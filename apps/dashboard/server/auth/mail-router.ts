import type { Db } from "mongodb";
import { isTestAddress, MailDeliveryError, type Mailer, type MailMessage } from "./mail.ts";

/** which provider sends what: transactional mail (codes, receipts, cloud ready) through resend, which adds no tracking and
 *  no list-unsubscribe, so gmail files it in primary; everything else through brevo. each provider has a daily and a
 *  monthly cap counted here (mongodb in production, per service); at a cap, or when resend fails, the other one sends */
export type MailProviderId = "resend" | "brevo";
export const MAIL_PROVIDERS: readonly MailProviderId[] = ["resend", "brevo"];
export interface MailCaps { daily: number; monthly: number }
/** resend's free tier (3,000 a month, 100 a day) and brevo's plan as the owner budgets it */
export const DEFAULT_MAIL_CAPS: Record<MailProviderId, MailCaps> = { resend: { daily: 100, monthly: 3_000 }, brevo: { daily: 300, monthly: 10_000 } };

const positive = (value: string | undefined, fallback: number) => { const n = Number(value); return Number.isSafeInteger(n) && n > 0 ? n : fallback; };
/** MADANI_RESEND_DAILY_LIMIT, MADANI_RESEND_MONTHLY_LIMIT, MADANI_BREVO_DAILY_LIMIT, MADANI_BREVO_MONTHLY_LIMIT */
export function mailCapsFromEnv(env: NodeJS.ProcessEnv): Record<MailProviderId, MailCaps> {
  return {
    resend: { daily: positive(env.MADANI_RESEND_DAILY_LIMIT, DEFAULT_MAIL_CAPS.resend.daily), monthly: positive(env.MADANI_RESEND_MONTHLY_LIMIT, DEFAULT_MAIL_CAPS.resend.monthly) },
    brevo: { daily: positive(env.MADANI_BREVO_DAILY_LIMIT, DEFAULT_MAIL_CAPS.brevo.daily), monthly: positive(env.MADANI_BREVO_MONTHLY_LIMIT, DEFAULT_MAIL_CAPS.brevo.monthly) },
  };
}

export interface MailProviderUsage {
  provider: MailProviderId; configured: boolean; caps: MailCaps;
  today: { sent: number; fallbacks: number }; month: { sent: number; fallbacks: number };
  lastError: { at: number; reason: string } | null;
}
export interface MailUsage { day: string; month: string; providers: MailProviderUsage[] }
/** the counts behind the caps. `fallbacks` sit on the provider that was passed over */
export interface MailUsageStore {
  /** counts one send if both of the provider's counts stay within the caps; false when either is full */
  reserve(provider: MailProviderId, day: string, caps: MailCaps): Promise<boolean>;
  /** takes a reserved send back when the provider refused it */
  release(provider: MailProviderId, day: string): Promise<void>;
  fallback(provider: MailProviderId, day: string): Promise<void>;
  error(provider: MailProviderId, at: number, reason: string): Promise<void>;
  read(provider: MailProviderId, day: string): Promise<Omit<MailProviderUsage, "provider" | "configured" | "caps">>;
}

const monthOf = (day: string) => day.slice(0, 7);
const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);

export function memoryMailUsage(): MailUsageStore {
  const counts = new Map<string, { sent: number; fallbacks: number }>(), errors = new Map<MailProviderId, { at: number; reason: string }>();
  const row = (key: string) => { let r = counts.get(key); if (!r) counts.set(key, r = { sent: 0, fallbacks: 0 }); return r; };
  return {
    async reserve(provider, day, caps) {
      const d = row(`${provider}:${day}`), m = row(`${provider}:${monthOf(day)}`);
      if (d.sent >= caps.daily || m.sent >= caps.monthly) return false;
      d.sent++; m.sent++;
      return true;
    },
    async release(provider, day) { row(`${provider}:${day}`).sent--; row(`${provider}:${monthOf(day)}`).sent--; },
    async fallback(provider, day) { row(`${provider}:${day}`).fallbacks++; row(`${provider}:${monthOf(day)}`).fallbacks++; },
    async error(provider, at, reason) { errors.set(provider, { at, reason }); },
    async read(provider, day) {
      return { today: { ...row(`${provider}:${day}`) }, month: { ...row(`${provider}:${monthOf(day)}`) }, lastError: errors.get(provider) ?? null };
    },
  };
}

interface UsageDoc { _id: string; provider: MailProviderId; period: "day" | "month" | "error"; sent?: number; fallbacks?: number; at?: number; reason?: string }
/** mail_usage: one document per provider per day ("resend:2026-11-14"), one per month ("resend:2026-11") and the last
 *  error ("resend:error"); every write is one $inc or $set on its _id, so two sends never lose a count */
