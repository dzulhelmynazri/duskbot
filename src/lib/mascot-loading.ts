import type { LocaleKey } from "@/locales";
import { HANDED_KEY } from "./switch-hold-key";
import { MASCOT_INK, PICKER_COLORS, type MausColor } from "./mascot";

/** How the loading mascot carries itself through one launch: looking about, hopping in place, mulling, all ears. */
export const LOADING_MOODS = ["searching", "waiting", "thinking", "listening"] as const;
export type LoadingMood = (typeof LOADING_MOODS)[number];
export type LoadingFace = LoadingMood | "sleeping" | "waking" | "happy";

/** The crew from the desktop's startup card (electron/startup-screen.mjs), so every wait shows the same characters. */
export const LOADING_CREW = ["goo", "kit", "pip", "mochi", "boxo"] as const;
export type LoadingCrew = (typeof LOADING_CREW)[number];

const LAST_COLOUR = "madani.loading.colour";
// white eyes on a yellow body read too faintly at loading size
const PALE = new Set<MausColor>(["yellow"]);

/** A crew member, colour and mood for this launch; never the colour the last launch wore. */
export function pickLoadingLook(last: string | null, random: () => number = Math.random): { color: MausColor; mood: LoadingMood; crew: LoadingCrew } {
  const colours = PICKER_COLORS.filter((color) => color !== last && !PALE.has(color));
  return {
    color: colours[Math.floor(random() * colours.length)] ?? "blue",
    mood: LOADING_MOODS[Math.floor(random() * LOADING_MOODS.length)] ?? "searching",
    crew: LOADING_CREW[Math.floor(random() * LOADING_CREW.length)] ?? "kit",
  };
}

let launch: { start: number; color: MausColor; mood: LoadingMood; crew: LoadingCrew; seen: boolean } | null = null;

/** The mascot a page hands on to the page a switch of place opens: who it is, how long it has been on screen, and the
 * ink it is drawn in and the ground under it, for the next page to paint before its own code has loaded. */
export type HandedLook = { crew: LoadingCrew; color: MausColor; mood: LoadingMood; elapsed: number; ink?: string; ground?: string };

/** Only after this long on screen has the mascot appeared (MascotLoader waits as long before it shows). */
export const APPEAR_AFTER_MS = 220;

const handedOf = (value: unknown): HandedLook | null => {
  if (!value || typeof value !== "object") return null;
  const { crew, color, mood, elapsed } = value as Record<string, unknown>;
  if (!LOADING_CREW.includes(crew as LoadingCrew) || !PICKER_COLORS.includes(color as MausColor) || !LOADING_MOODS.includes(mood as LoadingMood)) return null;
  if (typeof elapsed !== "number" || !Number.isFinite(elapsed) || elapsed < 0) return null;
  return { crew: crew as LoadingCrew, color: color as MausColor, mood: mood as LoadingMood, elapsed };
};

/** One loading look and clock for the whole launch, so every screen that waits shows the same mascot, mid-story. A page
 * that a switch of place opened goes on with the mascot the page before `handed` on, where it was. */
export function loadingLaunch(now = performance.now(), handed: () => unknown = handedByDesktop) {
  if (launch) return launch;
  const came = handedOf(handed());
  if (came) {
    launch = { start: now - came.elapsed, color: came.color, mood: came.mood, crew: came.crew, seen: came.elapsed >= APPEAR_AFTER_MS };
    return launch;
  }
  let last: string | null = null;
  try { last = localStorage.getItem(LAST_COLOUR); } catch { /* storage off: any colour */ }
  launch = { start: now, ...pickLoadingLook(last), seen: false };
  try { localStorage.setItem(LAST_COLOUR, launch.color); } catch { /* storage off */ }
  return launch;
}

function handedByDesktop(): unknown {
  if (typeof window === "undefined") return null;
  const held = (window as unknown as Record<string, unknown>)[HANDED_KEY];
  if (held) return held;
  try { return window.madaniDesktop?.workspaces?.takeLook?.() ?? null; } catch { return null; }
}

/** A switch of place began: the same mascot waits again from the start, hopping in as on launch. */
export function restartLoadingLaunch(now = performance.now()) {
  const look = loadingLaunch(now);
  look.start = now;
  look.seen = false;
  return look;
}

