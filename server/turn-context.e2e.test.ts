// The fake engine records what each turn is sent and runs scripted tool calls through the real MCP servers, so these
// prove what the server puts in front of a model and what a failed call reads like, not what a model does with it.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, runControlMadani } from "../scripts/control-madani.ts";
import type { WireBot } from "../shared/wire.ts";
import { HABIT_REMINDER } from "./habit-reminder.ts";
import { HANDOFF_BRIEF_RULE } from "./handoff-brief.ts";
import { splitLaunchNote } from "./testing/launch-note.ts";
import { NEXT_STEP_LEAD } from "./tool-next-step.ts";

const FAKE_MCP = fileURLToPath(new URL("./testing/fake-mcp-server.ts", import.meta.url));
type Fixture = Awaited<ReturnType<typeof launchVerificationServer>>;
let fixture: Fixture, scratch = "", prompts = "", toolCalls = "";

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "madani-turn-context-"));
  prompts = join(scratch, "prompts.jsonl");
  toolCalls = join(scratch, "tool-calls.json");
  // the server's own clock is India time; the person's app says New York
  fixture = await launchVerificationServer({ ...process.env, TZ: "Asia/Kolkata", FAKE_CLAUDE_PROMPTS: prompts, FAKE_CLAUDE_TOOL_CALLS_FILE: toolCalls });
}, 120_000);
afterAll(async () => {
  await fixture?.close();
  rmSync(scratch, { recursive: true, force: true });
});

const api = async <T = any>(path: string, method = "GET", body?: unknown): Promise<{ status: number; body: T }> => {
  const response = await fetch(fixture.info.url + path, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as T };
};
const control = (...args: string[]) => runControlMadani([...args, "--url", fixture.info.url]);
const sent = (): string[] => {
  try {
    return readFileSync(prompts, "utf8").trim().split("\n").filter(Boolean)
      .map((line) => splitLaunchNote(JSON.parse(line) as { message?: { content?: unknown } } | string).prompt)
      .map((prompt) => {
        const content = typeof prompt === "string" ? prompt : prompt.message?.content;
        if (typeof content === "string") return content;
        return Array.isArray(content) ? content.map((block: { text?: string }) => block.text ?? "").join("") : JSON.stringify(prompt);
      });
  } catch {
    return [];
  }
};
const promptWith = (marker: string) => sent().find((prompt) => prompt.includes(marker));
const turn = async (botId: string, threadId: string, text: string) => {
  await control("send", "--bot", botId, "--task", threadId, "--text", text);
  expect(await control("wait", "--bot", botId, "--task", threadId, "--timeout", "30")).toMatchObject({ status: "settled" });
};
const newBot = async (name: string) => {
  const made = await api<{ bot: WireBot }>("/api/bots", "POST", { name });
  expect(made.status).toBe(201);
  return made.body.bot;
};
const threadJson = async (threadId: string) => JSON.stringify((await api(`/api/threads/${encodeURIComponent(threadId)}/messages?limit=200`)).body);

it("tells time in the zone the person's app gave, with the part of the day", async () => {
  expect((await api("/api/presence/active", "POST", { source: "desktop", timeZone: "America/New_York" })).status).toBe(200);
  const bot = await newBot("Clock");
  await turn(bot.id, bot.threadId, "What should I do tonight?");
  const prompt = promptWith("What should I do tonight?");
  expect(prompt).toMatch(/^Current time when this message was sent: \w+day (morning|afternoon|evening|night), \d{4}-\d{2}-\d{2} \d{2}:\d{2} America\/New_York \(Eastern time, UTC-0[45]:00\)\./);
}, 60_000);

it("re-sends the one-line habit reminder once the chat reaches 20 messages, and not before", async () => {
  const bot = await newBot("Longchat");
  const textRows = async () => ((await api<{ messages: Array<{ role: string; kind: string }> }>(`/api/threads/${encodeURIComponent(bot.threadId)}/messages?limit=200`)).body.messages)
    .filter((row) => row.kind === "text" && (row.role === "user" || row.role === "bot")).length;
  const carried: boolean[] = [], expected: boolean[] = [];
  for (let index = 1; index <= 11; index += 1) {
    // the person's new message is the one more
    expected.push((await textRows()) + 1 >= 20);
    await turn(bot.id, bot.threadId, `Long chat message number ${index}.`);
    const prompt = promptWith(`Long chat message number ${index}.`)!;
    carried.push(prompt.split("\n")[0]!.includes(HABIT_REMINDER));
    expect(prompt.match(/Reminder: /g)?.length ?? 0).toBeLessThanOrEqual(1);
  }
  expect(carried).toEqual(expected);
  expect(carried[0]).toBe(false);
  expect(carried.at(-1)).toBe(true);
}, 180_000);

it("a failed call to the person's own MCP server reads with what to do next", async () => {
  const failure = join(scratch, "mcp-failure.txt");
  writeFileSync(failure, "HTTP 429 Too Many Requests");
  const added = await api("/api/mcp/servers", "POST", { name: "notes", command: process.execPath, args: ["--experimental-strip-types", "--no-warnings", FAKE_MCP], env: { FAKE_MCP_RESULT_FILE: failure, FAKE_MCP_IS_ERROR: "1" } });
  expect(added.status, JSON.stringify(added.body)).toBe(201);
  expect((await api("/api/mcp/servers/notes", "PATCH", { enabled: true })).status).toBe(200);
  const bot = await newBot("Recoverer");
  writeFileSync(toolCalls, JSON.stringify([{ name: "read_notes", server: "notes", input: {} }]));
  try {
    await turn(bot.id, bot.threadId, "Read my saved notes.");
  } finally {
    rmSync(toolCalls, { force: true });
  }
  const failed = JSON.parse(await threadJson(bot.threadId)).messages.find((row: { kind: string; tool?: { name: string } }) => row.kind === "activity" && row.tool?.name?.includes("read_notes"));
  expect(failed?.tool?.ok, JSON.stringify(failed)).toBe(false);
  expect(failed.tool.output).toContain("HTTP 429 Too Many Requests");
  expect(failed.tool.output).toContain(`${NEXT_STEP_LEAD}the service is limiting requests`);
}, 60_000);

it("a room member's turn is told that a hand-off brief stands alone", async () => {
  const lead = await newBot("Lead"), mate = await newBot("Mate");
  const room = (await api<{ group: { id: string; threadId: string } }>("/api/groups", "POST", {
    name: "Brief room",
    memberIds: [lead.id, mate.id],
    setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
  })).body.group;
  expect((await api(`/api/groups/${room.id}/messages`, "POST", { text: "Plan the launch email" })).status).toBe(202);
  await expect.poll(() => promptWith("Plan the launch email") !== undefined, { timeout: 20_000 }).toBe(true);
  // the rule rides the instructions: the system prompt, or the volatile half a new session's first message carries
  await expect.poll(() => {
    let dump: { systemPrompt?: unknown; prompt?: unknown };
    try { dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")); } catch { return false; }
    const seen = JSON.stringify([dump.systemPrompt, dump.prompt]);
    return seen.includes("Plan the launch email") && seen.includes(JSON.stringify(HANDOFF_BRIEF_RULE).slice(1, -1));
  }, { timeout: 20_000 }).toBe(true);
}, 90_000);
