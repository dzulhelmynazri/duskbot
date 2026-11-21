// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MacPermissionsBridge } from "@/lib/mac-permissions";

const fixture = vi.hoisted(() => ({ localMessage: "" }));
vi.mock("../DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("../DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ ready: true, capabilities: { dictation: { available: false }, host: { packaged: false, platform: "darwin" },
    localComputer: fixture.localMessage ? { available: false, message: fixture.localMessage } : { available: true } } }),
}));

const { MacPermissionsDialog } = await import("./PermissionsStep");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const openSettings = vi.fn(async () => undefined);
let root: ReturnType<typeof createRoot> | null = null;
const show = async (bridge: MacPermissionsBridge) => {
  document.body.innerHTML = "";
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => { root!.render(createElement(MacPermissionsDialog, { bridge, onClose: () => undefined })); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};
const button = (kind: string) => document.querySelector<HTMLButtonElement>(`[data-permission-ask="${kind}"]`)!;

beforeEach(() => {
  fixture.localMessage = "";
  openSettings.mockClear();
  (window as unknown as { madaniDesktop: unknown }).madaniDesktop = { platform: "darwin", permOpenSettings: openSettings, localControl: { retry: vi.fn(async () => ({})) } };
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; });

describe("the permissions modal's Allow buttons", () => {
  it("stay pressable when the app cannot read the grants, and open the permission's own pane", async () => {
    const failing = { status: vi.fn(() => Promise.reject(new Error("No handler registered"))), request: vi.fn(() => Promise.reject(new Error("No handler registered"))) };
    await show(failing);
    expect(button("accessibility").disabled).toBe(false);
    expect(button("screen").disabled).toBe(false);
    await act(async () => button("screen").click());
    expect(openSettings).toHaveBeenCalledWith("screen");
  });

  it("follow CuaDriver's own grants for a copy run from source, opening its pane and saying to turn it on", async () => {
    fixture.localMessage = "Screen Recording required for CuaDriver; turn on CuaDriver in System Settings > Privacy & Security";
    const bridge = { status: vi.fn(async () => ({ supported: true as const, accessibility: "granted" as const, screen: "granted" as const })), request: vi.fn() };
    await show(bridge);
    expect(document.querySelector('[data-permission="screen"]')!.getAttribute("data-permission-state")).toBe("missing");
    expect(document.querySelector('[data-permission="accessibility"]')!.getAttribute("data-permission-state")).toBe("granted");
    expect(document.body.textContent).toContain("Turn on CuaDriver in the list that opens");
    await act(async () => button("screen").click());
    expect(openSettings).toHaveBeenCalledWith("screen");
    expect(bridge.request).not.toHaveBeenCalled();
  });
});
