import assert from "node:assert/strict";
import test from "node:test";

import { createCloudMoveOffer, movable, offerStage, parseOffer } from "./cloud-move-offer.mjs";
import { createOpenWhenAsked, installOneHome } from "./one-home-main.mjs";
import { createOneHome } from "./one-home.mjs";

const ORIGIN = "https://madani-m-1.fly.dev";
const READY = { origin: ORIGIN, account: "acct-1", ready: true, moves: true, ended: false };
const WORK = { items: [{ kind: "bot", label: "Nova", talked: true }, { kind: "bot", label: "Quill" }, { kind: "setting", label: "profile" }] };
// a fresh Mac: only what its first run brought in (the starter Madani with imported notes, an imported skill), never talked with
const IMPORTED = { items: [{ kind: "bot", label: "Madani" }, { kind: "imported-skill", label: "review" }, { kind: "setting", label: "profile" }] };
const NOTHING = { items: [{ kind: "setting", label: "profile" }, { kind: "setting", label: "language" }] };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const memory = (value = null) => {
  let kept = value;
  return { read: () => structuredClone(kept), write: (next) => { kept = structuredClone(next); }, get: () => kept };
};

test("what the move would carry: bots and the person's own automations count, settings alone are nothing", () => {
  assert.deepEqual(movable(WORK), { bots: 2, something: true, talked: true });
  assert.deepEqual(movable(NOTHING), { bots: 0, something: false, talked: false });
  assert.deepEqual(movable({ items: [{ kind: "routine", label: "brief" }] }), { bots: 0, something: true, talked: false });
  assert.deepEqual(movable(null), { bots: 0, something: false, talked: false });
});

test("the move is asked about only when the person talked with a bot here; a fresh Mac's imports go by themselves", async () => {
  const saved = parseOffer(null, "acct-1 " + ORIGIN);
  assert.equal(offerStage({ cloud: READY, journal: null, local: movable(WORK), saved }), "prompt", "a bot they talked with: asked");
  assert.equal(offerStage({ cloud: READY, journal: null, local: movable(IMPORTED), saved }), "none", "only imports: never asked");
  for (const [summary, asks] of [[WORK, false], [IMPORTED, true]]) {
    let kicks = 0;
    const offer = createCloudMoveOffer({ store: memory(), cloud: () => READY, journal: () => null, keep: { on: () => false, set: async () => {} },
      summary: async () => summary, kick: () => { kicks++; } });
    await offer.refresh({ force: true });
    assert.equal(offer.consent(), asks, asks ? "imports move without a yes" : "talked-with bots wait for the yes");
    assert.equal(kicks, asks ? 1 : 0);
  }
});

test("the ask goes sheet, then line, then Settings only, and never while there is no ready Cloud, a move, or nothing to carry", () => {
  const local = movable(WORK), saved = parseOffer(null, "acct-1 " + ORIGIN);
  assert.equal(offerStage({ cloud: null, journal: null, local, saved }), "none", "no Cloud");
  assert.equal(offerStage({ cloud: { ...READY, ready: false }, journal: null, local, saved }), "none", "setting up");
  assert.equal(offerStage({ cloud: { ...READY, moves: false }, journal: null, local, saved }), "none", "the Admin's kill switch");
  assert.equal(offerStage({ cloud: { ...READY, ended: true }, journal: null, local, saved }), "none", "ended");
  assert.equal(offerStage({ cloud: READY, journal: null, local: null, saved }), "none", "this computer not read yet");
  assert.equal(offerStage({ cloud: READY, journal: null, local: movable(NOTHING), saved }), "none", "nothing to carry");
  assert.equal(offerStage({ cloud: READY, journal: null, local, saved, own: true }), "none", "a server of their own is home");
  assert.equal(offerStage({ cloud: READY, journal: null, local, saved }), "prompt");
  assert.equal(offerStage({ cloud: READY, journal: null, local, saved: { ...saved, prompt: 1 } }), "banner");
  assert.equal(offerStage({ cloud: READY, journal: null, local, saved: { ...saved, prompt: 1, banner: 2 } }), "settings");
  assert.equal(offerStage({ cloud: READY, journal: null, local, saved, keep: true }), "settings", "keeping them here never nags");
  assert.equal(offerStage({ cloud: READY, journal: null, local, saved: { ...saved, accepted: { at: 1, from: "prompt" } } }), "none", "said yes");
  const moving = { v: 1, phase: "copy", cloud: { origin: ORIGIN, account: "acct-1" } };
  assert.equal(offerStage({ cloud: READY, journal: moving, local, saved }), "none", "under way");
  assert.equal(offerStage({ cloud: READY, journal: { ...moving, phase: "back" }, local, saved }), "prompt", "came home: offered again");
});

