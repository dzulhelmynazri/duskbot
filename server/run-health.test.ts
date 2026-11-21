import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RUN_MARKER, stallPhase, startRunHealth, uncleanExitLine } from "./run-health.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const folder = () => { const dir = mkdtempSync(join(tmpdir(), "madani-run-health-")); dirs.push(dir); return dir; };
const T = Date.parse("2026-11-09T10:00:00Z");

describe("the run marker", () => {
  it("is there while the server runs and gone after a clean exit, so the next start says nothing", () => {
    const dataDir = folder();
    const lines: string[] = [];
    const run = startRunHealth({ dataDir, turns: () => 2, log: (line) => lines.push(line) });
    expect(JSON.parse(readFileSync(join(dataDir, RUN_MARKER), "utf8"))).toMatchObject({ pid: process.pid, turns: 2 });
    run.cleanExit();
    expect(existsSync(join(dataDir, RUN_MARKER))).toBe(false);
    startRunHealth({ dataDir, turns: () => 0, log: (line) => lines.push(line) }).cleanExit();
    expect(lines).toEqual([]);
  });

  it("left behind by a run that did not exit cleanly earns one line at the next start", () => {
    const dataDir = folder();
    startRunHealth({ dataDir, turns: () => 1, log: () => {}, now: () => T }).stop();
    const lines: string[] = [];
    const next = startRunHealth({ dataDir, turns: () => 0, log: (line) => lines.push(line), now: () => T + 5 * 60_000, bootedAt: () => T - 86_400_000 });
    expect(lines).toEqual([`run health: the last run did not exit cleanly (pid ${process.pid}, started 2026-11-09T10:00:00.000Z, last heard 2026-11-09T10:00:00.000Z, 5 min before this start; 1 turn was running)`]);
    next.cleanExit();
  });

  it("says whether the computer restarted or had slept", () => {
    const previous = { pid: 41, startedAt: T, heartbeatAt: T + 60_000, turns: 0 };
    expect(uncleanExitLine(previous, T + 3_600_000, T + 600_000)).toMatch(/; the computer restarted since\)$/);
    expect(uncleanExitLine({ ...previous, sleptAt: T + 30_000 }, T + 3_600_000, T - 1)).toMatch(/; the computer had slept \(woke 2026-11-09T10:00:30\.000Z\)\)$/);
    expect(uncleanExitLine({ ...previous, turns: 3 }, T + 120_000, T - 1)).toMatch(/1 min before this start; 3 turns were running\)$/);
  });

  it("ignores a marker it cannot read", () => {
    const dataDir = folder();
    writeFileSync(join(dataDir, RUN_MARKER), "{not json");
    const lines: string[] = [];
    startRunHealth({ dataDir, turns: () => 0, log: (line) => lines.push(line) }).cleanExit();
    expect(lines).toEqual([]);
  });
});

describe("the stall monitor", () => {
  it("tags a stall by when it happened", () => {
    expect(stallPhase(30_000, null)).toBe("startup");
    expect(stallPhase(30 * 60_000, 60_000)).toBe("resume");
    expect(stallPhase(30 * 60_000, 10 * 60_000)).toBe("first_hour");
    expect(stallPhase(3 * 3_600_000, null)).toBe("later");
  });

  it("writes one line when the main loop is held for more than a second", async () => {
    const lines: string[] = [];
    const run = startRunHealth({ dataDir: folder(), turns: () => 1, log: (line) => lines.push(line), stallCheckMs: 1_500 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const until = performance.now() + 1_200;
    while (performance.now() < until) { /* hold the loop */ }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    run.cleanExit();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^run health: the main loop stalled for 1\d{3} ms \(startup, 1 turns running\)$/);
  });
});
