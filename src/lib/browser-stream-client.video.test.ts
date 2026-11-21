// The v2 stream's video negotiation: the client asks for H.264 only when it decodes it, follows the server's answer
// (an old server or one without ffmpeg keeps sending JPEG), and a decoder that loses its place asks for a keyframe,
// then gives video up for JPEG.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { browserStreamAccess, createPreviewFramePainter, createPreviewStreamClient, type PreviewStreamEvents } from "./browser-stream-client";
import { isKeyUnit, resetH264Support } from "./h264-decoder";

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 1;
  binaryType = "";
  readonly sent: string[] = [];
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
    FakeSocket.all.push(this);
  }
  send(value: string) {
    this.sent.push(value);
  }
  close() {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event("close"), { code: 1005, reason: "" }));
  }
  open() {
    this.dispatchEvent(new Event("open"));
  }
  message(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

class FakeDecoder {
  static all: FakeDecoder[] = [];
  static supported = true;
  static isConfigSupported = vi.fn(async () => ({ supported: FakeDecoder.supported }));
  state = "unconfigured";
  decodeQueueSize = 0;
  config: unknown = null;
  readonly chunks: Array<{ type: string }> = [];
  readonly init: { output: (frame: unknown) => void; error: (error: Error) => void };
  constructor(init: FakeDecoder["init"]) {
    this.init = init;
    FakeDecoder.all.push(this);
  }
  configure(config: unknown) {
    this.config = config;
    this.state = "configured";
  }
  decode(chunk: { type: string }) {
    this.chunks.push(chunk);
    this.init.output({ displayWidth: 4, displayHeight: 2, close: vi.fn() });
  }
  fail() {
    this.state = "closed";
    this.init.error(new Error("decode"));
  }
  close() {
    this.state = "closed";
  }
}

class FakeChunk {
  readonly type: string;
  constructor(init: { type: string }) {
    this.type = init.type;
  }
}

/** Annex B: an IDR unit (SPS, PPS, IDR slice) and a delta unit (one non-IDR slice). */
const KEY = new Uint8Array([0, 0, 0, 1, 0x67, 1, 0, 0, 0, 1, 0x68, 2, 0, 0, 0, 1, 0x65, 3]).buffer;
const DELTA = new Uint8Array([0, 0, 0, 1, 0x41, 4]).buffer;
const H264 = JSON.stringify({ type: "encoding", encoding: "h264", codec: "avc1.42E01F", width: 1280, height: 800 });

const access = browserStreamAccess("pepper", { protocol: "http:", host: "madani.test" });
const target = { access, maxWidth: 800, maxHeight: 600 };
const events = (more: Partial<PreviewStreamEvents> = {}): PreviewStreamEvents => ({
  onFrame: vi.fn(),
  onViewport: vi.fn(),
  onConnectedChange: vi.fn(),
  onUnauthorized: vi.fn(),
  ...more,
});
const codecOf = (socket: FakeSocket) => new URL(socket.url).searchParams.get("codec");
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  FakeSocket.all = [];
  FakeDecoder.all = [];
  FakeDecoder.supported = true;
  resetH264Support();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("VideoDecoder", FakeDecoder);
  vi.stubGlobal("EncodedVideoChunk", FakeChunk);
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetH264Support();
});

