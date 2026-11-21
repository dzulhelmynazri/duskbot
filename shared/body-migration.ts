/** The bodies a bot can wear, and the one each body id saved by an older version now draws as. */

import { PIXEL_BODY_IDS, type PixelBodyId } from "./pixel-bodies.ts";

export const MADANI_BODY_IDS = PIXEL_BODY_IDS;

export type MadaniBodyId = PixelBodyId;

/** What a body is called in a picker and its accessible name. */
export const MADANI_BODY_NAMES: Record<MadaniBodyId, string> = {
  kit: "Kit", pip: "Pip", hop: "Hop", bruin: "Bruin", boo: "Boo", mochi: "Mochi", loaf: "Loaf", cheep: "Cheep",
  ribbit: "Ribbit", goo: "Goo", puff: "Puff", sprout: "Sprout", drip: "Drip", hearty: "Hearty", starry: "Starry",
  hoot: "Hoot", boxo: "Boxo", egg: "Egg", wisp: "Wisp", tofu: "Tofu",
};

/** The body a new bot wears, and what an unknown or missing id draws as. */
export const DEFAULT_BOT_BODY: MadaniBodyId = "kit";

/**
 * Every body id an older version saved, in stored bots, synced bots, backups, team files and server data, and the body
 * it draws as now. Never remove an entry: a bot saved with it would lose its look.
 */
export const BODY_MIGRATION = {
  circle: "pip",
  squircle: "loaf",
  pill: "mochi",
  hex: "boxo",
  star: "starry",
  heart: "hearty",
  drop: "drip",
  moon: "wisp",
  cloud: "puff",
  pixel: "tofu",
  cursor: "kit",
  blob: "pip",
  capsule: "mochi",
  shield: "boxo",
  hexagon: "boxo",
  diamond: "starry",
  tablet: "tofu",
  flower: "sprout",
  sparkle: "starry",
  wedge: "wisp",
  fruit: "cheep",
  clover: "puff",
  square: "loaf",
  teardrop: "drip",
  pebble: "egg",
  bean: "mochi",
  cylinder: "tofu",
  gem: "boxo",
  crystal: "starry",
  dome: "bruin",
  arch: "boo",
  leaf: "sprout",
  house: "boxo",
  crescent: "wisp",
} as const satisfies Record<string, MadaniBodyId>;

export type LegacyBodyId = keyof typeof BODY_MIGRATION;

export const LEGACY_BODY_IDS = Object.keys(BODY_MIGRATION) as LegacyBodyId[];

export function isMadaniBody(value: unknown): value is MadaniBodyId {
  return (MADANI_BODY_IDS as readonly unknown[]).includes(value);
}

/** The Halloween costumes a bot can still be saved in. Each draws as its nearest pixel body. */
export const HALLOWEEN_BODY_IDS = ["pumpkin", "ghost", "witch", "bat", "cat", "skull", "monster", "mummy", "vampire", "spider"] as const;

export type HalloweenBodyId = (typeof HALLOWEEN_BODY_IDS)[number];

export const COSTUME_BODY: Record<HalloweenBodyId, MadaniBodyId> = {
  pumpkin: "pip", ghost: "boo", witch: "drip", bat: "wisp", cat: "kit", skull: "egg", monster: "ribbit", mummy: "tofu", vampire: "hoot", spider: "bruin",
};

/** One of our bodies for an id we draw or used to draw, else null. */
export function migrateBodyId(value: unknown): MadaniBodyId | null {
  if (isMadaniBody(value)) return value;
  return typeof value === "string" && Object.hasOwn(BODY_MIGRATION, value) ? BODY_MIGRATION[value as LegacyBodyId] : null;
}

/** The body a stored id draws as; unknown and missing ids wear the default. */
export function madaniBody(value: unknown): MadaniBodyId {
  if (typeof value === "string" && Object.hasOwn(COSTUME_BODY, value)) return COSTUME_BODY[value as HalloweenBodyId];
  return migrateBodyId(value) ?? DEFAULT_BOT_BODY;
}
