import type { Db } from "mongodb";

export interface WaitlistEntry { email: string; position: number; createdAt: number; source: string | null; ref: string | null }
/** madani.waitlist, written by the madani.bot site; this service only reads it */
export interface WaitlistSource {
  count(): Promise<number>;
  list(query: { search?: string; limit: number; offset: number }): Promise<{ total: number; entries: WaitlistEntry[] }>;
  byDay(since: number): Promise<Array<{ day: string; count: number }>>;
  all(): Promise<WaitlistEntry[]>;
}
export interface BrevoStatus { state: "not_configured" | "synced" | "behind" | "error"; listCount: number | null; waitlistCount: number | null; checkedAt: number | null }

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);

export function memoryWaitlist(entries: WaitlistEntry[] = []): WaitlistSource & { entries: WaitlistEntry[] } {
  const sorted = () => [...entries].sort((a, b) => b.position - a.position);
  return {
    entries,
    async count() { return entries.length; },
    async list({ search, limit, offset }) {
      const needle = search?.trim().toLowerCase();
      const found = sorted().filter(entry => !needle || entry.email.includes(needle) || (entry.source ?? "").includes(needle));
      return { total: found.length, entries: found.slice(offset, offset + limit) };
    },
    async byDay(since) {
      const by = new Map<string, number>();
      for (const entry of entries) if (entry.createdAt >= since) by.set(dayKey(entry.createdAt), (by.get(dayKey(entry.createdAt)) ?? 0) + 1);
      return [...by].map(([day, count]) => ({ day, count }));
    },
    async all() { return sorted(); },
  };
}

type WaitlistDoc = { email: string; position: number; createdAt: Date; source?: string | null; ref?: string | null };
export function mongoWaitlist(db: Db): WaitlistSource {
  const list = db.collection<WaitlistDoc>("waitlist");
  const toEntry = (doc: WaitlistDoc): WaitlistEntry => ({ email: doc.email, position: doc.position, createdAt: doc.createdAt instanceof Date ? doc.createdAt.getTime() : 0, source: doc.source ?? null, ref: doc.ref ?? null });
  const projection = { _id: 0, email: 1, position: 1, createdAt: 1, source: 1, ref: 1 };
  return {
    count: () => list.countDocuments({}),
    async list({ search, limit, offset }) {
      const needle = search?.trim().toLowerCase();
      const filter = needle ? { $or: [{ email: { $regex: escape(needle), $options: "i" } }, { source: { $regex: escape(needle), $options: "i" } }] } : {};
      const [total, docs] = await Promise.all([list.countDocuments(filter), list.find(filter, { projection }).sort({ position: -1 }).skip(offset).limit(limit).toArray()]);
      return { total, entries: docs.map(toEntry) };
    },
    async byDay(since) {
      const rows = await list.aggregate<{ _id: string; count: number }>([{ $match: { createdAt: { $gte: new Date(since) } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, count: { $sum: 1 } } }]).toArray();
      return rows.map(row => ({ day: row._id, count: row.count }));
    },
    async all() { return (await list.find({}, { projection }).sort({ position: -1 }).toArray()).map(toEntry); },
  };
}

/** compares the Brevo contact list's size with the waitlist's; the site adds each signup to that list */
export function brevoChecker(options: { apiKey?: string; listId?: string; fetch?: typeof fetch; now?: () => number; ttlMs?: number }) {
  const now = options.now ?? Date.now, ttl = options.ttlMs ?? 300_000;
  let cached: BrevoStatus | null = null;
  return async (waitlistCount: number): Promise<BrevoStatus> => {
    if (!options.apiKey || !options.listId || !/^\d{1,10}$/.test(options.listId)) return { state: "not_configured", listCount: null, waitlistCount, checkedAt: null };
    if (cached && cached.checkedAt !== null && now() - cached.checkedAt < ttl) return { ...cached, waitlistCount, state: cached.state === "error" ? "error" : cached.listCount! >= waitlistCount ? "synced" : "behind" };
    try {
      const res = await (options.fetch ?? fetch)(`https://api.brevo.com/v3/contacts/lists/${options.listId}`, { headers: { "api-key": options.apiKey, accept: "application/json" }, signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error();
      const data = await res.json() as { totalSubscribers?: number; uniqueSubscribers?: number };
      const listCount = Number(data.uniqueSubscribers ?? data.totalSubscribers);
      if (!Number.isFinite(listCount)) throw new Error();
      cached = { state: listCount >= waitlistCount ? "synced" : "behind", listCount, waitlistCount, checkedAt: now() };
    } catch {
      cached = { state: "error", listCount: null, waitlistCount, checkedAt: now() };
    }
    return cached;
  };
}

/** one CSV field: quoted, and a leading formula character neutralised so a spreadsheet never runs it */
export function csvField(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, "\"\"")}"`;
}
export function waitlistCsv(entries: WaitlistEntry[]): string {
  const rows = entries.map(entry => [entry.position, entry.email, new Date(entry.createdAt).toISOString(), entry.source, entry.ref].map(csvField).join(","));
  return `${["position", "email", "joined", "source", "ref"].map(csvField).join(",")}\n${rows.join("\n")}${rows.length ? "\n" : ""}`;
}
