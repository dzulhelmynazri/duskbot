import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createErrorReporter, parseDsn, scrubText, stackFrames } from "./error-report.mjs";
import { fileSpool } from "./error-report-spool.mjs";

const DSN = "https://abc123@errors.example.com/7";

function recorder() {
  const calls = [];
  return { calls, fetch: async (url, init) => { calls.push({ url, init }); return new Response("{}"); } };
}

test("a dsn names the envelope endpoint and its key; anything else turns reporting off", () => {
  assert.deepEqual(parseDsn(DSN), { endpoint: "https://errors.example.com/api/7/envelope/", key: "abc123" });
  assert.deepEqual(parseDsn("https://k@host.example/sub/12"), { endpoint: "https://host.example/sub/api/12/envelope/", key: "k" });
  for (const bad of [undefined, "", "not a url", "http://k@errors.example.com/7", "https://errors.example.com/7", "https://k@errors.example.com/x"]) assert.equal(parseDsn(bad), null, String(bad));
  assert.equal(createErrorReporter({ dsn: undefined, component: "server", release: "1" }).enabled, false);
  assert.equal(createErrorReporter({ dsn: DSN, component: "server", release: "1", enabled: false }).enabled, false);
});

test("scrubbing drops secrets, addresses, quoted words and personal paths", () => {
  const text = scrubText(`Request to https://api.example.com/v1?key=1 failed for jane@example.com with Bearer abc.def token=hunter2 sk-ant-api03-AAAAAAAAAAAAAAAA at /Users/jane/Library and said "please book my flight to Paris" from 10.0.0.12`);
  for (const leak of ["api.example.com", "jane@example.com", "abc.def", "hunter2", "sk-ant-api03", "/Users/jane", "Paris", "10.0.0.12"]) assert.ok(!text.includes(leak), `${leak} in ${text}`);
  assert.match(text, /\[url\].*\[email\].*Bearer \[redacted\]/);
  assert.ok(scrubText("x".repeat(500)).length <= 200);
  assert.equal(scrubText(`a ${"q".repeat(40)} b`), "a [id] b");
});

test("stack frames keep the app-relative file, never the home folder", () => {
  const frames = stackFrames("Error: x\n    at boot (/Users/jane/Applications/Madani Bot.app/Contents/Resources/app.asar/electron/main.mjs:10:5)\n    at /home/bob/srv/server/index.js:3:1\n    at fn@https://madani.bot/assets/index-abc.js:1:200");
  assert.deepEqual(frames.map(frame => frame.filename), ["assets/index-abc.js", "server/index.js", "electron/main.mjs"]);
  assert.equal(frames.at(-1).function, "boot");
  assert.ok(!JSON.stringify(frames).includes("jane") && !JSON.stringify(frames).includes("bob"));
});

test("an event carries only the error, the component and the release, and the same error is sent once an hour", async () => {
  const { calls, fetch } = recorder();
  let time = 1_000_000;
  const reporter = createErrorReporter({ dsn: DSN, component: "dashboard", release: "0.1.142", fetch, now: () => time });
  const error = new TypeError(`Cannot read "secret plan" of undefined`);
  assert.ok(reporter.capture(error, { tags: { route: "/v1/report", bad: "has spaces in it" } }));
  assert.equal(reporter.capture(error), null);
  time += 3_600_001;
  assert.ok(reporter.capture(error));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://errors.example.com/api/7/envelope/");
  assert.match(calls[0].init.headers["x-sentry-auth"], /sentry_key=abc123/);
  const event = JSON.parse(calls[0].init.body.split("\n")[2]);
  assert.deepEqual(Object.keys(event).sort(), ["environment", "event_id", "exception", "level", "platform", "release", "tags", "timestamp"]);
  assert.deepEqual(event.tags, { component: "dashboard", route: "/v1/report" });
  assert.match(event.event_id, /^[0-9a-f]{32}$/);
  assert.equal(event.exception.values[0].type, "TypeError");
  assert.equal(event.exception.values[0].value, "Cannot read [text] of undefined");
});

test("a burst is capped per minute", async () => {
  const { calls, fetch } = recorder();
  const reporter = createErrorReporter({ dsn: DSN, component: "server", release: "1", fetch, now: () => 5, maxPerMinute: 3 });
  for (let i = 0; i < 10; i++) reporter.capture(new Error(`failure kind ${String.fromCharCode(97 + i)}`));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 3);
});

test("a fatal error waits in the spool and the next run sends it", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "madani-errors-")), "spool");
  const first = recorder();
  createErrorReporter({ dsn: DSN, component: "server", release: "1", fetch: first.fetch, spool: fileSpool(path) }).capture(new Error("boom"), { level: "fatal" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(first.calls.length, 0);
  const next = recorder();
  assert.equal(createErrorReporter({ dsn: DSN, component: "server", release: "1", fetch: next.fetch, spool: fileSpool(path) }).flush(), 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(next.calls.length, 1);
  assert.equal(fileSpool(path).take().length, 0);
});

test("a failing endpoint never throws into the caller", async () => {
  const reporter = createErrorReporter({ dsn: DSN, component: "server", release: "1", fetch: () => { throw new Error("offline"); } });
  assert.doesNotThrow(() => reporter.capture(new Error("x")));
  const rejecting = createErrorReporter({ dsn: DSN, component: "server", release: "1", fetch: async () => { throw new Error("offline"); } });
  assert.doesNotThrow(() => rejecting.capture(new Error("y")));
  assert.doesNotThrow(() => rejecting.capture("a string"));
});
