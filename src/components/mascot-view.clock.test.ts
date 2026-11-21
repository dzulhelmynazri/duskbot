// @vitest-environment happy-dom
import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { MausAvatar, type MausAvatarHandle, type MausAvatarProps } from "./Avatar";
import { UNREAD_NOTICE_MS, useUnreadNotice } from "./unread-notice";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const observed: { callback: ((entries: Array<{ target: Element; isIntersecting: boolean }>) => void) | null } = { callback: null };
class FakeIntersectionObserver {
  constructor(callback: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void) {
    observed.callback = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);

let reducedMotion = false;
const motionListeners = new Set<() => void>();
vi.stubGlobal("matchMedia", (query: string) => ({
  get matches() { return query.includes("reduce") && reducedMotion; },
  addEventListener: (_: string, listener: () => void) => motionListeners.add(listener),
  removeEventListener: (_: string, listener: () => void) => motionListeners.delete(listener),
}));

let frameRequests = 0;
let host: HTMLDivElement;
let root: Root;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  const raf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
    frameRequests++;
    return raf(callback);
  };
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  frameRequests = 0;
  reducedMotion = false;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (avatars: Array<Partial<MausAvatarProps> & { ref?: React.Ref<MausAvatarHandle> }>) =>
  act(() => root.render(avatars.map((props, key) => createElement(MausAvatar, { key, color: "green", ...props }))));
const run = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const markOf = () => host.querySelector("[data-madani-mark]")!;
/** The box the engine draws in: the mark's body, fitted inside the mark. */
const drawnOf = () => markOf().firstElementChild!;
/** Frames the shared loop asks for over `ms`, after the marks have had `settle` ms. */
const framesOver = (ms: number) => {
  frameRequests = 0;
  run(ms);
  return frameRequests;
};

describe("marks on the shared loop", () => {
  it("draws every busy mascot from one animation frame, about 60 times a second", () => {
    render(Array.from({ length: 12 }, (_, i) => ({ state: "working" as const, size: [24, 28, 36, 64][i % 4] })));
    run(100);
    const frames = framesOver(1000);
    expect(frames).toBeGreaterThanOrEqual(55);
    expect(frames).toBeLessThanOrEqual(70);
  });

  it("paints a static mascot once, in its state's face, and then asks for nothing", () => {
    render([{ state: "sleeping", animated: false, size: 24 }]);
    run(100);
    expect(markOf().getAttribute("data-state")).toBe("sleeping");
    expect(host.querySelector("[data-madani-mark] canvas")).not.toBeNull();
    expect(framesOver(2000)).toBe(0);
  });

  it("lets an idle mascot with no life of its own settle to no frames, and wakes it for a blink", () => {
    const ref = createRef<MausAvatarHandle>();
    render([{ state: "idle", size: 24, ref, personality: false }]);
    run(1000);
    expect(framesOver(2000)).toBe(0);
    act(() => ref.current!.blink());
    expect(framesOver(500)).toBeGreaterThan(5);
    expect(framesOver(2000)).toBe(0);
  });

  it("settles soon after a turn ends, then sleeps", () => {
    render([{ state: "working", size: 28, personality: false }]);
    run(1000);
    render([{ state: "idle", size: 28, personality: false }]);
    run(2000);
    expect(framesOver(3000)).toBe(0);
  });

  it("lets an unread mascot play its notice, then draws nothing while the news waits", () => {
    function Row({ unread }: { unread: boolean }) {
      return createElement(MausAvatar, { color: "green", state: unread ? "notifying" : "idle", size: 42, animated: useUnreadNotice(unread) });
    }
    act(() => root.render(createElement(Row, { unread: false })));
    run(200);
    act(() => root.render(createElement(Row, { unread: true })));
    expect(framesOver(2000)).toBeGreaterThan(20);
    run(UNREAD_NOTICE_MS);
    run(1000);
    expect(framesOver(30_000)).toBe(0);
  });

  it("stops drawing a mascot that leaves the screen", () => {
    render([{ state: "working", size: 36 }]);
    run(200);
    act(() => observed.callback!([{ target: drawnOf(), isIntersecting: false }]));
    expect(framesOver(1000)).toBe(0);
    act(() => observed.callback!([{ target: drawnOf(), isIntersecting: true }]));
    expect(framesOver(500)).toBeGreaterThan(5);
  });

  it("holds still under reduced motion: no move, blink or spin", () => {
    reducedMotion = true;
    act(() => { for (const listener of motionListeners) listener(); });
    const ref = createRef<MausAvatarHandle>();
    render([{ state: "celebrate", size: 64, ref }]);
    run(200);
    act(() => { ref.current!.blink(); ref.current!.spin(); });
    expect(framesOver(2000)).toBe(0);
  });

  it("calms an animating mascot when reduced motion is switched on", () => {
    render([{ state: "working", size: 36 }]);
    run(200);
    reducedMotion = true;
    act(() => { for (const listener of motionListeners) listener(); });
    run(100);
    expect(framesOver(1000)).toBe(0);
  });
});
