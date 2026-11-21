// madani pixel engine: draws PixelCore bots into canvases on one shared frame loop that sleeps while every bot is still
import { BODY, EYE, PixelCore, setReduced, type CoreOptions, type PixelReaction, type PixelState } from "./core.ts";

export { PIXEL_STATES, stillFrame, stillSvgPaths, type PixelReaction, type PixelState } from "./core.ts";

export interface PixelOptions extends CoreOptions {
  /** body paint: any css colour, var() and color-mix() included */
  colour?: string;
  /** eye paint, white by default */
  eyes?: string;
  /** false: never moves or blinks; the state's eyes are drawn once */
  animated?: boolean;
  /** watch a pointer moving nearby */
  follow?: boolean;
}

export interface PixelBot {
  readonly el: HTMLElement;
  readonly state: PixelState;
  setState(state: PixelState): void;
  react(kind: PixelReaction): void;
  /** a tap; clientX turns a spin away from the finger */
  poke(clientX?: number): void;
  blink(): void;
  /** look a way, -1..1 on each axis with y down, or null to look about on its own */
  look(dir: { x: number; y: number } | null): void;
  /** look at a point on the page, or null to stop */
  lookAt(x: number | null, y?: number, ms?: number): void;
  setColour(colour: string | undefined): void;
  setEyes(eyes: string | undefined): void;
  setLife(life: boolean): void;
  on(event: "state" | "react" | "tap" | "land", f: (value: unknown) => void): void;
  pause(): void;
  resume(): void;
  destroy(): void;
}

interface Host { core: PixelCore; el: HTMLElement; vis: boolean; paused: boolean; animated: boolean; follow: boolean; paint(): void; centre(): { x: number; y: number }; timers: Set<ReturnType<typeof setTimeout>> }

const hosts = new Set<Host>();
let slept = false, raf = 0, timer: ReturnType<typeof setTimeout> | undefined, last = 0, epoch = 1, io: IntersectionObserver | null = null, listening = false;
const ptr = { x: -1e5, y: -1e5, t: -1e9 };

function frame(now: number) {
  raf = 0;
  const gap = last ? (now - last) / 1000 : 1 / 60, dt = Math.min(0.25, gap);
  last = now;
  let any = false, busy = false, due = Infinity;
  for (const h of hosts) {
    if (!h.vis || h.paused || !h.animated) continue;
    any = true;
    // a settled bot slept through the gap: its clock catches up without physics
    if (slept) h.core.T += gap - dt;
    if (h.core.tick(dt)) busy = true;
    else due = Math.min(due, h.core.dueIn());
    h.paint();
  }
  slept = false;
  if (!any) { last = 0; return; }
  if (busy) { raf = requestAnimationFrame(frame); return; }
  // everything still: sleep until the next blink or settle, or until the pointer, a state or a reaction wakes it
  if (due < Infinity) timer = setTimeout(() => { timer = undefined; slept = true; wake(); }, Math.max(16, due * 1000));
  else last = 0;
}
function wake() {
  if (timer) { clearTimeout(timer); timer = undefined; slept = true; }
  if (!raf && hosts.size && !(typeof document != "undefined" && document.hidden)) raf = requestAnimationFrame(frame);
}
function listen() {
  if (listening || typeof window == "undefined") return;
  listening = true;
  const mv = (e: PointerEvent) => { ptr.x = e.clientX; ptr.y = e.clientY; ptr.t = performance.now(); if ([...hosts].some((h) => h.follow)) wake(); };
  addEventListener("pointermove", mv, { passive: true });
  addEventListener("pointerdown", mv, { passive: true });
  addEventListener("scroll", () => epoch++, { passive: true, capture: true });
  addEventListener("resize", () => epoch++, { passive: true });
  document.addEventListener("visibilitychange", () => { last = 0; wake(); });
  const mq = typeof matchMedia == "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  if (mq) { setReduced(mq.matches); mq.addEventListener("change", () => { setReduced(mq.matches); for (const h of hosts) { h.core.tick(0); h.paint(); } wake(); }); }
  if (typeof IntersectionObserver == "function") {
    io = new IntersectionObserver((es) => {
      for (const e of es) for (const h of hosts) if (h.el === e.target) { h.vis = e.isIntersecting; epoch++; }
      wake();
    }, { rootMargin: "120px" });
  }
}

