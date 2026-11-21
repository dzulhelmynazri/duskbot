// The update digest the app shows once (`GET /api/updates/digest`, then `POST /api/updates/digest/seen`), and a managed
// home's update report for the Admin (`GET /api/cloud/update`, signed with the bootstrap secret like the power read), and
// what would hold a VPS install's update back (`GET /api/updates/busy`, owner-trust loopback only: root's updater,
// apps/link-service/install.sh --update-server, asks it before it replaces the server).
import type { IncomingMessage, ServerResponse } from "node:http";
import { createCloudRequestVerifier } from "../cloud-home.ts";
import { json } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { UpdateState } from "../update-state.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const UPDATE_DIGEST_PATH = "/api/updates/digest";
export const CLOUD_UPDATE_PATH = "/api/cloud/update";
export const UPDATE_BUSY_PATH = "/api/updates/busy";

const ownerLoopback = (auth: RequestAuth) => auth.kind === "loopback" && auth.trust !== "service" && !auth.companionDevice;

/** `busy`: the update holds now (shared/update-guard.ts UPDATE_HOLDS codes); empty when an update may restart the server */
export function createUpdateRoutes(state: () => UpdateState | null, busy: () => string[] = () => []): RouteHandler {
  return async ({ res, path, method, auth, json: send }) => {
    if (path === UPDATE_BUSY_PATH) {
      if (method !== "GET") return send(res, 405, { error: "method_not_allowed" });
      if (!ownerLoopback(auth)) return send(res, 403, { error: "only this server's own updater asks this" });
      res.setHeader("cache-control", "no-store");
      return send(res, 200, { busy: busy() });
    }
    if (path !== UPDATE_DIGEST_PATH && path !== `${UPDATE_DIGEST_PATH}/seen`) return PASS;
    const updates = state();
    if (path === UPDATE_DIGEST_PATH) {
      if (method !== "GET") return send(res, 405, { error: "method_not_allowed" });
      return send(res, 200, { digest: updates?.digest() ?? null });
    }
    if (method !== "POST") return send(res, 405, { error: "method_not_allowed" });
    updates?.seen();
    return send(res, 200, { ok: true });
  };
}

/** true when the request was the signed update read and has been answered */
export function createCloudUpdateRoute(deps: { secret: string; state: () => UpdateState | null; now?: () => number }) {
  const reads = createCloudRequestVerifier({ secret: deps.secret, now: deps.now });
  return (req: IncomingMessage, res: ServerResponse, url: URL, path: string, method: string): boolean => {
    if (path !== CLOUD_UPDATE_PATH) return false;
    const updates = deps.state();
    res.setHeader("cache-control", "no-store");
    if (!updates) { json(res, 404, { error: "not_found" }); return true; }
    if (method !== "GET") { json(res, 405, { error: "method_not_allowed" }); return true; }
    const header = (name: string) => { const value = req.headers[name]; return typeof value === "string" ? value : undefined; };
    const verdict = reads.verify({ timestamp: header("x-madani-cloud-timestamp"), nonce: header("x-madani-cloud-nonce"), signature: header("x-madani-cloud-signature"), method, target: `${path}${url.search}`, body: "" });
    if (!verdict.ok) { json(res, verdict.status, { error: verdict.error }); return true; }
    json(res, 200, updates.report());
    return true;
  };
}
