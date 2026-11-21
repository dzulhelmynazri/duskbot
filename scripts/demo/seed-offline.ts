// Phase two of the seed, run while the demo harness is stopped and only with MADANI_DATA_DIR set to the demo folder:
// replaces each imported conversation's text-only rows with the full ones (tool calls, reactions, cards, shared files,
// a work summary) through the server's own message store, marks the unread chats and adds past routine runs.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const expected = process.env.MADANI_DEMO_EXPECTED_DIR;
if (!expected || !process.env.MADANI_DATA_DIR || resolve(process.env.MADANI_DATA_DIR) !== resolve(expected)) {
  throw new Error("seed-offline runs only from scripts/demo/demo.mjs, against the demo data folder");
}

const { DATA_DIR } = await import("../../server/config.ts");
const mdb = await import("../../server/message-db.ts");
const { BOTS, D, PAST_RUNS, threads } = await import("./content.mjs");
const { buildThread } = await import("./transcripts.mjs");

if (resolve(DATA_DIR) !== resolve(expected)) throw new Error("the server's data folder is not the demo folder");

interface SeedState {
  now: number;
  bots: Record<string, { id: string; threads: Record<string, string> }>;
  routines: Record<string, { id: string; botId: string }>;
}
interface StoredTask { threadId: string; unread?: boolean; lastReadMessageId?: string; updatedAt?: number; lastThreadOrderAt?: number }
interface StoredBot { id: string; unread?: boolean; tasks?: StoredTask[] }

const state = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as SeedState;
const attachmentsDir = join(DATA_DIR, "attachments");
mkdirSync(attachmentsDir, { recursive: true, mode: 0o700 });

const writeJson = (file: string, value: unknown) => {
  const temp = `${file}.demo-${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
};

const conversations = threads();
const taskPatches = new Map<string, Partial<StoredTask>>();
let rows = 0;
for (const bot of BOTS) {
  const seeded = state.bots[bot.key]!;
  for (const thread of conversations[bot.key]) {
    const threadId = seeded.threads[thread.key]!;
    const built = buildThread(bot.key, thread, { now: state.now, attachmentsDir, botId: seeded.id, threadId });
    for (const file of built.files) writeFileSync(file.path, file.body, { mode: 0o600 });
    mdb.deleteThread(threadId);
    mdb.importThread(threadId, built.messages, built.leafId);
    rows += built.messages.length;
    taskPatches.set(threadId, {
      unread: built.unread,
      ...(built.lastReadMessageId ? { lastReadMessageId: built.lastReadMessageId } : {}),
      updatedAt: built.updatedAt,
      lastThreadOrderAt: built.updatedAt,
    });
  }
}
mdb.closeMessageDb();

const botsFile = join(DATA_DIR, "bots.json");
const stored = JSON.parse(readFileSync(botsFile, "utf8")) as StoredBot[];
for (const bot of stored) {
  for (const task of bot.tasks ?? []) {
    const patch = taskPatches.get(task.threadId);
    if (!patch) continue;
    if (!patch.unread) delete task.lastReadMessageId;
    Object.assign(task, patch);
  }
  if (bot.tasks?.some((task) => taskPatches.has(task.threadId))) bot.unread = bot.tasks.some((task) => task.unread === true);
}
writeJson(botsFile, stored);

const routinesFile = join(DATA_DIR, "routines.json");
const routinesDoc = JSON.parse(readFileSync(routinesFile, "utf8")) as { runs?: unknown[]; routines?: Array<{ id: string; name: string; prompt: string }> };
const runs = routinesDoc.runs ?? [];
for (const [name, daysAgo, status, text] of PAST_RUNS as Array<[string, number, string, string]>) {
  const routine = routinesDoc.routines?.find((candidate) => candidate.name === name);
  const seeded = state.routines[name];
  if (!routine || !seeded) continue;
  const scheduledFor = state.now - daysAgo * D - 3 * 60 * 60_000;
  runs.push({
    id: randomUUID(), routineId: routine.id, routineName: name, prompt: routine.prompt, target: "bot",
    botId: seeded.botId, runOn: "maus", scheduledFor, status, manual: false, triggerSource: "schedule",
    startedAt: scheduledFor + 2_000, finishedAt: scheduledFor + 95_000,
    ...(status === "completed" ? { output: text } : { error: text }),
  });
}
routinesDoc.runs = runs;
writeJson(routinesFile, routinesDoc);

console.log(`  conversations: ${taskPatches.size} rewritten with ${rows} rows; ${[...taskPatches.values()].filter((patch) => patch.unread).length} unread`);
console.log(`  routine log: ${PAST_RUNS.length} past runs`);
