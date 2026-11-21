import { Binary, type Db } from "mongodb";
import { DAY_MS, RAW_RETENTION_DAYS, type Props } from "./events.ts";
import type { EventContext } from "./context.ts";
import type { RollupDoc, RollupMeta, RollupScope, RollupStore } from "./rollup.ts";
import { desktopFleetOf, type DesktopVersionRow } from "../admin/ops/fleet.ts";

export interface StoredEvent { id: string; name: string; at: number; accountId: string | null; props: Props; ctx?: EventContext }
export interface AuditEntry { id: string; at: number; actor: string; action: string; target: string | null; detail: Record<string, string | number | boolean | null> }
/** one request from an AI assistant's crawler to the site: which bot, what for, which page */
export interface Crawl { at: number; bot: string; kind: "answers" | "indexing" | "training"; path: string; host: string | null }
/** crawler requests are capped, not kept: the newest this many */
export const CRAWL_CAP = 200_000;
/** a chart note: a launch, a post, a release, pinned to a time */
export interface Note { id: string; at: number; text: string; by: string; createdAt: number }
/** the most raw events one dashboard read scans; beyond it the read uses the newest ones and says so */
export const SCAN_LIMIT = 400_000;
/** a scan's events, oldest first; `partialBefore` is set when the read stopped at its limit: events before that time were left out */
export type Scanned = StoredEvent[] & { partialBefore?: number };
export const partialOf = (events: readonly StoredEvent[]): number | null => (events as Scanned).partialBefore ?? null;
/** `out` (a filtered copy of `from`) keeps the mark of what `from` left out */
export function keepPartial(from: readonly StoredEvent[], out: StoredEvent[]): Scanned {
  const at = partialOf(from);
  if (at !== null) (out as Scanned).partialBefore = at;
  return out;
}
function capped(oldestFirst: StoredEvent[], hit: boolean): Scanned {
  const out = oldestFirst as Scanned;
  if (hit && out.length) out.partialBefore = out[0]!.at;
  return out;
}
export interface EventQuery { accountId?: string; name?: string; since?: number; before?: number; limit: number }
/** the longest one admin read may keep the database busy; past it the read fails with a clear error instead of hanging */
export const READ_TIMEOUT_MS = 20_000;
/** everything one person did: an account's events plus those of the site visitors and app installs that became it */
export interface PersonQuery { accountId: string | null; visitors: readonly string[]; installs: readonly string[]; since: number; limit: number }
/** one site visitor or app install that never signed in (or not yet), summed over a window */
export interface AnonymousRow {
  key: string; kind: "visitor" | "install"; firstAt: number; lastAt: number; events: number;
  country: string | null; city: string | null; device: string | null; os: string | null; browser: string | null; platform: string | null; appVersion: string | null;
}
/** the events that show an anonymous person: a site page, an account page, an app open */
export const ANONYMOUS_EVENTS = ["site_view", "page_view", "app_open"] as const;

