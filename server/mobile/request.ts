import type { IncomingMessage, ServerResponse } from "node:http";
import type { RequestAuth } from "../request-auth.ts";
import { hasTokenPrefix } from "../../electron/legacy-names.mjs";

const APP_ORIGINS = new Set(["capacitor://localhost", "https://localhost", "http://localhost"]);
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
// cache-control: phone builds up to 1.0.1 send it on the live stream, and a refused preflight left them "Reconnecting" forever
const HEADERS = ["Accept", "Authorization", "Cache-Control", "Content-Type", "Last-Event-ID", "X-Madani-Background", "X-Madani-Sha256"];
const VIEWER_SOCKET = /^\/api\/desktop-viewer\/(?:local\/(?:shared|bot-[a-f0-9]{64}|pool-\d+)|vps\/[\w-]+)\/websockify$/;

export function isMobileOrigin(origin: string | string[] | undefined): origin is string {
  return typeof origin === "string" && APP_ORIGINS.has(origin);
}

function allowOrigin(res: ServerResponse, origin: string): void {
  res.setHeader("access-control-allow-origin", origin);
  res.removeHeader("access-control-allow-credentials");
  const vary = String(res.getHeader("vary") ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (!vary.some(value => value.toLowerCase() === "origin" || value === "*")) vary.push("Origin");
  res.setHeader("vary", vary.join(", "));
}

export function answerMobilePreflight(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  const origin = req.headers.origin;
  if (req.method !== "OPTIONS" || !isMobileOrigin(origin) || !url.pathname.startsWith("/api/")) return false;
  const method = req.headers["access-control-request-method"];
  const headers = req.headers["access-control-request-headers"];
  const requested = typeof headers === "string" ? headers.toLowerCase().split(",").map(value => value.trim()) : [];
  // preflights carry no session; the actual request must authenticate with a bearer.
  if (typeof method !== "string" || !METHODS.has(method) || !requested.includes("authorization") ||
      requested.some(header => !HEADERS.some(allowed => allowed.toLowerCase() === header))) {
    res.writeHead(403).end();
    return true;
  }
  allowOrigin(res, origin);
  res.setHeader("access-control-allow-methods", method);
  res.setHeader("access-control-allow-headers", HEADERS.filter(header => requested.includes(header.toLowerCase())).join(", "));
  // WebKit keeps a preflight 5 s unless told longer (600 s at most): each live stream dial from the phone otherwise
  // costs a second trip to the place before it opens
  res.setHeader("access-control-max-age", "600");
  res.setHeader("cache-control", "no-store");
  res.writeHead(204).end();
  return true;
}

export function mobileBearer(req: IncomingMessage, auth: RequestAuth): boolean {
  return isMobileOrigin(req.headers.origin) && auth.kind === "session" && auth.via === "bearer";
}

export function applyMobileCors(req: IncomingMessage, res: ServerResponse, auth: RequestAuth): void {
  if (!mobileBearer(req, auth)) return;
  allowOrigin(res, req.headers.origin!);
  res.setHeader("access-control-expose-headers", "Content-Disposition, X-madanibot-Folder, X-Madani-Cloud-Power");
}

export function takeViewerAccessToken(req: IncomingMessage, url: URL): string | null | undefined {
  const tokens = url.searchParams.getAll("access_token");
  if (!tokens.length) return undefined;
  url.searchParams.delete("access_token");
  req.url = `${url.pathname}${url.search}`;
  if (req.method !== "GET" || req.headers.upgrade?.toLowerCase() !== "websocket" || !VIEWER_SOCKET.test(url.pathname) ||
      (req.headers.origin !== undefined && !isMobileOrigin(req.headers.origin)) || tokens.length !== 1 || !hasTokenPrefix(tokens[0], "sess")) return null;
  return tokens[0];
}
