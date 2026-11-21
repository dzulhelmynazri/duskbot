import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingMessage, type RequestListener, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMobileSessions } from "../src/mobile.ts";
import { createProxyHandler, type ProxyOptions } from "../src/proxy.ts";
import { denyReason } from "../src/routes.ts";
import { gzipTunnelReplies } from "../src/tunnel-gzip.ts";

const TOKEN = `madani_sess_${"a".repeat(43)}`;
const auth = { authorization: `Bearer ${TOKEN}` };
const servers: Server[] = [];
const sockets = new Set<Duplex>();
const dirs: string[] = [];

const stateFile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "madani-mobile-test-"));
  dirs.push(dir);
  return join(dir, "mobile-sessions.json");
};

const listen = async (server: Server): Promise<number> => {
  servers.push(server);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as { port: number }).port;
};

const fixture = async (listener: RequestListener, overrides: Partial<ProxyOptions> = {}) => {
  const harness = createServer(listener);
  const harnessPort = await listen(harness);
  const mobile = createMobileSessions({ file: null });
  const authenticate = vi.fn((token: string | undefined) => token === "companion-token"
    ? { id: "regular-device", cloudDesktopAccess: false, browserControlAccess: false }
    : null);
  const handler = createProxyHandler({
    harnessPort,
    mobile,
    authenticate,
    mutationToken: () => "sidecar-only-secret",
    redeem: () => ({ error: "not pairing" }),
    serverName: () => "fixture",
    ...overrides,
  });
  const sidecar = createServer(handler);
  sidecar.on("upgrade", handler.upgrade);
  const port = await listen(sidecar);
  return { harness, handler, mobile, authenticate, port, url: `http://127.0.0.1:${port}` };
};

