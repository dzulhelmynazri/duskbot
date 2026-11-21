import assert from "node:assert/strict";
import test from "node:test";

import { FOCUS_CAP_MS, FOCUS_PING_MS, createCloudFocus } from "./cloud-focus.mjs";

const CLOUD = "https://d0123456789abcdef0123.desktops.example.test";

function harness({ origin = CLOUD } = {}) {
  const h = { clock: 1_000_000, focused: true, origin, input: 0, sent: [], ticks: null };
  h.focus = createCloudFocus({ origin: () => h.origin, focused: () => h.focused, lastInput: () => h.input, now: () => h.clock,
    fetch: async (url, init) => { h.sent.push({ url, method: init.method, background: init.headers["x-madani-background"], credentials: init.credentials }); return new Response(null, { status: 200 }); },
    every: (work) => { h.ticks = work; return 1; }, stop: () => {} });
  h.settle = () => new Promise((resolve) => setImmediate(resolve));
  return h;
}

test("a focused window on My Cloud pings every 4 minutes, as a background call", async () => {
  const h = harness();
  assert.equal(h.focus.check(), true);
  await h.settle();
  assert.deepEqual(h.sent, [{ url: `${CLOUD}/api/cloud/focus`, method: "POST", background: "1", credentials: "include" }]);
  h.clock += FOCUS_PING_MS - 1; h.ticks(); await h.settle();
  assert.equal(h.sent.length, 1);
  h.clock += 1; h.ticks(); await h.settle();
  assert.equal(h.sent.length, 2);
});

test("no ping without focus, without My Cloud's page, or while it sleeps (origin null)", async () => {
  const h = harness();
  h.focused = false;
  assert.equal(h.focus.check(), false);
  h.focused = true; h.origin = null;
  assert.equal(h.focus.check(), false);
  await h.settle();
  assert.deepEqual(h.sent, []);
});

test("capped 30 minutes after the later of the focus starting and the last input", async () => {
  const h = harness();
  h.focus.check(); await h.settle();
  for (let at = FOCUS_PING_MS; at < FOCUS_CAP_MS; at += FOCUS_PING_MS) { h.clock += FOCUS_PING_MS; h.ticks(); await h.settle(); }
  const capped = h.sent.length;
  h.clock += FOCUS_PING_MS; h.ticks(); await h.settle();
  assert.equal(h.sent.length, capped, "a window left focused and untouched stops pinging");
  h.input = h.clock;
  h.ticks(); await h.settle();
  assert.equal(h.sent.length, capped + 1, "the person's input starts the cap again");
  // focus lost and regained: a new run, pinged at once
  h.focused = false; h.ticks();
  h.clock += 60_000; h.focused = true;
  assert.equal(h.focus.check(), false, "pinged within the last 4 minutes");
  h.clock += FOCUS_PING_MS; assert.equal(h.focus.check(), true);
});
