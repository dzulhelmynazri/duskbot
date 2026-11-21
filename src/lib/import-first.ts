const DAY = 86_400_000;
const NEW_FOR_MS = 5 * DAY;
const AWAY_FOR_MS = 3 * DAY;
const SETTLED_BOTS = 5;
const LAST_OPEN = "madani.lastOpenedAt";

/** when the app was last opened before this run, read once per run and then moved to now */
let previousOpen: number | null | undefined;
export function previousOpenAt(storage: Pick<Storage, "getItem" | "setItem"> | null = safeStorage(), now = Date.now()): number | null {
  if (previousOpen !== undefined) return previousOpen;
  const raw = Number(storage?.getItem(LAST_OPEN) ?? NaN);
  previousOpen = Number.isFinite(raw) && raw > 0 ? raw : null;
  try { storage?.setItem(LAST_OPEN, String(now)); } catch {}
  return previousOpen;
}

function safeStorage(): Storage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/** Whether "bring in from other apps" leads Settings: new here (first 5 days) or back after three days away, unless they already have plenty of bots. */
export function importFirst({ completedAt, lastOpenAt, bots, now = Date.now() }: { completedAt: string | null | undefined; lastOpenAt: number | null; bots: number; now?: number }): boolean {
  if (bots >= SETTLED_BOTS) return false;
  const started = completedAt ? Date.parse(completedAt) : NaN;
  const isNew = !Number.isFinite(started) || now - started < NEW_FOR_MS;
  const cameBack = lastOpenAt !== null && now - lastOpenAt >= AWAY_FOR_MS;
  return isNew || cameBack;
}

export function resetPreviousOpenForTests() { previousOpen = undefined; }
