// When a managed home's data may be deleted. The verdict reads only the systems of record (the billing store's subscriptions,
// the account store, this service's own backups) at the moment the reconciler acts, never a request, a webhook or a home's
// own report. A webhook can end a plan and so start the retention clock; it can never shorten it.
import type { StoredSubscription } from "../../dashboard/server/billing/store.ts";

export const DAY_MS = 86_400_000;
/** days a home and its data are kept after the plan that paid for it ended (MADANI_MANAGED_RETENTION_DAYS) */
export const DEFAULT_RETENTION_DAYS = 30;
/** days a confirmed owner request to delete waits, so it can be undone (MADANI_MANAGED_DELETE_DELAY_DAYS) */
export const DEFAULT_DELETE_DELAY_DAYS = 7;
/** notices before deletion: days left */
export const NOTICE_DAYS = [7] as const;

export type NoticeKind = "ended" | "left_30" | "left_7" | "left_1" | "deleted" | "recovered" | "delete_requested" | "delete_scheduled" | "delete_cancelled" | "resumed";

/** what the billing system of record says about one cloud's plan */
export interface Entitlement { active: boolean; until: number | null; known?: boolean }

/**
 * From the billing store: active while a subscription that paid for this cloud is active, has a payment problem, or is
 * cancelled but paid to a later time. Paid to: the cloud's own end when billing ended it (`endsAt`, or `ended` at
 * `endedAt`: a desktop taken off the plan, an account closed with "stop my desktops now"), else the latest period end. A
 * subscription that will not renew counts only to its period end, whatever its status says later (an account closed
 * before then gets no more webhooks). Event times never count: a late or replayed event cannot move the date.
 * `known` is false when no subscription ever paid for the cloud: nothing is deleted on that. App Review's demo cloud
 * (`review`) is always paid for, so it never sleeps for a plan, is never archived and never reaches a deletion verdict.
 */
export function entitlementOf(subscriptions: readonly StoredSubscription[], cloud: { id: string; subscriptionId: string | null; endsAt?: number; ended?: boolean; endedAt?: number; review?: true }, now: number): Entitlement {
  if (cloud.review) return { active: true, until: null, known: true };
  const mine = subscriptions.filter(s => s.id === cloud.subscriptionId || s.cloudId === cloud.id);
  if (!mine.length) return { active: false, until: null, known: false };
  // a plan whose period end passed before its end was recorded (a late expiry) ended at that period end
  if (cloud.ended) {
    const ended = cloud.endedAt ?? cloud.endsAt ?? null;
    const lapsed = mine.map(s => s.currentPeriodEnd ?? 0).filter(end => end > 0 && end <= now);
    const periodEnd = lapsed.length ? Math.max(...lapsed) : null;
    return { active: false, until: ended === null ? periodEnd : periodEnd === null ? ended : Math.min(ended, periodEnd), known: true };
  }
  if (cloud.endsAt !== undefined && cloud.endsAt <= now) return { active: false, until: cloud.endsAt, known: true };
  let until = 0;
  for (const s of mine) {
    const periodEnd = s.currentPeriodEnd ?? 0;
    if (s.cancelAtPeriodEnd && periodEnd > 0 && periodEnd <= now) { until = Math.max(until, periodEnd); continue; }
    if (s.status === "active" || s.status === "payment_problem" || (s.status === "cancelled" && periodEnd > now)) return { active: true, until: null, known: true };
    if (s.status === "pending") continue;
    until = Math.max(until, periodEnd);
  }
  return { active: false, until: until > 0 ? until : null, known: true };
}

export interface DeleteRequest { requestedAt: number; confirmedAt: number | null; executeAfter: number | null; cancelledAt: number | null }
export interface VerdictInput {
  now: number;
  retentionDays: number;
  entitlement: Entitlement;
  /** the newest verified backup of the home's volume, taken after it last stopped */
  finalBackup: { at: number; verifiedAt: number | null } | null;
  /** the snapshot the sandbox's last stop saved, or null if it never stopped */
  lastStopAt: number | null;
  ownerRequest: DeleteRequest | null;
  /** the home never finished its first setup: it never held anyone's data, so no final backup is owed */
  neverSetUp?: boolean;
  /** an operator hold (abuse investigation, legal): nothing is deleted while it is set */
  hold: boolean;
}
export type Verdict =
  | { delete: false; reason: "subscribed" | "no_billing_record" | "retention" | "no_final_backup" | "hold"; earliestAt: number | null }
  | { delete: true; reason: "retention_over" | "owner_request"; earliestAt: number };

export function deletionVerdict(input: VerdictInput): Verdict {
  if (!Number.isInteger(input.retentionDays) || input.retentionDays < DEFAULT_RETENTION_DAYS) throw new Error("Retention shorter than the minimum.");
  if (input.hold) return { delete: false, reason: "hold", earliestAt: null };
  if (input.entitlement.active) return { delete: false, reason: "subscribed", earliestAt: null };
  const request = input.ownerRequest;
  if (request?.confirmedAt && request.cancelledAt === null && request.executeAfter !== null && request.executeAfter <= input.now)
    return { delete: true, reason: "owner_request", earliestAt: request.executeAfter };
  if (input.entitlement.until === null) return { delete: false, reason: "no_billing_record", earliestAt: null };
  const earliestAt = input.entitlement.until + input.retentionDays * DAY_MS;
  if (input.now < earliestAt) return { delete: false, reason: "retention", earliestAt };
  const backup = input.finalBackup;
  if (input.neverSetUp) return { delete: true, reason: "retention_over", earliestAt };
  if (!backup?.verifiedAt || (input.lastStopAt !== null && backup.at < input.lastStopAt)) return { delete: false, reason: "no_final_backup", earliestAt };
  return { delete: true, reason: "retention_over", earliestAt };
}

