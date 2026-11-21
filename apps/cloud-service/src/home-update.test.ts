import { CLOUD_HOME } from "../../../electron/legacy-names.mjs";
import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DESKTOP_IMAGE_STATUS, homeControlScript, homeSetupScript, HOME_CONTROL, HOME_SCREEN_DIRECT_PORTS } from "./home.ts";
import { createReleaseFile, type HomeRelease } from "./home-update.ts";
import { signRelease, type ReleaseKey } from "./release-signing.ts";
import { createPolicySource, signPolicy, verifyPolicy } from "./update-policy.ts";
import { homeFixture, cleanup } from "./test-fixture.ts";
import type { StoredCloud } from "../../dashboard/server/clouds/types.ts";

const { privateKey } = generateKeyPairSync("ed25519");
const signing = `test-rel:${privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url")}`;
const keys: ReleaseKey[] = [{ kid: "test-rel", x: createPublicKey(privateKey).export({ format: "jwk" }).x! }];
const sha = (v: string) => createHash("sha256").update(`pkg-${v}`).digest("hex");
const release = (version: string): HomeRelease => ({ sha256: sha(version), url: `https://packages.example.test/${version}.tgz`,
  signature: signRelease({ kind: "home-package", name: "omb-home", version, sha256: sha(version), signedAt: 1 }, signing) });

