// A server connected by hand that stops answering keeps its place: the window shows this app's own page for it, with
// the chats it last saw there (read only, never fetched from it while it is down), "Reconnecting to {name}" and the
// next try's countdown, and looks again by itself until the server's page loads. The person may pick another
// workspace from there or the rail; nothing here ever changes which one is chosen (workspace-choice.mjs).
//
// Privacy: the frame keeps bot names and chat titles only, no message text, on this computer, for FRAME_MAX_AGE_MS,
// and goes when the server is forgotten.
import { serverLook } from "./saved-server.mjs";

export const RECONNECT_PATH = "/reconnect";
/** Waits between looks: quick at first (a service restart takes seconds), then every 30 s for as long as it takes. */
export const RETRY_MS = Object.freeze([2_000, 4_000, 8_000, 15_000, 30_000]);
export const FRAME_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** A frame is fetched again at most this often while the server's page is open. */
export const FRAME_EVERY_MS = 5 * 60 * 1000;
/** A status a proxy in front of the server answers with its own page when the server is gone: a 502 to 504 from any
 * proxy, and Cloudflare's 520 to 530 (a tunnel with no connector, as after uninstall.sh, is 530 "Error 1033"). */
export const proxyAnswersForDownServer = (code) => (code >= 502 && code <= 504) || (code >= 520 && code <= 530);
const FRAME_FETCH_MS = 5_000;
const LIMITS = Object.freeze({ bots: 60, groups: 30, chats: 25, text: 120 });

const originOf = (url) => { try { return new URL(url).origin; } catch { return null; } };
const text = (value) => (typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, LIMITS.text) : "");
const id = (value) => (typeof value === "string" && value.length > 0 && value.length <= 200 ? value : null);

/** What the frame keeps of a server's `GET /api/bots` answer: each bot's name and its chats' titles, each room's name. */
export function frameOf(body, at) {
  if (!body || typeof body !== "object") return null;
  const bots = (Array.isArray(body.bots) ? body.bots : []).slice(0, LIMITS.bots).flatMap((bot) => {
    const botId = id(bot?.id), name = text(bot?.name);
    if (!botId || !name) return [];
    const chats = (Array.isArray(bot.tasks) ? bot.tasks : []).slice(0, LIMITS.chats)
      .flatMap((task) => { const chatId = id(task?.threadId); return chatId ? [{ id: chatId, title: text(task.title) }] : []; });
    return [{ id: botId, name, chats }];
  });
  const groups = (Array.isArray(body.groups) ? body.groups : []).slice(0, LIMITS.groups)
    .flatMap((group) => { const groupId = id(group?.id), name = text(group?.name); return groupId && name ? [{ id: groupId, name }] : []; });
  return { at, bots, groups };
}

/**
 * @param {{
 *   fetch: typeof fetch,
 *   store: { read(): unknown, write(value: unknown): void },
 *   window(): { isDestroyed(): boolean, loadURL(url: string): Promise<unknown>, webContents: { getURL(): string, mainFrame: unknown } } | null,
 *   localOrigin(): string,
 *   localReady(): boolean,
 *   active(): { id: string, name: string, origin: string } | null,
 *   keeps?(entry: { id: string, origin: string }): boolean,
 *   places(): Array<{ id: string, name: string, local?: boolean }>,
 *   choose(id: string): unknown,
 *   remove?(id: string): unknown,
 *   publish?(view: unknown): void,
 *   timers?: { set(work: () => void, ms: number): unknown, clear(timer: unknown): void },
 *   now?(): number,
 *   log?(line: string): void,
 * }} deps `active()`: the chosen workspace when it is a server, else null. `keeps(entry)`: whether its frame is kept (a
 * server connected by hand; a team's Cloud may be another account's on this device, so nothing of it is kept). `choose(id)`:
 * the person picked another workspace on this page. `remove(id)`: the person removed the server it waits on.
 */
