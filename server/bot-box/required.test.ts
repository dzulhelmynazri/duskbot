import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { antigravityProfileDirectory } from "../drivers/antigravity-acp.ts";
import { engineInstallRoots } from "../engine-roots.ts";
import { BotBox, BoxRunner, BOX_EGRESS_PORT, engineHomeDir, extraCodeRoots, requiredFence } from "./box.ts";
import { boxWanted, detectBox } from "./detect.ts";
import { BoxFenceError, fencedPath, planBox, visibleInBox } from "./plan.ts";

const linuxBox = describe.skipIf(process.platform === "win32");
const bridge = { socat: "/usr/bin/socat", bridgeScript: "/app/dist-server/bot-box/box-bridge.js", node: "/usr/bin/node" };

const home = "/home/maus";
const dataDir = "/home/maus/.madanibot";
const fence = requiredFence(home, dataDir);
const setup = {
  dataDir, home, codeRoots: ["/app", "/home/maus/.local/bin", "/home/maus/.local/lib"], engineRoots: engineInstallRoots(dataDir), fence,
  bridges: [{ name: "egress", port: BOX_EGRESS_PORT, socket: `${dataDir}/box/egress.sock` }],
};
const cwd = join(dataDir, "task-workspaces", "bot-a", "thread-1");

describe("MADANI_BOT_BOX=required", () => {
  it("is on, and detection treats it as on", () => {
    expect(boxWanted({ MADANI_BOT_BOX: "required" })).toBe("required");
    expect(detectBox({ env: { MADANI_BOT_BOX: "required" }, platform: "linux", probe: () => true, which: (name) => (name === "bwrap" ? "/usr/bin/bwrap" : null) }).box).toBe("bwrap");
  });

  it("refuses a bot's spawn rather than running it unboxed when bubblewrap cannot start", async () => {
    const box = new BotBox();
    await box.start({ dataDir, home, port: 8799, env: { MADANI_BOT_BOX: "required" }, denyEnv: new Set(), log: () => {}, detect: () => ({ box: "off", reason: "userns-refused", tools: null }) });
    expect(box.isRequired()).toBe(true);
    expect(() => box.wrap({ command: "/usr/bin/codex", args: [], cwd, env: {} })).toThrow(/cannot start here \(userns-refused\)/);
    const optional = new BotBox();
    await optional.start({ dataDir, home, port: 8799, env: { MADANI_BOT_BOX: "1" }, denyEnv: new Set(), log: () => {}, detect: () => ({ box: "off", reason: "userns-refused", tools: null }) });
    expect(optional.wrap({ command: "/usr/bin/codex", args: [], cwd, env: {} })).toBeNull();
  });

  it("reads more code roots from MADANI_BOX_CODE_ROOTS, absolute ones only", () => {
    expect(extraCodeRoots({ MADANI_BOX_CODE_ROOTS: "/home/maus/.local/bin:relative::/home/maus/.local/lib" })).toEqual(["/home/maus/.local/bin", "/home/maus/.local/lib"]);
    expect(extraCodeRoots({})).toEqual([]);
  });
});

