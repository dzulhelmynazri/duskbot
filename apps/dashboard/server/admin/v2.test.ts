import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDashboardApp } from "../app.ts";
import { memoryMailer } from "../auth/mail.ts";
import { memorySink, type StoredEvent } from "../analytics/sink.ts";
import type { StoredInvoice, StoredSubscription } from "../billing/store.ts";
import { CSRF_HEADER } from "../../../../shared/account-api.ts";
import { accountIdentity, anonymousIdentity } from "./identity.ts";
import { ledgerOf, moneyOf, paymentsAnswer, totalsOf, type Money } from "./payments.ts";
import { ReadUnavailable, createReadCache } from "./read-cache.ts";
import { subscriptionReport } from "../analytics/subscriptions.ts";
import { planLabel, planOf } from "./payments.ts";

const DAY = 86_400_000;
const time = Date.parse("2026-11-15T12:00:00Z");
const cart = { interval: "month" as const, license: { kind: "solo" as const }, desktop: { kind: "none" as const } };
const sub = (id: string, accountId: string, extra: Partial<StoredSubscription> = {}): StoredSubscription => ({ id, accountId, providerSubscriptionId: `dodo_${id}`, checkoutId: `co_${id}`, cart, totalCents: 2000,
  lines: [], status: "active", licenseId: null, cloudId: null, currentPeriodStart: time - 5 * DAY, currentPeriodEnd: time + 25 * DAY, cancelAtPeriodEnd: false, createdAt: time - 5 * DAY, updatedAt: time,
  version: 1, source: "dash_billing", ...extra });
const invoice = (id: string, accountId: string, subscriptionId: string, extra: Partial<StoredInvoice> = {}): StoredInvoice => ({ id, accountId, providerPaymentId: `pay_${id}`, subscriptionId,
  checkoutId: `co_${subscriptionId}`, amountCents: 2400, taxCents: 400, currency: "USD", status: "paid", description: "solo", createdAt: time - 5 * DAY, ...extra });
function money(): Money {
  return {
    customers: [{ accountId: "acct_payer0001", email: "pat.real@gmail.com", providerCustomerId: "cus_pat" }, { accountId: "acct_tester001", email: "tess@gmail.com", providerCustomerId: "cus_tess" }],
    checkouts: [],
    subscriptions: [sub("sub_live", "acct_payer0001", { mode: "live" }), sub("sub_test", "acct_tester001", { mode: "test", cancelAtPeriodEnd: true }),
      sub("sub_grant", "acct_payer0001", { mode: "live", source: "ops_grant", providerSubscriptionId: null })],
    invoices: [invoice("inv_live1", "acct_payer0001", "sub_live", { mode: "live" }), invoice("inv_live2", "acct_payer0001", "sub_live", { mode: "live", createdAt: time - DAY }),
      invoice("inv_fail", "acct_payer0001", "sub_live", { mode: "live", status: "failed", createdAt: time - 2 * DAY }), invoice("inv_test", "acct_tester001", "sub_test", { mode: "test" }),
      invoice("inv_grant", "acct_payer0001", "sub_grant", { mode: "live", amountCents: 1500, taxCents: 0 })],
    refunds: [{ id: "ref_1", paymentId: "pay_inv_live2", amountCents: 1000, currency: "USD" }],
    ledger: [], webhookEvents: [{ id: "wh_1", at: time - DAY / 2, type: "refund.succeeded" }],
  };
}

