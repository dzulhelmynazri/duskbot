import type { ComponentProps, CSSProperties } from "react";

import { cn } from "@/lib/cn";
import { useOptimisticSwitch } from "./optimistic-switch";

/** Grok's switch: a 32 by 20 track, the switch blue when on, its colours on a 200ms ease; the 16px knob travels 240ms on
 * the web's ease-out (the dashboard's switch) and stretches along its travel while pressed. Reduced motion keeps the
 * colour fade and drops the travel. */
export function Toggle({ checked: owned, className, tone, style, disabled: ownedDisabled, onClick: ownedClick, ...props }: Omit<ComponentProps<"button">, "children" | "role" | "aria-checked"> & {
  checked: boolean;
  /** A bot's own switch colours, as Grok paints a bot's switches in its `bg/<hue>-primary` and `-primary-hover`. */
  tone?: { on: string; hover: string };
}) {
  const { checked, disabled, busy, onClick } = useOptimisticSwitch(owned, ownedDisabled, ownedClick);
  return (
    <button
      {...props}
      disabled={disabled}
      aria-busy={busy || undefined}
      onClick={onClick}
      style={tone ? { ...style, "--toggle-on": tone.on, "--toggle-on-hover": tone.hover } as CSSProperties : style}
      type="button"
      role="switch"
      aria-checked={checked}
      data-ui-toggle=""
      className={cn(
        "group/switch relative inline-flex h-5 w-8 shrink-0 cursor-pointer items-center rounded-full shadow-none transition-[background-color] duration-200 ease-[ease]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-1 focus-visible:ring-offset-app",
        "disabled:cursor-not-allowed disabled:opacity-50",
        // a thumb's target on touch: 44px tall around the 20px track, without moving anything
        "pointer-coarse:before:absolute pointer-coarse:before:-inset-x-1.5 pointer-coarse:before:-inset-y-3 pointer-coarse:before:content-['']",
        checked
          ? tone
            ? "bg-(--toggle-on) enabled:hover:bg-(--toggle-on-hover)"
            : "bg-accent enabled:hover:brightness-95 [:root[data-skin=grok]_&]:bg-accent-border [:root[data-skin=grok]_&]:enabled:hover:bg-accent [:root[data-skin=grok]_&]:enabled:hover:brightness-100"
          : "bg-ink/[0.12] enabled:hover:bg-ink/[0.16]",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute left-0.5 top-0.5 size-4 rounded-full bg-white shadow-[0_1px_3px_0_rgb(28_28_28/0.12)]",
          "[transition:translate_240ms_var(--madani-ease-out),scale_160ms_var(--madani-ease-out)] group-active/switch:scale-x-[1.11] group-active/switch:scale-y-[0.9] motion-reduce:transition-none motion-reduce:group-active/switch:scale-100",
          checked ? "translate-x-3 origin-right" : "origin-left",
        )}
      />
    </button>
  );
}