test("saved choices belong to one Cloud: a new Cloud asks again", () => {
  const saved = { v: 1, key: "acct-1 " + ORIGIN, prompt: 5, banner: 6, accepted: { at: 7, from: "banner" } };
  assert.deepEqual(parseOffer(saved, "acct-1 " + ORIGIN), saved);
  assert.deepEqual(parseOffer(saved, "acct-1 https://madani-m-2.fly.dev"), { v: 1, key: "acct-1 https://madani-m-2.fly.dev" });
  assert.deepEqual(parseOffer({ ...saved, accepted: { at: 7, from: "somewhere" } }, saved.key), { v: 1, key: saved.key, prompt: 5, banner: 6 });
});

function offerWorld({ summary = WORK, cloud = READY, journal = null, keepOn = false } = {}) {
  const w = { cloud, journal, keepOn, summary, kicks: 0, events: [], changes: 0, store: memory(), released: 0 };
  w.make = () => createCloudMoveOffer({
    store: w.store, cloud: () => w.cloud, journal: () => w.journal,
    keep: { on: () => w.keepOn, set: async (on) => { w.keepOn = on; w.released++; } },
    summary: async () => { if (w.summary instanceof Error) throw w.summary; return w.summary; },
    kick: () => { w.kicks++; }, onChange: () => { w.changes++; }, track: (name, props) => w.events.push([name, props]),
  });
  return w;
}

test("a Cloud that became ready while the app was closed is asked about at the next launch, and a closed sheet stays closed", async () => {
  const w = offerWorld({ cloud: null });
  let offer = w.make();
  await offer.refresh({ force: true });
  assert.equal(offer.state().stage, "none", "no Cloud yet");
  w.cloud = READY;
  offer = w.make();
  await offer.refresh();
  assert.deepEqual(offer.state(), { stage: "prompt", bots: 2 }, "the launch after the Cloud appeared");
  assert.equal(offer.consent(), false, "and the move waits for a yes");
  offer.dismiss("prompt");
  offer = w.make();
  await offer.refresh();
  assert.equal(offer.state().stage, "banner", "after a relaunch the line asks, never the sheet again");
  offer.dismiss("banner");
  assert.equal(w.make().state().stage, "none", "unknown until this computer is read");
  offer = w.make();
  await offer.refresh();
  assert.equal(offer.state().stage, "settings");
  assert.deepEqual(w.events, [["cloud_move_prompt", { action: "dismissed" }], ["cloud_move_banner", { action: "dismissed" }]]);
});

test("a yes is kept for this Cloud, lets go of keeping the bots here, and starts the move", async () => {
  const w = offerWorld({ keepOn: true });
  const offer = w.make();
  await offer.refresh();
  assert.equal(offer.state().stage, "settings");
  assert.equal(offer.accepted(), false);
  const after = await offer.accept("settings");
  assert.equal(after.stage, "none");
  assert.equal(w.keepOn, false);
  assert.equal(w.released, 1);
  assert.equal(w.kicks, 1);
  assert.equal(offer.consent(), true);
  assert.equal(w.store.get().accepted.from, "settings");
  assert.deepEqual(w.events, [["cloud_move_settings", { action: "accepted" }]]);
  await assert.rejects(offer.accept("prompt"), /nothing to move/u, "a second yes changes nothing");
});

test("a computer with nothing to carry needs no yes: the move goes on by itself, as before", async () => {
  const w = offerWorld({ summary: NOTHING });
  const offer = w.make();
  assert.equal(offer.consent(), false, "unknown until read");
  await offer.refresh();
  assert.equal(offer.consent(), true);
  assert.equal(offer.state().stage, "none");
  assert.equal(w.kicks, 1);
});

