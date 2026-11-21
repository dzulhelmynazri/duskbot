import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { resolveHttpRequestAuth, resolveRequestAuth } from "../request-auth.ts";
import { SessionRegistry } from "../sessions.ts";
import { answerMobilePreflight } from "./request.ts";
import { openEventStream } from "../harness/sse-gzip.ts";

let dir: string;
let sessions: SessionRegistry;
let phone: ReturnType<SessionRegistry["issue"]>;
const origins = ["capacitor://localhost", "https://localhost", "http://localhost"];
const cookieName = "fixture_session";
const viewer = "/api/desktop-viewer/local/shared/websockify";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "madani-mobile-cors-"));
  sessions = new SessionRegistry({ file: join(dir, "sessions.json") });
  phone = sessions.issue({ label: "Phone", scopes: ["admin", "client"] });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function request(headers: Record<string, string | undefined> = {}, method = "GET", path = "/api/bots") {
  const req = new IncomingMessage(new Socket());
  Object.defineProperty(req.socket, "remoteAddress", { value: "127.0.0.1" });
  req.headers = { host: "localhost", ...headers };
  req.method = method;
  req.url = path;
  const res = new ServerResponse(req);
  const url = new URL(path, "http://localhost");
  const options = { sessions, cookieName, url, streamPath: "/api/events", trustLocalBrowser: true };
  return { req, res, url, options };
}

it.each(origins)("allows only the requested preflight method and headers from %s", origin => {
  const { req, res, url } = request({ origin, "access-control-request-method": "POST",
    "access-control-request-headers": "authorization, CONTENT-type, last-event-id, x-madani-background, x-madani-sha256" }, "OPTIONS");
  expect(answerMobilePreflight(req, res, url)).toBe(true);
  expect(res.statusCode).toBe(204);
  expect(res.getHeader("access-control-allow-origin")).toBe(origin);
  expect(res.getHeader("access-control-allow-methods")).toBe("POST");
  expect(res.getHeader("access-control-allow-headers")).toBe("Authorization, Content-Type, Last-Event-ID, X-Madani-Background, X-Madani-Sha256");
  expect(res.getHeader("access-control-allow-credentials")).toBeUndefined();
});

it.each(origins)("allows the live stream preflight older phone builds send from %s", origin => {
  // builds up to 1.0.1 open /api/events with Accept and Cache-Control next to the bearer
  const { req, res, url } = request({ origin, "access-control-request-method": "GET",
    "access-control-request-headers": "accept,authorization,cache-control" }, "OPTIONS", "/api/events?since=1");
  expect(answerMobilePreflight(req, res, url)).toBe(true);
  expect(res.statusCode).toBe(204);
  expect(res.getHeader("access-control-allow-origin")).toBe(origin);
  expect(res.getHeader("access-control-allow-headers")).toBe("Accept, Authorization, Cache-Control");
  expect(res.getHeader("access-control-max-age")).toBe("600");
});

it.each([
  ["TRACE", "authorization"], ["GET", "content-type"], ["GET", "authorization, cookie"],
  ["GET", "authorization, x-madani-desktop-owner"], ["GET", "authorization, x-arbitrary"],
])("refuses a preflight for %s with %s", (method, headers) => {
  const { req, res, url } = request({ origin: origins[0], "access-control-request-method": method,
    "access-control-request-headers": headers }, "OPTIONS");
  expect(answerMobilePreflight(req, res, url)).toBe(true);
  expect(res.statusCode).toBe(403);
  expect(res.getHeader("access-control-allow-origin")).toBeUndefined();
});

it.each(origins)("adds CORS only after bearer authentication from %s", origin => {
  const { req, res, options } = request({ origin, authorization: `Bearer ${phone.token}` });
  res.setHeader("vary", "Accept-Encoding");
  const result = resolveHttpRequestAuth(req, res, options);
  expect(result.auth).toMatchObject({ kind: "session", via: "bearer", session: { id: phone.session.id } });
  expect(res.getHeader("access-control-allow-origin")).toBe(origin);
  expect(res.getHeader("access-control-allow-credentials")).toBeUndefined();
  expect(res.getHeader("vary")).toBe("Accept-Encoding, Origin");
});

