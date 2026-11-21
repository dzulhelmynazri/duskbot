import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDashboardApp } from "../app.ts";
import { memoryMailer } from "../auth/mail.ts";
import { memorySink } from "./sink.ts";
import { CSRF_HEADER } from "../../../../shared/account-api.ts";

const ORIGIN = "http://127.0.0.1:7998", SITE = "https://madani.bot";
const ADMIN = "owner@example.test", OTHER = "someone@example.test";
const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const VID = "AbCdEfGhIjKlMnOpQrStUv", SID = "ZyXwVuTsRqPoNmLkJiHgFe";
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

describe("site tracker and app ingest", () => {
  let app: ReturnType<typeof createDashboardApp>, sink: ReturnType<typeof memorySink>, mailer: ReturnType<typeof memoryMailer>;
  const url = ORIGIN;
  let dataDir: string, time: number;
  const csrf = new Map<string, string>();
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "madani-ingest-test-"));
    time = Date.parse("2026-11-12T12:00:00Z");
    sink = memorySink(() => time);
    mailer = memoryMailer();
    app = createDashboardApp({ dataDir, publicUrl: ORIGIN, mailer, staticDir: null, now: () => time, trustProxy: true, analytics: { sink, trackOrigins: [SITE] }, admin: { emails: [ADMIN], env: {} } });
  });
  afterEach(() => {
    app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  async function fetch(input: string, init: RequestInit) {
    const request = new Request(input, init), req = new IncomingMessage(new Socket());
    req.method = request.method;
    req.url = new URL(input).pathname;
    req.headers = Object.fromEntries(request.headers);
    Object.defineProperty(req.socket, "remoteAddress", { value: "127.0.0.1" });
    req.push(Buffer.from(await request.arrayBuffer()));
    req.push(null);
    const res = new ServerResponse(req), end = res.end.bind(res);
    let body: string | null = null;
    res.end = ((value?: string) => { body = value ?? null; return end(value); }) as typeof res.end;
    try {
      await app.handle(req, res);
      const headers = new Headers();
      for (const [key, value] of Object.entries(res.getHeaders())) {
        for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) headers.append(key, String(item));
      }
      return new Response(res.statusCode === 204 ? null : body, { status: res.statusCode, headers });
    } finally { req.destroy(); res.destroy(); }
  }
  const beacon = (body: unknown, headers: Record<string, string> = {}) => fetch(`${url}/v1/t`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "text/plain;charset=UTF-8", origin: SITE, "user-agent": SAFARI, ...headers } });
  const view = (extra: Record<string, unknown> = {}) => ({ v: 1, e: "pageview", vid: VID, sid: SID, pv: "pv000001", h: "madani.bot", p: "/pricing", w: 1440, ...extra });
  async function login(email: string) {
    const start = await fetch(`${url}/v1/auth/start`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ email }) });
    const { attempt } = await start.json() as { attempt: string };
    const code = mailer.outbox.findLast(item => item.to === email)!.text.match(/\b\d{8}\b/)![0];
    const verify = await fetch(`${url}/v1/auth/verify`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ attempt, code }) });
    const cookie = verify.headers.get("set-cookie")!.split(";")[0]!;
    csrf.set(cookie, (await verify.json() as { csrfToken: string }).csrfToken);
    return cookie;
  }
  async function appToken(email: string) {
    const device = { deviceName: "Test Mac", platform: "darwin", appVersion: "0.3.0" };
    const start = await fetch(`${url}/api/cloud/app/sign-in/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, ...device }) });
    const { attempt } = await start.json() as { attempt: string };
    const code = mailer.outbox.findLast(item => item.to === email)!.text.match(/\b\d{8}\b/)![0];
    const verify = await fetch(`${url}/api/cloud/app/sign-in/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ attempt, code }) });
    return (await verify.json() as { accessToken: string }).accessToken;
  }

  it("stores a page view with its visit, attribution, device and Cloudflare geo", async () => {
    const res = await beacon(view({ r: "chatgpt.com", u: { utm_campaign: "Launch", ref: "x-thread", email: "a@b.c" } }),
      { "x-forwarded-for": "203.0.113.4, 172.70.1.1", "cf-ipcountry": "US", "cf-ipcity": "Boston", "cf-iplatitude": "42.36", "cf-iplongitude": "-71.06" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ persist: true });
    expect(res.headers.get("access-control-allow-origin")).toBe(SITE);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    await settle();
    expect(sink.all).toHaveLength(1);
    expect(sink.all[0]).toMatchObject({ name: "site_view", accountId: null, props: { path: "/pricing" },
      ctx: { visitor: VID, session: SID, pv: "pv000001", host: "madani.bot", page: "/pricing", referrer: "chatgpt.com", ref: "x-thread", utm: { campaign: "launch" }, channel: "referral",
        device: "desktop", os: "mac", browser: "safari", country: "US", city: "Boston", lat: 42.4, lon: -71.1, width: 1440 } });
    expect(JSON.stringify(sink.all)).not.toContain("a@b.c");
    expect(JSON.stringify(sink.all)).not.toContain("203.0.113.4");
  });

  it("counts madani.bot visits from the apex and www with no MADANI_TRACK_ORIGINS set, and nothing from other hosts", async () => {
    app.close();
    app = createDashboardApp({ dataDir, publicUrl: SITE, mailer, staticDir: null, now: () => time, trustProxy: true, analytics: { sink }, admin: { emails: [ADMIN], env: {} } });
    expect((await beacon(view({ p: "/" }), { origin: "https://madani.bot" })).status).toBe(200);
    expect((await beacon(view({ p: "/", h: "www.madani.bot", pv: "pv000002" }), { origin: "https://www.madani.bot" })).status).toBe(200);
    expect((await beacon(view({ p: "/" }), { origin: "https://preview.madani.bot" })).status).toBe(403);
    expect((await beacon(view({ p: "/", h: "preview.madani.bot" }), { origin: "https://madani.bot" })).status).toBe(400);
    await settle();
    expect(sink.all.filter(event => event.name === "site_view").map(event => event.ctx?.host)).toEqual(["madani.bot", "www.madani.bot"]);
  });

  it("stores goals and page ends, and refuses what it should not count", async () => {
    await beacon({ v: 1, e: "goal", vid: VID, sid: SID, pv: "pv000001", h: "madani.bot", p: "/", g: "cta_click", m: { to: "/dashboard/signup", from: "/" } });
    await beacon({ v: 1, e: "leave", vid: VID, sid: SID, pv: "pv000001", h: "madani.bot", p: "/", s: 140, t: 5200.4 });
    expect((await beacon({ ...view(), e: "goal", g: "Bad Goal" })).status).toBe(400);
    expect((await beacon(view(), { origin: "https://evil.example" })).status).toBe(403);
    expect((await beacon(view({ h: "evil.example" }))).status).toBe(400);
    expect((await beacon(view({ vid: "short" }))).status).toBe(400);
    expect((await beacon("not json")).status).toBe(400);
    expect((await beacon("x".repeat(5000))).status).toBe(413);
    expect((await beacon(view(), { "user-agent": "Googlebot/2.1" })).status).toBe(204);
    expect((await beacon(view(), { "sec-gpc": "1" })).status).toBe(204);
    await settle();
    expect(sink.all.map(event => [event.name, event.props])).toEqual([["site_goal", { goal: "cta_click", to: "/dashboard/signup", from: "/" }], ["site_leave", { path: "/", scroll: 100, ms: 5200 }]]);
  });

  it("lowercases goal context and drops metadata outside the catalogue", async () => {
    expect((await beacon(view({ e: "goal", g: "click", m: { section: "Hero_Intro", label: "Get_Madani", value: "MAC", to: "/Download?email=private@example.com", email: "private@example.com" } }))).status).toBe(200);
    await beacon(view({ e: "goal", g: "click", m: { section: "bad section", label: "private@example.com", value: "a".repeat(41) } }));
    await beacon(view({ e: "goal", g: "click", m: { section: 42, label: ["array"], value: { nested: "never" } } }));
    await settle();
    expect(sink.all.map(event => event.props)).toEqual([
      { goal: "click", to: "/download", section: "hero_intro", label: "get_madani", value: "mac" }, { goal: "click" }, { goal: "click" },
    ]);
    expect(JSON.stringify(sink.all)).not.toContain("private@example.com");
  });

  it("accepts section batches, clamps durations and skips malformed entries", async () => {
    const res = await beacon(view({ e: "sections", l: [["hero", 300.6], ["pricing", -10], ["footer", 90_000_000], ["bad name", 500], ["UPPER", 500], ["", 500], ["a".repeat(41), 500], ["string", "500"], ["null", null], ["extra", 500, 1], [42, 500], null, {}] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ persist: true });
    expect((await beacon(view({ e: "sections", l: [] }))).status).toBe(200);
    for (const l of [undefined, null, "list", {}, Array.from({ length: 31 }, () => ["hero", 300])]) expect((await beacon(view({ e: "sections", l }))).status).toBe(400);
    expect((await beacon(view({ e: "unknown" }))).status).toBe(400);
    await settle();
    expect(sink.all.map(event => [event.name, event.props])).toEqual([
      ["site_section", { path: "/pricing", section: "hero", ms: 301 }], ["site_section", { path: "/pricing", section: "pricing", ms: 0 }], ["site_section", { path: "/pricing", section: "footer", ms: 86_400_000 }],
    ]);
    for (const event of sink.all) expect(event.ctx).toMatchObject({ visitor: VID, session: SID, pv: "pv000001", host: "madani.bot", page: "/pricing" });
    expect((await beacon(JSON.stringify(view({ e: "sections", l: [["infinite", 1]] })).replace('["infinite",1]', '["infinite",1e999]'))).status).toBe(200);
    await settle();
    expect(sink.all).toHaveLength(3);
  });

  it("keeps sections and new goals cookieless when consent would be needed", async () => {
    const headers = { "x-forwarded-for": "203.0.113.4, 172.70.1.1", "cf-ipcountry": "FR" };
    const res = await beacon(view({ e: "sections", l: [["hero", 800]] }), headers);
    expect(await res.json()).toEqual({ persist: false });
    await beacon(view({ e: "goal", g: "form_start", m: { section: "hero", label: "waitlist" } }), headers);
    await settle();
    expect(sink.all).toHaveLength(2);
    expect(sink.all[0]!.ctx!.visitor).not.toBe(VID);
    expect(sink.all[0]!.ctx!.session).not.toBe(SID);
    expect(sink.all[1]!.ctx).toMatchObject({ visitor: sink.all[0]!.ctx!.visitor, session: sink.all[0]!.ctx!.session });
  });

  describe("cookieless where consent would be needed", () => {
    const EU = { "x-forwarded-for": "203.0.113.4, 172.70.1.1", "cf-ipcountry": "FR" };
    it("derives a daily visitor and its visit on the server and tells the tracker to keep nothing", async () => {
      const first = await beacon(view(), EU);
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ persist: false });
      await beacon(view({ vid: "AAAAAAAAAAAAAAAAAAAAAA", sid: "BBBBBBBBBBBBBBBBBBBBBB", pv: "pv000002", p: "/docs" }), EU);
      await beacon({ v: 1, e: "leave", vid: VID, sid: SID, pv: "pv000002", h: "madani.bot", p: "/docs", s: 50, t: 1000 }, EU);
      await settle();
      const [a, b, c] = sink.all.map(event => event.ctx!);
      expect(a!.visitor).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect([a!.visitor, a!.session]).not.toContain(VID);
      expect([a!.visitor, a!.session]).not.toContain(SID);
      expect(b).toMatchObject({ visitor: a!.visitor, session: a!.session, country: "FR" });
      expect(c).toMatchObject({ visitor: a!.visitor, session: a!.session, pv: "pv000002" });
      expect(JSON.stringify(sink.all)).not.toContain("203.0.113.4");
    });
    it("starts a new visit after 30 idle minutes and a new visitor id the next day", async () => {
      await beacon(view(), EU);
      time += 31 * 60_000;
      await beacon(view(), EU);
      time += 24 * 3_600_000;
      await beacon(view(), EU);
      await settle();
      const [a, b, c] = sink.all.map(event => event.ctx!);
      expect(b!.visitor).toBe(a!.visitor);
      expect(b!.session).not.toBe(a!.session);
      expect(c!.visitor).not.toBe(a!.visitor);
    });
    it("treats the UK, Switzerland, the EEA and an unknown Cloudflare location as cookieless, and the US or a direct request as not", async () => {
      const persist = async (headers: Record<string, string>) => (await (await beacon(view(), headers)).json() as { persist: boolean }).persist;
      for (const country of ["GB", "CH", "NO", "DE", "XX", "T1"]) expect(await persist({ ...EU, "cf-ipcountry": country })).toBe(false);
      expect(await persist({ "x-forwarded-for": "203.0.113.4, 172.70.1.1" })).toBe(false);
      expect(await persist({ ...EU, "cf-ipcountry": "US" })).toBe(true);
      expect(await persist({ "x-forwarded-for": "203.0.113.4, 198.51.100.7", "cf-ipcountry": "FR" })).toBe(true);
    });
    it("still links the day's visitor to the account that signs in", async () => {
      await beacon(view(), EU);
      const cookie = await login(OTHER);
      await fetch(`${url}/v1/events`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, "user-agent": SAFARI, ...EU, cookie: `${cookie}; madani_vid=${VID}`, [CSRF_HEADER]: csrf.get(cookie)! },
        body: JSON.stringify({ visitor: VID, events: [{ name: "page_view", props: { path: "/" } }] }) });
      await settle();
      const visitor = sink.all.find(event => event.name === "site_view")!.ctx!.visitor;
      const links = sink.all.filter(event => event.name === "identify");
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({ accountId: app.auth.accountByEmail(OTHER)!.id, ctx: { visitor } });
      expect(visitor).not.toBe(VID);
    });
  });

  it("never counts the owner's own visits", async () => {
    const admin = await login(ADMIN);
    const before = sink.all.length;
    expect((await fetch(`${url}/v1/t`, { method: "POST", body: JSON.stringify(view({ h: "127.0.0.1" })), headers: { "content-type": "text/plain", origin: ORIGIN, "user-agent": SAFARI, cookie: admin } })).status).toBe(204);
    await settle();
    expect(sink.all.length).toBe(before);
  });

  const live = async (cookie: string) => (await fetch(`${url}/v1/admin/realtime?minutes=30`, { method: "GET", headers: { cookie } })).json() as Promise<{ online: { site: number }; here: Array<{ seed: string; page: string; country: string | null }> }>;

  it("shows the owner's own visit and an open page's pings as here now, without recording them", async () => {
    const admin = await login(ADMIN);
    expect(await live(admin)).toMatchObject({ online: { site: 0 }, here: [] });
    const before = sink.all.length;
    expect((await beacon(view(), { cookie: admin, "x-forwarded-for": "203.0.113.4, 172.70.1.1", "cf-ipcountry": "IN" })).status).toBe(204);
    // someone else's page, open six minutes after its page view: only its ping keeps it here
    expect((await beacon(view({ vid: "QqQqQqQqQqQqQqQqQqQqQq" }))).status).toBe(200);
    time += 6 * 60_000;
    expect((await beacon(view({ e: "ping", vid: "QqQqQqQqQqQqQqQqQqQqQq" }))).status).toBe(204);
    await settle();
    expect(sink.all.filter(event => event.name.startsWith("site_")).map(event => event.name)).toEqual(["site_view"]);
    expect(sink.all.length).toBe(before + 1);
    const answer = await live(admin);
    expect(answer.online.site).toBe(1);
    expect(answer.here).toEqual([expect.objectContaining({ seed: "QqQqQqQqQqQqQqQqQqQqQq", page: "/pricing" })]);
    expect((await beacon(view(), { cookie: admin, "x-forwarded-for": "203.0.113.4, 172.70.1.1", "cf-ipcountry": "IN" })).status).toBe(204);
    // the live view's next poll, past the few seconds one read is shared
    time += 5_000;
    const both = await live(admin);
    expect(both.online.site).toBe(2);
    expect(both.here.map(item => item.seed).sort()).toEqual(["QqQqQqQqQqQqQqQqQqQqQq", `owner:${VID}`]);
  });

  it("links a site visitor to the account that signs in on the same domain, once", async () => {
    const cookie = await login(OTHER);
    for (let n = 0; n < 2; n++) await fetch(`${url}/v1/events`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, cookie: `${cookie}; madani_vid=${VID}`, [CSRF_HEADER]: csrf.get(cookie)! },
      body: JSON.stringify({ events: [{ name: "page_view", props: { path: "/" } }] }) });
    await settle();
    const id = app.auth.accountByEmail(OTHER)!.id;
    const links = sink.all.filter(event => event.name === "identify");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ accountId: id, props: { via: "page" }, ctx: { visitor: VID } });
  });

  it("takes app usage anonymously, then identifies the install when the app signs in", async () => {
    const install = "inst_0123456789abcdef";
    const send = (body: unknown, token?: string) => fetch(`${url}/v1/app/events`, { method: "POST", headers: { "content-type": "application/json", origin: "app://madani", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    const events = [{ name: "app_open", props: { kind: "desktop", platform: "darwin", appVersion: "0.3.0" } }, { name: "app_screen", props: { screen: "/bots/ws_abcdefghijk" } },
      { name: "app_messages", props: { sent: 3, replies: 3, latencyMs: 1800, text: "never" } }, { name: "signup" }, { name: "app_feature", props: { feature: "rm_rf" } }];
    const anon = await send({ install, platform: "darwin", version: "0.3.0", session: "sess_0123456789abcdef", events });
    expect(anon.status).toBe(204);
    expect(anon.headers.get("access-control-allow-origin")).toBe("*");
    await settle();
    expect(sink.all.map(event => [event.name, event.accountId, event.props])).toEqual([
      ["app_open", null, { kind: "desktop", platform: "darwin", appVersion: "0.3.0" }], ["app_screen", null, { screen: "/bots/:id" }],
      ["app_messages", null, { sent: 3, replies: 3, latencyMs: 1800 }], ["app_feature", null, {}]]);
    expect(sink.all[0]!.ctx).toMatchObject({ install, session: "sess_0123456789abcdef", app: { platform: "darwin", version: "0.3.0" } });
    const token = await appToken(OTHER);
    expect((await send({ install, events: [{ name: "app_feature", props: { feature: "bot_created" } }] }, token)).status).toBe(204);
    await settle();
    const id = app.auth.accountByEmail(OTHER)!.id;
    expect(sink.all.find(event => event.name === "identify")).toMatchObject({ accountId: id, props: { via: "app" }, ctx: { install } });
    expect(sink.all.findLast(event => event.name === "app_feature")).toMatchObject({ accountId: id, props: { feature: "bot_created" } });
    expect((await send({ install: "x", events })).status).toBe(400);
    expect((await send({ install, events: Array.from({ length: 51 }, () => events[0]) })).status).toBe(400);
  });

  it("takes the app's account sign-in funnel steps, and keeps only the name of one carrying anything else", async () => {
    const install = "inst_0123456789abcdef";
    const action = (props: Record<string, unknown>) => ({ name: "app_action", props: { name: "account_sign_in", ...props } });
    const events = [action({ step: "shown" }), action({ step: "method", method: "google", via: "browser" }), action({ step: "handoff", method: "apple", via: "browser" }),
      action({ step: "returned", method: "apple", via: "browser" }), action({ step: "cancelled", method: "email", via: "link" }), action({ step: "skipped" }),
      action({ step: "error", method: "email", via: "code", code: "wrong_code" }),
      action({ step: "error", method: "email", code: "failed", email: "someone@example.test" }), action({ step: "error", code: "tok_abc123" }), action({ step: "teleported" })];
    const answer = await fetch(`${url}/v1/app/events`, { method: "POST", headers: { "content-type": "application/json", origin: "app://madani" }, body: JSON.stringify({ install, platform: "darwin", version: "0.3.0", events }) });
    expect(answer.status).toBe(204);
    await settle();
    expect(sink.all.map(event => [event.name, event.props])).toEqual([
      ["app_action", { name: "account_sign_in", step: "shown" }], ["app_action", { name: "account_sign_in", step: "method", method: "google", via: "browser" }],
      ["app_action", { name: "account_sign_in", step: "handoff", method: "apple", via: "browser" }], ["app_action", { name: "account_sign_in", step: "returned", method: "apple", via: "browser" }],
      ["app_action", { name: "account_sign_in", step: "cancelled", method: "email", via: "link" }], ["app_action", { name: "account_sign_in", step: "skipped" }],
      ["app_action", { name: "account_sign_in", step: "error", method: "email", via: "code", code: "wrong_code" }],
      // an email, a free-form code or an unknown step drops the whole signal to its name
      ["app_action", { name: "account_sign_in" }], ["app_action", { name: "account_sign_in" }], ["app_action", { name: "account_sign_in" }]]);
    expect(JSON.stringify(sink.all)).not.toContain("example.test");
  });
});
