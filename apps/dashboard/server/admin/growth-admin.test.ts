import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDashboardApp } from "../app.ts";
import { memoryMailer } from "../auth/mail.ts";
import { memorySink } from "../analytics/sink.ts";
import { BILLING_CONFIG } from "../billing/plans.ts";
import { CSRF_HEADER } from "../../../../shared/account-api.ts";
import { memoryWaitlist } from "./waitlist.ts";
import { memoryInfraStore } from "./infra.ts";
import { GROWTH_ROUTES, forGrowth, growthMay } from "./roles.ts";

const OWNER = "owner@example.test", GROWTH = "growth@example.test", BUYER = "buyer@example.test";
const DAY = 86_400_000;
const CLOUD = `c${"a".repeat(24)}`;
const EMAILISH = /[^\s"@]+@[^\s"@]+\.[a-z]{2,}/i;

/** every literal route the admin router answers, read from its source, so a route added there is checked here without a list to update */
const SOURCE = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const LITERAL_ROUTES = [...new Set([...SOURCE.matchAll(/route === "(\/[^"]*)"/g)].map(match => match[1]!))];
/** one concrete path per pattern route; the count is pinned to the source's, so a new pattern route fails until it is listed */
const PATTERN_ROUTES: Array<[method: string, route: string]> = [
  ["GET", "/v2/people/acct_someone1"], ["GET", "/users/acct_someone1"], ["GET", `/clouds/${CLOUD}/usage`], ["GET", "/journeys/acct_someone1"],
  ["PATCH", "/notes/note_abcdef12"], ["DELETE", "/notes/note_abcdef12"], ["PUT", "/ops/relays/cloudflare/limits"],
  ["POST", "/users/acct_someone1/plan"], ["POST", "/users/acct_someone1/plan/preview"], ["POST", "/users/acct_someone1/admin-role"],
  ["POST", `/clouds/${CLOUD}/pause`], ["POST", `/clouds/${CLOUD}/resume`], ["POST", `/clouds/${CLOUD}/delete`], ["POST", `/clouds/${CLOUD}/end-trial`],
];
const PATTERN_COUNT = 11;
const ALLOWED_GETS = ["/me", "/overview", "/web", "/web/country", "/funnel", "/realtime", "/retention", "/waitlist", "/revenue", "/subscribers"];
/** what cloud spend, cost per customer, margins and machines answer on; none of it is the growth role's */
const CLOUD_ROUTES = ["/revenue/infra", "/clouds", "/clouds?status=all", `/clouds/${CLOUD}/usage`, "/ops", "/ops/accounts", "/ops/relays", "/ops/sharing"];

describe("growth admin role", () => {
  let mailer: ReturnType<typeof memoryMailer>;
  let app: ReturnType<typeof createDashboardApp>;
  let sink: ReturnType<typeof memorySink>;
  let server: Server;
  let dataDir: string;
  let url: string;
  let time: number;
  const origin = "http://127.0.0.1:7999";
  const csrf = new Map<string, string>();

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "madani-growth-admin-test-"));
    time = Date.parse("2026-11-12T12:00:00Z");
    mailer = memoryMailer();
    sink = memorySink(() => time);
    const waitlist = memoryWaitlist([
      { email: "waiting@example.test", position: 1, createdAt: time - 3 * DAY, source: "home", ref: null },
      { email: "later@example.test", position: 2, createdAt: time - DAY, source: "x", ref: "launch" },
    ]);
    csrf.clear();
    app = createDashboardApp({ dataDir, publicUrl: origin, mailer, staticDir: null, now: () => time, analytics: { sink, waitlist, infra: memoryInfraStore() }, admin: { emails: [OWNER], env: {} } });
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

  function call(path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) {
    const method = init.method ?? (init.body === undefined ? "GET" : "POST");
    const body = init.body ?? (method === "GET" || method === "HEAD" ? undefined : {});
    return fetch(`${url}${path}`, { method, headers: { origin, ...(body === undefined ? {} : { "content-type": "application/json" }),
      "x-madani-admin-tests": "show", "x-madani-admin-money": "all", ...(init.cookie ? { cookie: init.cookie, [CSRF_HEADER]: csrf.get(init.cookie) ?? "" } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
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
  async function paidBuyer() {
    const buyer = app.auth.accountByEmail(BUYER)!;
    const bundle = BILLING_CONFIG.bundles.find(item => item.id === "starter")!;
    const answer = await app.billing.service.checkout({ id: buyer.id, email: buyer.email }, { kind: "cart", cart: app.billing.service.quote({ ...bundle.cart, interval: "month" }).cart }, { source: "dash_home" });
    const stored = app.billing.store.state.checkouts.find(item => item.id === answer.checkoutId)!;
    for (const delivery of app.billing.fake!.complete(stored.providerSessionId!)) app.billing.service.handleWebhook(delivery.headers, delivery.body);
    for (let n = 0; n < 8; n++) await app.billing.clouds.reconcile();
  }
  async function setup() {
    const owner = await login(OWNER), growth = await login(GROWTH);
    await login(BUYER);
    const growthId = app.auth.accountByEmail(GROWTH)!.id;
    expect((await call("/v1/admin/me", { cookie: growth })).status).toBe(403);
    const granted = await call(`/v1/admin/users/${growthId}/admin-role`, { cookie: owner, body: { role: "growth" } });
    expect(granted.status).toBe(200);
    expect(await granted.json()).toEqual({ role: "growth" });
    return { owner, growth, growthId };
  }

  it("pins the allowlist: reads only, and only these", () => {
    expect(GROWTH_ROUTES.map(pattern => pattern.source)).toEqual([
      "^\\/me$", "^\\/overview$", "^\\/web$", "^\\/web\\/[a-z_]{1,30}$", "^\\/funnel$", "^\\/realtime$", "^\\/retention$", "^\\/waitlist$", "^\\/revenue$", "^\\/subscribers$", "^\\/subscribers\\/[A-Za-z0-9_-]{1,80}$",
    ]);
    for (const route of ALLOWED_GETS) { expect(growthMay("GET", route)).toBe(true); expect(growthMay("POST", route)).toBe(false); }
    expect(growthMay("GET", "/waitlist.csv")).toBe(false);
    expect(growthMay("GET", "/revenue/sync")).toBe(false);
    for (const route of CLOUD_ROUTES) expect(growthMay("GET", route.split("?")[0]!)).toBe(false);
  });

  it("is granted by the owner and lets the role in, with its role on /me", async () => {
    const { owner, growth, growthId } = await setup();
    const me = await call("/v1/admin/me", { cookie: growth });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ admin: true, role: "growth" });
    expect(await (await call("/v1/admin/me", { cookie: owner })).json()).toMatchObject({ role: "owner" });
    const detail = await (await call(`/v1/admin/users/${growthId}`, { cookie: owner })).json() as { account: { admin: unknown } };
    expect(detail.account.admin).toEqual({ owner: false, role: "growth" });
    const audit = await (await call("/v1/admin/audit", { cookie: owner })).json() as { entries: Array<{ action: string; target: string }> };
    expect(audit.entries.some(entry => entry.action === "admin.role.grant" && entry.target === growthId)).toBe(true);
  });

  it("takes the role from MADANI_GROWTH_ADMIN_EMAILS without a grant, still limited", async () => {
    app.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    app = createDashboardApp({ dataDir, publicUrl: origin, mailer, staticDir: null, now: () => time, analytics: { sink, waitlist: null, infra: memoryInfraStore() },
      admin: { emails: [OWNER], growthEmails: [GROWTH.toUpperCase()], env: {} } });
    server = createServer(app.handle);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const growth = await login(GROWTH);
    expect(await (await call("/v1/admin/me", { cookie: growth })).json()).toMatchObject({ admin: true, role: "growth" });
    expect((await call("/v1/admin/users", { cookie: growth })).status).toBe(403);
  });

  it("answers every allowed read", async () => {
    const { growth } = await setup();
    for (const route of ALLOWED_GETS) expect([route, (await call(`/v1/admin${route}`, { cookie: growth })).status]).toEqual([route, 200]);
  });

  it("refuses every other admin route, read or change, with 403", async () => {
    const { growth } = await setup();
    expect(SOURCE.match(/\.exec\(route\)/g)?.length).toBe(PATTERN_COUNT);
    const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
    const checks: Array<[string, string]> = [];
    for (const route of [...LITERAL_ROUTES, "/", "/brand-new-route", "/v2/anything"]) for (const method of methods) if (!growthMay(method, route)) checks.push([method, route]);
    checks.push(...PATTERN_ROUTES);
    for (const route of ALLOWED_GETS) for (const method of methods.slice(1)) checks.push([method, route]);
    expect(checks.length).toBeGreaterThan(150);
    for (const [method, route] of checks) {
      const res = await call(`/v1/admin${route}`, { method, cookie: growth });
      expect([method, route, res.status, (await res.json() as { code?: string }).code]).toEqual([method, route, 403, "not_allowed"]);
    }
    for (const [method, path] of [["GET", "/v1/admin/bug-reports"], ["GET", "/v1/admin/incidents"], ["POST", "/v1/admin/incidents/test"]] as const)
      expect([path, (await call(path, { method, cookie: growth })).status]).toEqual([path, 403]);
  });

  it("gets no cloud cost, spend, margin or cloud figure at all", async () => {
    const { owner, growth } = await setup();
    await paidBuyer();
    for (const route of CLOUD_ROUTES) {
      const res = await call(`/v1/admin${route}`, { cookie: growth });
      expect([route, res.status, (await res.json() as { code?: string }).code]).toEqual([route, 403, "not_allowed"]);
    }
    expect((await call("/v1/admin/revenue/infra", { cookie: owner })).status).toBe(200);
    const overview = await (await call("/v1/admin/overview", { cookie: growth })).json() as { clouds?: unknown; totals: Record<string, unknown> };
    expect(overview.clouds).toBeUndefined();
    expect("clouds" in overview.totals).toBe(false);
    expect(typeof overview.totals.paying).toBe("number");
    const revenue = await (await call("/v1/admin/revenue?mode=all", { cookie: growth })).text();
    expect(revenue).not.toMatch(/costCents|computeCents|marginCents|instabox/i);
  });

  it("cannot grant or revoke roles, its own included", async () => {
    const { owner, growth, growthId } = await setup();
    const buyerId = app.auth.accountByEmail(BUYER)!.id;
    expect((await call(`/v1/admin/users/${buyerId}/admin-role`, { cookie: growth, body: { role: "growth" } })).status).toBe(403);
    expect((await call(`/v1/admin/users/${growthId}/admin-role`, { cookie: growth, body: { role: null } })).status).toBe(403);
    expect(app.auth.account(buyerId)!.adminRole).toBeUndefined();
    const ownerId = app.auth.accountByEmail(OWNER)!.id;
    expect((await call(`/v1/admin/users/${ownerId}/admin-role`, { cookie: owner, body: { role: "growth" } })).status).toBe(409);
    expect((await call(`/v1/admin/users/${buyerId}/admin-role`, { cookie: owner, body: { role: "owner" } })).status).toBe(400);
  });

  it("stops at once when the owner revokes it", async () => {
    const { owner, growth, growthId } = await setup();
    const revoked = await call(`/v1/admin/users/${growthId}/admin-role`, { cookie: owner, body: { role: null } });
    expect(await revoked.json()).toEqual({ role: null });
    expect((await call("/v1/admin/me", { cookie: growth })).status).toBe(403);
    expect((await call("/v1/admin/revenue", { cookie: growth })).status).toBe(403);
  });

  it("gets revenue and traffic with no email, name or customer list", async () => {
    const { owner, growth } = await setup();
    await paidBuyer();
    const buyerId = app.auth.accountByEmail(BUYER)!.id;
    await sink.insert({ id: "evt_site_1", at: time - 60_000, name: "site_view", accountId: buyerId, props: { path: "/" },
      ctx: { visitor: "v_buyer_visitor1", session: "s_buyer_1", pv: "pv_buyer_1", page: "/", country: "DE", city: "Berlin", lat: 52.52, lon: 13.4 } });
    // the owner reads first, so a cached owner answer is what the growth read would reuse
    const ownerRevenue = await (await call("/v1/admin/revenue?mode=all", { cookie: owner })).text();
    expect(ownerRevenue).toContain(BUYER);
    for (const route of ALLOWED_GETS) {
      const text = await (await call(`/v1/admin${route}${route === "/revenue" ? "?mode=all" : ""}`, { cookie: growth })).text();
      expect([route, EMAILISH.exec(text)?.[0] ?? null]).toEqual([route, null]);
    }
    const revenue = await (await call("/v1/admin/revenue?mode=all", { cookie: growth })).json() as { customers: unknown[]; upcoming: unknown[]; risk: unknown[]; headline: { mrr: number } };
    expect(revenue.customers).toEqual([]);
    expect(revenue.upcoming).toEqual([]);
    expect(revenue.risk).toEqual([]);
    expect(revenue.headline.mrr).toBeGreaterThan(0);
    const waitlist = await (await call("/v1/admin/waitlist?q=waiting", { cookie: growth })).json() as { entries: unknown[]; count: number; total: number };
    expect(waitlist).toMatchObject({ entries: [], count: 2, total: 2 });
  });

  it("reads subscribers and one subscriber by handle, never by email or name; the owner sees the email", async () => {
    const { owner, growth } = await setup();
    await paidBuyer();
    const buyerId = app.auth.accountByEmail(BUYER)!.id;
    type List = { rows: Array<{ accountId: string; handle: string; email: string | null; name: string | null }>; launch: { mrrCents: number } };
    const mine = await (await call("/v1/admin/subscribers?filter=all", { cookie: owner })).json() as List;
    expect(mine.rows.find(row => row.accountId === buyerId)?.email).toBe(BUYER);
    const list = await call("/v1/admin/subscribers?filter=all", { cookie: growth });
    expect(list.status).toBe(200);
    const text = await list.text();
    expect(EMAILISH.exec(text)?.[0] ?? null).toBeNull();
    const row = (JSON.parse(text) as List).rows.find(item => item.accountId === buyerId)!;
    expect(row).toMatchObject({ email: null, name: null });
    expect(row.handle).toMatch(/^p-[0-9a-f]{6}$/);
    const one = await call(`/v1/admin/subscribers/${buyerId}`, { cookie: growth });
    expect(one.status).toBe(200);
    expect(EMAILISH.exec(await one.text())?.[0] ?? null).toBeNull();
    expect(((await (await call(`/v1/admin/subscribers/${buyerId}`, { cookie: owner })).json()) as { account: { email: string } }).account.email).toBe(BUYER);
    expect((await call("/v1/admin/subscribers/acct_nobody0001", { cookie: growth })).status).toBe(404);
    expect((await call("/v1/admin/subscribers", { method: "POST", cookie: growth })).status).toBe(403);
  });

  it("strips people from any shape it is handed", () => {
    const shaped = forGrowth("/web", { marks: [{ seed: "v1", email: "a@b.co", customer: true }], account: { id: "acct_1", email: "x@y.io", name: "Ada", city: "Paris", lat: 48.85, lon: 2.35 },
      notes: [{ text: "call bob@corp.com", by: "acct_1" }], cards: { city: [{ key: "Paris", visitors: 3 }] } });
    expect(shaped).toEqual({ marks: [{ seed: "v1", email: null, customer: true }], account: { id: "acct_1", email: null, name: null, city: null, lat: 49, lon: 2 },
      notes: [{ text: "call hidden", by: "acct_1" }], cards: { city: [{ key: "Paris", visitors: 3 }] } });
    expect(forGrowth("/realtime", [{ name: "site_view", email: "a@b.co", city: "Paris" }])).toEqual([{ name: "site_view", email: null, city: null }]);
  });
});