linuxBox("the required box's fence", () => {
  it("never lets a line hold the server's HOME or data folder, or reach HOME's keys, settings or code", () => {
    for (const path of ["/", "/home", home, dataDir, `${home}/.ssh`, `${home}/.ssh/authorized_keys`, `${home}/.config/madanibot-link/tunnel.json`,
      `${home}/.local/lib/node_modules/madanibot/cli.js`, `${home}/.npmrc`, `${home}/.gitconfig`]) {
      expect(fencedPath(path, fence, dataDir), path).toBe(true);
    }
    for (const path of [`${home}/projects/site`, "/srv/app", `${dataDir}/workspaces/bot-a`, `${dataDir}/perm-abc.sock`]) expect(fencedPath(path, fence, dataDir), path).toBe(false);
    expect(fencedPath(`${dataDir}/workspaces/bot-a/sub`, fence, dataDir, true)).toBe(false);
    expect(fencedPath(cwd, fence, dataDir, true)).toBe(false);
    for (const folder of [`${dataDir}/bots`, `${dataDir}/workspaces`, `${dataDir}/engine-home`, `${dataDir}/ssh`, `${dataDir}/task-workspaces/bot-a`]) {
      expect(fencedPath(folder, fence, dataDir, true), `working folder ${folder}`).toBe(true);
    }
    expect(fencedPath(home, undefined, dataDir, true)).toBe(false);
  });

  it("refuses a turn whose working folder or lent path would open the fence", () => {
    const plan = (request: { cwd?: string; rw?: string[]; env?: Record<string, string> }) => planBox(setup, { command: "/usr/bin/codex", args: [], env: request.env ?? {}, ...request });
    expect(() => plan({ cwd: home })).toThrow(BoxFenceError);
    expect(() => plan({ cwd: "/" })).toThrow(BoxFenceError);
    expect(() => plan({ cwd, rw: [`${home}/.ssh`] })).toThrow(BoxFenceError);
    expect(() => plan({ cwd, env: { XDG_CONFIG_HOME: `${home}/.config` } })).toThrow(BoxFenceError);
    expect(() => plan({ cwd: `${dataDir}/bots` })).toThrow(BoxFenceError);
    expect(plan({ cwd: `${home}/projects/site` }).writable).toContain(`${home}/projects/site`);
  });

  it("an engine's own home under providers/ is its run's working folder only when its environment names that home", () => {
    const own = `${dataDir}/providers/antigravity/${"a".repeat(64)}`, other = `${dataDir}/providers/antigravity/${"b".repeat(64)}`;
    const plan = (request: { cwd: string; env: Record<string, string> }) => planBox(setup, { command: "/opt/agy/agy", args: ["--uid="], ...request });
    const ownRun = plan({ cwd: own, env: { GEMINI_HOME: own } });
    expect(visibleInBox(ownRun, own)).toBe("rw");
    expect(visibleInBox(ownRun, `${own}/antigravity-acp/acp_token.json`)).toBe("rw");
    for (const hidden of [other, `${dataDir}/providers/claude-2/.credentials.json`, `${dataDir}/providers/engine-status.json`, `${dataDir}/config.json`,
      `${dataDir}/messages.db`, `${dataDir}/logins-key`, `${dataDir}/workspaces/bot-a`, `${home}/.ssh/authorized_keys`]) {
      expect(visibleInBox(ownRun, hidden), hidden).toBe("none");
    }
    expect(() => plan({ cwd: own, env: {} }), "no engine home named").toThrow(BoxFenceError);
    expect(() => plan({ cwd: own, env: { GEMINI_HOME: other } }), "another account's home").toThrow(BoxFenceError);
    expect(() => plan({ cwd: own, env: { CLAUDE_CONFIG_DIR: `${dataDir}/providers/claude-2` } }), "another engine's home").toThrow(BoxFenceError);
    expect(() => plan({ cwd: `${dataDir}/providers/antigravity`, env: { GEMINI_HOME: own } }), "the engine's whole providers folder").toThrow(BoxFenceError);
    expect(() => plan({ cwd: `${dataDir}/providers`, env: { GEMINI_HOME: `${dataDir}/providers` } })).toThrow(BoxFenceError);
    expect(() => plan({ cwd: `${dataDir}/config`, env: { GEMINI_HOME: `${dataDir}/providers/x/../../config` } })).toThrow(BoxFenceError);
    expect(() => plan({ cwd: dataDir, env: { GEMINI_HOME: dataDir } })).toThrow(BoxFenceError);
    expect(plan({ cwd, env: { GEMINI_HOME: own } }).writable).toContain(cwd);
  });

  it("a refused path is never named in the message people see", () => {
    try {
      planBox(setup, { command: "/usr/bin/codex", args: [], cwd: `${dataDir}/bots`, env: {} });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BoxFenceError);
      expect((error as BoxFenceError).path).toBe(`${dataDir}/bots`);
      expect((error as Error).message).not.toContain(dataDir);
    }
  });

  it("a command-line path inside the fence is simply not put back", () => {
    const plan = planBox(setup, { command: "/usr/bin/claude", args: ["--settings", `${home}/.config/x.json`, "--add-dir", home], cwd, env: {} });
    expect(visibleInBox(plan, `${home}/.config/x.json`)).toBe("none");
    expect(visibleInBox(plan, `${home}/.ssh/authorized_keys`)).toBe("none");
  });
});

