import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ROUTINE_AROUND_MS } from "../shared/routines.ts";
import { CHECK_BOOT_HOLD_MS } from "./routine-check-pacing.ts";
import { flexOf } from "./routine-quiet.ts";
import { shapeNewRoutine } from "./routine-shape.ts";
import { RoutineManager, type Routine, type RoutineCheckResult, type RoutineChecks, type RoutineInput } from "./routines.ts";

const MINUTE = 60_000, HOUR = 60 * MINUTE;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function harness(options: { earlyMs?: (routine: Routine) => number; start?: Date } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "madani-quiet-"));
  dirs.push(dir);
  let now = (options.start ?? new Date(2026, 9, 22, 9, 0, 0)).getTime();
  const answers: RoutineCheckResult[] = [];
  const checked: number[] = [];
  const started: string[] = [];
  let thread = 0;
  const checks: RoutineChecks = {
    async check() { checked.push(now); return answers.shift() ?? {}; },
    release: () => {}, settled: () => {},
  };
  const manager = new RoutineManager({
    file: join(dir, "routines.json"), now: () => now, botState: () => "ready",
    createTask: () => ({ threadId: `thread-${++thread}` }),
    startTurn: async (_botId, threadId) => { started.push(threadId); },
    checks, ...(options.earlyMs ? { earlyMs: options.earlyMs } : {}),
  });
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
  return {
    manager, answers, checked, started,
    now: () => now,
    advance: (ms: number) => { now += ms; },
    tick: async () => { await manager.tick(); await settle(); },
    routine: (id: string) => manager.listRoutines().find((one) => one.id === id)!,
  };
}

