// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Toast } from "@/components/ui/Toast";
import { DESKTOP_MOTION } from "./desktop-motion";
import { playGhostExit } from "./ghost-exit";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let finish: () => void = () => {};
beforeEach(() => {
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  HTMLElement.prototype.animate = vi.fn(() => ({ finished }) as unknown as Animation);
});
afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

it("plays the way out on an inert copy with no ids, then removes it", async () => {
  const host = document.body.appendChild(document.createElement("div"));
  const el = document.createElement("div");
  el.id = "palette";
  el.innerHTML = '<button id="row-1">madani bot</button>';
  playGhostExit(el, host, (ghost) => [ghost.animate([{ opacity: 1 }, { opacity: 0 }], 100)]);
  const ghost = host.lastElementChild as HTMLElement;
  expect(ghost.getAttribute("aria-hidden")).toBe("true");
  expect(ghost.inert).toBe(true);
  expect(ghost.hasAttribute("data-exit-ghost")).toBe(true);
  expect(ghost.querySelector("[id]")).toBeNull();
  expect(ghost.id).toBe("");
  finish();
  await Promise.resolve();
  await Promise.resolve();
  expect(host.children).toHaveLength(0);
});

it("draws nothing into a host that has left the page", () => {
  const host = document.createElement("div");
  const play = vi.fn(() => []);
  playGhostExit(document.createElement("div"), host, play);
  expect(play).not.toHaveBeenCalled();
  expect(host.children).toHaveLength(0);
});

it("leaves only an inert copy of a closed toast, and only at a pick with a toast motion", () => {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(createElement(Toast, { text: "Archived travel", onDone: () => {} })));
  expect(document.querySelectorAll(".ui-toast")).toHaveLength(1);
  act(() => root.unmount());
  const left = [...document.querySelectorAll<HTMLElement>(".ui-toast")];
  expect(left).toHaveLength(DESKTOP_MOTION.toast ? 1 : 0);
  for (const ghost of left) {
    expect(ghost.inert).toBe(true);
    expect(ghost.getAttribute("aria-hidden")).toBe("true");
  }
});
