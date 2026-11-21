import { describe, expect, it } from "vitest";
import type { StoredEvent } from "./sink.ts";
import type { EventContext } from "./context.ts";
import { DAY, HOUR, DIMENSIONS, SURFACES, RETURN_WINDOWS, activeDays, breakdown, bucketsOf, due, funnel, identityOf, kpis, matches, online, retention, returned, series, valuesOf, visitsOf, type FunnelInput, type People } from "./web.ts";

const FROM = Date.parse("2026-09-01T00:17:00Z");
const event = (name: string, at: number, props: StoredEvent["props"] = {}, ctx?: EventContext, accountId: string | null = null): StoredEvent =>
  ({ id: `${name}:${at}:${ctx?.session ?? accountId}`, name, at, props, accountId, ...(ctx ? { ctx } : {}) });
const site = (visitor: string, session: string, at: number, path = "/", ctx: EventContext = {}) =>
  event("site_view", at, { path }, { visitor, session, pv: `${session}:${path}`, ...ctx });
const link = (visitor: string, account: string, install?: string) => event("identify", FROM, {}, { visitor, ...(install ? { install } : {}) }, account);
const emptyPeople = (): People => ({ signups: new Map(), paid: new Map() });

describe("visitsOf", () => {
  it("separates surfaces sharing a session and defaults to site visits", () => {
    const events = [site("v", "same", FROM, "/", { host: "madani.bot", utm: { term: "AI-Assistant" } }),
      event("page_view", FROM + 10, { path: "/billing" }, { session: "same", visitor: "v", source: "Google", channel: "search", country: "IN", device: "desktop", os: "mac", browser: "chrome", host: "preview.madani.bot", utm: { term: "Madani_Bot" } }, "acct_a"),
      event("page_view", FROM + 20, { path: "/usage" }, { session: "same", visitor: "v" }, "acct_a"),
      event("page_view", FROM, { path: "/ignored" }, {}, "acct_a"), event("page_view", FROM, {}, { session: "anonymous" }),
      event("app_open", FROM + 30, { kind: "desktop" }, { session: "same", install: "mac", app: { platform: "darwin" } }, "acct_a"),
      event("app_screen", FROM + 40, { screen: "/bots" }, { session: "same", install: "mac" }, "acct_a"),
      event("app_feature", FROM + 50, { feature: "bot_created" }, { session: "same", install: "mac" }, "acct_a"),
      event("app_close", FROM + 60, { ms: 5 }, { session: "same", install: "mac" }, "acct_a")];
    expect(visitsOf(events)).toEqual(visitsOf(events, ["site"]));
    const visits = visitsOf(events, SURFACES);
    expect(visits).toHaveLength(3);
    expect(visits[0]).toMatchObject({ surface: "site", keyword: "ai-assistant" });
    expect(visits[1]).toMatchObject({ surface: "account", visitor: "v", entry: "/dashboard/billing", exit: "/dashboard/usage", engagedMs: 10, bounced: false, source: "Google", channel: "search", country: "IN", device: "desktop", os: "mac", browser: "chrome", host: "preview.madani.bot", keyword: "madani_bot" });
    expect(visits[2]).toMatchObject({ surface: "desktop", visitor: "acct_a", entry: "/bots", engagedMs: 5 });
    const home = visitsOf([event("page_view", FROM, { path: "/" }, { session: "s9", visitor: "w" })], SURFACES);
    expect(home[0]).toMatchObject({ surface: "account", entry: "/dashboard" });
    expect(visits[2]!.pages).toHaveLength(1);
    for (const dim of ["surface", "host", "keyword"] as const) expect(valuesOf(visits[0]!, dim)).toEqual([visits[0]![dim]]);
    expect(matches(visits[1]!, { surface: "account", host: "preview.madani.bot", keyword: "madani_bot" })).toBe(true);
    expect(valuesOf(visits[2]!, "keyword")).toEqual(["unknown"]);
    expect(valuesOf({ ...visits[0]!, referrer: null, source: "launch-thread" }, "referrer"), "a ?ref or utm source stands in for a missing referrer").toEqual(["launch-thread"]);
    expect(valuesOf({ ...visits[0]!, referrer: null, source: "direct" }, "referrer")).toEqual(["direct"]);
    expect(valuesOf({ ...visits[0]!, referrer: "news.ycombinator.com", source: "Hacker News" }, "referrer")).toEqual(["news.ycombinator.com"]);
  });

  it("groups app sessions by install and day when needed and recognizes phone opens without platform context", () => {
    const visits = visitsOf([
      event("app_open", FROM, {}, { install: "i", app: { platform: "ios" } }),
      event("app_close", FROM + 100, { ms: 0 }, { install: "i" }),
      event("app_open", FROM + DAY, {}, { install: "i", app: { platform: "android" } }),
      event("app_screen", FROM + DAY + 10, { screen: "/chat" }, { install: "i" }),
      event("app_open", FROM, { kind: "mobile" }, { session: "mobile", install: "other" }),
      event("app_close", FROM + 1000, {}, { session: "mobile", install: "other" }),
      event("app_open", FROM, {}, { session: "windows", install: "pc", app: { platform: "win32" } }),
      event("app_open", FROM, {}, { session: "missing-person" }), event("app_open", FROM, {}, {}, "acct_missing_session"),
      event("app_feature", FROM, { feature: "bot_created" }, { session: "feature-only", install: "i" }),
    ], ["phone", "desktop"]);
    expect(visits).toHaveLength(4);
    expect(visits.filter(visit => visit.surface === "phone")).toHaveLength(3);
    expect(visits[0]).toMatchObject({ visitor: "install:i", entry: "/", engagedMs: 0 });
    expect(visits.find(visit => visit.session === "mobile")).toMatchObject({ surface: "phone", engagedMs: 1000 });
    expect(visits.at(-1)).toMatchObject({ visitor: "install:i", entry: "/chat", engagedMs: 10 });
    expect(visitsOf([], [])).toEqual([]);
  });

  it("attributes filtered conversions to account ids and identified installs", () => {
    const events = [event("page_view", FROM, { path: "/" }, { session: "account" }, "acct_a"),
      event("app_open", FROM, {}, { session: "app", install: "i" }), link("v", "acct_b", "i")];
    const visits = visitsOf(events, SURFACES), identity = identityOf(events);
    const people = { signups: new Map([["acct_a", FROM + 1], ["acct_b", FROM + 2]]), paid: new Map([["acct_b", FROM + 3]]) };
    expect(kpis(visits, identity, people, FROM, FROM + HOUR, { surface: "account" })).toMatchObject({ visitors: 1, signups: 1, paid: 0 });
    expect(kpis(visits, identity, people, FROM, FROM + HOUR, { surface: "desktop" })).toMatchObject({ visitors: 1, signups: 1, paid: 1 });
    expect(breakdown(visits, identity, people, "surface", FROM, FROM + HOUR)).toEqual([{ key: "account", visitors: 1, signups: 1, paid: 0 }, { key: "desktop", visitors: 1, signups: 1, paid: 1 }]);
    expect(series(visits, people, FROM, FROM + HOUR, { surface: "account" }, identity).signups).toEqual([1]);
    expect(series(visits, people, FROM, FROM + HOUR, { surface: "desktop" }, identity).paid).toEqual([1]);
  });

  it("groups sessions, keeps first-view attribution, entry/exit, and maximum leave measurements per page", () => {
    const events = [
      site("v1", "s1", FROM, "/", { source: "ChatGPT", channel: "ai", referrer: "chatgpt.com", utm: { campaign: "launch", source: "newsletter" }, ref: "thread", country: "DE", region: "BE", city: "Berlin", lat: 52.5, lon: 13.4, device: "desktop", os: "mac", browser: "safari", host: "madani.bot", pv: "p1" }),
      event("site_leave", FROM + 100, { path: "/", ms: 8000, scroll: 75 }, { visitor: "v1", session: "s1", pv: "p1" }),
      event("site_leave", FROM + 200, { path: "/", ms: 2000, scroll: 90 }, { visitor: "v1", session: "s1", pv: "p1" }),
      site("v1", "s1", FROM + 300, "/pricing", { source: "Google", channel: "search", country: "US", device: "mobile", pv: "p2" }),
      event("site_leave", FROM + 400, { path: "/pricing", ms: 4000, scroll: 50 }, { visitor: "v1", session: "s1", pv: "p2" }),
      site("v1", "s2", FROM + 500, "/docs"),
    ];
    const visits = visitsOf(events);
    expect(visits).toHaveLength(2);
    expect(visits[0]).toMatchObject({ visitor: "v1", session: "s1", start: FROM, end: FROM + 400, entry: "/", exit: "/pricing", engagedMs: 12000, bounced: false,
      source: "ChatGPT", channel: "ai", referrer: "chatgpt.com", campaign: "launch", ref: "thread", country: "DE", region: "BE", city: "Berlin", lat: 52.5, lon: 13.4, device: "desktop", os: "mac", browser: "safari", host: "madani.bot" });
    expect([...visits[0]!.leaves]).toEqual([["p1", { path: "/", ms: 8000, scroll: 90 }], ["p2", { path: "/pricing", ms: 4000, scroll: 50 }]]);
    expect(visits[1]).toMatchObject({ entry: "/docs", exit: "/docs", bounced: true, engagedMs: 0, source: "direct", channel: "direct" });
  });

  it("uses elapsed time when longer, recognizes goals, and ignores invalid identities and sessions without views", () => {
    const visits = visitsOf([
      event("site_goal", FROM - 100, { goal: "waitlist_join", to: "/thanks" }, { session: "s", visitor: "v", pv: "p" }),
      site("v", "s", FROM, "/", { pv: "p", utm: { source: "launch" } }),
      event("site_leave", FROM + 5000, { ms: 100, scroll: 30 }, { session: "s", visitor: "v", pv: "p" }),
      event("site_view", FROM, { path: "/bad" }, { session: "no-visitor" }),
      event("site_view", FROM, { path: "/bad" }, { visitor: "no-session" }),
      event("site_goal", FROM, { goal: "cta" }, { session: "no-view", visitor: "v" }),
      event("app_open", FROM, {}, { session: "app", visitor: "v" }),
    ]);
    expect(visits).toHaveLength(1);
    expect(visits[0]).toMatchObject({ bounced: false, engagedMs: 5100, ref: "launch", goals: [{ goal: "waitlist_join", at: FROM - 100, to: "/thanks" }] });
  });

  it("attributes an out-of-order event array to the chronologically first page view", () => {
    const [visit] = visitsOf([site("v", "s", FROM + 1000, "/last", { source: "Google", channel: "search" }), site("v", "s", FROM, "/first", { source: "ChatGPT", channel: "ai" })]);
    expect(visit).toMatchObject({ entry: "/first", exit: "/last", source: "ChatGPT", channel: "ai" });
  });
});

