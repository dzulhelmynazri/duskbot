// made-up people, clouds, events and waitlist entries for the admin panel in the local fixture; nothing here is real
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { createDashboardApp } from "../server/app.ts";
import { memoryWaitlist, type WaitlistEntry } from "../server/admin/waitlist.ts";
import { BILLING_CONFIG } from "../server/billing/plans.ts";
import { draft, ledgerId } from "../server/billing/ledger.ts";
import { costOf } from "../server/admin/infra.ts";
import { stateBackend } from "../server/persistence/backend.ts";
import type { UsageCategory, UsageDigest, UsageFrom, UsageFrustration, UsageReason, UsageRun, UsageSession, UsageSignal, UsageTool, UsageTurn } from "../../../shared/usage-signals.ts";

const DAY = 86_400_000;
const PEOPLE = ["mira.okafor", "tomas.lindqvist", "priya.raman", "jules.moreau", "kenji.watanabe", "ana.ferreira", "leo.brandt", "sofia.marin", "ravi.kulkarni", "noor.haddad",
  "elena.petrova", "sam.oduya", "hana.kim", "diego.alvarez", "freya.holm", "omar.siddiqui", "lucia.rossi", "ben.carter"];
const id = (prefix: string) => `${prefix}${Buffer.from(Array.from({ length: 16 }, () => Math.floor(rand() * 256))).toString("base64url")}`;
let seed = 7;
const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = <T,>(list: readonly T[]) => list[Math.floor(rand() * list.length)]!;

export interface SeededAccount { id: string; email: string; name: string; createdAt: number }
/** older customers with a year of subscription history, so every revenue chart has months to show */
const HISTORIC = ["ada.nwosu", "bruno.costa", "chloe.martin", "dev.patel", "emma.larsen", "felix.wagner", "grace.liu", "hugo.blanc", "isla.murphy", "jonas.berg",
  "kira.sato", "liam.walsh", "maya.cohen", "nils.eriksson", "olivia.reyes", "pablo.ruiz", "quinn.foster", "rosa.ibanez", "sven.dahl", "tara.singh",
  "uma.rao", "victor.hugo", "wren.taylor", "yara.haddad", "zoe.becker", "arjun.mehta", "bea.santos", "caleb.wright"];
let historic: SeededAccount[] = [];

/** made-up data only ever goes into a local fixture's JSON stores, never a database */
export function assertFixtureStore() {
  if (process.env.MONGODB_URI || stateBackend()) throw new Error("fixture data only seeds a local fixture; unset MONGODB_URI (it points at a real database).");
}

/** writes auth.json before the service starts, so the seeded accounts have real sign-up dates */
export function seedAdminAuth(dataDir: string, now: number): SeededAccount[] {
  assertFixtureStore();
  const accounts = PEOPLE.map((handle, i) => ({ id: id("acct_"), email: `${handle}@example.test`, name: handle.split(".").map(part => part[0]!.toUpperCase() + part.slice(1)).join(" "),
    createdAt: now - Math.round((i < 3 ? 36 + i * 8 : i * 1.7 + rand() * 2) * DAY) - Math.round(rand() * 20) * 3_600_000 }));
  const identities = accounts.filter((_, i) => i % 3 === 0).map(account => ({ accountId: account.id, provider: "google", subject: id("g_"), email: account.email, label: account.email, addedAt: account.createdAt }));
  const sessions = accounts.flatMap((account, i) => {
    const list = [{ kind: "web", name: "Browser", platform: null, appVersion: null }];
    if (i % 2 === 0) list.push({ kind: "desktop", name: `${account.name.split(" ")[0]}'s ${i % 4 === 0 ? "MacBook Pro" : "PC"}`, platform: i % 4 === 0 ? "darwin" : "win32", appVersion: i % 6 === 0 ? "0.2.14" : "0.2.15" } as never);
    if (i % 5 === 1) list.push({ kind: "mobile", name: "iPhone", platform: "ios", appVersion: "0.2.15" } as never);
    return list.map(device => ({ id: id("ses_"), accountId: account.id, tokenHash: createHash("sha256").update(id("t")).digest("hex"), ...device,
      createdAt: account.createdAt + 3_600_000, lastSeenAt: now - Math.round(rand() * 5 * DAY), expiresAt: now + 60 * DAY }));
  });
  historic = HISTORIC.map((handle, k) => ({ id: id("acct_"), email: `${handle}@example.test`, name: handle.split(".").map(part => part[0]!.toUpperCase() + part.slice(1)).join(" "),
    createdAt: now - Math.round((340 - k * 11 - rand() * 6) * DAY) }));
  const older = historic.map(account => ({ id: id("ses_"), accountId: account.id, tokenHash: createHash("sha256").update(id("t")).digest("hex"), kind: "web", name: "Browser", platform: null, appVersion: null,
    createdAt: account.createdAt + 3_600_000, lastSeenAt: now - Math.round(rand() * 20 * DAY), expiresAt: now + 60 * DAY }));
  writeFileSync(join(dataDir, "auth.json"), JSON.stringify({ accounts: [...accounts, ...historic].map(a => ({ ...a, name: a.name })), identities, sessions: [...sessions, ...older] }), { mode: 0o600 });
  return accounts;
}

export function seedWaitlist(now: number) {
  const entries: WaitlistEntry[] = [];
  for (let i = 0; i < 64; i++) entries.push({ email: `waiting${String(i + 1).padStart(2, "0")}@example.test`, position: i + 1, createdAt: now - Math.round((64 - i) * 0.6 * DAY + rand() * DAY),
    source: pick(["home", "pricing", "x", "launch", null] as const), ref: rand() < 0.2 ? pick(["friend", "newsletter"]) : null });
  return memoryWaitlist(entries);
}

/** clouds through the real (fake-provider) checkout path, then a month of events */
export async function seedAdminData(app: ReturnType<typeof createDashboardApp>, accounts: SeededAccount[], now: number) {
  assertFixtureStore();
  const { analytics, billing } = app;
  for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 9, 12]) {
    const account = accounts[i]!;
    const bundle = BILLING_CONFIG.bundles.find(item => item.id === (i % 3 === 2 ? "pro" : "starter"))!;
    const answer = await billing.service.checkout({ id: account.id, email: account.email }, { kind: "cart", cart: billing.service.quote({ ...bundle.cart, interval: "month" }).cart, name: `${account.name.split(" ")[0]}'s cloud` }, { source: pick(["dash_onboarding", "app_card", "dash_home"] as const) });
    if (i === 5) continue;
    const stored = billing.store.state.checkouts.find(item => item.id === answer.checkoutId)!;
    for (const delivery of billing.fake!.complete(stored.providerSessionId!)) billing.service.handleWebhook(delivery.headers, delivery.body);
  }
  seedPaymentHistory(app, accounts, now);
  for (let n = 0; n < 8; n++) await billing.clouds.reconcile();
  const paused = billing.clouds.list(accounts[1]!.id)[0];
  if (paused) await billing.clouds.power(paused.accountId, paused.id, "off").catch(() => {});

  await seedInfra(app, now);
  await seedWeb(app, accounts, now);
  await seedUsage(app, accounts, now);
  await seedHistoricEvents(app, now);
  for (const [i, account] of accounts.entries()) {
    await analytics.record("signup", { accountId: account.id, at: account.createdAt, props: { method: i % 3 === 0 ? "google" : "email" } });
    await analytics.record("sign_in", { accountId: account.id, at: account.createdAt + 1000, props: { kind: "web" } });
    for (const [s, step] of ["name", "plan", "app"].entries()) if (i % 7 !== 3 || s === 0) await analytics.record("onboarding_step", { accountId: account.id, at: account.createdAt + (s + 1) * 60_000, props: { step, ...(s ? { ms: Math.round(20_000 + rand() * 90_000) } : {}) } });
    if (rand() < 0.6) await analytics.record("page_action", { accountId: account.id, at: account.createdAt + 130_000, props: { action: "choose", label: "plan", value: pick(["plus", "plus", "pro"]), path: "/welcome" } });
    if (rand() < 0.5) await analytics.record("page_action", { accountId: account.id, at: account.createdAt + 200_000, props: { action: "download", label: "download_madani_bot", value: pick(["mac", "mac", "windows"]), path: "/welcome" } });
    if (i % 7 !== 3) await analytics.record("onboarding_done", { accountId: account.id, at: account.createdAt + 5 * 60_000, props: { ms: Math.round(30_000 + rand() * 120_000) } });
    if (i % 2 === 0) await analytics.record("app_paired", { accountId: account.id, at: account.createdAt + 3_600_000, props: { via: "app", platform: i % 4 === 0 ? "darwin" : "win32" } });
    if (i % 3 !== 2 && i < 12) await analytics.record("first_bot_reply", { accountId: account.id, at: account.createdAt + 2 * 3_600_000 });
    for (let t = account.createdAt + DAY; t < now; t += DAY) {
      if (rand() < (new Date(t).getUTCDay() % 6 === 0 ? 0.35 : 0.65)) {
        const ctx = { session: vid(), host: "madani.bot", country: pick(CITIES)[0], device: "desktop" as const, os: i % 4 === 0 ? "mac" as const : "windows" as const, browser: "chrome" as const };
        for (const [k, path] of ["/", pick(["/bots", "/usage", "/cloud", "/billing"])].entries()) await analytics.record("page_view", { accountId: account.id, at: t + k * 90_000, props: { path }, ctx });
      }
      if (i % 2 === 0 && rand() < 0.7) await analytics.record("app_active", { accountId: account.id, at: t + 3_600_000, props: { platform: i % 4 === 0 ? "darwin" : "win32", appVersion: "0.2.15" } });
    }
  }
}

