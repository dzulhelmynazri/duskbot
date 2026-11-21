// The server's end of the direct screen path (shared/screen-direct.ts): answers an app's WebRTC offer with
// node-datachannel, then carries the desktop's RFB bytes on the "screen" data channel instead of the link relay.
// The offer arrives on an authenticated request, so the DTLS fingerprint in it is the only peer that can complete the
// handshake; nothing reaches the desktop before the channel opens and the route's own checks still pass.
// node-datachannel is a native addon: where it is missing or fails to load, `available()` is false and the screen
// stays on the relay.
import type { Duplex } from "node:stream";
import type { DataChannel, PeerConnection } from "node-datachannel";
import {
  SCREEN_CANDIDATE_TYPES, SCREEN_CHANNEL, SCREEN_DIRECT_CONNECT_MS, SCREEN_DIRECT_GATHER_MS, SCREEN_DIRECT_ICE_SERVERS,
  SCREEN_DIRECT_MESSAGE, SCREEN_FALLBACK_REASONS, SCREEN_SDP_MAX, type ScreenCandidateType, type ScreenFallbackReason, type ScreenPath,
} from "../shared/screen-direct.ts";
import { nativeRequire } from "./data/engine.ts";
import { readFrame, writeFrame } from "./routes/rfb-handshake.ts";
import { trail } from "./trail.ts";

interface DataChannelModule {
  PeerConnection: new (name: string, config: {
    iceServers: string[]; portRangeBegin?: number; portRangeEnd?: number; maxMessageSize?: number;
  }) => PeerConnection;
}

/** A peer that has not opened its channel by then is dropped (signaling round trip, gathering and ICE included). */
const OPEN_DEADLINE_MS = SCREEN_DIRECT_GATHER_MS * 2 + SCREEN_DIRECT_CONNECT_MS + 5_000;
const DEFAULT_MAX_PEERS = 16;
/** Desktop bytes waiting in the channel above this pause the desktop; below the low mark they flow again. */
const CHANNEL_HIGH = 1024 * 1024;
const CHANNEL_LOW = 256 * 1024;

/** The data channel as the bridge sees it: bytes in, bytes out, nothing WebRTC-specific. */
export interface ScreenChannel {
  /** a byte stream: split into pieces, boundaries not kept */
  send(bytes: Buffer): boolean;
  /** one data-channel message, boundaries kept (at most SCREEN_DIRECT_MESSAGE * 4 bytes) */
  sendMessage(bytes: Buffer): boolean;
  buffered(): number;
  onDrain(callback: () => void): void;
  onMessage(callback: (bytes: Buffer) => void): void;
  onClose(callback: () => void): void;
  close(): void;
}

export interface DirectPeer {
  /** The answer to send back on the signaling request. */
  answer: { type: "answer"; sdp: string };
  /** Ends the peer and its channel. */
  close(): void;
}

export interface ScreenTransportStats {
  since: string;
  /** Whether this server can answer direct offers at all. */
  available: boolean;
  /** screens by the path they took: peer to peer, through Cloudflare's TURN (the app's relay candidate won), our link relay */
  paths: Record<ScreenPath, number>;
  /** the winning candidate pair of each WebRTC screen, as "<server's type>/<app's type>" (host, srflx, prflx, relay) */
  pairs: Record<string, number>;
  /** bytes are the screen's own (RFB) bytes, counted as they pass; `failed` is peers that never opened */
  direct: { sessions: number; open: number; failed: number; bytesSent: number; bytesReceived: number; candidates: Record<ScreenCandidateType, number> };
  /** bytes are the viewer socket's, counted when it closes; `reasons` is why each relay screen was not direct ("none": not asked) */
  relay: { sessions: number; open: number; bytesSent: number; bytesReceived: number; reasons: Record<ScreenFallbackReason | "none", number> };
}

