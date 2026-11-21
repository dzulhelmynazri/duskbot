import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { installAmbient, isAmbientWindow } from "./ambient-main.mjs";
import { SETTLE_WAIT_MS } from "./ambient-window.mjs";

function fakes({ prefs = { island: true, dock: true }, activity = null, platform = "darwin", seed = true, trace = null } = {}) {
  const windows = [];
  class BrowserWindow {
    constructor(options) {
      this.options = options; this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
      this.destroyed = false; this.visible = false; this.ignore = null; this.sent = []; this.focused = false; this.keys = [];
      this.webContents = Object.assign(new EventEmitter(), { send: (channel, payload) => this.sent.push([channel, payload]), setWindowOpenHandler() {}, isDestroyed: () => this.destroyed });
      this.events = new EventEmitter();
      windows.push(this);
    }
    setAlwaysOnTop(_on, level) { this.level = level; }
    setVisibleOnAllWorkspaces(_on, options) { this.workspaces = options; }
    setIgnoreMouseEvents(ignore, options) { this.ignore = { ignore, ...options }; }
    loadURL(url) { this.url = url; queueMicrotask(() => this.webContents.emit("did-finish-load")); return Promise.resolve(); }
    on(event, fn) { this.events.on(event, fn); }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    showInactive() { this.visible = true; }
    focus() { this.focused = true; this.keys.push("focus"); }
    blur() { this.focused = false; this.keys.push("blur"); }
    isFocused() { return this.focused; }
    getBounds() { return this.bounds; }
    setBounds(bounds) { this.bounds = bounds; }
    destroy() { this.destroyed = true; this.events.emit("closed"); }
  }
  const handlers = new Map(), listeners = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn), on: (channel, fn) => listeners.set(channel, fn) };
  const appPage = Object.assign(new EventEmitter(), { sent: [], throttling: [], send(channel, payload) { this.sent.push([channel, payload]); }, isDestroyed: () => false, getURL: () => "http://127.0.0.1:5199/", setBackgroundThrottling(on) { this.throttling.push(on); } });
  const builtIn = { id: 1, internal: true, label: "Built-in Liquid Retina XDR Display", bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 37, width: 1512, height: 945 } };
  const screen = Object.assign(new EventEmitter(), { getAllDisplays: () => [builtIn], getPrimaryDisplay: () => builtIn, getCursorScreenPoint: () => ({ x: 10, y: 10 }) });
  let saved = prefs;
  const opened = [], revealed = [];
  const ambient = installAmbient({
    ipcMain, BrowserWindow, platform, page: () => appPage, origin: () => "http://127.0.0.1:5199",
    file: { read: () => saved, write: (value) => { saved = value; } },
    openChat: (botId, threadId, origin) => opened.push(origin === undefined ? [botId, threadId] : [botId, threadId, origin]), reveal: () => revealed.push(true), activity, trace,
  });
  // the surfaces wait for the app's page to say who is there: by default it says one bot as they start
  const publish = (bots) => listeners.get("ambient:publish")({ sender: appPage }, { bots, labels: {}, lang: "en" });
  const realStart = ambient.start;
  ambient.start = (electronScreen) => { realStart(electronScreen); if (seed) publish([{ id: "nova", threadId: "t1", name: "Nova" }]); };
  return { windows, handlers, listeners, appPage, screen, ambient, opened, revealed, publish, saved: () => saved };
}

