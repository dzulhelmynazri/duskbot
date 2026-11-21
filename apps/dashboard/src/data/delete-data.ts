// an owner deleting a managed cloud's data: the emailed link's token, the sign-in-again round trip, and what to say.
// the token lives in this tab's sessionStorage only, never in the address bar or localStorage.
import { api, ApiError } from "../lib/api";
import { appPath } from "../lib/router";
import type { BillingOverview, CloudDesktop } from "./contracts";

export const DELETE_WINDOW_DAYS = 7;
const HOUR = 3_600_000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const PAGE = /^\/clouds\/([^/]+)\/delete\/?$/;
const RETRY = "madani-dash-delete-retry";
const tokenKey = (id: string) => `madani-dash-delete-token:${id}`;

export type DeleteStep = "ask" | "confirm";

export function deletePageId(path: string): string | null {
  const m = PAGE.exec(path);
  if (!m) return null;
  try { return decodeURIComponent(m[1]!); } catch { return null; }
}

export const deletePagePath = (id: string) => `/clouds/${encodeURIComponent(id)}/delete`;

/** on a delete link: keeps its token for this tab and takes it out of the address bar */
export function stashDeleteToken() {
  const id = deletePageId(appPath(location.pathname));
  if (!id || !location.hash) return;
  const token = location.hash.slice(1);
  history.replaceState(history.state, "", location.pathname + location.search);
  if (TOKEN.test(token)) try { sessionStorage.setItem(tokenKey(id), token); } catch {}
}

export function deleteToken(id: string): string | null {
  try { return sessionStorage.getItem(tokenKey(id)); } catch { return null; }
}

export function forgetDeleteToken(id: string) {
  try { sessionStorage.removeItem(tokenKey(id)); } catch {}
}

function pendingRetry(now = Date.now()): { step: DeleteStep; id: string } | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(RETRY) ?? "null") as { step?: unknown; id?: unknown; at?: unknown } | null;
    if (!saved || (saved.step !== "ask" && saved.step !== "confirm") || typeof saved.id !== "string" || typeof saved.at !== "number" || now - saved.at > HOUR / 2) return null;
    return { step: saved.step, id: saved.id };
  } catch { return null; }
}

/** once signed in again, whether `step` for this cloud was waiting on it; it runs once */
export function takeRetry(step: DeleteStep, id: string): boolean {
  const pending = pendingRetry();
  if (!pending || pending.step !== step || pending.id !== id) return false;
  try { sessionStorage.removeItem(RETRY); } catch {}
  return true;
}

/** deleting needs a sign-in from the last 10 minutes: signs out, and the page goes on with `step` once signed back in */
export async function signInAgain(step: DeleteStep, id: string, setAccount: (account: null) => void) {
  try { sessionStorage.setItem(RETRY, JSON.stringify({ step, id, at: Date.now() })); } catch {}
  try { await api.signOut(); } catch {}
  setAccount(null);
}

/** the sign-in screen's note while a delete is waiting on it */
export function deleteSignInNote(path: string): string | undefined {
  return deletePageId(path) || pendingRetry() ? "sign in to go on with deleting your cloud's data." : undefined;
}

export const needsSignIn = (error: unknown) => error instanceof ApiError && error.code === "reauth_required";

/** a managed cloud whose plan no longer pays for it; the service has the final word (409 billing_active) */
export function canDeleteData(cloud: CloudDesktop, billing: BillingOverview | null, now = Date.now()): boolean {
  if (cloud.provider !== "managed" || cloud.deleteScheduledAt) return false;
  if (cloud.status === "stopped") return true;
  if (billing === null) return false;
  const sub = billing.subscription;
  return !sub || (sub.status === "canceled" && sub.currentPeriodEnd <= now);
}

export function deletion(cloud: CloudDesktop, now = Date.now()): "scheduled" | "asked" | null {
  if (cloud.deleteScheduledAt) return "scheduled";
  if (cloud.deleteAskedAt && now - cloud.deleteAskedAt < HOUR) return "asked";
  return null;
}

const MESSAGES: Record<string, string> = {
  billing_active: "its plan is still active. cancel it in plans and billing first; you can delete the data once the plan has ended.",
  confirmation_required: "this link has expired or was already used. ask for a new one from your madani cloud page.",
  rate_limited: "too many tries. wait a while, then try again.",
  unavailable: "deleting has already started, so it can no longer be cancelled.",
  not_found: "this cloud is not on your account.",
  invalid_request: "this link is not complete. open it again from the email.",
};

export function deleteDataError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code && MESSAGES[error.code]) return MESSAGES[error.code]!;
    // the delete routes answer with the bare code as their error
    if (error.message && error.message !== error.code) return error.message;
  }
  return "that did not work. try again.";
}
