import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeEvent } from "../../shared/runtime-events.ts";
import { DRY_RUN_NOTE } from "../routine-execution.ts";
import { RoutineManager, type RoutineManagerOptions } from "../routines.ts";
import type { CapHit } from "../spend.ts";
import { createRoutineGuard, failedAlike, isNotYet, RECHECK_MINUTES } from "./routine-guard.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const START = new Date(2026, 10, 9, 8, 0, 0).getTime();
const MINUTE = 60_000;
type EventBody = RuntimeEvent extends infer E ? E extends RuntimeEvent ? Omit<E, "eventId" | "provider" | "threadId" | "createdAt"> : never : never;

function harness(over: { cap?: CapHit | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "madani-routine-guard-"));
  dirs.push(dir);
  let now = START;
  let tasks = 0;
  let manager!: RoutineManager;
  const started: Array<{ threadId: string; prompt: string }> = [];
  const told: Array<{ botId: string; threadId?: string; text: string; quiet?: boolean }> = [];
  const rechecks: Array<{ id: string; at: number }> = [];
  let cap = over.cap ?? null;
  const guard = createRoutineGuard({
    dataDir: dir, now: () => now,
    routine: (id) => manager.listRoutines().find((one) => one.id === id),
    runs: () => manager.listRuns(),
    pause: (id) => manager.update(id, { enabled: false }),
    recheck: (id, at) => { rechecks.push({ id, at }); manager.deferNextRun(id, at, true); },
    tell: (botId, threadId, text, quiet) => told.push({ botId, threadId, text, quiet }),
    language: () => undefined,
    spendOver: () => cap,
  });
  const options: RoutineManagerOptions = {
    file: join(dir, "routines.json"), now: () => now, botState: () => "ready",
    createTask: () => ({ threadId: `thread-${++tasks}` }),
    startTurn: async (_botId, threadId, prompt) => { started.push({ threadId, prompt }); },
    onRunFailed: (run) => guard.failed(run),
    onRunChanged: (run) => guard.changed(run),
    held: (run) => guard.held(run),
    decorate: (routine) => guard.pausedFor(routine),
  };
  manager = new RoutineManager(options);
  const event = (threadId: string, body: EventBody) =>
    manager.handleRuntimeEvent({ eventId: `e-${Math.random()}`, provider: "fake", threadId, createdAt: new Date(0).toISOString(), ...body } as RuntimeEvent);
  return {
    guard, started, told, rechecks, get manager() { return manager; },
    setCap: (next: CapHit | null) => { cap = next; },
    advance: async (ms: number) => { now += ms; await manager.tick(); },
    routine: (schedule: Parameters<RoutineManager["create"]>[0]["schedule"] = { type: "daily", time: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] }) =>
      manager.create({ name: "Invoice check", prompt: "Find the invoice email", botId: "maus-1", schedule }),
    run: async (id: string, dryRun = false) => {
      const run = manager.runNow(id, undefined, dryRun)!;
      await manager.tick();
      return manager.listRuns().find((one) => one.id === run.id)!;
    },
    fail: (threadId: string, message: string) => {
      event(threadId, { type: "runtime.error", message, stopReason: "refusal" } as EventBody);
      event(threadId, { type: "turn.completed", ok: false, stopReason: "refusal" });
    },
    complete: (threadId: string, text: string) => {
      event(threadId, { type: "item.completed", itemType: "assistant_text", text });
      event(threadId, { type: "turn.completed", ok: true });
    },
  };
}

