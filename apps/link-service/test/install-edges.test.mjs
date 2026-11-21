// the ways an install is cut short or run again: a lost answer, a stop between two writes, a second link, a stopped
// update, a half-done dpkg and a clock far off
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLinkService } from "../src/app.mjs";
import { frameGuard as agentGuard, noteRelayDate as agentNoteDate, openFrame as agentOpenFrame, retireTunnel } from "../agent.mjs";
import { createRelayClient, newLinkKeys, noteRelayDate as appNoteDate, seal, sealBytes, sealFrame, sha256hex, vpsTokenOf } from "../../../electron/vps-link-protocol.mjs";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const script = readFileSync(join(root, "install.sh"), "utf8").replace(/\nmain "\$@"\s*$/, "\n");
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

let dir, service, http, base, fake, fakePort, onPairing = async () => {};
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "omb-edges-"));
  service = createLinkService({ base: "http://link.test", dataDir: join(dir, "data"), scriptPath: join(root, "install.sh"), agentPath: join(root, "agent.mjs"), trustProxy: false });
  http = createServer((req, res) => void service.handler(req, res));
  base = `http://127.0.0.1:${await listen(http)}`;
  fake = createServer((req, res) => {
    req.resume();
    req.on("end", async () => {
      if (req.url === "/api/auth/pairing") await onPairing();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(req.url === "/api/auth/pairing" ? JSON.stringify({ code: "AAAA-BBBB-CCCC" }) : JSON.stringify({ environmentId: "env" }));
    });
  });
  fakePort = await listen(fake);
});
afterAll(async () => {
  service.close();
  await new Promise((resolve) => http.close(resolve));
  await new Promise((resolve) => fake.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

const post = (route, token, body) => fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
async function claimed() {
  const keys = newLinkKeys();
  const made = await createRelayClient({ base }).create({ verifier: keys.verifier, appPub: keys.pub });
  const vpsToken = vpsTokenOf(keys.secret);
  expect((await post(`/v1/sessions/${made.id}/claim`, vpsToken, {})).status).toBe(200);
  return { keys, made, vpsToken };
}
const agentLink = (home, id, token) => run(process.execPath, [join(root, "agent.mjs"), "link"], {
  env: { ...process.env, HOME: home, LINK_BASE: base, LINK_ID: id, LINK_TOKEN: token, LINK_MODE: "relay", LINK_SERVER_PORT: String(fakePort) },
});

describe("the link service and agent when a link is repeated", () => {
  it("answers the same result sent twice (its first answer lost) as done, and anything else as used", async () => {
    const { keys, made, vpsToken } = await claimed();
    const body = { sealed: seal(Buffer.alloc(32), made.id, Buffer.from("{}")), vpsPub: keys.pub, tunnel: { vps: sha256hex("v".repeat(43)), app: sha256hex("a".repeat(43)) } };
    expect((await post(`/v1/sessions/${made.id}/result`, vpsToken, body)).status).toBe(200);
    const again = await post(`/v1/sessions/${made.id}/result`, vpsToken, body);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ok: true, repeated: true });
    const other = await post(`/v1/sessions/${made.id}/result`, vpsToken, { ...body, tunnel: { vps: sha256hex("x".repeat(43)), app: body.tunnel.app } });
    expect(other.status).toBe(410);
    expect((await other.json()).code).toBe("used");
    expect((await post(`/v1/sessions/${made.id}/result`, "w".repeat(40), body)).status).toBe(401);
  });

  it("linking a server again ends the tunnel it had, so the app that held it reads unlinked", async () => {
    const home = mkdtempSync(join(dir, "home-"));
    const first = await claimed();
    await agentLink(home, first.made.id, first.vpsToken);
    const file = join(home, ".config", "madanibot-link", "tunnel.json");
    const old = JSON.parse(readFileSync(file, "utf8"));
    expect(service.store.tunnels.has(old.id)).toBe(true);
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "authorized_keys"), `ssh-ed25519 AAAAmine me@laptop\nrestrict,command="x" ssh-ed25519 AAAAold omb-link-${old.id}\n`);

    const second = await claimed();
    await agentLink(home, second.made.id, second.vpsToken);
    const now = JSON.parse(readFileSync(file, "utf8"));
    expect(now.id).toBe(second.made.id);
    expect(now.before).toBeUndefined();
    expect(service.store.tunnels.has(old.id)).toBe(false);
    expect(service.store.tunnels.has(second.made.id)).toBe(true);
    expect(readFileSync(join(home, ".ssh", "authorized_keys"), "utf8")).toBe("ssh-ed25519 AAAAmine me@laptop\n");
  });

  it("keeps the tunnel before listed when the new link is cut short, and ends it on the next link", async () => {
    const home = mkdtempSync(join(dir, "home-"));
    const first = await claimed();
    await agentLink(home, first.made.id, first.vpsToken);
    const file = join(home, ".config", "madanibot-link", "tunnel.json");
    const oldId = JSON.parse(readFileSync(file, "utf8")).id;
    // the session ends (cancelled in the app, or expired) after the claim, before the result
    const second = await claimed();
    onPairing = () => fetch(`${base}/v1/sessions/${second.made.id}`, { method: "DELETE", headers: { authorization: `Bearer ${second.made.watch}` } });
    await expect(agentLink(home, second.made.id, second.vpsToken)).rejects.toThrow();
    onPairing = async () => {};
    expect(JSON.parse(readFileSync(file, "utf8")).before.map((one) => one.id)).toEqual([oldId]);
    expect(service.store.tunnels.has(oldId)).toBe(true);
    const third = await claimed();
    await agentLink(home, third.made.id, third.vpsToken);
    expect(service.store.tunnels.has(oldId)).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8")).before).toBeUndefined();
  });

  it("retiring a tunnel the service no longer has still removes its key", async () => {
    const removed = [];
    await retireTunnel({ id: "abcdefghij", base, token: "t".repeat(43) }, { removeKey: (id, line) => removed.push([id, line]) });
    expect(removed).toEqual([["abcdefghij", null]]);
  });
});

