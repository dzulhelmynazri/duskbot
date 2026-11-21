// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  open: false,
  closed: null as null | { at: number; tabs: Array<{ title: string; url: string; image: string | null }> },
  sent: [] as unknown[],
  closes: [] as Array<[string, string | undefined]>,
  surface: null as null | { onMessage: (message: Record<string, unknown>) => void; onFirstFrame: () => void; quietNotice?: (message: string) => boolean },
}));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: { browserEngine: { engine: "chrome" } } } }), api: vi.fn() }));
vi.mock("../Avatar", () => ({ BotAvatar: () => null }));
vi.mock("@/lib/local-browser", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/local-browser")>(),
  useLocalBrowser: () => ({ open: f.open, closed: f.closed, known: true }),
  closeLocalBrowser: async (botId: string, threadId: string | undefined) => { f.closes.push([botId, threadId]); return true; },
}));
vi.mock("../browser/StreamSurface", async () => {
  const { useEffect } = await import("react");
  return {
    StreamSurface: (props: { onClient: (client: unknown) => void; onConnectedChange: (on: boolean) => void; onMessage: (message: Record<string, unknown>) => void; onFirstFrame: () => void; quietNotice?: (message: string) => boolean }) => {
      useEffect(() => {
        props.onClient({ send: (input: unknown) => { f.sent.push(input); return true; } });
        props.onConnectedChange(true);
      }, []);
      f.surface = { onMessage: props.onMessage, onFirstFrame: props.onFirstFrame, quietNotice: props.quietNotice };
      return null;
    },
  };
});
import { LocalBrowserSection } from "./LocalBrowser";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BOT = { id: "b1", name: "Nova", threadId: "t1", browser: true } as never;
const TABS = [
  { tabId: "a", title: "Lisbon to Sintra", url: "https://www.cp.pt/en/tickets", active: true },
  { tabId: "b", title: "Pena Palace tickets", url: "https://www.parquesdesintra.pt/en", active: false },
  { tabId: "c", title: "Guesthouse Graça", url: "https://www.booking.com/hotel/graca", active: false },
];

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  f.open = true; f.closed = null; f.sent = []; f.closes = []; f.surface = null;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

const q = <T extends HTMLElement = HTMLElement>(selector: string) => host.querySelector<T>(selector);
const render = (props: Record<string, unknown> = {}) => act(async () => { root.render(createElement(LocalBrowserSection, { bot: { ...(BOT as object), ...props } as never, after: createElement("p", { "data-cta": "" }, "Keep Nova working") })); });
const message = (value: Record<string, unknown>) => act(async () => { f.surface!.onMessage(value); });
const click = (selector: string) => act(async () => { q(selector)!.click(); });

