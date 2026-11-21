// Two processes: a server with the real desktop viewer route and node-datachannel (server/testing/screen-direct-peer.ts)
// and this one as the app, with node-datachannel's RTCPeerConnection standing in for Chromium's. The screen and its
// input go peer to peer; with ICE unable to connect the screen opens over the relay socket and nothing throws.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { createInterface } from "node:readline";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { RTCPeerConnection as NodePeer } from "node-datachannel/polyfill";
import { afterAll, beforeAll, expect, it } from "vitest";
import { openDirectScreen, resetDirectScreen } from "./screen-direct";

const root = fileURLToPath(new URL("../..", import.meta.url));
// MADANI_SCREEN_BENCH_RATE (bytes per second) measures a heavier screen; 25 Mbit/s is about 3276800
const RATE = Number(process.env.MADANI_SCREEN_BENCH_RATE) || 320 * 1024;
const MEASURE_MS = 2_000;
const Peer = NodePeer as unknown as typeof RTCPeerConnection;
const base = "/api/desktop-viewer/vps/test-bot";
/** the app's own RFB opening: version, security choice, ClientInit; the server already gave the desktop these */
const CLIENT_OPENING = Buffer.concat([Buffer.from("RFB 003.008\n"), Buffer.from([1, 1])]);
let child: ChildProcess;
let port = 0;
let token = "";

beforeAll(async () => {
  child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "server/testing/screen-direct-peer.ts", String(RATE)], { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
  const line = await new Promise<string>((resolve, reject) => {
    createInterface({ input: child.stdout! }).once("line", resolve);
    child.once("exit", (code) => reject(new Error(`peer exited ${code}`)));
  });
  ({ port, token } = JSON.parse(line) as { port: number; token: string });
}, 30_000);
afterAll(() => { child?.kill("SIGTERM"); });

const headers = () => ({ host: "workspace.example", "x-forwarded-proto": "https", cookie: `test_session=${token}` });

