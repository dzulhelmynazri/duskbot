import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { createPixel, stillFrame, stillSvgPaths, type PixelBot, type PixelState } from "@/pixel/engine";
import { madaniBody } from "../../shared/body-migration";
import { EXPRESSION_STATES, pixelReaction, pixelState, type MarkGaze, type MarkPoke, type MarkReaction } from "./mascot-engine";
import { onMascotCue } from "./mascot-events";
import { ATTENTION } from "./mascot-attention";

const useClientLayoutEffect = typeof document === "undefined" ? useEffect : useLayoutEffect;

/** How long a mark keeps looking at the composer after the last keystroke. */
const WATCH_MS = 1400;
const COMPOSER_GAZE = { x: 0.15, y: 0.75 };

export interface MadaniMarkProps {
  /** Any body id a bot was saved with; unknown ids wear the default. */
  body: string;
  /** CSS paint for the body. */
  colour: string;
  /** CSS paint for the eyes. */
  eyes?: string;
  state?: string;
  size?: number;
  /** False draws the state's eyes once and never moves. */
  animated?: boolean;
  /** A resting mark looks up, surprised, while the pointer is on it. */
  emphasized?: boolean;
  /** Where the mark looks, -1..1 on each axis with y down; null looks about on its own. */
  gaze?: MarkGaze | null;
  /** Index into the older expression list, held until it changes. */
  expression?: number;
  label?: string | null;
  /** False: no blinks or settling of its own between turns. */
  life?: boolean;
  /** The bot whose app moments (a message typed, a chat opened) this mark answers. */
  cueKey?: string;
  className?: string;
  style?: CSSProperties;
}

export interface MadaniMarkHandle {
  blink: () => void;
  spin: (durationMs?: number) => void;
  setExpression: (index: number) => void;
  /** No kind plays a random tap reaction. */
  poke: (kind?: MarkPoke) => void;
  react: (kind: MarkReaction) => void;
}

/** How a body is drawn in its box so every body looks the same size: `scale` evens out visual weight (mostly filled area,
 * some bounding box) and `x`/`y` move the silhouette's optical centre to the box's centre, all as fractions of the box. */
export interface BodyFit { scale: number; x: number; y: number }

// the median body's weight; the largest a body may grow to is 96% of the box on its longer side
const FIT_TARGET = 0.716;
const FIT_MAX_EXTENT = 0.96;
const fits = new Map<string, BodyFit>();

