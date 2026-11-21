import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";

import { reducedMotion } from "./onboarding";

/** The bot panel's usual width. */
export const PANEL_NARROW = 320;
/** The narrowest a drag of the panel's edge leaves it. */
export const PANEL_MIN = 280;
/** The chat keeps at least this much beside a widened panel. */
const CHAT_KEEPS = 420;
const WIDE_MAX = 880;
const REST_KEY = "madani-bot-panel-width";

function storedRest(): number {
  try {
    const stored = Number(globalThis.localStorage?.getItem(REST_KEY));
    if (Number.isFinite(stored) && stored >= PANEL_MIN && stored <= WIDE_MAX) return Math.round(stored);
  } catch {
  }
  return PANEL_NARROW;
}

/** The width the person dragged the panel's edge to, which it comes back to after the browser in it widens it. */
let rest = storedRest();
let width = rest;
if (rest !== PANEL_NARROW && typeof document !== "undefined") document.documentElement.style.setProperty("--side-panel-w", `${rest}px`);
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => width;

/** The panel's width now: where its edge was dragged to, or wider while the browser in it is expanded. */
export function usePanelWidth(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function panelWide(): boolean {
  return width > rest;
}

export function panelRest(): number {
  return rest;
}

/** The widest a drag leaves the panel: never squeezing the chat beside it under CHAT_KEEPS. */
export function panelRestMax(): number {
  return Math.max(PANEL_MIN, Math.min(WIDE_MAX, Math.round(sharedRoom() - CHAT_KEEPS)));
}

/** The panel's edge was dragged or stepped to `next`: it rests there, kept for the next open once `keep` is set. */
export function resizePanel(next: number, keep = false): number {
  rest = Math.round(Math.min(panelRestMax(), Math.max(PANEL_MIN, next)));
  apply(rest);
  if (keep) {
    try {
      globalThis.localStorage?.setItem(REST_KEY, String(rest));
    } catch {
    }
  }
  return rest;
}

/** About 60% of the room the chat and panel share, never squeezing the chat under CHAT_KEEPS. */
export function wideWidth(shared: number): number {
  return Math.round(Math.max(PANEL_NARROW, Math.min(WIDE_MAX, shared * 0.6, shared - CHAT_KEEPS)));
}

/** The room the chat and a docked panel share; a panel over the chat (a narrow window) has the window's. */
function sharedRoom(): number {
  // a server render (and its tests) has no page to measure: the panel may take its widest
  if (typeof document === "undefined" || typeof document.querySelector !== "function") return WIDE_MAX + CHAT_KEEPS;
  const slot = document.querySelector<HTMLElement>("[data-panel-slot]");
  const chat = slot?.parentElement?.querySelector<HTMLElement>(":scope > main");
  if (slot && chat) return slot.getBoundingClientRect().right - chat.getBoundingClientRect().left;
  return window.innerWidth - 48;
}

function apply(next: number): void {
  if (next === width) return;
  width = next;
  document.documentElement.style.setProperty("--side-panel-w", `${next}px`);
  for (const listener of listeners) listener();
}

function onResize(): void {
  if (width > rest) apply(wideWidth(sharedRoom()));
  else apply(Math.min(rest, panelRestMax()));
}
if (typeof window !== "undefined" && typeof window.addEventListener === "function") window.addEventListener("resize", onResize);

/** Widens the panel beside the chat, or brings it back. The chat and panel move as one spring through a view transition,
 * snapshots only, so the live page never lays out mid-motion; with less motion it simply changes. */
export function setPanelWide(on: boolean): void {
  const next = on ? Math.max(rest, wideWidth(sharedRoom())) : rest;
  if (next === width) return;
  const root = document.documentElement;
  if (reducedMotion() || typeof document.startViewTransition !== "function") { apply(next); return; }
  root.classList.add("panel-widening");
  const transition = document.startViewTransition(() => flushSync(() => apply(next)));
  void transition.finished.finally(() => root.classList.remove("panel-widening"));
}
