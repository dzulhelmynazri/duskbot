// the lean admin api (docs/admin-api.md): overview, people, one person, payments. every answer is computed by the
// database or from small in-memory directories; none of them loads the raw event log.
import type { Account, Identity, Session } from "../auth/store.ts";
import { identityOf } from "../analytics/web.ts";
import type { AnalyticsSink } from "../analytics/sink.ts";
import { DAY, dayRange, perDay } from "./metrics.ts";
import { accountIdentity, anonymousIdentity, type PersonIdentity } from "./identity.ts";
import { ledgerOf, moneyOf, paymentsAnswer, totalsOf, type Money } from "./payments.ts";
import type { MoneyMode, MoneyView } from "./money-mode.ts";

export class V2Error extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
const bad = (message = "Invalid request.") => new V2Error(400, "invalid_request", message);
const int = (value: string | null, fallback: number, min: number, max: number) => {
  const n = value === null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw bad();
  return n;
};

/** the data one request reads: this service's, or the live service's read only (preview's admin reading madani.bot) */
export interface V2Source {
  /** "own", or the live service's label ("madani.bot") */
  data: string;
  /** without test accounts' and harness events unless the panel asked for them */
  sink: AnalyticsSink;
  accounts: readonly Account[];
  identities: ReadonlyArray<Pick<Identity, "accountId" | "provider" | "label" | "email">>;
  /** this service's sessions; the live service's are not read */
  sessions: ReadonlyArray<Pick<Session, "accountId" | "lastSeenAt" | "kind">>;
  money: Money;
  /** the mode of money records without a stamp: this service's provider mode, live for the live service */
  serverMode: MoneyMode;
  reviewEmail: string | null;
  waitlistCount(): Promise<number | null>;
  /** the existing person page (timeline, sessions, sources), keyed acct_…, a visitor id or install:<id> */
  profile(id: string): Promise<unknown>;
}

export const SITE_VISIT_EVENTS = ["site_view"] as const;
const ACTIVATION_EVENTS = ["onboarding_done", "app_paired", "first_bot_reply"];
const PERSON_ID = /^(?:acct_[A-Za-z0-9_-]{8,80}|install:[A-Za-z0-9_-]{8,80}|[A-Za-z0-9_-]{8,80})$/;

function identities(source: V2Source) {
  const byAccount = new Map<string, Array<V2Source["identities"][number]>>();
  for (const row of source.identities) (byAccount.get(row.accountId) ?? byAccount.set(row.accountId, []).get(row.accountId)!).push(row);
  const accounts = new Map(source.accounts.map(account => [account.id, account]));
  const cache = new Map<string, PersonIdentity>();
  return (id: string): PersonIdentity => {
    const hit = cache.get(id);
    if (hit) return hit;
    const account = accounts.get(id);
    // a payer whose account is gone keeps its id; the checkout email names it
    const gone = (): PersonIdentity => {
      const email = source.money.checkouts.find(row => row.accountId === id)?.email ?? source.money.customers.find(row => row.accountId === id)?.email ?? null;
      return { ...accountIdentity({ id, email: email ?? "", name: null }, [], source.reviewEmail), label: "deleted account" };
    };
    const out = account ? accountIdentity(account, byAccount.get(id) ?? [], source.reviewEmail) : id.startsWith("acct_") ? gone()
      : anonymousIdentity({ key: id, kind: id.startsWith("install:") ? "install" : "visitor", city: null, country: null, device: null, os: null, platform: null });
    cache.set(id, out);
    return out;
  };
}
const accountMap = (accounts: readonly Account[]) => new Map(accounts.map(account => [account.id, { email: account.email, createdAt: account.createdAt, name: account.name }]));

