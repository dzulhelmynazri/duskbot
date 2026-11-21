// Local sentence embeddings for memory recall: BAAI bge-small-en-v1.5 (MIT), int8-quantized ONNX export by Xenova,
// run with onnxruntime-web's WebAssembly build (MIT). Nothing is sent anywhere to embed: the model and runtime are
// downloaded once into the data folder, checked against pinned SHA-256 digests, and run in this process.
// Until they are present, or if anything fails, recall works from words alone.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { DATA_DIR } from "./config.ts";

export const EMBED_MODEL = "bge-small-en-v1.5-q8";
export const EMBED_DIMS = 384;
const ORT = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist";
const HF = "https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main";
const FILES = [
  { name: "ort.wasm.min.mjs", url: `${ORT}/ort.wasm.min.mjs`, sha256: "c21d9c326d453a4a61398270c804d5979e118540597cb0c07f7b3d64e6098234" },
  { name: "ort-wasm-simd-threaded.mjs", url: `${ORT}/ort-wasm-simd-threaded.mjs`, sha256: "30ed0b5cd1182ede931fea448afb567d4dc705ec957af09f108a2be5f770dac3" },
  { name: "ort-wasm-simd-threaded.wasm", url: `${ORT}/ort-wasm-simd-threaded.wasm`, sha256: "4b884c203b0fa48d057be3332c65513ff85aa3c5bddd6946acc0fab7ecda001d" },
  { name: "model_quantized.onnx", url: `${HF}/onnx/model_quantized.onnx`, sha256: "6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4" },
  { name: "tokenizer.json", url: `${HF}/tokenizer.json`, sha256: "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66" },
] as const;
/** bge v1.5 retrieves best when the question, not the stored passage, carries this instruction. */
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
const MAX_TOKENS = 128;
const MIN_FREE_BYTES = 1024 ** 3;
const RETRY_AFTER_MS = 6 * 60 * 60_000;

/** `MADANI_MEMORY_EMBED=0` turns local embeddings off; under a test runner they are off unless set to 1. */
export function embeddingsWanted(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.MADANI_MEMORY_EMBED === "0") return false;
  if (env.MADANI_MEMORY_EMBED === "1") return true;
  return !env.VITEST && env.NODE_ENV !== "test";
}

export function modelDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.MADANI_MODEL_DIR?.trim() || join(DATA_DIR, "models", EMBED_MODEL);
}

type Ort = {
  env: { wasm: { numThreads: number; wasmPaths: string } };
  InferenceSession: { create(model: Uint8Array): Promise<Session> };
  Tensor: new (type: "int64", data: BigInt64Array, dims: number[]) => unknown;
};
type Session = { inputNames: string[]; outputNames: string[]; run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array; dims: number[] }>> };

interface Loaded {
  ort: Ort;
  session: Session;
  vocab: Map<string, number>;
}

let loaded: Loaded | null = null;
let loading: Promise<Loaded | null> | null = null;
let failedAt = 0;
let chain: Promise<unknown> = Promise.resolve();
let log: (line: string) => void = (line) => console.warn(line);

