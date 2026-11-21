import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/cn";
import { haptic } from "./haptics";
import { closesOnBack } from "./Sheet";
import { ease, feel, holdPress, prefersReducedMotion, springEasing } from "./motion";

export interface ContextAction {
  key: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

/** A touch handed to the system's context menu instead of the page's own hold. `opened` runs when the system menu
 * shows, so the tap that ends the hold does not also open the item under it. */
export interface NativePress { press(el: HTMLElement, opened: () => void): void; cancel(): void }

const HOLD_MS = 430;
const MOVE_CANCEL = 8;

/** The sink under a held finger: in toward the press scale over the whole hold, so the hand feels the menu coming; a
 * finger that lets go early springs it back. `null` hands the element over to the menu's lift with no release. */
export function holdSink(el: HTMLElement): (on: boolean | null) => void {
  let anim: Animation | null = null;
  const release = springEasing(feel.press.release.stiffness, feel.press.release.damping);
  return (on) => {
    if (prefersReducedMotion()) return;
    const now = anim ? Number(getComputedStyle(el).scale) || 1 : 1;
    anim?.cancel();
    anim = null;
    if (on) {
      // still for a moment (a tap or a scroll never moves it), then it shrinks by 15pt of its width until the menu takes over
      const width = Math.max(holdPress.inset * 2, el.getBoundingClientRect().width);
      const shrunk = (width - holdPress.inset) / width;
      const still = holdPress.stillMs / HOLD_MS;
      anim = el.animate([
        { scale: "1", offset: 0 },
        { scale: "1", offset: still, easing: "cubic-bezier(.22,1,.36,1)" },
        { scale: String(shrunk), offset: Math.min(1, still + holdPress.shrinkMs / HOLD_MS) },
        { scale: String(shrunk) },
      ], { duration: HOLD_MS, fill: "forwards" });
    } else if (on === false && now !== 1) {
      el.animate([{ scale: String(now) }, { scale: "1" }], { duration: release.duration, easing: release.easing });
    }
  };
}

/** Press and hold: the element sinks over the hold so the hand feels it coming, then a medium tap and the menu.
 * A right click or the context-menu key opens it at once (web preview, keyboards). The click that follows a hold is
 * swallowed so the row does not also open. */
export function useLongPress(ref: RefObject<HTMLElement | null>, onOpen: (rect: DOMRect) => void, enabled = true, native?: NativePress) {
  const latest = useRef(onOpen);
  latest.current = onOpen;
  // with the system's context menu a touch only arms it; a right click and the menu key still open the page's own
  const system = useRef(native);
  system.current = native;
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    let timer = 0;
    let start: { x: number; y: number } | null = null;
    let fired = false;
    el.dataset.longPress = "";
    const sink = holdSink(el);
    const cancel = () => { window.clearTimeout(timer); timer = 0; start = null; sink(false); };
    const lift = () => { window.clearTimeout(timer); timer = 0; start = null; sink(null); };
    const fire = () => {
      timer = 0;
      fired = true;
      lift();
      haptic("hold");
      latest.current(el.getBoundingClientRect());
    };
    const onTouchStart = (event: TouchEvent) => {
      const press = system.current;
      if (event.touches.length !== 1) { cancel(); press?.cancel(); return; }
      fired = false;
      start = { x: event.touches[0].clientX, y: event.touches[0].clientY };
      if (press) { press.press(el, () => { fired = true; window.clearTimeout(timer); timer = 0; }); return; }
      sink(true);
      timer = window.setTimeout(fire, HOLD_MS);
    };
    const onTouchMove = (event: TouchEvent) => {
      if (!start || (!timer && !system.current)) return;
      const touch = event.touches[0];
      if (Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > MOVE_CANCEL) { cancel(); system.current?.cancel(); }
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (fired && event.cancelable) event.preventDefault();
      cancel();
    };
    const onClick = (event: MouseEvent) => {
      if (!fired) return;
      fired = false;
      event.preventDefault();
      event.stopPropagation();
    };
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      if (timer || fired) return;
      haptic("hold");
      latest.current(el.getBoundingClientRect());
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault();
        latest.current(el.getBoundingClientRect());
      }
    };
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", cancel);
    el.addEventListener("click", onClick, true);
    el.addEventListener("contextmenu", onContextMenu);
    el.addEventListener("keydown", onKeyDown);
    return () => {
      cancel();
      delete el.dataset.longPress;
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", cancel);
      el.removeEventListener("click", onClick, true);
      el.removeEventListener("contextmenu", onContextMenu);
      el.removeEventListener("keydown", onKeyDown);
    };
  }, [ref, enabled]);
}

const MENU_W = 250;
const ROW_H = 46;
const GAP = 10;
const MARGIN = 12;
const BAR_H = 52;
const SAFE_TOP = 54;
const SAFE_BOTTOM = 34;