describe("admin identity", () => {
  it("names an account by its own name, then the provider's, then its email, and says what an apple relay is", () => {
    expect(accountIdentity({ id: "acct_a", email: "pat@gmail.com", name: "Pat" }, [{ provider: "google", label: "Patricia G", email: "pat@gmail.com" }])).toMatchObject({ name: "Pat", nameFrom: "account", providers: ["email", "google"], emailKind: "email" });
    expect(accountIdentity({ id: "acct_a", email: "pat@gmail.com", name: null }, [{ provider: "google", label: "Patricia G", email: null }])).toMatchObject({ name: "Patricia G", nameFrom: "provider" });
    expect(accountIdentity({ id: "acct_a", email: "pat.real-smith+x@gmail.com", name: "  " }, [])).toMatchObject({ name: "Pat Real Smith", nameFrom: "email", avatarUrl: null, avatarSeed: "acct_a" });
    expect(accountIdentity({ id: "acct_a", email: "x7k2@privaterelay.appleid.com", name: null }, [{ provider: "apple", label: null, email: null }]))
      .toMatchObject({ name: "Apple user (hidden email)", emailKind: "apple_relay", providers: ["email", "apple"] });
    expect(accountIdentity({ id: "acct_a", email: "qa-1@qa.madani.test", name: "QA" }, []).test).toBe(true);
  });
  it("says what an anonymous visitor or install is, never 'account'", () => {
    expect(anonymousIdentity({ key: "vid12345", kind: "visitor", city: "Pune", country: "IN", device: "mobile", os: "android", platform: null }))
      .toMatchObject({ kind: "visitor", name: "Site visitor on mobile (android), Pune, IN", label: "site visitor, not signed in", email: null });
    expect(anonymousIdentity({ key: "install:abc12345", kind: "install", city: null, country: null, device: null, os: null, platform: "darwin" }))
      .toMatchObject({ kind: "install", name: "Desktop app on macOS", label: "desktop app, not signed in" });
  });
});

describe("admin payments", () => {
  it("keeps live and test apart, drops grants, marks refunds and failures, and totals what the revenue report totals", () => {
    const live = moneyOf(money(), "live", "test"), test = moneyOf(money(), "test", "test");
    const ledger = ledgerOf(live, "live");
    expect(ledger.payments.map(row => [row.id, row.type, row.status, row.amountCents])).toEqual([
      ["ref_1", "refund", "refunded", -1000], ["inv_live2", "payment", "partially_refunded", 2400], ["inv_fail", "payment", "failed", 2400], ["inv_live1", "payment", "paid", 2400]]);
    expect(ledger.payments[1]!.dodo).toEqual({ paymentId: "pay_inv_live2", subscriptionId: "dodo_sub_live", customerId: "cus_pat" });
    expect(ledger.people).toEqual([expect.objectContaining({ personId: "acct_payer0001", paidCents: 4800, refundedCents: 1000, netCents: 3800, payments: 2, failed: 1, mrrCents: 2000, status: "active" })]);
    expect(ledgerOf(test, "test").subscriptions.map(row => [row.id, row.status, row.mode])).toEqual([["sub_test", "cancelling", "test"]]);
    const accounts = new Map([["acct_payer0001", { email: "pat.real@gmail.com", createdAt: time - 9 * DAY }]]);
    const totals = totalsOf(live, accounts, "live", time);
    const report = subscriptionReport({ subscriptions: live.subscriptions, invoices: live.invoices, refunds: live.refunds ?? [], ledger: [], checkouts: [], customers: live.customers, accounts,
      activity: new Map(), planOf, planLabel, now: time, modeOf: () => "live" });
    expect(totals).toMatchObject({ grossCents: report.cash.gross, refundsCents: report.cash.refunds, mrrCents: report.headline.mrr, payments: 2, failed: 1, customers: 1, activeSubscriptions: 1 });
    expect(totals).toMatchObject({ grossCents: 4000, taxCents: 800, chargedCents: 4800 });
    expect(totals.mrrCents).toBe(2000);
    expect(totalsOf(test, accounts, "test", time)).toMatchObject({ grossCents: 2000, payments: 1 });
  });
  it("pages payments newest first with a cursor and searches by person and dodo id", () => {
    const identity = (id: string) => accountIdentity({ id, email: id === "acct_payer0001" ? "pat.real@gmail.com" : "tess@gmail.com", name: null }, []);
    const base = { state: money(), serverMode: "test" as const, data: "own", now: time, accounts: new Map(), identity, q: "", status: null, before: null };
    const first = paymentsAnswer({ ...base, mode: "all", limit: 2 });
    expect(first.payments.map(row => row.id)).toEqual(["ref_1", "inv_live2"]);
    expect(first.payments[0]!.person.name).toBe("Pat Real");
    const second = paymentsAnswer({ ...base, mode: "all", limit: 2, before: first.next });
    expect(second.payments.map(row => row.id)).toEqual(["inv_fail", "inv_live1"]);
    expect(paymentsAnswer({ ...base, mode: "all", limit: 10, before: second.next }).payments.map(row => row.id)).toEqual(["inv_test"]);
    expect(paymentsAnswer({ ...base, mode: "all", limit: 10, q: "cus_tess" }).payments.map(row => row.id)).toEqual(["inv_test"]);
    expect(paymentsAnswer({ ...base, mode: "live", limit: 10, status: "failed" }).payments.map(row => row.id)).toEqual(["inv_fail"]);
    expect(first.totals.live.grossCents).toBe(4000);
    expect(first.totals.test.grossCents).toBe(2000);
  });
});