describe("the runs strip", () => {
  it("shows a quiet check as fired with nothing new and a failed read as failed, oldest first", async () => {
    const h = harness();
    const routine = h.manager.create({ name: "Price", prompt: "Tell me about price changes.", botId: "b", schedule: { type: "interval", everyMinutes: 15, anchorAt: h.now() + 15 * MINUTE }, probe: { kind: "page", url: "https://example.com/" } });
    h.advance(CHECK_BOOT_HOLD_MS + 15 * MINUTE);
    await h.tick();
    h.answers.push({ trouble: "Couldn't check example.com: The page answered 500." });
    h.advance(15 * MINUTE);
    await h.tick();
    expect(h.started).toEqual([]);
    expect(h.routine(routine.id).strip?.map((entry) => entry.outcome)).toEqual(["quiet", "failed"]);
    expect(h.routine(routine.id).checkTrouble).toMatch(/Couldn't check/);
  });

  it("does not count a held check as quiet", async () => {
    const h = harness();
    const routine = h.manager.create({ name: "Feed", prompt: "New posts?", botId: "b", schedule: { type: "interval", everyMinutes: 15, anchorAt: h.now() + 15 * MINUTE }, probe: { kind: "feed", url: "https://example.com/feed" } });
    h.answers.push({ held: true });
    h.advance(CHECK_BOOT_HOLD_MS + 15 * MINUTE);
    await h.tick();
    expect(h.routine(routine.id).strip ?? []).toEqual([]);
  });
});

describe("waking hours", () => {
  it("rolls the night's checks into one morning check just before the person starts", async () => {
    const h = harness({ start: new Date(2026, 9, 22, 22, 0, 0) });
    const input = shapeNewRoutine({ name: "Inbox", prompt: "Anything new in the shared inbox?", botId: "b", schedule: { type: "interval", everyMinutes: 30, anchorAt: h.now() + 30 * MINUTE } } as RoutineInput, { start: "06:30", end: "23:00" });
    expect(input.schedule).toMatchObject({ window: { start: "06:30", end: "23:00" } });
    const routine = h.manager.create({ ...input, probe: { kind: "page", url: "https://example.com/" } });
    // 22:30 is the last check of the evening
    for (let minutes = 0; minutes < 75; minutes += 15) { h.advance(15 * MINUTE); await h.tick(); }
    // a Cloud home sees the night's quiet gap: nothing due before the morning check
    expect(h.manager.upcoming()[0]?.at).toBe(new Date(2026, 9, 23, 6, 30).getTime());
    for (let minutes = 75; minutes < 9 * 60; minutes += 15) { h.advance(15 * MINUTE); await h.tick(); }
    const hours = h.checked.map((at) => new Date(at).getHours() + new Date(at).getMinutes() / 60);
    expect(hours.filter((hour) => hour >= 23 || hour < 6.5)).toEqual([]);
    expect(hours.at(-1)).toBeGreaterThanOrEqual(6.5);
    expect(hours.filter((hour) => hour >= 6.5 && hour < 7)).toHaveLength(1);
    expect(h.routine(routine.id).enabled).toBe(true);
  });
});

describe("around this time", () => {
  const daily = (h: ReturnType<typeof harness>) => h.manager.create({ name: "Digest", prompt: "Write my morning digest.", botId: "b", schedule: { type: "daily", time: "10:00", weekdays: [0, 1, 2, 3, 4, 5, 6] }, timing: "around" });

  it("keeps the exact time on a desktop", async () => {
    const h = harness();
    const routine = daily(h);
    expect(routine.timing).toBe("around");
    h.advance(40 * MINUTE);
    await h.tick();
    expect(h.started).toEqual([]);
    h.advance(20 * MINUTE);
    await h.tick();
    expect(h.started).toHaveLength(1);
  });

  it("lets a Cloud home run it within its window, and reports the window", async () => {
    const h = harness({ earlyMs: flexOf });
    daily(h);
    expect(h.manager.upcoming()[0]).toEqual({ at: new Date(2026, 9, 22, 10, 0).getTime(), flexMs: ROUTINE_AROUND_MS });
    // an old Admin that reads only nextDueAt still wakes it before the window ends
    expect(h.manager.nextDueAt()).toBe(new Date(2026, 9, 22, 10, 0).getTime() + ROUTINE_AROUND_MS);
    h.advance(35 * MINUTE);
    await h.tick();
    expect(h.started).toHaveLength(1);
    h.advance(HOUR);
    await h.tick();
    expect(h.started).toHaveLength(1);
  });

  it("is dropped for a schedule that cannot move", () => {
    const h = harness();
    const routine = h.manager.create({ name: "Hourly", prompt: "Check.", botId: "b", schedule: { type: "interval", everyMinutes: 60, anchorAt: h.now() + HOUR }, timing: "around" });
    expect(routine.timing).toBeUndefined();
    const patched = h.manager.update(daily(h).id, { timing: null })!;
    expect(patched.timing).toBeUndefined();
  });
});

describe("a probe on a routine", () => {
  it("is its own check: given turns it on, removed turns it off, and it never mixes with other checks or the brief", () => {
    const h = harness();
    const schedule = { type: "interval" as const, everyMinutes: 60, anchorAt: h.now() + HOUR };
    const routine = h.manager.create({ name: "Blog", prompt: "Any new posts?", botId: "b", schedule, probe: { kind: "feed", url: "https://example.com/feed" } });
    expect(routine).toMatchObject({ checks: ["probe"], probe: { kind: "feed", url: "https://example.com/feed" } });
    expect(() => h.manager.create({ name: "x", prompt: "y", botId: "b", schedule, probe: { kind: "page", url: "file:///etc/passwd" } })).toThrow(/http or https/);
    expect(() => h.manager.create({ name: "x", prompt: "y", botId: "b", schedule, probe: { kind: "page", url: "https://a.example/" }, checks: ["mail"] })).toThrow(/on its own/);
    expect(() => h.manager.create({ name: "x", prompt: "y", botId: "b", schedule, probe: { kind: "page", url: "https://a.example/" }, deliver: "brief" })).toThrow(/not the brief/);
    const off = h.manager.update(routine.id, { probe: null })!;
    expect(off.checks).toBeUndefined();
    expect(off.probe).toBeUndefined();
  });
});
