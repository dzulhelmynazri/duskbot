// @vitest-environment happy-dom
// The Computer tab's screen in a real DOM, where effects run: this computer through the desktop app's frame, Auto asked
// of the server, and Off showing nothing.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({ api: vi.fn(), platform: "darwin" as string, flush: () => Promise.resolve(null) }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: (...args: unknown[]) => fixture.api(...args),
  useStore: () => ({ flushBotPatches: fixture.flush }),
}));
vi.mock("@/lib/live-events", () => ({ listenLiveFrames: () => () => {} }));
vi.mock("../DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: { host: { platform: fixture.platform } }, ready: true }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { useBotScreen, LOCAL_FRAME_MS, LOCAL_MISSES } = await import("./bot-screen");
const { resetLiveScreen } = await import("./local-screen-stream");

const bot = (extra: Partial<Bot> = {}): Bot => ({
  id: "juno", threadId: "t1", name: "Juno", title: "", description: "", soul: "", notifications: true, color: "green", unread: false,
  messages: [], modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, ...extra,
});

let root: Root;
let seen: ReturnType<typeof useBotScreen>;
function Probe({ value, visible }: { value: Bot; visible?: boolean }) {
  seen = useBotScreen(value, { visible });
  return null;
}
const render = async (value: Bot, visible?: boolean) => {
  await act(async () => { root.render(createElement(Probe, { value, visible })); });
};

beforeEach(() => {
  vi.useFakeTimers();
  fixture.platform = "darwin";
  fixture.api.mockReset();
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
  resetLiveScreen();
  vi.useRealTimers();
  delete (window as { madaniDesktop?: unknown }).madaniDesktop;
  Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
});

describe("the bot's screen", () => {
  it("shows this computer's own screen and keeps it fresh while it shows", async () => {
    const screenFrame = vi.fn().mockResolvedValueOnce("data:image/png;base64,AAA").mockResolvedValue("data:image/png;base64,BBB");
    (window as { madaniDesktop?: unknown }).madaniDesktop = { screenFrame };
    await render(bot({ computer: "local" }));
    expect(seen).toMatchObject({ place: "local", src: "data:image/png;base64,AAA", loading: false, blocked: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(LOCAL_FRAME_MS); });
    expect(seen.src).toBe("data:image/png;base64,BBB");
    act(() => root.unmount());
    const calls = screenFrame.mock.calls.length;
    await vi.advanceTimersByTimeAsync(LOCAL_FRAME_MS * 3);
    expect(screenFrame.mock.calls.length).toBe(calls);
    root = createRoot(document.createElement("div"));
  });

  it("streams this computer live instead of taking frames, only while the screen shows", async () => {
    const track = { stop: vi.fn(), applyConstraints: vi.fn(() => Promise.resolve()), addEventListener: vi.fn() };
    const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
    const getDisplayMedia = vi.fn(() => Promise.resolve(stream));
    Object.defineProperty(navigator, "mediaDevices", { value: { getDisplayMedia }, configurable: true });
    const screenFrame = vi.fn().mockResolvedValue("data:image/png;base64,AAA");
    (window as { madaniDesktop?: unknown }).madaniDesktop = { screenFrame, screenLive: { begin: () => Promise.resolve(true) } };
    await render(bot({ computer: "local" }), false);
    expect(getDisplayMedia).not.toHaveBeenCalled();
    await render(bot({ computer: "local" }), true);
    expect(seen).toMatchObject({ place: "local", stream, src: null, loading: false, blocked: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(LOCAL_FRAME_MS * 3); });
    expect(screenFrame).not.toHaveBeenCalled();
  });

  it("falls back to taking frames when the desktop app's main process cannot grant a live screen", async () => {
    Object.defineProperty(navigator, "mediaDevices", { value: { getDisplayMedia: vi.fn() }, configurable: true });
    const screenFrame = vi.fn().mockResolvedValue("data:image/png;base64,AAA");
    (window as { madaniDesktop?: unknown }).madaniDesktop = { screenFrame, screenLive: { begin: () => Promise.reject(new Error("No handler registered for 'screen:live-intent'")) } };
    await render(bot({ computer: "local" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(seen).toMatchObject({ place: "local", stream: null, src: "data:image/png;base64,AAA", blocked: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(LOCAL_FRAME_MS); });
    expect(screenFrame.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("calls this computer's screen blocked after empty frames, never an older posted one", async () => {
    (window as { madaniDesktop?: unknown }).madaniDesktop = { screenFrame: vi.fn().mockResolvedValue(null) };
    await render(bot({ computer: "local", messages: [{ id: "m1", role: "assistant", kind: "screen", hasImage: true, mime: "image/png", text: "", at: 0 }] as unknown as Bot["messages"] }));
    expect(seen).toMatchObject({ src: null, loading: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(LOCAL_FRAME_MS * (LOCAL_MISSES - 1)); });
    expect(seen).toMatchObject({ src: null, loading: false, blocked: true });
  });

  it("does not try to show this computer outside the desktop app", async () => {
    await render(bot({ computer: "local" }));
    expect(seen).toMatchObject({ place: "local", src: null, loading: false, blocked: false });
  });

  it("asks the server which place Auto picked", async () => {
    fixture.api.mockResolvedValue({ surface: "cloud" });
    await render(bot());
    expect(fixture.api).toHaveBeenCalledWith("/api/bots/juno/computer?threadId=t1", expect.anything());
    expect(seen.place).toBe("cloud");
  });

  it("shows no screen for a bot that is Off", async () => {
    await render(bot({ computer: "off", messages: [{ id: "m1", role: "assistant", kind: "screen", hasImage: true, mime: "image/png", text: "", at: 0 }] as unknown as Bot["messages"] }));
    expect(seen).toMatchObject({ place: "off", src: null });
  });
});
