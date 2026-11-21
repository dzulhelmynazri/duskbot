import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoClient } from "mongodb";
import { createAnalytics } from "./index.ts";
import { memorySink, mongoSink } from "./sink.ts";
import { deviceOf, requestContext, touchContext } from "./context.ts";
import { cleanProps, routeOf } from "./events.ts";
import { funnel, dayRange, isPaying, perDay, wasPaid } from "../admin/metrics.ts";
import { brevoChecker, csvField } from "../admin/waitlist.ts";
import { healthTargets } from "../admin/health.ts";

const DAY = 86_400_000;
const SAFARI_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const fakeReq = (headers: Record<string, string>, url = "/", method = "GET") => ({ method, url, headers, socket: { remoteAddress: "203.0.113.9" } }) as unknown as IncomingMessage;
const settle = () => new Promise(resolve => setTimeout(resolve, 10));

describe("analytics", () => {
  let dataDir: string, time: number;
  let sink: ReturnType<typeof memorySink>;
  let analytics: ReturnType<typeof createAnalytics>;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "madani-analytics-test-"));
    time = Date.parse("2026-11-12T10:00:00Z");
    sink = memorySink(() => time);
    analytics = createAnalytics({ sink, dataDir, now: () => time, trustProxy: true });
  });
  afterEach(() => { analytics.close(); rmSync(dataDir, { recursive: true, force: true }); });

  it("reads Cloudflare's visitor headers only when Cloudflare's edge is the proxy's peer", () => {
    const headers = { "user-agent": IPHONE, "cf-ipcountry": "IN", "cf-ipcity": "Pune", "cf-region": "Maharashtra", "cf-iplatitude": "18.52043", "cf-iplongitude": "73.85674" };
    expect(requestContext(fakeReq(headers), { publicOrigin: "https://madani.bot", trustProxy: true })).toEqual({ device: "mobile", os: "ios", browser: "safari", source: "direct", channel: "direct" });
    const edge = fakeReq({ ...headers, "x-forwarded-for": "198.51.100.7, 172.70.1.1" });
    expect(requestContext(edge, { publicOrigin: "https://madani.bot", trustProxy: false }).country).toBeUndefined();
    expect(requestContext(edge, { publicOrigin: "https://madani.bot", trustProxy: true })).toMatchObject({ country: "IN", city: "Pune", region: "Maharashtra", lat: 18.5, lon: 73.9 });
  });

  it("names channels from tags first, then the referrer, with AI assistants apart from search", () => {
    expect(touchContext({ referrer: "chatgpt.com" })).toMatchObject({ source: "ChatGPT", channel: "ai" });
    expect(touchContext({ referrer: "www.google.com" })).toMatchObject({ channel: "search" });
    expect(touchContext({ referrer: "news.ycombinator.com", utmSource: "newsletter", utmMedium: "email" })).toMatchObject({ channel: "email", utm: { source: "newsletter", medium: "email" } });
    expect(touchContext({ ref: "launch-thread" })).toMatchObject({ source: "launch-thread", channel: "referral", ref: "launch-thread" });
    expect(touchContext({ utmSource: "a@b.c" }).utm).toBeUndefined();
    expect(touchContext({})).toEqual({ source: "direct", channel: "direct" });
    expect(deviceOf("Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/131 Mobile")).toEqual({ device: "mobile", os: "android", browser: "chrome" });
    const chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    expect(deviceOf(chrome, { brands: '"Brave";v="131", "Chromium";v="131"' }).browser).toBe("brave");
    expect(deviceOf(chrome, { hint: "arc" }).browser).toBe("arc");
    expect(deviceOf(chrome, { hint: "netscape" }).browser).toBe("chrome");
    expect(deviceOf(SAFARI_UA, { hint: "arc" }).browser).toBe("safari");
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
    expect(deviceOf(`${iphone} Twitter for iPhone/11.20`).browser).toBe("x app");
    expect(deviceOf(`${iphone} Barcelona 360.0.0.30.109`).browser).toBe("threads app");
    expect(deviceOf(`${iphone} Instagram 360.0.0.30.109`).browser).toBe("instagram app");
    expect(deviceOf(`${iphone} [FBAN/FBIOS;FBAV/490.0]`).browser).toBe("facebook app");
    expect(deviceOf(`${iphone} [LinkedInApp]/9.30`).browser).toBe("linkedin app");
    expect(deviceOf(iphone).browser, "an iOS web view with no app named is still Safari's engine").toBe("safari");
    expect(deviceOf("Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122 Mobile Safari/537.36").browser).toBe("samsung");
    expect(deviceOf(`${chrome} OPR/115.0`).browser).toBe("opera");
  });

  it("counts an app device active once a day, and the first bot reply once ever", async () => {
    const session = { id: "ses_1", accountId: "acct_1", platform: "darwin", appVersion: "0.2.0" };
    for (let n = 0; n < 5; n++) analytics.appActive(session);
    analytics.botReplied("acct_1"); analytics.botReplied("acct_1");
    await settle();
    expect(sink.all.map(event => event.name)).toEqual(["app_active", "first_bot_reply"]);
    expect(sink.all[0]).toMatchObject({ props: { platform: "darwin", appVersion: "0.2.0" }, ctx: { session: "ses_1", app: { platform: "darwin", version: "0.2.0" } } });
    time += DAY;
    analytics.appActive(session);
    const restarted = createAnalytics({ sink, dataDir, now: () => time });
    restarted.botReplied("acct_1");
    await settle();
    restarted.close();
    expect(sink.all.map(event => event.name)).toEqual(["app_active", "first_bot_reply", "app_active"]);
  });

  it("keeps raw events 400 days and the daily counts forever", async () => {
    await analytics.record("onboarding_done", { accountId: "acct_1" });
    time += 401 * DAY;
    await analytics.record("onboarding_done", { accountId: "acct_2" });
    expect(sink.all.map(event => event.accountId)).toEqual(["acct_2"]);
    expect([...sink.daySums.values()].reduce((a, b) => a + b, 0)).toBe(4);
  });

  it("keeps only known props and folds ids out of routes", () => {
    expect(cleanProps("sign_in", { kind: "desktop", platform: "darwin", appVersion: "1.2.3", email: "a@b.c" })).toEqual({ kind: "desktop", platform: "darwin", appVersion: "1.2.3" });
    expect(cleanProps("cloud_state", { cloudId: "nope" })).toEqual({});
    expect(routeOf("/Workspaces/ws_8f3k2m1n0p9q/?tab=1")).toBe("/workspaces/:id");
    expect(routeOf("/billing")).toBe("/billing");
    expect(routeOf("/invoices/12345")).toBe("/invoices/:id");
  });
});

