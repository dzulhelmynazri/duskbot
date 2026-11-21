import { DOCKER_NAMES } from "../electron/legacy-names.mjs";
import { afterEach, describe, expect, it } from "vitest";
import {
  admitVpsDesktop, createVpsCapacityHost, desktopCapacity, desktopLimitArgs, desktopLimits, desktopUpdateArgs, knownScreenCapacity,
  resetVpsCapacityForTests, setVpsCapacityHost, type VpsDocker,
} from "./vps-capacity.ts";
import { vpsTurnStartPlan } from "./vps-turn-start.ts";

const GB = 1024 ** 3;
const ENV = "env-1";
const name = (owner: string) => `${DOCKER_NAMES.vpsPrefix}-${owner}-${owner.padEnd(12, "0").slice(0, 12).replace(/[^a-f0-9]/g, "a")}`;

/** a docker that knows which desktops run and the host's memory, and records what it was asked */
function fakeHost(memory: number, running: Array<{ name: string; environment?: string; labelled?: string }>) {
  const calls: string[][] = [];
  const awake = new Map(running.map(row => [row.name, row]));
  const docker: VpsDocker = async (args) => {
    calls.push(args);
    if (args[0] === "info") return { stdout: `${memory}\n` };
    if (args[0] === "ps") return { stdout: [...awake.values()].map(row => `${row.name}\t${row.environment ?? ENV}\t${row.labelled ?? row.name}`).join("\n") };
    if (args[0] === "stop") { awake.delete(args.at(-1)!); return { stdout: "" }; }
    if (args[0] === "start") { awake.set(args.at(-1)!, { name: args.at(-1)! }); return { stdout: "" }; }
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  return { docker, calls, awake };
}

afterEach(() => { resetVpsCapacityForTests(); delete process.env.MADANI_VPS_MAX_DESKTOPS; });

describe("desktops a VPS keeps awake", () => {
  it("leaves room for the system and about 1.5 GB per desktop: six on a 12 GB host", () => {
    expect(desktopCapacity(12 * GB)).toBe(6);
    expect(desktopCapacity(11.6 * GB)).toBe(6);
    expect(desktopCapacity(24 * GB)).toBe(14);
    expect(desktopCapacity(2 * GB)).toBe(1);
    expect(desktopCapacity(256 * GB)).toBe(20);
    expect(desktopCapacity(12 * GB, { MADANI_VPS_MAX_DESKTOPS: "2" })).toBe(2);
  });

  it("caps each desktop's memory with no swap, below the host's services for cpu and the oom killer, and never restarts it after a reboot", () => {
    expect(desktopLimits(12 * GB, false)).toEqual({ memoryMb: 1536 });
    expect(desktopLimits(12 * GB, true)).toEqual({ memoryMb: 9728 });
    expect(desktopLimitArgs({ memoryMb: 1536 })).toEqual(["--memory", "1536m", "--memory-swap", "1536m", "--cpu-shares", "256", "--oom-score-adj", "500"]);
    expect(desktopUpdateArgs("abc", { memoryMb: 1536 })).toEqual(["update", "--memory", "1536m", "--memory-swap", "1536m", "--cpu-shares", "256", "--restart", "no", "abc"]);
  });

  it("starts at once while the host has room", async () => {
    const host = fakeHost(12 * GB, [{ name: name("a") }, { name: name("b") }]);
    const started = await admitVpsDesktop({ alias: "vps", containerName: name("c"), shared: false, local: false, environmentId: ENV, docker: host.docker },
      async limits => limits);
    expect(started).toEqual({ memoryMb: 1536 });
    expect(host.calls.filter(args => args[0] === "stop")).toEqual([]);
  });

  it("at the cap puts the least recently used idle desktop to sleep, never a busy one", async () => {
    process.env.MADANI_VPS_MAX_DESKTOPS = "3";
    const host = fakeHost(12 * GB, [{ name: name("a") }, { name: name("b") }, { name: name("c") }]);
    const slept: string[] = [];
    const used: Record<string, number> = { a: 300, b: 100, c: 200 };
    setVpsCapacityHost(createVpsCapacityHost({
      owners: () => ["a", "b", "c", "d"], containerName: name, lastActivityAt: owner => used[owner] ?? 0,
      sleep: async owner => { if (owner === "b") return false; slept.push(owner); host.awake.delete(name(owner)); return true; },
    }));
    await admitVpsDesktop({ alias: "vps", containerName: name("d"), shared: false, local: false, environmentId: ENV, docker: host.docker }, async () => host.docker(["start", name("d")]));
    // b was least recent but busy, so c (next oldest) slept; a, the most recent, stayed awake
    expect(slept).toEqual(["c"]);
    expect([...host.awake.keys()].sort()).toEqual([name("a"), name("b"), name("d")].sort());
  });

  it("sleeps a desktop no bot owns any more before anyone's own, and never another install's or a renamed backup", async () => {
    process.env.MADANI_VPS_MAX_DESKTOPS = "3";
    const backup = `${name("x")}-before-lazy-1`;
    const host = fakeHost(12 * GB, [{ name: name("a") }, { name: name("gone") }, { name: name("other"), environment: "env-2" }, { name: backup, labelled: name("x") }]);
    setVpsCapacityHost(createVpsCapacityHost({ owners: () => ["a"], containerName: name, lastActivityAt: () => 0, sleep: async () => { throw new Error("not expected"); } }));
    await admitVpsDesktop({ alias: "vps", containerName: name("a"), shared: false, local: false, environmentId: ENV, docker: host.docker }, async () => undefined);
    expect(host.calls.filter(args => args[0] === "stop").map(args => args.at(-1))).toEqual([name("gone")]);
  });

  it("when every awake desktop is busy, waits a little and then tells the bot plainly", async () => {
    process.env.MADANI_VPS_MAX_DESKTOPS = "1";
    const host = fakeHost(12 * GB, [{ name: name("a") }]);
    setVpsCapacityHost(createVpsCapacityHost({ owners: () => ["a", "b"], containerName: name, lastActivityAt: () => 0, sleep: async () => false }));
    let started = false;
    const error = await admitVpsDesktop({ alias: "vps", containerName: name("b"), shared: false, local: false, environmentId: ENV, docker: host.docker, waitMs: 40, pollMs: 10 },
      async () => { started = true; }).catch((failure: unknown) => failure as Error & { code?: string; status?: number });
    expect(started).toBe(false);
    expect(error).toMatchObject({ code: "vps_capacity_full", status: 503 });
    expect((error as Error).message).toMatch(/room for 1 awake bot computer .*12 GB.*Wait for one of those bots to finish/);
  });

  it("starts as soon as a desktop frees up while waiting", async () => {
    process.env.MADANI_VPS_MAX_DESKTOPS = "1";
    const host = fakeHost(12 * GB, [{ name: name("a") }]);
    setVpsCapacityHost(createVpsCapacityHost({ owners: () => ["a", "b"], containerName: name, lastActivityAt: () => 0, sleep: async () => false }));
    setTimeout(() => host.awake.delete(name("a")), 20);
    await expect(admitVpsDesktop({ alias: "vps", containerName: name("b"), shared: false, local: false, environmentId: ENV, docker: host.docker, waitMs: 2_000, pollMs: 10 },
      async () => "started")).resolves.toBe("started");
  });

  it("lets two starts on one host take turns, so both never take the last place", async () => {
    process.env.MADANI_VPS_MAX_DESKTOPS = "2";
    const host = fakeHost(12 * GB, [{ name: name("a") }]);
    setVpsCapacityHost(createVpsCapacityHost({ owners: () => ["a", "b", "c"], containerName: name, lastActivityAt: () => 0, sleep: async () => false }));
    const start = (owner: string) => admitVpsDesktop({ alias: "vps", containerName: name(owner), shared: false, local: false, environmentId: ENV, docker: host.docker, waitMs: 30, pollMs: 10 },
      async () => { await new Promise(resolve => setTimeout(resolve, 5)); await host.docker(["start", name(owner)]); return owner; });
    const results = await Promise.allSettled([start("b"), start("c")]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(host.awake.size).toBe(2);
  });

  it("starts anyway when docker cannot list desktops, so the start reports the real problem", async () => {
    const docker: VpsDocker = async (args) => { if (args[0] === "info") return { stdout: String(12 * GB) }; throw new Error("ps failed"); };
    await expect(admitVpsDesktop({ alias: "vps", containerName: name("a"), shared: false, local: false, environmentId: ENV, docker }, async () => "ok")).resolves.toBe("ok");
  });

  it("caps shared-computer screens by the measured host memory", async () => {
    expect(knownScreenCapacity("remote-vps")).toBe(3);
    const host = fakeHost(12 * GB, []);
    await admitVpsDesktop({ alias: "remote-vps", containerName: name("computer"), shared: true, local: false, environmentId: ENV, docker: host.docker }, async () => undefined);
    expect(knownScreenCapacity("remote-vps")).toBe(6);
  });
});

describe("waking a bot's own desktop at turn start", () => {
  const base = { autoStart: true, autoStartVps: true };
  it("never wakes it for a chat turn on Auto, or on a place the bot picked itself, that can pick its computer", () => {
    expect(vpsTurnStartPlan({ ...base, wants: undefined, canSelect: true })).toBe("lazy");
    expect(vpsTurnStartPlan({ ...base, wants: "cloud", canSelect: true, chosen: false })).toBe("lazy");
  });
  it("starts it when the person chose this computer", () => {
    expect(vpsTurnStartPlan({ ...base, wants: "cloud", canSelect: true, chosen: true })).toBe("start");
  });
  it("starts it for turns that cannot pick: a schedule, a handoff, the continuation after a pick", () => {
    expect(vpsTurnStartPlan({ ...base, wants: undefined, canSelect: true, automationSource: "routine" })).toBe("start");
    expect(vpsTurnStartPlan({ ...base, wants: "cloud", canSelect: false })).toBe("start");
    expect(vpsTurnStartPlan({ ...base, wants: undefined, canSelect: false })).toBe("start");
  });
  it("only looks when starting is switched off", () => {
    expect(vpsTurnStartPlan({ ...base, autoStart: false, wants: "cloud", canSelect: false })).toBe("inspect");
    expect(vpsTurnStartPlan({ autoStart: true, autoStartVps: false, wants: undefined, canSelect: true })).toBe("inspect");
    expect(vpsTurnStartPlan({ ...base, wants: "local", canSelect: true })).toBe("inspect");
  });
});