linuxBox("a required box runs engines in their own home", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it("HOME is the engine home; the server's HOME, data folder, keys and link files are not there; sign-ins are, settings read-only", () => {
    const root = mkdtempSync(join(tmpdir(), "madani-required-box-"));
    dirs.push(root);
    const serverHome = join(root, "home"), data = join(serverHome, ".madanibot");
    const runner = new BoxRunner({
      bwrap: "/usr/bin/bwrap", bridge, denyEnv: new Set(), engineHome: engineHomeDir(data),
      setup: { dataDir: data, home: serverHome, codeRoots: ["/app", join(serverHome, ".local", "bin"), join(serverHome, ".local", "lib")], engineRoots: [], fence: requiredFence(serverHome, data), bridges: [] },
    });
    const turnCwd = join(data, "task-workspaces", "bot-a", "thread-1");
    const wrapped = runner.wrap({ command: "/usr/bin/codex", args: ["app-server"], cwd: turnCwd, env: { HOME: serverHome, PATH: `${serverHome}/.local/bin:/usr/bin` } });
    const engineHome = engineHomeDir(data);
    expect(wrapped.env.HOME).toBe(engineHome);
    expect(existsSync(engineHome)).toBe(true);
    const plan = wrapped.plan;
    expect(visibleInBox(plan, engineHome)).toBe("rw");
    expect(visibleInBox(plan, turnCwd)).toBe("rw");
    expect(visibleInBox(plan, join(data, "workspaces", "bot-a", "MEMORY.md"))).toBe("rw");
    expect(visibleInBox(plan, join(engineHome, ".codex", "auth.json")), "the sign-in, refreshed in place").toBe("rw");
    expect(visibleInBox(plan, join(engineHome, ".codex", "config.toml")), "the person's settings, never writable").toBe("ro");
    expect(visibleInBox(plan, join(serverHome, ".local", "bin", "codex"))).toBe("ro");
    expect(visibleInBox(plan, join(serverHome, ".local", "lib", "node_modules", "madanibot", "cli.js"))).toBe("ro");
    for (const hidden of [".ssh/authorized_keys", ".config/madanibot-link/tunnel.json", ".config/madanibot/engines.env", ".codex/auth.json", ".bashrc", ".npmrc",
      ".madanibot/messages.db", ".madanibot/config.json", ".madanibot/logins-key", ".madanibot/workspaces/bot-b/x"]) {
      expect(visibleInBox(plan, join(serverHome, hidden)), hidden).toBe("none");
    }
    const mounts = plan.mounts.filter((mount) => mount.kind === "bind" || mount.kind === "ro");
    expect(mounts.some((mount) => "source" in mount && mount.source === serverHome), "the server's HOME is never bound").toBe(false);
    const auth = mounts.find((mount) => "target" in mount && mount.target === join(engineHome, ".codex", "auth.json"));
    expect(auth && "source" in auth ? auth.source : null).toBe(join(serverHome, ".codex", "auth.json"));
  });

  it("an Antigravity account's sign-in and model list run in its own profile, and nothing else of the data folder", () => {
    const root = mkdtempSync(join(tmpdir(), "madani-required-box-"));
    dirs.push(root);
    const serverHome = join(root, "home"), data = join(serverHome, ".madanibot");
    const runner = new BoxRunner({
      bwrap: "/usr/bin/bwrap", bridge, denyEnv: new Set(), engineHome: engineHomeDir(data),
      setup: { dataDir: data, home: serverHome, codeRoots: ["/app"], engineRoots: engineInstallRoots(data), fence: requiredFence(serverHome, data), bridges: [] },
    });
    const profile = antigravityProfileDirectory("antigravity", data);
    const executable = join(data, "tools", "antigravity-acp", "linux-x64", "versions", "abc", "agy");
    const wrapped = runner.wrap({ command: executable, args: ["--uid="], cwd: profile, env: { HOME: serverHome, GEMINI_HOME: profile } });
    expect(wrapped.env.GEMINI_HOME).toBe(profile);
    expect(visibleInBox(wrapped.plan, join(profile, "antigravity-acp", "acp_token.json"))).toBe("rw");
    expect(visibleInBox(wrapped.plan, executable)).toBe("ro");
    for (const hidden of [antigravityProfileDirectory("antigravity-2", data), join(data, "providers", "claude-2"), join(data, "config.json"), join(data, "workspaces", "bot-a")]) {
      expect(visibleInBox(wrapped.plan, hidden), hidden).toBe("none");
    }
    expect(() => runner.wrap({ command: executable, args: ["--uid="], cwd: profile, env: { HOME: serverHome } })).toThrow(BoxFenceError);
  });
});