export interface Generation { file: string; snapshotAt: number; verifiedAt: number | null }
/** the oldest generation is kept until it is this much older than the newest, so one copy is days old */
export const BACKUP_LONG_HOLD_MS = 14 * DAY_MS;

/**
 * The generations a cloud no longer needs. Kept: the newest verified one of each of the latest `keep` UTC days that have one,
 * so a home backed up several times a day keeps a day's worth of copies rather than hours of them; the oldest verified one
 * while it is under BACKUP_LONG_HOLD_MS older than the newest, so a home that wiped its own data cannot push every good copy
 * out within a few days; and any file in `protect` (a restore under way). A generation that failed its check is dropped
 * once a newer one passed.
 */
export function prunableBackups<G extends Generation>(generations: readonly G[], options: { keep: number; protect?: readonly string[] }): G[] {
  const verified = generations.filter(g => g.verifiedAt !== null).sort((a, b) => b.snapshotAt - a.snapshotAt);
  const newest = verified[0];
  if (!newest) return [];
  const kept = new Set<G>(), days = new Set<number>();
  for (const g of verified) {
    const day = Math.floor(g.snapshotAt / DAY_MS);
    if (days.has(day)) continue;
    if (days.size >= Math.max(1, options.keep)) break;
    days.add(day); kept.add(g);
  }
  const oldest = verified.at(-1)!;
  if (newest.snapshotAt - oldest.snapshotAt < BACKUP_LONG_HOLD_MS) kept.add(oldest);
  const protect = new Set(options.protect ?? []);
  return generations.filter(g => !kept.has(g) && !protect.has(g.file) && (g.verifiedAt !== null || g.snapshotAt < newest.snapshotAt));
}

/** the notice due now for a cloud whose plan ended, if any not yet sent */
export function dueNotice(input: { now: number; earliestAt: number; sent: readonly NoticeKind[] }): NoticeKind | null {
  if (!input.sent.includes("ended")) return "ended";
  const left = input.earliestAt - input.now;
  for (const days of [...NOTICE_DAYS].sort((a, b) => a - b)) {
    const kind = `left_${days}` as NoticeKind;
    if (left <= days * DAY_MS && left > 0 && !input.sent.includes(kind)) return kind;
  }
  return null;
}

export function noticeText(kind: NoticeKind, input: { name: string; at: number | null; dashboardUrl: string; link?: string }): { subject: string; text: string } {
  const date = input.at === null ? "" : new Date(input.at).toUTCString().replace(/:\d\d GMT$/, " UTC");
  const where = `Open ${input.dashboardUrl} to start a plan again, or to delete your data sooner from your cloud's page. A plan you start before then brings this cloud back with all of it.`;
  switch (kind) {
    case "ended": return { subject: `${input.name} is paused and kept for you`, text: `Your plan for ${input.name} ended, so it is paused. Your bots, chats, files and sign-ins are kept until ${date}. ${where}` };
    case "left_30": case "left_7": case "left_1": {
      const days = Number(kind.slice(5));
      return { subject: `${input.name} will be deleted in ${days} day${days === 1 ? "" : "s"}`, text: `${input.name} has been paused since its plan ended. On ${date} it and its data will be deleted. ${where}` };
    }
    case "deleted": return { subject: `${input.name} was deleted`, text: `${input.name} and its data were deleted on ${date}, after the time we keep a paused cloud. This cannot be undone.` };
    case "recovered": return input.at === null
      ? { subject: `${input.name} was set up again`, text: `${input.name}'s machine stopped working before its first backup, so we set it up again, empty. Your app reconnects by itself. Bots you moved there can be moved again from your computer.` }
      : { subject: `${input.name} was restored from a backup`, text: `${input.name}'s machine stopped working, so we set it up again from its latest backup, taken ${date}. Anything after that backup may be missing. Your app reconnects by itself.` };
    case "delete_requested": return { subject: `Confirm deleting ${input.name}`, text: `Someone signed in to your account asked to delete ${input.name} and all of its data. Nothing happens unless you open this link within an hour and confirm (you may be asked to sign in again): ${input.link ?? ""} After you confirm, it is deleted 7 days later, and you can cancel any time before then. If this was not you, ignore this email and sign out your other sessions.` };
    case "delete_scheduled": return { subject: `${input.name} will be deleted on ${date}`, text: `You confirmed deleting ${input.name}. It and its data, backups included, will be deleted on ${date}. Until then, Cancel deletion on your cloud's page at ${input.dashboardUrl} keeps everything.` };
    case "delete_cancelled": return { subject: `${input.name} will not be deleted`, text: `The request to delete ${input.name} was cancelled. Nothing was deleted.` };
    case "resumed": return { subject: `${input.name} is back`, text: `Welcome back. Your plan for ${input.name} is active again, and your cloud and bots are restored where they stopped.` };
  }
}
