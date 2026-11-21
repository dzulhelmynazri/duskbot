import { afterEach, describe, expect, it, vi } from "vitest";
import { cameraPermission, distinctCodes, scannerCamera, type ScanDriver } from "../../apps/mobile/src/native-platform";
import { webPlatform } from "./platform";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("camera permission mapping", () => {
  it.each([
    ["granted", "granted"],
    ["limited", "granted"],
    ["denied", "denied"],
    ["prompt", "prompt"],
    ["prompt-with-rationale", "prompt"],
    ["unknown", "prompt"],
  ])("maps %s to %s", (input, expected) => {
    expect(cameraPermission(input)).toBe(expected);
  });
});

describe("distinct scan delivery", () => {
  it("delivers each value once, including after other values appear", () => {
    const onCode = vi.fn();
    const deliver = distinctCodes(onCode);
    for (const code of [undefined, "first", "first", "second", "first", "second"]) deliver(code);
    expect(onCode.mock.calls).toEqual([["first"], ["second"]]);
  });

  it("keeps sessions independent and marks a value before calling back", () => {
    const onCode = vi.fn((code: string) => first(code));
    const first = distinctCodes(onCode);
    first("pair");
    distinctCodes(onCode)("pair");
    expect(onCode).toHaveBeenCalledTimes(2);
  });
});

function webCamera(torch = false) {
  const track = { stop: vi.fn(), getCapabilities: () => ({ torch }), applyConstraints: vi.fn().mockResolvedValue(undefined) };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const getUserMedia = vi.fn().mockResolvedValue(stream);
  const query = vi.fn().mockResolvedValue({ state: "prompt" });
  const readText = vi.fn().mockResolvedValue("pair-code");
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia }, permissions: { query }, clipboard: { readText } });
  vi.stubGlobal("BarcodeDetector", undefined);
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  }));
  const cancel = vi.fn((id: number) => frames.delete(id));
  vi.stubGlobal("cancelAnimationFrame", cancel);
  const element = { muted: false, playsInline: false, autoplay: false, srcObject: null, readyState: 2, play: vi.fn().mockResolvedValue(undefined), pause: vi.fn() };
  const video = element as unknown as HTMLVideoElement;
  return {
    platform: webPlatform(), track, stream, getUserMedia, query, readText, element, video, cancel, frames,
    async frame(time: number) {
      const pending = [...frames.entries()];
      frames.clear();
      for (const [, callback] of pending) callback(time);
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
  };
}

function barcodeDetector(detect = vi.fn().mockResolvedValue([]), formats = ["qr_code"]) {
  const create = vi.fn();
  vi.stubGlobal("BarcodeDetector", class {
    static async getSupportedFormats() { return formats; }
    constructor(options: { formats: string[] }) { create(options); }
    detect = detect;
  });
  return { detect, create };
}

