// the overview's /web answers for the panel's own ranges (today, 7, 30, 90 days, every surface) computed ahead for each reader
// the panel has seen, kept in the read cache and in MongoDB so a restarted service answers from them while it computes new ones
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { Binary, type Db } from "mongodb";
import { SURFACES } from "../analytics/web.ts";
import type { ReadCache } from "./read-cache.ts";

const DAY = 86_400_000;
export const WARM_RANGES = [1, 7, 30, 90] as const;
export const WARM_SURFACES = ["all", ...SURFACES] as const;
/** a `to` this close to now reads as "now" in the read cache's key */
export const NOW_SLACK_MS = 10 * 60_000;
const VIEWER_KEEP_MS = 7 * DAY;
const VIEWER_WRITE_MS = 60 * 60_000;

/** one reader of the panel: its clock (Date#getTimezoneOffset minutes) and its data switches (x-madani-admin-* headers) */
export interface WarmViewer { tz: number; data: string; tests: string; money: string }
export interface WarmStore {
  viewers(since: number): Promise<Array<{ viewer: WarmViewer; seen: number }>>;
  seen(viewer: WarmViewer, at: number): Promise<void>;
  answers(since: number): Promise<Array<{ key: string; at: number; value: unknown }>>;
  save(key: string, at: number, value: unknown, keepMs: number): Promise<void>;
  forgetAnswers(): Promise<void>;
}

const viewerKey = (viewer: WarmViewer) => JSON.stringify([viewer.tz, viewer.data, viewer.tests, viewer.money]);

/** the reader's local midnight `days - 1` days before today's (the panel's rangeOf) */
export function rangeFrom(now: number, tz: number, days: number) {
  const shift = tz * 60_000;
  return Math.floor((now - shift) / DAY) * DAY + shift - (days - 1) * DAY;
}

/** the reader behind a /web question, when the question is one of the panel's own ranges up to now with no filters */
export function viewerOf(url: URL, headers: Omit<WarmViewer, "tz">, now: number): WarmViewer | null {
  const params = url.searchParams;
  if ([...params.keys()].some(key => !["from", "to", "surface", "tz"].includes(key))) return null;
  const from = Number(params.get("from")), to = Number(params.get("to")), tz = Number(params.get("tz") ?? "0"), surface = params.get("surface") ?? "site";
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || Math.abs(to - now) >= NOW_SLACK_MS || !Number.isInteger(tz) || tz < -900 || tz > 900) return null;
  if (!(WARM_SURFACES as readonly string[]).includes(surface)) return null;
  if (!["", "own"].includes(headers.data) || !["", "show"].includes(headers.tests) || !["", "live", "test", "all"].includes(headers.money)) return null;
  // a question asked a little after the reader's midnight may still carry the day before's range
  if (!WARM_RANGES.some(days => [to, now].some(at => rangeFrom(at, tz, days) === from))) return null;
  return { tz, ...headers };
}

export interface WebWarmerOptions {
  store: WarmStore;
  reads: ReadCache;
  now: () => number;
  /** the read cache's key for a reader's question */
  keyOf(viewer: WarmViewer, url: URL): string;
  /** the answers to these questions, as /web gives them, in order */
  answer(viewer: WarmViewer, urls: URL[]): Promise<unknown[]>;
  /** how often each kept answer is computed again */
  everyMs: number;
  /** how long a kept answer may still be served (the read cache's freshness and staleness) */
  keepMs: number;
}

