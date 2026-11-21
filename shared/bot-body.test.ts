import { describe, expect, it } from "vitest";

import { BOT_BODY_IDS, COSTUME_FOR_COLOR, DEFAULT_BOT_BODY, bodyShapeFor, botBodyId, botBodySchema, isHalloweenBody, wearsBody } from "./bot-body.ts";
import { COSTUME_BODY, MADANI_BODY_IDS, HALLOWEEN_BODY_IDS, LEGACY_BODY_IDS, madaniBody } from "./body-migration.ts";
import { MAUS_COLOR_NAMES } from "./wire.ts";

describe("bot bodies", () => {
  it("offers our bodies and the Halloween ones", () => {
    expect(BOT_BODY_IDS).toEqual([...MADANI_BODY_IDS, ...HALLOWEEN_BODY_IDS]);
    expect(new Set(BOT_BODY_IDS).size).toBe(BOT_BODY_IDS.length);
    for (const id of BOT_BODY_IDS) expect(botBodySchema.parse(id)).toBe(id);
  });

  it("accepts every id an older version saved and saves the body it draws as now", () => {
    for (const id of LEGACY_BODY_IDS) expect(MADANI_BODY_IDS).toContain(botBodySchema.parse(id));
    expect(botBodySchema.parse("cursor")).toBe("kit");
    expect(botBodySchema.parse("clover")).toBe("puff");
    expect(botBodySchema.safeParse("hexagram").success).toBe(false);
  });

  it("reads an older id as its body now, and anything unknown as the default", () => {
    expect(botBodyId("pumpkin")).toBe("pumpkin");
    expect(botBodyId("starry")).toBe("starry");
    expect(botBodyId("star")).toBe("starry");
    expect(botBodyId("teardrop")).toBe("drip");
    expect(botBodyId("hexagram")).toBe(DEFAULT_BOT_BODY);
    expect(botBodyId("constructor")).toBe(DEFAULT_BOT_BODY);
    expect(botBodyId(undefined)).toBe(DEFAULT_BOT_BODY);
    expect(bodyShapeFor("gem")).toBe("boxo");
  });

  it("marks a picker option worn when the stored body draws as it", () => {
    expect(wearsBody("cursor", "kit")).toBe(true);
    expect(wearsBody("cursor", "pip")).toBe(false);
    expect(wearsBody(undefined, DEFAULT_BOT_BODY)).toBe(true);
    expect(wearsBody("pumpkin", "pumpkin")).toBe(true);
    expect(wearsBody("pumpkin", "kit")).toBe(false);
    expect(wearsBody("pumpkin", "pip")).toBe(true);
    expect(wearsBody("cursor", "pumpkin")).toBe(false);
  });

  it("draws every costume as a pixel body", () => {
    for (const id of HALLOWEEN_BODY_IDS) {
      expect(MADANI_BODY_IDS).toContain(madaniBody(id));
      expect(bodyShapeFor(id)).toBe(COSTUME_BODY[id]);
    }
    expect(bodyShapeFor("witch")).toBe("drip");
  });

  it("tells the Halloween bodies apart", () => {
    expect(isHalloweenBody("ghost")).toBe(true);
    expect(isHalloweenBody("cursor")).toBe(false);
    expect(isHalloweenBody(null)).toBe(false);
  });

  it("gives every bot colour but silver, chrome and brown its own costume", () => {
    const dressed = MAUS_COLOR_NAMES.filter((color) => color !== "silver" && color !== "chrome" && color !== "brown");
    expect(Object.keys(COSTUME_FOR_COLOR).sort()).toEqual([...dressed].sort());
    expect(new Set(Object.values(COSTUME_FOR_COLOR)).size).toBe(dressed.length);
    for (const body of Object.values(COSTUME_FOR_COLOR)) expect(isHalloweenBody(body)).toBe(true);
  });
});