/** made-up InstaBox usage for each cloud this month: some barely wake, some stay up most of the day */
async function seedInfra(app: ReturnType<typeof createDashboardApp>, now: number) {
  const start = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
  const rows = app.billing.clouds.all?.().filter(c => c.status !== "destroyed").flatMap((c, k) => {
    const hours = [0.5, 2, 3, 6, 9, 14, 20][k % 7]!;
    return Array.from({ length: Math.floor((now - start) / DAY) + 1 }, (_, d) => {
      const running = Math.round(hours * (0.6 + rand() * 0.8) * 3600), used = { runningSeconds: running, vcpuSeconds: running * c.spec.vcpu, memGiBSeconds: running * c.spec.ramGb, diskGiBSeconds: 86_400 * c.spec.diskGb, egressBytes: 0 };
      return { day: new Date(start + d * DAY).toISOString().slice(0, 10), cloudId: c.id, accountId: c.accountId, serverId: `fixture-${c.id}`, ...used, ...costOf(used), collectedAt: now };
    });
  }) ?? [];
  await app.infra.store.put(rows);
}

/** the fake provider pays everything at once; spread the payments over when each person would have paid, then add
 * renewals for the older ones and one refund */
function seedPaymentHistory(app: ReturnType<typeof createDashboardApp>, accounts: SeededAccount[], now: number) {
  const state = app.billing.store.state;
  const delays = [26, 3, 70, 5, 0.6, 0, 40, 9, 0, 2, 0, 0, 150];
  for (const [i, account] of accounts.entries()) {
    const at = Math.min(now - 600_000, account.createdAt + Math.round((delays[i] ?? 12) * 3_600_000));
    for (const sub of state.subscriptions.filter(item => item.accountId === account.id && item.currentPeriodStart !== null)) {
      Object.assign(sub, { createdAt: at, currentPeriodStart: at, currentPeriodEnd: at + 30 * DAY });
      const checkout = state.checkouts.find(item => item.id === sub.checkoutId);
      if (checkout) checkout.createdAt = at - 4 * 60_000;
      for (const invoice of state.invoices.filter(item => item.subscriptionId === sub.id)) invoice.createdAt = at;
      for (let renewal = at + 30 * DAY; renewal < now; renewal += 30 * DAY) {
        const payment = `pay_fixture_${sub.id}_${renewal}`;
        state.invoices.push({ id: `inv_${payment}`, accountId: account.id, providerPaymentId: payment, subscriptionId: sub.id, checkoutId: sub.checkoutId, amountCents: sub.totalCents,
          currency: "USD", status: "paid", description: "renewal", createdAt: renewal });
        Object.assign(sub, { currentPeriodStart: renewal, currentPeriodEnd: renewal + 30 * DAY });
      }
    }
  }
  const refunded = state.invoices.find(invoice => invoice.accountId === accounts[7]!.id && invoice.status === "paid");
  if (refunded) {
    (state.refunds ??= []).push({ id: "ref_fixture_1", paymentId: refunded.providerPaymentId, amountCents: refunded.amountCents, currency: refunded.currency });
    state.webhookEvents.push({ id: "wh_fixture_refund", at: Math.min(now - 3_600_000, refunded.createdAt + 2 * DAY), type: "refund.succeeded" });
    refunded.status = "refunded";
  }
  for (const row of state.ledger ?? []) {
    const invoice = state.invoices.find(item => item.providerPaymentId === row.providerPaymentId), sub = state.subscriptions.find(item => item.id === row.subscriptionId);
    if (invoice) row.at = invoice.createdAt;
    else if (sub && row.type === "subscription.active") row.at = sub.createdAt;
    else if (row.type === "checkout.started") { const checkout = state.checkouts.find(item => item.id === row.providerRef); if (checkout) row.at = checkout.createdAt; }
  }
  for (const invoice of state.invoices) if (invoice.description === "renewal") {
    const sub = state.subscriptions.find(item => item.id === invoice.subscriptionId)!;
    ledgerRow(state, { type: "payment.succeeded", at: invoice.createdAt, sub, payment: invoice.providerPaymentId, amount: invoice.amountCents });
    ledgerRow(state, { type: "subscription.renewed", at: invoice.createdAt, sub });
  }
  seedHistoric(app, now);
  seedTrials(app, accounts, now);
  app.billing.store.commit();
}

