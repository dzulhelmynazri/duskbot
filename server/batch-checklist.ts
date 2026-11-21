// A bot's progress checklist for work over a list (message 94 people, update 40 listings): one Markdown file per
// conversation in its task workspace, which the bot keeps through the checklist tool and the server reads to carry an
// unfinished list on in a new turn. A ticked item is final: nothing in this file is ever unticked while items stay open.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";

export const CHECKLIST_FILE = "checklist.md";
export const CHECKLIST_MAX_ITEMS = 1_000;
export const CHECKLIST_ITEM_MAX = 300;
const TITLE_MAX = 120;
const VERB_MAX = 24;
const NOTE_MAX = 160;

export type ItemState = "open" | "done" | "skipped";
export interface ChecklistItem { text: string; state: ItemState; note?: string }
export interface Checklist { title: string; verb: string; items: ChecklistItem[] }
export interface ChecklistCounts { done: number; skipped: number; open: number; total: number }

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) : flat;
};

/** Two spellings of one recipient are one item: "@Alice", "@alice " and "alice" all match. */
export function itemKey(text: string): string {
  return oneLine(text, CHECKLIST_ITEM_MAX).toLowerCase().replace(/^@/, "");
}

const MARK: Record<ItemState, string> = { open: " ", done: "x", skipped: "~" };
const LINE = /^\s*[-*]\s+\[([ xX~])\]\s+(.+?)\s*$/;
const NOTE = /\s+\((?:skipped|note):\s*([^)]*)\)$/i;
const META = /^<!--\s*madani bot checklist:\s*verb=([^;>]*?)\s*-->$/;

export function parseChecklist(text: string): Checklist | null {
  let title = "";
  let verb = "done";
  const items: ChecklistItem[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!title && line.startsWith("# ")) { title = oneLine(line.slice(2), TITLE_MAX); continue; }
    const meta = META.exec(line);
    if (meta) { verb = oneLine(meta[1]!, VERB_MAX) || "done"; continue; }
    const match = LINE.exec(raw);
    if (!match || items.length >= CHECKLIST_MAX_ITEMS) continue;
    const mark = match[1]!.toLowerCase();
    const state: ItemState = mark === "x" ? "done" : mark === "~" ? "skipped" : "open";
    const noted = NOTE.exec(match[2]!);
    const body = noted ? match[2]!.slice(0, noted.index) : match[2]!;
    items.push({ text: oneLine(body, CHECKLIST_ITEM_MAX), state, ...(noted?.[1]?.trim() ? { note: oneLine(noted[1], NOTE_MAX) } : {}) });
  }
  return items.length ? { title: title || "Checklist", verb, items } : null;
}

export function formatChecklist(list: Checklist): string {
  const lines = list.items.map((item) => {
    const note = item.note ? ` (${item.state === "skipped" ? "skipped" : "note"}: ${item.note.replace(/[()]/g, "")})` : "";
    return `- [${MARK[item.state]}] ${item.text}${note}`;
  });
  return `# ${list.title}\n<!-- madani bot checklist: verb=${list.verb.replace(/[;>]/g, "")} -->\n\n${lines.join("\n")}\n`;
}

export function counts(list: Checklist): ChecklistCounts {
  const done = list.items.filter((item) => item.state === "done").length;
  const skipped = list.items.filter((item) => item.state === "skipped").length;
  return { done, skipped, open: list.items.length - done - skipped, total: list.items.length };
}

/** Done or skipped: what a turn moved forward. */
export const closed = (list: Checklist | null): number => (list ? list.items.length - counts(list).open : 0);

export const openItems = (list: Checklist): string[] => list.items.filter((item) => item.state === "open").map((item) => item.text);

/** A new list, or the same list again: while the current one still has open items, every item it already ticked stays
 * ticked whatever the new call says, so a bot that starts over after a cut-off turn never repeats a send. */
export function startChecklist(current: Checklist | null, input: { title: string; items: readonly string[]; verb?: string }): Checklist {
  const keep = new Map<string, ChecklistItem>();
  if (current && counts(current).open > 0) for (const item of current.items) if (item.state !== "open") keep.set(itemKey(item.text), item);
  const seen = new Set<string>();
  const items: ChecklistItem[] = [];
  for (const raw of input.items) {
    const text = oneLine(raw, CHECKLIST_ITEM_MAX);
    const key = itemKey(text);
    if (!key || seen.has(key) || items.length >= CHECKLIST_MAX_ITEMS) continue;
    seen.add(key);
    items.push(keep.get(key) ?? { text, state: "open" });
  }
  // ticked items the new call left out stay on the list, so they are still known as done
  for (const [key, item] of keep) if (!seen.has(key) && items.length < CHECKLIST_MAX_ITEMS) items.push(item);
  return { title: oneLine(input.title, TITLE_MAX) || "Checklist", verb: oneLine(input.verb ?? "", VERB_MAX) || current?.verb || "done", items };
}

export interface TickResult { list: Checklist; ticked: string[]; already: string[]; unknown: string[] }

export function tick(list: Checklist, names: readonly string[], state: Exclude<ItemState, "open">, note?: string): TickResult {
  const byKey = new Map(list.items.map((item, index) => [itemKey(item.text), index]));
  const items = list.items.map((item) => ({ ...item }));
  const ticked: string[] = [], already: string[] = [], unknown: string[] = [];
  for (const name of names) {
    const index = byKey.get(itemKey(name));
    if (index === undefined) { unknown.push(oneLine(name, CHECKLIST_ITEM_MAX)); continue; }
    const item = items[index]!;
    if (item.state !== "open") { already.push(item.text); continue; }
    items[index] = { text: item.text, state, ...(note?.trim() ? { note: oneLine(note, NOTE_MAX) } : {}) };
    ticked.push(item.text);
  }
  return { list: { ...list, items }, ticked, already, unknown };
}

/** "12 of 94 sent", with what was skipped when anything was. */
export function progressLine(list: Checklist): string {
  const { done, skipped, total } = counts(list);
  return `${done} of ${total} ${list.verb}${skipped ? `, ${skipped} skipped` : ""}`;
}

/** The conversation's task workspace, where its checklist lives; null for an id that is not a plain id. */
export function checklistDir(root: string, botId: string, threadId: string): string | null {
  return [botId, threadId].every((id) => /^[A-Za-z0-9_-]{1,128}$/.test(id)) ? join(root, botId, threadId) : null;
}

export function checklistPath(taskDir: string): string {
  return join(taskDir, CHECKLIST_FILE);
}

export function readChecklist(taskDir: string): Checklist | null {
  const path = checklistPath(taskDir);
  if (!existsSync(path)) return null;
  try { return parseChecklist(readFileSync(path, "utf8")); } catch { return null; }
}

export function writeChecklist(taskDir: string, list: Checklist): void {
  mkdirSync(taskDir, { recursive: true, mode: 0o700 });
  writeFileAtomic(checklistPath(taskDir), formatChecklist(list));
}
