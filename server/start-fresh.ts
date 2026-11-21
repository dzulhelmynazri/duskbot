// "Start fresh" (the desktop app's reset): its owner asks this server to forget everything it holds, every bot, chat,
// memory, routine, file and sign-in, and come back as a brand-new install. The ask only leaves a marker and restarts; the
// next start removes the data folder's contents before anything opens it, so nothing still open writes a file back, and a
// start cut off halfway wipes again. Tools and caches that hold nothing of the person's stay, so the next start is quick.
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { keptInDataDir as kept } from "../electron/start-fresh.mjs";
import type { RequestAuth } from "./request-auth.ts";
import { PASS, type RouteHandler } from "./routes/table.ts";

export const START_FRESH_MARKER = "start-fresh.pending";

export function requestStartFresh(dataDir: string): void {
  writeFileSync(join(dataDir, START_FRESH_MARKER), JSON.stringify({ v: 1, at: Date.now() }), { mode: 0o600 });
}

/** At start, before any store opens: true when a start-fresh was pending and the folder is now empty of the person's data. */
export function applyPendingStartFresh(dataDir: string): boolean {
  if (!existsSync(join(dataDir, START_FRESH_MARKER))) return false;
  for (const name of readdirSync(dataDir)) {
    if (name === START_FRESH_MARKER || kept(name)) continue;
    rmSync(join(dataDir, name), { recursive: true, force: true });
  }
  // the marker goes last: a start that stops before here wipes again
  rmSync(join(dataDir, START_FRESH_MARKER), { force: true });
  return true;
}

export interface StartFreshRouteDeps {
  dataDir: string;
  /** a server of one person's own, and this request is theirs (own-home.ts) */
  owner(auth: RequestAuth): boolean;
  /** a Cloud, a team's Cloud or a hosted workspace: Madani or an organization runs it, so no one person wipes it here */
  managed(): boolean;
  restart(): void;
}

/** POST /api/start-fresh: only this computer's own desktop app (owner-trust loopback) or the one owner of a server of their
 * own. Never a shared server's bot shells, a member, a guest, or a managed Cloud. */
export function createStartFreshRoutes({ dataDir, owner, managed, restart }: StartFreshRouteDeps): RouteHandler {
  return async ({ res, path, method, auth, json }) => {
    if (path !== "/api/start-fresh") return PASS;
    if (method !== "POST") return json(res, 405, { error: "method not allowed" });
    const allowed = auth.kind === "loopback" ? auth.trust !== "service" : owner(auth);
    if (!allowed || managed()) return json(res, 403, { error: "Only this server's owner can delete everything on it." });
    requestStartFresh(dataDir);
    json(res, 202, { wiping: true });
    restart();
  };
}
