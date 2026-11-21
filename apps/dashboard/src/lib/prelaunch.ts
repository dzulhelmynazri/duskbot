// before launch (MADANI_PRELAUNCH_WAITLIST_ONLY on the account service) the page only exists for a real flow: the desktop
// app's sign-in, an emailed link, a handoff, claim or delete link (the admin panel is used from preview then). the server checks what it can see on load and marks
// the page; this sends every in-page move outside such a flow to the waitlist at /.

/** set by the server in the page's <head> while waitlist-only is on */
export const PRELAUNCH = typeof document !== "undefined" && document.querySelector('meta[name="madani-prelaunch"]')?.getAttribute("content") === "1";

/** the flow this tab arrived with: tokens that only ever come from a link and never sit in the address bar */
export interface PrelaunchFlows { handoff: boolean; claim: boolean; deleting(id: string): boolean; appReturn?: boolean; teamInvite?: boolean }

const DELETE = /^\/clouds\/([^/]+)\/delete$/;

/** whether `path` (app path, no base) may show before launch; anything else goes to the waitlist */
export function prelaunchAllowed(path: string, query: URLSearchParams, flows: PrelaunchFlows, depth = 0): boolean {
  if (path === "/cloud/desktop") return Boolean(query.get("code"));
  if (path === "/handoff") return flows.handoff;
  if (path === "/app-signed-in") return Boolean(flows.appReturn);
  if (path === "/claim") return flows.claim;
  if (path === "/team/join") return Boolean(flows.teamInvite);
  const deleting = DELETE.exec(path);
  if (deleting) { try { return flows.deleting(decodeURIComponent(deleting[1]!)); } catch { return false; } }
  if ((path === "/sign-in" || path === "/signin") && depth === 0) {
    if (query.get("attempt")) return true;
    const next = query.get("next");
    if (!next?.startsWith("/") || next.startsWith("//") || next.includes("\\")) return false;
    const target = new URL(next, "http://x");
    return prelaunchAllowed(target.pathname.replace(/\/+$/, "") || "/", target.searchParams, flows, 1);
  }
  return false;
}
