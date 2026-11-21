import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RoutineManager } from "./routines.ts";
import { LOST_RESUME_MS, WakeGate } from "./wake-gate.ts";

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the wake gate", () => {
  it("holds from sleep or wake until the desktop says the network is back, and says so in the log", () => {
    const released = vi.fn();
    const lines: string[] = [];
    const gate = new WakeGate({ onRelease: released, log: (line) => lines.push(line) });
    expect(gate.held()).toBe(false);
    gate.note("online");
    expect(released).not.toHaveBeenCalled();
    gate.note("suspend");
    gate.note("resume");
    expect(gate.held()).toBe(true);
    gate.note("online");
    expect(gate.held()).toBe(false);
    expect(released).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([
      "routines: held while this computer sleeps",
      "routines: held until this computer is back on the network",
      expect.stringMatching(/^routines: released after \d+ s awake \(the network is back\)$/),
    ]);
    gate.stop();
  });

  it("lets go by itself when no word comes after a wake", () => {
    vi.useFakeTimers();
    const released = vi.fn();
    const gate = new WakeGate({ onRelease: released });
    gate.note("resume");
    vi.advanceTimersByTime(LOST_RESUME_MS - 1);
    expect(gate.held()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(gate.held()).toBe(false);
    expect(released).toHaveBeenCalledTimes(1);
  });

  it("takes only the three events", () => {
    const gate = new WakeGate({ onRelease: () => {} });
    expect(gate.answer({ event: "resume" })).toEqual({ status: 200, body: { held: true } });
    expect(gate.answer({ event: "online" })).toEqual({ status: 200, body: { held: false } });
    expect(gate.answer({ event: "reboot" }).status).toBe(400);
    expect(gate.answer({ event: "resume", extra: 1 }).status).toBe(400);
    expect(gate.answer(null).status).toBe(400);
    gate.stop();
  });
});

describe("routines due while the computer slept", () => {
  it("wait until the network is back after a wake, then each runs once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "madani-wake-gate-"));
    dirs.push(dir);
    const start = Date.parse("2026-09-13T08:00:00Z");
    let now = start;
    const started: string[] = [];
    const gate = new WakeGate({ onRelease: () => manager.lookAgain() });
    const manager: RoutineManager = new RoutineManager({
      file: join(dir, "routines.json"),
      now: () => now,
      botState: () => "ready",
      createTask: () => ({ threadId: `thread-${started.length + 1}` }),
      startTurn: async (_botId, threadId) => { started.push(threadId); },
      heldAfterWake: () => gate.held(),
    });
    manager.create({ name: "Hourly digest", prompt: "Summarise", botId: "maus-1", schedule: { type: "interval", everyMinutes: 60, anchorAt: start + 60_000 } });

    gate.note("suspend");
    now = start + 5 * 60 * 60_000;
    gate.note("resume");
    await manager.tick();
    await manager.tick();
    expect(started).toEqual([]);
    expect(manager.listRuns()).toEqual([]);

    gate.note("online");
    await manager.tick();
    await manager.tick();
    expect(started).toHaveLength(1);
    expect(manager.listRuns()).toHaveLength(1);
    gate.stop();
    manager.close();
  });
});
