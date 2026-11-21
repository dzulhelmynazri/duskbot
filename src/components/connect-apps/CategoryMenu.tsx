import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/cn";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { Icon } from "../Icon";
import { GROK_LABEL, GROK_ROW_FILL, MENU_SHEET } from "../menu-recipe";

export interface CategoryChoice { key: string; label: string }

/** Grok's More chip: a 200px menu of the remaining categories, under the chip on its start edge, in 30px rows. */
export function CategoryMenu({ label, ariaLabel, choices, selected, onPick, onOpenChange }: {
  label: string;
  ariaLabel: string;
  choices: CategoryChoice[];
  selected: string | null;
  onPick: (key: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const root = useRef({ contains: (target: unknown) => Boolean(trigger.current?.contains(target as Node) || menu.current?.contains(target as Node)) });
  const id = useId();
  const pressed = selected !== null && choices.some((choice) => choice.key === selected);

  const show = (next: boolean) => {
    setOpen(next);
    onOpenChange(next);
    if (!next) setPlace(null);
  };
  usePopoverDismiss(open, root, () => { show(false); trigger.current?.focus(); });

  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const box = trigger.current.getBoundingClientRect();
    const width = menu.current?.offsetWidth ?? 200;
    setPlace({ left: Math.min(box.left, window.innerWidth - width - 8), top: box.bottom + 4 });
  }, [open]);
  useEffect(() => {
    if (open && place) menu.current?.querySelector<HTMLElement>('[role="menuitemradio"]')?.focus({ preventScroll: true });
  }, [open, place]);

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const move = (index: number) => { event.preventDefault(); items[(index + items.length) % items.length]?.focus(); };
    if (event.key === "ArrowDown") move(at + 1);
    else if (event.key === "ArrowUp") move(at - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(items.length - 1);
    else if (event.key === "Tab") show(false);
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="ca-chip"
        data-menu=""
        data-open={open ? "" : undefined}
        aria-pressed={pressed}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => show(!open)}
      >
        {label}
        <span data-chevron="" aria-hidden="true"><Icon name="chevron-down" size={12} /></span>
      </button>
      {open && createPortal(
        <div
          ref={menu}
          id={id}
          role="menu"
          aria-label={ariaLabel}
          onKeyDown={onMenuKey}
          className={cn(MENU_SHEET, "madani-popup-in fixed z-[70] w-[200px] origin-top-left rounded-[12px]")}
          style={{ left: place?.left ?? 0, top: place?.top ?? 0, visibility: place ? undefined : "hidden" }}
        >
          {choices.map((choice) => (
            <div
              key={choice.key}
              role="menuitemradio"
              aria-checked={choice.key === selected}
              tabIndex={-1}
              onClick={() => { show(false); onPick(choice.key); }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                show(false);
                onPick(choice.key);
              }}
              className={cn("flex h-[30px] cursor-pointer items-center px-2 py-1.5 text-[13px] text-ink outline-none", GROK_ROW_FILL, "before:rounded-[6px]")}
            >
              <span className={cn("min-w-0 truncate", GROK_LABEL)}>{choice.label}</span>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
