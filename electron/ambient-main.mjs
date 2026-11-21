// The ambient surfaces' wiring in main: the notch island and the bot dock, the person's choices for them, and the one
// summary of the bots that the app's own page publishes (from the live stream it already has open, so the surfaces
// never ask a server anything). Their asks (open a chat, reply, allow) go back to that page, which does them.
import { pickDisplay } from "./ambient-geometry.mjs";
import { watchStill } from "./ambient-still.mjs";
import { createChatFiller } from "./ambient-chats.mjs";
import { createTurnClock } from "./ambient-wake.mjs";
import { createTrace, traceFolder, traceWanted } from "./ambient-trace.mjs";
import { applyPrefsChange, parseAct, parsePrefs, parseSnapshot, seenKeys } from "./ambient-state.mjs";
import { createDockWindow } from "./dock-window.mjs";
import { createIslandWindow } from "./island-window.mjs";

export { isAmbientWindow } from "./ambient-window.mjs";

/** How often the pointer's display is checked while the surfaces follow it across two displays or more. */
export const FOLLOW_MS = 1000;
const PAGE = "/ambient.html";

/**
 * @param {{ ipcMain: any, BrowserWindow: any, page: () => any, origin: () => string | null,
 *   file: { read(): unknown, write(value: unknown): void }, openChat: (botId: string, threadId: string, origin: string | null) => void,
 *   reveal: () => void, activity?: { app: any, powerMonitor: any, focused: () => boolean } | null, platform?: string,
 *   log?: (line: string) => void }} deps `page()`: the app window's webContents, the only page whose summary counts and
 * the one that carries out the surfaces' asks. `activity`: what tells the surfaces to hold still (ambient-still.mjs).
 * `openChat` gets the origin of the page whose bots the surfaces show: the chat opens in that place, not This computer.
 */
