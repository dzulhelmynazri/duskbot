import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const script = (await readFile(new URL("../install.sh", import.meta.url), "utf8")).replace(/\nmain "\$@"\s*$/, "\n");
const dirs = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

/** a verified build at `<dir>/root-pkgs/madanibot-<name>.tgz` carrying `gate` as package/link/docker-gate.mjs (none: null) */
async function build(dir, name, gate) {
  const stage = join(dir, `stage-${name}`);
  await mkdir(join(stage, "package", "link"), { recursive: true });
  if (gate !== null) await writeFile(join(stage, "package", "link", "docker-gate.mjs"), gate);
  else await writeFile(join(stage, "package", "link", "install.sh"), "#!/bin/sh\n");
  await mkdir(join(dir, "root-pkgs"), { recursive: true });
  await run("tar", ["-czf", join(dir, "root-pkgs", `madanibot-${name}.tgz`), "-C", stage, "package"]);
  return join(dir, "root-pkgs", `madanibot-${name}.tgz`);
}

/** runs `body` in install.sh with root's paths in `dir`, systemd saying the gate is `gate` and the server idle or not */
async function inInstaller(dir, body, { gate = "active", busy = false, state = {} } = {}) {
  const stateDir = join(dir, "state");
  await mkdir(stateDir, { recursive: true });
  for (const [key, value] of Object.entries({ signed: "1", ...state })) await writeFile(join(stateDir, key), `${value}\n`);
  const file = join(dir, "fixture.sh");
  await writeFile(file, `${script}
STATE=${stateDir} LIB=${join(dir, "lib")} GATE=${join(dir, "lib", "docker-gate.mjs")} PKGS=${join(dir, "root-pkgs")} NODE_BIN=${process.execPath} TMP=$(mktemp -d)
log=${join(dir, "log")}
install() { printf 'install %s\\n' "$*" >> "$log"; command install -m 0644 "$(eval echo \\\${$(($# - 1))})" "$(eval echo \\\${$#})" 2>/dev/null || mkdir -p "$(eval echo \\\${$#})"; }
systemctl() { printf 'systemctl %s\\n' "$*" >> "$log"; [ "$1" = is-active ] && [ "$*" != "is-active --quiet omb-docker-gate.service" ] && { echo active; return 0; }; [ "${gate}" = active ]; }
x() { printf 'x %s\\n' "$*" >> "$log"; }
server_holds() { ${busy ? 'echo turn' : 'echo ""'}; }
${body}
`);
  const out = await run("sh", [file], { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } }).then((r) => r.stdout, (e) => `${e.stdout}\n${e.stderr}\nexit ${e.code}`);
  const log = (await readFile(join(dir, "log"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  const installed = await readFile(join(dir, "lib", "docker-gate.mjs"), "utf8").catch(() => null);
  const read = async (name) => (await readFile(join(stateDir, name), "utf8").catch(() => "")).trim();
  return { out, log, installed, read };
}

const NEW_GATE = 'export const DEFAULT_PULL = ["ghcr.io/madanibotai/madani-desktop"];\n';

describe("root's server update keeps the docker gate in step with the build (install.sh refresh_gate)", () => {
  it("installs the gate a verified build carries and restarts it; the same gate again changes nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omb-gate-refresh-")); dirs.push(dir);
    const tgz = await build(dir, "aaa", NEW_GATE);
    await mkdir(join(dir, "lib"), { recursive: true });
    await writeFile(join(dir, "lib", "docker-gate.mjs"), 'export const DEFAULT_PULL = ["ghcr.io/sidddevz/omb-bot-desktop"];\n');
    const first = await inInstaller(dir, `refresh_gate ${tgz}`);
    expect(first.installed).toBe(NEW_GATE);
    expect(first.out).toContain("the docker gate now matches the build");
    expect(first.log).toContain("x systemctl restart omb-docker-gate.service");
    await rm(join(dir, "log"));
    const again = await inInstaller(dir, `refresh_gate ${tgz}`);
    expect(again.log.filter((line) => line.startsWith("x "))).toEqual([]);
  });

  it("leaves the gate alone for an unsigned server, a build without one, or one that does not parse", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omb-gate-refresh-")); dirs.push(dir);
    const unsigned = await inInstaller(dir, `refresh_gate ${await build(dir, "a", NEW_GATE)}`, { state: { signed: "0" } });
    expect(unsigned.installed).toBeNull();
    expect((await inInstaller(dir, `refresh_gate ${await build(dir, "b", null)}`)).installed).toBeNull();
    expect((await inInstaller(dir, `refresh_gate ${await build(dir, "c", "export const = ;\n")}`)).installed).toBeNull();
  });

  it("the running build's gate, once per build and only while no bot is working: what an older updater installed catches up", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omb-gate-refresh-")); dirs.push(dir);
    await build(dir, "bbb", NEW_GATE);
    const sync = `_running=$(state_get running-package | sed 's/^sha256://')
if [ -n "$_running" ] && [ "$(state_get gate-from)" != "$_running" ] && [ -f "$PKGS/madanibot-$_running.tgz" ] && [ "$(restart_allowed)" = go ]; then
  refresh_gate "$PKGS/madanibot-$_running.tgz"; state_set gate-from "$_running"
fi`;
    expect(script).toContain(sync.split("\n")[1]);
    const busy = await inInstaller(dir, sync, { busy: true, state: { "running-package": "sha256:bbb" } });
    expect(busy.installed).toBeNull();
    const idle = await inInstaller(dir, sync, { state: { "running-package": "sha256:bbb" } });
    expect(idle.installed).toBe(NEW_GATE);
    expect(await idle.read("gate-from")).toBe("bbb");
  });
});

