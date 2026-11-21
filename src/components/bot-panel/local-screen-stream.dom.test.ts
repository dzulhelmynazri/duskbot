// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { LIVE_FPS, LIVE_LINGER_MS, primeLiveScreen, resetLiveScreen, useLiveScreen } = await import("./local-screen-stream");

function fakeStream() {
  const track = { stop: vi.fn(), applyConstraints: vi.fn(() => Promise.resolve()), addEventListener: vi.fn() };
  return { track, stream: { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream };
}

let root: Root;
const seen: Record<string, ReturnType<typeof useLiveScreen>> = {};
function Viewer({ name, enabled, fps }: { name: string; enabled: boolean; fps: number }) {
  seen[name] = useLiveScreen(enabled, fps);
  return null;
}
const render = async (...viewers: Array<{ name: string; enabled: boolean; fps: number }>) => {
  await act(async () => { root.render(viewers.map((viewer) => createElement(Viewer, { key: viewer.name, ...viewer }))); });
};

let getDisplayMedia: ReturnType<typeof vi.fn>;
let made: ReturnType<typeof fakeStream>;
beforeEach(() => {
  vi.useFakeTimers();
  made = fakeStream();
  getDisplayMedia = vi.fn(() => Promise.resolve(made.stream));
  Object.defineProperty(navigator, "mediaDevices", { value: { getDisplayMedia }, configurable: true });
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
  resetLiveScreen();
  vi.useRealTimers();
  delete (window as { madaniDesktop?: unknown }).madaniDesktop;
  Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
});

describe("this computer's live screen", () => {
  it("starts without a click through the desktop app's live permission and shares one capture", async () => {
    const beginScreenLiveIntent = vi.fn(() => Promise.resolve(true));
    (window as { madaniDesktop?: unknown }).madaniDesktop = { screenLive: { begin: beginScreenLiveIntent } };
    await render({ name: "preview", enabled: true, fps: LIVE_FPS.preview }, { name: "full", enabled: true, fps: LIVE_FPS.full });
    expect(beginScreenLiveIntent).toHaveBeenCalledTimes(1);
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(getDisplayMedia.mock.calls[0][0]).toMatchObject({ audio: false, video: { frameRate: { max: LIVE_FPS.preview } } });
    expect(seen.preview).toMatchObject({ status: "live", stream: made.stream });
    expect(seen.full.stream).toBe(made.stream);
    expect(made.track.applyConstraints).toHaveBeenLastCalledWith({ frameRate: { ideal: LIVE_FPS.full, max: LIVE_FPS.full } });
  });

  it("slows down when nothing shows it and stops after the linger", async () => {
    (window as { madaniDesktop?: unknown }).madaniDesktop = { screenLive: { begin: () => Promise.resolve(true) } };
    await render({ name: "preview", enabled: true, fps: LIVE_FPS.preview });
    await render({ name: "preview", enabled: false, fps: LIVE_FPS.preview });
    expect(made.track.applyConstraints).toHaveBeenLastCalledWith({ frameRate: { ideal: 1, max: 1 } });
    expect(made.track.stop).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_LINGER_MS); });
    expect(made.track.stop).toHaveBeenCalled();
    expect(seen.preview).toMatchObject({ status: "idle", stream: null });
  });

  it("never captures unasked in an app without the live permission, but a click can start it", async () => {
    const beginScreenPreviewIntent = vi.fn(() => true);
    (window as { madaniDesktop?: unknown }).madaniDesktop = { beginScreenPreviewIntent };
    await render({ name: "preview", enabled: true, fps: LIVE_FPS.preview });
    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(seen.preview.status).toBe("idle");
    await act(async () => { primeLiveScreen(); });
    expect(beginScreenPreviewIntent).toHaveBeenCalledTimes(1);
    expect(seen.preview).toMatchObject({ status: "live", stream: made.stream });
  });

  it("survives a desktop app whose main process predates the live permission", async () => {
    const noHandler = new Error("Error invoking remote method 'screen:live-intent': Error: No handler registered for 'screen:live-intent'");
    const beginScreenPreviewIntent = vi.fn(() => true);
    (window as { madaniDesktop?: unknown }).madaniDesktop = { screenLive: { begin: vi.fn(() => Promise.reject(noHandler)) }, beginScreenPreviewIntent };
    await render({ name: "preview", enabled: true, fps: LIVE_FPS.preview });
    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(seen.preview).toMatchObject({ status: "failed", stream: null });
    await act(async () => { primeLiveScreen(); });
    expect(beginScreenPreviewIntent).toHaveBeenCalledTimes(1);
    expect(seen.preview).toMatchObject({ status: "live", stream: made.stream });
  });

  it("ignores a stale page bridge that only has the old synchronous live permission", async () => {
    const beginScreenLiveIntent = vi.fn(() => { throw new Error("no listeners"); });
    (window as { madaniDesktop?: unknown }).madaniDesktop = { beginScreenLiveIntent };
    await render({ name: "preview", enabled: true, fps: LIVE_FPS.preview });
    expect(beginScreenLiveIntent).not.toHaveBeenCalled();
    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(seen.preview.status).toBe("idle");
  });

  it("treats a live permission that throws or answers no as no live screen", async () => {
    (window as { madaniDesktop?: unknown }).madaniDesktop = { screenLive: { begin: () => { throw new Error("gone"); } } };
    await render({ name: "preview", enabled: true, fps: LIVE_FPS.preview });
    expect(seen.preview.status).toBe("failed");
    resetLiveScreen();
    (window as { madaniDesktop?: unknown }).madaniDesktop = { screenLive: { begin: () => Promise.resolve(false) } };
    await render({ name: "preview", enabled: false, fps: LIVE_FPS.preview });
    await render({ name: "preview", enabled: true, fps: LIVE_FPS.preview });
    expect(seen.preview.status).toBe("failed");
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });

  it("does not restart a capture that was stopped from outside", async () => {
    (window as { madaniDesktop?: unknown }).madaniDesktop = { screenLive: { begin: () => Promise.resolve(true) } };
    await render({ name: "preview", enabled: true, fps: LIVE_FPS.preview });
    const ended = made.track.addEventListener.mock.calls.find(([type]) => type === "ended")?.[1] as () => void;
    await act(async () => { ended(); });
    expect(seen.preview.status).toBe("failed");
    await render({ name: "preview", enabled: false, fps: LIVE_FPS.preview });
    await render({ name: "preview", enabled: true, fps: LIVE_FPS.preview });
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
  });
});
