import { action, feedback, usageAnalyticsEnabled } from "./product-analytics";

const KEY = "madani-feedback-prompt";
const DAY = 86_400_000;
/** asked after this many distinct days of use, then at most once per GAP, and never again after two dismissals */
export const DAYS_BEFORE = 3;
export const GAP_MS = 30 * DAY;
export const MAX_DISMISSALS = 2;

interface Saved { days: string[]; askedAt: number | null; dismissed: number }

function read(): Saved {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Saved> | null;
    return { days: Array.isArray(value?.days) ? value.days.slice(-10) : [], askedAt: typeof value?.askedAt === "number" ? value.askedAt : null, dismissed: Number(value?.dismissed) || 0 };
  } catch { return { days: [], askedAt: null, dismissed: 0 }; }
}
function write(saved: Saved) { try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch {} }

/** records today as a day of use; true when "how's it going?" may be asked now */
export function feedbackDue(now = Date.now()): boolean {
  if (!usageAnalyticsEnabled()) return false;
  const saved = read(), today = new Date(now).toISOString().slice(0, 10);
  if (!saved.days.includes(today)) { saved.days = [...saved.days, today].slice(-10); write(saved); }
  if (saved.dismissed >= MAX_DISMISSALS || saved.days.length < DAYS_BEFORE) return false;
  return saved.askedAt === null || now - saved.askedAt >= GAP_MS;
}

export function feedbackShown(moment: string, now = Date.now()) {
  write({ ...read(), askedAt: now });
  action("feedback_prompt", { result: "shown", moment });
}
export function feedbackAnswered(score: number, moment: string) {
  feedback(score, moment);
  action("feedback_prompt", { result: "answered", moment });
}
export function feedbackDismissed(moment: string) {
  const saved = read();
  write({ ...saved, dismissed: saved.dismissed + 1 });
  action("feedback_prompt", { result: "dismissed", moment });
}
