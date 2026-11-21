// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { followSystemTextSize, readTextSize, setTextSize, textScale, textScaleFor } from "./text-scale";

const saved = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); }, clear: () => saved.clear() });
afterEach(() => saved.clear());

describe("system text size", () => {
  it("is the system body size over its default, kept inside what the layout holds", () => {
    expect(textScaleFor(17)).toBe(1);
    expect(textScaleFor(19)).toBe(1.12);
    expect(textScaleFor(14)).toBe(0.9);
    expect(textScaleFor(28)).toBe(1.35);
    expect(textScaleFor(53)).toBe(1.35);
    expect(textScaleFor(Number.NaN)).toBe(1);
    expect(textScaleFor(0)).toBe(1);
  });

  it("sets the page's text zoom on an iPhone, and again when the app comes back", () => {
    let size = 21;
    const zoom = vi.fn();
    let resumed: (() => void) | undefined;
    const stop = vi.fn();
    const off = followSystemTextSize({ kind: "ios", onResume: (listener) => { resumed = listener; return stop; } }, () => size, zoom);
    expect(zoom).toHaveBeenLastCalledWith(124);
    size = 17;
    resumed?.();
    expect(zoom).toHaveBeenLastCalledWith(100);
    off();
    expect(stop).toHaveBeenCalled();
  });

  it("leaves Android's and the browser's own text zoom alone while the phone's setting is followed", () => {
    expect(textScale("system", "android", () => 30)).toBe(1);
    expect(textScale("system", "web", () => 30)).toBe(1);
  });
});

describe("a text size picked in Settings", () => {
  it("wins over the phone's Larger Text and applies at once", () => {
    const zoom = vi.fn();
    const off = followSystemTextSize({ kind: "ios" }, () => 23, zoom);
    expect(zoom).toHaveBeenLastCalledWith(135);
    setTextSize("default");
    expect(zoom).toHaveBeenLastCalledWith(100);
    setTextSize("small");
    expect(zoom).toHaveBeenLastCalledWith(88);
    expect(readTextSize()).toBe("small");
    off();
  });

  it("reads an unknown saved value as the phone's setting", () => {
    localStorage.setItem("madani.mobile.textSize", "huge");
    expect(readTextSize()).toBe("system");
  });
});