/** The mascot as it is now, to hand on to the page a switch of place opens. */
export function handLoadingLook(now = performance.now(), ground?: string): HandedLook {
  const look = loadingLaunch(now);
  return { crew: look.crew, color: look.color, mood: look.mood, elapsed: Math.max(0, now - look.start), ink: MASCOT_INK[look.color], ...(ground ? { ground } : {}) };
}

export function resetLoadingLaunch() { launch = null; }

const NAP_MS = 2600;
const STRETCH_MS = 1700;
const DOZE_AFTER_MS = 9000;
const DOZE_EVERY_MS = 20000;

/** The face at `elapsed` ms into the wait: its mood, and once the wait runs long (or the computer is still starting),
 * a short nap and a wake-up, again every so often. */
export function loadingFace(elapsed: number, mood: LoadingMood, dozeFrom: number | null): LoadingFace {
  const from = dozeFrom ?? DOZE_AFTER_MS;
  if (elapsed < from) return mood;
  const k = (elapsed - from) % DOZE_EVERY_MS;
  return k < NAP_MS ? "sleeping" : k < NAP_MS + STRETCH_MS ? "waking" : mood;
}

const STEPS: Array<[number, LocaleKey]> = [
  [0, "loading.line.loading"],
  [2200, "loading.line.warmingUp"],
  [4800, "loading.line.wakingCrew"],
  [7800, "loading.line.gettingChats"],
  [11000, "loading.line.almostThere"],
];
const LATER: LocaleKey[] = ["loading.line.stillOnIt", "loading.line.anyMoment", "loading.line.almostThere"];
const LATER_FROM = 14500;
const LATER_EVERY = 3600;

/** The short line under the mascot at `elapsed` ms; a nap and its wake-up read as a stretch. */
export function loadingLineAt(elapsed: number, face: LoadingFace): LocaleKey {
  if (face === "sleeping" || face === "waking") return "loading.line.stretching";
  if (elapsed >= LATER_FROM) return LATER[Math.floor((elapsed - LATER_FROM) / LATER_EVERY) % LATER.length]!;
  let key = STEPS[0]![1];
  for (const [at, line] of STEPS) if (elapsed >= at) key = line;
  return key;
}

/** The eye shapes the startup crew's sprites carry. */
export type LoaderEyes = "idle" | "happy" | "working" | "sleeping" | "thinking";
export type LoaderBeat = "hop" | "double" | "look" | "think" | "peek";

/** One drawn frame, in sprite pixels: offset from rest (y up is negative), squash and stretch about the feet, where the
 * eyes look, and the nap's rising z's as 0..1 progress each. */
export interface LoaderPose { eyes: LoaderEyes; look: -1 | 0 | 1; x: number; y: number; sx: number; sy: number; flip: boolean; alpha: number; z: number[] }

export const BEAT_MS: Record<LoaderBeat, number> = { hop: 560, double: 1020, look: 1500, think: 1300, peek: 1000 };
const POOLS: Record<LoadingMood, LoaderBeat[]> = {
  searching: ["look", "look", "look", "hop", "think", "peek"],
  waiting: ["hop", "hop", "double", "double", "look", "peek"],
  thinking: ["think", "think", "think", "look", "hop"],
  listening: ["look", "look", "hop", "peek", "double"],
};

/** The next move for this mood, and the rest before it. */
export function pickBeat(mood: LoadingMood, random: () => number = Math.random): { beat: LoaderBeat; gap: number } {
  const pool = POOLS[mood];
  return { beat: pool[Math.floor(random() * pool.length)] ?? "look", gap: 420 + Math.round(random() * 680) };
}

export const ARRIVE_MS = 650;
/** How far right of its spot the mascot starts its hop in, in sprite pixels. */
export const ARRIVE_FROM = 22;
const SETTLE_MS = 130;
const CHEER_MS = 260;

const easeOut = (v: number) => 1 - (1 - v) ** 3;
const rest = (eyes: LoaderEyes = "idle"): LoaderPose => ({ eyes, look: 0, x: 0, y: 0, sx: 1, sy: 1, flip: false, alpha: 1, z: [] });

/** A landing's squash, `ms` after touching down, easing back to round. */
function settle(pose: LoaderPose, ms: number) {
  if (ms < 0 || ms >= SETTLE_MS) return;
  const k = 1 - easeOut(ms / SETTLE_MS);
  pose.sx = 1 + 0.14 * k; pose.sy = 1 - 0.14 * k;
}