/** where analytics live: MongoDB in production, memory in tests and fixtures */
export interface AnalyticsSink {
  insert(event: StoredEvent): Promise<void>;
  /** adds to the kept daily count of a name */
  bump(day: string, name: string, by?: number): Promise<void>;
  /** true the first time a key is seen; `expiresAt` null keeps the mark forever */
  once(key: string, expiresAt: number | null): Promise<boolean>;
  daily(names: string[], fromDay: string, toDay: string): Promise<Array<{ day: string; name: string; count: number }>>;
  events(query: EventQuery): Promise<StoredEvent[]>;
  counts(since: number, until: number): Promise<Array<{ name: string; count: number }>>;
  /** distinct accounts with any of these events since a time */
  accounts(names: string[], since: number): Promise<Set<string>>;
  /** removes every raw event of an account (its deletion, or opting out) */
  forget(accountId: string): Promise<void>;
  audit(entry: AuditEntry): Promise<void>;
  auditLog(limit: number, before?: number): Promise<AuditEntry[]>;
  /** the newest entries whose target is one of these ids, without the skipped actions */
  auditFor(targets: string[], limit: number, skipActions?: string[]): Promise<AuditEntry[]>;
  health(): Promise<{ ok: boolean; detail: string; latencyMs: number | null }>;
  /** raw events in [since, until), oldest first, optionally only some names */
  /** `byTime` reads through the time index, so events of the same millisecond come in the order they were written (the rollups need one order) */
  scan(since: number, until: number, names?: readonly string[], byTime?: boolean): Promise<Scanned>;
  notes(since: number, until: number): Promise<Note[]>;
  saveNote(note: Note): Promise<void>;
  deleteNote(id: string): Promise<boolean>;
  crawl(entry: Crawl): Promise<void>;
  crawls(since: number, until: number): Promise<Crawl[]>;
  /** one person's events, oldest first, from indexes (accountId, ctx.visitor, ctx.install), never a scan of everyone */
  person(query: PersonQuery): Promise<StoredEvent[]>;
  /** distinct site visitors (ctx.visitor) with any of these events in [since, until), counted by the database */
  visitorCount(since: number, until: number, names: readonly string[]): Promise<number>;
  /** each account's newest event at or after `since` */
  lastSeen(since: number): Promise<Map<string, number>>;
  /** visitors and installs with no account on their events in [since, until), newest first; `before` pages on lastAt */
  anonymous(since: number, until: number, options: { before?: number; limit: number }): Promise<{ total: number; rows: AnonymousRow[] }>;
  /** desktop versions in [since, until): installs by the version of their newest app_open, and app_error counts */
  fleet?(since: number, until: number): Promise<DesktopVersionRow[]>;
  /** how many raw events of these names are in [since, until) */
  count?(since: number, until: number, names: readonly string[]): Promise<number>;
  /** the time of the oldest raw event, null with none */
  oldest?(): Promise<number | null>;
  /** called with an event's time when one is written or removed (null: any may have been) */
  listen?(fn: (at: number | null) => void): void;
  /** whose events scan() returns, for the admin's rollups */
  rollupScope?(): RollupScope | null;
  /** where rollups of this service's analytics are kept */
  rollups?: RollupStore;
}

/** the anonymous people among these events, newest first: shared by the memory sink and the tests */
export function anonymousOf(events: readonly StoredEvent[], since: number, until: number): AnonymousRow[] {
  const rows = new Map<string, AnonymousRow>();
  for (const event of [...events].sort((a, b) => a.at - b.at)) {
    if (event.accountId || event.at < since || event.at >= until || !(ANONYMOUS_EVENTS as readonly string[]).includes(event.name)) continue;
    const ctx = event.ctx ?? {};
    const key = ctx.visitor ?? (ctx.install ? `install:${ctx.install}` : null);
    if (!key) continue;
    const row = rows.get(key) ?? rows.set(key, { key, kind: ctx.visitor ? "visitor" : "install", firstAt: event.at, lastAt: event.at, events: 0, country: null, city: null, device: null,
      os: null, browser: null, platform: null, appVersion: null }).get(key)!;
    row.lastAt = event.at; row.events++;
    row.country = ctx.country ?? row.country; row.city = ctx.city ?? row.city; row.device = ctx.device ?? row.device; row.os = ctx.os ?? row.os; row.browser = ctx.browser ?? row.browser;
    row.platform = ctx.app?.platform ?? row.platform; row.appVersion = ctx.app?.version ?? row.appVersion;
  }
  return [...rows.values()].sort((a, b) => b.lastAt - a.lastAt || a.key.localeCompare(b.key));
}

