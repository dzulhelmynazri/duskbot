import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, request, type Server } from "node:http";
import { duplexPair } from "node:stream";
import type { Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDashboardApp } from "../app.ts";
import { memoryMailer } from "../auth/mail.ts";
import { memorySink, type Note, type AuditEntry } from "../analytics/sink.ts";
import { DAY, HOUR, DIMENSIONS } from "../analytics/web.ts";
import { upsellsOf, type createAnalyticsRoutes } from "./analytics-routes.ts";
import { memoryWarmStore, rangeFrom } from "./web-warm.ts";
import type { EventName } from "../analytics/events.ts";
import { CSRF_HEADER } from "../../../../shared/account-api.ts";

const ORIGIN = "http://127.0.0.1:7999", SITE = "https://madani.bot";
const ADMIN = "owner@example.test", OTHER = "someone@example.test";
const VID = "AbCdEfGhIjKlMnOpQrStUv", ANON = "ZyXwVuTsRqPoNmLkJiHgFe", INSTALL = "inst_0123456789abcdef";
type Routes = ReturnType<typeof createAnalyticsRoutes>;
type Web = Awaited<ReturnType<Routes["web"]>>;
type Details = Awaited<ReturnType<Routes["webDetails"]>>;
type Funnel = Awaited<ReturnType<Routes["funnel"]>>;
type Journeys = Awaited<ReturnType<Routes["journeys"]>>;
type Profile = Awaited<ReturnType<Routes["profile"]>>;
type Realtime = Awaited<ReturnType<Routes["realtime"]>>;
type Retention = Awaited<ReturnType<Routes["retention"]>>;
type App = Awaited<ReturnType<Routes["app"]>>;

