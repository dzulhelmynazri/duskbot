// The built-in voice's model files, fetched on first use from pinned revisions and checked against their hashes.
// Licenses: Kokoro-82M weights Apache-2.0 (hexgrad); Moonshine base English MIT (Useful Sensors); misaki lexicons
// Apache-2.0 (hexgrad); cmu_misaki_us.json Apache-2.0 (KittenML), derived from CMUdict (BSD-style).
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

export interface ModelFile {
  path: string;
  url: string;
  bytes: number;
  sha256: string;
}

const KOKORO = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231";
const MOONSHINE = "https://huggingface.co/onnx-community/moonshine-base-ONNX/resolve/b1e9b6aae3c3c7298f10c3798393fdf38e8fbbad";
const MISAKI = "https://raw.githubusercontent.com/hexgrad/misaki/fba1236595f2d2bf21d414ba6e57d25256afada3/misaki/data";
const KITTEN = "https://huggingface.co/KittenML/kitten-tts-2-mini/resolve/8e89ae2a718ee4bb893c67d67657e520e6112faf";

const voice = (id: string, sha256: string): ModelFile => ({ path: `kokoro/voices/${id}.bin`, url: `${KOKORO}/voices/${id}.bin`, bytes: 522240, sha256 });

/** Hearing first: it is the smaller half, and a call can speak with the computer's own voice until the rest lands. */
export const MODEL_FILES: readonly ModelFile[] = [
  { path: "moonshine/encoder_model_quantized.onnx", url: `${MOONSHINE}/onnx/encoder_model_quantized.onnx`, bytes: 20513063, sha256: "1dd9ab0a7f987113d30affcba5a068d11c8f90fa0223caa3e491ade431ad9751" },
  { path: "moonshine/decoder_model_merged_quantized.onnx", url: `${MOONSHINE}/onnx/decoder_model_merged_quantized.onnx`, bytes: 42498870, sha256: "cc9f3cd6698a369c6008b41aa60aa3fb3322e7f03c9bdf19d8e6b7200afca4f3" },
  { path: "moonshine/tokenizer.json", url: `${MOONSHINE}/tokenizer.json`, bytes: 3761754, sha256: "7b913404bdd039af4756783218af4440bc07fb7d6d8258d677e34f95b3ec416f" },
  { path: "kokoro/model_q8f16.onnx", url: `${KOKORO}/onnx/model_q8f16.onnx`, bytes: 86033585, sha256: "04c658aec1b6008857c2ad10f8c589d4180d0ec427e7e6118ceb487e215c3cd0" },
  { path: "kokoro/tokenizer.json", url: `${KOKORO}/tokenizer.json`, bytes: 3497, sha256: "77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34" },
  voice("af_heart", "d583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b"),
  voice("af_bella", "f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b"),
  voice("af_sarah", "4409fbc125afabacc615d94db5398d847006a737b0247d6892b7a9a0007a2f0a"),
  voice("am_michael", "1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1"),
  voice("am_fenrir", "c27989f741f7ee34d273a39d8a595cc0837d35f5ced9a29b7cc162614616df43"),
  voice("am_puck", "fcf73c989033e9233e0b98713eca600c8c74dcc1614b37009d5450ff4a2274a0"),
  voice("bf_emma", "669fe0647f9dd04fcab92f1439a40eeb4c8b4ab1f82e4996fe3d918ce4a63b73"),
  voice("bm_george", "c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc"),
  { path: "lexicon/us_gold.json", url: `${MISAKI}/us_gold.json`, bytes: 3000469, sha256: "dc414872a49a28ae6c141463d502fd945f3b2fde040484fdc47d00cc4612686f" },
  { path: "lexicon/us_silver.json", url: `${MISAKI}/us_silver.json`, bytes: 3099517, sha256: "de8f67be911bb6c659187b4a65fd966b6a30e56350e0f790d763210b053ac475" },
  { path: "lexicon/cmu_misaki_us.json", url: `${KITTEN}/g2p/cmu_misaki_us.json`, bytes: 3418388, sha256: "ae564e1a76df3501058a5ec99d135d016759c9475042fb6c3811374daee1ef04" },
];

export const TOTAL_BYTES = MODEL_FILES.reduce((sum, file) => sum + file.bytes, 0);

export type ModelGroup = "hear" | "speak";

export function groupOf(file: ModelFile): ModelGroup {
  return file.path.startsWith("moonshine/") ? "hear" : "speak";
}

/** madani.bot's copy, one folder per hash (scripts/mirror-voice-models.sh); the pinned upstream is the fallback. */
export const DEFAULT_MIRROR = "https://madani.bot/voice";

export function mirrorFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.MADANI_VOICE_MIRROR_URL?.trim();
  if (value === "off") return null;
  return (value || DEFAULT_MIRROR).replace(/\/+$/, "");
}

/** Where a file may come from, in the order tried; every copy is checked against the same hash. */
export function sourcesFor(file: ModelFile, mirror: string | null): string[] {
  return mirror ? [`${mirror}/${file.sha256}/${path.basename(file.path)}`, file.url] : [file.url];
}

/** Shared by every workspace on the computer, outside any data directory a backup copies. */
export function defaultModelDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.MADANI_VOICE_MODELS_DIR) return env.MADANI_VOICE_MODELS_DIR;
  const home = homedir();
  if (platform === "darwin") return path.join(home, "Library", "Caches", "bot.madani.app", "voice");
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "madanibot", "voice");
  return path.join(env.XDG_CACHE_HOME || path.join(home, ".cache"), "madanibot", "voice");
}

