import { useEffect, type RefObject } from "react";
import { keyboardInset } from "@/lib/phone-viewport";
import { keyboardCurve, prefersReducedMotion } from "./motion";
import type { KeyboardFrame, MobilePlatform } from "./platform";

/** The open chat's transcript scroller, kept still on screen while the layout under it changes. */
function scroller(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>("[data-mobile-chat] .glass-scroller");
}

const AT_END_PX = 24;
const INTERACTIVE = "a, button, input, textarea, select, summary, label, [role=button], [role=menuitem], [contenteditable=true]";

function atEnd(list: HTMLElement): boolean {
  return list.scrollHeight - list.clientHeight - list.scrollTop <= AT_END_PX;
}

/** Opening the keyboard is for answering: the transcript goes to its newest row, as a messaging app's does. */
function toLatest(root: HTMLElement): void {
  const list = scroller(root);
  if (list) list.scrollTop = list.scrollHeight;
}

const TEXT_FIELD = "textarea, [contenteditable=true], input:not([type=checkbox], [type=radio], [type=button], [type=submit], [type=reset], [type=range], [type=file], [type=color], [type=hidden])";

function isComposerField(field: HTMLElement): boolean {
  return Boolean(field.closest("[data-mobile-chat] [data-tour=composer]"));
}

/** The composer's field, when it holds focus (the keyboard is up for it). */
function composerField(root: HTMLElement): HTMLElement | null {
  const active = document.activeElement;
  return active instanceof HTMLTextAreaElement && root.querySelector("[data-mobile-chat]")?.contains(active) ? active : null;
}

/** Puts the keyboard away from whichever field holds it, the native glass composer's or one on the page. */
export function dismissKeyboard(platform: MobilePlatform, root: HTMLElement, field: HTMLElement | null = editingField(root)): void {
  if (root.dataset.glassFocused !== undefined) platform.glass?.blur();
  if (!field) return;
  field.blur();
  platform.hideKeyboard?.();
}

function editingField(root: HTMLElement): HTMLElement | null {
  const active = document.activeElement;
  return active instanceof HTMLElement && root.contains(active) && active.matches("input, textarea, [contenteditable=true]") ? active : null;
}

/** A drag down the transcript, or a tap on it away from a control, puts the keyboard away (UIScrollView's
 * keyboardDismissMode onDrag, as Messages and WhatsApp do). */
export function useKeyboardDismiss(platform: MobilePlatform, rootRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let start: { x: number; y: number } | null = null;
    const inTranscript = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest("[data-mobile-chat] .glass-scroller"));
    const dismiss = () => dismissKeyboard(platform, root, root.dataset.glassFocused !== undefined ? null : composerField(root));
    const down = (event: TouchEvent) => {
      const touch = event.touches[0];
      start = touch && event.touches.length === 1 && inTranscript(event.target) ? { x: touch.clientX, y: touch.clientY } : null;
    };
    const move = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!start || !touch) return;
      const dy = touch.clientY - start.y;
      if (dy > 16 && dy > Math.abs(touch.clientX - start.x) * 1.5) { start = null; dismiss(); }
    };
    const up = () => { start = null; };
    const tap = (event: MouseEvent) => {
      if (!inTranscript(event.target) || (event.target as Element).closest(INTERACTIVE)) return;
      if (window.getSelection()?.toString()) return;
      dismiss();
    };
    root.addEventListener("touchstart", down, { passive: true });
    root.addEventListener("touchmove", move, { passive: true });
    root.addEventListener("touchend", up, { passive: true });
    root.addEventListener("touchcancel", up, { passive: true });
    root.addEventListener("click", tap);
    return () => {
      root.removeEventListener("touchstart", down);
      root.removeEventListener("touchmove", move);
      root.removeEventListener("touchend", up);
      root.removeEventListener("touchcancel", up);
      root.removeEventListener("click", tap);
    };
  }, [platform, rootRef]);
}

/** Each keyboard, composer and send step with its page clock, in the console, when localStorage has madani.kbtrace. */
export function kbTrace(step: string, detail: Record<string, number | string>): void {
  try {
    if (!localStorage.getItem("madani.kbtrace")) return;
  } catch {
    return;
  }
  console.info(`[kb] ${performance.now().toFixed(1)} ${step}`, JSON.stringify(detail));
}

/** A keyboard event that reached the page later than this was a stalled page, not a bridge hop. */
const MAX_CATCH_UP_MS = 150;

/** How the page rides a keyboard move the system announced: the system's own duration (within reason) and a negative
 * delay for the time its event spent crossing the bridge, so the transcript sits on the keyboard and the native composer
 * from its first frame instead of trailing them. */
export function keyboardRide(frame: KeyboardFrame, fallback: number, now = Date.now()): { duration: number; delayMs: number } {
  const duration = frame.duration !== undefined && frame.duration >= 0.15 && frame.duration <= 0.7 ? frame.duration : fallback;
  const delayMs = frame.at ? Math.min(MAX_CATCH_UP_MS, Math.max(0, now - frame.at), duration * 1000) : 0;
  return { duration, delayMs };
}

function safeBottom(root: HTMLElement): number {
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;visibility:hidden;height:var(--m-safe-bottom)";
  root.appendChild(probe);
  const value = probe.getBoundingClientRect().height;
  probe.remove();
  return value;
}

/** Moves the chat with the software keyboard. For the native glass composer's own field the native side lifts the whole
 * page in the keyboard's animation and the page's layout stays as it is (see `liftedInset`). Otherwise the transcript
 * and composer ride up on the compositor with the keyboard's own curve, and the layout takes the space only once it has
 * settled (and gives it back before it leaves), each swap paired with a scroll offset so nothing visibly jumps. In a
 * browser the visual viewport is the only signal and the browser already animates it, so the inset simply follows. */
