#!/usr/bin/env node
// Runs a fixed set of everyday bot requests against a live server's test bots, one after another, and records how
// each turn went from the engine's native log: time to first activity and first text, tool calls, how many ran at
// once, wall time, and the reply. Run it on the server, as the user it runs as:
//   node scripts/live-scenarios.mjs --label before --out /tmp/madani-scenarios [--only s1,s2] [--bot Cinder]
// Read-only on the person's Mac except for writes into ~/Downloads/<bot>/.
// Two probes time one thing each over the server's loopback api and its event stream, `--runs` times:
//   --probe msg --bot Nova     a one-word reply in the bot's main chat: send accepted, the message on the stream, the
//                              first reply text on the stream, the turn's end, and the engine's own startup phases
//   --probe wake --bot Cinder  puts the bot's computer to sleep, then wakes it and takes two screenshots
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : fallback; };
const label = opt("label", "run");
const outDir = opt("out", "/tmp/madani-scenarios");
const only = opt("only", "")?.split(",").filter(Boolean) ?? [];
const botOverride = opt("bot", "");
const dataDir = opt("data", join(homedir(), ".madanibot"));
const cli = opt("cli", "madanibot");
const base = opt("url", "http://127.0.0.1:8799");
const probe = opt("probe", "");
const runs = Number(opt("runs", "3"));
const LOOPBACK = { "x-madani-cli": "1" };

export const SCENARIOS = [
  { id: "s1-research", bot: "Atlas", text: "Quick research: what are the current stable versions of Node.js, Bun and Deno, and when was each released? Search the web for all three, then answer in three short lines with a source link each." },
  { id: "s2-title", bot: "Cinder", text: "Open madani.bot in your computer and give me the page title." },
  { id: "s3-tabs", bot: "Bolt", text: "Open 3 tabs in your computer's browser: news.ycombinator.com, github.com/trending and x.com. Summarise each in one line." },
  { id: "s4-app", bot: "Moss", text: "Launch an app on your computer (a text editor is fine) and tell me once it is open." },
  { id: "s5-download", bot: "Basil", text: "Download https://example.com/ to my Mac's Downloads folder and tell me the saved path." },
  { id: "s6-uname", bot: "Harness", text: "Run `uname -a` on my Mac and tell me the output." },
  { id: "s7-ip", bot: "Atlas", text: "What's my public IP from your computer? Check it in your computer's browser (for example api.ipify.org) and tell me the address." },
];

