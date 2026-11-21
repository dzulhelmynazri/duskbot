// connecting an app through composio connect: authorize composio once, then sign in to the app on composio's page.
// composio's sign-in link expires in 10 minutes (its own instruction text), so a wait that long is a timeout.
import { ApiError } from "@/state/api";
import { friendlyError } from "@/lib/plain-error";

export type ViaFailure = "authorize" | "cancelled" | "timeout" | "signedOut" | "offline" | "refused";

export type ViaFlow =
  /** `opened`: the sign-in page is up in the browser; until then the press is still fetching its link */
  | { step: "authorizing"; opened?: boolean }
  /** `note`: notYet once the person came back and it still is not connected; trouble while composio or madani cannot be reached */
  | { step: "waiting"; url: string; since: number; note?: "notYet" | "trouble" }
  | { step: "done" }
  | { step: "failed"; why: ViaFailure; message?: string };

export const VIA_DEADLINE_MS = 10 * 60_000;
/** back in madani this long without the sign-in done: the attempt was left, so it fails with retry instead of spinning */
export const VIA_GRACE_MS = 75_000;
/** back in madani this long without the sign-in done: the row offers Retry beside the sign-in still out */
export const VIA_STALL_MS = 15_000;
/** one status read never holds the wait up longer than this */
export const VIA_READ_MS = 40_000;
const DELAYS = [2_000, 3_000, 5_000, 8_000, 13_000, 15_000];

/** Waits between status checks: quick at first, then every 15 s. */
export const viaDelay = (attempt: number) => DELAYS[Math.min(Math.max(attempt, 0), DELAYS.length - 1)]!;

/** A failed status check: signed out of composio (authorize again), refused for good, or trouble worth retrying
 * (network down, madani restarting, composio unreachable). */
export function classifyViaError(cause: unknown): { kind: "signedOut" } | { kind: "refused"; message: string } | { kind: "trouble" } {
  if (!(cause instanceof ApiError)) return { kind: "trouble" };
  const code = typeof cause.body?.code === "string" ? cause.body.code : "";
  if (code === "composio_connect_signed_out" || code === "composio_connect_missing") return { kind: "signedOut" };
  if (cause.status >= 500 || cause.status === 408 || cause.status === 429) return { kind: "trouble" };
  return { kind: "refused", message: friendlyError(cause) };
}

const PENDING = "madani.composioConnect.pending";
type Pending = Record<string, { url: string; since: number }>;

/** Sign-ins still out, kept across a reload or a restart so the wait picks up where it was. */
export function readPendingVia(now = Date.now()): Pending {
  try {
    const raw = JSON.parse(localStorage.getItem(PENDING) ?? "{}") as Pending;
    return Object.fromEntries(Object.entries(raw).filter(([, entry]) => typeof entry?.url === "string" && typeof entry.since === "number" && entry.since <= now && now - entry.since < VIA_DEADLINE_MS));
  } catch {
    return {};
  }
}

export function keepPendingVia(slug: string, entry: { url: string; since: number } | null): void {
  try {
    const next = { ...readPendingVia() };
    if (entry) next[slug] = entry; else delete next[slug];
    localStorage.setItem(PENDING, JSON.stringify(next));
  } catch { /* private mode */ }
}

/** Calls `onBack` each time the person comes back to this window, and `onGiveUp` once they have stayed back for
 * `graceMs` without the sign-in finishing. Going away again (to the sign-in page) stops that clock. */
export function watchReturn(onBack: () => void, onGiveUp: () => void, graceMs = VIA_GRACE_MS): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const away = () => { clearTimeout(timer); timer = undefined; };
  const back = () => {
    if (document.visibilityState === "hidden") { away(); return; }
    onBack();
    timer ??= setTimeout(() => { timer = undefined; onGiveUp(); }, graceMs);
  };
  window.addEventListener("focus", back);
  window.addEventListener("blur", away);
  document.addEventListener("visibilitychange", back);
  return () => {
    away();
    window.removeEventListener("focus", back);
    window.removeEventListener("blur", away);
    document.removeEventListener("visibilitychange", back);
  };
}
