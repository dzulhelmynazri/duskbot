import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { licenseFiles } from "../../scripts/license-files.ts";

const root = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
// a git worktree links node_modules to the main checkout: the fonts and packages served from there are allowed too
const modules = fileURLToPath(new URL("../../node_modules", import.meta.url));
const allow = existsSync(modules) ? [repoRoot, realpathSync(modules)] : [repoRoot];
const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
const target = `http://127.0.0.1:${process.env.MADANI_PORT || 8799}`;

export default defineConfig({
  root,
  plugins: [react(), tailwindcss(), licenseFiles(repoRoot)],
  resolve: { alias: { "@": fileURLToPath(new URL("../../src", import.meta.url)) } },
  define: { __APP_VERSION__: JSON.stringify(version), __MADANI_ERROR_DSN__: JSON.stringify(process.env.MADANI_ERROR_DSN ?? "") },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.MADANI_MOBILE_PORT) || 5320,
    strictPort: true,
    fs: { allow },
    proxy: {
      "/api": { ws: true, target },
      "/.well-known/madanibot/environment": { target },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      // phone.html is the development preview frame: the dev server serves it, a build never carries it
      input: { index: fileURLToPath(new URL("./index.html", import.meta.url)) },
    },
  },
});
