import { animate, type AnimationPlaybackControls, type MotionValue } from "motion/react";
import { MOTION, pacedSpring } from "@/lib/motion-speed";

/** The bencho token set (~/madani-ref BENCHO-MOTION.md): every phone surface draws from these and nothing else. */
export const dur = { fast: 0.16, base: 0.22, slow: 0.42, long: 0.6 } as const;
export const ease = {
  out: [0.22, 1, 0.36, 1] as const,
  pop: [0.24, 1.34, 0.38, 1] as const,
  release: [0.28, 1.4, 0.36, 1] as const,
  menuIn: [0.16, 1, 0.3, 1] as const,
};
export const spring = {
  settle: { type: "spring", stiffness: 380, damping: 34 } as const,
  lively: { type: "spring", stiffness: 500, damping: 18 } as const,
  modal: { type: "spring", stiffness: 340, damping: 30, mass: 0.8 } as const,
  popover: { type: "spring", stiffness: 420, damping: 34, mass: 0.7 } as const,
  panel: { type: "spring", stiffness: 320, damping: 32, mass: 0.7 } as const,
};
export const withFade = <T extends object>(s: T) => ({ ...s, opacity: { duration: dur.fast } });

/** The phone's feel, measured off designbookmark.com/motion (omb-ref/designbookmark-motion/NOTES.md): soft springs that
 * land with a few percent of give, and fades on a shorter clock than the travel. Every interaction on the phone takes its numbers from here. */
export const feel = {
  /** a finger down: in on a quick ease, out on a spring that gives a hair past rest (press .952, release 1.008 there) */
  press: { scale: 0.96, wide: 0.985, inMs: 110, release: { stiffness: 620, damping: 30 } },
  /** something arriving: from 8px low and transparent, never blurred; opacity done in 200ms, the travel on `soft` */
  enter: { y: 8, fade: 0.2 },
  /** something leaving: faster and smaller than its entrance (130ms, scale .96) */
  exit: { scale: 0.96, fade: 0.13 },
  /** a held thing lifting out of the page (a message, a chat row) */
  lift: { scale: 1.035, spring: { type: "spring", stiffness: 460, damping: 26 } as const },
  /** morphs and slides between places (a pill, a highlight, a menu's height): t90 ~140ms, ~5% overshoot, ~420ms */
  soft: { type: "spring", stiffness: 400, damping: 28 } as const,
  /** surfaces that open from a source (menus, reaction bars): settles ~300ms with barely any give */
  surface: { type: "spring", stiffness: 380, damping: 30, mass: 0.9 } as const,
  /** items inside a surface that just opened arrive one after another */
  stagger: 0.028,
  /** the dim and blur over the page behind a held thing */
  scrim: { in: 0.22, out: 0.16, blur: 10 },
};

/** UIKit's own transitions (push, pop, sheet), measured off an iOS 26 recording: they leave at full speed and decelerate
 * with no overshoot. `push` is the start velocity in distances per second, for a push, a tapped pop and a rising sheet. */
export const system = { ...pacedSpring({ stiffness: 600, damping: 54 }), push: 10 / MOTION.scale } as const;
/** Content moving to a new place (rows reordering, a list making room): the vertical curve iOS, Telegram iOS and both
 * Telegram web clients use for a sent message's flight. */
export const contentMove = { ms: 250, css: "cubic-bezier(0.1992, 0.0106, 0.2792, 0.9103)" } as const;
/** A long press as Telegram iOS answers it: still for 120ms, then the held thing shrinks by 15pt of its width over 200ms. */
export const holdPress = { stillMs: 120, shrinkMs: 200, inset: 15 } as const;

/** A spring as a WAAPI/CSS duration and linear() easing, for things that must not wait on React. */
export function springEasing(stiffness: number, damping: number): { duration: number; easing: string } {
  const w = Math.sqrt(stiffness);
  const z = Math.min(1, damping / (2 * w));
  const wd = w * Math.sqrt(Math.max(1e-6, 1 - z * z));
  const at = (t: number) => z >= 1 ? 1 - (1 + w * t) * Math.exp(-w * t)
    : 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + (z * w / wd) * Math.sin(wd * t));
  let end = 0.05;
  while (Math.abs(1 - at(end)) > 0.001 || Math.abs(1 - at(end + 0.03)) > 0.001) end += 0.01;
  const steps = 40;
  const points = Array.from({ length: steps + 1 }, (_, i) => i === steps ? "1" : String(Math.round(at((end * i) / steps) * 10000) / 10000));
  return { duration: Math.round(end * 1000), easing: `linear(${points.join(", ")})` };
}

