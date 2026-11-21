import { useSyncExternalStore } from "react";
import { parseStarred } from "./starred-models";

/** The models picked last on this device, newest first, as starKeys. */
export const RECENT_MODELS_KEY = "madanibot.recentModels.v1";
export const RECENT_MODELS_KEPT = 6;
const CHANGED = "madani-recent-models";
const NONE: readonly string[] = Object.freeze([]);

export function withRecent(list: readonly string[], key: string): string[] {
  return [key, ...list.filter((item) => item !== key)].slice(0, RECENT_MODELS_KEPT);
}

let cache: { raw: string | null; list: readonly string[] } = { raw: null, list: NONE };

function snapshot(): readonly string[] {
  let raw: string | null = null;
  try { raw = localStorage.getItem(RECENT_MODELS_KEY); } catch { /* storage blocked */ }
  if (raw !== cache.raw) cache = { raw, list: parseStarred(raw) };
  return cache.list;
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => { if (event.key === RECENT_MODELS_KEY || event.key === null) onChange(); };
  window.addEventListener("storage", onStorage);
  window.addEventListener(CHANGED, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CHANGED, onChange);
  };
}

/** Notes picks in order, so the last one given is the newest. */
export function noteRecentModels(...keys: string[]): void {
  const next = keys.reduce<readonly string[]>((list, key) => withRecent(list, key), snapshot());
  try {
    localStorage.setItem(RECENT_MODELS_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event(CHANGED));
  } catch { /* storage blocked */ }
}

export function useRecentModels(): readonly string[] {
  return useSyncExternalStore(subscribe, snapshot, () => NONE);
}
