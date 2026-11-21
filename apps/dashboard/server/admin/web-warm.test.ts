import { describe, expect, it } from "vitest";
import { memorySink, type StoredEvent } from "../analytics/sink.ts";
import { createRollups, memoryRollupStore } from "../analytics/rollup.ts";
import { DIGESTS } from "../analytics/digests.ts";
import { DAY, HOUR } from "../analytics/web.ts";
import { createAnalyticsRoutes, type AnalyticsRoutesOptions } from "./analytics-routes.ts";
import { createReadCache } from "./read-cache.ts";
import { WARM_RANGES, WARM_SURFACES, createWebWarmer, memoryWarmStore, rangeFrom, viewerOf, type WarmStore, type WarmViewer } from "./web-warm.ts";

// a reader in India (UTC+5:30), one in UTC, one in New York (UTC-5) and one in Nepal (UTC+5:45)
const ZONES = [-330, 0, 300, -345];
const END = Date.parse("2026-11-20T10:17:23.456Z");
const START = END - 200 * DAY;
let clock = END;

function fixture(): { events: StoredEvent[]; accounts: Array<{ id: string; email: string; name: null; createdAt: number }> } {
  let seed = 3;
  const rand = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
  const pick = <T,>(list: readonly T[]) => list[Math.floor(rand() * list.length)]!;
  const events: StoredEvent[] = [], accounts: Array<{ id: string; email: string; name: null; createdAt: number }> = [];
  let n = 0;
  const add = (name: string, at: number, accountId: string | null, props: object, ctx: object = {}) => events.push({ id: `ev_${++n}`, name, at: Math.floor(at), accountId, props: props as StoredEvent["props"], ctx: ctx as StoredEvent["ctx"] });
  const visitors = Array.from({ length: 400 }, (_, i) => `v${String(i).padStart(21, "0")}`);
  // every few visits starts a minute or two before a reader's midnight and runs past it
  const midnights = ZONES.map(tz => tz * 60_000);
  for (let i = 0; i < 2500; i++) {
    const visitor = pick(visitors);
    let at = START + rand() * (END - START - 10 * 60_000);
    if (i % 7 === 0) at = Math.floor(at / DAY) * DAY + pick(midnights) + DAY - 90_000;
    if (at >= END - 60_000) continue;
    const session = `${visitor}-s${i}`, base = { visitor, session, source: pick(["google", "ChatGPT", "x.com", "direct"]), channel: pick(["search", "ai", "social", "direct"]), country: pick(["DE", "IN", "US"]),
      device: pick(["desktop", "mobile"]), os: "mac", browser: "safari", host: "madani.bot", ...(rand() < 0.3 ? { utm: { campaign: "launch", term: "AI Bot" } } : {}) };
    for (let p = 0; p < 1 + Math.floor(rand() * 3); p++) {
      const pv = `${session}-pv${p}`, path = pick(["/", "/pricing", "/download", "/blog/a"]);
      add("site_view", at, null, { path }, { ...base, pv, page: path });
      if (rand() < 0.4) add("site_goal", at + 3000, null, { goal: pick(["cta_click", "waitlist_join", "download_click"]) }, { ...base, pv, page: path });
      add("site_leave", at + 4000 + rand() * 60_000, null, { path, scroll: Math.floor(rand() * 100), ms: Math.floor(rand() * 90_000) }, { ...base, pv, page: path });
      at += 30_000 + rand() * 60_000;
    }
    if (rand() < 0.08) {
      const id = `acct_${accounts.length + 1}`;
      accounts.push({ id, email: `${id}@example.com`, name: null, createdAt: Math.floor(at) });
      add("identify", at, id, { via: "page" }, { visitor });
      add("page_view", at + 1000, id, { path: "/onboarding" }, { visitor, session: `${session}-acct`, page: "/onboarding" });
      const install = `inst${accounts.length}`, platform = rand() < 0.3 ? "ios" : "darwin", ctx = { install, app: { platform, version: "0.3.0" } };
      add("identify", at + 2000, id, { via: "app" }, { install });
      for (let k = 0; k < 3; k++) {
        const t = at + k * 5 * HOUR + 3000;
        if (t >= END - 60_000) break;
        add("app_open", t, rand() < 0.8 ? id : null, { kind: platform === "ios" ? "mobile" : "desktop" }, ctx);
        add("app_screen", t + 1000, id, { screen: pick(["/chat", "/bots"]) }, ctx);
        add("app_close", t + 2000, id, { ms: Math.floor(rand() * 600_000) }, ctx);
      }
    }
  }
  // the last five minutes: who is online
  add("site_view", END - 120_000, null, { path: "/" }, { visitor: "online-visitor-xxxxxxxx", session: "online-s", pv: "online-pv" });
  add("app_open", END - 60_000, null, { kind: "desktop" }, { install: "online-install", app: { platform: "darwin", version: "0.3.0" } });
  events.sort((a, b) => a.at - b.at);
  for (let i = 1; i < events.length; i++) if (events[i]!.at <= events[i - 1]!.at) events[i]!.at = events[i - 1]!.at + 1;
  return { events, accounts };
}

