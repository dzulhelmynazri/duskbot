import type { IncomingMessage, ServerResponse } from "node:http";
import { SLACK_EDGE_SYNC_PATH, SLACK_EDGE_TOKENS_PATH } from "../../../../shared/slack-edge.ts";
import { createSlackApi } from "../../../../server/slack/api.ts";
import { createSlackSocket } from "../../../../server/slack/socket.ts";
import { createSealer, parseSealKey } from "../clouds/seal.ts";
import type { CloudsService } from "../clouds/types.ts";
import { createSlackEdge, EdgeError, type EdgeSocketFactory } from "./service.ts";

export interface SlackEdgeHostOptions {
  dataDir: string;
  clouds: CloudsService;
  env: NodeJS.ProcessEnv;
  /** loopback development may run without a seal key; anywhere else tokens are sealed at rest */
  loopback: boolean;
  now?: () => number;
  socket?: EdgeSocketFactory;
}
export interface SlackEdgeRequest {
  readBody(req: IncomingMessage): Promise<Buffer>;
  bodyObject(body: Buffer): Record<string, unknown>;
  /** the workspace a signed request comes from (the dashboard's ed25519 workspace signature) */
  signed(req: IncomingMessage, body: Buffer): { id: string };
  /** the signed-in owner; mutation checks csrf */
  account(req: IncomingMessage, mutation: boolean): { id: string };
  json(res: ServerResponse, status: number, data: unknown): void;
}

export function createSlackEdgeHost(options: SlackEdgeHostOptions) {
  const enabled = options.env.MADANI_SLACK_EDGE === "1";
  if (enabled && !options.loopback && !options.env.MADANI_CLOUD_SEAL_KEY) throw new Error("MADANI_SLACK_EDGE needs MADANI_CLOUD_SEAL_KEY.");
  const sealer = createSealer(options.env.MADANI_CLOUD_SEAL_KEY ? parseSealKey(options.env.MADANI_CLOUD_SEAL_KEY) : null);
  const api = createSlackApi({ env: options.env });
  const socket: EdgeSocketFactory = options.socket ?? (input => createSlackSocket({ api, appToken: () => input.appToken, onEvent: payload => input.onEvent(payload), onState: input.onState,
    log: () => {} }));
  const edge = createSlackEdge({ dataDir: options.dataDir, clouds: options.clouds, enabled, sealer, socket, now: options.now });

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL, http: SlackEdgeRequest): Promise<boolean> {
    const path = url.pathname, method = req.method ?? "GET";
    const wakeRoute = /^\/v1\/clouds\/([^/]+)\/slack-wake$/.exec(path);
    if (path !== SLACK_EDGE_SYNC_PATH && path !== SLACK_EDGE_TOKENS_PATH && !wakeRoute) return false;
    try {
      if (wakeRoute) {
        if (method !== "GET" && method !== "PUT" && method !== "PATCH") throw new EdgeError(404, "not_found");
        const mutation = method !== "GET";
        if (mutation && req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new EdgeError(403, "forbidden");
        const owner = http.account(req, mutation);
        const cloud = options.clouds.owned(owner.id, wakeRoute[1]!);
        if (!cloud || cloud.status === "destroyed") throw new EdgeError(404, "not_found");
        if (!mutation) { http.json(res, 200, edge.view(cloud)); return true; }
        const data = http.bodyObject(await http.readBody(req));
        if (typeof data.enabled !== "boolean") throw new EdgeError(400, "invalid_request");
        http.json(res, 200, edge.setEnabled(cloud, data.enabled));
        return true;
      }
      if (method !== "POST") throw new EdgeError(404, "not_found");
      const body = await http.readBody(req), workspace = http.signed(req, body), data = http.bodyObject(body);
      http.json(res, 200, path === SLACK_EDGE_SYNC_PATH ? edge.sync(workspace.id, data) : edge.tokens(workspace.id, data));
      return true;
    } catch (error) {
      if (!(error instanceof EdgeError)) throw error;
      http.json(res, error.status, { error: error.code, code: error.code });
      return true;
    }
  }
  return { handle, edge, enabled, close: () => edge.close() };
}
