import { describe, expect, it } from "vitest";

import { KIT_BODY, KIT_EYES } from "../../electron/startup-mascot.mjs";
import { MADANI_BODY_IDS } from "../../shared/body-migration";
import { PIXEL_STATES, PixelCore, stillFrame, stillSvgPaths } from "./core";

describe("pixel still frames", () => {
  it("draws the splash's kit exactly as the engine does at rest", () => {
    const kit = stillSvgPaths("kit", { scale: 1 });
    expect(kit.body).toBe(KIT_BODY);
    expect(kit.eyes).toBe(KIT_EYES);
  });

  it("draws every body on its own grid at every size, so a 20 px row and a 112 px profile show the same sprite", () => {
    for (const body of MADANI_BODY_IDS) {
      const native = stillFrame(body, { scale: 1 });
      for (const size of [14, 16, 20, 24, 28, 30, 32, 36, 44, 56, 64, 96, 112]) {
        const frame = stillFrame(body, { size });
        expect(frame.G, `${body} at ${size}`).toBe(native.G);
        expect(frame.s, `${body} at ${size}`).toBeCloseTo(size / native.G);
        expect(Array.from(frame.paint), `${body} at ${size}`).toEqual(Array.from(native.paint));
      }
    }
  });

  it("puts two eyes inside every body at every size the app draws", () => {
    for (const body of MADANI_BODY_IDS) for (const size of [16, 20, 24, 28, 32, 36, 44, 64, 96, 112]) {
      const { paint } = stillFrame(body, { size });
      expect(paint.includes(2), `${body} at ${size}`).toBe(true);
    }
  });

  it("finds a fitting face for every state on every body", () => {
    for (const body of MADANI_BODY_IDS) for (const state of PIXEL_STATES) {
      const bot = new PixelCore({ body, size: 24, state, calm: true, life: false });
      expect(bot.shown, `${body} ${state}`).not.toBe("partial");
    }
  });
});
