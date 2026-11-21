import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SessionRegistry } from "../sessions.ts";
import { resolveRequestAuth, type RequestAuth } from "../request-auth.ts";
import { json, readBody } from "../harness/http.ts";
import { SHARED_LOCAL_VM_TARGET, perBotLocalVmTarget, poolLocalVmTarget, type ContainerComputerStatus } from "../container-computer.ts";
import { createDesktopViewer, desktopViewerUrl, type DesktopTarget, rfbInput } from "./desktop-viewer.ts";
import { readFrame, writeFrame } from "./rfb-handshake.ts";
import { viewerTargetId } from "../../shared/desktop-viewer.ts";
import { localDesktopTarget, localVmViewerStatus } from "../desktop-viewer-targets.ts";

let dir: string;
let sessions: SessionRegistry;
let viewer: ReturnType<typeof createDesktopViewer>;
let app: Server;
let desktop: Server;
let appPort: number;
let desktopPort: number;
let admin: ReturnType<SessionRegistry["issue"]>;
let member: ReturnType<SessionRegistry["issue"]>;
let vpsTarget: DesktopTarget | undefined;
let vpsThreads: Array<string | undefined>;
let inspected: string[];
let seenHeaders: IncomingHttpHeaders;
let seenPath: string | undefined;
let touched: string[];
let statusOverrides: Partial<ContainerComputerStatus>;
let inspection: Promise<void> | undefined;
let now: number;
let targetLookups: number;
let handled: () => void;
let leases: Set<string>;
const leaseKey = (id: string, botId: string, lease: string) => `${id} ${botId} ${lease}`;
let targets = [SHARED_LOCAL_VM_TARGET, perBotLocalVmTarget("test-bot"), poolLocalVmTarget(1)];
const peers = new Set<Duplex>();
const base = "/api/desktop-viewer/local/shared";
const remoteHeaders = { host: "workspace.example", origin: "https://workspace.example", "x-forwarded-proto": "https" };

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

function headers(token = admin.token) { return { ...remoteHeaders, cookie: `test_session=${token}` }; }

function get(path: string, extra: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: unknown }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: appPort, path, headers: { ...headers(), ...extra } }, res => {
      let text = "";
      res.on("data", chunk => text += chunk);
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: JSON.parse(text) }));
    });
    req.once("error", reject);
    req.end();
  });
}

function open(path = `${base}/websockify`, overrides: Record<string, string | undefined> = {}, rawKey = "dGhlIHNhbXBsZSBub25jZQ==") {
  return new Promise<{ status: number; socket?: Duplex; body?: string }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: appPort, path, headers: Object.fromEntries(Object.entries({
      ...headers(), Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": rawKey, "Sec-WebSocket-Version": "13", ...overrides,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined)) });
    req.once("upgrade", (res, socket) => { peers.add(socket); resolve({ status: res.statusCode!, socket }); });
    req.once("response", res => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.once("error", reject);
    req.end();
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "madani-viewer-"));
  now = Date.now();
  sessions = new SessionRegistry({ file: join(dir, "sessions.json"), now: () => now });
  admin = sessions.issue({ label: "Mac", scopes: ["admin", "client"] });
  member = sessions.issue({ label: "Member", scopes: ["client"] });
  inspected = []; touched = []; statusOverrides = {}; inspection = undefined; seenPath = undefined;
  vpsTarget = undefined;
  vpsThreads = [];
  targetLookups = 0; handled = () => {};
  leases = new Set();
  targets = [SHARED_LOCAL_VM_TARGET, perBotLocalVmTarget("test-bot"), poolLocalVmTarget(1)];
  desktop = createServer((_req, res) => res.writeHead(404).end());
  desktop.on("upgrade", (req, socket) => {
    peers.add(socket);
    seenHeaders = req.headers; seenPath = req.url;
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    // Bytes are opaque to the proxy; echo them to check both directions.
    socket.on("data", data => socket.write(data));
    socket.on("error", () => {});
  });
  desktopPort = await listen(desktop);
  viewer = createDesktopViewer({
    target: (id, threadId) => {
      targetLookups++;
      if (id === "vps/test-bot") { vpsThreads.push(threadId); return vpsTarget; }
      const target = targets.find(target => viewerTargetId(target) === id);
      return target && localDesktopTarget(target, {
        status: async target => {
          inspected.push(target.key);
          await inspection;
          return {
            managed: true, imageMatches: true, network: "loopback", container: "running", viewer_port: desktopPort,
            viewer_url: `http://127.0.0.1:${desktopPort}/vnc.html#password=fixture-secret`, ...statusOverrides,
          } as ContainerComputerStatus;
        },
        touch: target => touched.push(target.key),
      });
    },
    live: auth => auth.kind === "loopback" || sessions.isLive(auth.session.id),
    lease: (id, botId, lease, threadId) => {
      if (!leases.has(leaseKey(id, botId, lease)) || (threadId !== undefined && threadId !== "th-1")) return;
      // Settled at open; afterwards only the lease is asked about.
      return () => leases.has(leaseKey(id, botId, lease));
    },
  });
  sessions.onSessionRevoked(id => viewer.closeForOwner(id));
  const handle = async (req: Parameters<typeof resolveRequestAuth>[0], res: Parameters<typeof json>[0]) => {
    const url = new URL(req.url!, "http://localhost");
    const gate = resolveRequestAuth(req, { sessions, cookieName: "test_session", url, streamPath: "/api/events", loopbackTrust: "service" });
    if (!gate.auth) return json(res, gate.status, { error: gate.error });
    await viewer.route({ req, res, url, path: url.pathname, method: req.method!, auth: gate.auth, json, readBody });
    handled();
  };
  app = createServer((req, res) => void handle(req, res));
  viewer.attach(app, handle);
  appPort = await listen(app);
});

afterEach(async () => {
  viewer.closeAll();
  for (const peer of peers) peer.destroy();
  peers.clear();
  await Promise.all([app, desktop].map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); })));
  rmSync(dir, { recursive: true, force: true });
});

