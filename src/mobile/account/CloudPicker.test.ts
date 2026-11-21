import { describe, expect, it } from "vitest";
import { autoPickCloud, linkedHere } from "./CloudPicker";
import type { MobileCloud } from "./account-client";

const cloud = (id: string, origin: string, status = "ready"): MobileCloud => ({ id, name: id, status, origin, primary: false, asleep: false });
const mine = cloud("mine", "https://mine.madani.bot");

describe("the clouds step", () => {
  it("opens the only cloud on its own for a phone that links nothing yet", () => {
    expect(autoPickCloud([mine], [])).toBe(mine);
  });

  it("never re-links the cloud this phone already has (adding a second server)", () => {
    const records = [{ origin: "https://mine.madani.bot" }];
    expect(linkedHere(mine, records)).toBe(true);
    expect(autoPickCloud([mine], records)).toBeNull();
  });

  it("asks rather than picks once anything is linked, even a different place", () => {
    expect(autoPickCloud([mine], [{ origin: "https://vps.example.org" }])).toBeNull();
  });

  it("knows a cloud linked through one of its routes", () => {
    expect(linkedHere(mine, [{ origin: "http://10.0.0.2:8810", via: [{ kind: "https", url: "https://mine.madani.bot" }] } as never])).toBe(true);
  });
});