export interface ContextReaction {
  key: string;
  label: string;
  glyph: ReactNode;
  selected?: boolean;
}

type Layout = { top: number; left: number; height: number; menuTop: number; menuLeft: number; barTop: number; barLeft: number; barW: number; above: boolean; end: boolean };

/** Where the held item, its reactions and its actions sit: the item where it was, the reactions over it and the actions
 * under it (or over it near the bottom). If they would run off screen the three move together, and an item taller than
 * the room left is shown cut to fit, top first. */
export function placeContextMenu(anchor: { top: number; left: number; width: number; height: number }, rows: number, view: { width: number; height: number }, options: { reactions?: number; end?: boolean } = {}): Layout {
  const menuH = rows * ROW_H + 12;
  const barW = options.reactions ? options.reactions * 44 + 12 : 0;
  const bar = options.reactions ? BAR_H + 8 : 0;
  const floor = view.height - SAFE_BOTTOM - MARGIN;
  const ceiling = SAFE_TOP + MARGIN;
  const room = floor - ceiling - bar - GAP - menuH;
  const height = Math.max(48, Math.min(anchor.height, room));
  let top = anchor.top;
  let above = false;
  if (top + height + GAP + menuH > floor) {
    // the actions fit above only with no reactions bar competing for that side
    if (!bar && top - GAP - menuH > ceiling) above = true;
    else top = floor - menuH - GAP - height;
  }
  if (top - bar < ceiling) top = ceiling + bar;
  const end = Boolean(options.end);
  const clampX = (x: number, w: number) => Math.min(Math.max(MARGIN, x), view.width - w - MARGIN);
  const menuLeft = clampX(end ? anchor.left + anchor.width - MENU_W : anchor.left + (anchor.width > MENU_W * 1.4 ? 16 : 0), MENU_W);
  const barLeft = clampX(end ? anchor.left + anchor.width - barW : anchor.left, barW);
  return { top, left: anchor.left, height, menuTop: above ? top - GAP - menuH : top + height + GAP, menuLeft, barTop: top - bar, barLeft, barW, above, end };
}

/** iOS's context menu, in the phone's feel: the page dims and blurs, the held item lifts out of it on a soft spring,
 * the reactions open from its top corner and the actions from its bottom one, their items arriving one after another
 * through a small blur. Letting go settles the item back into its place before the page shows it again. */
