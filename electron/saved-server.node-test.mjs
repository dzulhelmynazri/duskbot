import assert from "node:assert/strict";
import test from "node:test";

import { newServerReach, serverAnswers, serverAnswersWithin, serverOpens, TUNNEL_GRACE_MS, tunnelOrigin } from "./saved-server.mjs";

const office = { id: "vps", name: "pro cloud", origin: "https://madani-u-gone.fly.dev" };
const answering = (status) => async () => new Response("{}", { status });
const gone = async () => { throw new TypeError("fetch failed"); };
const asked = (responses) => {
  const shown = [];
  return { shown, dialog: { showMessageBox: async (options) => { shown.push(options); return { response: responses.shift() ?? 2 }; } } };
};

test("a server answers with any status but a proxy's 5xx; a name that doesn't resolve, a refused or a slow one doesn't", async () => {
  for (const status of [200, 401, 404]) assert.equal(await serverAnswers(office.origin, answering(status)), true, String(status));
  for (const status of [502, 503]) assert.equal(await serverAnswers(office.origin, answering(status)), false, String(status));
  assert.equal(await serverAnswers(office.origin, gone), false);
  const slow = (_url, init) => new Promise((_, fail) => init.signal.addEventListener("abort", () => fail(init.signal.reason)));
  assert.equal(await serverAnswers(office.origin, slow, 20), false, "no answer within the look");
});

test("the window goes to a server that answers without asking anything", async () => {
  const { shown, dialog } = asked([]);
  assert.equal(await serverOpens(office, { fetch: answering(200), dialog, forget: () => assert.fail("nothing to forget") }), true);
  assert.deepEqual(shown, []);
});

test("one that doesn't answer is the person's choice: Cancel stays put, Remove forgets it, Try again looks once more", async () => {
  const cancel = asked([2]);
  assert.equal(await serverOpens(office, { fetch: gone, dialog: cancel.dialog, forget: () => assert.fail("not asked to") }), false);
  assert.equal(cancel.shown[0].message, "pro cloud isn't answering");
  assert.match(cancel.shown[0].detail, /madani-u-gone\.fly\.dev/);
  assert.deepEqual(cancel.shown[0].buttons, ["Try again", "Remove from list", "Cancel"]);

  const forgotten = [];
  const remove = asked([1]);
  assert.equal(await serverOpens(office, { fetch: gone, dialog: remove.dialog, forget: (id) => forgotten.push(id) }), false);
  assert.deepEqual(forgotten, ["vps"]);

  let tries = 0;
  const back = async () => (++tries < 2 ? gone() : new Response("{}", { status: 200 }));
  const retry = asked([0]);
  assert.equal(await serverOpens(office, { fetch: back, dialog: retry.dialog, forget: () => assert.fail("not asked to") }), true, "it answered the second time");
  assert.equal(retry.shown.length, 1);
});

test("a linked vps's tunnel address is looked at quietly while its proxy opens, before anyone is asked", async () => {
  const vps = { id: "v", name: "Oracle", origin: "http://vps-ab3d7fgh2k.localhost:47811" };
  assert.equal(tunnelOrigin(vps.origin), true);
  assert.equal(tunnelOrigin(office.origin), false);
  let at = 0, looks = 0;
  const clock = { now: () => at, sleep: async (ms) => { at += ms; } };
  const opening = async () => (++looks < 4 ? gone() : new Response("{}", { status: 200 }));
  const quiet = asked([]);
  assert.equal(await serverOpens(vps, { fetch: opening, dialog: quiet.dialog, forget: () => assert.fail("not asked to"), ...clock }), true);
  assert.deepEqual(quiet.shown, [], "no dialog while the tunnel opens");
  assert.equal(looks, 4);

  at = 0; looks = 0;
  const dead = async () => { looks++; return gone(); };
  const later = asked([2]);
  assert.equal(await serverOpens(vps, { fetch: dead, dialog: later.dialog, forget: () => assert.fail("not asked to"), ...clock }), false);
  assert.equal(later.shown.length, 1, "asked once the grace is over");
  assert.ok(at >= TUNNEL_GRACE_MS - 1_000 && at <= TUNNEL_GRACE_MS, `waited ${at} ms`);

  // a server reached directly is asked about at once, as before
  looks = 0;
  const direct = asked([2]);
  await serverOpens(office, { fetch: dead, dialog: direct.dialog, forget: () => {}, ...clock });
  assert.equal(looks, 1);
});

test("looking within a time never runs on when the clock does not move", async () => {
  let looks = 0;
  const answered = await serverAnswersWithin(office.origin, async () => { looks++; return gone(); }, { withinMs: 5_000, now: () => 0, sleep: async () => {} });
  assert.equal(answered, false);
  assert.equal(looks, 6);
});

test("a server being added opens only once it answers; one that doesn't is kept without switching, or not saved at all", async () => {
  const quiet = asked([]);
  assert.equal(await newServerReach(office, { fetch: answering(200), dialog: quiet.dialog }), "open");
  assert.deepEqual(quiet.shown, []);

  const keep = asked([1]);
  assert.equal(await newServerReach(office, { fetch: gone, dialog: keep.dialog }), "keep");
  assert.equal(keep.shown[0].message, "madani-u-gone.fly.dev isn't answering yet");
  assert.deepEqual(keep.shown[0].buttons, ["Try again", "Keep in list", "Cancel"]);
  assert.doesNotMatch(keep.shown[0].detail, /nothing is lost/i);

  assert.equal(await newServerReach(office, { fetch: gone, dialog: asked([2]).dialog }), "cancel");

  let tries = 0;
  const back = async () => (++tries < 2 ? gone() : new Response("{}", { status: 200 }));
  const retry = asked([0]);
  assert.equal(await newServerReach(office, { fetch: back, dialog: retry.dialog }), "open", "it answered the second time");
  assert.equal(retry.shown.length, 1);
});