async function setup() {
  const { events, accounts } = fixture();
  const sink = memorySink(() => clock);
  for (const event of events) await sink.insert(event);
  const rollups = createRollups({ store: memoryRollupStore(), digests: DIGESTS, now: () => clock });
  const presence = [{ key: "present-only-visitor", at: END, page: "/", owner: false }];
  const state = { customers: [], checkouts: [], subscriptions: [], invoices: [], ledger: [], refunds: [], licenses: [], credits: [], retention: [], webhookEvents: [] };
  const routes = createAnalyticsRoutes({ auth: { directory: () => ({ accounts, identities: [], sessions: [] }) }, billing: { store: { state }, operator: { provider: "none" }, service: { setAttribution() {} } },
    analytics: { sink, presence: { list: () => presence }, rollups }, workspaces: () => [], now: () => clock, actor: () => null } as unknown as AnalyticsRoutesOptions);
  return { sink, routes };
}
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;
const keyOf = (viewer: WarmViewer, url: URL) => `${url.searchParams.get("from")}|${url.searchParams.get("surface")}|${viewer.tz}|${viewer.data}`;
const viewer = (tz: number): WarmViewer => ({ tz, data: "", tests: "", money: "" });
function warmerWith(routes: Awaited<ReturnType<typeof setup>>["routes"], store: WarmStore, computed: string[] = []) {
  const reads = createReadCache({ now: () => clock });
  const warmer = createWebWarmer({ store, reads, now: () => clock, keyOf, everyMs: 10 * 60_000, keepMs: 12 * HOUR,
    answer: (_viewer, urls) => { computed.push(...urls.map(url => url.search)); return routes.webMany(urls); } });
  return { reads, warmer };
}

