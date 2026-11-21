import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDashboardApp } from "../app.ts";
import { memoryMailer } from "../auth/mail.ts";
import { memorySink } from "../analytics/sink.ts";
import { BILLING_CONFIG } from "../billing/plans.ts";
import { CSRF_HEADER } from "../../../../shared/account-api.ts";
import { memoryWaitlist } from "./waitlist.ts";
import { costOf, memoryInfraStore } from "./infra.ts";

const ADMIN = "owner@example.test", OTHER = "someone@example.test";
const DAY = 86_400_000;

describe("admin panel api", () => {
  let mailer: ReturnType<typeof memoryMailer>;
  let app: ReturnType<typeof createDashboardApp>;
  let sink: ReturnType<typeof memorySink>;
  let waitlist: ReturnType<typeof memoryWaitlist>;
  let infra: ReturnType<typeof memoryInfraStore>;
  let server: Server;
  let dataDir: string;
  let url: string;
  let time: number;
  const origin = "http://127.0.0.1:7999";
  const csrf = new Map<string, string>();

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "madani-admin-test-"));
    time = Date.parse("2026-11-12T12:00:00Z");
    mailer = memoryMailer();
    sink = memorySink(() => time);
    waitlist = memoryWaitlist([
      { email: "first@example.test", position: 1, createdAt: time - 3 * DAY, source: "home", ref: null },
      { email: "=cmd@example.test", position: 2, createdAt: time - DAY, source: "x", ref: "launch" },
    ]);
    csrf.clear();
    infra = memoryInfraStore();
    app = createDashboardApp({ dataDir, publicUrl: origin, mailer, staticDir: null, now: () => time, analytics: { sink, waitlist, infra }, admin: { emails: [ADMIN], env: {} } });
    server = createServer(app.handle);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture failed to start.");
    url = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    app.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    rmSync(dataDir, { recursive: true, force: true });
  });

  function call(path: string, init: { method?: string; body?: unknown; cookie?: string; csrf?: boolean; headers?: Record<string, string> } = {}) {
    const method = init.method ?? (init.body === undefined ? "GET" : "POST");
    return fetch(`${url}${path}`, { method, headers: { origin, ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      // the fixture's accounts are on example.test, which the panel hides unless asked
      "x-madani-admin-tests": "show", "x-madani-admin-money": "all", ...(init.cookie ? { cookie: init.cookie, ...(init.csrf === false ? {} : { [CSRF_HEADER]: csrf.get(init.cookie) ?? "" }) } : {}), ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
  }
  async function login(email: string) {
    const start = await call("/v1/auth/start", { body: { email } });
    const { attempt } = await start.json() as { attempt: string };
    const code = mailer.outbox.findLast(item => item.to === email && /\b\d{8}\b/.test(item.text))!.text.match(/\b\d{8}\b/)![0];
    const verify = await call("/v1/auth/verify", { body: { attempt, code } });
    expect(verify.status).toBe(200);
    const cookie = verify.headers.get("set-cookie")!.split(";")[0]!;
    csrf.set(cookie, (await verify.json() as { csrfToken: string }).csrfToken);
    return cookie;
  }
  async function grantCloud(email: string) {
    const owner = app.auth.accountByEmail(email)!;
    const bundle = BILLING_CONFIG.bundles.find(item => item.id === "starter")!;
    const answer = await app.billing.service.checkout({ id: owner.id, email: owner.email }, { kind: "cart", cart: app.billing.service.quote({ ...bundle.cart, interval: "month" }).cart }, { source: "dash_home" });
    const stored = app.billing.store.state.checkouts.find(item => item.id === answer.checkoutId)!;
    for (const delivery of app.billing.fake!.complete(stored.providerSessionId!)) app.billing.service.handleWebhook(delivery.headers, delivery.body);
    for (let n = 0; n < 8; n++) await app.billing.clouds.reconcile();
    return answer.cloudId!;
  }
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));

  describe("authorization on every route", () => {
    const reads = ["/v1/admin/me", "/v1/admin/overview", "/v1/admin/overview?days=7", "/v1/admin/users", "/v1/admin/users?q=owner&filter=all", "/v1/admin/clouds", "/v1/admin/clouds?status=all",
      "/v1/admin/waitlist", "/v1/admin/waitlist.csv", "/v1/admin/events", "/v1/admin/events?name=sign_in&days=30", "/v1/admin/health", "/v1/admin/audit", "/v1/admin/revenue/infra", "/v1/admin/ops", "/v1/admin/ops/relays"];

    it("keeps relay limit changes to the admin, with the csrf header", async () => {
      const admin = await login(ADMIN), other = await login(OTHER);
      const path = "/v1/admin/ops/relays/cloudflare/limits", body = { maxTunnels: 10 };
      expect((await call(path, { method: "PUT", body })).status).toBe(401);
      expect((await call(path, { method: "PUT", body, cookie: other })).status).toBe(403);
      expect((await call(path, { method: "PUT", body, cookie: admin, csrf: false })).status).toBe(403);
      // no relay token in this service's env: it says which one to set
      const answer = await call(path, { method: "PUT", body, cookie: admin });
      expect(answer.status).toBe(409);
      expect((await answer.json() as { error: string }).error).toContain("MADANI_CF_RELAY_OPS_TOKEN");
      expect((await call("/v1/admin/ops/relays/nope/limits", { method: "PUT", body, cookie: admin })).status).toBe(404);
    });

    it("answers 401 signed out, 403 for an account not on the list, and 200 for the admin", async () => {
      const admin = await login(ADMIN), other = await login(OTHER);
      const cloudId = await grantCloud(OTHER);
      const accountId = app.auth.accountByEmail(OTHER)!.id;
      const all = [...reads, `/v1/admin/users/${accountId}`, `/v1/admin/clouds/${cloudId}/usage`];
      for (const path of all) {
        expect((await call(path)).status, path).toBe(401);
        const refused = await call(path, { cookie: other });
        expect(refused.status, path).toBe(403);
        expect((await refused.json() as { code: string }).code).toBe("not_admin");
        expect((await call(path, { cookie: admin })).status, path).toBe(200);
      }
      for (const action of ["pause", "resume", "delete", "end-trial"]) {
        const path = `/v1/admin/clouds/${cloudId}/${action}`;
        expect((await call(path, { body: { confirm: cloudId } })).status, path).toBe(401);
        expect((await call(path, { body: { confirm: cloudId }, cookie: other })).status, path).toBe(403);
      }
      expect((await call(`/v1/admin/clouds/${cloudId}/pause`, { body: { confirm: cloudId }, cookie: admin })).status).toBe(200);
      expect((await call(`/v1/admin/clouds/${cloudId}/resume`, { body: { confirm: cloudId }, cookie: admin })).status).toBe(200);
      // deleting needs the managed backend and an ended plan; this cloud is paid and runs on the fake pool
      const refusedDelete = await call(`/v1/admin/clouds/${cloudId}/delete`, { body: { confirm: cloudId }, cookie: admin });
      expect(refusedDelete.status).toBe(409);
      expect((await refusedDelete.json() as { code: string }).code).toBe("not_available");
      // ending an update trial early needs a managed cloud on a service that allows it (preview); this one is neither
      const refusedTrial = await call(`/v1/admin/clouds/${cloudId}/end-trial`, { body: { confirm: cloudId }, cookie: admin });
      expect(refusedTrial.status).toBe(409);
      expect((await refusedTrial.json() as { code: string }).code).toBe("not_available");
    });

    it("needs the CSRF header and the app's own origin on changes", async () => {
      const admin = await login(ADMIN);
      await login(OTHER);
      const cloudId = await grantCloud(OTHER);
      expect((await call(`/v1/admin/clouds/${cloudId}/pause`, { body: { confirm: cloudId }, cookie: admin, csrf: false })).status).toBe(403);
      expect((await call(`/v1/admin/clouds/${cloudId}/pause`, { body: { confirm: cloudId }, cookie: admin, headers: { origin: "https://evil.example" } })).status).toBe(403);
      expect(app.billing.clouds.get(cloudId)!.status).toBe("running");
    });

    it("hides unknown admin routes behind the same gate", async () => {
      const admin = await login(ADMIN);
      expect((await call("/v1/admin/secrets")).status).toBe(401);
      expect((await call("/v1/admin/secrets", { cookie: admin })).status).toBe(404);
      expect((await call("/v1/admin/users/nope", { cookie: admin })).status).toBe(404);
      expect((await call("/v1/admin/users?limit=9999", { cookie: admin })).status).toBe(400);
    });

    it("lets nobody in when no admin email is configured", async () => {
      app.close();
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
      rmSync(dataDir, { recursive: true, force: true });
      dataDir = mkdtempSync(join(tmpdir(), "madani-admin-test-"));
      app = createDashboardApp({ dataDir, publicUrl: origin, mailer, staticDir: null, now: () => time, admin: { emails: [], env: {} } });
      server = createServer(app.handle);
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      expect((await call("/v1/admin/me", { cookie: await login(ADMIN) })).status).toBe(403);
    });
  });

  it("never counts what the operator gave as money, a customer, a conversion or a billing event, in any mode", async () => {
    const admin = await login(ADMIN);
    await login(OTHER);
    await login("given@example.test");
    await login("comped@example.test");
    await grantCloud(OTHER);
    const given = app.auth.accountByEmail("given@example.test")!, comped = app.auth.accountByEmail("comped@example.test")!;
    const bundle = BILLING_CONFIG.bundles.find(item => item.id === "starter")!;
    for (const [source, account] of [["ops_grant", given], ["admin_comp", comped]] as const) {
      const answer = await app.billing.service.checkout({ id: account.id, email: account.email }, { kind: "cart", cart: app.billing.service.quote({ ...bundle.cart, interval: "month" }).cart },
        { operator: { source, amountCents: 1500 } });
      const stored = app.billing.store.state.checkouts.find(item => item.id === answer.checkoutId)!;
      for (const delivery of app.billing.fake!.complete(stored.providerSessionId!)) app.billing.service.handleWebhook(delivery.headers, delivery.body);
    }
    expect(app.billing.store.state.subscriptions.filter(sub => sub.accountId === given.id || sub.accountId === comped.id).length).toBe(2);
    // the grants were charged, so without the rule they would read as two more paying customers
    expect(app.billing.store.state.invoices.filter(row => (row.accountId === given.id || row.accountId === comped.id) && row.status === "paid").map(row => row.amountCents)).toEqual([1500, 1500]);
    const all = { "x-madani-admin-money": "all" };
    const overview = await (await call("/v1/admin/overview?days=7", { cookie: admin, headers: all })).json() as { totals: { paying: number } };
    expect(overview.totals.paying).toBe(1);
    const revenue = await (await call("/v1/admin/revenue?mode=all", { cookie: admin })).json() as { customers: Array<{ accountId: string }>; headline: { customers: number } };
    expect(revenue.customers.map(row => row.accountId)).toEqual([app.auth.accountByEmail(OTHER)!.id]);
    expect(revenue.headline.customers).toBe(1);
    const paying = await (await call("/v1/admin/users?filter=paying", { cookie: admin })).json() as { users: Array<{ email: string }> };
    expect(paying.users.map(user => user.email)).toEqual([OTHER]);
    const profile = await (await call(`/v1/admin/journeys/${given.id}`, { cookie: admin, headers: all })).json() as { customer: boolean; stats: { spentCents: number }; sessions: Array<{ steps: Array<{ kind: string }> }> };
    expect(profile.customer).toBe(false);
    expect(profile.stats.spentCents).toBe(0);
    expect(profile.sessions.flatMap(session => session.steps).filter(step => step.kind === "paid" || step.kind === "billing")).toEqual([]);
    const events = await app.analytics.sink.scan(0, Date.now() + 60_000, ["checkout_paid", "billing"]);
    expect(events.filter(event => event.accountId === given.id || event.accountId === comped.id).map(event => `${event.name}:${String(event.props.type ?? event.props.amountCents)}`)).toEqual([]);
  });

  it("sends no money alert for what the operator gave, and still does for a customer's payment", async () => {
    app.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    app = createDashboardApp({ dataDir, publicUrl: origin, mailer, staticDir: null, now: () => time, analytics: { sink, waitlist, infra },
      admin: { emails: [ADMIN], environment: "production", env: { MADANI_ADMIN_ALERTS: "paid" } } });
    server = createServer(app.handle);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await login(ADMIN);
    await login(OTHER);
    await login("given@example.test");
    const given = app.auth.accountByEmail("given@example.test")!;
    const bundle = BILLING_CONFIG.bundles.find(item => item.id === "starter")!;
    const settle = () => new Promise(resolve => setTimeout(resolve, 20));
    const before = mailer.outbox.length;
    const alertsTo = () => mailer.outbox.slice(before).filter(item => item.to === ADMIN).map(item => item.subject);
    const answer = await app.billing.service.checkout({ id: given.id, email: given.email }, { kind: "cart", cart: app.billing.service.quote({ ...bundle.cart, interval: "month" }).cart },
      { operator: { source: "ops_grant", amountCents: 1500 } });
    const stored = app.billing.store.state.checkouts.find(item => item.id === answer.checkoutId)!;
    for (const delivery of app.billing.fake!.complete(stored.providerSessionId!)) app.billing.service.handleWebhook(delivery.headers, delivery.body);
    await settle();
    const granted = app.billing.store.state.invoices.find(row => row.accountId === given.id && row.status === "paid" && row.amountCents === 1500)!;
    for (const delivery of app.billing.fake!.refund(granted.providerPaymentId)) app.billing.service.handleWebhook(delivery.headers, delivery.body);
    await settle();
    expect(alertsTo()).toEqual([]);
    await grantCloud(OTHER);
    await settle();
    expect(alertsTo().some(subject => subject.startsWith("first payment ever"))).toBe(true);
    const bought = app.billing.store.state.invoices.find(row => row.accountId === app.auth.accountByEmail(OTHER)!.id && row.status === "paid")!;
    for (const delivery of app.billing.fake!.refund(bought.providerPaymentId)) app.billing.service.handleWebhook(delivery.headers, delivery.body);
    await settle();
    expect(alertsTo().some(subject => subject.startsWith("refund:"))).toBe(true);
  });

  it("pauses and resumes a cloud only with the typed confirmation, and audits each action", async () => {
    const admin = await login(ADMIN);
    await login(OTHER);
    const cloudId = await grantCloud(OTHER);
    const missing = await call(`/v1/admin/clouds/${cloudId}/pause`, { body: {}, cookie: admin });
    expect(missing.status).toBe(400);
    expect((await missing.json() as { code: string }).code).toBe("confirm_required");
    const paused = await call(`/v1/admin/clouds/${cloudId}/pause`, { body: { confirm: app.billing.clouds.get(cloudId)!.name }, cookie: admin });
    expect(paused.status).toBe(200);
    expect(app.billing.clouds.get(cloudId)!.wantPower).toBe("off");
    const again = await call(`/v1/admin/clouds/${cloudId}/pause`, { body: { confirm: cloudId }, cookie: admin });
    expect(again.status).toBe(409);
    time += 1000;
    await call(`/v1/admin/clouds/${cloudId}/resume`, { body: { confirm: cloudId }, cookie: admin });
    expect(app.billing.clouds.get(cloudId)!.wantPower).toBe("on");
    const audit = await (await call("/v1/admin/audit", { cookie: admin })).json() as { entries: Array<{ action: string; target: string; actorEmail: string; detail: { ok: boolean } }> };
    expect(audit.entries.map(entry => entry.action)).toEqual(["cloud.resume", "cloud.pause"]);
    expect(audit.entries.every(entry => entry.target === cloudId && entry.actorEmail === ADMIN && entry.detail.ok)).toBe(true);
  });

  it("lists users with plan, clouds and devices, and shows one user's timeline", async () => {
    const admin = await login(ADMIN);
    await login(OTHER);
    const cloudId = await grantCloud(OTHER);
    const list = await (await call("/v1/admin/users?q=someone", { cookie: admin })).json() as { total: number; users: Array<{ email: string; plan: { plan: string } | null; clouds: number; methods: string[] }> };
    expect(list.total).toBe(1);
    expect(list.users[0]).toMatchObject({ email: OTHER, plan: { plan: "plus" }, clouds: 1, methods: ["email"] });
    expect((await (await call("/v1/admin/users?filter=paying", { cookie: admin })).json() as { total: number }).total).toBe(1);
    const id = app.auth.accountByEmail(OTHER)!.id;
    await settle();
    const detail = await (await call(`/v1/admin/users/${id}`, { cookie: admin })).json() as { clouds: Array<{ id: string }>; timeline: Array<{ name: string }>; devices: Array<{ kind: string }> };
    expect(detail.clouds.map(c => c.id)).toEqual([cloudId]);
    expect(detail.devices.map(d => d.kind)).toEqual(["web"]);
    const names = detail.timeline.map(item => item.name);
    for (const name of ["account_created", "signup", "sign_in", "checkout_started", "subscription_paid", "cloud_state", "checkout_paid"]) expect(names).toContain(name);
    const audit = await (await call("/v1/admin/audit", { cookie: admin })).json() as { entries: Array<{ action: string }> };
    expect(audit.entries[0]!.action).toBe("user.view");
  });

  it("leaves test accounts out of people, signups and paying by default, and shows them on request", async () => {
    const admin = await login(ADMIN);
    await login("smoke@example.com");
    await login("pat.real@gmail.com");
    await grantCloud("smoke@example.com");
    const hide = { "x-madani-admin-tests": "" };
    type Users = { total: number; users: Array<{ email: string }> };
    const hidden = await (await call("/v1/admin/users", { cookie: admin, headers: hide })).json() as Users;
    expect(hidden.users.map(user => user.email)).toEqual(["pat.real@gmail.com"]);
    expect((await (await call("/v1/admin/users", { cookie: admin })).json() as Users).total).toBe(3);
    const overview = await (await call("/v1/admin/overview?days=7", { cookie: admin, headers: hide })).json() as { totals: { accounts: number; newAccounts: number; paying: number; clouds: number } };
    expect(overview.totals).toMatchObject({ accounts: 1, newAccounts: 1, paying: 0, clouds: 0 });
    const clouds = await (await call("/v1/admin/clouds?status=all", { cookie: admin, headers: hide })).json() as { clouds: unknown[] };
    expect(clouds.clouds).toEqual([]);
    const revenue = await (await call("/v1/admin/revenue?mode=all", { cookie: admin, headers: hide })).json() as { customers: unknown[] };
    expect(revenue.customers).toEqual([]);
    expect((await (await call("/v1/admin/revenue?mode=all", { cookie: admin })).json() as { customers: unknown[] }).customers).toHaveLength(1);
    expect(app.auth.accountByEmail("smoke@example.com")).toBeTruthy();
  });
  it("keeps harness events off the events page and counts only app activity as using the app", async () => {
    const admin = await login(ADMIN);
    await login("pat.real@gmail.com");
    const pat = app.auth.accountByEmail("pat.real@gmail.com")!.id;
    const hide = { "x-madani-admin-tests": "" };
    for (let i = 0; i < 6; i++) await sink.insert({ id: `qa${i}`, name: "app_open", at: time - 1000 + i, accountId: null, props: { kind: "desktop" }, ctx: { install: `app:qatest_${i}` } });
    await sink.insert({ id: "real1", name: "app_open", at: time - 5000, accountId: pat, props: { kind: "desktop" }, ctx: { install: "app:real" } });
    const events = await (await call("/v1/admin/events?name=app_open&limit=3", { cookie: admin, headers: hide })).json() as { events: Array<{ id: string }> };
    expect(events.events.map(event => event.id)).toEqual(["real1"]);
    const shown = await (await call("/v1/admin/events?name=app_open&limit=3", { cookie: admin })).json() as { events: Array<{ id: string }> };
    expect(shown.events).toHaveLength(3);
    const overview = await (await call("/v1/admin/overview?days=7", { cookie: admin, headers: hide })).json() as { totals: { appWau: number } };
    expect(overview.totals.appWau).toBe(1);
    expect(overview.totals).not.toHaveProperty("wau");
  });
  it("says when a read hit its event limit, and starts the experience chart at the first whole day it holds", async () => {
    const admin = await login(ADMIN);
    sink.scanLimit = 3;
    for (let d = 0; d < 5; d++) await sink.insert({ id: `open${d}`, name: "app_open", at: time - d * DAY, accountId: null, props: { kind: "desktop" }, ctx: { install: "app:real1" } });
    const cut = time - 2 * DAY;
    const experience = await (await call(`/v1/admin/experience?from=${time - 10 * DAY}&to=${time}`, { cookie: admin })).json() as { partialBefore: number | null; days: string[] };
    expect(experience.partialBefore).toBe(cut);
    expect(experience.days[0]).toBe("2026-11-11");
    const sharing = await (await call("/v1/admin/ops/sharing", { cookie: admin })).json() as { partialBefore: number | null };
    expect(sharing.partialBefore).toBe(cut);
    sink.scanLimit = 100;
    const whole = await (await call(`/v1/admin/experience?from=${time - 10 * DAY}&to=${time + 1}`, { cookie: admin })).json() as { partialBefore: number | null; days: string[] };
    expect(whole.partialBefore).toBeNull();
    expect(whole.days[0]).toBe("2026-11-02");
  });
  it("keeps active today to the filtered people, and says how many accounts turned analytics off", async () => {
    const admin = await login(ADMIN);
    await login("smoke@example.com");
    await login("pat.real@gmail.com");
    await login("sam.real@gmail.com");
    app.analytics.setOptOut(app.auth.accountByEmail("sam.real@gmail.com")!.id, true);
    const hide = { "x-madani-admin-tests": "" };
    const overview = await (await call("/v1/admin/overview?days=7", { cookie: admin, headers: hide })).json() as { totals: { accounts: number; activeToday: number; untracked: number | null } };
    expect(overview.totals).toMatchObject({ accounts: 2, activeToday: 2, untracked: 1 });
    const events = await (await call("/v1/admin/events", { cookie: admin, headers: hide })).json() as { untracked: number | null };
    expect(events.untracked).toBe(1);
    const shown = await (await call("/v1/admin/overview?days=7", { cookie: admin })).json() as { totals: { activeToday: number } };
    expect(shown.totals.activeToday).toBe(4);
  });
  it("exports the waitlist as CSV with formula cells neutralised, and audits the export", async () => {
    const admin = await login(ADMIN);
    const res = await call("/v1/admin/waitlist.csv", { cookie: admin });
    expect(res.headers.get("content-type")).toContain("text/csv");
    const text = await res.text();
    expect(text.split("\n")[0]).toBe("\"position\",\"email\",\"joined\",\"source\",\"ref\"");
    expect(text).toContain("\"'=cmd@example.test\"");
    const page = await (await call("/v1/admin/waitlist?q=first", { cookie: admin })).json() as { count: number; total: number; brevo: { state: string }; series: number[] };
    expect(page).toMatchObject({ count: 2, total: 1, brevo: { state: "not_configured" } });
    expect(page.series.reduce((a, b) => a + b, 0)).toBe(2);
    const audit = await (await call("/v1/admin/audit", { cookie: admin })).json() as { entries: Array<{ action: string; detail: { rows: number } }> };
    expect(audit.entries[0]).toMatchObject({ action: "waitlist.export", detail: { rows: 2 } });
  });

  it("sets this month's instabox cost against each customer's mrr", async () => {
    const admin = await login(ADMIN);
    await login(OTHER);
    const cloudId = await grantCloud(OTHER);
    const accountId = app.auth.accountByEmail(OTHER)!.id;
    const measured = { runningSeconds: 4 * 3600, vcpuSeconds: 8 * 3600, memGiBSeconds: 16 * 3600, diskGiBSeconds: 20 * 4 * 3600, egressBytes: 0 };
    const row = (day: string) => ({ day, cloudId, accountId, serverId: "m1", ...measured, ...costOf(measured), collectedAt: time });
    await infra.put([row("2026-11-11"), row("2026-11-12"), row("2026-10-31")]);
    const revenue = await (await call("/v1/admin/revenue?mode=test", { cookie: admin })).json() as { customers: Array<{ accountId: string; mrr: number }> };
    const mrr = revenue.customers.find(c => c.accountId === accountId)!.mrr;
    expect(mrr).toBeGreaterThan(0);
    const answer = await (await call("/v1/admin/revenue/infra", { cookie: admin })).json() as { collected: boolean; month: string; days: number; customers: Array<Record<string, number | string | null>>; worst: Array<{ accountId: string }>; totals: Record<string, number>; awake: Array<{ label: string; clouds: number }> };
    const cost = Math.round(2 * costOf(measured).costCents), elapsed = (time - Date.parse("2026-11-01T00:00:00Z")) / (30 * 86_400_000);
    const fee = Math.round(mrr * 0.06 + 40), projected = Math.round(2 * costOf(measured).costCents / elapsed);
    expect(answer).toMatchObject({ collected: true, month: "2026-11", days: 2 });
    expect(answer.customers).toEqual([expect.objectContaining({ accountId, mrr, costCents: cost, feeCents: fee, projectedCents: projected, marginCents: mrr - fee - projected, awakeHours: 8 })]);
    expect(answer.worst.map(c => c.accountId)).toEqual([accountId]);
    expect(answer.totals).toMatchObject({ mrr, costCents: cost, clouds: 1, unbilledCents: 0 });
    expect(answer.awake.find(bucket => bucket.clouds === 1)!.label).toBe("4-8h");
  });

  it("reports health without failing when backups and probes are not configured", async () => {
    const admin = await login(ADMIN);
    const health = await (await call("/v1/admin/health", { cookie: admin })).json() as { backup: { configured: boolean }; errors: { service: { day: number } }; analytics: { ok: boolean }; checks: unknown[] };
    expect(health).toMatchObject({ backup: { configured: false }, errors: { service: { day: 0 } }, analytics: { ok: true }, checks: [] });
  });

  describe("analytics ingestion", () => {
    it("records signups and sign-ins, and the page's own events with clean props", async () => {
      const cookie = await login(OTHER);
      const id = app.auth.accountByEmail(OTHER)!.id;
      const sent = await call("/v1/events", { cookie, body: { events: [
        { name: "page_view", props: { path: "/bots/ws_abcdefghijkl?secret=1", extra: "dropped" } },
        { name: "onboarding_step", props: { step: "plan" } },
        { name: "onboarding_done" },
        { name: "signup" },
        { name: "nonsense" },
        { name: "onboarding_step", props: { step: "<script>" } },
      ] } });
      expect(sent.status).toBe(204);
      await settle();
      const mine = sink.all.filter(event => event.accountId === id).map(event => [event.name, event.props]);
      expect(mine).toEqual([
        ["signup", { method: "email" }], ["sign_in", { kind: "web" }],
        ["page_view", { path: "/bots/:id" }], ["onboarding_step", { step: "plan" }], ["onboarding_done", {}], ["onboarding_step", {}],
      ]);
      expect(JSON.stringify(sink.all)).not.toContain(OTHER);
    });

    it("keeps anonymous page events to page views and honours Global Privacy Control", async () => {
      expect((await call("/v1/events", { body: { events: [{ name: "page_view", props: { path: "/signup" } }, { name: "onboarding_done" }] } })).status).toBe(204);
      expect((await call("/v1/events", { body: { events: [{ name: "page_view", props: { path: "/" } }] }, headers: { "sec-gpc": "1" } })).status).toBe(204);
      await settle();
      expect(sink.all.map(event => [event.name, event.accountId, event.props])).toEqual([["page_view", null, { path: "/signup" }]]);
      expect((await call("/v1/events", { body: { events: Array.from({ length: 21 }, () => ({ name: "page_view" })) } })).status).toBe(400);
      expect((await call("/v1/events", { body: { events: [] } })).status).toBe(400);
    });

    it("rate limits a signed-in account", async () => {
      const cookie = await login(OTHER);
      let last = 0;
      for (let n = 0; n < 1501; n++) last = (await call("/v1/events", { cookie, body: { events: [{ name: "page_view", props: { path: "/" } }] } })).status;
      expect(last).toBe(429);
    });

    it("forgets an account's events when it opts out, drops new ones, and purges them on deletion", async () => {
      const cookie = await login(OTHER);
      const id = app.auth.accountByEmail(OTHER)!.id;
      await settle();
      expect(sink.all.some(event => event.accountId === id)).toBe(true);
      expect((await call("/v1/account/analytics", { method: "PUT", body: { optOut: true }, cookie, csrf: false })).status).toBe(403);
      const out = await call("/v1/account/analytics", { method: "PUT", body: { optOut: true }, cookie });
      expect(await out.json()).toEqual({ optOut: true });
      expect(sink.all.some(event => event.accountId === id)).toBe(false);
      await call("/v1/events", { cookie, body: { events: [{ name: "onboarding_done" }] } });
      await settle();
      expect(sink.all.some(event => event.accountId === id)).toBe(false);
      expect(await (await call("/v1/account/analytics", { cookie })).json()).toEqual({ optOut: true });
      await call("/v1/account/analytics", { method: "PUT", body: { optOut: false }, cookie });
      await call("/v1/events", { cookie, body: { events: [{ name: "onboarding_done" }] } });
      await settle();
      expect(sink.all.filter(event => event.accountId === id).map(event => event.name)).toEqual(["onboarding_done"]);
      expect((await call("/v1/account/delete", { body: { email: OTHER }, cookie })).status).toBe(200);
      await settle();
      expect(sink.all.some(event => event.accountId === id)).toBe(false);
    });
  });

  describe("aggregation", () => {
    it("counts each account once a day as active, and feeds the overview's series and funnel", async () => {
      const admin = await login(ADMIN);
      const other = await login(OTHER);
      await call("/v1/events", { cookie: other, body: { events: [{ name: "page_view", props: { path: "/" } }, { name: "onboarding_done" }] } });
      await grantCloud(OTHER);
      await settle();
      const day = new Date(time).toISOString().slice(0, 10);
      expect(sink.daySums.get(`${day}|active_accounts`)).toBe(2);
      expect(sink.daySums.get(`${day}|page_view`)).toBe(1);
      const overview = await (await call("/v1/admin/overview?days=7", { cookie: admin })).json() as {
        range: string[]; totals: { accounts: number; paying: number; waitlist: number; clouds: number; activeToday: number };
        series: { signups: number[]; waitlist: number[]; active: number[] }; funnel: Array<{ id: string; count: number }>; clouds: Array<{ state: string; count: number }>;
      };
      expect(overview.range).toHaveLength(7);
      expect(overview.totals).toMatchObject({ accounts: 2, paying: 1, waitlist: 2, clouds: 1, activeToday: 2 });
      // the fake provider's money is test money: the panel's default (live) counts none of it
      const live = await (await call("/v1/admin/overview?days=7", { cookie: admin, headers: { "x-madani-admin-money": "" } })).json() as { totals: { paying: number } };
      expect(live.totals.paying).toBe(0);
      expect(overview.series.signups.at(-1)).toBe(2);
      expect(overview.series.waitlist.reduce((a, b) => a + b, 0)).toBe(2);
      expect(overview.series.active.at(-1)).toBe(2);
      expect(Object.fromEntries(overview.funnel.map(step => [step.id, step.count]))).toEqual({ site: 0, signup: 2, onboarded: 1, cloud: 1, paid: 1, paired: 0, replied: 0 });
      expect(overview.clouds).toEqual([{ state: "running", count: 1 }]);
    });

    it("lists events newest first with counts, filters and a cursor", async () => {
      const admin = await login(ADMIN);
      const id = app.auth.accountByEmail(ADMIN)!.id;
      for (let n = 0; n < 3; n++) { time += 1000; await call("/v1/events", { cookie: admin, body: { events: [{ name: "page_view", props: { path: `/p${n}` } }] } }); }
      await settle();
      const first = await (await call(`/v1/admin/events?name=page_view&account=${id}&limit=2`, { cookie: admin })).json() as { events: Array<{ props: { path: string }; email: string }>; next: number; counts: Array<{ name: string; count: number }> };
      expect(first.events.map(event => event.props.path)).toEqual(["/p2", "/p1"]);
      expect(first.events[0]!.email).toBe(ADMIN);
      expect(first.counts.find(row => row.name === "page_view")!.count).toBe(3);
      const second = await (await call(`/v1/admin/events?name=page_view&before=${first.next}`, { cookie: admin })).json() as { events: Array<{ props: { path: string } }>; next: number | null };
      expect(second.events.map(event => event.props.path)).toEqual(["/p0"]);
      expect(second.next).toBeNull();
      expect((await call("/v1/admin/events?name=bogus", { cookie: admin })).status).toBe(400);
    });
  });

  describe("live analytics (preview reading madani.bot)", () => {
    let live: ReturnType<typeof memorySink>;
    beforeEach(async () => {
      app.close();
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
      live = memorySink(() => time);
      const day = new Date(time).toISOString().slice(0, 10);
      await live.bump(day, "site_visitors", 41);
      await live.bump(day, "site_view", 97);
      await live.insert({ id: "ev_live1", name: "signup", at: time - 1000, accountId: "acct_live", props: { method: "email" } });
      const accounts = [{ id: "acct_live", email: "real@example.test", name: null, createdAt: time - 1000 }];
      app = createDashboardApp({ dataDir, publicUrl: origin, mailer, staticDir: null, now: () => time, analytics: { sink, waitlist, infra },
        admin: { emails: [ADMIN], env: {}, live: { label: "madani.bot", sink: live, accounts: async () => accounts, infra: async () => [], daily: async () => [], latest: async () => null } } });
      server = createServer(app.handle);
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Fixture failed to start.");
      url = `http://127.0.0.1:${address.port}`;
    });

    it("shows the live site's counts, sign-ups and waitlist by default, and this service's own on request", async () => {
      const admin = await login(ADMIN);
      expect(await (await call("/v1/admin/me", { cookie: admin })).json()).toMatchObject({ live: "madani.bot" });
      type Answer = { data: string; totals: { accounts: number; waitlist: number | null; clouds: number }; series: { visitors: number[]; views: number[] } };
      const real = await (await call("/v1/admin/overview?days=7", { cookie: admin })).json() as Answer;
      expect(real.data).toBe("madani.bot");
      expect(real.series.visitors.at(-1)).toBe(41);
      expect(real.series.views.at(-1)).toBe(97);
      expect(real.totals).toMatchObject({ accounts: 1, waitlist: 2, clouds: 0 });
      const own = await (await call("/v1/admin/overview?days=7", { cookie: admin, headers: { "x-madani-admin-data": "own" } })).json() as Answer;
      expect(own.data).toBe("own");
      expect(own.series.visitors.at(-1)).toBe(0);
      expect(own.totals).toMatchObject({ accounts: 1, waitlist: null });
      const events = await (await call("/v1/admin/events?name=signup", { cookie: admin })).json() as { events: Array<{ id: string; email: string | null }> };
      expect(events.events).toEqual([expect.objectContaining({ id: "ev_live1", email: "real@example.test" })]);
      const ownEvents = await (await call("/v1/admin/events?name=signup", { cookie: admin, headers: { "x-madani-admin-data": "own" } })).json() as { events: Array<{ id: string }> };
      expect(ownEvents.events.map(event => event.id)).not.toContain("ev_live1");
      expect((await call("/v1/admin/web", { cookie: admin })).status).toBe(200);
      expect((await call("/v1/admin/journeys/acct_live", { cookie: admin })).status).toBe(200);
      // reading the live site never writes to it: the view's audit lands in this service's own log
      expect(live.all.map(event => event.id)).toEqual(["ev_live1"]);
    });
  });
});