describe("frames between two clocks that disagree", () => {
  const realNow = Date.now;
  afterAll(() => { Date.now = realNow; agentNoteDate(new Date(realNow()).toUTCString()); appNoteDate(new Date(realNow()).toUTCString()); });

  it("a server whose clock runs ten minutes slow still takes the app's frames, through the relay's time", () => {
    const key = Buffer.alloc(32, 7), truth = realNow(), relayDate = new Date(truth).toUTCString();
    Date.now = () => truth;
    appNoteDate(relayDate);
    const frame = sealFrame(key, "abcdefghij", "to-vps", { t: "req", r: "r1" });
    const bytes = sealBytes(key, "abcdefghij", "to-vps", "aaaaaaaaaaaa", Buffer.from("hi"));
    Date.now = () => truth - 10 * 60_000;
    agentNoteDate(new Date(truth - 10 * 60_000).toUTCString());
    expect(agentOpenFrame(key, "abcdefghij", "to-vps", frame, agentGuard())).toBeNull();
    agentNoteDate(relayDate);
    expect(agentOpenFrame(key, "abcdefghij", "to-vps", frame, agentGuard())).toMatchObject({ t: "req", r: "r1" });
    expect(agentOpenFrame(key, "abcdefghij", "to-vps", bytes, agentGuard())?.b.toString()).toBe("hi");
    // still refused twice, and still refused when really stale
    const guard = agentGuard();
    expect(agentOpenFrame(key, "abcdefghij", "to-vps", frame, guard)).not.toBeNull();
    expect(agentOpenFrame(key, "abcdefghij", "to-vps", frame, guard)).toBeNull();
    Date.now = () => truth + 6 * 60_000;
    agentNoteDate(new Date(truth + 16 * 60_000).toUTCString());
    expect(agentOpenFrame(key, "abcdefghij", "to-vps", frame, agentGuard())).toBeNull();
  });
});

