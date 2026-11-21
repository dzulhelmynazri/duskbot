import type { IncomingMessage, ServerResponse } from "node:http";
import { isClientSource } from "./fingerprint.ts";
import type { ClientSource } from "./fingerprint.ts";
import type { Incidents } from "./index.ts";

export const ERRORS_PATH = "/v1/errors";
export const LEGACY_ERRORS_PATH = "/v1/client-error";
/** a client error report's whole body */
export const MAX_ERROR_BYTES = 16 * 1024;
/** per address, per hour (the service's rate window) */
export const ERRORS_PER_HOUR = 240;

export class IncidentRouteError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

export interface IncidentRouteOptions {
  incidents: Incidents;
  json(res: ServerResponse, status: number, data: unknown): void;
  readBody(req: IncomingMessage): Promise<Buffer>;
  bodyObject(body: Buffer): Record<string, unknown>;
  rate(req: IncomingMessage, kind: string, max: number): void;
  /** throws unless the request is an admin's signed-in web session (with the CSRF check on changes) */
  admin(req: IncomingMessage, mutation: boolean): void;
  /** also told of every client error: the sentry-compatible reporter when MADANI_ERROR_DSN is set */
  onClientError?(error: Error, page: string): void;
}

const text = (value: unknown, max: number) => typeof value === "string" ? value.slice(0, max) : "";
const integer = (value: string | null, fallback: number, min: number, max: number) => {
  const n = value === null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new IncidentRouteError(400, "invalid_request", "Invalid request.");
  return n;
};

export function createIncidentRoutes(options: IncidentRouteOptions) {
  const { incidents, json } = options;

  /** security: unauthenticated by design (pages and apps report before sign-in); rate-limited per address, size-capped,
   *  and every field is re-scrubbed server-side as untrusted client text */
  async function clientError(req: IncomingMessage, res: ServerResponse) {
    options.rate(req, "client-error", ERRORS_PER_HOUR);
    if (Number(req.headers["content-length"] ?? 0) > MAX_ERROR_BYTES) throw new IncidentRouteError(413, "too_large", "Request is too large.");
    const body = await options.readBody(req);
    if (body.length > MAX_ERROR_BYTES) throw new IncidentRouteError(413, "too_large", "Request is too large.");
    const input = options.bodyObject(body);
    const name = /^[A-Za-z_$][\w$]{0,60}$/.test(text(input.type, 61)) ? text(input.type, 61) : "Error";
    const message = text(input.message, 500), stack = text(input.stack, 4000);
    const path = text(input.path, 120) || text(input.page, 120);
    const claimed = text(input.source, 20);
    const source: ClientSource = isClientSource(claimed) ? claimed : path.startsWith("/admin") ? "admin" : "web";
    incidents.report({ source, name, message, stack, path: path || null, route: path || null, version: text(input.version, 40) || null, os: text(input.os, 40) || null });
    if (options.onClientError) {
      const error = new Error(message);
      error.name = name;
      error.stack = `${name}: ${message}\n${stack}`;
      options.onClientError(error, path.split("/").slice(0, 2).join("/").replace(/[^\w/-]/g, "") || "unknown");
    }
    res.writeHead(204, { "cache-control": "no-store" });
    res.end();
  }

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const method = req.method ?? "GET", path = url.pathname;
    if (method === "POST" && (path === ERRORS_PATH || path === LEGACY_ERRORS_PATH)) { await clientError(req, res); return true; }
    if (path !== "/v1/admin/incidents" && !path.startsWith("/v1/admin/incidents/")) return false;
    if (method === "GET" && path === "/v1/admin/incidents") {
      options.admin(req, false);
      const limit = integer(url.searchParams.get("limit"), 50, 1, 200);
      const before = url.searchParams.has("before") ? integer(url.searchParams.get("before"), 0, 1, Number.MAX_SAFE_INTEGER) : undefined;
      const source = url.searchParams.get("source") || undefined;
      if (source !== undefined && !/^[a-z-]{2,20}$/.test(source)) throw new IncidentRouteError(400, "invalid_request", "Invalid request.");
      const list = await incidents.list({ limit, before, source });
      json(res, 200, { incidents: list, next: list.length === limit ? list.at(-1)!.lastSeen : null, stats: incidents.stats });
      return true;
    }
    if (method === "POST" && path === "/v1/admin/incidents/test") {
      options.admin(req, true);
      const id = await incidents.test("test");
      json(res, 200, { ok: id !== null, id });
      return true;
    }
    const mute = /^\/v1\/admin\/incidents\/([0-9a-f]{20})\/mute$/.exec(path);
    if (method === "POST" && mute) {
      options.admin(req, true);
      const hours = options.bodyObject(await options.readBody(req)).hours;
      if (typeof hours !== "number" || !Number.isInteger(hours) || hours < 0 || hours > 24 * 90) throw new IncidentRouteError(400, "invalid_request", "hours must be 0 to 2160.");
      if (!await incidents.mute(mute[1]!, hours === 0 ? null : Date.now() + hours * 3_600_000)) throw new IncidentRouteError(404, "not_found", "Not found.");
      json(res, 200, { ok: true });
      return true;
    }
    options.admin(req, false);
    throw new IncidentRouteError(404, "not_found", "Not found.");
  }
  return { handle };
}
