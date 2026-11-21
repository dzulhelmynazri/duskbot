import { describe, expect, it } from "vitest";
import { MIN_MOBILE_APP_LEVEL, MOBILE_APP_LEVEL, phoneTooOld } from "../../../shared/server-api";
import { storeUrl } from "./phone-update";

describe("phone and server versions", () => {
  it("this build is never too old for this build's own server", () => {
    expect(MIN_MOBILE_APP_LEVEL).toBeLessThanOrEqual(MOBILE_APP_LEVEL);
    expect(phoneTooOld({ capabilities: { minMobile: MIN_MOBILE_APP_LEVEL } })).toBe(false);
  });

  it("is too old only when the server says a higher level, never when it says nothing usable", () => {
    expect(phoneTooOld({ capabilities: { minMobile: MOBILE_APP_LEVEL + 1 } })).toBe(true);
    for (const said of [null, {}, { capabilities: {} }, { capabilities: { minMobile: "9" } }, { capabilities: { minMobile: 1.5 } }]) expect(phoneTooOld(said)).toBe(false);
  });

  it("sends each phone to its own store, and to the download page until the iPhone app has a store id", () => {
    expect(storeUrl("android")).toBe("https://madani.bot/download#android");
    expect(storeUrl("ios", "1234567890")).toBe("https://apps.apple.com/app/id1234567890");
    expect(storeUrl("ios", null)).toBe("https://madani.bot/download");
    expect(storeUrl("ios"), "the listed iPhone app").toBe("https://apps.apple.com/app/id6834725640");
    expect(storeUrl("web")).toBe("https://madani.bot/download");
  });
});
