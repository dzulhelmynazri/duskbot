import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createWorkspaceReconnect, FRAME_MAX_AGE_MS, frameOf, installWorkspaceReconnectIpc, proxyAnswersForDownServer, RECONNECT_PATH, RETRY_MS } from "./workspace-reconnect.mjs";

const LOCAL = "http://127.0.0.1:8799";
const BOTS = {
  bots: [
    { id: "b1", name: "Research", messages: [{ text: "secret words" }], tasks: [{ threadId: "t1", title: "Flights to Goa", createdAt: 1 }, { threadId: "t2", title: "", createdAt: 2 }] },
    { id: "b2", name: "Inbox", tasks: [] },
  ],
  groups: [{ id: "g1", name: "Launch room", messages: [{ text: "more secret words" }] }],
};

/** A stand-in for the VPS: a real HTTP server on loopback that can go down (closed, connection refused) and come back on its port. */
async function fakeServer() {
  const served = [];
  const handler = (req, res) => {
    served.push(req.url);
    if (req.url === "/.well-known/madanibot/environment") return void res.writeHead(200, { "content-type": "application/json" }).end("{}");
    if (req.url === "/api/bots?messages=0") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(BOTS));
    res.writeHead(404).end();
  };
  let server = createServer(handler);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  return {
    origin: `http://127.0.0.1:${port}`, served,
    down: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); }),
    up: async () => { server = createServer(handler); await new Promise((done) => server.listen(port, "127.0.0.1", done)); },
  };
}

function world(remote) {
  const w = { clock: 1_000_000, timers: [], loads: [], published: [], chosen: [], saved: {}, url: `${remote.origin}/` };
  const entry = { id: "vps", kind: "remote", name: "Garage server", origin: remote.origin };
  w.entry = entry;
  w.active = entry;
  const contents = { mainFrame: { get url() { return w.url; } }, getURL: () => w.url };
  w.window = { isDestroyed: () => false, webContents: contents, loadURL: async (url) => { w.loads.push(url); w.url = url; } };
  w.reconnect = createWorkspaceReconnect({
    fetch: (...args) => fetch(...args),
    store: { read: () => w.saved, write: (value) => { w.saved = value; } },
    window: () => w.window, localOrigin: () => LOCAL, localReady: () => true,
    active: () => w.active, keeps: () => true,
    places: () => [{ id: "local", name: "This computer", local: true }, { id: "vps", name: "Garage server" }, { id: "office", name: "Office" }],
    choose: (id) => { w.chosen.push(id); },
    remove: (id) => { w.removed = [...(w.removed ?? []), id]; return true; },
    publish: (view) => w.published.push(view),
    timers: { set: (work, ms) => { const timer = { work, at: w.clock + ms }; w.timers.push(timer); return timer; }, clear: (timer) => { w.timers = w.timers.filter((entry) => entry !== timer); } },
    now: () => w.clock,
  });
  /** Moves the clock on and runs what is due, then lets the real fetches settle. */
  w.later = async (ms) => {
    w.clock += ms;
    const due = w.timers.filter((timer) => timer.at <= w.clock);
    w.timers = w.timers.filter((timer) => timer.at > w.clock);
    for (const timer of due) timer.work();
    for (let i = 0; i < 40 && w.reconnect.view()?.checking; i++) await new Promise((done) => setTimeout(done, 10));
  };
  return w;
}

test("the frame keeps bot names and chat titles only, never message text", () => {
  const frame = frameOf(BOTS, 5);
  assert.deepEqual(frame, { at: 5, bots: [{ id: "b1", name: "Research", chats: [{ id: "t1", title: "Flights to Goa" }, { id: "t2", title: "" }] }, { id: "b2", name: "Inbox", chats: [] }], groups: [{ id: "g1", name: "Launch room" }] });
  assert.doesNotMatch(JSON.stringify(frame), /secret/);
  assert.equal(frameOf(null, 1), null);
  assert.equal(frameOf({ bots: Array.from({ length: 500 }, (_, i) => ({ id: `b${i}`, name: "x", tasks: [] })) }, 1).bots.length, 60, "bounded");
});

test("a server that stops answering stays chosen: its last-seen chats, Reconnecting with a countdown, and it opens again by itself when it is back", async (t) => {
  const remote = await fakeServer();
  t.after(() => remote.down().catch(() => {}));
  const w = world(remote);
  // its page loaded once: the frame is kept
  w.reconnect.loaded(`${remote.origin}/`);
  for (let i = 0; i < 50 && !w.saved.vps; i++) await new Promise((done) => setTimeout(done, 10));
  assert.equal(w.saved.vps?.bots[0].chats[0].title, "Flights to Goa");

  await remote.down();
  w.reconnect.lost(w.entry);
  assert.deepEqual(w.loads, [`${LOCAL}${RECONNECT_PATH}`], "this computer's reconnect page, never This computer's app");
  w.reconnect.loaded(`${LOCAL}${RECONNECT_PATH}`);
  let view = w.reconnect.view();
  assert.equal(view.name, "Garage server");
  assert.equal(view.nextAt, w.clock + RETRY_MS[0], "the next look counts down");
  assert.deepEqual(view.frame.bots.map((bot) => bot.name), ["Research", "Inbox"], "the chats it showed last, read only");
  assert.deepEqual(view.places.map((place) => place.id), ["local", "office"], "another workspace may be opened, not itself");

  for (const ms of RETRY_MS.slice(0, 3)) await w.later(ms);
  view = w.reconnect.view();
  assert.equal(view.attempt, 3, "looked at again by itself");
  assert.equal(view.nextAt, w.clock + RETRY_MS[3], "waits longer each time");
  assert.deepEqual(w.chosen, [], "nothing chose another workspace");
  assert.equal(w.active.id, "vps");
  assert.equal(w.url, `${LOCAL}${RECONNECT_PATH}`);

  await remote.up();
  await w.later(RETRY_MS[3]);
  assert.equal(w.loads.at(-1), remote.origin, "its own page again once it answers");
  w.reconnect.loaded(`${remote.origin}/`);
  assert.equal(w.reconnect.view(), null, "the wait is over");
  assert.equal(w.published.at(-1), null);
  assert.deepEqual(w.timers, [], "nothing left to look again");
});

