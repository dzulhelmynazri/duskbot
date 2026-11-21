import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BOX_SCRATCH_SCRIPT, BoxDiskNotes, boxScratchArgs, clearBoxScratch, parseBoxScratch } from "./box-scratch.ts";

const DAY_MS = 24 * 60 * 60_000;
const gnuFind = spawnSync("find", [".", "-maxdepth", "0", "-printf", "%p"], { encoding: "utf8" }).stdout === ".";

const homes: string[] = [];
function box(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "madani-box-home-")));
  homes.push(home);
  return home;
}
function file(path: string, ageMs = 0): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x");
  const at = new Date(Date.now() - ageMs);
  utimesSync(path, at, at);
  return path;
}
/** The script exactly as a desktop runs it, with its home moved into a temporary folder. */
function run(home: string, mode: "turn" | "sweep", limit = 100): string {
  return execFileSync("bash", ["-c", BOX_SCRATCH_SCRIPT.replaceAll("/home/cua", home), "madani-scratch", mode, String(limit)], { encoding: "utf8" });
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe("boxScratchArgs", () => {
  it("runs the fixed script as the desktop user, with only the mode and limit as arguments", () => {
    const args = boxScratchArgs("my-vps", "madani-vps-bot-1-abc", "turn");
    expect(args.slice(0, 2)).toEqual(["-H", "ssh://my-vps"]);
    expect(args.slice(2, 7)).toEqual(["exec", "-u", "cua", "madani-vps-bot-1-abc", "bash"]);
    expect(args.slice(-4)).toEqual([BOX_SCRATCH_SCRIPT, "madani-scratch", "turn", "80"]);
  });

  it("refuses a container reference that is not a plain name or id", () => {
    for (const bad of ["", "-rf", "a b", "a;rm", "../x"]) expect(() => boxScratchArgs("my-vps", bad, "sweep")).toThrow();
  });
});

describe("clearBoxScratch", () => {
  it("reads the disk line, and treats an unreachable desktop as nothing to clear", async () => {
    expect(parseBoxScratch("disk 83 full\n")).toEqual({ usedPercent: 83, full: true });
    expect(parseBoxScratch("noise\ndisk 41 ok\n")).toEqual({ usedPercent: 41, full: false });
    expect(parseBoxScratch("")).toBeNull();
    expect(await clearBoxScratch(async () => ({ stdout: "disk 12 ok\n" }), "my-vps", "box", "sweep")).toEqual({ usedPercent: 12, full: false });
    expect(await clearBoxScratch(async () => { throw new Error("is not running"); }, "my-vps", "box", "turn")).toBeNull();
  });

  it("keeps a calm note only while the desktop is still full", () => {
    const notes = new BoxDiskNotes();
    notes.record("bot-1", { usedPercent: 91, full: true });
    expect(notes.note("bot-1")).toMatch(/nearly out of disk space/);
    expect(notes.note("bot-1")).not.toMatch(/—/);
    notes.record("bot-1", null);
    expect(notes.note("bot-1")).not.toBe("");
    notes.record("bot-1", { usedPercent: 60, full: false });
    expect(notes.note("bot-1")).toBe("");
  });
});

describe("the desktop's scratch script", () => {
  it("empties the scratch folder at a turn's end and touches nothing else", () => {
    const home = box();
    const shot = file(join(home, "scratch", "shot.png"));
    const recording = file(join(home, "scratch", "rec", "screen.mp4"));
    const report = file(join(home, "workspace", "report.pdf"), 3 * DAY_MS);
    const download = file(join(home, "Downloads", "invoice.pdf"), 3 * DAY_MS);
    const dump = file(join(home, ".config", "chromium", "Crash Reports", "pending", "fresh.dmp"));
    symlinkSync(report, join(home, "scratch", "linked-report.pdf"));
    expect(parseBoxScratch(run(home, "turn"))?.full).toBe(false);
    expect(existsSync(shot)).toBe(false);
    expect(existsSync(recording)).toBe(false);
    expect(existsSync(join(home, "scratch", "linked-report.pdf"))).toBe(false);
    expect(existsSync(join(home, "scratch"))).toBe(true);
    expect(existsSync(report)).toBe(true);
    expect(existsSync(download)).toBe(true);
    expect(existsSync(dump)).toBe(true);
  });

  it("sweeps only day-old scratch and crash dumps", () => {
    const home = box();
    const old = file(join(home, "scratch", "old.png"), DAY_MS + 5 * 60_000);
    const fresh = file(join(home, "scratch", "fresh.png"));
    const oldDump = file(join(home, ".config", "chromium", "Crash Reports", "old.dmp"), DAY_MS + 5 * 60_000);
    const screenDump = file(join(home, ".config", "omb", "screens", "a".repeat(64), "chromium", "Crash Reports", "old.dmp"), DAY_MS + 5 * 60_000);
    const report = file(join(home, "workspace", "old-report.pdf"), 30 * DAY_MS);
    run(home, "sweep");
    expect(existsSync(old)).toBe(false);
    expect(existsSync(oldDump)).toBe(false);
    expect(existsSync(screenDump)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(report)).toBe(true);
  });

  it("leaves a scratch folder alone when it is a link somewhere else", () => {
    const home = box();
    const report = file(join(home, "workspace", "report.pdf"), 3 * DAY_MS);
    symlinkSync(join(home, "workspace"), join(home, "scratch"));
    run(home, "turn");
    expect(existsSync(report)).toBe(true);
  });

  it.runIf(gnuFind)("over the disk limit, clears the oldest scratch and reports the disk still full when that is not enough", () => {
    const home = box();
    const old = file(join(home, "scratch", "old.png"), 60_000);
    const report = file(join(home, "workspace", "report.pdf"), 3 * DAY_MS);
    const result = parseBoxScratch(run(home, "sweep", 0));
    expect(existsSync(old)).toBe(false);
    expect(existsSync(report)).toBe(true);
    expect(result?.full).toBe(true);
  });
});