export async function overviewV2(source: V2Source, url: URL, now: number) {
  const days = int(url.searchParams.get("days"), 30, 1, 400);
  const range = dayRange(now, days), from = Date.parse(`${range[0]}T00:00:00Z`);
  const [visitors, daily, activated, waitlist, anonymous, seen] = await Promise.all([
    source.sink.visitorCount(from, now + 60_000, SITE_VISIT_EVENTS), source.sink.daily(["site_visitors", "site_view"], range[0]!, range.at(-1)!),
    source.sink.accounts(ACTIVATION_EVENTS, from), source.waitlistCount(), source.sink.anonymous(from, now + 60_000, { limit: 1 }), source.sink.lastSeen(now - 7 * DAY)]);
  const signups = source.accounts.filter(account => account.createdAt >= from);
  const live = moneyOf(source.money, "live", source.serverMode), test = moneyOf(source.money, "test", source.serverMode);
  const totals = { live: totalsOf(live, accountMap(source.accounts), "live", now), test: totalsOf(test, accountMap(source.accounts), "test", now) };
  const ids = new Set(source.accounts.map(account => account.id));
  const signedUp = new Set(signups.map(account => account.id));
  const activatedNew = [...activated].filter(id => signedUp.has(id)).length;
  const payingIds = new Set(ledgerOf(live, "live").people.filter(row => row.netCents > 0 || row.mrrCents > 0).map(row => row.personId));
  const signupDays = new Map<string, number>();
  for (const account of signups) { const day = new Date(account.createdAt).toISOString().slice(0, 10); signupDays.set(day, (signupDays.get(day) ?? 0) + 1); }
  const series = (name: string) => perDay(range, daily.filter(row => row.name === name));
  return {
    data: source.data, now, days, from, range,
    visitors: { unique: visitors, perDay: series("site_visitors"), views: series("site_view") },
    signups: { total: signups.length, perDay: perDay(range, [...signupDays].map(([day, count]) => ({ day, count }))) },
    accounts: { total: source.accounts.length, active7d: [...seen.keys()].filter(id => ids.has(id)).length, activated: [...activated].filter(id => ids.has(id)).length },
    anonymous: { total: anonymous.total },
    paying: { live: totals.live.customers, test: totals.test.customers },
    revenue: totals,
    waitlist,
    funnel: [
      { id: "visited", label: "visited the site", count: visitors },
      { id: "signed_up", label: "signed up", count: signups.length },
      { id: "activated", label: "set up the app or a bot", count: activatedNew },
      { id: "paying", label: "paying (live)", count: signups.filter(account => payingIds.has(account.id)).length },
    ],
  };
}

