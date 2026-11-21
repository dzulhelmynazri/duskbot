import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EMPTY_ONBOARDING, type OnboardingStatus } from "@/lib/onboarding";
import { ASLEEP_NOTICE, CLOUD_INTRO, CLOUD_NOTICE, CLOUD_TRIAL_NOTICE, dismissNotice, GROK_MOVE_NOTICE, introShown, introStage, LATE_ROUTINE_NOTICE, launchNotice, localDay, markLaunchNotice, nextNotice, noticeSeen,
  BRING_NOTICE, INVESTED_NOTICE, NOTICES, OLD_PRO_DISMISSALS, TWO_PLACES_NOTICE, usedBefore, WHATS_NEW_NOTICE, type NoticeFacts } from "./notices";

let storage: Map<string, string>, session: Map<string, string>;
beforeEach(() => {
  storage = new Map(); session = new Map();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => session.get(key) ?? null, setItem: (key: string, value: string) => session.set(key, value) });
});
afterEach(() => vi.unstubAllGlobals());

const record = (hintsSeen: string[] = []): OnboardingStatus => ({ ...EMPTY_ONBOARDING, completedAt: "2026-09-01", version: 1, hintsSeen });
const facts = (values: Partial<NoticeFacts> = {}): NoticeFacts => Object.fromEntries(NOTICES.map(id => [id, values[id] ?? false])) as NoticeFacts;
const none = () => false;
const DAY = 86_400_000, NOON = new Date(2026, 9, 9, 12).getTime();

it("queues account and workspace notices without upstream campaigns", () => {
  expect(NOTICES).toEqual([GROK_MOVE_NOTICE, WHATS_NEW_NOTICE, BRING_NOTICE, TWO_PLACES_NOTICE, LATE_ROUTINE_NOTICE, ASLEEP_NOTICE, CLOUD_INTRO, CLOUD_TRIAL_NOTICE, CLOUD_NOTICE]);
  expect(NOTICES, "the invested pitch lives in the sidebar card").not.toContain(INVESTED_NOTICE);
  // a routine that ran late is the stronger moment, so it goes before the general Cloud card
  expect(nextNotice(facts({ [LATE_ROUTINE_NOTICE]: true, [CLOUD_INTRO]: true }), none)).toBe(LATE_ROUTINE_NOTICE);
  expect(nextNotice(facts({ [ASLEEP_NOTICE]: true, [CLOUD_INTRO]: true }), none)).toBe(ASLEEP_NOTICE);
  expect(nextNotice(facts({ [TWO_PLACES_NOTICE]: true, [CLOUD_INTRO]: true }), none)).toBe(TWO_PLACES_NOTICE);
  expect(nextNotice(facts({ [CLOUD_TRIAL_NOTICE]: true, [CLOUD_NOTICE]: true }), none)).toBe(CLOUD_TRIAL_NOTICE);
  expect(nextNotice(facts({ [CLOUD_NOTICE]: true }), none)).toBe(CLOUD_NOTICE);
  expect(nextNotice(facts(), none)).toBeNull();
});

it("waits for unknown state and skips notices already dismissed", () => {
  const due = { ...facts({ [CLOUD_NOTICE]: true }), [CLOUD_INTRO]: null };
  expect(nextNotice(due, none)).toBeNull();
  expect(nextNotice(due, id => id === CLOUD_INTRO)).toBe(CLOUD_NOTICE);
});

it("keeps the launch quiet after its first notice closes", () => {
  const due = facts({ [WHATS_NEW_NOTICE]: true, [CLOUD_NOTICE]: true });
  expect(nextNotice(due, none)).toBe(WHATS_NEW_NOTICE);
  expect(nextNotice(due, id => id === WHATS_NEW_NOTICE, WHATS_NEW_NOTICE)).toBeNull();
});

it("keeps the first launch claim and ignores removed campaign ids", () => {
  expect(launchNotice()).toBeNull();
  session.set("madani.launch.notice", "retired-credit-2026-11");
  expect(launchNotice()).toBeNull();
  markLaunchNotice(WHATS_NEW_NOTICE); markLaunchNotice(CLOUD_NOTICE);
  expect(launchNotice()).toBe(WHATS_NEW_NOTICE);
  expect(session.get("madani.launch.notice")).toBe(WHATS_NEW_NOTICE);
  session.clear();
  vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
  markLaunchNotice(CLOUD_NOTICE);
  expect(launchNotice()).toBe(CLOUD_NOTICE);
});

