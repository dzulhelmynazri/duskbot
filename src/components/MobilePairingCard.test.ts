import { readFileSync } from "node:fs";
import en from "../locales/en.json";
import { describe, expect, it } from "vitest";

import type { MobileDevice } from "../../shared/mobile-link";
import { desktopAccountBridge, newDeviceSince, noRouteFix, platformLabelKey } from "./MobilePairingCard";

const device = (id: string, name = id): MobileDevice => ({
  id, name, platform: "ios", createdAt: 0, lastSeenAt: 0, expiresAt: 1, relay: false, push: null,
});

describe("mobile workspace pairing", () => {
  it("pairs a phone with a server of your own shown in the desktop window by that server's own code, never this computer's account", async () => {
    const cloudPlan = { phoneSignIn: async () => null, signIn: async () => null, signedIn: async () => true };
    const page = globalThis as { window?: unknown };
    try {
      page.window = { madaniDesktop: { app: { ownPage: false }, cloudPlan } };
      expect(desktopAccountBridge(false, false)).toBeNull();
      expect(await noRouteFix(false)).toBe("server");
      page.window = { madaniDesktop: { app: { ownPage: true }, cloudPlan } };
      expect(desktopAccountBridge(false, false)).not.toBeNull();
    } finally { delete page.window; }
  });

  it("labels the native platforms and falls back to Phone", () => {
    expect(platformLabelKey("ios")).toBe("settings.mobile.ios");
    expect(platformLabelKey("android")).toBe("settings.mobile.android");
    expect(platformLabelKey("other")).toBe("settings.mobile.phone");
    expect(platformLabelKey("unknown")).toBe("settings.mobile.phone");
  });

  it("finds the first phone paired with an empty workspace", () => {
    const phone = device("new", "My phone");
    expect(newDeviceSince([], [phone])).toBe(phone);
  });

  it("detects a new id even when its name matches an existing phone", () => {
    const phone = device("new", "phone");
    expect(newDeviceSince(["old"], [device("old", "phone"), phone])).toBe(phone);
  });

  it("ignores reordering, renames and last-seen updates", () => {
    expect(newDeviceSince(["a", "b"], [
      { ...device("b", "Renamed"), lastSeenAt: 100 }, device("a"),
    ])).toBeNull();
  });

  it("does not mistake a revoked phone for a new pairing", () => {
    expect(newDeviceSince(["a", "b"], [device("b")])).toBeNull();
    expect(newDeviceSince(["a"], [])).toBeNull();
  });

  it("reports the first new phone when several arrive together", () => {
    const first = device("first");
    expect(newDeviceSince(["old"], [device("old"), first, device("second")])).toBe(first);
  });

  it("tells a server with no way in for phones the command that turns phone access on, with no steps for a code it can't make", () => {
    const source = readFileSync(new URL("./MobilePairingCard.tsx", import.meta.url), "utf8");
    expect(source).toContain('cause instanceof ApiError && cause.body?.code === "unreachable"');
    expect(source).toContain('const PHONE_ACCESS_COMMAND = "npx madanibot setup";');
    expect(source).toContain("(failed && unreachable) ? null");
    expect((en as Record<string, string>)["settings.phone.unreachable"]).toMatch(/run this and pick phone access/);
  });

  it("keeps the Mac companion out of remote workspace pairing", () => {
    const source = readFileSync(new URL("./MobilePairingCard.tsx", import.meta.url), "utf8");
    expect(source).toContain("const companion = remote ? null : companionBridge()");
    expect(source).toContain("request.companion = (await companion.start()).endpoints");
    expect(source).toContain('method: "POST", body: JSON.stringify(request)');
  });

  it("hands the phone page's pieces to server pairing, with the active workspace flag", () => {
    const source = readFileSync(new URL("./SettingsModal.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/pairing: <PhoneLinking remote=\{remoteActive\} cloudHome=\{cloudHome\} email=\{state\.config\?\.profile\?\.email\}>\{\(phone\) => <ServerPairingCard phone=\{phone\}/);
  });

  it("sends an iPhone to the App Store app, never to a Home Screen page the qr cannot open", () => {
    // the qr is a madanibot://pair link only the app opens: a phone without it gets nothing from the camera
    const words = en as Record<string, string>;
    for (const key of ["settings.mobile.scanSteps", "mobile.desktop.noStoreApp", "mobile.desktop.appStore"]) {
      expect(words[key]).toContain("App Store");
      expect(words[key]).not.toMatch(/home screen/i);
      expect(words[key]).not.toMatch(/not in the app store|app store and google play soon/i);
    }
    const source = readFileSync(new URL("./MobilePairingCard.tsx", import.meta.url), "utf8");
    expect(source).toContain('data-phone-app-store="" href={storeUrl("ios")}');
    expect(words["mobile.desktop.storesSoon"]).toBe("Google Play soon");
  });
});