/** install.sh's functions in a temp root, with the system commands they reach stubbed by `actions` */
async function sh(actions) {
  const at = mkdtempSync(join(dir, "sh-"));
  const home = join(at, "home"), state = join(at, "state");
  for (const sub of [join(home, ".local/lib/node_modules/madanibot"), join(home, ".local/bin"), join(home, ".cache/madanibot-link"), state, join(home, ".madanibot")]) mkdirSync(sub, { recursive: true });
  mkdirSync(join(at, "bin"));
  writeFileSync(join(at, "fixture.sh"), `${script}
SVC_HOME=${home} STATE=${state} DATA=${home}/.madanibot TMP=${at} PKGS=${at}/pkgs LOGS=${at} LINK_HOME=${at}/link NODE_BIN=${process.execPath} SELFTEST_WAIT=2
log=${at}/log; : > "$log"
stub() { printf '#!/bin/sh\n%s\n' "$2" > "$TMP/bin/$1"; chmod +x "$TMP/bin/$1"; }
retry() { "$@"; }
chown() { :; }
x() { printf 'x %s\\n' "$*" >> "$log"; }
sleep() { :; }
mkdir -p "$PKGS"
as_user() { "$@"; }
${actions}
`);
  const out = await run("sh", [join(at, "fixture.sh")], { env: { PATH: `${at}/bin:/usr/bin:/bin:/usr/sbin:/sbin`, TERM: "dumb" } }).then((r) => r.stdout + r.stderr, (e) => `${e.stdout}${e.stderr}\nexit ${e.code}`);
  const read = (name) => { try { return readFileSync(join(state, name), "utf8").trim(); } catch { return ""; } };
  return { out, read, log: readFileSync(join(at, "log"), "utf8"), at, home };
}
const sha = (text) => createHash("sha256").update(text).digest("hex");