/** made-up trials for the subscribers page: some running, one set to end with its survey answer, one ended, with a few days of app use each */
function seedTrials(app: ReturnType<typeof createDashboardApp>, accounts: SeededAccount[], now: number) {
  const state = app.billing.store.state, bundle = BILLING_CONFIG.bundles.find(item => item.id === "starter")!;
  const free = accounts.filter(account => !state.subscriptions.some(sub => sub.accountId === account.id)).slice(0, 7);
  const plans: Array<{ cancel?: "scheduled" | "ended"; answer?: "price" | "unused" | "feature"; improve?: string }> = [{}, {}, {}, { cancel: "scheduled", answer: "price", improve: "a cheaper plan for one bot" }, {}, { cancel: "ended", answer: "unused" }, {}];
  for (const [k, account] of free.entries()) {
    const plan = plans[k] ?? {}, start = Math.max(account.createdAt + 3_600_000, now - (0.4 + k * 0.35) * DAY), priced = app.billing.service.quote({ ...bundle.cart, interval: "month" });
    const checkoutId = `chk_trial_${k}`, id = `sub_trial_${k}`;
    state.checkouts.push({ id: checkoutId, accountId: account.id, email: account.email, kind: "cart", cart: priced.cart, cloudId: null, providerSessionId: `fake_trial_${k}`, url: null,
      status: "completed", source: "dash_onboarding", createdAt: start - 5 * 60_000, openUntil: start + 30 * 60_000, subscriptionId: id, amountCents: 0, lines: priced.lines });
    state.subscriptions.push({ id, accountId: account.id, providerSubscriptionId: `dsub_trial_${k}`, checkoutId, cart: priced.cart, totalCents: priced.totalCents, lines: priced.lines,
      status: plan.cancel === "ended" ? "ended" : "active", source: "dash_onboarding", licenseId: null, cloudId: null, currentPeriodStart: start, currentPeriodEnd: start + 3 * DAY, trialEndsAt: start + 3 * DAY,
      cancelAtPeriodEnd: !!plan.cancel, createdAt: start, updatedAt: start, version: 1, lastEventAt: start, mode: "live" });
    if (plan.answer) state.feedback.push({ id: `fb_trial_${k}`, accountId: account.id, cloudId: null, subscriptionId: id, answer: plan.answer, ...(plan.improve ? { improve: plan.improve } : {}), at: start + DAY });
    const install = `fixture-trial-${k}`, platform = k % 3 === 0 ? "win32" : "darwin";
    const ctx = { install, app: { platform, version: "0.2.20" }, country: pick(["IN", "US", "DE", "BR"]) };
    void app.analytics.sink.insert({ id: `ev_trial_id_${k}`, name: "identify", at: start - 60_000, accountId: account.id, props: { via: "app" }, ctx });
    // the site visit that brought them, so the overview's cards can credit the trial
    const visitor = `vtrial${k}`.padEnd(22, "x"), [source, channel] = ([["X", "social"], ["Google", "search"], ["ChatGPT", "ai"], ["Hacker News", "referral"]] as const)[k % 4]!;
    void app.analytics.sink.insert({ id: `ev_trial_vid_${k}`, name: "identify", at: start - 50_000, accountId: account.id, props: { via: "page" }, ctx: { visitor } });
    void app.analytics.sink.insert({ id: `ev_trial_site_${k}`, name: "site_view", at: start - 2 * 3_600_000, accountId: null, props: { path: "/" },
      ctx: { visitor, session: `strial${k}`, pv: `pvtrial${k}`, page: "/", host: "madani.bot", source, channel, country: ctx.country, device: "desktop", os: "mac", browser: k % 2 ? "chrome" : "safari" } });
    for (const [name, props, after] of [["onboarding_step", { step: "name" }, -40_000], ["onboarding_done", {}, -20_000], ["app_open", { kind: "desktop", platform, appVersion: "0.2.20" }, 0],
      ["first_bot_reply", {}, 120_000]] as const) void app.analytics.sink.insert({ id: `ev_trial_${name}_${k}`, name, at: start + after, accountId: account.id, props, ctx });
    for (let d = 0; start + d * DAY < now; d++) {
      void app.analytics.sink.insert({ id: `ev_trial_msg_${k}_${d}`, name: "app_messages", at: Math.min(now - 60_000, start + d * DAY + 3_600_000), accountId: account.id, props: { sent: 3 + ((k * 7 + d * 5) % 11), replies: 3 }, ctx });
      void app.analytics.sink.insert({ id: `ev_trial_feat_${k}_${d}`, name: "app_feature", at: Math.min(now - 60_000, start + d * DAY + 7_200_000), accountId: account.id, props: { feature: pick(["chat_opened", "bot_created", "routine_ran", "voice_used", "app_connected"]) }, ctx });
    }
    if (k % 2 === 1) void app.analytics.sink.insert({ id: `ev_trial_fail_${k}`, name: "app_action", at: now - 2 * 3_600_000, accountId: account.id, props: { name: "turn_failed", reason: "quota", engine: "codex" }, ctx });
  }
}

type BillingState = ReturnType<typeof createDashboardApp>["billing"]["store"]["state"];
type Sub = BillingState["subscriptions"][number];
const monthly = (sub: Sub) => sub.source === "admin_comp" ? 0 : sub.cart.interval === "year" ? Math.round(sub.totalCents / 12) : sub.totalCents;
function ledgerRow(state: BillingState, input: { type: string; at: number; sub: Sub; payment?: string; amount?: number; previous?: number; reason?: string; ref?: string }) {
  const key = `${input.type}:${input.ref ?? input.payment ?? input.sub.providerSubscriptionId}:${input.at}`;
  const plan = BILLING_CONFIG.bundles.find(bundle => bundle.cart.desktop.kind === input.sub.cart.desktop.kind && bundle.cart.license.kind === input.sub.cart.license.kind)?.id ?? "custom";
  (state.ledger ??= []).push({ ...draft({ key, at: input.at, type: input.type, via: "fixture", accountId: input.sub.accountId, subscriptionId: input.sub.id, providerSubscriptionId: input.sub.providerSubscriptionId,
    providerPaymentId: input.payment ?? null, providerRef: input.ref ?? null, amountCents: input.amount ?? null, currency: input.amount === undefined ? null : "USD",
    netCents: input.amount && input.type === "payment.succeeded" ? Math.round(input.amount * 0.84) : null, taxCents: input.amount && input.type === "payment.succeeded" ? Math.round(input.amount * 0.16) : null,
    plan, interval: input.sub.cart.interval, mrrCents: monthly(input.sub), previousMrrCents: input.previous ?? null, reason: input.reason ?? null,
    country: input.type === "payment.succeeded" ? pick(["US", "US", "US", "IN", "DE", "GB", "CA", "FR", "BR", "NL", "AU", "JP"]) : null, status: null }), id: ledgerId(key), recordedAt: input.at });
}

/** a year of made-up subscription lives, shown as live money beside the fixture's own test checkouts: renewals, upgrades and downgrades, failed payments that recover or do not,
 * cancellations, a comeback, a yearly plan, a comp, a refund and a dispute */