describe("identityOf", () => {
  it("links multiple visitors and installs to one account and ignores unrelated or anonymous events", () => {
    const identity = identityOf([link("v1", "a", "i1"), link("v2", "a", "i2"), link("v1", "a", "i1"), link("v3", "b"), event("identify", FROM, {}, { visitor: "ignored", install: "ignored" }), event("app_open", FROM, {}, { visitor: "other" }, "a")]);
    expect([...identity.accountOf]).toEqual([["v1", "a"], ["install:i1", "a"], ["v2", "a"], ["install:i2", "a"], ["v3", "b"]]);
    expect(identity.visitorsOf.get("a")).toEqual(new Set(["v1", "v2"]));
    expect(identity.installsOf.get("a")).toEqual(new Set(["i1", "i2"]));
    expect(identityOf([])).toEqual({ accountOf: new Map(), visitorsOf: new Map(), installsOf: new Map() });
  });
});

function traffic() {
  const events = [
    site("old", "old", FROM - HOUR, "/old"),
    site("v1", "s1", FROM, "/", { channel: "ai", source: "ChatGPT", pv: "p1" }),
    site("v1", "s1", FROM + 1000, "/pricing", { pv: "p2" }),
    event("site_goal", FROM + 2000, { goal: "waitlist_join" }, { visitor: "v1", session: "s1", pv: "p2" }),
    site("v2", "s2", FROM + 3000, "/", { channel: "ai", source: "ChatGPT" }),
    site("v1", "s3", FROM + HOUR, "/pricing", { channel: "ai", source: "ChatGPT" }),
    site("v3", "s4", FROM + HOUR + 1000, "/", { channel: "search", source: "Google" }),
    event("site_leave", FROM + HOUR + 7000, { ms: 100, scroll: 20 }, { visitor: "v3", session: "s4", pv: "s4:/" }),
    site("outside", "outside", FROM + 2 * HOUR, "/outside"),
    link("v1", "a"), link("v2", "b"), link("v3", "c"),
  ];
  const people: People = { signups: new Map([["a", FROM + 100], ["b", FROM - 1], ["c", FROM + HOUR], ["unlinked", FROM + 200], ["boundary", FROM + 2 * HOUR]]),
    paid: new Map([["a", FROM + HOUR], ["b", FROM + 2 * HOUR], ["c", FROM - 1]]) };
  return { events, visits: visitsOf(events), identity: identityOf(events), people };
}

