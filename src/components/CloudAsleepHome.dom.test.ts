// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HomeBridge, HomeView, LastSeen } from "../../electron/home-window.mjs";
import { setLocale } from "@/lib/i18n";
import { HomeScreen } from "./HomeScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root | null = null;
const settle = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
const seen: LastSeen = { savedAt: 1, bots: [
  { id: "scout", threadId: "t-scout", name: "Scout", messages: [{ id: "m1", role: "user", text: "find flights to Goa", at: 1 }, { id: "m2", role: "bot", text: "Three options under ₹9,000.", at: 2 }] },
  { id: "quill", threadId: "t-quill", name: "Quill", messages: [{ id: "m3", role: "bot", text: "Draft is ready.", at: 3 }] },
] };
function bridgeOf(view: HomeView, lastSeen: LastSeen | null = seen) {
  let listener: ((view: HomeView) => void) | null = null;
  const bridge = {
    state: vi.fn(async () => view), onState: vi.fn((cb: (view: HomeView) => void) => { listener = cb; return () => {}; }), retry: vi.fn(async () => view),
    signIn: vi.fn(async () => {}), repair: vi.fn(async () => {}), lastSeen: vi.fn(async () => lastSeen),
    wake: vi.fn(async (_intent: "type" | "click" | "send", send?: unknown) => ({ screen: "asleep", waking: true, ...(send ? { held: (send as { text: string }).text } : {}) }) as HomeView),
  } satisfies HomeBridge;
  return { bridge, push: (next: HomeView) => act(async () => { listener?.(next); }) };
}
async function mount(bridge: HomeBridge) {
  root = createRoot(host);
  await act(async () => { root!.render(createElement(HomeScreen, { bridge })); });
  await settle();
}
const composer = () => host.querySelector<HTMLTextAreaElement>("[data-cloud-asleep-composer]")!;
const line = () => host.querySelector("[data-cloud-asleep-line]")?.textContent;
const key = (key: string, init: KeyboardEventInit = {}) => act(async () => { composer().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })); });
const type = (value: string) => act(async () => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(composer(), value);
  composer().dispatchEvent(new Event("input", { bubbles: true }));
});
beforeEach(() => { setLocale("en"); host = document.createElement("div"); document.body.append(host); Object.assign(window, { madaniDesktop: {} }); });
afterEach(async () => { await act(async () => root?.unmount()); root = null; host.remove(); });

it("never shows a sleeping Cloud: opening the screen wakes it once and only says it is connecting", async () => {
  const { bridge } = bridgeOf({ screen: "asleep" });
  await mount(bridge);
  expect(host.querySelector("[data-home-screen]")?.getAttribute("data-home-screen")).toBe("asleep");
  expect(bridge.wake).toHaveBeenCalledTimes(1);
  expect(bridge.wake).toHaveBeenCalledWith("click", null);
  expect(line()).toBe("Connecting…");
  expect(host.textContent).not.toMatch(/asleep/i);
  expect([...host.querySelectorAll("ol li div")].map((node) => node.textContent)).toEqual(["find flights to Goa", "Three options under ₹9,000."]);
  await act(async () => { host.querySelector<HTMLButtonElement>("nav button:nth-child(2)")!.click(); });
  expect(host.querySelector("ol li div")?.textContent).toBe("Draft is ready.");
  expect(host.querySelector("nav button[aria-current='page']")?.textContent).toBe("Quill");
  await key("h");
  expect(bridge.wake, "typing after the wake asks nothing more").toHaveBeenCalledTimes(1);
  expect(composer().getAttribute("aria-label")).toBe("Message Quill");
});

it("a message written while it connects is held and sent once it is up", async () => {
  const { bridge, push } = bridgeOf({ screen: "asleep" });
  await mount(bridge);
  await type("hi there");
  await key("Enter");
  expect(bridge.wake).toHaveBeenCalledTimes(2);
  const [intent, send] = bridge.wake.mock.calls[1]!;
  expect(intent).toBe("send");
  expect(send).toMatchObject({ botId: "scout", threadId: "t-scout", text: "hi there" });
  expect((send as { sendId: string }).sendId).toMatch(/^[A-Za-z0-9_-]{8,80}$/);
  await push({ screen: "asleep", waking: true, held: "hi there" });
  expect(host.querySelector("[data-cloud-asleep-held]")?.textContent).toBe("hi thereSends in a moment");
  expect(composer().value).toBe("");
});

it("with nothing seen yet it shows the loading mascot while it connects, never an empty chat list", async () => {
  const empty = bridgeOf({ screen: "asleep" }, null);
  await mount(empty.bridge);
  expect(host.querySelector("[data-cloud-asleep-loading] [data-mascot-loader]")).toBeTruthy();
  expect(host.querySelector("ol")).toBeNull();
  expect(host.textContent).not.toContain("No chats seen");
  expect(empty.bridge.wake).toHaveBeenCalledTimes(1);
});

it("the connecting line sits clear of the macOS traffic lights, in a bar that drags the window", async () => {
  // the preload's platform is read when the page's modules load, as in the app
  Object.assign(window, { madaniDesktop: { platform: "darwin" } });
  vi.resetModules();
  const fresh = await import("./HomeScreen");
  const { bridge } = bridgeOf({ screen: "asleep" });
  root = createRoot(host);
  await act(async () => { root!.render(createElement(fresh.HomeScreen, { bridge })); });
  await settle();
  const bar = host.querySelector<HTMLElement>("[data-cloud-asleep-bar]")!;
  expect(bar.contains(host.querySelector("[data-cloud-asleep-line]"))).toBe(true);
  expect(bar.style.paddingLeft).toBe("88px");
  expect(bar.hasAttribute("data-window-drag")).toBe(true);
  expect(bar.nextElementSibling?.querySelector("nav"), "the bots list starts under the bar, not beside the lights").toBeTruthy();
});

it("elsewhere the line keeps the page's own inset", async () => {
  const { bridge } = bridgeOf({ screen: "asleep" });
  await mount(bridge);
  expect(host.querySelector<HTMLElement>("[data-cloud-asleep-bar]")!.style.paddingLeft).toBe("");
});

it("with nothing seen yet a failed wake says so and offers Try again", async () => {
  const empty = bridgeOf({ screen: "asleep" }, null);
  empty.bridge.wake.mockRejectedValueOnce(new Error("offline"));
  await mount(empty.bridge);
  expect(host.querySelector("[role=alert]")?.textContent).toBeTruthy();
  const button = [...host.querySelectorAll("button")].find((node) => node.textContent === "Try again")!;
  expect(button).toBeTruthy();
  await act(async () => { button.click(); });
  expect(empty.bridge.wake).toHaveBeenCalledTimes(2);
  expect(empty.bridge.wake).toHaveBeenLastCalledWith("click", null);
});
