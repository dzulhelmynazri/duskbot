// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const local = vi.hoisted(() => ({ openPlaceSetup: vi.fn() }));
vi.mock("@/lib/place-setup", () => ({ openPlaceSetup: local.openPlaceSetup }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ ready: true, capabilities: { host: { platform: "darwin" }, localComputer: { available: true } } }) }));

vi.mock("@/state/store", async importOriginal => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: original.initialState, dispatch: vi.fn() }) };
});

const { LocalComputerSection } = await import("./LocalComputerSection");

afterEach(() => {
  delete window.madaniDesktop;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("loads only local and VPS inventories and offers the existing VPS setup flow", async () => {
  vi.useFakeTimers();
  window.madaniDesktop = { localControl: { retry: vi.fn() } } as any;
  const paths: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    paths.push(path);
    if (path === "/api/local-computer") return new Response(JSON.stringify({
      mode: "shared", container: "missing", ready: false, commands: {},
    }));
    if (path === "/api/computers/vps") return new Response(JSON.stringify({
      configured: false, available: false, instances: [], vpsAliases: [], problem: null,
    }));
    throw new Error(`Unexpected fixture request: ${path}`);
  }));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(LocalComputerSection)); });
    // the server's own description (server-compat), read once for the egress row, and the two inventories
    expect(paths.sort()).toEqual(["/.well-known/madanibot/environment", "/.well-known/openmausbot/environment", "/api/computer/egress", "/api/computers/vps", "/api/local-computer", "/api/mac"]);
    expect(container.textContent).toContain("Add your own server");
    expect(local.openPlaceSetup).not.toHaveBeenCalled();
    expect(container.textContent).not.toMatch(/\x42oat|credit|cloud desktop/i);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(paths.filter(path => path === "/api/local-computer")).toHaveLength(2);
    expect(paths.some(path => path.includes("/boxes"))).toBe(false);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
