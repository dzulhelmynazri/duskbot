import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const values = new Map<string, string>();
const os = { dark: false, listeners: new Set<() => void>() };

async function boot() {
  vi.resetModules();
  const skins = await import("./skins");
  skins.applySkinChoice(skins.readSkinChoice());
  return { skin: document.documentElement.dataset.skin, stored: values.get("madani-skin") };
}

function setOsDark(dark: boolean) {
  os.dark = dark;
  for (const listener of os.listeners) listener();
}

beforeEach(() => {
  values.clear();
  os.dark = false;
  os.listeners.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", { documentElement: { dataset: {} as Record<string, string> } });
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() { return query === "(prefers-color-scheme: dark)" && os.dark; },
    addEventListener: (_type: string, listener: () => void) => { os.listeners.add(listener); },
    removeEventListener: (_type: string, listener: () => void) => { os.listeners.delete(listener); },
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("default skin", () => {
  it("opens a fresh install following the computer's light or dark setting, in Simple mode, and keeps following it", async () => {
    expect(await boot()).toEqual({ skin: "grok", stored: "system" });
    values.set("madani-installed", "2026-10-17T00:00:00.000Z");
    os.dark = true;
    expect(await boot()).toEqual({ skin: "grok-dark", stored: "system" });
  });

  it("switches between Grok and Grok Dark when the computer does, while following it", async () => {
    await boot();
    setOsDark(true);
    expect(document.documentElement.dataset.skin).toBe("grok-dark");
    setOsDark(false);
    expect(document.documentElement.dataset.skin).toBe("grok");
  });

  it("stops following the computer once someone picks a skin", async () => {
    await boot();
    const skins = await import("./skins");
    skins.applySkin("meadow");
    setOsDark(true);
    expect(document.documentElement.dataset.skin).toBe("meadow");
    expect(values.get("madani-skin")).toBe("meadow");
  });

  it("moves an install that ran before onto the Grok look once, then keeps what it picks", async () => {
    values.set("madani-skin", "lagoon");
    expect(await boot()).toMatchObject({ skin: "grok", stored: "system" });
    const skins = await import("./skins");
    skins.applySkin("lagoon");
    expect(await boot()).toMatchObject({ skin: "lagoon", stored: "lagoon" });
  });

  it("keeps an install that ran before in Midnight when nobody picked a skin", async () => {
    values.set("madani-skin-grok", "1");
    values.set("madani-skin", "midnight");
    expect(await boot()).toMatchObject({ skin: "midnight", stored: "midnight" });
  });

  it("keeps Midnight for an earlier install whose saved skin is missing or no longer exists", async () => {
    values.set("madani-skin-grok", "1");
    values.set("madani-installed", "2026-01-01T00:00:00.000Z");
    expect(await boot()).toEqual({ skin: "midnight", stored: "midnight" });
    values.set("madani-skin", "retired-skin");
    expect(await boot()).toMatchObject({ skin: "midnight", stored: "midnight" });
  });

  it("always honours a skin someone chose", async () => {
    values.set("madani-skin-grok", "1");
    values.set("madani-skin", "lagoon");
    expect(await boot()).toMatchObject({ skin: "lagoon" });
    values.clear();
    values.set("madani-skin-grok", "1");
    values.set("madani-skin", "midnight");
    values.set("madani-advanced-mode", "0");
    expect(await boot()).toMatchObject({ skin: "midnight" });
  });

  it("shows System as the theme in Appearance on a fresh install", async () => {
    os.dark = true;
    await boot();
    const { ThemeRow } = await import("@/components/ThemeRow");
    const theme = renderToStaticMarkup(createElement(ThemeRow));
    expect(theme.match(/role="combobox" aria-label="Theme"[^>]*>(?:<[^>]+>)*([^<]+)</)?.[1]).toBe("Follow system");
  });
});
