import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";
import type { Freshness } from "../../../../shared/dashboard-protocol";
import { ago } from "../lib/format";
import type { CloudDesktop } from "../data/contracts";
import { placeState, TONE_TEXT } from "../data/place";
import { Link } from "../lib/router";
import { GLIDE, m, Pill, usePill } from "./motion";

export const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

export function Card({ children, className, as: Tag = "section", style, ...rest }: { children: ReactNode; className?: string; as?: "section" | "div" | "article"; style?: CSSProperties; "aria-label"?: string; "aria-labelledby"?: string }) {
  return <Tag className={cx("surface rounded-card bg-card p-6 max-sm:p-5", className)} style={style} {...rest}>{children}</Tag>;
}

type Variant = "primary" | "outline" | "ghost" | "danger";
const VARIANT: Record<Variant, string> = {
  primary: "bg-primary text-primary-ink hover-primary",
  outline: "bg-btn text-ink hover-btn",
  ghost: "text-ink-2 hover-ghost",
  danger: "bg-btn text-bad hover-btn",
};

export function Button({ variant = "outline", size = "md", className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" }) {
  return (
    <button
      type="button"
      className={cx(
        "press inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full font-medium disabled:opacity-45",
        size === "sm" ? "h-9 px-4 text-13" : "h-11 px-5 text-14",
        VARIANT[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function ButtonLink({ to, variant = "outline", size = "md", className, children, external }: { to: string; variant?: Variant; size?: "sm" | "md"; className?: string; children: ReactNode; external?: boolean }) {
  const cls = cx(
    "press inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full font-medium",
    size === "sm" ? "h-9 px-4 text-13" : "h-11 px-5 text-14",
    VARIANT[variant],
    className,
  );
  return external ? <a href={to} className={cls} target="_blank" rel="noreferrer">{children}</a> : <Link to={to} className={cls}>{children}</Link>;
}

/** one thin bar, white on dark; the value is 0..100 */
export function Bar({ value, tone = "ink", className, label }: { value: number; tone?: "ink" | "accent" | "warn" | "bad"; className?: string; label?: string }) {
  const v = Math.max(0, Math.min(100, value));
  const color = { ink: "bg-ink", accent: "bg-accent", warn: "bg-warn", bad: "bg-bad" }[tone];
  return (
    <div className={cx("h-1.5 overflow-hidden rounded-full bg-track", className)} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v)} aria-label={label}>
      <m.div className={cx("h-full w-full rounded-full", color)} style={{ originX: 0 }} initial={{ scaleX: 0 }} animate={{ scaleX: v / 100 }} transition={GLIDE} />
    </div>
  );
}

/** the one badge the dashboard shows: "Current" */
export function Badge({ children, tone = "plain", className }: { children: ReactNode; tone?: "plain" | "good" | "warn" | "bad" | "accent"; className?: string }) {
  const color = { plain: "text-ink-2", good: "text-good", warn: "text-warn", bad: "text-bad", accent: "text-accent-ink" }[tone];
  return <span className={cx("tag shrink-0", color, className)}>{children}</span>;
}

/** a workspace's state: a madani cloud reads by the cloud itself (pass it), any other place by its last report */
export function FreshnessTag({ freshness, at, now, cloud, className }: { freshness: Freshness; at: number | null; now: number; cloud?: CloudDesktop | null; className?: string }) {
  const s = placeState(freshness, at, now, cloud);
  return (
    <span className={cx("inline-flex items-center gap-2 text-13 text-ink-3", className)}>
      <span className={cx("live-dot", TONE_TEXT[s.tone])} data-live={s.live && s.tone === "good"} aria-hidden />
      <span className="num" title={at ? `last report ${ago(at, now)}` : undefined}>{s.label}</span>
    </span>
  );
}

export function SectionTitle({ children, action, id }: { children: ReactNode; action?: ReactNode; id?: string }) {
  return (
    <div className="mb-4 flex min-h-8 items-center justify-between gap-3">
      <h2 id={id} className="text-16 font-medium tracking-[-0.02em] text-ink">{children}</h2>
      {action}
    </div>
  );
}

export function PageHeader({ title, sub, action }: { title: string; sub?: ReactNode; action?: ReactNode }) {
  return (
    <header className="mb-10 flex flex-wrap items-end justify-between gap-4 max-sm:mb-7">
      <div className="min-w-0">
        <h1 className="t-title">{title}</h1>
        {sub && <div className="mt-2 text-15 text-ink-2">{sub}</div>}
      </div>
      {action}
    </header>
  );
}

export function KV({ k, v, className }: { k: ReactNode; v: ReactNode; className?: string }) {
  return (
    <div className={cx("flex items-baseline justify-between gap-4 py-2.5 text-14", className)}>
      <dt className="text-ink-3">{k}</dt>
      <dd className="num min-w-0 truncate text-end text-ink">{v}</dd>
    </div>
  );
}

export function Stat({ label, value, className }: { label: string; value: ReactNode; className?: string }) {
  return (
    <div className={cx("min-w-0", className)}>
      <div className="text-13 text-ink-3">{label}</div>
      <div className="num mt-1 truncate text-14 text-ink">{value}</div>
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: string }>; onChange(v: T): void; label: string }) {
  const pill = usePill();
  return (
    <div role="radiogroup" aria-label={label} className="scroll-x inline-flex max-w-full shrink-0 rounded-full bg-card-2 p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx("relative h-8 shrink-0 whitespace-nowrap rounded-full px-3.5 text-13 font-medium", value === o.value ? "text-ink" : "text-ink-3 hover-link")}
        >
          {value === o.value && <Pill id={pill} />}
          <span className="relative">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <div className={cx("skeleton", className)} style={style} aria-hidden />;
}