export class DirectRefused extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** Finds node-datachannel beside the server; null (direct off) when it is missing, broken or turned off. */
export function loadDataChannel(env: NodeJS.ProcessEnv = process.env): DataChannelModule | null {
  if (env.MADANI_SCREEN_DIRECT === "off") return null;
  for (const directory of [undefined, null]) {
    try {
      const loaded = nativeRequire(directory)("node-datachannel") as Partial<DataChannelModule> | undefined;
      if (typeof loaded?.PeerConnection === "function") return loaded as DataChannelModule;
    } catch { /* not staged there */ }
  }
  return null;
}

/** `MADANI_SCREEN_DIRECT_PORTS=50000-50100` keeps the peers' UDP ports in a range a firewall can open. */
export function directPortRange(value: string | undefined): { portRangeBegin: number; portRangeEnd: number } | undefined {
  const match = /^(\d{4,5})-(\d{4,5})$/.exec(value?.trim() ?? "");
  if (!match) return undefined;
  const [begin, end] = [Number(match[1]), Number(match[2])];
  return begin >= 1024 && end <= 65535 && begin <= end ? { portRangeBegin: begin, portRangeEnd: end } : undefined;
}

/** An offer the app's WebRTC stack made for one data channel: bounded, with a fingerprint, and no media. */
export function screenOffer(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const { type, sdp } = value as { type?: unknown; sdp?: unknown };
  if (type !== "offer" || typeof sdp !== "string" || sdp.length > SCREEN_SDP_MAX || !sdp.startsWith("v=0")) return null;
  if (!/^a=fingerprint:sha-256 [0-9A-F:]{95}\r?$/im.test(sdp) || !/^m=application /m.test(sdp) || /^m=(?:audio|video) /m.test(sdp)) return null;
  return sdp;
}

const candidateType = (value: string | undefined): ScreenCandidateType | null =>
  (SCREEN_CANDIDATE_TYPES as readonly string[]).includes(value ?? "") ? value as ScreenCandidateType : null;