it("proxies opaque bytes and keeps workspace credentials out of the VM", async () => {
  const answer = await open(`${base}/websockify?host=evil.example&token=do-not-forward`, { authorization: `Bearer ${admin.token}`, "sec-websocket-protocol": "binary" });
  expect(answer.status).toBe(101);
  const socket = answer.socket!;
  const echo = new Promise<Buffer>(resolve => socket.once("data", resolve));
  const bytes = Buffer.from([0, 255, 12, 13, 127]);
  socket.write(bytes);
  expect(await echo).toEqual(bytes);
  expect(seenPath).toBe("/websockify");
  expect(seenHeaders.cookie).toBeUndefined();
  expect(seenHeaders.authorization).toBeUndefined();
  expect(seenHeaders["x-forwarded-proto"]).toBeUndefined();
  expect(seenHeaders["sec-websocket-protocol"]).toBeUndefined();
  expect(touched).toContain("shared");
});

it("protects HTTP and upgrade requests with the existing session and scope checks", async () => {
  for (const [extra, expected] of [
    [{ cookie: "" }, 403], [{ cookie: `test_session=${member.token}` }, 403],
    [{ origin: "https://evil.example" }, 403], [{ cookie: "test_session=revoked" }, 401],
  ] as const) {
    expect((await open(undefined, extra)).status).toBe(expected);
    expect((await get(base, extra)).status).toBe(expected);
  }
  expect(inspected).toEqual([]);
});

it.each(["capacitor://localhost", "https://localhost", "http://localhost", undefined])("authenticates viewer query tokens from %s and strips them upstream", async origin => {
  const answer = await open(`${base}/websockify?access_token=${admin.token}`, { origin, cookie: "" });
  expect(answer.status).toBe(101);
  expect(seenPath).toBe("/websockify");
  expect(seenHeaders.authorization).toBeUndefined();
  expect(seenHeaders.cookie).toBeUndefined();
  const echoed = once(answer.socket!, "data");
  answer.socket!.write(Buffer.from("phone viewer"));
  expect((await echoed)[0]).toEqual(Buffer.from("phone viewer"));
  const closed = once(answer.socket!, "close");
  sessions.revoke(admin.session.id);
  await closed;
  expect((await open(`${base}/websockify?access_token=${admin.token}`, { origin, cookie: "" })).status).toBe(401);
});

