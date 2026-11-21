// The AI grid's last known "Connected" cards, kept on this device so a reopened grid draws them in its first frame. The
// server's list answers "Checking engine status" for an engine it has not read yet since it started, and its first
// answer can take a while; until a card's engine has a real answer, the card shows what it last showed.
import type { AiTileId } from "./funnel";

const KEY = "madani:ai-connected";
const CHECKING = /^Checking engine status$/;

type Snapshot = { state: string; reason?: string };
type Tile = { id: AiTileId; candidates: ReadonlyArray<{ snapshot: Snapshot }> };

export function readConnectedCache(storage: Pick<Storage, "getItem"> | null = safeStorage()): ReadonlySet<AiTileId> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is AiTileId => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export function writeConnectedCache(ids: ReadonlySet<AiTileId>, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try { storage?.setItem(KEY, JSON.stringify([...ids].sort())); } catch { /* private mode or full: the next open reads live */ }
}

/** A card whose every engine is still waiting for the server's first read: what it shows is not known yet. */
export function tilePending(tile: Tile): boolean {
  return tile.candidates.length > 0 && tile.candidates.every((candidate) => candidate.snapshot.state !== "available" && CHECKING.test(candidate.snapshot.reason ?? ""));
}

/** The cards drawn as connected: live where the server has answered, the last known where it has not yet. `next` is the
 * cache to keep: settled cards take their live answer, pending ones keep what they had. */
export function connectedCards<T extends Tile>(tiles: readonly T[], live: (tile: T) => boolean, cached: ReadonlySet<AiTileId>): { shown: Set<AiTileId>; next: Set<AiTileId> } {
  const shown = new Set<AiTileId>();
  const next = new Set<AiTileId>(cached);
  for (const tile of tiles) {
    if (live(tile)) { shown.add(tile.id); next.add(tile.id); continue; }
    if (tilePending(tile)) { if (cached.has(tile.id)) shown.add(tile.id); continue; }
    next.delete(tile.id);
  }
  return { shown, next };
}

function safeStorage(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}