describe("kpis and time series", () => {
  it("counts distinct visitors, visits, pageviews, account records, conversion, bounce, waitlist and median duration", () => {
    const { visits, identity, people } = traffic();
    expect(kpis(visits, identity, people, FROM, FROM + 2 * HOUR)).toEqual({ visitors: 3, visits: 4, pageviews: 5, signups: 3, paid: 1, waitlist: 1, conversion: 1, bounce: 3 / 4, visitMs: 1000 });
    expect(kpis(visits, identity, people, FROM, FROM + 2 * HOUR, { channel: "ai" })).toEqual({ visitors: 2, visits: 3, pageviews: 4, signups: 1, paid: 1, waitlist: 1, conversion: 1 / 2, bounce: 2 / 3, visitMs: 0 });
    expect(kpis(visits, identity, people, FROM - 2 * HOUR, FROM)).toMatchObject({ visitors: 1, visits: 1, pageviews: 1, signups: 1, paid: 1, waitlist: 0 });
    expect(kpis([], identityOf([]), emptyPeople(), FROM, FROM + HOUR)).toEqual({ visitors: 0, visits: 0, pageviews: 0, signups: 0, paid: 0, waitlist: 0, conversion: null, bounce: null, visitMs: null });
  });

  it("starts hourly buckets at from through exactly two days, then switches to daily buckets", () => {
    expect(bucketsOf(FROM, FROM + HOUR + 1)).toEqual({ size: HOUR, starts: [FROM, FROM + HOUR] });
    expect(bucketsOf(FROM, FROM + 2 * DAY).starts).toHaveLength(48);
    expect(bucketsOf(FROM, FROM + 2 * DAY).size).toBe(HOUR);
    expect(bucketsOf(FROM, FROM + 2 * DAY + 1)).toEqual({ size: DAY, starts: [FROM, FROM + DAY, FROM + 2 * DAY] });
  });

  it("buckets visitors, signups, paid and waitlist, applying the same identity filter to account records", () => {
    const { visits, identity, people } = traffic();
    expect(series(visits, people, FROM, FROM + 2 * HOUR)).toEqual({ size: HOUR, starts: [FROM, FROM + HOUR], visitors: [2, 2], signups: [2, 1], paid: [0, 1], waitlist: [1, 0] });
    expect(series(visits, people, FROM, FROM + 2 * HOUR, { channel: "ai" }, identity)).toEqual({ size: HOUR, starts: [FROM, FROM + HOUR], visitors: [2, 1], signups: [1, 0], paid: [0, 1], waitlist: [1, 0] });
    expect(series(visits, people, FROM, FROM + 3 * DAY).visitors).toEqual([4, 0, 0]);
  });

  it("counts a waitlist visitor once per bucket even across multiple sessions", () => {
    const visits = visitsOf([site("v", "s1", FROM), event("site_goal", FROM + 1, { goal: "waitlist_join" }, { visitor: "v", session: "s1", pv: "p1" }),
      site("v", "s2", FROM + 2), event("site_goal", FROM + 3, { goal: "waitlist_join" }, { visitor: "v", session: "s2", pv: "p2" })]);
    expect(series(visits, emptyPeople(), FROM, FROM + HOUR).waitlist).toEqual([1]);
  });
});

