import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { animate, motion, useMotionValue, useMotionValueEvent, useReducedMotion, useTransform, type MotionValue } from "motion/react";
import { X } from "../icons";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { canScroll, ownsDrag, useDrag } from "./gesture";
import { haptic } from "./haptics";
import { dur, ease, projectRelease, rubberband, settleTo, springPath, system } from "./motion";
import { BackGlyph, RoundButton } from "./RoundButton";

const SYSTEM = { stiffness: system.stiffness, damping: system.damping };

/** The page under an open sheet steps back as the sheet rises (iOS's page sheet): it shrinks a little toward the top and
 * rounds its corners, so the sliver above the sheet reads as the page behind, not as its header peeking out. */
export function recedeStyle(progress: number): { transform: string; borderRadius: string } | null {
  const p = Math.max(0, Math.min(1, progress));
  if (p === 0) return null;
  return { transform: `translate3d(0, calc(var(--m-safe-top) * ${(p * 0.5).toFixed(3)}), 0) scale(${(1 - 0.07 * p).toFixed(4)})`, borderRadius: `${(p * 14).toFixed(1)}px` };
}
const OPEN_SHEETS: Array<() => void> = [];

type Run = { stop: () => void };

type SheetLayers = { sheet: HTMLElement; scrim: HTMLElement | null; page: HTMLElement | null };

/** The sheet, its scrim and the page stepping back moved together as keyframes the compositor plays, on the system's
 * spring leaving at `velocity` (px/s): a sheet whose content is mounting (a bot's panel) or unmounting never stalls a
 * frame. `y` takes over where it is on landing, or on `stop` (a finger taking the sheet, a close turned around). */
export function slideOnCompositor(layers: SheetLayers, y: MotionValue<number>, to: number, velocity: number, height: number, onDone: () => void): Run {
  const path = springPath(y.get(), to, velocity, SYSTEM);
  const options: KeyframeAnimationOptions = { duration: path.duration, easing: "linear", fill: "forwards" };
  const progress = (p: number) => Math.max(0, Math.min(1, 1 - p / Math.max(1, height)));
  if (layers.page) Object.assign(layers.page.style, { transformOrigin: "50% 0", borderRadius: recedeStyle(1)!.borderRadius });
  const runs = [
    layers.sheet.animate(path.points.map((p) => ({ transform: `translateY(${p}px)` })), options),
    layers.scrim?.animate(path.points.map((p) => ({ opacity: progress(p) })), options),
    layers.page?.animate(path.points.map((p) => ({ transform: recedeStyle(progress(p))?.transform ?? "none" })), options),
  ].filter((run): run is Animation => Boolean(run));
  let over = false;
  const hand = (at: number) => {
    if (over) return;
    over = true;
    for (const run of runs) {
      try { run.commitStyles(); } catch { /* an element already gone */ }
      run.cancel();
    }
    y.set(at);
  };
  runs[0]!.onfinish = () => { if (!over) { hand(to); onDone(); } };
  return { stop: () => { if (!over) hand(new DOMMatrixReadOnly(getComputedStyle(layers.sheet).transform).m42); } };
}

/** A sheet rising from below the screen at the system's speed. */
export function riseOnCompositor(layers: SheetLayers, y: MotionValue<number>, height: number, onDone: () => void): Run {
  y.set(height);
  return slideOnCompositor(layers, y, 0, -system.push * height, height, onDone);
}

/** An open sheet, or a full screen layer that is not one (the picture viewer), closes on Android's back. */
export function closesOnBack(close: () => void): () => void {
  OPEN_SHEETS.push(close);
  layersChanged();
  return () => { const at = OPEN_SHEETS.indexOf(close); if (at >= 0) { OPEN_SHEETS.splice(at, 1); layersChanged(); } };
}

const layerWatchers = new Set<() => void>();
function layersChanged() { for (const watcher of layerWatchers) watcher(); }

/** For useSyncExternalStore: how many sheets and layers that close on back are open. */
export function subscribeBackLayers(watcher: () => void): () => void {
  layerWatchers.add(watcher);
  return () => { layerWatchers.delete(watcher); };
}
export function backLayerCount(): number {
  return OPEN_SHEETS.length;
}

/** Closes the top sheet, for Android's back and Escape. False when none is open. */
export function closeTopSheet(): boolean {
  const close = OPEN_SHEETS.at(-1);
  if (!close) return false;
  close();
  return true;
}

type SheetProps = {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  /** Accessible name when the title is not plain text. */
  label?: string;
  children: ReactNode;
  /** Fills the screen below the status bar instead of hugging its content. */
  full?: boolean;
  /** A back chevron in place of the close button, for a page inside a sheet. */
  back?: () => void;
  trailing?: ReactNode;
  bodyClassName?: string;
  /** No header row: the content draws its own. */
  flush?: boolean;
  /** False for a sheet over another sheet: the page behind already stepped back for the first one. */
  recede?: boolean;
};

