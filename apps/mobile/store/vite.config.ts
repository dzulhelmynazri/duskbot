import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import base from "../vite.config.ts";

// a git worktree links node_modules into the main checkout, so vite has to be allowed to serve the fonts from there;
// MADANI_VITE_CACHE_DIR keeps a worktree's prebundle out of the checkout's shared one
const modules = realpathSync(fileURLToPath(new URL("../../../node_modules", import.meta.url)));
export default {
  ...base,
  ...(process.env.MADANI_VITE_CACHE_DIR ? { cacheDir: process.env.MADANI_VITE_CACHE_DIR } : {}),
  server: { ...base.server, fs: { allow: [...(base.server?.fs?.allow ?? []), modules] } },
};
