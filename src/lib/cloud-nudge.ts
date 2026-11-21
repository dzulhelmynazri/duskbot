// when the sidebar's madani cloud card shows: at most twice a calendar day, on a day the app is in use, hours apart. Each
// showing stays until it is closed, clicked or the app quits; closing it brings Give feedback back until the next showing.
// Counters live on this computer only.

export const NUDGE_KEY = "madani-cloud-nudge";
/** the least time between two showings, across midnight too */
export const NUDGE_GAP_MS = 3 * 3600_000;
/** the most showings in one calendar day */
export const NUDGE_DAILY_MAX = 2;

/** today's use on this computer and today's showings; `lastShownAt` carries over to the next day.
 * `open`: a showing nobody has answered yet */
export interface NudgeDay { day: string; sessions: number; messages: number; shown: number; lastShownAt: number; open: boolean }

/** the local calendar day, so "today" is the person's own */
export function dayKey(now: number): string {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/** the stored record as of `now`: a new day starts its counts at zero; anything unreadable is a fresh start */
export function readNudge(raw: string | null | undefined, now: number): NudgeDay {
  const today = dayKey(now);
  let saved: Partial<NudgeDay> = {};
  try { const parsed: unknown = raw ? JSON.parse(raw) : null; if (parsed && typeof parsed === "object") saved = parsed as Partial<NudgeDay>; } catch {}
  const carried = { lastShownAt: Math.min(count(saved.lastShownAt), now), open: saved.open === true };
  if (saved.day !== today) return { day: today, sessions: 0, messages: 0, shown: 0, ...carried };
  return { day: today, sessions: count(saved.sessions), messages: count(saved.messages), shown: count(saved.shown), ...carried };
}

/** how many showings today earns: none before the app is in use today, then at most NUDGE_DAILY_MAX */
export function dailyShowings(day: Pick<NudgeDay, "sessions" | "messages">): number {
  return day.sessions > 0 || day.messages > 0 ? NUDGE_DAILY_MAX : 0;
}

/** when the next showing may start: null when today's are used up (or not earned yet) */
export function nextNudgeAt(day: NudgeDay): number | null {
  if (day.shown >= dailyShowings(day)) return null;
  return day.lastShownAt ? day.lastShownAt + NUDGE_GAP_MS : 0;
}

export const nudgeDue = (day: NudgeDay, now: number): boolean => {
  const at = nextNudgeAt(day);
  return at !== null && at <= now;
};

/** whether the card may show at all: the offer is allowed here (not a store build, no madani cloud yet, nobody's
 * organization), first run is over, and no corner madani cloud card has this launch */
export function nudgeEligible({ allowed, settled, cornerCard }: { allowed: boolean | null; settled: boolean; cornerCard: boolean }): boolean {
  return allowed === true && settled && !cornerCard;
}

// the running app's side: the record in localStorage, the showing held for this launch, and a listener list
const read = (now: number) => { let raw: string | null = null; try { raw = localStorage.getItem(NUDGE_KEY); } catch {} return readNudge(raw, now); };
const write = (day: NudgeDay) => { try { localStorage.setItem(NUDGE_KEY, JSON.stringify(day)); } catch {} };
const listeners = new Set<() => void>();
let version = 0;
let sessionNoted = false;
let showing = false;
const changed = () => { version++; for (const listener of listeners) listener(); };

export const watchNudge = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const nudgeVersion = (): number => version;
export const nudgeDay = (now = Date.now()): NudgeDay => read(now);
/** a showing is on screen in this launch */
export const nudgeShowing = (): boolean => showing;

/** this launch, counted once; a showing left open when the app quit is over */
export function noteNudgeSession(now = Date.now()): void {
  if (sessionNoted) return;
  sessionNoted = true;
  const day = read(now);
  write({ ...day, open: false, sessions: day.sessions + 1 });
  changed();
}
/** a message the person sent */
export function noteNudgeMessage(now = Date.now()): void {
  const day = read(now);
  write({ ...day, messages: day.messages + 1, sessions: Math.max(day.sessions, 1) });
  changed();
}
/** starts a showing when one is due; true when it did */
export function takeNudge(now = Date.now()): boolean {
  if (showing) return false;
  const day = read(now);
  if (!nudgeDue(day, now)) return false;
  write({ ...day, shown: day.shown + 1, lastShownAt: now, open: true });
  showing = true;
  changed();
  return true;
}
/** closed or clicked: this showing is over, and Give feedback comes back until the next one */
export function endNudge(now = Date.now()): void {
  if (!showing) return;
  showing = false;
  write({ ...read(now), open: false });
  changed();
}
