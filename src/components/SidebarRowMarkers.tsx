import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

/** The colour behind a Simple row, which the status dot on its avatar is ring-cut against. Hover sits three quarters of
 * the way to the selected fill, and neither fades: both change at once. */
export function rowSurface(selected: boolean): string {
  // grok's bot rows: clear, 6% ink under the pointer (instant, no fade) and 8% when chosen; --row is that colour laid on the
  // panel, for the ring that cuts a badge out of the avatar
  return selected
    ? "bg-ink/[0.08] [--row:color-mix(in_srgb,var(--color-panel),var(--color-ink)_8%)]"
    : "bg-transparent [--row:var(--color-panel)] max-md:[--row:var(--color-app)] hover:bg-ink/[0.06] hover:[--row:color-mix(in_srgb,var(--color-panel),var(--color-ink)_6%)]";
}

export type RowActivity = "working" | "teammate" | "queued";

const ACTIVITY = {
  working: { tone: "bg-success", label: () => t("chat.activity.working"), testId: "working-dot" },
  teammate: { tone: "bg-accent", label: () => t("sidebar.preview.waitingOnTeammate"), testId: "teammate-wait-dot" },
  queued: { tone: "bg-ink-secondary", label: () => t("task.queued"), testId: "queued-dot" },
} as const satisfies Record<RowActivity, { tone: string; label: () => string; testId: string }>;

/** Working, waiting on a teammate or queued: a small dot on the avatar's corner. */
export function AvatarActivityDot({ activity }: { activity: RowActivity | null }) {
  if (!activity) return null;
  const { tone, label, testId } = ACTIVITY[activity];
  return <span aria-hidden="true" data-testid={testId} title={label()} className={cn("absolute bottom-0.5 right-0.5 size-2 rounded-full ring-2 ring-[var(--row)]", tone)} />;
}

/** Unread, or waiting for the person (which wins): one dot centred at the row's right end, which gives way to its ⋯ under
 * keyboard focus. A touch screen always shows the ⋯, so there the dot sits just before it, at the end of the name line. */
export function RowDot({ waiting = false }: { waiting?: boolean }) {
  const label = waiting ? t("sidebar.preview.waiting") : t("sidebar.grok.unreadActivity");
  const tone = cn("size-2 shrink-0 rounded-full", waiting ? "bg-[#da830e]" : "animate-[madani-fade-in_130ms_cubic-bezier(.22,1,.36,1)] bg-[var(--color-unread,var(--color-accent))]");
  return (
    <>
      <span aria-hidden="true" data-row-dot="" className="pointer-events-none absolute inset-y-0 right-2 flex items-center transition-opacity duration-[120ms] group-has-[:focus-visible]:opacity-0 touch:opacity-0 max-md:hidden">
        <span data-testid={waiting ? "waiting-dot" : "unread-dot"} title={label} className={tone} />
      </span>
      <span aria-hidden="true" title={label} className={cn(tone, "hidden self-center max-md:block touch:block")} />
    </>
  );
}

/** What the row's markers show, said once for a screen reader; a waiting row's preview already says it. */
export function RowStatusText({ working = false, unread }: { working?: boolean; unread: boolean }) {
  const text = [working ? t("chat.activity.working") : "", unread ? t("task.unread") : ""].filter(Boolean).join(", ");
  return text ? <span className="sr-only">{text}</span> : null;
}