it("a dismissal holds on this device at once and in the workspace record for good", () => {
  const seen = record(["tour.done"]);
  expect(dismissNotice(seen, CLOUD_NOTICE)).toEqual({ onboarding: { hintsSeen: ["tour.done", CLOUD_NOTICE] } });
  expect(storage.get(CLOUD_NOTICE)).toBe("1");
  expect(noticeSeen(record(), CLOUD_NOTICE)).toBe(true);
  storage.clear();
  expect(noticeSeen(record(), CLOUD_NOTICE)).toBe(false);
  expect(noticeSeen(record([CLOUD_NOTICE]), CLOUD_NOTICE)).toBe(true);
  expect(dismissNotice(record([CLOUD_NOTICE]), CLOUD_NOTICE)).toBeNull();
});

it("browser storage that throws still leaves the workspace record in charge", () => {
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
  expect(noticeSeen(record(), CLOUD_NOTICE)).toBe(false);
  expect(noticeSeen(record([CLOUD_NOTICE]), CLOUD_NOTICE)).toBe(true);
  expect(dismissNotice(record(), CLOUD_NOTICE)).toEqual({ onboarding: { hintsSeen: [CLOUD_NOTICE] } });
  expect(introStage(record(), NOON)).toBe("due");
  expect(introShown(record(), NOON)).toEqual({ onboarding: { hintsSeen: [`${CLOUD_INTRO}:day-1`] } });
});

it("the card after the update shows at most once a calendar day, on at most three days, then counts as dismissed", () => {
  let hints: string[] = [];
  const show = (at: number) => { const patch = introShown(record(hints), at); if (patch) hints = patch.onboarding.hintsSeen; };
  expect(introStage(record(hints), NOON)).toBe("due");
  show(NOON);
  expect(hints).toEqual([`${CLOUD_INTRO}:day-1`]);
  expect(JSON.parse(storage.get(`${CLOUD_INTRO}:days`)!)).toEqual([localDay(NOON)]);
  expect(introStage(record(hints), NOON + 3 * 3600_000)).toBe("shown-today");
  expect(introShown(record(hints), NOON + 3 * 3600_000)).toBeNull();
  const midnight = new Date(2026, 9, 10, 0, 30).getTime();
  expect(introStage(record(hints), midnight), "an ignored card rests the next day").toBe("resting");
  const twoDays = NOON + 2 * DAY;
  expect(introStage(record(hints), twoDays)).toBe("due");
  show(twoDays); show(NOON + 5 * DAY);
  expect(hints).toEqual([`${CLOUD_INTRO}:day-1`, `${CLOUD_INTRO}:day-2`, `${CLOUD_INTRO}:day-3`]);
  expect(introStage(record(hints), NOON + 5 * DAY + 3600_000)).toBe("shown-today");
  expect(introStage(record(hints), NOON + 6 * DAY)).toBe("done");
  storage.clear();
  expect(introStage(record(hints), NOON + 6 * DAY)).toBe("done");
  expect(introStage(record([`${CLOUD_INTRO}:day-3`]), NOON + 6 * DAY)).toBe("done");
  expect(introStage(record([`${CLOUD_INTRO}:day-2`]), NOON + 6 * DAY)).toBe("due");
  expect(introStage(record([CLOUD_INTRO]), NOON)).toBe("done");
  storage.set(CLOUD_INTRO, "1");
  expect(introStage(record(), NOON)).toBe("done");
});

it("someone who closed the earlier Pro card sees this one on one day only", () => {
  expect([...OLD_PRO_DISMISSALS]).toEqual(["pro-introduction-dismissed-v2", "pro-introduction-dismissed-v3"]);
  for (const earlier of OLD_PRO_DISMISSALS) {
    storage.clear();
    expect(introStage(record([earlier]), NOON)).toBe("due");
    const patch = introShown(record([earlier]), NOON)!;
    expect(introStage({ ...record(), hintsSeen: patch.onboarding.hintsSeen }, NOON + DAY)).toBe("done");
    storage.clear(); storage.set(earlier, "1");
    introShown(record(), NOON);
    expect(introStage(record(), NOON + DAY)).toBe("done");
  }
  storage.clear();
  introShown(record(["pro-introduction-dismissed"]), NOON);
  expect(introStage(record(["pro-introduction-dismissed"]), NOON + 2 * DAY)).toBe("due");
});

it("someone has used the app before when a conversation from before this launch has had a reply", () => {
  const launch = 1_000_000;
  const task = (createdAt: number, turns?: number) => ({ createdAt, ...(turns === undefined ? {} : { usage: { turns } }) });
  expect(usedBefore([], launch)).toBe(false);
  expect(usedBefore([{ tasks: [task(launch - 1, 1)] }], launch)).toBe(true);
  expect(usedBefore([{ tasks: [task(launch, 3)] }], launch)).toBe(false);
  expect(usedBefore([{ tasks: [task(launch - 1, 0), task(launch - 1)] }, {}], launch)).toBe(false);
  expect(usedBefore([{}, { tasks: [task(launch + 5, 2), task(launch - 9, 2)] }], launch)).toBe(true);
});