export function setEmbedLog(fn: (line: string) => void): void {
  log = fn;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function present(dir: string): boolean {
  return FILES.every((file) => existsSync(join(dir, file.name)));
}

async function download(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const free = (() => {
    try {
      const fs = statfsSync(dir);
      return fs.bavail * fs.bsize;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  })();
  if (free < MIN_FREE_BYTES) throw new Error("less than 1 GB of disk free");
  for (const file of FILES) {
    const target = join(dir, file.name);
    if (existsSync(target) && sha256(target) === file.sha256) continue;
    const res = await fetch(file.url, { signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok) throw new Error(`${file.name}: HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error(`${file.name}: checksum mismatch`);
    const part = `${target}.part`;
    writeFileSync(part, bytes, { mode: 0o600 });
    renameSync(part, target);
  }
}

/** Where ort loads its wasm glue and binary from. A file:// URL with a trailing slash, which a bare Windows path is not. */
export function wasmPrefix(dir: string): string {
  const url = pathToFileURL(dir).href;
  return url.endsWith("/") ? url : `${url}/`;
}

async function load(dir: string): Promise<Loaded> {
  for (const file of FILES) {
    if (sha256(join(dir, file.name)) !== file.sha256) {
      rmSync(join(dir, file.name), { force: true });
      throw new Error(`${file.name} changed on disk; it will be downloaded again`);
    }
  }
  const ort = (await import(pathToFileURL(join(dir, "ort.wasm.min.mjs")).href)) as Ort;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = wasmPrefix(dir);
  const session = await ort.InferenceSession.create(readFileSync(join(dir, "model_quantized.onnx")));
  const tokenizer = JSON.parse(readFileSync(join(dir, "tokenizer.json"), "utf8")) as { model: { vocab: Record<string, number> } };
  return { ort, session, vocab: new Map(Object.entries(tokenizer.model.vocab)) };
}

/** Starts the one-time download and load in the background; recall never waits for it. */
export function warmEmbedder(): void {
  if (!embeddingsWanted() || loaded || loading || (failedAt && Date.now() - failedAt < RETRY_AFTER_MS)) return;
  const dir = modelDir();
  loading = (async () => {
    try {
      if (!present(dir)) {
        log(`memory: downloading the local embedding model (about 50 MB) into ${dir}`);
        await download(dir);
      }
      loaded = await load(dir);
      return loaded;
    } catch (error) {
      failedAt = Date.now();
      log(`memory: local embeddings unavailable, recall uses words only: ${(error as Error).message}`);
      return null;
    } finally {
      loading = null;
    }
  })();
}

export function embedderReady(): boolean {
  return loaded !== null;
}

/** Waits for a warm-up already started; true when the model is ready. */
export async function embedderSettled(): Promise<boolean> {
  if (loading) await loading;
  return loaded !== null;
}

function words(text: string): string[] {
  const folded = text.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase().replace(/\p{Cc}/gu, " ");
  return folded
    .replace(/([㐀-䶿一-鿿豈-﫿])/g, " $1 ")
    .split(/\s+/)
    .flatMap((word) => word.split(/([\p{P}\p{S}])/u))
    .filter(Boolean);
}

/** BERT WordPiece, uncased, as bge-small's tokenizer.json describes it. */
function encode(vocab: Map<string, number>, text: string): number[] {
  const unk = vocab.get("[UNK]")!;
  const ids: number[] = [];
  for (const word of words(text)) {
    if (word.length > 100) {
      ids.push(unk);
      continue;
    }
    const pieces: number[] = [];
    let start = 0;
    while (start < word.length) {
      let end = word.length;
      let piece: number | undefined;
      while (start < end) {
        piece = vocab.get(`${start > 0 ? "##" : ""}${word.slice(start, end)}`);
        if (piece !== undefined) break;
        end -= 1;
      }
      if (piece === undefined) {
        pieces.length = 0;
        pieces.push(unk);
        break;
      }
      pieces.push(piece);
      start = end;
    }
    ids.push(...pieces);
    if (ids.length >= MAX_TOKENS - 2) break;
  }
  return [vocab.get("[CLS]")!, ...ids.slice(0, MAX_TOKENS - 2), vocab.get("[SEP]")!];
}

async function run(model: Loaded, texts: readonly string[]): Promise<Float32Array[]> {
  const encoded = texts.map((text) => encode(model.vocab, text));
  const width = Math.max(...encoded.map((ids) => ids.length));
  const size = texts.length * width;
  const ids = new BigInt64Array(size);
  const mask = new BigInt64Array(size);
  encoded.forEach((row, i) => row.forEach((id, j) => {
    ids[i * width + j] = BigInt(id);
    mask[i * width + j] = 1n;
  }));
  const feeds: Record<string, unknown> = {
    input_ids: new model.ort.Tensor("int64", ids, [texts.length, width]),
    attention_mask: new model.ort.Tensor("int64", mask, [texts.length, width]),
  };
  if (model.session.inputNames.includes("token_type_ids")) feeds.token_type_ids = new model.ort.Tensor("int64", new BigInt64Array(size), [texts.length, width]);
  const out = await model.session.run(feeds);
  const hidden = out[model.session.outputNames[0]!]!;
  const dims = hidden.dims[2]!;
  // bge pools with the [CLS] vector, then normalizes it
  return texts.map((_, i) => {
    const offset = i * width * dims;
    const vector = Float32Array.from(hidden.data.subarray(offset, offset + dims));
    let norm = 0;
    for (const x of vector) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    for (let k = 0; k < vector.length; k++) vector[k]! /= norm;
    return vector;
  });
}

/** Vectors for stored passages, or null when embeddings are not ready. One model call at a time. */
export function embedPassages(texts: readonly string[]): Promise<Float32Array[] | null> {
  const model = loaded;
  if (!model || !texts.length) return Promise.resolve(model ? [] : null);
  const next = chain.then(() => run(model, texts)).catch((error: unknown) => {
    log(`memory: embedding failed: ${(error as Error).message}`);
    return null;
  });
  chain = next;
  return next;
}

export async function embedQuery(text: string): Promise<Float32Array | null> {
  const vectors = await embedPassages([`${QUERY_PREFIX}${text}`]);
  return vectors?.[0] ?? null;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length && i < b.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

export function vectorBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
}

export function blobVector(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob);
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}
