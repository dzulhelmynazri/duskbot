// The v2 stream's H.264 encoder: which ffmpeg it uses (none means JPEG), how it frames access units out of FLV, and how
// one view's ffmpeg is restarted for a new size or a keyframe, skips pictures when behind and is given up when it dies.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { ffmpegArgs, findH264Encoder, flvUnits, h264Codec, h264Level, H264Stream, jpegSize, videoInterval, videoSize, x264Preset, type H264Config, type H264Encoder } from "./h264-encoder.ts";

/** A JPEG's first bytes up to its SOF0, enough for jpegSize. */
const jpeg = (width: number, height: number, tag = 0) => Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, tag, 0x00,
  0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);

const tag = (type: number, data: Buffer) => {
  const head = Buffer.alloc(11);
  head[0] = type;
  head.writeUIntBE(data.length, 1, 3);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(11 + data.length);
  return Buffer.concat([head, data, tail]);
};
const SPS = Buffer.from([0x67, 0x42, 0xc0, 0x1f]);
const PPS = Buffer.from([0x68, 0xce, 0x3c, 0x80]);
const FLV_HEAD = Buffer.from([0x46, 0x4c, 0x56, 1, 1, 0, 0, 0, 9, 0, 0, 0, 0]);
const config = () => tag(9, Buffer.concat([
  Buffer.from([0x17, 0, 0, 0, 0, 1, 0x42, 0xc0, 0x1f, 0xff, 0xe1]), Buffer.from([0, SPS.length]), SPS, Buffer.from([1, 0, PPS.length]), PPS,
]));
const nal = (bytes: number[]) => Buffer.concat([Buffer.from([0, 0, 0, bytes.length]), Buffer.from(bytes)]);
const picture = (key: boolean, ...nals: number[][]) => tag(9, Buffer.concat([Buffer.from([key ? 0x17 : 0x27, 1, 0, 0, 0]), ...nals.map(nal)]));
const annexB = (...nals: Buffer[]) => Buffer.concat(nals.flatMap((one) => [Buffer.from([0, 0, 0, 1]), one]));

class FakeFfmpeg extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly written: Buffer[] = [];
  killed = false;
  readonly args: string[];
  constructor(args: string[]) {
    super();
    this.args = args;
    this.stdin.on("data", (chunk: Buffer) => this.written.push(chunk));
    this.stdout.write(FLV_HEAD);
    this.stdout.write(config());
  }
  kill() {
    this.killed = true;
    return true;
  }
  /** The JPEG parts written so far, by the tag byte of each. */
  pictures(): number[] {
    return this.written.filter((chunk) => chunk[0] === 0xff && chunk[1] === 0xd8).map((chunk) => chunk[6]!);
  }
  /** One encoded picture out. */
  out(key = false) {
    this.stdout.write(picture(key, key ? [0x65, 1] : [0x41, 2]));
  }
}

const X264: H264Encoder = { command: "ffmpeg", library: "libx264", fpsMode: true };
const tick = () => new Promise((resolve) => setImmediate(resolve));

function harness({ canSend = () => true, now = () => 0, minIntervalMs = 0 }: { canSend?: () => boolean; now?: () => number; minIntervalMs?: number } = {}) {
  const procs: FakeFfmpeg[] = [];
  const configs: H264Config[] = [];
  const units: Array<{ data: Buffer; ack: () => void }> = [];
  const failed = vi.fn();
  const stream = new H264Stream(X264, {
    config: (value) => configs.push(value),
    unit: (data, ack) => units.push({ data, ack }),
    failed,
  }, {
    canSend,
    now,
    minIntervalMs,
    spawn: (_command, args) => {
      const proc = new FakeFfmpeg(args);
      procs.push(proc);
      return proc as unknown as ChildProcess;
    },
  });
  return { stream, procs, configs, units, failed };
}

