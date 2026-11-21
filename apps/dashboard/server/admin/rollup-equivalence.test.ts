import { describe, expect, it } from "vitest";
import { memorySink, type AnalyticsSink, type StoredEvent } from "../analytics/sink.ts";
import { createRollups, memoryRollupStore, segmentsOf } from "../analytics/rollup.ts";
import { DIGESTS } from "../analytics/digests.ts";
import { DAY, HOUR, identityOf, visitsOf } from "../analytics/web.ts";
import { createAnalyticsRoutes, type AnalyticsRoutesOptions } from "./analytics-routes.ts";
import { isTestEvent } from "./test-accounts.ts";

// one fixture read two ways: every view from raw events (no rollups) and from digests of closed hours and days, which must
// answer the same, also after late events, a forgotten account, a new hidden test account and time moving on
const START = Date.parse("2026-11-08T00:00:00Z");
let clock = Date.parse("2026-11-20T10:17:23.456Z");

function fixture(): StoredEvent[] {
  let seed = 7;
  const rand = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
  const pick = <T,>(list: readonly T[]) => list[Math.floor(rand() * list.length)]!;
  const out: StoredEvent[] = [];
  let n = 0;
  const add = (name: string, at: number, accountId: string | null, props: object, ctx: object = {}) => out.push({ id: `ev_${++n}`, name, at: Math.floor(at), accountId, props: props as StoredEvent["props"], ctx: ctx as StoredEvent["ctx"] });
  const accounts = Array.from({ length: 8 }, (_, i) => `acct_${i + 1}`);
  // site visitors: sessions of a few pages minutes apart, some running over an hour or midnight
  for (let v = 0; v < 70; v++) {
    const visitor = `v${String(v).padStart(21, "0")}`, account = v < 16 ? accounts[v % 8]! : null;
    const source = pick(["google", "ChatGPT", "x.com", "direct"]), channel = pick(["search", "ai", "social", "direct"]);
    for (let s = 0; s < 1 + Math.floor(rand() * 3); s++) {
      let at = START + rand() * 12.4 * DAY;
      if (v % 9 === 0) at = Math.floor(at / DAY) * DAY + DAY - 4 * 60_000;
      const session = `${visitor}-s${s}`, base = { visitor, session, source, channel, country: pick(["DE", "IN", "US"]), device: pick(["desktop", "mobile"]), os: "mac", browser: "safari",
        ...(rand() < 0.3 ? { utm: { campaign: "launch", term: "AI Bot" } } : {}), host: "madani.bot" };
      for (let p = 0; p < 1 + Math.floor(rand() * 4); p++) {
        const pv = `${session}-pv${p}`, path = pick(["/", "/pricing", "/download", "/blog/a"]);
        if (p === 0 && rand() < 0.2) add("site_leave", at - 1000, null, { path, scroll: 5, ms: 100 }, { ...base, pv });
        add("site_view", at, null, { path }, { ...base, pv, page: path });
        add("site_section", at + 2000, null, { path, section: pick(["hero", "faq", "price"]), ms: Math.floor(rand() * 9000) }, { ...base, pv, page: path });
        if (rand() < 0.5) add("site_goal", at + 3000, null, { goal: pick(["cta_click", "waitlist_join", "rage_click", "download_click", "form_start", "form_abandon", "js_error"]), label: pick(["get_started", "logo"]), section: "hero", value: "macos" }, { ...base, pv, page: path });
        add("site_leave", at + 4000 + rand() * 60_000, null, { path, scroll: Math.floor(rand() * 100), ms: Math.floor(rand() * 90_000) }, { ...base, pv, page: path });
        at += 60_000 + rand() * 25 * 60_000;
      }
      if (account && s === 0) {
        add("identify", at, account, { via: "page" }, { visitor });
        for (let p = 0; p < 3; p++) add("page_view", at + p * 400_000, account, { path: pick(["/", "/onboarding", "/billing"]) }, { visitor, session: `${session}-acct`, page: "/" });
        add("page_action", at + 100, account, { action: pick(["choose", "download", "upsell_shown", "upsell_click"]), label: pick(["plan", "cloud_banner"]), value: "pro", path: "/" }, { visitor });
        for (const step of ["name", "plan", "app"]) if (rand() < 0.8) add("onboarding_step", at + 500 + rand() * 5000, account, { step, ms: Math.floor(rand() * 20_000) }, { page: "/onboarding" });
        if (rand() < 0.5) add("onboarding_done", at + 9000, account, { ms: 1 });
        add("plan_chosen", at + 9500, account, { plan: pick(["free", "pro"]) });
        if (rand() < 0.4) add("billing", at + 9900, account, { type: "checkout.started" });
      }
    }
  }
  // a cookieless visitor's daily id changes at midnight while its session goes on
  for (const [i, day] of [[0, 3], [1, 9]] as const) {
    const midnight = START + day * DAY, session = `rotating-${i}`;
    add("site_view", midnight - 60_000, null, { path: "/" }, { visitor: `r${i}-day1`.padEnd(22, "x"), session, pv: `${session}-1` });
    add("site_view", midnight + 60_000, null, { path: "/pricing" }, { visitor: `r${i}-day2`.padEnd(22, "x"), session, pv: `${session}-2` });
  }
  // apps: installs that open, use features, send messages and close, some signed in, one a harness install, one a dev build
  for (let i = 0; i < 14; i++) {
    const install = i === 0 ? "qatest-install" : `inst${i}`, account = i < 9 ? accounts[i % 8]! : null, platform = i % 4 === 0 ? "ios" : "darwin", version = i === 1 ? "0.0.0" : pick(["0.2.14", "0.2.15"]);
    if (account && i % 3 === 0) add("identify", START + i * 1000, account, { via: "app" }, { install });
    for (let d = 0; d < 6; d++) {
      let at = START + rand() * 12.4 * DAY;
      const ctx = { install, app: { platform, version } }, who = rand() < 0.7 ? account : null;
      add("app_open", at, who, { kind: platform === "ios" ? "mobile" : "desktop" }, ctx);
      for (let k = 0; k < 5; k++) {
        at += rand() * 30 * 60_000;
        const kind = pick(["screen", "feature", "messages", "action", "error"]);
        if (kind === "screen") add("app_screen", at, who, { screen: pick(["/chat", "/bots", "/settings"]) }, ctx);
        if (kind === "feature") add("app_feature", at, who, { feature: pick(["bot_created", "bot_deleted", "chat_opened", "voice_used"]) }, ctx);
        if (kind === "messages") add("app_messages", at, who, { sent: Math.floor(rand() * 5), replies: Math.floor(rand() * 4), latencyMs: Math.floor(rand() * 3) * 500 }, ctx);
        if (kind === "action") add("app_action", at, who, pick([{ name: "send" }, { name: "reply_reaction", emoji: pick(["yes", "no"]) }, { name: "onboarding_step", step: "welcome", path: "mac", ms: 300 },
          { name: "upsell_shown", source: "cloud_banner" }, { name: "upsell_dismiss", source: "cloud_banner" }]), ctx);
        if (kind === "error") add("app_error", at, who, { kind: "net", code: pick(["timeout", "dns"]) }, ctx);
      }
      if (rand() < 0.3) add("app_feedback", at + 1000, who, { score: 1 + Math.floor(rand() * 5), moment: pick(["reply", "setup"]) }, ctx);
      add("app_close", at + 2000, who, { ms: Math.floor(rand() * 600_000) }, ctx);
    }
    if (account) { add("app_paired", START + rand() * 12 * DAY, account, { via: "app" }); add("first_bot_reply", START + rand() * 12 * DAY, account, {}); }
  }
  out.sort((a, b) => a.at - b.at);
  // distinct times: views that pick "the first" or "the last" of equal times may differ between two correct readings
  for (let i = 1; i < out.length; i++) if (out[i]!.at <= out[i - 1]!.at) out[i]!.at = out[i - 1]!.at + 1;
  return out;
}