export function installAmbient({ ipcMain, BrowserWindow, page, origin, file, openChat, reveal, activity = null, platform = process.platform, log = () => {}, readPage = null, trace: given = undefined }) {
  let throttled = null;
  let prefs = null, snapshot = null, from = null, screen = null, started = false, follow = null, displayId = null, dockCount = -1, stillness = null;
  const saved = () => (prefs ??= (() => { try { return parsePrefs(file.read(), platform); } catch { return parsePrefs(null, platform); } })());
  const save = next => { prefs = next; try { file.write(next); } catch (error) { log(`ambient prefs not saved: ${error?.message ?? error}`); } };
  const address = surface => { const base = origin(); return base ? `${base}${PAGE}?surface=${surface}` : null; };
  const appPage = () => { const contents = page(); return contents && !contents.isDestroyed() ? contents : null; };
  const pageOrigin = () => { try { return new URL(appPage()?.getURL() ?? "").origin; } catch { return null; } };

  const views = { island: null, dock: null };
  const onMessage = surface => (channel, payload) => {
    if (channel === "ambient:ready") return tellAll();
    if (channel === "ambient:open") {
      // the place the surfaces' bots came from; before the first summary, the place the app's window shows
      if (typeof payload?.botId === "string" && typeof payload?.threadId === "string") openChat(payload.botId, payload.threadId, from ?? pageOrigin());
      return;
    }
    if (channel === "ambient:act") {
      const act = parseAct(payload);
      if (!act) return;
      if (act.kind === "new-bot") reveal();
      appPage()?.send("ambient:act", act);
      return;
    }
    if (channel === "ambient:viewing") {
      // the chat a surface shows: the app's page puts a long stretch of it in that bot's summary
      const botId = typeof payload?.botId === "string" && /^[\w.:-]{1,128}$/.test(payload.botId) ? payload.botId : null;
      const limit = Number.isFinite(payload?.limit) ? Math.max(1, Math.min(120, Math.floor(payload.limit))) : 40;
      // each surface's own: the island closing its chat never takes the dock's card's away, and the other way round
      views[surface] = botId ? { botId, limit } : null;
      appPage()?.send("ambient:viewing", views[surface] ?? views[surface === "dock" ? "island" : "dock"] ?? null);
      return;
    }
    if (channel === "ambient:seen") {
      const keys = seenKeys(payload).slice(0, 50);
      if (!keys.length) return;
      const seen = seenKeys([...saved().seen.filter(key => !keys.includes(key)), ...keys]);
      save({ ...saved(), seen });
      island.send("ambient:seen", seen); dock.send("ambient:seen", seen);
      return;
    }
    if (channel === "ambient:order" && surface === "dock") {
      save(applyPrefsChange(saved(), { order: payload }));
      relayout("dock order");
    }
  };
  // MADANI_AMBIENT_TRACE=1 or `trace: true` in the prefs file: a millisecond timeline of both surfaces (ambient-trace.mjs)
  let rawPrefs = null;
  try { rawPrefs = file.read(); } catch { /* no prefs yet */ }
  const trace = given !== undefined ? given : traceWanted(process.env, rawPrefs) ? createTrace({ folder: traceFolder(platform) }) : null;
  const note = (event, detail) => trace?.("main", event, detail);
  const island = createIslandWindow({ BrowserWindow, url: () => address("island"), platform, onMessage: onMessage("island"), log, trace });
  const dock = createDockWindow({ BrowserWindow, url: () => address("dock"), platform, onMessage: onMessage("dock"), log, trace, cursor: () => screen?.getCursorScreenPoint() ?? null });

  const display = () => {
    if (!screen) return null;
    return pickDisplay(screen.getAllDisplays(), saved().display, { primary: screen.getPrimaryDisplay(), cursor: saved().display === "active" ? screen.getCursorScreenPoint() : null });
  };

  // the mini chat for bots the page sent without one (ambient-chats.mjs), read through the app window's own session
  const read = readPage ?? (async (url) => {
    const contents = appPage();
    if (!contents) throw new Error("no page");
    const response = await contents.session.fetch(url, { credentials: "include", headers: { "x-madani-background": "1" } });
    if (!response.ok) throw new Error(`${response.status}`);
    return response.json();
  });
  const chats = createChatFiller({ read, onChange: () => tellAll() });
  const clock = createTurnClock();

  function tellAll() {
    const shown = chats.fill(snapshot);
    if (shown) { island.send("ambient:state", shown); dock.send("ambient:state", shown); }
    const seen = saved().seen;
    island.send("ambient:seen", seen); dock.send("ambient:seen", seen);
  }

  // the surfaces show bots or nothing: no empty dock or lone "+", no island before the page has said who is there, and
  // none while the app's window is on its first run or the places hub
  const hasBots = () => Boolean(snapshot?.bots.length) && snapshot?.away !== true;
  function relayout(reason = "") {
    const on = saved();
    const target = started && origin() && hasBots() ? display() : null;
    note("relayout", `${reason} bots=${snapshot?.bots.length ?? "none"} island=${Boolean(on.island && target)} dock=${Boolean(on.dock && target)}`);
    displayId = target?.id ?? null;
    if (on.island && target) island.layout(target, { size: on.size }); else island.close();
    dockCount = snapshot?.bots.length ?? -1;
    if (on.dock && target) dock.layout(target, { count: dockCount, order: on.order }); else dock.close();
    tellAll();
    // the app's page summarises its bots only while a surface shows them; meanwhile it must keep up even behind other
    // windows: Electron's background throttling would slow its timers, and (since it also makes the page read as
    // hidden) its live stream would not reconnect, so a reply could wait until the app is shown again
    appPage()?.send("ambient:wanted", wanted());
    const throttle = !wanted();
    if (appPage() && throttled !== throttle) {
      throttled = throttle;
      note("page-throttling", String(throttle));
      appPage().setBackgroundThrottling?.(throttle);
    }
    followPointer();
  }

  // electron has no event for the pointer moving to another display: a cheap check, and only while it matters
  function followPointer() {
    const needed = started && screen && saved().display === "active" && (saved().island || saved().dock) && screen.getAllDisplays().length > 1;
    if (!needed) { clearInterval(follow); follow = null; return; }
    follow ??= setInterval(() => { if (display()?.id !== displayId) relayout("pointer on another display"); }, FOLLOW_MS);
    follow.unref?.();
  }

  const wanted = () => started && (saved().island || saved().dock);
  const view = () => ({ available: true, platform, ...saved(), seen: undefined, displays: screen ? screen.getAllDisplays().map(entry => ({ id: entry.id, internal: entry.internal === true, label: String(entry.label ?? "") })) : [] });

  // the page that publishes going away (reloading, leaving for another place, closing) takes the surfaces with it until a
  // page says who is there again
  const watched = new WeakSet();
  function watchPage(contents) {
    if (watched.has(contents) || typeof contents.on !== "function") return;
    watched.add(contents);
    const forget = (why) => {
      if (contents !== appPage() && !contents.isDestroyed?.()) return;
      if (!snapshot) return;
      snapshot = null;
      relayout(why);
    };
    contents.on("destroyed", () => forget("page gone"));
    contents.on("render-process-gone", () => forget("page crashed"));
    contents.on("did-start-navigation", (details, ...rest) => {
      // electron passes (details) or (event, url, isInPlace, isMainFrame)
      const mainFrame = typeof details?.isMainFrame === "boolean" ? details.isMainFrame : rest[2];
      const inPlace = typeof details?.isSameDocument === "boolean" ? details.isSameDocument : rest[1];
      if (mainFrame && !inPlace) forget("page navigating");
    });
  }

  ipcMain.on("ambient:publish", (event, raw) => {
    if (event.sender !== appPage()) return;
    const next = parseSnapshot(raw);
    if (!next) return;
    watchPage(event.sender);
    const hadBots = hasBots();
    snapshot = clock(next);
    try { from = new URL(event.senderFrame?.url ?? event.sender.getURL()).origin; } catch { from = null; }
    chats.want(snapshot, from);
    if (hadBots !== hasBots() || (next.bots.length !== dockCount && saved().dock)) relayout(hadBots !== hasBots() ? "bots arrived or left" : "bot count");
    else tellAll();
  });
  // Settings in whichever place the app's window shows; the preload asks a server's page for the person's click
  const fromApp = (channel, handler) => (event, ...args) => {
    if (event.sender !== appPage()) throw new Error(`${channel} is only available in this app's window`);
    return handler(...args);
  };
  ipcMain.handle("ambient:wanted", event => event.sender === appPage() && wanted());
  ipcMain.handle("ambient:prefs", fromApp("ambient:prefs", () => view()));
  ipcMain.handle("ambient:set", fromApp("ambient:set", change => {
    save(applyPrefsChange(saved(), change));
    relayout("settings");
    return view();
  }));

  const changed = (why = "display or server") => { try { relayout(typeof why === "string" ? why : "display or server"); } catch (error) { log(`ambient relayout failed: ${error?.message ?? error}`); } };
  return {
    /** Once the app is ready: `screen` exists only then. */
    start(electronScreen) {
      if (started) return;
      started = true;
      screen = electronScreen;
      if (activity) {
        stillness = watchStill({ ...activity, onChange: (still) => { island.send("ambient:still", still); dock.send("ambient:still", still); } });
      }
      for (const event of ["display-added", "display-removed", "display-metrics-changed"]) screen.on(event, changed);
      changed();
    },
    /** This app's server came up (the pages load from it) or its address changed. */
    refresh: changed,
    close() {
      started = false;
      clearInterval(follow); follow = null;
      stillness?.stop(); stillness = null;
      chats.stop();
      island.close(); dock.close();
    },
  };
}
