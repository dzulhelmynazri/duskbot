// @vitest-environment happy-dom
import { createElement, useRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dismissKeyboard, keyboardRide, useKeyboardDismiss, useKeyboardSync } from "./keyboard";
import type { KeyboardFrame, MobilePlatform } from "./platform";

let root: Root;
let host: HTMLDivElement;
let keyboard: ((frame: KeyboardFrame) => void) | null;
const hideKeyboard = vi.fn();

function platform(native: boolean): MobilePlatform {
  return {
    kind: native ? "ios" : "web", native, haptic() {}, hideKeyboard,
    onKeyboard: native ? (listener) => { keyboard = listener; return () => { keyboard = null; }; } : undefined,
    prefs: { get: async () => null, set: async () => {}, remove: async () => {} },
    secrets: { get: async () => null, set: async () => {}, remove: async () => {} },
    openExternal: async () => {}, deviceName: () => "iPhone", appVersion: "test",
  } as MobilePlatform;
}

function Shell({ platform: p }: { platform: MobilePlatform }) {
  const ref = useRef<HTMLDivElement>(null);
  useKeyboardSync(p, ref);
  useKeyboardDismiss(p, ref);
  return createElement("div", { ref, className: "madani-mobile" },
    createElement("div", { "data-mobile-chat": "" },
      createElement("div", { className: "glass-scroller" }, createElement("p", { id: "bubble" }, "hello")),
      createElement("textarea", { id: "field" })));
}

const list = () => host.querySelector<HTMLElement>(".glass-scroller")!;
const field = () => host.querySelector<HTMLTextAreaElement>("#field")!;
function scrollable(height: number, top: number) {
  Object.defineProperty(list(), "scrollHeight", { configurable: true, get: () => height });
  Object.defineProperty(list(), "clientHeight", { configurable: true, get: () => 400 });
  list().scrollTop = top;
}
const touch = (target: Element, type: string, y: number, x = 100) => {
  const event = new Event(type, { bubbles: true }) as Event & { touches: Array<{ clientX: number; clientY: number }> };
  Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : [{ clientX: x, clientY: y }] });
  target.dispatchEvent(event);
};

beforeEach(() => {
  keyboard = null;
  hideKeyboard.mockClear();
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { fn(0); return 1; });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("the phone keyboard", () => {
  it("goes to the newest row as it starts to rise, however far up the chat was read", () => {
    flushSync(() => root.render(createElement(Shell, { platform: platform(true) })));
    scrollable(2000, 300);
    keyboard!({ height: 336, phase: "will" });
    expect(list().scrollTop).toBe(2000);
  });

  it("keeps a chat resting at its newest row there as the keyboard goes away", () => {
    flushSync(() => root.render(createElement(Shell, { platform: platform(true) })));
    // a real scroller: its height follows the keyboard's inset and scrollTop is clamped to the range on every read
    const el = list();
    let top = 0;
    const client = () => 800 - (parseFloat(host.querySelector<HTMLElement>(".madani-mobile")!.style.getPropertyValue("--m-kb")) || 0);
    const clamp = (value: number) => Math.max(0, Math.min(value, 1200 - client()));
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 1200 });
    Object.defineProperty(el, "clientHeight", { configurable: true, get: client });
    Object.defineProperty(el, "scrollTop", { configurable: true, get: () => (top = clamp(top)), set: (value: number) => { top = clamp(value); } });
    keyboard!({ height: 336, phase: "will" });
    keyboard!({ height: 336, phase: "did" });
    expect(el.scrollTop).toBe(1200 - 464);
    keyboard!({ height: 0, phase: "will" });
    expect(el.scrollTop).toBe(1200 - 800);
  });

  it("is put away by a drag down the transcript, not by a sideways or upward one", () => {
    flushSync(() => root.render(createElement(Shell, { platform: platform(true) })));
    field().focus();
    const bubble = host.querySelector("#bubble")!;
    touch(bubble, "touchstart", 300);
    touch(bubble, "touchmove", 280);
    touch(bubble, "touchmove", 290, 160);
    expect(document.activeElement).toBe(field());
    touch(bubble, "touchend", 0);
    touch(bubble, "touchstart", 300);
    touch(bubble, "touchmove", 324);
    expect(document.activeElement).not.toBe(field());
    expect(hideKeyboard).toHaveBeenCalledOnce();
  });

  it("is put away by a tap on the transcript, but a tap on a control keeps it", () => {
    flushSync(() => root.render(createElement(Shell, { platform: platform(true) })));
    const button = document.createElement("button");
    list().append(button);
    field().focus();
    button.click();
    expect(document.activeElement).toBe(field());
    (host.querySelector("#bubble") as HTMLElement).click();
    expect(document.activeElement).not.toBe(field());
  });
});

