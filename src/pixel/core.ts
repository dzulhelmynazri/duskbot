// madani pixel core: one colour pixel mascots, body and eyes only. still at rest, full body motion while busy. no dom here:
// a bot paints palette indices (0 empty, 1 body, 2 eye) and the host turns them into pixels
import { PIXEL_BODIES, type BodyPart, type PartOptions, type PixelBodyDef, type PixelBodyId } from "../../shared/pixel-bodies.ts";

export type PixelState =
  | "idle" | "listening" | "thinking" | "working" | "searching" | "waiting" | "done" | "happy" | "excited" | "love"
  | "surprised" | "confused" | "sad" | "error" | "sleeping" | "waking";
export type PixelReaction = "boing" | "wobble" | "squish" | "spin" | "heart" | "dizzy" | "nod" | "hop" | "poke";
type Eye = "open" | "big" | "wide" | "focus" | "half" | "blink" | "closed" | "happy" | "sad" | "x" | "dizzy" | "heart" | "none";

export const EMPTY = 0, BODY = 1, EYE = 2;

const TAU = Math.PI * 2, D2R = Math.PI / 180, R = Math.round, abs = Math.abs, sin = Math.sin, cos = Math.cos;
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

const rngOf = (seed: number) => {
  let a = seed;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
};
export const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };

