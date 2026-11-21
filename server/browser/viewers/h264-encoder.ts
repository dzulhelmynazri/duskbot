// The v2 stream's H.264: the screencast's JPEGs re-encoded by the machine's own ffmpeg, one process per view. Video
// costs a fraction of the JPEG bytes (a still page is near zero, typing a few KB/s). It is never bundled: libx264 is
// GPL, so only an ffmpeg the server's owner installed is used, and without one every view keeps its JPEG frames.
//
// ffmpeg reads the JPEGs as multipart parts with their lengths (each is decoded the moment it arrives, where a JPEG pipe
// waits for the next picture to find the end of this one) and writes FLV, whose tags frame every access unit exactly;
// each goes out as Annex B, a keyframe with its SPS and PPS in front.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { availableParallelism } from "node:os";

import { spawnBotWork } from "../../oom-score.ts";

export type H264Library = "libx264" | "libopenh264";

export interface H264Encoder {
  /** The ffmpeg to run. */
  readonly command: string;
  readonly library: H264Library;
  /** ffmpeg 5.1 and later name the frame timing option -fps_mode; older ones only take -vsync. */
  readonly fpsMode: boolean;
}

/** What the client configures its decoder with; a keyframe follows. */
export interface H264Config {
  codec: string;
  width: number;
  height: number;
}

type Run = (command: string, args: string[]) => Promise<string>;

const run: Run = (command, args) => new Promise((resolve, reject) => {
  execFile(command, args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
});

/** The H.264 encoder this machine's ffmpeg has, libx264 first, or null: none, or MADANI_BROWSER_VIDEO=off. */
export async function findH264Encoder(env: NodeJS.ProcessEnv = process.env, exec: Run = run): Promise<H264Encoder | null> {
  if (env.MADANI_BROWSER_VIDEO?.trim().toLowerCase() === "off") return null;
  const command = env.MADANI_FFMPEG?.trim() || "ffmpeg";
  try {
    const [encoders, formats, version] = await Promise.all([
      exec(command, ["-hide_banner", "-encoders"]),
      exec(command, ["-hide_banner", "-formats"]),
      exec(command, ["-hide_banner", "-version"]).catch(() => ""),
    ]);
    const library = (["libx264", "libopenh264"] as const).find((name) => new RegExp(`^\\s*V\\S*\\s+${name}\\s`, "m").test(encoders));
    // a minimal build may leave out the multipart demuxer or the FLV muxer
    const hasFormat = (flags: RegExp, name: string) => new RegExp(`^\\s*${flags.source}\\s+(?:\\S+,)*${name}(?:,\\S+)*\\s`, "m").test(formats);
    if (!library || !hasFormat(/D\S*/, "mpjpeg") || !hasFormat(/\S*E/, "flv")) return null;
    const match = /version\s+n?(\d+)\.(\d+)/.exec(version);
    const fpsMode = !match || Number(match[1]) > 5 || (Number(match[1]) === 5 && Number(match[2]) >= 1);
    return { command, library, fpsMode };
  } catch {
    return null;
  }
}

let found: Promise<H264Encoder | null> | null = null;
/** findH264Encoder, asked once per process. */
export function h264Encoder(): Promise<H264Encoder | null> {
  found ??= findH264Encoder();
  return found;
}

/** Width and height from a JPEG's start-of-frame segment, or null. */
export function jpegSize(data: Uint8Array): { width: number; height: number } | null {
  if (data[0] !== 0xff || data[1] !== 0xd8) return null;
  for (let at = 2; at + 9 < data.length;) {
    if (data[at] !== 0xff) return null;
    const marker = data[at + 1]!;
    if (marker === 0xff) { at++; continue; }
    // SOF0 to SOF15, without DHT (c4), JPG (c8) and DAC (cc)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (data[at + 5]! << 8) | data[at + 6]!;
      const width = (data[at + 7]! << 8) | data[at + 8]!;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    at += 2 + ((data[at + 2]! << 8) | data[at + 3]!);
  }
  return null;
}

/** The H.264 level of a picture size (frame size limit only), or null past 5.1's 36864 macroblocks. */
export function h264Level(width: number, height: number): number | null {
  const blocks = Math.ceil(width / 16) * Math.ceil(height / 16);
  const levels: Array<[number, number]> = [[1620, 30], [3600, 31], [5120, 32], [8192, 40], [8704, 42], [22080, 50], [36864, 51]];
  return levels.find(([limit]) => blocks <= limit)?.[1] ?? null;
}

/** Video goes at 1x: a 2x (Retina) screencast is scaled down to this before encoding, which keeps a view's encoder cheap. */
export const VIDEO_LIMITS = { maxWidth: 1280, maxPixels: 1_200_000 } as const;

/** The encoded picture for a screencast frame of this size: at most VIDEO_LIMITS, aspect kept, even sides. */
export function videoSize(width: number, height: number): { width: number; height: number } {
  const fit = Math.min(1, VIDEO_LIMITS.maxWidth / width, Math.sqrt(VIDEO_LIMITS.maxPixels / (width * height)));
  return { width: Math.max(2, Math.floor((width * fit) / 2) * 2), height: Math.max(2, Math.floor((height * fit) / 2) * 2) };
}

/** A machine with two cores or fewer encodes with the faster preset, so one view stays near a tenth of a core. */
export const x264Preset = (cores: number = availableParallelism()) => (cores <= 2 ? "superfast" : "veryfast");

/** Constrained baseline at `level`, as WebCodecs names it. */
export const h264Codec = (level: number) => `avc1.42E0${level.toString(16).toUpperCase().padStart(2, "0")}`;

export function ffmpegArgs(encoder: Pick<H264Encoder, "library" | "fpsMode">, level: number, size: { width: number; height: number }, preset = x264Preset()): string[] {
  const codec = encoder.library === "libx264"
    ? ["-c:v", "libx264", "-profile:v", "baseline", "-level:v", (level / 10).toFixed(1), "-preset", preset, "-tune", "zerolatency", "-crf", "26", "-bf", "0"]
    : ["-c:v", "libopenh264", "-profile:v", "constrained_baseline", "-b:v", "2M"];
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-probesize", "32", "-analyzeduration", "0", "-fpsprobesize", "0", "-use_wallclock_as_timestamps", "1", "-threads", "1",
    "-f", "mpjpeg", "-i", "pipe:0",
    "-an", ...(encoder.fpsMode ? ["-fps_mode", "passthrough"] : ["-vsync", "passthrough"]),
    // H.264 4:2:0 needs even sides: an odd last row or column is dropped. Chromium draws WebCodecs frames as limited-range
    // BT.709 (measured in headless Chromium), so the screencast's full-range BT.601 JPEG becomes that; accurate_rnd keeps grays gray.
    "-vf", `crop=trunc(iw/2)*2:trunc(ih/2)*2,scale=${size.width}:${size.height}:in_range=full:out_range=limited:in_color_matrix=bt601:out_color_matrix=bt709:flags=accurate_rnd,setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709`, "-pix_fmt", "yuv420p",
    ...codec, "-g", "300", "-threads", "2",
    "-flush_packets", "1", "-flvflags", "no_duration_filesize", "-f", "flv", "pipe:1",
  ];
}