describe("admin read cache", () => {
  it("joins identical reads in flight, keeps an answer for its ttl, and forgets on clear", async () => {
    let clock = 0, runs = 0;
    const cache = createReadCache({ now: () => clock });
    const work = async () => { runs++; await new Promise(resolve => setTimeout(resolve, 5)); return runs; };
    expect(await Promise.all([cache.get("k", 1000, work), cache.get("k", 1000, work)])).toEqual([1, 1]);
    clock = 500;
    expect(await cache.get("k", 1000, work)).toBe(1);
    clock = 1500;
    expect(await cache.get("k", 1000, work)).toBe(2);
    cache.clear();
    expect(await cache.get("k", 1000, work)).toBe(3);
    expect(await cache.get("other", 0, work)).toBe(4);
    expect(await cache.get("other", 0, work)).toBe(5);
  });
  it("fails a slow read or a database error with a clear 503 instead of hanging", async () => {
    const cache = createReadCache({ deadlineMs: 20 });
    await expect(cache.get("slow", 1000, () => new Promise(() => {}))).rejects.toMatchObject({ status: 503, code: "admin_slow" });
    const mongo = Object.assign(new Error("connection refused"), { name: "MongoServerSelectionError" });
    await expect(cache.bounded(Promise.reject(mongo))).rejects.toBeInstanceOf(ReadUnavailable);
    await expect(cache.bounded(Promise.reject(mongo))).rejects.toMatchObject({ code: "admin_data_unavailable" });
    expect(cache.size).toBe(0);
  });
});

describe("analytics sink: people reads", () => {
  it("finds one person's events by account, visitor and install, and sums anonymous people", async () => {
    const sink = memorySink(() => time);
    const add = (event: Partial<StoredEvent> & { id: string; name: string; at: number }) => sink.insert({ accountId: null, props: {}, ...event });
    await add({ id: "e1", name: "site_view", at: time - 3 * DAY, ctx: { visitor: "vidAAAAAAAA", country: "IN", city: "Pune", device: "mobile", os: "android" } });
    await add({ id: "e2", name: "site_view", at: time - 2 * DAY, ctx: { visitor: "vidAAAAAAAA", country: "IN", city: "Pune", device: "mobile", os: "android" } });
    await add({ id: "e3", name: "app_open", at: time - DAY, ctx: { install: "inst00000001", app: { platform: "darwin", version: "0.2.12" } } });
    await add({ id: "e4", name: "app_open", at: time - DAY / 2, accountId: "acct_payer0001", ctx: { install: "inst00000002" } });
    await add({ id: "e5", name: "site_view", at: time - DAY / 3, ctx: { visitor: "vidBBBBBBBB" } });
    expect((await sink.person({ accountId: "acct_payer0001", visitors: ["vidAAAAAAAA"], installs: [], since: 0, limit: 100 })).map(event => event.id)).toEqual(["e1", "e2", "e4"]);
    expect((await sink.person({ accountId: null, visitors: [], installs: ["inst00000001"], since: 0, limit: 100 })).map(event => event.id)).toEqual(["e3"]);
    expect(await sink.visitorCount(0, time, ["site_view"])).toBe(2);
    expect([...(await sink.lastSeen(0))]).toEqual([["acct_payer0001", time - DAY / 2]]);
    const anon = await sink.anonymous(0, time, { limit: 2 });
    expect(anon.total).toBe(3);
    expect(anon.rows.map(row => [row.key, row.kind, row.events])).toEqual([["vidBBBBBBBB", "visitor", 1], ["install:inst00000001", "install", 1]]);
    const rest = await sink.anonymous(0, time, { limit: 2, before: anon.rows.at(-1)!.lastAt });
    expect(rest.rows).toEqual([expect.objectContaining({ key: "vidAAAAAAAA", firstAt: time - 3 * DAY, lastAt: time - 2 * DAY, events: 2, city: "Pune" })]);
  });
});