export function createWebWarmer(options: WebWarmerOptions) {
  const { store, reads, now, everyMs, keepMs } = options;
  const viewers = new Map<string, { viewer: WarmViewer; seen: number; written: number }>();
  let timer: ReturnType<typeof setTimeout> | null = null, running: Promise<void> | null = null, again = false, started = false, stopped = false;

  function questions(viewer: WarmViewer, days: number, time: number) {
    const from = rangeFrom(time, viewer.tz, days);
    return WARM_SURFACES.map(surface => new URL(`http://admin/v1/admin/web?from=${from}&to=${time}&surface=${surface}&tz=${viewer.tz}`));
  }

  async function warmRange(viewer: WarmViewer, days: number) {
    const time = now(), urls = questions(viewer, days, time), keys = urls.map(url => options.keyOf(viewer, url));
    if (keys.every(key => (reads.keptAt(key) ?? -Infinity) > time - everyMs)) return;
    const generation = reads.generation;
    const answers = await options.answer(viewer, urls);
    for (const [i, key] of keys.entries()) {
      reads.put(key, answers[i], time, generation);
      await store.save(key, time, answers[i], keepMs).catch(error => console.error(`[admin] a warmed /web answer was not saved: ${(error as Error).message}`));
    }
  }

  async function pass() {
    const time = now();
    const known = await store.viewers(time - VIEWER_KEEP_MS).catch(error => { console.error(`[admin] the /web readers could not be read: ${(error as Error).message}`); return []; });
    for (const { viewer, seen } of known) {
      const key = viewerKey(viewer), mine = viewers.get(key);
      if (!mine || mine.seen < seen) viewers.set(key, { viewer, seen, written: seen });
    }
    for (const [key, entry] of viewers) {
      if (entry.seen < time - VIEWER_KEEP_MS) { viewers.delete(key); continue; }
      for (const days of WARM_RANGES) {
        if (stopped) return;
        await warmRange(entry.viewer, days).catch(error => console.error(`[admin] /web ${days}d not warmed: ${(error as Error).message}`));
      }
    }
  }

  /** the soonest local midnight of a known reader, so a new day's ranges are warm a moment after it starts */
  function nextDelay() {
    const time = now();
    let delay = everyMs;
    for (const { viewer } of viewers.values()) delay = Math.min(delay, rangeFrom(time, viewer.tz, 0) - time + 5_000);
    return Math.max(1_000, delay);
  }
  function schedule(delayMs: number) {
    if (!started || stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void run(); }, delayMs);
    timer.unref?.();
  }
  function run(): Promise<void> {
    if (running) { again = true; return running; }
    running = pass().finally(() => {
      running = null;
      if (again) { again = false; void run(); } else schedule(nextDelay());
    });
    return running;
  }

  return {
    /** a /web question an admin asked: its reader is kept warm from now on */
    note(url: URL, headers: Omit<WarmViewer, "tz">) {
      const time = now(), viewer = viewerOf(url, headers, time);
      if (!viewer) return;
      const key = viewerKey(viewer), entry = viewers.get(key);
      if (entry) entry.seen = time; else viewers.set(key, { viewer, seen: time, written: 0 });
      const current = viewers.get(key)!;
      if (current.written < time - VIEWER_WRITE_MS) {
        current.written = time;
        store.seen(viewer, time).catch(error => console.error(`[admin] a /web reader was not saved: ${(error as Error).message}`));
      }
      if (!entry && !running) schedule(30_000);
    },
    /** the kept answers into the read cache, then a pass after `delayMs` and every `everyMs` after it */
    async start(delayMs = 30_000) {
      started = true;
      const time = now(), generation = reads.generation;
      const kept = await store.answers(time - keepMs).catch(error => { console.error(`[admin] the warmed /web answers could not be read: ${(error as Error).message}`); return []; });
      for (const { key, at, value } of kept) reads.put(key, value, at, generation);
      schedule(delayMs);
    },
    stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; },
    /** after a change the panel made: the kept answers are out of date */
    forget() { store.forgetAnswers().catch(error => console.error(`[admin] the warmed /web answers were not dropped: ${(error as Error).message}`)); },
    run,
  };
}
export type WebWarmer = ReturnType<typeof createWebWarmer>;

export function memoryWarmStore(): WarmStore & { saved: Map<string, { at: number; value: unknown }> } {
  const seen = new Map<string, { viewer: WarmViewer; seen: number }>(), saved = new Map<string, { at: number; value: unknown }>();
  return {
    saved,
    async viewers(since) { return [...seen.values()].filter(row => row.seen >= since); },
    async seen(viewer, at) { seen.set(viewerKey(viewer), { viewer, seen: at }); },
    async answers(since) { return [...saved].filter(([, row]) => row.at >= since).map(([key, row]) => ({ key, ...row })); },
    async save(key, at, value) { saved.set(key, { at, value: JSON.parse(JSON.stringify(value)) as unknown }); },
    async forgetAnswers() { saved.clear(); },
  };
}

const zip = promisify(gzip), unzip = promisify(gunzip);
type WarmDoc = { _id: string; kind: "viewer" | "answer"; expiresAt: Date; viewer?: WarmViewer; seen?: Date; key?: string; at?: Date; data?: Binary };
/** admin_web_warm: the panel's readers (7 days after last seen) and their warmed /web answers (as long as they may be served), gone by TTL */
export async function mongoWarmStore(db: Db): Promise<WarmStore> {
  const rows = db.collection<WarmDoc>("admin_web_warm");
  await rows.createIndexes([{ key: { expiresAt: 1 }, expireAfterSeconds: 0 }, { key: { kind: 1, at: 1 } }]);
  return {
    async viewers(since) {
      return (await rows.find({ kind: "viewer", seen: { $gte: new Date(since) } }).toArray()).map(row => ({ viewer: row.viewer!, seen: row.seen!.getTime() }));
    },
    async seen(viewer, at) {
      await rows.updateOne({ _id: `viewer|${viewerKey(viewer)}` }, { $set: { kind: "viewer", viewer, seen: new Date(at), expiresAt: new Date(at + VIEWER_KEEP_MS) } }, { upsert: true });
    },
    async answers(since) {
      const found = await rows.find({ kind: "answer", at: { $gte: new Date(since) } }).toArray();
      return Promise.all(found.map(async row => ({ key: row.key!, at: row.at!.getTime(), value: JSON.parse((await unzip(row.data!.buffer)).toString()) as unknown })));
    },
    async save(key, at, value, keepMs) {
      const data = new Binary(await zip(Buffer.from(JSON.stringify(value))));
      await rows.replaceOne({ _id: `answer|${key}` }, { kind: "answer", key, at: new Date(at), expiresAt: new Date(at + keepMs), data }, { upsert: true });
    },
    async forgetAnswers() { await rows.deleteMany({ kind: "answer" }); },
  };
}
