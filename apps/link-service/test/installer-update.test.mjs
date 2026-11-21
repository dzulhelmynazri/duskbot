import { execFile } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { PINNED_RELEASE_KEYS, signRelease } from "../../cloud-service/src/release-signing.ts";
import { signPolicy } from "../../cloud-service/src/update-policy.ts";

const run = promisify(execFile);
const script = (await readFile(new URL("../install.sh", import.meta.url), "utf8")).replace(/\nmain "\$@"\s*$/, "\n");
const { privateKey } = generateKeyPairSync("ed25519");
const signing = `test-vps:${privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url")}`;
const publicKey = `test-vps:${createPublicKey(privateKey).export({ format: "jwk" }).x}`;
const dirs = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

/** a server with `installed` running; `actions` is a shell snippet run after the stubs; returns its log and state */
async function server({ installed = "1.0.0", state = {}, actions, selfTest = null }) {
  const dir = await mkdtemp(join(tmpdir(), "omb-update-")); dirs.push(dir);
  const home = join(dir, "home"), stateDir = join(dir, "state"), data = join(home, ".madanibot");
  await mkdir(join(home, ".local/lib/node_modules/madanibot"), { recursive: true }); await mkdir(join(home, ".local/bin"), { recursive: true });
  await mkdir(stateDir, { recursive: true }); await mkdir(data, { recursive: true }); await mkdir(join(home, ".cache/madanibot-link"), { recursive: true });
  await writeFile(join(home, ".local/lib/node_modules/madanibot/package.json"), `{\n  "version": "${installed}"\n}\n`);
  await writeFile(join(home, ".local/bin/madanibot"), "#!/bin/sh\n", { mode: 0o755 });
  for (const [key, value] of Object.entries(state)) await writeFile(join(stateDir, key), `${value}\n`);
  if (selfTest) await writeFile(join(data, "update-state.json"), JSON.stringify({ v: 1, boots: [], selfTest }));
  const file = join(dir, "fixture.sh");
  await writeFile(file, `${script}
SVC_HOME=${home} STATE=${stateDir} DATA=${data} TMP=${dir} PKGS=${join(dir, "pkgs")} NODE_BIN=${process.execPath} SELFTEST_WAIT=2
log=${join(dir, "log")}
get_package() { printf 'package for %s\\n' "$PKG_SHA" > "$1"; }
as_user() { [ "$1" = npm ] || { "$@"; return; }; printf 'as_user %s\\n' "$*" >> "$log"; eval "f=\\\${$#}"; v=$(sed -n 's/^v=//p' "$f" 2>/dev/null); [ -z "$v" ] || printf '{\\n  "version": "%s"\\n}\\n' "$v" > "$SVC_HOME/.local/lib/node_modules/madanibot/package.json"; }
retry() { "$@"; }
chown() { :; }
install() { while [ $# -gt 1 ]; do shift; done; mkdir -p "$1"; }
x() { printf 'x %s\\n' "$*" >> "$log"; }
wait_health() { return 0; }
sleep() { :; }
${actions}
`);
  const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TERM: "dumb", MADANI_RELEASE_PUBLIC_KEYS: publicKey };
  const out = await run("sh", [file], { env }).then(r => r.stdout, e => `${e.stdout}\nexit ${e.code}`);
  const read = async (name) => (await readFile(join(stateDir, name), "utf8").catch(() => "")).trim();
  return { out, log: (await readFile(join(dir, "log"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean), read, cache: join(home, ".cache/madanibot-link") };
}
const shaOf = (version) => createHash("sha256").update(`v=${version}`).digest("hex");
const sig = (version, sha = shaOf(version)) => signRelease({ kind: "vps-package", name: "madanibot", version, sha256: sha, signedAt: 1 }, signing);
const policy = (p) => { const doc = signPolicy(p, signing); return { body: Buffer.from(doc.body).toString("base64url"), signature: doc.signature }; };
/** offers `version` as the link service would; the fixture package's bytes say its version for the npm stub */
const offer = (version, { signature = sig(version), policyDoc = null } = {}) => `
PKG_SHA=${shaOf(version)} PKG_VERSION=${version} PKG_SIG='${signature ?? ""}' POLICY_BODY='${policyDoc?.body ?? ""}' POLICY_SIG='${policyDoc?.signature ?? ""}'
get_package() { printf 'v=${version}' > "$1"; }`;

describe("installer updates", () => {
  it("pins the same release keys as the service", () => {
    const pinned = /^RELEASE_KEYS="([^$"]+)/m.exec(script)[1];
    expect(pinned).toBe(PINNED_RELEASE_KEYS.map(k => `${k.kid}:${k.x}`).join(","));
  });

  it("updates to a newer signed build, keeps the one before, and settles once its self-test passes", async () => {
    const s = await server({ state: { package: `sha256:${shaOf("1.0.0")}` }, selfTest: { version: "1.1.0", ok: true, at: 1, checks: {} },
      actions: `${offer("1.1.0")}\ndo_app\nprintf 'pending %s\\n' "$(state_get update-pending)" >> "$log"\nupdate_settle 1` });
    expect(s.log.some(l => l.startsWith("as_user npm install") && l.includes(`madanibot-${shaOf("1.1.0")}.tgz`))).toBe(true);
    expect(s.log).toContain("pending 1.1.0");
    expect(s.out).toContain("Updated to 1.1.0");
    expect(await s.read("package")).toBe(`sha256:${shaOf("1.1.0")}`);
    expect(await s.read("package-prev")).toBe(`sha256:${shaOf("1.0.0")}`);
    expect(await s.read("signed")).toBe("1");
    expect(await s.read("update-pending")).toBe("");
  });

  it("puts the build before back when the new one fails its self-test, and never takes that version again", async () => {
    const prevSha = shaOf("1.0.0");
    const s = await server({ state: { package: `sha256:${prevSha}` }, selfTest: { version: "1.1.0", ok: false, at: 1, checks: { browser: "failed" } },
      actions: `printf 'v=1.0.0' > "$SVC_HOME/.cache/madanibot-link/madanibot-${prevSha}.tgz"\n${offer("1.1.0")}\ndo_app\nupdate_settle 1\n${offer("1.1.0")}\ndo_app` });
    expect(s.out).toContain("going back to the build before");
    expect(s.out).toContain("Update rolled back, nothing lost");
    expect(s.log.filter(l => l.startsWith("as_user npm install")).at(-1)).toContain(`madanibot-${prevSha}.tgz`);
    expect(s.log).toContain("x systemctl restart madanibot.service");
    expect(await s.read("package")).toBe(`sha256:${prevSha}`);
    expect(await s.read("update-failed")).toBe("1.1.0");
    expect(s.out).toContain("keeping the installed build: the offered one is not taken (failed_here 1.1.0)");
  });

  it("refuses a blocked build and keeps the installed one", async () => {
    const s = await server({ state: { package: `sha256:${shaOf("1.0.0")}` },
      actions: `${offer("1.1.0", { policyDoc: policy({ serial: 3, floor: null, blocked: ["1.1.0"] }) })}\ndo_app` });
    expect(s.out).toContain("keeping the installed build: the offered one is not taken (blocked 1.1.0)");
    expect(s.log.some(l => l.startsWith("as_user npm install"))).toBe(false);
    expect(JSON.parse(await s.read("update-policy.json"))).toEqual({ serial: 3, floor: null, blocked: ["1.1.0"] });
  });

  it("refuses a downgrade, a build below the signed floor, and an unsigned build once signed ones were taken", async () => {
    const older = await server({ installed: "2.0.0", state: { package: `sha256:${shaOf("2.0.0")}` }, actions: `${offer("1.9.0")}\ndo_app` });
    expect(older.out).toContain("not taken (older 1.9.0)");
    const floor = await server({ installed: "2.0.0", state: { package: `sha256:${shaOf("2.0.0")}` },
      actions: `${offer("2.1.0", { policyDoc: policy({ serial: 1, floor: "2.2.0", blocked: [] }) })}\ndo_app` });
    expect(floor.out).toContain("not taken (below_floor 2.1.0)");
    const unsigned = await server({ state: { package: `sha256:${shaOf("1.0.0")}`, signed: "1" }, actions: `${offer("1.1.0", { signature: null })}\ndo_app` });
    expect(unsigned.out).toContain("not taken (unsigned)");
    const forged = await server({ state: { package: `sha256:${shaOf("1.0.0")}` }, actions: `${offer("1.1.0", { signature: sig("1.1.0", "c".repeat(64)) })}\ndo_app` });
    expect(forged.out).toContain("not taken (unsigned)");
    for (const s of [older, floor, unsigned, forged]) expect(s.log.some(l => l.startsWith("as_user npm install"))).toBe(false);
  });
});