function run(command, argv, timeoutMs) {
  return new Promise((resolve) => {
    execFile(command, argv, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
}

/** Per-turn numbers from a Codex app-server native log, for everything logged at or after `since`. */
export function analyzeNative(lines, since) {
  const events = [];
  for (const line of lines) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    const at = Date.parse(row.at ?? "");
    if (!Number.isFinite(at) || at < since) continue;
    events.push({ at, dir: row.dir, msg: row.msg ?? {} });
  }
  const turns = [];
  let turn = null;
  const open = new Map();
  for (const { at, dir, msg } of events) {
    const method = msg.method;
    if (dir === "out" && method === "initialize") { turn = { spawnAt: at, startAt: null, endAt: null, firstItemAt: null, firstTextAt: null, tools: [], texts: [], mcpReadyAt: null, errors: [] }; turns.push(turn); continue; }
    if (!turn) continue;
    if (method === "mcpServer/startupStatus/updated" && msg.params?.status !== "starting") turn.mcpReadyAt = at;
    if (method === "mcpServer/startupStatus/updated" && msg.params?.status === "failed") turn.errors.push(`mcp ${msg.params.name} failed: ${msg.params.error ?? ""}`);
    if (dir === "out" && method === "turn/start") turn.startAt = at;
    if (method === "turn/completed") turn.endAt = at;
    if (method === "error" || method === "turn/failed") turn.errors.push(JSON.stringify(msg.params ?? {}).slice(0, 300));
    if (method === "item/started" || method === "item/completed") {
      const item = msg.params?.item ?? {};
      if (item.type === "userMessage") continue;
      if (method === "item/started" && turn.firstItemAt === null && item.type !== "reasoning") turn.firstItemAt = at;
      if (item.type === "agentMessage") {
        if (method === "item/started" && turn.firstTextAt === null) turn.firstTextAt = at;
        if (method === "item/completed") turn.texts.push(String(item.text ?? ""));
        continue;
      }
      if (item.type === "reasoning") continue;
      if (method === "item/started") { open.set(item.id, { at, item }); continue; }
      const started = open.get(item.id);
      open.delete(item.id);
      const start = item.startedAtMs ?? started?.at ?? at;
      const end = item.completedAtMs ?? at;
      const name = item.type === "mcpToolCall" ? `${item.server}.${item.tool}` : item.type === "webSearch" ? "web_search" : item.type === "commandExecution" ? "shell" : item.type;
      const error = item.error ? (typeof item.error === "string" ? item.error : item.error.message ?? JSON.stringify(item.error)) : item.result?.isError ? JSON.stringify(item.result.content ?? "").slice(0, 200) : "";
      turn.tools.push({ name, start, end, ms: end - start, ...(error ? { error: String(error).slice(0, 300) } : {}) });
    }
  }
  const maxConcurrent = (tools) => {
    const edges = tools.flatMap((tool) => [[tool.start, 1], [Math.max(tool.end, tool.start + 1), -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let now = 0, best = 0;
    for (const [, step] of edges) { now += step; best = Math.max(best, now); }
    return best;
  };
  return turns.map((one) => ({
    spawnToStartMs: one.startAt && one.spawnAt ? one.startAt - one.spawnAt : null,
    startToFirstItemMs: one.startAt && one.firstItemAt ? one.firstItemAt - one.startAt : null,
    startToFirstTextMs: one.startAt && one.firstTextAt ? one.firstTextAt - one.startAt : null,
    turnMs: one.startAt && one.endAt ? one.endAt - one.startAt : null,
    toolCount: one.tools.length,
    maxConcurrent: maxConcurrent(one.tools),
    toolMs: one.tools.reduce((sum, tool) => sum + tool.ms, 0),
    tools: one.tools.map((tool) => `${tool.name}:${tool.ms}${tool.error ? `!${tool.error}` : ""}`),
    textBubbles: one.texts.filter((text) => text.trim()).length,
    errors: one.errors,
    spawnAt: one.spawnAt,
    startAt: one.startAt,
    firstItemAt: one.firstItemAt,
    firstTextAt: one.firstTextAt,
  }));
}

/** The same numbers from a Claude Code native log: each turn starts where a person's message goes in. `cold` turns
 * started a new engine (its SessionStart hook ran) and `closes` lists why warm engines were closed. */
export function analyzeClaude(lines, since) {
  const turns = [];
  let turn = null;
  const open = new Map();
  for (const line of lines) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    const at = Date.parse(row.at ?? "");
    if (!Number.isFinite(at) || at < since) continue;
    const msg = row.msg ?? {};
    if (row.source === "claude.session" && msg.close) { (turn ?? { closes: [] }).closes?.push(msg.close); continue; }
    if (row.source !== "claude.sdk.message") continue;
    const content = Array.isArray(msg.message?.content) ? msg.message.content : [];
    if (row.dir === "out" && msg.type === "user" && !content.some((part) => part.type === "tool_result")) {
      turn = { startAt: at, cold: false, initAt: null, firstTokenAt: null, firstTextAt: null, endAt: null, tools: [], closes: [] };
      turns.push(turn);
      continue;
    }
    if (!turn) continue;
    if (msg.type === "system" && msg.subtype === "hook_started" && msg.hook_event === "SessionStart") turn.cold = true;
    if (msg.type === "system" && msg.subtype === "init") turn.initAt ??= at;
    if (msg.type === "stream_event" && msg.event?.type === "message_start") turn.firstTokenAt ??= at;
    for (const part of content) {
      if (msg.type === "assistant" && part.type === "text" && String(part.text ?? "").trim()) turn.firstTextAt ??= at;
      if (msg.type === "assistant" && part.type === "tool_use") open.set(part.id, { at, name: part.name });
      if (msg.type === "user" && part.type === "tool_result" && open.has(part.tool_use_id)) {
        const started = open.get(part.tool_use_id);
        open.delete(part.tool_use_id);
        turn.tools.push({ name: started.name, start: started.at, end: at, ms: at - started.at, ...(part.is_error ? { error: "error" } : {}) });
      }
    }
    if (msg.type === "result") turn.endAt ??= at;
  }
  return turns.map((one) => ({
    cold: one.cold, closes: one.closes,
    startToInitMs: one.initAt ? one.initAt - one.startAt : null,
    startToFirstTokenMs: one.firstTokenAt ? one.firstTokenAt - one.startAt : null,
    startToFirstTextMs: one.firstTextAt ? one.firstTextAt - one.startAt : null,
    turnMs: one.endAt ? one.endAt - one.startAt : null,
    toolCount: one.tools.length,
    toolSearches: one.tools.filter((tool) => tool.name === "ToolSearch").length,
    tools: one.tools.map((tool) => `${tool.name}:${tool.ms}${tool.error ? "!" : ""}`),
    startAt: one.startAt,
  }));
}

/** Codex or Claude, whichever wrote the thread's native log since `sentAt`. */
function nativeTurns(threadId, sentAt) {
  const file = threadId ? join(dataDir, "native", `${threadId}.ndjson`) : "";
  if (!file || !existsSync(file)) return { engine: null, turns: [] };
  const lines = readFileSync(file, "utf8").split("\n");
  const codex = analyzeNative(lines, sentAt);
  return codex.length ? { engine: "codex", turns: codex } : { engine: "claude", turns: analyzeClaude(lines, sentAt) };
}

async function scenario(item) {
  const bot = botOverride || item.bot;
  const sentAt = Date.now();
  const title = `speed ${label} ${item.id}`;
  const res = await run(cli, ["run", bot, item.text, "--title", title, "--wait", "job", "--timeout", "6m", "--on-input", "exit", "--json", "--quiet"], 7 * 60_000);
  const doneAt = Date.now();
  let result = {};
  try { result = JSON.parse(res.stdout); } catch { result = { ok: false, error: (res.stdout || res.stderr || String(res.error)).slice(0, 500) }; }
  const threadId = result.threadId;
  const { engine, turns } = nativeTurns(threadId, sentAt);
  const firstTurn = turns[0];
  const allTools = turns.flatMap((one) => one.tools);
  return {
    id: item.id, label, bot, engine, threadId, state: result.state ?? (result.ok ? "completed" : "failed"), exitCode: result.exitCode,
    wallMs: doneAt - sentAt,
    sendToSpawnMs: firstTurn?.spawnAt ? firstTurn.spawnAt - sentAt : null,
    sendToFirstItemMs: firstTurn?.firstItemAt ? firstTurn.firstItemAt - sentAt : firstTurn?.startToFirstTextMs != null ? firstTurn.startAt + firstTurn.startToFirstTextMs - sentAt : null,
    sendToFirstTextMs: turns.find((one) => one.firstTextAt)?.firstTextAt ? turns.find((one) => one.firstTextAt).firstTextAt - sentAt : null,
    nativeTurns: turns.length,
    toolCount: allTools.length,
    maxConcurrent: Math.max(0, ...turns.map((one) => one.maxConcurrent)),
    toolErrors: allTools.filter((tool) => tool.includes("!")).length,
    turns: turns.map(({ spawnAt: _spawnAt, startAt: _startAt, firstItemAt: _firstItemAt, firstTextAt: _firstTextAt, ...rest }) => rest),
    reply: String(result.reply?.text ?? result.reply ?? "").slice(0, 1200),
    error: result.error ?? result.reason ?? null,
  };
}

/** the server's event stream on loopback: `frames` collects every frame with the time it arrived */
async function eventStream(signal) {
  const frames = [];
  const response = await fetch(`${base}/api/events?screens=off`, { headers: LOOPBACK, signal });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        const at = Date.now();
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = block.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
          if (data) try { frames.push({ at, frame: JSON.parse(data) }); } catch { }
        }
      }
    } catch { }
  })();
  return frames;
}