it("refuses invalid, expired, duplicate, client-scoped and foreign-origin viewer query tokens", async () => {
  for (const [query, origin, status] of [
    ["access_token=invalid", "capacitor://localhost", 401],
    ["access_token=madani_sess_invalid", "capacitor://localhost", 401],
    [`access_token=${member.token}`, "capacitor://localhost", 403],
    [`access_token=${admin.token}&access_token=${admin.token}`, "capacitor://localhost", 401],
    [`access_token=${admin.token}`, "https://evil.example", 401],
    [`access_token=${admin.token}`, remoteHeaders.origin, 401],
  ] as const) expect((await open(`${base}/websockify?${query}`, { origin })).status).toBe(status);
  now = admin.session.expiresAt + 1;
  expect((await open(`${base}/websockify?access_token=${admin.token}`, { origin: "capacitor://localhost" })).status).toBe(401);
  expect(inspected).toEqual([]);
});

it("allows mobile bearer viewer metadata and refuses foreign-origin bearers", async () => {
  expect((await get(base, { origin: "capacitor://localhost", cookie: "", authorization: `Bearer ${admin.token}` })).status).toBe(200);
  expect((await get(base, { origin: "https://evil.example", cookie: "", authorization: `Bearer ${admin.token}` })).status).toBe(403);
});

it("returns fresh credentials only to admins and selects shared, per-bot and pool targets", async () => {
  for (const target of targets) {
    const path = `/api/desktop-viewer/${viewerTargetId(target)}`;
    const response = await get(path);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.body).toEqual({ password: "fixture-secret" });
    expect((await open(`${path}/websockify`)).status).toBe(101);
  }
  expect(inspected).toContain(targets[1].key);
  expect(inspected).toContain("pool:1");
  expect((await open("/api/desktop-viewer/local/pool-999/websockify")).status).toBe(404);
  expect((await open("/api/desktop-viewer/local/127.0.0.1:22/websockify")).status).toBe(404);
});

it.each([
  { managed: false }, { imageMatches: false }, { network: "unsafe" }, { container: "stopped" },
  { viewer_port: null }, { viewer_port: null, viewer_url: "" }, { viewer_port: 0 }, { viewer_port: 65536 },
])("refuses unavailable or untrusted containers: %j", async override => {
  statusOverrides = override as Partial<ContainerComputerStatus>;
  expect((await open()).status).toBe(409);
});

it("rejects ordinary HTTP on the socket path and invalid WebSocket handshakes", async () => {
  expect((await get(`${base}/websockify`)).status).toBe(426);
  expect((await open(undefined, {}, "invalid")).status).toBe(400);
  expect((await open(undefined, { "sec-websocket-version": "12" })).status).toBe(400);
});

it("closes an established viewer when its paired session is revoked", async () => {
  const socket = (await open()).socket!;
  const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
  sessions.revoke(admin.session.id);
  await closed;
  expect((await open()).status).toBe(401);
});

it("expires an open viewer without renewing its session in the background", async () => {
  const socket = (await open()).socket!;
  const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
  now = sessions.list().find(session => session.id === admin.session.id)!.expiresAt + 1;
  await closed;
  expect((await open()).status).toBe(401);
}, 8000);

it("rechecks access after asynchronous container inspection", async () => {
  let inspectedDone!: () => void;
  inspection = new Promise(resolve => { inspectedDone = resolve; });
  const result = get(base);
  await expect.poll(() => inspected.length).toBe(1);
  sessions.revoke(admin.session.id);
  inspectedDone();
  expect((await result).status).toBe(401);
  expect(seenPath).toBeUndefined();
});

it.each(["shutdown", "revocation", "target revocation"])("closes a pending upgrade immediately on %s", async action => {
  let inspectedDone!: () => void;
  inspection = new Promise(resolve => { inspectedDone = resolve; });
  const accepted = once(app, "connection");
  const completed = new Promise<void>(resolve => { handled = resolve; });
  const rejected = expect(open()).rejects.toThrow();
  await expect.poll(() => inspected.length).toBe(1);
  const [socket] = await accepted;
  try {
    if (action === "shutdown") viewer.closeAll();
    else if (action === "revocation") sessions.revoke(admin.session.id);
    else { targets = []; expect(viewer.recheck()).toBe(1); }
    await expect.poll(() => socket.destroyed, { timeout: 1000 }).toBe(true);
    await rejected;
  } finally {
    inspectedDone();
  }
  await completed;
  expect(seenPath).toBeUndefined();
  if (action === "shutdown") await expect(open()).rejects.toThrow();
});

