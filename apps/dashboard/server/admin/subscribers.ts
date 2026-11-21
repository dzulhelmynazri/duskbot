// The subscribers page: one row per person with a subscription, built for watching the trial flow (who is in a trial, who
// pays, who is leaving and why), what each of them does in the app, and the launch cohort's money.
import { createHash } from "node:crypto";
import type { StoredEvent } from "../analytics/sink.ts";
import type { PersonDay, SnapshotRow } from "../analytics/usage.ts";
import type { BillingState, StoredSubscription } from "../billing/store.ts";
import type { StoredWorkspace } from "../store.ts";
import { isOpsMade } from "./money-mode.ts";
import { paysOf, receivedIn, refundsOf } from "../analytics/subscriptions.ts";

const DAY = 86_400_000;
/** the public launch: accounts made at or after this moment are the launch cohort */
export const LAUNCH_AT = Date.parse("2026-11-18T14:26:00Z");
export const LAUNCH_LABEL = "since nov 18, 7:56 pm ist";

export const SUBSCRIBER_FILTERS = ["trial", "cancelling", "paid", "payment_problem", "cancelled", "all"] as const;
export type SubscriberFilter = (typeof SUBSCRIBER_FILTERS)[number];
export type SubscriberBucket = Exclude<SubscriberFilter, "all">;
export type Place = "this computer" | "own server" | "madani cloud";

/** a short name for a person that says nothing about who they are; the same account always gets the same one */
export const handleOf = (accountId: string) => `p-${createHash("sha256").update(accountId).digest("hex").slice(0, 6)}`;

type Sub = Pick<StoredSubscription, "id" | "accountId" | "status" | "cancelAtPeriodEnd" | "trialEndsAt" | "createdAt" | "currentPeriodStart" | "currentPeriodEnd" | "totalCents" | "cart" | "mode" | "review" | "source">;
/** a subscription that counts: bought (no grant or review plan) and past its checkout; the view it is read through already holds one money mode */
export const countsAsBought = (sub: Sub) => !isOpsMade(sub) && sub.status !== "pending";

/** which list a subscription is in now: a trial or paid plan set to end is cancelling; an ended one is cancelled; one whose
 *  charge failed is a payment problem, never paid */
export function bucketOf(sub: Sub, now: number): SubscriberBucket {
  if (sub.status === "ended" || sub.status === "cancelled") return "cancelled";
  if (sub.cancelAtPeriodEnd) return "cancelling";
  if (sub.status === "payment_problem") return "payment_problem";
  return sub.trialEndsAt !== undefined && sub.trialEndsAt > now ? "trial" : "paid";
}
/** the subscription a person's row is about: the newest one still running, else the newest */
export function currentOf(subs: readonly Sub[], now: number): Sub | null {
  const sorted = [...subs].sort((a, b) => b.createdAt - a.createdAt);
  return sorted.find(sub => bucketOf(sub, now) !== "cancelled") ?? sorted[0] ?? null;
}
/** a subscription's monthly value in cents */
export const monthlyOf = (sub: Pick<Sub, "totalCents" | "cart">) => (sub.cart as { interval?: string } | undefined)?.interval === "year" ? Math.round(sub.totalCents / 12) : sub.totalCents;
/** "trial day 2 of 3", "paid", "cancelling", "cancelled" */
export function statusLine(sub: Sub, now: number): string {
  const bucket = bucketOf(sub, now);
  const inTrial = sub.trialEndsAt !== undefined && sub.trialEndsAt > now && bucket !== "cancelled";
  const trial = inTrial ? `trial day ${Math.min(Math.max(1, Math.ceil((sub.trialEndsAt! - sub.createdAt) / DAY)), Math.floor((now - sub.createdAt) / DAY) + 1)} of ${Math.max(1, Math.ceil((sub.trialEndsAt! - sub.createdAt) / DAY))}` : null;
  if (bucket === "cancelling") return trial ? `${trial}, cancelling` : "cancelling";
  if (bucket === "cancelled") return "cancelled";
  if (bucket === "payment_problem") return "payment problem";
  return trial ?? "paid";
}

export interface LaunchStrip { since: number; label: string; accounts: number; mrrCents: number; atRiskCents: number; trial: number; paying: number; paymentProblem: number; cancelling: number; cancelled: number; receivedCents: number }
/** the launch cohort's money: accounts made at or after `since`; mrr is what will bill (running plans not set to end, without
 *  failed charges), at risk is the monthly value of failed charges, received is
 *  payments before tax less refunds (before processor fees), in the money mode of the view it is given */