export type DownloadState =
  | { phase: "missing"; hear: boolean; speak: boolean }
  | { phase: "downloading"; received: number; total: number; hear: boolean; speak: boolean; background: boolean }
  | { phase: "ready"; hear: true; speak: true }
  | { phase: "failed"; error: string; received: number; total: number; hear: boolean; speak: boolean };

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

async function sha256Of(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

export class Paused extends Error {
  constructor() {
    super("the download was paused");
  }
}

export class ModelStore {
  readonly dir: string;
  private state: DownloadState;
  private running: Promise<void> | null = null;
  /** Set while the download runs in the background, so it can make way; a call's own request clears it. */
  private backgroundStop: AbortController | null = null;
  private readonly fetchImpl: Fetch;
  private readonly files: readonly ModelFile[];
  private readonly mirror: string | null;

  constructor({ dir = defaultModelDir(), fetchImpl = fetch, files = MODEL_FILES, mirror = mirrorFromEnv() }: { dir?: string; fetchImpl?: Fetch; files?: readonly ModelFile[]; mirror?: string | null } = {}) {
    this.dir = dir;
    this.fetchImpl = fetchImpl;
    this.files = files;
    this.mirror = mirror;
    this.state = this.rest();
  }

  file(relative: string): string {
    return path.join(this.dir, relative);
  }

  /** Whether every file one half of the voice needs is here. */
  ready(group: ModelGroup): boolean {
    return this.files.filter((file) => groupOf(file) === group).every((file) => this.present(file));
  }

  private present(file: ModelFile): boolean {
    return sizeOf(this.file(file.path)) === file.bytes;
  }

  private rest(): DownloadState {
    const hear = this.ready("hear");
    const speak = this.ready("speak");
    return hear && speak ? { phase: "ready", hear, speak } : { phase: "missing", hear, speak };
  }

  status(): DownloadState {
    if (!this.running && this.state.phase !== "failed") this.state = this.rest();
    return this.state;
  }

  private received(): number {
    return this.files.reduce((sum, file) => {
      const done = sizeOf(this.file(file.path));
      return sum + (done === file.bytes ? done : Math.min(sizeOf(`${this.file(file.path)}.part`), file.bytes));
    }, 0);
  }

  /** Starts or joins the download; resolves when every file is present and verified. `background` downloads can be
   * paused with pauseBackground() and reject with Paused; a later ensure() resumes where they stopped. */
  ensure({ background = false }: { background?: boolean } = {}): Promise<void> {
    if (this.status().phase === "ready") return Promise.resolve();
    if (!background) this.backgroundStop = null;
    if (!this.running) {
      const stop = background ? new AbortController() : null;
      this.backgroundStop = stop;
      this.running = this.download(stop?.signal).finally(() => {
        this.running = null;
        if (this.backgroundStop === stop) this.backgroundStop = null;
      });
    }
    return this.running;
  }

  /** Makes way for a turn, a call or a battery: the part files stay for the next ensure(). */
  pauseBackground(): void {
    this.backgroundStop?.abort();
  }

  private async download(signal?: AbortSignal): Promise<void> {
    const total = this.files.reduce((sum, file) => sum + file.bytes, 0);
    const halves = () => ({ hear: this.ready("hear"), speak: this.ready("speak") });
    this.state = { phase: "downloading", received: this.received(), total, ...halves(), background: Boolean(signal) };
    try {
      for (const file of this.files) {
        await this.fetchFile(file, signal);
        if (this.state.phase === "downloading") this.state = { ...this.state, ...halves() };
      }
      this.state = { phase: "ready", hear: true, speak: true };
    } catch (error) {
      if (error instanceof Paused) {
        this.state = this.rest();
        throw error;
      }
      this.state = { phase: "failed", error: error instanceof Error ? error.message : String(error), received: this.received(), total, ...halves() };
      throw error;
    }
  }

  private async fetchFile(file: ModelFile, signal?: AbortSignal): Promise<void> {
    const target = this.file(file.path);
    if (this.present(file)) return;
    mkdirSync(path.dirname(target), { recursive: true });
    const part = `${target}.part`;
    const sources = sourcesFor(file, this.mirror);
    // A background download that was asked to stop, unless a call has since taken it over.
    const stopped = () => Boolean(signal?.aborted) && this.backgroundStop?.signal === signal;
    for (let attempt = 0; ; attempt += 1) {
      if (stopped()) throw new Paused();
      try {
        let have = sizeOf(part);
        if (have > file.bytes) {
          rmSync(part, { force: true });
          have = 0;
        }
        if (have < file.bytes) {
          const res = await this.fetchImpl(sources[attempt % sources.length]!, { headers: have ? { range: `bytes=${have}-` } : {}, redirect: "follow", ...(signal ? { signal } : {}) });
          if (!res.ok || !res.body) throw new Error(`downloading ${path.basename(file.path)} failed (${res.status})`);
          // A server that ignores Range answers 200 with the whole file.
          const append = have > 0 && res.status === 206;
          const base = append ? have : 0;
          let written = 0;
          const counted = Readable.fromWeb(res.body as never).on("data", (chunk: Buffer) => {
            written += chunk.length;
            if (this.state.phase === "downloading") this.state = { ...this.state, received: this.received() - sizeOf(part) + base + written };
          });
          await pipeline(counted, createWriteStream(part, { flags: append ? "a" : "w" }), ...(signal ? [{ signal }] : []));
        }
        if (sizeOf(part) !== file.bytes || (await sha256Of(part)) !== file.sha256) {
          rmSync(part, { force: true });
          throw new Error(`${path.basename(file.path)} did not match its expected contents`);
        }
        renameSync(part, target);
        return;
      } catch (error) {
        if (stopped()) throw new Paused();
        if (attempt >= 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
  }

  has(relative: string): boolean {
    return existsSync(this.file(relative));
  }
}
