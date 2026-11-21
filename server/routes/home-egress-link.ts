// GET /api/computer/egress/link (websocket): the person's app on their own computer, so sites that block this madani cloud
// home are browsed through their connection (server/home-egress-link.ts). Owner or admin only, from the app's paired
// device (bearer), or the owner's own page; a cookie from another origin is refused.
import { createWebSocketStream, WebSocketServer } from "ws";

import type { HomeEgressLink } from "../home-egress-link.ts";
import { isSameOrigin, ownerOrAdmin } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";
import type { Upgrades } from "./upgrades.ts";

export const HOME_EGRESS_LINK_PATH = "/api/computer/egress/link";

export function createHomeEgressLinkRoutes({ link, upgrades }: { link: HomeEgressLink | null; upgrades: Pick<Upgrades, "route" | "pending"> }): RouteHandler {
  const sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 4 * 1024 * 1024 });
  upgrades.route((path) => path === HOME_EGRESS_LINK_PATH);
  return async ({ req, res, path, method, auth, json }) => {
    if (path !== HOME_EGRESS_LINK_PATH) return PASS;
    if (!link) return json(res, 404, { error: "this server has no link for the person's connection" });
    if (method !== "GET") return json(res, 405, { error: "method not allowed" });
    if (!ownerOrAdmin(auth)) return json(res, 403, { error: "only the owner's app can lend its connection" });
    if (auth.kind === "session" && auth.via === "cookie" && !isSameOrigin(req)) return json(res, 403, { error: "forbidden: cross-origin request" });
    const pending = upgrades.pending(req);
    if (!pending) return json(res, 426, { error: "WebSocket upgrade required" });
    if (pending.socket.destroyed) return;
    pending.release();
    req.socket.setTimeout(0);
    sockets.handleUpgrade(req, pending.socket, pending.head, (ws) => {
      const stream = createWebSocketStream(ws);
      stream.on("error", () => stream.destroy());
      link.attach(stream);
    });
    res.detachSocket(pending.socket);
  };
}
