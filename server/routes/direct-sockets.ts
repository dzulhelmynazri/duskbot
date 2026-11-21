// A WebSocket route carried on a direct peer (shared/screen-direct.ts, "a WebSocket carried on a direct peer"): the app
// signals with POST /api/direct/socket?path=<socket path>, and once its channel opens this server opens that same
// socket on itself with the signaling request's own credentials and forwarding headers. The route then checks it exactly
// as it checks a socket over the relay, so the direct path can never reach more than the person could anyway.
import type { IncomingMessage } from "node:http";
import WebSocket from "ws";
import {
  SCREEN_DIRECT_CONNECT_MS, SCREEN_DIRECT_GATHER_MS, SOCKET_CHANNEL, SOCKET_DIRECT_PATH, SOCKET_DIRECT_TARGET, SOCKET_KIND, SOCKET_PIECE,
} from "../../shared/screen-direct.ts";
import { isProxied, requestSource, type RequestAuth } from "../request-auth.ts";
import { DirectRefused, type ScreenChannel, type ScreenDirect } from "../screen-direct.ts";
import { PASS, type RouteHandler } from "./table.ts";

/** Headers that say who is asking; everything else of the signaling request stays behind. */
const CARRIED = ["cookie", "authorization", "host", "origin", "user-agent", "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "forwarded", "x-madani-background"];
const HIGH = 1024 * 1024;
const CONNECT_MS = 10_000;
/** a peer whose channel has not opened by then never will (gathering, the answer's way back and ICE) */
const OPEN_MS = SCREEN_DIRECT_GATHER_MS * 2 + SCREEN_DIRECT_CONNECT_MS + 5_000;

/** The signaling request's identity for the same socket opened on this server: a forwarded request stays forwarded. */
export function carriedHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of CARRIED) {
    const value = req.headers[name];
    if (typeof value === "string") headers[name] = value;
    else if (Array.isArray(value)) headers[name] = value.join(", ");
  }
  // a gateway's IPC peer has no forwarding header of its own; the copy must still never count as this machine
  if (isProxied(req) && !headers["x-forwarded-for"] && !headers.forwarded) headers["x-forwarded-for"] = requestSource(req) || "0.0.0.0";
  return headers;
}

/** Turns WebSocket messages into channel messages and back (SOCKET_KIND framing). */
export function socketFraming(channel: Pick<ScreenChannel, "sendMessage">) {
  let parts: Buffer[] = [];
  return {
    send(data: Buffer, binary: boolean) {
      for (let at = 0; at < data.length || at === 0; at += SOCKET_PIECE) {
        const last = at + SOCKET_PIECE >= data.length;
        const kind = binary ? (last ? SOCKET_KIND.binary : SOCKET_KIND.binaryPart) : (last ? SOCKET_KIND.text : SOCKET_KIND.textPart);
        if (!channel.sendMessage(Buffer.concat([Buffer.from([kind]), data.subarray(at, at + SOCKET_PIECE)]))) return false;
        if (last) break;
      }
      return true;
    },
    close(code: number, reason: string) {
      channel.sendMessage(Buffer.concat([Buffer.from([SOCKET_KIND.close]), Buffer.from(JSON.stringify({ code, reason: reason.slice(0, 120) }))]));
    },
    /** one channel message in; a whole WebSocket message out when its last part arrives */
    read(message: Buffer): { data: Buffer; binary: boolean } | { close: { code: number; reason: string } } | null {
      const kind = message[0];
      const body = message.subarray(1);
      if (kind === SOCKET_KIND.close) {
        try {
          const { code, reason } = JSON.parse(body.toString()) as { code?: unknown; reason?: unknown };
          return { close: { code: typeof code === "number" ? code : 1000, reason: typeof reason === "string" ? reason : "" } };
        } catch { return { close: { code: 1000, reason: "" } }; }
      }
      if (kind === SOCKET_KIND.textPart || kind === SOCKET_KIND.binaryPart) {
        parts.push(body);
        if (parts.reduce((sum, part) => sum + part.length, 0) > 16 * 1024 * 1024) throw new Error("message too large");
        return null;
      }
      if (kind !== SOCKET_KIND.text && kind !== SOCKET_KIND.binary) throw new Error("not a socket message");
      const data = parts.length ? Buffer.concat([...parts, body]) : body;
      parts = [];
      return { data, binary: kind === SOCKET_KIND.binary };
    },
  };
}

