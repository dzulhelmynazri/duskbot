// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ state: {} as Record<string, unknown>, dispatch: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }),
}));

const { BotsElsewhere } = await import("./BotsElsewhere");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement, root: Root;
let finish: ((value: boolean) => void) | null = null;
const bridge = {
  state: vi.fn(async () => ({ places: [{ id: "srv", name: "instance-1", why: "moved" }], known: null })),
  open: vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; })),
  connect: vi.fn(async () => null),
  stay: vi.fn(async () => true),
  counts: vi.fn(async () => ({ srv: 3, bogus: -1 })),
};

const render = async () => { await act(async () => { root.render(createElement(BotsElsewhere)); }); };
const screen = () => host.querySelector("[data-elsewhere]");
const primary = () => host.querySelector<HTMLButtonElement>("button[data-place-row=server]")!;

const memoryStorage = () => { const kept = new Map<string, string>(); return { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => { kept.set(key, String(value)); }, removeItem: (key: string) => { kept.delete(key); }, clear: () => kept.clear() }; };
beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  fixture.state = { hydrated: true, connected: true, bots: [], appSettingsOpen: false, cloudAdd: null };
  (window as unknown as { madaniDesktop: unknown }).madaniDesktop = { elsewhere: bridge };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); finish = null; vi.clearAllMocks(); });

it("opening a place keeps this screen up until main answers, never this computer's empty page in between", async () => {
  await render();
  expect(screen()?.getAttribute("data-elsewhere")).toBe("bots-on");
  expect(host.querySelector("h1")?.textContent).toBe("Pick where to open");
  expect(host.querySelector("button[data-place-row=computer]")?.textContent).toContain("No bots");
  expect(primary().textContent).toContain("instance-1");
  expect(primary().textContent).toContain("3 bots");
  expect(primary().hasAttribute("data-lit")).toBe(true);
  await act(async () => { primary().click(); });
  expect(bridge.open).toHaveBeenCalledWith("srv");
  expect(screen()).not.toBeNull();
  expect(screen()?.getAttribute("aria-busy")).toBe("true");
  expect(primary().disabled).toBe(true);
  await act(async () => { finish?.(true); });
  expect(screen()?.getAttribute("aria-busy")).toBeNull();
  expect(primary().disabled).toBe(false);
});

it("steps aside while Settings is open, so connect a server shows the connect flow instead of this screen", async () => {
  fixture.state = { ...fixture.state, appSettingsOpen: true };
  await render();
  expect(screen()).toBeNull();
  fixture.state = { ...fixture.state, appSettingsOpen: false };
  await render();
  expect(screen()).not.toBeNull();
});

it("a place that fails to open says so under its row, and the row can be tried again", async () => {
  await render();
  await act(async () => { primary().click(); });
  await act(async () => { finish?.(false); });
  const note = host.querySelector("[data-row-note]");
  expect(note?.getAttribute("Role")).toBe("alert");
  expect(note?.textContent).toBe("Couldn't open instance-1. Check it's online and try again.");
  expect(primary().disabled).toBe(false);
  await act(async () => { primary().click(); });
  expect(bridge.open).toHaveBeenCalledTimes(2);
  expect(host.querySelector("[data-row-note]")).toBeNull();
  await act(async () => { finish?.(true); });
  expect(host.querySelector("[data-row-note]")).toBeNull();
});

it("this computer's row takes the person into this computer and stops offering the places", async () => {
  await render();
  const mac = host.querySelector<HTMLButtonElement>("button[data-place-row=computer]")!;
  expect(mac.disabled).toBe(false);
  await act(async () => { mac.click(); });
  expect(bridge.stay).toHaveBeenCalledTimes(1);
  expect(bridge.open).not.toHaveBeenCalled();
  expect(screen()).toBeNull();
  // a page loaded later, after the choice, never shows the picker again
  act(() => root.unmount());
  root = createRoot(host);
  await render();
  expect(screen()).toBeNull();
});

it("never shows the picker once main says a place was already chosen", async () => {
  bridge.state.mockResolvedValueOnce({ places: [{ id: "srv", name: "instance-1", why: "moved" }], known: null, chosen: true } as never);
  await render();
  expect(screen()).toBeNull();
});

it("adding a place opens the guided setup, not Settings", async () => {
  await render();
  await act(async () => { host.querySelector<HTMLButtonElement>("[data-settings-open=add-workspace]")!.click(); });
  expect(fixture.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "toggleAppSettings" }));
  const { usePlaceSetupOpen, closePlaceSetup } = await import("@/lib/place-setup");
  let open: ReturnType<typeof usePlaceSetupOpen> = null;
  function Probe() { open = usePlaceSetupOpen(); return null; }
  await act(async () => { root.render(createElement(Probe)); });
  expect(open, "the first choice, not a click event as its start").toEqual({});
  closePlaceSetup();
});

it("the add-a-place sheet opens over the picker and closing it returns there, not to this computer's empty app", async () => {
  await render();
  await act(async () => { host.querySelector<HTMLButtonElement>("[data-settings-open=add-workspace]")!.click(); });
  expect(screen()?.getAttribute("data-elsewhere")).toBe("bots-on");
  const { closePlaceSetup } = await import("@/lib/place-setup");
  await act(async () => { closePlaceSetup(); });
  expect(screen()?.getAttribute("data-elsewhere")).toBe("bots-on");
});