export function createWorkspaceReconnect(deps) {
  const { fetch: fetchImpl, store, window, localOrigin, localReady, active, keeps = () => true, places, choose, remove = () => false, publish = () => {},
    timers = { set: (work, ms) => setTimeout(work, ms), clear: (timer) => clearTimeout(timer) }, now = Date.now, log = () => {} } = deps;
  /** The server that isn't answering: `{ id, name, origin, attempt, nextAt, checking }`, else null. */
  let lost = null, timer = null;
  const fetchedAt = new Map();
  /** Servers whose page loaded since launch; a kept frame says the same across launches. */
  const connected = new Set();

  const frames = () => { try { const value = store.read(); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; } catch { return {}; } };
  const fresh = (frame) => Boolean(frame && Number.isFinite(frame.at) && now() - frame.at <= FRAME_MAX_AGE_MS);
  const clear = () => { if (timer) timers.clear(timer); timer = null; };
  const tell = () => { try { publish(view()); } catch {} };
  const onPage = () => {
    const win = window();
    if (!win || win.isDestroyed()) return false;
    try { const at = new URL(win.webContents.getURL()); return at.origin === localOrigin() && at.pathname === RECONNECT_PATH; } catch { return false; }
  };
  const showPage = () => {
    const win = window();
    if (!win || win.isDestroyed() || onPage() || !localReady()) return;
    void Promise.resolve(win.loadURL(`${localOrigin()}${RECONNECT_PATH}`)).catch(() => {});
  };
  /** Still the same chosen server: anything else (the person picked another, or forgot it) ends the wait. */
  const still = () => { const entry = active(); return Boolean(lost && entry && entry.id === lost.id && entry.origin === lost.origin); };

  function schedule() {
    clear();
    const ms = RETRY_MS[Math.min(lost.attempt, RETRY_MS.length - 1)];
    lost = { ...lost, nextAt: now() + ms, checking: false };
    timer = timers.set(() => { timer = null; void look(); }, ms);
    tell();
  }

  async function look() {
    if (!still()) return stop();
    clear();
    lost = { ...lost, attempt: lost.attempt + 1, checking: true, nextAt: null };
    tell();
    const entry = lost;
    const look = await serverLook(entry.origin, fetchImpl);
    if (lost !== entry || !still()) return lost === entry ? stop() : undefined;
    // a deleted madani cloud never comes back: said once, with Remove and the other places, and never looked at again
    if (look === "gone") {
      log(`workspace: ${entry.name} was deleted; it is no longer looked at`);
      lost = { ...lost, gone: true, checking: false, nextAt: null };
      showPage();
      tell();
      return;
    }
    if (look === "yes") {
      log(`workspace: ${entry.name} answers again; opening it`);
      const win = window();
      // its page loading is what ends the wait (loaded()); a load that fails comes back through lost()
      if (win && !win.isDestroyed()) void Promise.resolve(win.loadURL(entry.origin)).catch(() => {});
      schedule();
      return;
    }
    showPage();
    schedule();
  }

  function stop() {
    clear();
    if (!lost) return;
    lost = null;
    tell();
  }

  function view() {
    if (!lost) return null;
    const frame = lost.kept ? frames()[lost.id] : null;
    // a server added by hand that never opened has nothing kept and nothing to come back to: it can't be reached yet
    const neverConnected = lost.kept && !frame && !connected.has(lost.id);
    let host = "";
    try { host = new URL(lost.origin).host; } catch {}
    return { name: lost.name, host, attempt: lost.attempt, nextAt: lost.nextAt ?? null, checking: lost.checking === true,
      ...(lost.gone ? { gone: true } : {}),
      ...(neverConnected ? { neverConnected: true } : {}),
      ...(fresh(frame) ? { frame: { at: frame.at, bots: frame.bots ?? [], groups: frame.groups ?? [] } } : {}),
      places: places().filter((place) => place.id !== lost.id) };
  }

  async function remember(entry, force = false) {
    if (!keeps(entry)) return;
    const last = fetchedAt.get(entry.id) ?? 0;
    if (!force && now() - last < FRAME_EVERY_MS) return;
    fetchedAt.set(entry.id, now());
    try {
      const response = await fetchImpl(`${entry.origin}/api/bots?messages=0`, { credentials: "include", cache: "no-store", redirect: "error",
        signal: AbortSignal.timeout(FRAME_FETCH_MS), headers: { accept: "application/json", "x-madani-background": "1" } });
      if (!response.ok) { await response.body?.cancel?.().catch(() => {}); return; }
      const frame = frameOf(await response.json(), now());
      const current = active();
      if (!frame || !current || current.id !== entry.id) return;
      store.write({ ...frames(), [entry.id]: frame });
    } catch (error) {
      log(`workspace: could not keep ${entry.name}'s chat list (${error?.message ?? error})`);
    }
  }

  return {
    /** The chosen server's page didn't load: its place stays, and this page shows while it is looked at again. */
    lost(entry) {
      if (!entry?.id || !entry.origin) return;
      const again = lost?.id === entry.id && lost.origin === entry.origin;
      if (!again) log(`workspace: ${entry.name} isn't answering; it stays chosen and is looked at again`);
      lost = again ? lost : { id: entry.id, name: entry.name, origin: entry.origin, kept: keeps(entry) === true, attempt: 0, nextAt: null, checking: false };
      showPage();
      if (lost.gone || lost.checking) return;
      // a page that answered "gone" is looked at now, so the deleted state shows at once
      if (entry.gone) void look(); else schedule();
    },
    /** A page of the main frame finished loading: the chosen server's own ends the wait and refreshes its frame. */
    loaded(url) {
      const entry = active();
      if (!entry || originOf(url) !== entry.origin || !/^https?:/u.test(url)) {
        // this computer's page came up after a server was chosen that is still down: show the wait again
        if (lost && still() && originOf(url) === localOrigin() && !onPage()) showPage();
        return;
      }
      const back = Boolean(lost);
      connected.add(entry.id);
      if (lost) stop();
      void remember(entry, back);
    },
    /** The person asked to look again now (the page's button, back online, the window focused). */
    retry() {
      if (lost && !lost.checking && !lost.gone) void look();
      return view();
    },
    stop,
    view,
    /** `event` came from this page in the main window's main frame. */
    page(event) {
      const win = window();
      if (!win || win.isDestroyed() || event?.sender !== win.webContents || !event.senderFrame || event.senderFrame !== win.webContents.mainFrame) return false;
      try { const at = new URL(event.senderFrame.url); return at.origin === localOrigin() && at.pathname === RECONNECT_PATH; } catch { return false; }
    },
    /** The person picked another workspace on this page: only one the page was offered. */
    choose(placeId) {
      const shown = view();
      if (!shown || typeof placeId !== "string" || !shown.places.some((place) => place.id === placeId)) throw new Error("Choose one of the places listed.");
      return choose(placeId);
    },
    /** The person removed the server this page waits on. */
    remove() {
      if (!lost) throw new Error("There is no server to remove.");
      return remove(lost.id);
    },
    /** The server was forgotten: its frame goes with it. */
    forget(placeId) {
      fetchedAt.delete(placeId);
      connected.delete(placeId);
      const all = frames();
      if (!Object.hasOwn(all, placeId)) return;
      const { [placeId]: _gone, ...rest } = all;
      try { store.write(rest); } catch {}
    },
  };
}

/** The page's IPC: what it shows, look again now, the person's pick of another workspace, and removing the server. */
export function installWorkspaceReconnectIpc({ ipcMain, reconnect }) {
  const from = (channel, handler) => (event, ...args) => {
    if (!reconnect.page(event)) throw new Error(`${channel} is only available in this app's window`);
    return handler(...args);
  };
  ipcMain.handle("workspace-reconnect:state", from("workspace-reconnect:state", () => reconnect.view()));
  ipcMain.handle("workspace-reconnect:retry", from("workspace-reconnect:retry", () => reconnect.retry()));
  ipcMain.handle("workspace-reconnect:open", from("workspace-reconnect:open", (placeId) => reconnect.choose(placeId)));
  ipcMain.handle("workspace-reconnect:remove", from("workspace-reconnect:remove", () => reconnect.remove()));
}