/** a WebSocket close code the app's socket accepts: 1000 or an application code */
const closeCode = (code: number) => (code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000);

export function createDirectSockets(deps: { direct?: ScreenDirect; self: () => { port: number } | null }): RouteHandler {
  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    if (path !== SOCKET_DIRECT_PATH) return PASS;
    res.setHeader("cache-control", "private, no-store");
    if (method !== "POST") return json(res, 405, { error: "method not allowed" });
    const target = url.searchParams.get("path") ?? "";
    if (!SOCKET_DIRECT_TARGET.test(target)) return json(res, 400, { error: "not a socket this path carries", reason: "signal-failed" });
    if (!deps.direct?.available()) return json(res, 503, { error: "direct path is off", reason: "server-off" });
    if ((auth as RequestAuth).kind === "loopback") return json(res, 409, { error: "direct path is for another machine", reason: "unsupported" });
    const self = deps.self();
    if (!self) return json(res, 503, { error: "direct path is off", reason: "server-off" });
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) return json(res, 415, { error: "send the offer as JSON" });
    let offer: unknown;
    try { offer = await readBody(req, 128 * 1024); } catch { return json(res, 400, { error: "not a screen offer", reason: "signal-failed" }); }
    const headers = carriedHeaders(req);
    // the socket opens while ICE connects, so the first frame follows the channel at once; held until the channel opens
    let socket: WebSocket | null = null;
    let channel: ScreenChannel | null = null;
    let framing: ReturnType<typeof socketFraming> | null = null;
    let ended = false;
    const early: Array<{ data: Buffer; binary: boolean }> = [];
    let closedEarly: { code: number; reason: string } | null = null;
    const end = (code = 1000, reason = "") => {
      if (ended) return;
      ended = true;
      clearTimeout(deadline);
      if (channel && framing) {
        const open = channel;
        framing.close(closeCode(code), reason);
        setTimeout(() => open.close(), 100).unref();
      }
      socket?.terminate();
    };
    const deadline = setTimeout(() => { if (!channel) end(); }, OPEN_MS);
    deadline.unref();
    const join = (opened: ScreenChannel) => {
      channel = opened;
      clearTimeout(deadline);
      const own = socketFraming(opened);
      framing = own;
      opened.onClose(() => { ended = true; socket?.terminate(); });
      if (closedEarly) { end(closedEarly.code, closedEarly.reason); return; }
      for (const message of early.splice(0)) own.send(message.data, message.binary);
      opened.onDrain(() => { if (!ended) socket?.resume(); });
      opened.onMessage((message) => {
        let read;
        try { read = own.read(message); } catch { end(1009, "too large"); return; }
        if (!read) return;
        if ("close" in read) { end(read.close.code, read.close.reason); return; }
        const { data, binary } = read;
        if (socket?.readyState === WebSocket.OPEN) socket.send(data, { binary });
        else socket?.once("open", () => socket?.send(data, { binary }));
      });
      socket?.resume();
    };
    try {
      const peer = await deps.direct.answer(offer, (opened) => { if (ended) opened.close(); else join(opened); }, SOCKET_CHANNEL);
      if (!ended) {
        const ws = new WebSocket(`ws://127.0.0.1:${self.port}${target}`, { headers, perMessageDeflate: false, handshakeTimeout: CONNECT_MS, followRedirects: false });
        socket = ws;
        const finish = (code: number, reason: string) => { if (channel) end(code, reason); else { closedEarly ??= { code, reason }; } };
        ws.on("unexpected-response", (_request, answer) => { answer.resume(); finish(4000 + Math.min(999, answer.statusCode ?? 502), "refused"); });
        ws.on("error", () => finish(1011, "unavailable"));
        ws.on("close", (code, reason) => finish(code, reason.toString()));
        ws.on("open", () => { if (!channel) ws.pause(); });
        ws.on("message", (data, binary) => {
          const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
          if (!channel || !framing) { early.push({ data: bytes, binary }); return; }
          if (!framing.send(bytes, binary)) end(1011, "unavailable");
          else if (channel.buffered() > HIGH) ws.pause();
        });
      }
      return json(res, 200, peer.answer);
    } catch (error) {
      const refused = error instanceof DirectRefused ? error : new DirectRefused(503, "direct path is off");
      return json(res, refused.status, { error: refused.message, reason: refused.status === 400 ? "signal-failed" : "server-off" });
    }
  };
}