type Test = (x: number, y: number, k: number) => boolean;
// shape tests in source grid units. k is source units per output pixel so thin parts never vanish
const SH: Record<BodyPart[0], (...a: number[]) => Test> = {
  c: (x0, y0, r) => (x, y) => (x - x0!) ** 2 + (y - y0!) ** 2 < r! * r!,
  e: (x0, y0, rx, ry) => (x, y) => ((x - x0!) / rx!) ** 2 + ((y - y0!) / ry!) ** 2 < 1,
  s: (x0, y0, rx, ry, p = 4) => (x, y) => abs((x - x0!) / rx!) ** p + abs((y - y0!) / ry!) ** p < 1,
  r: (x0, y0, x1, y1, r = 0) => (x, y) => {
    if (x < x0! || x > x1! || y < y0! || y > y1!) return false;
    const dx = Math.max(x0! + r - x, 0, x - x1! + r), dy = Math.max(y0! + r - y, 0, y - y1! + r);
    return dx * dx + dy * dy <= r * r;
  },
  l: (ax, ay, bx, by, th = 1) => (x, y, k) => {
    const dx = bx! - ax!, dy = by! - ay!, L = dx * dx + dy * dy || 1, t = clamp(((x - ax!) * dx + (y - ay!) * dy) / L, 0, 1);
    const ex = x - ax! - t * dx, ey = y - ay! - t * dy, h = Math.max(th / 2, k * 0.55);
    return ex * ex + ey * ey < h * h;
  },
  p: (...q) => (x, y) => {
    let inn = false;
    for (let i = 0, j = q.length - 2; i < q.length; j = i, i += 2) {
      const xi = q[i]!, yi = q[i + 1]!, xj = q[j]!, yj = q[j + 1]!;
      if (yi > y != yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inn = !inn;
    }
    return inn;
  },
};
function mirArgs(t: BodyPart[0], args: number[], N: number) {
  const a = args.slice();
  if (t == "r") { const x0 = a[0]!; a[0] = N - a[2]!; a[2] = N - x0; }
  else if (t == "l") { a[0] = N - a[0]!; a[2] = N - a[2]!; }
  else if (t == "p") for (let i = 0; i < a.length; i += 2) a[i] = N - a[i]!;
  else a[0] = N - a[0]!;
  return a;
}

interface Part { test: Test; cut: boolean; z: number; piv?: readonly [number, number]; m: 1 | -1; g: number }
interface Group { q: string; amp: number; sp: number; ph: number }
export interface Def {
  name: string; N: number; float: boolean; parts: Part[]; groups: Group[];
  eyes: { w: number; h: number; gap: number; y: number; x: number; r?: 1 };
  p: NonNullable<PixelBodyDef["p"]>; pokes?: readonly string[];
  cache: Record<number, Map<string, Uint8Array>>;
}

const DEFS: Record<string, Def> = Object.create(null);

function define(name: string, d: PixelBodyDef): Def {
  const N = d.N || 16, parts: Part[] = [], groups: Group[] = [], gmap: Record<string, number> = {};
  d.parts.forEach((p, i) => {
    const last = p[p.length - 1];
    const o: PartOptions = typeof last == "object" ? last : {};
    const args = p.slice(1, typeof last == "object" ? -1 : undefined) as number[];
    const mk = (a: number[], m: 1 | -1, piv?: readonly [number, number]) => {
      let g = -1;
      if (o.q || o.g) {
        const key = (o.g || "i" + i) + (m < 0 ? "m" : "");
        if (!(key in gmap)) { gmap[key] = groups.length; groups.push({ q: o.q || "none", amp: (o.amp || 8) * D2R, sp: o.sp || 1, ph: (o.ph || 0) + (m < 0 ? 1.7 : 0) }); }
        g = gmap[key]!;
      }
      parts.push({ test: SH[p[0]](...a), cut: !!o.cut, z: o.z || 0, piv, m, g });
    };
    mk(args, 1, o.piv);
    if (o.mir) mk(mirArgs(p[0], args, N), -1, o.piv && [N - o.piv[0], o.piv[1]]);
  });
  parts.sort((a, b) => a.z - b.z);
  return (DEFS[name] = {
    name, N, float: !!d.float, parts, groups, p: d.p || {}, pokes: d.pokes, cache: {},
    eyes: { x: N / 2, ...d.eyes },
  });
}
for (const [name, d] of Object.entries(PIXEL_BODIES)) define(name, d as PixelBodyDef);

export const defOf = (body: string): Def => DEFS[body] ?? DEFS.kit!;

class Spring {
  x = 0; v = 0; k: number; c: number;
  constructor(k: number, z: number) { this.k = k; this.c = 2 * z * Math.sqrt(k); }
  step(t: number, dt: number) { this.v += (-this.k * (this.x - t) - this.c * this.v) * dt; this.x += this.v * dt; }
}

const HEART = ["##.##", "#####", ".###.", "..#.."];
// when an expression does not fit inside the body, fall back to a simpler one
const FALL: Partial<Record<Eye, Eye[]>> = { heart: ["heart", "happy", "closed"], big: ["big", "wide", "open"], wide: ["wide", "open"], x: ["x", "closed"], dizzy: ["dizzy", "closed"], sad: ["sad", "half"], focus: ["focus", "half"], happy: ["happy", "closed"] };
const OPEN: Partial<Record<Eye, 1>> = { open: 1, wide: 1, focus: 1, half: 1, big: 1 };

let reduce = typeof matchMedia == "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
/** the page's prefers-reduced-motion, kept by the host */
export function setReduced(v: boolean) { reduce = v; }
export const reduced = () => reduce;

export interface Pose {
  sq: number; lean: number; gx: number; gy: number; dx: number; yaw: number; snap: number | null; lift: number;
  eyes: Eye; eyesR: Eye | null; blink: number; look: number; m: boolean;
}
interface StateDef { active?: 1; enter?(b: PixelCore): void; pose?(b: PixelCore, t: number, P: Pose): void }

// P.m is false for a calm bot or reduced motion: it keeps the eyes of a state and none of the motion.
// u is state time at this bot's own tempo, so neighbours never move in step
const STATES: Record<PixelState, StateDef> = {
  idle: {},
  listening: {
    active: 1,
    pose(b, t, P) {
      P.eyes = "wide"; P.look = 0;
      if (!P.m) return;
      const u = t * b.pe.tm, ph = u % 2.6;
      P.lean = 0.14 * b.pe.side; P.gx = b.pe.side;
      if (ph < 0.6) P.gy = 1;
      if (b.beat("a", u, 2.6)) b.kick(3.2);
      if (b.beat("b", u - 0.28, 2.6)) b.kick(2.6);
    },
  },
  thinking: {
    active: 1,
    pose(b, t, P) {
      P.gy = -1; P.look = 0; P.gx = b.pe.side;
      if (!P.m) return;
      const u = t * b.pe.tm, w = sin(u * 1.4);
      P.gx = (w > 0 ? 1 : -1) * b.pe.side;
      P.lean = 0.15 * w * b.pe.side; P.sq = 0.04 + 0.04 * sin(u * 2.8);
      if (b.beat("h", u - 2, 4.5)) b.hop(0.35);
    },
  },
  working: {
    active: 1,
    pose(b, t, P) {
      P.eyes = "focus"; P.gy = 1; P.look = 0;
      if (!P.m) return;
      const u = t * b.pe.tm;
      const ph = u % 3.6, typing = ph < 2;
      P.gx = typing ? [-1, 0, 1, 0][Math.floor(u / 0.5) % 4]! : ph < 2.8 ? -b.pe.side : b.pe.side;
      P.lean = typing ? 0.13 * b.pe.side : 0.03 * b.pe.side;
      if (typing && b.beat("k", u, 0.25)) b.kick(1.6);
      if (b.beat("l", u - 2.9, 7.2)) b.hop(0.45);
    },
  },
  searching: {
    active: 1,
    pose(b, t, P) {
      P.look = 0;
      const u = t * b.pe.tm, d = [1, 0, -1, 0][Math.floor(u / 1.2) % 4]! * b.pe.side;
      P.gx = d;
      if (!P.m) return;
      P.yaw = d * 1.05; P.lean = d * 0.08;
      if (b.beat("s", u, 1.2)) b.kick(-2.2);
    },
  },
  waiting: {
    active: 1,
    pose(b, t, P) {
      const u = t * b.pe.tm;
      if (u % 5 > 3.6) { P.gy = -1; P.gx = b.pe.side; P.look = 0; }
      if (!P.m) return;
      P.lean = 0.07 * b.pe.side;
      if (u % 3.6 < 1.5 && b.beat("w", u, 0.5)) b.hop(0.4);
    },
  },
  happy: {
    active: 1,
    pose(b, t, P) {
      P.eyes = "happy";
      if (!P.m) return;
      const u = t * b.pe.tm;
      P.lean = 0.07 * sin(u * 2.4);
      if (b.beat("h", u, 2.6)) b.hop(0.9);
    },
  },
  done: {
    pose(b, t, P) {
      P.eyes = t < 0.12 ? "open" : "happy";
      if (P.m && b.beat("h", t, 9)) b.hop(1.1);
    },
  },
  excited: {
    active: 1,
    pose(b, t, P) {
      P.eyes = b.air ? "big" : "happy";
      if (!P.m) return;
      const u = t * b.pe.tm, ph = u % 2.4;
      if (b.beat("a", u, 2.4)) b.hop(1.15);
      if (b.beat("b", u - 0.48, 2.4)) b.hop(0.75);
      if (ph > 0.95 && ph < 1.6 && !b.air) P.lean = 0.18 * sin(ph * 20) * (1.6 - ph) * 1.5;
    },
  },
  love: {
    active: 1,
    pose(b, t, P) {
      P.eyes = "heart"; P.blink = 0;
      if (!P.m) return;
      const u = t * b.pe.tm;
      P.lean = 0.1 * sin(u * 2.6);
      if (u % 2.6 < 1 && b.beat("h", u, 0.5)) b.hop(0.45);
    },
  },
  surprised: {
    pose(b, t, P) {
      P.eyes = "big"; P.look = 0;
      if (!P.m) return;
      if (b.beat("s", t, 9)) { b.kick(-6); b.hop(0.55); }
      if (t < 0.3) P.sq = -0.2;
    },
  },
  confused: {
    active: 1,
    pose(b, t, P) {
      P.eyes = "open"; P.eyesR = "half"; P.look = 0; P.gy = -1;
      if (!P.m) return;
      const u = t * b.pe.tm, d = Math.floor(u / 2.2) % 2 ? -1 : 1;
      P.lean = 0.2 * d * b.pe.side; P.yaw = 0.6 * d * b.pe.side; P.gx = -d * b.pe.side;
      if (b.beat("c", u, 2.2)) b.kick(2.4);
    },
  },
  sad: {
    active: 1,
    pose(b, t, P) {
      P.eyes = "sad"; P.gy = 1; P.look = 0;
      if (!P.m) return;
      const u = t * b.pe.tm;
      P.sq = Math.min(0.14, t * 0.4) + 0.025 * sin(u * 1.3); P.lean = -0.06 * b.pe.side;
      if (b.beat("s", u - 1.5, 3.6)) b.kick(2.2);
    },
  },
  error: {
    active: 1,
    pose(b, t, P) {
      P.eyes = "x"; P.look = 0; P.blink = 0;
      if (!P.m) return;
      // a readable shake: a few side to side swings that die out, then a long pause
      const ph = t % 3.2, f = Math.max(0, 1 - ph / 0.7);
      P.sq = 0.05; P.dx = 1.8 * sin(ph * 30) * f; P.lean = -0.1 * sin(ph * 30) * f;
      if (b.beat("e", t, 3.2)) b.kick(2.5);
    },
  },
  sleeping: {
    active: 1,
    pose(b, t, P) {
      P.eyes = "closed"; P.look = 0; P.blink = 0;
      if (P.m) P.sq = 0.05 + 0.06 * sin((t * b.pe.tm * TAU) / 3.2);
    },
  },
  waking: {
    active: 1,
    pose(b, t, P) {
      P.look = 0; P.blink = 0;
      P.eyes = t < 0.35 ? "closed" : t < 0.5 ? "half" : t < 0.6 ? "closed" : t < 0.75 ? "half" : "open";
      if (P.m) {
        if (t < 0.6) P.sq = 0.08;
        else if (t < 1.25) { P.sq = -0.2; P.lean = 0.1 * b.pe.side * sin((t - 0.6) * 9); P.gy = -1; }
        if (b.beat("w", t - 1.25, 9)) { b.shake(0.45); b.kick(2); }
      }
      if (t > 1.7) b.setState(b.after);
    },
  },
};
export const PIXEL_STATES = Object.keys(STATES) as PixelState[];
const isState = (n: string): n is PixelState => Object.hasOwn(STATES, n);
const ease = (v: number) => v * v * (3 - 2 * v);

interface Reaction { n: string; t: number; d: number; dir: number; p?: number; a?: number; b?: number; pose?: RxDef["pose"] }
interface RxDef { d: number; start?(b: PixelCore, r: Reaction): void; pose?(b: PixelCore, t: number, P: Pose, r: Reaction): void }
// tap reactions: lively one shots that settle back to still
const RX: Record<Exclude<PixelReaction, "poke">, RxDef> = {
  boing: { d: 0.85, start(b) { b.hop(1.7); }, pose(b, _t, P) { P.eyes = b.air ? "big" : "happy"; } },
  wobble: { d: 0.7, pose(_b, t, P) { const f = 1 - t / 0.7; P.lean = 0.26 * sin(t * 20) * f; P.sq = 0.13 * sin(t * 20 + 1.5) * f; P.dx = 0.8 * sin(t * 20) * f; P.eyes = "happy"; } },
  squish: { d: 0.75, pose(b, t, P, r) { if (t < 0.22) { P.sq = 0.26; P.eyes = "closed"; } else { P.eyes = "big"; if (!r.p) { r.p = 1; b.kick(-5); b.hop(0.6); } } } },
  spin: { d: 0.8, start(b) { b.hop(0.5); }, pose(_b, t, P, r) { P.snap = ease(Math.min(1, t / 0.7)) * TAU * (r.dir < 0 ? -1 : 1); P.look = 0; P.blink = 0; } },
  heart: { d: 0.9, start(b) { b.hop(0.5); }, pose(_b, t, P) { P.eyes = "heart"; P.lean = 0.12 * sin(t * 12) * (1 - t / 0.9); } },
  dizzy: { d: 1.8, pose(_b, t, P) { const f = 1 - t / 1.8; P.eyes = "dizzy"; P.look = 0; P.blink = 0; P.lean = 0.28 * sin(t * 6) * f; P.dx = 2.2 * sin(t * 6 - 1) * f; P.yaw = 0.5 * sin(t * 6 + 1) * f; P.sq = 0.06 * f; } },
  nod: { d: 0.65, pose(b, t, P, r) { P.gy = 1; P.lean = 0.08; if (!r.a) { r.a = 1; b.kick(3.2); } if (!r.b && t > 0.25) { r.b = 1; b.kick(3.2); } } },
  hop: { d: 0.6, start(b) { b.hop(0.9); } },
};
const POKES = ["boing", "wobble", "squish", "spin", "heart"] as const;

export interface CoreOptions {
  body: string;
  state?: string;
  /** css px per grid pixel; the body is drawn on its own grid */
  scale?: number;
  /** drawn size in css px: the body's own grid, scaled to fill it */
  size?: number;
  seed?: number;
  /** false: the eyes of a state and none of the motion */
  calm?: boolean;
  /** false: no blinks and no settling of its own */
  life?: boolean;
  /** the state a waking bot settles in */
  after?: PixelState;
}

/** Where the host shows the bot: its centre on the page, for gaze toward a pointer or a neighbour. */
export interface CoreHost { center(): { x: number; y: number }; pointer(): { x: number; y: number; fresh: boolean } | null }

export class PixelCore {
  readonly def: Def;
  readonly G: number; readonly s: number; readonly k: number;
  readonly px: number; readonly pt: number; readonly W: number; readonly H: number; readonly ax: number; readonly ay: number;
  /** palette indices, W by H */
  readonly paint: Uint8Array;
  state: PixelState = "idle";
  after: PixelState;
  calm: boolean; life: boolean;
  host: CoreHost | null = null;
  rng: () => number;
  pe: { hop: number; side: number; tm: number };
  air = false;
  T: number;
  private sT: number; private nap: number; private y = 0; private vy = 0; private v0 = 0; private crouch = 0; private hopH = 0;
  private sq = new Spring(320, 0.55); private lean = new Spring(200, 0.6); private gxs = new Spring(500, 1); private gys = new Spring(500, 1);
  private xo = new Spring(500, 0.35); private yw = new Spring(90, 0.8); private gs: Spring[];
  private bk: number; private bt: Record<string, number> = {}; private P = {} as Pose; private rx: Reaction | null = null;
  private lastKey = ""; private taps: number[] = []; private lastPoke = "";
  private man: { x: number; y: number; u: number } | null = null; private gl: { x: number; y: number; u: number } | null = null;
  private dir: { x: number; y: number } | null = null;
  private once = false;
  private eye: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  private ev: Record<string, Array<(a: unknown) => void>> = {};
  /** the expression drawn last, for tests */
  shown = "";
  /** true while the paint changed since the host last read it */
  dirty = true;

  constructor(o: CoreOptions) {
    const def = (this.def = defOf(o.body));
    const N = def.N;
    const G = N, s = o.size ? o.size / N : o.scale || 4;
    this.G = G; this.s = s; this.k = N / G;
    // a little room around the body for lean, ears and hops
    this.px = Math.ceil(G * 0.35); this.pt = Math.ceil(G * 0.62);
    this.W = G + this.px * 2; this.H = G + this.pt;
    this.ax = this.px + G / 2; this.ay = this.pt + G;
    this.paint = new Uint8Array(this.W * this.H);
    const rnd = (this.rng = rngOf(o.seed ?? hash(def.name)));
    const p = def.p;
    this.pe = { hop: (p.hop || 1) * (0.85 + rnd() * 0.35), side: rnd() < 0.5 ? -1 : 1, tm: 0.88 + rnd() * 0.24 };
    this.gs = def.groups.map(() => new Spring(260, 0.45));
    this.bk = 1 + rnd() * 7;
    this.T = rnd() * 10; this.nap = this.T + 6 + rnd() * 14;
    this.calm = !!o.calm; this.life = o.life !== false; this.after = o.after ?? "idle";
    this.sT = this.T;
    const st = o.state;
    if (st && isState(st)) { this.state = st; STATES[st].enter?.(this); }
    this.tick(0);
  }

  on(n: string, f: (a: unknown) => void) { (this.ev[n] ||= []).push(f); return this; }
  private fire(n: string, a?: unknown) { this.ev[n]?.forEach((f) => f(a)); }
  setState(n: string) {
    if (!isState(n) || n == this.state) return this;
    this.state = n; this.sT = this.T; this.bt = {};
    STATES[n].enter?.(this);
    this.fire("state", n);
    return this;
  }
  react(n: PixelReaction, o: { dir?: number; social?: boolean } = {}): this {
    if (n == "poke") return this.poke();
    if (reduce || this.calm) return this;
    const r = RX[n];
    this.rx = { n, t: 0, d: r.d, pose: r.pose, dir: o.dir ?? 0 };
    r.start?.(this, this.rx);
    if (o.social) this.fire("social");
    this.fire("react", n);
    return this;
  }
  /** a tap: wakes a sleeper, five quick ones make it dizzy */
  poke(clientX?: number): this {
    if (this.state == "sleeping") return this.setState("waking");
    const T = this.T;
    this.taps = this.taps.filter((t) => T - t < 2.6);
    this.taps.push(T);
    let dir = 0;
    if (clientX != null && this.host) dir = clamp((clientX - this.host.center().x) / 40, -1, 1);
    if (this.taps.length >= 5) { this.taps = []; this.fire("tap", "dizzy"); return this.react("dizzy", { social: true }); }
    const pool = (this.def.pokes as readonly Exclude<PixelReaction, "poke">[] | undefined) || POKES;
    let n: Exclude<PixelReaction, "poke">;
    do n = pool[(this.rng() * pool.length) | 0]!; while (n == this.lastPoke && pool.length > 1);
    this.lastPoke = n;
    this.fire("tap", n);
    return this.react(n, { dir, social: true });
  }
  blink() { if (!reduce && !this.calm) { this.bk = this.T; this.once = true; } }
  /** seconds until a settled bot next moves on its own: a blink or a settle */
  dueIn() {
    if (!this.life || reduce) return Infinity;
    const nap = this.state == "idle" && !this.calm && !reduce ? this.nap - this.T : Infinity;
    return Math.max(0, Math.min(this.bk - 0.1 - this.T, nap));
  }
  hop(h = 1) {
    if (reduce || this.calm || this.air || this.crouch > 0) return;
    this.crouch = 0.07; this.hopH = h * this.pe.hop * this.def.N * 0.2;
  }
  shake(a = 1) { if (!reduce && !this.calm) this.xo.v += this.def.N * 2.4 * a * (this.rng() < 0.5 ? -1 : 1); }
  kick(v: number) { if (!reduce && !this.calm) this.sq.v += v; }
  /** true once each time u crosses into a new period */
  beat(key: string, u: number, per: number) { const n = Math.floor(u / per); if (n < 0 || this.bt[key] === n) return false; this.bt[key] = n; return true; }
  /** look at a point on the page for dur ms, or null to stop */
  lookAt(x: number | null, y = 0, dur?: number) { this.man = x == null ? null : { x, y, u: dur ? this.T + dur / 1000 : 1e9 }; }
  glance(x: number, y: number, dur = 1000) { this.gl = { x, y, u: this.T + dur / 1000 }; }
  /** look a way, -1..1 on each axis with y down, or null to look about on its own */
  look(dir: { x: number; y: number } | null) { this.dir = dir; }

  /** advance dt seconds and repaint; true while anything still moves */
  tick(dt: number): boolean {
    const T = (this.T += dt), P = this.P, def = this.def, N = def.N, rnd = this.rng;
    const moves = !reduce && !this.calm;
    Object.assign(P, { sq: 0, lean: 0, gx: 0, gy: 0, dx: 0, yaw: 0, snap: null, lift: 0, eyes: "open", eyesR: null, blink: this.life && !reduce ? 1 : 0, look: 1, m: moves });
    STATES[this.state].pose?.(this, T - this.sT, P);
    if (this.state == "idle" && P.m && this.life && T > this.nap) { this.nap = T + 10 + rnd() * 10; this.kick(1.3); }
    const r = this.rx;
    if (r) { r.t += dt; if (r.t >= r.d) this.rx = null; else r.pose?.(this, r.t, P, r); }
    // gaze: eyes shift a pixel toward a direction, a manual target, a neighbour, or a nearby pointer. the body stays put
    if (P.look) {
      if (this.dir) {
        P.gx += abs(this.dir.x) > 0.25 ? Math.sign(this.dir.x) : 0;
        P.gy += abs(this.dir.y) > 0.35 ? Math.sign(this.dir.y) : 0;
      } else if (this.host) {
        let tg: { x: number; y: number } | null = null, near = false;
        const ptr = this.host.pointer();
        if (this.man && T < this.man.u) tg = this.man;
        else if (this.gl && T < this.gl.u) tg = this.gl;
        else if (ptr?.fresh) { tg = ptr; near = true; }
        if (tg) {
          const c = this.host.center(), dx = tg.x - c.x, dy = tg.y - c.y;
          if (!near || dx * dx + dy * dy < 320 * 320) { P.gx += abs(dx) > 24 ? Math.sign(dx) : 0; P.gy += abs(dy) > 60 ? Math.sign(dy) : 0; }
        }
      }
    }
    let eL = P.eyes, eR = P.eyesR || P.eyes, blinking = false;
    if ((P.blink || this.once) && OPEN[eL]) {
      const bt = T - this.bk;
      if (bt >= -0.1) blinking = true;
      if (bt >= 0) {
        const ph: Eye | null = bt < 0.05 ? "blink" : bt < 0.12 ? "closed" : bt < 0.17 ? "blink" : null;
        if (ph) eL = eR = ph;
        else { this.bk = T + 4 + rnd() * 4; this.once = false; }
      }
    }
    // physics in fixed sub steps so springs stay stable
    const g = N * 14;
    if (!moves) {
      this.sq.x = 0; this.sq.v = 0; this.lean.x = 0; this.gxs.x = P.gx; this.gys.x = P.gy; this.xo.x = 0; this.y = 0; this.air = false; this.crouch = 0; this.yw.x = 0;
      this.gs.forEach((s) => { s.x = 0; });
    } else {
      for (let left = dt; left > 1e-6; left -= 1 / 240) {
        const h = Math.min(1 / 240, left);
        let sqT = P.sq;
        if (this.crouch > 0) {
          sqT += 0.1; this.crouch -= h;
          if (this.crouch <= 0) { this.air = true; this.vy = -Math.sqrt(2 * g * this.hopH); this.v0 = -this.vy; this.sq.v -= 2.5; def.groups.forEach((gg, i) => { this.gs[i]!.v += gg.amp * 6; }); }
        }
        if (this.air) {
          this.vy += g * h; this.y += this.vy * h;
          sqT -= 0.06 * clamp(abs(this.vy) / (this.v0 || 1), 0, 1);
          if (this.y >= 0 && this.vy > 0) {
            this.y = 0; this.air = false; this.sq.v += clamp(this.vy * 0.08, 0, 3);
            def.groups.forEach((gg, i) => { this.gs[i]!.v -= gg.amp * 6; });
            this.fire("land");
          }
        }
        this.sq.step(sqT, h); this.lean.step(P.lean, h); this.gxs.step(P.gx, h); this.gys.step(P.gy, h); this.xo.step(P.dx, h);
        if (P.snap != null) { this.yw.x = Math.atan2(sin(P.snap), cos(P.snap)); this.yw.v = 0; } else this.yw.step(P.yaw, h);
        // limbs only follow the body (a hop, a squash) and settle
        for (let i = 0; i < this.gs.length; i++) this.gs[i]!.step(this.sq.x * def.groups[i]!.amp * 1.6 - this.lean.x * 0.6, h);
      }
    }
    // floaters hover at a fixed height; a lift is a whole pixel nudge used by active states
    const hov = (def.float ? -N * 0.1 : 0) - P.lift * this.k;
    this.draw(eL, eR, hov);
    const moving = abs(this.sq.x) + abs(this.sq.v) * 0.05 + abs(this.lean.x) + abs(this.lean.v) * 0.05 + abs(this.xo.x - P.dx) + abs(this.xo.v) * 0.05 + abs(this.yw.x - P.yaw) + abs(this.yw.v) * 0.05 + abs(this.gxs.x - P.gx) + abs(this.gys.x - P.gy) + this.gs.reduce((a, s) => a + abs(s.x) + abs(s.v) * 0.05, 0) > 0.004;
    return !!(this.rx || this.air || this.crouch > 0 || blinking || moving || (STATES[this.state].active && P.m));
  }

  private raster(sx: number, sy: number, lean: number, ang: number[]) {
    const { W, H, k, ax, ay, def } = this, N = def.N, parts = def.parts, m = new Uint8Array(W * H);
    const cs = ang.map((a) => [cos(-a), sin(-a)] as const);
    for (let gy = 0; gy < H; gy++) {
      // lean shifts whole rows by whole pixels so small round parts never break into spikes
      const dy = ((gy + 0.5 - ay) * k) / sy, y0 = N + dy, sh = R((lean * dy) / k) * k;
      for (let gx = 0; gx < W; gx++) {
        const x0 = N / 2 + ((gx + 0.5 - ax) * k + sh) / sx;
        let v = 0;
        for (const p of parts) {
          let x = x0, y = y0;
          if (p.g >= 0 && p.piv) {
            const c = cs[p.g]![0], s = cs[p.g]![1] * p.m, qx = x - p.piv[0], qy = y - p.piv[1];
            x = p.piv[0] + qx * c - qy * s; y = p.piv[1] + qx * s + qy * c;
          }
          if (p.test(x, y, k)) v = p.cut ? 0 : 1;
        }
        m[gy * W + gx] = v;
      }
    }
    // trim 1 or 2 row bumps that stick out a pixel past the rows above and below
    const ext = (y: number, d: number) => { if (y < 0 || y >= H) return null; if (d < 0) { for (let x = 0; x < W; x++) if (m[y * W + x]) return x; } else for (let x = W - 1; x >= 0; x--) if (m[y * W + x]) return x; return null; };
    for (const d of [-1, 1]) for (let y = 1; y < H - 1; y++) for (const n of [1, 2]) {
      const e = ext(y, d), a = ext(y - 1, d), z = ext(y + n, d);
      if (e == null || a == null || z == null) continue;
      let same = true;
      for (let j = 1; j < n; j++) if (ext(y + j, d) !== e) same = false;
      const out = (v: number) => (d < 0 ? e < v : e > v);
      if (same && out(a) && out(z) && abs(e - a) == 1 && abs(e - z) == 1) for (let j = 0; j < n; j++) m[(y + j) * W + e] = 0;
    }
    // one silhouette: a thin part that came loose under shear or squash is joined back by its shortest bridge
    const lab = new Int32Array(W * H).fill(-1), comps: number[][] = [];
    for (let i = 0; i < m.length; i++) {
      if (!m[i] || lab[i]! >= 0) continue;
      const c: number[] = [], st = [i]; lab[i] = comps.length;
      while (st.length) {
        const j = st.pop()!, x = j % W, y = (j / W) | 0; c.push(j);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy, q = yy * W + xx; if (xx >= 0 && yy >= 0 && xx < W && yy < H && m[q] && lab[q]! < 0) { lab[q] = comps.length; st.push(q); } }
      }
      comps.push(c);
    }
    if (comps.length > 1) {
      comps.sort((a, b) => b.length - a.length);
      const main = comps[0]!;
      for (const c of comps.slice(1)) {
        let best = 1e9, A = 0, B = 0;
        for (const i of c) for (const j of main) { const d = Math.max(abs((i % W) - (j % W)), abs(((i / W) | 0) - ((j / W) | 0))); if (d < best) { best = d; A = i; B = j; } }
        let x = A % W, y = (A / W) | 0;
        const bx = B % W, by = (B / W) | 0;
        while (Math.max(abs(bx - x), abs(by - y)) > 1) { x += Math.sign(bx - x); y += Math.sign(by - y); m[y * W + x] = 1; main.push(y * W + x); }
        main.push(...c);
      }
    }
    return m;
  }

  private draw(eL: Eye, eR: Eye, hov: number) {
    const { W, H, G, k, def } = this, N = def.N, E = def.eyes, buf = this.paint;
    const s = this.sq.x;
    const yc = cos(this.yw.x), sy = clamp(1 - s, 0.7, 1.25), sx = clamp(clamp(1 + s * 0.7, 0.8, 1.28) * (0.5 + 0.5 * abs(yc)), 0.5, 1.28);
    const lean = clamp(this.lean.x, -0.28, 0.28);
    // turned more than about 70 degrees: side or back, no eyes
    if (yc < 0.35) eL = eR = "none";
    const q = (v: number) => R(v * G * 1.5) / (G * 1.5);
    const qsx = q(sx), qsy = q(sy), ql = q(lean), qa = this.gs.map((g, i) => { const A = def.groups[i]!.amp; return R(clamp(g.x, -A, A) / (3 * D2R)) * 3 * D2R; });
    const mk = qsx + "," + qsy + "," + ql + "," + qa.join(",");
    const cache = (def.cache[G] ||= new Map());
    let m = cache.get(mk);
    if (!m) { if (cache.size > 600) cache.clear(); m = this.raster(qsx, qsy, ql, qa); cache.set(mk, m); }
    const ox = R(this.xo.x / k), oy = R((this.y + hov) / k);
    // eye geometry in output pixels, kept symmetric
    const F = (x: number, y: number) => [this.ax + ((x - N / 2) * qsx - ql * (y - N)) / k + ox, this.ay + ((y - N) * qsy) / k + oy] as const;
    const ey = E.y + E.h / 2, [lx, ly] = F(E.x - E.gap / 2 - E.w / 2, ey), [rx] = F(E.x + E.gap / 2 + E.w / 2, ey);
    const w = Math.max(1, R(E.w / k)), h = Math.max(1, R((E.h * qsy) / k));
    let gap = Math.max(1, R(abs(rx - lx) - w)), x0 = R((lx + rx) / 2 - (2 * w + gap) / 2);
    const y0 = R(ly - h / 2), row = clamp(R(ly) - oy, 0, H - 1);
    // centre the pair on the body row it sits on, with matching parity so both sides get the same margin
    let a = R(this.ax) - 1, z = a;
    if (m[row * W + a]) { while (a > 0 && m[row * W + a - 1]) a--; while (z < W - 1 && m[row * W + z + 1]) z++; const bw = z - a + 1; if ((bw - 2 * w - gap) % 2) gap += gap > 1 ? -1 : 1; x0 = a + ox + (bw - 2 * w - gap) / 2; }
    const gx = R(this.gxs.x + sin(this.yw.x) * 1.6), gy = R(this.gys.x), ph = R(this.T * 6) % 64;
    this.eye = [x0, y0, w, h, gap];
    const key = mk + "|" + ox + "," + oy + "|" + eL + eR + this.eye.join(",") + gx + "," + gy + (eL == "dizzy" ? ph : "");
    if (key == this.lastKey) return;
    this.lastKey = key; this.dirty = true;
    buf.fill(EMPTY);
    for (let y = 0; y < H; y++) {
      const my = y - oy;
      if (my < 0 || my >= H) continue;
      for (let x = 0; x < W; x++) {
        const mx = x - ox;
        if (mx >= 0 && mx < W && m[my * W + mx]) buf[y * W + x] = BODY;
      }
    }
    if (eL != "none") this.drawEyes(m, eL, eR, ox, oy, gx, gy, ph); else this.shown = "none";
  }

  private drawEyes(m: Uint8Array, eL: Eye, eR: Eye, ox: number, oy: number, gx: number, gy: number, ph: number) {
    const { W, H } = this, buf = this.paint, [x0, y0, w, h, gap] = this.eye, round = !!this.def.eyes.r && w >= 3 && h >= 5;
    const at = (x: number, y: number) => { const mx = x - ox, my = y - oy; return mx >= 0 && my >= 0 && mx < W && my < H && !!m[my * W + mx]; };
    const inner = (x: number, y: number) => { for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) if (!at(x + i, y + j)) return false; return true; };
    const sum = 2 * x0 + 2 * w + gap - 1;
    type Pt = [number, number];
    // one eye, drawn as the left eye; the right eye is its mirror
    const shape = (ex: Eye): Pt[] => {
      const p: Pt[] = [], x = x0, y = y0;
      const box = (bx: number, by: number, bw: number, bh: number, rd = false, skip?: (i: number, j: number) => boolean) => {
        for (let j = 0; j < bh; j++) for (let i = 0; i < bw; i++) { if (rd && (i == 0 || i == bw - 1) && (j == 0 || j == bh - 1)) continue; if (!(skip && skip(i, j))) p.push([bx + i, by + j]); }
      };
      switch (ex) {
        case "open": box(x, y, w, h, round); break;
        case "big": box(x - (w >= 2 ? 1 : 0), y - 1, w + (w >= 2 ? 1 : 0), h + 1, round); break;
        case "wide": box(x, y - 1, w, h + 1, round); break;
        case "focus": box(x, y + 1, w, Math.max(1, h - 1)); break;
        case "half": { const k = Math.ceil(h / 2); box(x, y + h - k, w, k); break; }
        case "blink": box(x, y + Math.ceil(h / 2), w, Math.max(1, Math.floor(h / 2) - (h >= 4 ? 1 : 0))); break;
        case "closed": box(w == 1 ? x - 1 : x, y + h - 1 - (h >= 4 ? 1 : 0), Math.max(w, 2), 1); break;
        case "happy": { const r = y + Math.floor(h / 2) - 1; box(x, r, w, 1); p.push([x - 1, r + 1], [x + w, r + 1]); if (h >= 5) p.push([x - 1, r + 2], [x + w, r + 2]); break; }
        case "sad": box(x, y + 1, w, Math.max(1, h - 1), false, (i, j) => (j == 0 && (i == w - 1 || (w >= 3 && i == w - 2))) || (h >= 4 && j == 1 && i == w - 1 && w >= 2)); break;
        case "x": { const n = h >= 5 ? 5 : 3, a = Math.floor(x + (w - n) / 2), b = Math.floor(y + (h - n) / 2); for (let i = 0; i < n; i++) p.push([a + i, b + i], [a + n - 1 - i, b + i]); break; }
        case "dizzy": { const ring: Pt[] = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]], g0 = ph % 8, cx = Math.floor(x + (w - 1) / 2), cy = Math.floor(y + (h - 1) / 2); ring.forEach(([i, j], n) => { if (n != g0 && n != (g0 + 1) % 8) p.push([cx + i, cy + j]); }); break; }
        case "heart": {
          // two separate hearts, each on its eye, at least two body pixels apart; too tight means no hearts
          const hx = Math.floor(x + (w - 1) / 2 - 2), hy = y + Math.floor((h - 4) / 2);
          if (sum - (hx + 4) - (hx + 4) < 3) return [];
          HEART.forEach((r, j) => { for (let i = 0; i < 5; i++) if (r[i] == "#") p.push([hx + i, hy + j]); });
          break;
        }
      }
      return p;
    };
    const pair = (a: Eye, b: Eye, dx: number, dy: number, ins = 0): Pt[] => {
      let L = shape(a).map(([x, y]): Pt => [x + ins, y]), Rt = shape(b).map(([x, y]): Pt => [sum - x - ins, y]);
      // the eye on the side being looked at narrows a little
      if (dx && w > 1) {
        if (dx < 0 && OPEN[a] && a != "half") { const mx = Math.max(...L.map((q) => q[0])); L = L.filter((q) => q[0] != mx); }
        if (dx > 0 && OPEN[b] && b != "half") { const mn = Math.min(...Rt.map((q) => q[0])); Rt = Rt.filter((q) => q[0] != mn); }
      }
      // hearts must stay two separate shapes with at least two body pixels between them
      if (a == "heart" && L.length && Rt.length && Math.min(...Rt.map((q) => q[0])) - Math.max(...L.map((q) => q[0])) < 3) return [];
      return L.concat(Rt).map(([x, y]): Pt => [x + dx, y + dy]);
    };
    // gaze first, then still, then a pixel nudge down, up or inward, before a simpler expression
    const fa = FALL[eL] || [eL], fb = FALL[eR] || [eR];
    const tries: Array<[number, number, number?]> = [[gx, gy], [Math.sign(gx), gy], [gx, 0], [Math.sign(gx), 0], [0, gy], [0, 0], [0, 1], [0, -1], [0, 0, 1], [0, 1, 1]];
    for (let k = 0; k < Math.max(fa.length, fb.length); k++) {
      const a = fa[Math.min(k, fa.length - 1)]!, b = fb[Math.min(k, fb.length - 1)]!;
      for (const [dx, dy, ins] of tries) {
        const pts = pair(a, b, dx, dy, ins);
        if (pts.length && pts.every(([x, y]) => inner(x, y))) { pts.forEach(([x, y]) => { buf[y * W + x] = EYE; }); this.shown = a == b ? a : a + " " + b; return; }
      }
    }
    // last resort, never seen with the shipped bodies: only the pixels that are safely inside
    this.shown = "partial";
    pair("open", "open", 0, 0).forEach(([x, y]) => { if (inner(x, y)) buf[y * W + x] = EYE; });
  }
}

