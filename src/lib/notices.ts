import { hintSeen, hintSeenPatch, type OnboardingStatus } from "@/lib/onboarding";

/** The What's new popup's campaign: each person sees it once. A new id shows it once more. */
export const WHATS_NEW_NOTICE = "whats-new-2026-11";
export const CLOUD_INTRO = "cloud-trial-intro-v1";
export const CLOUD_TRIAL_NOTICE = "cloud-trial-notice";
export const CLOUD_NOTICE = "cloud-notice";
/** Bots on this computer and on another place of the person's (two-places.ts): dismissed per place, by main. */
export const TWO_PLACES_NOTICE = "two-places";
/** A routine on this computer ran late or not at all while it slept: madani cloud offered once, at that moment. */
export const LATE_ROUTINE_NOTICE = "late-routine-v1";
/** A bot was working when this computer went to sleep: madani cloud offered once, after it wakes. */
export const ASLEEP_NOTICE = "asleep-work-v1";
/** Someone clearly invested (shared/cloud-upsell.ts INVESTED): the sidebar madani cloud card says it once, in their numbers.
 * Not a corner notice: the id only records that it was said. */
export const INVESTED_NOTICE = "cloud-invested-v1";
/** The Move from Grok Bot popup: each person sees it once, first of all, after their welcome. */
export const GROK_MOVE_NOTICE = "grok-move-2026-11";
/** Other AI tools on this computer with memory or skills never brought in: the import offered once, after the welcome. */
export const BRING_NOTICE = "bring-tools-v1";

/**
 * Every notice, in the order a launch asks them: one launch shows one notice, the first one due. The rest wait for later launches, in this order.
 */
export const NOTICES = [
  GROK_MOVE_NOTICE,
  WHATS_NEW_NOTICE,
  BRING_NOTICE,
  TWO_PLACES_NOTICE,
  LATE_ROUTINE_NOTICE,
  ASLEEP_NOTICE,
  CLOUD_INTRO,
  CLOUD_TRIAL_NOTICE,
  CLOUD_NOTICE,
] as const;

export type NoticeId = (typeof NOTICES)[number];

export type NoticeFacts = Record<NoticeId, boolean | null>;

/** `launch`: the notice this launch already showed (launchNotice), the only one that may show again in it. */
export function nextNotice(facts: NoticeFacts, seen: (id: NoticeId) => boolean, launch: NoticeId | null = null): NoticeId | null {
  for (const id of NOTICES) {
    if (seen(id) || (launch !== null && id !== launch)) continue;
    if (facts[id] === null) return null;
    if (facts[id]) return id;
  }
  return null;
}

const LAUNCH_KEY = "madani.launch.notice";
// Where browser storage is blocked, this page's memory stands in for it, so a claim still holds for the page.
let launchMemory: NoticeId | null = null;
const isNotice = (id: unknown): id is NoticeId => (NOTICES as readonly unknown[]).includes(id);

/** The first notice this launch showed, kept for the window's session, so a reload is the same launch. */
export function launchNotice(): NoticeId | null {
  try {
    const id = sessionStorage.getItem(LAUNCH_KEY);
    if (isNotice(id)) return id;
  } catch {}
  return launchMemory;
}

const launchWatchers = new Set<() => void>();
/** Told when this launch claims its notice, so the sidebar's madani cloud card can step aside at once. */
export function watchLaunchNotice(watch: () => void): () => void {
  launchWatchers.add(watch);
  return () => { launchWatchers.delete(watch); };
}

/** The first claim of a launch holds; a later one changes nothing. */
export function markLaunchNotice(id: NoticeId): void {
  if (launchNotice()) return;
  try {
    sessionStorage.setItem(LAUNCH_KEY, id);
  } catch {
    launchMemory = id;
  }
  for (const watch of Array.from(launchWatchers)) watch();
}

const stored = (id: string): string | null => { try { return localStorage.getItem(id); } catch { return null; } };
const store = (id: string, value: string) => { try { localStorage.setItem(id, value); } catch {} };

export function noticeSeen(record: OnboardingStatus | undefined, id: string): boolean {
  return hintSeen(record, id) || stored(id) === "1";
}

export function dismissNotice(record: OnboardingStatus | undefined, id: string): { onboarding: { hintsSeen: string[] } } | null {
  store(id, "1");
  return hintSeenPatch(record, id);
}

export function localDay(now: number): string {
  const date = new Date(now), two = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

const INTRO_DAYS = `${CLOUD_INTRO}:days`;
const introDayHint = (count: number) => `${CLOUD_INTRO}:day-${count}`;
const recordedDays = (record: OnboardingStatus | undefined) => Math.max(0, ...(record?.hintsSeen ?? [])
  .map(id => id.startsWith(`${CLOUD_INTRO}:day-`) ? Number(id.slice(`${CLOUD_INTRO}:day-`.length)) : 0)
  .filter(count => Number.isSafeInteger(count)));
export const OLD_PRO_DISMISSALS = ["pro-introduction-dismissed-v2", "pro-introduction-dismissed-v3"] as const;
const MAX_INTRO_DAYS = 3;

function introDays(): string[] {
  try {
    const parsed: unknown = JSON.parse(stored(INTRO_DAYS) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((day): day is string => typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day)).slice(-MAX_INTRO_DAYS) : [];
  } catch { return []; }
}

const dayNumber = (day: string) => { const [y, m, d] = day.split("-").map(Number); return Math.round(Date.UTC(y!, m! - 1, d!) / 86_400_000); };
/** an ignored showing rests: the next one waits until at least two calendar days later, not the next launch */
const INTRO_REST_DAYS = 2;

export function introStage(record: OnboardingStatus | undefined, now: number): "due" | "resting" | "shown-today" | "done" {
  if (noticeSeen(record, CLOUD_INTRO)) return "done";
  const days = introDays();
  if (days.includes(localDay(now))) return "shown-today";
  const counted = Math.max(days.length, recordedDays(record));
  const limit = OLD_PRO_DISMISSALS.some(id => noticeSeen(record, id)) ? 1 : MAX_INTRO_DAYS;
  if (counted >= limit) return "done";
  const last = days.at(-1);
  return last && dayNumber(localDay(now)) - dayNumber(last) < INTRO_REST_DAYS ? "resting" : "due";
}

export function introShown(record: OnboardingStatus | undefined, now: number): { onboarding: { hintsSeen: string[] } } | null {
  const days = introDays(), today = localDay(now);
  if (days.includes(today)) return null;
  const next = [...days, today].slice(-MAX_INTRO_DAYS);
  store(INTRO_DAYS, JSON.stringify(next));
  return hintSeenPatch(record, introDayHint(Math.min(Math.max(recordedDays(record) + 1, next.length), MAX_INTRO_DAYS)));
}

export const LAUNCHED_AT = Date.now();

export function usedBefore(
  bots: ReadonlyArray<{ tasks?: ReadonlyArray<{ createdAt?: number; usage?: { turns: number } }> }>,
  launchedAt = LAUNCHED_AT,
): boolean {
  return bots.some(bot => bot.tasks?.some(task => (task.createdAt ?? Infinity) < launchedAt && (task.usage?.turns ?? 0) > 0) ?? false);
}
