import { describe, expect, it } from "vitest";

import { companionFolder, companionLaunchPorts, companionPorts, DESKTOP_PORTS } from "./desktop-ports.mjs";

const dev = { packaged: false };

describe("the phone companion's ports", () => {
  it("are 8810 and 8811 for the packaged app on any of its ports, so Wi-Fi pairings keep their address", () => {
    for (const port of DESKTOP_PORTS) expect(companionPorts(port)).toEqual({ companion: 8810, control: 8811 });
  });

  it("step the packaged app's control port past a harness on 8811 and its webhook on 8812", () => {
    expect(companionPorts(8811)).toEqual({ companion: 8810, control: 8813 });
  });

  it("never clash between the packaged app and a dev app on the same computer", () => {
    const held = (harness, options) => [harness, harness + 1, ...Object.values(companionPorts(harness, options))];
    for (const packagedHarness of DESKTOP_PORTS) {
      for (const devHarness of [8799, 8811, 8810, 8800, 5211, ...DESKTOP_PORTS]) {
        if (Math.abs(packagedHarness - devHarness) < 2) continue;
        const app = held(packagedHarness), mine = held(devHarness, dev);
        expect(new Set(mine).size).toBe(4);
        expect(mine.slice(2)).not.toContain(8812);
        expect(app.filter((port) => mine.slice(2).includes(port))).toEqual([]);
      }
    }
    expect(companionPorts(8811, dev)).toEqual({ companion: 8822, control: 8823 });
    expect(companionPorts(8799, dev)).toEqual({ companion: 8813, control: 8814 });
  });
});

describe("the ports a companion launches on", () => {
  it("move the control port past one a dev app's harness holds, never onto the webhook or the hosted origin", async () => {
    const held = new Set([8811, 8813]);
    const taken = async (port) => held.has(port);
    expect(await companionLaunchPorts(8799, { taken })).toEqual({ companion: 8810, control: 8814 });
    expect(await companionLaunchPorts(8799, { taken: async () => false })).toEqual({ companion: 8810, control: 8811 });
  });
});

describe("the phone companion's folder", () => {
  it("is the usual one for the packaged app and its own per port for a dev app", () => {
    expect(companionFolder({ home: "/Users/me", harnessPort: 18799, packaged: true })).toBe("/Users/me/.madanibot-companion");
    expect(companionFolder({ home: "/Users/me", harnessPort: 8811, packaged: false })).toBe("/Users/me/.madanibot-companion/dev-8811");
  });
});