function seedHistoric(app: ReturnType<typeof createDashboardApp>, now: number) {
  const state = app.billing.store.state, quote = (bundle: string, interval: "month" | "year") => app.billing.service.quote({ ...BILLING_CONFIG.bundles.find(item => item.id === bundle)!.cart, interval });
  const add = (n: number, months: number) => { const d = new Date(n); d.setUTCMonth(d.getUTCMonth() + months); return d.getTime(); };
  let paymentN = 0;
  function subscribe(account: SeededAccount, start: number, bundle: string, interval: "month" | "year", source: string) {
    const priced = quote(bundle, interval), checkoutId = `chk_hist_${account.id.slice(5, 15)}_${start}`;
    state.checkouts.push({ id: checkoutId, accountId: account.id, email: account.email, kind: "cart", cart: priced.cart, cloudId: null, providerSessionId: `fake_hist_${start}`, url: null,
      status: "completed", source, createdAt: start - 6 * 60_000, openUntil: start + 30 * 60_000, subscriptionId: null, amountCents: priced.totalCents, lines: priced.lines });
    const sub: Sub = { id: `sub_hist_${account.id.slice(5, 15)}_${start}`, accountId: account.id, providerSubscriptionId: `dsub_hist_${account.id.slice(5, 15)}_${start}`, checkoutId, cart: priced.cart,
      totalCents: source === "admin_comp" ? 0 : priced.totalCents, lines: priced.lines, status: "active", source, licenseId: null, cloudId: null, currentPeriodStart: start, currentPeriodEnd: add(start, interval === "year" ? 12 : 1),
      cancelAtPeriodEnd: false, createdAt: start, updatedAt: start, version: 1, lastEventAt: start, mode: "live" };
    state.checkouts.at(-1)!.subscriptionId = sub.id;
    state.subscriptions.push(sub);
    ledgerRow(state, { type: "checkout.started", at: start - 6 * 60_000, sub, ref: checkoutId, amount: sub.totalCents });
    return sub;
  }
  function pay(sub: Sub, at: number, status: "paid" | "failed" = "paid") {
    const payment = `pay_hist_${paymentN++}`;
    state.invoices.push({ id: `inv_${payment}`, accountId: sub.accountId, providerPaymentId: payment, subscriptionId: sub.id, checkoutId: sub.checkoutId, amountCents: sub.totalCents, currency: "USD", status,
      description: "renewal", createdAt: at });
    if (sub.totalCents > 0) ledgerRow(state, { type: status === "paid" ? "payment.succeeded" : "payment.failed", at, sub, payment, amount: sub.totalCents, reason: status === "failed" ? pick(["insufficient_funds", "card_declined", "expired_card"]) : undefined });
    return payment;
  }
  /** runs a subscription month by month until `endAt` (or now); `events` changes it on the way */
  function live(sub: Sub, opts: { endAt?: number; cancelScheduled?: boolean; failAt?: number[]; failForever?: number; upgradeAt?: [number, string]; downgradeAt?: [number, string] }) {
    const step = sub.cart.interval === "year" ? 12 : 1;
    pay(sub, sub.createdAt);
    ledgerRow(state, { type: "subscription.active", at: sub.createdAt, sub });
    let period = 0;
    for (let at = add(sub.createdAt, step); at < now && (opts.endAt === undefined || at < opts.endAt); at = add(at, step)) {
      period++;
      if (opts.upgradeAt?.[0] === period || opts.downgradeAt?.[0] === period) {
        const [, bundle] = (opts.upgradeAt?.[0] === period ? opts.upgradeAt : opts.downgradeAt)!;
        const before = monthly(sub), priced = quote(bundle, sub.cart.interval);
        Object.assign(sub, { cart: priced.cart, totalCents: priced.totalCents, lines: priced.lines });
        ledgerRow(state, { type: monthly(sub) > before ? "subscription.upgraded" : "subscription.downgraded", at: at - 3 * DAY, sub, previous: before });
      }
      if (opts.failForever === period) {
        pay(sub, at, "failed"); ledgerRow(state, { type: "subscription.on_hold", at: at + 3_600_000, sub, reason: "card_declined" });
        sub.status = "payment_problem"; sub.currentPeriodStart = add(at, -step); sub.currentPeriodEnd = at;
        if (opts.endAt !== undefined && opts.endAt < now) {
          Object.assign(sub, { status: "ended", updatedAt: opts.endAt });
          ledgerRow(state, { type: "subscription.expired", at: opts.endAt, sub, reason: "payment_failed" });
        }
        return;
      }
      if (opts.failAt?.includes(period)) {
        pay(sub, at, "failed"); ledgerRow(state, { type: "subscription.on_hold", at: at + 3_600_000, sub });
        pay(sub, at + 3 * DAY); ledgerRow(state, { type: "subscription.recovered", at: at + 3 * DAY, sub });
      } else { pay(sub, at); ledgerRow(state, { type: "subscription.renewed", at, sub }); }
      sub.currentPeriodStart = at; sub.currentPeriodEnd = add(at, step);
    }
    if (opts.endAt !== undefined && opts.endAt < now) {
      ledgerRow(state, { type: "subscription.cancel_scheduled", at: opts.endAt - 9 * DAY, sub, reason: pick(["price", "later", "feature", "setup"]) });
      Object.assign(sub, { status: "ended", cancelAtPeriodEnd: true, currentPeriodEnd: opts.endAt, updatedAt: opts.endAt });
      ledgerRow(state, { type: "subscription.cancelled", at: opts.endAt, sub });
    } else if (opts.cancelScheduled) {
      sub.cancelAtPeriodEnd = true; ledgerRow(state, { type: "subscription.cancel_scheduled", at: now - 4 * DAY, sub, reason: "price" });
    }
  }
  const sources = ["dash_onboarding", "app_card", "dash_home", "dash_billing", "app_always_on", "dash_cloud"];
  for (const [k, account] of historic.entries()) {
    const start = account.createdAt + Math.round((k % 4 === 0 ? 0.2 : k % 4 === 1 ? 1.5 : k % 4 === 2 ? 6 : 19) * DAY), source = sources[k % sources.length]!;
    if (k === 26 || k === 27) continue;
    if (k === 9) { live(subscribe(account, start, "starter", "month", "admin_comp"), {}); continue; }
    const bundle = k % 5 === 2 ? "pro" : k === 13 ? "team" : "starter", interval = k % 7 === 3 ? "year" : "month";
    const sub = subscribe(account, start, bundle, interval, source);
    if (k === 1 || k === 6 || k === 11 || k === 17 || k === 21) live(sub, { endAt: add(start, 2 + (k % 4)) + 2 * DAY });
    else if (k === 4) {
      live(sub, { endAt: add(start, 2) + DAY });
      live(subscribe(account, add(start, 5), "pro", "month", "dash_billing"), {});
    } else if (k === 8) live(sub, { failForever: 5, endAt: add(start, 6) });
    else if (k === 14) live(sub, { failForever: Math.max(1, Math.floor((now - start) / (30 * DAY))) });
    else if (k === 0 || k === 5 || k === 15 || k === 19) live(sub, { upgradeAt: [k === 0 ? 4 : 2, "pro"], failAt: k === 5 ? [3] : [] });
    else if (k === 12 || k === 2) live(sub, { downgradeAt: [3, "starter"] });
    else if (k === 18) live(sub, { cancelScheduled: true });
    else live(sub, { failAt: k === 7 || k === 22 ? [2] : [] });
  }
  const refunded = state.invoices.find(invoice => invoice.providerPaymentId.startsWith("pay_hist_") && invoice.status === "paid" && invoice.accountId === historic[11]!.id);
  if (refunded) {
    (state.refunds ??= []).push({ id: "ref_hist_1", paymentId: refunded.providerPaymentId, amountCents: refunded.amountCents, currency: "USD" });
    refunded.status = "refunded";
    const sub = state.subscriptions.find(item => item.id === refunded.subscriptionId)!;
    ledgerRow(state, { type: "refund.succeeded", at: refunded.createdAt + 2 * DAY, sub, payment: refunded.providerPaymentId, ref: "ref_hist_1", amount: refunded.amountCents, reason: "asked within a week" });
  }
  const disputed = state.invoices.filter(invoice => invoice.accountId === historic[2]!.id && invoice.status === "paid").at(-2);
  if (disputed) {
    const sub = state.subscriptions.find(item => item.id === disputed.subscriptionId)!;
    ledgerRow(state, { type: "dispute.opened", at: disputed.createdAt + 9 * DAY, sub, payment: disputed.providerPaymentId, ref: "dsp_hist_1", amount: disputed.amountCents, reason: "unrecognized" });
    if (disputed.createdAt + 30 * DAY < now) ledgerRow(state, { type: "dispute.won", at: disputed.createdAt + 30 * DAY, sub, payment: disputed.providerPaymentId, ref: "dsp_hist_1", amount: disputed.amountCents });
  }
  for (const account of historic) state.customers.push({ accountId: account.id, email: account.email, providerCustomerId: `cus_hist_${account.id.slice(5, 15)}` });
  for (let i = 0; i < 9; i++) {
    const account = historic[(i * 5) % historic.length]!, at = now - Math.round((5 + i * 9) * DAY);
    state.checkouts.push({ id: `chk_left_${i}`, accountId: account.id, email: account.email, kind: "cart", cart: quote("pro", "month").cart, cloudId: null, providerSessionId: `fake_left_${i}`, url: null,
      status: "expired", source: sources[i % sources.length]!, createdAt: at, openUntil: at + 30 * 60_000, subscriptionId: null, amountCents: quote("pro", "month").totalCents, lines: quote("pro", "month").lines });
  }
}

/** the historic customers' visits, sign-ups and recent activity, so channels and usage health have something to read */
async function seedHistoricEvents(app: ReturnType<typeof createDashboardApp>, now: number) {
  const { analytics } = app, state = app.billing.store.state;
  for (const [k, account] of historic.entries()) {
    const touch = TOUCHES[(k * 3) % TOUCHES.length]!, place = CITIES[(k * 5) % CITIES.length]!, visitor = vid(), at = account.createdAt - Math.round((1 + k % 5) * 3_600_000);
    const ctx = { visitor, session: vid(), pv: vid(), page: "/", host: "madani.bot", source: touch.source, channel: touch.channel, ...(touch.referrer ? { referrer: touch.referrer } : {}),
      ...(touch.campaign ? { utm: { campaign: touch.campaign } } : {}), country: place[0], region: place[1], city: place[2], device: "desktop" as const, os: "mac" as const, browser: "chrome" as const };
    await analytics.record("site_view", { at, visitor, props: { path: "/" }, ctx });
    await analytics.record("identify", { accountId: account.id, at: account.createdAt, props: { via: "page" }, ctx: { visitor } });
    await analytics.record("signup", { accountId: account.id, at: account.createdAt, props: { method: k % 3 ? "email" : "google" } });
    const live = state.subscriptions.some(sub => sub.accountId === account.id && sub.status !== "ended");
    const busy = k % 6 === 2 ? 0 : live ? 8 : 0;
    for (let d = 0; d < busy; d++) await analytics.record("app_active", { accountId: account.id, at: now - (d * 1.6 + 0.3) * DAY, props: { platform: "darwin", appVersion: "0.2.15" } });
  }
}