describe("web camera", () => {
  it("is absent without media capture", () => {
    vi.stubGlobal("navigator", {});
    expect(webPlatform().camera).toBeUndefined();
  });

  it.each(["granted", "denied", "prompt"])("reads %s permission", async (state) => {
    const { platform, query } = webCamera();
    query.mockResolvedValue({ state });
    expect(await platform.camera!.permission()).toBe(state);
    expect(query).toHaveBeenCalledWith({ name: "camera" });
  });

  it("treats unavailable or rejected permission queries as prompt", async () => {
    const { platform, query } = webCamera();
    query.mockRejectedValue(new TypeError("unsupported permission"));
    expect(await platform.camera!.permission()).toBe("prompt");
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn() } });
    expect(await platform.camera!.permission()).toBe("prompt");
  });

  it("requests the environment camera and immediately releases permission-probe tracks", async () => {
    const { platform, track, getUserMedia } = webCamera();
    expect(await platform.camera!.request()).toBe("granted");
    expect(getUserMedia).toHaveBeenCalledWith({ video: { facingMode: "environment" } });
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it.each(["NotAllowedError", "NotFoundError"])("maps %s requests to denied", async (name) => {
    const { platform, getUserMedia } = webCamera();
    getUserMedia.mockRejectedValue(new DOMException("camera unavailable", name));
    expect(await platform.camera!.request()).toBe("denied");
  });

  it.each([undefined, ["code_128"]])("keeps preview running without QR detection (%s)", async (formats) => {
    const { platform, video, element, stream, track, frames } = webCamera();
    if (formats) barcodeDetector(undefined, formats);
    const onError = vi.fn();
    const session = await platform.camera!.start({ video, onCode: vi.fn(), onError });
    expect(element).toMatchObject({ muted: true, playsInline: true, autoplay: true, srcObject: stream });
    expect(element.play).toHaveBeenCalledOnce();
    expect(onError.mock.calls).toEqual([["unsupported"]]);
    expect(track.stop).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
    expect(session.torch).toBeUndefined();
    await Promise.all([session.stop(), session.stop()]);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(element.pause).toHaveBeenCalledOnce();
    expect(element.srcObject).toBeNull();
  });

  it("throttles scans, delivers distinct values, and stops the loop", async () => {
    const fixture = webCamera();
    const { detect, create } = barcodeDetector(vi.fn().mockResolvedValue([{ rawValue: "first" }, { rawValue: "first" }, { rawValue: "second" }]));
    const onCode = vi.fn();
    const session = await fixture.platform.camera!.start({ video: fixture.video, onCode });
    expect(create).toHaveBeenCalledWith({ formats: ["qr_code"] });
    await fixture.frame(0);
    await fixture.frame(149);
    expect(detect).toHaveBeenCalledTimes(1);
    await fixture.frame(150);
    expect(detect).toHaveBeenCalledTimes(2);
    expect(onCode.mock.calls).toEqual([["first"], ["second"]]);
    await session.stop();
    expect(fixture.cancel).toHaveBeenCalledOnce();
    expect(fixture.frames.size).toBe(0);
    await fixture.frame(500);
    expect(detect).toHaveBeenCalledTimes(2);
  });

  it("does not overlap detection or deliver a result after stop", async () => {
    const fixture = webCamera();
    let resolve!: (codes: Array<{ rawValue: string }>) => void;
    const { detect } = barcodeDetector(vi.fn(() => new Promise((done) => { resolve = done; })));
    const onCode = vi.fn();
    const session = await fixture.platform.camera!.start({ video: fixture.video, onCode });
    await fixture.frame(0);
    await fixture.frame(300);
    expect(detect).toHaveBeenCalledOnce();
    await session.stop();
    resolve([{ rawValue: "late" }]);
    await fixture.frame(600);
    expect(onCode).not.toHaveBeenCalled();
  });

  it("sets a supported torch and ignores changes after stop", async () => {
    const { platform, video, track } = webCamera(true);
    const session = await platform.camera!.start({ video, onCode: vi.fn() });
    await session.torch!.set(true);
    await session.torch!.set(false);
    expect(track.applyConstraints.mock.calls).toEqual([[{ advanced: [{ torch: true }] }], [{ advanced: [{ torch: false }] }]]);
    await session.stop();
    await session.torch!.set(true);
    expect(track.applyConstraints).toHaveBeenCalledTimes(2);
  });

  it("releases tracks and detaches if playback fails", async () => {
    const { platform, video, element, track } = webCamera();
    element.play.mockRejectedValue(new Error("playback failed"));
    await expect(platform.camera!.start({ video, onCode: vi.fn() })).rejects.toThrow("playback failed");
    expect(track.stop).toHaveBeenCalledOnce();
    expect(element.srcObject).toBeNull();
  });

  it("requires a video before acquiring camera tracks", async () => {
    const { platform, getUserMedia } = webCamera();
    await expect(platform.camera!.start({ onCode: vi.fn() })).rejects.toThrow("video-required");
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("reads the clipboard and returns null when unavailable or refused", async () => {
    const { platform, readText } = webCamera();
    expect(await platform.readClipboard!()).toBe("pair-code");
    readText.mockRejectedValue(new Error("clipboard denied"));
    expect(await platform.readClipboard!()).toBeNull();
    vi.stubGlobal("navigator", {});
    expect(await platform.readClipboard!()).toBeNull();
  });
});

describe("native scanner session", () => {
  function driver(overrides: Partial<ScanDriver> = {}) {
    let code: (text: string | undefined) => void = () => {};
    const remove = vi.fn().mockResolvedValue(undefined);
    const fake: ScanDriver = {
      permission: vi.fn().mockResolvedValue("granted"),
      request: vi.fn().mockResolvedValue("denied"),
      openSettings: vi.fn().mockResolvedValue(undefined),
      listen: vi.fn(async (onCode) => { code = onCode; return [{ remove }]; }),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      torchAvailable: vi.fn().mockResolvedValue(true),
      torch: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
    return { fake, remove, read: (text: string) => code(text) };
  }

  it("hands each code over once, and stopping turns the torch off and the page opaque again", async () => {
    const { fake, remove, read } = driver();
    const scanning = vi.fn();
    const onCode = vi.fn();
    const camera = scannerCamera(fake, scanning);
    expect(await camera.permission()).toBe("granted");
    expect(await camera.request()).toBe("denied");
    const session = await camera.start({ onCode });
    expect(scanning).toHaveBeenLastCalledWith(true);
    read("madanibot://pair?m=1"); read("madanibot://pair?m=1");
    expect(onCode).toHaveBeenCalledOnce();
    await session.torch!.set(true);
    await session.stop();
    await session.stop();
    expect(fake.torch).toHaveBeenLastCalledWith(false);
    expect(fake.stop).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(scanning).toHaveBeenLastCalledWith(false);
    read("late");
    expect(onCode).toHaveBeenCalledOnce();
  });

  it("a scanner the system draws full screen gets the page's words, hands back its buttons, and pauses while a code is redeemed", async () => {
    let action: ((key: string) => void) | undefined;
    const busy = vi.fn().mockResolvedValue(undefined);
    const { fake } = driver({
      start: vi.fn().mockResolvedValue({ fullScreen: true }),
      listen: vi.fn(async (_code, _error, onAction) => { action = onAction; return [{ remove: vi.fn().mockResolvedValue(undefined) }]; }),
      busy,
    });
    const scanning = vi.fn();
    const onAction = vi.fn();
    const overlay = { title: "Scan", hint: "Point at the code", close: "Close", torch: "Torch", actions: [{ key: "code", title: "Enter code", icon: "keyboard" }] };
    const session = await scannerCamera(fake, scanning).start({ onCode: vi.fn(), overlay, onAction });
    expect(fake.start).toHaveBeenCalledWith(overlay);
    expect(session.fullScreen).toBe(true);
    expect(session.torch).toBeUndefined();
    expect(fake.torchAvailable).not.toHaveBeenCalled();
    expect(scanning).toHaveBeenLastCalledWith(false);
    action?.("code");
    expect(onAction).toHaveBeenCalledWith("code");
    session.busy?.(true, "Linking");
    expect(busy).toHaveBeenCalledWith(true, "Linking");
    await session.stop();
    action?.("close");
    expect(onAction).toHaveBeenCalledOnce();
  });

  it("a camera that will not start leaves nothing running", async () => {
    const { fake } = driver({ start: vi.fn().mockRejectedValue(new Error("this device has no camera to scan with")) });
    const scanning = vi.fn();
    await expect(scannerCamera(fake, scanning).start({ onCode: vi.fn() })).rejects.toThrow("no camera");
    expect(fake.stop).toHaveBeenCalledOnce();
    expect(scanning).toHaveBeenLastCalledWith(false);
  });
});
