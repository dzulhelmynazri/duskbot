import { randomBytes } from "node:crypto";
import type { Mailer, MailMessage } from "../auth/mail.ts";
import type { EmailConfig } from "../email/layout.ts";
import { clientText, fingerprint, isClientSource, maskText, routeOf, shortStack, stackFrames } from "./fingerprint.ts";
import type { IncidentSource } from "./fingerprint.ts";
import { incidentEmail } from "./email.ts";
import type { IncidentMailKind } from "./email.ts";
import type { Incident, IncidentSample, IncidentStore } from "./store.ts";

/** A failure as one masked line: its name and what it said, never a connection string or an address. */
const failure = (error: unknown) => (error instanceof Error ? `${error.name}: ${maskText(error.message, 160)}` : maskText(error, 160));

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
/** the throttle rules; docs/LAUNCH.md "alerts" repeats them for the owner */
export const RULES = {
  /** a new problem is mailed this long after it is first seen, so a burst of new problems shares one email */
  fastMs: 20_000,
  /** a problem is open until it has been quiet this long; while open it is mailed once and repeats only count */
  reopenAfterMs: 7 * DAY,
  /** alert emails per utc day, the daily email aside; past it new problems wait for the daily email */
  mailsPerDay: 10,
  /** of those, emails started by a client error (the public /v1/errors) */
  clientMailsPerDay: 3,
  /** new client fingerprints tracked per hour; past it they fold into one "too many client errors" incident */
  newClientPerHour: 100,
  /** fingerprints kept in memory */
  tracked: 1000,
  /** the daily email's hour, utc; it is sent only when a problem was never mailed (held back by the caps) */
  dailyHourUtc: 8,
  /** a failed alert email is retried each minute for this long */
  retryMs: HOUR,
} as const;

export interface IncidentInput {
  source: IncidentSource;
  name?: string;
  message?: string;
  stack?: string | null;
  /** a fixed fingerprint for lines that carry no stack */
  key?: string;
  route?: string | null;
  status?: number | null;
  requestId?: string | null;
  version?: string | null;
  os?: string | null;
  path?: string | null;
  at?: number;
}

export interface IncidentsOptions {
  env: string;
  store: IncidentStore;
  /** where the alert emails go; empty sends none */
  to: () => string[];
  /** tried in order: the second is the fallback when the first refuses */
  mailers: Mailer[];
  email: EmailConfig;
  panelUrl: string;
  /** false records incidents but sends no email (MADANI_ALERTS=off, or development) */
  mail: boolean;
  now?: () => number;
  /** off in tests, which call tick() themselves */
  timers?: boolean;
  log?: (line: string) => void;
}

interface Entry { incident: Incident; unsaved: number; fast: boolean; client: boolean }
interface Outgoing { message: Omit<MailMessage, "to">; to: string[]; until: number }

