import type { KeyboardEvent, ReactNode } from "react";
import { Check, ChevronRight, Trash2, type GlyphIcon } from "../../icons";

import { cn } from "@/lib/cn";
import type { MausColor } from "@/lib/mascot";
import { rowCls, RowText, SwitchRow as ListSwitchRow } from "../ListRows";
import { Toggle } from "../ui/Toggle";

export {
  Card, CardLabel, ItemRow, LabelAction, NavRow, NoteRow, PanelEmpty, PanelSections, RowIcon, RowText, roundButtonCls, rowCls, sectionGapCls,
} from "../ListRows";

/** the panel's small row pill: 28px, an ink/6 wash, a hairline inset, ink/10 on hover */
export const buttonCls =
  "madani-press inline-flex h-7 shrink-0 cursor-pointer items-center justify-center gap-1 whitespace-nowrap rounded-full bg-ink/6 px-2.5 text-[13px] leading-[18px] text-ink shadow-[inset_0_0_0_0.5px_color-mix(in_srgb,var(--color-ink)_6%,transparent)] enabled:hover:bg-ink/10 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50";
/** a field with no fill and one quiet hairline that stays put on hover and focus */
export const fieldCls =
  "h-7 min-w-0 flex-1 rounded-lg border-[0.5px] border-ink/12 bg-transparent px-2 text-[13px] leading-[18px] text-ink outline-none placeholder:text-ink/40 disabled:opacity-50";

/** Grok's per-hue switch colours (`bg/<hue>-primary`, `-primary-hover`); a colour Grok has no hue for keeps the accent. */
const SWITCH_TONE: Partial<Record<MausColor, { on: string; hover: string }>> = {
  green: { on: "#10ab61", hover: "#0d9655" },
  blue: { on: "#1680f3", hover: "#126fd4" },
  red: { on: "#e72e3b", hover: "#c82532" },
  coral: { on: "#e72e3b", hover: "#c82532" },
  orange: { on: "#ee620d", hover: "#d2550a" },
  purple: { on: "#8351e4", hover: "#7442d1" },
  cyan: { on: "#10a693", hover: "#0d9381" },
  teal: { on: "#10a693", hover: "#0d9381" },
  pink: { on: "#e52f8b", hover: "#c82779" },
  yellow: { on: "#da830e", hover: "#c2730b" },
  ["brown" as MausColor]: { on: "#9d6937", hover: "#86592e" },
};

export function BotSwitch({ color, ...props }: Parameters<typeof Toggle>[0] & { color: MausColor }) {
  return <Toggle {...props} tone={SWITCH_TONE[color]} />;
}

export function SwitchRow({ color, ...props }: Omit<Parameters<typeof ListSwitchRow>[0], "tone"> & { color: MausColor }) {
  return <ListSwitchRow {...props} tone={SWITCH_TONE[color]} />;
}

export function ColRow({ children, ...rest }: { children: ReactNode; "data-panel-row"?: string }) {
  return <div {...rest} className={cn(rowCls, "flex-col items-stretch gap-[9px]")}>{children}</div>;
}

export function LinkRow({ children, onClick, icon: Icon = ChevronRight, ...rest }: {
  children: ReactNode;
  onClick: () => void;
  icon?: GlyphIcon;
  "data-panel-link"?: string;
}) {
  return (
    <button type="button" {...rest} onClick={onClick} className="flex min-h-[30px] w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] leading-[18px] tracking-[0.015em] text-ink-secondary outline-none hover:bg-ink/[0.035] hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus">
      <span className="min-w-0 flex-1">{children}</span>
      <Icon size={14} className="shrink-0" aria-hidden="true" />
    </button>
  );
}

/** Arrow keys move through a radiogroup's rows and pick the one they land on, as native radios do. */
export function radioArrows(event: KeyboardEvent<HTMLElement>) {
  const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
  if (!step) return;
  const radios = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)')];
  const at = radios.indexOf(document.activeElement as HTMLButtonElement);
  if (at < 0 || radios.length < 2) return;
  event.preventDefault();
  const next = radios[(at + step + radios.length) % radios.length]!;
  next.focus();
  next.click();
}

