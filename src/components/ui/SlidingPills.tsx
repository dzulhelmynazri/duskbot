import { useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { useStretch } from "@/lib/use-stretch";
import { MotionSpan, useMotionReduced } from "./SheetMotion";

export interface SlidingPill<V extends string> {
  value: V;
  label: ReactNode;
  title?: string;
  /** Extra attributes for the option's button, e.g. a data hook. */
  attrs?: HTMLAttributes<HTMLButtonElement> & Record<`data-${string}`, string | undefined>;
}

/** A menu's pick-one of equal pills on an ink-tinted track: the fill is one thumb that stretches to the picked pill (its
 * leading edge runs ahead, the back edge catches up: use-stretch.ts; springs, so a quick second pick carries on from
 * where it is), the words crossfade their ink, and a press barely gives. Nothing picked leaves the thumb faded out.
 * Reduced motion: the thumb jumps, the ink still fades.
 * (ui/Segmented is the settings pages' version: a lifted card on a soft track, sized to its labels.) */
export function SlidingPills<V extends string>({ options, value, onPick, className, pillClassName = "px-2", ...rest }: {
  options: readonly SlidingPill<V>[];
  value: V | undefined;
  onPick: (value: V) => void;
  className?: string;
  /** The pills' side padding: narrower where more of them share the track. */
  pillClassName?: string;
} & Omit<HTMLAttributes<HTMLDivElement>, "onChange">) {
  const at = options.findIndex((option) => option.value === value);
  const tabStop = Math.max(0, at);
  const group = useRef<HTMLDivElement>(null);
  const reduced = useMotionReduced();
  const [thumb, setThumb] = useState<{ start: number; end: number; at: number; moved: boolean } | null>(null);
  useLayoutEffect(() => {
    const root = group.current;
    if (!root) return;
    const place = () => {
      const pill = root.querySelectorAll<HTMLElement>("[data-sliding-pill]")[Math.max(0, at)];
      if (!pill || !pill.offsetWidth) return;
      const next = { start: pill.offsetLeft, end: pill.offsetLeft + pill.offsetWidth };
      // the first placement, and a resize, land at once; only a new pick stretches
      setThumb((last) => last && last.start === next.start && last.end === next.end ? last : { ...next, at, moved: last !== null && last.at !== at });
    };
    place();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(place);
    watch.observe(root);
    return () => watch.disconnect();
  }, [at, options.length]);
  const stretch = useStretch(thumb, reduced || !thumb?.moved);
  return (
    <div ref={group} role="group" {...rest} className={cn("relative isolate m-1 grid rounded-full bg-ink/[0.05] p-[3px]", className)}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      <MotionSpan
        aria-hidden="true"
        data-segmented-pill=""
        className="pointer-events-none absolute inset-y-[3px] left-0 -z-10 rounded-full bg-ink/[0.1] transition-opacity duration-150 ease-[ease]"
        style={{ x: stretch.start, width: stretch.size, opacity: at < 0 || !thumb ? 0 : 1 }}
      />
      {options.map((option, index) => {
        const picked = index === at;
        return (
          <button
            key={option.value}
            type="button"
            {...option.attrs}
            aria-pressed={picked}
            data-sliding-pill=""
            tabIndex={index === tabStop ? 0 : -1}
            title={option.title}
            onClick={() => onPick(option.value)}
            className={cn(
              "madani-press-soft h-6 min-w-0 truncate rounded-full text-[12px] leading-4 touch:h-8", pillClassName,
              "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus",
              picked ? "text-ink" : "text-ink-secondary hover:text-ink",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
