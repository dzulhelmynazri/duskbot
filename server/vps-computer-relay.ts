// a vps computer's cua tools as an engine reaches them: its harness proxy relays every mcp request here and this server
// runs the driver bridge. an engine in the bot box has no docker access (its own `docker exec` dies before the mcp
// handshake), and a computer asleep at turn start must still list its tools and wake on the first call.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./atomic.ts";
import { HARNESS_CALL_BUDGET_MS } from "./harness-budget.ts";
import { harnessMcpTokenEnv } from "./harness-mcp-token.ts";
import { AGENTS_NODE_FLAG, SPAWNED_PROXIES } from "./proxy-paths.ts";
import { trail, trailError } from "./trail.ts";

export interface RelayBridge { command: string; args: string[]; env: Record<string, string> }

export interface RelayTurn {
  /** the awake computer's driver bridge; null while it sleeps */
  bridge: () => RelayBridge | null;
  /** wakes the computer, or joins its wake, and returns its bridge */
  wake: () => Promise<RelayBridge>;
  /** the desktop and driver a tool list belongs to */
  toolsKey: string;
}

export function vpsToolsKey(status: { desktop: string; driver_version: string }): string {
  return `${status.desktop}:${status.driver_version}`;
}

/** What the engine mounts as its computer: the harness proxy, holding only the turn's capability. */
export function relayedComputerSpec(token: string, port: number) {
  return { command: process.execPath, args: [SPAWNED_PROXIES.harnessMcp, "computer"], platform: "linux" as const,
    env: { ...AGENTS_NODE_FLAG, [harnessMcpTokenEnv("computer")]: token, MADANI_HARNESS_URL: `http://127.0.0.1:${port}` } };
}

export interface RelayOwner { threadId: string; generation: string }
export type RelayAnswer = { result: unknown } | { error: string };

export interface McpSession {
  readonly closed: boolean;
  request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<RelayAnswer>;
  close(): void;
}

const MAX_BUFFERED = 16 * 1024 * 1024;
const START_MS = 30_000;
const KEPT_LISTS = 8;
/** how long a finished turn's driver session waits for the next turn on the same desktop */
const PARKED_MS = 5 * 60_000;
const STOPPED = "The cloud computer's tools stopped. Take a screenshot before repeating an action whose result is uncertain.";
const SLOW = "The cloud computer did not answer in time. It may still be running the action: take a screenshot before repeating it.";
const STILL_STARTING = "The cloud computer is still starting. Call the tool again in a moment; nothing ran yet.";
const NO_COMPUTER = "This turn has no cloud computer.";

/** One stdio MCP session to the driver bridge, spawned by this server outside any bot box. */
export function openBridgeSession(bridge: RelayBridge): McpSession {
  const child = spawn(bridge.command, bridge.args, { env: { ...process.env, ...bridge.env }, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, (answer: RelayAnswer) => void>();
  let closed = false, buffer = "", nextId = 1;
  const end = (why: string) => {
    if (closed) return;
    closed = true;
    for (const settle of pending.values()) settle({ error: why });
    pending.clear();
    child.kill();
  };
  const write = (frame: unknown) => { if (!closed) child.stdin.write(`${JSON.stringify(frame)}\n`); };
  child.on("error", () => end("The cloud computer's tools could not start."));
  child.on("exit", () => end(STOPPED));
  child.stdin.on("error", () => {});
  // drained, never kept: it can carry connection details
  child.stderr.resume();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      let frame: { id?: unknown; method?: unknown; result?: unknown; error?: { message?: unknown } };
      try { frame = JSON.parse(line); } catch { continue; }
      if (typeof frame.method === "string") {
        if (frame.id !== undefined) write({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "Client method not supported" } });
        continue;
      }
      const settle = typeof frame.id === "number" ? pending.get(frame.id) : undefined;
      if (!settle) continue;
      settle("result" in frame ? { result: frame.result }
        : { error: typeof frame.error?.message === "string" ? frame.error.message : "The cloud computer refused the request." });
    }
    if (buffer.length > MAX_BUFFERED) end("The cloud computer's answer was too large.");
  });
  const send = (method: string, params: unknown, timeoutMs: number, signal?: AbortSignal) => new Promise<RelayAnswer>((resolve) => {
    if (closed) return resolve({ error: STOPPED });
    const id = nextId++;
    const finish = (answer: RelayAnswer) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      pending.delete(id);
      resolve(answer);
    };
    const cancel = () => {
      write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "Cancelled" } });
      finish({ error: "The call was cancelled." });
    };
    const timer = setTimeout(() => finish({ error: SLOW }), timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    pending.set(id, finish);
    write({ jsonrpc: "2.0", id, method, params });
  });
  const ready = send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "madanibot", version: "1" } }, START_MS)
    .then((answer) => {
      if ("error" in answer) end(answer.error);
      else write({ jsonrpc: "2.0", method: "notifications/initialized" });
      return answer;
    });
  return {
    get closed() { return closed; },
    async request(method, params, timeoutMs, signal) {
      const started = await ready;
      return "error" in started ? started : send(method, params, timeoutMs, signal);
    },
    close: () => end(STOPPED),
  };
}