describe("admin metrics", () => {
  const now = Date.parse("2026-11-12T10:00:00Z");
  it("builds a nested funnel and keeps each step's own total", () => {
    const accounts = ["a", "b", "c", "d"].map((id, i) => ({ id, createdAt: now - i * DAY }));
    const steps = funnel({ since: now - 10 * DAY, siteVisitors: 40, accounts: [...accounts, { id: "old", createdAt: now - 90 * DAY }],
      checkouts: [{ accountId: "a", kind: "cart", cart: { interval: "month", license: { kind: "none" }, desktop: { kind: "shared_s" } } }, { accountId: "b", kind: "credits", cart: null }],
      subscriptions: [{ accountId: "a", status: "active", currentPeriodStart: now }, { accountId: "old", status: "active", currentPeriodStart: now }],
      sessions: [{ accountId: "a", kind: "desktop" }, { accountId: "c", kind: "mobile" }, { accountId: "d", kind: "web" }],
      workspaces: [{ ownerAccountId: "c", report: { at: now, workspace: { name: "x", kind: "mac", version: "1", platform: "darwin" }, activity: { from: "", to: "", timeZone: "UTC", days: [{ date: "2026-11-12", turns: 3, tokens: 1, costUsd: 0 }], byBot: [], byModel: [], totals: { turns: 3, tokens: 1, costUsd: 0 } } } }],
      marked: { onboarded: new Set(["d"]), paired: new Set(), replied: new Set(), chosen: new Set() } });
    expect(steps.map(step => [step.id, step.count, step.total])).toEqual([["site", 40, 40], ["signup", 4, 4], ["onboarded", 3, 3], ["cloud", 1, 1], ["paid", 1, 1], ["paired", 1, 2], ["replied", 0, 1]]);
  });
  it("lays counts on a fixed day range", () => {
    const days = dayRange(now, 3);
    expect(days).toEqual(["2026-11-10", "2026-11-11", "2026-11-12"]);
    expect(perDay(days, [{ day: "2026-11-12", count: 2 }, { day: "2026-11-10", count: 1 }, { day: "2026-11-12", count: 1 }, { day: "2025-01-01", count: 9 }])).toEqual([1, 0, 3]);
  });
  it("checks the Brevo list against the waitlist, caching the answer", async () => {
    let calls = 0;
    const fetcher = (async () => { calls++; return new Response(JSON.stringify({ uniqueSubscribers: 10 }), { status: 200 }); }) as typeof fetch;
    expect(await brevoChecker({})(5)).toMatchObject({ state: "not_configured" });
    const check = brevoChecker({ apiKey: "k", listId: "7", fetch: fetcher, now: () => now });
    expect(await check(10)).toMatchObject({ state: "synced", listCount: 10 });
    expect(await check(12)).toMatchObject({ state: "behind", listCount: 10, waitlistCount: 12 });
    expect(calls).toBe(1);
    const broken = brevoChecker({ apiKey: "k", listId: "7", fetch: (async () => new Response("", { status: 401 })) as typeof fetch, now: () => now });
    expect(await broken(1)).toMatchObject({ state: "error" });
  });
  it("neutralises spreadsheet formulas and parses health targets", () => {
    expect(csvField("=HYPERLINK(1)")).toBe("\"'=HYPERLINK(1)\"");
    expect(csvField("a\"b")).toBe("\"a\"\"b\"");
    expect(csvField(null)).toBe("\"\"");
    expect(healthTargets("link=https://link.madani.bot/health, bad=ftp://x, =http://y, site=http://127.0.0.1:3106/")).toEqual([
      { name: "link", url: "https://link.madani.bot/health" }, { name: "site", url: "http://127.0.0.1:3106/" }]);
  });
});