export function bodyFit(body: string): BodyFit {
  const known = fits.get(body);
  if (known) return known;
  const f = stillFrame(body, { scale: 1 });
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, area = 0, sy = 0;
  for (let y = 0; y < f.H; y++) for (let x = 0; x < f.W; x++) {
    if (!f.paint[y * f.W + x]) continue;
    area++; sy += y + 0.5;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  let fit: BodyFit = { scale: 1, x: 0, y: 0 };
  if (area) {
    const G = f.G, w = (x1 - x0 + 1) / G, h = (y1 - y0 + 1) / G, a = area / (G * G);
    const weight = 0.7 * Math.sqrt(a) + 0.3 * Math.sqrt(w * h);
    const scale = Math.min(FIT_TARGET / weight, FIT_MAX_EXTENT / Math.max(w, h));
    const cx = ((x0 + x1 + 1) / 2 - f.px) / G;
    // optical middle: halfway between the box's middle and where the paint's weight sits
    const cy = (((y0 + y1 + 1) / 2 + sy / area) / 2 - f.pt) / G;
    fit = { scale, x: (0.5 - cx) * scale, y: (0.5 - cy) * scale };
  }
  fits.set(body, fit);
  return fit;
}

/** Where the drawn box sits inside a `size` box for `fit`, in whole pixels so the pixel grid stays crisp. */
function fitBox(fit: BodyFit, size: number) {
  const drawn = Math.round(size * fit.scale);
  return { drawn, left: Math.round((size - drawn) / 2 + fit.x * size), top: Math.round((size - drawn) / 2 + fit.y * size) };
}

const expressionState = (index: number) => EXPRESSION_STATES[((index % EXPRESSION_STATES.length) + EXPRESSION_STATES.length) % EXPRESSION_STATES.length]!;

export const MadaniMark = forwardRef<MadaniMarkHandle, MadaniMarkProps>(function MadaniMark(
  { body, colour, eyes, state = "idle", size = 44, animated = true, emphasized = false, gaze = null, expression, label, life = true, cueKey, className, style },
  ref,
) {
  const shape = madaniBody(body);
  const box = fitBox(bodyFit(shape), size);
  const el = useRef<HTMLSpanElement>(null);
  const bot = useRef<PixelBot | null>(null);
  const [held, setHeld] = useState<PixelState | null>(null);
  const shown: PixelState = held ?? (expression !== undefined ? expressionState(expression) : emphasized && pixelState(state) === "idle" ? "surprised" : pixelState(state));
  const latest = useRef({ colour, eyes, shown, life, gaze });
  latest.current = { colour, eyes, shown, life, gaze };
  const watching = useRef(false);
  const applyLook = () => bot.current?.look(watching.current ? COMPOSER_GAZE : latest.current.gaze);

  useClientLayoutEffect(() => {
    const p = latest.current;
    const made = createPixel(el.current!, {
      body: shape, size: box.drawn, colour: p.colour, eyes: p.eyes, state: p.shown, animated, life: p.life,
      follow: animated && p.life && size >= ATTENTION.minPx,
    });
    bot.current = made;
    applyLook();
    return () => { made.destroy(); bot.current = null; };
  }, [shape, size, box.drawn, animated]);

  useEffect(() => { bot.current?.setState(shown); }, [shown]);
  useEffect(() => { bot.current?.setColour(colour); }, [colour]);
  useEffect(() => { bot.current?.setEyes(eyes); }, [eyes]);
  useEffect(() => { bot.current?.setLife(life); }, [life]);
  useEffect(() => { applyLook(); }, [gaze?.x, gaze?.y, gaze === null]);

  useEffect(() => {
    if (!cueKey) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onMascotCue(cueKey, (cue) => {
      if (cue !== "watch") {
        const kind = pixelReaction(cue);
        if (kind) bot.current?.react(kind);
        return;
      }
      clearTimeout(timer);
      watching.current = true;
      applyLook();
      timer = setTimeout(() => { watching.current = false; applyLook(); }, WATCH_MS);
    });
    return () => { off(); clearTimeout(timer); watching.current = false; };
  }, [cueKey]);

  useImperativeHandle(ref, () => ({
    blink: () => bot.current?.blink(),
    spin: () => bot.current?.react("spin"),
    setExpression: (index: number) => setHeld(expressionState(index)),
    poke: (kind?: MarkPoke) => {
      const r = kind ? pixelReaction(kind) : null;
      if (r) bot.current?.react(r); else bot.current?.poke();
    },
    react: (kind: MarkReaction) => {
      const r = pixelReaction(kind);
      if (r === "poke") bot.current?.poke(); else if (r) bot.current?.react(r);
    },
  }), []);

  return (
    <span
      data-madani-mark=""
      data-body={shape}
      data-state={state}
      data-pixel-state={shown}
      data-colour={colour}
      data-eyes={eyes || "#fff"}
      role={label ? "img" : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
      className={className}
      style={{ display: "inline-block", position: "relative", width: size, height: size, flexShrink: 0, ...style }}
      onDoubleClick={animated ? (event) => bot.current?.poke(event.clientX) : undefined}
    >
      <span ref={el} style={{ position: "absolute", left: box.left, top: box.top, width: box.drawn, height: box.drawn }} />
    </span>
  );
});

/** A 1px pixel ring one grid step outside a body's silhouette, for a picker's hovered or chosen shape. */
export function BodyRing({ body, size, className }: { body: string; size: number; className?: string }) {
  const shape = madaniBody(body);
  const d = useMemo(() => ringPath(shape, size), [shape, size]);
  const { drawn, left, top } = fitBox(bodyFit(shape), size);
  // the viewBox is widened so the ring lands where the fitted mark is drawn
  const unit = d.G / drawn;
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox={`${-left * unit} ${-top * unit} ${size * unit} ${size * unit}`} overflow="visible" shapeRendering="crispEdges" className={className}>
      <path d={d.path} fill="currentColor" />
    </svg>
  );
}

function ringPath(body: string, size: number) {
  const { G, body: silhouette } = stillSvgPaths(body, { size });
  const on = new Set<string>();
  for (const m of silhouette.matchAll(/M(-?\d+) (-?\d+)h(\d+)/g)) for (let i = 0; i < Number(m[3]); i++) on.add(`${Number(m[1]) + i},${m[2]}`);
  const ring = new Set<string>();
  for (const key of on) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const k = `${x + dx},${y + dy}`;
      if (!on.has(k)) ring.add(k);
    }
  }
  let path = "";
  for (const key of ring) { const [x, y] = key.split(","); path += `M${x} ${y}h1v1h-1z`; }
  return { G, path };
}