/** The last tool list each desktop and driver answered, kept on disk so a turn that finds the computer asleep can list it. */
export class ComputerToolLists {
  private lists: Record<string, unknown[]> = {};
  private readonly file: string | undefined;
  constructor(file?: string) {
    this.file = file;
    if (!file) return;
    try {
      const saved: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (saved && typeof saved === "object" && !Array.isArray(saved)) {
        this.lists = Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]) && entry[1].length > 0));
      }
    } catch {}
  }

  get(key: string): unknown[] | null {
    return this.lists[key] ?? null;
  }

  set(key: string, tools: unknown[]): void {
    if (!tools.length || JSON.stringify(this.lists[key]) === JSON.stringify(tools)) return;
    const rest = Object.entries(this.lists).filter(([name]) => name !== key).slice(-(KEPT_LISTS - 1));
    this.lists = { ...Object.fromEntries(rest), [key]: tools };
    if (this.file) try { writeFileAtomic(this.file, JSON.stringify(this.lists), { mode: 0o600 }); } catch {}
  }
}

interface Entry { owner: RelayOwner; turn: RelayTurn; closed: boolean; waking?: Promise<RelayBridge>; wakeDeadline?: number; session?: McpSession; bridge?: RelayBridge }

function within<T>(work: Promise<T>, deadline: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error(STILL_STARTING), { slow: true })), Math.max(0, deadline - Date.now()));
    const cancel = () => reject(new Error("The call was cancelled."));
    signal?.addEventListener("abort", cancel, { once: true });
    work.then(resolve, reject).finally(() => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); });
    if (signal?.aborted) cancel();
    else if (deadline <= Date.now()) reject(Object.assign(new Error(STILL_STARTING), { slow: true }));
  });
}

