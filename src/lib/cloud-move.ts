// "Runs on" in a bot's Computer tab: where this page's bots are hosted, and the move to the paid Cloud desktop as one
// flow. The move itself is the one-time move (electron/one-home.mjs): after checkout it starts by itself unless the person
// keeps this computer's bots here, and keeping them here again is the way back.
import { useSyncExternalStore } from "react";
import type { KeepHereState } from "../../electron/cloud-send.mjs";
import type { CloudDesktopView } from "@/lib/cloud-desktop";

export type RunsOnKind = "mac" | "pc" | "vps" | "cloud";
export type RunsOnStatus = "awake" | "asleep" | "offline";

export interface RunsOnHost {
  kind: RunsOnKind;
  /** The server's own name, for a VPS. */
  name: string | null;
}

/** Where this page's bots run: the Cloud's own page, another server's page (the person's VPS), or this computer. */
export function runsOnHost(input: { cloudHome: boolean; otherServer: string | null; platform: string }): RunsOnHost {
  if (input.cloudHome) return { kind: "cloud", name: null };
  if (input.otherServer) return { kind: "vps", name: input.otherServer };
  return { kind: input.platform === "darwin" ? "mac" : "pc", name: null };
}

/** Offline while the page has lost its server; otherwise awake while the bot's screen shows or wakes, asleep when not. */
export function runsOnStatus(connected: boolean, screen: "screen" | "loading" | "asleep" | "off" | null): RunsOnStatus {
  if (!connected) return "offline";
  return screen === "screen" || screen === "loading" ? "awake" : "asleep";
}

/**
 * The move sheet's stage. `buy`: no Cloud desktop yet, so checkout comes first (`resume`: one is already open);
 * `preparing`: paid, being set up or waking, and the move starts by itself after; `ready`: one tap moves (the person
 * kept their bots here before); `moving`; `moved`: they are there, and can come back; `coming-back`; `manage`: the
 * account's Cloud needs the Plan page first; `elsewhere`: this page cannot run the move (another server's page);
 * `open`: a Cloud desktop the move does not apply to, which only opens.
 */
export type CloudMoveStage = "buy" | "resume" | "preparing" | "ready" | "moving" | "moved" | "coming-back" | "manage" | "open" | "elsewhere";

/** The account has a madani cloud: never an offer to buy one, only the way to it. */
export function hasMadaniCloud(stage: CloudMoveStage | null): boolean {
  return stage !== null && stage !== "buy" && stage !== "resume" && stage !== "elsewhere";
}

export function cloudMoveStage(view: CloudDesktopView | null, keep: KeepHereState | null): CloudMoveStage {
  if (!view) return "elsewhere";
  switch (view.step) {
    case "get": return "buy";
    case "finish": return "resume";
    case "setup": case "waking": return "preparing";
    case "move": return "ready";
    case "moving": return "moving";
    case "back": return "moved";
    case "coming-back": return "coming-back";
    case "manage": case "other": return "manage";
    case "open": return keep?.moved ? "moved" : "open";
  }
}

/** The stages that go on by themselves: the sheet shows progress, never a button that starts something. */
export const MOVE_IN_PROGRESS: ReadonlySet<CloudMoveStage> = new Set(["preparing", "moving", "coming-back"]);

/** A move the person asked for here and has not seen through: after checkout the sheet finishes it with no second tap.
 * Kept a day, so a checkout left open and paid tomorrow still moves. */
export const MOVE_INTENT_KEY = "madani-cloud-move-intent";
const INTENT_MS = 24 * 3600_000;

export function moveIntended(stored: string | null, now: number): boolean {
  const at = Number(stored);
  return Number.isFinite(at) && at > 0 && now - at < INTENT_MS && at <= now;
}

/** What the sheet does when the stage changes under an intent: the one step left, or nothing. */
export function moveFollowUp(stage: CloudMoveStage, intended: boolean): "move" | "clear" | null {
  if (!intended) return null;
  if (stage === "ready") return "move";
  if (stage === "moved" || stage === "open") return "clear";
  return null;
}

// whether the move sheet is open, and which way: one tiny store, so the Computer tab and the checkout's end open the same one
export type CloudMoveTarget = "cloud" | "home";
let opened: CloudMoveTarget | null = null;
const watchers = new Set<() => void>();
const tell = () => { for (const watch of Array.from(watchers)) watch(); };
export function openCloudMove(target: CloudMoveTarget = "cloud"): void { opened = target; tell(); }
export function closeCloudMove(): void { opened = null; tell(); }
export function useCloudMoveOpen(): CloudMoveTarget | null {
  return useSyncExternalStore((watch) => { watchers.add(watch); return () => { watchers.delete(watch); }; }, () => opened, () => null);
}

export function readMoveIntent(): string | null { try { return localStorage.getItem(MOVE_INTENT_KEY); } catch { return null; } }
export function writeMoveIntent(on: boolean): void {
  try { if (on) localStorage.setItem(MOVE_INTENT_KEY, String(Date.now())); else localStorage.removeItem(MOVE_INTENT_KEY); } catch {}
}
