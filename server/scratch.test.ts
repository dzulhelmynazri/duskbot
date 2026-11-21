import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { guardDisk, listScratch, ScratchLedger, SCRATCH_MAX_AGE_MS, sweepScratch } from "./scratch.ts";

const made: string[] = [];
function place(): { root: string; scratch: string; outside: string } {
  const root = mkdtempSync(join(tmpdir(), "madani-scratch-"));
  made.push(root);
  const scratch = join(root, "browser", "screenshots");
  const outside = join(root, "workspace");
  mkdirSync(scratch, { recursive: true });
  mkdirSync(outside, { recursive: true });
  return { root, scratch, outside };
}
function file(path: string, ageMs = 0, now = Date.now()): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x");
  const at = new Date(now - ageMs);
  utimesSync(path, at, at);
  return path;
}
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("ScratchLedger", () => {
  it("deletes what a holder marked once it lets go, and nothing another holder marked", () => {
    const { scratch } = place();
    const ledger = new ScratchLedger([scratch]);
    const mine = file(join(scratch, "a", "shot-1.png"));
    const theirs = file(join(scratch, "b", "shot-2.png"));
    expect(ledger.mark("browser:bot-a", mine)).toBe(true);
    expect(ledger.mark("browser:bot-b", theirs)).toBe(true);
    expect(ledger.inUse(mine)).toBe(true);
    expect(ledger.release("browser:bot-a")).toBe(1);
    expect(existsSync(mine)).toBe(false);
    expect(existsSync(theirs)).toBe(true);
    expect(ledger.inUse(mine)).toBe(false);
    expect(ledger.release("browser:bot-a")).toBe(0);
  });

  it("never tracks a path outside its scratch roots, the root itself, or an escape through ..", () => {
    const { scratch, outside } = place();
    const ledger = new ScratchLedger([scratch]);
    const report = file(join(outside, "report.pdf"));
    expect(ledger.mark("t", report)).toBe(false);
    expect(ledger.mark("t", scratch)).toBe(false);
    expect(ledger.mark("t", join(scratch, "..", "..", "workspace", "report.pdf"))).toBe(false);
    ledger.release("t");
    expect(existsSync(report)).toBe(true);
  });

  it("removes a link it marked as a link, never the file it points at", () => {
    const { scratch, outside } = place();
    const report = file(join(outside, "report.pdf"));
    const link = join(scratch, "report.pdf");
    symlinkSync(report, link);
    const ledger = new ScratchLedger([scratch]);
    ledger.mark("t", link);
    ledger.release("t");
    expect(existsSync(report)).toBe(true);
    expect(readFileSync(report, "utf8")).toBe("x");
  });
});

describe("sweepScratch", () => {
  it("deletes scratch a day old and keeps newer scratch, the root and everything outside it", () => {
    const { scratch, outside } = place();
    const now = Date.now();
    const old = file(join(scratch, "h1", "old.png"), SCRATCH_MAX_AGE_MS + 60_000, now);
    const fresh = file(join(scratch, "h2", "fresh.png"), 60_000, now);
    const work = file(join(outside, "old-report.pdf"), 30 * SCRATCH_MAX_AGE_MS, now);
    expect(sweepScratch([scratch], { now })).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(join(scratch, "h1"))).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(scratch)).toBe(true);
    expect(existsSync(work)).toBe(true);
  });

  it("does not walk into a linked folder, or a root that is itself a link", () => {
    const { root, scratch, outside } = place();
    const work = file(join(outside, "old.pdf"), 30 * SCRATCH_MAX_AGE_MS);
    symlinkSync(outside, join(scratch, "linked"));
    const linkedRoot = join(root, "linked-root");
    symlinkSync(outside, linkedRoot);
    sweepScratch([scratch, linkedRoot]);
    expect(listScratch([linkedRoot])).toEqual([]);
    expect(existsSync(work)).toBe(true);
  });
});

describe("guardDisk", () => {
  it("does nothing while the disk is under the limit", () => {
    const { scratch } = place();
    const shot = file(join(scratch, "a.png"));
    expect(guardDisk([scratch], () => 79)).toEqual({ removed: 0, full: false });
    expect(existsSync(shot)).toBe(true);
  });

  it("clears the oldest scratch first and stops once the disk is under the limit", () => {
    const { scratch } = place();
    const now = Date.now();
    const oldest = file(join(scratch, "1.png"), 3_000, now);
    const middle = file(join(scratch, "2.png"), 2_000, now);
    const newest = file(join(scratch, "3.png"), 1_000, now);
    expect(guardDisk([scratch], () => (existsSync(middle) ? 90 : 70), { limit: 80 })).toEqual({ removed: 2, full: false });
    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(middle)).toBe(false);
    expect(existsSync(newest)).toBe(true);
  });

  it("says the disk is still full when all scratch is gone and it is still over the limit", () => {
    const { scratch } = place();
    file(join(scratch, "1.png"));
    file(join(scratch, "2.png"));
    expect(guardDisk([scratch], () => 90, { limit: 80 })).toEqual({ removed: 2, full: true });
  });

  it("never deletes what a running turn still holds, and says the disk is still full", () => {
    const { scratch } = place();
    const ledger = new ScratchLedger([scratch]);
    const held = file(join(scratch, "held.png"), 5_000);
    const loose = file(join(scratch, "loose.png"), 1_000);
    ledger.mark("browser:bot-a", held);
    expect(guardDisk([scratch], () => 95, { keep: (path) => ledger.inUse(path) })).toEqual({ removed: 1, full: true });
    expect(existsSync(held)).toBe(true);
    expect(existsSync(loose)).toBe(false);
  });
});