describe("routine guard", () => {
  it("pauses a routine after three runs fail the same way, says so once, and forgets it once turned back on", async () => {
    const h = harness();
    const routine = h.routine();
    for (let i = 1; i <= 3; i += 1) {
      const run = await h.run(routine.id);
      h.fail(run.threadId!, "Gmail is not connected");
    }
    const paused = h.manager.listRoutines().find((one) => one.id === routine.id)!;
    expect(paused.enabled).toBe(false);
    expect(paused.pausedFor).toMatchObject({ by: "failures", error: "Gmail is not connected" });
    expect(h.told).toHaveLength(1);
    expect(h.told[0]!.text).toContain("after 3 runs failed the same way: Gmail is not connected");

    h.manager.update(routine.id, { enabled: true });
    expect(h.manager.listRoutines().find((one) => one.id === routine.id)!.pausedFor).toBeUndefined();
  });

  it("does not pause for failures that differ, or for test runs", async () => {
    const h = harness();
    const routine = h.routine();
    for (const message of ["one", "two", "two"]) h.fail((await h.run(routine.id)).threadId!, message);
    for (let i = 0; i < 3; i += 1) h.fail((await h.run(routine.id, true)).threadId!, "two");
    expect(h.manager.listRoutines()[0]!.enabled).toBe(true);
    expect(failedAlike(h.manager.listRuns(), routine.id)).toBeNull();
    expect(h.told).toEqual([]);
  });

  it("holds a scheduled run back at a cap without starting it, while a run someone starts still goes", async () => {
    const h = harness({ cap: { kind: "routine", id: "x", botId: "maus-1", name: "Invoice check", capUsd: 2, spentUsd: 2.4 } });
    const routine = h.routine({ type: "interval", everyMinutes: 30, anchorAt: START });
    await h.advance(31 * MINUTE);
    const missed = h.manager.listRuns().find((run) => !run.manual)!;
    expect(missed).toMatchObject({ status: "missed", error: "Not started: this routine reached its weekly cap" });
    expect(h.started).toEqual([]);
    expect(h.manager.listRoutines()[0]).toMatchObject({ enabled: false, pausedFor: { by: "cap", capUsd: 2 } });

    await h.run(routine.id);
    expect(h.started).toHaveLength(1);
  });

  it("checks again with backoff when a run says its input is not there yet", async () => {
    const h = harness();
    const routine = h.routine({ type: "daily", time: "12:00", weekdays: [0, 1, 2, 3, 4, 5, 6] });
    const run = await h.run(routine.id);
    h.complete(run.threadId!, "Not yet: the invoice email from Acme isn't in the inbox.");
    expect(h.rechecks).toEqual([{ id: routine.id, at: START + RECHECK_MINUTES[0] * MINUTE }]);
    expect(h.manager.listRoutines()[0]!.nextRunAt).toBe(START + RECHECK_MINUTES[0] * MINUTE);
    expect(h.told).toEqual([expect.objectContaining({ threadId: run.threadId, quiet: true })]);

    await h.advance(RECHECK_MINUTES[0] * MINUTE);
    const second = h.started.at(-1)!;
    expect(h.started).toHaveLength(2);
    h.complete(second.threadId, "Not yet: still nothing.");
    expect(h.rechecks[1]!.at).toBe(START + (RECHECK_MINUTES[0] + RECHECK_MINUTES[1]) * MINUTE);
    await h.advance(RECHECK_MINUTES[1] * MINUTE);
    h.complete(h.started.at(-1)!.threadId, "Found it and filed it.");
    const later = await h.run(routine.id);
    h.complete(later.threadId!, "Not yet: tomorrow's has not come.");
    expect(h.rechecks.at(-1)!.at).toBe(START + (RECHECK_MINUTES[0] * 2 + RECHECK_MINUTES[1]) * MINUTE);
  });

  it("runs a test with the dry-run note, and never rechecks one", async () => {
    const h = harness();
    const routine = h.routine();
    const run = await h.run(routine.id, true);
    expect(run.dryRun).toBe(true);
    expect(h.started[0]!.prompt).toContain(DRY_RUN_NOTE);
    expect(h.guard.dryRun(run)).toBe(true);
    h.complete(run.threadId!, "Not yet: nothing.");
    expect(h.rechecks).toEqual([]);
  });

  it("reads a not-yet reply only at its start", () => {
    expect(isNotYet("Not yet: the file is missing")).toBe(true);
    expect(isNotYet("**Not yet** - waiting")).toBe(true);
    expect(isNotYet("Done. It is not yet Friday.")).toBe(false);
  });
});