export interface SegmentOption<V extends string> {
  value: V;
  label: ReactNode;
  disabled?: boolean;
  tooltip?: string;
}

export function Segmented<V extends string>({ options, value, onChange, label, attr, compact = false }: {
  options: readonly SegmentOption<V>[];
  value: string | null | undefined;
  onChange: (value: V) => void;
  label: string;
  attr: string;
  /** Grok's tab pills instead of a filled track: 26px, the chosen one on a 6% ink wash. */
  compact?: boolean;
}) {
  if (compact) {
    return (
      <div role="group" aria-label={label} className="flex min-w-0 gap-0.5">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            {...{ [attr]: option.value }}
            aria-pressed={value === option.value}
            disabled={option.disabled}
            title={option.tooltip}
            onClick={() => onChange(option.value)}
            className={cn(
              "h-[26px] min-w-0 shrink truncate rounded-full px-2 py-1 text-[13px] leading-[18px] tracking-[0.015em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50",
              value === option.value ? "bg-ink/[0.06] text-ink" : "text-ink-secondary enabled:cursor-pointer enabled:hover:bg-ink/[0.06]",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    );
  }
  return (
    <div role="group" aria-label={label} className="flex w-full rounded-full bg-ink/[0.05] p-[3px]">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          {...{ [attr]: option.value }}
          aria-pressed={value === option.value}
          disabled={option.disabled}
          title={option.tooltip}
          onClick={() => onChange(option.value)}
          className={cn(
            "min-w-0 flex-auto truncate whitespace-nowrap rounded-full px-1.5 py-1.5 text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-50",
            value === option.value ? "bg-ink/[0.14] text-ink" : "text-ink-secondary enabled:hover:text-ink",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function TrashButton({ label, onClick, disabled, ...rest }: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  "data-panel-action"?: string;
}) {
  return (
    <button
      type="button"
      {...rest}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-ink/[0.56] hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Trash2 size={14} aria-hidden="true" />
    </button>
  );
}

export function RadioRow({ title, hint, leading, checked, onClick, disabled, ...rest }: {
  title: ReactNode;
  hint?: ReactNode;
  leading?: ReactNode;
  checked: boolean;
  onClick: () => void;
  disabled?: boolean;
  tabIndex?: number;
  "data-panel-choice"?: string;
}) {
  return (
    <button
      type="button"
      {...rest}
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      onClick={onClick}
      className={cn(rowCls, "w-full cursor-pointer text-left outline-none enabled:hover:bg-ink/[0.035] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50")}
    >
      {leading}
      <RowText title={title} hint={hint} />
      <span className="flex w-4 shrink-0 text-ink">{checked && <Check size={16} aria-hidden="true" />}</span>
    </button>
  );
}

export function TextRow({ value, placeholder, label, action, disabled, onChange, onSubmit, ...rest }: {
  value: string;
  placeholder: string;
  label: string;
  action: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  "data-panel-form"?: string;
}) {
  return (
    <form
      {...rest}
      className={rowCls}
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim() && !disabled) onSubmit();
      }}
    >
      <input
        value={value}
        placeholder={placeholder}
        aria-label={label}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={fieldCls}
      />
      <button type="submit" disabled={disabled || !value.trim()} className={buttonCls}>{action}</button>
    </form>
  );
}

/** One small closed disclosure under a tab's everyday rows, for what a person rarely needs. Native details: Enter and
 * Space open it, and it stays put (no motion). */
export function Disclosure({ label, children, ...rest }: { label: string; children: ReactNode; "data-panel-advanced"?: string }) {
  return (
    <details {...rest} className="group mt-3">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-md px-1 py-0.5 text-[12px] leading-4 text-ink/[0.56] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus [&::-webkit-details-marker]:hidden">
        <ChevronRight size={12} aria-hidden="true" className="group-open:rotate-90" />
        {label}
      </summary>
      <div className="mt-2 flex flex-col gap-3">{children}</div>
    </details>
  );
}
