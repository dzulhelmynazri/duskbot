import { describe, expect, it } from "vitest";
import { appReturnLink } from "./app-return";

describe("the desktop app's sign-in landing", () => {
  it("hands back only a well-formed one-time link, rebuilt as the app's own address", () => {
    const code = "c".repeat(43), state = "s".repeat(43);
    expect(appReturnLink(`#code=${code}&state=${state}`)).toBe(`madanibot://auth?code=${code}&state=${state}`);
    for (const hash of ["", "#", `#code=${code}`, `#state=${state}`, `#code=short&state=${state}`, `#code=${code}&state=${state}&next=x`, `#code=${code}%20x&state=${state}`])
      expect([hash, appReturnLink(hash)]).toEqual([hash, null]);
  });
});