/** Inside a stack of pages (Settings), a sheet page is pushed in place instead of opening over it: `back` pops it. */
export const SheetStack = createContext<{ back: () => void } | null>(null);

/** A bottom sheet with Grok's 28pt top corners. It follows the finger down from anywhere whose scroller is at its top,
 * rubber-bands up, and on release dismisses or springs back by where the flick would land. Inside a SheetStack it is a
 * page of that stack instead. */
export function Sheet(props: SheetProps) {
  const stack = useContext(SheetStack);
  return stack ? <StackPage {...props} back={props.back ?? stack.back} /> : <ModalSheet {...props} />;
}

/** iOS's sheet header: back on the left of a pushed page, the title, its actions, and close on the right. */
function SheetHeader({ title, back, onClose, trailing, className }: Pick<SheetProps, "title" | "back" | "onClose" | "trailing"> & { className: string }) {
  return (
    <div className={cn("flex min-h-[52px] shrink-0 items-center gap-3 px-4 pb-2", className)}>
      {back && <RoundButton label={t("mobile.sheet.back")} onClick={back} size={44}><BackGlyph /></RoundButton>}
      <div className={cn("min-w-0 flex-1 truncate text-[17px] font-semibold text-ink", !back && "ps-1")}>{title}</div>
      {trailing}
      {!back && <RoundButton label={t("mobile.sheet.close")} onClick={onClose} size={44}><X size={18} /></RoundButton>}
    </div>
  );
}

/** One page of a stack inside a sheet: its own header (back, title, an action) over its own scroller. */
export function StackPage({ title, label, children, back, onClose, trailing, bodyClassName, flush = false }: SheetProps) {
  return (
    <section aria-label={label ?? (typeof title === "string" ? title : undefined)} className="flex h-full flex-col bg-(--m-sheet-page)">
      {!flush && <SheetHeader title={title} back={back} onClose={onClose} trailing={trailing} className="pt-[22px]" />}
      <div className={cn("mobile-sheet-body relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain pb-[max(var(--m-safe-bottom),16px)]", bodyClassName)}>
        {children}
      </div>
    </section>
  );
}