describe("admin analytics routes", () => {
  let app: ReturnType<typeof createDashboardApp>, sink: ReturnType<typeof memorySink>, mailer: ReturnType<typeof memoryMailer>;
  let server: Server, dataDir: string, time: number;
  const csrf = new Map<string, string>();

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "madani-analytics-routes-"));
    time = Date.parse("2026-11-12T12:00:00Z");
    mailer = memoryMailer(); sink = memorySink(() => time); csrf.clear();
    app = createDashboardApp({ dataDir, publicUrl: ORIGIN, mailer, staticDir: null, now: () => time,
      admin: { emails: [ADMIN], env: {} }, analytics: { sink, trackOrigins: [SITE] } });
    server = createServer(app.handle);
  });
  afterEach(async () => {
    app.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    rmSync(dataDir, { recursive: true, force: true });
  });

  function send(path: string, init: { method: string; headers: Record<string, string>; body?: string }) {
    const [client, peer] = duplexPair();
    Object.defineProperty(peer, "remoteAddress", { value: "127.0.0.1" });
    server.emit("connection", peer);
    return new Promise<Response>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port: 7999, path, method: init.method,
        headers: { ...init.headers, connection: "close", ...(init.body === undefined ? {} : { "content-length": String(Buffer.byteLength(init.body)) }) }, createConnection: () => client as Socket }, res => {
        const chunks: Buffer[] = [];
        res.on("data", chunk => chunks.push(Buffer.from(chunk)));
        res.on("error", reject);
        res.on("end", () => {
          const headers = new Headers();
          for (const [key, value] of Object.entries(res.headers)) for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(key, item);
          resolve(new Response(res.statusCode === 204 ? null : Buffer.concat(chunks), { status: res.statusCode, headers }));
        });
      });
      req.on("error", reject);
      req.end(init.body);
    });
  }
  function call(path: string, init: { method?: string; body?: unknown; cookie?: string; csrf?: boolean } = {}) {
    return send(path, { method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { origin: ORIGIN, "x-madani-admin-tests": "show", "x-madani-admin-money": "all", ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init.cookie ? { cookie: init.cookie, ...(init.csrf === false ? {} : { [CSRF_HEADER]: csrf.get(init.cookie) ?? "" }) } : {}) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
  }
  async function read<T>(path: string, cookie: string): Promise<T> {
    const response = await call(path, { cookie });
    expect(response.status, path).toBe(200);
    return await response.json() as T;
  }
  async function login(email: string) {
    const start = await call("/v1/auth/start", { body: { email } });
    expect(start.status).toBe(200);
    const { attempt } = await start.json() as { attempt: string };
    const code = mailer.outbox.findLast(item => item.to === email && /\b\d{8}\b/.test(item.text))!.text.match(/\b\d{8}\b/)![0];
    const verify = await call("/v1/auth/verify", { body: { attempt, code } });
    expect(verify.status).toBe(200);
    const cookie = verify.headers.get("set-cookie")!.split(";")[0]!;
    csrf.set(cookie, (await verify.json() as { csrfToken: string }).csrfToken);
    return cookie;
  }
  const range = (from: number, to: number) => `from=${from}&to=${to}`;
  const record = (name: EventName, input: Parameters<typeof app.analytics.record>[1] = {}) => app.analytics.record(name, input);
  function view(visitor: string, session: string, at: number, path = "/", extra: NonNullable<Parameters<typeof app.analytics.record>[1]>["ctx"] = {}) {
    return record("site_view", { at, visitor, props: { path }, ctx: { visitor, session, pv: `${session}:pv`, page: path, source: "ChatGPT", channel: "ai", country: "DE", device: "desktop", os: "mac", browser: "safari", ...extra } });
  }
  async function beacon(visitor = ANON, path = "/anonymous") {
    const response = await send("/v1/t", { method: "POST", headers: { "content-type": "text/plain;charset=UTF-8", origin: SITE, "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15" },
      body: JSON.stringify({ v: 1, e: "pageview", vid: visitor, sid: visitor, pv: "pv000001", h: "madani.bot", p: path, w: 1440 }) });
    expect(response.status).toBe(200);
    await expect.poll(() => sink.all.some(event => event.name === "site_view" && event.ctx?.visitor === visitor)).toBe(true);
  }
  function pay(accountId: string, at: number) {
    app.billing.store.state.invoices.push({ id: `inv_${accountId}`, accountId, providerPaymentId: `pay_${accountId}`, subscriptionId: null, checkoutId: null,
      amountCents: 1000, currency: "USD", status: "paid", description: "fixture", createdAt: at });
  }
  async function identify(accountId: string, visitor = VID, install?: string) {
    await record("identify", { accountId, visitor, props: { via: install ? "app" : "page" }, ctx: { visitor, ...(install ? { install } : {}) } });
  }

  it("authorizes every analytics GET for signed-out, non-admin and admin sessions", async () => {
    const admin = await login(ADMIN), other = await login(OTHER), accountId = app.auth.accountByEmail(OTHER)!.id;
    await beacon();
    const paths = ["/v1/admin/web", "/v1/admin/web/source", `/v1/admin/web?${range(time - DAY, time + 1)}&f.channel=ai`, "/v1/admin/funnel", "/v1/admin/funnel?mode=signups",
      "/v1/admin/journeys", "/v1/admin/journeys?only=customers&q=x", `/v1/admin/journeys/${accountId}`, `/v1/admin/journeys/${ANON}`,
      "/v1/admin/realtime", "/v1/admin/realtime?minutes=60", "/v1/admin/retention", "/v1/admin/app", "/v1/admin/revenue", "/v1/admin/revenue?days=30"];
    for (const path of paths) {
      expect((await call(path)).status, path).toBe(401);
      expect((await call(path, { cookie: other })).status, path).toBe(403);
      expect((await call(path, { cookie: admin })).status, path).toBe(200);
    }
  });

  it("keeps the revenue backfill to the owner with CSRF, and says when the provider keeps no history", async () => {
    const admin = await login(ADMIN), other = await login(OTHER);
    expect((await call("/v1/admin/revenue/sync", { body: {} })).status).toBe(401);
    expect((await call("/v1/admin/revenue/sync", { body: {}, cookie: other })).status).toBe(403);
    expect((await call("/v1/admin/revenue/sync", { body: {}, cookie: admin, csrf: false })).status).toBe(403);
    const answer = await call("/v1/admin/revenue/sync", { body: {}, cookie: admin });
    expect(answer.status).toBe(409);
    expect(await answer.json()).toMatchObject({ code: "unavailable" });
    expect((await call("/v1/admin/revenue?days=3", { cookie: admin })).status).toBe(400);
  });

  it("reports MRR from a real checkout, stores the payer's first touch and shows billing on their profile", async () => {
    const admin = await login(ADMIN), payer = await login(OTHER), accountId = app.auth.accountByEmail(OTHER)!.id;
    await view(VID, "s1", time - 2 * DAY, "/pricing");
    await identify(accountId);
    const bundle = (await import("../billing/plans.ts")).BILLING_CONFIG.bundles.find(item => item.id === "starter")!;
    const answer = await app.billing.service.checkout({ id: accountId, email: OTHER }, { kind: "cart", cart: app.billing.service.quote({ ...bundle.cart, interval: "month" }).cart }, { source: "dash_home" });
    const stored = app.billing.store.state.checkouts.find(item => item.id === answer.checkoutId)!;
    for (const delivery of app.billing.fake!.complete(stored.providerSessionId!)) app.billing.service.handleWebhook(delivery.headers, delivery.body);
    const total = app.billing.store.state.subscriptions[0]!.totalCents;
    type Revenue = Awaited<ReturnType<Routes["revenue"]>>;
    // the fake provider is test money: the live view (the default) leaves it out, and the totals keep the two apart
    const live = await read<Revenue>("/v1/admin/revenue", admin);
    expect(live).toMatchObject({ mode: "live", serverMode: "test", headline: { mrr: 0, customers: 0 }, customers: [],
      modes: { live: { mrr: 0, customers: 0, gross: 0, payments: 0 }, test: { mrr: total, customers: 1, payments: 1 } } });
    expect(app.billing.store.state.subscriptions[0]!.mode).toBe("test");
    expect(app.billing.store.state.invoices[0]!.mode).toBe("test");
    expect((await call("/v1/admin/revenue?mode=both", { cookie: admin })).status).toBe(400);
    const revenue = await read<Revenue>("/v1/admin/revenue?mode=test", admin);
    expect(revenue.headline).toMatchObject({ mrr: total, arr: total * 12, customers: 1, arpu: total });
    expect(revenue.customers[0]).toMatchObject({ accountId, email: OTHER, mode: "test", status: "active", channel: "ai", source: "ChatGPT", country: "DE" });
    expect((await read<Revenue>("/v1/admin/revenue?mode=all", admin)).headline.mrr).toBe(total);
    expect(revenue.feed[0]).toMatchObject({ kind: "new", accountId, amountCents: total });
    expect(revenue.received).toMatchObject({ cents: revenue.cash.gross, payments: 1, refundsCents: 0 });
    expect(revenue.received.cents).toBeGreaterThan(0);
    expect(revenue.received.series).toHaveLength(90);
    expect((await read<Revenue>("/v1/admin/revenue?days=30&mode=test", admin)).received.series).toHaveLength(30);
    expect(live.received.cents, "test money is never received in the live view").toBe(0);
    // a paid checkout with no free trial: visited and signed up, never a trial
    expect(revenue.funnel.steps.map(step => [step.id, step.count])).toEqual([["visit", 1], ["signup", 1], ["trial", 0], ["converted", 0]]);
    expect(revenue.sync).toEqual({ available: false, last: null });
    expect(app.billing.store.state.customers.find(row => row.accountId === accountId)!.attribution).toMatchObject({ source: "ChatGPT", channel: "ai" });
    await expect.poll(() => sink.all.filter(event => event.name === "billing").map(event => event.props.type)).toEqual(["checkout.started", "payment.succeeded", "subscription.active"]);
    const profile = await read<Profile>(`/v1/admin/journeys/${accountId}`, admin);
    expect(profile.billing).toMatchObject({ customer: { mrr: total, status: "active" }, invoices: [{ amountCents: total, status: "paid" }] });
    expect(profile.billing!.events.map(event => event.emoji)).toContain("💰");
    expect(JSON.stringify(profile.sessions)).not.toContain("\"name\":\"billing\"");
    void payer;
  });

  it("authorizes every note mutation and requires CSRF for each method", async () => {
    const admin = await login(ADMIN), other = await login(OTHER), id = "note_fixture123";
    await sink.saveNote({ id, at: time, text: "fixture", by: app.auth.accountByEmail(ADMIN)!.id, createdAt: time });
    for (const [method, path, body] of [
      ["POST", "/v1/admin/notes", { text: "launch", at: time }], ["PATCH", `/v1/admin/notes/${id}`, { text: "edited", at: time }], ["DELETE", `/v1/admin/notes/${id}`, {}],
    ] as const) {
      expect((await call(path, { method, body })).status, method).toBe(401);
      expect((await call(path, { method, body, cookie: other })).status, method).toBe(403);
      expect((await call(path, { method, body, cookie: admin, csrf: false })).status, method).toBe(403);
      expect((await call(path, { method, body, cookie: admin })).status, method).toBe(200);
    }
    expect(await sink.notes(0, time + 1)).toHaveLength(1);
  });

  it("returns separate current and previous web metrics, bucket counts, all cards, notes and online counts", async () => {
    const end = time, from = end - DAY;
    time = from - HOUR;
    await login("previous@example.test");
    await view("previous", "previous", time);
    time = from + HOUR;
    await login(OTHER);
    const accountId = app.auth.accountByEmail(OTHER)!.id;
    await view(VID, "current", time, "/pricing", { referrer: "chatgpt.com", utm: { campaign: "launch" }, ref: "thread", region: "BE", city: "Berlin" });
    await identify(accountId);
    await record("site_goal", { at: time + 1000, visitor: VID, props: { goal: "waitlist_join" }, ctx: { visitor: VID, session: "current", pv: "current:pv" } });
    pay(accountId, time + 2000);
    const note = { id: "note_inrange", at: from + HOUR, text: "launch", by: accountId, createdAt: time };
    await sink.saveNote(note);
    await sink.saveNote({ ...note, id: "note_outside", at: end + DAY });
    time = end - 60_000;
    await view(VID, "recent", time, "/pricing", { referrer: "chatgpt.com", utm: { campaign: "launch" }, ref: "thread", region: "BE", city: "Berlin" });
    await record("app_open", { accountId, ctx: { install: INSTALL }, props: { platform: "darwin" } });
    await beacon();
    time = end;
    const admin = await login(ADMIN);
    const data = await read<Web>(`/v1/admin/web?${range(from, end)}`, admin);
    expect(data.current).toMatchObject({ visitors: 2, visits: 3, pageviews: 3, signups: 1, paid: 1, waitlist: 1, conversion: 0.5, bounce: 2 / 3, visitMs: 0 });
    expect(data.previous).toMatchObject({ visitors: 1, visits: 1, pageviews: 1, signups: 1, paid: 0 });
    expect(data.series.size).toBe(HOUR); expect(data.series.starts).toHaveLength(24);
    expect(data.series.starts[0]).toBe(from); expect(data.series.signups.reduce((a, b) => a + b, 0)).toBe(1);
    expect(data.series.paid.reduce((a, b) => a + b, 0)).toBe(1); expect(data.series.waitlist.reduce((a, b) => a + b, 0)).toBe(1);
    expect(Object.keys(data.cards).sort()).toEqual([...DIMENSIONS].sort());
    for (const dim of DIMENSIONS) expect(data.cards[dim], dim).toEqual(expect.arrayContaining([expect.objectContaining({ signups: 1, paid: 1 })]));
    expect(data.cards.channel).toEqual([{ key: "ai", visitors: 1, signups: 1, paid: 1 }, { key: "direct", visitors: 1, signups: 0, paid: 0 }]);
    expect(data.notes).toEqual([note]); expect(data.online).toEqual({ site: 2, app: 1 }); expect(data.tracked).toBe(true);
    const filtered = await read<Web>(`/v1/admin/web?${range(from, end)}&f.channel=ai`, admin);
    expect(filtered.filters).toEqual({ channel: "ai" });
    expect(filtered.current).toMatchObject({ visitors: 1, signups: 1, paid: 1 });
    expect(filtered.cards.channel).toHaveLength(1);
  });

  it("reads closed hours from digests: once built, a view reads raw only the hour still open and the few identify and billing events", async () => {
    const admin = await login(ADMIN);
    await view(VID, "s1", time - 3 * HOUR);
    await record("site_section", { at: time - 3 * HOUR + 10_000, visitor: VID, props: { path: "/", section: "hero", ms: 3000 }, ctx: { visitor: VID, session: "s1", pv: "s1:pv" } });
    await record("app_action", { ctx: { install: INSTALL }, props: { name: "send" } });
    // the panel's windows start at the reader's midnight
    const midnight = `from=${time - 12 * HOUR - 30 * DAY}&to=${time}`;
    const paths = ["web", "web/page", "funnel", "journeys", "app", "retention", "product"].map(path => `/v1/admin/${path}?${midnight}`).concat("/v1/admin/revenue");
    for (const path of paths) expect((await call(path, { cookie: admin })).status, path).toBe(200);
    const asked: Array<{ span: number; names: readonly string[] | undefined }> = [];
    const scan = sink.scan.bind(sink);
    sink.scan = (since, until, names) => { asked.push({ span: until - since, names }); return scan(since, until, names); };
    time += 31_000;
    const web = await read<Web>(`/v1/admin/web?${range(time - DAY, time)}`, admin);
    expect(web.online).toEqual({ site: 0, app: 1 });
    expect(web.current).toMatchObject({ visitors: 1, pageviews: 1 });
    for (const path of paths) expect((await call(path, { cookie: admin })).status, path).toBe(200);
    expect(asked.length).toBeGreaterThan(0);
    for (const { span, names } of asked.filter(row => row.span > HOUR + 60_000)) expect(names, String(span)).toBeDefined();
    for (const { names } of asked.filter(row => row.span > HOUR + 60_000)) for (const name of names!) expect(["identify", "billing", "checkout_paid"]).toContain(name);
  });

  it("keeps the panel's /web reads warm and answers a kept one with who is online now", async () => {
    app.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    const store = memoryWarmStore();
    app = createDashboardApp({ dataDir, publicUrl: ORIGIN, mailer, staticDir: null, now: () => time, admin: { emails: [ADMIN], env: {}, readCacheMs: 30_000, warm: { store } }, analytics: { sink, trackOrigins: [SITE] } });
    server = createServer(app.handle);
    const admin = await login(ADMIN);
    await view(VID, "s1", time - HOUR);
    const path = `/v1/admin/web?from=${rangeFrom(time, -330, 7)}&to=${time}&surface=all&tz=-330`;
    const first = await read<Web>(path, admin);
    expect(first.online).toEqual({ site: 0, app: 0 });
    expect((await store.viewers(0)).map(row => row.viewer)).toEqual([{ tz: -330, data: "", tests: "show", money: "all" }]);
    time += 10_000;
    await view(ANON, "s2", time - 1000);
    const kept = await read<Web>(path, admin);
    expect(kept.current.visitors).toBe(first.current.visitors);
    expect(kept.online).toEqual({ site: 1, app: 0 });
  });

  it("rejects reversed, empty and over-400-day ranges", async () => {
    const admin = await login(ADMIN);
    for (const [from, to] of [[time, time], [time + 1, time], [time - 401 * DAY, time]]) {
      for (const path of ["web", "web/source", "funnel", "journeys", "app"]) expect((await call(`/v1/admin/${path}?${range(from!, to!)}`, { cookie: admin })).status, path).toBe(400);
    }
  });

  it("selects surfaces, counts picker visitors and links signup and payment marks", async () => {
    const start = time;
    await login(OTHER);
    const accountId = app.auth.accountByEmail(OTHER)!.id;
    await view(VID, "shared", start, "/", { host: "madani.bot", utm: { term: "Madani-Bot" } });
    await identify(accountId, VID, INSTALL);
    await record("page_view", { accountId, at: start + 100, props: { path: "/billing" }, ctx: { session: "shared", host: "madani.bot" } });
    await record("app_open", { at: start + 200, props: { kind: "desktop" }, ctx: { install: INSTALL, session: "shared", app: { platform: "darwin" } } });
    await record("app_open", { accountId, at: start + 300, props: { kind: "mobile" }, ctx: { install: "phone", session: "phone", app: { platform: "android" } } });
    pay(accountId, start + 400);
    time += HOUR;
    const admin = await login(ADMIN), adminId = app.auth.accountByEmail(ADMIN)!.id;
    const query = range(start, time + 1);
    const data = await read<Web>(`/v1/admin/web?${query}`, admin);
    expect(data.surfaces).toEqual({ site: 1, account: 1, desktop: 1, phone: 1 });
    expect(data.current).toMatchObject({ visitors: 1, visits: 1, pageviews: 1, signups: 2, paid: 1 });
    expect(data.cards.host).toEqual([{ key: "madani.bot", visitors: 1, signups: 1, paid: 1 }]);
    expect(data.cards.keyword).toEqual([{ key: "madani-bot", visitors: 1, signups: 1, paid: 1 }]);
    expect(data.cards.surface).toEqual([{ key: "site", visitors: 1, signups: 1, paid: 1 }]);
    expect(data.marks).toEqual([
      { at: time, kind: "signup", seed: adminId, email: ADMIN, customer: false },
      { at: start + 400, kind: "paid", seed: VID, email: OTHER, customer: true },
      { at: start, kind: "signup", seed: VID, email: OTHER, customer: true },
    ]);
    for (const surface of ["account", "desktop", "phone"]) {
      const selected = await read<Web>(`/v1/admin/web?${query}&surface=${surface}`, admin);
      expect(selected.surfaces).toEqual(data.surfaces);
      expect(selected.current).toMatchObject({ visitors: 1, visits: 1, pageviews: 1, signups: 1, paid: 1 });
      expect(selected.cards.surface).toEqual([{ key: surface, visitors: 1, signups: 1, paid: 1 }]);
      expect(selected.marks).toEqual(data.marks.slice(1));
      expect(selected.series.signups.reduce((sum, n) => sum + n, 0)).toBe(1);
    }
    expect((await read<Web>(`/v1/admin/web?${query}&surface=all`, admin)).current).toMatchObject({ visitors: 3, visits: 4, pageviews: 4 });
    const filtered = await read<Web>(`/v1/admin/web?${query}&surface=all&f.surface=site&f.host=madani.bot&f.keyword=madani-bot`, admin);
    expect(filtered.current).toMatchObject({ visitors: 1, signups: 1, paid: 1 });
    expect(filtered.marks).toEqual(data.marks.slice(1));
    expect((await read<Web>(`/v1/admin/web?${query}&surface=desktop&f.surface=phone`, admin)).current.visitors).toBe(0);
    for (const surface of ["", "app", "SITE", "unknown"]) for (const path of ["web", "web/source"]) expect((await call(`/v1/admin/${path}?surface=${surface}`, { cookie: admin })).status).toBe(400);
    expect((await call("/v1/admin/web/nope", { cookie: admin })).status).toBe(400);
    expect((await call("/v1/admin/web/source/extra", { cookie: admin })).status).toBe(400);
  });

  it("returns row conversion, bounce, median visit time and pageviews with surface and dimension filters", async () => {
    const start = time;
    await login(OTHER);
    const accountId = app.auth.accountByEmail(OTHER)!.id;
    await identify(accountId);
    await view(VID, "first", start, "/", { host: "madani.bot" });
    await view(VID, "first", start + 1000, "/pricing", { host: "madani.bot" });
    await view(ANON, "second", start + 2000, "/", { host: "madani.bot" });
    await view(VID, "third", start + 3000, "/", { host: "preview.madani.bot" });
    await view("outside", "outside", start - 1, "/outside");
    await record("page_view", { accountId, at: start + 4000, props: { path: "/billing" }, ctx: { session: "account", host: "madani.bot" } });
    pay(accountId, start + 5000);
    time += HOUR;
    const admin = await login(ADMIN), query = range(start, time);
    const data = await read<Details>(`/v1/admin/web/host?${query}`, admin);
    expect(data).toMatchObject({ from: start, to: time, dimension: "host", filters: {} });
    expect(data.rows).toEqual([
      { key: "madani.bot", visitors: 2, signups: 1, paid: 1, conversion: 0.5, bounce: 0.5, visitMs: 500, pageviews: 3 },
      { key: "preview.madani.bot", visitors: 1, signups: 1, paid: 1, conversion: 1, bounce: 1, visitMs: 0, pageviews: 1 },
    ]);
    const filtered = await read<Details>(`/v1/admin/web/page?${query}&f.host=madani.bot&f.channel=ai`, admin);
    expect(filtered.rows).toEqual([
      { key: "/", visitors: 2, signups: 1, paid: 1, conversion: 0.5, bounce: 0.5, visitMs: 500, pageviews: 3 },
      { key: "/pricing", visitors: 1, signups: 1, paid: 1, conversion: 1, bounce: 0, visitMs: 1000, pageviews: 2 },
    ]);
    expect((await read<Details>(`/v1/admin/web/page?${query}&surface=account`, admin)).rows).toEqual([
      { key: "/dashboard/billing", visitors: 1, signups: 1, paid: 1, conversion: 1, bounce: 1, visitMs: 0, pageviews: 1 },
    ]);
    expect((await read<Details>(`/v1/admin/web/source?${query}&f.source=absent`, admin)).rows).toEqual([]);
    for (const dim of DIMENSIONS) expect((await call(`/v1/admin/web/${dim}?${query}`, { cookie: admin })).status).toBe(200);
  });

  it("caps detail rows at 500 and chart marks at 60 within the requested window", async () => {
    const admin = await login(ADMIN), start = time;
    for (let i = 0; i < 505; i++) await view(`visitor${i}`, `session${i}`, start + i, `/page${i}`);
    for (let i = 0; i < 70; i++) pay(`acct_${i}`, start + i);
    pay("acct_before", start - 1); pay("acct_after", start + 1000);
    time += HOUR;
    const query = range(start, start + 1000);
    const data = await read<Details>(`/v1/admin/web/page?${query}`, admin);
    expect(data.rows).toHaveLength(500);
    expect((await read<Web>(`/v1/admin/web?${query}`, admin)).cards.page).toHaveLength(50);
    const { marks } = await read<Web>(`/v1/admin/web?${query}`, admin);
    expect(marks).toHaveLength(60);
    expect(marks[0]).toEqual({ at: start + 69, kind: "paid", seed: "acct_69", email: null, customer: true });
    expect(marks.at(-1)!.at).toBe(start + 10);
  });

  it("builds visitor and signup funnels from identity links and account signup records", async () => {
    const start = time - HOUR;
    time = start;
    await beacon(VID, "/pricing");
    time += 1000;
    await login(OTHER);
    const accountId = app.auth.accountByEmail(OTHER)!.id;
    await identify(accountId);
    for (const step of ["name", "plan", "app"]) { time += 1000; await record("onboarding_step", { accountId, props: { step } }); }
    time += 1000; await record("onboarding_done", { accountId });
    time += 1000; await record("plan_chosen", { accountId, props: { plan: "starter", period: "month" } });
    time += 1000; pay(accountId, time);
    time += 1000; await record("app_paired", { accountId, props: { via: "app" } });
    time += 1000; await record("first_bot_reply", { accountId });
    time += 1000; await beacon();
    const admin = await login(ADMIN);
    const data = await read<Funnel>(`/v1/admin/funnel?${range(start, time + 1)}`, admin);
    expect(data.steps.map(step => [step.id, step.count])).toEqual([["visit", 2], ["signup", 1], ["onboarding_name", 1], ["onboarding_plan", 1], ["onboarding_app", 1], ["onboarded", 1], ["cloud", 1], ["paid", 1], ["paired", 1], ["replied", 1], ["d1", 0], ["d7", 0], ["d30", 0]]);
    expect(data.steps[1]!.medianMs).toBe(1000);
    const signups = await read<Funnel>(`/v1/admin/funnel?mode=signups&${range(start, time)}`, admin);
    expect(signups.mode).toBe("signups");
    expect(signups.steps.map(step => step.count)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0]);
    // a free plan picked on onboarding is not a cloud chosen
    time += 1000; await login("free@example.test");
    const free = app.auth.accountByEmail("free@example.test")!.id;
    await identify(free, ANON);
    for (const step of ["name", "plan", "app"]) { time += 1000; await record("onboarding_step", { accountId: free, props: { step } }); }
    time += 1000; await record("onboarding_done", { accountId: free });
    time += 1000; await record("plan_chosen", { accountId: free, props: { plan: "free", period: "month" } });
    const after = await read<Funnel>(`/v1/admin/funnel?${range(start, time + 1)}`, admin);
    expect(after.steps.slice(0, 7).map(step => [step.id, step.count])).toEqual([["visit", 2], ["signup", 2], ["onboarding_name", 2], ["onboarding_plan", 2], ["onboarding_app", 2], ["onboarded", 2], ["cloud", 1]]);
  });

  it("lists identified and anonymous journeys, filters customers and searches account email", async () => {
    const admin = await login(ADMIN);
    await login(OTHER);
    const id = app.auth.accountByEmail(OTHER)!.id;
    await view(VID, "identified", time - 1000, "/pricing"); await identify(id); pay(id, time);
    await beacon();
    time += 1;
    const data = await read<Journeys>("/v1/admin/journeys", admin);
    expect(data.people).toEqual(expect.arrayContaining([
      expect.objectContaining({ id, seed: VID, account: expect.objectContaining({ email: OTHER }), customer: true, visits: 1, pageviews: 1, lastPage: "/pricing" }),
      expect.objectContaining({ id: ANON, seed: ANON, account: null, customer: false, visits: 1, lastPage: "/anonymous" }),
    ]));
    const customers = await read<Journeys>("/v1/admin/journeys?only=customers&q=someone", admin);
    expect(customers.total).toBe(1); expect(customers.people.map(person => person.id)).toEqual([id]);
    expect((await read<Journeys>("/v1/admin/journeys?only=customers&q=absent", admin)).people).toEqual([]);
    expect((await read<Journeys>("/v1/admin/journeys?only=signups", admin)).people.every(person => person.account !== null)).toBe(true);
  });

  it("joins the person timeline across linked visitors, anonymous install activity and account events, and audits the view", async () => {
    const admin = await login(ADMIN); await login(OTHER);
    const id = app.auth.accountByEmail(OTHER)!.id, secondVisitor = "SecondVisitor0123456789";
    await view(VID, "first", time - 4000, "/pricing");
    await record("app_open", { at: time - 3000, props: { platform: "darwin" }, ctx: { install: INSTALL } });
    await identify(id, VID, INSTALL); await identify(id, secondVisitor);
    await view(secondVisitor, "second", time - 2000, "/docs");
    await record("app_screen", { accountId: id, at: time - 1000, props: { screen: "/bots" }, ctx: { install: INSTALL } });
    await view("unrelated", "unrelated", time - 500, "/unrelated");
    const data = await read<Profile>(`/v1/admin/journeys/${id}`, admin);
    expect(data).toMatchObject({ account: { id, email: OTHER }, visitors: 2, installs: 1, summary: { visits: 2, pageviews: 2 } });
    expect(data.timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "site_view", surface: "site", props: { path: "/pricing" } }),
      expect.objectContaining({ name: "app_open", surface: "app" }), expect.objectContaining({ name: "app_screen", surface: "app", props: { screen: "/bots" } }),
    ]));
    expect(data.timeline.some(item => item.props.path === "/unrelated")).toBe(false);
    expect(data.timeline.map(item => item.at)).toEqual(data.timeline.map(item => item.at).sort((a, b) => b - a));
    const byVisitor = await read<Profile>(`/v1/admin/journeys/${VID}`, admin);
    expect(byVisitor.account?.id).toBe(id); expect(byVisitor.timeline).toEqual(data.timeline);
    const { entries } = await read<{ entries: AuditEntry[] }>("/v1/admin/audit", admin);
    expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({ action: "person.view", target: id, actor: app.auth.accountByEmail(ADMIN)!.id }), expect.objectContaining({ action: "person.view", target: VID })]));
  });

  it("returns newest realtime feed first and only visitors seen in the last five minutes in here", async () => {
    const admin = await login(ADMIN); await login(OTHER);
    const id = app.auth.accountByEmail(OTHER)!.id;
    await identify(id);
    await view("expired", "expired", time - 6 * 60_000, "/old");
    await view(VID, "recent", time - 2 * 60_000, "/pricing");
    await record("site_goal", { at: time - 60_000, visitor: VID, props: { goal: "cta_click" }, ctx: { visitor: VID, session: "recent", pv: "recent:pv", page: "/pricing" } });
    await record("app_open", { accountId: id, at: time - 30_000, ctx: { install: INSTALL } });
    await record("page_view", { at: time - 20_000, visitor: "signin_only_visitor", props: { path: "/signin" }, ctx: { session: "tab", page: "/signin", country: "IN", lat: 26.9, lon: 75.8 } });
    await beacon();
    const data = await read<Realtime>("/v1/admin/realtime?minutes=60", admin);
    expect(data.minutes).toBe(60); expect(data.online).toEqual({ site: 3, app: 1 });
    expect(data.here.find(item => item.seed === "signin_only_visitor")).toMatchObject({ name: "page_view", page: "/signin", country: "IN", lat: 26.9, lon: 75.8 });
    expect(data.feed.map(item => item.at)).toEqual(data.feed.map(item => item.at).sort((a, b) => b - a));
    expect(data.feed.some(item => item.seed === "expired")).toBe(true);
    expect(data.here.map(item => item.seed)).toEqual([ANON, "signin_only_visitor", VID]);
    expect(data.here.find(item => item.seed === VID)).toMatchObject({ name: "site_goal", email: OTHER, goal: "cta_click", country: "DE" });
    expect(data.here.some(item => item.seed === "expired")).toBe(false);
  });
  it("puts a free trial that began in the window into the live feed, in its place by time", async () => {
    const admin = await login(ADMIN); await login(OTHER);
    const id = app.auth.accountByEmail(OTHER)!.id;
    await identify(id);
    await view(VID, "recent", time - 3 * 60_000, "/pricing");
    const sub = { id: "sub_trial_live", accountId: id, status: "active", trialEndsAt: time + 3 * 86_400_000, createdAt: time - 60_000, updatedAt: time - 60_000, cancelAtPeriodEnd: false, totalCents: 2000,
      cart: { interval: "month" }, currentPeriodStart: time - 60_000, currentPeriodEnd: time + 3 * 86_400_000, checkoutId: "chk_trial_live", mode: "live" };
    app.billing.store.state.subscriptions.push(sub as never);
    const data = await read<Realtime>("/v1/admin/realtime?minutes=60", admin);
    expect(data.feed.find(item => item.name === "trial_started")).toMatchObject({ at: time - 60_000, email: OTHER, customer: true });
    expect(data.feed.map(item => item.at)).toEqual(data.feed.map(item => item.at).sort((a, b) => b - a));
  });

  it("returns signup cohorts and ranks power users by active days with usage totals", async () => {
    const end = time;
    time = end - 35 * DAY; await login(OTHER);
    const id = app.auth.accountByEmail(OTHER)!.id, signup = time;
    for (const day of [1, 7, 30]) await record("app_open", { accountId: id, at: signup + day * DAY });
    await record("app_messages", { accountId: id, at: signup + 30 * DAY, props: { sent: 5, replies: 4, latencyMs: 2000 } });
    await record("app_feature", { accountId: id, at: signup + 30 * DAY, props: { feature: "bot_created" } });
    time = end; const admin = await login(ADMIN);
    const data = await read<Retention>("/v1/admin/retention", admin);
    expect(data.cohorts).toHaveLength(8);
    expect(data.cohorts.find(cohort => signup >= cohort.start && signup < cohort.start + 7 * DAY)).toMatchObject({ size: 1, d1: { n: 1, of: 1 }, d7: { n: 1, of: 1 }, d30: { n: 1, of: 1 } });
    expect(data.power[0]).toMatchObject({ id, email: OTHER, activeDays: 2, opens: 2, sent: 5, replies: 4, features: 1 });
  });

  it("aggregates app screens, features, messages, reply-weighted median latency, failures and platforms", async () => {
    const admin = await login(ADMIN); await login(OTHER);
    const id = app.auth.accountByEmail(OTHER)!.id, at = time - HOUR;
    const ctx = { install: INSTALL, app: { platform: "darwin", version: "0.3.0" } };
    await record("app_open", { accountId: id, at, props: { platform: "darwin", appVersion: "0.3.0", kind: "desktop" }, ctx });
    await record("app_open", { at: at + 1, props: { platform: "ios", kind: "mobile" }, ctx: { install: "inst_anonymous012345", app: { platform: "ios", version: "1.0.0" } } });
    for (const screen of ["/bots", "/bots", "/settings"]) await record("app_screen", { accountId: id, at, props: { screen }, ctx });
    for (const feature of ["bot_created", "bot_created", "search_used"]) await record("app_feature", { accountId: id, at, props: { feature }, ctx });
    for (const [sent, replies, latencyMs] of [[2, 1, 100], [3, 1, 2000], [12, 9, 9000], [4, 0, 50000]]) await record("app_messages", { accountId: id, at, props: { sent: sent!, replies: replies!, latencyMs: latencyMs! }, ctx });
    await record("app_error", { accountId: id, at, props: { kind: "network", code: "timeout" }, ctx });
    await record("app_pair_failed", { accountId: id, at, props: { reason: "expired" }, ctx });
    await record("app_messages", { at: time - 4 * DAY, props: { sent: 100, replies: 100, latencyMs: 1 } });
    await record("app_screen", { at: time + 1, props: { screen: "/outside" }, ctx });
    const data = await read<App>(`/v1/admin/app?${range(time - 2 * DAY, time)}`, admin);
    expect(data).toMatchObject({ installs: 2, identified: 1, sent: 21, replies: 11, latencyMs: 9000, active: [0, 2], opens: [0, 2] });
    expect(data.days).toEqual([time - 2 * DAY, time - DAY]);
    expect(data.screens).toEqual([{ key: "/bots", count: 2 }, { key: "/settings", count: 1 }]);
    expect(data.features).toEqual([{ key: "bot_created", count: 2 }, { key: "search_used", count: 1 }]);
    expect(data.errors).toEqual([{ key: "network: timeout", count: 1 }]);
    expect(data.pairFailures).toEqual([{ key: "expired", count: 1 }]);
    expect(data.platforms).toEqual([{ key: "darwin", count: 1 }, { key: "ios", count: 1 }]);
    expect(data.versions).toEqual([{ key: "darwin 0.3.0", count: 1 }, { key: "ios 1.0.0", count: 1 }]);
  });

  it("creates, edits and deletes notes with validation, missing-id errors and audit entries", async () => {
    const admin = await login(ADMIN), actor = app.auth.accountByEmail(ADMIN)!.id;
    const create = await call("/v1/admin/notes", { cookie: admin, body: { text: " launch ", at: time } });
    expect(create.status).toBe(200);
    const { note } = await create.json() as { note: Note };
    expect(note).toMatchObject({ text: "launch", at: time, by: actor, createdAt: time });
    expect(note.id).toMatch(/^note_/);
    const edit = await call(`/v1/admin/notes/${note.id}`, { method: "PATCH", cookie: admin, body: { text: "edited", at: time - 1000 } });
    expect(edit.status).toBe(200);
    expect((await edit.json() as { note: Note }).note).toEqual({ ...note, text: "edited", at: time - 1000 });
    expect((await read<Web>(`/v1/admin/web?${range(time - DAY, time + 1)}`, admin)).notes).toEqual([{ ...note, text: "edited", at: time - 1000 }]);
    for (const body of [{ text: "", at: time }, { text: " ", at: time }, { text: "x".repeat(141), at: time }, { text: "date required" }, { text: "bad date", at: "invalid" }, { text: "future", at: time + 366 * DAY }]) {
      for (const [method, path] of [["POST", "/v1/admin/notes"], ["PATCH", `/v1/admin/notes/${note.id}`]]) expect((await call(path!, { method, cookie: admin, body })).status, JSON.stringify(body)).toBe(400);
    }
    for (const text of ["x", "x".repeat(140)]) {
      const valid = await call(`/v1/admin/notes/${note.id}`, { method: "PATCH", cookie: admin, body: { text, at: time } });
      expect(valid.status).toBe(200);
    }
    const deleted = await call(`/v1/admin/notes/${note.id}`, { method: "DELETE", cookie: admin, body: {} });
    expect(deleted.status).toBe(200); expect(await deleted.json()).toEqual({ ok: true });
    expect((await read<Web>(`/v1/admin/web?${range(time - DAY, time + 1)}`, admin)).notes).toEqual([]);
    expect((await call("/v1/admin/notes/note_missing123", { method: "PATCH", cookie: admin, body: { text: "missing", at: time } })).status).toBe(404);
    expect((await call("/v1/admin/notes/note_missing123", { method: "DELETE", cookie: admin, body: {} })).status).toBe(404);
    const { entries } = await read<{ entries: AuditEntry[] }>("/v1/admin/audit", admin);
    for (const action of ["note.add", "note.edit", "note.delete"]) expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({ action, target: note.id, actor })]));
  });
});