describe("breakdown", () => {
  it("sorts distinct visitors, overlays only linked in-window account records, applies filters and limits", () => {
    const { visits, identity, people } = traffic();
    expect(breakdown(visits, identity, people, "channel", FROM, FROM + 2 * HOUR)).toEqual([
      { key: "ai", visitors: 2, signups: 1, paid: 1 }, { key: "search", visitors: 1, signups: 1, paid: 0 },
    ]);
    expect(breakdown(visits, identity, people, "source", FROM, FROM + 2 * HOUR, {}, 1)).toEqual([{ key: "ChatGPT", visitors: 2, signups: 1, paid: 1 }]);
    expect(breakdown(visits, identity, people, "page", FROM, FROM + 2 * HOUR, { channel: "search" })).toEqual([{ key: "/", visitors: 1, signups: 1, paid: 0 }]);
    expect(breakdown(visits, identity, people, "country", FROM, FROM + 2 * HOUR)).toEqual([{ key: "unknown", visitors: 3, signups: 2, paid: 1 }]);
    for (const dim of DIMENSIONS) expect(breakdown([], identity, people, dim, FROM, FROM + HOUR)).toEqual([]);
  });

  it("counts each visitor once per page, including repeat pageviews and sessions, and tracks entry and exit", () => {
    const events = [site("v1", "s1", FROM, "/"), site("v1", "s1", FROM + 1, "/"), site("v1", "s1", FROM + 2, "/end"), site("v1", "s2", FROM + 3, "/"), site("v2", "s3", FROM + 4, "/end")];
    const visits = visitsOf(events), identity = identityOf([]), people = emptyPeople();
    expect(breakdown(visits, identity, people, "page", FROM, FROM + HOUR)).toEqual([{ key: "/end", visitors: 2, signups: 0, paid: 0 }, { key: "/", visitors: 1, signups: 0, paid: 0 }]);
    expect(breakdown(visits, identity, people, "entry", FROM, FROM + HOUR).map(row => [row.key, row.visitors])).toEqual([["/", 1], ["/end", 1]]);
    expect(breakdown(visits, identity, people, "exit", FROM, FROM + HOUR).map(row => [row.key, row.visitors])).toEqual([["/end", 2], ["/", 1]]);
    expect(breakdown(visitsOf([site("v", "s", FROM, "/", { source: "" })]), identity, people, "source", FROM, FROM + HOUR)[0]!.key).toBe("unknown");
  });
});