describe("riding the keyboard with the native composer", () => {
  it("takes the system's duration and starts as far in as the bridge hop cost", () => {
    expect(keyboardRide({ height: 336, phase: "will", duration: 0.383, at: 1_000 }, 0.4, 1_032)).toEqual({ duration: 0.383, delayMs: 32 });
    expect(keyboardRide({ height: 0, phase: "will", duration: 0.25, at: 1_000 }, 0.4, 1_000)).toEqual({ duration: 0.25, delayMs: 0 });
  });

  it("falls back to its own spring without the system's timing, and never skips more than a stalled hop", () => {
    expect(keyboardRide({ height: 336, phase: "will" }, 0.4, 5_000)).toEqual({ duration: 0.4, delayMs: 0 });
    expect(keyboardRide({ height: 336, phase: "will", duration: 0, at: 1_000 }, 0.4, 1_900)).toEqual({ duration: 0.4, delayMs: 150 });
    expect(keyboardRide({ height: 336, phase: "will", duration: 0.383, at: 2_000 }, 0.4, 1_000).delayMs, "a clock that runs behind").toBe(0);
  });

  it("starts the transcript's ride with a negative delay for a late event, on both the way up and down", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(10_040);
    flushSync(() => root.render(createElement(Shell, { platform: platform(true) })));
    const shell = host.querySelector<HTMLElement>(".madani-mobile")!;
    keyboard!({ height: 336, phase: "will", duration: 0.383, at: 10_000 });
    expect(shell.style.getPropertyValue("--m-kb-dur")).toBe("0.383s");
    expect(shell.style.getPropertyValue("--m-kb-delay")).toBe("-40ms");
    keyboard!({ height: 336, phase: "did" });
    now.mockReturnValue(20_050);
    keyboard!({ height: 0, phase: "will", duration: 0.383, at: 20_000 });
    expect(shell.style.getPropertyValue("--m-kb-delay")).toBe("-50ms");
    expect(shell.style.getPropertyValue("--m-kb-shift")).toBe("0px");
    now.mockRestore();
  });
});

describe("a keyboard the native side lifts the page for", () => {
  it("never scrolls the transcript or moves its layout for a full lift, up or down", () => {
    flushSync(() => root.render(createElement(Shell, { platform: platform(true) })));
    const shell = host.querySelector<HTMLElement>(".madani-mobile")!;
    scrollable(2000, 1600);
    keyboard!({ height: 336, phase: "will", duration: 0.38, at: Date.now(), lift: 302 });
    keyboard!({ height: 336, phase: "did" });
    expect(shell.style.getPropertyValue("--m-kb-shift")).toBe("");
    expect(shell.dataset.kbMoving).toBeUndefined();
    keyboard!({ height: 336, phase: "did", lift: 302 });
    expect(shell.style.getPropertyValue("--m-kb")).toBe("34px");
    expect(shell.style.getPropertyValue("--m-lift"), "what the transcript's follow reads as off screen").toBe("302px");
    expect(shell.dataset.keyboard).toBe("open");
    keyboard!({ height: 0, phase: "will", duration: 0.38, at: Date.now(), lift: 0 });
    expect(shell.style.getPropertyValue("--m-kb")).toBe("0px");
    expect(shell.style.getPropertyValue("--m-lift")).toBe("0px");
    keyboard!({ height: 0, phase: "did" });
    keyboard!({ height: 0, phase: "did", lift: 0 });
    expect(list().scrollTop).toBe(1600);
    expect(shell.dataset.keyboard).toBeUndefined();
  });

  it("covers only what a short chat's partial lift leaves under the keyboard, and gives it back as the keyboard starts down", () => {
    flushSync(() => root.render(createElement(Shell, { platform: platform(true) })));
    const shell = host.querySelector<HTMLElement>(".madani-mobile")!;
    scrollable(300, 0);
    keyboard!({ height: 336, phase: "will", duration: 0.38, at: Date.now(), lift: 102 });
    keyboard!({ height: 336, phase: "did", lift: 102 });
    expect(shell.style.getPropertyValue("--m-kb")).toBe("234px");
    keyboard!({ height: 0, phase: "will", duration: 0.38, at: Date.now(), lift: 0 });
    expect(shell.style.getPropertyValue("--m-kb")).toBe("0px");
    expect(list().scrollTop).toBe(0);
  });

  it("leaves a field on the page to the page's own ride", () => {
    flushSync(() => root.render(createElement(Shell, { platform: platform(true) })));
    const shell = host.querySelector<HTMLElement>(".madani-mobile")!;
    keyboard!({ height: 336, phase: "will", lift: 302 });
    keyboard!({ height: 0, phase: "did", lift: 0 });
    keyboard!({ height: 336, phase: "will", duration: 0.38, at: Date.now() });
    expect(shell.dataset.kbMoving).toBe("");
  });
});