let memorySinks = 0;
export function memorySink(now: () => number = Date.now): AnalyticsSink & { all: StoredEvent[]; daySums: Map<string, number>; scanLimit: number } {
  let all: StoredEvent[] = [];
  const daySums = new Map<string, number>(), marks = new Map<string, number | null>(), audits: AuditEntry[] = [], notes = new Map<string, Note>(), crawlLog: Crawl[] = [];
  const listeners: Array<(at: number | null) => void> = [];
  const changed = (at: number | null) => { for (const fn of listeners) fn(at); };
  const match = (event: StoredEvent, q: Omit<EventQuery, "limit">) => (q.accountId === undefined || event.accountId === q.accountId) && (q.name === undefined || event.name === q.name)
    && (q.since === undefined || event.at >= q.since) && (q.before === undefined || event.at < q.before);
  const key = `memory${++memorySinks}`;
  const sink: AnalyticsSink & { all: StoredEvent[]; daySums: Map<string, number>; scanLimit: number } = {
    all, daySums, scanLimit: SCAN_LIMIT,
    async insert(event) {
      all.push(event);
      changed(event.at);
      const cutoff = now() - RAW_RETENTION_DAYS * DAY_MS;
      if (all[0] && all[0].at < cutoff) { all = all.filter(item => item.at >= cutoff); this.all = all; changed(null); }
    },
    async bump(day, name, by = 1) { const key = `${day}|${name}`; daySums.set(key, (daySums.get(key) ?? 0) + by); },
    async once(key, expiresAt) {
      const existing = marks.get(key);
      if (existing !== undefined && (existing === null || existing > now())) return false;
      marks.set(key, expiresAt); return true;
    },
    async daily(names, fromDay, toDay) {
      return [...daySums].map(([key, count]) => { const [day, name] = key.split("|") as [string, string]; return { day, name, count }; })
        .filter(row => names.includes(row.name) && row.day >= fromDay && row.day <= toDay);
    },
    async events(q) { return all.filter(event => match(event, q)).sort((a, b) => b.at - a.at).slice(0, q.limit); },
    async counts(since, until) {
      const by = new Map<string, number>();
      for (const event of all) if (event.at >= since && event.at < until) by.set(event.name, (by.get(event.name) ?? 0) + 1);
      return [...by].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    },
    async accounts(names, since) { return new Set(all.filter(event => event.accountId && names.includes(event.name) && event.at >= since).map(event => event.accountId!)); },
    async forget(accountId) {
      for (const event of all) if (event.accountId === accountId) changed(event.at);
      all = all.filter(event => event.accountId !== accountId); this.all = all;
    },
    async audit(entry) { audits.push(entry); },
    async auditLog(limit, before) { return audits.filter(entry => before === undefined || entry.at < before).sort((a, b) => b.at - a.at).slice(0, limit); },
    async auditFor(targets, limit, skipActions = []) { return audits.filter(entry => entry.target !== null && targets.includes(entry.target) && !skipActions.includes(entry.action)).sort((a, b) => b.at - a.at).slice(0, limit); },
    async health() { return { ok: true, detail: "memory (fixture)", latencyMs: null }; },
    async scan(since, until, names) {
      const found = all.filter(event => event.at >= since && event.at < until && (!names || names.includes(event.name))).sort((a, b) => a.at - b.at);
      return capped(found.slice(-sink.scanLimit), found.length > sink.scanLimit);
    },
    async notes(since, until) { return [...notes.values()].filter(note => note.at >= since && note.at < until).sort((a, b) => a.at - b.at); },
    async saveNote(note) { notes.set(note.id, note); },
    async deleteNote(id) { return notes.delete(id); },
    async crawl(entry) { crawlLog.push(entry); if (crawlLog.length > CRAWL_CAP) crawlLog.splice(0, crawlLog.length - CRAWL_CAP); },
    async crawls(since, until) { return crawlLog.filter(entry => entry.at >= since && entry.at < until); },
    async person(q) {
      const visitors = new Set(q.visitors), installs = new Set(q.installs);
      return all.filter(event => event.at >= q.since && ((q.accountId !== null && event.accountId === q.accountId) || (!!event.ctx?.visitor && visitors.has(event.ctx.visitor))
        || (!!event.ctx?.install && installs.has(event.ctx.install)))).sort((a, b) => a.at - b.at).slice(-q.limit);
    },
    async visitorCount(since, until, names) {
      return new Set(all.filter(event => event.at >= since && event.at < until && names.includes(event.name) && event.ctx?.visitor).map(event => event.ctx!.visitor)).size;
    },
    async lastSeen(since) {
      const out = new Map<string, number>();
      for (const event of all) if (event.accountId && event.at >= since && (out.get(event.accountId) ?? -1) < event.at) out.set(event.accountId, event.at);
      return out;
    },
    async fleet(since, until) { return desktopFleetOf(all, since, until); },
    async anonymous(since, until, options) {
      const rows = anonymousOf(all, since, until);
      return { total: rows.length, rows: rows.filter(row => options.before === undefined || row.lastAt < options.before).slice(0, options.limit) };
    },
    async count(since, until, names) { return all.filter(event => event.at >= since && event.at < until && names.includes(event.name)).length; },
    async oldest() { return all.reduce<number | null>((min, event) => min === null || event.at < min ? event.at : min, null); },
    listen(fn) { listeners.push(fn); },
    rollupScope: () => ({ key, sink, hidden: null, drops: null }),
  };
  return sink;
}

type EventDoc = { _id: string; name: string; at: Date; accountId: string | null; props: Props; ctx?: EventContext };
type AuditDoc = Omit<AuditEntry, "id" | "at"> & { _id: string; at: Date };

