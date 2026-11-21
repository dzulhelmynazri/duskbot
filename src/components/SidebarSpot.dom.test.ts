// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppUpdateState } from "../../electron/app-update.mjs";
import { closeFeedback, useFeedbackOpen } from "@/lib/feedback-sheet";
import { RailSpot, SidebarSpot, UpdatedNote, type SpotCta } from "./SidebarSpot";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let tell: (state: AppUpdateState) => void = () => {};
let now: AppUpdateState = { ready: null, available: null, progress: null };
const bridge = {
  state: vi.fn(async () => now),
  restart: vi.fn(async () => true),
  download: vi.fn(async () => "0.2.7" as string | null),
  open: vi.fn(async () => true),
  move: vi.fn(async () => true),
  onState: vi.fn((cb: (state: AppUpdateState) => void) => { tell = cb; return () => {}; }),
};
const openExternal = vi.fn(async () => true);
let opened = false;
function Probe() { opened = useFeedbackOpen(); return null; }

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  now = { ready: null, available: null, progress: null, mode: "self" };
  (window as unknown as { madaniDesktop: unknown }).madaniDesktop = { appUpdate: bridge, openExternal };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.clearAllMocks(); closeFeedback(); });

const spot = () => host.querySelector<HTMLButtonElement>("[data-sidebar-spot]");
const mount = async (component: typeof SidebarSpot | typeof RailSpot = SidebarSpot) => {
  await act(async () => { root.render([createElement(component, { key: "spot" }), createElement(Probe, { key: "probe" })]); });
};
const hear = async (state: AppUpdateState) => { await act(async () => { tell(state); }); };

