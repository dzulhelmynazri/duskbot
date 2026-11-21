// A server connected by hand, before the window goes there: the window goes only to a server that answers; one that
// doesn't (its name no longer resolves, nothing listens) is the person's choice: try again, remove it, or stay.
import { goneAnswer } from "./cloud-power.mjs";

/** How long a server has to answer before it counts as not answering. */
export const SERVER_LOOK_MS = 3_000;
/** A linked vps answers through this app's own tunnel proxy, which opens a moment after launch: it is looked at quietly
 * this long before anyone is asked. */
export const TUNNEL_GRACE_MS = 15_000;
const LOOK_AGAIN_MS = 1_000;

/** The local address of a vps linked through the tunnel (vps-link.mjs): http://vps-<id>.localhost:<port>. */
export function tunnelOrigin(origin) {
  try { return /^vps-[^.]+\.localhost$/iu.test(new URL(origin).hostname); } catch { return false; }
}

/** "yes" when anything answers at `origin` (any HTTP status but a 5xx from a proxy in front of a stopped app), "gone" for a
 * madani cloud that was deleted, else "no". */
export async function serverLook(origin, fetchImpl, timeoutMs = SERVER_LOOK_MS) {
  try {
    const response = await fetchImpl(`${origin}/.well-known/madanibot/environment`, {
      cache: "no-store", redirect: "manual", credentials: "omit", signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" },
    });
    await response.body?.cancel?.().catch(() => {});
    if (goneAnswer(response)) return "gone";
    return response.status < 500 ? "yes" : "no";
  } catch {
    return "no";
  }
}

/** Whether anything answers at `origin`; a deleted madani cloud does not. */
export async function serverAnswers(origin, fetchImpl, timeoutMs = SERVER_LOOK_MS) {
  return (await serverLook(origin, fetchImpl, timeoutMs)) === "yes";
}

/** Whether `origin` answers within `withinMs`, looked at again every second until then. */
export async function serverAnswersWithin(origin, fetchImpl, { withinMs, timeoutMs = SERVER_LOOK_MS, everyMs = LOOK_AGAIN_MS, now = Date.now, sleep = (ms) => new Promise((done) => setTimeout(done, ms)) }) {
  const until = now() + withinMs, looks = Math.max(1, Math.floor(withinMs / everyMs) + 1);
  for (let look = 1; ; look++) {
    if (await serverAnswers(origin, fetchImpl, timeoutMs)) return true;
    // by the clock, and by count too, so a stopped clock never looks forever
    if (look >= looks || now() + everyMs > until) return false;
    await sleep(everyMs);
  }
}

/**
 * True when the window may go to `entry` now. A server that doesn't answer asks the person, in one dialog: Try again
 * (looks once more), Remove from list (`forget(entry.id)`, then false), or Cancel (false: the window stays where it is).
 * A vps reached through the tunnel is first given TUNNEL_GRACE_MS, since right after launch its proxy may not be open yet.
 * @param {{ id: string, name: string, origin: string }} entry
 * @param {{ fetch: typeof fetch, dialog: { showMessageBox(options: object): Promise<{ response: number }> }, forget: (id: string) => unknown, timeoutMs?: number, graceMs?: number, now?: () => number, sleep?: (ms: number) => Promise<void> }} deps
 */
export async function serverOpens(entry, { fetch: fetchImpl, dialog, forget, timeoutMs = SERVER_LOOK_MS, graceMs = TUNNEL_GRACE_MS, now, sleep }) {
  let first = tunnelOrigin(entry.origin);
  for (;;) {
    const answers = first ? await serverAnswersWithin(entry.origin, fetchImpl, { withinMs: graceMs, timeoutMs, now, sleep }) : await serverAnswers(entry.origin, fetchImpl, timeoutMs);
    first = false;
    if (answers) return true;
    const { response } = await dialog.showMessageBox({
      type: "warning", buttons: ["Try again", "Remove from list", "Cancel"], defaultId: 0, cancelId: 2,
      message: `${entry.name} isn't answering`,
      detail: `Nothing answers at ${new URL(entry.origin).host}. If that server is gone for good, remove it from your list. Your bots elsewhere aren't affected.`,
    });
    if (response === 1) { await forget(entry.id); return false; }
    if (response !== 0) return false;
  }
}

/**
 * A server being added, looked at before it is saved: "open" when it answers (save it and go there), else the person's
 * choice in one dialog: Try again (looks once more), Keep in list ("keep": saved, the window stays where it is), or
 * Cancel ("cancel": nothing is saved). The window never goes to a server that has never answered.
 * @param {{ origin: string }} link
 * @param {{ fetch: typeof fetch, dialog: { showMessageBox(options: object): Promise<{ response: number }> }, timeoutMs?: number }} deps
 * @returns {Promise<"open" | "keep" | "cancel">}
 */
export async function newServerReach(link, { fetch: fetchImpl, dialog, timeoutMs = SERVER_LOOK_MS }) {
  const host = new URL(link.origin).host;
  for (;;) {
    if (await serverAnswers(link.origin, fetchImpl, timeoutMs)) return "open";
    const { response } = await dialog.showMessageBox({
      type: "warning", buttons: ["Try again", "Keep in list", "Cancel"], defaultId: 0, cancelId: 2,
      message: `${host} isn't answering yet`,
      detail: "Nothing answered at that address. Check it's typed right and the server is running. You can keep it in your list and open it once it's up.",
    });
    if (response === 1) return "keep";
    if (response !== 0) return "cancel";
  }
}