const START_CODE = Buffer.from([0, 0, 0, 1]);

/** FLV in, H.264 access units out: `unit` once per video tag, as Annex B. */
export function flvUnits(unit: (data: Buffer, key: boolean) => void): (chunk: Buffer) => void {
  let buffer: Buffer = Buffer.alloc(0);
  let header = false;
  let lengthSize = 4;
  let parameterSets: Buffer = Buffer.alloc(0);
  const annexB = (body: Buffer) => {
    const parts: Buffer[] = [];
    for (let at = 0; at + lengthSize <= body.length;) {
      const length = body.readUIntBE(at, lengthSize);
      at += lengthSize;
      if (length <= 0 || at + length > body.length) break;
      parts.push(START_CODE, body.subarray(at, at + length));
      at += length;
    }
    return parts;
  };
  const configRecord = (body: Buffer) => {
    if (body.length < 7) return;
    lengthSize = (body[4]! & 3) + 1;
    const parts: Buffer[] = [];
    let at = 5;
    for (const countMask of [0x1f, 0xff]) {
      const count = body[at++]! & countMask;
      for (let i = 0; i < count && at + 2 <= body.length; i++) {
        const length = body.readUInt16BE(at);
        at += 2;
        parts.push(START_CODE, body.subarray(at, at + length));
        at += length;
      }
    }
    parameterSets = Buffer.concat(parts);
  };
  return (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    if (!header) {
      if (buffer.length < 13) return;
      buffer = buffer.subarray(13);
      header = true;
    }
    while (buffer.length >= 11) {
      const size = buffer.readUIntBE(1, 3);
      if (buffer.length < 11 + size + 4) return;
      const type = buffer[0];
      const data = buffer.subarray(11, 11 + size);
      buffer = buffer.subarray(15 + size);
      // video, AVC
      if (type !== 9 || data.length < 5 || (data[0]! & 0x0f) !== 7) continue;
      const body = data.subarray(5);
      if (data[1] === 0) configRecord(body);
      else if (data[1] === 1) {
        const key = data[0]! >> 4 === 1;
        const nals = annexB(body);
        if (nals.length) unit(Buffer.concat(key ? [parameterSets, ...nals] : nals), key);
      }
    }
  };
}