export function launchStrip(state: Pick<BillingState, "subscriptions" | "invoices" | "refunds">, accounts: ReadonlyArray<{ id: string; createdAt: number }>, now: number, since = LAUNCH_AT): LaunchStrip {
  const cohort = new Set(accounts.filter(account => account.createdAt >= since).map(account => account.id));
  const subs = state.subscriptions.filter(sub => cohort.has(sub.accountId) && countsAsBought(sub));
  const byPerson = new Map<string, Sub[]>();
  for (const sub of subs) byPerson.set(sub.accountId, [...(byPerson.get(sub.accountId) ?? []), sub]);
  const counts = { trial: 0, paying: 0, paymentProblem: 0, cancelling: 0, cancelled: 0 };
  const countOf = { trial: "trial", paid: "paying", payment_problem: "paymentProblem", cancelling: "cancelling", cancelled: "cancelled" } as const;
  for (const list of byPerson.values()) counts[countOf[bucketOf(currentOf(list, now)!, now)]]++;
  const mrrCents = subs.filter(sub => { const bucket = bucketOf(sub, now); return bucket === "trial" || bucket === "paid"; }).reduce((sum, sub) => sum + monthlyOf(sub), 0);
  const atRiskCents = subs.filter(sub => bucketOf(sub, now) === "payment_problem").reduce((sum, sub) => sum + monthlyOf(sub), 0);
  const bought = new Set(subs.map(sub => sub.id));
  const payments = state.invoices.filter(invoice => cohort.has(invoice.accountId) && (invoice.subscriptionId === null || bought.has(invoice.subscriptionId)) && invoice.status !== "failed");
  const pays = paysOf({ invoices: payments, ledger: [] }), until = Math.max(since, now) + 1;
  const receivedCents = receivedIn(pays, refundsOf({ refunds: state.refunds ?? [], ledger: [] }, pays), since, until, until - since).cents;
  return { since, label: LAUNCH_LABEL, accounts: cohort.size, mrrCents, atRiskCents, ...counts, receivedCents };
}

export interface TrialTotals { active: number; cancelling: number; mrrAtStake: number; ended: number; converted: number; conversion: number | null }
/** every free trial so far: what is running now, what it is worth if it converts, and how many finished trials went on to pay */
export function trialTotals(subscriptions: readonly Sub[], now: number): TrialTotals {
  const trials = subscriptions.filter(sub => countsAsBought(sub) && sub.trialEndsAt !== undefined);
  const running = trials.filter(sub => sub.trialEndsAt! > now && bucketOf(sub, now) !== "cancelled");
  const ended = trials.filter(sub => sub.trialEndsAt! <= now);
  const converted = ended.filter(sub => sub.status === "active" || sub.status === "payment_problem").length;
  return { active: running.length, cancelling: running.filter(sub => sub.cancelAtPeriodEnd).length, mrrAtStake: running.filter(sub => !sub.cancelAtPeriodEnd).reduce((sum, sub) => sum + monthlyOf(sub), 0),
    ended: ended.length, converted, conversion: ended.length ? converted / ended.length : null };
}

export interface SubscriberRow {
  accountId: string; handle: string; email: string | null; name: string | null; country: string | null;
  plan: string; bucket: SubscriberBucket; status: string; reason: string | null; monthlyCents: number;
  started: number; trialEndsAt: number | null; renewsAt: number | null;
  messages7d: number; messages: number; turns: number; turns7d: number; failed: number; engines: string[]; apps: number; routines: number; bots: number;
  lastActive: number | null; platforms: string[]; places: Place[]; cloud: "running" | "asleep" | "starting" | "stopped" | null;
}
export interface SubscribersInput {
  now: number;
  accounts: ReadonlyArray<{ id: string; email: string; name?: string | null; createdAt: number }>;
  sessions: ReadonlyArray<{ accountId: string; kind: string; platform?: string | null; lastSeenAt: number }>;
  billing: Pick<BillingState, "subscriptions" | "invoices" | "feedback" | "customers">;
  /** analytics events of the people's apps over the window read: app_messages and app_open */
  events: readonly StoredEvent[];
  people: readonly PersonDay[];
  snapshots: readonly SnapshotRow[];
  workspaces: readonly StoredWorkspace[];
  clouds: ReadonlyArray<{ accountId: string; workspaceId?: string | null; status: string }>;
  planOf(sub: Sub): string;
}
const CLOUD_STATE: Record<string, SubscriberRow["cloud"]> = { running: "running", sleeping: "asleep", stopped: "stopped", provisioning: "starting", checkout: "starting" };
const PLATFORM: Record<string, string> = { darwin: "mac", mac: "mac", macos: "mac", win32: "windows", windows: "windows", linux: "linux", ios: "iphone", android: "android" };

