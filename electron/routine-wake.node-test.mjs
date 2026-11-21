import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createRoutineWakeHold, rememberRoutineWake, routineWakeDecision, routineWakeSettings } from "./routine-wake.mjs";

test("the hold is on only when enabled, plugged in, and the server says a routine is due or running", () => {
  const due = { hold: true, reason: "due", at: 1_700_000_000_000 };
  assert.deepEqual(routineWakeDecision({ enabled: true, onBattery: false, status: due }), { hold: true, reason: "due", at: 1_700_000_000_000 });
  assert.deepEqual(routineWakeDecision({ enabled: true, onBattery: false, status: { hold: true, reason: "running" } }), { hold: true, reason: "running", at: null });
  assert.deepEqual(routineWakeDecision({ enabled: true, onBattery: false, status: { hold: false } }), { hold: false, reason: "idle", at: null });
  assert.deepEqual(routineWakeDecision({ enabled: true, onBattery: false, status: null }), { hold: false, reason: "idle", at: null });
  assert.deepEqual(routineWakeDecision({ enabled: true, onBattery: true, status: due }), { hold: false, reason: "battery", at: null });
  assert.deepEqual(routineWakeDecision({ enabled: false, onBattery: false, status: due }), { hold: false, reason: "off", at: null });
});

test("the toggle is on until switched off, and survives a reread", () => {
  const dir = mkdtempSync(join(tmpdir(), "madani-routine-wake-"));
  try {
    assert.deepEqual(routineWakeSettings(dir), { keepAwake: true });
    rememberRoutineWake(dir, false);
    assert.deepEqual(routineWakeSettings(dir), { keepAwake: false });
    rememberRoutineWake(dir, true);
    assert.deepEqual(routineWakeSettings(dir), { keepAwake: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one assertion is taken while a hold is warranted and released when it is not, or on stop", async () => {
  const calls = [];
  let nextId = 1;
  const started = new Set();
  const blocker = {
    start(type) { const id = nextId++; started.add(id); calls.push(["start", type, id]); return id; },
    stop(id) { started.delete(id); calls.push(["stop", id]); },
    isStarted: (id) => started.has(id),
  };
  let status = { hold: true, reason: "due", at: 42 };
  let onBattery = false;
  let keepAwake = true;
  const hold = createRoutineWakeHold({
    fetchStatus: async () => status,
    isOnBattery: () => onBattery,
    blocker,
    settings: () => ({ keepAwake }),
    log() {},
    pollMs: 60_000,
  });

  assert.deepEqual(await hold.poll(), { hold: true, reason: "due", at: 42, keepAwake: true, onBattery: false });
  assert.equal(hold.holding(), true);
  await hold.poll();
  assert.deepEqual(calls, [["start", "prevent-app-suspension", 1]]);

  onBattery = true;
  assert.equal((await hold.poll()).reason, "battery");
  assert.equal(hold.holding(), false);
  onBattery = false;
  await hold.poll();
  assert.equal(hold.holding(), true);

  status = null;
  assert.equal((await hold.poll()).reason, "idle");
  assert.equal(hold.holding(), false);
  status = { hold: true, reason: "running" };
  keepAwake = false;
  assert.equal((await hold.poll()).reason, "off");
  assert.equal(hold.holding(), false);

  keepAwake = true;
  await hold.poll();
  assert.equal(hold.holding(), true);
  hold.stop();
  assert.equal(hold.holding(), false);
  assert.deepEqual(calls.at(-1), ["stop", 3]);
});

test("after a wake the server hears resume, then online once the network reads online twice in a row", async () => {
  const { watchWake } = await import("./routine-wake.mjs");
  const listeners = {};
  const told = [];
  const reads = [false, true, false, true, true];
  const wake = watchWake({
    powerMonitor: { on: (event, listener) => { listeners[event] = listener; } },
    isOnline: () => reads.shift() ?? true,
    notify: async (event) => { told.push(event); },
    onlinePollMs: 5,
    log: () => {},
  });
  wake.watch();
  wake.watch();
  listeners.suspend();
  listeners.resume();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(told, ["suspend", "resume", "online"]);
  assert.equal(reads.length, 0);
});

test("routines go ahead without the network after the wait, and a later sleep cancels a pending wait", async () => {
  const { watchWake } = await import("./routine-wake.mjs");
  const listeners = {};
  const told = [];
  const lines = [];
  const wake = watchWake({
    powerMonitor: { on: (event, listener) => { listeners[event] = listener; } },
    isOnline: () => false,
    notify: async (event) => { told.push(event); },
    onlinePollMs: 5,
    onlineWaitMs: 40,
    log: (line) => lines.push(line),
  });
  wake.watch();
  listeners.resume();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(told, ["resume", "online"]);
  assert.match(lines.join("\n"), /no network \d+ s after waking; routines go ahead/);
  told.length = 0;
  listeners.resume();
  await new Promise((resolve) => setTimeout(resolve, 10));
  listeners.suspend();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(told, ["resume", "suspend"]);
});

test("a server that does not answer is asked again, and the wait goes on", async () => {
  const { watchWake } = await import("./routine-wake.mjs");
  const listeners = {};
  let failures = 1;
  const told = [];
  const wake = watchWake({
    powerMonitor: { on: (event, listener) => { listeners[event] = listener; } },
    isOnline: () => true,
    notify: async (event) => { if (failures-- > 0) throw new Error("starting"); told.push(event); },
    onlinePollMs: 5,
    log: () => {},
  });
  wake.watch();
  listeners.resume();
  await new Promise((resolve) => setTimeout(resolve, 1_300));
  assert.deepEqual(told, ["resume", "online"]);
});