it.each(origins)("refuses cookie and loopback fallback from %s", origin => {
  for (const headers of [{}, { cookie: `${cookieName}=${phone.token}` }, { authorization: "Bearer invalid", cookie: `${cookieName}=${phone.token}` }]) {
    const { req, res, options } = request({ origin, ...headers });
    expect(resolveHttpRequestAuth(req, res, options)).toMatchObject({ auth: null, status: 403 });
    expect(res.getHeader("access-control-allow-origin")).toBeUndefined();
  }
});

it.each(["https://evil.example", "capacitor://localhost.evil", "capacitor://localhost/", "capacitor://localhost:123", "https://localhost:123"])("never grants CORS to %s", origin => {
  const { req, res, url, options } = request({ origin, "access-control-request-method": "GET", "access-control-request-headers": "authorization" }, "OPTIONS");
  expect(answerMobilePreflight(req, res, url)).toBe(false);
  req.headers.authorization = `Bearer ${phone.token}`;
  resolveHttpRequestAuth(req, res, options);
  expect(res.getHeader("access-control-allow-origin")).toBeUndefined();
});

it("keeps unknown-origin refusal and rejects revoked mobile bearers", () => {
  const foreign = request({ origin: "https://evil.example" });
  expect(resolveHttpRequestAuth(foreign.req, foreign.res, foreign.options)).toMatchObject({ auth: null, status: 403, error: "forbidden: cross-origin request" });
  sessions.revoke(phone.session.id);
  const revoked = request({ origin: origins[0], authorization: `Bearer ${phone.token}`, cookie: `${cookieName}=${phone.token}` });
  expect(resolveHttpRequestAuth(revoked.req, revoked.res, revoked.options)).toMatchObject({ auth: null, status: 401 });
  expect(revoked.res.getHeader("access-control-allow-origin")).toBeUndefined();
});

it("strips viewer tokens before restrictions run and preserves the other parameters", () => {
  const { req, url, options } = request({ origin: origins[0], upgrade: "websocket" }, "GET", `${viewer}?access_token=${phone.token}&rfb=server`);
  const result = resolveRequestAuth(req, { ...options, restricted: (_session, _method, _path, checked) => {
    expect(checked.searchParams.has("access_token")).toBe(false);
    expect(req.url).toBe(`${viewer}?rfb=server`);
    return "restricted session";
  } });
  expect(url.search).toBe("?rfb=server");
  expect(result).toMatchObject({ auth: null, status: 403, error: "restricted session" });
});

it("does not accept query tokens on ordinary HTTP routes or use cookies after a bad token", () => {
  for (const [path, upgrade] of [[viewer, ""], ["/api/bots", "websocket"], [viewer, "websocket"]]) {
    const { req, url, options } = request({ origin: origins[0], upgrade, cookie: `${cookieName}=${phone.token}` }, "GET",
      `${path}?access_token=${upgrade === "websocket" && path === viewer ? "invalid" : phone.token}`);
    expect(resolveRequestAuth(req, options)).toMatchObject({ auth: null, status: 401 });
    expect(url.searchParams.has("access_token")).toBe(false);
    expect(req.url).toBe(path);
  }
});

it("refuses browser-only sessions as viewer query tokens", () => {
  const { credential } = sessions.openPairing({ browser: true });
  const browser = sessions.exchange({ code: credential, browser: true, label: "Browser", source: "127.0.0.1" });
  if (!browser.ok) throw new Error(browser.error);
  const { req, options } = request({ origin: origins[0], upgrade: "websocket" }, "GET", `${viewer}?access_token=${browser.token}`);
  expect(resolveRequestAuth(req, options)).toMatchObject({ auth: null, status: 401,
    error: "unauthorized: this session belongs to a browser; sign in with a pairing code" });
});

it("keeps CORS on an authenticated SSE response over a local socket", async () => {
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    if (answerMobilePreflight(req, res, url)) return;
    const gate = resolveHttpRequestAuth(req, res, { sessions, cookieName, url, streamPath: "/api/events" });
    if (!gate.auth) { res.writeHead(gate.status).end(); return; }
    const stream = openEventStream(res, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    stream.write('data: {"kind":"hello"}\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/events`, {
      headers: { origin: origins[0], authorization: `Bearer ${phone.token}`, "last-event-id": "fixture:1" },
      signal: AbortSignal.timeout(5_000),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(origins[0]);
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"kind":"hello"');
    await reader.cancel();
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
});
