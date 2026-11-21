import { DOCKER_NAMES } from "../electron/legacy-names.mjs";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BOT_DESKTOP_IMAGE, BOT_DESKTOP_LABEL, BOT_DESKTOP_MODE_LABEL, BOT_DESKTOP_NETWORK, BOT_DESKTOP_VERSION } from "../shared/bot-desktop.ts";
import {
  FREE_CAPABILITIES,
  botDesktopIsHardened,
  botDesktopKit,
  botDesktopMode,
  botDesktopMountsAreSafe,
  botDesktopNetworkCreateArgs,
  botDesktopNetworkIsPrivate,
  botDesktopRunArgs,
  botDesktopVolume,
  BOT_DESKTOP_SETUP_LATER,
  containerBotDesktopMode,
  dockerHostBuilds,
  containerDesktopKind,
  hostBuildTiming,
  hostIsolation,
  parseHostAddresses,
  preferredVpsDesktop,
  provisionBotDesktop,
} from "./bot-desktop.ts";
import { CUA_DRIVER_VERSION, DRIVER_LABEL } from "./container-computer.ts";
import type { AppConfig } from "./config.ts";
import { vpsBoxChrome, vpsComputerAction, vpsComputerStatus, vpsContainerName, type VpsCommandRunner } from "./vps-computer.ts";
import { INDEPENDENT_DISPLAYS, independentScreenTarget, isManagedScreenViewerPort } from "./shared-desktop-screens.ts";
import { SCREEN_BROWSER_LOW_MEMORY } from "./vps-browser-ready.ts";
import * as vpsLocal from "./vps-local.ts";
import { boxChromes, closeVpsScreenConnections, evictVpsBoxChrome, screenKey } from "./vps-connections.ts";

const NAME = `${DOCKER_NAMES.vpsPrefix}-bot1-0123456789ab`;
const IMAGE_ID = `sha256:${"c".repeat(64)}`;
const SECRET = "viewer-secret-123";

const flag = (args: string[], name: string) => args.flatMap((arg, index) => (arg === name ? [args[index + 1]] : []));

/** What `docker inspect` reports for a strict box made by botDesktopRunArgs. */
function inspected(name: string, overrides: Record<string, unknown> = {}) {
  return {
    ReadonlyRootfs: true,
    Runtime: "runc",
    CapDrop: ["ALL"],
    CapAdd: ["CAP_NET_ADMIN", "CAP_SETUID", "CAP_SETGID"],
    SecurityOpt: ["no-new-privileges"],
    Privileged: false,
    PidMode: "",
    IpcMode: "private",
    UTSMode: "",
    Devices: [],
    DeviceRequests: [],
    UsernsMode: "",
    CgroupnsMode: "private",
    AutoRemove: false,
    RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
    NetworkMode: BOT_DESKTOP_NETWORK,
    PortBindings: {},
    PublishAllPorts: false,
    Binds: null,
    VolumesFrom: null,
    ...overrides,
    _mounts: [{ Type: "volume", Name: botDesktopVolume(name), Destination: "/home/cua", Driver: "local" }],
  };
}

/** The same for a free box: writable root, sudo-capable, no NET_ADMIN, no no-new-privileges. */
const freeInspected = (overrides: Record<string, unknown> = {}) => inspected(NAME, {
  ReadonlyRootfs: false, SecurityOpt: null, CapAdd: FREE_CAPABILITIES.map((cap) => `CAP_${cap}`), Runtime: "runsc", ...overrides,
});

describe("bot desktop run flags", () => {
  const strict = botDesktopRunArgs({ containerName: NAME, imageRef: IMAGE_ID, viewerSecret: SECRET, labels: ["a=1"], mode: "strict", blockedHostAddresses: ["203.0.113.7", "x; rm"] });
  const free = botDesktopRunArgs({ containerName: NAME, imageRef: IMAGE_ID, viewerSecret: SECRET, labels: ["a=1"], mode: "free", runtime: "runsc", blockedHostAddresses: ["203.0.113.7"] });

  it("starts either box capability-dropped on its own network with one home volume and nothing published", () => {
    for (const args of [strict, free]) {
      expect(args.slice(0, 2)).toEqual(["run", "-d"]);
      expect(args.at(-1)).toBe(IMAGE_ID);
      expect(flag(args, "--network")).toEqual([BOT_DESKTOP_NETWORK]);
      expect(flag(args, "--dns")).toEqual(["1.1.1.1", "9.9.9.9"]);
      expect(flag(args, "--cap-drop")).toEqual(["ALL"]);
      expect(flag(args, "--mount")).toEqual([`type=volume,source=${NAME}-home,target=/home/cua`]);
      expect(args.some((arg) => ["-v", "--volume", "-p", "--publish", "-P", "--privileged", "--pid", "--userns", "--device"].includes(arg))).toBe(false);
      expect(args.some((arg) => arg.includes("docker.sock"))).toBe(false);
      expect(flag(args, "--label")).toEqual(expect.arrayContaining(["a=1", `${BOT_DESKTOP_LABEL}=${BOT_DESKTOP_VERSION}`, `${DRIVER_LABEL}=${CUA_DRIVER_VERSION}`]));
      expect(flag(args, "--pids-limit")).toHaveLength(1);
      expect(flag(args, "--memory")).toEqual(["1536m"]);
      expect(flag(args, "--memory-swap")).toEqual(["1536m"]);
      expect(flag(args, "--oom-score-adj")).toEqual(["500"]);
      expect(flag(args, "--cpu-shares")).toEqual(["256"]);
      expect(flag(args, "--restart")).toEqual(["no"]);
      expect(flag(args, "--cpus")).toEqual(["2"]);
    }
  });

  it("strict: read-only root, its own firewall capability, no-new-privileges, the host's addresses fenced inside", () => {
    expect(strict).toContain("--read-only");
    expect(flag(strict, "--cap-add").sort()).toEqual(["NET_ADMIN", "SETGID", "SETUID"]);
    expect(flag(strict, "--security-opt")).toEqual(["no-new-privileges"]);
    expect(flag(strict, "-e")).toEqual(["MADANI_MODE=strict", "MADANI_BROWSER_AT_START=off", `VNC_PW=${SECRET}`, "MADANI_BLOCK_EXTRA=203.0.113.7"]);
    expect(strict).not.toContain("--runtime");
  });

  it("free: writable root and sudo, but never a network, raw-socket or kernel capability", () => {
    expect(free).not.toContain("--read-only");
    expect(flag(free, "--security-opt")).toEqual([]);
    expect(flag(free, "--cap-add").sort()).toEqual([...FREE_CAPABILITIES].sort());
    for (const cap of ["NET_ADMIN", "NET_RAW", "SYS_ADMIN", "SYS_PTRACE", "SYS_MODULE", "MKNOD", "DAC_READ_SEARCH", "SETFCAP"]) {
      expect(flag(free, "--cap-add")).not.toContain(cap);
    }
    expect(flag(free, "-e")).toEqual(["MADANI_MODE=free", "MADANI_BROWSER_AT_START=off", `VNC_PW=${SECRET}`]);
    expect(flag(free, "--runtime")).toEqual(["runsc"]);
    expect(flag(free, "--label")).toContain(`${BOT_DESKTOP_MODE_LABEL}=free`);
  });

  it("names the bridge the host fence keys on", () => {
    expect(botDesktopNetworkCreateArgs()).toEqual(expect.arrayContaining(["com.docker.network.bridge.name=omb-desk0", "com.docker.network.bridge.enable_icc=false"]));
  });
});