const bodyOf = async (req: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const noCompanionHeaders = (req: IncomingMessage): void => {
  expect(Object.keys(req.headers).filter((name) => name.startsWith("x-madani-companion"))).toEqual([]);
};

const upgradeRequest = (port: number, headers: Record<string, string> = {}) => request({
  hostname: "127.0.0.1",
  port,
  path: "/api/full-harness/socket?session=1",
  headers: {
    ...auth,
    connection: "Upgrade",
    upgrade: "websocket",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    "sec-websocket-version": "13",
    "sec-websocket-protocol": "fixture",
    "sec-websocket-extensions": "permessage-deflate",
    ...headers,
  },
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("mobile session registry", () => {
  it("persists only hashes with private permissions and reloads sessions", () => {
    const file = stateFile();
    const mobile = createMobileSessions({ file });
    mobile.remember(TOKEN, "phone-1");
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain(TOKEN);
    expect(JSON.parse(raw)).toEqual({
      v: 1,
      sessions: [{ hash: createHash("sha256").update(TOKEN).digest("hex"), deviceId: "phone-1", createdAt: expect.any(Number) }],
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const loaded = createMobileSessions({ file });
    expect(loaded.has(TOKEN)).toBe(true);
    expect(loaded.list()).toEqual([{ deviceId: "phone-1", createdAt: expect.any(Number) }]);
    loaded.forget(TOKEN);
    expect(createMobileSessions({ file }).has(TOKEN)).toBe(false);
  });

  it("rejects malformed tokens, keeps duplicates stable and caps the oldest entries", () => {
    const mobile = createMobileSessions({ file: null });
    for (const token of ["madani_token", "madani_sess_short", `madani_sess_${"x".repeat(201)}`, `madani_sess_${"!".repeat(20)}`]) {
      mobile.remember(token, "invalid");
      expect(mobile.has(token)).toBe(false);
    }
    expect(mobile.list()).toEqual([]);
    mobile.remember(TOKEN, "first");
    mobile.remember(TOKEN, "duplicate");
    expect(mobile.list()).toHaveLength(1);
    expect(mobile.list()[0].deviceId).toBe("first");
    for (let i = 0; i < 64; i++) mobile.remember(`madani_sess_${String(i).padStart(20, "0")}`, `phone-${i}`);
    expect(mobile.list()).toHaveLength(64);
    expect(mobile.has(TOKEN)).toBe(false);
    expect(mobile.list()[0].deviceId).toBe("phone-0");
  });

  it("ignores missing state and warns without disclosing corrupt contents", () => {
    const file = stateFile();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(createMobileSessions({ file }).list()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    writeFileSync(file, TOKEN);
    expect(createMobileSessions({ file }).list()).toEqual([]);
    expect(warn).toHaveBeenCalledWith("companion: could not load mobile sessions");
  });
});

describe("mobile HTTP forwarding", () => {
  it("redeems without sidecar authority, remembers only a hash and returns verbatim bytes", async () => {
    const file = stateFile();
    const mobile = createMobileSessions({ file });
    const reply = ` { "token": "${TOKEN}", "device": {"id":"phone-1"}, "scopes":["client"] }\n`;
    const input = '{ "secret": "grant", "attemptId": "attempt", "device": {"name":"phone","platform":"ios"} }';
    let received = "";
    let seen: IncomingMessage | undefined;
    const app = await fixture(async (req, res) => {
      seen = req;
      received = (await bodyOf(req)).toString();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(reply);
    }, { mobile });
    expect(denyReason({ method: "POST", path: "/api/mobile/redeem", authenticated: false })).toBeNull();
    const response = await fetch(`${app.url}/api/mobile/redeem`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json", "x-madani-companion-auth": "forged", "x-forwarded-for": "forged", "x-forwarded-proto": "https", "last-event-id": "private", range: "bytes=0-1" },
      body: input,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(reply);
    expect(received).toBe(input);
    noCompanionHeaders(seen!);
    expect(seen!.headers.authorization).toBeUndefined();
    expect(seen!.headers["x-forwarded-for"]).toBe("127.0.0.1");
    expect(seen!.headers["x-forwarded-proto"]).toBe("http");
    expect(seen!.headers["last-event-id"]).toBeUndefined();
    expect(seen!.headers.range).toBeUndefined();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mobile.has(TOKEN)).toBe(true);
    expect(readFileSync(file, "utf8")).not.toContain(TOKEN);
  });

  it.each([401, 200])("does not remember unsuccessful or malformed redemption (%s)", async (status) => {
    const app = await fixture((_req, res) => res.writeHead(status).end(JSON.stringify({ token: status === 401 ? TOKEN : "invalid", device: { id: "phone" } })));
    expect((await fetch(`${app.url}/api/mobile/redeem`, { method: "POST", body: "{}" })).status).toBe(status);
    expect(app.mobile.list()).toEqual([]);
  });

  it.each(["GET", "POST"])("passes %s outside the companion allowlist with the phone's authority", async (method) => {
    let seen: IncomingMessage | undefined;
    let received = "";
    const reply = '{ "resumeCursors": {"private-to-session": true} }\n';
    const app = await fixture(async (req, res) => {
      seen = req;
      received = (await bodyOf(req)).toString();
      res.writeHead(201, { "content-type": "application/json", "cache-control": "public", connection: "keep-alive, x-hop", "x-hop": "remove", "x-preserved": "yes" });
      res.end(reply);
    });
    app.mobile.remember(TOKEN, "phone");
    const response = await fetch(`${app.url}/api/full-harness?keep=1`, {
      method,
      headers: { ...auth, "content-type": "application/json", "last-event-id": "event-1", range: " bytes=1-2 ", "x-madani-companion": "1", "x-madani-companion-device": "forged", "x-madani-companion-auth": "forged", cookie: "omit=1" },
      ...(method === "POST" ? { body: '{ "setting": true }' } : {}),
    });
    expect(response.status).toBe(201);
    expect(await response.text()).toBe(reply);
    expect(seen!.url).toBe("/api/full-harness?keep=1");
    expect(seen!.headers.authorization).toBe(auth.authorization);
    expect(seen!.headers["x-forwarded-for"]).toBe("127.0.0.1");
    expect(seen!.headers["x-forwarded-proto"]).toBe("http");
    expect(seen!.headers["last-event-id"]).toBe("event-1");
    expect(seen!.headers.range).toBe("bytes=1-2");
    expect(seen!.headers.cookie).toBeUndefined();
    noCompanionHeaders(seen!);
    expect(received).toBe(method === "POST" ? '{ "setting": true }' : "");
    expect(response.headers.get("x-hop")).toBeNull();
    expect(response.headers.get("x-preserved")).toBe("yes");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(app.authenticate).not.toHaveBeenCalled();
  });

  it("leaves regular companion capabilities closed while mobile sessions use harness gates", async () => {
    const reached = vi.fn((_req: IncomingMessage, res: Parameters<RequestListener>[1]) => res.end("harness"));
    const app = await fixture(reached);
    app.mobile.remember(TOKEN, "phone");
    for (const path of ["/api/bots/b1/computer/join", "/api/bots/b1/browser/action"]) {
      const ordinary = await fetch(`${app.url}${path}`, { method: "POST", headers: { authorization: "Bearer companion-token" } });
      expect(ordinary.status).toBe(403);
      expect((await fetch(`${app.url}${path}`, { method: "POST", headers: auth })).status).toBe(200);
    }
    expect(reached).toHaveBeenCalledTimes(2);
  });

  it("answers an unknown session with 503, never the 401 that unpairs a phone, and asks the harness once a minute", async () => {
    const paths: string[] = [];
    const app = await fixture((req, res) => { paths.push(req.url!); res.writeHead(401).end(); });
    const response = await fetch(`${app.url}/api/auth/session`, { headers: auth });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "not_here" });
    expect(paths.sort()).toEqual(["/api/auth/session", "/api/mobile/device"]);
    expect((await fetch(`${app.url}/api/bots`, { headers: auth })).status).toBe(503);
    expect(paths).toHaveLength(2);
    expect(app.mobile.has(TOKEN)).toBe(false);
  });

  it("admits a phone paired through the relay once the harness says it is one of its phones", async () => {
    const seen: IncomingMessage[] = [];
    const app = await fixture((req, res) => {
      seen.push(req);
      if (req.url === "/api/mobile/device") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ device: { id: "relay-phone" } }));
      if (req.url === "/api/auth/session") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ kind: "session", environmentId: "env-a" }));
      res.end("bots");
    });
    const response = await fetch(`${app.url}/api/bots`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{\"name\":\"x\"}" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("bots");
    expect(app.mobile.has(TOKEN)).toBe(true);
    expect(app.mobile.environmentOf(TOKEN)).toBe("env-a");
    for (const req of seen) {
      expect(req.headers.authorization).toBe(auth.authorization);
      expect(req.headers["x-forwarded-for"]).toBe("127.0.0.1");
      noCompanionHeaders(req);
    }
    expect(seen.map((req) => req.url).sort()).toEqual(["/api/auth/session", "/api/bots", "/api/mobile/device"]);
  });

  it("refuses a live session that is not a phone as before", async () => {
    const app = await fixture((req, res) => res.writeHead(req.url === "/api/mobile/device" ? 404 : 200).end("{}"));
    expect((await fetch(`${app.url}/api/bots`, { headers: auth })).status).toBe(401);
    expect(app.mobile.has(TOKEN)).toBe(false);
  });

  it("says the harness is down, not refused, when it does not answer", async () => {
    const app = await fixture((_req, res) => res.destroy());
    expect((await fetch(`${app.url}/api/auth/session`, { headers: auth })).status).toBe(502);
  });

  it("keeps a phone of another workspace while that workspace is not the one running", async () => {
    let environmentId = "env-b";
    const app = await fixture((req, res) => {
      if (req.url === "/.well-known/madanibot/environment") return res.writeHead(200).end(JSON.stringify({ environmentId }));
      res.writeHead(401).end("{}");
    });
    app.mobile.remember(TOKEN, "phone", "env-a");
    const elsewhere = await fetch(`${app.url}/api/auth/session`, { headers: auth });
    expect(elsewhere.status).toBe(503);
    expect(app.mobile.has(TOKEN)).toBe(true);
    environmentId = "env-a";
    expect((await fetch(`${app.url}/api/auth/session`, { headers: auth })).status).toBe(401);
    expect(app.mobile.has(TOKEN)).toBe(false);
  });

  it("caps one address's harness lookups for unknown sessions at 10 a minute", async () => {
    let lookups = 0;
    const app = await fixture((_req, res) => { lookups += 1; res.writeHead(401).end(); });
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const token = `madani_sess_${String(i).padStart(43, "b")}`;
      statuses.push((await fetch(`${app.url}/api/bots`, { headers: { authorization: `Bearer ${token}` } })).status);
    }
    expect(statuses.every((status) => status === 503)).toBe(true);
    expect(lookups).toBe(20);
  });

  it("asks the harness once for a phone's requests that arrive together", async () => {
    const asked: string[] = [];
    const app = await fixture((req, res) => {
      if (req.url === "/api/mobile/device") { asked.push(req.url); return void setTimeout(() => res.writeHead(200).end(JSON.stringify({ device: { id: "relay-phone" } })), 50); }
      if (req.url === "/api/auth/session") return res.writeHead(200).end(JSON.stringify({ environmentId: "env-a" }));
      res.end("ok");
    });
    const statuses = await Promise.all([1, 2, 3, 4].map(() => fetch(`${app.url}/api/bots`, { headers: auth }).then((res) => res.status)));
    expect(statuses).toEqual([200, 200, 200, 200]);
    expect(asked).toHaveLength(1);
  });

  it("keeps a remembered phone when the running workspace cannot say which it is", async () => {
    const app = await fixture((_req, res) => res.writeHead(401).end("{}"));
    app.mobile.remember(TOKEN, "phone", "env-a");
    expect((await fetch(`${app.url}/api/auth/session`, { headers: auth })).status).toBe(503);
    expect(app.mobile.has(TOKEN)).toBe(true);
  });

  it("forgets a session on harness 401 and closes the next request at the sidecar", async () => {
    const file = stateFile();
    const mobile = createMobileSessions({ file });
    const reached = vi.fn((_req: IncomingMessage, res: Parameters<RequestListener>[1]) => res.writeHead(401).end("revoked"));
    const app = await fixture(reached, { mobile });
    mobile.remember(TOKEN, "phone");
    const first = await fetch(`${app.url}/api/bots`, { headers: auth });
    expect(first.status).toBe(401);
    expect(await first.text()).toBe("revoked");
    expect(mobile.has(TOKEN)).toBe(false);
    expect(createMobileSessions({ file }).has(TOKEN)).toBe(false);
    expect((await fetch(`${app.url}/api/bots`, { headers: auth })).status).toBe(503);
    expect(reached.mock.calls.map(([req]) => req.url).sort()).toEqual(["/api/auth/session", "/api/bots", "/api/mobile/device"]);
  });

  it("refuses Origin on redemption and remembered sessions before any authentication", async () => {
    const reached = vi.fn((_req: IncomingMessage, res: Parameters<RequestListener>[1]) => res.end());
    const app = await fixture(reached);
    app.mobile.remember(TOKEN, "phone");
    for (const path of ["/api/mobile/redeem", "/api/bots"]) {
      expect((await fetch(`${app.url}${path}`, { method: "POST", headers: { ...auth, origin: "https://example.test" } })).status).toBe(403);
    }
    expect(reached).not.toHaveBeenCalled();
    expect(app.authenticate).not.toHaveBeenCalled();
  });

  it("denies redemption when mobile sessions are not configured", async () => {
    const reached = vi.fn((_req: IncomingMessage, res: Parameters<RequestListener>[1]) => res.end());
    const app = await fixture(reached, { mobile: undefined });
    expect((await fetch(`${app.url}/api/mobile/redeem`, { method: "POST" })).status).toBe(401);
    expect(reached).not.toHaveBeenCalled();
  });

  it("streams the first SSE event while the harness response is still open", async () => {
    let ended = false;
    let finish: () => void = () => {};
    const event = 'data: {"resumeCursors":{"raw":true}}\n\n';
    const app = await fixture((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(event);
      finish = () => { ended = true; res.end("data: done\n\n"); };
    });
    app.mobile.remember(TOKEN, "phone");
    const response = await fetch(`${app.url}/api/events`, { headers: auth });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(event);
    expect(ended).toBe(false);
    finish();
    while (!(await reader.read()).done) {}
  });

  it("streams a 3 MB upload byte for byte", async () => {
    const body = randomBytes(3 * 1024 * 1024);
    let received: Buffer | undefined;
    const app = await fixture(async (req, res) => {
      received = await bodyOf(req);
      res.end("uploaded");
    });
    app.mobile.remember(TOKEN, "phone");
    const response = await fetch(`${app.url}/api/uploads/full`, { method: "POST", headers: auth, body });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("uploaded");
    expect(received!.equals(body)).toBe(true);
  });

  it("uses HTTPS and a non-loopback fallback on the managed origin", async () => {
    let seen: IncomingMessage | undefined;
    const app = await fixture((req, res) => { seen = req; res.end("ok"); });
    app.mobile.remember(TOKEN, "phone");
    const path = join(stateFile(), "..", "origin.sock");
    const managed = createServer(gzipTunnelReplies(app.handler));
    servers.push(managed);
    managed.on("connection", (socket) => sockets.add(socket));
    await new Promise<void>((resolve) => managed.listen(path, resolve));
    const body = await new Promise<string>((resolve, reject) => {
      const req = request({ socketPath: path, path: "/api/full-harness", headers: auth }, async (res) => resolve((await bodyOf(res)).toString()));
      req.on("error", reject);
      req.end();
    });
    expect(body).toBe("ok");
    expect(seen!.headers["x-forwarded-for"]).toBe("192.0.2.11");
    expect(seen!.headers["x-forwarded-proto"]).toBe("https");
  });

  it("bounds redemption replies and never remembers their token on overflow", async () => {
    const app = await fixture((_req, res) => res.end(JSON.stringify({ token: TOKEN, device: { id: "phone" }, padding: "x".repeat(256 * 1024) })));
    expect((await fetch(`${app.url}/api/mobile/redeem`, { method: "POST" })).status).toBe(502);
    expect(app.mobile.list()).toEqual([]);
  });

  it("keeps the headers deadline for remembered sessions", async () => {
    const app = await fixture(() => {}, { headersTimeoutMs: 30 });
    app.mobile.remember(TOKEN, "phone");
    expect((await fetch(`${app.url}/api/full-harness`, { headers: auth })).status).toBe(504);
  });
});