const surface = (windows, name) => windows.find((win) => !win.destroyed && win.options.webPreferences.additionalArguments.includes(`--madani-ambient=${name}`));
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("the island and the dock open as click-through panels on the display, hidden over full-screen apps", async () => {
  const { windows, screen, ambient } = fakes();
  ambient.start(screen);
  await tick();
  const island = surface(windows, "island"), dock = surface(windows, "dock");
  assert.ok(island && dock);
  assert.equal(island.url, "http://127.0.0.1:5199/ambient.html?surface=island");
  assert.equal(island.options.type, "panel");
  assert.equal(island.bounds.y, 0);
  assert.deepEqual(island.ignore, { ignore: true, forward: true });
  assert.equal(island.workspaces.visibleOnFullScreen, false);
  assert.ok(island.visible && dock.visible);
  assert.ok(isAmbientWindow(island));
  const layout = island.sent.find(([channel]) => channel === "ambient:layout")[1];
  assert.equal(layout.collapsed.kind, "notch");
  // the page says the pointer reached its shape: clicks land there until it says otherwise
  island.webContents.emit("ipc-message", {}, "ambient:pointer", true);
  assert.deepEqual(island.ignore, { ignore: false });
  // hovering from bot to bot is the page's own business: never a new window
  const count = windows.length;
  for (let index = 0; index < 6; index++) dock.webContents.emit("ipc-message", {}, "ambient:pointer", index % 2 === 0);
  assert.equal(windows.length, count);
  island.webContents.emit("ipc-message", {}, "ambient:pointer", false);
  assert.deepEqual(island.ignore, { ignore: true, forward: true });
  ambient.close();
});

test("only the app's own page publishes the summary, and the surfaces' asks go back to it", async () => {
  const { windows, listeners, appPage, screen, ambient, opened, revealed } = fakes({ seed: false });
  ambient.start(screen);
  await tick();
  listeners.get("ambient:publish")({ sender: {} }, { bots: [{ id: "x", threadId: "t", name: "X" }] });
  assert.equal(surface(windows, "island"), undefined);
  listeners.get("ambient:publish")({ sender: appPage }, { bots: [{ id: "nova", threadId: "t1", name: "Nova", status: "working" }], labels: {}, lang: "en" });
  await tick();
  const island = surface(windows, "island");
  const state = island.sent.findLast(([channel]) => channel === "ambient:state")[1];
  assert.equal(state.bots[0].name, "Nova");
  island.webContents.emit("ipc-message", {}, "ambient:open", { botId: "nova", threadId: "t1" });
  assert.deepEqual(opened, [["nova", "t1", "http://127.0.0.1:5199"]]);
  island.webContents.emit("ipc-message", {}, "ambient:act", { kind: "reply", botId: "nova", threadId: "t1", text: "go" });
  island.webContents.emit("ipc-message", {}, "ambient:act", { kind: "wipe", botId: "nova", threadId: "t1" });
  island.webContents.emit("ipc-message", {}, "ambient:act", { kind: "new-bot" });
  assert.deepEqual(appPage.sent.filter(([channel]) => channel === "ambient:act").map(([, act]) => act.kind), ["reply", "new-bot"]);
  assert.equal(revealed.length, 1);
  ambient.close();
});

test("Settings turns a surface off and on, from the app's window only, and the dock keeps its order", async () => {
  const { windows, handlers, appPage, screen, ambient, saved } = fakes();
  ambient.start(screen);
  await tick();
  assert.throws(() => handlers.get("ambient:set")({ sender: {} }, { island: false }));
  const view = handlers.get("ambient:set")({ sender: appPage }, { island: false });
  assert.equal(view.island, false);
  assert.equal(surface(windows, "island"), undefined);
  assert.ok(surface(windows, "dock"));
  assert.equal(saved().island, false);
  surface(windows, "dock").webContents.emit("ipc-message", {}, "ambient:order", ["quill", "nova"]);
  assert.deepEqual(saved().order, ["quill", "nova"]);
  handlers.get("ambient:set")({ sender: appPage }, { dock: false });
  assert.equal(surface(windows, "dock"), undefined);
  assert.equal(await handlers.get("ambient:wanted")({ sender: appPage }), false);
  assert.deepEqual(appPage.sent.findLast(([channel]) => channel === "ambient:wanted"), ["ambient:wanted", false]);
  ambient.close();
});

test("both surfaces hear when to hold still, the newest word replayed to a page that loads later", async () => {
  const app = new EventEmitter(), powerMonitor = Object.assign(new EventEmitter(), { getSystemIdleState: () => "active" });
  let focused = true;
  const { windows, screen, ambient } = fakes({ activity: { app, powerMonitor, focused: () => focused } });
  ambient.start(screen);
  await tick();
  focused = false;
  app.emit("browser-window-blur");
  await tick();
  for (const name of ["island", "dock"]) {
    const sent = surface(windows, name).sent.filter(([channel]) => channel === "ambient:still").map(([, still]) => still);
    assert.deepEqual(sent.at(-1), true, name);
  }
  ambient.close();
  assert.equal(app.listenerCount("browser-window-blur"), 0);
});