export function createComputerRelay(options: { lists: ComputerToolLists; open?: (bridge: RelayBridge) => McpSession; budgetMs?: number; parkedMs?: number }) {
  const turns = new Map<string, Entry>();
  // a driver session outlives its turn here, keyed by the whole bridge (container id and the thread's bearer), so the
  // next turn on that desktop skips spawning the bridge and its docker exec; a stopped desktop ends the session itself
  const parked = new Map<string, { session: McpSession; timer: ReturnType<typeof setTimeout> }>();
  const parkedMs = options.parkedMs ?? PARKED_MS;
  const bridgeKey = (bridge: RelayBridge) => JSON.stringify([bridge.command, bridge.args, Object.entries(bridge.env).sort(([a], [b]) => a.localeCompare(b))]);
  const unpark = (key: string) => {
    const held = parked.get(key);
    if (!held) return undefined;
    parked.delete(key);
    clearTimeout(held.timer);
    return held.session.closed ? undefined : held.session;
  };
  const park = (bridge: RelayBridge, session: McpSession) => {
    const key = bridgeKey(bridge);
    unpark(key)?.close();
    const timer = setTimeout(() => unpark(key)?.close(), parkedMs);
    timer.unref?.();
    parked.set(key, { session, timer });
  };
  const open = (bridge: RelayBridge) => unpark(bridgeKey(bridge)) ?? (options.open ?? openBridgeSession)(bridge);
  const budgetMs = options.budgetMs ?? HARNESS_CALL_BUDGET_MS;
  const entryFor = (owner: RelayOwner) => {
    const entry = turns.get(owner.threadId);
    return entry && entry.owner.generation === owner.generation ? entry : undefined;
  };
  const awake = (entry: Entry): Promise<RelayBridge> => {
    const bridge = entry.turn.bridge();
    if (bridge) { entry.wakeDeadline = undefined; return Promise.resolve(bridge); }
    if (!entry.waking) {
      entry.wakeDeadline = Date.now() + budgetMs;
      const wakeAt = Date.now();
      trail("computer.wake", { thread: entry.owner.threadId, why: "turn" });
      entry.waking = entry.turn.wake().then((bridge) => { trail("computer.awake", { thread: entry.owner.threadId, ms: Date.now() - wakeAt }); return bridge; }, (error: unknown) => {
        entry.waking = undefined; entry.wakeDeadline = undefined;
        trailError("computer.wake-failed", error, { thread: entry.owner.threadId, ms: Date.now() - wakeAt });
        throw error;
      });
    }
    return entry.waking;
  };
  const sessionFor = async (entry: Entry) => {
    const bridge = await awake(entry);
    if (entry.closed) throw new Error("This turn ended before the cloud computer was ready.");
    if (!entry.session || entry.session.closed || entry.bridge !== bridge) {
      entry.session?.close();
      entry.session = open(bridge);
      entry.bridge = bridge;
    }
    return entry.session;
  };
  const close = (entry: Entry) => {
    entry.closed = true;
    if (entry.session && !entry.session.closed && entry.bridge) park(entry.bridge, entry.session);
    else entry.session?.close();
    if (turns.get(entry.owner.threadId) === entry) turns.delete(entry.owner.threadId);
  };
  return {
    open(owner: RelayOwner, turn: RelayTurn): void {
      const earlier = turns.get(owner.threadId);
      if (earlier) close(earlier);
      turns.set(owner.threadId, { owner: { threadId: owner.threadId, generation: owner.generation }, turn, closed: false });
    },
    close(owner: RelayOwner): void {
      const entry = entryFor(owner);
      if (entry) close(entry);
    },
    /** A turn that finds the computer asleep mounts its tools only when their list is known. */
    knowsTools(toolsKey: string): boolean {
      return options.lists.get(toolsKey) !== null;
    },
    asleep(owner: RelayOwner): boolean {
      const entry = entryFor(owner);
      return Boolean(entry && !entry.closed && !entry.turn.bridge());
    },
    async wake(owner: RelayOwner): Promise<void> {
      const entry = entryFor(owner);
      if (!entry) throw Object.assign(new Error(NO_COMPUTER), { status: 409 });
      const waking = awake(entry);
      await within(waking, entry.wakeDeadline ?? Date.now() + budgetMs);
    },
    async request(owner: RelayOwner, frame: unknown, signal?: AbortSignal): Promise<RelayAnswer> {
      const { method, params } = (frame && typeof frame === "object" ? frame : {}) as { method?: unknown; params?: unknown };
      if (method !== "tools/list" && method !== "tools/call") return { error: "Unsupported computer method." };
      const entry = entryFor(owner);
      if (!entry || entry.closed) return { error: NO_COMPUTER };
      if (method === "tools/list" && !entry.session && !entry.turn.bridge()) {
        const known = options.lists.get(entry.turn.toolsKey);
        if (known) return { result: { tools: known } };
      }
      let deadline = Date.now() + budgetMs;
      let session: McpSession;
      try {
        const starting = sessionFor(entry);
        if (!entry.turn.bridge() && entry.wakeDeadline !== undefined) deadline = Math.min(deadline, entry.wakeDeadline);
        session = await within(starting, deadline, signal);
      }
      catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        return { error: (error as { slow?: unknown }).slow ? text : `The cloud computer could not be started: ${text}` };
      }
      const answer = await session.request(method, params ?? {}, Math.max(1_000, deadline - Date.now()), signal);
      const listed = "result" in answer ? answer.result as { tools?: unknown; nextCursor?: unknown } | null : null;
      if (method === "tools/list" && Array.isArray(listed?.tools) && listed.nextCursor === undefined) options.lists.set(entry.turn.toolsKey, listed.tools);
      return answer;
    },
  };
}

export type ComputerRelay = ReturnType<typeof createComputerRelay>;