export function subscriberRows(input: SubscribersInput): SubscriberRow[] {
  const { now } = input, week = now - 7 * DAY, weekDay = new Date(week).toISOString().slice(0, 10);
  const subs = new Map<string, Sub[]>();
  for (const sub of input.billing.subscriptions) if (countsAsBought(sub)) subs.set(sub.accountId, [...(subs.get(sub.accountId) ?? []), sub]);
  const per = <T>(build: () => T) => { const map = new Map<string, T>(); return (id: string) => map.get(id) ?? map.set(id, build()).get(id)!; };
  const messages = per(() => ({ week: 0, all: 0 })), platforms = per(() => new Set<string>()), countries = new Map<string, string>();
  for (const event of input.events) {
    if (!event.accountId || !subs.has(event.accountId)) continue;
    if (event.name === "app_messages") { const sent = Number(event.props.sent) || 0, row = messages(event.accountId); row.all += sent; if (event.at >= week) row.week += sent; }
    if (event.name === "app_open") { const platform = PLATFORM[String(event.props.kind === "mobile" ? "ios" : event.props.platform ?? "")]; if (platform) platforms(event.accountId).add(platform); }
    if (event.ctx?.country) countries.set(event.accountId, event.ctx.country);
  }
  const usage = per(() => ({ turns: 0, week: 0, failed: 0, last: null as string | null }));
  for (const day of input.people) {
    if (!subs.has(day.accountId)) continue;
    const row = usage(day.accountId);
    row.turns += day.turns; row.failed += day.failed;
    if (day.day >= weekDay) row.week += day.turns;
    if (day.turns > 0 && (!row.last || day.day > row.last)) row.last = day.day;
  }
  const snaps = per(() => ({ bots: 0, routines: 0, engines: new Set<string>() }));
  for (const row of input.snapshots) {
    if (!subs.has(row.accountId)) continue;
    const mine = snaps(row.accountId);
    mine.bots += row.snapshot.bots; mine.routines += row.snapshot.routines + row.snapshot.webhooks + row.snapshot.appEvents;
    for (const [engine, n] of Object.entries(row.snapshot.botEngines ?? {})) if (n) mine.engines.add(engine);
  }
  const cloudWorkspaces = new Set(input.clouds.map(cloud => cloud.workspaceId).filter((id): id is string => !!id));
  const places = per(() => new Set<Place>());
  const appsOf = new Map<string, number>();
  for (const ws of input.workspaces) {
    const id = ws.ownerAccountId;
    if (!id || !subs.has(id)) continue;
    places(id).add(cloudWorkspaces.has(ws.id) ? "madani cloud" : ws.kind === "vps" ? "own server" : "this computer");
    appsOf.set(id, (appsOf.get(id) ?? 0) + (ws.report?.apps?.services.filter(service => service.connected).length ?? 0));
  }
  const clouds = new Map<string, SubscriberRow["cloud"]>();
  for (const cloud of input.clouds) {
    if (cloud.status === "destroyed" || !subs.has(cloud.accountId)) continue;
    places(cloud.accountId).add("madani cloud");
    const state = CLOUD_STATE[cloud.status] ?? null;
    if (state === "running" || !clouds.get(cloud.accountId)) clouds.set(cloud.accountId, state);
  }
  const seen = new Map<string, number>();
  for (const session of input.sessions) {
    if (session.lastSeenAt > (seen.get(session.accountId) ?? 0)) seen.set(session.accountId, session.lastSeenAt);
    if (session.kind !== "web" && session.platform && subs.has(session.accountId)) { const platform = PLATFORM[session.platform]; if (platform) platforms(session.accountId).add(platform); }
  }
  const accounts = new Map(input.accounts.map(account => [account.id, account]));
  const reasons = new Map<string, string>();
  for (const row of [...input.billing.feedback].sort((a, b) => a.at - b.at)) reasons.set(row.subscriptionId ?? row.accountId, [row.answer, row.expected, row.improve].filter(Boolean).join(": "));
  const country = new Map(input.billing.customers.map(row => [row.accountId, row.attribution?.country ?? null]));
  const rows: SubscriberRow[] = [];
  for (const [accountId, list] of subs) {
    const sub = currentOf(list, now)!, bucket = bucketOf(sub, now), account = accounts.get(accountId);
    const use = usage(accountId), snap = snaps(accountId), msg = messages(accountId);
    const lastDay = use.last ? Date.parse(`${use.last}T00:00:00Z`) : 0;
    const lastActive = Math.max(seen.get(accountId) ?? 0, lastDay) || null;
    rows.push({
      accountId, handle: handleOf(accountId), email: account?.email ?? null, name: account?.name ?? null, country: country.get(accountId) ?? countries.get(accountId) ?? null,
      plan: input.planOf(sub), bucket, status: statusLine(sub, now), reason: bucket === "cancelled" || bucket === "cancelling" ? reasons.get(sub.id) ?? reasons.get(accountId) ?? null : null,
      monthlyCents: monthlyOf(sub), started: sub.createdAt,
      trialEndsAt: sub.trialEndsAt !== undefined && sub.trialEndsAt > now ? sub.trialEndsAt : null,
      renewsAt: bucket === "paid" || bucket === "trial" || bucket === "payment_problem" ? sub.currentPeriodEnd ?? sub.trialEndsAt ?? null : null,
      messages7d: msg.week, messages: msg.all, turns: use.turns, turns7d: use.week, failed: use.failed, engines: [...snap.engines].sort(), apps: appsOf.get(accountId) ?? 0,
      routines: snap.routines, bots: snap.bots, lastActive, platforms: [...platforms(accountId)].sort(), places: [...places(accountId)].sort(), cloud: clouds.get(accountId) ?? null,
    });
  }
  return rows.sort((a, b) => b.started - a.started);
}

