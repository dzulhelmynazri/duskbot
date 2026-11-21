// @vitest-environment happy-dom
// The notch and dock step: the real island is on while it shows, the choice is saved, and leaving without one puts it back.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

vi.mock("@/components/Avatar", () => ({ MausAvatar: () => null, BotAvatar: () => null }));
vi.mock("@/components/mascot-clock", () => ({ usePrefersReducedMotion: () => true }));
const { IslandIntro } = await import("./IslandIntro");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
let prefs: { available: boolean; island: boolean; dock: boolean };
const set = vi.fn();
const onDone = vi.fn();
const button = (label: string) => [...host.querySelectorAll("button")].find((node) => node.textContent === label)!;
const flush = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(50); }); };
const show = async () => {
  await act(async () => { root.render(createElement(IslandIntro, { onDone })); });
  await flush();
};

beforeEach(() => {
  vi.useFakeTimers();
  setLocale("en");
  prefs = { available: true, island: false, dock: true };
  set.mockReset().mockImplementation(async (change: object) => Object.assign(prefs, change));
  onDone.mockReset();
  vi.stubGlobal("madaniDesktop", { ambient: { prefs: async () => ({ ...prefs }), set } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the notch and dock step", () => {
  it("lights up the real island while it shows, and says so", async () => {
    await show();
    expect(set).toHaveBeenCalledWith({ island: true });
    expect(host.querySelector("[role=status]")?.textContent).toBe("Live at the top of your screen right now");
  });

  it("keeps the notch on when asked", async () => {
    await show();
    await act(async () => { button("Keep the notch on").click(); });
    expect(set).toHaveBeenLastCalledWith({ island: true });
    expect(onDone).toHaveBeenCalledWith("notch");
  });

  it("goes back to just the side dock, which stays on", async () => {
    prefs.dock = false;
    await show();
    await act(async () => { button("Just the side dock").click(); });
    expect(set).toHaveBeenLastCalledWith({ island: false, dock: true });
    expect(onDone).toHaveBeenCalledWith("dock");
    expect(prefs).toMatchObject({ island: false, dock: true });
  });

  it("puts the island back off when it closes with no choice", async () => {
    await show();
    await act(async () => root.unmount());
    root = createRoot(host);
    expect(set).toHaveBeenLastCalledWith({ island: false });
    expect(prefs.island).toBe(false);
  });

  it("leaves an island that was already on alone", async () => {
    prefs.island = true;
    await show();
    await act(async () => root.unmount());
    root = createRoot(host);
    expect(set).not.toHaveBeenCalled();
  });

  it("says when the choice did not save, and stays", async () => {
    await show();
    set.mockRejectedValueOnce(new Error("no"));
    await act(async () => { button("Just the side dock").click(); });
    expect(host.querySelector("[role=alert]")?.textContent).toBe("Couldn't save this setting. Try again.");
    expect(onDone).not.toHaveBeenCalled();
    expect(button("Just the side dock").disabled).toBe(false);
  });

  it("walks the island through every mood on its own, and a tapped bot is cheered on", async () => {
    await show();
    const mood = () => [...host.querySelectorAll("[data-island-emoji]")].at(-1)?.getAttribute("data-island-emoji");
    const seen = new Set<string | null | undefined>();
    for (let i = 0; i < 7; i++) {
      seen.add(mood());
      await act(async () => { await vi.advanceTimersByTimeAsync(2400); });
    }
    expect([...seen].sort()).toEqual(["celebrate", "done", "idle", "needs-you", "talking", "thinking", "working"]);
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-dock-bot="invoices"]')!.click(); });
    expect(mood()).toBe("celebrate");
  });
});