function ModalSheet({ open, onClose, title, label, children, full = false, back, trailing, bodyClassName, flush = false, recede = full }: SheetProps) {
  const [mounted, setMounted] = useState(open);
  const closing = useRef(false);
  const fade = useMotionValue(1);
  const sheetRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const height = useRef(800);
  const y = useMotionValue(typeof window === "undefined" ? 800 : window.innerHeight);
  const scrim = useTransform(y, (value) => Math.max(0, Math.min(1, 1 - value / Math.max(1, height.current))));
  const run = useRef<Run | null>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const [moving, setMoving] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const scrimPressed = useRef(false);
  const flungAway = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const reduced = useReducedMotion();
  const page = useRef<HTMLElement | null>(null);
  useMotionValueEvent(scrim, "change", (progress) => {
    const nav = page.current;
    if (!nav || reduced) return;
    const style = recedeStyle(progress);
    nav.style.transform = style?.transform ?? "";
    // the page clips to its corners: rounding them a little more each frame repaints the whole page every frame, so
    // they round once as it starts to step back (the screen's own corners hide them that early) and stay so
    const corners = style ? recedeStyle(1)!.borderRadius : "";
    if (nav.style.borderRadius !== corners) nav.style.borderRadius = corners;
    if (nav.style.transformOrigin !== "50% 0px") nav.style.transformOrigin = "50% 0";
  });
  useLayoutEffect(() => {
    if (!mounted || !recede) return;
    page.current = sheetRef.current?.closest(".madani-mobile")?.querySelector<HTMLElement>(":scope > .mobile-nav") ?? null;
    return () => {
      const nav = page.current;
      if (nav) { nav.style.transform = ""; nav.style.borderRadius = ""; }
      page.current = null;
    };
  }, [mounted, recede]);

  if (open && !mounted) setMounted(true);

  const go = useCallback((target: number, velocity: number, done?: () => void) => {
    run.current?.stop();
    setMoving(true);
    run.current = settleTo(y, target, velocity, () => { setMoving(false); done?.(); }, SYSTEM);
  }, [y]);
  /** opening and closing, by a tap, Escape, back or a flick: one spring both ways, played on the compositor and turned
   * around from wherever it is; reduced motion fades the sheet in place instead */
  const slide = useCallback((to: number, velocity: number, done: () => void) => {
    run.current?.stop();
    setMoving(true);
    const finish = () => { setMoving(false); done(); };
    const el = sheetRef.current;
    if (Math.abs(y.get() - to) < 0.5 && (!reduced || fade.get() === (to <= 0 ? 1 : 0))) { finish(); return; }
    if (reduced) {
      if (to <= 0) y.set(0);
      const fading = animate(fade, to <= 0 ? 1 : 0, { duration: dur.fast, ease: ease.out, onComplete: () => { y.set(to); finish(); } });
      run.current = { stop: () => fading.stop() };
      return;
    }
    if (!el || typeof el.animate !== "function") {
      const controls = settleTo(y, to, velocity, finish, SYSTEM);
      run.current = { stop: () => controls.stop() };
      return;
    }
    run.current = slideOnCompositor({ sheet: el, scrim: scrimRef.current, page: recede ? page.current : null }, y, to, velocity, height.current, finish);
  }, [y, fade, reduced, recede]);

  useLayoutEffect(() => {
    if (!mounted) return;
    const sheet = sheetRef.current;
    if (!sheet) return;
    height.current = sheet.getBoundingClientRect().height;
    if (open) {
      sheet.focus({ preventScroll: true });
      haptic("sheet");
      flungAway.current = false;
      if (closing.current) {
        closing.current = false;
        slide(0, -system.push * height.current, () => {});
        return;
      }
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      y.set(height.current);
      fade.set(reduced ? 0 : 1);
      // the rise starts on the first frame drawn with the sheet in place below the screen: started here, the spring's
      // clock would run through the frame that mounts its content and its first steps would lurch, then stall
      const start = requestAnimationFrame(() => slide(0, -system.push * height.current, () => {}));
      return () => cancelAnimationFrame(start);
    } else {
      if (!flungAway.current) haptic("sheet");
      flungAway.current = false;
      closing.current = true;
      slide(height.current + 24, system.push * height.current, () => {
        closing.current = false;
        setMounted(false);
        opener.current?.focus({ preventScroll: true });
      });
    }
  }, [open, mounted]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    return closesOnBack(() => closeRef.current());
  }, [open]);

  useDrag(sheetRef, {
    axis: "y",
    enabled: mounted && open,
    claim: (s) => {
      if (ownsDrag(s.target)) return false;
      const root = sheetRef.current!;
      return s.dy > 0 ? !canScroll(s.target, root, "y", -1) : !canScroll(s.target, root, "y", 1);
    },
    onStart: () => {
      run.current?.stop();
      height.current = sheetRef.current?.getBoundingClientRect().height ?? height.current;
      setMoving(true);
    },
    onMove: (s) => y.set(s.dy > 0 ? s.dy : rubberband(s.dy, 48)),
    onEnd: (s) => {
      const landing = projectRelease(Math.max(0, y.get()), s.vy);
      if (y.get() > 0 && (landing > height.current * 0.5 || s.vy > 700)) {
        haptic("sheet");
        flungAway.current = true;
        slide(height.current + 24, Math.max(s.vy, 0), () => closeRef.current());
      } else {
        go(0, s.vy);
      }
    },
    onCancel: () => go(0, 0),
  });

  if (!mounted) return null;
  return (
    <motion.div className="mobile-sheet-layer fixed inset-0 z-40" data-sheet-open="" style={{ opacity: fade }} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
      {/* only a press that began on the scrim closes the sheet: the finger that opened it on press lifts over it */}
      <motion.div ref={scrimRef} aria-hidden className={cn("absolute inset-0", full ? "bg-[rgb(12_12_14/0.42)]" : "bg-[rgb(12_12_14/0.30)]")} style={{ opacity: scrim }}
        onPointerDown={() => { scrimPressed.current = true; }}
        onClick={() => { if (scrimPressed.current) onClose(); scrimPressed.current = false; }} />
      <motion.div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={label ?? (typeof title === "string" ? title : undefined)}
        tabIndex={-1}
        className={cn(
          "mobile-sheet absolute inset-x-0 bottom-0 flex flex-col overflow-hidden rounded-t-[28px] bg-(--m-sheet-page) outline-none",
          full ? "top-[calc(var(--m-safe-top)+10px)]" : "max-h-[calc(100%-var(--m-safe-top)-10px)]",
        )}
        style={{ y, willChange: moving ? "transform" : undefined }}
      >
        <div aria-hidden className={cn("mx-auto h-[5px] w-9 shrink-0 rounded-full bg-ink/[0.14]", flush ? "pointer-events-none absolute inset-x-0 top-2 z-50" : "mt-2")} />
        {!flush && <SheetHeader title={title} back={back} onClose={onClose} trailing={trailing} className="pt-1.5" />}
        <div ref={bodyRef} className={cn("mobile-sheet-body relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain pb-[max(var(--m-safe-bottom),16px)]", bodyClassName)}>
          {children}
        </div>
      </motion.div>
    </motion.div>
  );
}
