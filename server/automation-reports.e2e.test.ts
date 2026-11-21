// Automations in the bot's chat, end to end: the real server and Claude driver, the scripted fake engine
// answering each turn by what it was sent, and the permission broker reached the way the CLI's proxy reaches it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { launchVerificationServer, runControlMadani, type VerificationServer } from "../scripts/control-madani.ts";
import { AUTOMATION_REPLY_PROMPT } from "./system-prompt.ts";
import { launchRestartableServer } from "./testing/restartable-server.ts";
import { openSse, type SseRecorder } from "./testing/sse.ts";

let fixture: VerificationServer | undefined;
let events: SseRecorder | undefined;
let broker: Socket | undefined;
afterEach(async () => {
  broker?.destroy();
  events?.close();
  if (fixture) {
    console.info(JSON.stringify({ logPath: fixture.info.logPath }));
    await fixture.close();
  }
  fixture = events = broker = undefined;
});

type ScriptEntry = {
  key: string; match: string[]; reply: string; repeat?: boolean; gateFile?: string; expectContextIncludes?: string[]; fail?: boolean;
  steps?: Array<{ tool: string; arguments: Record<string, unknown> }>;
};

async function server(env: NodeJS.ProcessEnv = {}) {
  fixture = await launchVerificationServer({ ...process.env, ...env }, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir } = fixture.info;
  const api = async (method: string, path: string, body?: unknown, status?: number) => {
    const response = await fetch(`${url}${path}`, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    if (status === undefined) expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBeLessThan(300);
    else expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    return value;
  };
  const cli = (...args: string[]) => runControlMadani([...args, "--url", url]) as Promise<any>;
  const { bot } = await cli("new-bot", "--name", "Pepper");
  const main = bot.activeTaskId as string;
  const planPath = join(dataDir, "room-plan.json");
  const script = (entries: ScriptEntry[], others: Record<string, ScriptEntry[]> = {}) => writeFileSync(planPath, JSON.stringify(
    Object.fromEntries(Object.entries({ [bot.id]: entries, ...others }).map(([id, each]) => [id, { script: each }]))));
  events = await openSse(`${url}/api/events`, { origin: url });
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages as any[];
  const lines = async (threadId = main) => (await messages(threadId)).filter((message) => message.automation);
  const runs = async () => (await api("GET", "/api/routines")).runs as any[];
  const run = async (id: string) => (await runs()).find((candidate) => candidate.id === id);
  const routine = async (name: string) => (await api("POST", "/api/routines", {
    name, prompt: `Do the ${name} check.`, botId: bot.id, enabled: false,
    schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
  }, 201)).routine.id as string;
  const runNow = async (routineId: string) => (await api("POST", `/api/routines/${routineId}/run`, undefined, 201)).run.id as string;
  const settled = (id: string, status = "completed") => expect.poll(async () => (await run(id))?.status, { timeout: 30_000 }).toBe(status);
  const reported = (id: string, state: string) => expect.poll(async () => (await run(id))?.report?.state, { timeout: 30_000 }).toBe(state);
  const savedBot = async () => (await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === bot.id);
  const notified = () => events!.frames.filter((frame) => frame.kind === "notify").map((frame) => frame.notification as { kind: string; threadId: string; body: string });
  const header = (name: string) => `Routine ${JSON.stringify(name)}, do this now:`;
  /** Whether the turn the script answered with `key` was told that only its last reply leaves the run. */
  const toldOnlyReplyLeaves = (key: string) => {
    const turns = readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { planKey?: string; system?: string; prompt?: unknown });
    const turn = turns.find((candidate) => candidate.planKey === key);
    expect(turn, `no turn answered with ${key}`).toBeTruthy();
    return `${turn!.system}\n${JSON.stringify(turn!.prompt)}`.includes(AUTOMATION_REPLY_PROMPT.trim());
  };
  return { url, dataDir, api, cli, bot, main, script, messages, lines, runs, run, routine, runNow, settled, reported, savedBot, notified, header, toldOnlyReplyLeaves };
}

