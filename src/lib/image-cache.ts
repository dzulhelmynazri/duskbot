import { __resetMediaSizesForTests, noteMediaSizes, rememberImageSize, validSize, type MediaSize } from "./media-sizes";

export { knownImageSize, noteMediaSizes, rememberImageSize, reservedAspect, type MediaSize } from "./media-sizes";

const DECODED_MAX = 160;
/** Decoded images kept alive so a chat opened again paints them in the first frame, without a fade or a re-decode. */
const decoded = new Map<string, HTMLImageElement>();
const pending = new Map<string, Promise<boolean>>();

/** True when this URL already loaded and decoded in this window. */
export function imageReady(src: string): boolean {
  const image = decoded.get(src);
  if (!image) return false;
  decoded.delete(src);
  decoded.set(src, image);
  return true;
}

function keep(src: string, image: HTMLImageElement): void {
  decoded.delete(src);
  decoded.set(src, image);
  while (decoded.size > DECODED_MAX) decoded.delete(decoded.keys().next().value!);
}

/** An image element that finished loading: kept decoded for the next mount of the same URL. */
export function noteImageLoaded(src: string, image: HTMLImageElement): void {
  if (!src || src.startsWith("blob:")) return;
  if (image.naturalWidth > 0) rememberImageSize(src, { width: image.naturalWidth, height: image.naturalHeight });
  keep(src, image);
}

/** Fetches and decodes `src` off screen; resolves false when it cannot load. */
export function warmImage(src: string): Promise<boolean> {
  if (typeof Image === "undefined" || !src || decoded.has(src)) return Promise.resolve(decoded.has(src));
  const running = pending.get(src);
  if (running) return running;
  const image = new Image();
  image.decoding = "async";
  const done = new Promise<boolean>((resolve) => {
    image.onload = () => {
      const finish = () => { noteImageLoaded(src, image); resolve(true); };
      if (typeof image.decode === "function") void image.decode().then(finish, finish);
      else finish();
    };
    image.onerror = () => resolve(false);
  }).finally(() => pending.delete(src));
  pending.set(src, done);
  image.src = src;
  return done;
}

const STORED_IMAGE = /^[A-Za-z0-9-]+\.(?:png|jpg|gif|webp)$/;

/** Warm the stored pictures the newest messages of a chat show, a few at a time, at idle. */
export function warmChatImages(messages: ReadonlyArray<{ media?: Record<string, MediaSize> }>, limit = 12): void {
  const names: string[] = [];
  for (let index = messages.length - 1; index >= 0 && names.length < limit; index--) {
    const media = messages[index]?.media;
    if (!media) continue;
    noteMediaSizes(media);
    for (const name of Object.keys(media)) if (STORED_IMAGE.test(name) && names.length < limit) names.push(name);
  }
  if (!names.length) return;
  const run = async () => {
    for (const name of names) await warmImage(`/api/attachments/${encodeURIComponent(name)}`);
  };
  const idle = (globalThis as { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number }).requestIdleCallback;
  if (idle) idle(() => void run(), { timeout: 2_000 });
  else setTimeout(() => void run(), 200);
}

export function __resetImageCacheForTests(): void {
  __resetMediaSizesForTests();
  decoded.clear();
  pending.clear();
  rendered = null;
}

const RENDERED_KEY = "madani.rendered-sizes";
const RENDERED_MAX = 200;
let rendered: Map<string, MediaSize> | null = null;

function renderedSizes(): Map<string, MediaSize> {
  if (rendered) return rendered;
  rendered = new Map();
  try {
    const stored = JSON.parse(globalThis.localStorage?.getItem(RENDERED_KEY) ?? "[]") as Array<[string, MediaSize]>;
    for (const [key, size] of Array.isArray(stored) ? stored : []) if (typeof key === "string" && validSize(size)) rendered.set(key, size);
  } catch {
    rendered.clear();
  }
  return rendered;
}

/** The size something drawn late (a diagram) had the last time, kept across launches so its box is reserved. */
export function renderedSize(key: string): MediaSize | undefined {
  return renderedSizes().get(key);
}

export function rememberRenderedSize(key: string, size: MediaSize): void {
  if (!validSize(size)) return;
  const sizes = renderedSizes();
  const had = sizes.get(key);
  if (had && had.w === size.w && had.h === size.h) return;
  sizes.delete(key);
  sizes.set(key, size);
  while (sizes.size > RENDERED_MAX) sizes.delete(sizes.keys().next().value!);
  try { globalThis.localStorage?.setItem(RENDERED_KEY, JSON.stringify([...sizes])); } catch { /* storage full or blocked: the box is only reserved this session */ }
}