/** A hop of height `h` starting at 0 ms: a crouch, a stretch on the way up, a squash on landing. */
function hop(pose: LoaderPose, ms: number, h: number) {
  if (ms < 0) return;
  if (ms < 90) { const k = easeOut(ms / 90); pose.sx = 1 + 0.1 * k; pose.sy = 1 - 0.1 * k; return; }
  const air = (ms - 90) / 280;
  if (air < 1) {
    pose.y = -4 * air * (1 - air) * h;
    const s = air < 0.4 ? 1 - air / 0.4 : 0;
    pose.sx = 1 - 0.08 * s; pose.sy = 1 + 0.1 * s;
    return;
  }
  settle(pose, ms - 370);
}

/** The pose `ms` into a beat. */
export function beatPose(beat: LoaderBeat, ms: number, eyes: LoaderEyes = "idle"): LoaderPose {
  const pose = rest(eyes);
  if (beat === "hop") hop(pose, ms, 5);
  else if (beat === "double") { hop(pose, ms, 4); if (ms >= 470) { const second = rest(eyes); hop(second, ms - 470, 3); Object.assign(pose, { ...second, eyes }); } }
  else if (beat === "look") pose.look = ms < 600 ? -1 : ms < 680 ? 0 : ms < 1260 ? 1 : 0;
  else if (beat === "think") { pose.eyes = "thinking"; if (ms > 150 && ms < 300) pose.y = -1; }
  else if (beat === "peek") { pose.eyes = "working"; if (ms > 120 && ms < 320) pose.y = 1; }
  return pose;
}

/** Blinks every few seconds, now and then twice. */
export function blinking(ms: number): boolean {
  const k = ms % 3700;
  return k < 110 || (Math.floor(ms / 3700) % 3 === 1 && k > 230 && k < 330);
}

/** The startup card's arrival: three bounces in from the right, facing the way it goes, landing in a squash. */
export function arrivePose(ms: number): LoaderPose {
  const pose = rest("working");
  const f = Math.min(1, Math.max(0, ms / ARRIVE_MS));
  pose.flip = true;
  pose.alpha = Math.min(1, f * 4);
  pose.x = ARRIVE_FROM * (1 - easeOut(f));
  pose.y = -Math.abs(Math.sin(f * Math.PI * 3)) * 6 * (1 - f * 0.5);
  if (f > 0.9) { pose.sx = 1.12; pose.sy = 0.88; }
  return pose;
}

/** Asleep: eyes shut, a slow breath, z's drifting up. */
export function napPose(ms: number): LoaderPose {
  const pose = rest("sleeping");
  pose.sy = 1 - 0.035 * (1 + Math.sin((ms / 2800) * Math.PI * 2));
  pose.sx = 2 - pose.sy;
  pose.z = [0, 1, 2].map((i) => ((ms / 2400 + i / 3) % 1));
  return pose;
}

/** Waking: still asleep a moment, eyes pop open with a startled hop, then a blink. */
export function wakePose(ms: number): LoaderPose {
  if (ms < 300) return rest("sleeping");
  const pose = rest("idle");
  hop(pose, ms - 300, 6);
  if (ms > 1000 && ms < 1110) pose.eyes = "sleeping";
  return pose;
}

/** Glad it is done: a quick cheer hop with squinting eyes, as the startup crew does. */
export function cheerPose(ms: number): LoaderPose {
  const pose = rest("happy");
  if (ms < CHEER_MS) pose.y = -Math.sin((ms / CHEER_MS) * Math.PI) * 3.5;
  else settle(pose, ms - CHEER_MS);
  return pose;
}

/** Between beats it bobs a pixel now and then, as the startup crew does while it waits. */
export function idleBob(ms: number): number {
  return Math.sin(ms / 420) > 0.7 ? -1 : 0;
}

/** A pose with all movement taken out, for reduced motion: the eyes still say what is going on. */
export function still(pose: LoaderPose): LoaderPose {
  return { ...pose, x: 0, y: 0, sx: 1, sy: 1, flip: false, alpha: pose.alpha > 0 ? 1 : 0, z: pose.z.length ? [0.5] : [] };
}