const CITIES: Array<[string, string, string, number, number]> = [
  ["US", "California", "San Francisco", 37.8, -122.4], ["US", "New York", "New York", 40.7, -74.0], ["US", "Texas", "Austin", 30.3, -97.7], ["IN", "Karnataka", "Bengaluru", 13.0, 77.6],
  ["IN", "Maharashtra", "Pune", 18.5, 73.9], ["DE", "Berlin", "Berlin", 52.5, 13.4], ["GB", "England", "London", 51.5, -0.1], ["FR", "Ile-de-France", "Paris", 48.9, 2.4],
  ["BR", "Sao Paulo", "Sao Paulo", -23.6, -46.6], ["JP", "Tokyo", "Tokyo", 35.7, 139.7], ["CA", "Ontario", "Toronto", 43.7, -79.4], ["NL", "North Holland", "Amsterdam", 52.4, 4.9],
  ["SE", "Stockholm", "Stockholm", 59.3, 18.1], ["AU", "New South Wales", "Sydney", -33.9, 151.2], ["SG", "Singapore", "Singapore", 1.3, 103.8], ["NG", "Lagos", "Lagos", 6.5, 3.4],
];
const TOUCHES: Array<{ weight: number; referrer?: string; source: string; channel: string; campaign?: string; ref?: string }> = [
  { weight: 20, source: "direct", channel: "direct" }, { weight: 23, referrer: "x.com", source: "X", channel: "social" },
  { weight: 18, referrer: "www.google.com", source: "Google", channel: "search" }, { weight: 10, referrer: "chatgpt.com", source: "ChatGPT", channel: "ai" },
  { weight: 5, referrer: "www.perplexity.ai", source: "Perplexity", channel: "ai" }, { weight: 7, referrer: "news.ycombinator.com", source: "Hacker News", channel: "social" },
  { weight: 5, referrer: "www.reddit.com", source: "Reddit", channel: "social" }, { weight: 4, referrer: "www.producthunt.com", source: "Product Hunt", channel: "social" },
  { weight: 5, source: "newsletter", channel: "email", campaign: "november-launch" }, { weight: 3, source: "friend", channel: "referral", ref: "friend" },
];
const weightedTouch = () => {
  let weight = rand() * TOUCHES.reduce((sum, touch) => sum + touch.weight, 0);
  return TOUCHES.find(touch => (weight -= touch.weight) < 0) ?? TOUCHES[0]!;
};
const placeOf = () => pick([CITIES[0]!, CITIES[0]!, CITIES[1]!, CITIES[3]!, CITIES[3]!, CITIES[6]!, ...CITIES]);
const PATHS = ["/", "/pricing", "/download", "/docs", "/about", "/changelog"];
const vid = () => id("");
const LANDING = ["hero", "say", "team", "many", "where", "models", "free", "pricing", "how", "everywhere", "faq", "end"];
const CLICKS = [{ label: "monthly", section: "pricing", value: "m" }, { label: "yearly", section: "pricing", value: "y" }, { label: "see_how_it_works", section: "hero" }, { label: "how_do_i_pay", section: "faq" }];

