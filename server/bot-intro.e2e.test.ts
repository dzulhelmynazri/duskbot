import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

// A bot just made writes its hello as a turn on its own engine with its full instructions, never twice; an engine that
// fails leaves the fixed hello and no failure row.

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const HELLO = "Hi, I'm Ledger. I keep your books tidy. Want me to start with last month's receipts?";
const FALLBACK = "Hi, I'm Edie. Tell me what you'd like to start with and I'll take it from there.";
const SLOW_HELLO = "Hi, I'm Pace. I take my time saying hello, word by word, so you may well get in first.";

let child: ChildProcess;
let home = "";
let base = "";
let output = "";
let dump = "";

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

const messages = async (threadId: string): Promise<Array<{ role: string; kind: string; text?: string }>> =>
  (await api("GET", `/api/threads/${threadId}/messages`)).body.messages;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "madani-bot-intro-"));
  const data = join(home, ".madanibot");
  const staticDir = join(home, "static");
  mkdirSync(data, { recursive: true });
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Bot intro test</title>");
  writeFileSync(join(staticDir, "assets", "smoke.css"), "body{}");
  dump = join(home, "dump.json");
  writeFileSync(join(data, "config.json"), JSON.stringify({
    instances: {
      intro: {
        driver: "claudeAgent", displayName: "Intro fixture", config: { cli: FAKE_CLAUDE },
        environment: { FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_DUMP: dump, FAKE_CLAUDE_TOOL_CALLS: "[]", FAKE_CLAUDE_REPLIES: JSON.stringify([HELLO, HELLO]) },
      },
      slow: {
        driver: "claudeAgent", displayName: "Slow fixture", config: { cli: FAKE_CLAUDE },
        environment: { FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_TOOL_CALLS: "[]", FAKE_CLAUDE_STREAM_CADENCE: "1:150",
          FAKE_CLAUDE_REPLIES: JSON.stringify([SLOW_HELLO]), FAKE_CLAUDE_DUMP: join(home, "slow-dump.json") },
      },
      broken: {
        driver: "claudeAgent", displayName: "Broken fixture", config: { cli: FAKE_CLAUDE },
        environment: { FAKE_CLAUDE_MODE: "exit-early", FAKE_CLAUDE_TOOL_CALLS: "[]" },
      },
    },
  }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      MADANI_PORT: String(port),
      MADANI_WEBHOOK_PORT: String(port + 1),
      MADANI_STATIC_DIR: staticDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (chunk) => (output += chunk));
  child.stderr!.on("data", (chunk) => (output += chunk));
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${output}`);
    try {
      if ((await fetch(`${base}/api/health`)).status === 200) break;
    } catch {
    }
    if (Date.now() >= deadline) throw new Error(`server never became healthy: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}, 30_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

const waitFor = async <T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 20_000): Promise<T> => {
  const deadline = Date.now() + ms;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    value = await read();
  }
  return value;
};

const idle = async (botId: string) => waitFor(
  async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((each: { id: string }) => each.id === botId)?.busy,
  (busy) => !busy, 5_000);

describe("a new bot's intro", { timeout: 60_000 }, () => {
  it("writes its hello in a turn with its instructions and template, with no line from the person, and never twice", async () => {
    const { bot } = (await api("POST", "/api/bots", {
      name: "ledger", title: "Bookkeeper", greeting: false, useDefaults: false,
      modelSelection: { instanceId: "intro", model: "claude-sonnet-5" }, requireAvailableModel: true,
    })).body;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { soul: "You keep the person's books.", memoryUpkeep: false, browser: false, computer: "off" })).status).toBe(200);
    expect(await messages(bot.threadId)).toEqual([]);

    const [first, second] = await Promise.all([
      api("POST", `/api/bots/${bot.id}/intro`, { template: "bookkeeper" }),
      api("POST", `/api/bots/${bot.id}/intro`, { template: "bookkeeper" }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 202]);
    const thread = await waitFor(() => messages(bot.threadId), (rows) => rows.some((message) => message.role === "bot" && message.text === HELLO));
    expect(thread.filter((message) => message.role === "user")).toEqual([]);
    expect(thread.filter((message) => message.role === "bot" && message.kind === "text").map((message) => message.text)).toEqual([HELLO]);

    expect(existsSync(dump)).toBe(true);
    const sent = JSON.parse(readFileSync(dump, "utf8")) as { prompt: unknown; systemPrompt: string };
    const prompt = JSON.stringify(sent.prompt);
    expect(prompt).toContain("You were just created");
    expect(prompt).toContain("Your name, as you write it: Ledger.");
    expect(prompt).toContain("ready-made bot");
    expect(sent.systemPrompt).toContain("You keep the person's books.");

    await idle(bot.id);
    expect((await api("POST", `/api/bots/${bot.id}/intro`)).body).toEqual({ skipped: true });
    expect((await messages(bot.threadId)).filter((message) => message.role === "bot" && message.kind === "text")).toHaveLength(1);
  });

  it("says the fixed hello, and nothing broken, when its engine fails", async () => {
    const { bot } = (await api("POST", "/api/bots", {
      name: "edie", title: "Writer", greeting: false, useDefaults: false,
      modelSelection: { instanceId: "broken", model: "claude-sonnet-5" },
    })).body;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { memoryUpkeep: false, browser: false, computer: "off" })).status).toBe(200);
    const started = await api("POST", `/api/bots/${bot.id}/intro`);
    expect([201, 202]).toContain(started.status);
    const thread = await waitFor(() => messages(bot.threadId), (rows) => rows.some((message) => message.role === "bot" && message.kind === "text"));
    await idle(bot.id);
    const settled = await messages(bot.threadId);
    expect(thread.length).toBeGreaterThan(0);
    // the turn's work receipt (kind digest) is a record the chat does not draw
    expect(settled.filter((message) => message.role === "bot" && message.kind !== "digest").map((message) => message.text)).toEqual([FALLBACK]);
  });

  it("answers the person's first message instead of greeting, when they write before the greeting lands", async () => {
    const { bot } = (await api("POST", "/api/bots", {
      name: "pace", title: "Namer", greeting: false, useDefaults: false,
      modelSelection: { instanceId: "slow", model: "claude-sonnet-5" },
    })).body;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { memoryUpkeep: false, browser: false, computer: "off" })).status).toBe(200);
    expect((await api("POST", `/api/bots/${bot.id}/intro`)).status).toBe(202);
    await waitFor(() => api("GET", "/api/bots?messages=0"), (state) => state.body.bots.find((one: { id: string }) => one.id === bot.id)?.busy === true);
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "name my bakery" })).status).toBeLessThan(300);
    await waitFor(() => messages(bot.threadId), (rows) => rows.some((message) => message.role === "bot" && message.kind === "text"), 40_000);
    await idle(bot.id);
    const said = (await messages(bot.threadId)).filter((message) => message.kind === "text").map((message) => message.role);
    expect(said, "one reply, to the person's message, and no greeting before it").toEqual(["user", "bot"]);
    expect(JSON.stringify(JSON.parse(readFileSync(join(home, "slow-dump.json"), "utf8")).prompt)).toContain("name my bakery");
  }, 60_000);

  it("knows no bot it cannot find", async () => {
    expect((await api("POST", "/api/bots/nope/intro")).status).toBe(404);
  });
});