describe("a strict box's own firewall", () => {
  it("lets only the docker host reach every screen's viewer, the independent screens' included", () => {
    const script = readFileSync(resolve(import.meta.dirname, "..", "deploy", "bot-desktop", "rootfs", "usr", "local", "bin", "omb-firewall"), "utf8");
    const accepts = [...script.matchAll(/-A INPUT -s \$\{gateway\}\/32 -p tcp --dport (\d+)(?::(\d+))? -j ACCEPT/g)].map(m => [Number(m[1]), Number(m[2] ?? m[1])]);
    expect(accepts).toEqual([[6901, 6900 + Math.max(...INDEPENDENT_DISPLAYS)]]);
    for (let port = 6900; port <= 6923; port++) expect(accepts.some(([a, b]) => port >= a! && port <= b!), String(port)).toBe(isManagedScreenViewerPort(port));
  });
});

describe("bot desktop isolation checks", () => {
  it("accepts exactly what the run flags produce", () => {
    expect(botDesktopIsHardened(inspected(NAME), "strict")).toBe(true);
    expect(botDesktopIsHardened(inspected(NAME, { Runtime: "runsc" }), "strict")).toBe(true);
    expect(botDesktopIsHardened(freeInspected(), "free")).toBe(true);
    expect(botDesktopIsHardened(freeInspected({ Runtime: "runc" }), "free")).toBe(true);
  });

  it.each([
    ["a writable root", { ReadonlyRootfs: false }],
    ["no no-new-privileges", { SecurityOpt: [] }],
    ["an extra capability", { CapAdd: ["CAP_NET_ADMIN", "CAP_SETUID", "CAP_SETGID", "CAP_SYS_ADMIN"] }],
    ["no firewall capability", { CapAdd: ["CAP_SETUID", "CAP_SETGID"] }],
    ["privileged", { Privileged: true }],
    ["host pid", { PidMode: "host" }],
    ["unconfined seccomp", { SecurityOpt: ["no-new-privileges", "seccomp=unconfined"] }],
    ["an unknown runtime", { Runtime: "kata" }],
  ])("refuses a strict box with %s", (_label, overrides) => {
    expect(botDesktopIsHardened(inspected(NAME, overrides), "strict")).toBe(false);
  });

  it.each([
    ["NET_ADMIN", { CapAdd: [...FREE_CAPABILITIES, "NET_ADMIN"] }],
    ["NET_RAW", { CapAdd: [...FREE_CAPABILITIES, "NET_RAW"] }],
    ["privileged", { Privileged: true }],
    ["host networking namespaces", { PidMode: "host" }],
    ["the host user namespace", { UsernsMode: "host" }],
    ["unconfined seccomp", { SecurityOpt: ["seccomp=unconfined"] }],
    ["a device", { Devices: [{ PathOnHost: "/dev/kvm" }] }],
  ])("refuses a free box with %s", (_label, overrides) => {
    expect(botDesktopIsHardened(freeInspected(overrides), "free")).toBe(false);
  });

  it("judges a box only as the mode its label and environment agree on", () => {
    expect(containerBotDesktopMode({ [BOT_DESKTOP_MODE_LABEL]: "free" }, ["MADANI_MODE=free"])).toBe("free");
    expect(containerBotDesktopMode({ [BOT_DESKTOP_MODE_LABEL]: "strict" }, ["VNC_PW=x"])).toBe("strict");
    expect(containerBotDesktopMode({ [BOT_DESKTOP_MODE_LABEL]: "free" }, ["MADANI_MODE=strict"])).toBeUndefined();
    expect(containerBotDesktopMode({}, [])).toBeUndefined();
    expect(containerBotDesktopMode({ [BOT_DESKTOP_MODE_LABEL]: "free" }, ["OMB_MODE=free"])).toBe("free");
    expect(containerBotDesktopMode({ [BOT_DESKTOP_MODE_LABEL]: "free" }, ["MADANI_MODE=strict", "OMB_MODE=free"])).toBeUndefined();
    expect(containerBotDesktopMode({ [BOT_DESKTOP_MODE_LABEL]: "strict" }, ["OMB_MODE=free"])).toBeUndefined();
    expect(botDesktopIsHardened(freeInspected(), undefined)).toBe(false);
    expect(botDesktopIsHardened(freeInspected(), "strict")).toBe(false);
  });

  it("allows only its own home volume and its own network", () => {
    const mounts = [{ Type: "volume", Name: `${NAME}-home`, Destination: "/home/cua", Driver: "local" }];
    expect(botDesktopMountsAreSafe(NAME, { Mounts: mounts, HostConfig: { Binds: null } })).toBe(true);
    expect(botDesktopMountsAreSafe(NAME, { Mounts: [{ ...mounts[0], Name: "other-home" }] })).toBe(false);
    expect(botDesktopMountsAreSafe(NAME, { Mounts: [...mounts, { Type: "bind", Destination: "/x" }] })).toBe(false);
    expect(botDesktopMountsAreSafe(NAME, { Mounts: mounts, HostConfig: { Binds: ["/:/host"] } })).toBe(false);
    expect(botDesktopMountsAreSafe(NAME, { Mounts: [] })).toBe(false);
    const networks = { [BOT_DESKTOP_NETWORK]: {} };
    expect(botDesktopNetworkIsPrivate({ NetworkMode: BOT_DESKTOP_NETWORK }, networks)).toBe(true);
    expect(botDesktopNetworkIsPrivate({ NetworkMode: "bridge" }, { bridge: {} })).toBe(false);
    expect(botDesktopNetworkIsPrivate({ NetworkMode: BOT_DESKTOP_NETWORK }, { ...networks, bridge: {} })).toBe(false);
    expect(botDesktopNetworkIsPrivate({ NetworkMode: BOT_DESKTOP_NETWORK, PortBindings: { "6901/tcp": [{}] } }, networks)).toBe(false);
  });

  it("frees a box only behind the host fence and gVisor or user-namespace remapping", () => {
    const gvisor = hostIsolation('{"Runtimes":{"runc":{},"runsc":{"path":"runsc"}},"SecurityOptions":["name=seccomp,profile=builtin"]}', {});
    const remapped = hostIsolation('{"Runtimes":{"runc":{}},"SecurityOptions":["name=seccomp,profile=builtin","name=userns"]}', {});
    const plain = hostIsolation('{"Runtimes":{"runc":{}},"SecurityOptions":["name=seccomp,profile=builtin"]}', {});
    expect(gvisor).toEqual({ runtime: "runsc", userns: false });
    expect(remapped).toEqual({ runtime: null, userns: true });
    expect(hostIsolation('{"Runtimes":{"runsc":{}}}', { MADANI_VPS_GVISOR: "off" }).runtime).toBeNull();
    expect(hostIsolation("not json", {})).toEqual({ runtime: null, userns: false });
    expect(botDesktopMode(true, gvisor, {})).toBe("free");
    expect(botDesktopMode(true, remapped, {})).toBe("free");
    expect(botDesktopMode(true, plain, {})).toBe("strict");
    expect(botDesktopMode(false, gvisor, {})).toBe("strict");
    expect(botDesktopMode(true, gvisor, { MADANI_VPS_BOX: "strict" })).toBe("strict");
  });

  it("reads host addresses and the desktop kind defensively", () => {
    expect(parseHostAddresses("2: eth0    inet 203.0.113.7/24 brd x scope global eth0\n2: eth0    inet6 2001:db8::7/64 scope global\nnoise")).toEqual(["203.0.113.7", "2001:db8::7"]);
    expect(preferredVpsDesktop({})).toBe("bot-desktop");
    expect(preferredVpsDesktop({ MADANI_VPS_DESKTOP: "cua" })).toBe("cua");
    expect(containerDesktopKind({ [BOT_DESKTOP_LABEL]: "1" })).toBe("bot-desktop");
    expect(containerDesktopKind({})).toBe("cua");
  });

  it("keeps build.sh's fallback tag and host-fence.sh's bridge in step with the constants", () => {
    const script = readFileSync(new URL("../deploy/bot-desktop/build.sh", import.meta.url), "utf8");
    expect(script).toContain(`image="\${image:-ghcr.io/madanibotai/madani-desktop:v$version}"`);
    expect(script).toContain(`version="\${version:-${BOT_DESKTOP_VERSION}}"`);
    expect(readFileSync(new URL("../deploy/bot-desktop/Dockerfile", import.meta.url), "utf8")).toContain(`ARG BOT_DESKTOP_VERSION=${BOT_DESKTOP_VERSION}\n`);
    expect(readFileSync(new URL("../deploy/bot-desktop/rootfs/usr/local/bin/omb-session", import.meta.url), "utf8")).toContain('${MADANI_BROWSER_AT_START:-off}');
    expect(BOT_DESKTOP_IMAGE).toBe(`ghcr.io/madanibotai/madani-desktop:v${BOT_DESKTOP_VERSION}`);
    expect(readFileSync(new URL("../deploy/bot-desktop/host-fence.sh", import.meta.url), "utf8")).toContain("BRIDGE=omb-desk0\n");
  });

  it("publishes every version it points at: the workflow runs on a bump, in the namespace the repository's token pushes to", () => {
    const workflow = readFileSync(new URL("../.github/workflows/bot-desktop-image.yml", import.meta.url), "utf8");
    for (const path of ["shared/bot-desktop.ts", "deploy/bot-desktop/**"]) expect(workflow).toContain(`      - ${path}\n`);
    expect(workflow).toMatch(/branches: \[main\]/);
    expect(workflow).toContain("runner: ubuntu-24.04-arm");
    expect(workflow).toContain('-t "$IMAGE-$ARCH" --push deploy/bot-desktop');
    expect(workflow).toContain('imagetools create -t "$IMAGE" "$IMAGE-amd64" "$IMAGE-arm64"');
    expect(workflow).toContain("node scripts/check-bot-desktop-published.mjs");
    // GITHUB_TOKEN of dzulhelmynazri/madani-bot can push only under ghcr.io/madanibotai
    expect(BOT_DESKTOP_IMAGE).toMatch(/^ghcr\.io\/madanibotai\/[a-z0-9-]+:v\d+$/);
    const gate = readFileSync(new URL("../apps/link-service/docker-gate.mjs", import.meta.url), "utf8");
    expect(/^export const DEFAULT_PULL = (\[.*\]);$/m.exec(gate)?.[1]).toContain(`"${BOT_DESKTOP_IMAGE.slice(0, BOT_DESKTOP_IMAGE.lastIndexOf(":"))}"`);
    // a server build and a release refuse an image nobody can pull
    expect(readFileSync(new URL("../scripts/build-vps-package.mjs", import.meta.url), "utf8")).toContain("checkBotDesktopPublished()");
    expect(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")).toContain("run: node scripts/check-bot-desktop-published.mjs");
  });

});

describe("bot desktop provisioning", () => {
  function host({ pull = true, network = false, runsc = false, fenced = false, build = true } = {}) {
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "pull") { if (!pull) throw new Error("Error response from daemon: denied"); return { stdout: "" }; }
      if (args[0] === "build") { if (!build) throw new Error("ERROR: failed to solve: process did not complete successfully"); return { stdout: "" }; }
      if (args[0] === "image") return { stdout: JSON.stringify([{ Id: IMAGE_ID, Config: { Labels: { [BOT_DESKTOP_LABEL]: BOT_DESKTOP_VERSION, [DRIVER_LABEL]: CUA_DRIVER_VERSION } } }]) };
      if (args[0] === "network" && args[1] === "inspect") {
        if (!network) throw new Error(`Error: No such network: ${BOT_DESKTOP_NETWORK}`);
        return { stdout: JSON.stringify({ Labels: { [DOCKER_NAMES.label("vps-network")]: "1" }, Options: { "com.docker.network.bridge.name": "omb-desk0" } }) };
      }
      if (args[0] === "info") return { stdout: JSON.stringify({ Runtimes: runsc ? { runc: {}, runsc: {} } : { runc: {} }, SecurityOptions: [] }) };
      if (args.includes("/usr/local/bin/omb-host-fence")) { if (!fenced) throw new Error("exit status 1"); return { stdout: "" }; }
      if (args.includes("--entrypoint")) return { stdout: "2: eth0 inet 198.51.100.4/24 scope global eth0\n" };
      return { stdout: "" };
    };
    return { calls, run };
  }
  const input = { containerName: NAME, imageId: null, labels: [], viewerSecret: SECRET };
  const steps = (calls: string[][]) => calls.map((args) => (args.includes("--entrypoint") ? `probe ${args[args.indexOf("--entrypoint") + 1]}` : args.slice(0, 2).join(" ")));

  it("without the host fence: pulls, makes the network, and starts a strict box that fences the host's addresses itself", async () => {
    const fake = host({ runsc: true });
    expect(await provisionBotDesktop(fake.run, input)).toBe("strict");
    expect(steps(fake.calls)).toEqual([`pull ${BOT_DESKTOP_IMAGE}`, "image inspect", "network inspect", "info --format", "probe /usr/local/bin/omb-host-fence", "network create", "probe ip", "run -d"]);
    const started = fake.calls.at(-1)!;
    expect(started.at(-1)).toBe(IMAGE_ID);
    expect(started).toEqual(expect.arrayContaining(["--read-only", "--runtime", "runsc", "MADANI_MODE=strict", "MADANI_BLOCK_EXTRA=198.51.100.4"]));
  });

  it("behind the host fence with gVisor: a free box, no address probe needed", async () => {
    const fake = host({ runsc: true, network: true, fenced: true });
    expect(await provisionBotDesktop(fake.run, input)).toBe("free");
    expect(steps(fake.calls)).toEqual([`pull ${BOT_DESKTOP_IMAGE}`, "image inspect", "network inspect", "info --format", "probe /usr/local/bin/omb-host-fence", "run -d"]);
    expect(fake.calls.at(-1)).toEqual(expect.arrayContaining(["--runtime", "runsc", "MADANI_MODE=free"]));
    expect(fake.calls.at(-1)).not.toContain("--read-only");
  });

  it("behind the fence but on plain runc: still strict", async () => {
    expect(await provisionBotDesktop(host({ network: true, fenced: true }).run, input)).toBe("strict");
  });

  it("builds the image on the docker host from the shipped kit when the registry refuses it, and reports the build", async () => {
    const fake = host({ pull: false, network: true });
    const progress: string[] = [];
    expect(await provisionBotDesktop(fake.run, { ...input, onProgress: step => progress.push(step) })).toBe("strict");
    expect(progress).toEqual(["pulling", "building"]);
    const kit = botDesktopKit()!;
    expect(kit).toBe(resolve(import.meta.dirname, "..", "deploy", "bot-desktop"));
    expect(fake.calls[1]).toEqual(["build", "--build-arg", `BOT_DESKTOP_VERSION=${BOT_DESKTOP_VERSION}`, "-t", BOT_DESKTOP_IMAGE, kit]);
    expect(steps(fake.calls).slice(0, 3)).toEqual([`pull ${BOT_DESKTOP_IMAGE}`, "build --build-arg", "image inspect"]);
    expect(fake.calls.at(-1)!.at(-1)).toBe(IMAGE_ID);
  });

  it("refuses with a clear reason, creating nothing, when the image can be neither pulled nor built", async () => {
    vi.stubEnv("MADANI_BOT_DESKTOP_KIT", join(tmpdir(), "madani-no-such-kit"));
    try {
      const fake = host({ pull: false, network: true });
      await expect(provisionBotDesktop(fake.run, input)).rejects.toMatchObject({ status: 409, code: "bot_desktop_unavailable", message: BOT_DESKTOP_SETUP_LATER });
      expect(steps(fake.calls)).toEqual([`pull ${BOT_DESKTOP_IMAGE}`]);
    } finally { vi.unstubAllEnvs(); }
    // docker's and the build's own words stay in the server log
    const broken = host({ pull: false, network: true, build: false });
    await expect(provisionBotDesktop(broken.run, input)).rejects.toMatchObject({ status: 409, message: BOT_DESKTOP_SETUP_LATER });
    expect(broken.calls.map(args => args[0])).toEqual(["pull", "build"]);
  });

  it("never tries to build behind the docker gate, which forwards no build", async () => {
    expect(dockerHostBuilds({ DOCKER_HOST: "unix:///run/madanibot-docker/docker.sock" })).toBe(false);
    expect(dockerHostBuilds({ DOCKER_HOST: "unix:///run/openmausbot-docker/docker.sock" })).toBe(false);
    expect(dockerHostBuilds({ DOCKER_HOST: "unix:///var/run/docker.sock" })).toBe(true);
    expect(dockerHostBuilds({})).toBe(true);
    vi.stubEnv("DOCKER_HOST", "unix:///run/madanibot-docker/docker.sock");
    try {
      const gated = host({ pull: false, network: true });
      await expect(provisionBotDesktop(gated.run, input)).rejects.toMatchObject({ code: "bot_desktop_unavailable", message: BOT_DESKTOP_SETUP_LATER });
      expect(gated.calls.map(args => args[0])).toEqual(["pull"]);
    } finally { vi.unstubAllEnvs(); }
  });

  describe("on a managed cloud home, whose own machine builds the image", () => {
    const status = () => join(mkdtempSync(join(tmpdir(), "madani-host-build-")), "desktop-image");
    /** the registry refuses; `image inspect` answers once the machine's build has finished `afterChecks` checks later */
    function building(afterChecks: number) {
      let checks = 0;
      const calls: string[][] = [];
      const base = host({ pull: false, network: true });
      const run = async (args: string[]) => {
        if (args[0] === "image" && args[1] === "inspect" && args[2] === BOT_DESKTOP_IMAGE && checks++ < afterChecks) { calls.push(args); throw new Error(`Error: No such image: ${BOT_DESKTOP_IMAGE}`); }
        calls.push(args);
        return base.run(args);
      };
      return { calls, run };
    }
    beforeEach(() => { Object.assign(hostBuildTiming, { pollMs: 1, limitMs: 2_000 }); });

    it("waits for the machine's build instead of building through the gate, and reports it as building", async () => {
      const file = status();
      writeFileSync(file, "building\n");
      vi.stubEnv("MADANI_BOT_DESKTOP_HOST_BUILD", file);
      try {
        const fake = building(3), progress: string[] = [];
        expect(await provisionBotDesktop(fake.run, { ...input, onProgress: step => progress.push(step) })).toBe("strict");
        expect(progress).toEqual(["pulling", "building"]);
        expect(fake.calls.some(args => args[0] === "build")).toBe(false);
        expect(fake.calls.filter(args => args[0] === "image" && args[2] === BOT_DESKTOP_IMAGE)).toHaveLength(5);
      } finally { vi.unstubAllEnvs(); }
    });

    it("refuses at once with a clear reason when the machine's build failed, creating nothing", async () => {
      const file = status();
      writeFileSync(file, "failed\n");
      vi.stubEnv("MADANI_BOT_DESKTOP_HOST_BUILD", file);
      try {
        const fake = building(Number.POSITIVE_INFINITY);
        await expect(provisionBotDesktop(fake.run, input)).rejects.toMatchObject({ status: 409, code: "bot_desktop_unavailable", message: expect.stringContaining("could not build") });
        expect(fake.calls.some(args => args[0] === "run" || args[0] === "build")).toBe(false);
      } finally { vi.unstubAllEnvs(); }
    });

    it("gives up after its limit with a try-again message while the build still runs", async () => {
      vi.stubEnv("MADANI_BOT_DESKTOP_HOST_BUILD", status());
      Object.assign(hostBuildTiming, { pollMs: 5, limitMs: 30 });
      try {
        await expect(provisionBotDesktop(building(Number.POSITIVE_INFINITY).run, input)).rejects.toMatchObject({ code: "bot_desktop_unavailable", message: expect.stringContaining("still building") });
      } finally { vi.unstubAllEnvs(); }
    });
  });

  it("only offers a kit that builds exactly this app's desktop version, outside any asar archive", () => {
    const directory = mkdtempSync(join(tmpdir(), "madani-kit-"));
    try {
      const kit = join(directory, "bot-desktop");
      mkdirSync(kit);
      writeFileSync(join(kit, "Dockerfile"), `FROM debian\nARG BOT_DESKTOP_VERSION=${Number(BOT_DESKTOP_VERSION) - 1}\n`);
      expect(botDesktopKit({ MADANI_BOT_DESKTOP_KIT: kit })).toBeNull();
      writeFileSync(join(kit, "Dockerfile"), `FROM debian\nARG BOT_DESKTOP_VERSION=${BOT_DESKTOP_VERSION}\n`);
      expect(botDesktopKit({ MADANI_BOT_DESKTOP_KIT: kit })).toBe(kit);
      const packed = join(directory, "app.asar", "deploy", "bot-desktop");
      mkdirSync(packed, { recursive: true });
      writeFileSync(join(packed, "Dockerfile"), `ARG BOT_DESKTOP_VERSION=${BOT_DESKTOP_VERSION}\n`);
      expect(botDesktopKit({ MADANI_BOT_DESKTOP_KIT: packed })).toBeNull();
      expect(botDesktopKit({ MADANI_BOT_DESKTOP_KIT: join(directory, "missing") })).toBeNull();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("shares preparation for concurrent bots on one host, then rechecks the fence on the next start", async () => {
    const fake = host({ runsc: true, network: true, fenced: true });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const run = async (args: string[]) => {
      if (args[0] === "pull") await gate;
      return fake.run(args);
    };
    const first = provisionBotDesktop(run, { ...input, hostKey: "shared-vps" });
    const second = provisionBotDesktop(run, { ...input, containerName: `${NAME}-other`, hostKey: "shared-vps" });
    release();
    expect(await Promise.all([first, second])).toEqual(["free", "free"]);
    expect(fake.calls.filter((args) => args[0] === "pull")).toHaveLength(1);
    expect(fake.calls.filter((args) => args[0] === "network")).toHaveLength(1);
    expect(fake.calls.filter((args) => args[0] === "info")).toHaveLength(1);
    expect(fake.calls.filter((args) => args.includes("/usr/local/bin/omb-host-fence"))).toHaveLength(1);
    const starts = fake.calls.filter((args) => args[0] === "run" && args[1] === "-d");
    expect(starts).toHaveLength(2);
    expect(starts.map((args) => flag(args, "--name")[0])).toEqual([NAME, `${NAME}-other`]);

    const unfenced = host({ runsc: true, network: true, fenced: false });
    expect(await provisionBotDesktop(unfenced.run, { ...input, imageId: IMAGE_ID, hostKey: "shared-vps" })).toBe("strict");
    expect(unfenced.calls.some((args) => args.includes("/usr/local/bin/omb-host-fence"))).toBe(true);
  });

  it("keeps preparation separate across hosts and lets a failed pull retry", async () => {
    vi.stubEnv("MADANI_BOT_DESKTOP_KIT", join(tmpdir(), "madani-no-such-kit"));
    const unavailable = host({ pull: false });
    const available = host({ runsc: true, network: true, fenced: true });
    expect(await Promise.all([
      provisionBotDesktop(unavailable.run, { ...input, hostKey: "offline-vps" }),
      provisionBotDesktop(available.run, { ...input, hostKey: "online-vps" }),
    ].map(attempt => attempt.catch((error: { code?: string }) => error.code)))).toEqual(["bot_desktop_unavailable", "free"]);
    expect(await provisionBotDesktop(available.run, { ...input, hostKey: "offline-vps" })).toBe("free");
    expect(available.calls.filter((args) => args[0] === "pull")).toHaveLength(2);
    vi.unstubAllEnvs();
  });
});


describe("bot desktop on the VPS path", () => {
  beforeEach(() => { vi.stubEnv("MADANI_VPS_DESKTOP", ""); });
  const CONFIG: AppConfig = { vps: { sshAlias: "production-vps" } };
  const BOT = "bot-desktop-1";
  const name = vpsContainerName(BOT);

  function daemon() {
    const state = { image: false, container: false, running: false, secret: "", containerImageId: IMAGE_ID, pidsLimit: undefined as number | undefined,
      previous: null as null | { running: boolean; containerImageId: string; labels: Record<string, string> }, failRun: false };
    const calls: string[][] = [];
    const runner: VpsCommandRunner = async (args) => {
      const docker = args.slice(2);
      calls.push(docker);
      const [command] = docker;
      if (command === "pull") { state.image = true; return { stdout: "", stderr: "" }; }
      if (command === "image") {
        if (!state.image) throw new Error(`Error: No such image: ${docker[2]}`);
        return { stdout: JSON.stringify([{ Id: IMAGE_ID, Config: { Labels: { [BOT_DESKTOP_LABEL]: BOT_DESKTOP_VERSION, [DRIVER_LABEL]: CUA_DRIVER_VERSION } } }]), stderr: "" };
      }
      if (command === "network") {
        if (docker[1] === "inspect") throw new Error("Error: No such network");
        return { stdout: "", stderr: "" };
      }
      if (command === "info") return { stdout: '{"runc":{}}', stderr: "" };
      if (command === "run" && docker[1] === "--rm") return { stdout: "", stderr: "" };
      if (command === "stop") { state.running = false; return { stdout: "", stderr: "" }; }
      if (command === "start") { if (!state.container) throw new Error("Error: No such container"); state.running = true; return { stdout: "", stderr: "" }; }
      if (command === "update") return { stdout: "", stderr: "" };
      if (command === "rename") {
        const labels = (state as unknown as { labels: Record<string, string> }).labels;
        if (docker[1] === `${name}-previous`) {
          if (!state.previous || state.container) throw new Error("Error: rename failed");
          Object.assign(state, { container: true, running: state.previous.running, containerImageId: state.previous.containerImageId, labels: state.previous.labels, previous: null });
        } else {
          if (!state.container) throw new Error(`Error: No such container: ${docker[1]}`);
          Object.assign(state, { previous: { running: state.running, containerImageId: state.containerImageId, labels: { ...labels } }, container: false, running: false });
        }
        return { stdout: "", stderr: "" };
      }
      if (command === "rm") {
        if (docker.at(-1) === `${name}-previous`) state.previous = null;
        else state.container = false;
        return { stdout: "", stderr: "" };
      }
      if (command === "run") {
        if (state.failRun) throw new Error("Error: the new desktop could not start");
        state.containerImageId = IMAGE_ID;
        state.container = true;
        state.running = true;
        state.secret = docker.find((arg) => arg.startsWith("VNC_PW="))!.slice(7);
        const labels = Object.fromEntries(flag(docker, "--label").map((label) => label!.split("=") as [string, string]));
        Object.assign(state, { labels });
        return { stdout: `${name}\n`, stderr: "" };
      }
      if (command === "inspect") {
        if (!state.container) throw new Error(`Error: No such object: ${name}`);
        const { _mounts, ...hostConfig } = inspected(name);
        return {
          stdout: JSON.stringify([{
            Id: "d".repeat(64),
            Image: state.containerImageId,
            Config: { Image: state.containerImageId, Env: [`VNC_PW=${state.secret}`], Labels: (state as unknown as { labels: Record<string, string> }).labels },
            HostConfig: { ...hostConfig, PidsLimit: state.pidsLimit },
            NetworkSettings: { Networks: { [BOT_DESKTOP_NETWORK]: { IPAddress: "172.30.0.2" } } },
            Mounts: _mounts,
            State: { Running: state.running },
          }]),
          stderr: "",
        };
      }
      if (command === "exec") {
        if (docker.at(-1) === "--version") return { stdout: `cua-driver ${CUA_DRIVER_VERSION}\n`, stderr: "" };
        if (docker.includes("madani-desktop-probe") || docker.includes("health_report")) return { stdout: JSON.stringify({ schema_version: "1", overall: "ok", checks: [] }), stderr: "" };
        return { stdout: "{}\n", stderr: "" };
      }
      throw new Error(`unexpected docker ${command}`);
    };
    return { calls, runner, state };
  }

  it("provisions the bot desktop by default and then reports it ready through the same Cua Driver probes", async () => {
    const fake = daemon();
    const before = await vpsComputerStatus(CONFIG, BOT, fake.runner);
    expect(before).toMatchObject({ desktop: "bot-desktop", image: false, container: "missing", image_ref: BOT_DESKTOP_IMAGE });
    const status = await vpsComputerAction("provision", CONFIG, BOT, fake.runner);
    expect(status).toMatchObject({ desktop: "bot-desktop", ready: true, network: "private", mounts: "none", security: "hardened", problem: null });
    expect(fake.calls.some((args) => args[0] === "build")).toBe(false);
    expect(fake.calls.find((args) => args[0] === "run" && args[1] === "-d")).toEqual(expect.arrayContaining(["--read-only", "--network", BOT_DESKTOP_NETWORK]));
  });

  const makeV1 = async (fake: ReturnType<typeof daemon>, running = false) => {
    await vpsComputerAction("provision", CONFIG, BOT, fake.runner);
    const oldImage = `sha256:${"e".repeat(64)}`;
    Object.assign(fake.state, { running, containerImageId: oldImage, pidsLimit: 512 });
    (fake.state as unknown as { labels: Record<string, string> }).labels[BOT_DESKTOP_LABEL] = "1";
    fake.calls.length = 0;
    return oldImage;
  };

  it("names a managed v1 computer as outdated in plain words, without changing anything just by looking", async () => {
    const fake = daemon();
    const oldImage = await makeV1(fake);
    const status = await vpsComputerStatus(CONFIG, BOT, fake.runner);
    expect(status).toMatchObject({ managed: true, imageMatches: false, ready: false, container: "stopped", mounts: "none", outdated: true, updating: false });
    expect(status.problem).not.toMatch(/\d|managed|Replace|desktop version/);
    expect(fake.calls.every((args) => args[0] === "image" || args[0] === "inspect")).toBe(true);
    expect(fake.state).toMatchObject({ container: true, running: false, containerImageId: oldImage });
  });

  it("updates a managed v1 computer by itself when woken with the new image already here: the old one set aside, on the same home volume", async () => {
    const fake = daemon();
    await makeV1(fake);
    const status = await vpsComputerAction("provision", CONFIG, BOT, fake.runner);
    expect(status).toMatchObject({ ready: true, imageMatches: true, outdated: false, container: "running" });
    const order = fake.calls.map((args) => args[0]);
    expect(order).not.toContain("pull");
    expect(order.indexOf("rename")).toBeLessThan(order.lastIndexOf("run"));
    // the old desktop is removed only after the new one is up
    expect(order.lastIndexOf("rm")).toBeGreaterThan(order.lastIndexOf("run"));
    expect(fake.state).toMatchObject({ container: true, running: true, containerImageId: IMAGE_ID, previous: null });
    expect(inspected(name)._mounts[0].Name).toBe(botDesktopVolume(name));
  });

  it("puts the old computer back exactly as it was when the new one fails, and wakes that one instead", async () => {
    const fake = daemon();
    const oldImage = await makeV1(fake);
    fake.state.failRun = true;
    expect(await vpsComputerAction("provision", CONFIG, BOT, fake.runner)).toMatchObject({ ready: true, outdated: true, runsOlderVersion: true, container: "running", problem: null });
    expect(fake.state).toMatchObject({ container: true, running: true, containerImageId: oldImage, previous: null });
    expect((fake.state as unknown as { labels: Record<string, string> }).labels[BOT_DESKTOP_LABEL]).toBe("1");
    expect(inspected(name)._mounts[0].Name).toBe(botDesktopVolume(name));
    // and the background update swaps it once the new one can start
    fake.state.failRun = false;
    expect(await vpsComputerAction("update", CONFIG, BOT, fake.runner)).toMatchObject({ imageMatches: true, outdated: false });
  });

  it("wakes the old computer at once when the new version can be neither pulled nor built, and updates quietly later", async () => {
    const fake = daemon();
    const oldImage = await makeV1(fake);
    fake.state.image = false;
    let registry = false;
    const runner: VpsCommandRunner = async (args, options) => {
      const [command] = args.slice(2);
      if (command === "pull" || command === "build") fake.calls.push(args.slice(2));
      if (command === "pull") { if (!registry) throw new Error("Error response from daemon: manifest unknown"); fake.state.image = true; return { stdout: "", stderr: "" }; }
      if (command === "build") throw new Error("ERROR: failed to solve: docker.io/moby/buildkit: pull refused by the gate");
      return fake.runner(args, options);
    };
    const asleep = await vpsComputerStatus(CONFIG, BOT, runner);
    expect(asleep).toMatchObject({ outdated: true, runsOlderVersion: true, container: "stopped", image: false });
    expect(asleep.problem).not.toMatch(/older version|update/i);

    // the wake neither downloads nor builds: it starts the computer as it is
    const woken = await vpsComputerAction("provision", CONFIG, BOT, runner);
    expect(woken).toMatchObject({ ready: true, container: "running", outdated: true, runsOlderVersion: true, problem: null });
    expect(fake.calls.some((args) => ["pull", "build", "rename", "rm"].includes(args[0]!))).toBe(false);
    expect(fake.state).toMatchObject({ running: true, containerImageId: oldImage });

    // the background update fails quietly, short words only, and leaves the running computer alone
    await vpsComputerAction("stop", CONFIG, BOT, runner);
    fake.calls.length = 0;
    const failed = await vpsComputerAction("update", CONFIG, BOT, runner).then(() => null, (error: Error) => error);
    expect(failed?.message).toBe(BOT_DESKTOP_SETUP_LATER);
    expect(fake.calls.map((args) => args[0])).toEqual(expect.arrayContaining(["pull", "build"]));
    expect(fake.calls.some((args) => ["rename", "rm", "run", "stop"].includes(args[0]!))).toBe(false);
    expect(fake.state).toMatchObject({ container: true, containerImageId: oldImage, previous: null });
    expect(await vpsComputerAction("provision", CONFIG, BOT, runner)).toMatchObject({ ready: true, runsOlderVersion: true });

    // once the image is published the next pass swaps it in, and the wake after starts the new one
    registry = true;
    await vpsComputerAction("stop", CONFIG, BOT, runner);
    expect(await vpsComputerAction("update", CONFIG, BOT, runner)).toMatchObject({ imageMatches: true, outdated: false, container: "stopped" });
    expect(await vpsComputerAction("provision", CONFIG, BOT, runner)).toMatchObject({ ready: true, imageMatches: true, outdated: false });
  });

  it("the background update leaves the new computer asleep and does nothing to one that is current", async () => {
    const fake = daemon();
    await makeV1(fake, true);
    const updated = await vpsComputerAction("update", CONFIG, BOT, fake.runner);
    expect(updated).toMatchObject({ imageMatches: true, outdated: false, container: "stopped" });
    fake.calls.length = 0;
    expect(await vpsComputerAction("update", CONFIG, BOT, fake.runner)).toMatchObject({ container: "stopped", imageMatches: true });
    expect(fake.calls.every((args) => args[0] === "image" || args[0] === "inspect")).toBe(true);
  });

  it("never silently falls back to the Cua desktop: it builds the bot desktop from the kit, or refuses", async () => {
    const fake = daemon();
    const builds: string[][] = [];
    const runner: VpsCommandRunner = async (args, options) => {
      if (args[2] === "pull" && args[3] === BOT_DESKTOP_IMAGE) throw new Error("manifest unknown");
      if (args[2] === "build") { builds.push(args.slice(2)); fake.state.image = true; return { stdout: "", stderr: "" }; }
      return fake.runner(args, options);
    };
    const progress: string[] = [];
    const status = await vpsComputerAction("provision", CONFIG, BOT, runner, { onProgress: step => progress.push(step) });
    expect(status).toMatchObject({ desktop: "bot-desktop", image_ref: BOT_DESKTOP_IMAGE, ready: true });
    expect(progress).toEqual(["pulling", "building"]);
    expect(builds.map(args => args.at(-1))).toEqual([botDesktopKit()]);
    expect(fake.calls.some(args => args.some(arg => arg.includes("cua-local-vm")))).toBe(false);

    const refused = daemon();
    vi.stubEnv("MADANI_BOT_DESKTOP_KIT", join(tmpdir(), "madani-no-such-kit"));
    const offline: VpsCommandRunner = async (args, options) => {
      if (args[2] === "pull") throw new Error("manifest unknown");
      return refused.runner(args, options);
    };
    try {
      await expect(vpsComputerAction("provision", CONFIG, `${BOT}-offline`, offline)).rejects.toMatchObject({ status: 409, code: "bot_desktop_unavailable" });
      expect(refused.calls.some(args => ["build", "run", "network"].includes(args[0]!))).toBe(false);
    } finally { vi.stubEnv("MADANI_BOT_DESKTOP_KIT", undefined); }
  });

  it("pins an in-box browser to its observed container and SSH host", async () => {
    const fake = daemon();
    await vpsComputerAction("provision", CONFIG, BOT, fake.runner);
    try {
      const first = await vpsBoxChrome(CONFIG, BOT, "d".repeat(64), fake.runner);
      expect(first).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(await vpsBoxChrome(CONFIG, BOT, "d".repeat(64), fake.runner)).toBe(first);
      const other = await vpsBoxChrome({ vps: { sshAlias: "another-vps" } }, BOT, "d".repeat(64), fake.runner);
      expect(other).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(other).not.toBe(first);
      expect(await vpsBoxChrome(CONFIG, BOT, "e".repeat(64), fake.runner)).toBeNull();
    } finally {
      await vpsBoxChrome({}, BOT, undefined, fake.runner);
    }
  });
  it("surfaces low-memory browser admission before creating any relay", async () => {
    const fake = daemon();
    await vpsComputerAction("provision", CONFIG, BOT, fake.runner);
    const target = independentScreenTarget(BOT, 21);
    const screen = { containerId: "d".repeat(64), target };
    const relay = vi.spyOn(vpsLocal, "boxChromeRelay");
    const runner: VpsCommandRunner = async (args, options) => {
      if (args.includes("browser-ensure")) throw new Error(`omb-screen: ${SCREEN_BROWSER_LOW_MEMORY}`);
      return fake.runner(args, options);
    };
    try {
      await expect(vpsBoxChrome(CONFIG, BOT, screen.containerId, runner, screen)).rejects.toMatchObject({ status: 429, message: SCREEN_BROWSER_LOW_MEMORY });
      expect(relay).not.toHaveBeenCalled();
      expect(boxChromes.has(screenKey(BOT, screen))).toBe(false);
    } finally { relay.mockRestore(); closeVpsScreenConnections(BOT, screen); }
  });
  it("preflights only new independent relays and retries admission after their exact cache entry fails", async () => {
    const fake = daemon();
    await vpsComputerAction("provision", CONFIG, BOT, fake.runner);
    const target = independentScreenTarget(BOT, 2);
    const screen = { containerId: "d".repeat(64), target };
    let checks = 0;
    const runner: VpsCommandRunner = async (args, options) => {
      if (!args.includes("browser-ensure")) return fake.runner(args, options);
      checks += 1;
      if (checks > 1) throw new Error(SCREEN_BROWSER_LOW_MEMORY);
      return { stdout: JSON.stringify({ version: 2, browserReady: true, display: target.display, botHash: target.botHash, generation: target.generation }), stderr: "" };
    };
    try {
      const url = await vpsBoxChrome(CONFIG, BOT, screen.containerId, runner, screen);
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(await vpsBoxChrome(CONFIG, BOT, screen.containerId, runner, screen)).toBe(url);
      expect(checks).toBe(1);
      evictVpsBoxChrome(screenKey(BOT, screen), url!);
      await expect(vpsBoxChrome(CONFIG, BOT, screen.containerId, runner, screen)).rejects.toMatchObject({ status: 429 });
      expect(checks).toBe(2);
    } finally { closeVpsScreenConnections(BOT, screen); }
  });
});