/** One still frame of a body, for markup drawn before any script runs and for picker outlines. */
export function stillFrame(body: PixelBodyId | string, o: { size?: number; scale?: number; state?: PixelState } = {}) {
  const b = new PixelCore({ body, size: o.size, scale: o.scale ?? (o.size ? undefined : 1), state: o.state, calm: true, life: false });
  return { W: b.W, H: b.H, G: b.G, s: b.s, px: b.px, pt: b.pt, paint: b.paint };
}

/** A still frame as svg rects (one path per colour), positioned so the G by G body box is the viewBox. */
export function stillSvgPaths(body: PixelBodyId | string, o: { size?: number; scale?: number; state?: PixelState } = {}) {
  const f = stillFrame(body, o);
  const runs = (v: number) => {
    let d = "";
    for (let y = 0; y < f.H; y++) for (let x = 0; x < f.W; x++) {
      if (f.paint[y * f.W + x] !== v) continue;
      let e = x;
      while (e + 1 < f.W && f.paint[y * f.W + e + 1] === v) e++;
      d += `M${x - f.px} ${y - f.pt}h${e - x + 1}v1h${-(e - x + 1)}z`;
      x = e;
    }
    return d;
  };
  // the eyes sit on the body, so the body path fills under them too
  const body1 = (() => { const save = f.paint.slice(); for (let i = 0; i < f.paint.length; i++) if (f.paint[i] === EYE) f.paint[i] = BODY; const d = runs(BODY); f.paint.set(save); return d; })();
  return { G: f.G, body: body1, eyes: runs(EYE) };
}