test("someone who never chose gets the dock and the island", async () => {
  const { windows, ambient, screen } = fakes({ prefs: null });
  ambient.start(screen);
  await tick();
  assert.ok(surface(windows, "island") && surface(windows, "dock"));
  ambient.close();
});

test("what a surface has seen is saved, told to both surfaces, and still there after a restart", async () => {
  const first = fakes();
  first.ambient.start(first.screen);
  await tick();
  const dock = surface(first.windows, "dock"), island = surface(first.windows, "island");
  dock.webContents.emit("ipc-message", {}, "ambient:seen", ["echo:error:9", "../bad"]);
  assert.deepEqual(first.saved().seen, ["echo:error:9"]);
  assert.deepEqual(island.sent.findLast(([channel]) => channel === "ambient:seen")[1], ["echo:error:9"]);
  first.ambient.close();
  const again = fakes({ prefs: first.saved() });
  again.ambient.start(again.screen);
  await tick();
  surface(again.windows, "dock").webContents.emit("did-finish-load");
  assert.deepEqual(surface(again.windows, "dock").sent.findLast(([channel]) => channel === "ambient:seen")[1], ["echo:error:9"]);
  again.ambient.close();
});

test("over its shape a panel takes the keyboard so macOS shows its cursor, and gives it back only once the surface has finished closing", async () => {
  const { windows, ambient, screen } = fakes();
  ambient.start(screen);
  await tick();
  const island = surface(windows, "island");
  const say = (channel, payload) => island.webContents.emit("ipc-message", {}, channel, payload);
  say("ambient:pointer", true);
  assert.deepEqual([island.ignore, island.keys], [{ ignore: false }, ["focus"]]);
  // moving between bots: still over the shape, nothing more
  say("ambient:pointer", true);
  assert.deepEqual(island.keys, ["focus"]);
  // off the shape: clicks fall through at once, but the keyboard stays until the closing animation is done
  say("ambient:pointer", false);
  assert.deepEqual([island.ignore, island.keys], [{ ignore: true, forward: true }, ["focus"]]);
  say("ambient:settled");
  assert.deepEqual(island.keys, ["focus", "blur"]);
  // back before it settled: nothing to give back
  say("ambient:pointer", true);
  say("ambient:pointer", false);
  say("ambient:pointer", true);
  say("ambient:settled");
  assert.deepEqual(island.keys, ["focus", "blur", "focus"]);
  // typing in an answer: the keyboard stays while the pointer wanders, and goes back once the field lets go and it settles
  say("ambient:typing", true);
  say("ambient:pointer", false);
  say("ambient:settled");
  assert.deepEqual(island.keys, ["focus", "blur", "focus"]);
  say("ambient:typing", false);
  say("ambient:settled");
  assert.deepEqual(island.keys, ["focus", "blur", "focus", "blur"]);
  ambient.close();
});

test("a panel macOS took the keyboard from (another app clicked or switched to) takes it again on the next visit", async () => {
  const { windows, ambient, screen } = fakes();
  ambient.start(screen);
  await tick();
  const island = surface(windows, "island");
  const say = (channel, payload) => island.webContents.emit("ipc-message", {}, channel, payload);
  say("ambient:pointer", true);
  assert.deepEqual(island.keys, ["focus"]);
  island.focused = false;
  say("ambient:pointer", false);
  say("ambient:pointer", true);
  assert.deepEqual([island.focused, island.keys], [true, ["focus", "focus"]]);
  ambient.close();
});

