import type { AppState } from "@/state/store";
import { threadsNeedingPages } from "@/state/use-selected-transcript";
import type { MobileConnectionRecord } from "../../shared/mobile-link";

const OPEN_CHAT_KEY = "madani.mobile.openChat";

/** The chat open when the page last unloaded on this place: iOS reclaiming a backgrounded web view reloads the page,
 * sessionStorage stays. A chat kept for another place, or before a sign-out, is not reopened. */
export function readOpenChat(place: string | null): string | null {
  try {
    const kept: unknown = JSON.parse(sessionStorage.getItem(OPEN_CHAT_KEY) ?? "null");
    if (!kept || typeof kept !== "object") return null;
    const { place: keptPlace, chat } = kept as { place?: unknown; chat?: unknown };
    return keptPlace === place && typeof chat === "string" && chat ? chat : null;
  } catch { return null; }
}

export function rememberOpenChat(id: string | null, place: string | null = null): void {
  try {
    if (id) sessionStorage.setItem(OPEN_CHAT_KEY, JSON.stringify({ place, chat: id }));
    else sessionStorage.removeItem(OPEN_CHAT_KEY);
  } catch { /* storage off */ }
}

/** The saved place a link or notification belongs to when it is not the one on screen: its chat lives there. */
export function placeForTarget(environmentId: string | undefined, records: readonly Pick<MobileConnectionRecord, "id" | "environmentId">[], activeId: string | null): string | null {
  if (!environmentId) return null;
  const active = records.find((record) => record.id === activeId);
  if (active?.environmentId === environmentId) return null;
  return records.find((record) => record.environmentId === environmentId)?.id ?? null;
}

/** "wait" until the snapshot has landed; then the chat to open again, or null when it is gone from this workspace. */
export function restoredChat(id: string, state: Pick<AppState, "hydrated" | "bots" | "groups">): string | null | "wait" {
  if (!state.hydrated) return "wait";
  return state.bots.some((bot) => bot.id === id) || state.groups.some((group) => group.id === id) ? id : null;
}

/** A snapshot read aborts the transcript reads under way, so with any still loading the stream-down reread waits: on a
 * slow route a read every few seconds would abort them every time and leave the open chat empty. */
export function rereadDue(state: Pick<AppState, "bots" | "groups">, hidden: boolean): boolean {
  return !hidden && threadsNeedingPages(state).length === 0;
}