describe("upsells by source", () => {
  it("counts people who saw, opened and dismissed each upsell, from the page and the apps, and who paid through it", () => {
    const at = 1_000;
    const ev = (name: string, accountId: string | null, props: Record<string, string>, visitor?: string) => ({ id: `e${Math.random()}`, name, at, accountId, props, ...(visitor ? { ctx: { visitor } } : {}) });
    const rows = upsellsOf([
      ev("page_action", "a1", { action: "upsell_shown", label: "dash_sidebar" }), ev("page_action", "a1", { action: "upsell_shown", label: "dash_sidebar" }),
      ev("page_action", "a2", { action: "upsell_shown", label: "dash_sidebar" }), ev("page_action", "a2", { action: "upsell_click", label: "dash_sidebar" }),
      ev("page_action", null, { action: "upsell_dismiss", label: "dash_invested" }, "v1"), ev("page_action", "a3", { action: "cta_click", label: "dash_sidebar" }),
      ev("app_action", "a4", { name: "upsell_shown", source: "desktop_sleep" }), ev("app_action", "a4", { name: "upsell_click", source: "desktop_sleep" }),
      ev("app_action", null, { name: "upsell_dismiss", source: "app_mobile" }), ev("app_action", "a4", { name: "bot_tour", source: "desktop_sleep" }),
      { ...ev("page_action", "a5", { action: "upsell_shown", label: "dash_sidebar" }), at: 5_000 },
    ], [
      { source: "dash_sidebar", status: "active", currentPeriodStart: at, createdAt: at },
      { source: "dash_sidebar", status: "pending", currentPeriodStart: null, createdAt: at },
      { source: "admin_comp", status: "active", currentPeriodStart: at, createdAt: at },
    ], 0, 2_000);
    expect(rows).toEqual([
      { source: "dash_sidebar", shown: 2, clicked: 1, dismissed: 0, paid: 1 },
      { source: "desktop_sleep", shown: 1, clicked: 1, dismissed: 0, paid: 0 },
      { source: "app_mobile", shown: 0, clicked: 0, dismissed: 1, paid: 0 },
      { source: "dash_invested", shown: 0, clicked: 0, dismissed: 1, paid: 0 },
    ]);
  });
});
