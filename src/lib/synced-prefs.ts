import { api } from "@/state/api";
import { applyChatWidth, readChatWidth } from "@/lib/chat-width";
import { applyFont, readFont } from "@/lib/fonts";
import { languageChoice, setLanguageChoice } from "@/lib/language-preference";
import { applySkinChoice, readSkinChoice } from "@/lib/skins";
import { SYNCED_UI_PREFS } from "../../shared/synced-prefs";

// The app's own preferences follow the person: this page keeps them in its storage, its place's server keeps them too
// (server/settings-sync.ts), and the desktop app carries them to the person's other places. A change here goes to the
// server within seconds; a newer one from the server is worn here at once.
const ROUTE = "/api/settings-sync/ui";
/** What this page and its server last agreed on, per preference: its value and when it changed. */
const AGREED = "madani-prefs-synced";
const LOOK_MS = 3_000;

type Agreed = Record<string, { value: string | null; at: number }>;
type Prefs = Record<string, { value: string | null; at: number }>;

function store(): Storage | undefined {
  try { return typeof localStorage === "undefined" ? undefined : localStorage; } catch { return undefined; }
}

function agreed(): Agreed {
  try { return JSON.parse(store()?.getItem(AGREED) ?? "{}") as Agreed; } catch { return {}; }
}

function agree(name: string, value: string | null, at: number): void {
  const all = agreed();
  all[name] = { value, at };
  try { store()?.setItem(AGREED, JSON.stringify(all)); } catch {}
}

function read(name: string): string | null {
  if (name === "madani-language") return languageChoice();
  try { return store()?.getItem(name) ?? null; } catch { return null; }
}

function wear(name: string, value: string | null): void {
  if (name === "madani-language") { if (value !== null) setLanguageChoice(value); return; }
  try {
    if (value === null) store()?.removeItem(name); else store()?.setItem(name, value);
  } catch { return; }
  if (name === "madani-skin") applySkinChoice(readSkinChoice());
  else if (name === "madani-font") applyFont(readFont());
  else if (name === "madani-chat-width") applyChatWidth(readChatWidth());
  // the rest read their storage when it says it changed
  try { window.dispatchEvent(new StorageEvent("storage", { key: name, newValue: value, storageArea: store() ?? null })); } catch {}
}

let off = false;
let busy = false;

/** The server's newer preferences, worn here. */
export async function pullSyncedPrefs(): Promise<void> {
  if (off || busy) return;
  busy = true;
  try {
    const { prefs } = await api<{ prefs: Prefs }>(ROUTE, { background: true });
    const mine = agreed();
    for (const name of SYNCED_UI_PREFS) {
      const there = prefs[name];
      if (!there) continue;
      const known = mine[name];
      if (known && there.at <= known.at) continue;
      // nothing kept there yet: this page's own goes up instead (pushSyncedPrefs)
      if (!known && there.at === 0 && there.value === null) continue;
      if (read(name) !== there.value) wear(name, there.value);
      agree(name, there.value, there.at);
    }
  } catch (error) {
    // a place that keeps no person's preferences (a Team Cloud, a phone's link): nothing to do here
    if ([403, 404].includes((error as { status?: number }).status ?? 0)) off = true;
  } finally {
    busy = false;
  }
}

/** This page's changed preferences, sent up. */
async function pushSyncedPrefs(): Promise<void> {
  if (off || busy) return;
  const mine = agreed();
  const changed = SYNCED_UI_PREFS.filter((name) => read(name) !== (mine[name]?.value ?? null) && (mine[name] || read(name) !== null));
  if (!changed.length) return;
  busy = true;
  let stale = false;
  try {
    for (const name of changed) {
      const value = read(name);
      // first met: kept as this page's own, not as a change made now, so it never outranks another place's choice
      const at = mine[name] ? Date.now() : 0;
      const answer = await api<{ ok: boolean; at: number }>(ROUTE, { method: "PUT", background: true, body: JSON.stringify({ name, value, at }) });
      if (answer.ok) agree(name, value, answer.at);
      else stale = true;
    }
  } catch (error) {
    if ([403, 404].includes((error as { status?: number }).status ?? 0)) off = true;
  } finally {
    busy = false;
  }
  if (stale) await pullSyncedPrefs();
}

let started = false;
export function startSyncedPrefs(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  void pullSyncedPrefs().then(() => pushSyncedPrefs());
  setInterval(() => void pushSyncedPrefs(), LOOK_MS);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void pullSyncedPrefs(); });
}