describe("online", () => {
  it("counts site visitors and app installs or accounts separately in the last five minutes", () => {
    expect(online([
      site("v", "s", FROM - 300_000), site("v", "s2", FROM), site("old", "s3", FROM - 300_001),
      event("site_goal", FROM, { goal: "cta" }, { visitor: "v2" }),
      event("app_open", FROM, {}, { install: "i" }, "a"), event("app_screen", FROM, {}, { install: "i" }, "a"),
      event("app_open", FROM, {}, { install: "i2" }, "a"), event("app_open", FROM, {}, undefined, "b"),
      event("app_open", FROM - 300_001, {}, { install: "old" }), event("app_open", FROM),
      event("signup", FROM, {}, undefined, "c"), site("future", "s4", FROM + 60_001),
    ], FROM)).toEqual({ site: 2, app: 3 });
  });
  it("counts people on the account pages as on the site, once with their site visits", () => {
    expect(online([
      site("v", "s", FROM), event("page_view", FROM, { path: "/" }, { visitor: "v", session: "tab" }),
      event("page_view", FROM, { path: "/signin" }, { visitor: "anon", session: "tab2" }), event("page_view", FROM, { path: "/" }, { session: "tab3" }, "acct_a"),
      event("page_view", FROM - 300_001, { path: "/" }, { visitor: "old" }), event("page_view", FROM),
    ], FROM)).toEqual({ site: 3, app: 0 });
  });
});