describe("install.sh run again after a stop", () => {
  it("a line already used by this server, stopped before it noted the link, repairs instead of refusing", async () => {
    const s = await sh(`
mkdir -p "$LINK_HOME/.config/madanibot-link"
printf '{"v":1,"base":"x","id":"abcdefghij","key":"k","token":"t","before":[{"id":"zzzzzzzzzz"}]}' > "$LINK_HOME/.config/madanibot-link/tunnel.json"
state_set id abcdefghij
LINK_ID=abcdefghij PROTO==http VPS_TOKEN=t LINK_BASE=http://127.0.0.1:1
curl() { while [ $# -gt 0 ]; do [ "$1" = -o ] && { printf '{"error":"used","code":"used"}' > "$2"; shift; }; shift; done; printf 410; }
claim; echo "offline=$OFFLINE linked=$(state_get linked)"`);
    expect(s.out).toContain("offline=1 linked=abcdefghij");
  });

  it("the same answer for a server that never held this line stays refused", async () => {
    const s = await sh(`
state_set id otherother
LINK_ID=abcdefghij PROTO==http VPS_TOKEN=t LINK_BASE=http://127.0.0.1:1
curl() { while [ $# -gt 0 ]; do [ "$1" = -o ] && { printf '{"error":"used","code":"used"}' > "$2"; shift; }; shift; done; printf 410; }
claim; echo "not reached"`);
    expect(s.out).toContain("This line was already used");
    expect(s.out).not.toContain("not reached");
  });

  it("an update stopped inside npm still has its rollback noted, and the next run finishes the install", async () => {
    const oldSha = sha("v=1.0.0"), newSha = sha("v=1.1.0");
    const s = await sh(`
printf '{\\n  "version": "1.0.0"\\n}\\n' > "$SVC_HOME/.local/lib/node_modules/madanibot/package.json"
printf '#!/bin/sh\\n' > "$SVC_HOME/.local/bin/madanibot"; chmod +x "$SVC_HOME/.local/bin/madanibot"
state_set package sha256:${oldSha}
printf 'v=1.0.0' > "$SVC_HOME/.cache/madanibot-link/madanibot-${oldSha}.tgz"
PKG_SHA=${newSha} PKG_VERSION=1.1.0 OFFLINE=0
get_package() { printf 'v=1.1.0' > "$1"; }
as_user() { [ "$1" = npm ] || { "$@"; return; }; echo "npm stopped" >> "$log"; return 130; }
( set -e; do_app ) || echo "first run stopped"
echo "after stop: package=$(state_get package) pending=$(state_get update-pending) prev=$(state_get package-prev) half=$(state_get app-installing)"
as_user() { [ "$1" = npm ] || { "$@"; return; }; printf 'as_user %s\\n' "$*" >> "$log"; }
PKG_SHA="" OFFLINE=1
( set -e; do_app ) && echo "repair finished: package=$(state_get package) half=$(state_get app-installing)"`);
    expect(s.out).toContain("first run stopped");
    expect(s.out).toContain(`after stop: package=sha256:${oldSha} pending=1.1.0 prev=sha256:${oldSha} half=sha256:${newSha}`);
    expect(s.out).toContain(`repair finished: package=sha256:${newSha} half=`);
    expect(s.log).toContain(`madanibot-${newSha}.tgz`);
  });

  it("a rollback stopped part way keeps the update pending, so the next run rolls back again", async () => {
    const oldSha = sha("v=1.0.0"), newSha = sha("v=1.1.0");
    const s = await sh(`
printf '#!/bin/sh\\n' > "$SVC_HOME/.local/bin/madanibot"; chmod +x "$SVC_HOME/.local/bin/madanibot"
printf 'v=1.0.0' > "$SVC_HOME/.cache/madanibot-link/madanibot-${oldSha}.tgz"
state_set package sha256:${newSha}; state_set package-prev sha256:${oldSha}; state_set update-pending 1.1.0
printf '{"v":1,"selfTest":{"version":"1.1.0","ok":false}}' > "$DATA/update-state.json"
wait_health() { return 0; }
as_user() { [ "$1" = npm ] || { "$@"; return; }; return 1; }
update_settle 1 || echo "rollback stopped"
echo "pending=$(state_get update-pending) package=$(state_get package) failed=$(state_get update-failed)"
as_user() { [ "$1" = npm ] || { "$@"; return; }; printf 'as_user %s\\n' "$*" >> "$log"; }
update_settle 1
echo "pending=$(state_get update-pending) package=$(state_get package) failed=$(state_get update-failed)"`);
    expect(s.out).toContain("rollback stopped");
    expect(s.out).toContain(`pending=1.1.0 package=sha256:${newSha} failed=1.1.0`);
    expect(s.out).toContain("Update rolled back, nothing lost");
    expect(s.out).toContain(`pending= package=sha256:${oldSha} failed=1.1.0`);
  });

  it("restarts a running server onto a newly installed build even when no unit changed, and only then", async () => {
    const s = await sh(`
get_gate() { :; }; handoff_script() { :; }; server_unit() { return 1; }; helper_units() { return 1; }; ssh_guard() { return 1; }
gate_up() { :; }; box_works() { :; }; wait_health() { return 0; }; systemctl() { :; }
state_set package sha256:new; state_set running-package sha256:old
do_service; echo "running=$(state_get running-package)"
do_service`);
    const starts = s.log.split("\n").filter((line) => line.endsWith(" madanibot.service"));
    expect(starts).toEqual(["x systemctl restart madanibot.service", "x systemctl start madanibot.service"]);
    expect(s.out).toContain("running=sha256:new");
  });

  it("a first build that never started here does not stop the build before it from coming back", async () => {
    const broken = sha("v=1.1.0"), good = sha("v=1.0.0");
    const s = await sh(`
printf '{\n  "version": "1.1.0"\n}\n' > "$SVC_HOME/.local/lib/node_modules/madanibot/package.json"
printf '#!/bin/sh\n' > "$SVC_HOME/.local/bin/madanibot"; chmod +x "$SVC_HOME/.local/bin/madanibot"
state_set package sha256:${broken}
get_gate() { :; }; handoff_script() { :; }; server_unit() { return 1; }; helper_units() { return 1; }; ssh_guard() { return 1; }
gate_up() { :; }; box_works() { :; }; wait_health() { return 1; }; systemctl() { :; }; journalctl() { :; }; ss() { :; }
do_service || echo "service failed, failed=$(state_get update-failed)"
PKG_SHA=${good} PKG_VERSION=1.0.0 OFFLINE=0
get_package() { printf 'v=1.0.0' > "$1"; }
as_user() { [ "$1" = npm ] || { "$@"; return; }; printf '{\n  "version": "1.0.0"\n}\n' > "$SVC_HOME/.local/lib/node_modules/madanibot/package.json"; }
do_app && echo "package=$(state_get package)"`);
    expect(s.out).toContain("service failed, failed=1.1.0");
    expect(s.out).toContain(`package=sha256:${good}`);
  });

  it("finishes a dpkg run that was interrupted before installing anything", async () => {
    const s = await sh(`
cat > "$TMP/bin/dpkg" <<'STUB'
#!/bin/sh
case "$1" in --audit) echo "The following packages are only half configured" ;; *) echo "dpkg $*" >> "$STUB_LOG" ;; esac
STUB
chmod +x "$TMP/bin/dpkg"; export STUB_LOG="$log"
stub apt-get :
x() { printf 'x %s\\n' "$*" >> "$log"; "$@"; }
apt_update`);
    expect(s.log).toContain("dpkg --force-confdef --force-confold --configure -a");
  });

  it("leaves a healthy dpkg alone", async () => {
    const s = await sh(`
cat > "$TMP/bin/dpkg" <<'STUB'
#!/bin/sh
echo "dpkg $*" >> "$STUB_LOG"
STUB
chmod +x "$TMP/bin/dpkg"; export STUB_LOG="$log"
stub apt-get :
apt_update`);
    expect(s.log).not.toContain("--configure -a");
  });

  it("refuses a server whose clock stays minutes off, after trying time sync", async () => {
    const s = await sh(`
LINK_BASE=http://127.0.0.1:1 PROTO==http
curl() { printf 'HTTP/1.1 200 OK\\r\\nDate: %s\\r\\n\\r\\n' "$(command date -u -d @$(($(command date +%s) - 900)) '+%a, %d %b %Y %H:%M:%S GMT' 2>/dev/null || command date -u -r $(($(command date +%s) - 900)) '+%a, %d %b %Y %H:%M:%S GMT')"; }
date() { if [ "$1" = -u ] && [ "$2" = -d ]; then command date -u -d "$3" +%s 2>/dev/null || command date -u -j -f '%a, %d %b %Y %H:%M:%S GMT' "$3" +%s; else command date "$@"; fi; }
timedatectl() { echo "timedatectl $*" >> "$log"; }
clock_check || echo "clock refused"`);
    expect(s.log).toContain("timedatectl set-ntp true");
    expect(s.out).toContain("900 seconds ahead");
    expect(s.out).toContain("clock refused");
  });

  it("lets a clock a few seconds off through without touching time sync", async () => {
    const s = await sh(`
LINK_BASE=http://127.0.0.1:1 PROTO==http
curl() { printf 'HTTP/1.1 200 OK\\r\\nDate: %s\\r\\n\\r\\n' "$(command date -u '+%a, %d %b %Y %H:%M:%S GMT')"; }
date() { if [ "$1" = -u ] && [ "$2" = -d ]; then command date -u -d "$3" +%s 2>/dev/null || command date -u -j -f '%a, %d %b %Y %H:%M:%S GMT' "$3" +%s; else command date "$@"; fi; }
timedatectl() { echo "timedatectl $*" >> "$log"; }
clock_check && echo "clock fine"`);
    expect(s.out).toContain("clock fine");
    expect(s.log).not.toContain("timedatectl");
  });
});