/** site visits through the tracker's own event shapes, accounts linked to the visitor they came from, app use and two chart notes */
async function seedWeb(app: ReturnType<typeof createDashboardApp>, accounts: SeededAccount[], now: number) {
  const { analytics } = app;
  const visit = async (visitor: string, start: number, opts: { pages?: string[]; goals?: Array<[string, Record<string, string>?]>; touch?: (typeof TOUCHES)[number]; place?: (typeof CITIES)[number] } = {}) => {
    const touch = opts.touch ?? weightedTouch(), place = opts.place ?? placeOf(), mobile = rand() < 0.32;
    const term = touch.channel === "search" && rand() < 0.6 ? pick(["ai-assistant", "madani-bot", "personal-ai-agent", "local-ai-assistant", "ai-for-work"]) : undefined;
    const session = vid(), pages = opts.pages ?? ["/", ...(rand() < 0.55 ? [pick(PATHS.slice(1))] : []), ...(rand() < 0.25 ? [pick(PATHS.slice(1))] : [])];
    const base = { session, host: rand() < 0.92 ? "madani.bot" : "preview.madani.bot", country: place[0], region: place[1], city: place[2], lat: place[3], lon: place[4], device: mobile ? "mobile" as const : "desktop" as const,
      os: mobile ? (rand() < 0.6 ? "ios" as const : "android" as const) : pick(["mac", "windows", "linux"] as const), browser: pick(["chrome", "safari", "firefox", "edge"] as const) };
    let at = start;
    for (const [k, path] of pages.entries()) {
      const pv = vid().slice(0, 8);
      await analytics.record("site_view", { at, visitor, props: { path }, ctx: { ...base, pv, page: path, ...(k === 0 ? { source: touch.source, channel: touch.channel as never, referrer: touch.referrer, ref: touch.ref, utm: touch.campaign ? { campaign: touch.campaign, medium: "email", source: "newsletter" } : term ? { term } : undefined } : {}) } });
      const ms = Math.round(4000 + rand() * 90_000);
      await analytics.record("site_leave", { at: at + ms, visitor, props: { path, scroll: Math.round(20 + rand() * 80), ms, folds: path === "/" || path === "/pricing" ? 4 : 1 }, ctx: { ...base, pv, page: path } });
      at += ms + 2000;
    }
    for (const [goal, meta] of opts.goals ?? []) await analytics.record("site_goal", { at, visitor, props: { goal, ...meta }, ctx: { ...base, page: pages.at(-1) } });
    if (pages[0] === "/") {
      const seen = LANDING.slice(0, 2 + Math.floor(rand() * (LANDING.length - 1)));
      for (const section of seen) await analytics.record("site_section", { at: start + 1000, visitor, props: { path: "/", section, ms: Math.round(800 + rand() * 14_000) }, ctx: { ...base, page: "/" } });
      if (rand() < 0.35) await analytics.record("site_goal", { at, visitor, props: { goal: "click", ...pick(CLICKS) }, ctx: { ...base, page: "/" } });
      if (rand() < 0.1) await analytics.record("site_goal", { at, visitor, props: { goal: "form_start", label: "waitlist", section: "end" }, ctx: { ...base, page: "/" } });
      if (rand() < 0.05) await analytics.record("site_goal", { at, visitor, props: { goal: "form_abandon", label: "waitlist", section: "end" }, ctx: { ...base, page: "/" } });
      if (rand() < 0.03) await analytics.record("site_goal", { at, visitor, props: { goal: "rage_click", label: "monthly", section: "pricing" }, ctx: { ...base, page: "/" } });
    }
    return at;
  };
  for (let d = 29; d >= 0; d--) {
    const day = Math.floor(now / DAY) * DAY - d * DAY, weekday = new Date(day).getUTCDay();
    const spike = d === 12 ? 210 : d === 4 ? 110 : d === 11 || d === 13 ? 45 : d === 3 || d === 5 ? 20 : 0;
    const count = Math.round((22 + (29 - d) * 0.8 + rand() * 12) * (weekday === 0 || weekday === 6 ? 0.6 : 1) + spike);
    for (let v = 0; v < count; v++) {
      const goals: Array<[string, Record<string, string>?]> = [];
      if (rand() < 0.08) goals.push(["waitlist_join"]);
      if (rand() < 0.12) goals.push(["download_click", { to: "/download", value: pick(["mac", "mac", "windows", "linux"]) }]);
      await visit(vid(), day + Math.round(rand() * Math.min(DAY - 600_000, Math.max(0, now - day - 600_000))), { goals, ...(d === 12 && rand() < 0.7 ? { touch: TOUCHES[1] } : {}) });
    }
  }
  for (const account of accounts) {
    const visitor = vid(), first = account.createdAt - Math.round(rand() * 3 * DAY) - 600_000;
    await visit(visitor, first, { pages: ["/", "/pricing"], goals: [["cta_click", { to: "/dashboard/signup", from: "/pricing" }]] });
    if (rand() < 0.5) await visit(visitor, account.createdAt - 300_000, { pages: ["/pricing"] });
    await analytics.record("identify", { accountId: account.id, at: account.createdAt + 2000, props: { via: "page" }, ctx: { visitor } });
  }
  for (const [i, account] of accounts.entries()) {
    if (i % 2 && i % 5 !== 1) continue;
    const mobile = i % 2 !== 0, install = vid(), platform = mobile ? i % 4 === 1 ? "ios" : "android" : i % 4 === 0 ? "darwin" : "win32";
    await analytics.record("identify", { accountId: account.id, at: account.createdAt + 3_600_000, props: { via: "app" }, ctx: { install } });
    for (let t = account.createdAt + 3_600_000; t < now; t += DAY * (0.6 + rand())) {
      const ctx = { install, session: vid(), app: { platform, version: "0.2.15" } };
      await analytics.record("app_open", { accountId: account.id, at: t, props: { kind: mobile ? "mobile" : "desktop", platform, appVersion: "0.2.15" }, ctx });
      for (const screen of ["/chat/:id", pick(["/bots", "/routines", "/rooms", "/computers", "/settings"])]) await analytics.record("app_screen", { accountId: account.id, at: t + 60_000, props: { screen }, ctx: { ...ctx, page: screen } });
      if (rand() < 0.6) await analytics.record("app_feature", { accountId: account.id, at: t + 120_000, props: { feature: pick(["bot_created", "routine_created", "routine_ran", "file_uploaded", "voice_used", "app_connected", "computer_used"]) }, ctx });
      const sent = 1 + Math.round(rand() * 14);
      await analytics.record("app_messages", { accountId: account.id, at: t + 900_000, props: { sent, replies: sent, latencyMs: Math.round(900 + rand() * 4000) }, ctx });
      if (rand() < 0.08) await analytics.record("app_error", { accountId: account.id, at: t + 1000_000, props: { kind: "window", code: "error" }, ctx });
      if (rand() < 0.3) await analytics.record("app_action", { accountId: account.id, at: t + 200_000, props: { name: "cloud_card_shown", variant: "free" }, ctx });
      if (rand() < 0.12) await analytics.record("app_action", { accountId: account.id, at: t + 210_000, props: { name: "cloud_card_action", action: pick(["start_trial", "not_now", "not_now"]) }, ctx });
      if (rand() < 0.25) await analytics.record("app_action", { accountId: account.id, at: t + 300_000, props: { name: "reply_reaction", emoji: pick(["yes", "yes", "love", "no"]), on: true }, ctx });
      if (rand() < 0.06) await analytics.record("app_feedback", { accountId: account.id, at: t + 400_000, props: { score: pick([5, 5, 4, 4, 3, 2]), moment: pick(["after_replies", "after_routine"]) }, ctx });
      if (rand() < 0.1) await analytics.record("app_feature", { accountId: account.id, at: t + 500_000, props: { feature: "bot_deleted" }, ctx });
      await analytics.record("app_close", { accountId: account.id, at: t + 1_200_000, props: { ms: Math.round(120_000 + rand() * 1_800_000) }, ctx });
      if (rand() < 0.05) await analytics.record("app_pair_failed", { accountId: account.id, at: t + 1100_000, props: { reason: pick(["expired_code", "network"]) }, ctx });
    }
    if (!mobile && i % 3 === 0) {
      const ctx = { install, session: vid(), app: { platform, version: "0.2.15" } }, where = i % 2 ? "first_run" : "settings";
      if (i % 4 === 0) await analytics.record("app_action", { accountId: account.id, at: now - (2 + rand() * 20) * DAY, props: { name: "usage_sharing", on: false, where }, ctx });
      if (i % 12 === 0) await analytics.record("app_action", { accountId: account.id, at: now - rand() * DAY, props: { name: "usage_sharing", on: true, where }, ctx });
      if (i % 4 !== 0) await analytics.record("app_action", { accountId: account.id, at: now - rand() * 6 * DAY, props: { name: "usage_sharing", on: false, where: "first_run" }, ctx });
    }
  }
  // one paying person's whole road, for the profile: a launch thread on x, the demo, a direct return, sign-up, the upsell, checkout and a cloud
  const mira = accounts[0]!, story = vid(), paidAt = Math.min(now - 600_000, mira.createdAt + 26 * 3_600_000);
  await visit(story, mira.createdAt - 2 * DAY - 3 * 3_600_000, { pages: ["/", "/pricing", "/docs"], touch: TOUCHES[1], place: CITIES[0],
    goals: [["demo_play", { section: "hero", label: "start_the_live_demo", from: "/" }], ["click", { label: "yearly", section: "pricing", value: "y", from: "/pricing" }], ["download_click", { to: "/download", from: "/pricing", value: "mac" }]] });
  await visit(story, mira.createdAt - 18 * 60_000, { pages: ["/", "/pricing"], touch: TOUCHES[0], place: CITIES[0], goals: [["cta_click", { to: "/dashboard/signup", from: "/pricing", value: "plus" }]] });
  await analytics.record("identify", { accountId: mira.id, at: mira.createdAt + 1500, props: { via: "page" }, ctx: { visitor: story } });
  await analytics.record("plan_chosen", { accountId: mira.id, at: mira.createdAt + 150_000, props: { plan: "plus", period: "month" } });
  const dash = { session: vid(), host: "madani.bot", device: "desktop" as const, os: "mac" as const, browser: "arc" as const, country: "US", region: "California", city: "San Francisco" };
  await analytics.record("page_view", { accountId: mira.id, at: paidAt - 12 * 60_000, props: { path: "/" }, ctx: { ...dash, source: "direct", channel: "direct", page: "/" } });
  await analytics.record("page_action", { accountId: mira.id, at: paidAt - 11 * 60_000, props: { action: "upsell_shown", label: "dash_sidebar", path: "/" }, ctx: dash });
  await analytics.record("page_action", { accountId: mira.id, at: paidAt - 6 * 60_000, props: { action: "upsell_click", label: "dash_sidebar", path: "/", ms: 12_000 }, ctx: dash });
  await analytics.record("page_leave", { accountId: mira.id, at: paidAt - 6 * 60_000 + 500, props: { path: "/", ms: 64_000 }, ctx: { ...dash, page: "/" } });
  await analytics.record("page_view", { accountId: mira.id, at: paidAt - 5 * 60_000, props: { path: "/cloud" }, ctx: { ...dash, page: "/cloud" } });
  await analytics.record("page_leave", { accountId: mira.id, at: paidAt - 60_000, props: { path: "/cloud", ms: 212_000 }, ctx: { ...dash, page: "/cloud" } });
  // the desktop app the evening before: a corner notice closed fast, the sidebar card left alone, the routine pitch put away
  const desk = { install: vid(), session: vid(), app: { platform: "darwin", version: "0.2.15" } }, eve = paidAt - 20 * 3_600_000;
  await analytics.record("identify", { accountId: mira.id, at: eve - 1000, props: { via: "app" }, ctx: { install: desk.install } });
  await analytics.record("app_open", { accountId: mira.id, at: eve, props: { kind: "desktop", platform: "darwin", appVersion: "0.2.15" }, ctx: desk });
  await analytics.record("app_action", { accountId: mira.id, at: eve + 30_000, props: { name: "notice_closed", notice: "cloud_trial_intro_v1", ms: 3_000 }, ctx: desk });
  await analytics.record("app_action", { accountId: mira.id, at: eve + 60_000, props: { name: "upsell_shown", source: "app_sidebar" }, ctx: desk });
  await analytics.record("app_action", { accountId: mira.id, at: eve + 5 * 60_000, props: { name: "upsell_shown", source: "app_routines" }, ctx: desk });
  await analytics.record("app_action", { accountId: mira.id, at: eve + 5 * 60_000 + 4_000, props: { name: "upsell_dismiss", source: "app_routines", ms: 4_000 }, ctx: desk });
  await analytics.record("app_action", { accountId: mira.id, at: eve + 9 * 60_000, props: { name: "two_places_card", action: "bring", kind: "server", ms: 9_000 }, ctx: desk });
  await analytics.record("app_action", { accountId: mira.id, at: eve + 18 * 60_000, props: { name: "upsell_ignored", source: "app_sidebar", ms: 30_000 }, ctx: desk });
  await analytics.record("app_action", { accountId: mira.id, at: eve + 18 * 60_000 + 100, props: { name: "notice_ignored", notice: "late_routine_v1", ms: 41_000 }, ctx: desk });
  await analytics.record("app_close", { accountId: mira.id, at: eve + 18 * 60_000 + 200, props: { ms: 18 * 60_000 }, ctx: desk });
  await analytics.record("cloud_state", { accountId: mira.id, at: paidAt + 40_000, props: { cloudId: "c0123456789abcdef01234567", kind: "starter", region: "us-east", from: "new", to: "provisioning" } });
  await analytics.record("cloud_state", { accountId: mira.id, at: paidAt + 4 * 60_000, props: { cloudId: "c0123456789abcdef01234567", kind: "starter", region: "us-east", from: "provisioning", to: "running" } });
  for (let v = 0; v < 9; v++) await visit(vid(), now - Math.round(rand() * 25 * 60_000), { pages: rand() < 0.5 ? ["/", "/pricing"] : ["/"], goals: rand() < 0.3 ? [["waitlist_join"]] : [] });
  const BOTS: Array<[string, "answers" | "indexing" | "training"]> = [["GPTBot", "training"], ["ChatGPT-User", "answers"], ["ClaudeBot", "training"], ["PerplexityBot", "indexing"], ["OAI-SearchBot", "indexing"], ["Claude-User", "answers"]];
  for (let c = 0; c < 140; c++) { const [bot, kind] = pick(BOTS); await analytics.sink.crawl({ at: now - Math.round(rand() * 29 * DAY), bot, kind, path: pick([...PATHS, "/robots.txt", "/llms.txt", "/docs/getting-started"]), host: "preview.madani.bot" }); }
  await analytics.sink.saveNote({ id: "note_launchx1", at: now - 12 * DAY, text: "launch thread on x", by: accounts[0]!.id, createdAt: now });
  await analytics.sink.saveNote({ id: "note_pricing2", at: now - 4 * DAY, text: "new pricing page", by: accounts[0]!.id, createdAt: now });
}

