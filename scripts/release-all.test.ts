import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { signPolicy, verifyPolicy } from "../apps/cloud-service/src/update-policy.ts";
import type { FleetAnswer } from "../apps/dashboard/server/admin/ops/fleet.ts";
import { configOf, createRelease, judge, nextPolicy, release, rolloutSteps } from "./release-all.ts";

const { privateKey } = generateKeyPairSync("ed25519");
const signing = `test-rel:${privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url")}`;
const publicKeys = `test-rel:${createPublicKey(privateKey).export({ format: "jwk" }).x}`;
const MIN = 60_000;

const fleetOf = (over: { desktops?: FleetAnswer["desktops"]["versions"]; canary?: FleetAnswer["clouds"]["canary"] } = {}): FleetAnswer =>
  ({ at: 0, desktops: { days: 14, versions: over.desktops ?? [] }, clouds: { versions: [], canary: over.canary ?? [] }, servers: null });
const cloud = (id: string, version: string | null, extra: object = {}) => ({ id, version, trial: null, rolledBack: null, refused: null, stuck: false, ...extra });

describe("the release tool's decisions", () => {
  it("rolls desktops out in growing steps that end at 100, or at once", () => {
    expect(rolloutSteps(undefined, false)).toEqual([10, 50, 100]);
    expect(rolloutSteps("5,100", false)).toEqual([5, 100]);
    expect(rolloutSteps("50,10,100", true)).toEqual([100]);
    expect(() => rolloutSteps("50,10,100", false)).toThrow();
    expect(() => rolloutSteps("10,50", false)).toThrow();
  });

  it("signs each policy past the served serial, keeps the floor and blocks, and drops a finished rollout", () => {
    const served = { serial: 7, floor: "0.2.0", blocked: ["0.2.20"] };
    const staged = nextPolicy(served, 0, { rollout: ["0.2.26", 10] });
    expect(staged).toEqual({ serial: 8, floor: "0.2.0", blocked: ["0.2.20"], rollout: { "0.2.26": 10 } });
    const widened = nextPolicy(staged, 9, { rollout: ["0.2.26", 100] });
    expect(widened).toEqual({ serial: 10, floor: "0.2.0", blocked: ["0.2.20"] });
    expect(nextPolicy(widened, 0, { block: "0.2.26", rollout: ["0.2.26", null] })).toEqual({ serial: 11, floor: "0.2.0", blocked: ["0.2.20", "0.2.26"] });
    expect(nextPolicy(nextPolicy(widened, 0, { paused: true }), 0, { paused: false })).toEqual({ serial: 12, floor: "0.2.0", blocked: ["0.2.20"] });
  });

  it("halts on a canary cloud that rolled the version back or a desktop error spike, and widens only after the watch", () => {
    const base = { version: "0.2.26", canary: ["c1", "c2"], startedAt: 0, watchMs: 30 * MIN, maxWaitMs: 120 * MIN };
    expect(judge(fleetOf({ canary: [cloud("c1", "0.2.25", { rolledBack: "0.2.26" }), cloud("c2", "0.2.26")] }), { ...base, now: MIN }).verdict).toBe("halt");
    expect(judge(fleetOf({ canary: [cloud("c1", "0.2.26", { stuck: true })] }), { ...base, now: MIN }).verdict).toBe("halt");
    const spike = [{ version: "0.2.26", installs: 40, errors: 60 }, { version: "0.2.25", installs: 400, errors: 80 }];
    expect(judge(fleetOf({ desktops: spike }), { ...base, canary: [], now: MIN })).toMatchObject({ verdict: "halt" });
    const calm = [{ version: "0.2.26", installs: 40, errors: 10 }, { version: "0.2.25", installs: 400, errors: 80 }];
    const through = [cloud("c1", "0.2.26", { trial: "passed" }), cloud("c2", "0.2.25")];
    expect(judge(fleetOf({ desktops: calm, canary: through }), { ...base, now: 10 * MIN }).verdict).toBe("wait");
    expect(judge(fleetOf({ desktops: calm, canary: through }), { ...base, now: 31 * MIN }).verdict).toBe("healthy");
    // few installs say nothing yet about errors
    expect(judge(fleetOf({ desktops: [{ version: "0.2.26", installs: 3, errors: 30 }], canary: through }), { ...base, now: 31 * MIN }).verdict).toBe("healthy");
    const pending = [cloud("c1", "0.2.26", { trial: "pending" }), cloud("c2", "0.2.25")];
    expect(judge(fleetOf({ canary: pending }), { ...base, now: 31 * MIN }).verdict).toBe("wait");
    expect(judge(fleetOf({ canary: pending }), { ...base, now: 121 * MIN }).verdict).toBe("timeout");
  });
});