describe("the Android keyboard", () => {
  const android = (mode: (ride: boolean) => void) => ({ ...platform(true), kind: "android", keyboardMode: mode }) as MobilePlatform;

  it("rides the composer's field in a window of full height and has any other field's window end at the keyboard", () => {
    const mode = vi.fn();
    flushSync(() => root.render(createElement(Shell, { platform: android(mode) })));
    const chat = host.querySelector("[data-mobile-chat]")!;
    const composer = document.createElement("div");
    composer.dataset.tour = "composer";
    const own = document.createElement("textarea");
    composer.append(own);
    chat.append(composer);
    const search = document.createElement("input");
    host.querySelector(".madani-mobile")!.append(search);
    const box = document.createElement("input");
    box.type = "checkbox";
    host.querySelector(".madani-mobile")!.append(box);
    own.focus();
    search.focus();
    box.focus();
    expect(mode.mock.calls).toEqual([[true], [false]]);
  });

  it("rides up on the system's clock, takes the space once it stops, and gives it back at once when a sheet's field takes the keyboard", () => {
    flushSync(() => root.render(createElement(Shell, { platform: android(() => {}) })));
    const shell = host.querySelector<HTMLElement>(".madani-mobile")!;
    scrollable(2000, 1600);
    keyboard!({ height: 300, phase: "will", duration: 0.285, at: Date.now() });
    expect(shell.dataset.kbMoving).toBe("");
    expect(shell.style.getPropertyValue("--m-kb-dur")).toBe("0.285s");
    keyboard!({ height: 300, phase: "did" });
    expect(shell.style.getPropertyValue("--m-kb")).toBe("300px");
    expect(shell.dataset.kbMoving).toBeUndefined();
    keyboard!({ height: 0, phase: "did" });
    expect(shell.style.getPropertyValue("--m-kb")).toBe("0px");
    expect(shell.dataset.keyboard).toBeUndefined();
  });
});

describe("leaving a chat", () => {
  it("puts away the keyboard of the native composer and of a field on the page", () => {
    const blur = vi.fn();
    const p = { ...platform(true), glass: { blur } } as unknown as MobilePlatform;
    flushSync(() => root.render(createElement(Shell, { platform: p })));
    const shell = host.querySelector<HTMLElement>(".madani-mobile")!;
    shell.dataset.glassFocused = "";
    dismissKeyboard(p, shell);
    expect(blur).toHaveBeenCalledTimes(1);
    expect(hideKeyboard).not.toHaveBeenCalled();
    delete shell.dataset.glassFocused;
    field().focus();
    dismissKeyboard(p, shell);
    expect(document.activeElement).not.toBe(field());
    expect(hideKeyboard).toHaveBeenCalledTimes(1);
    dismissKeyboard(p, shell);
    expect(hideKeyboard).toHaveBeenCalledTimes(1);
  });
});
