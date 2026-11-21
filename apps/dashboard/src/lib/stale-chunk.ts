const STALE_KEY = "madani-stale-chunk-reload";
/** a tab opened before a deploy asks for chunks the new build no longer has: load the new build once, at most every
 * 30 s so a chunk that is really missing still shows its error instead of reloading forever */
export function reloadForStaleChunk(error: unknown, storage: Pick<Storage, "getItem" | "setItem"> = sessionStorage, reload = () => location.reload(), now = Date.now()) {
  const message = String((error as Error | null)?.message ?? "");
  if (!/dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(message)) return false;
  try {
    if (now - Number(storage.getItem(STALE_KEY) ?? 0) < 30_000) return false;
    storage.setItem(STALE_KEY, String(now));
  } catch { return false; }
  reload();
  return true;
}
