import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { LEGACY } from "../../../electron/legacy-names.mjs";

const run = promisify(execFile);
const script = (await readFile(new URL("../install.sh", import.meta.url), "utf8")).replace(/\nmain "\$@"\s*$/, "\n");
const OLD = LEGACY.devName;
const dirs = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const put = async (file, text) => { await mkdir(dirname(file), { recursive: true }); await writeFile(file, text); };

/** a server as an install from before the rename left it, with every system path under one throwaway root */
async function oldServer() {
  const root = await mkdtemp(join(tmpdir(), "omb-install-legacy-"));
  dirs.push(root);
  const bin = join(root, "bin");
  await mkdir(bin);
  for (const tool of ["systemctl", "apparmor_parser", "chown"]) {
    await writeFile(join(bin, tool), `#!/bin/sh\nprintf '${tool} %s\\n' "$*" >> "$CALLS"\n`);
    await chmod(join(bin, tool), 0o755);
  }
  for (const unit of [`${OLD}.service`, `${OLD}-link.service`, `${OLD}-engines.path`, `${OLD}-handoff.service`]) await put(join(root, "units", unit), "[Unit]\n");
  await put(join(root, "units", "ssh.service.d", `10-${OLD}-oom.conf`), "[Service]\n");
  await put(join(root, "home/maus", `.${OLD}`, "config.json"), "{}");
  await put(join(root, "home/maus", `.${OLD}`, "bots.json"), JSON.stringify([{ id: "b1", name: "Kept helper" }]));
  await put(join(root, "var/lib", `${OLD}-link`, "linked"), "1\n");
  await put(join(root, "var/lib", `${OLD}-link`, "id"), "abcdefghij\n");
  await put(join(root, "var/log", `${OLD}-link`, "link.log"), "old log\n");
  await put(join(root, "var/lib", OLD, "install-manifest"), `pkg docker.io\nfile /etc/apparmor.d/${OLD}-bwrap\n`);
  await put(join(root, "opt", `${OLD}-link`, "agent.mjs"), "// agent\n");
  await put(join(root, "usr/local/lib", OLD, "docker-gate.mjs"), "// gate\n");
  await put(join(root, "etc", OLD, "engines.env"), "CLAUDE_CODE_OAUTH_TOKEN=x\n");
  await put(join(root, "var/lib/omb-link/.config", `${OLD}-link`, "tunnel.json"), '{"id":"abcdefghij"}');
  await put(join(root, "var/lib/omb-link/.ssh/authorized_keys"), `command="/usr/bin/node ${root}/opt/${OLD}-link/agent.mjs direct" ssh-ed25519 AAAA omb-link-abcdefghij\n`);
  await put(join(root, "etc/apparmor.d", `${OLD}-bwrap`), "profile\n");
  await put(join(root, "etc/caddy", `${OLD}.caddy`), "example.test {\n}\n");
  await put(join(root, "etc/caddy/Caddyfile"), `# managed by ${OLD}-link\nimport ${root}/etc/caddy/${OLD}.caddy\n`);
  const file = join(root, "fixture.sh");
  await writeFile(file, `${script}
ROOT=$1
CALLS=$ROOT/calls; export CALLS
UNITS=$ROOT/units TMP=$ROOT/tmp
SVC_USER=maus SVC_HOME=$ROOT/home/maus; DATA=$SVC_HOME/.madanibot
LINK_HOME=$ROOT/var/lib/omb-link
STATE=$ROOT/var/lib/madanibot-link LOGS=$ROOT/var/log/madanibot-link MANIFEST=$ROOT/var/lib/madanibot/install-manifest
AGENT=$ROOT/opt/madanibot-link/agent.mjs LIB=$ROOT/usr/local/lib/madanibot ETC=$ROOT/etc/madanibot
CADDY_SITE=$ROOT/etc/caddy/madanibot.caddy CADDY_MAIN=$ROOT/etc/caddy/Caddyfile
OLD_STATE=$ROOT/var/lib/$OLD-link OLD_LOGS=$ROOT/var/log/$OLD-link OLD_MANIFEST=$ROOT/var/lib/$OLD/install-manifest
OLD_AGENT_DIR=$ROOT/opt/$OLD-link OLD_LIB=$ROOT/usr/local/lib/$OLD OLD_ETC=$ROOT/etc/$OLD
OLD_BWRAP_PROFILE=$ROOT/etc/apparmor.d/$OLD-bwrap OLD_CADDY_SITE=$ROOT/etc/caddy/$OLD.caddy
# the vps's GNU sed edits in place with a bare -i
sed() { if [ "$1" = -i ]; then shift; command sed "$1" "$2" > "$2.sed" && cat "$2.sed" > "$2" && rm -f "$2.sed"; else command sed "$@"; fi; }
mkdir -p "$TMP"
migrate_legacy > "$ROOT/out"
migrate_legacy > "$ROOT/again"
`);
  await run("sh", [file, root], { env: { PATH: `${bin}:/usr/bin:/bin`, TERM: "dumb" } });
  return root;
}