function routes(sink: AnalyticsSink, rollups: ReturnType<typeof createRollups> | null) {
  const accounts = Array.from({ length: 8 }, (_, i) => ({ id: `acct_${i + 1}`, email: `p${i + 1}@example.com`, name: null, createdAt: START + i * DAY + 3 * HOUR }));
  const state = { customers: [], checkouts: [], subscriptions: [], invoices: [], ledger: [], refunds: [], licenses: [], credits: [], retention: [], webhookEvents: [] };
  return createAnalyticsRoutes({ auth: { directory: () => ({ accounts, identities: [], sessions: [] }) }, billing: { store: { state }, operator: { provider: "none" }, service: { setAttribution() {} } },
    analytics: { sink, presence: { list: () => [] }, ...(rollups ? { rollups } : {}) }, workspaces: () => [], now: () => clock, actor: () => null } as unknown as AnalyticsRoutesOptions);
}

/** the test-account view's sink (admin/index.ts): the hidden accounts' and harness installs' events dropped */
function clean(sink: AnalyticsSink, hidden: () => Set<string>): AnalyticsSink {
  return { ...sink, scan: async (since, until, names) => (await sink.scan(since, until, names)).filter(event => !isTestEvent(event, hidden())),
    person: async query => (await sink.person(query)).filter(event => !isTestEvent(event, hidden())),
    rollupScope: () => { const ids = hidden(); return { key: `${sink.rollupScope!()!.key}~clean`, sink, hidden: ids, drops: event => isTestEvent(event, ids) }; } };
}