export function createIncidents(options: IncidentsOptions) {
  const now = options.now ?? Date.now, store = options.store;
  const log = options.log ?? ((line: string) => console.warn(`incidents: ${line}`));
  const entries = new Map<string, Entry>();
  const newClient: number[] = [];
  const outbox: Outgoing[] = [];
  const today = { day: -1, mails: 0, clientMails: 0, heldBack: 0 };
  let fastTimer: ReturnType<typeof setTimeout> | null = null;
  let saving: Promise<void> | null = null, closed = false;
  const stats = { reported: 0, mailed: 0, mailFailed: 0, dropped: 0, heldBack: 0 };

  const dayOf = (at: number) => Math.floor(at / DAY);
  const muted = (incident: Incident) => incident.mutedUntil !== null && incident.mutedUntil > now();
  // only what needs the owner now emails: the server itself failing. client and desktop errors and new problem groups
  // stay in the admin panel (the owner asked for urgent mail only, 2026-11-17)
  const urgent = (incident: Pick<Incident, "source" | "name">) => !isClientSource(incident.source) && incident.name !== "NewProblemGroup";
  function count() { const day = dayOf(now()); if (today.day !== day) Object.assign(today, { day, mails: 0, clientMails: 0 }); return today; }
  function within(list: number[], ms: number) { const time = now(); while (list.length && list[0]! <= time - ms) list.shift(); return list.length; }

  function sample(input: IncidentInput, at: number): IncidentSample {
    const client = isClientSource(input.source);
    const text = client ? clientText : (value: unknown) => maskText(value);
    const name = /^[A-Za-z_$][\w$ .:-]{0,60}$/.test(input.name ?? "") ? input.name! : "Error";
    const frames = stackFrames(`${name}\n${input.stack ?? ""}`);
    const route = routeOf(input.route);
    const message = text(input.message ?? "");
    const id = input.key ? fingerprint({ source: input.source, name, message: "", key: input.key, frames: [], route })
      : fingerprint({ source: input.source, name, message, frames, route });
    const short = (value: string | null | undefined, max: number) => value ? maskText(value, max).replace(/[^\w ./:+()-]/g, "") || null : null;
    return { id, env: options.env, source: input.source, name, message, route, status: input.status ?? null, stack: shortStack(frames),
      version: short(input.version, 40), os: short(input.os, 40), path: input.path ? routeOf(input.path) : null,
      requestId: input.requestId && /^[\w-]{4,64}$/.test(input.requestId) ? input.requestId : null, lastSeen: at };
  }

  /** counts one sighting; only a problem that is not open yet can lead to an email. never throws and never waits */
  function report(input: IncidentInput): string | null {
    try {
      if (closed) return null;
      const at = input.at ?? now();
      const client = isClientSource(input.source);
      let fields = sample(input, at);
      let entry = entries.get(fields.id);
      if (!entry && client) {
        if (within(newClient, HOUR) >= RULES.newClientPerHour) {
          stats.dropped++;
          fields = sample({ source: input.source, name: "TooManyClientErrors", key: "overflow", message: `more than ${RULES.newClientPerHour} different client errors in an hour; the rest are counted here` }, at);
          entry = entries.get(fields.id);
        } else newClient.push(now());
      }
      stats.reported++;
      if (!entry) {
        if (entries.size >= RULES.tracked) evict();
        entry = { incident: { ...fields, count: 0, firstSeen: at, notifiedAt: null, mutedUntil: null }, unsaved: 0, fast: false, client };
        entries.set(fields.id, entry);
      }
      const reopened = entry.incident.count > 0 && at - entry.incident.lastSeen > RULES.reopenAfterMs;
      Object.assign(entry.incident, fields, { count: entry.incident.count + 1 });
      entry.unsaved++;
      if (reopened) { entry.incident.notifiedAt = null; entry.incident.firstSeen = at; }
      if (entry.incident.notifiedAt === null && !entry.fast && !muted(entry.incident) && urgent(entry.incident)) {
        entry.fast = true;
        entry.client = client;
        fastTimer ??= options.timers === false ? null : setTimeout(() => { fastTimer = null; void flushNew(); }, RULES.fastMs);
        fastTimer?.unref?.();
      }
      return fields.id;
    } catch (error) {
      log(`a report was dropped (${error instanceof Error ? error.name : "error"})`);
      return null;
    }
  }

  function evict() {
    const idle = [...entries].filter(([, entry]) => !entry.unsaved && !entry.fast).sort((a, b) => a[1].incident.lastSeen - b[1].incident.lastSeen);
    for (const [id] of idle.slice(0, Math.max(1, Math.floor(RULES.tracked / 10)))) entries.delete(id);
    if (entries.size >= RULES.tracked) entries.delete(entries.keys().next().value!);
  }

  async function send(kind: IncidentMailKind, items: Incident[], extra: { test?: boolean; capped?: boolean; note?: string } = {}): Promise<boolean> {
    const to = options.to();
    if (!options.mail || !to.length || !items.length) return false;
    const message = incidentEmail(options.email, { kind, env: options.env, incidents: items, panelUrl: options.panelUrl, ...extra });
    const job: Outgoing = { message, to, until: now() + RULES.retryMs };
    if (!await deliver(job)) { outbox.push(job); if (outbox.length > 20) outbox.shift(); }
    return true;
  }
  async function deliver(job: Outgoing): Promise<boolean> {
    for (const mailer of options.mailers) {
      try {
        await Promise.all(job.to.map(address => mailer.send({ to: address, ...job.message })));
        stats.mailed++;
        return true;
      } catch { stats.mailFailed++; }
    }
    log(`an alert email failed; it is retried every minute for ${RULES.retryMs / MINUTE} minutes`);
    return false;
  }

  function markMailed(ids: string[]) {
    const at = now();
    for (const id of ids) { const entry = entries.get(id); if (entry) { entry.incident.notifiedAt = at; entry.fast = false; } }
    void save().then(() => store.notified(ids, at)).catch((error: unknown) => log(`could not mark incidents as mailed (${failure(error)})`));
  }

  /** one email for the problems that opened in the last few seconds, within the daily caps; the rest wait for the daily email */
  async function flushNew(): Promise<void> {
    const fresh = [...entries.values()].filter(entry => entry.fast);
    if (!fresh.length) return;
    for (const entry of fresh) entry.fast = false;
    const day = count();
    const client = fresh.every(entry => entry.client);
    if (day.mails >= RULES.mailsPerDay || (client && day.clientMails >= RULES.clientMailsPerDay)) {
      day.heldBack += fresh.length; stats.heldBack += fresh.length;
      return;
    }
    if (!options.mail || !options.to().length) return;
    day.mails++;
    if (client) day.clientMails++;
    if (await send("new", fresh.map(entry => ({ ...entry.incident })))) markMailed(fresh.map(entry => entry.incident.id));
  }

  /** at 08:00 utc, once: the problems of the last day that were never mailed; nothing when there are none */
  async function daily(): Promise<void> {
    const time = now(), midnight = dayOf(time) * DAY;
    if (time < midnight + RULES.dailyHourUtc * HOUR || !options.mail || !options.to().length) return;
    const unmailed = (await store.list({ limit: 200, since: midnight - DAY })).filter(incident => incident.notifiedAt === null && urgent(incident) && !(incident.mutedUntil !== null && incident.mutedUntil > time));
    if (!unmailed.length || !await store.once(`daily|${options.env}|${midnight}`, time + 7 * DAY)) return;
    const capped = today.heldBack > 0;
    today.heldBack = 0;
    if (await send("daily", unmailed, { capped })) markMailed(unmailed.map(incident => incident.id));
  }

  async function save(): Promise<void> {
    if (saving) return saving;
    const dirty = [...entries.values()].filter(entry => entry.unsaved > 0);
    if (!dirty.length) return;
    const batch = dirty.map(entry => ({ sample: { ...entry.incident }, add: entry.unsaved, firstSeen: entry.incident.firstSeen }));
    for (const entry of dirty) entry.unsaved = 0;
    saving = store.record(batch).catch((error: unknown) => {
      for (const [index, entry] of dirty.entries()) entry.unsaved += batch[index]!.add;
      // why, masked: without it nine of these on madani.bot (2026-11-12) said nothing anyone could act on
      log(`incidents could not be saved (${failure(error)}); they are kept in memory and tried again`);
    }).finally(() => { saving = null; });
    return saving;
  }

  async function retry(): Promise<void> {
    const time = now();
    // oxlint-disable-next-line no-useless-spread -- a copy, because the loop splices outbox
    for (const job of [...outbox]) {
      if (job.until < time) { outbox.splice(outbox.indexOf(job), 1); log("an alert email was given up after an hour of retries"); continue; }
      if (await deliver(job)) outbox.splice(outbox.indexOf(job), 1);
    }
  }

  /** once a minute: save, retry, daily email */
  async function tick(): Promise<void> {
    await save();
    await retry();
    await daily().catch(() => log("the daily email failed"));
  }

  /** loads the open problems, so a restart (or a crash loop) does not mail them again */
  async function load(): Promise<void> {
    const recent = await store.list({ limit: RULES.tracked, since: now() - RULES.reopenAfterMs });
    for (const incident of recent) if (!entries.has(incident.id)) entries.set(incident.id, { incident, unsaved: 0, fast: false, client: isClientSource(incident.source) });
  }

  const timer = options.timers === false ? null : setInterval(() => { void tick().catch(() => log("a tick failed")); }, MINUTE);
  timer?.unref?.();

  return {
    report,
    tick,
    flushNew,
    load,
    stats,
    /** an owner's test: a fresh fingerprint each time, mailed at once, outside the daily caps */
    async test(source: "test" | "server" = "test"): Promise<string | null> {
      const nonce = randomBytes(4).toString("hex");
      const id = report({ source, name: "TestAlert", message: `a test alert (${nonce}) fired by the owner`, key: `test-${nonce}`, route: "/v1/admin/incidents/test",
        stack: `TestAlert: test\n    at fireTest (apps/dashboard/server/incidents/routes.ts:1:1)`, requestId: `test-${nonce}` });
      const entry = id ? entries.get(id) : undefined;
      if (!entry) return null;
      entry.fast = false;
      if (await send("new", [{ ...entry.incident }], { test: true })) markMailed([entry.incident.id]);
      return id;
    },
    /** the one "back to normal" email for a problem that was mailed; a second call, or a restart, sends nothing */
    async recovered(id: string, note: string): Promise<boolean> {
      await save();
      const incident = entries.get(id)?.incident ?? (await store.list({ limit: 200, source: "ops" })).find(item => item.id === id);
      if (!incident || incident.notifiedAt === null || muted(incident) || !options.mail || !options.to().length) return false;
      if (!await store.once(`recovered|${id}|${incident.firstSeen}`, now() + 30 * DAY)) return false;
      const day = count();
      if (day.mails >= RULES.mailsPerDay) return false;
      day.mails++;
      return send("recovered", [{ ...incident, lastSeen: now() }], { note });
    },
    async list(query: { limit: number; before?: number; source?: string }) { await save(); return store.list(query); },
    async mute(id: string, until: number | null) {
      await save();
      const found = await store.mute(id, until);
      const entry = entries.get(id);
      if (entry) { entry.incident.mutedUntil = until; if (until !== null) entry.fast = false; }
      return found || !!entry;
    },
    async close() {
      if (fastTimer) clearTimeout(fastTimer);
      if (timer) clearInterval(timer);
      await save().catch(() => {});
      closed = true;
    },
  };
}
export type Incidents = ReturnType<typeof createIncidents>;