export async function mongoMailUsage(db: Db): Promise<MailUsageStore> {
  const usage = db.collection<UsageDoc>("mail_usage");
  const bump = (provider: MailProviderId, day: string, field: "sent" | "fallbacks", by: number) => Promise.all([
    usage.findOneAndUpdate({ _id: `${provider}:${day}` }, { $inc: { [field]: by }, $setOnInsert: { provider, period: "day" } }, { upsert: true, returnDocument: "after" }),
    usage.findOneAndUpdate({ _id: `${provider}:${monthOf(day)}` }, { $inc: { [field]: by }, $setOnInsert: { provider, period: "month" } }, { upsert: true, returnDocument: "after" }),
  ]);
  return {
    async reserve(provider, day, caps) {
      // count first, then check: two sends at the edge can't both slip under the cap
      const [d, m] = await bump(provider, day, "sent", 1);
      if ((d?.sent ?? 0) <= caps.daily && (m?.sent ?? 0) <= caps.monthly) return true;
      await bump(provider, day, "sent", -1);
      return false;
    },
    async release(provider, day) { await bump(provider, day, "sent", -1); },
    async fallback(provider, day) { await bump(provider, day, "fallbacks", 1); },
    async error(provider, at, reason) {
      await usage.updateOne({ _id: `${provider}:error` }, { $set: { provider, period: "error", at, reason } }, { upsert: true });
    },
    async read(provider, day) {
      const docs = await usage.find({ _id: { $in: [`${provider}:${day}`, `${provider}:${monthOf(day)}`, `${provider}:error`] } }).toArray();
      const of = (id: string) => docs.find(doc => doc._id === id);
      const d = of(`${provider}:${day}`), m = of(`${provider}:${monthOf(day)}`), e = of(`${provider}:error`);
      return { today: { sent: d?.sent ?? 0, fallbacks: d?.fallbacks ?? 0 }, month: { sent: m?.sent ?? 0, fallbacks: m?.fallbacks ?? 0 },
        lastError: e?.at && e.reason ? { at: e.at, reason: e.reason } : null };
    },
  };
}

/** resend's failures that another provider can fix: no answer, rate or quota limits (429), its outages (5xx) and a key it
 *  refuses (401, 403). a 400 or 422 is the message itself and would fail anywhere */
export const worthAnotherTry = (error: unknown) =>
  error instanceof MailDeliveryError && (error.status === null || error.status === 429 || error.status >= 500 || error.status === 401 || error.status === 403);

export interface RoutedMailer extends Mailer {
  /** this service's counts against each provider's caps, for admin ops */
  usage(): Promise<MailUsage>;
  /** a sender that uses only this provider, within its caps (incident mail's second try) */
  only(provider: MailProviderId): Mailer | null;
}
export function createMailRouter(options: {
  providers: Partial<Record<MailProviderId, Mailer | null>>; caps: Record<MailProviderId, MailCaps>; usage: MailUsageStore;
  now?: () => number; log?: (line: string) => void;
}): RoutedMailer {
  const now = options.now ?? Date.now, log = options.log ?? (line => console.warn(line));
  const configured = (id: MailProviderId) => !!options.providers[id];
  if (!MAIL_PROVIDERS.some(configured)) throw new Error("The mail router needs resend or brevo.");
  // counting never stops an email: a store that can't answer lets the send through
  const quiet = <T,>(work: Promise<T>, fallback: T) => work.catch(() => fallback);

  async function attempt(id: MailProviderId, message: MailMessage, day: string): Promise<"sent" | "capped"> {
    if (!await quiet(options.usage.reserve(id, day, options.caps[id]), true)) return "capped";
    try {
      await options.providers[id]!.send(message);
      return "sent";
    } catch (error) {
      const reason = error instanceof MailDeliveryError ? error.reason : "failed";
      await Promise.all([quiet(options.usage.release(id, day), undefined), quiet(options.usage.error(id, now(), reason), undefined)]);
      throw error;
    }
  }

  async function deliver(order: MailProviderId[], message: MailMessage, fallbackOnError: boolean) {
    // harness addresses (@qa.madani.test, qa*@madani.bot) never reach a provider, whatever sends to them
    if (isTestAddress(message.to)) return;
    const day = dayOf(now()), [first, second] = order.filter(configured);
    let why: string;
    try {
      if (await attempt(first!, message, day) === "sent") return;
      why = `${first} is at its cap`;
      if (!second) throw new MailDeliveryError(null, `${first} at its cap`);
    } catch (error) {
      if (!second || !fallbackOnError || !worthAnotherTry(error)) throw error instanceof MailDeliveryError ? error : new MailDeliveryError(null, "failed");
      why = `${first} failed (${(error as MailDeliveryError).reason})`;
    }
    await quiet(options.usage.fallback(first!, day), undefined);
    log(`mail: ${why}, so "${message.subject.replace(/\d{6,}/g, "<code>")}" went through ${second}`);
    if (await attempt(second, message, day) === "capped") throw new MailDeliveryError(null, `${first} and ${second} at their caps`);
  }

  return {
    // transactional: resend, then brevo when resend is full or failing. everything else: brevo, then resend only at brevo's cap
    send: message => message.transactional ? deliver(["resend", "brevo"], message, true) : deliver(["brevo", "resend"], message, false),
    only: id => configured(id) ? { send: message => deliver([id], message, false) } : null,
    async usage() {
      const day = dayOf(now());
      const providers = await Promise.all(MAIL_PROVIDERS.map(async provider => ({ provider, configured: configured(provider), caps: options.caps[provider],
        ...await options.usage.read(provider, day) })));
      return { day, month: monthOf(day), providers };
    },
  };
}