it("closes established viewers during shutdown", async () => {
  const socket = (await open()).socket!;
  const closed = once(socket, "close");
  viewer.closeAll();
  await closed;
  await expect(open()).rejects.toThrow();
});

it("does not connect upstream after the waiting browser disconnects", async () => {
  let inspectedDone!: () => void;
  inspection = new Promise(resolve => { inspectedDone = resolve; });
  const accepted = once(app, "connection");
  const completed = new Promise<void>(resolve => { handled = resolve; });
  const req = request({ hostname: "127.0.0.1", port: appPort, path: `${base}/websockify`, headers: {
    ...headers(), Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13",
  } });
  req.on("error", () => {});
  req.end();
  await expect.poll(() => inspected.length).toBe(1);
  const [serverSocket] = await accepted;
  const closed = once(serverSocket, "close");
  req.destroy();
  await closed;
  inspectedDone();
  await completed;
  expect(targetLookups).toBe(1);
  expect(seenPath).toBeUndefined();
});

it("closes viewers whose target disappears, and keeps active viewers from idle removal", async () => {
  const socket = (await open()).socket!;
  await expect.poll(() => touched.length, { timeout: 7000 }).toBeGreaterThan(1);
  const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
  targets = [];
  await closed;
}, 15_000);

it("returns a bounded error when the viewer refuses an upgrade", async () => {
  desktop.removeAllListeners("upgrade");
  desktop.on("upgrade", (_req, socket) => socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"));
  expect((await open()).status).toBe(502);
});

it("refuses forged upstream handshakes and does not forward upstream cookies", async () => {
  desktop.removeAllListeners("upgrade");
  desktop.on("upgrade", (_req, socket) => {
    peers.add(socket);
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: forged\r\nSet-Cookie: injected=true\r\n\r\n");
  });
  expect((await open()).status).toBe(502);
});

it("times out an upstream that never answers the handshake", async () => {
  desktop.removeAllListeners("upgrade");
  desktop.on("upgrade", (_req, socket) => { peers.add(socket); });
  expect((await open()).status).toBe(502);
}, 13_000);

it("preserves local desktop URLs and removes passwords from paired viewer links", () => {
  const original = { target_key: targets[1].key, viewer_url: "http://127.0.0.1:49152/vnc.html#password=secret" };
  const local: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
  expect(localVmViewerStatus(original, local)).toBe(original);
  const remote: RequestAuth = { kind: "session", session: sessions.authenticate(admin.token)!, via: "cookie", scopes: admin.session.scopes };
  expect(localVmViewerStatus(original, remote).viewer_url).toBe(desktopViewerUrl(viewerTargetId(targets[1])));
});

it("uses the same authenticated proxy for VPS and releases only its own connection", async () => {
  let holds = 0;
  vpsTarget = { key: "vps/test-bot", resolve: async () => ({
    port: desktopPort, password: "fixture-secret",
    retain: () => { holds++; return () => { holds--; }; },
  }) };
  const path = "/api/desktop-viewer/vps/test-bot";
  expect((await get(path)).body).toEqual({ password: "fixture-secret" });
  expect(holds).toBe(0);
  const first = (await open(`${path}/websockify`)).socket!;
  const second = (await open(`${path}/websockify`)).socket!;
  expect(holds).toBe(2);
  first.destroy();
  await expect.poll(() => holds).toBe(1);
  expect(second.destroyed).toBe(false);
  const closed = once(second, "close");
  sessions.revoke(admin.session.id);
  await closed;
  expect(holds).toBe(0);
});

it("closes VPS viewers immediately when their shared membership or destination is revoked", async () => {
  let holds = 0;
  const resolve = async () => ({ port: desktopPort, password: "fixture-secret", retain: () => {
    holds++;
    return () => { holds--; };
  } });
  vpsTarget = { key: "team-a:ssh-a", resolve };
  const first = (await open("/api/desktop-viewer/vps/test-bot/websockify")).socket!;
  const unrelated = (await open()).socket!;
  expect(holds).toBe(1);
  const closed = once(first, "close");
  vpsTarget = { key: "team-b:ssh-a", resolve };
  expect(viewer.recheck()).toBe(1);
  await closed;
  expect(holds).toBe(0);
  expect(unrelated.destroyed).toBe(false);
  const replacement = (await open("/api/desktop-viewer/vps/test-bot/websockify")).socket!;
  const revoked = once(replacement, "close");
  vpsTarget = undefined;
  expect(viewer.recheck()).toBe(1);
  await revoked;
  expect((await get("/api/desktop-viewer/vps/test-bot")).status).toBe(404);
});

it("tracks the logical bot for unbound VPS viewers when closing one owner's bot window", async () => {
  vpsTarget = { key: "team-a:ssh-a", resolve: async () => ({ port: desktopPort, password: null }) };
  const mine = (await open("/api/desktop-viewer/vps/test-bot/websockify")).socket!;
  const unrelated = (await open()).socket!;
  const closed = once(mine, "close");
  expect(viewer.closeForOwner(admin.session.id, "test-bot")).toBe(1);
  await closed;
  expect(unrelated.destroyed).toBe(false);
});

it("passes validated VPS conversation context through lookup and immediate rechecks", async () => {
  vpsTarget = { key: "team-a:thread-a", resolve: async () => ({ port: desktopPort, password: null }) };
  const path = "/api/desktop-viewer/vps/test-bot";
  expect((await get(`${path}?threadId=thread-a`)).status).toBe(200);
  const socket = (await open(`${path}/websockify?threadId=thread-a`)).socket!;
  expect(viewer.recheck()).toBe(0);
  expect(vpsThreads.length).toBeGreaterThan(2);
  expect(vpsThreads.every(thread => thread === "thread-a")).toBe(true);
  expect((await get(`${path}?threadId=bad%20thread`)).status).toBe(400);
  expect((await get(`${path}?threadId=thread-a`, { cookie: `test_session=${member.token}` })).status).toBe(403);
  expect(socket.destroyed).toBe(false);
});

const lease = "phone-lease-0123456789";
const phoneTarget = viewerTargetId(perBotLocalVmTarget("test-bot"));
const phoneBase = `/api/desktop-viewer/${phoneTarget}`;
const bound = (query = `botId=test-bot&controlLeaseId=${lease}`) => `${phoneBase}/websockify?${query}`;

it.each([SHARED_LOCAL_VM_TARGET, poolLocalVmTarget(1)])("refuses phone control of a shared desktop even with a valid bot lease: %j", async desktop => {
  const target = viewerTargetId(desktop);
  leases.add(leaseKey(target, "test-bot", lease));
  const query = `botId=test-bot&threadId=th-1&controlLeaseId=${lease}`;
  for (const response of [
    await open(`/api/desktop-viewer/${target}/websockify?${query}`),
    await get(`/api/desktop-viewer/${target}?${query}`),
  ]) {
    expect(response.status).toBe(409);
    expect(JSON.stringify(response.body)).toContain("per-bot Local VM");
  }
  expect(inspected).toEqual([]);
});

it("opens a lease-bound viewer only while that lease holds the bot's computer", async () => {
  const refused = await open(bound());
  expect(refused.status).toBe(409);
  expect(refused.body).toContain("Take control");
  expect(inspected).toEqual([]);

  leases.add(leaseKey(phoneTarget, "test-bot", lease));
  const answer = await open(bound(), { authorization: `Bearer ${admin.token}`, "sec-websocket-protocol": "binary" });
  expect(answer.status).toBe(101);
  const socket = answer.socket!;
  const echo = new Promise<Buffer>(resolve => socket.once("data", resolve));
  const bytes = Buffer.from("RFB 003.008\n");
  socket.write(bytes);
  expect(await echo).toEqual(bytes);
  expect(seenPath).toBe("/websockify");
  expect(seenHeaders.authorization).toBeUndefined();

  const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
  leases.clear();
  await closed;
  expect((await open(bound())).status).toBe(409);
}, 10_000);

it("binds a lease to one bot's desktop and refuses malformed or half-given lease names", async () => {
  leases.add(leaseKey(phoneTarget, "test-bot", lease));
  expect((await open(bound(`botId=other-bot&controlLeaseId=${lease}`))).status).toBe(409);
  expect((await open(`/api/desktop-viewer/${viewerTargetId(perBotLocalVmTarget("other-bot"))}/websockify?botId=test-bot&controlLeaseId=${lease}`)).status).toBe(409);
  for (const query of ["botId=test-bot", `controlLeaseId=${lease}`, "botId=test-bot&controlLeaseId=short", `botId=bad%20bot&controlLeaseId=${lease}`,
    "threadId=th-1", `botId=test-bot&threadId=bad%20thread&controlLeaseId=${lease}`]) {
    expect((await open(bound(query))).status).toBe(400);
  }
  expect((await open(bound(`botId=test-bot&threadId=th-1&controlLeaseId=${lease}`))).status).toBe(101);
  expect((await open(bound(`botId=test-bot&threadId=th-2&controlLeaseId=${lease}`))).status).toBe(409);
  expect((await get(`${phoneBase}?botId=test-bot&controlLeaseId=${lease}`)).body).toEqual({ password: "fixture-secret" });
  leases.clear();
  expect((await get(`${phoneBase}?botId=test-bot&controlLeaseId=${lease}`)).status).toBe(409);
});

it("keeps the session and scope checks ahead of the lease, and closes a session's viewers per bot or all at once", async () => {
  leases.add(leaseKey(phoneTarget, "test-bot", lease));
  leases.add(leaseKey(phoneTarget, "other-bot", lease));
  expect((await open(bound(), { cookie: `test_session=${member.token}` })).status).toBe(403);
  expect((await open(bound(), { cookie: "test_session=revoked" })).status).toBe(401);
  const mine = (await open(bound())).socket!;
  const other = (await open(bound(`botId=other-bot&controlLeaseId=${lease}`))).socket!;
  const browser = (await open()).socket!;
  const closedMine = once(mine, "close");
  expect(viewer.closeForOwner("nobody", "test-bot")).toBe(0);
  expect(viewer.closeForOwner(admin.session.id, "test-bot")).toBe(1);
  expect(viewer.closeForOwner(admin.session.id, "test-bot")).toBe(0);
  await closedMine;
  expect(other.destroyed).toBe(false);
  expect(browser.destroyed).toBe(false);
  const rest = Promise.all([other, browser].map(socket => once(socket, "close")));
  expect(viewer.closeForOwner(admin.session.id)).toBe(2);
  await rest;
});

it("dials a VPS desktop again while it is still waking up, until its viewer port answers", async () => {
  const waking = createServer((_req, res) => res.writeHead(404).end());
  const port = await listen(waking);
  await new Promise<void>(resolve => waking.close(() => resolve()));
  vpsTarget = { key: "vps/test-bot", resolve: async () => ({ port, password: "fixture-secret" }) };
  const opened = open("/api/desktop-viewer/vps/test-bot/websockify");
  await new Promise(resolve => setTimeout(resolve, 350));
  const awake = createServer((_req, res) => res.writeHead(404).end());
  awake.on("upgrade", (req, socket) => {
    peers.add(socket);
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  await new Promise<void>(resolve => awake.listen(port, "127.0.0.1", resolve));
  try {
    expect((await opened).status).toBe(101);
  } finally {
    for (const peer of peers) peer.destroy();
    await new Promise<void>(resolve => { awake.close(() => resolve()); awake.closeAllConnections(); });
  }
});

it("answers a VPS desktop's handshake on the server when the viewer asks, so the viewer gets the opening at once", async () => {
  desktop.removeAllListeners("upgrade");
  desktop.on("upgrade", (req, socket) => {
    peers.add(socket);
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    // a desktop with no password: version, None, an OK result, then ServerInit once ClientInit arrives
    let raw = Buffer.alloc(0);
    let step = 0;
    socket.write(writeFrame(Buffer.from("RFB 003.008\n"), false));
    socket.on("data", (chunk: Buffer) => {
      raw = Buffer.concat([raw, chunk]);
      for (let next; (next = readFrame(raw));) {
        raw = raw.subarray(next.size);
        step++;
        if (step === 1) socket.write(writeFrame(Buffer.from([1, 1]), false));
        if (step === 2) socket.write(writeFrame(Buffer.from([0, 0, 0, 0]), false));
        if (step === 3) socket.write(writeFrame(Buffer.concat([Buffer.alloc(20), Buffer.from([0, 0, 0, 1]), Buffer.from("x")]), false));
      }
    });
  });
  vpsTarget = { key: "vps/test-bot", resolve: async () => ({ port: desktopPort, password: null }) };
  let raw = Buffer.alloc(0);
  const messages: string[] = [];
  const read = (chunk: Buffer) => {
    raw = Buffer.concat([raw, chunk]);
    for (let next; (next = readFrame(raw));) { raw = raw.subarray(next.size); messages.push(next.frame.payload.toString("latin1")); }
  };
  const status = await new Promise<number>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: appPort, path: "/api/desktop-viewer/vps/test-bot/websockify?rfb=server", headers: {
      ...headers(), Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13",
    } });
    req.once("upgrade", (res, socket, head) => { peers.add(socket); read(head); socket.on("data", read); resolve(res.statusCode!); });
    req.once("response", res => resolve(res.statusCode!));
    req.once("error", reject);
    req.end();
  });
  expect(status).toBe(101);
  await expect.poll(() => messages.length).toBe(2);
  expect(messages[0]).toBe("RFB 003.008\n");
  expect(messages[1]).toBe(Buffer.concat([Buffer.from([1, 1, 0, 0, 0, 0]), Buffer.alloc(20), Buffer.from([0, 0, 0, 1]), Buffer.from("x")]).toString("latin1"));
});