/** analytics_events (TTL on `at`, 400 days; nothing else deletes raw events but an account's own deletion or opt-out), analytics_daily (kept), analytics_marks (TTL on `expiresAt`), admin_audit (kept) */
export async function mongoSink(db: Db): Promise<AnalyticsSink> {
  const { events, daily, marks, audits, notes } = collectionsOf(db);
  if (!(await db.listCollections({ name: "analytics_crawls" }, { nameOnly: true }).toArray()).length) {
    await db.createCollection("analytics_crawls", { capped: true, size: 64 * 1024 * 1024, max: CRAWL_CAP }).catch((error: { code?: number }) => { if (error.code !== 48) throw error; });
  }
  await Promise.all([
    events.createIndexes([{ key: { at: 1 }, expireAfterSeconds: RAW_RETENTION_DAYS * 86_400 }, { key: { accountId: 1, at: -1 } }, { key: { name: 1, at: -1 } }, { key: { "ctx.session": 1, at: 1 }, sparse: true },
      // one person's page (the admin's profile) reads by visitor and install instead of scanning every event
      { key: { "ctx.visitor": 1, at: 1 }, sparse: true }, { key: { "ctx.install": 1, at: 1 }, sparse: true }]),
    daily.createIndexes([{ key: { day: 1, name: 1 } }]),
    marks.createIndexes([{ key: { expiresAt: 1 }, expireAfterSeconds: 0, partialFilterExpression: { expiresAt: { $type: "date" } } }]),
    audits.createIndexes([{ key: { at: -1 } }, { key: { target: 1, at: -1 } }]),
    notes.createIndexes([{ key: { at: 1 } }]),
    db.collection("analytics_crawls").createIndexes([{ key: { at: 1 } }]),
    ...rollupIndexes(db),
  ]);
  const sink = sinkOf(db, "own");
  return { ...sink, rollups: mongoRollupStore(db) };
}

/** another service's analytics, read only (preview's admin reading madani.bot's): no setup, and every write refuses */
export function readonlySink(db: Db): AnalyticsSink {
  const refuse = () => Promise.reject(new Error("These analytics are read only."));
  return { ...sinkOf(db, "live"), insert: refuse, bump: refuse, once: refuse, forget: refuse, audit: refuse, saveNote: refuse, deleteNote: refuse, crawl: refuse };
}

type RollupRow = Omit<RollupDoc, "at" | "data"> & { _id: string; at: Date; data: Binary };
/** analytics_rollups: digests of closed hours and days (rollup.ts), kept as long as raw events; analytics_rollup_marks: when a slot last went stale */
function rollupIndexes(db: Db) {
  const keep = (RAW_RETENTION_DAYS + 2) * 86_400;
  return [db.collection("analytics_rollups").createIndexes([{ key: { scope: 1, slot: 1 } }, { key: { at: 1 }, expireAfterSeconds: keep }]),
    db.collection("analytics_rollup_marks").createIndexes([{ key: { at: 1 }, expireAfterSeconds: keep }])];
}
export function mongoRollupStore(db: Db): RollupStore {
  const rows = db.collection<RollupRow>("analytics_rollups"), marks = db.collection<{ _id: string; stamp: number; at: Date }>("analytics_rollup_marks");
  const id = (scope: string, kind: string, slot: string) => `${scope}|${kind}|${slot}`;
  const toDoc = ({ _id: _ignored, at, data, ...rest }: RollupRow): RollupDoc => ({ ...rest, at: at.getTime(), data: data.buffer });
  return {
    async read(scope, kind, slots) {
      return (await rows.find({ _id: { $in: slots.map(slot => id(scope, kind, slot)) } }).maxTimeMS(READ_TIMEOUT_MS).toArray()).map(toDoc);
    },
    async meta(scope, slots) {
      return (await rows.find({ scope, slot: { $in: [...slots] } }, { projection: { data: 0 } }).maxTimeMS(READ_TIMEOUT_MS).toArray())
        .map(({ _id: _ignored, at, ...rest }) => ({ ...rest, at: at.getTime() }) as unknown as RollupMeta);
    },
    async write(docs) {
      if (!docs.length) return;
      await rows.bulkWrite(docs.map(doc => ({ replaceOne: { filter: { _id: id(doc.scope, doc.kind, doc.slot) }, upsert: true,
        replacement: { ...doc, at: new Date(doc.at), data: new Binary(doc.data) } } })), { ordered: false });
    },
    async marks(source, slots) {
      const docs = await marks.find({ _id: { $in: [...slots, "*"].map(slot => `${source}|${slot}`) } }).toArray();
      return new Map(docs.map(doc => [doc._id.slice(source.length + 1), doc.stamp]));
    },
    async mark(source, slots, stamp) {
      await marks.bulkWrite(slots.map(slot => ({ updateOne: { filter: { _id: `${source}|${slot}` }, upsert: true,
        update: { $max: { stamp }, $set: { at: new Date(slot === "*" ? Date.now() : Date.parse(slot.startsWith("d:") ? `${slot.slice(2)}T00:00:00Z` : `${slot.slice(2)}:00:00Z`)) } } } })), { ordered: false });
    },
  };
}

