import { useSyncExternalStore } from "react";
import type { HapticKind, MobilePlatform } from "./platform";

const HAPTICS_KEY = "madani.mobile.haptics";
let platform: MobilePlatform | null = null;
let enabled = true;
const listeners = new Set<() => void>();
const lastAt = new Map<HapticKind, number>();

/** Every moment the phone answers with a tap, and the tap it plays. Scrolling, typing and passing taps play nothing. */
export const HAPTICS = {
  openChat: "light",
  back: "light",
  tap: "light",
  toggle: "selection",
  segment: "selection",
  pick: "selection",
  sheet: "soft",
  refresh: "selection",
  swipeReply: "medium",
  hold: "medium",
  stop: "medium",
  send: "light",
  reply: "soft",
  success: "success",
  error: "error",
} as const satisfies Record<string, HapticKind>;
export type HapticAction = keyof typeof HAPTICS;
/** The shared components ask the phone bridge for a tap by its kind. */
export const KIND_ACTION: Record<HapticKind, HapticAction> = { light: "tap", soft: "reply", medium: "hold", selection: "pick", error: "error", success: "success" };

export async function installHaptics(next: MobilePlatform): Promise<void> {
  platform = next;
  enabled = (await next.prefs.get(HAPTICS_KEY)) !== "off";
  for (const listener of listeners) listener();
}

/** One tap of the device's taptic engine. Repeats of one kind inside 40 ms collapse: a burst of frames is one event. */
export function haptic(action: HapticAction): void {
  if (!enabled || !platform) return;
  const kind = HAPTICS[action];
  const now = performance.now();
  if (now - (lastAt.get(kind) ?? 0) < 40) return;
  lastAt.set(kind, now);
  platform.haptic(kind);
}

export function setHapticsEnabled(on: boolean): void {
  enabled = on;
  void platform?.prefs.set(HAPTICS_KEY, on ? "on" : "off");
  for (const listener of listeners) listener();
}

export function useHapticsEnabled(): boolean {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => enabled,
  );
}
