import { useSyncExternalStore } from "react";
import type { MobilePlatform } from "./platform";

const LIVE_ACTIVITY_KEY = "madani.mobile.liveActivity";
let platform: MobilePlatform | null = null;
let enabled = true;
const listeners = new Set<() => void>();

export async function installLiveActivitySetting(next: MobilePlatform): Promise<void> {
  platform = next;
  enabled = (await next.prefs.get(LIVE_ACTIVITY_KEY)) !== "off";
  for (const listener of listeners) listener();
}

export function liveActivityEnabled(): boolean {
  return enabled;
}

export function setLiveActivityEnabled(on: boolean): void {
  if (enabled === on) return;
  enabled = on;
  void platform?.prefs.set(LIVE_ACTIVITY_KEY, on ? "on" : "off");
  for (const listener of listeners) listener();
}

export function subscribeLiveActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useLiveActivityEnabled(): boolean {
  return useSyncExternalStore(subscribeLiveActivity, liveActivityEnabled);
}