describe("retention", () => {
  it("collects distinct UTC active days only for catalogue activity with an account", () => {
    const days = activeDays([event("app_open", 10 * DAY, {}, undefined, "a"), event("page_view", 10 * DAY + HOUR, {}, undefined, "a"), event("app_feature", 11 * DAY, {}, undefined, "a"),
      event("app_error", 12 * DAY, {}, undefined, "a"), event("site_view", 13 * DAY, {}, { visitor: "v" }, "a"), event("app_open", 14 * DAY)]);
    expect(days).toEqual(new Map([["a", new Set([10, 11])]]));
  });

  it.each([["d1", 1, 2], ["d7", 7, 14], ["d30", 30, 60]] as const)("uses the exact %s return window and excludes windows not due", (key, low, high) => {
    const signup = 10 * DAY + HOUR, window = RETURN_WINDOWS[key];
    expect(window).toEqual([low, high]);
    expect(returned(signup, undefined, window)).toBe(false);
    expect(returned(signup, new Set([10 + low - 1, 10 + high]), window)).toBe(false);
    expect(returned(signup, new Set([10 + low]), window)).toBe(true);
    expect(returned(signup, new Set([10 + high - 1]), window)).toBe(true);
    expect(due(signup, window, signup + low * DAY - 1)).toBe(false);
    expect(due(signup, window, signup + low * DAY)).toBe(true);
  });

  it("returns Monday cohorts, eligible denominators and null rates for windows not yet due", () => {
    const monday = Date.parse("2026-09-07T00:00:00Z"), baseDay = monday / DAY, now = monday + 5 * 7 * DAY + 2 * DAY + HOUR;
    const signups = new Map([["a", monday + HOUR], ["b", monday + 2 * HOUR], ["new", now - HOUR / 2]]);
    const days = new Map([["a", new Set([baseDay + 1, baseDay + 7, baseDay + 30])], ["b", new Set([baseDay + 13, baseDay + 31])]]);
    const cohorts = retention(signups, days, now, 6);
    expect(cohorts).toHaveLength(6);
    expect(cohorts[0]).toMatchObject({ start: monday, size: 2, d1: { n: 1, of: 2 }, d7: { n: 2, of: 2 }, d30: { n: 2, of: 2 } });
    expect(cohorts[1]).toMatchObject({ size: 0, d1: null, d7: null, d30: null });
    expect(cohorts[5]).toMatchObject({ start: monday + 35 * DAY, size: 1, d1: null, d7: null, d30: null });
  });

  it("includes all elapsed weekly activity columns for older cohorts and only elapsed columns for new ones", () => {
    const monday = Date.parse("2026-09-07T00:00:00Z"), day = monday / DAY;
    const cohorts = retention(new Map([["a", monday], ["new", monday + 35 * DAY]]), new Map([["a", new Set([day, day + 7, day + 30])]]), monday + 37 * DAY, 6);
    expect(cohorts.map(cohort => cohort.weekly)).toEqual([[1, 1, 0, 0, 1, 0], [null, null, null, null, null], [null, null, null, null], [null, null, null], [null, null], [0]]);
  });

  it("leaves a not-yet-due signup out of an otherwise eligible cohort's denominator", () => {
    const monday = Date.parse("2026-09-07T00:00:00Z"), now = monday + DAY + 2 * HOUR;
    const [cohort] = retention(new Map([["due", monday + HOUR], ["young", now - HOUR]]), new Map([["due", new Set([monday / DAY + 1])]]), now, 1);
    expect(cohort).toMatchObject({ size: 2, d1: { n: 1, of: 1 }, d7: null, d30: null });
  });
});

function funnelFixture(): FunnelInput & { events: StoredEvent[] } {
  const events = [site("a1", "a1", FROM, "/", { source: "ChatGPT", channel: "ai" }), site("b1", "b1", FROM, "/pricing", { channel: "search" }), link("a1", "a"), link("b1", "b")];
  for (const [i, step] of ["name", "plan", "app"].entries()) events.push(event("onboarding_step", FROM + (i + 2) * 1000, { step }, undefined, "a"));
  events.push(event("onboarding_done", FROM + 5000, {}, undefined, "a"), event("onboarding_step", FROM + 3000, { step: "plan" }, undefined, "b"));
  for (const day of [1, 7, 30]) events.push(event("app_open", FROM + day * DAY, {}, undefined, "a"));
  for (const [i, scroll] of [10, 25, 50, 100].entries()) {
    const visitor = `anon${i}`;
    events.push(site(visitor, visitor, FROM, "/stop", { channel: "ai", pv: visitor }), event("site_goal", FROM + 1, { goal: "cta_click" }, { visitor, session: visitor, pv: visitor }),
      event("site_leave", FROM + 2, { scroll, ms: 10 }, { visitor, session: visitor, pv: visitor }));
  }
  events.push(site("out", "out", FROM - 1));
  return { from: FROM, to: FROM + HOUR, now: FROM + 61 * DAY, mode: "visitors", events, visits: visitsOf(events), identity: identityOf(events),
    people: { signups: new Map([["a", FROM + 1000], ["b", FROM + 3000], ["old", FROM - 1]]), paid: new Map([["a", FROM + 7000]]) },
    cloudChosen: new Map([["a", FROM + 6000]]), paired: new Map([["a", FROM + 8000]]), replied: new Map([["a", FROM + 9000]]) };
}

