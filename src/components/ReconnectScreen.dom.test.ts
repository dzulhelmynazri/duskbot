// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReconnectBridge, ReconnectView } from "../../electron/workspace-reconnect.mjs";
import { setLocale } from "@/lib/i18n";
import { ReconnectScreen, reconnectText, secondsLeft } from "./ReconnectScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root | null = null;
const settle = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
const NOW = 1_800_000_000_000;
const VIEW: ReconnectView = {
  name: "Garage server", host: "garage.example.net", attempt: 2, nextAt: NOW + 8_000, checking: false,
  frame: { at: NOW - 60_000, bots: [{ id: "b1", name: "Research", chats: [{ id: "t1", title: "Flights to Goa" }, { id: "t2", title: "" }] }], groups: [{ id: "g1", name: "Launch room" }] },
  places: [{ id: "local", name: "This computer", local: true }, { id: "office", name: "Office" }],
};
function bridgeOf(view: ReconnectView | null) {
  let push: (next: ReconnectView | null) => void = () => {};
  const bridge = { state: vi.fn(async () => view), onState: vi.fn((cb: (next: ReconnectView | null) => void) => { push = cb; return () => {}; }), retry: vi.fn(async () => view), open: vi.fn(async () => {}), remove: vi.fn(async () => {}) } satisfies ReconnectBridge;
  return { bridge, push: (next: ReconnectView | null) => act(async () => push(next)) };
}
beforeEach(() => { setLocale("en"); vi.useFakeTimers({ now: NOW, toFake: ["Date", "setInterval", "clearInterval"] }); host = document.createElement("div"); document.body.append(host); });
afterEach(async () => { await act(async () => root?.unmount()); root = null; host.remove(); vi.useRealTimers(); });

it("says who it waits on and counts down to the next look", () => {
  expect(reconnectText(VIEW, NOW)).toEqual({ title: "Reconnecting to Garage server", next: "Next try in 8s." });
  expect(secondsLeft(VIEW, NOW + 7_400)).toBe(1);
  expect(secondsLeft(VIEW, NOW + 20_000), "never below zero").toBe(0);
  expect(reconnectText({ ...VIEW, checking: true, nextAt: null }, NOW).next).toBe("Looking for it now…");
  expect(reconnectText(null).title).toBe("Opening…");
});

it("shows the last-seen chats read only, Try now, and the other workspaces to open", async () => {
  const { bridge, push } = bridgeOf(VIEW);
  root = createRoot(host);
  await act(async () => { root!.render(createElement(ReconnectScreen, { bridge })); });
  await settle();
  expect(host.querySelector("[role='status']")?.textContent).toBe("Reconnecting to Garage server");
  expect(host.querySelector("[data-reconnect-next]")?.textContent).toBe("Next try in 8s.");
  await act(async () => { vi.advanceTimersByTime(3_000); });
  expect(host.querySelector("[data-reconnect-next]")?.textContent).toBe("Next try in 5s.");
  const frame = host.querySelector("[data-reconnect-frame]")!;
  expect(frame.textContent).toContain("Flights to Goa");
  expect(frame.textContent, "an untitled chat still has a name").toContain("New conversation");
  expect(frame.textContent).toContain("Launch room");
  expect(frame.querySelectorAll("button, a, input"), "nothing in the frame does anything").toHaveLength(0);
  host.querySelector<HTMLButtonElement>("[data-reconnect-retry]")!.click();
  await settle();
  expect(bridge.retry).toHaveBeenCalledTimes(1);
  expect([...host.querySelectorAll("[data-reconnect-open]")].map((button) => button.textContent)).toEqual(["This computer", "Office"]);
  host.querySelector<HTMLButtonElement>("[data-reconnect-open='office']")!.click();
  expect(bridge.open).toHaveBeenCalledWith("office");
  await push({ ...VIEW, checking: true, nextAt: null });
  expect(host.querySelector("[data-reconnect-next]")?.textContent).toBe("Looking for it now…");
  expect(host.querySelector<HTMLButtonElement>("[data-reconnect-retry]")?.disabled).toBe(true);
});

it("with nothing kept yet there is no list, only the wait", async () => {
  const { bridge } = bridgeOf({ ...VIEW, frame: undefined, places: [] });
  root = createRoot(host);
  await act(async () => { root!.render(createElement(ReconnectScreen, { bridge })); });
  await settle();
  expect(host.querySelector("[data-reconnect-frame]")).toBeNull();
  expect(host.querySelector("[data-reconnect-places]")).toBeNull();
  expect(host.querySelector("[role='status']")?.textContent).toBe("Reconnecting to Garage server");
});

it("a server added by hand that never answered says it can't be reached yet, never that nothing is lost, and may be removed", async () => {
  const { bridge } = bridgeOf({ ...VIEW, frame: undefined, neverConnected: true });
  expect(reconnectText({ ...VIEW, neverConnected: true }, NOW).title).toBe("Can't reach Garage server yet");
  root = createRoot(host);
  await act(async () => { root!.render(createElement(ReconnectScreen, { bridge })); });
  await settle();
  expect(host.querySelector("[role='status']")?.textContent).toBe("Can't reach Garage server yet");
  expect(host.textContent).toContain("Nothing has answered at garage.example.net so far.");
  expect(host.textContent).not.toContain("Nothing is lost");
  expect(host.querySelector("[data-reconnect-retry]")).not.toBeNull();
  host.querySelector<HTMLButtonElement>("[data-reconnect-remove]")!.click();
  expect(bridge.remove).toHaveBeenCalledTimes(1);
});

it("a server that connected before offers no remove on its wait", async () => {
  const { bridge } = bridgeOf(VIEW);
  root = createRoot(host);
  await act(async () => { root!.render(createElement(ReconnectScreen, { bridge })); });
  await settle();
  expect(host.querySelector("[data-reconnect-remove]")).toBeNull();
  expect(host.textContent).toContain("Nothing is lost");
});

it("a madani cloud that was deleted says so once: no countdown, no Try now, only Remove and the other places", async () => {
  const { bridge } = bridgeOf({ ...VIEW, gone: true, nextAt: null, checking: false });
  expect(reconnectText({ ...VIEW, gone: true }, NOW)).toEqual({ title: "Garage server was deleted", next: null });
  root = createRoot(host);
  await act(async () => { root!.render(createElement(ReconnectScreen, { bridge })); });
  await settle();
  expect(host.querySelector("[role='status']")?.textContent).toBe("Garage server was deleted");
  expect(host.textContent).toContain("no longer exists");
  expect(host.querySelector("[data-reconnect-retry]")).toBeNull();
  expect(host.querySelector("[data-reconnect-next]")).toBeNull();
  expect(host.querySelector("[data-reconnect-places]")).not.toBeNull();
  host.querySelector<HTMLButtonElement>("[data-reconnect-remove]")!.click();
  expect(bridge.remove).toHaveBeenCalledTimes(1);
});