// neighbours only glance over, nothing more
function notify(src: Host) {
  const c0 = src.centre();
  for (const h of hosts) {
    if (h === src || !h.vis || h.paused || !h.animated) continue;
    const c = h.centre(), d = Math.hypot(c.x - c0.x, c.y - c0.y);
    if (d < 260) {
      const t = setTimeout(() => { h.timers.delete(t); h.core.glance(c0.x, c0.y, 800 + h.core.rng() * 600); wake(); }, 120 + d * 1.6);
      h.timers.add(t);
    }
  }
}

let probe: CanvasRenderingContext2D | null = null;
/** any css colour as packed little endian rgba */
function packed(colour: string, el: HTMLElement): number {
  let css = colour;
  if (/var\(|color-mix|currentcolor/i.test(css)) {
    const span = document.createElement("span");
    span.style.color = css;
    el.appendChild(span);
    css = getComputedStyle(span).color;
    span.remove();
  }
  probe ||= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!probe) return 0xffffffff;
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = "#000";
  probe.fillStyle = css;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
  return ((a! << 24) | (b! << 16) | (g! << 8) | r!) >>> 0;
}

/** Brings a pixel bot to life inside el, which keeps its own size; destroy() on unmount. */
export function createPixel(el: HTMLElement, o: PixelOptions): PixelBot {
  listen();
  const animated = o.animated !== false;
  const core = new PixelCore({ ...o, calm: o.calm || !animated, life: animated && o.life !== false });
  const { W, H, G, s, px, pt } = core;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H; cv.setAttribute("aria-hidden", "true");
  const box = o.size ?? G * s, inset = Math.round((box - G * s) / 2);
  cv.style.cssText = `position:absolute;left:${inset - px * s}px;top:${inset - pt * s}px;width:${W * s}px;height:${H * s}px;image-rendering:pixelated;pointer-events:none`;
  // an inline position needs no computed one: reading it forces the whole page's style
  if ((el.style.position || getComputedStyle(el).position) == "static") el.style.position = "relative";
  el.appendChild(cv);
  const ctx = cv.getContext("2d");
  const img = ctx?.createImageData(W, H), buf = img ? new Uint32Array(img.data.buffer) : new Uint32Array(W * H);
  let body = packed(o.colour || "#286ef9", el), eyes = packed(o.eyes || "#fff", el);
  let rect: { x: number; y: number } | null = null, rectEpoch = 0;
  const host: Host = {
    core, el, vis: true, paused: false, animated, follow: animated && o.follow === true, timers: new Set(),
    paint() {
      if (!core.dirty) return;
      core.dirty = false;
      const p = core.paint;
      for (let i = 0; i < p.length; i++) buf[i] = p[i] === BODY ? body : p[i] === EYE ? eyes : 0;
      if (img) ctx!.putImageData(img, 0, 0);
    },
    centre() {
      if (!rect || rectEpoch !== epoch) { const r = el.getBoundingClientRect(); rect = { x: r.left + r.width / 2, y: r.top + r.height * 0.45 }; rectEpoch = epoch; }
      return rect;
    },
  };
  core.host = {
    center: () => host.centre(),
    pointer: () => (host.follow ? { x: ptr.x, y: ptr.y, fresh: performance.now() - ptr.t < 3000 } : null),
  };
  core.on("social", () => notify(host));
  hosts.add(host);
  io?.observe(el);
  host.paint();
  const redraw = () => { if (!animated) { core.tick(0); host.paint(); } else wake(); };
  wake();
  return {
    el,
    get state() { return core.state; },
    setState(n) { core.setState(n); redraw(); },
    react(n) { if (animated) { core.react(n); wake(); } },
    poke(x) { if (animated) { core.poke(x); wake(); } },
    blink() { if (animated) { core.blink(); wake(); } },
    look(dir) { core.look(dir); redraw(); },
    lookAt(x, y, ms) { core.lookAt(x, y, ms); wake(); },
    setColour(c) { body = packed(c || "#286ef9", el); core.dirty = true; host.paint(); },
    setEyes(c) { eyes = packed(c || "#fff", el); core.dirty = true; host.paint(); },
    setLife(life) { core.life = animated && life; wake(); },
    on(n, f) { core.on(n, f); },
    pause() { host.paused = true; },
    resume() { host.paused = false; wake(); },
    destroy() {
      hosts.delete(host); io?.unobserve(el);
      host.timers.forEach(clearTimeout);
      cv.remove();
    },
  };
}