describe("root's server update brings a dead docker gate back (install.sh heal_gate)", () => {
  /** heal_gate with docker `up` or not, and the gate answering the server account or not */
  async function heal({ up = true, answers = false, unit = true } = {}) {
    const dir = await mkdtemp(join(tmpdir(), "omb-gate-heal-")); dirs.push(dir);
    await mkdir(join(dir, "units"), { recursive: true });
    if (unit) await writeFile(join(dir, "units", "omb-docker-gate.service"), "[Unit]\n");
    return inInstaller(dir, `UNITS=${join(dir, "units")}
docker() { printf 'docker %s\\n' "$*" >> "$log"; ${up ? "return 0" : "return 1"}; }
as_user() { printf 'as_user %s\\n' "$*" >> "$log"; ${answers ? "return 0" : "return 1"}; }
heal_gate`);
  }

  it("starts a gate that does not answer the server account again, and has docker want it from then on", async () => {
    const r = await heal();
    expect(r.log).toContain("systemctl add-wants docker.service omb-docker-gate.service");
    expect(r.log).toContain("x systemctl restart omb-docker-gate.service");
    expect(r.out).toContain("the docker gate did not answer");
  });

  it("leaves an answering gate alone, and does nothing while docker is down or on a server without the gate", async () => {
    expect((await heal({ answers: true })).log.filter((line) => line.startsWith("x "))).toEqual([]);
    expect((await heal({ up: false })).log.filter((line) => line.startsWith("x ") || line.startsWith("as_user"))).toEqual([]);
    expect((await heal({ unit: false })).log.filter((line) => line.startsWith("x ") || line.startsWith("as_user"))).toEqual([]);
  });

  it("runs at the start of every update round, and the gate unit restarts with docker without ever giving up", () => {
    expect(script).toMatch(/\[ -f "\$STATE\/linked" \] \|\| return 0\n  heal_gate\n/);
    expect(script).toContain("Requires=docker.service\nStartLimitIntervalSec=0\n");
    expect(script).toContain("WantedBy=multi-user.target docker.service\nEOF\n  put_file \"$UNITS/omb-docker-gate.service\"");
  });
});
