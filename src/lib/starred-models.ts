import { useSyncExternalStore } from "react";

// A person's starred models, in the order they were starred. They follow the person (shared/synced-prefs.ts), so the
// value is kept as one text preference: a JSON list of model keys.
export const STARRED_MODELS_KEY = "madanibot.starredModels.v1";
const CHANGED = "madani-starred-models";
const NONE: readonly string[] = Object.freeze([]);

export function starKey(instanceId: string, model: string, variant?: string): string {
  return [instanceId, model, variant ?? ""].join("::");
}

export function parseStarred(raw: string | null | undefined): readonly string[] {
  if (!raw) return NONE;
  try {
    const list: unknown = JSON.parse(raw);
    return Array.isArray(list) ? [...new Set(list.filter((item): item is string => typeof item === "string"))] : NONE;
  } catch { return NONE; }
}

export function toggleStar(list: readonly string[], key: string): string[] {
  return list.includes(key) ? list.filter((item) => item !== key) : [...list, key];
}

let cache: { raw: string | null; list: readonly string[] } = { raw: null, list: NONE };

function snapshot(): readonly string[] {
  let raw: string | null = null;
  try { raw = localStorage.getItem(STARRED_MODELS_KEY); } catch { /* storage blocked */ }
  if (raw !== cache.raw) cache = { raw, list: parseStarred(raw) };
  return cache.list;
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => { if (event.key === STARRED_MODELS_KEY || event.key === null) onChange(); };
  window.addEventListener("storage", onStorage);
  window.addEventListener(CHANGED, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CHANGED, onChange);
  };
}

export function setStarred(next: readonly string[]): void {
  try { localStorage.setItem(STARRED_MODELS_KEY, JSON.stringify(next)); } catch { return; }
  window.dispatchEvent(new Event(CHANGED));
}

export function useStarredModels(): { starred: readonly string[]; toggle: (key: string) => void } {
  const starred = useSyncExternalStore(subscribe, snapshot, () => NONE);
  return { starred, toggle: (key) => setStarred(toggleStar(snapshot(), key)) };
}
