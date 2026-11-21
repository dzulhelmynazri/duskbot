// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RailState } from "../../electron/cloud-rail.mjs";
import { setLocale } from "@/lib/i18n";
import { refreshPlaces } from "@/lib/places";

const store = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: store.state, dispatch: vi.fn() }),
  api: vi.fn(async () => ({ hits: [] })),
}));
const { SidebarPlaceButton, placeKind, switchPlaceCommand } = await import("./SidebarPlaceButton");
const { CommandPalette } = await import("./CommandPalette");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type Current = { local: boolean; name: string; origin?: string; home?: boolean; role?: string };
let current: Current;
let rail: RailState;
const workspaces = { state: vi.fn(async () => current), menu: vi.fn(async (): Promise<void> => {}), places: vi.fn(async () => rail), onChanged: vi.fn(() => () => {}) };
let host: HTMLDivElement, root: Root | null = null;

async function mount(element = createElement(SidebarPlaceButton)) {
  root = createRoot(host);
  await act(async () => { await refreshPlaces(); root!.render(element); });
  await act(async () => { await Promise.resolve(); });
}
const button = () => host.querySelector<HTMLButtonElement>("[data-sidebar-place] button");

beforeEach(() => {
  setLocale("en");
  current = { local: true, name: "This computer" };
  rail = { places: [], add: { cloud: false, link: false, address: false } };
  store.state = { config: {}, hydrated: true, connected: true, bots: [], groups: [], selectedId: null };
  Object.assign(window, { madaniDesktop: { workspaces } });
  vi.clearAllMocks();
  try { localStorage.removeItem("madani-place-dot-seen"); } catch { /* no storage */ }
  host = document.createElement("div"); document.body.append(host);
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; host.remove(); document.body.innerHTML = ""; });

it("names what the place on screen is: this computer, a Cloud (My Cloud, a team's, home) or a server connected by hand", () => {
  expect(placeKind({ local: true })).toBe("computer");
  expect(placeKind(null, { cloudHome: true })).toBe("cloud");
  expect(placeKind({ local: false }, { cloudHome: true })).toBe("cloud");
  expect(placeKind({ local: false, role: "member" })).toBe("cloud");
  expect(placeKind({ local: false }, { team: true })).toBe("cloud");
  expect(placeKind({ local: false, home: true })).toBe("cloud");
  expect(placeKind({ local: false })).toBe("server");
});

it("one round button like search and +: the place's icon, an online dot, and its name and status for a screen reader", async () => {
  await mount();
  const control = button()!;
  expect(control.className).toContain("rounded-full");
  expect(control.className).toContain("size-10");
  expect(control.getAttribute("aria-haspopup")).toBe("menu");
  expect(control.getAttribute("aria-label")).toBe("Switch server: This computer · Online");
  expect(control.querySelector("[data-icon-name]")?.getAttribute("data-icon-name")).toBe("laptop");
  expect(control.querySelector("[data-place-dot]")?.className).toContain("bg-success");
});

it("a click opens main's native list of places, the one switch every place shares; the page never reads the list", async () => {
  await mount();
  await act(async () => { button()!.click(); await Promise.resolve(); });
  expect(workspaces.menu).toHaveBeenCalledTimes(1);
  expect(workspaces.places.mock.calls.length, "only the rail's own check, never to draw a list here").toBeLessThanOrEqual(1);
  expect(host.querySelectorAll("[role=menuitem]")).toHaveLength(0);
});

it("a server connected by hand shows the server icon and its address in the tooltip", async () => {
  current = { local: false, name: "Office", origin: "https://office.example.test" };
  await mount();
  expect(button()!.getAttribute("data-place-kind")).toBe("server");
  expect(button()!.querySelector("[data-icon-name]")?.getAttribute("data-icon-name")).toBe("server");
  expect(button()!.title).toBe("Office · Online · https://office.example.test");
});

it("offline once the network goes, said in words as well as the dot", async () => {
  await mount();
  await act(async () => { window.dispatchEvent(new Event("offline")); });
  expect(button()!.getAttribute("data-place-status")).toBe("offline");
  expect(button()!.getAttribute("aria-label")).toBe("Switch server: This computer · Offline");
  expect(button()!.querySelector("[data-place-dot]")?.className).toContain("bg-danger");
  await act(async () => { window.dispatchEvent(new Event("online")); });
  expect(button()!.getAttribute("data-place-status")).toBe("online");
});

it("says so when main can't open the list", async () => {
  workspaces.menu.mockRejectedValueOnce(new Error("no"));
  await mount();
  await act(async () => { button()!.click(); await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
  expect(host.querySelector("[role=alert]")?.textContent).toBe("Could not open the server list. Try the server menu.");
});

it("My Cloud as home with nothing else still shows the place button, a cloud, which opens the list; nothing in a browser", async () => {
  current = { local: false, name: "My Cloud", home: true };
  await mount();
  const control = button()!;
  expect(control.getAttribute("data-place-kind")).toBe("cloud");
  expect(control.innerHTML).toContain("cloud");
  await act(async () => control.click());
  expect(workspaces.menu).toHaveBeenCalledTimes(1);
  await act(async () => root?.unmount());
  Object.assign(window, { madaniDesktop: undefined });
  await mount();
  expect(host.querySelector("[data-sidebar-place]")).toBeNull();
  expect(switchPlaceCommand()).toBeNull();
});

it("this computer shows the laptop, a cloud window the cloud", async () => {
  await mount();
  expect(button()!.getAttribute("data-place-kind")).toBe("computer");
  await act(async () => root?.unmount());
  current = { local: false, name: "My Cloud" };
  store.state = { ...store.state, config: { cloudHome: true } };
  await mount();
  expect(button()!.getAttribute("data-place-kind")).toBe("cloud");
});

it("stays in the header beside the window's rail of places too: never hidden", async () => {
  rail = { places: [], add: { cloud: false, link: false, address: false }, beside: true };
  await mount();
  expect(host.querySelector("[data-switcher-beside-rail]")).toBeNull();
  expect(button()).not.toBeNull();
});

it("⌘K finds it as switch place, or by typing workspace, and opens the same native list", async () => {
  await mount(createElement(CommandPalette));
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true })); });
  const input = host.querySelector<HTMLInputElement>("input")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, "workspace"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  const row = [...host.querySelectorAll("button")].find((entry) => entry.textContent?.includes("Switch place"));
  expect(row).toBeTruthy();
  await act(async () => { row!.click(); await Promise.resolve(); });
  expect(workspaces.menu).toHaveBeenCalledTimes(1);
});

it("the green dot goes once the list of places has been opened, and stays gone; a red one still shows", async () => {
  await mount();
  expect(button()!.querySelector("[data-place-dot]")).not.toBeNull();
  await act(async () => { button()!.click(); await Promise.resolve(); });
  expect(button()!.querySelector("[data-place-dot]")).toBeNull();
  await act(async () => { window.dispatchEvent(new Event("offline")); });
  expect(button()!.querySelector("[data-place-dot]")?.className).toContain("bg-danger");
  await act(async () => { window.dispatchEvent(new Event("online")); });
  await act(async () => root?.unmount()); root = null;
  await mount();
  const storage = (() => { try { return typeof localStorage?.getItem === "function"; } catch { return false; } })();
  if (storage) expect(button()!.querySelector("[data-place-dot]")).toBeNull();
});
