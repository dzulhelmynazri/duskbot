/**
 * A person's avatar, as the account keeps it (`avatar` on the account service): absent for the default (the photo of their
 * google or x sign-in, else the drawing seeded from their account id), `photo` for that photo, `drawn` for the drawing from
 * their account id even with a photo, or `g:<seed>` for a drawn one they picked. The drawing is deterministic: the same seed
 * draws the same picture on every device.
 */
export type UserAvatarChoice = "photo" | "drawn" | `g:${string}`;

const CHOICE = /^(?:photo|drawn|g:[a-z0-9]{1,16})$/;

export function parseUserAvatarChoice(value: unknown): UserAvatarChoice | null {
  return typeof value === "string" && CHOICE.test(value) ? value as UserAvatarChoice : null;
}

/** What to draw for an account: its photo, or a drawing from a seed. */
export type UserAvatarFace = { kind: "photo"; url: string } | { kind: "drawn"; seed: string };

/** A drawing they picked; the drawing from their account id when they chose it; else the photo of their sign-in when they
 * have one, and the drawing from their account id when they don't. */
export function userAvatarFace(account: { id: string; avatarUrl?: string; avatar?: string }): UserAvatarFace {
  const choice = parseUserAvatarChoice(account.avatar);
  if (choice?.startsWith("g:")) return { kind: "drawn", seed: choice.slice(2) };
  if (choice !== "drawn" && account.avatarUrl) return { kind: "photo", url: account.avatarUrl };
  return { kind: "drawn", seed: account.id };
}

/** The same choice in its shortest form for this account: the default (null) wherever it shows the same face. */
export function plainAvatarChoice(choice: UserAvatarChoice | null, hasPhoto: boolean): UserAvatarChoice | null {
  if (choice === "photo") return null;
  if (choice === "drawn" && !hasPhoto) return null;
  return choice;
}

/** A fresh seed for Shuffle and the suggestions: 8 base-36 characters. */
export function newAvatarSeed(random: () => number = Math.random): string {
  let seed = "";
  for (let i = 0; i < 8; i++) seed += Math.floor(random() * 36).toString(36);
  return seed;
}

function hash(text: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}

