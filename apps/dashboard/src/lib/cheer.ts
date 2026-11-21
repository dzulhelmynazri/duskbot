import { useSyncExternalStore } from "react";
import { toast } from "./toast";

export interface Cheer { id: number; text: string; confetti?: boolean }

let current: Cheer | null = null;
let next = 1;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

/** a small pixel bot pops up in the corner and cheers, with the words as a toast for screen readers too */
export function cheer(text: string, { confetti = false } = {}) {
  // a big moment keeps the stage: a smaller cheer right after it only says its words
  if (current?.confetti && !confetti) { toast(text); return; }
  current = { id: next++, text, ...(confetti ? { confetti } : {}) };
  toast(text);
  emit();
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { current = null; timer = null; emit(); }, confetti ? 3400 : 2600);
}

/** cheers once per account and milestone, ever */
export function cheerOnce(accountId: string | null | undefined, milestone: string, text: string, options?: { confetti?: boolean }) {
  if (!accountId) return;
  const key = `madani-dash-milestone:${accountId}:${milestone}`;
  try { if (localStorage.getItem(key)) return; localStorage.setItem(key, "1"); } catch { return; }
  cheer(text, options);
}

export const useCheer = () => useSyncExternalStore((fn) => { listeners.add(fn); return () => void listeners.delete(fn); }, () => current, () => null);
