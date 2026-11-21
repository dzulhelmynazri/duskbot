import { investedBy, type InvestedFacts } from "../../../../shared/cloud-upsell";

/** a different hello each day; the same one all day, so a reload does not reshuffle it */
export const DAILY_LINES = [
  "the crew saved you a seat.",
  "fresh day. the bots are stretching.",
  "good to see you again.",
  "nothing on fire. lovely.",
  "your bots were hoping you'd stop by.",
  "small jobs, done well. that's the plan.",
  "the kettle's on, figuratively.",
  "a quiet day is a good day too.",
  "everyone's here. let's get something done.",
  "the bots tidied up while you were out.",
  "pick one thing. the crew does the rest.",
  "back again. the bots noticed.",
  "today feels like a good day for a routine.",
  "you bring the ideas. they bring the hours.",
] as const;

export function dailyLine(now: number): string {
  const d = new Date(now);
  const day = Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
  return DAILY_LINES[((day % DAILY_LINES.length) + DAILY_LINES.length) % DAILY_LINES.length]!;
}

/** a streak said kindly: nothing for a day or less, warmer the longer it runs */
export function streakLine(days: number): string | null {
  if (days < 2) return null;
  if (days < 7) return `${days} day streak`;
  if (days < 30) return `${days} days straight. nice.`;
  return `${days} days straight. legendary.`;
}

const INVESTED_KEY = (account: string) => `madani-dash-invested:${account}`;

/** the sidebar card's invested copy: someone without a cloud who crossed a threshold, shown once per account */
export function investedNoteDue(account: string | null | undefined, facts: InvestedFacts, hasCloud: boolean): boolean {
  if (!account || hasCloud || !investedBy(facts)) return false;
  try { return !localStorage.getItem(INVESTED_KEY(account)); } catch { return false; }
}

export function markInvestedNote(account: string): void {
  try { localStorage.setItem(INVESTED_KEY(account), "1"); } catch {}
}

/** the invested card's headline: what they've built, never a count */
export function investedLine(facts: InvestedFacts): string {
  const by = investedBy(facts) ?? "bots";
  if (by === "bots") return "a good crew of bots.";
  if (by === "routines") return "your routines are doing real work.";
  return "your bots carry a heavy workload.";
}