describe("warmed /web answers", () => {
  it("knows the panel's own ranges in every time zone, also around the reader's midnight", () => {
    expect(rangeFrom(END, -330, 1)).toBe(Date.parse("2026-11-19T18:30:00Z"));
    expect(rangeFrom(END, -330, 7)).toBe(Date.parse("2026-11-13T18:30:00Z"));
    expect(rangeFrom(END, 300, 90)).toBe(Date.parse("2026-11-20T05:00:00Z") - 89 * DAY);
    expect(rangeFrom(END, -345, 1)).toBe(Date.parse("2026-11-19T18:15:00Z"));
    const ist = Date.parse("2026-11-20T18:30:00Z");
    expect(rangeFrom(ist, -330, 1)).toBe(ist);
    expect(rangeFrom(ist - 1, -330, 1)).toBe(ist - DAY);
    const switches = { data: "", tests: "", money: "" };
    const ask = (query: string, at = END) => viewerOf(new URL(`http://x/v1/admin/web?${query}`), switches, at);
    expect(ask(`from=${rangeFrom(END, -330, 30)}&to=${END - 1000}&surface=all&tz=-330`)).toEqual({ tz: -330, ...switches });
    // asked just before midnight, answered just after
    expect(ask(`from=${ist - DAY}&to=${ist - 2000}&surface=site&tz=-330`, ist + 3000)).toEqual({ tz: -330, ...switches });
    expect(ask(`from=${rangeFrom(END, -330, 30) + 60_000}&to=${END}&tz=-330`)).toBeNull();
    expect(ask(`from=${rangeFrom(END, -330, 14)}&to=${END}&tz=-330`)).toBeNull();
    expect(ask(`from=${rangeFrom(END, -330, 7)}&to=${END - DAY}&tz=-330`)).toBeNull();
    expect(ask(`from=${rangeFrom(END, -330, 7)}&to=${END}&tz=-330&f.channel=ai`)).toBeNull();
    expect(viewerOf(new URL(`http://x/v1/admin/web?from=${rangeFrom(END, 0, 7)}&to=${END}`), { ...switches, money: "made-up" }, END)).toBeNull();
  });

  it("answers exactly what /web computes, for every range, surface and time zone, with who is online now", async () => {
    const { sink, routes } = await setup();
    for (const at of [END, Date.parse("2026-11-20T18:30:40Z"), Date.parse("2026-11-21T00:00:30Z"), Date.parse("2026-11-21T05:00:20Z")]) {
      clock = at;
      const store = memoryWarmStore(), { reads, warmer } = warmerWith(routes, store);
      for (const tz of ZONES) warmer.note(new URL(`http://x/v1/admin/web?from=${rangeFrom(clock, tz, 30)}&to=${clock}&surface=all&tz=${tz}`), viewer(tz));
      await warmer.run();
      warmer.stop();
      for (const tz of ZONES) for (const days of WARM_RANGES) for (const surface of WARM_SURFACES) {
        const url = new URL(`http://x/v1/admin/web?from=${rangeFrom(clock, tz, days)}&to=${clock}&surface=${surface}&tz=${tz}`);
        const key = keyOf(viewer(tz), url);
        expect(reads.keptAt(key), key).toBe(clock);
        const kept = await reads.get(key, 30_000, () => Promise.reject(new Error("not warmed")));
        expect(json(kept), `${new Date(clock).toISOString()} ${key}`).toEqual(json(await routes.web(url)));
      }
      expect(store.saved.size).toBe(ZONES.length * WARM_RANGES.length * WARM_SURFACES.length);
    }

    clock = END;
    const url = new URL(`http://x/v1/admin/web?from=${rangeFrom(END, -330, 1)}&to=${END}&surface=all&tz=-330`);
    const warmed = await routes.web(url);
    expect(warmed.online).toEqual({ site: 2, app: 1 });
    // someone arrives after the answer was kept: the live count is read at once, the same as a full read
    clock = END + 30_000;
    await sink.insert({ id: "late-online", name: "site_view", at: clock - 1000, accountId: null, props: { path: "/" }, ctx: { visitor: "another-visitor-xxxxxxx", session: "another-s", pv: "another-pv" } });
    expect(await routes.onlineNow()).toEqual({ site: 3, app: 1 });
    expect((await routes.web(url)).online).toEqual(await routes.onlineNow());
  }, 120_000);

  it("starts from the saved answers after a restart and computes only what is out of date", async () => {
    clock = END;
    const { routes } = await setup();
    const store = memoryWarmStore(), first = warmerWith(routes, store);
    first.warmer.note(new URL(`http://x/v1/admin/web?from=${rangeFrom(END, -330, 1)}&to=${END}&tz=-330`), viewer(-330));
    await first.warmer.run();
    first.warmer.stop();

    const computed: string[] = [], second = warmerWith(routes, store, computed);
    await second.warmer.start(60 * 60_000);
    const url = new URL(`http://x/v1/admin/web?from=${rangeFrom(END, -330, 90)}&to=${END}&surface=phone&tz=-330`);
    const kept = await second.reads.get(keyOf(viewer(-330), url), 30_000, () => Promise.reject(new Error("computed again")));
    expect(kept).toEqual(json(await routes.web(url)));
    await second.warmer.run();
    expect(computed).toEqual([]);
    // eleven minutes on, every range is computed again; the viewer came back from the store
    clock = END + 11 * 60_000;
    await second.warmer.run();
    second.warmer.stop();
    expect(computed.length).toBe(WARM_RANGES.length * WARM_SURFACES.length);
    // a change the panel made: nothing computed before it is kept
    const generation = second.reads.generation;
    second.reads.clear();
    second.reads.put("k", 1, clock, generation);
    expect(second.reads.keptAt("k")).toBeNull();
  }, 120_000);
});
