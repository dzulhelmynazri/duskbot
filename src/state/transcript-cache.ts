import { optimisticMessageId } from "./optimistic-send";
import { foldSnapshotOntoStreamed } from "./room-frames";
import type { Message } from "./store";

/** A conversation's messages as this device last saw them. */
export interface CachedTranscript {
  threadId: string;
  messages: Message[];
  hasMore: boolean;
  activeLeafId: string | null;
  savedAt: number;
}

export const CACHED_THREADS = 200;
export const CACHED_BYTES = 32 * 1024 * 1024;
export const CACHED_THREAD_BYTES = 512 * 1024;
export const CACHED_MESSAGES = 200;
const CACHED_TOOL_OUTPUT = 1_000;

const sameMessage = (a: Message, b: Message) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** `incoming`, holding on to each message of `current` it did not change, so rows keyed on them do not draw again. */
export function reuseMessages(current: readonly Message[], incoming: readonly Message[]): Message[] {
  if (!current.length) return incoming as Message[];
  const held = new Map(current.map((message) => [message.id, message]));
  let changed = incoming.length !== current.length;
  const merged = incoming.map((message, index) => {
    const before = held.get(message.id);
    const kept = before && sameMessage(before, message) ? before : message;
    if (kept !== current[index]) changed = true;
    return kept;
  });
  return changed ? merged : (current as Message[]);
}

/** A cached transcript brought up to date by the newest page: messages the page covers come from it (or from what
 * streamed in while it was on its way), older cached history it does not reach stays above it, and every message
 * that did not change keeps its object. */
export function reconcileTranscript(
  current: readonly Message[],
  heldAtStart: ReadonlySet<Message>,
  page: readonly Message[],
  pageHasMore: boolean,
  currentHasMore: boolean | undefined,
): { messages: Message[]; hasMore: boolean } {
  const folded = foldSnapshotOntoStreamed(current, heldAtStart, page);
  const anchor = page.length ? current.findIndex((message) => message.id === page[0]!.id) : -1;
  const pageIds = new Set(page.map((message) => message.id));
  const older = pageHasMore && anchor > 0 ? current.slice(0, anchor).filter((message) => !pageIds.has(message.id)) : [];
  return {
    messages: reuseMessages(current, [...older, ...folded]),
    hasMore: older.length ? Boolean(currentHasMore) || pageHasMore : pageHasMore,
  };
}

function storable(message: Message): Message {
  const output = message.tool?.output;
  if (message.kind !== "activity" || output === undefined || output.length <= CACHED_TOOL_OUTPUT || message.relay || message.roomRequest || message.comm || message.threadRef) return message;
  return { ...message, tool: { ...message.tool!, output: output.slice(0, CACHED_TOOL_OUTPUT), clipped: true } };
}

/** What of a transcript is worth keeping on disk: its newest messages, within a size budget. */
export function cacheEntry(threadId: string, messages: readonly Message[], hasMore: boolean | undefined, activeLeafId: string | null | undefined, savedAt: number): CachedTranscript & { bytes: number } {
  let kept = messages.slice(-CACHED_MESSAGES).filter((message) => !message.id.startsWith("optimistic-")).map(storable);
  let bytes = JSON.stringify(kept).length;
  while (bytes > CACHED_THREAD_BYTES && kept.length > 1) {
    kept = kept.slice(Math.ceil(kept.length / 4));
    bytes = JSON.stringify(kept).length;
  }
  return { threadId, messages: kept, hasMore: Boolean(hasMore) || kept.length < messages.length, activeLeafId: activeLeafId ?? null, savedAt, bytes };
}

/** Where cached transcripts live between launches. */
export interface TranscriptShelf {
  read(): Promise<Array<CachedTranscript & { bytes: number }>>;
  write(put: ReadonlyArray<CachedTranscript & { bytes: number }>, remove: readonly string[]): Promise<void>;
}

const DB = "madani-transcripts";
const STORE = "threads";

/** One shelf per workspace connection on a device that holds several (the phone app); `null` is the page's own
 * workspace. */
export function transcriptShelfName(scope: string | null): string {
  return scope === null ? DB : `${DB}.${scope}`;
}

