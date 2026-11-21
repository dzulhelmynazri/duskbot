import { describe, expect, it } from "vitest";

import { PIXEL_BODIES } from "./pixel-bodies.ts";
import { BODY_MIGRATION, DEFAULT_BOT_BODY, MADANI_BODY_IDS, MADANI_BODY_NAMES, LEGACY_BODY_IDS, madaniBody, migrateBodyId } from "./body-migration.ts";

// every body id the app stored or shipped before our own bodies, as its settings schema listed them, and the names the
// website used for bodies it has since renamed
const SAVED_BEFORE = [
  "cursor", "blob", "circle", "squircle", "capsule", "drop", "shield", "hexagon", "diamond", "star", "tablet", "cloud",
  "flower", "sparkle", "wedge", "heart", "fruit", "clover", "square", "teardrop", "pebble", "bean", "egg", "cylinder",
  "hex", "gem", "crystal", "dome", "arch", "leaf", "house",
];
// the smooth bodies, and the website's renames of them, each onto the pixel body that took its place
const SITE_NAMES = { clover: "puff", capsule: "mochi", gem: "boxo", blob: "pip", teardrop: "drip", square: "loaf", crescent: "wisp" };
const SMOOTH = { circle: "pip", squircle: "loaf", pill: "mochi", hex: "boxo", star: "starry", heart: "hearty", drop: "drip", moon: "wisp", cloud: "puff", pixel: "tofu" };

describe("body migration", () => {
  it("names exactly the bodies the engine draws", () => {
    expect([...MADANI_BODY_IDS].sort()).toEqual(Object.keys(PIXEL_BODIES).sort());
    expect(MADANI_BODY_IDS).toHaveLength(20);
    expect(Object.keys(MADANI_BODY_NAMES).sort()).toEqual([...MADANI_BODY_IDS].sort());
  });

  it("draws every id saved before as one of our bodies", () => {
    for (const id of SAVED_BEFORE) expect(MADANI_BODY_IDS, id).toContain(migrateBodyId(id));
  });

  it("moves the smooth bodies and the website's renames onto their pixel bodies", () => {
    for (const [from, to] of Object.entries({ ...SMOOTH, ...SITE_NAMES })) expect(migrateBodyId(from), from).toBe(to);
  });

  it("keeps our own ids as they are", () => {
    for (const id of MADANI_BODY_IDS) expect(migrateBodyId(id)).toBe(id);
  });

  it("maps only to our bodies and never shadows one", () => {
    for (const to of Object.values(BODY_MIGRATION)) expect(MADANI_BODY_IDS).toContain(to);
    for (const id of LEGACY_BODY_IDS) expect(MADANI_BODY_IDS as readonly string[]).not.toContain(id);
  });

  it("falls back to the default for unknown, missing and inherited names", () => {
    for (const value of ["hexagram", "", "constructor", "__proto__", "toString", undefined, null, 42, {}]) {
      expect(migrateBodyId(value)).toBeNull();
      expect(madaniBody(value)).toBe(DEFAULT_BOT_BODY);
    }
    expect(MADANI_BODY_IDS).toContain(DEFAULT_BOT_BODY);
  });
});