function post(path: string, body: unknown, extra: Record<string, string> = {}) {
  return new Promise<{ status: number; body: { error?: string; reason?: string } }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: appPort, path, method: "POST", headers: { ...headers(), "content-type": "application/json", ...extra } }, res => {
      let text = "";
      res.on("data", chunk => text += chunk);
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
    });
    req.once("error", reject);
    req.end(JSON.stringify(body));
  });
}

it("guards the direct screen's signaling exactly like the relay socket, and says when the server has no direct path", async () => {
  vpsTarget = { key: "vps/test-bot", resolve: async () => ({ port: desktopPort, password: null }) };
  const offer = { type: "offer", sdp: "v=0" };
  expect((await post("/api/desktop-viewer/vps/test-bot/direct", offer, { cookie: `test_session=${member.token}` })).status).toBe(403);
  expect((await post("/api/desktop-viewer/vps/test-bot/direct", offer, { origin: "https://evil.example" })).status).toBe(403);
  expect((await post("/api/desktop-viewer/vps/test-bot/direct", offer, { cookie: "test_session=revoked" })).status).toBe(401);
  expect((await get("/api/desktop-viewer/vps/test-bot/direct")).status).toBe(405);
  expect((await post("/api/desktop-viewer/local/shared/direct?botId=test-bot&controlLeaseId=lease-0000000000000000", offer)).status).toBe(409);
  // this viewer was made without node-datachannel: the app hears why and opens the relay
  expect(await post("/api/desktop-viewer/vps/test-bot/direct", offer)).toEqual({ status: 503, body: { error: "direct path is off", reason: "server-off" } });
  expect(inspected).toEqual([]);
});

it("shows how screens connected to an admin only", async () => {
  expect((await get("/api/desktop-viewer/transport", { cookie: `test_session=${member.token}` })).status).toBe(403);
  expect(await get("/api/desktop-viewer/transport")).toMatchObject({ status: 200, body: { available: false } });
});

it("tells a person's key and pointer input from a screen being watched", () => {
  const update = Buffer.from([3, 1, 0, 0, 0, 0, 4, 0, 3, 0]);
  const pointer = Buffer.from([5, 0, 0, 10, 0, 20]);
  const key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x61]);
  const encodings = Buffer.from([2, 0, 0, 2, 0, 0, 0, 7, 0, 0, 0, 0]);
  expect(rfbInput(update)).toBe(false);
  expect(rfbInput(Buffer.concat([encodings, update]))).toBe(false);
  expect(rfbInput(pointer)).toBe(true);
  expect(rfbInput(Buffer.concat([update, key]))).toBe(true);
  expect(rfbInput(Buffer.from("RFB 003.008\n"))).toBe(false);
  expect(rfbInput(Buffer.from([5, 0]))).toBe(false);
});