describe("the compact browser in the Computer tab", () => {
  it("at the panel's width shows only the address row and the page: no tabs, no new tab, no titles", async () => {
    await render();
    await message({ type: "tabs", tabs: TABS });
    for (const gone of ["[data-local-browser-strip]", "[data-local-browser-tab]", "[data-local-browser-action=new-tab]"]) expect(q(gone), gone).toBeNull();
    expect(host.textContent).not.toContain("Pena Palace tickets");
    expect(q("[data-local-browser-toolbar]")).not.toBeNull();
  });

  it("expanded, shows the bot's tabs, and selects, closes and opens tabs through the browser", async () => {
    await render();
    await message({ type: "tabs", tabs: TABS });
    await click("[data-local-browser-action=expand]");
    const tabs = [...host.querySelectorAll<HTMLElement>("[data-local-browser-tab]")];
    expect(tabs.map((tab) => tab.querySelector("[dir=auto]")?.textContent)).toEqual(["Lisbon to Sintra", "Pena Palace tickets", "Guesthouse Graça"]);
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");

    await click('[data-local-browser-tab="b"]');
    expect(f.sent.at(-1)).toEqual({ type: "tabSelect", tabId: "b" });
    // chosen at once, before the browser answers
    expect(q('[data-local-browser-tab="b"]')!.getAttribute("aria-selected")).toBe("true");

    await click('[data-local-browser-tab-close="c"]');
    expect(f.sent.at(-1)).toEqual({ type: "tabClose", tabId: "c" });
    expect(q('[data-local-browser-tab="c"]')).toBeNull();

    await click("[data-local-browser-action=new-tab]");
    expect(f.sent.at(-1)).toEqual({ type: "tabNew", url: "https://www.google.com/" });
  });

  it("opens a browser the person started on Google once, as its own step: a failure there is never a toast", async () => {
    f.open = false;
    await render();
    await click("[data-local-browser-action=start]");
    await message({ type: "tabs", tabs: [{ tabId: "t1", title: "", url: "about:blank", active: true }] });
    expect(f.sent).toEqual([{ type: "navigate", url: "https://www.google.com/" }]);
    expect(f.surface!.quietNotice?.("The browser could not do that. Try again."), "its own step's failure").toBe(true);
    expect(f.surface!.quietNotice?.("The browser could not do that. Try again."), "a person's next one shows").toBe(false);
    await message({ type: "tabs", tabs: [{ tabId: "t1", title: "", url: "about:blank", active: true }] });
    expect(f.sent, "only once").toHaveLength(1);
  });

  it("never navigates the bot's own browser, revealed, shown again or between tabs", async () => {
    // the bot's browser revealed as its turn starts: a blank tab is the one it is about to load
    await render();
    await message({ type: "tabs", tabs: [{ tabId: "t1", title: "", url: "about:blank", active: true }] });
    await message({ type: "tabs", tabs: [{ tabId: "t1", title: "X", url: "https://x.com/home", active: true }] });
    // shown again after the panel closed, or the Computer tab was left: a tab mid-load may report no address
    act(() => root.unmount());
    root = createRoot(host);
    await render();
    await message({ type: "tabs", tabs: [{ tabId: "t1", title: "", url: "", active: true }] });
    await message({ type: "tabs", tabs: [{ tabId: "t1", title: "X", url: "https://x.com/home", active: true }, { tabId: "t2", title: "", url: "about:blank", active: false }] });
    await click("[data-local-browser-action=expand]");
    await click('[data-local-browser-tab="t1"]');
    expect(f.sent.filter((input) => (input as { type: string }).type === "navigate")).toEqual([]);
  });

  it("shows the madani cloud card only at the panel's own width, never under the expanded browser", async () => {
    await render();
    await message({ type: "tabs", tabs: TABS });
    expect(q("[data-cta]")).not.toBeNull();
    await click("[data-local-browser-action=expand]");
    expect(q("[data-cta]")).toBeNull();
    await click("[data-local-browser-action=expand]");
    expect(q("[data-cta]")).not.toBeNull();
  });

  it("leaves a browser that already has pages where it is", async () => {
    await render();
    await message({ type: "tabs", tabs: TABS });
    expect(f.sent).toEqual([]);
  });

  it("acts on no tab or page until this browser has said which tabs it has", async () => {
    await render();
    expect(q<HTMLButtonElement>("[data-local-browser-action=reload]")!.disabled, "a restarted browser numbers its tabs anew").toBe(true);
    await message({ type: "tabs", tabs: TABS });
    expect(q<HTMLButtonElement>("[data-local-browser-action=reload]")!.disabled).toBe(false);
  });

  it("keeps the page hidden until its first frame paints, so it never flashes black", async () => {
    await render();
    expect(q("[data-local-browser-surface]")!.className).toContain("opacity-0");
    await act(async () => { f.surface!.onFirstFrame(); });
    expect(q("[data-local-browser-surface]")!.className).not.toContain("opacity-0");
  });

  it("goes back, forward and reloads, and goes to a typed address on Enter", async () => {
    await render();
    await message({ type: "tabs", tabs: TABS });
    await message({ type: "nav", url: "https://www.cp.pt/en/tickets", loading: false, canGoBack: true, canGoForward: false });
    expect(q<HTMLInputElement>("[data-local-browser-address]")!.value).toBe("cp.pt/en/tickets");
    expect(q<HTMLButtonElement>("[data-local-browser-action=forward]")!.disabled).toBe(true);
    await click("[data-local-browser-action=back]");
    expect(f.sent.at(-1)).toEqual({ type: "history", delta: -1 });
    await click("[data-local-browser-action=reload]");
    expect(f.sent.at(-1)).toEqual({ type: "reload" });

    const field = q<HTMLInputElement>("[data-local-browser-address]")!;
    await act(async () => { field.focus(); });
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "example.com");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { q<HTMLFormElement>("[data-local-browser-toolbar]")!.requestSubmit(); });
    expect(f.sent.at(-1)).toEqual({ type: "navigate", url: "https://example.com/" });
  });

  it("says the bot is browsing only while its turn acts in the browser, else that the browser is open", async () => {
    await render({ busy: false });
    expect(q("[data-local-browser-status]")!.textContent).toBe("Browser open");
    await render({ busy: true, turnStartedAt: Date.now() - 1_000 });
    expect(q("[data-local-browser-status]")!.textContent).toBe("Browser open");
    await message({ type: "pointer", phase: "click", x: 4, y: 4, sequence: 1 });
    expect(q("[data-local-browser-status]")!.textContent).toBe("Nova is browsing");
    await render({ busy: false });
    expect(q("[data-local-browser-status]")!.textContent).toBe("Browser open");
  });

  it("asks before closing the browser, and Cancel keeps it", async () => {
    await render();
    await message({ type: "tabs", tabs: TABS });
    await click("[data-local-browser-action=close]");
    expect(q("[role=alertdialog]")!.textContent).toBe("Close the browser? Nova’s tabs are saved.CancelClose");
    await click("[data-local-browser-action=close-cancel]");
    expect(q("[role=alertdialog]")).toBeNull();
    expect(f.closes).toEqual([]);

    await click("[data-local-browser-action=close]");
    await click("[data-local-browser-action=close-confirm]");
    expect(f.closes).toEqual([["b1", "t1"]]);
    expect(q("[data-local-browser=live]")).toBeNull();
    expect(q("[data-local-browser-action=start]")!.textContent).toBe("Start browser");
    expect(q("[data-local-browser-tab]"), "no tabs once it is closed").toBeNull();
    expect(q("[data-cta]")).not.toBeNull();
  });

  it("shows only the pill and the offer while closed, never the tabs it closed with, however recent", async () => {
    f.open = false;
    f.closed = { at: Date.now() - 60_000, tabs: [{ title: "Lisbon to Sintra", url: "https://www.cp.pt/en/tickets", image: "/screen.jpg" }] };
    await render();
    expect(q("[data-local-browser=closed]")!.textContent).toBe("Start browser");
    for (const gone of ["[data-local-browser-closed-tab]", "[data-local-browser-recent]", "[data-local-browser-tab]", "[data-local-browser=last-screen]"]) expect(q(gone), gone).toBeNull();
    expect(host.textContent).not.toContain("Lisbon to Sintra");
    expect(q("[data-cta]")).not.toBeNull();
  });

  it("starts the browser from the pill", async () => {
    f.open = false;
    await render();
    expect(q("[data-local-browser=live]")).toBeNull();
    await click("[data-local-browser-action=start]");
    expect(q("[data-local-browser=live]")).not.toBeNull();
    expect(f.surface).not.toBeNull();
  });

  it("widens the panel, and Escape brings it back without closing the panel around it", async () => {
    host.id = "bot-panel";
    host.setAttribute("role", "dialog");
    await render();
    await click("[data-local-browser-action=expand]");
    expect(q("[data-local-browser-action=expand]")!.getAttribute("aria-pressed")).toBe("true");
    expect(document.documentElement.style.getPropertyValue("--side-panel-w")).not.toBe("320px");
    let panelSaw: boolean | null = null;
    const panel = (event: KeyboardEvent) => { panelSaw = event.defaultPrevented; };
    window.addEventListener("keydown", panel);
    await act(async () => { q("[data-local-browser-action=expand]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    window.removeEventListener("keydown", panel);
    expect(panelSaw).not.toBe(false);
    expect(q("[data-local-browser-action=expand]")!.getAttribute("aria-pressed")).toBe("false");
    expect(document.documentElement.style.getPropertyValue("--side-panel-w")).toBe("320px");
  });

  it("asks for this Mac's missing permissions before starting, then opens the browser once all are on", async () => {
    f.open = false;
    let state: "missing" | "granted" = "missing";
    const status = () => ({ supported: true as const, screen: state, accessibility: state });
    const askFirst = { status: async () => status(), request: async () => { state = "granted"; return status(); } };
    await act(async () => { root.render(createElement(LocalBrowserSection, { bot: BOT, askFirst, after: createElement("p", { "data-cta": "" }, "Keep Nova working") })); });
    await click("[data-local-browser-action=start]");
    const dialog = () => [...document.body.querySelectorAll("[data-mac-permissions-dialog]")].find((el) => !el.closest("[data-leaving]")) ?? null;
    expect(dialog()).not.toBeNull();
    expect(q("[data-local-browser=live]")).toBeNull();
    expect(document.body.querySelectorAll("[data-permission-ask]")).toHaveLength(2);
    await act(async () => { document.body.querySelector<HTMLElement>("[data-permission-ask=accessibility]")!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(dialog()).toBeNull();
    expect(q("[data-local-browser=live]")).not.toBeNull();
  });

  it("asks first too when the app cannot read this Mac's permissions", async () => {
    f.open = false;
    const askFirst = { status: () => Promise.reject(new Error("No handler registered")), request: () => Promise.reject(new Error("No handler registered")) };
    await act(async () => { root.render(createElement(LocalBrowserSection, { bot: BOT, askFirst })); });
    await click("[data-local-browser-action=start]");
    expect(document.body.querySelector("[data-mac-permissions-dialog]")).not.toBeNull();
  });

  it("starts at once when this Mac already allows everything", async () => {
    f.open = false;
    const granted = { supported: true as const, screen: "granted" as const, accessibility: "granted" as const };
    const askFirst = { status: async () => granted, request: async () => granted };
    await act(async () => { root.render(createElement(LocalBrowserSection, { bot: BOT, askFirst })); });
    await click("[data-local-browser-action=start]");
    expect(document.body.querySelector("[data-mac-permissions-dialog]")).toBeNull();
    expect(q("[data-local-browser=live]")).not.toBeNull();
  });

  it("marks the tab the person holds, and hands it back", async () => {
    await render();
    await message({ type: "tabs", tabs: [{ ...TABS[0], held: true }, TABS[1]] });
    await click("[data-local-browser-action=expand]");
    expect(q('[data-local-browser-tab="a"] [data-local-browser-held]')).not.toBeNull();
    expect(q('[data-local-browser-tab="b"] [data-local-browser-held]')).toBeNull();
    expect(q("[data-local-browser-held-line]")!.textContent).toBe("You’re using this tabHand back");
    await click("[data-local-browser-action=hand-back]");
    expect(f.sent.at(-1)).toEqual({ type: "releaseControl" });
  });
});
