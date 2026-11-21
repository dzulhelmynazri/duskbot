import { useSyncExternalStore } from "react";

/** what the workspace switcher says, with no workspace yet, while a page is in the middle of the app's own step (linking
 *  a server, buying madani cloud): a calm line about what is happening instead of "connect one from the app" */
export type FlowNote = { title: string; sub: string };

let current: FlowNote | null = null;
const listeners = new Set<() => void>();

export function setFlowNote(note: FlowNote | null) {
  current = note;
  for (const fn of listeners) fn();
}

export const useFlowNote = () => useSyncExternalStore((fn) => { listeners.add(fn); return () => void listeners.delete(fn); }, () => current, () => null);
