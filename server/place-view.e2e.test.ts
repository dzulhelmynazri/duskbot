// real server and fake claude cli with no VPS connected: cloud computers are VPS-only, so asking for one names the missing VPS.
// a restartable home lets a test seed an automatic pin.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("a cloud computer that can't start, against the real server", () => {
  let home = "";
  let data = "";
  let ui = "";
  let output = "";
  let child: ChildProcess | null = null;
  let base = "";

  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const apiOk = async (method: string, path: string, body?: unknown) => {
    const result = await api(method, path, body);
    expect(result.status, `${method} ${path}: ${JSON.stringify(result.body)}`).toBeLessThan(400);
    return result.body;
  };
  async function until<T>(read: () => T | Promise<T>, accept: (value: NoInfer<T>) => boolean, what = "fixture"): Promise<T> {
    const end = Date.now() + 30_000;
    for (;;) {
      const value = await read();
      if (accept(value)) return value;
      if (Date.now() >= end) throw new Error(`${what} wait expired: ${JSON.stringify(value)}\n${output.slice(-2_000)}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  const messages = async (threadId: string) => (await apiOk("GET", `/api/threads/${threadId}/messages?limit=50`)).messages as any[];
  const failedRow = (threadId: string, after = 0): Promise<any> => until(
    async () => (await messages(threadId)).slice(after).find((message) => String(message.tool?.name ?? "").startsWith("error:")),
    Boolean, "failed row");
  const idle = (botId: string) => until(
    async () => (await apiOk("GET", "/api/bots?messages=0")).bots.find((bot: any) => bot.id === botId),
    (bot: any) => bot && !bot.busy, "idle bot");
  const savedTask = (botId: string, threadId: string) =>
    (JSON.parse(readFileSync(join(data, "bots.json"), "utf8")) as any[])
      .find((bot: any) => bot.id === botId)?.tasks.find((task: any) => task.threadId === threadId);
  const editSavedBot = (botId: string, edit: (bot: any) => void) => {
    const bots = JSON.parse(readFileSync(join(data, "bots.json"), "utf8")) as any[];
    edit(bots.find((bot: any) => bot.id === botId));
    writeFileSync(join(data, "bots.json"), JSON.stringify(bots, null, 2));
  };
  const send = (botId: string, threadId: string, text: string) =>
    apiOk("POST", `/api/bots/${botId}/messages`, { text, threadId });

  async function start() {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    output = "";
    const proc = spawn(process.execPath, [join(ROOT, "server/index.ts")], {
      cwd: ROOT, env: {
        PATH: dirname(process.execPath), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home, USERPROFILE: home, MADANI_DATA_DIR: data,
        APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"),
        TEMP: home, TMP: home, TMPDIR: home, MADANI_TEST_SEALED_PATH: "1",
        MADANI_PORT: String(port), MADANI_WEBHOOK_PORT: String(port + 1), MADANI_STATIC_DIR: ui,
        MADANI_USER_DATA: join(home, "user-data"),
      }, stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;
    proc.stdout!.on("data", chunk => { output += chunk; });
    proc.stderr!.on("data", chunk => { output += chunk; });
    await until(async () => {
      if (proc.exitCode !== null) throw new Error(`server exited during boot:\n${output}`);
      try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
    }, Boolean, "boot");
  }
  async function stop() {
    if (!child) return;
    const proc = child;
    child = null;
    await waitForExit(proc, { signal: "SIGTERM" });
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "madani-place-view-"));
    data = join(home, "data");
    ui = join(home, "static");
    mkdirSync(data);
    mkdirSync(join(ui, "assets"), { recursive: true });
    writeFileSync(join(ui, "index.html"), "<title>Place view</title>");
    writeFileSync(join(ui, "assets", "test.css"), "body{}");
    writeConfig();
  });
  const writeConfig = () => writeFileSync(join(data, "config.json"), JSON.stringify({
    // Every turn first takes one screenshot through the cloud computer's tools: that call, not the message, starts the cloud computer.
    instances: { claude: {
      driver: "claudeAgent", config: { cli: join(ROOT, "server/testing/fake-claude-cli.ts") },
      environment: { FAKE_CLAUDE_USES_CLOUD_COMPUTER: "1" },
    } },
  }));
  afterAll(async () => {
    await stop();
    if (home) await removeTempDir(home);
  });
  afterEach(stop);

  const NO_VPS = "The VPS computer is unavailable; connect a VPS in Settings and retry.";

  it("Works on Cloud with no VPS goes on without a computer, with no place card (6c14850881)", async () => {
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "Cloud Bot" });
    await apiOk("PATCH", `/api/bots/${bot.id}`, { computer: "cloud" });
    await send(bot.id, bot.threadId, "Open the desktop.");
    const answered = (rows: any[]) => rows.slice(rows.findIndex((row) => row.text === "Open the desktop.") + 1).some((row) => row.role === "bot" && row.kind === "text");
    await until(async () => answered(await messages(bot.threadId)), Boolean, "the turn's answer");
    await idle(bot.id);
    expect((await messages(bot.threadId)).filter((row) => row.tool?.place)).toEqual([]);
  }, 90_000);

  it("an automatic pin that fails is cleared, and the row says the conversation is back on Auto", async () => {
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "Pinned Bot" });
    await stop();
    editSavedBot(bot.id, saved => {
      Object.assign(saved.tasks.find((task: any) => task.threadId === bot.threadId), { surface: "cloud", surfaceSource: "auto" });
    });
    await start();
    await send(bot.id, bot.threadId, "Carry on on the desktop.");
    const row = await failedRow(bot.threadId);
    expect(row.tool.name).toBe(`error: ${NO_VPS} This conversation is back on auto. Send your message again.`);
    expect(row.tool.place).toEqual({ state: "place-failed", params: { bot: "Pinned Bot", cause: NO_VPS }, source: "auto-pin" });
    await idle(bot.id);
    expect(savedTask(bot.id, bot.threadId)?.surface).toBeUndefined();
    const after = (await messages(bot.threadId)).length;
    await send(bot.id, bot.threadId, "What is 2+2?");
    await until(async () => (await messages(bot.threadId)).slice(after).some(message => message.role === "bot" && message.kind === "text"), Boolean, "Auto reply");
    expect((await messages(bot.threadId)).slice(after).some(message => String(message.tool?.name ?? "").startsWith("error:"))).toBe(false);
  }, 90_000);

  it("a cloud routine with no VPS says to connect one", async () => {
    await start();
    const { bot } = await apiOk("POST", "/api/bots", { name: "Routine Bot" });
    const { routine } = await apiOk("POST", "/api/routines", { name: "Desktop check", botId: bot.id,
      prompt: "Check the cloud desktop.", runOn: "cloud", enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } });
    const { run } = await apiOk("POST", `/api/routines/${routine.id}/run`, {});
    const threadId: string = await until(async (): Promise<string> =>
      (await apiOk("GET", "/api/routines")).runs.find((entry: any) => entry.id === run.id)?.threadId ?? "", Boolean, "routine thread");
    const row = await failedRow(threadId);
    // the routine is refused before it starts, in one line that says what to do
    expect(row.tool.name).toBe("error: Connect a VPS in Settings before scheduling work on its computer.");
    expect(row.tool.name).not.toMatch(/Works on/);
  }, 90_000);
});
