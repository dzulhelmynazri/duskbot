import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEvent } from "../shared/runtime-events.ts";
import { RoutineManager, RoutineScheduleError, type RoutineManagerOptions } from "./routines.ts";

const MINUTE = 60_000;
const START = Date.parse("2026-11-07T08:00:00Z");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "madani-routine-concurrency-"));
  dirs.push(directory);
  let now = START;
  let task = 0;
  const starts: string[] = [];
  const interrupted = vi.fn(async () => {});
  const options: RoutineManagerOptions = {
    file: join(directory, "routines.json"), now: () => now,
    botState: () => "ready", createTask: () => ({ threadId: `thread-${++task}` }),
    startTurn: async (_bot, threadId) => { starts.push(threadId); }, interruptTurn: interrupted,
  };
  const manager = new RoutineManager(options);
  const event = (body: Omit<RuntimeEvent, "eventId" | "provider" | "threadId" | "createdAt">) => manager.handleRuntimeEvent({ eventId: "fixture", provider: "fake", threadId: "thread-1", createdAt: new Date(now).toISOString(), ...body } as RuntimeEvent);
  const open = (requestId: string | undefined, summary = requestId ?? "legacy action") => event({ type: "request.opened", requestId, requestType: "permission", tool: "shell", summary } as Parameters<typeof event>[0]);
  const resolve = (requestId: string, source: "user" | "timeout" = "user") => event({ type: "request.resolved", requestId, source, behavior: source === "user" ? "allow" : "deny" } as Parameters<typeof event>[0]);
  const routine = (botId = "fixture-bot") => manager.create({ name: "Fixture work", prompt: "Do fixture work", botId, timeoutMinutes: 10, schedule: { type: "daily", time: "23:59", weekdays: [6] } });
  const start = async () => { const created = routine(); manager.runNow(created.id); await manager.tick(); return manager.listRuns()[0]!; };
  return { manager, options, starts, interrupted, open, resolve, routine, start, at: (minutes: number) => { now = START + minutes * MINUTE; } };
}