const IST = Date.parse("2026-11-19T18:30:00Z"), UTC = Date.parse("2026-11-20T00:00:00Z");
async function answers(r: ReturnType<typeof routes>) {
  const out: Record<string, unknown> = {};
  for (const [label, from, to] of [["ist 1d", IST, clock], ["utc 7d", UTC - 6 * DAY, clock], ["ist 30d", IST - 29 * DAY, clock], ["past", IST - 5 * DAY, IST - 2 * DAY + 7 * HOUR + 5]] as const) {
    const q = `from=${from}&to=${to}`;
    out[`web ${label}`] = await r.web(new URL(`http://x/?${q}&tz=-330`));
    out[`web all ${label}`] = await r.web(new URL(`http://x/?${q}&surface=all&f.channel=ai`));
    out[`web phone ${label}`] = await r.web(new URL(`http://x/?${q}&surface=phone`));
    out[`details ${label}`] = await r.webDetails("page", new URL(`http://x/?${q}&surface=all`));
    out[`funnel ${label}`] = await r.funnel(new URL(`http://x/?${q}`));
    out[`funnel signups ${label}`] = await r.funnel(new URL(`http://x/?${q}&mode=signups`));
    out[`journeys ${label}`] = await r.journeys(new URL(`http://x/?${q}`));
    out[`app ${label}`] = await r.app(new URL(`http://x/?${q}`));
    out[`product ${label}`] = await r.product(new URL(`http://x/?${q}`));
  }
  out["app off a quarter hour"] = await r.app(new URL(`http://x/?from=${IST - 3 * DAY + 7 * 60_000}&to=${clock}`));
  out.retention = await r.retention();
  out.revenue = await r.revenue(new URL("http://x/?days=30"));
  return JSON.parse(JSON.stringify(out, (_, value) => value instanceof Map ? [...value] : value instanceof Set ? [...value] : value)) as Record<string, unknown>;
}
async function same(raw: ReturnType<typeof routes>, rolled: ReturnType<typeof routes>) {
  const [a, b] = [await answers(raw), await answers(rolled)];
  for (const key of Object.keys(a)) expect(b[key], key).toEqual(a[key]);
}