export interface H264StreamEvents {
  /** A new encoder starts: the client configures its decoder for it, and a keyframe follows. */
  config(config: H264Config): void;
  /** An access unit. `ack` releases its picture's screencast frame: call it once the client has it. */
  unit(data: Buffer, ack: () => void): void;
  /** The encoder failed for good: this view's frames go as JPEG from now on. */
  failed(): void;
}

export interface H264StreamOptions {
  /** False while the client still has too many units unacknowledged: the encoder waits, keeping only the newest picture. */
  canSend(): boolean;
  spawn?: (command: string, args: string[]) => ChildProcess;
  now?: () => number;
  /** pictures go to the encoder at most this often; the newest waits (default: videoInterval()) */
  minIntervalMs?: number;
}

/** A machine with two cores or fewer encodes at most 20 pictures a second, so one view stays under about 15% of a core. */
export const videoInterval = (cores: number = availableParallelism()) => (cores <= 2 ? 50 : 0);

/** Pictures written to ffmpeg and not yet out: one decoding, one encoding. More waits as the single newest picture. */
const IN_ENCODER = 2;
/** A view's decoder asking for keyframes runs a new encoder at most this often. */
const KEYFRAME_EVERY_MS = 1_000;
/** An encoder that dies this many times without a unit in between is given up. */
const FAILURES = 2;
/** An encoder holding pictures this long without a unit is stuck, and counts as died: its pictures' frames are released. */
const STALL_MS = 5_000;
const MAX_ENCODERS = Math.max(2, Math.floor(availableParallelism() / 2));
let encoders = 0;

const spawnFfmpeg = (command: string, args: string[]) =>
  spawnBotWork(() => spawn(command, args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true }));

const part = (jpeg: Buffer) => [Buffer.from(`--ffmpeg\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`), jpeg, Buffer.from("\r\n")];

interface Picture { jpeg: Buffer; ack: () => void }

/**
 * One view's encoder. `push` takes a screencast JPEG and whether it was taken: false for a picture too large for H.264,
 * or once the encoder gave up, which the view then sends as JPEG. A new size starts a new ffmpeg, and so does a keyframe
 * request; a view's encoder that falls behind keeps only the newest picture, releasing the ones it skips.
 */