/** fetch over node:http, so the request carries the signed-in cookie and host like the app's link proxy does */
function linkFetch(rewrite: (sdp: string) => string = (sdp) => sdp): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.stringify({ ...JSON.parse(String(init.body)), sdp: rewrite(JSON.parse(String(init.body)).sdp) }) : undefined;
    const answer = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port, path: url, method: init?.method ?? "GET", headers: { ...headers(), "content-type": "application/json" } }, (res) => {
        let text = "";
        res.on("data", (chunk) => text += chunk);
        res.on("end", () => resolve({ status: res.statusCode!, text }));
      });
      req.once("error", reject);
      req.end(body);
    });
    const parsed = answer.text ? JSON.parse(answer.text) as { sdp?: string } : {};
    if (typeof parsed.sdp === "string") parsed.sdp = rewrite(parsed.sdp);
    return new Response(JSON.stringify(parsed), { status: answer.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

/** an SDP with no way to reach its side: ICE has nothing to check and cannot connect */
const noCandidates = (sdp: string) => sdp.split(/\r?\n/).filter((line) => !line.startsWith("a=candidate") && line !== "a=end-of-candidates").join("\r\n");

async function rate(read: () => number): Promise<number> {
  const before = read();
  await new Promise((resolve) => setTimeout(resolve, MEASURE_MS));
  return Math.round((read() - before) * 1000 / MEASURE_MS);
}

function serverFrames(onPayload: (bytes: Buffer) => void) {
  let raw = Buffer.alloc(0);
  return (chunk: Buffer) => {
    raw = Buffer.concat([raw, chunk]);
    for (;;) {
      if (raw.length < 2) return;
      let length = raw[1]! & 0x7f, offset = 2;
      if (length === 126) { if (raw.length < 4) return; length = raw.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (raw.length < 10) return; length = Number(raw.readBigUInt64BE(2)); offset = 10; }
      if (raw.length < offset + length) return;
      onPayload(raw.subarray(offset, offset + length));
      raw = raw.subarray(offset + length);
    }
  };
}

function maskedFrame(payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const head = Buffer.from([0x82, 0x80 | payload.length]);
  return Buffer.concat([head, mask, Buffer.from(payload.map((byte, i) => byte ^ mask[i & 3]!))]);
}

it("carries the screen and the person's input peer to peer", async () => {
  resetDirectScreen();
  const result = await openDirectScreen(`${base}/direct?rfb=server`, { signal: AbortSignal.timeout(15_000), fetch: linkFetch(), RTCPeerConnection: Peer, iceServers: [] });
  if (!("channel" in result)) throw new Error(`fell back: ${result.fallback}`);
  const { channel } = result;
  const messages: Buffer[] = [];
  let received = 0;
  channel.addEventListener("message", (event) => {
    const bytes = Buffer.from((event as MessageEvent<ArrayBuffer>).data);
    received += bytes.length;
    messages.push(bytes);
  });
  await expect.poll(() => messages.length, { timeout: 5_000 }).toBeGreaterThanOrEqual(2);
  expect(messages[0]!.toString("latin1")).toBe("RFB 003.008\n");
  // security: None only, an OK result, then the desktop's ServerInit
  expect([...messages[1]!.subarray(0, 6)]).toEqual([1, 1, 0, 0, 0, 0]);
  channel.send(CLIENT_OPENING);
  channel.send(Buffer.from("key-a"));
  await expect.poll(() => Buffer.concat(messages).includes(Buffer.from([0xfe, ...Buffer.from("key-a")])), { timeout: 5_000 }).toBe(true);
  const direct = await rate(() => received);
  console.log(`direct screen: ${direct} B/s (desktop sends ${RATE} B/s)`);
  expect(direct).toBeGreaterThan(RATE * 0.8);
  result.close();
}, 30_000);

it("falls back to the relay without an error when ICE cannot connect, and counts why", async () => {
  resetDirectScreen();
  const started = Date.now();
  const result = await openDirectScreen(`${base}/direct?rfb=server`, { signal: AbortSignal.timeout(15_000), fetch: linkFetch(noCandidates), RTCPeerConnection: Peer, iceServers: [], connectMs: 2_000 });
  expect("fallback" in result && ["timeout", "ice-failed"].includes(result.fallback)).toBe(true);
  expect(Date.now() - started).toBeLessThan(6_000);
  const reason = (result as { fallback: string }).fallback;
  // the next screen does not wait for ICE again
  expect(await openDirectScreen(`${base}/direct?rfb=server`, { signal: AbortSignal.timeout(5_000), fetch: linkFetch(), RTCPeerConnection: Peer, iceServers: [] })).toEqual({ fallback: "recent-failure" });

  // the relay socket, as connectDesktop opens it after a fallback
  let received = 0;
  const payloads: Buffer[] = [];
  const socket = await new Promise<Duplex>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path: `${base}/websockify?rfb=server&direct=${reason}`, headers: {
      ...headers(), Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": randomBytes(16).toString("base64"), "Sec-WebSocket-Version": "13",
    } });
    req.once("upgrade", (_res, upgraded, head) => {
      const read = serverFrames((payload) => { received += payload.length; payloads.push(Buffer.from(payload)); });
      read(head);
      upgraded.on("data", read);
      resolve(upgraded);
    });
    req.once("response", (res) => reject(new Error(`relay answered ${res.statusCode}`)));
    req.once("error", reject);
    req.end();
  });
  await expect.poll(() => payloads.length, { timeout: 5_000 }).toBeGreaterThanOrEqual(2);
  expect(payloads[0]!.toString("latin1")).toBe("RFB 003.008\n");
  socket.write(maskedFrame(CLIENT_OPENING));
  socket.write(maskedFrame(Buffer.from("key-b")));
  await expect.poll(() => Buffer.concat(payloads).includes(Buffer.from([0xfe, ...Buffer.from("key-b")])), { timeout: 5_000 }).toBe(true);
  const relay = await rate(() => received);
  console.log(`relay screen: ${relay} B/s (desktop sends ${RATE} B/s)`);
  expect(relay).toBeGreaterThan(RATE * 0.8);
  socket.destroy();

  const stats = await linkFetch()("/api/desktop-viewer/transport").then((response) => response.json()) as {
    available: boolean; paths: Record<string, number>; direct: { sessions: number; failed: number; bytesSent: number }; relay: { sessions: number; bytesSent: number; reasons: Record<string, number> };
  };
  expect(stats.available).toBe(true);
  expect(stats.direct.sessions).toBe(1);
  // the server drops the peer that never connected at its own deadline
  await expect.poll(async () => (await linkFetch()("/api/desktop-viewer/transport").then((response) => response.json()) as typeof stats).direct.failed, { timeout: 15_000, interval: 500 }).toBe(1);
  expect(stats.relay.reasons[reason]).toBe(1);
  expect(stats.paths).toEqual({ direct: 1, "cloudflare-turn": 0, "our-relay": 1 });
  await expect.poll(async () => (await linkFetch()("/api/desktop-viewer/transport").then((response) => response.json()) as typeof stats).relay.bytesSent).toBeGreaterThan(0);
  const after = await linkFetch()("/api/desktop-viewer/transport").then((response) => response.json()) as typeof stats;
  console.log(`wire bytes: direct ${after.direct.bytesSent}, relay ${after.relay.bytesSent}`);
  // nothing about the person in the counters
  expect(JSON.stringify(after)).not.toMatch(/127\.0\.0\.1|test-bot|Mac/);
  expect(JSON.stringify(after)).not.toContain(token);
}, 60_000);