test("this computer's server not answering shows nothing and starts nothing", async () => {
  const w = offerWorld({ summary: new Error("down") });
  const offer = w.make();
  await offer.refresh();
  assert.equal(offer.state().stage, "none");
  assert.equal(offer.consent(), false);
  assert.equal(w.kicks, 0);
});

test("the move's own steps are said once each: started, each failure's reason code once, then succeeded with counts", async () => {
  const w = offerWorld();
  const offer = w.make();
  await offer.refresh();
  await offer.accept("prompt");
  w.events.length = 0;
  const base = { v: 1, cloud: { origin: ORIGIN, account: "acct-1" }, startedAt: 100 };
  w.journal = { ...base, phase: "copy" };
  offer.observe(); offer.observe();
  w.journal = { ...base, phase: "copy", failure: { phase: "copy", code: "unanswered", count: 1 } };
  offer.observe();
  w.journal = { ...base, phase: "copy", failure: { phase: "copy", code: "unanswered", count: 2 } };
  w.make().observe();
  w.journal = { ...base, phase: "copy", failure: { phase: "final", code: "refused", count: 3 } };
  offer.observe();
  w.journal = { ...base, phase: "done", counts: { bots: 12, chats: 40, routines: 3, skills: 5, logins: 0, onePassword: false } };
  offer.observe(); w.make().observe();
  assert.deepEqual(w.events, [
    ["cloud_move", { step: "started", from: "prompt" }],
    ["cloud_move", { step: "failed", reason: "unanswered", phase: "copy" }],
    ["cloud_move", { step: "failed", reason: "refused", phase: "final" }],
    ["cloud_move", { step: "succeeded", bots: 12, chats: 40, routines: 3, skills: 5 }],
  ]);
});

/** Main's own wiring with a ready My Cloud and this computer's server answering its move summary. */
function mainWorld({ summary = WORK, accounts = 1 } = {}) {
  const handlers = new Map(), journal = memory(), store = memory(), events = [];
  const machine = { status: "ready", origin: ORIGIN, moves: true };
  const main = installOneHome({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, cloudPage: (event) => event.page ?? null, server: () => null, home: () => null,
    cookieFetch: async () => json({}, 401), reconnect: async () => false, power: { asleep: () => false }, file: () => "/nonexistent/cloud-send.json", window: () => null,
    localOrigin: () => "http://127.0.0.1:4100", fetch: async () => json({}, 404),
    localRequest: async (route) => (route === "/api/cloud-send?move=1" ? json(summary) : route === "/api/move/freeze" ? json({ frozen: false }) : json({}, 404)),
    account: () => ({ state: () => ({ status: "connected", account: { id: "acct-1" }, machine }), pairHome: async () => { throw new Error("no code in this test"); } }),
    journalFile: () => "/nonexistent/one-home.json", tempRoot: () => "/nonexistent", journal, keep: memory(), accountsHere: () => accounts,
    offer: { store, track: (name, props) => events.push([name, props]) },
  });
  const ask = (channel, page, ...args) => handlers.get(channel)({ page }, ...args);
  return { main, journal, store, events, ask };
}

test("main: with bots here, no move starts until the person says yes on either page; the yes starts it", async () => {
  const w = mainWorld();
  try {
    await w.main.kick();
    await w.main.offer().refresh({ force: true });
    await w.main.oneHome.kick();
    assert.equal(w.journal.get(), null, "the first move waits");
    const notice = await w.ask("cloud-send:notice", "local");
    assert.deepEqual(notice.offer, { stage: "prompt", bots: 2 }, "this computer's page is told");
    assert.deepEqual((await w.ask("cloud-send:notice", "cloud")).offer, { stage: "prompt", bots: 2 }, "and My Cloud's page");
    assert.throws(() => w.ask("cloud-send:move-offer-accept", null, "prompt"), /only available/u, "never another page");
    assert.equal((await w.ask("cloud-send:move-offer-dismiss", "local", "prompt")).offer.stage, "banner");
    const after = await w.ask("cloud-send:move-offer-accept", "cloud", "banner");
    assert.equal(after.offer, undefined, "the ask goes away");
    assert.equal(w.journal.get()?.cloud.origin, ORIGIN, "the move started");
    assert.deepEqual(w.events.slice(0, 2), [["cloud_move_prompt", { action: "dismissed" }], ["cloud_move_banner", { action: "accepted" }]]);
    assert.ok(w.events.some(([name, props]) => name === "cloud_move" && props.step === "started"), JSON.stringify(w.events));
  } finally { w.main.close(); }
});