/** Drops a workspace's saved transcripts from this device, once it is unlinked or replaced. */
export function forgetTranscriptShelf(scope: string | null, factory: IDBFactory | undefined = globalThis.indexedDB): Promise<void> {
  if (!factory) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const req = factory.deleteDatabase(transcriptShelfName(scope));
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function indexedDbShelf(factory: IDBFactory | undefined = globalThis.indexedDB, scope: string | null = null): TranscriptShelf | null {
  if (!factory) return null;
  let opened: Promise<IDBDatabase> | null = null;
  const open = () => opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory.open(transcriptShelfName(scope), 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "threadId" }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return {
    async read() {
      const db = await open();
      return request(db.transaction(STORE, "readonly").objectStore(STORE).getAll()) as Promise<Array<CachedTranscript & { bytes: number }>>;
    },
    async write(put, remove) {
      const db = await open();
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      for (const entry of put) store.put(entry);
      for (const threadId of remove) store.delete(threadId);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    },
  };
}

/** The device's transcript cache: what each conversation last showed, kept current by the store, and the newest
 * {@link CACHED_THREADS} of them saved to the shelf a moment after they change. Saving starts once
 * {@link setEnabled} says the workspace is this person's own. */
export function createTranscriptCache(shelf: TranscriptShelf | null, { delayMs = 1_500, now = Date.now }: { delayMs?: number; now?: () => number } = {}) {
  const memory = new Map<string, CachedTranscript>();
  // conversations this device has followed since the server last confirmed them: what is here is what the server has
  const fresh = new Set<string>();
  const saved = new Map<string, CachedTranscript>();
  const dirty = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing: Promise<void> = Promise.resolve();
  let enabled = false;

  const loaded: Promise<void> = shelf
    ? shelf.read().then((entries) => {
      for (const entry of entries) {
        if (!entry || typeof entry.threadId !== "string" || !Array.isArray(entry.messages)) continue;
        saved.set(entry.threadId, entry);
        if (!memory.has(entry.threadId)) memory.set(entry.threadId, entry);
      }
    }, () => undefined)
    : Promise.resolve();

  const flush = (): Promise<void> => {
    timer = undefined;
    if (!shelf || !enabled) return writing;
    const candidates: Array<CachedTranscript & { bytes: number }> = [];
    let used = 0;
    for (const entry of [...memory.values()].sort((a, b) => b.savedAt - a.savedAt)) {
      if (candidates.length >= CACHED_THREADS) break;
      const stored = saved.get(entry.threadId) === entry && "bytes" in entry
        ? entry as CachedTranscript & { bytes: number }
        : cacheEntry(entry.threadId, entry.messages, entry.hasMore, entry.activeLeafId, entry.savedAt);
      if (used + stored.bytes > CACHED_BYTES) continue;
      candidates.push(stored);
      used += stored.bytes;
    }
    const keep = new Set(candidates.map((entry) => entry.threadId));
    const put = candidates.filter((entry) => dirty.has(entry.threadId) || !saved.has(entry.threadId));
    const remove = [...saved.keys()].filter((threadId) => !keep.has(threadId));
    dirty.clear();
    for (const threadId of remove) saved.delete(threadId);
    for (const entry of put) saved.set(entry.threadId, memory.get(entry.threadId) ?? entry);
    if (!put.length && !remove.length) return writing;
    writing = writing.then(() => shelf.write(put, remove)).catch(() => {});
    return writing;
  };
  const schedule = () => {
    if (!shelf || !enabled || timer !== undefined) return;
    timer = setTimeout(flush, delayMs);
  };
  const put = (threadId: string, messages: Message[], hasMore: boolean | undefined, activeLeafId: string | null | undefined) => {
    const before = memory.get(threadId);
    if (before?.messages === messages && before.activeLeafId === (activeLeafId ?? null) && before.hasMore === Boolean(hasMore)) return;
    if (!messages.length) return;
    memory.set(threadId, { threadId, messages, hasMore: Boolean(hasMore), activeLeafId: activeLeafId ?? null, savedAt: now() });
    dirty.add(threadId);
    schedule();
  };

  return {
    /** Resolves once the shelf has been read; what it held is then in {@link get}. */
    loaded,
    get(threadId: string): CachedTranscript | undefined {
      return memory.get(threadId);
    },
    /** A conversation as the server has it right now, or undefined when this device may have missed some of it. */
    current(threadId: string): CachedTranscript | undefined {
      return fresh.has(threadId) ? memory.get(threadId) : undefined;
    },
    /** The newest page of a conversation, straight from the server. */
    confirm(threadId: string, messages: Message[], hasMore: boolean | undefined, activeLeafId: string | null | undefined, heldAtStart?: readonly Message[]) {
      const before = memory.get(threadId);
      put(threadId, before ? reconcileTranscript(before.messages, new Set(heldAtStart ?? before.messages), messages, Boolean(hasMore), before.hasMore).messages : messages, hasMore, activeLeafId);
      fresh.add(threadId);
    },
    /** A live frame: every conversation held here follows it, the one on screen or not. */
    follow(frame: { kind: string; threadId?: string; message?: unknown; activeLeafId?: string | null }) {
      const entry = frame.threadId ? memory.get(frame.threadId) : undefined;
      if (!entry) return;
      if (frame.kind === "thread") return put(entry.threadId, entry.messages, entry.hasMore, frame.activeLeafId ?? null);
      const message = frame.message as Message | undefined;
      if (!message?.id || (frame.kind !== "message" && frame.kind !== "message.patch")) return;
      const index = entry.messages.findIndex((held) => held.id === message.id);
      if (index < 0 && frame.kind === "message") {
        const adoptsLeaf = (message.parentId ?? null) === entry.activeLeafId;
        put(entry.threadId, [...entry.messages.filter((held) => !message.sendId || held.id !== optimisticMessageId(message.sendId)), message], entry.hasMore, adoptsLeaf ? message.id : entry.activeLeafId);
      } else if (index >= 0) put(entry.threadId, entry.messages.map((held, at) => (at === index ? message : held)), entry.hasMore, entry.activeLeafId);
    },
    /** The live stream restarted without replaying what it missed: nothing here is known current until confirmed again. */
    forgetConfirmed() {
      fresh.clear();
    },
    /** A conversation's current messages. The same array again changes nothing. */
    remember(threadId: string, messages: Message[], hasMore: boolean | undefined, activeLeafId: string | null | undefined) {
      fresh.add(threadId);
      put(threadId, messages, hasMore, activeLeafId);
    },
    /** Marks a conversation as just opened, so it is among the last to leave the shelf. */
    touch(threadId: string) {
      const entry = memory.get(threadId);
      if (!entry) return;
      memory.set(threadId, { ...entry, savedAt: now() });
      dirty.add(threadId);
      schedule();
    },
    /** Off on a shared workspace, where what one person was shown must never wait on disk for the next: that also
     * empties the shelf. */
    setEnabled(next: boolean) {
      if (next === enabled) return;
      enabled = next;
      if (next) {
        schedule();
        return;
      }
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      const remove = [...saved.keys()];
      saved.clear();
      if (shelf && remove.length) writing = writing.then(() => shelf.write([], remove)).catch(() => {});
    },
    flush,
  };
}

export type TranscriptCache = ReturnType<typeof createTranscriptCache>;
