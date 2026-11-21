// A madani cloud home's end of "browse through the person's connection when a site blocks the cloud". A linked VPS has
// the link agent for this (apps/link-service/agent.mjs createEgressProxy); a cloud home has no link agent, so the app
// keeps a websocket to the home's own https while the home is awake (electron/home-egress-link.mjs) and its egress
// endpoint (electron/vps-link-egress.mjs createEgressEndpoint, unchanged) opens the connections from the person's
// computer. Here the streams are opened in process for the built-in browser's gate, and served as SOCKS5 on the bot
// computers' bridge for their Chromium, whose policy (computer-egress.ts) sends only the blocked sites this way.
// Security: nothing here connects anywhere itself; the SOCKS listener answers the bridge's boxes only, never the host's
// own address, and the app checks every destination again on its side.
import { randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { Duplex } from "node:stream";

import { encodeBytes, encodeControl, linkReader, type EgressLinkFrame } from "../electron/egress-link-codec.mjs";
import type { EgressAgentReport } from "./computer-egress.ts";

/** the app says hello every 15 s while it takes streams; past this it is gone */
export const LINK_SEEN_MS = 40_000;
export const LINK_DIAL_MS = 8_000;
const QUEUE_HIGH = 1024 * 1024;
const PIECE = 256 * 1024;
const BRIDGE = "omb-desk0";
export const BOX_PROXY_PORT = 3129;

interface Stream { local: Duplex; settle: ((ok: boolean) => void) | null; timer: NodeJS.Timeout | null; ended: boolean }

const randomId = () => Array.from(randomBytes(12), (byte) => "abcdefghijklmnopqrstuvwxyz234567"[byte & 31]).join("");

export function createHomeEgressLink({ now = Date.now, log = () => {}, dialMs = LINK_DIAL_MS }: { now?: () => number; log?: (line: string) => void; dialMs?: number } = {}) {
  let link: Duplex | null = null;
  let ready = false, seenAt = 0;
  const streams = new Map<string, Stream>();
  const stats = { relayed: 0, refused: 0, fallbacks: 0 };

  const write = (record: Buffer) => { if (link && !link.destroyed) link.write(record); };
  const send = (frame: Record<string, unknown>) => write(encodeControl(frame));
  const online = () => Boolean(link && !link.destroyed) && ready && now() - seenAt < LINK_SEEN_MS;

  function forget(r: string, tell: boolean) {
    const entry = streams.get(r);
    if (!entry) return;
    streams.delete(r);
    if (entry.timer) clearTimeout(entry.timer);
    entry.settle?.(false);
    if (tell) send({ t: "cancel", r });
    entry.local.destroy();
  }

  function dropAll() {
    for (const r of Array.from(streams.keys())) forget(r, false);
  }

  function handle(frame: EgressLinkFrame) {
    if (frame.t === "egress") {
      if (frame.ready === true) { ready = true; seenAt = now(); }
      else { ready = false; dropAll(); }
      return;
    }
    const entry = typeof frame.r === "string" ? streams.get(frame.r) : undefined;
    if (!entry) return;
    if (frame.t === "dialed") {
      seenAt = now();
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
      const settle = entry.settle;
      entry.settle = null;
      settle?.(frame.ok === true);
    } else if (frame.t === "bytes") {
      if (!entry.local.push((frame as { b: Buffer }).b)) link?.pause();
    } else if (frame.t === "end") {
      entry.ended = true;
      entry.local.push(null);
    } else if (frame.t === "cancel") forget(frame.r!, false);
  }

  return {
    online,
    /** the app's connection; a newer one replaces it */
    attach(stream: Duplex) {
      if (link) { const old = link; link = null; dropAll(); old.destroy(); }
      link = stream;
      ready = false;
      const read = linkReader(handle);
      stream.on("data", (chunk: Buffer) => { try { read(chunk); } catch (error) { log(`egress link: ${error instanceof Error ? error.message : String(error)}`); stream.destroy(); } });
      stream.on("drain", () => { for (const entry of streams.values()) entry.local.emit("link-drain"); });
      const gone = () => { if (link === stream) { link = null; ready = false; dropAll(); } };
      stream.once("close", gone);
      stream.once("error", gone);
    },
    /** A connection to host:port opened on the person's computer, or null when it cannot be now (offline, busy, refused). */
    open(host: string, port: number): Promise<Duplex | null> {
      if (!online()) { stats.fallbacks += 1; return Promise.resolve(null); }
      const r = randomId();
      const local: Duplex = new Duplex({
        write(chunk: Buffer, _encoding, callback) {
          for (let at = 0; at < chunk.length; at += PIECE) write(encodeBytes(r, chunk.subarray(at, at + PIECE)));
          if (link && link.writableLength >= QUEUE_HIGH) local.once("link-drain", () => callback());
          else callback();
        },
        final(callback) { if (streams.has(r)) send({ t: "end", r }); callback(); },
        read() { link?.resume(); },
        destroy(error, callback) { if (streams.has(r)) forget(r, !streams.get(r)!.ended); callback(error); },
      });
      return new Promise((resolve) => {
        const entry: Stream = { local, ended: false, timer: null, settle: (ok) => {
          if (ok) { stats.relayed += 1; resolve(local); return; }
          stats.refused += 1;
          resolve(null);
        } };
        entry.timer = setTimeout(() => {
          // the app did not answer in time: it is asleep or gone, so this connection goes the server's way
          log("egress link: the app did not answer a dial; using this server's network");
          ready = false;
          forget(r, true);
        }, dialMs);
        streams.set(r, entry);
        send({ t: "dial", r, host, port });
      });
    },
    stats: () => ({ ...stats, active: streams.size }),
    close() { dropAll(); link?.destroy(); link = null; },
  };
}

export type HomeEgressLink = ReturnType<typeof createHomeEgressLink>;

/** The bot computers' bridge on this machine: its address and network, or null while it does not exist. */
export function bridgeOf(name = BRIDGE, interfaces = networkInterfaces()): { host: string; inSubnet(address: string): boolean } | null {
  const entry = interfaces[name]?.find((one) => one.family === "IPv4");
  if (!entry) return null;
  const toNumber = (ip: string) => ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
  const mask = toNumber(entry.netmask);
  const net = (toNumber(entry.address) & mask) >>> 0;
  return { host: entry.address, inSubnet: (address) => ((toNumber(address) & mask) >>> 0) === net };
}

// SOCKS5 (RFC 1928) replies: success, general failure (Chromium then takes the PAC's DIRECT), command unsupported.
const reply = (code: number) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);