test("a page that never says it settled still gets the keyboard taken back, a moment later", async () => {
  const { windows, ambient, screen } = fakes();
  ambient.start(screen);
  await tick();
  const island = surface(windows, "island");
  island.webContents.emit("ipc-message", {}, "ambient:pointer", true);
  island.webContents.emit("ipc-message", {}, "ambient:pointer", false);
  assert.deepEqual(island.keys, ["focus"]);
  await new Promise((resolve) => setTimeout(resolve, SETTLE_WAIT_MS + 50));
  assert.deepEqual(island.keys, ["focus", "blur"]);
  ambient.close();
});

test("the dock never takes the keyboard on hover: giving it back would fade the panel out and in, and the edge would read the focus as a window switch", async () => {
  const { windows, ambient, screen } = fakes();
  ambient.start(screen);
  await tick();
  const dock = surface(windows, "dock");
  const say = (channel, payload) => dock.webContents.emit("ipc-message", {}, channel, payload);
  for (let visit = 0; visit < 3; visit++) {
    say("ambient:pointer", true);
    assert.deepEqual(dock.ignore, { ignore: false });
    say("ambient:pointer", false);
    say("ambient:settled");
  }
  assert.deepEqual(dock.keys, []);
  await new Promise((resolve) => setTimeout(resolve, SETTLE_WAIT_MS + 50));
  assert.deepEqual(dock.keys, []);
  // the island still does, so macOS shows its pointing hand
  const island = surface(windows, "island");
  island.webContents.emit("ipc-message", {}, "ambient:pointer", true);
  assert.deepEqual(island.keys, ["focus"]);
  ambient.close();
});

test("opening a bot from a surface goes to the place its bots came from, or the place the app's window shows", async () => {
  const { windows, ambient, screen, opened, appPage } = fakes();
  ambient.start(screen);
  await tick();
  const dock = surface(windows, "dock");
  dock.webContents.emit("ipc-message", {}, "ambient:open", { botId: "nova", threadId: "t1" });
  assert.deepEqual(opened.at(-1), ["nova", "t1", "http://127.0.0.1:5199"]);
  ambient.close();
  assert.ok(appPage);
});

test("a panel that already has the keyboard (the person clicked into it) is left alone, and other platforms never take it", async () => {
  const mac = fakes();
  mac.ambient.start(mac.screen);
  await tick();
  const island = surface(mac.windows, "island");
  island.focused = true;
  island.webContents.emit("ipc-message", {}, "ambient:pointer", true);
  island.webContents.emit("ipc-message", {}, "ambient:pointer", false);
  assert.deepEqual(island.keys, []);
  mac.ambient.close();
  const windows = fakes({ platform: "win32", prefs: { island: true, dock: true } });
  windows.ambient.start(windows.screen);
  await tick();
  const other = surface(windows.windows, "dock");
  other.webContents.emit("ipc-message", {}, "ambient:pointer", true);
  other.webContents.emit("ipc-message", {}, "ambient:pointer", false);
  assert.deepEqual(other.keys, []);
  windows.ambient.close();
});

test("no bots, no surfaces: nothing shows until the page says who is there, and it goes again when the page does", async () => {
  const { windows, screen, ambient, appPage, publish } = fakes({ seed: false });
  ambient.start(screen);
  await tick();
  // started, but no word from the page yet: no empty dock, no lone "+", no island
  assert.deepEqual([surface(windows, "island"), surface(windows, "dock")], [undefined, undefined]);
  publish([]);
  await tick();
  assert.deepEqual([surface(windows, "island"), surface(windows, "dock")], [undefined, undefined]);
  publish([{ id: "nova", threadId: "t1", name: "Nova" }]);
  await tick();
  assert.ok(surface(windows, "island") && surface(windows, "dock"));
  // the page leaves for another place: the surfaces go until a page speaks again
  appPage.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  assert.deepEqual([surface(windows, "island"), surface(windows, "dock")], [undefined, undefined]);
  publish([{ id: "nova", threadId: "t1", name: "Nova" }]);
  await tick();
  assert.ok(surface(windows, "dock"));
  // an in-page move is not leaving
  appPage.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
  assert.ok(surface(windows, "dock"));
  publish([]);
  assert.equal(surface(windows, "dock"), undefined);
  ambient.close();
});

