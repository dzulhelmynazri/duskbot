import { afterEach, expect, it, vi } from "vitest";
import { emailGateDone, setEmailGateDone, track } from "./analytics";

afterEach(() => vi.unstubAllGlobals());

it("does no telemetry work even when an older install saved an opt-in", () => {
  const request = vi.fn();
  const setInterval = vi.fn();
  const setItem = vi.fn();
  vi.stubGlobal("fetch", request);
  vi.stubGlobal("setInterval", setInterval);
  vi.stubGlobal("localStorage", { getItem: () => "0", setItem });
  vi.stubGlobal("window", { madaniDesktop: { desktopAnalytics: { enabled: () => true, set: request } } });
  track("app_opened", { platform: "desktop" });
  expect(request).not.toHaveBeenCalled();
  expect(setInterval).not.toHaveBeenCalled();
  expect(setItem).not.toHaveBeenCalled();
});

it("preserves the local legacy onboarding flag", () => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) });
  expect(emailGateDone()).toBe(false);
  setEmailGateDone("submitted");
  expect(values.get("madani-email-gate")).toBe("submitted");
  expect(emailGateDone()).toBe(true);
});

it("continues onboarding when browser storage is unavailable", () => {
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("unavailable"); }, setItem: () => { throw new Error("unavailable"); } });
  expect(emailGateDone()).toBe(false);
  expect(() => setEmailGateDone("skipped")).not.toThrow();
});