/** The run's permission broker, reached the way the CLI's proxy reaches it; what it answers lands in the returned list. */
async function brokerOf(s: Awaited<ReturnType<typeof server>>, threadId: string): Promise<any[]> {
  const dump = join(s.dataDir, "fake-claude-dump.json");
  await expect.poll(() => {
    try { return JSON.parse(readFileSync(dump, "utf8")).mcpConfig?.mcpServers?.agents?.env?.MADANI_THREAD_ID === threadId; } catch { return false; }
  }, { timeout: 20_000 }).toBe(true);
  const socketPath = JSON.parse(readFileSync(dump, "utf8")).mcpConfig.mcpServers.madani.args.at(-1);
  const socket = broker = connect(socketPath);
  socket.on("error", () => {});
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  const answers: any[] = [];
  let buffered = "";
  socket.on("data", (chunk) => {
    buffered += chunk.toString();
    for (let at = buffered.indexOf("\n"); at >= 0; at = buffered.indexOf("\n")) {
      answers.push(JSON.parse(buffered.slice(0, at)));
      buffered = buffered.slice(at + 1);
    }
  });
  return answers;
}

it("answers each run in the main chat as the bot's own reply, with no conversation, line or card of its own", async () => {
  const s = await server();
  s.script([{ key: "run", match: [s.header("Inbox watch")], reply: "Acme replied: they need the invoice by Friday." }]);
  const id = await s.runNow(await s.routine("Inbox watch"));
  await s.settled(id);
  expect(await s.run(id)).toMatchObject({ threadId: s.main, resultsThreadId: s.main });
  expect((await s.run(id)).report).toBeUndefined();
  const transcript = await s.messages(s.main);
  expect(transcript.findLast((message) => message.role === "bot" && message.kind === "text")).toMatchObject({ text: "Acme replied: they need the invoice by Friday." });
  expect(transcript.find((message) => message.routineStart)).toMatchObject({ role: "user", routineStart: { name: "Inbox watch" } });
  expect(transcript.some((message) => message.automation || message.kind === "routine.run")).toBe(false);
  expect(s.toldOnlyReplyLeaves("run")).toBe(false);
  const saved = await s.savedBot();
  expect(saved.tasks.map((task: any) => task.threadId)).toEqual([s.main]);
  expect(saved.tasks[0].routineRunId).toBeUndefined();
}, 120_000);

it("waits for the person's own turn in the main chat, never interrupts it, and answers right after", async () => {
  const s = await server();
  const gate = join(s.dataDir, "finish-person-turn");
  s.script([
    { key: "person", match: ["Draft the weekly update."], reply: "Here is the weekly update draft.", gateFile: gate },
    { key: "run", match: [s.header("Inbox watch")], reply: "Acme replied." },
  ]);
  const routineId = await s.routine("Inbox watch");
  await s.cli("send", "--bot", s.bot.id, "--task", s.main, "--text", "Draft the weekly update.");
  await expect.poll(async () => (await s.savedBot()).tasks.find((task: any) => task.threadId === s.main)?.busy, { timeout: 20_000 }).toBe(true);
  const id = await s.runNow(routineId);
  await expect.poll(async () => (await s.run(id))?.attention, { timeout: 20_000 }).toMatch(/^Waiting to start/);
  expect(await s.run(id)).toMatchObject({ status: "queued", threadId: s.main });
  expect((await s.savedBot()).tasks.find((task: any) => task.threadId === s.main)?.busy).toBe(true);
  writeFileSync(gate, "done");
  await s.settled(id);
  await s.cli("wait", "--bot", s.bot.id, "--task", s.main, "--timeout", "20");
  expect((await s.messages(s.main)).filter((message) => message.role === "bot" && message.kind === "text").map((message) => message.text).slice(-2)).toEqual(["Here is the weekly update draft.", "Acme replied."]);
  expect((await s.savedBot()).tasks).toHaveLength(1);
}, 120_000);

