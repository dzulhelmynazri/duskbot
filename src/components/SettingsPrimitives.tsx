import { useId, type ComponentProps, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { useOptimisticSwitch } from "./ui/optimistic-switch";
import { HeadArt, type ArtName } from "./ui/Art";
import { SettingGlyph, type SettingGlyphName } from "./ui/SettingGlyph";

/** The panel's card: white, 12px corners on a half-pixel edge, 4px in, its rows drawing their own hover pill. */
export const SIMPLE_CARD = "flex flex-col rounded-[12px] border-[0.5px] border-transparent bg-composer p-1";
/** Grok's buttons inside a settings row: a 30px pill on the faint fill and a half-pixel inset edge, the danger one red. */
export const SIMPLE_BUTTONS = cn(
  "[&_.ui-button]:h-[30px] [&_.ui-button]:gap-1 [&_.ui-button]:rounded-full [&_.ui-button]:border-0 [&_.ui-button]:px-3 [&_.ui-button]:py-1.5 [&_.ui-button]:text-[13px] [&_.ui-button]:leading-[18px] [&_.ui-button]:tracking-[0.015em] [&_.ui-button]:font-normal [&_.ui-button]:whitespace-nowrap [&_.ui-button]:transition-[background-color,color] [&_.ui-button]:duration-[120ms] [&_.ui-button]:ease-[ease-out]",
  "[&_.ui-button:not(.ui-button-primary,.ui-button-danger)]:bg-ink/[0.06] [&_.ui-button:not(.ui-button-primary,.ui-button-danger)]:text-ink [&_.ui-button:not(.ui-button-primary,.ui-button-danger)]:shadow-none [&_.ui-button:not(.ui-button-primary,.ui-button-danger):enabled:hover]:bg-ink/10",
  "[&_.ui-button:not(.ui-button-primary,.ui-button-danger):disabled]:bg-ink/[0.04] [&_.ui-button:not(.ui-button-primary,.ui-button-danger):disabled]:text-ink/30 [&_.ui-button:disabled]:opacity-100 [&_.ui-button:disabled]:cursor-default",
  "[&_.ui-button-primary]:bg-ink [&_.ui-button-primary]:text-app [&_.ui-button-primary:enabled:hover]:bg-ink/85",
  "[&_.ui-button-danger]:bg-[#e72e3b] [&_.ui-button-danger]:text-white [&_.ui-button-danger:enabled:hover]:bg-[#c82532]",
);

export function Switch({
  checked: owned,
  className,
  disabled: ownedDisabled,
  onClick: ownedClick,
  ...props
}: Omit<ComponentProps<"button">, "children" | "role" | "aria-checked"> & { checked: boolean }) {
  const { checked, disabled, busy, onClick } = useOptimisticSwitch(owned, ownedDisabled, ownedClick);
  return (
    <button
      {...props}
      disabled={disabled}
      aria-busy={busy || undefined}
      onClick={onClick}
      type="button"
      role="switch"
      aria-checked={checked}
      className={cn(
        "group/switch relative cursor-pointer h-6 w-11 shrink-0 rounded-full transition-colors enabled:hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none",
        // a thumb's target on touch: 44px tall around the track, without moving anything
        "pointer-coarse:before:absolute pointer-coarse:before:-inset-x-1.5 pointer-coarse:before:-inset-y-3 pointer-coarse:before:content-['']",
        "in-data-[settings-look=simple]:h-5 in-data-[settings-look=simple]:w-8 in-data-[settings-look=simple]:transition-[background-color] in-data-[settings-look=simple]:duration-[120ms] in-data-[settings-look=simple]:ease-[ease] in-data-[settings-look=simple]:enabled:hover:brightness-100",
        "in-data-[settings-look=simple]:shadow-none in-data-[settings-look=simple]:outline-none in-data-[settings-look=simple]:focus-visible:outline-2 in-data-[settings-look=simple]:focus-visible:outline-offset-1 in-data-[settings-look=simple]:focus-visible:outline-focus",
        checked
          ? "bg-accent in-data-[settings-look=simple]:bg-(--settings-switch-on) in-data-[settings-look=simple]:enabled:hover:bg-accent"
          : "bg-control in-data-[settings-look=simple]:bg-(--settings-switch-off) in-data-[settings-look=simple]:enabled:hover:bg-(--settings-switch-off-hover)",
        className,
      )}
    >
      <span
        className={cn(
          "absolute left-[3px] top-[3px] h-[18px] w-[18px] rounded-full bg-white",
          "[transition:translate_450ms_var(--madani-ease-thumb),scale_160ms_var(--madani-ease-out)] group-active/switch:scale-x-[1.11] group-active/switch:scale-y-[0.9] motion-reduce:transition-none motion-reduce:group-active/switch:scale-100",
          "in-data-[settings-look=simple]:left-0.5 in-data-[settings-look=simple]:top-0.5 in-data-[settings-look=simple]:size-4 in-data-[settings-look=simple]:shadow-[0_1px_3px_0_rgb(28_28_28/0.12)]",
          checked ? "origin-right translate-x-[18px] in-data-[settings-look=simple]:translate-x-3" : "origin-left",
        )}
      />
    </button>
  );
}

/** Outside Settings, a padded card with its title inside. In Settings (data-settings-look=simple), Grok's anatomy: the title
 * becomes the small group label over a white card that holds the rest. */
export function Card({
  title,
  subtitle,
  children,
}: {
  title?: string;
  subtitle?: string;
  children?: React.ReactNode;
}) {
  return (
    <div data-card="" className="rounded-xl bg-card p-4 max-md:rounded-2xl in-data-[settings-look=simple]:flex in-data-[settings-look=simple]:flex-col in-data-[settings-look=simple]:gap-2.5 in-data-[settings-look=simple]:rounded-none in-data-[settings-look=simple]:bg-transparent in-data-[settings-look=simple]:p-0">
      {title && <div className="text-[16px] font-semibold text-ink in-data-[settings-look=simple]:px-3 in-data-[settings-look=simple]:text-[13px] in-data-[settings-look=simple]:leading-[18px] in-data-[settings-look=simple]:font-normal in-data-[settings-look=simple]:tracking-[0.015em] in-data-[settings-look=simple]:text-ink-secondary">{title}</div>}
      {(subtitle || children) && (
        <div className={cn(title && (subtitle ? "mt-0.5" : "mt-4"), "in-data-[settings-look=simple]:mt-0", "in-data-[settings-look=simple]:rounded-[12px] in-data-[settings-look=simple]:border-[0.5px] in-data-[settings-look=simple]:border-transparent in-data-[settings-look=simple]:bg-composer in-data-[settings-look=simple]:px-3 in-data-[settings-look=simple]:py-2.5")}>
          {subtitle && <div className="text-[13px] leading-relaxed text-ink-secondary in-data-[settings-look=simple]:leading-[18px] in-data-[settings-look=simple]:tracking-[-0.08px]">{subtitle}</div>}
          {children && <div className={subtitle ? "mt-4 in-data-[settings-look=simple]:mt-3" : undefined}>{children}</div>}
        </div>
      )}
    </div>
  );
}

export function SettingRow({
  title,
  subtitle,
  icon,
  children,
  message,
  className,
}: {
  title: string;
  subtitle?: React.ReactNode;
  /** a one-colour pixel glyph (or a drawn mark of the same size) before the name, centred on it and its line */
  icon?: SettingGlyphName | React.ReactElement;
  children: React.ReactNode;
  message?: React.ReactNode;
  className?: string;
}) {
  const titleId = useId();
  // in Settings it is the panel's row: the name (and a short line) on the left, its value or control on the right
  return (
    <div role="group" aria-labelledby={titleId} data-setting-row="" className={cn("px-4 in-data-[settings-look=simple]:rounded-lg in-data-[settings-look=simple]:px-2 in-data-[settings-look=simple]:py-1.5", className)}>
      <div className="grid min-w-0 grid-cols-1 items-center gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-6 in-data-[settings-look=simple]:flex in-data-[settings-look=simple]:min-h-[18px] in-data-[settings-look=simple]:flex-wrap in-data-[settings-look=simple]:justify-between in-data-[settings-look=simple]:gap-x-2 in-data-[settings-look=simple]:gap-y-1.5">
        {typeof icon === "string" ? <SettingGlyph name={icon} className="hidden self-center in-data-[settings-look=simple]:block" />
          : icon && <span aria-hidden="true" className="hidden size-6 shrink-0 items-center justify-center self-center in-data-[settings-look=simple]:flex">{icon}</span>}
        <div className="min-w-0 in-data-[settings-look=simple]:flex in-data-[settings-look=simple]:min-w-28 in-data-[settings-look=simple]:shrink in-data-[settings-look=simple]:grow in-data-[settings-look=simple]:basis-[min-content] in-data-[settings-look=simple]:flex-col in-data-[settings-look=simple]:[overflow-wrap:break-word]">
          <div id={titleId} data-setting-title="" className="text-[14px] font-medium text-ink in-data-[settings-look=simple]:text-[13px] in-data-[settings-look=simple]:font-normal in-data-[settings-look=simple]:leading-[18px] in-data-[settings-look=simple]:tracking-[0.015em]">{title}</div>
          {subtitle && <div data-setting-hint="" className="mt-1 text-[12px] leading-relaxed text-pretty text-ink-secondary in-data-[settings-look=simple]:mt-0 in-data-[settings-look=simple]:text-[13px] in-data-[settings-look=simple]:leading-[18px] in-data-[settings-look=simple]:tracking-[0.015em]">{subtitle}</div>}
        </div>
        <div className="min-w-0 sm:max-w-[240px] in-data-[settings-look=simple]:ml-auto in-data-[settings-look=simple]:flex in-data-[settings-look=simple]:max-w-full in-data-[settings-look=simple]:shrink-0 in-data-[settings-look=simple]:flex-col in-data-[settings-look=simple]:items-end in-data-[settings-look=simple]:sm:max-w-[60%]">{children}</div>
      </div>
      {message && <div className="mt-2 text-[12px]">{message}</div>}
    </div>
  );
}

export function SettingsGroup({ label, art, hint, block, actions, footnote, children }: {
  label?: string;
  art?: ArtName;
  hint?: ReactNode;
  block?: string;
  actions?: ReactNode;
  footnote?: ReactNode;
  children: ReactNode;
}) {
  const labelId = useId();
  return (
    <section
      data-settings-block={block}
      data-settings-art={art}
      aria-labelledby={label ? labelId : undefined}
      className="flex scroll-mt-4 flex-col gap-2.5 has-[>[data-settings-rows]:empty]:hidden has-[>[data-settings-rows]>:only-child:empty]:hidden"
    >
      {(label || actions) && (
        <div data-settings-group-head="" className="flex min-h-[18px] items-center gap-3 px-3">
          {art && <HeadArt name={art} />}
          <div className="min-w-0 flex-1">
            <div className="flex w-full items-center justify-between gap-3">
              {label && <h3 id={labelId} data-settings-heading="" className="text-[13px] leading-[18px] font-normal tracking-[0.015em] text-ink-secondary">{label}</h3>}
              {actions}
            </div>
            {hint && <p data-settings-group-hint="" className="text-[13px] leading-[18px] text-ink-secondary">{hint}</p>}
          </div>
        </div>
      )}
      {children}
      {footnote && <p data-settings-footnote="" className="-mt-0.5 px-3 text-[12px] leading-4 text-ink-tertiary empty:hidden">{footnote}</p>}
    </section>
  );
}

export function SettingsRows({ children }: { children: ReactNode }) {
  return <div data-settings-rows="" className={cn(SIMPLE_CARD, "flex flex-col empty:hidden")}>{children}</div>;
}