describe("finding ffmpeg's H.264 encoder", () => {
  const encoders = (...names: string[]) => `Encoders:\n V..... = Video\n ------\n${names.map((name) => ` V....D ${name}  ${name} H.264\n`).join("")}`;
  const FORMATS = "File formats:\n D. = Demuxing\n --\n D  mpjpeg          MIME multipart JPEG\n  E flv             FLV (Flash Video)\n DE mov,mp4,m4a  QuickTime\n";
  const exec = (outputs: Record<string, string | Error>) => async (_command: string, args: string[]) => {
    const value = outputs[args[1]!]!;
    if (value instanceof Error) throw value;
    return value;
  };

  it("prefers libx264, then libopenh264, and reads whether -fps_mode exists", async () => {
    const both = exec({ "-encoders": encoders("libopenh264", "libx264"), "-formats": FORMATS, "-version": "ffmpeg version 6.1.1-3ubuntu5 Copyright" });
    expect(await findH264Encoder({}, both)).toEqual({ command: "ffmpeg", library: "libx264", fpsMode: true });
    const open = exec({ "-encoders": encoders("libopenh264"), "-formats": FORMATS, "-version": "ffmpeg version 4.4.2-0ubuntu0.22.04.1" });
    expect(await findH264Encoder({ MADANI_FFMPEG: "/opt/ff/ffmpeg" }, open)).toEqual({ command: "/opt/ff/ffmpeg", library: "libopenh264", fpsMode: false });
  });

  it("finds none without ffmpeg, without an H.264 encoder or the formats it needs, or when turned off", async () => {
    const missing = Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });
    expect(await findH264Encoder({}, exec({ "-encoders": missing, "-formats": missing, "-version": missing }))).toBeNull();
    expect(await findH264Encoder({}, exec({ "-encoders": encoders("libvpx", "h264_videotoolbox"), "-formats": FORMATS, "-version": "" }))).toBeNull();
    expect(await findH264Encoder({}, exec({ "-encoders": encoders("libx264"), "-formats": "  E flv  FLV\n", "-version": "" }))).toBeNull();
    const run = vi.fn(exec({ "-encoders": encoders("libx264"), "-formats": FORMATS, "-version": "" }));
    expect(await findH264Encoder({ MADANI_BROWSER_VIDEO: "off" }, run)).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
});

describe("H.264 framing", () => {
  it("reads a JPEG's size, the level it needs and its codec name", () => {
    expect(jpegSize(jpeg(1280, 800))).toEqual({ width: 1280, height: 800 });
    expect(jpegSize(Buffer.from([0x89, 0x50]))).toBeNull();
    expect(h264Level(1280, 720)).toBe(31);
    expect(h264Level(1280, 800)).toBe(32);
    expect(h264Level(1920, 1080)).toBe(40);
    expect(h264Level(3200, 2000)).toBe(51);
    expect(h264Level(7680, 4320)).toBeNull();
    expect(h264Codec(31)).toBe("avc1.42E01F");
    expect(ffmpegArgs(X264, 32, { width: 1280, height: 800 })).toEqual(expect.arrayContaining(["-level:v", "3.2", "-tune", "zerolatency", "-bf", "0"]));
  });

  it("splits FLV into Annex B access units across any chunking, with SPS and PPS in front of each keyframe", () => {
    const units: Array<[string, boolean]> = [];
    const read = flvUnits((data, key) => units.push([data.toString("hex"), key]));
    const all = Buffer.concat([FLV_HEAD, tag(18, Buffer.from("meta")), config(), picture(true, [0x06, 9], [0x65, 1]), picture(false, [0x41, 2], [0x41, 3])]);
    for (let at = 0; at < all.length; at += 7) read(all.subarray(at, at + 7));
    expect(units).toEqual([
      [annexB(SPS, PPS, Buffer.from([0x06, 9]), Buffer.from([0x65, 1])).toString("hex"), true],
      [annexB(Buffer.from([0x41, 2]), Buffer.from([0x41, 3])).toString("hex"), false],
    ]);
  });
});

