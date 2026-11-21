// a bot on Auto whose own VPS computer is asleep at turn start: its tools are mounted, and the first screen call and the
// first vm_exec wake it and run in that same turn, with no select_computer switch and no continuation turn
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeFileAtomic } from "./atomic.ts";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { vpsToolsKey } from "./vps-computer-relay.ts";
import { WAKES_ON_CALL_VPS_NOTE } from "./vps-turn-start.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let child: ChildProcess;
let home = "";
let base = "";
let stderr = "";
let vpsStateFile = "";
let dumpFile = "";
let callsFile = "";
let driverLog = "";
const readVpsState = (): { containers?: Record<string, string>; actions?: Array<{ action: string; ownerId: string }>; execs?: string[] } =>
  JSON.parse(readFileSync(vpsStateFile, "utf8"));
const vpsState = (state: ReturnType<typeof readVpsState> = {}) => writeFileAtomic(vpsStateFile, JSON.stringify(state));
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(base + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json() as any;
  expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
  return result;
};
async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() >= end) throw new Error(`Fixture wait expired: ${JSON.stringify(value)}\n${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}
const idle = (botId: string) => until(() => api("GET", "/api/bots?messages=0"), (state) => !state.bots.find((bot: any) => bot.id === botId)?.busy);
const dump = () => until(() => {
  if (!existsSync(dumpFile)) return null;
  try { return JSON.parse(readFileSync(dumpFile, "utf8")); } catch { return null; }
}, Boolean);
const driverCalls = () => existsSync(driverLog) ? readFileSync(driverLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "madani-vps-wakes-"));
  const data = join(home, "data"), ui = join(home, "static");
  vpsStateFile = join(home, "vps.json");
  dumpFile = join(home, "dump.json");
  callsFile = join(home, "calls.json");
  driverLog = join(home, "driver.log");
  vpsState();
  writeFileAtomic(join(home, "vm.json"), "{}");
  mkdirSync(data);
  mkdirSync(join(ui, "assets"), { recursive: true });
  writeFileSync(join(ui, "index.html"), "<title>VPS wakes on call</title>");
  writeFileSync(join(ui, "assets", "test.css"), "body{}");
  // what an earlier turn on an awake desktop listed: the fixture desktop is "cua" with driver "fixture"
  writeFileSync(join(data, "vps-computer-tools.json"), JSON.stringify({ [vpsToolsKey({ desktop: "cua", driver_version: "fixture" })]: [
    { name: "screenshot", inputSchema: { type: "object", properties: {} } },
    { name: "launch_app", inputSchema: { type: "object", properties: { url: { type: "string" } } } },
  ] }));
  writeFileSync(join(data, "config.json"), JSON.stringify({ vps: { sshAlias: "fixture-vps", mode: "per-bot" }, instances: { claude: {
    driver: "claudeAgent", config: { cli: join(ROOT, "server/testing/fake-claude-cli.ts") },
    environment: { FAKE_CLAUDE_DUMP: dumpFile, FAKE_CLAUDE_TOOL_CALLS_FILE: callsFile },
  } } }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--import", pathToFileURL(join(ROOT, "server/testing/group-local-vm-hooks.mjs")).href, join(ROOT, "server/index.ts")], {
    cwd: ROOT, env: {
      PATH: dirname(process.execPath), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home, USERPROFILE: home, MADANI_DATA_DIR: data, APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"),
      TEMP: home, TMP: home, TMPDIR: home, MADANI_PORT: String(port), MADANI_WEBHOOK_PORT: String(port + 1), MADANI_STATIC_DIR: ui,
      MADANI_TEST_VM_STATE: join(home, "vm.json"), MADANI_TEST_VPS_STATE: vpsStateFile, MADANI_TEST_VPS_DRIVER_LOG: driverLog,
    }, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", () => {});
  child.stderr!.on("data", (chunk) => { stderr += chunk; });
  await until(async () => {
    if (child.exitCode !== null) throw new Error(stderr);
    try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
  }, Boolean);
  const seeded = (await api("GET", "/api/bots?messages=0")).bots.find((bot: any) => bot.chiefOfStaff);
  if (seeded) await api("PATCH", `/api/bots/${seeded.id}`, { chiefOfStaff: false });
}, 60_000);
afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

describe("a list of bots drawn before the event stream opens", () => {
  it("carries the stream cursor it was read at, and the stream resumes from it", async () => {
    const { cursor } = await api("GET", "/api/bots?messages=0");
    expect(cursor).toMatch(/^[\w-]+:\d+$/);
    const stop = new AbortController();
    const response = await fetch(`${base}/api/events?since=${encodeURIComponent(cursor)}&screens=off`, { signal: stop.signal });
    const reader = response.body!.getReader();
    let text = "";
    while (!text.includes("\n\n")) text += new TextDecoder().decode((await reader.read()).value);
    stop.abort();
    expect(JSON.parse(text.slice(text.indexOf("data: ") + 6, text.indexOf("\n\n")))).toMatchObject({ kind: "hello", resumed: true });
  });
});

describe("a bot's own VPS computer asleep at turn start", () => {
  it("wakes on the first screen call and vm_exec of the same turn", async () => {
    const { bot } = await api("POST", "/api/bots", { name: "Cinder fixture", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } });
    await api("PATCH", `/api/bots/${bot.id}`, { computer: null, browser: false });
    vpsState({ containers: { [bot.id]: "stopped" } });
    writeFileSync(callsFile, JSON.stringify([
      { name: "launch_app", server: "computer", input: { url: "https://madani.bot" } },
      { name: "screenshot", server: "computer", input: {} },
      { name: "vm_exec", server: "agents", input: { command: "uname -m" } },
    ]));
    rmSync(dumpFile, { force: true });
    await api("POST", `/api/bots/${bot.id}/messages`, { text: "can u use computer and open madani.bot in it" });
    const sent: any = await dump();
    await idle(bot.id);

    const computer = sent.mcpConfig.mcpServers.computer;
    expect(computer.args.at(-1)).toBe("computer");
    expect(computer.env.MADANI_MCP_TOKEN_COMPUTER).toBeTruthy();
    expect(computer.env.MADANI_CONTROL_TOKEN).toBeUndefined();
    expect(sent.systemPrompt).toContain(WAKES_ON_CALL_VPS_NOTE.trim());

    expect(readVpsState().actions).toEqual([{ action: "start", ownerId: bot.id }]);
    expect(driverCalls().map((entry) => [entry.ownerId, entry.call.name, entry.held])).toEqual([
      [bot.id, "launch_app", false], [bot.id, "screenshot", false],
    ]);
    expect(readVpsState().execs).toEqual(["uname -m"]);

    const transcript = JSON.stringify(await api("GET", "/api/bots?messages=50"));
    expect(transcript).not.toContain("The computer selection is now");
    expect(transcript).not.toContain("is not running");

    // the next turn finds the same relayed computer: its engine keeps running, and its proxy's bearer works again
    vpsState({ containers: { [bot.id]: "stopped" } });
    writeFileSync(callsFile, JSON.stringify([{ name: "screenshot", server: "computer", input: {} }]));
    rmSync(dumpFile, { force: true });
    await api("POST", `/api/bots/${bot.id}/messages`, { text: "and take one more screenshot" });
    const next: any = await dump();
    await idle(bot.id);
    expect(next.pid).toBe(sent.pid);
    expect(driverCalls().map((entry) => entry.call.name)).toEqual(["launch_app", "screenshot", "screenshot"]);
  }, 60_000);
});
