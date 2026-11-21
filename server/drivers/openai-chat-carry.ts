// A chat turn that a usage or rate limit cut off after it ran tools: the limit is reported the way every engine reports
// one, so the turn waits for the reset (or a backup the person chose takes it) through the shared limit hold, and the
// steps it ran ride into the turn that carries it on, on this engine or a chat-engine backup, instead of starting over.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dataDirFor } from "../../electron/legacy-names.mjs";
import { writeFileAtomic } from "../atomic.ts";
import { isLimitResume } from "../limit-resume.ts";
import type { ChatToolCall } from "./openai-chat-protocol.ts";
import { classifyError } from "./retry.ts";

export interface CarriedMessage {
  role: "assistant" | "tool";
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

/** a limit reached by the turn's last request, as runtime.error's limit facts; null for any other failure */
export function chatLimitFacts(error: unknown, now = Date.now()): { limit: "engine"; limitResetsAt?: number } | null {
  const reason = classifyError(error instanceof Error ? error : { text: String(error) }).reason;
  if (reason !== "rate_limited" && reason !== "quota") return null;
  const { retryAfterMs: asked, limitResetAt: named } = (error ?? {}) as { retryAfterMs?: unknown; limitResetAt?: unknown };
  const at = typeof asked === "number" && asked > 0 ? now + asked : typeof named === "number" && named > now ? named
    : reason === "rate_limited" ? now + RATE_LIMIT_WAIT_MS : undefined;
  return { limit: "engine", ...(at ? { limitResetsAt: at } : {}) };
}

const RESULT_MAX = 2_000;
const RATE_LIMIT_WAIT_MS = 60_000;
const CARRY_MAX = 48_000;
const KEEP_MS = 8 * 24 * 60 * 60_000;
const THREADS_MAX = 64;

/** the tool calls and their results after `from`, whole pairs only, bounded: past the bound the newest pairs stay */
export function carriedSteps(messages: ReadonlyArray<{ role: string; content?: unknown; tool_calls?: ChatToolCall[]; tool_call_id?: string }>, from: number): CarriedMessage[] {
  const pairs: CarriedMessage[][] = [];
  for (let index = from + 1; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role !== "assistant" || !message.tool_calls?.length) continue;
    const ids = new Set(message.tool_calls.map((call) => call.id));
    const results = messages.slice(index + 1).filter((entry) => entry.role === "tool" && entry.tool_call_id && ids.has(entry.tool_call_id));
    if (results.length !== ids.size) break;
    pairs.push([
      { role: "assistant", content: typeof message.content === "string" ? message.content : null, tool_calls: message.tool_calls },
      ...results.map((entry): CarriedMessage => ({ role: "tool", tool_call_id: entry.tool_call_id!, content: String(entry.content ?? "").slice(0, RESULT_MAX) })),
    ]);
  }
  let bytes = 0, first = pairs.length;
  for (; first > 0; first--) {
    const size = Buffer.byteLength(JSON.stringify(pairs[first - 1]));
    if (bytes + size > CARRY_MAX) break;
    bytes += size;
  }
  return pairs.slice(first).flat();
}

/** where the steps wait: next to the held turns (limit-held-turns.json), so a restart during the wait keeps them */
export function carriedWorkFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDirFor(env.MADANI_DATA_DIR, homedir()), "limit-carried-steps.json");
}

type Kept = { at: number; steps: CarriedMessage[]; next?: true };

function load(file: string | undefined): Map<string, Kept> {
  if (!file) return new Map();
  try {
    const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    return new Map(Object.entries(saved).flatMap(([threadId, value]): Array<[string, Kept]> => {
      const row = value as Partial<Kept> | null;
      return row && Number.isFinite(row.at) && Array.isArray(row.steps) ? [[threadId, { at: row.at!, steps: row.steps, ...(row.next === true ? { next: true as const } : {}) }]] : [];
    }));
  } catch {
    return new Map();
  }
}

/** Per conversation, the steps a limited turn ran. The next chat-engine turn there takes them once: only the turn that
 * carries the limited one on, or the person's message that ended its wait, gets them; any other turn (a backup already
 * finished the work) clears them. */
export function createCarriedWork(options: { file?: string; now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const kept = load(options.file);
  const save = () => {
    if (!options.file) return;
    try {
      if (kept.size || existsSync(options.file)) writeFileAtomic(options.file, JSON.stringify(Object.fromEntries(kept)), { mode: 0o600 });
    } catch (error) {
      console.warn(`carried steps: could not save: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return {
    keep(threadId: string, steps: CarriedMessage[]): void {
      if (!steps.length) return;
      kept.delete(threadId);
      kept.set(threadId, { at: now(), steps });
      if (kept.size > THREADS_MAX) kept.delete(kept.keys().next().value!);
      save();
    },
    /** the person wrote while the limited turn waited: their next turn carries the steps on */
    forNextTurn(threadId: string): void {
      const entry = kept.get(threadId);
      if (!entry || entry.next) return;
      entry.next = true;
      save();
    },
    take(threadId: string, text: string): CarriedMessage[] {
      const entry = kept.get(threadId);
      if (!entry) return [];
      kept.delete(threadId);
      save();
      return (entry.next || isLimitResume(text)) && now() - entry.at <= KEEP_MS ? entry.steps : [];
    },
  };
}

export type CarriedWork = ReturnType<typeof createCarriedWork>;

const sharedWork = new Map<string, CarriedWork>();

/** one store per file for every chat engine, so a backup takes the steps and no engine's save drops another's */
export function sharedCarriedWork(file: string): CarriedWork {
  let work = sharedWork.get(file);
  if (!work) sharedWork.set(file, work = createCarriedWork({ file }));
  return work;
}

/** the person's message ended a limit wait in this conversation: the steps the held turn ran go into that message's turn */
export function carryIntoNextTurn(threadId: string, file = carriedWorkFile()): void {
  sharedCarriedWork(file).forNextTurn(threadId);
}
