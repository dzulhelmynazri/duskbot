import { beforeEach, describe, expect, it, vi } from "vitest";
import { dailyShowings, dayKey, NUDGE_DAILY_MAX, NUDGE_GAP_MS, NUDGE_KEY, nudgeDue, nudgeEligible, nextNudgeAt, readNudge, type NudgeDay } from "./cloud-nudge";

const HOUR = 3600_000;
const MORNING = new Date(2026, 10, 15, 9).getTime();
const day = (over: Partial<NudgeDay> = {}): NudgeDay => ({ day: dayKey(MORNING), sessions: 1, messages: 0, shown: 0, lastShownAt: 0, open: false, ...over });

describe("how many showings a day earns", () => {
  it("none before the app is used that day, then two at most, however heavy the day", () => {
    expect(dailyShowings({ sessions: 0, messages: 0 })).toBe(0);
    expect(dailyShowings({ sessions: 1, messages: 0 })).toBe(2);
    expect(dailyShowings({ sessions: 9, messages: 500 })).toBe(2);
    expect(NUDGE_DAILY_MAX).toBe(2);
  });
});

describe("when the next showing may start", () => {
  it("as soon as the app is in use that day", () => {
    expect(nudgeDue(day({ sessions: 0 }), MORNING)).toBe(false);
    expect(nudgeDue(day(), MORNING)).toBe(true);
  });
  it("hours after the last one, and never a third on the same calendar day", () => {
    const once = day({ shown: 1, lastShownAt: MORNING });
    expect(nudgeDue(once, MORNING + HOUR)).toBe(false);
    expect(nudgeDue(once, MORNING + NUDGE_GAP_MS - 1)).toBe(false);
    expect(nudgeDue(once, MORNING + NUDGE_GAP_MS), "the next time slot, even after a close").toBe(true);
    const twice = day({ shown: 2, lastShownAt: MORNING + NUDGE_GAP_MS });
    expect(nudgeDue(twice, MORNING + 12 * HOUR)).toBe(false);
    expect(nextNudgeAt(twice)).toBeNull();
  });
  it("a new day starts its counts over but keeps the gap across midnight", () => {
    const late = new Date(2026, 10, 15, 23).getTime(), after = late + 2 * HOUR;
    const raw = JSON.stringify({ day: dayKey(late), sessions: 3, messages: 40, shown: 2, lastShownAt: late });
    const next = readNudge(raw, after);
    expect(next).toEqual({ day: dayKey(after), sessions: 0, messages: 0, shown: 0, lastShownAt: late, open: false });
    expect(nudgeDue({ ...next, sessions: 1 }, after), "still within the gap").toBe(false);
    expect(nudgeDue({ ...next, sessions: 1 }, late + NUDGE_GAP_MS)).toBe(true);
  });
  it("reads anything broken as a fresh day", () => {
    for (const raw of [null, "", "{", "[]", JSON.stringify({ day: dayKey(MORNING), shown: -4, messages: "x", lastShownAt: MORNING * 2 })]) {
      const read = readNudge(raw, MORNING);
      expect(read.shown).toBe(0);
      expect(read.messages).toBe(0);
      expect(read.lastShownAt).toBeLessThanOrEqual(MORNING);
    }
  });
});

describe("who never sees it", () => {
  it("only where the offer is allowed (no store build, no madani cloud yet), after first run, with no corner cloud card", () => {
    expect(nudgeEligible({ allowed: true, settled: true, cornerCard: false })).toBe(true);
    expect(nudgeEligible({ allowed: false, settled: true, cornerCard: false }), "has madani cloud, or a store build").toBe(false);
    expect(nudgeEligible({ allowed: null, settled: true, cornerCard: false }), "plan still loading").toBe(false);
    expect(nudgeEligible({ allowed: true, settled: false, cornerCard: false }), "first run").toBe(false);
    expect(nudgeEligible({ allowed: true, settled: true, cornerCard: true })).toBe(false);
  });
});

describe("the running app's record", () => {
  let storage: Map<string, string>;
  beforeEach(() => {
    vi.resetModules();
    storage = new Map();
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  });

  it("shows twice a day at most, each held until closed, and a close brings it back only at the next slot", async () => {
    const nudge = await import("./cloud-nudge");
    nudge.noteNudgeSession(MORNING); nudge.noteNudgeSession(MORNING);
    expect(nudge.nudgeDay(MORNING).sessions).toBe(1);
    expect(nudge.takeNudge(MORNING)).toBe(true);
    expect(nudge.nudgeShowing()).toBe(true);
    expect(nudge.takeNudge(MORNING + 5 * HOUR), "one showing at a time").toBe(false);
    nudge.endNudge(MORNING + HOUR);
    expect(nudge.nudgeShowing()).toBe(false);
    expect(nudge.takeNudge(MORNING + 2 * HOUR), "not before the next slot").toBe(false);
    expect(nudge.takeNudge(MORNING + NUDGE_GAP_MS)).toBe(true);
    nudge.endNudge(MORNING + NUDGE_GAP_MS);
    expect(nudge.takeNudge(MORNING + 12 * HOUR), "two is the day's most").toBe(false);
    expect(JSON.parse(storage.get(NUDGE_KEY)!)).toMatchObject({ day: dayKey(MORNING), shown: 2, open: false });
    nudge.noteNudgeMessage(MORNING + 24 * HOUR);
    expect(nudge.takeNudge(MORNING + 24 * HOUR), "a new day the app is used").toBe(true);
  });

  it("a new launch drops a showing nobody closed, and it still counts toward the day", async () => {
    let nudge = await import("./cloud-nudge");
    nudge.noteNudgeSession(MORNING);
    expect(nudge.takeNudge(MORNING)).toBe(true);
    vi.resetModules();
    nudge = await import("./cloud-nudge");
    nudge.noteNudgeSession(MORNING + HOUR);
    expect(nudge.nudgeShowing()).toBe(false);
    expect(JSON.parse(storage.get(NUDGE_KEY)!)).toMatchObject({ shown: 1, open: false });
    expect(nudge.takeNudge(MORNING + HOUR), "the gap still holds").toBe(false);
    expect(nudge.takeNudge(MORNING + NUDGE_GAP_MS)).toBe(true);
  });
});