export function createScreenDirect(options: {
  load?: () => DataChannelModule | null;
  iceServers?: readonly string[];
  maxPeers?: number;
  ports?: { portRangeBegin: number; portRangeEnd: number };
  gatherMs?: number;
  now?: () => Date;
  /** one line per screen: its path and winning candidate types, never an address */
  log?: (line: string) => void;
} = {}) {
  const load = options.load ?? (() => loadDataChannel());
  let module: DataChannelModule | null | undefined;
  const lib = () => (module === undefined ? (module = load()) : module);
  const peers = new Set<PeerConnection>();
  const stats: ScreenTransportStats = {
    since: (options.now?.() ?? new Date()).toISOString(),
    available: false,
    paths: { direct: 0, "cloudflare-turn": 0, "our-relay": 0 },
    pairs: {},
    direct: { sessions: 0, open: 0, failed: 0, bytesSent: 0, bytesReceived: 0, candidates: { host: 0, srflx: 0, prflx: 0, relay: 0 } },
    relay: { sessions: 0, open: 0, bytesSent: 0, bytesReceived: 0, reasons: Object.fromEntries([...SCREEN_FALLBACK_REASONS, "none"].map((reason) => [reason, 0])) as ScreenTransportStats["relay"]["reasons"] },
  };

  /**
   * Answers one offer. `onChannel` runs once, when the app's "screen" channel opens; any other channel is closed.
   * Throws DirectRefused when this server has no direct path, is full, or the offer is not one.
   */
  async function answer(offer: unknown, onChannel: (channel: ScreenChannel) => void, label: string = SCREEN_CHANNEL): Promise<DirectPeer> {
    const ndc = lib();
    if (!ndc) throw new DirectRefused(503, "direct path is off");
    if (peers.size >= (options.maxPeers ?? DEFAULT_MAX_PEERS)) throw new DirectRefused(503, "direct path is busy");
    const sdp = screenOffer(offer);
    if (!sdp) throw new DirectRefused(400, "not a screen offer");
    const pc = new ndc.PeerConnection("madani-screen", { iceServers: [...(options.iceServers ?? SCREEN_DIRECT_ICE_SERVERS)], ...options.ports, maxMessageSize: 256 * 1024 });
    peers.add(pc);
    let ended = false, opened = false, channel: DataChannel | undefined;
    const closers: Array<() => void> = [];
    const end = () => {
      if (ended) return;
      ended = true;
      clearTimeout(deadline);
      peers.delete(pc);
      if (opened) stats.direct.open--;
      else stats.direct.failed++;
      try { channel?.close(); } catch { /* closed */ }
      try { pc.close(); } catch { /* closed */ }
      for (const closed of closers.splice(0)) { try { closed(); } catch { /* the bridge's own */ } }
    };
    const deadline = setTimeout(end, OPEN_DEADLINE_MS);
    deadline.unref();
    pc.onStateChange((state) => { if (state === "failed" || state === "closed") end(); });
    pc.onDataChannel((dc) => {
      if (ended || channel || dc.getLabel() !== label) { dc.close(); return; }
      channel = dc;
      const open = () => {
        if (ended || opened) return;
        opened = true;
        clearTimeout(deadline);
        stats.direct.sessions++;
        stats.direct.open++;
        const pair = pc.getSelectedCandidatePair();
        const type = candidateType(pair?.local.type);
        const remote = candidateType(pair?.remote.type);
        if (type) stats.direct.candidates[type]++;
        const path: ScreenPath = remote === "relay" || type === "relay" ? "cloudflare-turn" : "direct";
        stats.paths[path]++;
        const key = `${type ?? "unknown"}/${remote ?? "unknown"}`;
        if (Object.keys(stats.pairs).length < 32 || key in stats.pairs) stats.pairs[key] = (stats.pairs[key] ?? 0) + 1;
        options.log?.(`screen: ${path} (${key})`);
        trail("screen.path", { path, pair: key });
        dc.setBufferedAmountLowThreshold(CHANNEL_LOW);
        const drains: Array<() => void> = [];
        dc.onBufferedAmountLow(() => { for (const drain of drains) drain(); });
        // what the app sends before the desktop is dialled waits here
        let early: Buffer[] | null = [];
        let deliver: ((bytes: Buffer) => void) | null = null;
        dc.onMessage((message) => {
          if (typeof message === "string") { end(); return; }
          const bytes = Buffer.isBuffer(message) ? message : Buffer.from(message);
          stats.direct.bytesReceived += bytes.length;
          if (deliver) deliver(bytes);
          else if (early && early.reduce((sum, one) => sum + one.length, bytes.length) <= 256 * 1024) early.push(bytes);
          else end();
        });
        onChannel({
          send: (bytes) => {
            if (ended || !dc.isOpen()) return false;
            // false from sendMessageBinary means queued behind earlier bytes, not lost; bufferedAmount paces the desktop
            for (let at = 0; at < bytes.length; at += SCREEN_DIRECT_MESSAGE) dc.sendMessageBinary(bytes.subarray(at, at + SCREEN_DIRECT_MESSAGE));
            stats.direct.bytesSent += bytes.length;
            return true;
          },
          sendMessage: (bytes) => {
            if (ended || !dc.isOpen() || bytes.length > SCREEN_DIRECT_MESSAGE * 4) return false;
            dc.sendMessageBinary(bytes);
            stats.direct.bytesSent += bytes.length;
            return true;
          },
          buffered: () => (ended ? 0 : dc.bufferedAmount()),
          onDrain: (callback) => { drains.push(callback); },
          onMessage: (callback) => {
            deliver = callback;
            for (const bytes of early ?? []) callback(bytes);
            early = null;
          },
          onClose: (callback) => { closers.push(callback); },
          close: end,
        });
      };
      dc.onClosed(end);
      dc.onError(end);
      if (dc.isOpen()) open(); else dc.onOpen(open);
    });
    try {
      pc.setRemoteDescription(sdp, "offer");
      await gathered(pc, options.gatherMs ?? SCREEN_DIRECT_GATHER_MS);
      const local = pc.localDescription();
      if (ended || !local || local.type !== "answer") throw new DirectRefused(503, "no answer");
      return { answer: { type: "answer", sdp: local.sdp }, close: end };
    } catch (error) {
      end();
      if (error instanceof DirectRefused) throw error;
      throw new DirectRefused(400, "not a screen offer");
    }
  }

  /** a relay screen counted by path and reason only: its bytes are not followed (the bot browser's stream) */
  const relayCounted = (reason: ScreenFallbackReason | null) => {
    stats.relay.sessions++;
    // a screen on a link that already goes direct is direct, though it came through the link agent
    const path: ScreenPath = reason === "link-direct" ? "direct" : "our-relay";
    stats.paths[path]++;
    stats.relay.reasons[reason ?? "none"]++;
    options.log?.(`screen: ${path} (${reason ?? "not asked"})`);
    trail("screen.path", { path, reason: reason ?? "not-asked" });
  };


  return {
    available: () => lib() !== null,
    answer,
    /** A relay screen opened; `reason` is why the app did not go direct, as it said. */
    relayOpened(reason: ScreenFallbackReason | null) {
      stats.relay.open++;
      relayCounted(reason);
    },
    relayCounted,
    relayClosed(bytesSent: number, bytesReceived: number) {
      stats.relay.open--;
      stats.relay.bytesSent += bytesSent;
      stats.relay.bytesReceived += bytesReceived;
      trail("screen.close", { path: "our-relay", bytesSent, bytesReceived });
    },
    /** Counters only: how screens connected and how many bytes each path carried. No ids, names or addresses. */
    stats(): ScreenTransportStats {
      return structuredClone({ ...stats, available: lib() !== null });
    },
    closeAll() {
      for (const pc of peers) { try { pc.close(); } catch { /* closed */ } }
      peers.clear();
    },
  };
}
export type ScreenDirect = ReturnType<typeof createScreenDirect>;

