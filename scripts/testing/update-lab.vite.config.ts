// the update pill lab (update-lab.tsx) as a static site: npx vite build -c scripts/testing/update-lab.vite.config.ts
// (into $UPDATE_LAB_OUT, default a temp folder; open scripts/testing/update-lab.html there), or
// npx vite -c scripts/testing/update-lab.vite.config.ts and open /scripts/testing/update-lab.html to work on it.
// its cache lives in the temp folder too: a shared node_modules/.vite would break the app's own dev server.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const root = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  // the repo, so Tailwind finds the classes the app's components use
  root,
  base: "./",
  cacheDir: join(tmpdir(), "madani-update-lab-cache"),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": join(root, "src") } },
  define: { __APP_VERSION__: JSON.stringify("0.2.15") },
  server: { host: "127.0.0.1", port: 5341, strictPort: true },
  build: { outDir: process.env.UPDATE_LAB_OUT || join(tmpdir(), "madani-update-lab"), emptyOutDir: true, rollupOptions: { input: { index: join(root, "scripts/testing/update-lab.html") } } },
});