function collectionsOf(db: Db) {
  return { events: db.collection<EventDoc>("analytics_events"), daily: db.collection<{ _id: string; day: string; name: string; count: number }>("analytics_daily"),
    marks: db.collection<{ _id: string; expiresAt: Date | null }>("analytics_marks"), audits: db.collection<AuditDoc>("admin_audit"),
    notes: db.collection<{ _id: string; at: Date; text: string; by: string; createdAt: Date }>("analytics_notes"),
    crawlCollection: db.collection<{ at: Date; bot: string; kind: Crawl["kind"]; path: string; host: string | null }>("analytics_crawls") };
}

function sinkOf(db: Db, key: string): AnalyticsSink {
  const { events, daily, marks, audits, notes, crawlCollection } = collectionsOf(db);
  const toEvent = (doc: EventDoc): StoredEvent => ({ id: doc._id, name: doc.name, at: doc.at.getTime(), accountId: doc.accountId, props: doc.props ?? {}, ...(doc.ctx ? { ctx: doc.ctx } : {}) });
  const listeners: Array<(at: number | null) => void> = [];
  const changed = (at: number | null) => { for (const fn of listeners) fn(at); };
  const sink: AnalyticsSink = {
    async insert(event) {
      await events.insertOne({ _id: event.id, name: event.name, at: new Date(event.at), accountId: event.accountId, props: event.props, ...(event.ctx ? { ctx: event.ctx } : {}) });
      changed(event.at);
    },
    async bump(day, name, by = 1) { await daily.updateOne({ _id: `${day}|${name}` }, { $setOnInsert: { day, name }, $inc: { count: by } }, { upsert: true }); },
    async once(key, expiresAt) {
      const until = expiresAt === null ? null : new Date(expiresAt);
      try { await marks.insertOne({ _id: key, expiresAt: until }); return true; } catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
      const existing = await marks.findOne({ _id: key });
      if (!existing?.expiresAt || existing.expiresAt.getTime() > Date.now()) return false;
      return (await marks.updateOne({ _id: key, expiresAt: existing.expiresAt }, { $set: { expiresAt: until } })).modifiedCount === 1;
    },
    async daily(names, fromDay, toDay) {
      return (await daily.find({ name: { $in: names }, day: { $gte: fromDay, $lte: toDay } }).toArray()).map(({ day, name, count }) => ({ day, name, count }));
    },
    async events(q) {
      const at: Record<string, Date> = {};
      if (q.since !== undefined) at.$gte = new Date(q.since);
      if (q.before !== undefined) at.$lt = new Date(q.before);
      const filter = { ...(q.accountId === undefined ? {} : { accountId: q.accountId }), ...(q.name === undefined ? {} : { name: q.name }), ...(Object.keys(at).length ? { at } : {}) };
      return (await events.find(filter).sort({ at: -1 }).limit(q.limit).toArray()).map(toEvent);
    },
    async counts(since, until) {
      const rows = await events.aggregate<{ _id: string; count: number }>([{ $match: { at: { $gte: new Date(since), $lt: new Date(until) } } }, { $group: { _id: "$name", count: { $sum: 1 } } }, { $sort: { count: -1 } }]).toArray();
      return rows.map(row => ({ name: row._id, count: row.count }));
    },
    async accounts(names, since) {
      return new Set((await events.distinct("accountId", { name: { $in: names }, at: { $gte: new Date(since) }, accountId: { $type: "string" } })) as string[]);
    },
    async forget(accountId) {
      const hours = await events.aggregate<{ _id: number }>([{ $match: { accountId } }, { $group: { _id: { $subtract: [{ $toLong: "$at" }, { $mod: [{ $toLong: "$at" }, 3_600_000] }] } } }],
        { maxTimeMS: READ_TIMEOUT_MS }).toArray().catch(() => null);
      await events.deleteMany({ accountId });
      if (hours) for (const hour of hours) changed(Number(hour._id)); else changed(null);
    },
    async audit(entry) { const { id, at, ...rest } = entry; await audits.insertOne({ _id: id, at: new Date(at), ...rest }); },
    async auditLog(limit, before) {
      return (await audits.find(before === undefined ? {} : { at: { $lt: new Date(before) } }).sort({ at: -1 }).limit(limit).toArray())
        .map(({ _id, at, ...rest }) => ({ id: _id, at: at.getTime(), ...rest }));
    },
    async auditFor(targets, limit, skipActions = []) {
      return (await audits.find({ target: { $in: targets }, ...(skipActions.length ? { action: { $nin: skipActions } } : {}) }).sort({ at: -1 }).limit(limit).toArray()).map(({ _id, at, ...rest }) => ({ id: _id, at: at.getTime(), ...rest }));
    },
    async scan(since, until, names, byTime) {
      const filter = { at: { $gte: new Date(since), $lt: new Date(until) }, ...(names ? { name: { $in: [...names] } } : {}) };
      const query = events.find(filter).sort({ at: -1 }).limit(SCAN_LIMIT + 1).maxTimeMS(READ_TIMEOUT_MS);
      const docs = await (byTime ? query.hint({ at: 1 }) : query).toArray();
      const hit = docs.length > SCAN_LIMIT;
      return capped(docs.slice(0, SCAN_LIMIT).reverse().map(toEvent), hit);
    },
    async notes(since, until) {
      return (await notes.find({ at: { $gte: new Date(since), $lt: new Date(until) } }).sort({ at: 1 }).toArray())
        .map(doc => ({ id: doc._id, at: doc.at.getTime(), text: doc.text, by: doc.by, createdAt: doc.createdAt.getTime() }));
    },
    async saveNote(note) { await notes.replaceOne({ _id: note.id }, { at: new Date(note.at), text: note.text, by: note.by, createdAt: new Date(note.createdAt) }, { upsert: true }); },
    async deleteNote(id) { return (await notes.deleteOne({ _id: id })).deletedCount === 1; },
    async crawl(entry) { await crawlCollection.insertOne({ ...entry, at: new Date(entry.at) }); },
    async crawls(since, until) {
      return (await crawlCollection.find({ at: { $gte: new Date(since), $lt: new Date(until) } }).toArray()).map(({ at, bot, kind, path, host }) => ({ at: at.getTime(), bot, kind, path, host }));
    },
    async person(q) {
      const or: Array<Record<string, unknown>> = [];
      if (q.accountId !== null) or.push({ accountId: q.accountId });
      if (q.visitors.length) or.push({ "ctx.visitor": { $in: [...q.visitors] } });
      if (q.installs.length) or.push({ "ctx.install": { $in: [...q.installs] } });
      if (!or.length) return [];
      const docs = await events.find({ $or: or, at: { $gte: new Date(q.since) } }).sort({ at: -1 }).limit(q.limit).maxTimeMS(READ_TIMEOUT_MS).toArray();
      return docs.reverse().map(toEvent);
    },
    async visitorCount(since, until, names) {
      const [row] = await events.aggregate<{ n: number }>([{ $match: { name: { $in: [...names] }, at: { $gte: new Date(since), $lt: new Date(until) }, "ctx.visitor": { $type: "string" } } },
        { $group: { _id: "$ctx.visitor" } }, { $count: "n" }], { maxTimeMS: READ_TIMEOUT_MS }).toArray();
      return row?.n ?? 0;
    },
    async lastSeen(since) {
      const rows = await events.aggregate<{ _id: string; at: Date }>([{ $match: { accountId: { $type: "string" }, at: { $gte: new Date(since) } } }, { $group: { _id: "$accountId", at: { $max: "$at" } } }],
        { maxTimeMS: READ_TIMEOUT_MS }).toArray();
      return new Map(rows.map(row => [row._id, row.at.getTime()]));
    },
    async anonymous(since, until, options) {
      const key = { $ifNull: ["$ctx.visitor", { $cond: [{ $eq: [{ $type: "$ctx.install" }, "string"] }, { $concat: ["install:", "$ctx.install"] }, null] }] };
      const [out] = await events.aggregate<{ total: Array<{ n: number }>; rows: Array<Omit<AnonymousRow, "firstAt" | "lastAt"> & { _id: string; firstAt: Date; lastAt: Date }> }>([
        { $match: { name: { $in: [...ANONYMOUS_EVENTS] }, at: { $gte: new Date(since), $lt: new Date(until) }, accountId: null } },
        { $sort: { at: 1 } },
        { $group: { _id: key, visitor: { $first: "$ctx.visitor" }, firstAt: { $min: "$at" }, lastAt: { $max: "$at" }, events: { $sum: 1 }, country: { $last: "$ctx.country" }, city: { $last: "$ctx.city" },
          device: { $last: "$ctx.device" }, os: { $last: "$ctx.os" }, browser: { $last: "$ctx.browser" }, platform: { $last: "$ctx.app.platform" }, appVersion: { $last: "$ctx.app.version" } } },
        { $match: { _id: { $type: "string" } } },
        { $facet: { total: [{ $count: "n" }], rows: [...(options.before === undefined ? [] : [{ $match: { lastAt: { $lt: new Date(options.before) } } }]), { $sort: { lastAt: -1, _id: 1 } }, { $limit: options.limit }] } },
      ], { maxTimeMS: READ_TIMEOUT_MS, allowDiskUse: true }).toArray();
      return { total: out?.total[0]?.n ?? 0, rows: (out?.rows ?? []).map(row => ({ key: row._id, kind: (row as { visitor?: string | null }).visitor ? "visitor" as const : "install" as const,
        firstAt: row.firstAt.getTime(), lastAt: row.lastAt.getTime(), events: row.events, country: row.country ?? null, city: row.city ?? null, device: row.device ?? null, os: row.os ?? null,
        browser: row.browser ?? null, platform: row.platform ?? null, appVersion: row.appVersion ?? null })) };
    },
    async fleet(since, until) {
      const [out] = await events.aggregate<{ installs: Array<{ _id: string; n: number }>; errors: Array<{ _id: string; n: number }> }>([
        { $match: { name: { $in: ["app_open", "app_error"] }, at: { $gte: new Date(since), $lt: new Date(until) }, "ctx.app.version": { $type: "string" } } },
        { $project: { name: 1, at: 1, install: "$ctx.install", version: "$ctx.app.version" } },
        { $facet: {
          installs: [{ $match: { name: "app_open", install: { $type: "string" } } }, { $sort: { at: 1 } }, { $group: { _id: "$install", version: { $last: "$version" } } }, { $group: { _id: "$version", n: { $sum: 1 } } }],
          errors: [{ $match: { name: "app_error" } }, { $group: { _id: "$version", n: { $sum: 1 } } }],
        } },
      ], { maxTimeMS: READ_TIMEOUT_MS, allowDiskUse: true }).toArray();
      const installs = new Map((out?.installs ?? []).map(row => [row._id, row.n])), errors = new Map((out?.errors ?? []).map(row => [row._id, row.n]));
      return [...new Set([...installs.keys(), ...errors.keys()])].filter(version => /^\d+\.\d+\.\d+$/.test(version))
        .map(version => ({ version, installs: installs.get(version) ?? 0, errors: errors.get(version) ?? 0 }))
        .sort((a, b) => { const x = a.version.split(".").map(Number), y = b.version.split(".").map(Number); return (y[0]! - x[0]!) || (y[1]! - x[1]!) || (y[2]! - x[2]!); });
    },
    async health() {
      const started = performance.now();
      try { await db.command({ ping: 1 }); return { ok: true, detail: "mongodb", latencyMs: Math.round(performance.now() - started) }; } catch { return { ok: false, detail: "mongodb ping failed", latencyMs: null }; }
    },
    async count(since, until, names) {
      return events.countDocuments({ at: { $gte: new Date(since), $lt: new Date(until) }, name: { $in: [...names] } }, { maxTimeMS: READ_TIMEOUT_MS });
    },
    async oldest() {
      const [doc] = await events.find({}, { projection: { at: 1 } }).sort({ at: 1 }).limit(1).toArray();
      return doc ? doc.at.getTime() : null;
    },
    listen(fn) { listeners.push(fn); },
    rollupScope: () => ({ key, sink, hidden: null, drops: null }),
  };
  return sink;
}
