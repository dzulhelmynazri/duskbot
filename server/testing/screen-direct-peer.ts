// A server with a VPS desktop for the direct screen end-to-end test (src/lib/screen-direct.e2e.test.ts), run as its own
// process: the real desktop viewer route and node-datachannel, one signed-in session, and a fake desktop that answers
// the VNC handshake, then sends a steady picture stream and echoes what it is sent (take-control input).
// Prints {"port","token"} once listening.
//   node --experimental-strip-types server/testing/screen-direct-peer.ts [bytes per second]
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { json, readBody } from "../harness/http.ts";
import { resolveRequestAuth } from "../request-auth.ts";
import { createDesktopViewer } from "../routes/desktop-viewer.ts";
import { createUpgrades } from "../routes/upgrades.ts";
import { readFrame, writeFrame } from "../routes/rfb-handshake.ts";
import { WebSocketServer } from "ws";
import { createDirectSockets } from "../routes/direct-sockets.ts";
import { isProxied } from "../request-auth.ts";
import { createScreenDirect } from "../screen-direct.ts";
import { SessionRegistry } from "../sessions.ts";

const RATE = Number(process.argv[2] ?? 320 * 1024);
const TICK_MS = 50;
/** what the fake desktop puts in front of an echo, so the test can find its input in the stream */
const ECHO = 0xfe;

const desktop = createServer((_req, res) => res.writeHead(404).end());
desktop.on("upgrade", (req, socket) => {
  const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.on("error", () => {});
  socket.write(writeFrame(Buffer.from("RFB 003.008\n"), false));
  let raw = Buffer.alloc(0), step = 0, stream: ReturnType<typeof setInterval> | undefined;
  socket.on("close", () => clearInterval(stream));
  socket.on("data", (chunk: Buffer) => {
    raw = Buffer.concat([raw, chunk]);
    for (let next; (next = readFrame(raw));) {
      raw = raw.subarray(next.size);
      if (next.frame.opcode >= 8) continue;
      step++;
      if (step === 1) socket.write(writeFrame(Buffer.from([1, 1]), false));
      else if (step === 2) socket.write(writeFrame(Buffer.from([0, 0, 0, 0]), false));
      else if (step === 3) {
        socket.write(writeFrame(Buffer.concat([Buffer.from([0, 4, 0, 3]), Buffer.alloc(16), Buffer.from([0, 0, 0, 4]), Buffer.from("fake")]), false));
        const piece = Buffer.alloc(Math.max(1, Math.round(RATE * TICK_MS / 1000)), 1);
        stream = setInterval(() => socket.write(writeFrame(piece, false)), TICK_MS);
      } else socket.write(writeFrame(Buffer.concat([Buffer.from([ECHO]), next.frame.payload]), false));
    }
  });
});
await new Promise<void>((resolve) => desktop.listen(0, "127.0.0.1", resolve));
const desktopPort = (desktop.address() as { port: number }).port;

const sessions = new SessionRegistry({ file: join(mkdtempSync(join(tmpdir(), "madani-direct-peer-")), "sessions.json") });
const admin = sessions.issue({ label: "Mac", scopes: ["admin", "client"] });
const direct = createScreenDirect({ iceServers: [] });
let appPort = 0;
const sockets = createDirectSockets({ direct, self: () => ({ port: appPort }) });
// a stand-in for the bot browser's stream (/api/bots/<id>/browser/stream): signed-in and forwarded only, then picture
// frames the size of a browsing JPEG at a steady rate, a JSON hello, text echoed back, and "bye" closes with 4404
const STREAM = "/api/bots/test-bot/browser/stream";
const streams = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const FRAME = Buffer.alloc(Number(process.env.STREAM_FRAME ?? 96 * 1024), 2);
const upgrades = createUpgrades();
upgrades.route((path) => path === STREAM);
const viewer = createDesktopViewer({
  upgrades,
  target: (id) => id === "vps/test-bot" ? { key: "vps/test-bot", resolve: async () => ({ port: desktopPort, password: null }) } : undefined,
  live: (auth) => auth.kind === "loopback" || sessions.isLive(auth.session.id),
  direct,
});
const handle = async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url!, "http://localhost");
  const gate = resolveRequestAuth(req, { sessions, cookieName: "test_session", url, streamPath: "/api/events", loopbackTrust: "service" });
  if (!gate.auth) return json(res, gate.status, { error: gate.error });
  if (url.pathname === STREAM) {
    const pending = upgrades.pending(req);
    if (!pending || gate.auth.kind !== "session" || !isProxied(req)) return json(res, 403, { error: "forbidden" });
    pending.release();
    res.detachSocket(pending.socket);
    streams.handleUpgrade(req, pending.socket, pending.head, (ws) => {
      ws.send(JSON.stringify({ type: "hello", via: url.searchParams.get("direct") ?? "direct" }));
      const timer = setInterval(() => ws.send(FRAME), 1000 / Number(process.env.STREAM_FPS ?? 10));
      ws.on("message", (data, binary) => {
        const text = binary ? "" : data.toString();
        if (text === "bye") ws.close(4404, "tab gone");
        else if (text) ws.send(JSON.stringify({ type: "echo", text }));
      });
      ws.on("close", () => clearInterval(timer));
    });
    return;
  }
  if (url.pathname === "/api/direct/socket") { await sockets({ req, res, url, path: url.pathname, method: req.method!, auth: gate.auth, json, readBody }); return; }
  await viewer.route({ req, res, url, path: url.pathname, method: req.method!, auth: gate.auth, json, readBody });
  if (!res.headersSent && !res.writableEnded && !req.headers.upgrade) json(res, 404, { error: "not found" });
};
const app = createServer((req, res) => void handle(req, res));
viewer.attach(app, handle);
await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
appPort = (app.address() as { port: number }).port;
process.stdout.write(`${JSON.stringify({ port: (app.address() as { port: number }).port, token: admin.token })}\n`);
process.on("SIGTERM", () => { viewer.closeAll(); process.exit(0); });
