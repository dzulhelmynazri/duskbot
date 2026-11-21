// A test, check or verify script that starts its own Vite dev server keeps its deps cache under .madani-scratch. Without
// `cacheDir` it shares node_modules/.vite with the developer's running dev server (a worktree links the same folder),
// rewrites its optimized deps under it, and that page then fails to load parts it fetches later.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./preview-fixture.ts";

const DIRS = ["scripts", "src", "server", "apps", "electron", "evals"];
const SKIP = /(^|\/)(node_modules|dist[\w-]*|\.madani-scratch)(\/|$)/;
const files = DIRS.flatMap((dir) => {
  try { return readdirSync(join(REPO_ROOT, dir), { recursive: true, encoding: "utf8" }).map((name) => join(dir, name)); } catch { return []; }
}).filter((name) => /\.(?:[cm]?[jt]sx?)$/.test(name) && !SKIP.test(name) && !/vite\.config\.[cm]?ts$/.test(name));

let checked = 0;
const unpinned = files.flatMap((file) => {
  const text = readFileSync(join(REPO_ROOT, file), "utf8");
  if (!/from ["']vite["']|import\(["']vite["']\)/.test(text)) return [];
  const calls = [...text.matchAll(/\b(?:createServer|createViteServer)\(\s*\{/g)];
  checked += calls.length;
  return calls.filter((call) => !/\bcacheDir\b/.test(text.slice(call.index, call.index + 600))).map((call) => `${file}:${text.slice(0, call.index).split("\n").length}`);
});

describe("test Vite servers", () => {
  it("each keep their own deps cache, never the developer's node_modules/.vite", () => {
    // the preview fixture, the gallery's desktop run, the verify scripts and the ambient checks
    expect(checked).toBeGreaterThanOrEqual(8);
    expect(unpinned).toEqual([]);
  });
});
