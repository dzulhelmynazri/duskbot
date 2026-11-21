import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RoutineManager } from "../routines.ts";
import { createRoutineHoldsHost, ROUTINE_HOLD_LINES } from "./routine-holds-host.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const START = Date.parse("2026-10-30T06:00:00Z");
const HOUR = 60 * 60_000;
type Line = { threadId: string; name: string; signIn?: true };
const IN = { ready: true, signedIn: true }, OUT = { ready: false, signedIn: false };

/** A Cloud home's routines and bots: the owner's Chief, a teammate's later one, and a bot that is no Chief. */
function world(dataDir?: string) {
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), "madani-routine-holds-host-"));
  if (!dataDir) dirs.push(dir);
  let now = START;
  let mcp = 0;
  let apps: boolean | null = true;
  const lines: Line[] = [];
  const routines = new RoutineManager({ file: join(dir, "routines.json"), now: () => now, botState: () => "ready", createTask: () => ({ threadId: "run" }), startTurn: async () => {} });
  const bots = [
    { id: "ops", name: "Ops", threadId: "ops-main", createdAt: 1 },
    { id: "chief-2", name: "Second", threadId: "chief-2-main", createdAt: 3, chiefOfStaff: true },
    { id: "chief", name: "Madani", threadId: "chief-main", createdAt: 2, chiefOfStaff: true, defaultBot: {} },
  ];
  const host = createRoutineHoldsHost({
    dataDir: dir, now: () => now,
    store: { bots, appendMessage: (threadId: string, message: { tool?: { name: string; signIn?: boolean } }) => { lines.push({ threadId, name: message.tool!.name, ...(message.tool!.signIn ? { signIn: true } : {}) }); return {}; } } as never,
    mcpServers: () => mcp, appsConnected: async () => apps,
  });
  const routine = routines.create({ name: "Clarity export", prompt: "Export Clarity", botId: "ops", schedule: { type: "interval", everyMinutes: 60, anchorAt: START + HOUR } });
  const state = () => routines.listRoutines().find((candidate) => candidate.id === routine.id)!;
  return {
    dir, host, routines, lines, state,
    make: () => host.attach(routines),
    setMcp: (count: number) => { mcp = count; }, setApps: (value: boolean | null) => { apps = value; },
    advance: (ms: number) => { now += ms; },
  };
}

describe("a Cloud home's routines wait while the owner has left", () => {
  it("pauses when none of the owner's AI is signed in any more, with one quiet line in the owner's Chief's chat, and comes back on sign-in", () => {
    const w = world();
    w.make();
    w.host.engines(OUT);
    expect(w.state().enabled).toBe(true);
    w.host.engines(IN);
    w.host.engines(OUT);
    expect(w.state()).toMatchObject({ enabled: false, heldFor: "no_engine" });
    expect(w.lines, "one short line, with Sign in beside it").toEqual([{ threadId: "chief-main", name: "notice: Routines are paused. Sign in to your AI to turn them back on.", signIn: true }]);
    // Read again and again while signed out: nothing more is said.
    w.host.engines(OUT);
    w.host.engines(OUT);
    expect(w.lines).toHaveLength(1);
    w.host.engines(IN);
    expect(w.state()).toMatchObject({ enabled: true });
    expect(w.state().heldFor).toBeUndefined();
    expect(w.lines).toHaveLength(1);
  });

  it("pauses while the plan is cancelled and keeps that across a restart, before the engines are read again", () => {
    const w = world();
    w.make();
    w.host.engines(IN);
    w.host.plan(true);
    expect(w.state()).toMatchObject({ enabled: false, heldFor: "plan_cancelled" });
    expect(w.lines.map((line) => line.name)).toEqual([`notice: ${ROUTINE_HOLD_LINES.plan_cancelled}`]);
    expect(JSON.parse(readFileSync(join(w.dir, "routine-holds.json"), "utf8"))).toEqual({ hadOwn: true, planCancelled: true });

    const again = world(w.dir);
    again.make();
    again.host.review();
    expect(again.host.causes()).toEqual(["plan_cancelled"]);
    expect(again.lines).toEqual([]);
    again.host.plan(false);
    expect(again.routines.listRoutines().every((routine) => routine.enabled)).toBe(true);
  });

  it("remembers what it read before the routines exist and applies it once they do", () => {
    const w = world();
    w.host.engines(IN);
    w.host.engines(OUT);
    expect(w.state().enabled).toBe(true);
    w.make();
    w.host.review();
    expect(w.state()).toMatchObject({ enabled: false, heldFor: "no_engine" });
    expect(w.lines).toHaveLength(1);
  });

  it("pauses once the last connected app or server is removed, never on a guess, and resumes when one is added", async () => {
    const w = world();
    w.make();
    w.setMcp(1);
    await w.host.connections("removed");
    expect(w.state().enabled).toBe(true);
    w.setMcp(0);
    w.setApps(null);
    await w.host.connections("removed");
    expect(w.state().enabled).toBe(true);
    w.setApps(false);
    await w.host.connections("removed");
    expect(w.state()).toMatchObject({ enabled: false, heldFor: "no_connections" });
    expect(w.lines.map((line) => line.name)).toEqual([`notice: ${ROUTINE_HOLD_LINES.no_connections}`]);
    await w.host.connections("added");
    expect(w.state().enabled).toBe(true);
  });

  it("notices an app connected some other way, reading again at most every 15 minutes while none was left", async () => {
    const w = world();
    w.make();
    w.setApps(false);
    await w.host.connections("removed");
    expect(w.state().enabled).toBe(false);
    w.setApps(true);
    w.host.review();
    await new Promise((resolve) => setImmediate(resolve));
    expect(w.state().enabled).toBe(false);
    w.advance(15 * 60_000);
    w.host.review();
    await new Promise((resolve) => setImmediate(resolve));
    expect(w.state()).toMatchObject({ enabled: true });
  });
});