/** the detail sheet's story of one person, oldest first: sign-up, the steps of onboarding, the first reply, checkout, the trial
 *  and how it ended */
export interface Step { at: number; kind: string; label: string }
const STEP_LABEL: Record<string, (event: StoredEvent) => string | null> = {
  signup: () => "signed up",
  onboarding_step: event => `onboarding: ${String(event.props.step ?? "step").replace(/_/g, " ")}`,
  onboarding_done: () => "finished onboarding",
  app_paired: event => `paired the ${String(event.props.kind ?? "app")}`,
  first_bot_reply: () => "first bot reply",
  plan_chosen: event => `chose ${String(event.props.plan ?? "a plan").replace(/_/g, " ")}`,
  checkout_paid: () => "paid at checkout",
  billing: event => typeof event.props.type === "string" ? event.props.type.replace(/[._]/g, " ") : null,
  cancel_flow: event => event.props.outcome === "cancelled" ? `cancelled (${String(event.props.reason ?? "no reason")})` : null,
};
export function timelineOf(events: readonly StoredEvent[], subs: readonly Sub[], feedback: ReadonlyArray<{ at: number; answer: string }>, accountCreated: number, now: number): Step[] {
  const steps: Step[] = [{ at: accountCreated, kind: "account", label: "account made" }];
  for (const event of events) { const label = STEP_LABEL[event.name]?.(event); if (label) steps.push({ at: event.at, kind: event.name, label }); }
  for (const sub of subs) {
    steps.push({ at: sub.createdAt, kind: "subscription", label: sub.trialEndsAt ? `trial started (${Math.max(1, Math.ceil((sub.trialEndsAt - sub.createdAt) / DAY))} days)` : "subscription started" });
    if (sub.trialEndsAt && sub.trialEndsAt <= now && bucketOf(sub, now) !== "cancelled") steps.push({ at: sub.trialEndsAt, kind: "trial_end", label: "trial ended, first charge" });
  }
  for (const row of feedback) steps.push({ at: row.at, kind: "cancel_survey", label: `cancel survey: ${row.answer}` });
  return steps.sort((a, b) => a.at - b.at);
}

/** messages sent per UTC day over the last `days` days, oldest first */
export function dailyMessages(events: readonly StoredEvent[], now: number, days = 30): Array<{ day: string; sent: number }> {
  const out = Array.from({ length: days }, (_, i) => ({ day: new Date(now - (days - 1 - i) * DAY).toISOString().slice(0, 10), sent: 0 }));
  const index = new Map(out.map((row, i) => [row.day, i]));
  for (const event of events) if (event.name === "app_messages") { const i = index.get(new Date(event.at).toISOString().slice(0, 10)); if (i !== undefined) out[i]!.sent += Number(event.props.sent) || 0; }
  return out;
}

const tally = (values: readonly string[]) => [...values.reduce((map, value) => map.set(value, (map.get(value) ?? 0) + 1), new Map<string, number>())]
  .map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
/** what a person used and where it went wrong, from their own app events */
export function usageOf(events: readonly StoredEvent[]) {
  const action = (name: string) => events.filter(event => event.name === "app_action" && event.props.name === name);
  return {
    features: tally(events.filter(event => event.name === "app_feature").map(event => String(event.props.feature ?? "other").replace(/_/g, " "))).slice(0, 20),
    engines: tally(action("engine_signed_in").map(event => String(event.props.engine ?? "other"))),
    failures: tally([...action("turn_failed").map(event => `turn failed: ${String(event.props.reason ?? "unknown")}${event.props.engine ? ` (${String(event.props.engine)})` : ""}`),
      ...action("tool_failed").map(event => `tool failed: ${String(event.props.tool ?? "other")}`),
      ...events.filter(event => event.name === "app_error").map(event => `app error: ${String(event.props.kind ?? "")} ${String(event.props.code ?? "")}`.trim()),
      ...action("update_failed").map(event => `update failed: ${String(event.props.stage ?? "")}`),
      ...action("crash").map(event => `crash: ${String(event.props.kind ?? "")}`)]).slice(0, 15),
  };
}