/** A small seeded generator (mulberry32). */
export function seededRandom(seed: string): () => number {
  let a = hash(seed) || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface AvatarPixels {
  /** cells per side */
  size: number;
  /** one colour per cell, row by row */
  cells: string[];
  /** the background, also the margin round the art when a size is not a whole multiple of the grid */
  tile: string;
}

// ---- the heads: one bold geometric head on a tile, flat colour, no outline, attitude in the eyes, brows and mouth ----

type Lab = [number, number, number];
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
function oklab(hex: string): Lab {
  const [r, g, b] = [1, 3, 5].map((i) => toLinear(parseInt(hex.slice(i, i + 2), 16) / 255)) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
/** an OKLCH colour as hex, chroma eased down until it fits sRGB, hue held */
function oklch(L: number, C: number, h: number): string {
  for (let c = C; c >= 0; c -= 0.004) {
    const A = c * Math.cos(h), B = c * Math.sin(h);
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3, m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3, s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
    const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
    if (rgb.every((v) => v >= -0.0005 && v <= 1.0005)) return `#${rgb.map((v) => Math.round(Math.min(1, Math.max(0, toGamma(v))) * 255).toString(16).padStart(2, "0")).join("")}`;
  }
  return "#808080";
}
const hueOf = (hex: string) => { const [, a, b] = oklab(hex); return Math.atan2(b, a); };
/** OKLab lightness, 0 to 1 */
export const avatarLightness = (hex: string) => oklab(hex)[0];
/** OKLab distance between two colours */
export const avatarDistance = (x: string, y: string) => { const p = oklab(x), q = oklab(y); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };

const INK = "#1f1a2b", WHITE = "#fbf7f0", GOLD = "#f2c14e", RED = "#ef6f6c";
export interface AvatarSkin { name: string; family: string; fill: string; side: string; ink: string }
const skin = (name: string, family: string, fill: string, ink = INK): AvatarSkin => ({ name, family, fill, side: oklch(avatarLightness(fill) - 0.07, 0.11, hueOf(fill)), ink });
/** brand pastels first (common), then the rares */
export const AVATAR_SKINS: readonly (readonly [AvatarSkin, number])[] = [
  [skin("lilac", "lilac", "#b99af2"), 10], [skin("peach", "peach", "#f6b183"), 10], [skin("lime", "lime", "#a6dd6c"), 10],
  [skin("sky", "sky", "#7cc6f2"), 10], [skin("rose", "rose", "#f4a0c4"), 10], [skin("lemon", "lemon", "#f6dc62"), 6],
  [skin("mint", "mint", "#86dcc0"), 2], [skin("chalk", "chalk", "#ece7f4"), 2], [skin("ink", "night", "#3a3760", WHITE), 1.5],
  [skin("ember", "rose", "#ef7f6a"), 1.5], [skin("gold", "lemon", "#e9b949"), 1],
];
export interface AvatarTile { name: string; family: string; color: string }
const lightTile = (name: string, from: string): AvatarTile => ({ name, family: name, color: oklch(0.94, 0.035, hueOf(from)) });
const deepTile = (name: string, family: string, from: string): AvatarTile => ({ name, family: `deep-${family}`, color: oklch(0.36, 0.08, hueOf(from)) });
export const AVATAR_TILES: readonly AvatarTile[] = [
  lightTile("lilac", "#b99af2"), lightTile("sky", "#7cc6f2"), lightTile("lime", "#a6dd6c"), lightTile("peach", "#f6b183"), lightTile("rose", "#f4a0c4"), lightTile("lemon", "#f6dc62"),
  deepTile("madani", "lilac", "#b99af2"), deepTile("sea", "sky", "#7cc6f2"), deepTile("moss", "lime", "#a6dd6c"), deepTile("plum", "rose", "#f4a0c4"),
];
/** A head reads on its tile: never its own hue family, clearly apart from it, and its face clearly apart from its skin. */
export function avatarReadable(head: AvatarSkin, tile: AvatarTile): boolean {
  return head.family !== tile.family && `deep-${head.family}` !== tile.family && avatarDistance(head.fill, tile.color) >= 0.14
    && Math.abs(avatarLightness(head.ink) - avatarLightness(head.fill)) >= 0.4;
}

function picker(random: () => number) {
  return {
    pick<T>(items: readonly T[]): T { return items[Math.floor(random() * items.length)]!; },
    weighted<T>(items: readonly (readonly [T, number])[]): T {
      let roll = random() * items.reduce((sum, [, w]) => sum + w, 0);
      for (const [item, w] of items) { roll -= w; if (roll < 0) return item; }
      return items[items.length - 1]![0];
    },
  };
}

const N = 16;
type Cells = (string | null)[][];
const HEADS: Record<string, { top: number; widths: number[]; shift?: number[] }> = {
  round: { top: 3, widths: [3, 5, 6, 6, 6, 6, 6, 6, 6, 6, 5, 4, 3] },
  tall: { top: 1, widths: [4, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5] },
  wide: { top: 5, widths: [6, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7] },
  pointy: { top: 1, widths: [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 6, 6, 6] },
  angular: { top: 3, widths: [3, 4, 5, 6, 6, 6, 6, 6, 6, 6, 5, 4, 3] },
  block: { top: 3, widths: [6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6] },
  lean: { top: 2, widths: [4, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5], shift: [2, 2, 2, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0] },
};
const MOODS = [["chill", 4], ["smirk", 4], ["side-eye", 4], ["determined", 3], ["sleepy", 3], ["mischief", 3], ["shades", 3], ["unimpressed", 3], ["wink", 2], ["shout", 1.5], ["monocle", 1]] as const;
const GEAR = [["none", 6], ["headphones", 2], ["cap", 2], ["visor", 1.5], ["bandana", 2], ["antenna", 1.5], ["earring", 2], ["beanie", 1.5], ["crown", 0.4], ["halo", 0.4]] as const;

export interface AvatarTraits { shape: string; skin: string; mood: string; gear: string; tile: string; mirrored: boolean }
export interface UserAvatarDrawing extends AvatarPixels { traits: AvatarTraits; head: AvatarSkin; tileOf: AvatarTile }

/** The person's head for a seed: the same seed draws the same head everywhere. */
export function drawUserAvatar(seed: string): UserAvatarDrawing {
  const random = seededRandom(`heads:${seed}`), r = picker(random);
  const shape = r.pick(Object.keys(HEADS)), { top, widths, shift } = HEADS[shape]!;
  const head = r.weighted(AVATAR_SKINS), mood = r.weighted(MOODS);
  let gear: string = r.weighted(GEAR);
  if (shape === "pointy" && ["cap", "beanie", "headphones", "crown"].includes(gear)) gear = "earring";
  const readable = AVATAR_TILES.filter((tile) => avatarReadable(head, tile));
  const tile = readable.length ? r.pick(readable) : AVATAR_TILES[6]!;
  const g: Cells = Array.from({ length: N }, () => Array<string | null>(N).fill(null));
  const set = (x: number, y: number, c: string) => { if (x >= 0 && y >= 0 && x < N && y < N) g[y]![x] = c; };
  const paint = (x: number, y: number, c: string) => { if (x >= 0 && y >= 0 && x < N && y < N && g[y]![x] !== null) g[y]![x] = c; };

  widths.forEach((hw, i) => { const s = shift?.[i] ?? 0; for (let x = 8 - hw + s; x < 8 + hw + s; x++) set(x, top + i, head.fill); });
  // one flat side plane for weight, no outline
  for (let y = top + 2; y < N; y++) { const row = g[y]!; const last = row.map((c, x) => (c ? x : -1)).reduce((a, b) => Math.max(a, b), -1); if (last >= 0) row[last] = head.side; }

  const ey = Math.max(top + 3, 7), mid = 8 + (shift?.[ey - top] ?? 0);
  const f = shape === "pointy" ? { lx: mid - 3, rx: mid + 1, ey: 8, my: 12, cx: mid } : { lx: mid - 4, rx: mid + 2, ey, my: ey + 4, cx: mid };
  const ink = head.ink;
  const eye = (x: number, kind: "dot" | "tall" | "line" | "lid" | "white") => {
    if (kind === "dot") { paint(x, f.ey, ink); paint(x + 1, f.ey, ink); }
    if (kind === "tall") for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) paint(x + dx, f.ey + dy, ink);
    if (kind === "line") { paint(x, f.ey + 1, ink); paint(x + 1, f.ey + 1, ink); }
    if (kind === "lid") { paint(x, f.ey, ink); paint(x + 1, f.ey, ink); paint(x, f.ey + 1, WHITE); paint(x + 1, f.ey + 1, ink); }
    if (kind === "white") for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) paint(x + dx, f.ey + dy, WHITE);
  };
  const brow = (x: number, slope: number) => { paint(x, f.ey - 2 + (slope > 0 ? 1 : 0), ink); paint(x + 1, f.ey - 2 + (slope < 0 ? 1 : 0), ink); };
  const mouth = (kind: string) => {
    const y = f.my, c = f.cx;
    if (kind === "flat") { paint(c - 1, y, ink); paint(c, y, ink); }
    if (kind === "smirk") { paint(c - 1, y, ink); paint(c, y, ink); paint(c + 1, y - 1, ink); }
    if (kind === "grin") { for (let x = c - 2; x < c + 2; x++) paint(x, y, WHITE); paint(c - 3, y - 1, ink); paint(c + 2, y - 1, ink); }
    if (kind === "o") for (const [dx, dy] of [[-1, 0], [0, 0], [-1, 1], [0, 1]] as const) paint(c + dx, y + dy, ink);
    if (kind === "tongue") { paint(c - 1, y, ink); paint(c, y, ink); paint(c + 1, y, ink); paint(c, y + 1, RED); }
  };
  const side = random() < 0.5 ? 0 : 1;
  switch (mood) {
    case "chill": eye(f.lx, "dot"); eye(f.rx, "dot"); mouth(r.pick(["flat", "smirk"])); break;
    case "smirk": eye(f.lx, "tall"); eye(f.rx, "tall"); mouth("smirk"); break;
    case "side-eye": for (const x of [f.lx, f.rx]) { eye(x, "white"); paint(x + side, f.ey, ink); paint(x + side, f.ey + 1, ink); } mouth(r.pick(["flat", "smirk"])); break;
    case "determined": eye(f.lx, "tall"); eye(f.rx, "tall"); brow(f.lx, 1); brow(f.rx, -1); mouth("flat"); break;
    case "sleepy": eye(f.lx, "line"); eye(f.rx, "line"); mouth(r.pick(["o", "flat"])); break;
    case "mischief": eye(f.lx, "lid"); eye(f.rx, "lid"); brow(f.rx, -1); mouth("grin"); break;
    case "shades":
      for (let x = f.lx - 1; x <= f.rx + 2; x++) paint(x, f.ey, INK);
      for (const x of [f.lx, f.lx + 1, f.rx, f.rx + 1]) paint(x, f.ey + 1, INK);
      paint(f.lx, f.ey, WHITE); mouth(r.pick(["smirk", "flat", "grin"])); break;
    case "unimpressed": eye(f.lx, "lid"); eye(f.rx, "lid"); mouth("flat"); break;
    case "wink": eye(f.lx, "tall"); eye(f.rx, "line"); mouth(r.pick(["tongue", "smirk"])); break;
    case "shout": eye(f.lx, "tall"); eye(f.rx, "tall"); brow(f.lx, 1); brow(f.rx, -1); mouth("o"); break;
    case "monocle":
      eye(f.lx, "dot"); eye(f.rx, "white"); paint(f.rx, f.ey + 1, ink);
      for (const [dx, dy] of [[-1, 0], [-1, 1], [2, 0], [2, 1], [0, -1], [1, -1], [0, 2], [1, 2]] as const) paint(f.rx + dx, f.ey + dy, GOLD);
      paint(f.rx + 2, f.ey + 3, GOLD); paint(f.rx + 2, f.ey + 4, GOLD); mouth("flat"); break;
  }

  const span = (g[top + 1] ?? []).map((c, x) => (c ? x : -1)).filter((x) => x >= 0);
  const left = span[0] ?? 4, right = span[span.length - 1] ?? 11, w = right - left + 1, earY = ey + 1;
  const tone = r.pick(AVATAR_SKINS.slice(0, 6).map(([s]) => s.fill)), dark = oklch(avatarLightness(tone) - 0.22, 0.12, hueOf(tone));
  if (gear === "headphones") {
    for (let x = left; x <= right; x++) set(x, top - 1, INK);
    set(left - 1, top, INK); set(right + 1, top, INK);
    for (let y = top + 1; y < earY - 1; y++) { set(left - 1, y, INK); set(right + 1, y, INK); }
    for (let y = earY - 1; y <= earY + 1; y++) for (const x of [left - 2, left - 1, right + 1, right + 2]) set(x, y, tone);
  } else if (gear === "cap") {
    for (let y = top - 1; y <= top + 1; y++) for (let x = left; x <= right; x++) set(x, y, y === top + 1 ? dark : tone);
    if (random() < 0.6) { set(right + 1, top, dark); set(right + 2, top, dark); set(right + 2, top + 1, dark); }
    else for (let x = left - 3; x < left + 2; x++) set(x, top + 1, dark);
  } else if (gear === "visor") {
    for (let x = left; x <= right; x++) set(x, top + 2, tone);
    for (let x = left - 2; x < left + 3; x++) set(x, top + 3, dark);
  } else if (gear === "bandana") {
    for (let x = left; x <= right; x++) { set(x, top + 1, RED); set(x, top + 2, x % 2 ? RED : WHITE); }
    set(right + 1, top + 2, RED); set(right + 1, top + 3, RED); set(right + 2, top + 3, RED);
  } else if (gear === "antenna") {
    const x = left + Math.floor(w / 2);
    set(x, top - 1, INK); set(x, top - 2, INK);
    for (const [dx, dy] of [[0, -3], [1, -3], [0, -4], [1, -4]] as const) set(x + dx, top + dy, tone);
  } else if (gear === "earring") { set(right + 1, earY + 1, GOLD); set(right + 1, earY + 2, GOLD); }
  else if (gear === "beanie") { for (let y = top - 2; y <= top + 1; y++) for (let x = left; x <= right; x++) set(x, y, y === top + 1 ? dark : tone); set(left + Math.floor(w / 2), top - 3, WHITE); }
  else if (gear === "crown") { const x0 = left + Math.floor(w / 2) - 2; for (let x = x0; x < x0 + 5; x++) { set(x, top - 1, GOLD); set(x, top - 2, GOLD); if ((x - x0) % 2 === 0) set(x, top - 3, GOLD); } }
  else if (gear === "halo") for (let x = left + 1; x < right; x++) set(x, top - 2, GOLD);

  const mirrored = random() < 0.35;
  const rows = mirrored ? g.map((row) => [...row].reverse()) : g;
  return { size: N, cells: rows.flatMap((row) => row.map((c) => c ?? tile.color)), tile: tile.color, head, tileOf: tile,
    traits: { shape, skin: head.name, mood, gear, tile: tile.name, mirrored } };
}
