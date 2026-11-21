import { feel, prefersReducedMotion, springEasing } from "./motion";

/** Controls that already press in CSS (the shell's round buttons, the composer discs) or that move under the finger. */
const OWN_PRESS = ".mobile-press, [data-long-press], [data-composer-send], [data-voice-mic], [data-composer-stop], [data-composer-plus], [role='slider'], input, textarea, select";
/** On Android: controls that answer with a ripple of their own (the composer's), press in CSS, or move under the finger,
 * and rows and menu items, where a ripple reads as the whole row flashing. */
const OWN_RIPPLE = ".mobile-press, .mobile-row, [role='menuitem'], [role='menuitemradio'], [role='option'], [data-tour='composer'] button, [role='slider'], input, textarea, select";
const TAPPABLE = "button, a[href], [role='button'], [role='menuitem'], [role='option'], [role='tab'], [role='radio'], [role='switch'], label[for], summary";

export function pressTarget(target: EventTarget | null, root: Element, own = OWN_PRESS): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest<HTMLElement>(TAPPABLE);
  if (!el || !root.contains(el) || el.matches(own) || el.closest(own)) return null;
  if (el.matches(":disabled, [aria-disabled='true']") || el.closest("[data-no-press]")) return null;
  return el;
}

/** Wide things (a chat row, a settings row) barely move; small ones press further. */
export function pressScale(width: number): number {
  return width > 180 ? feel.press.wide : feel.press.scale;
}

/** Every tappable in the phone shell sinks under the finger and springs back on release, so a tap always lands. Runs on
 * the compositor through `scale`, which leaves each control's own transform and transitions alone. A touch that turns
 * into a scroll lets go at once. */
export function installPress(root: HTMLElement): () => void {
  if (document.documentElement.dataset.mobileApp === "android") return installRipple(root);
  const release = springEasing(feel.press.release.stiffness, feel.press.release.damping);
  let held: { el: HTMLElement; anim: Animation; to: number } | null = null;

  const letGo = () => {
    if (!held) return;
    const { el, anim, to } = held;
    held = null;
    const now = Number(getComputedStyle(el).scale) || to;
    anim.cancel();
    el.animate([{ scale: String(now) }, { scale: "1" }], { duration: release.duration, easing: release.easing });
  };

  const down = (event: PointerEvent) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    letGo();
    if (prefersReducedMotion()) return;
    const el = pressTarget(event.target, root);
    if (!el) return;
    const to = pressScale(el.getBoundingClientRect().width);
    const anim = el.animate([{ scale: "1" }, { scale: String(to) }], { duration: feel.press.inMs, easing: "cubic-bezier(.22,1,.36,1)", fill: "forwards" });
    held = { el, anim, to };
  };

  root.addEventListener("pointerdown", down, { passive: true });
  window.addEventListener("pointerup", letGo, { passive: true });
  window.addEventListener("pointercancel", letGo, { passive: true });
  // a press that becomes a scroll, or a held row that opens a menu, lets go too
  root.addEventListener("scroll", letGo, { passive: true, capture: true });
  root.addEventListener("madani-press-release", letGo);
  return () => {
    letGo();
    root.removeEventListener("pointerdown", down);
    window.removeEventListener("pointerup", letGo);
    window.removeEventListener("pointercancel", letGo);
    root.removeEventListener("scroll", letGo, { capture: true });
    root.removeEventListener("madani-press-release", letGo);
  };
}

/** Android answers a touch the Material way instead: a ripple spreads from the finger across the control (M3's
 * emphasized decelerate) and fades once it lets go. It paints in the control's own background (mobile.css), so nothing
 * round it moves or is clipped. */
export function installRipple(root: HTMLElement): () => void {
  const running = new WeakMap<HTMLElement, Animation[]>();
  let held: HTMLElement | null = null;

  const clear = (el: HTMLElement) => {
    for (const one of running.get(el) ?? []) one.cancel();
    running.delete(el);
    delete el.dataset.ripple;
  };

  const letGo = () => {
    const el = held;
    if (!el) return;
    held = null;
    const fade = el.animate([{ "--m-ripple-a": "1" }, { "--m-ripple-a": "0" }], { duration: 220, delay: 90, easing: "linear", fill: "forwards" });
    const list = [...(running.get(el) ?? []), fade];
    running.set(el, list);
    void fade.finished.then(() => { if (running.get(el) === list) clear(el); }, () => {});
  };

  const down = (event: PointerEvent) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    letGo();
    const el = pressTarget(event.target, root, OWN_RIPPLE);
    if (!el) return;
    clear(el);
    const box = el.getBoundingClientRect();
    const x = event.clientX - box.left, y = event.clientY - box.top;
    const reach = Math.hypot(Math.max(x, box.width - x), Math.max(y, box.height - y));
    el.style.setProperty("--m-rx", `${Math.round(x)}px`);
    el.style.setProperty("--m-ry", `${Math.round(y)}px`);
    el.dataset.ripple = "";
    running.set(el, [el.animate([{ "--m-ripple": "0px" }, { "--m-ripple": `${Math.ceil(reach)}px` }], {
      duration: prefersReducedMotion() ? 1 : 450, easing: "cubic-bezier(.05,.7,.1,1)", fill: "forwards",
    })]);
    held = el;
  };

  root.addEventListener("pointerdown", down, { passive: true });
  window.addEventListener("pointerup", letGo, { passive: true });
  window.addEventListener("pointercancel", letGo, { passive: true });
  root.addEventListener("scroll", letGo, { passive: true, capture: true });
  root.addEventListener("madani-press-release", letGo);
  return () => {
    letGo();
    root.removeEventListener("pointerdown", down);
    window.removeEventListener("pointerup", letGo);
    window.removeEventListener("pointercancel", letGo);
    root.removeEventListener("scroll", letGo, { capture: true });
    root.removeEventListener("madani-press-release", letGo);
  };
}