test("the first run and the places hub keep both surfaces closed, even with bots, and they come back once a place's bots show", async () => {
  const { windows, screen, ambient, appPage, listeners } = fakes();
  ambient.start(screen);
  await tick();
  assert.ok(surface(windows, "island") && surface(windows, "dock"));
  const send = (raw) => listeners.get("ambient:publish")({ sender: appPage }, raw);
  send({ bots: [{ id: "madani", threadId: "t1", name: "Madani" }], labels: {}, lang: "en", away: true });
  await tick();
  assert.deepEqual([surface(windows, "island"), surface(windows, "dock")], [undefined, undefined]);
  send({ bots: [{ id: "madani", threadId: "t1", name: "Madani" }], labels: {}, lang: "en" });
  await tick();
  assert.ok(surface(windows, "island") && surface(windows, "dock"));
  ambient.close();
});

test("a surface in use or still closing is never moved or resized: the new place waits until it has settled", async () => {
  const lines = [];
  const { windows, screen, ambient } = fakes({ trace: (surfaceName, event, detail) => lines.push(`${surfaceName} ${event}${detail ? ` ${detail}` : ""}`) });
  ambient.start(screen);
  await tick();
  const dock = surface(windows, "dock");
  const before = dock.bounds;
  dock.webContents.emit("ipc-message", {}, "ambient:pointer", true);
  dock.webContents.emit("ipc-message", {}, "ambient:pointer", false);
  // the display changes size while the dock is closing
  screen.getAllDisplays()[0].workArea.height = 900;
  screen.emit("display-metrics-changed");
  assert.deepEqual(dock.bounds, before);
  assert.ok(lines.some((line) => line.startsWith("dock place-held")), lines.join("\n"));
  dock.webContents.emit("ipc-message", {}, "ambient:settled");
  assert.equal(dock.bounds.height, 900);
  // every window action is in the trace, in order
  const actions = lines.filter((line) => line.startsWith("dock win:") || line.startsWith("dock page:settled")).map((line) => line.split(" ").slice(0, 2).join(" "));
  assert.deepEqual(actions.slice(-4), ["dock win:setIgnoreMouseEvents", "dock win:setIgnoreMouseEvents", "dock page:settled", "dock win:setBounds"]);
  ambient.close();
});

test("a surface showing a bot's chat asks the app's page for a long stretch of it, and that page keeps up behind other windows", async () => {
  const { windows, screen, ambient, appPage, handlers } = fakes();
  ambient.start(screen);
  await tick();
  // while a surface is on, the page is never throttled, so a reply streams in even with the app behind other windows
  assert.deepEqual(appPage.throttling, [false]);
  const dock = surface(windows, "dock");
  dock.webContents.emit("ipc-message", {}, "ambient:viewing", { botId: "nova", limit: 999 });
  dock.webContents.emit("ipc-message", {}, "ambient:viewing", { botId: "../x", limit: 5 });
  dock.webContents.emit("ipc-message", {}, "ambient:viewing", null);
  assert.deepEqual(appPage.sent.filter(([channel]) => channel === "ambient:viewing").map(([, viewing]) => viewing), [{ botId: "nova", limit: 120 }, null, null]);
  // the island letting go of its chat leaves the dock's card's in place
  const island = surface(windows, "island");
  dock.webContents.emit("ipc-message", {}, "ambient:viewing", { botId: "nova", limit: 60 });
  island.webContents.emit("ipc-message", {}, "ambient:viewing", { botId: "rivet", limit: 40 });
  island.webContents.emit("ipc-message", {}, "ambient:viewing", null);
  assert.deepEqual(appPage.sent.filter(([channel]) => channel === "ambient:viewing").slice(-3).map(([, viewing]) => viewing), [{ botId: "nova", limit: 60 }, { botId: "rivet", limit: 40 }, { botId: "nova", limit: 60 }]);
  // both surfaces off: the page may rest again
  handlers.get("ambient:set")({ sender: appPage }, { island: false, dock: false });
  assert.deepEqual(appPage.throttling, [false, true]);
  ambient.close();
});
