import { describe, expect, it } from "vitest";
import type { StoredEvent } from "./sink.ts";
import type { EventContext } from "./context.ts";
import type { Props } from "./events.ts";
import { visitsOf } from "./web.ts";
import { billingSteps, firstSourceOf, SESSION_GAP_MS, sessionsOf, spendOf, stepOf, timeToPayOf, UPSELL_PAIR_MS, whereOf } from "./profile.ts";

const T = Date.parse("2026-11-12T17:58:00Z"), MIN = 60_000, DAY = 86_400_000;
let n = 0;
const ev = (name: string, at: number, props: Props = {}, ctx?: EventContext, accountId: string | null = null): StoredEvent => ({ id: `ev_${n++}`, name, at, accountId, props, ...(ctx ? { ctx } : {}) });
const site = (session: string, extra: EventContext = {}): EventContext => ({ visitor: "v1", session, host: "madani.bot", ...extra });

describe("person profile", () => {
  it("maps each event kind to a readable step and hides bookkeeping", () => {
    const cases: Array<[StoredEvent, Partial<ReturnType<typeof stepOf>> | null]> = [
      [ev("site_view", T, { path: "/pricing" }, site("s")), { kind: "view", surface: "site", path: "/pricing" }],
      [ev("page_view", T, { path: "/billing" }), { kind: "view", surface: "account", path: "/dashboard/billing" }],
      [ev("page_view", T, { path: "/" }), { path: "/dashboard" }],
      [ev("site_goal", T, { goal: "download_click", to: "/download", value: "mac" }, site("s", { page: "/" })), { kind: "goal", name: "download_click", path: "/", detail: "mac" }],
      [ev("site_goal", T, { goal: "cta_click", to: "/dashboard/signup", from: "/pricing" }, site("s", { page: "/pricing" })), { kind: "goal", name: "cta_click", path: "/pricing" }],
      [ev("site_goal", T, { goal: "click", label: "see_how_it_works" }, site("s", { page: "/" })), { kind: "goal", name: "see_how_it_works" }],
      [ev("site_goal", T, { goal: "demo_play" }, site("s", { page: "/" })), { kind: "goal", name: "demo_play", path: "/" }],
      [ev("site_goal", T, { goal: "js_error", label: "error" }, site("s", { page: "/" })), { kind: "error", name: "page error" }],
      [ev("page_action", T, { action: "upsell_shown", label: "dash_sidebar", path: "/" }), { kind: "upsell", name: "upsell_shown", detail: "dash_sidebar" }],
      [ev("page_action", T, { action: "download", label: "download_madani_bot", value: "mac", path: "/welcome" }), { kind: "goal", name: "download_click", path: "/dashboard/welcome", detail: "mac" }],
      [ev("page_action", T, { action: "js_error", label: "rejection", path: "/" }), { kind: "error" }],
      [ev("download_click", T, { platform: "windows", detected_os: "windows" }), { kind: "goal", name: "download_click", detail: "windows" }],
      [ev("signup", T, { method: "google" }), { kind: "signup", name: "signed up", detail: "google" }],
      [ev("onboarding_step", T, { step: "plan" }), { kind: "onboarding", name: "onboarding: plan" }],
      [ev("plan_chosen", T, { plan: "plus", period: "year" }), { kind: "plan", name: "picked plus", detail: "yearly" }],
      [ev("app_paired", T, { via: "app", platform: "darwin" }), { kind: "paired", name: "app paired", detail: "mac" }],
      [ev("app_open", T, { kind: "mobile", platform: "ios" }), { kind: "app", name: "opened the phone app", detail: "ios" }],
      [ev("first_bot_reply", T), { kind: "reply", name: "first bot reply" }],
      [ev("cloud_state", T, { from: "new", to: "provisioning", kind: "starter" }), { kind: "cloud", name: "cloud created" }],
      [ev("cloud_state", T, { from: "running", to: "sleeping", kind: "shared_s" }), { kind: "cloud", name: "cloud sleeping", detail: "plus plan" }],
      [ev("cloud_state", T, { from: "sleeping", to: "running", kind: "dedicated" }), { kind: "cloud", name: "cloud running", detail: "dedicated plan" }],
      [ev("app_error", T, { kind: "window", code: "error" }), { kind: "error", detail: "window error" }],
      [ev("app_action", T, { name: "upsell_click", source: "app_routines" }), { kind: "upsell", name: "upsell_click", detail: "app_routines" }],
      [ev("checkout_paid", T, { amountCents: 1500 }), { kind: "paid", amountCents: 1500 }],
      [ev("site_leave", T, { path: "/", ms: 4000 }), null], [ev("site_section", T, { section: "hero" }), null], [ev("identify", T), null],
      [ev("app_close", T, { ms: 5000 }), null], [ev("app_active", T), null], [ev("app_action", T, { name: "env" }), null],
    ];
    for (const [event, want] of cases) {
      const got = stepOf(event);
      if (want === null) expect(got, event.name).toBeNull();
      else expect(got, `${event.name} ${JSON.stringify(event.props)}`).toMatchObject({ at: T, ...want });
    }
  });

  it("groups events into sessions after 30 quiet minutes, newest first, with source, length and a returned step", () => {
    const events = [
      ev("site_view", T, { path: "/" }, site("a", { source: "X", channel: "social", referrer: "x.com", page: "/" })),
      ev("site_goal", T + MIN, { goal: "cta_click" }, site("a", { page: "/" })),
      ev("site_view", T + 2 * MIN, { path: "/pricing" }, site("a", { source: "direct", channel: "direct", page: "/pricing" })),
      ev("site_leave", T + 2 * MIN + 3_000, { path: "/pricing", ms: 3_000 }, site("a")),
      ev("signup", T + 2 * MIN + 2_000, { method: "email" }, undefined, "acct_1"),
      // 30 minutes exactly is still the same session
      ev("page_view", T + 2 * MIN + 3_000 + SESSION_GAP_MS, { path: "/" }, { session: "d" }, "acct_1"),
      ev("site_view", T + 3 * DAY, { path: "/" }, site("b", { source: "direct", channel: "direct", page: "/" })),
    ];
    const sessions = sessionsOf(events);
    expect(sessions).toHaveLength(2);
    const [last, first] = sessions;
    expect(first).toMatchObject({ start: T, end: T + 2 * MIN + 3_000 + SESSION_GAP_MS, ms: 2 * MIN + 3_000 + SESSION_GAP_MS, surface: "site", source: "X", channel: "social", referrer: "x.com" });
    expect(first!.steps.map(s => s.kind)).toEqual(["view", "signup", "view", "goal", "view"]);
    expect(last).toMatchObject({ start: T + 3 * DAY, ms: 0, source: "direct" });
    expect(last!.steps.map(s => s.kind)).toEqual(["view", "returned"]);
    expect(last!.steps[1]!.gapMs).toBe(3 * DAY - first!.end + T);
  });

  it("splits at more than 30 minutes, uses the app's own open time and keeps billing-only sessions without a source", () => {
    const app = { install: "i1", session: "x", app: { platform: "darwin" } };
    const sessions = sessionsOf([
      ev("app_open", T, { kind: "desktop", platform: "darwin" }, app, "acct_1"),
      ev("app_close", T + MIN, { ms: 20 * MIN }, app, "acct_1"),
      ev("app_open", T + MIN + SESSION_GAP_MS + 1, { kind: "desktop" }, app, "acct_1"),
    ], billingSteps([{ id: "p", accountId: "acct_1", at: T + 10 * DAY, amountCents: 1500, taxCents: 0, currency: "USD", kind: "renewal" }], []));
    expect(sessions.map(s => [s.surface, s.source, s.ms])).toEqual([["server", null, 0], ["app", null, 0], ["app", null, 20 * MIN]]);
    expect(sessions[0]!.steps).toEqual([expect.objectContaining({ kind: "paid", name: "renewed", amountCents: 1500 })]);
    expect(sessions[1]!.steps.at(-1)!.kind).toBe("returned");
  });

  it("takes the first source from the earliest site visit, with its campaign and ref", () => {
    const events = [
      ev("page_view", T - DAY, { path: "/" }, { session: "acc", source: "Google", channel: "search" }, "acct_1"),
      ev("site_view", T + DAY, { path: "/" }, site("late", { source: "X", channel: "social" })),
      ev("site_view", T, { path: "/" }, site("early", { source: "newsletter", channel: "email", utm: { campaign: "launch", source: "newsletter" }, ref: "friend" })),
    ];
    expect(firstSourceOf(visitsOf(events, ["site", "account"]))).toEqual({ at: T, source: "newsletter", channel: "email", campaign: "launch", referrer: null, ref: "friend" });
    expect(firstSourceOf(visitsOf(events.slice(0, 1), ["site", "account"]))).toMatchObject({ source: "Google", channel: "search" });
    expect(firstSourceOf([])).toBeNull();
  });

  it("sums spend net of refunds and times the first payment from the first visit", () => {
    const pay = (at: number, amountCents: number, kind: "new" | "renewal" | "refund") => ({ id: `p${at}`, accountId: "a", at, amountCents, taxCents: 0, currency: "USD", kind });
    const spend = spendOf([pay(T + 3 * DAY, 1500, "new"), pay(T + 33 * DAY, 1500, "renewal"), pay(T + 34 * DAY, -1500, "refund")]);
    expect(spend).toEqual({ spentCents: 1500, refundedCents: 1500, payments: 2, firstPaidAt: T + 3 * DAY });
    expect(timeToPayOf(T, spend.firstPaidAt)).toBe(3 * DAY);
    expect(spendOf([], T + DAY)).toMatchObject({ spentCents: 0, firstPaidAt: T + DAY });
    expect(timeToPayOf(T, null)).toBeNull();
    expect(timeToPayOf(null, T)).toBeNull();
  });

  it("reads device and place from the latest browser visit, else from the app", () => {
    expect(whereOf([
      ev("site_view", T, {}, site("a", { device: "desktop", os: "windows", browser: "edge", country: "DE", city: "Berlin" })),
      ev("site_view", T + DAY, {}, site("b", { device: "mobile", os: "ios", browser: "safari", country: "US", region: "California", city: "San Francisco" })),
    ])).toEqual({ device: "mobile", os: "ios", browser: "safari", country: "US", region: "California", city: "San Francisco" });
    expect(whereOf([ev("app_open", T, {}, { install: "i", app: { platform: "android" } })])).toMatchObject({ device: "mobile", os: "android", browser: null, country: null });
  });

  it("gives page views their visible time, and long site pages their scroll, without rows for the page ends", () => {
    const [session] = sessionsOf([
      ev("site_view", T, { path: "/pricing" }, site("s", { pv: "pv000001" })),
      ev("site_leave", T + MIN, { path: "/pricing", scroll: 40, ms: 30_000, folds: 4 }, site("s", { pv: "pv000001" })),
      ev("site_leave", T + 2 * MIN, { path: "/pricing", scroll: 80, ms: 72_000, folds: 4 }, site("s", { pv: "pv000001" })),
      ev("site_view", T + 3 * MIN, { path: "/" }, site("s", { pv: "pv000002" })),
      ev("site_leave", T + 4 * MIN, { path: "/", scroll: 100, ms: 9_000, folds: 1 }, site("s", { pv: "pv000002" })),
      ev("page_view", T + 5 * MIN, { path: "/billing" }, { session: "d" }, "acct_1"),
      ev("page_leave", T + 6 * MIN, { path: "/billing", ms: 41_000 }, { session: "d" }, "acct_1"),
      ev("page_view", T + 7 * MIN, { path: "/billing" }, { session: "d" }, "acct_1"),
    ]);
    expect(session!.steps.map(step => [step.path, step.ms, step.scroll])).toEqual([
      ["/dashboard/billing", undefined, undefined], ["/dashboard/billing", 41_000, undefined], ["/", 9_000, undefined], ["/pricing", 72_000, 80],
    ]);
  });

  it("folds an upsell's shown into its click, dismiss or ignore, and keeps a shown with no outcome", () => {
    const dash = { session: "d" };
    const app = { install: "i1", app: { platform: "darwin" } };
    const steps = sessionsOf([
      ev("page_action", T, { action: "upsell_shown", label: "dash_sidebar", path: "/" }, dash, "a"),
      ev("page_action", T + 5_000, { action: "upsell_dismiss", label: "dash_sidebar", path: "/", ms: 4_000 }, dash, "a"),
      ev("page_action", T + 6_000, { action: "upsell_shown", label: "dash_routines", path: "/" }, dash, "a"),
      ev("app_action", T + 7_000, { name: "upsell_shown", source: "app_sidebar" }, app, "a"),
      ev("app_action", T + 40_000, { name: "upsell_ignored", source: "app_sidebar", ms: 30_000 }, app, "a"),
      ev("app_action", T + 41_000, { name: "upsell_shown", source: "app_routines" }, app, "a"),
      ev("app_action", T + 41_000 + UPSELL_PAIR_MS + 1, { name: "upsell_click", source: "app_routines", ms: 12_000 }, app, "a"),
    ]).flatMap(session => session.steps).filter(step => step.kind === "upsell").reverse();
    expect(steps.map(step => [step.name, step.detail, step.ms])).toEqual([
      ["upsell_dismiss", "dash_sidebar", 4_000], ["upsell_shown", "dash_routines", undefined], ["upsell_ignored", "app_sidebar", 30_000],
      ["upsell_shown", "app_routines", undefined], ["upsell_click", "app_routines", 12_000],
    ]);
  });

  it("reads notices, timed actions and onboarding steps with their time", () => {
    const app = { install: "i1" };
    expect(stepOf(ev("app_action", T, { name: "notice_closed", notice: "cloud_trial_intro_v1", ms: 4_000 }, app))).toMatchObject({ kind: "notice", name: "notice_closed", detail: "cloud trial intro", ms: 4_000 });
    expect(stepOf(ev("app_action", T, { name: "notice_closed", notice: "two_places", ms: 9_000, acted: true }, app))).toMatchObject({ name: "notice_acted", detail: "two places" });
    expect(stepOf(ev("app_action", T, { name: "notice_ignored", notice: "late_routine_v1", ms: 60_000 }, app))).toMatchObject({ name: "notice_ignored", ms: 60_000 });
    expect(stepOf(ev("app_action", T, { name: "cloud_card_action", action: "start", ms: 12_000 }, app))).toMatchObject({ kind: "goal", detail: "start", ms: 12_000 });
    expect(stepOf(ev("onboarding_step", T, { step: "plan", ms: 14_000 }))).toMatchObject({ name: "onboarding: plan", ms: 14_000 });
    expect(stepOf(ev("onboarding_step", T, { step: "name" }))!.ms).toBeUndefined();
    expect(stepOf(ev("page_leave", T, { path: "/", ms: 1 }))).toBeNull();
  });
});