// needs a replica set: MADANI_TEST_MONGODB_URI names a server whose user may drop MADANI_TEST_MONGODB_DB (default madani_test)
const uri = process.env.MADANI_TEST_MONGODB_URI, dbName = process.env.MADANI_TEST_MONGODB_DB || "madani_test";
describe.skipIf(!uri)("analytics in mongodb", () => {
  let client: MongoClient;
  afterAll(async () => { for (const name of ["analytics_events", "analytics_daily", "analytics_marks", "admin_audit"]) await client.db(dbName).collection(name).drop().catch(() => {}); await client.close(); });
  it("stores events with a TTL, counts days, marks once, and forgets an account", async () => {
    client = await MongoClient.connect(uri!);
    const db = client.db(dbName);
    for (const name of ["analytics_events", "analytics_daily", "analytics_marks", "admin_audit"]) await db.collection(name).drop().catch(() => {});
    const sink = await mongoSink(db);
    const at = Date.now();
    await sink.insert({ id: "ev_1", name: "sign_in", at, accountId: "acct_1", props: { kind: "web" }, ctx: { country: "DE" } });
    await sink.insert({ id: "ev_2", name: "page_view", at: at + 1, accountId: null, props: { path: "/" } });
    await sink.bump("2026-11-12", "sign_in"); await sink.bump("2026-11-12", "sign_in");
    expect(await sink.daily(["sign_in"], "2026-11-01", "2026-11-30")).toEqual([{ day: "2026-11-12", name: "sign_in", count: 2 }]);
    expect(await sink.once("k", at + DAY)).toBe(true);
    expect(await sink.once("k", at + DAY)).toBe(false);
    expect((await sink.events({ limit: 10 })).map(event => event.id)).toEqual(["ev_2", "ev_1"]);
    expect((await sink.events({ accountId: "acct_1", limit: 10 }))[0]!.ctx).toEqual({ country: "DE" });
    expect([...await sink.accounts(["sign_in"], at - 1)]).toEqual(["acct_1"]);
    await sink.forget("acct_1");
    expect((await sink.events({ limit: 10 })).map(event => event.id)).toEqual(["ev_2"]);
    const ttl = (await db.collection("analytics_events").indexes()).find(index => index.expireAfterSeconds !== undefined);
    expect(ttl?.expireAfterSeconds).toBe(400 * 86_400);
    expect((await sink.health()).ok).toBe(true);
  });
});

describe("ai crawlers", () => {
  it("keeps AI crawler requests apart, capped, with robots.txt and llms.txt by name", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "madani-crawl-test-"));
    const sink = memorySink(() => 1000);
    const analytics = createAnalytics({ sink, dataDir, now: () => 1000 });
    analytics.crawlerVisit(fakeReq({ "user-agent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)" }, "/llms.txt"), "madani.bot");
    analytics.crawlerVisit(fakeReq({ "user-agent": "Mozilla/5.0 (compatible; ChatGPT-User/1.0)" }, "/pricing?x=1"), "madani.bot");
    analytics.crawlerVisit(fakeReq({ "user-agent": SAFARI_UA }, "/"), "madani.bot");
    await settle();
    expect(await sink.crawls(0, 2000)).toEqual([{ at: 1000, bot: "GPTBot", kind: "training", path: "/llms.txt", host: "madani.bot" }, { at: 1000, bot: "ChatGPT-User", kind: "answers", path: "/pricing", host: "madani.bot" }]);
    expect(sink.all).toEqual([]);
    analytics.close(); rmSync(dataDir, { recursive: true, force: true });
  });
});

describe("paying", () => {
  it("never counts a failed charge as paying, though it was paid for", () => {
    expect(isPaying({ status: "payment_problem" })).toBe(false);
    expect(isPaying({ status: "active" })).toBe(true);
    expect(wasPaid({ status: "payment_problem", currentPeriodStart: null })).toBe(true);
  });
});
