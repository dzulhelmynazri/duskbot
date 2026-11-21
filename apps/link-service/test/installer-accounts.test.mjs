import { LEGACY } from "../../../electron/legacy-names.mjs";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const script = (await readFile(new URL("../install.sh", import.meta.url), "utf8")).replace(/\nmain "\$@"\s*$/, "\n");
const TOKEN = `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-${"a".repeat(40)}`;
const dirs = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

/** The installer's functions with root-only commands stubbed: accounts are names in a file, runuser runs as the caller. */
async function fixture(body) {
  const dir = await mkdtemp(join(tmpdir(), "omb-install-accounts-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "runuser"), '#!/bin/sh\nprintf "runuser %s\\n" "$2" >> "$CALLS"\nshift 3\nexec "$@"\n');
  await writeFile(join(bin, "systemctl"), '#!/bin/sh\nprintf "systemctl %s\\n" "$*" >> "$CALLS"\n');
  await chmod(join(bin, "runuser"), 0o755);
  await chmod(join(bin, "systemctl"), 0o755);
  const file = join(dir, "fixture.sh");
  await writeFile(file, `${script}
ROOT=$1
CALLS=$ROOT/calls; export CALLS
UNITS=$ROOT/units; TMP=$ROOT/tmp; STATE=$ROOT/state
SVC_HOME=$ROOT/home/$SVC_USER; DATA=$SVC_HOME/.madanibot
LINK_HOME=$ROOT/var/lib/omb-link; HANDOFF=$LINK_HOME/handoff
ETC=$ROOT/etc/madanibot; LIB=$ROOT/usr/local/lib/madanibot; GATE=$LIB/docker-gate.mjs
NAME=fixture; AGENT=/opt/madanibot-link/agent.mjs
mkdir -p "$UNITS" "$TMP" "$STATE"
touch "$ROOT/users"
log() { printf '%s\\n' "$*" >> "$CALLS"; }
id() {
  case "$1" in
    -nG) cat "$ROOT/groups-$2" 2>/dev/null ;;
    "") echo "uid=0(root)" ;;
    *) grep -qx "$1" "$ROOT/users" && echo "uid=1($1)" ;;
  esac
}
getent() { grep -qx "$2" "$ROOT/group-names"; }
useradd() { log "useradd $*"; for last; do :; done; echo "$last" >> "$ROOT/users"; }
groupadd() { log "groupadd $*"; for last; do :; done; echo "$last" >> "$ROOT/group-names"; }
usermod() { log "usermod $*"; }
gpasswd() { log "gpasswd $*"; }
install() {
  _args=""
  while [ $# -gt 0 ]; do case "$1" in -o|-g) shift 2 ;; *) _args="$_args '$1'"; shift ;; esac; done
  eval "command install $_args"
}
as_user() { env HOME="$SVC_HOME" "$@"; }
${body}
`);
  await run("sh", [file, dir], { env: { PATH: `${bin}:/usr/bin:/bin`, TERM: "dumb" } });
  return dir;
}

const read = (path) => readFile(path, "utf8");

describe("the installer's units", () => {
  it("runs the server hardened, out of the docker group, with every turn boxed and docker only through the gate", async () => {
    const dir = await fixture("server_unit; helper_units; handoff_script");
    const server = await read(join(dir, "units", "madanibot.service"));
    for (const line of ["User=madani", "SupplementaryGroups=omb-dockergate", "Environment=MADANI_BOT_BOX=required", `Environment=MADANI_BOX_CODE_ROOTS=${dir}/home/madani/.local/bin:${dir}/home/madani/.local/lib`,
      "Environment=MADANI_VPS_DOCKER=local", "Environment=DOCKER_HOST=unix:///run/madanibot-docker/docker.sock", `EnvironmentFile=-${dir}/etc/madanibot/engines.env`,
      "NoNewPrivileges=yes", "CapabilityBoundingSet=", "ProtectSystem=strict", "ProtectHome=tmpfs", `BindPaths=${dir}/home/madani`, `ReadWritePaths=${dir}/home/madani`,
      "PrivateTmp=yes", "ProtectProc=invisible", "UMask=0077"]) {
      expect(server.split("\n"), line).toContain(line);
    }
    expect(server).not.toMatch(/SupplementaryGroups=.*\bdocker\b/);
    // bubblewrap makes user, mount, pid and network namespaces and their loopback over netlink
    expect(server).not.toContain("RestrictNamespaces");
    // nor RestrictSUIDSGID: its seccomp filter refuses the mount api bubblewrap 0.12 uses (debian 13)
    expect(server).not.toContain("RestrictSUIDSGID");
    // and mounts a fresh /proc, which the kernel refuses under a partly covered one
    for (const masking of ["ProtectKernelTunables", "ProtectKernelLogs", "ProcSubset", "PrivateDevices"]) expect(server).not.toContain(masking);
    expect(server).toContain("RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK");
    expect(server).not.toContain("config/madanibot/engines.env");

    const link = await read(join(dir, "units", "madanibot-link.service"));
    for (const line of ["User=omb-link", `Environment=HOME=${dir}/var/lib/omb-link`, `Environment=MADANI_LINK_ENGINES_FILE=${dir}/var/lib/omb-link/handoff/engines.env`,
      `Environment=MADANI_LINK_CODEX_AUTH_FILE=${dir}/var/lib/omb-link/handoff/codex-auth.json`, "NoNewPrivileges=yes", "ProtectHome=yes", "RestrictNamespaces=yes", "ProtectKernelTunables=yes", "PrivateDevices=yes", `ReadWritePaths=${dir}/var/lib/omb-link`,
      "WantedBy=multi-user.target madanibot.service"]) {
      expect(link.split("\n"), line).toContain(line);
    }
    // a server restart must not restart the link: that drops the app's tunnel and every phone's stream; a stop still
    // takes it down, from the server's own stop hook
    expect(link).not.toMatch(/^(?:PartOf|BindsTo|StopPropagatedFrom)=/m);
    expect(server).toContain("ExecStopPost=+/bin/sh -c 'systemctl list-jobs --no-legend madanibot.service 2>/dev/null | grep -qw stop && systemctl stop --no-block madanibot-link.service || true'");
    expect(link).not.toContain("User=madani");

    const gate = await read(join(dir, "units", "omb-docker-gate.service"));
    for (const line of ["User=omb-docker", "Group=omb-dockergate", "SupplementaryGroups=docker", "RuntimeDirectory=madanibot-docker", "RestrictAddressFamilies=AF_UNIX", "IPAddressDeny=any", "NoNewPrivileges=yes", "CapabilityBoundingSet="]) {
      expect(gate.split("\n"), line).toContain(line);
    }
    expect(gate).toContain(`ExecStart=/usr/bin/node ${dir}/usr/local/lib/madanibot/docker-gate.mjs --listen /run/madanibot-docker/docker.sock --upstream /var/run/docker.sock`);

    const path = await read(join(dir, "units", "madanibot-engines.path"));
    expect(path).toContain(`PathExists=${dir}/var/lib/omb-link/handoff/engines.env`);
    expect(path).toContain("Unit=madanibot-handoff.service");
    expect(existsSync(join(dir, "units", "madanibot-restart.service"))).toBe(false);
    expect((await stat(join(dir, "usr", "local", "lib", "madanibot", "engine-handoff.sh"))).mode & 0o777).toBe(0o755);
  });

  it("the hand-off keeps only the Claude token line, puts the codex sign-in in madani's home and restarts the server", async () => {
    const dir = await fixture(`handoff_script
mkdir -p "$HANDOFF" "$ETC" "$SVC_HOME"
printf 'NODE_OPTIONS=--require /tmp/x.js\\n${TOKEN}\\nPATH=/evil\\n' > "$HANDOFF/engines.env"
printf '{"tokens":{"id_token":"x"}}' > "$HANDOFF/codex-auth.json"
sh "$LIB/engine-handoff.sh"`);
    expect(await read(join(dir, "etc", "madanibot", "engines.env"))).toBe(`${TOKEN}\n`);
    expect(await read(join(dir, "home", "madani", ".codex", "auth.json"))).toBe('{"tokens":{"id_token":"x"}}');
    expect(existsSync(join(dir, "var", "lib", "omb-link", "handoff", "engines.env"))).toBe(false);
    expect(existsSync(join(dir, "var", "lib", "omb-link", "handoff", "codex-auth.json"))).toBe(false);
    const calls = await read(join(dir, "calls"));
    expect(calls).toContain("runuser omb-link");
    expect(calls).toContain("runuser madani");
    expect(calls).toContain("systemctl restart madanibot.service");
  });

  it("a hand-off with no valid token changes nothing and restarts nothing", async () => {
    const dir = await fixture(`handoff_script
mkdir -p "$HANDOFF" "$ETC"
printf '${TOKEN}\\n' > "$ETC/engines.env"
printf 'NODE_OPTIONS=--require /tmp/x.js\\n' > "$HANDOFF/engines.env"
sh "$LIB/engine-handoff.sh"`);
    expect(await read(join(dir, "etc", "madanibot", "engines.env"))).toBe(`${TOKEN}\n`);
    expect(await read(join(dir, "calls")).catch(() => "")).not.toContain("systemctl restart");
  });
});

describe("the installer's account split on an older install", () => {
  const older = `
SVC_USER=$OLD_SVC_USER; SVC_HOME=$ROOT/home/$SVC_USER; DATA=$SVC_HOME/.madanibot
mkdir -p "$SVC_HOME/.config/${LEGACY.linkConfigDir}" "$SVC_HOME/.config/${LEGACY.devName}" "$SVC_HOME/.ssh" "$DATA/workspaces/b1" "$SVC_HOME/.codex/sessions/2026" "$SVC_HOME/.claude/projects/p"
echo maus >> "$ROOT/users"; echo docker >> "$ROOT/group-names"
echo "maus docker" > "$ROOT/groups-maus"
printf '{"v":1,"id":"abcdefghij","key":"k"}' > "$SVC_HOME/.config/${LEGACY.linkConfigDir}/tunnel.json"
printf 'ssh-ed25519 AAAA mine\\nrestrict,command="/usr/bin/node /opt/madanibot-link/agent.mjs direct" ssh-ed25519 BBBB omb-link-abcdefghij\\n' > "$SVC_HOME/.ssh/authorized_keys"
printf 'NODE_OPTIONS=--require /tmp/x.js\\n${TOKEN}\\n' > "$SVC_HOME/.config/${LEGACY.devName}/engines.env"
echo rollout > "$SVC_HOME/.codex/sessions/2026/r.jsonl"; echo transcript > "$SVC_HOME/.claude/projects/p/s.jsonl"; echo '{}' > "$SVC_HOME/.claude.json"
echo db > "$DATA/messages.db"
`;

  it("moves the link files to omb-link, the token to /etc, takes maus out of docker and gives engines their own home", async () => {
    const dir = await fixture(`${older}
do_user > "$ROOT/out" 2>&1 || { cat "$ROOT/out" >&2; exit 1; }`);
    const home = join(dir, "home", "maus"), linkHome = join(dir, "var", "lib", "omb-link");
    expect(await read(join(linkHome, ".config", "madanibot-link", "tunnel.json"))).toBe('{"v":1,"id":"abcdefghij","key":"k"}');
    expect(existsSync(join(home, ".config", LEGACY.linkConfigDir))).toBe(false);
    expect(await read(join(home, ".ssh", "authorized_keys"))).toBe("ssh-ed25519 AAAA mine\n");
    expect(await read(join(dir, "etc", "madanibot", "engines.env"))).toBe(`${TOKEN}\n`);
    expect(existsSync(join(home, ".config", LEGACY.devName, "engines.env"))).toBe(false);
    const engine = join(home, ".madanibot", "engine-home");
    expect(await read(join(engine, ".codex", "sessions", "2026", "r.jsonl"))).toBe("rollout\n");
    expect(await read(join(engine, ".claude", "projects", "p", "s.jsonl"))).toBe("transcript\n");
    expect(await read(join(engine, ".claude.json"))).toBe("{}\n");
    expect(await read(join(home, ".madanibot", "messages.db"))).toBe("db\n");
    expect((await stat(home)).mode & 0o777).toBe(0o700);
    expect((await stat(join(home, ".madanibot"))).mode & 0o777).toBe(0o700);
    const calls = await read(join(dir, "calls"));
    expect(calls).toContain("gpasswd -d maus docker");
    expect(calls).toMatch(/useradd --system --no-create-home .* --gid omb-dockergate omb-docker/);
    expect(calls).toMatch(/useradd --system --create-home --home-dir \S+omb-link --shell \/bin\/sh omb-link/);
    expect(calls).toContain("usermod -aG omb-dockergate maus");
    expect(calls).toContain("usermod -aG docker omb-docker");
    expect(calls).not.toContain("usermod -aG docker maus");
  });

  it("is safe to run again: nothing is made twice and nothing is lost", async () => {
    const dir = await fixture(`${older}
do_user > "$ROOT/out" 2>&1 || { cat "$ROOT/out" >&2; exit 1; }
echo "maus" > "$ROOT/groups-maus"
: > "$CALLS"
echo later > "$DATA/engine-home/.codex/kept"
do_user > "$ROOT/out2" 2>&1 || { cat "$ROOT/out2" >&2; exit 1; }`);
    const calls = await read(join(dir, "calls"));
    expect(calls).not.toContain("useradd");
    expect(calls).not.toContain("groupadd");
    expect(calls).not.toContain("gpasswd");
    expect(await read(join(dir, "home", "maus", ".madanibot", "engine-home", ".codex", "kept"))).toBe("later\n");
    expect(await read(join(dir, "var", "lib", "omb-link", ".config", "madanibot-link", "tunnel.json"))).toContain("abcdefghij");
  });
});

describe("sh install.sh --repair", () => {
  let lastDir;
  async function repair(linked) {
    const dir = await mkdtemp(join(tmpdir(), "omb-install-repair-"));
    dirs.push(dir);
    lastDir = dir;
    const file = join(dir, "fixture.sh");
    await writeFile(file, `${script}
STATE=$1/state; LOGS=$1/logs; mkdir -p "$STATE"
${linked ? 'echo abcdefghij > "$STATE/id"; echo abcdefghij > "$STATE/linked"; echo img:3 > "$STATE/desktop-image"' : ""}
id() { [ "$1" = -u ] && echo 0 || command id "$@"; }
claim() { echo "claimed"; }
ui_init() { :; }; banner() { :; }; intro() { :; }; checklist() { :; }; finale() { echo "finale offline=$OFFLINE image=$BOT_DESKTOP_IMAGE id=$LINK_ID"; }
phase() { :; }; phase_end() { :; }; step() { echo "step $1"; }; start_link_service() { echo "link restarted"; }
AGENT=$1/agent.mjs; touch "$AGENT"
TOKEN=--repair; main --repair
`);
    return run("sh", [file, dir], { env: { PATH: "/usr/bin:/bin", TERM: "dumb" } }).then((result) => result.stdout, (error) => `${error.stdout}${error.stderr}`);
  }

  it("brings a linked install up to date without a line: no claim, no new link", async () => {
    const out = await repair(true);
    expect(out).not.toContain("claimed");
    expect(out).toContain("step user");
    expect(out).toContain("step service");
    expect(out).not.toContain("step link");
    expect(out).not.toContain("link restarted");
    expect(await read(join(lastDir, "logs", "link.log"))).toContain("link restarted");
    expect(out).toContain("finale offline=1 image=img:3 id=abcdefghij");
  });

  it("refuses on a server that was never linked", async () => {
    expect(await repair(false)).toContain("--repair needs an install that is already linked");
  });
});