test("its page failing again after it answered keeps waiting; the person's pick and a forget end it", async (t) => {
  const remote = await fakeServer();
  t.after(() => remote.down().catch(() => {}));
  const w = world(remote);
  w.reconnect.lost(w.entry);
  await w.later(RETRY_MS[0]);
  assert.equal(w.loads.at(-1), remote.origin, "it answered: its page is loaded");
  w.reconnect.lost(w.entry);
  assert.equal(w.reconnect.view().attempt, 1, "the same wait, not a new one");
  assert.equal(w.loads.at(-1), `${LOCAL}${RECONNECT_PATH}`);
  assert.throws(() => w.reconnect.choose("vps"), /Choose one of the places/, "only a workspace the page offered");
  w.reconnect.choose("office");
  assert.deepEqual(w.chosen, ["office"]);
  w.active = { id: "office", kind: "remote", name: "Office", origin: "https://office.example.test" };
  await w.later(RETRY_MS[1]);
  assert.equal(w.reconnect.view(), null, "another workspace chosen: no more looks at this one");
  w.saved = { vps: frameOf(BOTS, w.clock), office: frameOf(BOTS, w.clock) };
  w.reconnect.forget("vps");
  assert.deepEqual(Object.keys(w.saved), ["office"], "a forgotten server's frame goes with it");
});

test("an old frame is not shown, and the page's IPC answers only this app's reconnect page in the main frame", async (t) => {
  const remote = await fakeServer();
  t.after(() => remote.down().catch(() => {}));
  const w = world(remote);
  w.saved = { vps: { ...frameOf(BOTS, w.clock - FRAME_MAX_AGE_MS - 1) } };
  await remote.down();
  w.reconnect.lost(w.entry);
  assert.equal(w.reconnect.view().frame, undefined);
  const handlers = new Map();
  installWorkspaceReconnectIpc({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, reconnect: w.reconnect });
  const from = (url, frame = w.window.webContents.mainFrame) => ({ sender: w.window.webContents, senderFrame: url === null ? frame : { url } });
  assert.equal(handlers.get("workspace-reconnect:state")(from(null)).name, "Garage server", "the page itself");
  for (const url of [`${remote.origin}${RECONNECT_PATH}`, `${LOCAL}/`, `${LOCAL}/home`]) {
    assert.throws(() => handlers.get("workspace-reconnect:state")({ sender: w.window.webContents, senderFrame: { url } }), /only available/, url);
  }
  assert.throws(() => handlers.get("workspace-reconnect:open")({ sender: {}, senderFrame: w.window.webContents.mainFrame }, "office"), /only available/, "another window");
});

test("a server added by hand that never opened says so, with nothing kept to show, and may be removed from its page", async (t) => {
  const remote = await fakeServer();
  t.after(() => remote.down().catch(() => {}));
  const w = world(remote);
  await remote.down();
  w.reconnect.lost(w.entry);
  const view = w.reconnect.view();
  assert.equal(view.neverConnected, true);
  assert.equal(view.host, new URL(remote.origin).host);
  assert.equal(view.frame, undefined);
  assert.equal(w.reconnect.remove(), true);
  assert.deepEqual(w.removed, ["vps"]);

  // once its page has loaded it has connected: a later outage is a reconnect, not "can't reach it yet"
  await remote.up();
  w.reconnect.loaded(`${remote.origin}/`);
  await remote.down();
  w.reconnect.lost(w.entry);
  assert.equal(w.reconnect.view().neverConnected, undefined);
  w.reconnect.stop();
  assert.throws(() => w.reconnect.remove(), /no server to remove/);
});

test("a proxy's own page for a gone server, Cloudflare's tunnel errors included, counts as the server not answering", () => {
  for (const code of [502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]) assert.equal(proxyAnswersForDownServer(code), true, String(code));
  for (const code of [200, 204, 301, 401, 403, 404, 500, 501, 505]) assert.equal(proxyAnswersForDownServer(code), false, String(code));
});

test("a madani cloud the edge says was deleted is said once, with Remove and the other places, and never looked at again", async (t) => {
  const served = [];
  const server = createServer((req, res) => {
    served.push(req.url);
    res.writeHead(410, { "content-type": "text/plain", "x-madani-cloud-power": "gone" }).end("This madani bot was deleted.");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); }));
  const w = world({ origin: `http://127.0.0.1:${server.address().port}` });
  w.reconnect.lost({ ...w.entry, gone: true });
  for (let i = 0; i < 50 && !w.reconnect.view()?.gone; i++) await new Promise((done) => setTimeout(done, 10));
  const view = w.reconnect.view();
  assert.equal(view.gone, true);
  assert.equal(view.nextAt, null);
  assert.equal(view.checking, false);
  assert.deepEqual(view.places.map((place) => place.id), ["local", "office"]);
  assert.equal(w.loads.at(-1), `${LOCAL}${RECONNECT_PATH}`);
  assert.equal(w.timers.length, 0, "nothing is scheduled");
  const asked = served.length;
  w.reconnect.retry();
  w.reconnect.lost({ ...w.entry, gone: true });
  await w.later(10 * 60_000);
  assert.equal(served.length, asked, "never looked at again");
  w.reconnect.remove();
  assert.deepEqual(w.removed, ["vps"]);
});