describe("admin analytics rollups", () => {
  it("cuts a window into raw edges and closed hours and days", () => {
    const now = Date.parse("2026-11-20T10:17:00Z");
    expect(segmentsOf(IST, now + 60_000, now)).toEqual([{ raw: [IST, IST + 30 * 60_000] }, ...[19, 20, 21, 22, 23].map(h => ({ slot: `h:2026-11-19T${h}` })),
      ...Array.from({ length: 10 }, (_, h) => ({ slot: `h:2026-11-20T${String(h).padStart(2, "0")}` })), { raw: [Date.parse("2026-11-20T10:00:00Z"), now + 60_000] }]);
    expect(segmentsOf(IST - 2 * DAY, IST, now).filter(item => "slot" in item && item.slot.startsWith("d:"))).toEqual([{ slot: "d:2026-11-18" }]);
  });

  it("answers every view the same from digests as from raw events", async () => {
    clock = Date.parse("2026-11-20T10:17:23.456Z");
    const sink = memorySink(() => clock);
    for (const event of fixture()) await sink.insert(event);
    const store = memoryRollupStore(), rollups = createRollups({ store, digests: DIGESTS, now: () => clock });
    const raw = routes(sink, null), rolled = routes(sink, rollups);
    await same(raw, rolled);
    expect([...store.docs.keys()].some(key => key.includes("|visits|d:2026-11-15"))).toBe(true);
    // again, from what was stored
    await same(raw, rolled);

    // the revenue funnel's "visited" counted the way it always was: people first seen on a site visit (visitsOf) in the window
    const history = await sink.scan(clock - 400 * DAY, clock + 60_000, ["site_view", "page_view", "identify"]), identity = identityOf(history.filter(event => event.name === "identify"));
    const first = new Map<string, number>();
    for (const visit of visitsOf(history)) { const who = identity.accountOf.get(visit.visitor) ?? visit.visitor; if (!first.has(who) || first.get(who)! > visit.start) first.set(who, visit.start); }
    for (let i = 0; i < 8; i++) { const id = `acct_${i + 1}`, at = START + i * DAY + 3 * HOUR; if (!first.has(id) || first.get(id)! > at) first.set(id, at); }
    const visited = [...first.values()].filter(at => at >= clock - 30 * DAY && at < clock).length;
    expect((await rolled.revenue(new URL("http://x/?days=30"))).funnel.steps[0]!.count).toBe(visited);

    // an app's queued events land in closed hours; a site session gets a late page
    await sink.insert({ id: "late1", name: "app_messages", at: Date.parse("2026-11-18T07:12:00Z"), accountId: "acct_2", props: { sent: 9, replies: 9, latencyMs: 700 }, ctx: { install: "inst2", app: { platform: "darwin", version: "0.2.15" } } });
    await sink.insert({ id: "late2", name: "site_view", at: Date.parse("2026-11-20T08:59:59Z"), accountId: null, props: { path: "/late" }, ctx: { visitor: "v000000000000000000003", session: "v000000000000000000003-s0", pv: "late" } });
    await sink.insert({ id: "late3", name: "onboarding_step", at: Date.parse("2026-11-12T03:00:00Z"), accountId: "acct_5", props: { step: "name", ms: 1 } });
    await same(raw, rolled);
    // a day with one late hour is rebuilt once, then read as stored
    const write = store.write.bind(store), written: string[] = [];
    store.write = async docs => { written.push(...docs.map(doc => doc.slot)); return write(docs); };
    await same(raw, rolled);
    expect(written).toEqual([]);
    store.write = write;

    // an account removes its events
    await sink.forget("acct_3");
    await same(raw, rolled);

    // time moves on: the open hour closes, a new day starts
    clock += 15 * HOUR;
    await same(raw, rolled);
    await rollups.settle();
  }, 60_000);

  it("keeps the test-account view exact while the hidden accounts change", async () => {
    clock = Date.parse("2026-11-20T10:17:23.456Z");
    const sink = memorySink(() => clock);
    for (const event of fixture()) await sink.insert(event);
    let hidden = new Set(["acct_4"]);
    const view = clean(sink, () => hidden);
    const rollups = createRollups({ store: memoryRollupStore(), digests: DIGESTS, now: () => clock });
    const raw = routes(view, null), rolled = routes(view, rollups), all = routes(sink, rollups);
    await same(raw, rolled);
    // the unfiltered view's digests are kept apart
    await same(routes(sink, null), all);
    hidden = new Set(["acct_4", "acct_6"]);
    await same(raw, rolled);
    hidden = new Set();
    await same(raw, rolled);
  }, 60_000);

  it("builds every closed day in the background, and checks recent ones against the raw events", async () => {
    clock = Date.parse("2026-11-20T10:17:23.456Z");
    const sink = memorySink(() => clock);
    for (const event of fixture()) await sink.insert(event);
    const store = memoryRollupStore(), rollups = createRollups({ store, digests: DIGESTS, now: () => clock });
    rollups.watch(() => sink.rollupScope!());
    await rollups.backfill();
    const days = new Set([...store.docs.values()].filter(doc => doc.slot.startsWith("d:")).map(doc => doc.slot));
    expect([...days].sort()).toEqual(Array.from({ length: 12 }, (_, i) => `d:${new Date(START + i * DAY).toISOString().slice(0, 10)}`));
    // an event written behind the rollups' back (another process) is found by the count check
    const before = new Map([...store.docs].map(([key, doc]) => [key, doc.builtAt]));
    (sink as unknown as { all: StoredEvent[] }).all.push({ id: "sneaky", name: "app_open", at: Date.parse("2026-11-17T05:00:00Z"), accountId: null, props: {}, ctx: { install: "inst5" } });
    await rollups.backfill();
    const rebuilt = [...store.docs].filter(([key, doc]) => before.get(key) !== doc.builtAt).map(([key]) => key);
    expect(rebuilt.some(key => key.endsWith("|d:2026-11-17"))).toBe(true);
    expect(rebuilt.some(key => key.endsWith("|d:2026-11-10"))).toBe(false);
  }, 60_000);
});
