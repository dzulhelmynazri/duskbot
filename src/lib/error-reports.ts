// privacy: an error's type, message, stack and the page path only, through the preload bridge; main sends it to the
// account service only while the person keeps error reports on.
import type { ErrorReportsBridge } from "../../electron/account-errors.mjs";

const MAX_PER_LOAD = 5;

export function createErrorReports(bridge: ErrorReportsBridge | undefined, path = () => location.pathname) {
  let left = MAX_PER_LOAD;
  const seen = new Set<string>();
  return (error: unknown) => {
    if (!bridge) return;
    const err = error instanceof Error ? error : new Error(typeof error === "string" ? error : "non-error rejection");
    if (/ResizeObserver loop/.test(err.message)) return;
    const stack = (err.stack ?? "").split("\n").slice(1, 31).join("\n");
    const key = `${err.name}|${err.message}|${stack.split("\n")[0] ?? ""}`;
    if (seen.has(key) || left <= 0) return;
    seen.add(key);
    left--;
    void bridge.send({ type: err.name, message: err.message.slice(0, 500), stack: stack.slice(0, 4000), path: path().slice(0, 120) }).catch(() => {});
  };
}

const report = typeof window === "undefined" ? () => {} : createErrorReports(window.madaniDesktop?.errorReports);
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("error", event => report(event.error ?? event.message));
  window.addEventListener("unhandledrejection", event => report(event.reason));
}

/** The technical words behind a plain line on screen: they go to the error report (when the person keeps it on), never
 * onto the page. Once per text per load, as every report is. */
export function reportShownError(text: string) {
  report(new ShownError(text));
}
class ShownError extends Error {
  override name = "ShownError";
}

/** createRoot's options: an error a boundary caught is still logged as React logs it, and reported */
export const rootErrorOptions = {
  onCaughtError(error: unknown) {
    console.error(error);
    report(error);
  },
};