function gathered(pc: PeerConnection, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (pc.gatheringState() === "complete") { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    pc.onGatheringStateChange((state) => { if (state === "complete") { clearTimeout(timer); resolve(); } });
  });
}

/**
 * Joins the screen channel to the desktop's websockify connection: the desktop's WebSocket frames become plain RFB
 * bytes on the channel and the app's channel messages become masked frames to the desktop. When the server answered
 * the desktop's handshake itself, `opening` goes first and the app's own version, security choice and ClientInit are
 * dropped (`skip`), exactly as joinViewer does for a relay viewer.
 */
export function bridgeScreen(channel: ScreenChannel, upstream: Duplex, start: { head: Buffer; opening?: Buffer[]; payload?: Buffer; skip?: number; input?: (bytes: Buffer) => void }, onEnd: () => void): void {
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    upstream.destroy();
    channel.close();
    onEnd();
  };
  let raw = start.head;
  const parse = () => {
    try {
      for (let next; (next = readFrame(raw));) {
        raw = raw.subarray(next.size);
        const { frame } = next;
        if (frame.opcode === 8) { end(); return; }
        if (frame.opcode === 9) { upstream.write(writeFrame(frame.payload, true, 10)); continue; }
        if (frame.opcode >= 8) continue;
        if (frame.payload.length && !channel.send(frame.payload)) { end(); return; }
      }
    } catch { end(); return; }
    if (channel.buffered() > CHANNEL_HIGH) upstream.pause();
  };
  channel.onDrain(() => { if (!ended) upstream.resume(); });
  for (const message of start.opening ?? []) channel.send(message);
  if (start.payload?.length) channel.send(start.payload);
  let skip = start.skip ?? 0;
  channel.onMessage((bytes) => {
    if (ended) return;
    const dropped = Math.min(skip, bytes.length);
    skip -= dropped;
    if (bytes.length > dropped) { const rest = bytes.subarray(dropped); upstream.write(writeFrame(rest, true)); start.input?.(rest); }
  });
  channel.onClose(end);
  upstream.on("data", (chunk: Buffer) => { raw = raw.length ? Buffer.concat([raw, chunk]) : chunk; parse(); });
  upstream.once("error", end);
  upstream.once("close", end);
  upstream.resume();
  parse();
}