describe("routine approvals during parallel tool calls", () => {
  it("ignores another request's resolution and duplicate openings while the original approval still waits", async () => {
    const h = fixture(); await h.start();
    h.at(1); h.open("first", "approve fixture action");
    h.at(2); h.open("first", "duplicate event");
    const before = h.manager.listRuns()[0]!;
    const saved = readFileSync(h.options.file!, "utf8");
    h.at(3);
    expect(h.resolve("unknown")).toBeNull();
    expect(h.manager.listRuns()[0]).toEqual(before);
    expect(readFileSync(h.options.file!, "utf8")).toBe(saved);
    expect(before.attention).toContain("approve fixture action");
  });

  it.each(["first", "second"])("keeps waiting when %s resolves first and counts the overlapping wait only once", async (firstToResolve) => {
    const h = fixture(); await h.start();
    h.at(1); h.open("first");
    h.at(2); h.open("second");
    h.at(3); h.resolve(firstToResolve);
    const remaining = firstToResolve === "first" ? "second" : "first";
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "waiting", asked: { requestId: remaining, since: START + MINUTE } });
    expect(h.manager.listRuns()[0].attention).toContain(remaining);
    h.at(5); h.resolve(remaining);
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "running", waitedMs: 4 * MINUTE });
    expect(h.manager.listRuns()[0]).not.toHaveProperty("asked");
    h.at(13); await h.manager.tick();
    expect(h.manager.listRuns()[0].status).toBe("running");
    h.at(14); await h.manager.tick();
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "failed", error: "Stopped after reaching the 10-minute run limit" });
    expect(h.interrupted).toHaveBeenCalledTimes(1);
  });

  it("stops when any concurrent approval times out and never revives it on late answers", async () => {
    const h = fixture(); await h.start();
    h.at(1); h.open("first"); h.open("second");
    h.at(2); h.resolve("second", "timeout");
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "failed", error: "Stopped: nobody answered the approval to run “second”" });
    expect(h.resolve("first")).toBeNull();
    expect(h.manager.listRuns()[0].status).toBe("failed");
    expect(h.interrupted).toHaveBeenCalledTimes(1);
  });

  it("cancels a run with several open approvals once and ignores both late answers", async () => {
    const h = fixture(); const run = await h.start();
    h.open("first"); h.open("second");
    expect(await h.manager.cancelRun(run.id)).toMatchObject({ status: "cancelled" });
    expect(h.resolve("second")).toBeNull();
    expect(h.resolve("first")).toBeNull();
    expect(h.manager.listRuns()).toHaveLength(1);
    expect(h.manager.listRuns()[0].status).toBe("cancelled");
    expect(h.interrupted).toHaveBeenCalledTimes(1);
  });

  it("clears every old approval on restart and preserves exactly one interrupted run", async () => {
    const h = fixture(); const run = await h.start();
    h.at(1); h.open("first"); h.open("second");
    h.at(3);
    const rebooted = new RoutineManager(h.options);
    expect(rebooted.listRuns()).toHaveLength(1);
    expect(rebooted.listRuns()[0]).toMatchObject({ id: run.id, status: "queued", retried: "restarted", waitedMs: 2 * MINUTE });
    expect(rebooted.listRuns()[0]).not.toHaveProperty("asked");
    h.at(4); await rebooted.tick(); await rebooted.tick();
    expect(h.starts).toEqual(["thread-1", "thread-1"]);
    expect(rebooted.listRuns()).toHaveLength(1);
    rebooted.close();
  });

  it("keeps legacy requests without native IDs compatible and ignores malformed persisted pending lists", async () => {
    const h = fixture(); await h.start();
    h.at(1); h.open(undefined);
    h.at(3); h.resolve("native-answer-id");
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "running", waitedMs: 2 * MINUTE });
    h.open("next");
    const disk = JSON.parse(readFileSync(h.options.file!, "utf8"));
    disk.runs[0].asked.pending = { malformed: true };
    writeFileSync(h.options.file!, JSON.stringify(disk));
    const rebooted = new RoutineManager(h.options);
    expect(rebooted.listRuns()[0]).toMatchObject({ status: "queued", retried: "restarted" });
    expect(rebooted.listRuns()[0]).not.toHaveProperty("asked");
    rebooted.close();
  });

  it("keeps returned approval snapshots from changing the live requests or rollback state", async () => {
    const h = fixture(); await h.start();
    h.open("first"); h.open("second");
    const snapshot = h.manager.listRuns()[0]!;
    snapshot.asked!.pending![0]!.requestId = "changed-outside";
    h.resolve("first");
    expect(h.manager.listRuns()[0]).toMatchObject({ status: "waiting", asked: { requestId: "second" } });
    h.resolve("second");
    expect(h.manager.listRuns()[0].status).toBe("running");
  });

  it("starts independent bots once under overlapping scheduler ticks without sharing their tasks", async () => {
    const h = fixture();
    const first = h.routine("first-bot"), second = h.routine("second-bot");
    h.manager.runNow(first.id); h.manager.runNow(second.id);
    await Promise.all([h.manager.tick(), h.manager.tick()]);
    expect(h.starts).toEqual(["thread-1", "thread-2"]);
    expect(h.manager.listRuns().map((run) => run.status)).toEqual(["running", "running"]);
    expect(h.manager.listRuns().map((run) => run.botId).sort()).toEqual(["first-bot", "second-bot"]);
  });
});

describe("one-time timestamp bounds", () => {
  it("rejects unrepresentable and fractional dates atomically instead of keeping an enabled routine that can never run", () => {
    const h = fixture(); h.routine();
    const before = readFileSync(h.options.file!, "utf8");
    for (const at of [8_640_000_000_000_001, Number.MAX_VALUE, -1, START + 0.5]) {
      expect(() => h.manager.create({ name: "Invalid date", prompt: "Do not dispatch", botId: "fixture-bot", schedule: { type: "once", at } })).toThrow(RoutineScheduleError);
      expect(readFileSync(h.options.file!, "utf8")).toBe(before);
    }
  });
});
