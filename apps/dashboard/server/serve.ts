import type { IncomingMessage, Server, ServerResponse } from "node:http";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * Holds requests that arrive while the service starts (waiting for the writer lease, loading state) and hands them to the
 * app once it is ready, so a restart delays requests instead of refusing them; one held past `timeoutMs` gets a 503.
 */
export function readyGate(timeoutMs = 30_000) {
  let ready: Handler | null = null;
  const held = new Set<{ req: IncomingMessage; res: ServerResponse; timer: NodeJS.Timeout }>();
  return {
    handle(req: IncomingMessage, res: ServerResponse) {
      if (ready) return ready(req, res);
      const entry = { req, res, timer: setTimeout(() => {
        held.delete(entry);
        res.writeHead(503, { "content-type": "application/json", "retry-after": "5", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "madani bot is restarting; try again in a moment.", code: "starting" }));
      }, timeoutMs) };
      held.add(entry);
      res.once("close", () => { clearTimeout(entry.timer); held.delete(entry); });
    },
    open(handler: Handler) {
      ready = handler;
      for (const entry of held) { clearTimeout(entry.timer); held.delete(entry); if (!entry.res.writableEnded && !entry.res.destroyed) handler(entry.req, entry.res); }
    },
    held: () => held.size,
  };
}

/**
 * Listens, and while the port is still taken (the service before this one is stopping) tries again until it is free
 * instead of exiting. Never SO_REUSEPORT: a second start that waits for the lease must not take a share of the traffic.
 */
export async function listenWhenFree(server: Server, o: { port: number; host: string; everyMs?: number; log?: (line: string) => void; sleep?: (ms: number) => Promise<void> }) {
  const sleep = o.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  for (let tries = 0; ; tries += 1) {
    const error = await new Promise<NodeJS.ErrnoException | null>(resolve => {
      const failed = (e: NodeJS.ErrnoException) => { server.off("listening", done); resolve(e); };
      const done = () => { server.off("error", failed); resolve(null); };
      server.once("error", failed);
      server.once("listening", done);
      server.listen({ port: o.port, host: o.host });
    });
    if (!error) return;
    if (error.code !== "EADDRINUSE") throw error;
    if (tries % 20 === 0) o.log?.(`port ${o.port} is still taken (the service before this one is stopping); waiting`);
    await sleep(o.everyMs ?? 250);
  }
}

/**
 * Stops for a SIGTERM or a handoff: stops taking connections, lets the app stop its timers, writes what is pending and
 * gives the writer lease back (`closeDatabase`), then ends the connections left. `hardMs` later it is over regardless.
 */
export async function gracefulStop(o: { server: Server; closeApp: () => void; closeDatabase: () => Promise<void>; hardMs?: number; log?: (line: string) => void }): Promise<"clean" | "forced"> {
  const hard = new Promise<"forced">(resolve => { const timer = setTimeout(() => resolve("forced"), o.hardMs ?? 25_000); timer.unref(); });
  const clean = (async () => {
    o.server.close();
    o.server.closeIdleConnections();
    try { o.closeApp(); } catch (error) { o.log?.(`shutdown: the app did not close cleanly (${error instanceof Error ? error.message : String(error)})`); }
    await o.closeDatabase().catch(error => o.log?.(`shutdown: the database did not close cleanly (${error instanceof Error ? error.message : String(error)})`));
    o.server.closeAllConnections();
    return "clean" as const;
  })();
  return Promise.race([clean, hard]);
}