describe("browser stream video", () => {
  it("asks for H.264 only when this app decodes it", async () => {
    // the first answer is awaited: the socket opens once it is known
    const first = createPreviewStreamClient(target, events());
    expect(FakeSocket.all).toHaveLength(0);
    await flush();
    expect(FakeDecoder.isConfigSupported).toHaveBeenCalledWith(expect.objectContaining({ codec: "avc1.42E028" }));
    expect(codecOf(FakeSocket.all[0]!)).toBe("h264");
    first.stop();
    resetH264Support();
    FakeDecoder.supported = false;
    const client = createPreviewStreamClient(target, events());
    await flush();
    expect(codecOf(FakeSocket.all.at(-1)!)).toBeNull();
    client.stop();
    vi.stubGlobal("VideoDecoder", undefined);
    resetH264Support();
    createPreviewStreamClient(target, events()).stop();
    expect(codecOf(FakeSocket.all.at(-1)!)).toBeNull();
  });

  it("a browser on this machine streams sharp JPEG, never the network's 1x video", async () => {
    FakeDecoder.isConfigSupported.mockClear();
    for (const host of ["127.0.0.1:7317", "localhost:7317"]) {
      const local = { ...target, access: browserStreamAccess("pepper", { protocol: "http:", host }) };
      const client = createPreviewStreamClient(local, events());
      await flush();
      const url = new URL(FakeSocket.all.at(-1)!.url);
      expect(url.searchParams.get("codec")).toBeNull();
      expect(url.searchParams.get("quality")).toBe("90");
      client.stop();
    }
    expect(FakeDecoder.isConfigSupported).not.toHaveBeenCalled();
    // a server on another machine keeps the video and the server's own JPEG quality
    const remote = createPreviewStreamClient(target, events());
    await flush();
    expect(new URL(FakeSocket.all.at(-1)!.url).searchParams.get("quality")).toBeNull();
    remote.stop();
  });

  it("keeps JPEG frames from a server that answers jpeg, or that never answers (an old server)", () => {
    resetH264Support(true);
    for (const answer of [JSON.stringify({ type: "encoding", encoding: "jpeg" }), null]) {
      const onFrame = vi.fn();
      const onMessage = vi.fn();
      const client = createPreviewStreamClient(target, events({ onFrame, onMessage }));
      const socket = FakeSocket.all.at(-1)!;
      expect(codecOf(socket)).toBe("h264");
      if (answer) socket.message(answer);
      const jpeg = new ArrayBuffer(8);
      socket.message(jpeg);
      expect(onFrame).toHaveBeenCalledWith(jpeg);
      expect(socket.sent).toEqual([JSON.stringify({ type: "ack" })]);
      expect(onMessage).not.toHaveBeenCalled();
      expect(FakeDecoder.all).toHaveLength(0);
      client.stop();
    }
  });

  it("decodes access units after the server's h264 answer, acking each, from the first keyframe on", () => {
    resetH264Support(true);
    const onFrame = vi.fn();
    const client = createPreviewStreamClient(target, events({ onFrame }));
    const socket = FakeSocket.all.at(-1)!;
    socket.message(H264);
    socket.message(DELTA);
    socket.message(KEY);
    socket.message(DELTA);
    const decoder = FakeDecoder.all[0]!;
    expect(decoder.config).toMatchObject({ codec: "avc1.42E01F", codedWidth: 1280, codedHeight: 800, optimizeForLatency: true });
    expect(decoder.chunks.map((chunk) => chunk.type)).toEqual(["key", "delta"]);
    expect(socket.sent.filter((sent) => sent.includes("ack"))).toHaveLength(3);
    expect(onFrame).toHaveBeenCalledTimes(2);
    expect(onFrame.mock.calls[0]![0]).toMatchObject({ displayWidth: 4, displayHeight: 2 });
    // a new size: a new decoder, waiting for its keyframe
    socket.message(JSON.stringify({ type: "encoding", encoding: "h264", codec: "avc1.42E028", width: 1600, height: 1000 }));
    socket.message(DELTA);
    socket.message(KEY);
    expect(FakeDecoder.all).toHaveLength(2);
    expect(decoder.state).toBe("closed");
    expect(FakeDecoder.all[1]!.chunks.map((chunk) => chunk.type)).toEqual(["key"]);
    // and back to JPEG, as for a picture too large for video
    socket.message(JSON.stringify({ type: "encoding", encoding: "jpeg" }));
    const jpeg = new ArrayBuffer(4);
    socket.message(jpeg);
    expect(onFrame).toHaveBeenLastCalledWith(jpeg);
    client.stop();
    expect(FakeDecoder.all[1]!.state).toBe("closed");
  });

  it("asks for a keyframe when its decoder fails, and reopens as JPEG when it keeps failing", async () => {
    resetH264Support(true);
    const client = createPreviewStreamClient(target, events());
    const socket = FakeSocket.all.at(-1)!;
    socket.open();
    socket.message(H264);
    socket.message(KEY);
    FakeDecoder.all[0]!.fail();
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ type: "keyframe" }));
    // deltas wait for the keyframe, which opens a new decoder
    socket.message(DELTA);
    expect(FakeDecoder.all).toHaveLength(1);
    socket.message(KEY);
    expect(FakeDecoder.all).toHaveLength(2);
    FakeDecoder.all[1]!.fail();
    socket.message(KEY);
    expect(socket.sent.filter((sent) => sent.includes("keyframe"))).toHaveLength(2);
    vi.useFakeTimers();
    try {
      FakeDecoder.all[2]!.fail();
      expect(socket.readyState).toBe(3);
      await vi.advanceTimersByTimeAsync(1_000);
    } finally {
      vi.useRealTimers();
    }
    expect(FakeSocket.all).toHaveLength(2);
    expect(codecOf(FakeSocket.all[1]!)).toBeNull();
    client.stop();
  });

  it("finds keyframes by their NAL types", () => {
    expect(isKeyUnit(new Uint8Array(KEY))).toBe(true);
    expect(isKeyUnit(new Uint8Array(DELTA))).toBe(false);
    expect(isKeyUnit(new Uint8Array([0, 0, 1, 0x09, 0x10, 0, 0, 1, 0x65, 1]))).toBe(true);
  });

  it("paints decoded frames on the JPEG canvas and closes them", () => {
    const drawImage = vi.fn();
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }) } as unknown as HTMLCanvasElement;
    const onPainted = vi.fn();
    const painter = createPreviewFramePainter(canvas, onPainted);
    const frame = { displayWidth: 1280, displayHeight: 800, close: vi.fn() } as unknown as VideoFrame;
    painter.paint(frame);
    expect(drawImage).toHaveBeenCalledWith(frame, 0, 0);
    expect([canvas.width, canvas.height]).toEqual([1280, 800]);
    expect(frame.close).toHaveBeenCalled();
    expect(onPainted).toHaveBeenCalledTimes(1);
    painter.stop();
    const late = { displayWidth: 1, displayHeight: 1, close: vi.fn() } as unknown as VideoFrame;
    painter.paint(late);
    expect(late.close).toHaveBeenCalled();
    expect(drawImage).toHaveBeenCalledTimes(1);
  });
});
