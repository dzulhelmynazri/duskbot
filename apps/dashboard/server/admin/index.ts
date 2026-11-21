import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { createAuth } from "../auth/index.ts";
import type { createBilling } from "../billing/index.ts";
import { BILLING_CONFIG, MANAGED_REGION, regionLabel as labelOfRegion } from "../billing/plans.ts";
import type { StoredCloud } from "../clouds/types.ts";
import type { StoredWorkspace } from "../store.ts";
import type { Analytics } from "../analytics/index.ts";
import type { Usage } from "../analytics/usage.ts";
import { summarize as summarizeUsage, type AdoptionInput } from "../analytics/usage-summary.ts";
import { moreFocus, moreOf } from "../analytics/usage-more.ts";
import { FEEDBACK_KINDS, allRecords, feedbackAnswer } from "../analytics/feedback.ts";
/** the app and account events the deeper usage questions read */
const MORE_EVENTS = ["app_action", "app_open", "app_close", "app_error", "app_feature", "onboarding_step", "onboarding_done", "page_view", "site_view", "cloud_state"] as const;
import { EVENTS, EVENT_NAMES, isEventName } from "../analytics/events.ts";
import { keepPartial, partialOf, type AnalyticsSink, type StoredEvent } from "../analytics/sink.ts";
import type { LiveData } from "./live.ts";
import { brevoChecker, waitlistCsv, type WaitlistSource } from "./waitlist.ts";
import { healthTargets, newestBackup, probe, spoolCount, type ErrorCounter } from "./health.ts";
import { AnalyticsRouteError, createAnalyticsRoutes } from "./analytics-routes.ts";
import { BillingError } from "../billing/service.ts";
import { PlanError, createPlanEditor } from "./plans.ts";
import { marginReport, type InfraStore } from "./infra.ts";
import { RelayError, createRelays } from "./ops/relays.ts";
import { SHARING_LOOKBACK_DAYS, sharingOf } from "./sharing.ts";
import { EXPERIENCE_EVENTS, experienceAnswer, itemsOf, timelineAnswer } from "./experience.ts";
import { isRange, rangeDays, topAccounts } from "./ops/accounts.ts";
import { ACCOUNT_NOTES, type AccountNotes } from "./ops/index.ts";
import type { OpsAccountsAnswer, OpsAccountsRange, OpsRelayCard } from "../../src/admin/ops-types.ts";
import { isTestEvent, isTestInstall, testAccountIds, testBuyerIds, withoutAccounts, withoutBilling } from "./test-accounts.ts";
import { moneyIn, moneyViewOf, withoutOps, type MoneyView } from "./money-mode.ts";
import { ReadUnavailable, createReadCache } from "./read-cache.ts";
import { NOW_SLACK_MS, createWebWarmer, type WarmStore } from "./web-warm.ts";
import { SITE_VISIT_EVENTS, V2Error, overviewV2, paymentsV2, peopleV2, personV2, type V2Source } from "./v2.ts";
import { countsAsBought, dailyMessages, launchStrip, SUBSCRIBER_FILTERS, subscriberRows, timelineOf, trialTotals, usageOf } from "./subscribers.ts";
import type { BugReportStore } from "../bug-reports/store.ts";
import { quote } from "../billing/pricing.ts";
import type { StoredSubscription } from "../billing/store.ts";
import type { Money } from "./payments.ts";
import { ADMIN_ROLES, type Account, type AdminRole } from "../auth/store.ts";
import { forGrowth, growthMay, growthUrl, type PanelRole } from "./roles.ts";
import { DAY, choseCloud, dayKey, dayRange, funnel, isPaying, perDay, wasPaid, workspaceTurns } from "./metrics.ts";

export class AdminError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
type Auth = ReturnType<typeof createAuth>;
type Billing = ReturnType<typeof createBilling>;
export interface AdminOptions {
  /** MADANI_ADMIN_EMAILS: the accounts allowed in, by email; empty lets nobody in */
  emails: string[];
  /** MADANI_GROWTH_ADMIN_EMAILS: accounts that get the growth role without a grant from the panel */
  growthEmails?: string[];
  auth: Auth;
  billing: Billing;
  workspaces: () => StoredWorkspace[];
  analytics: Analytics;
  usage: Usage;
  /** the in-app reports, for a subscriber's own */
  bugReports?: BugReportStore;
  /** the slack edge's measured cloud wake times by desktop kind */
  wakeStats?: () => Partial<Record<string, { medianMs: number; p90Ms: number; samples: number }>>;
  waitlist: WaitlistSource | null;
  /** another service's analytics, read only, shown by default (preview's admin reads madani.bot's); x-madani-admin-data: own shows this service's */
  live?: LiveData | null;
  now: () => number;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  errors: ErrorCounter;
  /** daily InstaBox usage per managed cloud, for the revenue page's cost and margin */
  infra?: { store: InfraStore };
  /** the ops page: spend, health, outliers and alert rules, from what the ops collectors stored */
  ops?: { answer(): Promise<unknown>; collect(): Promise<unknown>; accounts(relays: readonly OpsRelayCard[], query?: { range?: OpsAccountsRange; limit?: number }): Promise<OpsAccountsAnswer> };
  /** how long an analytics answer is kept for the panel's refreshes (default 30 s); 0 keeps none, only joins identical reads in flight */
  readCacheMs?: number;
  /** keeps the overview's default /web ranges computed ahead (web-warm.ts), every `everyMs` (default 10 minutes) */
  warm?: { store: WarmStore; everyMs?: number } | null;
  /** the local fixture: made-up relay cards instead of asking the relays */
  relayFixture?: boolean;
  service: { version: string | null; startedAt: number; environment: string; dataDir: string; backupDir: string | null; database: () => { ok: boolean; detail: string } | null };
  readBody(req: IncomingMessage): Promise<Buffer>;
  bodyObject(body: Buffer): Record<string, unknown>;
  json(res: ServerResponse, status: number, data: unknown): void;
}

const rethrow = (error: unknown): never => {
  if (error instanceof AnalyticsRouteError || error instanceof PlanError) throw new AdminError(error.status, error.code, error.message);
  if (error instanceof BillingError) throw new AdminError(error.status, error.code, error.code === "unavailable" ? "The payment provider can't be read right now." : "That can't be done right now.");
  throw error;
};
export const parseAdminEmails = (value: string | undefined) => [...new Set((value ?? "").split(",").map(item => item.trim().toLowerCase()).filter(item => /^[^\s@]+@[^\s@]+$/.test(item)))];
const ACTIVE_NAMES = EVENT_NAMES.filter(name => "active" in EVENTS[name]);
/** "using the app": the app's own events and its server heartbeat, not site visits or sign-ins */
const APP_NAMES = EVENT_NAMES.filter(name => EVENTS[name].source === "app" || name === "app_active");
const REALTIME_TTL_MS = 4_000;
/** how long past its freshness a kept read is still answered at once while a new one is computed behind it */
const STALE_MS = 12 * 60 * 60_000;
const SUBSCRIBER_EVENTS = ["app_messages", "app_open"];
const bundleLabel = (id: string | null | undefined) => BILLING_CONFIG.bundles.find(bundle => bundle.id === id)?.label.toLowerCase() ?? (id ? "custom" : null);
const regionLabel = (id: string, managed: boolean) => (labelOfRegion(managed ? MANAGED_REGION.id : id) ?? id).toLowerCase();
const int = (value: string | null, fallback: number, min: number, max: number) => {
  const n = value === null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new AdminError(400, "invalid_request", "Invalid request.");
  return n;
};

