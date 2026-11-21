// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadingLaunch, resetLoadingLaunch, type HandedLook } from "@/lib/mascot-loading";
import { BootCover } from "./BootCover";

let root: Root | null = null;
let switching: ((on: boolean) => void) | null = null;
const handed: HandedLook[] = [];

const cover = () => document.querySelector<HTMLElement>("[data-boot-cover]");
function render(busy: boolean) {
  act(() => root!.render(createElement(BootCover, { busy })));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  resetLoadingLaunch();
  handed.length = 0;
  window.madaniDesktop = {
    workspaces: {
      onSwitching: (cb: (on: boolean) => void) => { switching = cb; return () => { switching = null; }; },
      handLook: (look: HandedLook) => handed.push(look),
    },
  } as unknown as typeof window.madaniDesktop;
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  switching = null;
  delete (window as { madaniDesktop?: unknown }).madaniDesktop;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("the boot cover on a switch of place", () => {
  it("covers the page the moment a switch begins, with nothing of the old page showing through", () => {
    render(false);
    expect(cover()).toBeNull();
    act(() => switching!(true));
    expect(cover()?.dataset.bootCover).toBe("loading");
    expect(cover()?.dataset.switching).toBe("true");
    expect(cover()?.className).toContain("bg-app");
  });

  it("hands the mascot on to the next page, from the start of its wait", () => {
    render(false);
    act(() => switching!(true));
    expect(handed).toHaveLength(1);
    expect(handed[0]).toMatchObject({ crew: loadingLaunch().crew, color: loadingLaunch().color });
    expect(handed[0]!.elapsed).toBeLessThan(50);
  });

  it("hops away and fades when main says the switch ended on this page", () => {
    render(false);
    act(() => switching!(true));
    act(() => switching!(false));
    act(() => { vi.advanceTimersByTime(2000); });
    expect(cover()).toBeNull();
  });

  it("stays while the page that opened is still loading its chats", () => {
    render(true);
    act(() => switching!(true));
    act(() => switching!(false));
    act(() => { vi.advanceTimersByTime(2000); });
    expect(cover()?.dataset.bootCover).toBe("loading");
  });
});

describe("the page a switch opened", () => {
  it("goes on with the mascot the page before handed on, already there", () => {
    const look = loadingLaunch(10_000, () => ({ crew: "pip", color: "green", mood: "thinking", elapsed: 900 }));
    expect(look).toMatchObject({ crew: "pip", color: "green", mood: "thinking", seen: true, start: 9_100 });
  });

  it("picks its own when nothing was handed on, or something malformed", () => {
    resetLoadingLaunch();
    expect(loadingLaunch(0, () => ({ crew: "<b>", color: "green", mood: "thinking", elapsed: 1 })).seen).toBe(false);
    resetLoadingLaunch();
    expect(loadingLaunch(0, () => null).start).toBe(0);
  });
});