export function useKeyboardSync(platform: MobilePlatform, rootRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const curve = platform.kind === "android" ? keyboardCurve.android : keyboardCurve.ios;
    root.style.setProperty("--m-kb-dur", `${prefersReducedMotion() ? 0.01 : curve.duration}s`);
    root.style.setProperty("--m-kb-ease", curve.css);
    let committed = 0;
    let settleTimer = 0;
    const ride = (frame: KeyboardFrame) => {
      if (prefersReducedMotion()) return { duration: 0.01, delayMs: 0 };
      const timing = keyboardRide(frame, curve.duration);
      root.style.setProperty("--m-kb-dur", `${timing.duration}s`);
      root.style.setProperty("--m-kb-delay", `${-timing.delayMs}ms`);
      return timing;
    };

    const set = (kb: number, shift: number) => {
      root.style.setProperty("--m-kb", `${kb}px`);
      root.style.setProperty("--m-kb-shift", `${shift}px`);
    };
    const commitShown = (height: number) => {
      window.clearTimeout(settleTimer);
      if (committed === height) return;
      const shift = Math.max(0, height - safeBottom(root));
      delete root.dataset.kbMoving;
      const list = scroller(root);
      const top = list?.scrollTop ?? 0;
      set(height, 0);
      if (list) list.scrollTop = top + shift - Math.max(0, committed - safeBottom(root));
      committed = height;
    };

    const mode = platform.keyboardMode;
    const focused = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && event.target.matches(TEXT_FIELD)) mode?.(isComposerField(event.target));
    };
    if (mode) root.addEventListener("focusin", focused);
    let nativeRide = false;
    /** The page's own share of a keyboard the native side lifts it for: only the part the lift leaves covered (a short
     * chat's empty space), so its layout never moves anything on screen and nothing scrolls. */
    const liftedInset = (height: number, lift: number) => {
      const inset = Math.max(0, height - lift);
      kbTrace("page inset", { height, lift, inset });
      delete root.dataset.kbMoving;
      if (height > 0) root.dataset.keyboard = "open";
      else delete root.dataset.keyboard;
      if (inset === committed) return;
      set(inset, 0);
      committed = inset;
    };

    /** At once, with the scroll offset so the transcript stays still: the keyboard went without a move to ride. */
    const giveBack = () => {
      window.clearTimeout(settleTimer);
      const list = scroller(root);
      const top = list?.scrollTop ?? 0;
      const shift = Math.max(0, committed - safeBottom(root));
      set(0, 0);
      delete root.dataset.keyboard;
      if (list) list.scrollTop = Math.max(0, top - shift);
      committed = 0;
    };

    if (platform.onKeyboard) {
      const stop = platform.onKeyboard((frame) => {
        const { height, phase } = frame;
        if (frame.lift !== undefined) {
          kbTrace(phase === "did" ? "native settled" : "native will", { height, lift: frame.lift });
          nativeRide = true;
          root.style.setProperty("--m-lift", `${height > 0 ? frame.lift : 0}px`);
          window.clearTimeout(settleTimer);
          // on the way down the covered part is under the keyboard still: given back at once, as it starts to go
          if (phase === "did" || height === 0) liftedInset(height, frame.lift);
          return;
        }
        if (nativeRide && phase === "did") return;
        nativeRide = false;
        root.style.setProperty("--m-lift", "0px");
        if (height > 0) {
          if (phase === "did") { commitShown(height); return; }
          if (!committed && !root.dataset.keyboard) toLatest(root);
          const shift = Math.max(0, height - Math.max(committed, safeBottom(root)));
          const timing = ride(frame);
          root.dataset.kbMoving = "";
          root.dataset.keyboard = "open";
          root.style.setProperty("--m-kb-shift", `${shift}px`);
          window.clearTimeout(settleTimer);
          settleTimer = window.setTimeout(() => commitShown(height), timing.duration * 1000 - timing.delayMs + 40);
          return;
        }
        if (phase === "did") { delete root.dataset.kbMoving; if (committed) giveBack(); return; }
        window.clearTimeout(settleTimer);
        const shift = Math.max(0, committed - safeBottom(root));
        delete root.dataset.kbMoving;
        delete root.dataset.keyboard;
        const list = scroller(root);
        // read before the layout gives the space back: the taller scroller clamps scrollTop on the next read
        const top = list?.scrollTop ?? 0;
        set(0, shift);
        if (list) list.scrollTop = Math.max(0, top - shift);
        committed = 0;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          ride(frame);
          root.dataset.kbMoving = "";
          root.style.setProperty("--m-kb-shift", "0px");
        }));
      });
      return () => { stop(); window.clearTimeout(settleTimer); root.removeEventListener("focusin", focused); };
    }

    const vv = window.visualViewport;
    if (!vv) return;
    let frame = 0;
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const inset = keyboardInset(window.innerHeight, vv);
        if (inset && (window.scrollY > 0 || vv.offsetTop > 0)) window.scrollTo(0, 0);
        if (inset === committed) return;
        const list = scroller(root);
        // the newest row stays in view as the keyboard takes its space; opening it goes to the newest row
        const pin = Boolean(list && (atEnd(list) || (inset > 0 && committed === 0)));
        committed = inset;
        set(inset, 0);
        if (pin) toLatest(root);
        if (inset) root.dataset.keyboard = "open";
        else delete root.dataset.keyboard;
        if (inset && (window.scrollY > 0 || vv.offsetTop > 0)) window.scrollTo(0, 0);
      });
    };
    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    return () => {
      cancelAnimationFrame(frame);
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
    };
  }, [platform, rootRef]);
}
