import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createAccountErrors } from "./account-errors.mjs";

function setup(on = true) {
  const calls = [];
  const errors = createAccountErrors({ origin: "https://madani.bot/x", enabled: () => on, platform: "darwin", release: "25.0.0", version: "0.1.141",
    fetch: async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return new Response(null, { status: 204 }); } });
  return { errors, calls };
}

test("posts a renderer report once, without credentials, with version and os", () => {
  const { errors, calls } = setup();
  const report = { type: "TypeError", message: "x is undefined", stack: "    at a (/Users/sidd/Library/app.asar/dist/assets/i.js:1:2)", path: "/chat/42?q=secret", extra: "dropped" };
  assert.equal(errors.send(report), true);
  assert.equal(errors.send(report), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://madani.bot/v1/errors");
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(calls[0].init.headers.authorization, undefined);
  assert.deepEqual(calls[0].body, { source: "desktop", type: "TypeError", message: "x is undefined", stack: "    at a (assets/i.js:1:2)", path: "/chat/42qsecret", version: "0.1.141", os: "darwin 25.0.0" });
});

test("scrubs what a person may have typed and their home folder before it leaves", () => {
  const { errors, calls } = setup();
  errors.capture(Object.assign(new Error("cannot open \"my diary.txt\" for me@example.com"), { stack: "Error: x\n    at read (/Users/sidd/notes/app.js:3:4)" }));
  assert.doesNotMatch(JSON.stringify(calls[0].body), /diary|me@example|sidd/);
});

test("sends nothing with reports off, and at most ten an hour", () => {
  const off = setup(false);
  assert.equal(off.errors.capture(new Error("x")), false);
  assert.equal(off.calls.length, 0);
  const { errors, calls } = setup();
  for (let n = 0; n < 15; n++) errors.capture(new Error(`e${n}`));
  assert.equal(calls.length, 10);
  assert.equal(calls[0].body.source, "desktop-main");
});

test("watches the main process and page crashes", () => {
  const { errors, calls } = setup();
  const app = new EventEmitter(), proc = new EventEmitter();
  errors.watch(app, proc);
  proc.emit("uncaughtExceptionMonitor", new RangeError("bad"));
  app.emit("render-process-gone", {}, {}, { reason: "crashed", exitCode: 9 });
  app.emit("render-process-gone", {}, {}, { reason: "clean-exit", exitCode: 0 });
  assert.deepEqual(calls.map(call => call.body.message), ["bad", "page process crashed (exit 9)"]);
});

test("a gone child names its process and reads its Windows exit code", () => {
  const { errors, calls } = setup();
  const app = new EventEmitter();
  let quitting = false;
  errors.watch(app, new EventEmitter(), { ending: () => quitting, platform: "win32" });
  app.emit("child-process-gone", {}, { type: "Utility", name: "madani bot companion", reason: "crashed", exitCode: -36861 });
  app.emit("child-process-gone", {}, { type: "Utility", name: "Network Service", reason: "crashed", exitCode: -1073741819 });
  quitting = true;
  app.emit("child-process-gone", {}, { type: "GPU", reason: "crashed", exitCode: -1073740791 });
  assert.deepEqual(calls.map(call => call.body.message), [
    "Utility process madani bot companion crashed (exit -36861 0xFFFF7003)",
    "Utility process Network Service crashed (exit 0xC0000005 access violation)",
    "GPU process crashed (exit 0xC0000409 fail-fast) while quitting",
  ]);
});