describe("a view's H.264 stream", () => {
  it("sends each picture's unit with that picture's ack, and starts a new encoder for a new size", async () => {
    const { stream, procs, configs, units } = harness();
    const acks = [vi.fn(), vi.fn(), vi.fn()];
    expect(stream.push(jpeg(1280, 800, 1), acks[0]!)).toBe(true);
    expect(configs).toEqual([{ codec: "avc1.42E020", width: 1280, height: 800 }]);
    expect(procs[0]!.args).toEqual(expect.arrayContaining(["-f", "mpjpeg", "-f", "flv"]));
    await tick();
    expect(procs[0]!.pictures()).toEqual([1]);
    procs[0]!.out(true);
    await tick();
    expect(units).toHaveLength(1);
    expect(units[0]!.data.subarray(0, 8)).toEqual(Buffer.concat([Buffer.from([0, 0, 0, 1]), SPS]));
    expect(acks[0]).not.toHaveBeenCalled();
    units[0]!.ack();
    expect(acks[0]).toHaveBeenCalledOnce();
    // an odd size is encoded one row and column smaller
    stream.push(jpeg(1001, 701, 2), acks[1]!);
    expect(procs).toHaveLength(2);
    expect(procs[0]!.killed).toBe(true);
    expect(configs.at(-1)).toEqual({ codec: "avc1.42E01F", width: 1000, height: 700 });
    // the old encoder's late output is dropped
    procs[0]!.out();
    await tick();
    expect(units).toHaveLength(1);
    stream.close();
    expect(procs[1]!.killed).toBe(true);
    expect(acks[1]).toHaveBeenCalledOnce();
  });

  it("keeps only the newest picture while behind, releasing the ones it skips", async () => {
    let room = true;
    const { stream, procs, units } = harness({ canSend: () => room });
    const acks = Array.from({ length: 6 }, () => vi.fn());
    stream.push(jpeg(640, 480, 0), acks[0]!);
    stream.push(jpeg(640, 480, 1), acks[1]!);
    // two pictures in ffmpeg: the rest wait, only the newest kept
    stream.push(jpeg(640, 480, 2), acks[2]!);
    stream.push(jpeg(640, 480, 3), acks[3]!);
    await tick();
    expect(procs[0]!.pictures()).toEqual([0, 1]);
    expect(acks[2]).toHaveBeenCalledOnce();
    expect(acks[3]).not.toHaveBeenCalled();
    // the client has no room either: the encoder emptying does not write it yet
    room = false;
    procs[0]!.out(true);
    procs[0]!.out();
    await tick();
    expect(units).toHaveLength(2);
    expect(procs[0]!.pictures()).toEqual([0, 1]);
    room = true;
    stream.pump();
    await tick();
    expect(procs[0]!.pictures()).toEqual([0, 1, 3]);
    stream.close();
  });

  it("restarts on a keyframe request at most once a second, on the newest picture", async () => {
    let now = 0;
    const { stream, procs, configs } = harness({ now: () => now });
    stream.push(jpeg(640, 480, 7), () => {});
    vi.useFakeTimers();
    try {
      now = 300;
      stream.keyframe();
      expect(procs).toHaveLength(1);
      now = 1_000;
      await vi.advanceTimersByTimeAsync(700);
      expect(procs).toHaveLength(2);
      expect(configs).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
    await tick();
    expect(procs[1]!.pictures()).toEqual([7]);
    stream.close();
  });

  it("encodes a picture larger than 1x at 1x, and a same-size 1x picture keeps the encoder", () => {
    const { stream, procs, configs } = harness();
    expect(stream.push(jpeg(7680, 4320), () => {})).toBe(true);
    expect(configs.at(-1)).toMatchObject({ width: 1280, height: 720 });
    expect(stream.push(jpeg(1280, 720), () => {})).toBe(true);
    expect(procs).toHaveLength(1);
    stream.close();
  });

  it("counts an encoder that holds pictures for 5 s without a unit as died, releasing them", async () => {
    vi.useFakeTimers();
    try {
      const { stream, procs } = harness();
      const ack = vi.fn();
      stream.push(jpeg(640, 480), ack);
      await vi.advanceTimersByTimeAsync(4_900);
      expect(procs[0]!.killed).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(procs[0]!.killed).toBe(true);
      expect(ack).toHaveBeenCalledOnce();
      // the next picture starts a new encoder
      expect(stream.push(jpeg(640, 480), () => {})).toBe(true);
      expect(procs).toHaveLength(2);
      stream.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after its ffmpeg dies twice without a unit, releasing every picture it held", async () => {
    const { stream, procs, failed } = harness();
    const acks = [vi.fn(), vi.fn(), vi.fn()];
    stream.push(jpeg(640, 480), acks[0]!);
    procs[0]!.emit("exit", 1);
    expect(acks[0]).toHaveBeenCalledOnce();
    expect(stream.running).toBe(false);
    stream.push(jpeg(640, 480), acks[1]!);
    stream.push(jpeg(640, 480), acks[2]!);
    procs[1]!.emit("exit", 1);
    expect(failed).toHaveBeenCalledOnce();
    expect(acks.every((ack) => ack.mock.calls.length === 1)).toBe(true);
    expect(stream.push(jpeg(640, 480), () => {})).toBe(false);
  });
});

const ffmpeg = (() => {
  try {
    return /\blibx264\b/.test(execFileSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return false;
  }
})();

describe.runIf(ffmpeg)("with this machine's ffmpeg", () => {
  it("encodes each picture as it arrives, a keyframe first, without waiting for the next", async () => {
    const encoder = await findH264Encoder({});
    expect(encoder?.library).toBe("libx264");
    const pictures = ["red", "blue", "white"].map((color) => execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=${color}:s=641x401`, "-frames:v", "1", "-f", "mjpeg", "pipe:1",
    ]));
    const units: Array<{ key: boolean; at: number }> = [];
    const configs: H264Config[] = [];
    const stream = new H264Stream(encoder!, {
      config: (value) => configs.push(value),
      unit: (data, ack) => { units.push({ key: data.includes(Buffer.from([0, 0, 0, 1, 0x65])) || data.includes(Buffer.from([0, 0, 1, 0x65])), at: Date.now() }); ack(); },
      failed: () => { throw new Error("ffmpeg failed"); },
    }, { canSend: () => true, spawn: (command, args) => spawn(command, args, { stdio: ["pipe", "pipe", "ignore"] }) });
    try {
      for (const [index, jpegData] of pictures.entries()) {
        const sent = Date.now();
        stream.push(jpegData, () => {});
        const deadline = Date.now() + 10_000;
        while (units.length <= index && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
        expect(units).toHaveLength(index + 1);
        expect(units[index]!.at - sent).toBeLessThan(5_000);
      }
      expect(units.map((unit) => unit.key)).toEqual([true, false, false]);
      expect(configs).toEqual([{ codec: "avc1.42E01E", width: 640, height: 400 }]);
    } finally {
      stream.close();
    }
  }, 30_000);
});

describe("video size and preset", () => {
  it("encodes at 1x: a 2x screencast is scaled to at most 1280 wide, aspect kept, even sides", () => {
    expect(videoSize(2560, 1600)).toEqual({ width: 1280, height: 800 });
    expect(videoSize(1280, 800)).toEqual({ width: 1280, height: 800 });
    expect(videoSize(801, 601)).toEqual({ width: 800, height: 600 });
    const tall = videoSize(1170, 2532);
    expect(tall.width * tall.height).toBeLessThanOrEqual(1_200_000);
    expect(tall.width % 2 + tall.height % 2).toBe(0);
    expect(ffmpegArgs(X264, 32, { width: 1280, height: 800 }).join(" ")).toContain("scale=1280:800:");
  });

  it("paces pictures on a small machine: the newest waits for its turn and still arrives", async () => {
    vi.useFakeTimers();
    try {
      let time = 0;
      const { stream, procs, units } = harness({ now: () => time, minIntervalMs: 50 });
      stream.push(jpeg(640, 480, 0), () => {});
      procs[0]!.out(true);
      await vi.advanceTimersByTimeAsync(0);
      time = 10;
      stream.push(jpeg(640, 480, 1), () => {});
      const dropped = vi.fn();
      stream.push(jpeg(640, 480, 2), dropped);
      stream.push(jpeg(640, 480, 3), () => {});
      await vi.advanceTimersByTimeAsync(0);
      expect(procs[0]!.pictures()).toEqual([0]);
      expect(dropped).toHaveBeenCalledOnce();
      time = 50;
      await vi.advanceTimersByTimeAsync(40);
      expect(procs[0]!.pictures()).toEqual([0, 3]);
      expect(units).toHaveLength(1);
      stream.close();
    } finally { vi.useRealTimers(); }
    expect(videoInterval(2)).toBe(50);
    expect(videoInterval(8)).toBe(0);
  });

  it("uses the faster preset on a machine with two cores or fewer", () => {
    expect(x264Preset(1)).toBe("superfast");
    expect(x264Preset(2)).toBe("superfast");
    expect(x264Preset(4)).toBe("veryfast");
    expect(ffmpegArgs(X264, 32, { width: 1280, height: 800 }, "superfast")).toEqual(expect.arrayContaining(["-preset", "superfast"]));
  });
});