test("main: a computer with nothing to carry still moves by itself", async () => {
  const w = mainWorld({ summary: NOTHING });
  try {
    await w.main.kick();
    await w.main.offer().refresh({ force: true });
    await w.main.oneHome.kick();
    assert.equal(w.journal.get()?.cloud.origin, ORIGIN);
  } finally { w.main.close(); }
});

test("main: with two accounts here, even an empty computer waits for the person's yes, and the yes starts it", async () => {
  const w = mainWorld({ summary: NOTHING, accounts: 2 });
  try {
    await w.main.kick();
    await w.main.offer().refresh({ force: true });
    await w.main.oneHome.kick();
    assert.equal(w.journal.get(), null);
  } finally { w.main.close(); }
  const busy = mainWorld({ accounts: 2 });
  try {
    await busy.main.kick();
    await busy.main.offer().refresh({ force: true });
    await busy.ask("cloud-send:move-offer-accept", "local", "prompt");
    assert.equal(busy.journal.get()?.cloud.origin, ORIGIN);
  } finally { busy.main.close(); }
});

test("rollback: a move that fails after this computer paused lifts the pause, deletes nothing here and tries again later", async () => {
  let journal = null, frozen = false, forgot = 0, finals = 0, clock = 1_000_000;
  const home = createOneHome({
    journal: { read: () => structuredClone(journal), write: (value) => { journal = structuredClone(value); } },
    cloud: () => ({ origin: ORIGIN, account: "acct-1", machine: ORIGIN, ready: true, moves: true, ended: false, paid: true }),
    send: {
      move: async (options) => { if (options?.final) { finals++; throw Object.assign(new Error("My Cloud refused the pass."), { status: 422 }); } },
      check: async () => ({ ok: true }), switches: () => ({}), snapshot: () => ({ running: null }),
    },
    local: {
      freeze: async () => { frozen = true; return { frozen: true }; },
      unfreeze: async () => { frozen = false; },
      frozen: async () => frozen,
      json: async () => ({}),
      call: async () => ({ ok: true, status: 200, body: {} }),
      forget: async () => { forgot++; },
    },
    session: async () => ({ call: async () => ({ ok: true, status: 200, body: {} }), close: async () => {} }),
    lastInput: () => 0,
    now: () => clock,
    timers: { set: () => null, clear: () => {} },
  });
  try {
    await home.kick();
    assert.equal(finals, 1, "it got as far as the pass after the pause");
    assert.equal(frozen, false, "the pause is lifted");
    assert.equal(forgot, 0, "nothing on this computer is deleted");
    assert.equal(journal.phase, "copy", "it goes again from the copy");
    assert.equal(journal.failure.phase, "final", "the failure is kept with its reason code");
    assert.match(journal.failure.code, /^[a-z_]+$/u);
    assert.ok(journal.retryAt > clock, "later");
    assert.equal(home.away(), false, "home is still this computer");
  } finally { home.close(); }
});

test("once all moved, My Cloud opens on Open madani cloud, or by itself when nobody presses it, and only once", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const opened = [];
  const held = createOpenWhenAsked({ open: () => opened.push("cloud"), waitMs: 1_000 });
  held.done();
  held.done();
  assert.deepEqual(opened, [], "the window waits for the person");
  held.now();
  assert.deepEqual(opened, ["cloud"]);
  t.mock.timers.tick(5_000);
  assert.deepEqual(opened, ["cloud"], "the fallback never opens it again");
  held.done();
  t.mock.timers.tick(999);
  assert.deepEqual(opened, ["cloud"]);
  t.mock.timers.tick(1);
  assert.deepEqual(opened, ["cloud", "cloud"], "nobody pressing it, it opens by itself");
  held.done();
  held.close();
  t.mock.timers.tick(5_000);
  assert.deepEqual(opened, ["cloud", "cloud"], "closed, nothing is left waiting");
  const plain = [];
  createOpenWhenAsked({ open: () => plain.push("cloud"), waitMs: 0 }).done();
  assert.deepEqual(plain, ["cloud"], "without the offer it opens at once, as before");
});