async function updating(options: { policy?: { serial: number; floor: string | null; blocked: string[] } } = {}) {
  let offered: HomeRelease | null = null;
  const dir = mkdtempSync(join(tmpdir(), "madani-policy-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const policyFile = join(dir, "policy.json");
  if (options.policy) writeFileSync(policyFile, JSON.stringify(signPolicy(options.policy, signing)));
  const f = await homeFixture({ releaseKeys: keys, settings: { package: release("1.0.0") }, release: () => offered, updatePolicy: createPolicySource(policyFile, keys, () => {}) });
  const { c } = await f.paid();
  const commands = () => f.api.requests.filter(r => r.path.endsWith("/exec")).map(r => (r.body as { cmd: string }).cmd);
  const actions = () => f.audit.entries(c.id).filter(e => e.action.startsWith("update_") && e.action !== "update_policy").map(e => `${e.action}:${e.reason}`);
  /** one reconcile with the home's power read due */
  const pass = async () => { f.advance(61_000); c.nextAttemptAt = 0; await f.service.reconcile(); };
  return { f, c, commands, actions, pass, offer: (r: HomeRelease | null) => { offered = r; }, policyFile,
    setPolicy: (p: { serial: number; floor: string | null; blocked: string[]; paused?: boolean }) => { writeFileSync(policyFile, JSON.stringify(signPolicy(p, signing))); } };
}
const version = (c: StoredCloud) => c.managed!.update?.guard.current?.version ?? null;

describe("staged home updates", () => {
  it("installs a newer signed release only while the home is idle, self-tests it and settles after two runs", async () => {
    const t = await updating();
    expect(version(t.c) ?? "1.0.0").toBe("1.0.0");
    t.offer(release("1.1.0"));
    t.f.power.busy = ["turn"];
    await t.pass();
    expect(t.commands().filter(x => x.includes("omb-home install"))).toHaveLength(1);
    t.f.power.busy = ["run"]; await t.pass();
    t.f.power.busy = ["maintenance"]; await t.pass();
    expect(t.c.managed!.update!.guard.trial).toBeNull();
    t.f.power.busy = ["recent-activity"];
    await t.pass();
    const install = t.commands().filter(x => x.includes("omb-home install")).at(-1)!;
    expect(install).toContain(sha("1.1.0"));
    expect(install).toContain(release("1.1.0").signature!);
    expect(t.c.managed!.installed).toBe(sha("1.1.0"));
    expect(t.c.managed!.update!.guard.trial).toMatchObject({ to: { version: "1.1.0" }, selfTest: "pending" });
    // the self-test still runs: the home is kept up, never put to sleep in the middle
    t.f.power.idle = true; t.f.power.busy = [];
    Object.assign(t.f.update, { version: "1.1.0", selfTest: "running" });
    await t.pass();
    expect(t.c.status).toBe("running");
    const at = t.f.now();
    Object.assign(t.f.update, { selfTest: "passed", runs: [{ id: "r1", ok: true, at }, { id: "r2", ok: false, at: at + 1 }] });
    await t.pass();
    expect(t.c.managed!.update!.guard.trial).toBeNull();
    expect(t.c.managed!.update!.guard.last).toMatchObject({ kind: "updated", version: "1.1.0" });
    expect(t.actions()).toEqual(["update_applied:idle", "update_settled:trial_passed"]);
  });

  it("a release that lists cloud ids installs on those clouds only; the rest stay on the package the service started with", async () => {
    const other = await updating();
    other.offer({ ...release("1.1.0"), clouds: ["some-other-cloud"] });
    other.f.power.busy = ["recent-activity"];
    await other.pass();
    expect(other.commands().filter(x => x.includes("omb-home install") && x.includes(sha("1.1.0")))).toHaveLength(0);
    expect(other.c.managed!.installed).toBe(sha("1.0.0"));
    expect(other.actions()).toEqual([]);

    const canary = await updating();
    canary.offer({ ...release("1.1.0"), clouds: [canary.c.id] });
    canary.f.power.busy = ["recent-activity"];
    await canary.pass();
    expect(canary.commands().filter(x => x.includes("omb-home install")).at(-1)).toContain(sha("1.1.0"));
    expect(canary.c.managed!.installed).toBe(sha("1.1.0"));
    expect(canary.actions()).toEqual(["update_applied:idle"]);
  });

  it("reads a release file's cloud list, and treats an empty list as every cloud", () => {
    const dir = mkdtempSync(join(tmpdir(), "madani-release-file-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "release.json");
    writeFileSync(file, JSON.stringify({ sha256: sha("1.1.0"), url: "https://packages.example.test/1.1.0.tgz", clouds: ["c1", 7, "c2"] }));
    expect(createReleaseFile(file)()).toMatchObject({ sha256: sha("1.1.0"), clouds: ["c1", "c2"] });
    const later = join(dir, "all.json");
    writeFileSync(later, JSON.stringify({ sha256: sha("1.1.0"), url: "https://packages.example.test/1.1.0.tgz", clouds: [] }));
    expect(createReleaseFile(later)()).not.toHaveProperty("clouds");
  });

  it("the operator can end a trial early once its self-test passed, so the next release installs at the next idle moment", async () => {
    const t = await updating();
    t.offer(release("1.1.0"));
    t.f.power.busy = ["recent-activity"];
    await t.pass();
    const managed = t.f.service.managed!;
    expect(managed.endTrial!(t.c, "test_cloud")).toEqual({ refused: "self_test_pending" });
    Object.assign(t.f.update, { version: "1.1.0", selfTest: "passed", runs: [] });
    await t.pass();
    expect(t.c.managed!.update!.guard.trial).toMatchObject({ selfTest: "passed" });
    t.offer(release("1.2.0"));
    await t.pass();
    expect(t.c.managed!.installed).toBe(sha("1.1.0"));
    expect(managed.endTrial!(t.c, "test_cloud")).toEqual({ ended: "1.1.0" });
    expect(t.f.audit.entries(t.c.id).find(e => e.action === "update_settled")).toMatchObject({ actor: "operator", reason: "operator", detail: { version: "1.1.0", why: "test_cloud" } });
    await t.pass();
    expect(t.c.managed!.installed).toBe(sha("1.2.0"));
    expect(managed.endTrial!(t.c, "test_cloud")).toEqual({ refused: "self_test_pending" });
    expect(t.c.managed!.update!.guard.trial).toMatchObject({ to: { version: "1.2.0" } });
  });

  it("rolls back automatically when the self-test fails, and never installs that version again", async () => {
    const t = await updating();
    t.offer(release("1.1.0"));
    await t.pass();
    Object.assign(t.f.update, { version: "1.1.0", selfTest: "failed" });
    await t.pass();
    expect(t.commands().some(x => x.includes("omb-home rollback"))).toBe(true);
    expect(t.commands().at(-1)).toContain("omb-home start");
    expect(t.c.managed!.installed).toBe(sha("1.0.0"));
    expect(version(t.c)).toBe("1.0.0");
    expect(t.actions()).toEqual(["update_applied:idle", "update_rolled_back:self_test"]);
    const installs = t.commands().filter(x => x.includes("omb-home install")).length;
    Object.assign(t.f.update, { version: "1.0.0", selfTest: "passed" });
    await t.pass(); await t.pass();
    expect(t.commands().filter(x => x.includes("omb-home install")).length).toBe(installs);
    expect(t.actions().at(-1)).toBe("update_refused:failed_here");
  });

  it("rolls back when the new version does not answer within the self-test window", async () => {
    const t = await updating();
    t.offer(release("1.1.0"));
    await t.pass();
    t.f.home.update.mockRejectedValue(new Error("down"));
    await t.pass();
    expect(t.c.managed!.update!.guard.trial).not.toBeNull();
    t.f.advance(5 * 60_000);
    await t.pass();
    expect(t.actions()).toContain("update_rolled_back:self_test");
  });

  it("rolls back when the next two runs fail in a row, once the home is idle", async () => {
    const t = await updating();
    t.offer(release("1.1.0"));
    await t.pass();
    const at = t.f.now();
    Object.assign(t.f.update, { version: "1.1.0", selfTest: "passed", runs: [{ id: "a", ok: false, at }, { id: "b", ok: false, at: at + 1 }] });
    t.f.power.busy = ["run"];
    await t.pass();
    expect(t.c.managed!.installed).toBe(sha("1.1.0"));
    t.f.power.busy = [];
    await t.pass();
    expect(t.c.managed!.installed).toBe(sha("1.0.0"));
    expect(t.actions().at(-1)).toBe("update_rolled_back:runs_failed");
    expect(t.f.audit.entries(t.c.id).find(e => e.action === "update_rolled_back")!.detail).toMatchObject({ from: "1.1.0", to: "1.0.0", rerunFree: 2 });
  });

  it("never installs a blocked version, and rolls a running one back when it is blocked later", async () => {
    const t = await updating({ policy: { serial: 1, floor: null, blocked: ["1.1.0"] } });
    t.offer(release("1.1.0"));
    await t.pass();
    expect(t.commands().some(x => x.includes(sha("1.1.0")))).toBe(false);
    expect(t.actions()).toContain("update_refused:blocked");
    // 1.2.0 goes in and settles; then the operator pulls it
    t.offer(release("1.2.0"));
    await t.pass();
    Object.assign(t.f.update, { version: "1.2.0", selfTest: "passed" });
    t.f.advance(25 * 3_600_000); await t.pass();
    expect(t.c.managed!.update!.guard.last).toMatchObject({ kind: "updated", version: "1.2.0" });
    t.setPolicy({ serial: 2, floor: null, blocked: ["1.1.0", "1.2.0"] });
    await t.pass();
    expect(t.actions().at(-1)).toBe("update_rolled_back:blocked");
    expect(t.c.managed!.installed).toBe(sha("1.0.0"));
  });

  it("refuses a downgrade and anything below the signed floor, and passes the floor to the machine", async () => {
    const t = await updating({ policy: { serial: 1, floor: "1.0.0", blocked: [] } });
    t.offer(release("0.9.0"));
    await t.pass();
    expect(t.actions()).toEqual(["update_refused:below_floor"]);
    t.setPolicy({ serial: 2, floor: null, blocked: [] });
    await t.pass();
    expect(t.actions().at(-1)).toBe("update_refused:not_newer");
    expect(t.commands().filter(x => x.includes("omb-home install"))).toHaveLength(1);
    // an unsigned release is never installed where releases must be signed
    t.setPolicy({ serial: 3, floor: "1.0.0", blocked: [] });
    t.offer({ ...release("2.0.0"), signature: undefined });
    await t.pass();
    expect(t.actions().at(-1)).toBe("update_refused:invalid");
    t.offer(release("2.0.0"));
    await t.pass();
    expect(t.commands().at(-2)).toMatch(/omb-home install \S+ [a-f0-9]{64} r1\.\S+ 1\.0\.0$/);
  });

  it("offers a canary release only to the clouds it names, and holds every install while the policy is paused", async () => {
    const t = await updating();
    t.offer({ ...release("1.1.0"), clouds: ["cloud_other"] });
    await t.pass();
    expect(t.commands().some(x => x.includes(sha("1.1.0")))).toBe(false);
    expect(t.actions()).toEqual([]);
    t.setPolicy({ serial: 1, floor: null, blocked: [], paused: true });
    t.offer({ ...release("1.1.0"), clouds: ["cloud_other", t.c.id] });
    await t.pass();
    expect(t.commands().some(x => x.includes(sha("1.1.0")))).toBe(false);
    expect(t.actions()).toEqual(["update_refused:paused"]);
    t.setPolicy({ serial: 2, floor: null, blocked: [] });
    t.offer(release("1.1.0"));
    await t.pass();
    expect(t.c.managed!.installed).toBe(sha("1.1.0"));
  });

  it("serves only a policy the pinned keys signed, and keeps the last good one", () => {
    const dir = mkdtempSync(join(tmpdir(), "madani-policy-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "p.json"), alerts: string[] = [];
    writeFileSync(file, JSON.stringify(signPolicy({ serial: 4, floor: "1.0.0", blocked: [] }, signing)));
    const source = createPolicySource(file, keys, line => alerts.push(line));
    expect(source.policy()).toEqual({ serial: 4, floor: "1.0.0", blocked: [] });
    const signed = source.signed()!;
    writeFileSync(file, JSON.stringify({ ...signed, body: signed.body.replace("1.0.0", "0.0.1") }));
    expect(source.policy()?.floor).toBe("1.0.0");
    expect(alerts).toHaveLength(1);
    expect(() => verifyPolicy({ ...signed, body: signed.body.replace("1.0.0", "0.0.1") }, keys)).toThrow();
  });
});

describe("omb-home on the machine", () => {
  // the real control script, its root paths moved into a temp folder and root-only commands stubbed
  function machine() {
    const dir = mkdtempSync(join(tmpdir(), "madani-machine-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const bin = join(dir, "stub"); mkdirSync(bin);
    writeFileSync(join(bin, "chown"), "#!/bin/sh\nexit 0\n"); chmodSync(join(bin, "chown"), 0o755);
    // systemctl records what it was asked; docker has the image once `have-image` exists, and its registry refuses a pull
    writeFileSync(join(bin, "systemctl"), `#!/bin/sh\necho "$*" >> ${join(dir, "systemctl.log")}\nexit 0\n`); chmodSync(join(bin, "systemctl"), 0o755);
    writeFileSync(join(bin, "docker"), `#!/bin/sh\necho "$*" >> ${join(dir, "docker.log")}\ncase "$1 $2" in "image inspect") [ -f ${join(dir, "have-image")} ]; exit $? ;; esac\n[ "$1" = pull ] && exit 1\nexit 0\n`); chmodSync(join(bin, "docker"), 0o755);
    writeFileSync(join(bin, "install"), "#!/bin/sh\nwhile [ $# -gt 1 ]; do case \"$1\" in -d) ;; -o|-g|-m) shift ;; *) mkdir -p \"$1\" ;; esac; shift; done\n[ -z \"$1\" ] || mkdir -p \"$1\"\n");
    chmodSync(join(bin, "install"), 0o755);
    // macOS has no gnu sha256sum
    if (process.platform === "darwin") { writeFileSync(join(bin, "sha256sum"), "#!/bin/sh\nexec shasum -a 256 \"$@\"\n"); chmodSync(join(bin, "sha256sum"), 0o755); }
    const script = homeControlScript({ releaseKeys: keys, requireSigned: true }).replaceAll("/var/run/docker.sock", join(dir, "docker.sock")).replaceAll("/var/log/omb-desktop-image.log", join(dir, "desktop.log"))
      .replaceAll(CLOUD_HOME.run, join(dir, "run")).replaceAll(CLOUD_HOME.root, join(dir, "root")).replaceAll(`${join(dir, "root")}/node/bin/node`, process.execPath);
    writeFileSync(join(dir, "omb-home"), script); mkdirSync(join(dir, "root"), { recursive: true });
    const pkg = (v: string, kit = false) => {
      const stage = join(dir, `stage-${v}`); mkdirSync(join(stage, "dist-server"), { recursive: true });
      writeFileSync(join(stage, "dist-server", "cloud-home-start.js"), `// ${v}\n`);
      if (kit) {
        // the bot computer kit as the package carries it: its build script stands in for `docker build`
        mkdirSync(join(stage, "deploy", "bot-desktop"), { recursive: true }); mkdirSync(join(stage, "shared"));
        writeFileSync(join(stage, "deploy", "bot-desktop", "Dockerfile"), "ARG BOT_DESKTOP_VERSION=3\n");
        writeFileSync(join(stage, "deploy", "bot-desktop", "build.sh"), `[ -f ${join(dir, "fail-build")} ] && exit 1\necho "$IMAGE" > ${join(dir, "built")}\n`);
        writeFileSync(join(stage, "shared", "bot-desktop.ts"), 'export const BOT_DESKTOP_VERSION = "3";\nexport const BOT_DESKTOP_IMAGE = "ghcr.io/sidddevz/omb-bot-desktop:v3";\n');
      }
      const file = join(dir, `pkg-${v}.tgz`); execFileSync("tar", ["-czf", file, "-C", stage, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
      const sum = createHash("sha256").update(readFileSync(file)).digest("hex");
      return { file, sum, sig: signRelease({ kind: "home-package", name: "omb-home", version: v, sha256: sum, signedAt: 1 }, signing) };
    };
    const run = (...args: string[]) => {
      try { return execFileSync("bash", [join(dir, "omb-home"), ...args], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: dir } }).trim(); }
      catch (error) { return String((error as { stdout?: string }).stdout ?? "").trim().split("\n").at(-1)!; }
    };
    const running = () => readFileSync(join(dir, "root", "app", "dist-server", "cloud-home-start.js"), "utf8").trim();
    const status = () => { try { return readFileSync(join(dir, "run", DESKTOP_IMAGE_STATUS.split("/").at(-1)!), "utf8").trim(); } catch { return null; } };
    const asked = () => { try { return readFileSync(join(dir, "systemctl.log"), "utf8"); } catch { return ""; } };
    /** a docker daemon socket, so the script sees a machine with docker */
    const docker = () => new Promise<void>(resolve => { const server = createServer().listen(join(dir, "docker.sock"), () => resolve()); cleanup.push(() => new Promise<void>(r => server.close(() => r()))); });
    return { dir, pkg, run, running, status, asked, docker };
  }

  it("installs a newer signed package, refuses an older one or one below the floor, and rolls back to the one before", () => {
    const m = machine();
    const v1 = m.pkg("1.0.0"), v2 = m.pkg("1.1.0");
    expect(m.run("install", v1.file, v1.sum, v1.sig)).toBe("installed");
    expect(m.run("install", v2.file, v2.sum, v2.sig, "1.0.0")).toBe("installed");
    expect(m.running()).toBe("// 1.1.0");
    const old = m.pkg("1.0.0");
    expect(m.run("install", old.file, old.sum, old.sig)).toBe("older package");
    const v3 = m.pkg("1.2.0");
    expect(m.run("install", v3.file, v3.sum, v3.sig, "1.3.0")).toBe("below floor");
    const again = m.pkg("1.1.1");
    expect(m.run("install", again.file, again.sum, "r1.bad.x.y")).toBe("bad signature");
    expect(m.running()).toBe("// 1.1.0");
    expect(m.run("rollback")).toBe("rolled back");
    expect(m.running()).toBe("// 1.0.0");
    expect(readFileSync(join(m.dir, "root", "installed-version"), "utf8").trim()).toBe("1.0.0");
    expect(readFileSync(join(m.dir, "root", "installed"), "utf8").trim()).toBe(v1.sum);
    expect(m.run("rollback")).toBe("nothing to roll back to");
    expect(existsSync(join(m.dir, "root", "app.prev"))).toBe(false);
  });

  it("makes the bot computers' image ready without anyone's step: install starts its unit without waiting, and the unit builds from the package's kit when the registry refuses", async () => {
    const m = machine();
    await m.docker();
    const v1 = m.pkg("1.0.0", true);
    expect(m.run("install", v1.file, v1.sum, v1.sig)).toBe("installed");
    expect(m.asked()).toContain("start --no-block omb-desktop-image.service");
    expect(m.asked()).toContain("enable omb-desktop-image.service");
    // the unit's own run: the pull is refused, the kit builds the image under the name the app looks for
    expect(m.run("desktop-image")).toBe("ready");
    // the home's server, not root, reads it: under the script's umask it would be root's alone
    expect(statSync(join(m.dir, "run", DESKTOP_IMAGE_STATUS.split("/").at(-1)!)).mode & 0o777).toBe(0o644);
    expect(readFileSync(join(m.dir, "built"), "utf8").trim()).toBe("ghcr.io/sidddevz/omb-bot-desktop:v3");
    expect(readFileSync(join(m.dir, "docker.log"), "utf8")).toContain("pull -q ghcr.io/sidddevz/omb-bot-desktop:v3");
    expect(m.status()).toBe("ready");
    // once there, nothing is pulled or built again, and a start does not start the unit
    rmSync(join(m.dir, "built")); writeFileSync(join(m.dir, "have-image"), "");
    expect(m.run("desktop-image")).toBe("ready");
    expect(existsSync(join(m.dir, "built"))).toBe(false);
    rmSync(join(m.dir, "systemctl.log"));
    m.run("start", "https://a.example.test", "https://b.example.test");
    expect(m.asked()).not.toContain("omb-desktop-image");
  });

  it("a failed image build says so to the home, and a later start tries it again in the background", async () => {
    const m = machine();
    await m.docker();
    const v1 = m.pkg("1.0.0", true);
    expect(m.run("install", v1.file, v1.sum, v1.sig)).toBe("installed");
    writeFileSync(join(m.dir, "fail-build"), "");
    expect(m.run("desktop-image")).toBe("build failed");
    expect(m.status()).toBe("failed");
    rmSync(join(m.dir, "systemctl.log"));
    m.run("start", "https://a.example.test", "https://b.example.test");
    expect(m.asked()).toContain("start --no-block omb-desktop-image.service");
  });

  it("a machine without docker never starts the image unit", () => {
    const m = machine();
    const v1 = m.pkg("1.0.0", true);
    expect(m.run("install", v1.file, v1.sum, v1.sig)).toBe("installed");
    expect(m.asked()).not.toContain("omb-desktop-image");
  });
});

describe("the machine's setup", () => {
  it("installs the bot computer image unit beside the gate and tells the home where its status is", () => {
    const setup = homeSetupScript();
    expect(setup).toContain("/etc/systemd/system/omb-desktop-image.service");
    const unit = setup.slice(setup.indexOf("<<'MADANI_DESKTOP'"), setup.indexOf("MADANI_DESKTOP\n", setup.indexOf("<<'MADANI_DESKTOP'") + 20));
    expect(unit).toContain(`ExecStart=${HOME_CONTROL} desktop-image`);
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("Type=oneshot");
    expect(unit).toMatch(/Nice=\d+/);
    expect(setup).toContain(`MADANI_BOT_DESKTOP_HOST_BUILD: "${DESKTOP_IMAGE_STATUS}"`);
    // the direct screen path binds a fixed UDP range, the server image's
    expect(setup).toContain(`MADANI_SCREEN_DIRECT_PORTS: "${HOME_SCREEN_DIRECT_PORTS}"`);
    // the gate never builds: only root's unit does, from the signed package's kit
    expect(homeControlScript()).toContain('sh "$kit/build.sh"');
  });
});
