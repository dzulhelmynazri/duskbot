// The desktop app asks for the bots' browsers to quit before the computer logs out or shuts down, and before it quits
// on Windows, where Electron's utilityProcess.kill() ends this server without a signal: a Chrome that is only killed
// loses the cookies it has not written yet, so sign-ins made just before are gone on the next start.

export const BROWSERS_FLUSH = "madanibot:browsers-flush";
export const BROWSERS_FLUSHED = "madanibot:browsers-flushed";

export interface BrowsersFlushRequest {
  type: typeof BROWSERS_FLUSH;
  requestId: string;
  /** The app is going away for sure; false while Windows only asks whether the session may end, which can be cancelled. */
  final: boolean;
}

export interface BrowsersFlushReply {
  type: typeof BROWSERS_FLUSHED;
  requestId: string;
  ok: boolean;
}

export interface BrowsersFlushDeps {
  /** Quits every browser through its own close, which writes cookies to disk. */
  flush(final: boolean): Promise<void>;
  reply(message: BrowsersFlushReply): void;
  log?(line: string): void;
}

export function createBrowsersFlush(deps: BrowsersFlushDeps) {
  let queue: Promise<unknown> = Promise.resolve();

  /** True when `raw` was a flush request, answered once the browsers have quit or failed to. */
  function receive(raw: unknown): boolean {
    if (!raw || typeof raw !== "object") return false;
    const message = raw as Partial<BrowsersFlushRequest>;
    if (message.type !== BROWSERS_FLUSH) return false;
    if (typeof message.requestId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(message.requestId)) return true;
    const requestId = message.requestId;
    const final = message.final === true;
    const run = queue.then(() => deps.flush(final)).then(() => true, (error: unknown) => {
      deps.log?.(`browser: could not quit the browsers before exit (${error instanceof Error ? error.message : String(error)})`);
      return false;
    });
    queue = run;
    void run.then((ok) => deps.reply({ type: BROWSERS_FLUSHED, requestId, ok }));
    return true;
  }

  return { receive };
}
