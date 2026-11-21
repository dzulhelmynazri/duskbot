// The server's side of the debug trail (electron/trail.mjs): the same JSON lines, in trail-server.jsonl in the desktop
// app's logs folder when the app started this server, else in <data dir>/logs (a VPS, a Cloud home). A request that
// carries x-madani-trail names every event it causes with that id (cid), so one action reads the same on both machines.
import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { TRAIL_CAP_BYTES, TRAIL_HEADER, configureTrail, createTrailWriter, trail, trailError, validTrailId } from "../electron/trail.mjs";

export { trail, trailError };

const scope = new AsyncLocalStorage<{ cid: string }>();

let started = false;
/** once, at startup; `src` is "server" on a computer or VPS and "cloud" on a Cloud home */
export function startServerTrail({ dataDir, src, env = process.env }: { dataDir: string; src: string; env?: NodeJS.ProcessEnv }): void {
  if (started) return;
  started = true;
  try {
    const dir = env.MADANI_TRAIL_DIR || env.MADANI_LOG_DIR || join(dataDir, "logs");
    const cap = Number(env.MADANI_TRAIL_CAP) > 0 ? Number(env.MADANI_TRAIL_CAP) : TRAIL_CAP_BYTES.packaged / 2;
    const writer = configureTrail({ src, writer: createTrailWriter({ dir, prefix: "trail-server", capBytes: cap }), context: () => scope.getStore() ?? null });
    process.on("exit", () => writer.flushSync());
    process.on("uncaughtExceptionMonitor", (error, origin) => { trailError(origin === "unhandledRejection" ? "server.unhandled-rejection" : "server.uncaught", error); writer.flushSync(); });
    trail("server.start", { pid: process.pid, version: env.MADANI_APP_VERSION });
  } catch { /* the server runs without a trail rather than not at all */ }
}

/** the trail id a request carries, when it is a well-formed one */
export function requestTrailId(req: IncomingMessage): string | undefined {
  const value = req.headers[TRAIL_HEADER];
  return validTrailId(value) ? value : undefined;
}

/** runs a request with its trail id in scope; a named request, and any that fails on the server, is recorded when it ends */
export function withRequestTrail<T>(req: IncomingMessage, res: ServerResponse, handle: () => T): T {
  const cid = requestTrailId(req);
  const startedAt = Date.now();
  res.once("close", () => {
    try {
      if (!cid && res.statusCode < 500) return;
      trail("http.req", {
        ...(cid ? { cid } : {}), method: req.method, path: req.url, status: res.statusCode, ms: Date.now() - startedAt,
        // reached through the app's link (the agent forwards it) or straight from this computer
        via: req.headers["x-forwarded-for"] === undefined ? "local" : "tunnel",
      });
    } catch { /* never */ }
  });
  return cid ? scope.run({ cid }, handle) : handle();
}

/** the trail id of the request this code runs for, if it named one */
export function currentTrailId(): string | undefined {
  return scope.getStore()?.cid;
}
