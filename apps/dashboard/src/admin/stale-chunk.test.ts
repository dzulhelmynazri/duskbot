import { expect, test } from "vitest";
import { reloadForStaleChunk } from "../lib/stale-chunk";

const memory = () => { const map = new Map<string, string>(); return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) }; };

// preview's admin showed "failed to fetch dynamically imported module" to a tab left open across a deploy
test("a chunk gone after a deploy reloads the page once, then lets the error show", () => {
  const storage = memory();
  let reloads = 0;
  const gone = new TypeError("Failed to fetch dynamically imported module: https://preview.madani.bot/dashboard/assets/AdminApp-old.js");
  expect(reloadForStaleChunk(gone, storage, () => reloads++, 1_000_000)).toBe(true);
  expect(reloadForStaleChunk(gone, storage, () => reloads++, 1_010_000)).toBe(false);
  expect(reloadForStaleChunk(gone, storage, () => reloads++, 1_040_000)).toBe(true);
  expect(reloads).toBe(2);
  expect(reloadForStaleChunk(new Error("something else"), storage, () => reloads++, 2_000_000)).toBe(false);
});