describe("a release run", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  function world(o: { fleet: () => FleetAnswer; served?: { serial: number; floor: string | null; blocked: string[] } }) {
    const stateDir = mkdtempSync(join(tmpdir(), "madani-release-all-")); dirs.push(stateDir);
    const ran: string[] = [], placed: Array<{ to: string; text: string }> = [];
    let policyDoc: string | null = o.served ? JSON.stringify(signPolicy(o.served, signing)) : null, clock = 1_000_000;
    const env = { MADANI_RELEASE_SIGNING_KEY: signing, MADANI_RELEASE_PUBLIC_KEYS: publicKeys, MADANI_OPS_TOKEN: "o".repeat(32) };
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/v1/updates/policy")) return policyDoc ? new Response(policyDoc) : new Response("{}", { status: 404 });
      if (url.includes("/v1/ops/fleet")) return new Response(JSON.stringify(o.fleet()));
      if (url.endsWith("/releases/latest.json")) return new Response(JSON.stringify({ version: "0.2.26" }));
      if (url.endsWith("/v1/release")) return new Response(JSON.stringify({ v: 1, agent: { version: "9.9.9" } }));
      return new Response("no", { status: 404 });
    }) as unknown as typeof fetch;
    const sh = (cmd: string, args: string[], input?: string) => {
      const line = `${cmd} ${args.join(" ")}`;
      ran.push(line);
      if (cmd === "git" && args[0] === "rev-parse") return "c".repeat(40);
      if (cmd === "git" && args[0] === "status") return "";
      if (cmd === "ssh" && input !== undefined) {
        const to = /mv -f '[^']+' '([^']+)'/.exec(args.at(-1)!)![1]!;
        placed.push({ to, text: input });
        if (to.endsWith("home/update-policy.json")) policyDoc = input;
      }
      return "";
    };
    const r = createRelease({ cfg: configOf({}), env, dryRun: false, fetchImpl, sh, now: () => (clock += MIN), sleep: async () => {}, log: () => {}, stateDir, siteDir: stateDir });
    return { r, ran, placed, stateDir, policy: () => verifyPolicy(JSON.parse(policyDoc!), [{ kid: "test-rel", x: publicKeys.split(":")[1]! }]) };
  }
  const options = { version: "0.2.26", now: false, canary: ["c1"], steps: [10, 100], watchMs: 5 * MIN, maxWaitMs: 20 * MIN, skipBuild: true, dryRun: false, pollMs: 0 };

  it("halts and blocks the version everywhere when the canary cloud rolls it back, and a rerun stays halted", async () => {
    const w = world({ fleet: () => fleetOf({ canary: [cloud("c1", "0.2.25", { rolledBack: "0.2.26" })] }), served: { serial: 3, floor: null, blocked: [] } });
    // the cloud package step needs a built package; stand one in
    const pkgDir = join(process.cwd(), "release", "home");
    const made = !existsSync(join(pkgDir, "omb-home.tgz"));
    if (made) { mkdirSync(pkgDir, { recursive: true }); writeFileSync(join(pkgDir, "omb-home.tgz"), "home package"); }
    try {
      expect(await release(w.r, options)).toBe("halted");
      expect(w.policy()).toMatchObject({ blocked: ["0.2.26"] });
      expect(w.policy().rollout).toBeUndefined();
      const releaseFile = w.placed.find(p => p.to.endsWith("home/release.json"))!;
      expect(JSON.parse(releaseFile.text)).toMatchObject({ version: "0.2.26", clouds: ["c1"], file: "/var/lib/madani-account-prod/home/omb-home-0.2.26.tgz" });
      expect(w.placed.filter(p => p.to.endsWith("update-policy.json")).map(p => p.to)).toEqual(expect.arrayContaining(["/var/lib/madani-account-prod/home/update-policy.json", "/root/omb-link-data/packages/update-policy.json"]));
      expect(w.ran.some(line => line.includes("build-vps-package"))).toBe(false);
      const state = JSON.parse(readFileSync(w.r.stateFile("0.2.26"), "utf8"));
      expect(state.halted).toMatch(/rolled 0.2.26 back/);
      expect(await release(w.r, options)).toBe("halted");
    } finally {
      if (made) rmSync(join(pkgDir, "omb-home.tgz"));
    }
  });

  it("widens to every cloud and desktop after a healthy canary, and a rerun skips what is done", async () => {
    const healthy = () => fleetOf({ canary: [cloud("c1", "0.2.26", { trial: "passed" })] });
    const w = world({ fleet: healthy, served: { serial: 3, floor: null, blocked: [] } });
    const pkgDir = join(process.cwd(), "release", "home");
    const made = !existsSync(join(pkgDir, "omb-home.tgz"));
    if (made) { mkdirSync(pkgDir, { recursive: true }); writeFileSync(join(pkgDir, "omb-home.tgz"), "home package"); }
    try {
      await expect(release(w.r, options)).rejects.toThrow(/manifest\.json|ENOENT|not signed/);
      const releases = w.placed.filter(p => p.to.endsWith("home/release.json")).map(p => JSON.parse(p.text));
      expect(releases.at(-1)).not.toHaveProperty("clouds");
      expect(w.policy().rollout).toBeUndefined();
      expect(w.policy().serial).toBe(5);
      const state = JSON.parse(readFileSync(w.r.stateFile("0.2.26"), "utf8"));
      expect(Object.keys(state.done)).toEqual(["preflight", "desktop-rollout", "desktop", "cloud-package", "canary", "cloud-widen", "desktop-100"]);
      const before = w.ran.length;
      await expect(release(w.r, options)).rejects.toThrow();
      expect(w.ran.slice(before).some(line => line.includes("build-home-package"))).toBe(false);
    } finally {
      if (made) rmSync(join(pkgDir, "omb-home.tgz"));
    }
  });
});
