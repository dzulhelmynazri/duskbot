import { useCallback, useState } from "react";

const COLLAPSED_KEY = "madani.mobile.home.collapsedFolders";

export type Folder<T> = { name: string; entries: T[]; unread: number };

/** The home list in the desktop sidebar's shape: each folder (a sidebar section) with its chats, newest first, the
 * folders by name, then every chat in no folder. */
export function homeFolders<T extends { at: number; unread: boolean }>(entries: readonly T[], folderOf: (entry: T) => string | undefined): { folders: Folder<T>[]; loose: T[] } {
  const byName = new Map<string, T[]>();
  const loose: T[] = [];
  for (const entry of entries) {
    const name = folderOf(entry)?.trim();
    if (!name) { loose.push(entry); continue; }
    const list = byName.get(name) ?? [];
    list.push(entry);
    byName.set(name, list);
  }
  const newest = (a: T, b: T) => b.at - a.at;
  const folders = [...byName].map(([name, list]) => ({ name, entries: list.sort(newest), unread: list.filter((entry) => entry.unread).length }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return { folders, loose: loose.sort(newest) };
}

function readCollapsed(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : [];
  } catch {
    return [];
  }
}

/** Which folders the person closed on this phone, kept across launches. */
export function useCollapsedFolders(): { collapsed: (name: string) => boolean; toggle: (name: string) => void } {
  const [names, setNames] = useState<string[]>(readCollapsed);
  const toggle = useCallback((name: string) => setNames((current) => {
    const next = current.includes(name) ? current.filter((one) => one !== name) : [...current, name];
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next)); } catch {}
    return next;
  }), []);
  return { collapsed: useCallback((name: string) => names.includes(name), [names]), toggle };
}