it("asks a run's question in the main chat, and the answer given there carries the run on", async () => {
  const s = await server();
  const gate = join(s.dataDir, "finish-run");
  s.script([{ key: "run", match: [s.header("Inbox watch")], reply: "Used the Work account: two new orders.", gateFile: gate }]);
  const id = await s.runNow(await s.routine("Inbox watch"));
  await s.settled(id, "running");
  const answers = await brokerOf(s, s.main);
  broker!.write(JSON.stringify({ t: "ask", kind: "question", id: "which-account", tool: "ask_user", input: { question: "Which account should I check?" } }) + "\n");
  await s.settled(id, "waiting");
  await expect.poll(async () => (await s.messages(s.main)).find((message) => message.kind === "options")?.card?.requestId, { timeout: 20_000 }).toBeTruthy();
  const cards = (await s.messages(s.main)).filter((message) => message.kind === "options");
  expect(cards).toHaveLength(1);
  expect(cards[0].automation).toBeUndefined();
  await s.api("POST", `/api/threads/${s.main}/respond`, { requestId: cards[0].card.requestId, behavior: "answer", message: "Work" });
  await expect.poll(() => answers.find((answer) => answer.id === "which-account"), { timeout: 20_000 }).toMatchObject({ t: "answer", behavior: "answer", message: "Work", source: "user" });
  writeFileSync(gate, "done");
  await s.settled(id);
  expect((await s.messages(s.main)).filter((message) => message.role === "bot" && message.kind === "text").map((message) => message.text).at(-1)).toBe("Used the Work account: two new orders.");
  expect((await s.messages(s.main)).some((message) => message.automation)).toBe(false);
}, 120_000);

it("reports an outside event's run into the main chat too, from a conversation of its own that stays out of the way", async () => {
  const s = await server();
  s.script([{ key: "lead", match: ["Draft a follow-up"], reply: "Drafted a follow-up for Ada.", repeat: true }]);
  const { webhook, credential } = await s.api("POST", "/api/webhooks", { name: "Sales form leads", prompt: "Draft a follow-up for the lead.", botId: s.bot.id }, 201);
  const response = await fetch(credential.url, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "lead-1" }, body: JSON.stringify({ lead: "Ada" }) });
  expect(response.status).toBe(202);
  const { runId } = await response.json() as any;
  await s.settled(runId);
  await s.reported(runId, "posted");
  const done = await s.run(runId);
  expect(done).toMatchObject({ webhookId: webhook.id, resultsThreadId: s.main, triggerSource: "webhook" });
  expect(await s.lines()).toEqual([expect.objectContaining({ text: "Drafted a follow-up for Ada.", automation: expect.objectContaining({ trigger: "webhook", name: "Sales form leads" }) })]);
  expect(s.toldOnlyReplyLeaves("lead")).toBe(true);
  const saved = await s.savedBot();
  expect(saved.threadId).toBe(s.main);
  expect(saved.tasks.find((task: any) => task.threadId === done.threadId)).toMatchObject({ routineRunId: runId });
  expect(existsSync(join(s.dataDir, "room-plan.json"))).toBe(true);
}, 120_000);

it("still reports the person's own failed turn in a chat a run once continued", async () => {
  const s = await server();
  s.script([
    { key: "continue", match: [s.header("Finish the report")], reply: "Picked up where I stopped: the report is done." },
    { key: "person", match: ["Plan the launch."], reply: "never", fail: true },
  ]);
  const { routine } = await s.api("POST", "/api/routines", {
    name: "Finish the report", prompt: "Do the Finish the report check.", botId: s.bot.id, schedule: { type: "limit_reset", engine: "claude" },
  }, 201);
  const id = await s.runNow(routine.id);
  await s.settled(id);
  expect(await s.run(id)).toMatchObject({ threadId: s.main });
  expect(await s.lines()).toEqual([]);
  expect(s.toldOnlyReplyLeaves("continue")).toBe(false);
  await s.cli("send", "--bot", s.bot.id, "--task", s.main, "--text", "Plan the launch.");
  await s.cli("wait", "--bot", s.bot.id, "--task", s.main, "--timeout", "20");
  // The failure is told to the person.
  const filed = () => s.notified().some((notification) => notification.kind === "incident" && notification.threadId === s.main);
  await expect.poll(filed, { timeout: 20_000 }).toBe(true);
}, 120_000);