describe("funnel", () => {
  it("counts visitor steps with required predecessors, median gaps, dropoff details and channel counts", () => {
    const result = funnel(funnelFixture());
    expect(result.mode).toBe("visitors");
    expect(result.steps.map(step => [step.id, step.count])).toEqual([["visit", 6], ["signup", 2], ["onboarding_name", 1], ["onboarding_plan", 1], ["onboarding_app", 1], ["onboarded", 1], ["cloud", 1], ["paid", 1], ["paired", 1], ["replied", 1], ["d1", 1], ["d7", 1], ["d30", 1]]);
    expect(result.steps.slice(0, 10).map(step => step.medianMs)).toEqual([null, 2000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000]);
    expect(result.dropoff.visit).toEqual({ count: 4, lastPages: [{ key: "/stop", count: 4 }], lastEvents: [{ key: "cta_click", count: 4 }], scroll: [1, 1, 1, 1] });
    expect(result.dropoff.signup).toMatchObject({ count: 1, lastPages: [{ key: "/pricing", count: 1 }], scroll: [0, 0, 0, 0] });
    expect(result.bySource).toEqual([{ channel: "ai", counts: [5, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1] }, { channel: "search", counts: [1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }]);
  });

  it("starts signup mode at account creation, counts accounts once and retains the last account event for dropoffs", () => {
    const input = funnelFixture();
    input.events = [...input.events, link("a2", "a"), site("a2", "a2", FROM + 1), event("page_view", FROM + 4000, { path: "/onboarding" }, undefined, "b")];
    input.visits = visitsOf(input.events); input.identity = identityOf(input.events);
    const result = funnel({ ...input, mode: "signups" });
    expect(result.steps.map(step => step.count)).toEqual([2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(result.steps[0]).toMatchObject({ id: "signup", medianMs: null });
    expect(result.dropoff.signup).toEqual({ count: 1, lastPages: [{ key: "/onboarding", count: 1 }], lastEvents: [{ key: "page_view", count: 1 }], scroll: [0, 0, 0, 0] });
    expect(result.bySource.map(row => row.counts[0])).toEqual([1, 1]);
  });

  it("counts an account that set up in the desktop app as onboarded, so it can still reach the cloud and paid steps", () => {
    const input = funnelFixture();
    input.cloudChosen = new Map([...input.cloudChosen, ["b", FROM + 9000]]);
    input.paired = new Map([...input.paired, ["b", FROM + 4000]]);
    const result = funnel({ ...input, mode: "signups" });
    expect(result.steps.slice(0, 7).map(step => [step.id, step.count])).toEqual([["signup", 2], ["onboarding_name", 2], ["onboarding_plan", 2], ["onboarding_app", 2], ["onboarded", 2], ["cloud", 2], ["paid", 1]]);
  });

  it("allows a waitlist join to reach the visitor signup step without an account", () => {
    const input = funnelFixture();
    const events = [site("wait", "wait", FROM), event("site_goal", FROM + 500, { goal: "waitlist_join" }, { visitor: "wait", session: "wait", pv: "wait:/" })];
    const result = funnel({ ...input, events, visits: visitsOf(events), identity: identityOf([]), people: emptyPeople() });
    expect(result.steps.slice(0, 3).map(step => [step.count, step.medianMs])).toEqual([[1, null], [1, 500], [0, null]]);
  });

  it("counts a step reached before the one above it, but leaves it out of that step's median", () => {
    const input = funnelFixture();
    const base = funnel(input);
    input.events = input.events.map(item => item.accountId === "a" && item.name === "onboarding_step" && item.props.step === "name" ? { ...item, at: FROM + 500 } : item);
    const result = funnel(input);
    expect(result.steps[2]!.count).toBe(base.steps[2]!.count);
    expect(result.bySource.find(row => row.channel === "ai")!.counts[2]).toBe(base.bySource.find(row => row.channel === "ai")!.counts[2]);
    expect(result.steps[2]!.medianMs === null || result.steps[2]!.medianMs >= 0).toBe(true);
  });
});
