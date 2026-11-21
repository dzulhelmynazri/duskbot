import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RoutineManager } from "../routines.ts";
import { createSpend } from "../spend.ts";
import type { UsageRow } from "../usage-ledger.ts";
import { createRoutineHost, upcomingRuns } from "./routine-quiet-host.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), "madani-quiet-host-"));
  dirs.push(dataDir);
  let thread = 0;
  const spend = createSpend({ dataDir });
  let host!: ReturnType<typeof createRoutineHost>;
  const manager = new RoutineManager({
    file: join(dataDir, "routines.json"), botState: () => "ready",
    createTask: () => ({ threadId: `t-${++thread}` }), startTurn: async () => {},
    held: (run) => host.allowanceHeld(run, "en-US"),
  });
  const make = () => createRoutineHost({ dataDir, cloudHome: false, spend, routines: () => manager, botName: () => "Bot", model: () => undefined, tell: () => {}, language: () => "en-US" });
  host = make();
  const book = (usd: number, runId?: string, routineId?: string) => {
    const row: UsageRow = { at: new Date().toISOString(), botId: "b", botName: "Bot", threadId: "t", instanceId: "claude", driverKind: "claudeAgent", model: "m", input: 1, output: 1, costUsd: usd,
      trigger: runId ? { kind: "routine", routineId: routineId!, label: "Digest", runId } : { kind: "owner" } };
    const entry = spend.booked(row);
    if (entry) host.allowance.booked(entry);
  };
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
  return { manager, get host() { return host; }, book, settle, restart: () => { host = make(); } };
}

describe("free re-runs after an update was rolled back", () => {
  it("runs each failed run's routine again once, past a used-up allowance, uncharged, and marks it on the strip", async () => {
    const h = harness();
    const routine = h.manager.create({ name: "Digest", prompt: "Write it.", botId: "b", schedule: { type: "daily", time: "08:00", weekdays: [1, 2, 3, 4, 5] } });
    const failed = h.manager.runNow(routine.id)!;
    await h.manager.tick();
    h.manager.failThread(h.manager.listRuns().find((run) => run.id === failed.id)!.threadId!, "the bad version crashed");
    await h.settle();
    h.host.allowance.setWeekly(1);
    h.book(1);
    expect(h.host.allowance.over()).toBe(true);

    const [rerun] = h.host.rerunFree([failed.id, failed.id, "unknown"]);
    expect(rerun).toBeDefined();
    expect(h.host.rerunFree([])).toEqual([]);
    await h.manager.tick();
    await h.settle();
    const started = h.manager.listRuns().find((run) => run.id === rerun);
    expect(started?.status).toBe("running");
    h.book(0.5, rerun, routine.id);
    expect(h.host.allowance.report()).toMatchObject({ spentUsd: 1, overrunUsd: 0 });
    h.manager.handleRuntimeEvent({ type: "turn.completed", threadId: started!.threadId!, ok: true, stopReason: "end_turn" } as never);
    h.restart();
    const strip = h.manager.listRoutines().find((one) => one.id === routine.id)!.strip!;
    expect(strip.map((entry) => [entry.outcome, entry.rerun ?? false])).toEqual([["failed", false], ["ok", true]]);
    // an ordinary run still waits for the allowance
    const ordinary = h.manager.runNow(routine.id)!;
    await h.manager.tick();
    await h.settle();
    expect(h.manager.listRuns().find((run) => run.id === ordinary.id)?.status).toBe("missed");
    expect(h.host.limitSkipped(ordinary.id)).toBe(true);
    expect(h.manager.listRoutines().find((one) => one.id === routine.id)!.strip!.at(-1)).toMatchObject({ outcome: "skipped" });
  });

  it("lists what skips before the reset, each routine once, in order", () => {
    const routine = (id: string, nextRunAt: number | null, enabled = true) => ({ id, name: id, enabled, nextRunAt, schedule: { type: "once", at: nextRunAt ?? 0 } }) as never;
    expect(upcomingRuns([routine("b", 300), routine("a", 200), routine("off", 100, false), routine("later", 900), routine("none", null)], 0, 500))
      .toEqual([{ routineId: "a", name: "a", at: 200 }, { routineId: "b", name: "b", at: 300 }]);
  });
});