it("does not take a person's failed turn in the main chat for the run's own while the run waits on a teammate", async () => {
  const s = await server();
  const { bot: sam } = await s.cli("new-bot", "--name", "Sam");
  const samGate = join(s.dataDir, "sam-counts");
  s.script([
    { key: "run", match: [s.header("Stock check")], steps: [{ tool: "coordinate_bots", arguments: { bot_ids: [sam.id], message: "Count the boxes in stock." } }], reply: "Asked Sam to count the stock." },
    { key: "person", match: ["Any news?"], reply: "never", fail: true },
    { key: "resume", match: ["42 boxes"], reply: "We have 42 boxes in stock." },
  ], { [sam.id]: [{ key: "count", match: ["Count the boxes in stock."], reply: "Counted 42 boxes.", gateFile: samGate }] });
  const id = await s.runNow(await s.routine("Stock check"));
  await s.settled(id, "waiting");
  expect((await s.run(id)).threadId).toBe(s.main);
  await s.cli("send", "--bot", s.bot.id, "--task", s.main, "--text", "Any news?");
  await s.cli("wait", "--bot", s.bot.id, "--task", s.main, "--timeout", "20");
  await expect.poll(async () => (await s.messages(s.main)).some((message) => message.kind === "activity" && message.tool?.ok === false), { timeout: 20_000 }).toBe(true);
  expect(await s.run(id)).toMatchObject({ status: "waiting" });
  expect((await s.run(id)).error).toBeUndefined();
  writeFileSync(samGate, "done");
  await s.settled(id);
  await expect.poll(async () => (await s.messages(s.main)).filter((message) => message.role === "bot" && message.kind === "text").map((message) => message.text).at(-1), { timeout: 20_000 }).toBe("We have 42 boxes in stock.");
  expect(await s.lines()).toEqual([]);
}, 120_000);

it("fails a run in the main chat as any failed turn there, with no line of its own", async () => {
  const s = await server();
  s.script([{ key: "run", match: [s.header("Inbox watch")], reply: "never", fail: true, repeat: true }]);
  const id = await s.runNow(await s.routine("Inbox watch"));
  await s.settled(id, "failed");
  expect(await s.run(id)).toMatchObject({ threadId: s.main });
  expect(await s.lines()).toEqual([]);
  expect((await s.savedBot()).tasks).toHaveLength(1);
}, 120_000);

it("tells the main chat about a run missed while the computer was off, which has no conversation of its own", async () => {
  const restartable = await launchRestartableServer({ scripted: true });
  const api = async (method: string, path: string, body?: unknown) => (await fetch(`${restartable.url}${path}`, {
    method, headers: { "content-type": "application/json", origin: restartable.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })).json() as Promise<any>;
  try {
    const { bot } = await runControlMadani(["new-bot", "--name", "Pepper", "--url", restartable.url]) as any;
    const main = bot.activeTaskId as string;
    const { routine } = await api("POST", "/api/routines", {
      name: "Inbox watch", prompt: "Do the Inbox watch check.", botId: bot.id,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
    });
    await restartable.stop();
    const file = join(restartable.dataDir, "routines.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    saved.routines.find((each: any) => each.id === routine.id).nextRunAt = Date.now() - 13 * 3_600_000;
    writeFileSync(file, JSON.stringify(saved));
    await restartable.start();
    await expect.poll(async () => (await api("GET", "/api/routines")).runs.map((run: any) => run.status), { timeout: 30_000 }).toEqual(["missed"]);
    const missed = (await api("GET", "/api/routines")).runs[0];
    expect(missed).toMatchObject({ resultsThreadId: main });
    expect(missed.threadId).toBeUndefined();
    await expect.poll(async () => (await api("GET", `/api/threads/${main}/messages?limit=200`)).messages
      .filter((message: any) => message.routineRun?.runId === missed.id).map((message: any) => message.routineRun.status), { timeout: 10_000 }).toEqual(["missed"]);
    const task = (await api("GET", "/api/bots")).bots.find((each: any) => each.id === bot.id).tasks.find((each: any) => each.threadId === main);
    expect(task.unread).toBe(true);
  } finally {
    await restartable.close();
  }
}, 120_000);