describe("the sidebar's feedback and update spot", () => {
  it("is Give feedback until an update comes, and a click opens the feedback sheet", async () => {
    await mount();
    expect(spot()?.dataset.sidebarSpot).toBe("feedback");
    expect(spot()?.textContent).toBe("Give feedback");
    await act(async () => { spot()!.click(); });
    expect(opened).toBe(true);
  });

  it("on a mac that installs its own: the found update, its download, then Restart to update with its version", async () => {
    await mount();
    await hear({ ready: null, available: "0.2.7", progress: null, mode: "self" });
    expect(spot()?.dataset.appUpdateState).toBe("available");
    expect(spot()?.textContent).toBe("Update to 0.2.7");
    await hear({ ready: null, available: "0.2.7", progress: 0.4, mode: "self" });
    expect(spot()?.textContent).toBe("Downloading update40%");
    expect(spot()?.getAttribute("aria-busy")).toBe("true");
    await hear({ ready: "0.2.7", available: "0.2.7", progress: null, mode: "self" });
    expect(spot()?.dataset.sidebarSpot).toBe("update");
    expect(spot()?.textContent).toBe("Restart to update0.2.7");
    await act(async () => { spot()!.click(); });
    expect(bridge.restart).toHaveBeenCalledTimes(1);
    await hear({ ready: null, available: null, progress: null, mode: "self" });
    expect(spot()?.dataset.sidebarSpot).toBe("feedback");
  });

  it("a click on a found update downloads it, then restarts into it once it's ready", async () => {
    now = { ready: null, available: "0.2.7", progress: null, mode: "self" };
    await mount();
    await act(async () => { spot()!.click(); });
    expect(bridge.download).toHaveBeenCalledTimes(1);
    expect(spot()?.dataset.appUpdateState).toBe("downloading");
    await hear({ ready: "0.2.7", available: "0.2.7", progress: null, mode: "self" });
    expect(bridge.restart).toHaveBeenCalledTimes(1);
  });

  it("a download that failed says so and offers madani.bot, instead of trying again in silence", async () => {
    now = { ready: null, available: "0.2.7", progress: null, mode: "self" };
    bridge.download.mockImplementationOnce(async () => { tell({ ready: null, available: "0.2.7", progress: null, checking: false, failed: true, mode: "self" }); return null; });
    await mount();
    await act(async () => { spot()!.click(); });
    expect(spot()?.dataset.appUpdateState).toBe("failed");
    expect(spot()?.textContent).toBe("Download from madani.bot0.2.7");
    await act(async () => { spot()!.click(); });
    expect(bridge.open).toHaveBeenCalledTimes(1);
    expect(bridge.download).toHaveBeenCalledTimes(1);
  });

  it("a dropped connection shows the paused download with how far it got, then picks up", async () => {
    await mount();
    await hear({ ready: null, available: "0.2.7", progress: 0.42, retrying: true, checking: true, mode: "self" });
    expect(spot()?.dataset.appUpdateState).toBe("retrying");
    expect(spot()?.textContent).toBe("Retrying download42%");
    expect(spot()?.getAttribute("aria-busy")).toBe("true");
    await hear({ ready: null, available: "0.2.7", progress: 0.43, retrying: false, checking: true, mode: "self" });
    expect(spot()?.textContent).toBe("Downloading update43%");
  });

  it("a press shows the check at once, even before a version is known", async () => {
    now = { ready: null, available: "0.2.7", progress: null, mode: "self" };
    bridge.download.mockImplementationOnce(() => new Promise(() => {}));
    await mount();
    await act(async () => { spot()!.click(); });
    await hear({ ready: null, available: null, progress: null, checking: true, mode: "self" });
    expect(spot()?.dataset.appUpdateState).toBe("checking");
    expect(spot()?.textContent).toBe("Checking for updates");
  });

  it("a mac running from Downloads or a disk image is asked to move to Applications", async () => {
    now = { ready: null, available: "0.2.7", progress: null, blocked: "move", mode: "self" };
    await mount();
    expect(spot()?.dataset.appUpdateState).toBe("move");
    expect(spot()?.textContent).toBe("Move to Applications0.2.7");
    await act(async () => { spot()!.click(); });
    expect(bridge.move).toHaveBeenCalledTimes(1);
    expect(bridge.download).not.toHaveBeenCalled();
  });

  it("on Windows and Linux: Download with its version, which opens that installer", async () => {
    now = { ready: null, available: "0.2.7", progress: null, mode: "notice", manual: { version: "0.2.7", url: "https://madani.bot/releases/0.2.7/MadaniBot-0.2.7-setup.exe" } };
    await mount();
    expect(spot()?.dataset.appUpdateState).toBe("manual");
    expect(spot()?.textContent).toBe("Download 0.2.7");
    await act(async () => { spot()!.click(); });
    expect(bridge.open).toHaveBeenCalledTimes(1);
    expect(bridge.download).not.toHaveBeenCalled();
    expect(bridge.restart).not.toHaveBeenCalled();
  });

  it("stays Give feedback when nothing newer is out", async () => {
    now = { ready: null, available: null, mode: "notice", manual: null };
    await mount();
    expect(spot()?.dataset.sidebarSpot).toBe("feedback");
  });

  it("is Give feedback on a page that isn't this computer's own, and in a browser", async () => {
    (window as unknown as { madaniDesktop: unknown }).madaniDesktop = { appUpdate: bridge, remoteClient: { active: true } };
    now = { ready: "0.2.7", available: "0.2.7", progress: null, mode: "self" };
    await mount();
    expect(spot()?.dataset.sidebarSpot).toBe("feedback");
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    (window as unknown as { madaniDesktop: unknown }).madaniDesktop = undefined;
    await mount();
    expect(spot()?.dataset.sidebarSpot).toBe("feedback");
  });

  it("the collapsed sidebar keeps no Give feedback, only an update as one named round button", async () => {
    await mount(RailSpot);
    expect(spot()).toBeNull();
    await hear({ ready: "0.2.7", available: "0.2.7", progress: null, mode: "self" });
    expect(spot()?.getAttribute("aria-label")).toBe("Restart to update, 0.2.7");
    await act(async () => { spot()!.click(); });
    expect(bridge.restart).toHaveBeenCalledTimes(1);
  });

  describe("an offer in Give feedback's place", () => {
    const started = vi.fn();
    /** the footer's side: the offer holds until its close ends it, as the madani cloud nudge does */
    function WithOffer() {
      const [on, setOn] = useState(true);
      const cta: SpotCta | null = on ? { id: "cloud", title: "Keep your bots working", hint: "On madani cloud, they keep replying", art: "clock", closeLabel: "Hide",
        onStart: started, onClose: () => setOn(false) } : null;
      return createElement(SidebarSpot, { cta });
    }
    const mountOffer = async () => { await act(async () => { root.render([createElement(WithOffer, { key: "spot" }), createElement(Probe, { key: "probe" })]); }); };
    const close = () => host.querySelector<HTMLButtonElement>("[data-spot-cta-close]");

    it("shows the offer as the same one-line card, and its press is the offer's", async () => {
      await mountOffer();
      expect(spot()?.dataset.sidebarSpot).toBe("cta");
      expect(spot()?.dataset.spotCta).toBe("cloud");
      expect(host.textContent).toBe("Keep your bots working");
      expect(host.querySelector("[data-sidebar-spot='feedback']")).toBeNull();
      await act(async () => { host.querySelector<HTMLButtonElement>("[data-spot-cta-start]")!.click(); });
      expect(started).toHaveBeenCalledTimes(1);
      expect(opened).toBe(false);
    });

    it("its close is a named button beside the card, and closing brings Give feedback back", async () => {
      await mountOffer();
      expect(close()?.getAttribute("aria-label")).toBe("Hide");
      expect(close()?.closest("[data-spot-cta-start]")).toBeNull();
      await act(async () => { close()!.click(); });
      expect(started).not.toHaveBeenCalled();
      expect(spot()?.dataset.sidebarSpot).toBe("feedback");
      expect(spot()?.textContent).toBe("Give feedback");
    });

    it("an update goes first, and the offer is back once it's gone", async () => {
      await mountOffer();
      await hear({ ready: "0.2.7", available: "0.2.7", progress: null, mode: "self" });
      expect(spot()?.dataset.sidebarSpot).toBe("update");
      await hear({ ready: null, available: null, progress: null, mode: "self" });
      expect(spot()?.dataset.sidebarSpot).toBe("cta");
    });
  });
});

describe("the updated note", () => {
  it("goes away on its own 20 seconds after launch", () => {
    vi.useFakeTimers();
    const seen = vi.fn();
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(createElement(UpdatedNote, { version: "0.2.16", seen })));
    act(() => { vi.advanceTimersByTime(19_000); });
    expect(seen).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1_500); });
    expect(seen).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    vi.useRealTimers();
  });
});