const api = async (method, path, body) => {
  const started = Date.now();
  const response = await fetch(`${base}${path}`, { method, headers: { ...LOOPBACK, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  let json = null; try { json = JSON.parse(text); } catch { }
  return { status: response.status, json, ms: Date.now() - started };
};

async function botNamed(name) {
  const { json } = await api("GET", "/api/bots?messages=0");
  const bot = json?.bots?.find((one) => one.name === name);
  if (!bot) throw new Error(`no bot named ${name}`);
  if (/^(Madani|Pixel)$/.test(bot.name)) throw new Error("probes run on test bots only");
  return bot;
}

const replyText = (frame, threadId) => (frame.kind === "message" || frame.kind === "message.patch") && frame.threadId === threadId &&
  frame.message?.role === "bot" && frame.message?.kind === "text" && String(frame.message.text ?? "").trim();

async function probeMessage(bot, index) {
  for (let waited = 0; (await botNamed(bot.name)).busy && waited < 60; waited += 1) await new Promise((resolve) => setTimeout(resolve, 1000));
  const stop = new AbortController();
  const frames = await eventStream(stop.signal);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const threadId = bot.threadId;
  const sentAt = Date.now();
  const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text: `Reply with just the word ok. (speed probe ${index})`, threadId });
  const deadline = Date.now() + 120_000;
  const find = (test, after = sentAt) => frames.find(({ at, frame }) => at >= after && test(frame));
  const marker = `(speed probe ${index})`;
  let user, reply, done;
  while (Date.now() < deadline && !done) {
    user ??= find((frame) => frame.kind === "message" && frame.threadId === threadId && frame.message?.role === "user" && String(frame.message.text ?? "").includes(marker));
    if (user) reply ??= find((frame) => replyText(frame, threadId), user.at);
    if (reply) done = find((frame) => frame.kind === "bot" && frame.bot?.id === bot.id && frame.bot.busy === false, reply.at);
    if (!done) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  stop.abort();
  const { engine, turns } = nativeTurns(threadId, sentAt);
  const native = turns[0];
  return {
    probe: "msg", label, bot: bot.name, engine: bot.modelSelection?.instanceId ?? null, status: sent.status, postMs: sent.ms,
    userOnStreamMs: user ? user.at - sentAt : null, firstReplyOnStreamMs: reply ? reply.at - sentAt : null, doneMs: done ? done.at - sentAt : null,
    native: engine === "claude" && native ? { engineStartMs: native.startAt - sentAt, cold: native.cold, closes: native.closes, toInitMs: native.startToInitMs, toFirstTokenMs: native.startToFirstTokenMs }
      : native ? { spawnMs: native.spawnAt - sentAt, spawnToTurnStartMs: native.spawnToStartMs, turnStartToTextMs: native.startToFirstTextMs } : null,
  };
}

async function probeWake(bot) {
  const path = `/api/bots/${bot.id}/computer`;
  const slept = await api("POST", `${path}/sleep`, {});
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const woke = await api("POST", `${path}/provision`, {});
  const first = await api("POST", `${path}/screenshot`, {});
  const second = await api("POST", `${path}/screenshot`, {});
  return { probe: "wake", label, bot: bot.name, sleepStatus: slept.status, wakeStatus: woke.status, ready: woke.json?.ready ?? null, problem: woke.json?.problem ?? null,
    wakeMs: woke.ms, firstScreenshotMs: first.ms, secondScreenshotMs: second.ms, wakeToFirstScreenMs: woke.ms + first.ms };
}

async function runProbe() {
  mkdirSync(outDir, { recursive: true });
  const bot = await botNamed(botOverride || (probe === "wake" ? "Cinder" : "Nova"));
  for (let index = 0; index < runs; index += 1) {
    const record = probe === "wake" ? await probeWake(bot) : await probeMessage(bot, index);
    appendFileSync(join(outDir, `${label}-${probe}.jsonl`), JSON.stringify(record) + "\n");
    console.log(JSON.stringify(record));
  }
}

async function main() {
  if (probe) return runProbe();
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${label}.jsonl`);
  for (const item of SCENARIOS.filter((one) => !only.length || only.includes(one.id) || only.includes(one.id.split("-")[0]))) {
    const record = await scenario(item);
    appendFileSync(file, JSON.stringify(record) + "\n");
    console.log(`${record.id} ${record.state} wall=${record.wallMs} firstItem=${record.sendToFirstItemMs} tools=${record.toolCount} max||=${record.maxConcurrent} turns=${record.nativeTurns}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