export class H264Stream {
  readonly #encoder: H264Encoder;
  readonly #events: H264StreamEvents;
  readonly #canSend: () => boolean;
  readonly #spawn: (command: string, args: string[]) => ChildProcess;
  readonly #now: () => number;
  readonly #minInterval: number;
  #lastWrite = Number.NEGATIVE_INFINITY;
  #paceTimer: ReturnType<typeof setTimeout> | null = null;
  #proc: ChildProcess | null = null;
  #size: { width: number; height: number } | null = null;
  /** Acks of the pictures written, in order: each goes with the unit that comes out for it. */
  #written: Array<() => void> = [];
  #waiting: Picture | null = null;
  #last: Buffer | null = null;
  #startedAt = -Infinity;
  #failures = 0;
  #dead = false;
  #closed = false;
  #counted = false;
  #keyTimer: ReturnType<typeof setTimeout> | null = null;
  #stallTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(encoder: H264Encoder, events: H264StreamEvents, options: H264StreamOptions) {
    this.#encoder = encoder;
    this.#events = events;
    this.#canSend = options.canSend;
    this.#spawn = options.spawn ?? spawnFfmpeg;
    this.#now = options.now ?? Date.now;
    this.#minInterval = options.minIntervalMs ?? videoInterval();
  }

  /** A view's encoder, or null while as many run on this machine as it has room for. close() gives its place back. */
  static open(encoder: H264Encoder, events: H264StreamEvents, options: H264StreamOptions): H264Stream | null {
    if (encoders >= MAX_ENCODERS) return null;
    encoders++;
    const stream = new H264Stream(encoder, events, options);
    stream.#counted = true;
    return stream;
  }

  get running(): boolean {
    return this.#proc !== null;
  }

  push(jpeg: Buffer, ack: () => void): boolean {
    if (this.#dead || this.#closed) return false;
    const size = jpegSize(jpeg);
    const even = size && size.width >= 2 && size.height >= 2 ? videoSize(size.width, size.height) : null;
    if (!even || even.width < 2 || even.height < 2 || h264Level(even.width, even.height) === null) {
      this.#stop();
      this.#release();
      this.#size = null;
      return false;
    }
    if (!this.#proc || this.#size?.width !== even.width || this.#size.height !== even.height) {
      this.#size = even;
      this.#start();
      if (this.#dead) return false;
    }
    this.#waiting?.ack();
    this.#waiting = { jpeg, ack };
    this.pump();
    return true;
  }

  /** Writes the waiting picture if the encoder and the client have room for it. */
  pump(): void {
    const proc = this.#proc;
    if (!proc || !this.#waiting || this.#written.length >= IN_ENCODER || !this.#canSend()) return;
    const early = this.#lastWrite + this.#minInterval - this.#now();
    if (early > 0) {
      this.#paceTimer ??= setTimeout(() => { this.#paceTimer = null; this.pump(); }, early);
      this.#paceTimer.unref?.();
      return;
    }
    this.#lastWrite = this.#now();
    const { jpeg, ack } = this.#waiting;
    this.#waiting = null;
    this.#write(proc, jpeg, ack);
  }

  /** The client's decoder lost its place: a new encoder starts on the newest picture, so a keyframe comes next. Asked
   * again within KEYFRAME_EVERY_MS, it waits for that rather than restart more often. */
  keyframe(): void {
    if (this.#dead || this.#closed || !this.#size || !this.#last || this.#keyTimer) return;
    const wait = this.#startedAt + KEYFRAME_EVERY_MS - this.#now();
    if (wait > 0) {
      this.#keyTimer = setTimeout(() => { this.#keyTimer = null; this.keyframe(); }, wait);
      this.#keyTimer.unref?.();
      return;
    }
    this.#start();
    if (!this.#proc) return;
    if (this.#waiting) this.pump();
    else this.#write(this.#proc, this.#last, () => {});
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#paceTimer) clearTimeout(this.#paceTimer);
    this.#paceTimer = null;
    if (this.#keyTimer) clearTimeout(this.#keyTimer);
    this.#keyTimer = null;
    this.#stop();
    this.#release();
    if (this.#counted) encoders--;
    this.#counted = false;
  }

  #write(proc: ChildProcess, jpeg: Buffer, ack: () => void): void {
    this.#last = jpeg;
    this.#written.push(ack);
    this.#watch();
    for (const piece of part(jpeg)) proc.stdin?.write(piece);
  }

  #start(): void {
    this.#stop();
    const size = this.#size!;
    const level = h264Level(size.width, size.height)!;
    let proc: ChildProcess;
    try {
      proc = this.#spawn(this.#encoder.command, ffmpegArgs(this.#encoder, level, size));
    } catch {
      this.#failed();
      return;
    }
    this.#proc = proc;
    this.#startedAt = this.#now();
    const current = () => this.#proc === proc;
    proc.stdin?.on("error", () => undefined);
    proc.stdout?.on("data", flvUnits((data) => {
      if (!current()) return;
      this.#failures = 0;
      const ack = this.#written.shift() ?? (() => {});
      this.#unwatch();
      if (this.#written.length) this.#watch();
      this.#events.unit(data, ack);
      this.pump();
    }));
    const ended = () => {
      if (!current()) return;
      this.#stop();
      if (++this.#failures >= FAILURES) this.#failed();
    };
    this.#stalled = ended;
    proc.once("error", ended);
    proc.once("exit", ended);
    this.#events.config({ codec: h264Codec(level), width: size.width, height: size.height });
  }

  #stalled: () => void = () => {};

  #watch(): void {
    if (this.#stallTimer) return;
    this.#stallTimer = setTimeout(() => { this.#stallTimer = null; this.#stalled(); }, STALL_MS);
    this.#stallTimer.unref?.();
  }

  #unwatch(): void {
    if (this.#stallTimer) clearTimeout(this.#stallTimer);
    this.#stallTimer = null;
  }

  #stop(): void {
    this.#unwatch();
    const proc = this.#proc;
    this.#proc = null;
    for (const ack of this.#written.splice(0)) ack();
    if (!proc) return;
    proc.stdin?.destroy();
    proc.stdout?.destroy();
    proc.kill("SIGKILL");
  }

  #failed(): void {
    this.#dead = true;
    this.#stop();
    this.#release();
    this.#events.failed();
  }

  #release(): void {
    const waiting = this.#waiting;
    this.#waiting = null;
    waiting?.ack();
  }
}
