import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createAllowance, resetOf, topSpenders, validAutoTopUp, weekStartOf } from "./allowance.ts";
import type { Entry } from "./spend.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function harness(options: { skipped?: Array<{ routineId: string; name: string; at: number }> } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "madani-allowance-"));
  dirs.push(dataDir);
  // a Wednesday afternoon
  let now = new Date(2026, 10, 11, 15, 0).getTime();
  const entries: Entry[] = [];
  const make = () => createAllowance({
    dataDir, now: () => now,
    since: (at) => entries.filter((entry) => entry.at >= at),
    names: { bot: (id) => ({ research: "Research", chief: "Chief" })[id], routine: (id) => (id === "inbox" ? { name: "your inbox check", botId: "chief" } : undefined) },
    upcoming: () => options.skipped ?? [],
  });
  let allowance = make();
  const spend = (usd: number, botId = "research", routineId?: string) => {
    const entry: Entry = { at: now, botId, botName: botId, usd, tokens: 10, ...(routineId ? { routineId, routineName: routineId, runId: `run-${entries.length}` } : {}) };
    entries.push(entry);
    allowance.booked(entry);
  };
  return { get allowance() { return allowance; }, spend, entries, advance: (ms: number) => { now += ms; }, now: () => now, restart: () => { allowance = make(); } };
}

describe("the weekly allowance", () => {
  it("runs Monday 12:00 AM to the next Monday, local time", () => {
    const wednesday = new Date(2026, 10, 11, 15, 0).getTime();
    expect(new Date(weekStartOf(wednesday))).toEqual(new Date(2026, 10, 9, 0, 0));
    expect(new Date(resetOf(weekStartOf(wednesday)))).toEqual(new Date(2026, 10, 16, 0, 0));
    expect(new Date(weekStartOf(new Date(2026, 10, 15, 23, 59).getTime()))).toEqual(new Date(2026, 10, 9, 0, 0));
  });

  it("has none by default: nothing waits and no notice is due, however much is spent", () => {
    const h = harness();
    h.spend(50);
    expect(h.allowance.over()).toBe(false);
    expect(h.allowance.notice()).toBeNull();
    expect(h.allowance.report()).toMatchObject({ weeklyUsd: null, limitUsd: null, level: "off", top: [] });
  });

  it("has one quiet notice due at 80%, once a week, and names the top two spenders only in the report", () => {
    const h = harness();
    h.allowance.setWeekly(6);
    h.spend(2.1, "research");
    h.spend(1.2, "chief", "inbox");
    h.spend(0.5, "chief");
    expect(h.allowance.notice()).toBeNull();
    h.spend(1.0, "research");
    expect(h.allowance.notice()).toBe("near");
    expect(h.allowance.report().top.map((one) => [one.name, one.usd])).toEqual([["Research", 3.1], ["your inbox check", 1.2]]);
    h.allowance.noticeSeen();
    h.spend(0.1);
    h.restart();
    h.spend(0.1);
    expect(h.allowance.notice()).toBeNull();
    expect(h.allowance.report().level).toBe("near");
  });

  it("at 100% lets the step finish, keeps the overrun off the count, lists what skips and holds new work", () => {
    const h = harness({ skipped: [{ routineId: "a", name: "Morning digest", at: 1 }, { routineId: "b", name: "Inbox check", at: 2 }] });
    h.allowance.setWeekly(6);
    h.spend(5.9);
    h.spend(0.13);
    expect(h.allowance.notice()).toBe("over");
    expect(h.allowance.over()).toBe(true);
    expect(h.allowance.report()).toMatchObject({ level: "over", spentUsd: 6, overrunUsd: 0.03, share: 1, skipped: [{ name: "Morning digest" }, { name: "Inbox check" }] });
    expect(h.allowance.held("en-US")).toBe("Skipped: weekly limit reached. It resets Monday 12:00 AM, in 4 days.");
    expect(h.allowance.refusal("en-US")).toBe("Weekly limit reached, so new tasks wait until Monday 12:00 AM (in 4 days). Turn on saver mode in usage to keep chatting on a cheaper model.");
    expect(h.allowance.refusal("en-US")).not.toMatch(/\$/);
    // a step still running when it hit is ours too
    h.spend(0.02);
    expect(h.allowance.report().overrunUsd).toBe(0.05);
    h.allowance.noticeSeen();
    h.spend(0.02);
    expect(h.allowance.notice()).toBeNull();
  });

  it("Saver mode is the person's choice: chat then works, and its spend is kept apart until the reset", () => {
    const h = harness();
    h.allowance.setWeekly(1);
    h.spend(1);
    expect(h.allowance.report().saver).toBe(false);
    h.allowance.setSaver(true);
    expect(h.allowance.refusal()).toBeNull();
    expect(h.allowance.held()).not.toBeNull();
    h.spend(0.04);
    expect(h.allowance.report()).toMatchObject({ saver: true, saverUsd: 0.04, overrunUsd: 0 });
    h.advance(5 * 24 * 60 * 60_000);
    expect(h.allowance.report()).toMatchObject({ saver: false, level: "ok", spentUsd: 0, overrunUsd: 0, saverUsd: 0 });
  });

  it("adds for this week at the price shown, and a new week starts clean", () => {
    const h = harness();
    h.allowance.setWeekly(6);
    h.spend(6);
    h.allowance.addForWeek(2);
    expect(h.allowance.over()).toBe(false);
    expect(h.allowance.report()).toMatchObject({ limitUsd: 8, extraUsd: 2 });
    h.advance(5 * 24 * 60 * 60_000);
    expect(h.allowance.report()).toMatchObject({ limitUsd: 6, extraUsd: 0 });
  });

  it("auto top-up is off by default, needs a ceiling, and never goes past it in a month", () => {
    const h = harness();
    expect(h.allowance.report().autoTopUp.on).toBe(false);
    expect(validAutoTopUp({ on: true, stepUsd: 2 })).toBeNull();
    expect(validAutoTopUp({ on: true, stepUsd: 5, monthlyCeilingUsd: 3 })).toBeNull();
    h.allowance.setWeekly(1);
    h.allowance.setAutoTopUp(validAutoTopUp({ on: true, stepUsd: 1, monthlyCeilingUsd: 1 })!);
    h.spend(1.2);
    expect(h.allowance.report()).toMatchObject({ limitUsd: 2, autoTopUp: { on: true, monthUsd: 1 } });
    expect(h.allowance.over()).toBe(false);
    h.spend(1);
    expect(h.allowance.over()).toBe(true);
    expect(h.allowance.report().limitUsd).toBe(2);
  });

  it("ranks a routine's spend apart from its bot's other work", () => {
    const entries = [
      { at: 1, botId: "chief", botName: "Chief", usd: 1, tokens: 0 },
      { at: 2, botId: "chief", botName: "Chief", usd: 2, tokens: 0, routineId: "inbox", routineName: "Inbox" },
      { at: 3, botId: "research", botName: "Research", usd: 0.5, tokens: 0 },
    ];
    expect(topSpenders(entries, { bot: () => undefined, routine: () => undefined }).map((one) => [one.kind, one.name, one.usd])).toEqual([["routine", "Inbox", 2], ["bot", "Chief", 1]]);
  });
});