export function ContextMenu({ open, anchor, preview, actions, label, onClose, reactions, onReact, end = false, source, previewClassName, radius = 18 }: {
  open: boolean;
  anchor: DOMRect | null;
  preview: ReactNode;
  actions: ContextAction[];
  label: string;
  onClose: () => void;
  reactions?: ContextReaction[];
  onReact?: (key: string) => void;
  /** the item hugs the right edge (a sent message): menus open from that side */
  end?: boolean;
  /** the item on the page, hidden while its lifted copy is shown */
  source?: HTMLElement | null;
  previewClassName?: string;
  /** the held item's corner radius, so its shadow and backing follow its shape */
  radius?: string | number;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const hidden = useRef<HTMLElement | null>(null);
  const reduced = prefersReducedMotion();
  const barCount = reactions?.length ?? 0;

  useLayoutEffect(() => {
    if (!open || !anchor) return;
    setLayout(placeContextMenu(anchor, actions.length, { width: window.innerWidth, height: window.innerHeight }, { reactions: barCount, end }));
    if (source) { source.style.visibility = "hidden"; hidden.current = source; }
  }, [open, anchor, actions.length, barCount, end, source]);

  const reveal = () => {
    if (hidden.current) hidden.current.style.visibility = "";
    hidden.current = null;
  };
  useEffect(() => () => reveal(), []);

  useEffect(() => {
    if (!open) return;
    (menuRef.current?.parentElement?.querySelector<HTMLButtonElement>("[role='toolbar'] button, [role='menu'] button:not(:disabled)"))?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey);
    const unback = closesOnBack(onClose);
    return () => { window.removeEventListener("keydown", onKey); unback(); };
  }, [open, onClose, layout]);

  const fadeOut = { duration: feel.exit.fade, ease: ease.out };
  const item = {
    off: { opacity: 0, y: reduced ? 0 : 6 },
    on: { opacity: 1, y: 0, transition: { duration: feel.enter.fade, ease: [0.22, 1, 0.36, 1] as const } },
  };
  const glyph = {
    off: { opacity: 0, scale: reduced ? 1 : 0.5, y: reduced ? 0 : 8 },
    on: { opacity: 1, scale: 1, y: 0, transition: { type: "spring" as const, stiffness: 600, damping: 30, opacity: { duration: feel.enter.fade } } },
  };

  return createPortal(
    <AnimatePresence onExitComplete={reveal}>
      {open && anchor && layout && (
        <div className="madani-mobile-overlay fixed inset-0 z-50" key="context">
          <motion.div
            aria-hidden
            className="absolute inset-0 bg-[rgb(23_24_26/0.22)] [-webkit-backdrop-filter:blur(8px)] [backdrop-filter:blur(8px)]"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: feel.scrim.out } }}
            transition={{ duration: feel.scrim.in }}
            onClick={onClose}
          />
          <motion.div
            aria-hidden
            className="pointer-events-none absolute"
            style={{ left: layout.left, top: anchor.top, width: anchor.width, height: layout.height, transformOrigin: layout.end ? "right center" : "left center" }}
            initial={{ scale: reduced ? 1 : Math.max(0, anchor.width - holdPress.inset) / Math.max(holdPress.inset * 2, anchor.width), y: 0 }}
            animate={{ scale: reduced ? 1 : layout.height > 240 ? 1.01 : feel.lift.scale, y: layout.top - anchor.top }}
            exit={{ scale: 1, y: 0, transition: reduced ? { duration: 0 } : feel.soft }}
            transition={reduced ? { duration: 0 } : feel.lift.spring}
          >
            <motion.div
              className="absolute inset-0 shadow-[0_14px_40px_-10px_rgb(10_10_12/0.30)]"
              style={{ borderRadius: radius }}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: feel.exit.fade } }}
              transition={{ duration: feel.enter.fade }}
            />
            <div className={cn("relative size-full overflow-hidden bg-app", previewClassName)} style={{ borderRadius: radius }}>{preview}</div>
          </motion.div>
          {reactions && reactions.length > 0 && (
            <motion.div
              role="toolbar"
              aria-label={label}
              className="absolute flex h-[52px] items-center gap-0 rounded-full bg-menu px-1.5 shadow-[0_12px_40px_-8px_rgb(10_10_12/0.30)]"
              style={{ left: layout.barLeft, top: layout.barTop, width: layout.barW, transformOrigin: layout.end ? "right bottom" : "left bottom" }}
              initial={{ opacity: 0, scale: reduced ? 1 : 0.6, y: reduced ? 0 : 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: reduced ? 1 : feel.exit.scale, transition: fadeOut }}
              transition={{ ...feel.surface, opacity: { duration: feel.enter.fade } }}
            >
              <motion.div className="flex items-center" initial="off" animate="on" variants={{ on: { transition: { staggerChildren: feel.stagger, delayChildren: 0.05 } } }}>
                {reactions.map((reaction) => (
                  <motion.button
                    key={reaction.key}
                    type="button"
                    aria-label={reaction.label}
                    aria-pressed={reaction.selected}
                    variants={glyph}
                    onClick={() => { haptic("pick"); onClose(); onReact?.(reaction.key); }}
                    className={cn("flex size-11 items-center justify-center rounded-full text-[26px] leading-none", reaction.selected && "bg-ink/[0.08]")}
                  >
                    <span aria-hidden>{reaction.glyph}</span>
                  </motion.button>
                ))}
              </motion.div>
            </motion.div>
          )}
          <motion.div
            ref={menuRef}
            role="menu"
            aria-label={label}
            className="absolute overflow-hidden rounded-[16px] bg-menu py-1.5 shadow-[0_12px_40px_-8px_rgb(10_10_12/0.30)]"
            style={{ left: layout.menuLeft, top: layout.menuTop, width: MENU_W, transformOrigin: `${layout.end ? "right" : "left"} ${layout.above ? "bottom" : "top"}` }}
            initial={{ opacity: 0, scale: reduced ? 1 : 0.9, y: reduced ? 0 : layout.above ? 6 : -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: reduced ? 1 : feel.exit.scale, transition: fadeOut }}
            transition={{ ...feel.surface, opacity: { duration: feel.enter.fade } }}
          >
            <motion.div initial="off" animate="on" variants={{ on: { transition: { staggerChildren: feel.stagger, delayChildren: 0.04 } } }}>
              {actions.map((action) => (
                <motion.button
                  key={action.key}
                  type="button"
                  role="menuitem"
                  variants={item}
                  disabled={action.disabled}
                  onClick={() => { haptic("pick"); onClose(); action.onSelect(); }}
                  className={cn(
                    "mobile-row flex h-[46px] w-full items-center gap-3 px-4 text-left text-[16px] disabled:opacity-40",
                    action.danger ? "text-danger" : "text-ink",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{action.label}</span>
                  {action.icon && <span aria-hidden className="shrink-0 opacity-80">{action.icon}</span>}
                </motion.button>
              ))}
            </motion.div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.querySelector(".madani-mobile") ?? document.body,
  );
}
