// The bots' browsers quit through Chrome's own close before the computer logs out or shuts down, so the cookies of a
// sign-in made just before reach disk. Windows only tells windows ("query-session-end", then "session-end"),
// powerMonitor "shutdown" covers macOS and Linux, and on Windows the app's quit needs it too: utilityProcess.kill()
// there ends the server without a signal, so the server's own graceful shutdown never runs.

export const BROWSERS_FLUSH = "madanibot:browsers-flush";
export const BROWSERS_FLUSHED = "madanibot:browsers-flushed";
/** Long enough for Chrome to quit and write its profile; short enough that the OS does not call the app hung. */
export const BROWSERS_FLUSH_MS = 4_000;

/**
 * @param {{ server: () => { postMessage(message: object): void } | null, randomId: () => string, timeoutMs?: number,
 *   setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} deps
 */
export function createBrowsersFlush({ server, randomId, timeoutMs = BROWSERS_FLUSH_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  /** @type {Map<string, (ok: boolean) => void>} */
  const pending = new Map();
  /** @type {Promise<boolean> | null} */
  let finalFlush = null;

  /** @param {{ final: boolean }} options @returns {Promise<boolean>} true once the server says its browsers quit */
  function ask({ final }) {
    const proc = server();
    if (!proc) return Promise.resolve(false);
    const requestId = randomId().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "flush";
    return new Promise((resolve) => {
      const timer = setTimer(() => settle(false), timeoutMs);
      timer?.unref?.();
      function settle(ok) {
        if (!pending.has(requestId)) return;
        pending.delete(requestId);
        clearTimer(timer);
        resolve(ok);
      }
      pending.set(requestId, settle);
      try {
        proc.postMessage({ type: BROWSERS_FLUSH, requestId, final });
      } catch {
        settle(false);
      }
    });
  }

  /** The app is going away: asked once, every later caller waits on the same answer. */
  function flush() {
    finalFlush ??= ask({ final: true });
    return finalFlush;
  }

  /** Windows asks whether the session may end, and another app may still cancel it. */
  function prepare() {
    return finalFlush ?? ask({ final: false });
  }

  /** @returns {boolean} true when `message` was a flush answer */
  function receive(message) {
    if (!message || typeof message !== "object" || message.type !== BROWSERS_FLUSHED || typeof message.requestId !== "string") return false;
    pending.get(message.requestId)?.(message.ok === true);
    return true;
  }

  return { flush, prepare, receive };
}

/**
 * @param {{ app: { on(event: string, listener: (...args: any[]) => void): void }, windows: () => Array<{ on(event: string, listener: () => void): void }>, powerMonitor: { on(event: string, listener: (event: { preventDefault(): void }) => void): void },
 *   flusher: ReturnType<typeof createBrowsersFlush>, quit: () => void, log?: (line: string) => void, onSessionEnd?: () => void }} deps
 */
export function installSessionEndFlush({ app, windows, powerMonitor, flusher, quit, log, onSessionEnd }) {
  const watch = (win) => {
    win.on("query-session-end", () => { void flusher.prepare(); });
    win.on("session-end", () => { onSessionEnd?.(); void flusher.flush(); });
  };
  for (const win of windows()) watch(win);
  app.on("browser-window-created", (_event, win) => watch(win));
  let shuttingDown = false;
  powerMonitor.on("shutdown", (event) => {
    // Electron delays the shutdown only while the app has not quit, and expects a quit soon after.
    event.preventDefault();
    if (shuttingDown) return;
    shuttingDown = true;
    void flusher.flush().then((ok) => {
      if (!ok) log?.("browser: the bots' browsers did not confirm they quit before shutdown");
    }).finally(quit);
  });
}
