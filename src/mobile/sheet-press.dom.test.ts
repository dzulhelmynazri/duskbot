// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

vi.mock("@/components/ChatView", () => ({ ChatView: () => null }));
vi.mock("@/components/GroupView", () => ({ GroupView: () => null }));
vi.mock("./connection/ConnectionProblem", () => ({ ConnectionPill: () => null, useLiveConnection: () => ({ notice: null, trying: false, retry() {} }) }));
vi.mock("./PhoneChatMenu", () => ({ PhoneChatMenu: () => null }));
vi.mock("./platform", async (importOriginal) => ({ ...await importOriginal<typeof import("./platform")>(), usePlatform: () => ({}) }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: { computerControl: {} }, dispatch: () => {} }),
}));

const { ChatScreen } = await import("./ChatScreen");
const { Sheet } = await import("./Sheet");

const bot = { id: "nova", name: "Nova", color: "green", busy: false } as unknown as Bot;
let root: Root | null = null;
const mount = (node: ReturnType<typeof createElement>) => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  flushSync(() => root!.render(node));
};
afterEach(() => { if (root) flushSync(() => root!.unmount()); root = null; document.body.innerHTML = ""; });

describe("the bot's name pill", () => {
  it("opens the sheet as the finger lands, once, with no second open from the click that follows", () => {
    const onProfile = vi.fn();
    mount(createElement(ChatScreen, { bot, members: [], onBack() {}, onProfile, onComputer() {} }));
    const pill = document.querySelector<HTMLButtonElement>("[data-glass=title]")!;
    pill.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    expect(onProfile).toHaveBeenCalledTimes(1);
    pill.click();
    expect(onProfile).toHaveBeenCalledTimes(1);
  });

  it("still opens from a click with no press before it: a key, or the native pill over the glass bridge", () => {
    const onProfile = vi.fn();
    mount(createElement(ChatScreen, { bot, members: [], onBack() {}, onProfile, onComputer() {} }));
    document.querySelector<HTMLButtonElement>("[data-glass=title]")!.click();
    expect(onProfile).toHaveBeenCalledTimes(1);
  });
});

describe("a sheet's scrim", () => {
  it("closes only for a press that began on it, never for the lift of the press that opened the sheet", () => {
    const onClose = vi.fn();
    mount(createElement("div", { className: "madani-mobile" }, createElement(Sheet, { open: true, onClose, title: "Nova", children: "body" })));
    const scrim = document.querySelector<HTMLElement>(".mobile-sheet-layer > [aria-hidden]")!;
    scrim.click();
    expect(onClose).not.toHaveBeenCalled();
    scrim.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    scrim.click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
