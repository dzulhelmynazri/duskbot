// The demo's own Vite dev server: the repository's vite.config.ts with its /api proxy pointed at the demo harness
// (MADANI_PORT), on its own port and with its own dependency cache, so it never shares state with `pnpm dev` on 5199.
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const port = Number(process.env.MADANI_UI_PORT);
if (!Number.isInteger(port) || !process.env.MADANI_PORT) throw new Error("vite-demo needs MADANI_UI_PORT and MADANI_PORT");

const server = await createServer({
  configFile: fileURLToPath(new URL("../../vite.config.ts", import.meta.url)),
  root: repo,
  cacheDir: fileURLToPath(new URL("../../node_modules/.vite-demo", import.meta.url)),
  clearScreen: false,
  server: { host: "127.0.0.1", port, strictPort: true, open: false },
});
await server.listen();
console.log(`demo ui on http://127.0.0.1:${port}, api -> 127.0.0.1:${process.env.MADANI_PORT}`);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => void server.close().finally(() => process.exit(0)));
}