describe("mobile WebSocket forwarding", () => {
  it("forwards the handshake, head bytes and bidirectional socket bytes", async () => {
    const app = await fixture((_req, res) => res.end());
    app.mobile.remember(TOKEN, "phone");
    let seen: IncomingMessage | undefined;
    app.harness.on("upgrade", (req, socket, head) => {
      seen = req;
      socket.on("error", () => {});
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Protocol: fixture\r\n\r\nharness-head");
      if (head.length) socket.write(head);
      socket.pipe(socket);
    });
    const socket = connect(app.port, "127.0.0.1");
    sockets.add(socket);
    let received = Buffer.alloc(0);
    await new Promise<void>((resolve, reject) => {
      socket.on("error", reject);
      socket.on("data", (chunk) => {
        received = Buffer.concat([received, Buffer.from(chunk)]);
        if (received.includes("harness-headphone-headphone-payload")) resolve();
      });
      socket.on("connect", () => {
        socket.write(`GET /api/full-harness/socket?session=1 HTTP/1.1\r\nHost: fixture\r\nAuthorization: ${auth.authorization}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: fixture\r\nSec-WebSocket-Extensions: permessage-deflate\r\n\r\nphone-head`);
      });
      socket.once("data", () => socket.write("phone-payload"));
    });
    expect(received.toString()).toContain("HTTP/1.1 101 Switching Protocols");
    expect(received.toString()).toContain("Sec-WebSocket-Protocol: fixture");
    expect(seen!.headers.authorization).toBe(auth.authorization);
    expect(seen!.headers["sec-websocket-key"]).toBe("dGhlIHNhbXBsZSBub25jZQ==");
    expect(seen!.headers["sec-websocket-extensions"]).toBe("permessage-deflate");
    expect(seen!.headers["x-forwarded-for"]).toBe("127.0.0.1");
    expect(seen!.headers["x-forwarded-proto"]).toBe("http");
    noCompanionHeaders(seen!);
    socket.destroy();
  });

  it("relays a non-upgraded 401 body and forgets the mobile session", async () => {
    const app = await fixture((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.write('{"error":');
      res.end('"revoked"}');
    });
    app.mobile.remember(TOKEN, "phone");
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = upgradeRequest(app.port);
      req.on("response", resolve);
      req.on("error", reject);
      req.end();
    });
    expect(response.statusCode).toBe(401);
    expect((await bodyOf(response)).toString()).toBe('{"error":"revoked"}');
    expect(app.mobile.has(TOKEN)).toBe(false);
    expect((await fetch(`${app.url}/api/bots`, { headers: auth })).status).toBe(503);
  });

  it.each(["origin", "unremembered"])("refuses %s upgrade before reaching the harness", async (reason) => {
    const app = await fixture((_req, res) => res.end());
    const reached = vi.fn();
    app.harness.on("upgrade", reached);
    if (reason === "origin") app.mobile.remember(TOKEN, "phone");
    const status = await new Promise<number | null>((resolve, reject) => {
      const req = upgradeRequest(app.port, reason === "origin" ? { origin: "https://example.test" } : {});
      req.on("response", (res) => { res.resume(); resolve(res.statusCode ?? null); });
      req.on("error", (error: NodeJS.ErrnoException) => error.code === "ECONNRESET" ? resolve(null) : reject(error));
      req.end();
    });
    expect(status === null || status === 401).toBe(true);
    expect(reached).not.toHaveBeenCalled();
  });
});

describe("mobile redeem rate limit", () => {
  it("limits redemption to 20 calls per minute across sidecar handlers", async () => {
    vi.spyOn(Date, "now").mockReturnValue(4_000_000_000_000);
    const reached = vi.fn((_req: IncomingMessage, res: Parameters<RequestListener>[1]) => res.writeHead(401).end("{}"));
    const first = await fixture(reached);
    const second = await fixture(reached);
    for (let i = 0; i < 20; i++) {
      const response = await fetch(`${i % 2 ? first.url : second.url}/api/mobile/redeem`, { method: "POST" });
      expect(response.status).toBe(401);
      await response.text();
    }
    const limited = await fetch(`${first.url}/api/mobile/redeem`, { method: "POST" });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "too many mobile pairing attempts" });
    expect(reached).toHaveBeenCalledTimes(20);
    vi.mocked(Date.now).mockReturnValue(4_000_000_060_000);
    expect((await fetch(`${second.url}/api/mobile/redeem`, { method: "POST" })).status).toBe(401);
  });
});