const MODELS: Partial<Record<string, string[]>> = { claude: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"], codex: ["gpt-5.1-codex", "gpt-5.1"], gemini: ["gemini-2.5-pro", "gemini-2.5-flash"], grok: ["grok-4"] };
const ACTIONS: Record<string, string[]> = { gmail: ["gmail_send_email", "gmail_fetch_emails", "gmail_create_email_draft", "gmail_reply_to_thread"], github: ["github_create_an_issue", "github_list_pull_requests"],
  googlecalendar: ["googlecalendar_create_event", "googlecalendar_find_event"], notion: ["notion_create_notion_page", "notion_search_notion_page"], googlesheets: ["googlesheets_batch_update", "googlesheets_get_spreadsheet_info"],
  slack: ["slack_sends_a_message_to_a_slack_channel"], twitter: ["twitter_creation_of_a_post"] };

/** the apps' side: their setup, sessions, errors, features and connect attempts, as the real app events */
async function seedAppSignals(app: ReturnType<typeof createDashboardApp>, account: SeededAccount, i: number, now: number) {
  const { analytics } = app, platform = i % 4 === 0 ? "darwin" : i % 5 === 1 ? "ios" : "win32";
  for (let t = Math.max(account.createdAt, now - 28 * DAY); t < now; t += DAY * (1 + Math.floor(rand() * 3))) {
    const at = t + Math.round((7 + rand() * 14) * 3_600_000);
    await analytics.record("app_open", { accountId: account.id, at, props: { kind: platform === "ios" ? "mobile" : "desktop", platform, appVersion: rand() < 0.7 ? "0.2.15" : "0.2.14" } });
    await analytics.record("app_action", { accountId: account.id, at, props: { name: "env", os: platform, arch: platform === "darwin" ? "arm64" : "x64", locale: pick(["en", "en", "en", "de", "pt_br", "hi", "fr"]),
      screen: platform === "ios" ? "xs" : pick(["m", "l", "l"]), theme: pick(["light", "dark", "dark"]), skin: pick(["grok", "grok_dark", "midnight"]), notifications: pick(["granted", "granted", "default", "denied"]),
      hour: new Date(at).getHours() } });
    await analytics.record("app_close", { accountId: account.id, at: at + 600_000, props: { ms: Math.round(60_000 + rand() * 40 * 60_000) } });
    if (rand() < 0.05) await analytics.record("app_error", { accountId: account.id, at, props: { kind: "window", code: pick(["error", "rejection"]) } });
  }
  for (const [k, feature] of ["bot_created", "chat_opened", "app_connected", "routine_created", "voice_used", "phone_paired", "search_used"].entries())
    if (rand() < 0.95 - k * 0.12) await analytics.record("app_feature", { accountId: account.id, at: account.createdAt + Math.round((k + rand() * 3) * DAY), props: { feature } });
  for (const app_ of ["gmail", "notion", "googlecalendar"].slice(0, 1 + (i % 3))) {
    const result = app_ === "notion" && rand() < 0.5 ? "failed" : "connected";
    await analytics.record("app_action", { accountId: account.id, at: account.createdAt + DAY, props: { name: "connector_connect", app: app_, result } });
  }
  await analytics.record("app_action", { accountId: account.id, at: account.createdAt + 3_600_000, props: { name: "bot_created", source: "template", template: pick(["writer", "researcher", "assistant", "coder"]) } });
}

const ENGINES = [["claude", 50], ["codex", 28], ["gemini", 9], ["grok", 6], ["opencode", 4], ["api", 3]] as const;
const TASKS: Array<{ category: UsageCategory; tools: UsageTool[]; apps: string[]; weight: number; fail: number; reason?: UsageReason; ms: number }> = [
  { category: "email", tools: ["app"], apps: ["gmail"], weight: 22, fail: 0.18, reason: "auth", ms: 25_000 },
  { category: "research", tools: ["browser", "web"], apps: [], weight: 18, fail: 0.06, reason: "timeout", ms: 70_000 },
  { category: "coding", tools: ["terminal", "files"], apps: ["github"], weight: 14, fail: 0.08, reason: "context", ms: 140_000 },
  { category: "chat", tools: [], apps: [], weight: 16, fail: 0.02, reason: "rate_limit", ms: 6_000 },
  { category: "calendar", tools: ["app"], apps: ["googlecalendar"], weight: 8, fail: 0.05, reason: "auth", ms: 18_000 },
  { category: "docs", tools: ["app"], apps: ["notion"], weight: 7, fail: 0.04, reason: "tool", ms: 30_000 },
  { category: "data", tools: ["app", "data"], apps: ["googlesheets"], weight: 6, fail: 0.12, reason: "tool", ms: 45_000 },
  { category: "messaging", tools: ["app"], apps: ["slack"], weight: 5, fail: 0.03, reason: "network", ms: 15_000 },
  { category: "computer", tools: ["computer"], apps: [], weight: 3, fail: 0.2, reason: "crashed", ms: 200_000 },
  { category: "social", tools: ["app", "browser"], apps: ["twitter"], weight: 2, fail: 0.1, reason: "refused", ms: 40_000 },
];
const weighted = <T,>(list: ReadonlyArray<T>, weight: (item: T) => number) => {
  let roll = rand() * list.reduce((sum, item) => sum + weight(item), 0);
  for (const item of list) { roll -= weight(item); if (roll <= 0) return item; }
  return list[0]!;
};
const FRUSTRATIONS = [
  ["email", "claude", "user asked the bot to reply to a long thread in the email app; the sign-in kept expiring and the bot asked them to reconnect three times, so they gave up."],
  ["email", "claude", "the bot was meant to sort the inbox into folders every morning but failed to open the mail app and the person stopped it twice."],
  ["data", "codex", "user asked to reconcile last month's receipts into a spreadsheet; the bot couldn't open the sheet through the sheets app and kept asking for the file location."],
  ["computer", "claude", "the bot tried to fill a form on the computer but kept clicking the wrong field; the person typed in capitals and stopped the turn."],
  ["coding", "codex", "the bot kept breaking the build while fixing a failing test and lost track of the earlier change after the chat got long."],
] as const;
const DIGESTS = [
  "they mostly use it for email triage and drafting replies in the email app, plus a daily news summary. replies are good, but reconnecting the email app is painful and slow. they want calendar scheduling next.",
  "mostly coding help: fixing tests, reading logs and small refactors in the terminal. it works well for short tasks; long sessions forget earlier context. they want it to remember project decisions.",
  "research and reading: comparing products and summarizing articles with the browser. good results, but turns are slow. they would like routines that send a weekly digest.",
  "runs a small shop: updates a spreadsheet of orders, drafts customer emails and posts to social. the sheets app often fails to open, which is frustrating. wants more automation for posting.",
  "uses it as a planner: calendar, reminders and travel planning, mostly from the phone. setup of routines was confusing at first; now a morning routine runs every day.",
];

const SESSIONS: Array<[UsageCategory, string]> = [
  ["coding", "a long coding session in the terminal with github; tests and small refactors went smoothly, but signing in to github took 2 tries."],
  ["email", "worked through the inbox with gmail for most of an hour; drafts were good, but connecting gmail took 3 tries and two replies timed out."],
  ["research", "a long research session with the browser comparing options; results were useful, though replies got slow near the end."],
  ["data", "updated a spreadsheet through the sheets app over many turns; the bot lost track of earlier columns twice and needed reminding."],
];

/** a month of bot turns, routine runs, frustrations, big sessions and weekly notes through the real usage ingest */
async function seedUsage(app: ReturnType<typeof createDashboardApp>, accounts: SeededAccount[], now: number) {
  let serial = 0;
  const uid = (prefix: string) => `${prefix}${String(++serial).padStart(10, "0")}`;
  for (const [i, account] of accounts.entries()) {
    if (i % 6 === 5) continue;
    const power = i % 5 === 0 ? 6 : i % 3 === 0 ? 2.2 : 0.7, ws = `ws_fixture_${i}`, from: UsageFrom = i % 4 === 1 ? "remote" : "app";
    const turns: UsageTurn[] = [], runs: UsageRun[] = [], signals: UsageSignal[] = [];
    for (const engine of i % 2 ? ["claude"] : ["claude", "codex"]) {
      const at = Math.max(account.createdAt, now - 28 * DAY) + 3_600_000;
      signals.push({ id: uid("sig"), at, name: "engine_sign_in", props: { engine, outcome: "started" } });
      const outcome = engine === "codex" && rand() < 0.45 ? "failed" : "succeeded";
      signals.push({ id: uid("sig"), at: at + 60_000, name: "engine_sign_in", props: { engine, outcome, ...(outcome === "failed" ? { reason: pick(["auth", "timeout"]) } : {}) } });
    }
    for (let t = Math.max(account.createdAt, now - 29 * DAY); t < now; t += DAY) {
      if (rand() > (power > 2 ? 0.85 : 0.45)) continue;
      const count = Math.round(power * (2 + rand() * 6));
      for (let k = 0; k < count; k++) {
        const task = weighted(TASKS, item => item.weight), failed = rand() < task.fail, cancelled = !failed && rand() < 0.04;
        turns.push({ id: uid("turn"), at: Math.min(now - 60_000, t + Math.round(rand() * DAY)), engine: weighted(ENGINES, item => item[1])[0], outcome: failed ? "failed" : cancelled ? "cancelled" : "ok",
          ...(failed ? { reason: rand() < 0.75 ? task.reason ?? "unknown" : "unknown" } : cancelled ? { reason: "unknown" as const } : {}), ms: Math.round(task.ms * (0.4 + rand() * 1.8)), tools: task.tools,
          apps: task.apps, category: task.category, from: rand() < 0.15 ? "routine" : from, place: i % 3 === 0 ? "cloud" : "desktop", room: rand() < 0.08 });
        const last = turns.at(-1)!, model = MODELS[last.engine];
        Object.assign(last, { firstMs: Math.round(last.ms * (0.15 + rand() * 0.3)), ...(model ? { model: pick(model) } : {}), bot: `bot${String(i).padStart(3, "0")}${Math.floor(rand() * (1 + i % 4))}xyz`.slice(0, 10).padEnd(10, "x"),
          chat: `chat${String(i).padStart(3, "0")}${Math.floor(rand() * 9)}`.padEnd(10, "x"), ...(failed && task.tools[0] ? { failedTools: [task.tools[0]], ...(task.apps.length ? { failedApps: task.apps } : {}) } : {}),
          ...(task.apps.length ? { actions: [pick(ACTIONS[task.apps[0]!] ?? [`${task.apps[0]}_list_items`])] } : {}) });
      }
      if (i % 3 === 0 && rand() < 0.7) { const trigger = weighted(["schedule", "schedule", "event", "webhook"] as const, () => 1), routine = Math.floor(rand() * 3);
        runs.push({ id: uid("run"), at: t + 8 * 3_600_000, trigger, outcome: rand() < 0.14 ? "failed" : "ok", ms: Math.round(20_000 + rand() * 200_000),
          every: trigger === "schedule" ? (["daily", "weekdays", "hourly"] as const)[routine]! : "event", routine: `rtn${String(i).padStart(3, "0")}${routine}`.padEnd(10, "x") }); }
      if (rand() < 0.5) signals.push({ id: uid("sig"), at: Math.min(now - 60_000, t + 3_600_000), name: "attachment", props: { kind: pick(["image", "image", "pdf", "doc", "sheet", "text"]), size: pick(["lt100k", "lt1m", "lt1m", "lt10m"]) } });
      if (rand() < 0.15) signals.push({ id: uid("sig"), at: Math.min(now - 60_000, t + 7_200_000), name: "setting_changed", props: { key: pick(["theme", "newBotDefaults", "talkingStyle", "helper", "browser"]) } });
      if (rand() < 0.1) signals.push({ id: uid("sig"), at: Math.min(now - 60_000, t + 9_000_000), name: "chat_deleted", props: {} });
    }
    const frustrations: UsageFrustration[] = [];
    if (power >= 2) for (const [category, engine, summary] of FRUSTRATIONS.filter((_, f) => (f + i) % 3 !== 0)) {
      const task = TASKS.find(item => item.category === category)!;
      frustrations.push({ id: uid("frust"), at: now - Math.round(rand() * 20 * DAY), engine, category, tools: task.tools, apps: task.apps, reason: task.reason, signals: pick([["retried", "stopped"], ["thumbs_down", "swearing"], ["failed", "corrective"]] as const).slice(),
        retries: Math.floor(rand() * 4), summary });
    }
    const sessions: UsageSession[] = power >= 2 ? SESSIONS.filter((_, k) => (k + i) % 2 === 0).map(([category, summary], k) => {
      const task = TASKS.find(item => item.category === category)!;
      return { id: uid("session"), at: now - Math.round(rand() * 12 * DAY), engine: k % 2 ? "codex" : "claude", category, tools: task.tools, apps: task.apps, turns: 15 + Math.floor(rand() * 20),
        minutes: 25 + Math.floor(rand() * 60), failed: Math.floor(rand() * 3), ...(i % 4 === 3 ? {} : { summary }) };
    }) : [];
    const digests: UsageDigest[] = power >= 2 ? [{ id: uid("digest"), at: now - Math.round(rand() * 6 * DAY), turns: Math.round(power * 30), days: 5, summary: DIGESTS[i % DIGESTS.length]! }] : [];
    for (let start = 0; start < turns.length; start += 500) await app.usage.ingest(account.id, ws, { turns: turns.slice(start, start + 500), runs: start ? [] : runs, ...(start ? {} : { frustrations, sessions, digests, signals }),
      snapshot: { bots: 1 + (i % 4), rooms: i % 3 === 0 ? 1 : 0, routines: i % 3 === 0 ? 2 : i % 4 === 2 ? 1 : 0, webhooks: i % 7 === 0 ? 1 : 0, appEvents: i % 5 === 0 ? 1 : 0, skills: i % 4,
        chats: 4 + i * 2, archived: i % 5, memory: 1 + (i % 4), botEngines: i % 2 ? { claude: 1 + (i % 4) } : { claude: 1, codex: i % 4 } } }, { kind: i % 3 === 2 ? "vps" : i % 3 === 1 ? "windows" : "mac", version: i % 2 ? "0.2.15" : "0.2.14" });
    await seedAppSignals(app, account, i, now);
  }
}