describe("admin v2 routes", () => {
  const ADMIN = "owner@madanibot.test", origin = "http://127.0.0.1:7999";
  let dataDir: string, server: Server, url: string, app: ReturnType<typeof createDashboardApp>;
  let live: ReturnType<typeof memorySink>;
  const mailer = memoryMailer();
  const csrf = new Map<string, string>();
  async function start(withLive: boolean) {
    dataDir = mkdtempSync(join(tmpdir(), "madani-admin-v2-"));
    live = memorySink(() => time);
    const liveAccounts = [{ id: "acct_payer0001", email: "pat.real@gmail.com", name: null, createdAt: time - 9 * DAY, avatarUrl: "https://lh3.example/pat.png" },
      { id: "acct_relay0001", email: "x7k2@privaterelay.appleid.com", name: null, createdAt: time - 2 * DAY }, { id: "acct_qa000001", email: "qa-1@qa.madani.test", name: "QA", createdAt: time - DAY }];
    app = createDashboardApp({ dataDir, publicUrl: origin, mailer, staticDir: null, now: () => time, analytics: { sink: memorySink(() => time) },
      admin: { emails: [ADMIN], env: {}, ...(withLive ? { live: { label: "madani.bot", sink: live, accounts: async () => liveAccounts, infra: async () => [], daily: async () => [], latest: async () => null,
        identities: async () => [{ accountId: "acct_payer0001", provider: "google" as const, label: "Pat Real", email: "pat.real@gmail.com", addedAt: time }], money: async () => money() } } : {}) } });
    server = createServer(app.handle);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture failed to start.");
    url = `http://127.0.0.1:${address.port}`;
  }
  const call = (path: string, init: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {}) => fetch(`${url}${path}`, {
    method: init.body === undefined ? "GET" : "POST", headers: { origin, ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init.cookie ? { cookie: init.cookie, [CSRF_HEADER]: csrf.get(init.cookie) ?? "" } : {}), ...init.headers }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
  async function login(email: string) {
    const { attempt } = await (await call("/v1/auth/start", { body: { email } })).json() as { attempt: string };
    const code = mailer.outbox.findLast(item => item.to === email)!.text.match(/\b\d{8}\b/)![0];
    const verify = await call("/v1/auth/verify", { body: { attempt, code } });
    const cookie = verify.headers.get("set-cookie")!.split(";")[0]!;
    csrf.set(cookie, (await verify.json() as { csrfToken: string }).csrfToken);
    return cookie;
  }
  beforeEach(() => start(true));
  afterEach(async () => { app.close(); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); rmSync(dataDir, { recursive: true, force: true }); });

  it("answers people, payments and the overview from the live service with names, faces and money, test accounts hidden", async () => {
    await live.insert({ id: "v1", name: "site_view", at: time - DAY, accountId: null, props: {}, ctx: { visitor: "vidAAAAAAAA", country: "US" } });
    await live.insert({ id: "v2", name: "site_view", at: time - DAY, accountId: null, props: {}, ctx: { visitor: "vidBBBBBBBB" } });
    await live.insert({ id: "a1", name: "app_open", at: time - 60_000, accountId: null, props: {}, ctx: { install: "inst00000001", app: { platform: "win32", version: "0.2.12" } } });
    await live.insert({ id: "a2", name: "app_paired", at: time - 60_000, accountId: "acct_relay0001", props: {} });
    const admin = await login(ADMIN);
    const people = await (await call("/v1/admin/v2/people", { cookie: admin })).json() as { data: string; total: number; people: Array<{ person: { id: string; name: string; avatarUrl: string | null; emailKind: string }; paidCents: number; lastSeenAt: number | null }> };
    expect(people.data).toBe("madani.bot");
    expect(people.people.map(row => [row.person.id, row.person.name, row.person.emailKind, row.paidCents])).toEqual([
      ["acct_relay0001", "Apple user (hidden email)", "apple_relay", 0], ["acct_payer0001", "Pat Real", "email", 3800]]);
    expect(people.people[1]!.person.avatarUrl).toBe("https://lh3.example/pat.png");
    expect(people.people[0]!.lastSeenAt).toBe(time - 60_000);
    const anon = await (await call("/v1/admin/v2/people?kind=anonymous", { cookie: admin })).json() as { total: number; people: Array<{ person: { kind: string; name: string; label: string } }> };
    expect(anon.total).toBe(3);
    expect(anon.people[0]!.person).toMatchObject({ kind: "install", name: "Desktop app on Windows", label: "desktop app, not signed in" });
    const pay = await (await call("/v1/admin/v2/payments", { cookie: admin })).json() as { data: string; mode: string; totals: { live: { grossCents: number; mrrCents: number }; test: { grossCents: number } }; payments: Array<{ id: string; person: { name: string } }> };
    expect(pay).toMatchObject({ data: "madani.bot", mode: "live", totals: { live: { grossCents: 4000, mrrCents: 2000 }, test: { grossCents: 2000 } } });
    expect(pay.payments.map(row => row.id)).toEqual(["ref_1", "inv_live2", "inv_fail", "inv_live1"]);
    const overview = await (await call("/v1/admin/v2/overview?days=7", { cookie: admin })).json() as { visitors: { unique: number }; signups: { total: number }; accounts: { total: number; activated: number }; funnel: Array<{ id: string; count: number }> };
    expect(overview.visitors.unique).toBe(2);
    expect(overview.accounts).toMatchObject({ total: 2, activated: 1 });
    expect(overview.funnel.map(step => step.count)).toEqual([2, 1, 1, 0]);
    const shown = await (await call("/v1/admin/v2/people", { cookie: admin, headers: { "x-madani-admin-tests": "show" } })).json() as { total: number };
    expect(shown.total).toBe(3);
    const person = await call("/v1/admin/v2/people/acct_payer0001", { cookie: admin });
    expect(person.status).toBe(200);
    const detail = await person.json() as { person: { name: string }; money: { live: { summary: { netCents: number } } } };
    expect(detail.person.name).toBe("Pat Real");
    expect(detail.money.live.summary.netCents).toBe(3800);
    expect((await call("/v1/admin/v2/people/install%3Ainst00000001", { cookie: admin })).status).toBe(200);
    expect((await call("/v1/admin/v2/payments?mode=bogus", { cookie: admin })).status).toBe(400);
    expect(live.all.map(event => event.id).sort()).toEqual(["a1", "a2", "v1", "v2"]);
  });

  it("reads this service's own data on request, and refuses people who are not admins", async () => {
    const admin = await login(ADMIN);
    const own = await (await call("/v1/admin/v2/payments", { cookie: admin, headers: { "x-madani-admin-data": "own" } })).json() as { data: string; payments: unknown[] };
    expect(own).toMatchObject({ data: "own", payments: [] });
    const people = await (await call("/v1/admin/v2/people", { cookie: admin, headers: { "x-madani-admin-data": "own" } })).json() as { people: Array<{ person: { id: string; name: string } }> };
    // the owner's own .test address is a test account, hidden until asked for
    expect(people.people).toEqual([]);
    const shown = await (await call("/v1/admin/v2/people", { cookie: admin, headers: { "x-madani-admin-data": "own", "x-madani-admin-tests": "show" } })).json() as { people: Array<{ person: { name: string } }> };
    expect(shown.people.map(row => row.person.name)).toEqual(["Owner"]);
    const other = await login("someone@madanibot.test");
    expect((await call("/v1/admin/v2/people", { cookie: other })).status).toBe(403);
    expect((await call("/v1/admin/v2/people")).status).toBe(401);
  });
});
