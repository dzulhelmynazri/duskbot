import { execFile } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { signRelease } from "../../cloud-service/src/release-signing.ts";

const run = promisify(execFile);
const script = (await readFile(new URL("../install.sh", import.meta.url), "utf8")).replace(/\nmain "\$@"\s*$/, "\n");
const { privateKey } = generateKeyPairSync("ed25519");
const signing = `test-vps:${privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url")}`;
const publicKey = `test-vps:${createPublicKey(privateKey).export({ format: "jwk" }).x}`;
const dirs = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const bytesOf = (version) => `v=${version}`;
const shaOf = (version) => createHash("sha256").update(bytesOf(version)).digest("hex");
const sig = (version, sha = shaOf(version)) => signRelease({ kind: "vps-package", name: "madanibot", version, sha256: sha, signedAt: 1 }, signing);

/**
 * a linked server on `installed`, with the link agent's staged build `staged` (its ready.json and tgz), systemd saying
 * `unit` for madanibot.service and the server answering its busy reads in turn from `busy` (the last repeats; "down" is a
 * refused connection); `before(home)` plants things in the server account's home. runs root's `--update-server` once
 */
async function updateRound({ installed = "1.0.0", staged = "1.1.0", ready = {}, tgz = bytesOf(staged), unit = "active", busy = ["idle"], selfTest = { version: staged, ok: true, at: 1, checks: {} }, state = {}, before = async () => {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "omb-server-update-")); dirs.push(dir);
  const home = join(dir, "home"), stateDir = join(dir, "state"), data = join(home, ".madanibot"), release = join(dir, "release"), cache = join(home, ".cache/madanibot-link");
  for (const path of [join(home, ".local/lib/node_modules/madanibot"), join(home, ".local/bin"), stateDir, data, release, cache]) await mkdir(path, { recursive: true });
  await writeFile(join(home, ".local/lib/node_modules/madanibot/package.json"), `{\n  "version": "${installed}"\n}\n`);
  await writeFile(join(home, ".local/bin/madanibot"), "#!/bin/sh\n", { mode: 0o755 });
  await writeFile(join(cache, `madanibot-${shaOf(installed)}.tgz`), bytesOf(installed));
  await before(home, dir);
  for (const [key, value] of Object.entries({ linked: "abcdefghij", id: "abcdefghij", package: `sha256:${shaOf(installed)}`, "running-package": `sha256:${shaOf(installed)}`, ...state })) {
    await writeFile(join(stateDir, key), `${value}\n`);
  }
  if (selfTest) await writeFile(join(data, "update-state.json"), JSON.stringify({ v: 1, boots: [], selfTest }));
  const sha = shaOf(staged);
  await writeFile(join(release, `${sha}.tgz`), tgz);
  await writeFile(join(release, "ready.json"), JSON.stringify({ v: 1, sha256: sha, size: tgz.length, version: staged, signature: sig(staged), at: 1, ...ready }));
  const file = join(dir, "fixture.sh");
  await writeFile(file, `${script}
SVC_HOME=${home} CLI=${join(dir, "cli")} STATE=${stateDir} DATA=${data} SERVER_RELEASE=${release} INSTALL_LOCK=${join(dir, "lock")} NODE_BIN=${process.execPath} SELFTEST_WAIT=2 UPDATER=${join(dir, "updater.sh")} PKGS=${join(dir, "root-pkgs")} UPDATE_RESTART_WAIT=30
log=${join(dir, "log")} answers=${join(dir, "answers")}
printf '%s\\n' ${busy.join(" ")} > "$answers"
id() { echo 0; }
get_package() { :; }
as_link() { printf 'as_link %s\\n' "$*" >> "$log"; "$@"; }
as_user() { [ "$1" = npm ] || { printf 'as_user %s\\n' "$1" >> "$log"; "$@"; return; }; printf 'as_user %s\\n' "$*" >> "$log"; eval "f=\\\${$#}"; v=$(sed -n 's/^v=//p' "$f" 2>/dev/null); [ -z "$v" ] || printf '{\\n  "version": "%s"\\n}\\n' "$v" > "$SVC_HOME/.local/lib/node_modules/madanibot/package.json"; }
retry() { "$@"; }
chown() { printf 'root chown %s\\n' "$*" >> "$log"; }
install() { printf 'root install %s\\n' "$*" >> "$log"; while [ $# -gt 1 ]; do shift; done; mkdir -p "$1"; }
systemctl() { [ "$1" = is-active ] && { echo "${unit}"; [ "${unit}" = active ]; }; }
x() { printf 'x %s\\n' "$*" >> "$log"; }
wait_health() { return 0; }
sleep() { :; }
curl() {
  while [ $# -gt 0 ]; do [ "$1" = -o ] && { shift; out=$1; }; shift; done
  said=$(head -n 1 "$answers"); [ "$(wc -l < "$answers")" -gt 1 ] && sed -i.bak 1d "$answers"
  case "$said" in
    down) printf 000; return 7 ;;
    busy) printf '{"busy":["turn"]}' > "$out"; printf 200 ;;
    *) printf '{"busy":[]}' > "$out"; printf 200 ;;
  esac
}
update_server
`);
  const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TERM: "dumb", MADANI_RELEASE_PUBLIC_KEYS: publicKey };
  const out = await run("sh", [file], { env }).then(r => r.stdout, e => `${e.stdout}\n${e.stderr}\nexit ${e.code}`);
  const read = async (name) => (await readFile(join(stateDir, name), "utf8").catch(() => "")).trim();
  const log = (await readFile(join(dir, "log"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  return { out, log, read, dir, npm: log.filter(l => l.startsWith("as_user npm install")) };
}

describe("root's server update (install.sh --update-server)", () => {
  it("installs a newer signed staged build while nothing runs, restarts, and settles once its self-test passes", async () => {
    const r = await updateRound();
    expect(r.npm).toHaveLength(1);
    expect(r.npm[0]).toContain(`madanibot-${shaOf("1.1.0")}.tgz`);
    expect(r.log).toContain("x systemctl restart madanibot.service");
    expect(r.out).toContain("Updated to 1.1.0");
    expect(await r.read("package")).toBe(`sha256:${shaOf("1.1.0")}`);
    expect(await r.read("running-package")).toBe(`sha256:${shaOf("1.1.0")}`);
    expect(await r.read("update-pending")).toBe("");
    // the link account's files are read as that account
    expect(r.log.some(l => l.startsWith("as_link head -c 70000 "))).toBe(true);
    expect(r.log.some(l => l.startsWith(`as_link head -c ${bytesOf("1.1.0").length} `))).toBe(true);
  });

  it("waits while a bot is working, and touches nothing", async () => {
    const r = await updateRound({ busy: ["busy"] });
    expect(r.out).toContain("waits: turn");
    expect(r.npm).toHaveLength(0);
    expect(r.log).not.toContain("x systemctl restart madanibot.service");
    expect(await r.read("package")).toBe(`sha256:${shaOf("1.0.0")}`);
  });

  it("re-checks right before the restart: waits in short steps, and leaves the restart to the next round when still busy", async () => {
    const later = await updateRound({ busy: ["idle", "busy", "idle"] });
    expect(later.log).toContain("x systemctl restart madanibot.service");
    expect(later.out).toContain("Updated to 1.1.0");
    const deferred = await updateRound({ busy: ["idle", "busy"] });
    expect(deferred.npm).toHaveLength(1);
    expect(deferred.out).toContain("the restart waits for the next round: turn");
    expect(deferred.log).not.toContain("x systemctl restart madanibot.service");
    expect(await deferred.read("running-package")).toBe(`sha256:${shaOf("1.0.0")}`);
  });

  it("updates a failed server, but never one someone stopped", async () => {
    const failed = await updateRound({ unit: "failed", busy: ["down"] });
    expect(failed.npm).toHaveLength(1);
    expect(failed.log).toContain("x systemctl restart madanibot.service");
    const stopped = await updateRound({ unit: "inactive", busy: ["down"] });
    expect(stopped.out).toContain("waits: stopped (inactive)");
    expect(stopped.npm).toHaveLength(0);
    expect(stopped.log).not.toContain("x systemctl restart madanibot.service");
    const refused = await updateRound({ unit: "active", busy: ["down"] });
    expect(refused.out).toContain("waits: unknown");
    expect(refused.npm).toHaveLength(0);
  });

  it("puts the build before back when the new one fails its self-test, and never offers that build to npm again", async () => {
    const r = await updateRound({ selfTest: { version: "1.1.0", ok: false, at: 1, checks: { browser: "failed" } } });
    expect(r.out).toContain("Update rolled back, nothing lost");
    expect(r.npm.at(-1)).toContain(`madanibot-${shaOf("1.0.0")}.tgz`);
    expect(await r.read("package")).toBe(`sha256:${shaOf("1.0.0")}`);
    expect(await r.read("running-package")).toBe(`sha256:${shaOf("1.0.0")}`);
    expect(await r.read("update-failed")).toBe("1.1.0");
  });

  it("takes signed builds only on this path, and refuses a forged signature or a build that does not match its hash", async () => {
    const unsigned = await updateRound({ ready: { signature: undefined } });
    expect(unsigned.out).toContain("not taken (unsigned)");
    const forged = await updateRound({ ready: { signature: sig("1.1.0", "c".repeat(64)) } });
    expect(forged.out).toContain("not taken (unsigned)");
    expect(await forged.read("server-update-refused")).toBe(shaOf("1.1.0"));
    const swapped = await updateRound({ tgz: "v=6.6.6" });
    expect(swapped.out).toContain("does not match its hash");
    for (const r of [unsigned, forged, swapped]) {
      expect(r.npm).toHaveLength(0);
      expect(await r.read("package")).toBe(`sha256:${shaOf("1.0.0")}`);
    }
  });

  it("refuses an older staged build, and does nothing for the build already running", async () => {
    const older = await updateRound({ installed: "2.0.0", staged: "1.9.0" });
    expect(older.out).toContain("not taken (older 1.9.0)");
    expect(older.npm).toHaveLength(0);
    const same = await updateRound({ staged: "1.0.0" });
    expect(same.npm).toHaveLength(0);
    expect(same.log.filter(l => !l.startsWith("as_link "))).toHaveLength(0);
  });

  it("refuses a staged offer that is too large or whose fields would reach the shell", async () => {
    const huge = await updateRound({ ready: { size: 3 * 1024 ** 3 } });
    expect(huge.npm).toHaveLength(0);
    const r = await updateRound({ ready: { version: "1.1.0; touch /tmp/pwned", signature: "$(id)" } });
    expect(r.out).not.toContain("pwned");
    expect(r.npm).toHaveLength(0);
  });

  it("never follows the server account's links: a cache folder pointing elsewhere, or a build file pointing at another file", async () => {
    const victim = (dir) => join(dir, "victim");
    const dirLinked = await updateRound({ before: async (home, dir) => {
      await mkdir(victim(dir));
      await rm(join(home, ".cache/madanibot-link"), { recursive: true });
      await symlink(victim(dir), join(home, ".cache/madanibot-link"));
    } });
    const fileLinked = await updateRound({ before: async (home, dir) => {
      await writeFile(victim(dir), "root:secret\n");
      await symlink(victim(dir), join(home, `.cache/madanibot-link/madanibot-${shaOf("1.1.0")}.tgz`));
    } });
    for (const r of [dirLinked, fileLinked]) {
      // root touches only its own folder; the copy npm gets is written by the server account itself
      expect(r.log.filter(l => l.startsWith("root ") && l.includes(".cache"))).toEqual([]);
      expect(r.log.filter(l => l.startsWith("root chown"))).toEqual([]);
      expect(r.log).toContain("as_user sh");
      expect(r.out).toContain("Updated to 1.1.0");
    }
    expect(await readFile(victim(fileLinked.dir), "utf8")).toBe("root:secret\n");
    expect(await readdir(join(dirLinked.dir, "root-pkgs"))).toContain(`madanibot-${shaOf("1.1.0")}.tgz`);
  });
});