export function createAdmin(options: AdminOptions) {
  const { auth, billing, analytics, now } = options;
  const allowed = new Set(options.emails.map(email => email.toLowerCase()));
  const growthByEmail = new Set((options.growthEmails ?? []).map(email => email.toLowerCase()));
  const env = options.env ?? process.env;
  const brevo = brevoChecker({ apiKey: env.MADANI_BREVO_API_KEY, listId: env.MADANI_BREVO_WAITLIST_LIST_ID, fetch: options.fetch, now });
  const targets = healthTargets(env.MADANI_ADMIN_HEALTH_URLS);
  const actor = (id: string) => auth.directory().accounts.find(account => account.id === id)?.email ?? null;
  const deep = createAnalyticsRoutes({ auth, billing, analytics, workspaces: options.workspaces, now, actor });
  const reviewEmail = env.MADANI_REVIEW_EMAIL?.trim().toLowerCase() || null;

  /** which data the analytics pages read: this service's, or the live service's (its events, daily counts and accounts;
   *  no money, clouds, devices or workspaces, which stay on its own admin). the waitlist pairs with the live site only. */
  const live = options.live ?? null;
  type Directory = ReturnType<Auth["directory"]>;
  type View = { live: boolean; sink: AnalyticsSink; directory: () => Directory; store: () => Billing["store"]["state"]; clouds: () => StoredCloud[]; workspaces: () => StoredWorkspace[];
    waitlist: WaitlistSource | null; deep: typeof deep; hidden: () => ReadonlySet<string> };
  const NONE: ReadonlySet<string> = new Set();
  const ownView: View = { live: false, sink: analytics.sink, directory: () => auth.directory(), store: () => billing.store.state, clouds: () => billing.clouds.all?.() ?? [],
    workspaces: options.workspaces, waitlist: live ? null : options.waitlist, deep, hidden: () => NONE };
  /** the same view without the test accounts (test-accounts.ts) in its people, money, clouds and workspaces, and without the events
   *  of test accounts, harness installs and dev builds; nothing is removed from the data */
  function withoutTests(view: View, build: (directory: () => Directory, store: () => Billing["store"]["state"], sink: AnalyticsSink) => typeof deep): View {
    const hidden = () => new Set([...testAccountIds(view.directory().accounts, reviewEmail), ...testBuyerIds(view.store().checkouts, reviewEmail)]);
    const directory = () => withoutAccounts(view.directory(), hidden());
    const store = () => withoutBilling(view.store(), hidden());
    const sink: AnalyticsSink = { ...view.sink, scan: async (since, until, names) => { const ids = hidden(), all = await view.sink.scan(since, until, names); return keepPartial(all, all.filter(event => !isTestEvent(event, ids))); },
      // the rollups read the unfiltered events and drop the same ones, keyed apart from the unfiltered view's
      rollupScope: () => {
        const base = view.sink.rollupScope?.();
        if (!base) return null;
        const ids = hidden();
        return { key: `${base.key}~clean`, sink: base.sink, hidden: ids, drops: event => isTestEvent(event, ids) };
      },
      events: async query => {
        const ids = hidden(), kept: StoredEvent[] = [];
        let before = query.before;
        for (let page = 0; page < 5 && kept.length < query.limit; page++) {
          const got = await view.sink.events({ ...query, before });
          kept.push(...got.filter(event => !isTestEvent(event, ids)));
          if (got.length < query.limit) break;
          before = got.at(-1)!.at;
        }
        return kept.slice(0, query.limit);
      },
      person: async query => { const ids = hidden(); return (await view.sink.person(query)).filter(event => !isTestEvent(event, ids)); },
      lastSeen: async since => { const seen = await view.sink.lastSeen(since); for (const id of hidden()) seen.delete(id); return seen; },
      anonymous: async (since, until, options) => {
        const answer = await view.sink.anonymous(since, until, options), rows = answer.rows.filter(row => row.kind !== "install" || !isTestInstall(row.key.slice("install:".length)));
        return { total: answer.total - (answer.rows.length - rows.length), rows };
      } };
    return { ...view, hidden, directory, store, sink, clouds: () => { const ids = hidden(); return view.clouds().filter(c => !ids.has(c.accountId)); },
      workspaces: () => { const ids = hidden(); return view.workspaces().filter(ws => !isTestInstall(ws.id) && (!ws.ownerAccountId || !ids.has(ws.ownerAccountId))); }, deep: build(directory, store, sink) };
  }
  const billingWith = (store: () => Billing["store"]["state"]) => ({ ...billing, store: Object.defineProperty({ ...billing.store }, "state", { get: store }) }) as Billing;
  const ownClean = withoutTests(ownView, (directory, store, sink) => createAnalyticsRoutes({ auth: { directory } as unknown as Auth, billing: billingWith(store), analytics: { ...analytics, sink },
    workspaces: () => ownClean.workspaces(), now, actor }));
  const NO_MONEY = { customers: [], checkouts: [], subscriptions: [], licenses: [], invoices: [], credits: [], webhookEvents: [], feedback: [], closures: [], refunds: [], ledger: [] } as unknown as Billing["store"]["state"];
  let liveDirectory: Directory = { accounts: [], identities: [], sessions: [] };
  const liveView: View | null = live && {
    live: true, sink: live.sink, directory: () => liveDirectory, store: () => NO_MONEY, clouds: () => [], workspaces: () => [], waitlist: options.waitlist, hidden: () => NONE,
    deep: createAnalyticsRoutes({ auth: { directory: () => liveDirectory } as unknown as Auth,
      billing: { store: { state: NO_MONEY }, operator: { provider: "none" }, service: { setAttribution() { /* never writes the live service's billing */ } } } as unknown as Billing,
      analytics: { ...analytics, sink: live.sink, presence: { ...analytics.presence, list: () => [] } }, workspaces: () => [], now,
      actor: id => liveDirectory.accounts.find(account => account.id === id)?.email ?? null }),
  };
  const liveClean = liveView && withoutTests(liveView, (directory, _store, sink) => createAnalyticsRoutes({ auth: { directory } as unknown as Auth,
    billing: { store: { state: NO_MONEY }, operator: { provider: "none" }, service: { setAttribution() { /* never writes the live service's billing */ } } } as unknown as Billing,
    analytics: { ...analytics, sink, presence: { ...analytics.presence, list: () => [] } }, workspaces: () => [], now,
    actor: id => liveDirectory.accounts.find(account => account.id === id)?.email ?? null }));
  /** test accounts stay out unless the panel asks for them (x-madani-admin-tests: show) */
  const showTests = (req: IncomingMessage) => req.headers["x-madani-admin-tests"] === "show";
  const serverMode = () => billing.operator.mode ?? "live";
  /** the view with only one mode's money in it (x-madani-admin-money, live by default), so test checkouts never read as revenue */
  const moneyViews = new Map<string, View>();
  function inMoney(base: View, key: string, money: MoneyView): View {
    const cached = moneyViews.get(`${key}:${money}`);
    if (cached) return cached;
    // what the operator gave (grants, comps, App Review's cloud) is never money, in any mode
    const store = () => moneyIn(withoutOps(base.store()), money, serverMode());
    const view: View = { ...base, store, deep: createAnalyticsRoutes({ auth: { directory: base.directory } as unknown as Auth, billing: billingWith(store), analytics: { ...analytics, sink: base.sink }, workspaces: base.workspaces, now, actor }) };
    moneyViews.set(`${key}:${money}`, view);
    return view;
  }
  const ownViewOf = (req: IncomingMessage, money: MoneyView = moneyViewOf(req.headers["x-madani-admin-money"])) =>
    showTests(req) ? inMoney(ownView, "own", money) : inMoney(ownClean, "clean", money);
  async function viewOf(req: IncomingMessage): Promise<View> {
    if (!liveView || req.headers["x-madani-admin-data"] === "own") return ownViewOf(req);
    liveDirectory = { accounts: await live!.accounts(), identities: [], sessions: [] };
    return showTests(req) ? liveView : liveClean!;
  }

  /** what the v2 routes read: the live service's (preview reading madani.bot, read only) unless the panel asked for its own */
  async function sourceOf(req: IncomingMessage): Promise<V2Source> {
    const tests = showTests(req);
    if (live && req.headers["x-madani-admin-data"] !== "own") {
      const [accounts, identities, money] = await Promise.all([live.accounts(), live.identities?.() ?? Promise.resolve([]), live.money?.() ?? Promise.resolve(NO_MONEY as Money)]);
      const hidden: ReadonlySet<string> = tests ? NONE : new Set([...testAccountIds(accounts, reviewEmail), ...testBuyerIds(money.checkouts, reviewEmail)]);
      liveDirectory = { accounts, identities: [], sessions: [] };
      const view = tests ? liveView! : liveClean!;
      return { data: live.label, sink: view.sink, accounts: accounts.filter(account => !hidden.has(account.id)), identities: identities.filter(row => !hidden.has(row.accountId)), sessions: [],
        money: withoutBilling(money, hidden), serverMode: "live", reviewEmail, waitlistCount: async () => options.waitlist ? options.waitlist.count() : null, profile: id => view.deep.profile(id) };
    }
    const view = tests ? ownView : ownClean, directory = view.directory();
    const waitlist = live ? null : options.waitlist;
    return { data: "own", sink: view.sink, accounts: directory.accounts, identities: directory.identities, sessions: directory.sessions, money: view.store() as Money, serverMode: serverMode(),
      reviewEmail, waitlistCount: async () => waitlist ? waitlist.count() : null, profile: id => view.deep.profile(id) };
  }
  async function v2(req: IncomingMessage, url: URL, route: string, owner: { id: string }): Promise<unknown> {
    try {
      const source = await sourceOf(req), time = now();
      if (route === "/v2/overview") return await overviewV2(source, url, time);
      if (route === "/v2/people") return await peopleV2(source, url, time, moneyViewOf(req.headers["x-madani-admin-money"]));
      if (route === "/v2/payments") return paymentsV2(source, url, time);
      const person = /^\/v2\/people\/([^/]{1,100})$/.exec(route);
      if (person) {
        const id = decodeURIComponent(person[1]!);
        const answer = await personV2(source, id);
        await audit(owner.id, "person.view", id);
        return answer;
      }
    } catch (error) {
      if (error instanceof V2Error || error instanceof AnalyticsRouteError) throw new AdminError(error.status, error.code, error.message);
      throw error;
    }
    throw new AdminError(404, "not_found", "Route not found.");
  }

  /** a full admin by MADANI_ADMIN_EMAILS, or the limited role the owner granted on the account */
  function roleOf(account: Pick<Account, "email" | "adminRole">): PanelRole | null {
    if (allowed.has(account.email.toLowerCase())) return "owner";
    if (growthByEmail.has(account.email.toLowerCase())) return "growth";
    return account.adminRole && ADMIN_ROLES.includes(account.adminRole) ? account.adminRole : null;
  }
  /** every admin route: a signed-in web session (401), an admin role (403), and the CSRF header on changes */
  function gate(req: IncomingMessage, mutation: boolean) {
    const owner = auth.requireWeb(req, { mutation });
    const role = roleOf(owner);
    if (!role) throw new AdminError(403, "not_admin", "This account is not an admin.");
    return { owner, role };
  }
  function audit(actor: string, action: string, target: string | null, detail: Record<string, string | number | boolean | null> = {}) {
    return analytics.sink.audit({ id: `aud_${randomBytes(12).toString("base64url")}`, at: now(), actor, action, target, detail }).catch(() => { analytics.stats.failed++; });
  }

  const plans = createPlanEditor({ billing, now, audit });
  const directory = () => auth.directory();
  const store = () => billing.store.state;
  const allClouds = () => billing.clouds.all?.() ?? [];
  function subsOf(accountId: string) { return billing.service.subscriptions(accountId); }
  function planOf(accountId: string) {
    const subs = subsOf(accountId).filter(sub => sub.status !== "ended" && sub.status !== "pending").sort((a, b) => b.createdAt - a.createdAt);
    if (!subs[0]) return null;
    const time = now(), trial = store().subscriptions.some(sub => sub.accountId === accountId && sub.status === "active" && sub.trialEndsAt !== undefined && sub.trialEndsAt > time);
    return { plan: bundleLabel(subs[0].bundle), status: subs[0].status, trial };
  }
  function lastSeen(accountId: string, sessions = directory().sessions) {
    return sessions.filter(session => session.accountId === accountId).reduce<number | null>((best, session) => best === null || session.lastSeenAt > best ? session.lastSeenAt : best, null);
  }
  function cloudRow(c: StoredCloud, emails: Map<string, string>) {
    const view = billing.clouds.view(c), sub = store().subscriptions.find(item => item.id === c.subscriptionId);
    const status = view.status, managed = !!billing.clouds.managed && !!c.managed;
    const usable = !c.ended && !(c.destroyAt !== null && c.destroyAt <= now());
    return {
      id: c.id, name: c.name, accountId: c.accountId, owner: emails.get(c.accountId) ?? null, kind: c.kind, plan: BILLING_CONFIG.desktops[c.kind]?.label.toLowerCase() ?? c.kind,
      placement: c.placement, region: c.region, regionLabel: regionLabel(c.region, !!c.backend), status, setupStep: c.setupStep, backend: c.backend ?? null, origin: c.origin,
      spec: c.spec, createdAt: c.createdAt, provisionedAt: c.provisionedAt ?? null, powerSince: c.powerSince, lastReportAt: view.lastReportAt,
      suspended: c.suspended !== null, ended: !!c.ended, destroyAt: c.destroyAt, error: c.error, subscription: sub ? { status: sub.status, periodEnd: sub.currentPeriodEnd } : null,
      egress: view.egress ? { bytes: view.egress.bytes, state: view.egress.state } : null,
      actions: {
        pause: c.suspended === null && usable && ["running", "sleeping"].includes(c.status),
        resume: c.suspended !== null ? c.status === "suspended" && usable : usable && ["stopped", "sleeping"].includes(c.status),
        delete: managed && !!c.ended && c.status !== "destroyed" && c.status !== "destroying",
        endTrial: managed && !!billing.endTrials && !!billing.clouds.managed?.endTrial && usable,
      },
    };
  }
  const emailMap = () => new Map(directory().accounts.map(account => [account.id, account.email]));
  const relays = createRelays({ env, fetch: options.fetch, now, accounts: () => directory().accounts, fixture: options.relayFixture });
  const relayCall = <T>(work: Promise<T>) => work.catch((error: unknown): never => { if (error instanceof RelayError) throw new AdminError(error.status, error.code, error.message); throw error; });

  /** what people use it for, over whole UTC days from `from` to `to` (at most 90), against the window before */
  async function usageAnswer(url: URL, v: View, clean: boolean) {
    const to = int(url.searchParams.get("to"), now(), 0, Number.MAX_SAFE_INTEGER), from = int(url.searchParams.get("from"), to - 30 * DAY, 0, Number.MAX_SAFE_INTEGER);
    const span = Math.min(90, Math.max(1, Math.ceil((to - from) / DAY)));
    const days = dayRange(to, span), previousDays = dayRange(Date.parse(`${days[0]}T00:00:00Z`) - 1, span);
    const start = Date.parse(`${days[0]}T00:00:00Z`), end = Date.parse(`${days.at(-1)}T00:00:00Z`) + DAY;
    const store = options.usage.store;
    const [daily, previousDaily, people, previousPeople, snapshots, frustrations, digests, recentPeople, signals, spans, events] = await Promise.all([
      store.daily(days[0]!, days.at(-1)!), store.daily(previousDays[0]!, previousDays.at(-1)!), store.people(days[0]!, days.at(-1)!),
      store.people(previousDays[0]!, previousDays.at(-1)!), store.snapshots(), allRecords(store, "frustration", start, end).then(read => read.rows), allRecords(store, "digest", start, end).then(read => read.rows),
      store.people(dayKey(now() - 90 * DAY), dayKey(now())), store.records("signal", start, end, 50_000), store.routines(),
      v.sink.scan(start, end, MORE_EVENTS),
    ]).then(([daily, previousDaily, ...rows]) => {
      // test accounts and harness installs stay out of every per-person read; the kept daily totals can't be split
      const ids = v.hidden(), real = <T extends { accountId?: string | null; workspaceId?: string }>(list: T[]) => !clean ? list
        : list.filter(row => !isTestInstall(row.workspaceId) && !(row.accountId && ids.has(row.accountId)));
      const [people, previousPeople, snapshots, frustrations, digests, recentPeople, signals, spans, events] = rows;
      return [daily, previousDaily, real(people), real(previousPeople), real(snapshots), real(frustrations), real(digests), real(recentPeople), real(signals), real(spans), events] as const;
    });
    const answer = summarizeUsage({ days, daily, previousDaily, people, previousPeople: new Set(previousPeople.filter(row => row.turns > 0).map(row => row.accountId)).size, snapshots, frustrations, digests, adoption: adoption(snapshots, recentPeople, v) });
    const signIns = signals.filter(record => (record.data as { name: string }).name === "engine_sign_in")
      .map(record => ({ id: record.id, name: "engine_sign_in", at: record.at, accountId: record.accountId, props: (record.data as { props: StoredEvent["props"] }).props }));
    const billingState = v.store();
    const more = moreOf({ days, daily: new Map(daily.map(row => [row.day, row.c])), people, snapshots, routines: spans, events: [...events, ...signIns],
      billing: { checkouts: billingState.checkouts, subscriptions: billingState.subscriptions, feedback: billingState.feedback ?? [] },
      accounts: v.directory().accounts, from: start, to: end, now: now(), wake: wakeOf() });
    const focus = [...answer.focus, ...moreFocus(more)].sort((a, b) => b.weight - a.weight).slice(0, 5);
    return { ...answer, focus, more, partialBefore: partialOf(events) };
  }
  /** the slack edge's measured wakes: the kind with the most samples stands for all */
  function wakeOf() {
    const stats = Object.values(options.wakeStats?.() ?? {}).filter((stat): stat is { medianMs: number; p90Ms: number; samples: number } => !!stat).sort((a, b) => b.samples - a.samples);
    return stats[0] ? { count: stats.reduce((sum, stat) => sum + stat.samples, 0), p50Ms: stats[0].medianMs, p90Ms: stats[0].p90Ms } : undefined;
  }
  function adoption(snapshots: Awaited<ReturnType<Usage["store"]["snapshots"]>>, recent: Awaited<ReturnType<Usage["store"]["people"]>>, v: View): AdoptionInput {
    const { accounts, sessions } = v.directory();
    const bot = new Set<string>(), routine = new Set<string>(), connector = new Set<string>(), phone = new Set<string>(), cloud = new Set<string>();
    for (const row of snapshots) {
      if (row.snapshot.bots > 0) bot.add(row.accountId);
      if (row.snapshot.routines + row.snapshot.webhooks + row.snapshot.appEvents > 0) routine.add(row.accountId);
    }
    for (const ws of v.workspaces()) {
      const id = ws.ownerAccountId;
      if (!id) continue;
      if (ws.report?.bots?.length) bot.add(id);
      if (ws.report?.bots?.some(item => item.routines.length > 0)) routine.add(id);
      if (ws.report?.apps?.services.some(service => service.connected)) connector.add(id);
      if (ws.report?.devices?.phones.length) phone.add(id);
    }
    for (const session of sessions) if (session.kind === "mobile") phone.add(session.accountId);
    for (const row of recent) if (row.appTurns > 0) connector.add(row.accountId);
    for (const c of v.clouds()) if (!c.ended) cloud.add(c.accountId);
    const known = new Set(accounts.map(account => account.id)), count = (set: Set<string>) => [...set].filter(id => known.has(id)).length;
    return { accounts: accounts.length, bot: count(bot), routine: count(routine), connector: count(connector), phone: count(phone), cloud: count(cloud) };
  }

  async function overview(days: number, v: View) {
    const time = now(), range = dayRange(time, days), since = Date.parse(`${range[0]}T00:00:00Z`);
    const { accounts, sessions } = v.directory();
    const today = Date.parse(`${range.at(-1)}T00:00:00Z`);
    const [daily, waitlistDays, waitlistCount, marked, appWau, activeNow, siteVisitors] = await Promise.all([
      v.sink.daily(["active_accounts", "site_visitors", "site_view", "app_active"], range[0]!, range.at(-1)!),
      v.waitlist?.byDay(since).catch(() => []) ?? Promise.resolve([]),
      v.waitlist?.count().catch(() => null) ?? Promise.resolve(null),
      Promise.all(["onboarding_done", "app_paired", "first_bot_reply", "plan_chosen"].map(name => v.sink.accounts([name], since))),
      v.sink.accounts(APP_NAMES, time - 7 * DAY), v.sink.accounts(ACTIVE_NAMES, today),
      v.sink.visitorCount(since, time + 60_000, SITE_VISIT_EVENTS),
    ]);
    const hidden = v.hidden(), kept = (ids: Set<string>) => hidden.size ? new Set([...ids].filter(id => !hidden.has(id))) : ids;
    const [markedKept, appWauKept] = [marked.map(kept), kept(appWau)];
    const activeToday = kept(new Set([...activeNow, ...sessions.filter(session => session.lastSeenAt >= today).map(session => session.accountId)])).size;
    const untracked = v.live ? null : accounts.filter(account => analytics.optedOut(account.id)).length;
    const series = (name: string) => perDay(range, daily.filter(row => row.name === name));
    const activeSeries = series("active_accounts");
    const clouds = v.clouds();
    const byState = new Map<string, number>();
    for (const c of clouds) { const status = billing.clouds.view(c).status; byState.set(status, (byState.get(status) ?? 0) + 1); }
    const owned = v.workspaces().filter(ws => ws.ownerAccountId !== null);
    const sinceDay = dayKey(time - 29 * DAY);
    return {
      now: time, days, range, data: v.live ? live!.label : "own",
      totals: {
        accounts: accounts.length, newAccounts: accounts.filter(account => account.createdAt >= since).length,
        activeToday, untracked, appWau: appWauKept.size,
        paying: new Set(v.store().subscriptions.filter(isPaying).map(sub => sub.accountId)).size,
        waitlist: waitlistCount, clouds: [...byState].reduce((sum, [state, count]) => state === "destroyed" ? sum : sum + count, 0),
      },
      series: {
        signups: perDay(range, accounts.map(account => ({ day: dayKey(account.createdAt), count: 1 }))),
        waitlist: perDay(range, waitlistDays), active: activeSeries, visitors: series("site_visitors"), views: series("site_view"), apps: series("app_active"),
      },
      funnel: funnel({ since, siteVisitors, accounts, checkouts: v.store().checkouts, subscriptions: v.store().subscriptions, sessions,
        workspaces: owned, marked: { onboarded: markedKept[0]!, paired: markedKept[1]!, replied: markedKept[2]!, chosen: markedKept[3]! } }),
      clouds: [...byState].map(([state, count]) => ({ state, count })).sort((a, b) => b.count - a.count),
      bots: { workspaces: owned.length, bots: owned.reduce((sum, ws) => sum + (ws.report?.bots?.length ?? 0), 0), turns30d: owned.reduce((sum, ws) => sum + workspaceTurns(ws, sinceDay), 0) },
    };
  }

  function users(url: URL, v: View) {
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase().slice(0, 100);
    const offset = int(url.searchParams.get("offset"), 0, 0, 1_000_000), limit = int(url.searchParams.get("limit"), 50, 1, 200);
    const filter = url.searchParams.get("filter") ?? "all";
    const { accounts, identities, sessions } = v.directory();
    const clouds = v.clouds();
    let rows = accounts.map(account => {
      const devices = sessions.filter(session => session.accountId === account.id && session.kind !== "web");
      return { id: account.id, email: account.email, name: account.name, createdAt: account.createdAt, methods: ["email", ...identities.filter(item => item.accountId === account.id).map(item => item.provider)],
        plan: planOf(account.id), clouds: clouds.filter(c => c.accountId === account.id && c.status !== "destroyed").length, devices: devices.length,
        platforms: [...new Set(devices.map(device => device.platform ?? "unknown"))], lastSeenAt: lastSeen(account.id, sessions), optOut: analytics.optedOut(account.id) };
    });
    if (q) rows = rows.filter(row => row.email.includes(q) || (row.name ?? "").toLowerCase().includes(q) || row.id.toLowerCase() === q);
    if (filter === "paying") { const paying = new Set(v.store().subscriptions.filter(isPaying).map(sub => sub.accountId)); rows = rows.filter(row => paying.has(row.id)); }
    else if (filter === "cloud") rows = rows.filter(row => row.clouds > 0);
    else if (filter === "app") rows = rows.filter(row => row.devices > 0);
    else if (filter !== "all") throw new AdminError(400, "invalid_request", "Invalid request.");
    rows.sort((a, b) => b.createdAt - a.createdAt);
    return { total: rows.length, offset, limit, users: rows.slice(offset, offset + limit) };
  }

  async function user(id: string) {
    const { accounts, identities, sessions } = directory();
    const account = accounts.find(item => item.id === id);
    if (!account) throw new AdminError(404, "not_found", "Not found.");
    const emails = emailMap(), billingState = store();
    const workspaces = options.workspaces().filter(ws => ws.ownerAccountId === id);
    const sinceDay = dayKey(now() - 29 * DAY);
    const clouds = billing.clouds.list(id, true);
    const [events, auditEntries] = await Promise.all([analytics.sink.events({ accountId: id, limit: 200 }),
      analytics.sink.auditFor([id, ...clouds.map(c => c.id), ...billingState.subscriptions.filter(s => s.accountId === id).map(s => s.id)], 50, ["user.view", "person.view"])]);
    const derived: Array<Pick<StoredEvent, "name" | "at" | "props">> = [
      { name: "account_created", at: account.createdAt, props: {} },
      ...billingState.checkouts.filter(c => c.accountId === id).map(c => ({ name: "checkout_started", at: c.createdAt, props: { status: c.status, cloud: choseCloud(c), amountCents: c.amountCents, source: c.source ?? "unknown" } })),
      ...billingState.subscriptions.filter(s => s.accountId === id).map(s => ({ name: wasPaid(s) ? "subscription_paid" : "subscription_pending", at: s.createdAt, props: { status: s.status, amountCents: s.totalCents } })),
      ...billingState.invoices.filter(i => i.accountId === id).map(i => ({ name: "payment", at: i.createdAt, props: { status: i.status, amountCents: i.amountCents } })),
    ];
    const timeline = [...events.map(({ name, at, props }) => ({ name, at, props, source: "event" as const })), ...derived.map(item => ({ ...item, source: "record" as const }))]
      .sort((a, b) => b.at - a.at).slice(0, 250);
    return {
      account: { id: account.id, email: account.email, name: account.name, createdAt: account.createdAt, lastSeenAt: lastSeen(id, sessions), optOut: analytics.optedOut(id),
        admin: { owner: roleOf(account) === "owner", role: account.adminRole ?? null } },
      methods: ["email", ...identities.filter(item => item.accountId === id).map(item => item.provider)],
      plan: planOf(id),
      subscriptions: plans.subscriptions(id),
      billing: plans.info(),
      payments: billingState.invoices.filter(i => i.accountId === id).sort((a, b) => b.createdAt - a.createdAt).map(({ id: invoiceId, amountCents, currency, status, createdAt, description, mode, subscriptionId }) =>
        ({ id: invoiceId, amountCents, currency, status, createdAt, description, mode: mode ?? billingState.subscriptions.find(s => s.id === subscriptionId)?.mode ?? billing.operator.mode })),
      devices: sessions.filter(session => session.accountId === id).sort((a, b) => b.lastSeenAt - a.lastSeenAt)
        .map(({ id: sessionId, kind, name, platform, appVersion, createdAt, lastSeenAt }) => ({ id: sessionId, kind, name, platform, appVersion, createdAt, lastSeenAt })),
      clouds: clouds.map(c => cloudRow(c, emails)),
      workspaces: workspaces.map(ws => ({ id: ws.id, name: ws.name, kind: ws.kind, version: ws.version, connectedAt: ws.connectedAt, lastReportAt: ws.lastReportAt,
        bots: ws.report?.bots?.length ?? 0, turns30d: workspaceTurns(ws, sinceDay), computers: ws.report?.computers?.computers.length ?? 0 })),
      timeline,
      audit: auditEntries.map(entry => ({ ...entry, actorEmail: emails.get(entry.actor) ?? null })),
    };
  }

  const subscriberPlan = (sub: Pick<StoredSubscription, "cart">) => { try { return bundleLabel(quote(sub.cart, BILLING_CONFIG).bundle ?? null) ?? "custom"; } catch { return "custom"; } };
  /** what the subscribers page reads about everyone with a subscription */
  async function subscriberInputs(v: View, accountIds: ReadonlySet<string> | null) {
    const time = now(), mine = <T extends { accountId?: string | null; ownerAccountId?: string | null }>(rows: readonly T[]): T[] =>
      accountIds ? rows.filter(row => accountIds.has((row.accountId ?? row.ownerAccountId) as string)) : [...rows];
    const { accounts, sessions } = v.directory();
    const [events, people, snapshots] = await Promise.all([v.sink.scan(time - 90 * DAY, time + 60_000, SUBSCRIBER_EVENTS),
      options.usage.store.people(dayKey(time - 90 * DAY), dayKey(time)), options.usage.store.snapshots()]);
    const hidden = v.hidden(), real = <T extends { accountId: string; workspaceId?: string }>(rows: readonly T[]) => rows.filter(row => !hidden.has(row.accountId) && !isTestInstall(row.workspaceId));
    const state = v.store();
    return {
      input: { now: time, accounts: accountIds ? accounts.filter(account => accountIds.has(account.id)) : accounts, sessions: mine(sessions), billing: { subscriptions: mine(state.subscriptions), invoices: state.invoices, feedback: state.feedback ?? [], customers: state.customers },
        events: mine(events), people: mine(real(people)), snapshots: mine(real(snapshots)), workspaces: mine(v.workspaces()),
        clouds: mine(v.clouds()).map(c => ({ accountId: c.accountId, workspaceId: c.workspaceId ?? null, status: billing.clouds.view(c).status })), planOf: subscriberPlan },
      state, accounts, partialBefore: partialOf(events),
    };
  }
  async function subscribersAnswer(url: URL, v: View) {
    const filter = url.searchParams.get("filter") ?? "trial";
    if (!(SUBSCRIBER_FILTERS as readonly string[]).includes(filter)) throw new AdminError(400, "invalid_request", "Unknown filter.");
    const { input, state, accounts, partialBefore } = await subscriberInputs(v, null);
    const rows = subscriberRows(input);
    const counts = Object.fromEntries(SUBSCRIBER_FILTERS.map(name => [name, name === "all" ? rows.length : rows.filter(row => row.bucket === name).length]));
    return { now: input.now, filter, counts, rows: filter === "all" ? rows : rows.filter(row => row.bucket === filter), launch: launchStrip(state, accounts, input.now), trials: trialTotals(state.subscriptions, input.now), partialBefore };
  }
  async function subscriber(id: string, v: View) {
    const time = now(), account = v.directory().accounts.find(item => item.id === id);
    if (!account) throw new AdminError(404, "not_found", "Not found.");
    const { input, state } = await subscriberInputs(v, new Set([id]));
    const [row] = subscriberRows(input);
    if (!row) throw new AdminError(404, "not_found", "This person has no subscription.");
    const identifies = await v.sink.events({ accountId: id, name: "identify", limit: 200 });
    const installs = [...new Set(identifies.map(event => event.ctx?.install).filter((install): install is string => !!install))];
    const visitors = [...new Set(identifies.map(event => event.ctx?.visitor).filter((visitor): visitor is string => !!visitor))];
    const [events, reports] = await Promise.all([v.sink.person({ accountId: id, visitors, installs, since: 0, limit: 5000 }),
      options.bugReports ? options.bugReports.fromInstalls([...new Set([...installs, ...installs.map(install => install.replace(/^app:/, ""))])], 20) : Promise.resolve([])]);
    const subs = input.billing.subscriptions.filter(countsAsBought);
    const feedback = (state.feedback ?? []).filter(item => item.accountId === id).sort((a, b) => b.at - a.at);
    const days = new Map<string, { turns: number; failed: number }>();
    for (const day of input.people) { const had = days.get(day.day) ?? { turns: 0, failed: 0 }; days.set(day.day, { turns: had.turns + day.turns, failed: had.failed + day.failed }); }
    const daily = dailyMessages(events, time).map(day => ({ ...day, turns: days.get(day.day)?.turns ?? 0, failed: days.get(day.day)?.failed ?? 0 }));
    return {
      account: { id, handle: row.handle, email: account.email, name: account.name ?? null, createdAt: account.createdAt }, row, daily,
      timeline: timelineOf(events, subs, feedback, account.createdAt, time), usage: usageOf(events),
      reports: reports.map(({ id: reportId, source, description, appVersion, platform, status, fixedIn, receivedAt }) => ({ id: reportId, source, description, appVersion, platform, status, fixedIn, receivedAt })),
      cancel: feedback.map(({ answer, expected, improve, at }) => ({ answer, expected: expected ?? null, improve: improve ?? null, at })),
    };
  }

  function clouds(url: URL, v: View) {
    const status = url.searchParams.get("status") ?? "live";
    const emails = emailMap();
    let rows = v.clouds().map(c => cloudRow(c, emails));
    if (status === "live") rows = rows.filter(row => row.status !== "destroyed" && row.status !== "checkout");
    else if (status !== "all") rows = rows.filter(row => row.status === status);
    rows.sort((a, b) => b.createdAt - a.createdAt);
    return { clouds: rows, now: now() };
  }

  async function cloudAction(owner: { id: string }, id: string, action: string, input: Record<string, unknown>) {
    const cloud = billing.clouds.get(id);
    if (!cloud) throw new AdminError(404, "not_found", "Not found.");
    const row = cloudRow(cloud, emailMap()), key = action === "end-trial" ? "endTrial" : action;
    if (!(key in row.actions) || !row.actions[key as keyof typeof row.actions]) throw new AdminError(409, "not_available", `This cloud can't ${action.replace("-", " ")} in its current state.`);
    if (input.confirm !== cloud.id && input.confirm !== cloud.name) throw new AdminError(400, "confirm_required", "Type the cloud's name to confirm.");
    if (key === "endTrial") {
      // the same early settle as POST /v1/billing/ops/clouds/<id>/end-trial, from the panel instead of the ops token
      const answer = billing.clouds.managed!.endTrial!(cloud, "admin_panel");
      await audit(owner.id, "cloud.end_trial", cloud.id, "refused" in answer ? { ok: false, code: answer.refused } : { ok: true });
      if ("refused" in answer) throw new AdminError(409, answer.refused, answer.refused === "no_trial" ? "No update is on trial on this cloud." : "Its self-test has not passed yet.");
      void billing.clouds.reconcile().catch(() => {});
      return { cloud: cloudRow(cloud, emailMap()) };
    }
    try {
      if (action === "pause") await billing.clouds.power(cloud.accountId, cloud.id, "off");
      else if (action === "resume") { if (cloud.suspended !== null) await billing.clouds.resume(cloud.id); else await billing.clouds.power(cloud.accountId, cloud.id, "on"); }
      else {
        const reason = typeof input.reason === "string" && /^[a-z_]{3,40}$/.test(input.reason) ? input.reason : "admin_panel";
        billing.clouds.managed!.operatorDelete(cloud, reason);
        void billing.clouds.reconcile().catch(() => {});
      }
    } catch (error) {
      await audit(owner.id, `cloud.${action}`, cloud.id, { ok: false, code: (error as { code?: string }).code ?? "failed" });
      const status = (error as { status?: number }).status;
      throw new AdminError(status && status < 500 ? status : 502, (error as { code?: string }).code ?? "failed", "The cloud refused that action. Check its state and try again.");
    }
    await audit(owner.id, `cloud.${action}`, cloud.id, { ok: true, from: row.status });
    return { cloud: cloudRow(cloud, emailMap()) };
  }

  async function events(url: URL, v: View) {
    const name = url.searchParams.get("name") || undefined, accountId = url.searchParams.get("account") || undefined;
    if (name !== undefined && !isEventName(name)) throw new AdminError(400, "invalid_request", "Unknown event.");
    if (accountId !== undefined && !/^[A-Za-z0-9_-]{1,80}$/.test(accountId)) throw new AdminError(400, "invalid_request", "Invalid request.");
    const days = int(url.searchParams.get("days"), 7, 1, 400), limit = int(url.searchParams.get("limit"), 100, 1, 500);
    const before = url.searchParams.has("before") ? int(url.searchParams.get("before"), 0, 0, Number.MAX_SAFE_INTEGER) : undefined;
    const time = now(), since = time - days * DAY;
    const [list, counts] = await Promise.all([v.sink.events({ name, accountId, since, before, limit: limit + 1 }), v.sink.counts(since, time + 1)]);
    const emails = new Map(v.directory().accounts.map(account => [account.id, account.email]));
    return { names: EVENT_NAMES, counts, untracked: v.live ? null : v.directory().accounts.filter(account => analytics.optedOut(account.id)).length, events: list.slice(0, limit).map(event => ({ ...event, email: event.accountId ? emails.get(event.accountId) ?? null : null })),
      next: list.length > limit ? list[limit - 1]!.at : null };
  }

  /** this month's InstaBox cost and gross margin, per customer and in total */
  async function infraAnswer() {
    const time = now(), start = Date.UTC(new Date(time).getUTCFullYear(), new Date(time).getUTCMonth(), 1);
    const rows = options.infra ? await options.infra.store.range(dayKey(start), dayKey(time)) : [];
    const egress = new Map<string, "slowed" | "paused">();
    for (const c of allClouds()) {
      const state = c.managed ? billing.clouds.view(c).egress?.state : undefined;
      if (state === "paused" || state === "slowed" && egress.get(c.accountId) !== "paused") egress.set(c.accountId, state);
    }
    return { now: time, collected: !!options.infra, ...marginReport({ now: time, customers: deep.customers(), rows, egress }) };
  }

  async function health() {
    const time = now(), backup = newestBackup(options.service.backupDir);
    const [sink, checks] = await Promise.all([analytics.sink.health(), Promise.all(targets.map(target => probe(target, options.fetch)))]);
    const database = options.service.database();
    return {
      now: time,
      service: { version: options.service.version, environment: options.service.environment, startedAt: options.service.startedAt, uptimeSec: Math.round((time - options.service.startedAt) / 1000),
        node: process.version, rssMb: Math.round(process.memoryUsage().rss / 1_048_576) },
      database: database ?? { ok: true, detail: "json files (development)" },
      analytics: { ...sink, written: analytics.stats.written, failed: analytics.stats.failed, dropped: analytics.stats.dropped, lastFailureAt: analytics.stats.lastFailureAt },
      backup: options.service.backupDir ? { configured: true, at: backup?.at ?? null, ageHours: backup ? Math.round((time - backup.at) / 360_000) / 10 : null, ok: !!backup && time - backup.at < 30 * 3_600_000 } : { configured: false, at: null, ageHours: null, ok: null },
      errors: { ...options.errors.counts(), spooled: spoolCount(join(options.service.dataDir, "error-spool")) },
      checks,
    };
  }

  const reads = createReadCache({ now });
  /** how long a GET answer is kept: null for the ones that are never kept (an audited view, an export, live probes) */
  function readTtl(route: string): number | null {
    if (/^\/(?:me|health|audit|waitlist\.csv|ops\/relays|experience\/timeline)$/.test(route) || /^\/(?:users|journeys|v2\/people|subscribers)\/[^/]+$/.test(route) || /^\/clouds\/[^/]+\/usage$/.test(route)) return null;
    return route === "/realtime" ? REALTIME_TTL_MS : options.readCacheMs ?? 30_000;
  }
  const switchesOf = (req: IncomingMessage) => {
    const header = (name: string) => String(req.headers[name] ?? "");
    return { data: header("x-madani-admin-data"), tests: header("x-madani-admin-tests"), money: header("x-madani-admin-money") };
  };
  /** one question: the path, its query (a `to` within 10 minutes of now reads as now, so every "until now" view shares one answer) and the panel's switches */
  function readKey(url: URL, switches: { data: string; tests: string; money: string }) {
    const params = [...url.searchParams].map(([key, value]) => {
      const at = Number(value);
      return key === "to" && Number.isSafeInteger(at) && Math.abs(now() - at) < NOW_SLACK_MS ? [key, "now"] : [key, value];
    }).sort(([a], [b]) => a!.localeCompare(b!));
    return `${url.pathname}?${new URLSearchParams(params as Array<[string, string]>)}|${switches.data}|${switches.tests}|${switches.money}`;
  }
  const requestWith = (switches: { data: string; tests: string; money: string }) => ({ headers: Object.fromEntries(
    Object.entries({ "x-madani-admin-data": switches.data, "x-madani-admin-tests": switches.tests, "x-madani-admin-money": switches.money }).filter(([, value]) => value)) }) as unknown as IncomingMessage;
  const warmer = options.warm ? createWebWarmer({ store: options.warm.store, reads, now, everyMs: options.warm.everyMs ?? 10 * 60_000, keepMs: (options.readCacheMs ?? 30_000) + STALE_MS,
    keyOf: (viewer, url) => readKey(url, viewer), answer: async (viewer, urls) => (await viewOf(requestWith(viewer))).deep.webMany(urls) }) : null;
  void warmer?.start();
  /** the view whose live numbers (online now) a request reads, without reloading the live service's accounts */
  const onlineViewOf = (req: IncomingMessage) => !liveView || req.headers["x-madani-admin-data"] === "own" ? ownViewOf(req) : showTests(req) ? liveView : liveClean!;

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname, method = req.method ?? "GET";
    if (path !== "/v1/admin" && !path.startsWith("/v1/admin/")) return false;
    const mutation = method !== "GET" && method !== "HEAD";
    const { owner, role } = gate(req, mutation);
    const route = path.slice("/v1/admin".length) || "/";
    if (role === "growth" && !growthMay(method, route)) throw new AdminError(403, "not_allowed", "This admin role can't open that.");
    if (role === "growth") url = growthUrl(route, url);
    const shape = (data: unknown) => role === "growth" ? forGrowth(route, data) : data;
    if (mutation) { reads.clear(); warmer?.forget(); }
    try {
      if (method !== "GET") return await answer(req, res, url, owner, route, method, data => { options.json(res, 200, data); return true; });
      const ttlMs = readTtl(route);
      if (ttlMs === null) return await reads.bounded(answer(req, res, url, owner, route, method, data => { options.json(res, 200, shape(data)); return true; }));
      if (route === "/web") warmer?.note(url, switchesOf(req));
      const data = await reads.get(readKey(url, switchesOf(req)), ttlMs, async () => {
        const out: { data?: unknown } = {};
        await answer(req, res, url, owner, route, method, data => { out.data = data; return true; });
        return out.data;
      }, route === "/realtime" ? 0 : STALE_MS);
      // a kept answer may be minutes old; who is online is always now
      const fresh = route === "/web" && data && typeof data === "object" ? { ...data, online: await onlineViewOf(req).deep.onlineNow() } : data;
      options.json(res, 200, shape(fresh));
      return true;
    } catch (error) {
      if (error instanceof ReadUnavailable) throw new AdminError(error.status, error.code, error.message);
      throw error;
    }
  }

  async function answer(req: IncomingMessage, res: ServerResponse, url: URL, owner: ReturnType<typeof gate>["owner"], route: string, method: string, send: (data: unknown) => true): Promise<boolean> {
    if (method === "GET" && route.startsWith("/v2/")) return send(await v2(req, url, route, owner));
    if (method === "GET") {
      if (route === "/me") return send({ admin: true, role: roleOf(owner), email: owner.email, environment: options.service.environment, version: options.service.version, live: live?.label ?? null });
      if (route === "/overview") return send(await overview(int(url.searchParams.get("days"), 30, 7, 90), await viewOf(req)));
      if (route === "/users") return send(users(url, ownViewOf(req)));
      const userMatch = /^\/users\/([A-Za-z0-9_-]{1,80})$/.exec(route);
      if (userMatch) {
        const answer = await user(userMatch[1]!);
        await audit(owner.id, "user.view", userMatch[1]!);
        return send(answer);
      }
      if (route === "/subscribers") return send(await subscribersAnswer(url, ownViewOf(req)));
      const subscriberMatch = /^\/subscribers\/([A-Za-z0-9_-]{1,80})$/.exec(route);
      if (subscriberMatch) {
        const answer = await subscriber(subscriberMatch[1]!, ownViewOf(req));
        await audit(owner.id, "subscriber.view", subscriberMatch[1]!);
        return send(answer);
      }
      if (route === "/clouds") return send(clouds(url, ownViewOf(req)));
      const usage = /^\/clouds\/(c[0-9a-f]{24})\/usage$/.exec(route);
      if (usage) {
        const cloud = billing.clouds.get(usage[1]!);
        if (!cloud) throw new AdminError(404, "not_found", "Not found.");
        const managed = billing.clouds.managed;
        const measured = cloud.backend && managed?.usage ? await managed.usage(cloud).catch(() => null) : null;
        return send({ usage: measured, exposed: !!(cloud.backend && managed?.usage) });
      }
      if (route === "/waitlist") {
        if (!options.waitlist) return send({ configured: false, total: 0, entries: [], brevo: { state: "not_configured", listCount: null, waitlistCount: null, checkedAt: null } });
        const q = (url.searchParams.get("q") ?? "").slice(0, 100);
        const offset = int(url.searchParams.get("offset"), 0, 0, 10_000_000), limit = int(url.searchParams.get("limit"), 50, 1, 200);
        const days = dayRange(now(), 30);
        const [page, count, byDay] = await Promise.all([options.waitlist.list({ search: q, limit, offset }), options.waitlist.count(), options.waitlist.byDay(Date.parse(`${days[0]}T00:00:00Z`))]);
        return send({ configured: true, count, total: page.total, offset, limit, entries: page.entries, days, series: perDay(days, byDay), brevo: await brevo(count) });
      }
      if (route === "/waitlist.csv") {
        if (!options.waitlist) throw new AdminError(404, "not_found", "The waitlist is not connected.");
        const entries = await options.waitlist.all();
        await audit(owner.id, "waitlist.export", null, { rows: entries.length });
        res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store", "content-disposition": `attachment; filename="madani-waitlist-${dayKey(now())}.csv"`, "x-content-type-options": "nosniff" });
        res.end(waitlistCsv(entries));
        return true;
      }
      if (route === "/events") return send(await events(url, await viewOf(req)));
      if (route === "/usage") return send(await usageAnswer(url, ownViewOf(req), !showTests(req)));
      if (route === "/feedback") {
        const kind = url.searchParams.get("kind"), before = url.searchParams.get("before");
        const hidden = ownViewOf(req).hidden();
        return send(await feedbackAnswer(options.usage.store, { now: now(), kind: FEEDBACK_KINDS.find(one => one === kind) ?? null, before: before ? int(before, now(), 0, Number.MAX_SAFE_INTEGER) : null,
          ...(showTests(req) ? {} : { hidden: (record: { accountId: string; workspaceId: string }) => isTestInstall(record.workspaceId) || (!!record.accountId && hidden.has(record.accountId)) }) }));
      }
      if (route === "/revenue/infra") return send(await infraAnswer());
      if (route === "/ops") {
        if (!options.ops) throw new AdminError(404, "not_found", "The ops page is not connected.");
        return send(await options.ops.answer());
      }
      if (route === "/experience" || route === "/experience/timeline") {
        const view = await viewOf(req), time = now(), timeline = route === "/experience/timeline";
        const to = int(url.searchParams.get("to"), time, 0, Number.MAX_SAFE_INTEGER), from = int(url.searchParams.get("from"), to - 14 * DAY, 0, Number.MAX_SAFE_INTEGER);
        const who = url.searchParams.get("who") ?? "";
        if (timeline && !/^(?:ws:)?[A-Za-z0-9_-]{8,80}$/.test(who)) throw new AdminError(400, "invalid_request", "Name an install.");
        const since = timeline ? time - 30 * DAY : Math.max(from, to - 90 * DAY) - DAY, until = timeline ? time + 1 : to + 1;
        const ids = view.hidden(), clean = !showTests(req);
        const [events, signals] = await Promise.all([view.sink.scan(since, until, EXPERIENCE_EVENTS),
          view.live ? Promise.resolve([]) : options.usage.store.records("signal", since, until, 50_000)
            .then(rows => clean ? rows.filter(row => !isTestInstall(row.workspaceId) && !(row.accountId && ids.has(row.accountId))) : rows)]);
        const items = itemsOf(events, signals);
        // a read cut at its limit starts the chart at the first whole day it holds, so the cut never draws as growth
        const partialBefore = partialOf(events), whole = partialBefore === null ? from : Math.max(from, Math.ceil(partialBefore / DAY) * DAY);
        if (!timeline) return send({ ...experienceAnswer(items, { from: whole, to, now: time }), partialBefore });
        await audit(owner.id, "experience.timeline", who);
        return send(timelineAnswer(items, who, time));
      }
      if (route === "/ops/relays") return send(await relays.list());
      if (route === "/ops/sharing") {
        const time = now();
        const events = await (await viewOf(req)).sink.scan(time - SHARING_LOOKBACK_DAYS * DAY, time + 1, ["app_action", "app_open"]);
        return send({ ...sharingOf(events, time), partialBefore: partialOf(events) });
      }
      if (route === "/ops/accounts") {
        if (!options.ops) throw new AdminError(404, "not_found", "The ops page is not connected.");
        const asked = url.searchParams.get("range"), range = isRange(asked) ? asked : "month", limit = url.searchParams.get("all") === "1" ? 5000 : 200;
        const [view, cards] = await Promise.all([viewOf(req), relays.list()]);
        if (!view.live) return send(await options.ops.accounts(cards.relays, { range, limit }));
        const time = now(), { from, to } = rangeDays(range, time);
        const [infra, mail, notes] = await Promise.all([live!.infra(from, to).catch(() => null), live!.daily("mail", from, to).catch(() => null),
          live!.latest(ACCOUNT_NOTES).catch(() => null) as Promise<AccountNotes | null>]);
        return send(topAccounts({ now: time, month: new Date(time).toISOString().slice(0, 7), range, limit, data: live!.label, accounts: [...view.directory().accounts, ...auth.directory().accounts],
          relays: range === "month" ? cards.relays : [], infra, mail, plans: notes?.plans ? new Map(Object.entries(notes.plans)) : undefined, suspects: Array.isArray(notes?.suspects) ? notes.suspects : [] }));
      }
      try {
        if (route === "/revenue") return send(await ownViewOf(req, "all").deep.revenue(url));
        const view = /^\/(?:web|funnel|journeys|realtime|retention|app|product)(?:\/|$)/.test(route) ? await viewOf(req) : ownViewOf(req), reads = view.deep;
        if (route === "/web") return send(await reads.web(url));
        if (route.startsWith("/web/")) { const dim = route.slice(5); if (!reads.isDimension(dim)) throw new AnalyticsRouteError(400, "invalid_request", "Invalid dimension."); return send(await reads.webDetails(dim, url)); }
        if (route === "/funnel") return send(await reads.funnel(url));
        if (route === "/journeys") return send(await reads.journeys(url));
        const person = /^\/journeys\/((?:acct_)?[A-Za-z0-9_-]{8,80})$/.exec(route);
        if (person) {
          const answer = await reads.profile(person[1]!);
          await audit(owner.id, "person.view", person[1]!);
          return send(answer);
        }
        if (route === "/realtime") return send(await reads.realtime(url));
        if (route === "/retention") return send(await reads.retention());
        if (route === "/app") return send(await reads.app(url));
        if (route === "/product") return send(await reads.product(url));
      } catch (error) {
        if (error instanceof AnalyticsRouteError) throw new AdminError(error.status, error.code, error.message);
        throw error;
      }
      if (route === "/health") return send(await health());
      if (route === "/audit") {
        const before = url.searchParams.has("before") ? int(url.searchParams.get("before"), 0, 0, Number.MAX_SAFE_INTEGER) : undefined;
        const emails = emailMap();
        return send({ entries: (await analytics.sink.auditLog(100, before)).map(entry => ({ ...entry, actorEmail: emails.get(entry.actor) ?? null })) });
      }
    }
    if (route === "/notes" && method === "POST") {
      const note = await deep.saveNote(owner.id, options.bodyObject(await options.readBody(req))).catch(rethrow);
      await audit(owner.id, "note.add", note.id);
      return send({ note });
    }
    const noteRoute = /^\/notes\/(note_[A-Za-z0-9_-]{6,20})$/.exec(route);
    if (noteRoute && method === "PATCH") {
      const note = await deep.saveNote(owner.id, options.bodyObject(await options.readBody(req)), noteRoute[1]!).catch(rethrow);
      await audit(owner.id, "note.edit", note.id);
      return send({ note });
    }
    if (noteRoute && method === "DELETE") {
      if (!await deep.deleteNote(noteRoute[1]!)) throw new AdminError(404, "not_found", "Not found.");
      await audit(owner.id, "note.delete", noteRoute[1]!);
      return send({ ok: true });
    }
    const relayLimits = /^\/ops\/relays\/([a-z][a-z0-9-]{1,30})\/limits$/.exec(route);
    if (relayLimits && method === "PUT") {
      const body = options.bodyObject(await options.readBody(req));
      const relay = await relayCall(relays.setLimits(relayLimits[1]!, body));
      const detail: Record<string, string | number | boolean | null> = {};
      for (const [key, value] of Object.entries(body).slice(0, 16)) if (value === null || typeof value === "number" || typeof value === "boolean") detail[key] = value;
      await audit(owner.id, "ops.relay.limits", relayLimits[1]!, detail);
      return send({ relay });
    }
    if (method === "POST") {
      const planRoute = /^\/users\/([A-Za-z0-9_-]{1,80})\/plan$/.exec(route);
      const previewRoute = /^\/users\/([A-Za-z0-9_-]{1,80})\/plan\/preview$/.exec(route);
      if (previewRoute) {
        const account = directory().accounts.find(item => item.id === previewRoute[1]);
        if (!account) throw new AdminError(404, "not_found", "Not found.");
        try { return send(await plans.preview({ id: account.id, email: account.email }, options.bodyObject(await options.readBody(req)))); } catch (error) { return rethrow(error); }
      }
      if (planRoute) {
        const account = directory().accounts.find(item => item.id === planRoute[1]);
        if (!account) throw new AdminError(404, "not_found", "Not found.");
        await plans.edit(owner, { id: account.id, email: account.email }, options.bodyObject(await options.readBody(req))).catch(rethrow);
        return send(await user(account.id));
      }
      const roleRoute = /^\/users\/([A-Za-z0-9_-]{1,80})\/admin-role$/.exec(route);
      if (roleRoute) {
        const body = options.bodyObject(await options.readBody(req));
        if (body.role !== null && !ADMIN_ROLES.includes(body.role as AdminRole)) throw new AdminError(400, "invalid_request", "Invalid role.");
        const account = auth.account(roleRoute[1]!);
        if (!account) throw new AdminError(404, "not_found", "Not found.");
        if (roleOf(account) === "owner") throw new AdminError(409, "already_owner", "This account is already a full admin.");
        const before = account.adminRole ?? null;
        auth.setAdminRole(account.id, body.role as AdminRole | null);
        await audit(owner.id, body.role ? "admin.role.grant" : "admin.role.revoke", account.id, { role: (body.role as string | null) ?? before });
        return send({ role: account.adminRole ?? null });
      }
      if (route === "/ops/collect") {
        if (!options.ops) throw new AdminError(404, "not_found", "The ops page is not connected.");
        const result = await options.ops.collect();
        await audit(owner.id, "ops.collect", null);
        return send(result);
      }
      if (route === "/revenue/sync") {
        const result = await deep.syncRevenue().catch(rethrow);
        await audit(owner.id, "revenue.sync", null, result);
        return send(result);
      }
      const action = /^\/clouds\/(c[0-9a-f]{24})\/(pause|resume|delete|end-trial)$/.exec(route);
      if (action) return send(await cloudAction(owner, action[1]!, action[2]!, options.bodyObject(await options.readBody(req))));
    }
    throw new AdminError(404, "not_found", "Route not found.");
  }
  return { handle, isAdmin: (email: string) => allowed.has(email.toLowerCase()), roleOf, customers: () => deep.customers() };
}