/**
 * SOCKS5 CONNECT for the bot computers, over the link. Only addresses `allowed` may connect (the bridge's boxes, never
 * the bridge's own address, so host processes cannot use it). A connection the link cannot carry gets a general
 * failure at once, which Chromium's PAC answers by going DIRECT: the site is back on this server's network.
 */
export function listenBoxProxy({ link, host, port = BOX_PROXY_PORT, allowed }: { link: Pick<HomeEgressLink, "open">; host: string; port?: number; allowed(address: string): boolean }):
  Promise<{ server: Server; port: number; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    const remote = String(client.remoteAddress ?? "").replace(/^::ffff:/u, "");
    if (!allowed(remote)) { client.destroy(); return; }
    let data = Buffer.alloc(0), greeted = false;
    const onData = (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (data.length > 1024) return void client.destroy();
      if (!greeted) {
        if (data.length < 2 || data.length < 2 + data[1]!) return;
        if (data[0] !== 5 || !data.subarray(2, 2 + data[1]!).includes(0)) return void client.end(Buffer.from([5, 0xff]));
        data = data.subarray(2 + data[1]!);
        greeted = true;
        client.write(Buffer.from([5, 0]));
      }
      if (data.length < 5) return;
      if (data[0] !== 5 || data[1] !== 1 || data[3] !== 3) { client.off("data", onData); return void client.end(reply(7)); }
      const end = 7 + data[4]!;
      if (data.length < end) return;
      client.off("data", onData);
      client.pause();
      const target = data.subarray(5, 5 + data[4]!).toString("latin1"), targetPort = data.readUInt16BE(end - 2), rest = data.subarray(end);
      void link.open(target, targetPort).then((upstream) => {
        if (!upstream) return void client.end(reply(1));
        if (client.destroyed) return void upstream.destroy();
        client.write(reply(0));
        if (rest.length) upstream.write(rest);
        upstream.on("error", () => client.destroy());
        upstream.pipe(client);
        client.pipe(upstream);
        client.on("close", () => upstream.destroy());
        upstream.on("close", () => client.destroy());
        client.resume();
      });
    };
    client.on("data", onData);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      server.on("error", () => {});
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : port,
        close: () => new Promise<void>((done) => { for (const socket of sockets) socket.destroy(); server.close(() => done()); }) });
    });
  });
}

/**
 * Keeps the box proxy on the bridge while the bridge exists, and tells computer-egress.ts what the link agent would:
 * whether the person's computer takes streams and where the proxy listens.
 */
export function runHomeEgress({ link, report, bridge = () => bridgeOf(), everyMs = 5_000, log = () => {} }: {
  link: HomeEgressLink; report(value: EgressAgentReport): unknown; bridge?: () => ReturnType<typeof bridgeOf>; everyMs?: number; log?: (line: string) => void;
}) {
  let proxy: Awaited<ReturnType<typeof listenBoxProxy>> | null = null, proxyHost: string | null = null, stopped = false;
  async function tick() {
    const at = bridge();
    if (proxy && proxyHost !== at?.host) { await proxy.close(); proxy = null; proxyHost = null; }
    if (!proxy && at) {
      try {
        proxy = await listenBoxProxy({ link, host: at.host, allowed: (address) => address !== at.host && at.inSubnet(address) });
        proxyHost = at.host;
      } catch (error) { log(`egress link: could not listen on ${at.host}:${BOX_PROXY_PORT} (${error instanceof Error ? error.message : String(error)})`); }
    }
    const stats = link.stats();
    report({ online: link.online(), proxy: proxy && proxyHost ? { host: proxyHost, port: proxy.port } : null, active: stats.active, relayed: stats.relayed, refused: stats.refused, fallbacks: stats.fallbacks });
  }
  const timer = setInterval(() => { if (!stopped) void tick().catch(() => {}); }, everyMs);
  timer.unref?.();
  void tick().catch(() => {});
  return { tick, close: async () => { stopped = true; clearInterval(timer); await proxy?.close(); } };
}