export async function peopleV2(source: V2Source, url: URL, now: number, money: MoneyView) {
  const kind = url.searchParams.get("kind") ?? "accounts";
  if (kind !== "accounts" && kind !== "anonymous") throw bad("kind is accounts or anonymous.");
  const limit = int(url.searchParams.get("limit"), 50, 1, 200), q = (url.searchParams.get("q") ?? "").trim().toLowerCase().slice(0, 100);
  const who = identities(source);
  const idents = await source.sink.scan(0, now + 60_000, ["identify"]);
  const links = identityOf(idents);
  if (kind === "anonymous") {
    const days = int(url.searchParams.get("days"), 30, 1, 400), before = url.searchParams.get("before");
    const answer = await source.sink.anonymous(now - days * DAY, now + 60_000, { limit: limit * 2 + 20, ...(before ? { before: int(before, now, 0, Number.MAX_SAFE_INTEGER) } : {}) });
    // a visitor or install that later signed in is that account's row, not an anonymous one
    const rows = answer.rows.filter(row => !links.accountOf.has(row.key)).map(row => ({ person: anonymousIdentity(row), firstSeenAt: row.firstAt, lastSeenAt: row.lastAt, events: row.events,
      country: row.country, city: row.city, device: row.device, os: row.os, browser: row.browser, platform: row.platform, appVersion: row.appVersion }))
      .filter(row => !q || row.person.name.toLowerCase().includes(q) || row.person.id.toLowerCase().includes(q));
    const page = rows.slice(0, limit);
    return { data: source.data, kind, total: answer.total, people: page, next: answer.rows.length > page.length && page.length ? String(page.at(-1)!.lastSeenAt) : null };
  }
  const offset = int(url.searchParams.get("cursor"), 0, 0, 10_000_000);
  const seen = await source.sink.lastSeen(now - 400 * DAY);
  for (const session of source.sessions) if ((seen.get(session.accountId) ?? 0) < session.lastSeenAt) seen.set(session.accountId, session.lastSeenAt);
  const view = money === "all" ? null : money;
  const ledger = ledgerOf(moneyOf(source.money, view ?? "live", source.serverMode), view ?? "live");
  const paid = new Map(ledger.people.map(row => [row.personId, row]));
  const rows = source.accounts.map(account => {
    const person = who(account.id), pay = paid.get(account.id) ?? null;
    return { person, createdAt: account.createdAt, lastSeenAt: seen.get(account.id) ?? null, onboarded: !!account.onboardedAt,
      installs: links.installsOf.get(account.id)?.size ?? 0, visitors: links.visitorsOf.get(account.id)?.size ?? 0,
      devices: source.sessions.filter(session => session.accountId === account.id && session.kind !== "web").length,
      plan: pay?.plan ?? null, planStatus: pay?.status ?? null, paidCents: pay?.netCents ?? 0, mrrCents: pay?.mrrCents ?? 0, currency: pay?.currency ?? "USD", lastPaidAt: pay?.lastPaidAt ?? null };
  }).filter(row => !q || [row.person.id, row.person.name, row.person.email, ...row.person.providers].some(value => value?.toLowerCase().includes(q)))
    .sort((a, b) => (b.lastSeenAt ?? b.createdAt) - (a.lastSeenAt ?? a.createdAt) || a.person.id.localeCompare(b.person.id));
  const page = rows.slice(offset, offset + limit);
  return { data: source.data, kind, money: view ?? "live", total: rows.length, people: page, next: offset + limit < rows.length ? String(offset + limit) : null };
}

export async function personV2(source: V2Source, id: string) {
  if (!PERSON_ID.test(id)) throw bad("Invalid person.");
  const who = identities(source);
  const profile = await source.profile(id) as { account?: { id: string } | null };
  const accountId = profile.account?.id ?? (id.startsWith("acct_") ? id : null);
  const person = who(accountId ?? id);
  const money = Object.fromEntries((["live", "test"] as const).map(mode => {
    const ledger = ledgerOf(moneyOf(source.money, mode, source.serverMode), mode);
    return [mode, accountId ? { summary: ledger.people.find(row => row.personId === accountId) ?? null, payments: ledger.payments.filter(row => row.personId === accountId),
      subscriptions: ledger.subscriptions.filter(row => row.personId === accountId) } : { summary: null, payments: [], subscriptions: [] }];
  }));
  return { data: source.data, person, money, profile };
}

export function paymentsV2(source: V2Source, url: URL, now: number) {
  const asked = url.searchParams.get("mode") ?? "live";
  if (asked !== "live" && asked !== "test" && asked !== "all") throw bad("mode is live, test or all.");
  const status = url.searchParams.get("status");
  if (status !== null && !["paid", "refunded", "partially_refunded", "failed"].includes(status)) throw bad("Invalid status.");
  const before = url.searchParams.get("before");
  if (before !== null && !/^\d{1,16}:[A-Za-z0-9_:-]{1,120}$/.test(before)) throw bad("Invalid cursor.");
  return paymentsAnswer({ state: source.money, serverMode: source.serverMode, mode: asked, data: source.data, now, accounts: accountMap(source.accounts), identity: identities(source),
    q: (url.searchParams.get("q") ?? "").slice(0, 100), status, before, limit: int(url.searchParams.get("limit"), 50, 1, 200) });
}