it("moves an install from before the rename to the new names, keeping its bots, link and site", async () => {
  const root = await oldServer();
  const at = (...parts) => join(root, ...parts);
  const calls = await readFile(at("calls"), "utf8");

  for (const unit of [`${OLD}.service`, `${OLD}-link.service`, `${OLD}-engines.path`, `${OLD}-handoff.service`]) {
    expect(calls).toContain(`systemctl disable --now ${unit}`);
    expect(existsSync(at("units", unit))).toBe(false);
  }
  expect(existsSync(at("units/ssh.service.d", `10-${OLD}-oom.conf`))).toBe(false);

  // the bots, under the new folder name, still found through the old one
  expect(JSON.parse(await readFile(at("home/maus/.madanibot/bots.json"), "utf8"))[0].name).toBe("Kept helper");
  expect((await lstat(at("home/maus", `.${OLD}`))).isSymbolicLink()).toBe(true);
  expect(await readFile(at("home/maus", `.${OLD}`, "config.json"), "utf8")).toBe("{}");

  expect(await readFile(at("var/lib/madanibot-link/id"), "utf8")).toBe("abcdefghij\n");
  expect(await readFile(at("var/log/madanibot-link/link.log"), "utf8")).toBe("old log\n");
  expect(await readFile(at("etc/madanibot/engines.env"), "utf8")).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  expect(await readFile(at("usr/local/lib/madanibot/docker-gate.mjs"), "utf8")).toBe("// gate\n");
  expect(await readFile(at("var/lib/omb-link/.config/madanibot-link/tunnel.json"), "utf8")).toContain("abcdefghij");

  // the agent: moved, its old folder a link, and the app's direct key runs it from the new place
  expect(await readFile(at("opt/madanibot-link/agent.mjs"), "utf8")).toBe("// agent\n");
  expect(await readlink(at("opt", `${OLD}-link`))).toBe(at("opt/madanibot-link"));
  const keys = await readFile(at("var/lib/omb-link/.ssh/authorized_keys"), "utf8");
  expect(keys).toContain(`${at("opt/madanibot-link")}/agent.mjs direct`);
  expect(keys).not.toContain(OLD);

  expect(calls).toContain(`apparmor_parser -R ${at("etc/apparmor.d", `${OLD}-bwrap`)}`);
  expect(existsSync(at("etc/apparmor.d", `${OLD}-bwrap`))).toBe(false);
  expect(await readFile(at("etc/caddy/madanibot.caddy"), "utf8")).toBe("example.test {\n}\n");
  expect(await readFile(at("etc/caddy/Caddyfile"), "utf8")).toBe(`# managed by madanibot-link\nimport ${at("etc/caddy/madanibot.caddy")}\n`);
  expect(await readFile(at("var/lib/madanibot/install-manifest"), "utf8")).not.toContain(OLD);

  expect(await readFile(at("out"), "utf8")).toContain("moving an install from before the rename");
  expect(await readFile(at("again"), "utf8")).toBe("");
});
