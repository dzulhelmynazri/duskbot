// After the app or the dev server swaps its built files, a page that loaded the old ones can no longer fetch a part
// it loads later ("Failed to fetch dynamically imported module"). One quiet reload brings the page onto the new files;
// a second failure within a minute is left alone so a real outage never turns into a reload loop.
const KEY = "madani.staleChunkReloadAt";
const WINDOW_MS = 60_000;

export const STALE_CHUNK = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError|Loading (?:CSS )?chunk \S+ failed/i;

export function isStaleChunkError(reason: unknown): boolean {
  const text = reason instanceof Error ? reason.message : String(reason ?? "");
  return STALE_CHUNK.test(text);
}

export function reloadForStaleChunks(storage: Pick<Storage, "getItem" | "setItem"> = sessionStorage, now = Date.now(), reload = () => location.reload()): boolean {
  const last = Number(storage.getItem(KEY) ?? 0);
  if (now - last < WINDOW_MS) return false;
  storage.setItem(KEY, String(now));
  reload();
  return true;
}

export function watchStaleChunks(target: Window = window) {
  // swallowed only while a reload is on its way: a second failure reaches the screen that asked, which offers a reload
  target.addEventListener("vite:preloadError", (event) => { if (reloadForStaleChunks()) event.preventDefault(); });
  target.addEventListener("unhandledrejection", (event) => { if (isStaleChunkError(event.reason)) reloadForStaleChunks(); });
}