/** A spring from `from` to `to` that leaves at `velocity` (units/s), sampled every frame until it rests within `rest`:
 * the positions for WAAPI keyframes, which the compositor plays on its own while the page's thread is busy. */
export function springPath(from: number, to: number, velocity: number, { stiffness, damping, mass = 1 }: { stiffness: number; damping: number; mass?: number }, rest = 0.25): { duration: number; points: number[] } {
  const step = 1000 / 60;
  const w = Math.sqrt(stiffness / mass);
  const z = damping / (2 * Math.sqrt(stiffness * mass));
  const d0 = from - to;
  const offset = (t: number): number => {
    if (Math.abs(z - 1) < 1e-4) return (d0 + (velocity + w * d0) * t) * Math.exp(-w * t);
    if (z > 1) {
      const root = w * Math.sqrt(z * z - 1);
      const r1 = -z * w + root, r2 = -z * w - root;
      const a = (velocity - r2 * d0) / (r1 - r2);
      return a * Math.exp(r1 * t) + (d0 - a) * Math.exp(r2 * t);
    }
    const wd = w * Math.sqrt(1 - z * z);
    return Math.exp(-z * w * t) * (d0 * Math.cos(wd * t) + ((velocity + z * w * d0) / wd) * Math.sin(wd * t));
  };
  const points = [from];
  for (let i = 1; i < 120; i += 1) {
    const d = offset((i * step) / 1000);
    if (Math.abs(d) < rest && Math.abs(offset(((i + 1) * step) / 1000)) < rest) break;
    points.push(to + d);
  }
  points.push(to);
  return { duration: Math.round((points.length - 1) * step), points };
}

const IOS_KEYBOARD = springEasing(555.027, 47.118);
/** The software keyboard's own curve: iOS 26 slides it on a critically damped spring (mass 1, stiffness 555.027, damping
 * 47.118, about 0.383 s, as Telegram iOS reads it off UIKit), Android on its emphasized decelerate. */
export const keyboardCurve = {
  ios: { duration: IOS_KEYBOARD.duration / 1000, css: IOS_KEYBOARD.easing },
  android: { duration: 0.28, css: "cubic-bezier(.2,0,0,1)" },
};

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Rubber band past an edge, as UIScrollView: the further you pull the less it gives. `limit` is the asymptote. */
export function rubberband(overshoot: number, limit: number, coefficient = 0.55): number {
  if (overshoot === 0) return 0;
  const sign = Math.sign(overshoot);
  const distance = Math.abs(overshoot);
  return sign * (1 - 1 / ((distance * coefficient) / limit + 1)) * limit;
}

/** Where a released gesture would come to rest if left to decelerate: UIScrollView's normal rate, in px and px/s. */
export function projectRelease(position: number, velocity: number, decelerationRate = 0.998): number {
  return position + (velocity / 1000) * decelerationRate / (1 - decelerationRate);
}

/** Hands a gesture's release velocity to a spring, so the settle starts at the finger's speed. Reduced motion cuts to a
 * short fade-length tween instead. */
export function settleTo(value: MotionValue<number>, target: number, velocity: number, onDone?: () => void, options?: { stiffness?: number; damping?: number; restDelta?: number }): AnimationPlaybackControls {
  if (prefersReducedMotion()) return animate(value, target, { duration: dur.fast, ease: ease.out, onComplete: onDone });
  return animate(value, target, {
    type: "spring",
    stiffness: options?.stiffness ?? spring.settle.stiffness,
    damping: options?.damping ?? spring.settle.damping,
    velocity,
    restDelta: options?.restDelta ?? 0.5,
    restSpeed: 10,
    onComplete: onDone,
  });
}

/** Tracks pointer velocity over the last ~80 ms, enough to read a flick without being thrown by the final jitter. */
export function velocityTracker() {
  let samples: Array<{ t: number; x: number; y: number }> = [];
  return {
    reset(x: number, y: number) { samples = [{ t: performance.now(), x, y }]; },
    push(x: number, y: number) {
      const t = performance.now();
      samples.push({ t, x, y });
      while (samples.length > 2 && t - samples[0].t > 80) samples.shift();
    },
    velocity(): { x: number; y: number } {
      if (samples.length < 2) return { x: 0, y: 0 };
      const first = samples[0], last = samples[samples.length - 1];
      const dt = (last.t - first.t) / 1000;
      if (dt <= 0) return { x: 0, y: 0 };
      return { x: (last.x - first.x) / dt, y: (last.y - first.y) / dt };
    },
  };
}
