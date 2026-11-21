// the phone's direct path over webrtc: one reliable, ordered data channel from the webview's own RTCPeerConnection to the
// server's link agent, carrying the same sealed byte stream as the desktop's direct paths (direct-records.ts). the offer
// and answer travel as one sealed control op ("direct-rtc") over the phone's relay channel, so the dtls fingerprints in
// them come from the two ends that hold the channel key; the agent then reads only frames sealed with that key. stun
// finds the way, plus cloudflare's turn when the phone is signed in to its madani account. no port is opened anywhere.

/** shared with electron/vps-link-rtc.mjs and apps/link-service/agent.mjs */
export const RTC_LABEL = "madani-link";
/** a write goes out in messages this size: every webrtc stack takes 64 KB */
export const RTC_PIECE = 64 * 1024;
export const RTC_STUN = ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"];
const RTC_HIGH = 4 * 1024 * 1024;
const RTC_LOW = 1024 * 1024;

export type IceServer = { urls: string | string[]; username?: string; credential?: string };
export type RtcOffer = { type: "offer"; sdp: string };
type PeerClass = typeof RTCPeerConnection;

/** one open data channel as the direct link uses it */
export interface DirectConn {
  /** a whole record (or several): its messages go out back to back, so records never interleave */
  send(bytes: Uint8Array<ArrayBuffer>): void;
  /** resolves once the channel has room again (its queue under RTC_HIGH) */
  room(): Promise<void>;
  onData(listener: (bytes: Uint8Array) => void): void;
  onClose(listener: (reason: string) => void): void;
  close(): void;
  /** "direct" or "turn": how the selected pair got there, when the webview says */
  path: string;
}

/** the webview's RTCPeerConnection, or null where it has none (an old WKWebView): the phone stays on the relay */
export function peerClass(scope: { RTCPeerConnection?: PeerClass } = globalThis as { RTCPeerConnection?: PeerClass }): PeerClass | null {
  return typeof scope.RTCPeerConnection === "function" ? scope.RTCPeerConnection : null;
}

let turnSource: (() => Promise<IceServer[]>) | null = null;
/** the signed-in account's turn servers (account-client screenIce); null when signed out: stun only */
export function setTurnSource(source: (() => Promise<IceServer[]>) | null): void { turnSource = source; }
const accountTurn = () => turnSource?.() ?? Promise.resolve([]);

const TURN_URL = /^(?:stun|turns?):[a-z0-9.-]+(?::\d{1,5})?(?:\?transport=(?:udp|tcp))?$/i;
/** the account service's list, kept to well-formed entries (a turn url without its credential is dropped) */
export function cleanIce(list: unknown): IceServer[] {
  const out: IceServer[] = [];
  for (const entry of Array.isArray(list) ? list.slice(0, 8) : []) {
    const value = entry as { urls?: unknown; username?: unknown; credential?: unknown } | null;
    const urls = (Array.isArray(value?.urls) ? value.urls : [value?.urls]).filter((url): url is string => typeof url === "string" && TURN_URL.test(url));
    if (!urls.length) continue;
    const turn = urls.some((url) => /^turns?:/i.test(url));
    if (turn && (typeof value?.username !== "string" || typeof value?.credential !== "string")) continue;
    out.push(turn ? { urls, username: value!.username as string, credential: value!.credential as string } : { urls });
  }
  return out;
}

function wait<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(fallback); });
  });
}

/** the data channel as a DirectConn; what arrives before anyone listens (the agent's hello) waits for the first listener */
export function channelConn(dc: RTCDataChannel, pc: RTCPeerConnection, path = "direct"): DirectConn {
  const data = new Set<(bytes: Uint8Array) => void>();
  const early: Uint8Array[] = [];
  const closes = new Set<(reason: string) => void>();
  let ended = false;
  const end = (reason: string) => {
    if (ended) return;
    ended = true;
    for (const listener of closes) listener(reason);
    try { dc.close(); } catch { /* closed */ }
    try { pc.close(); } catch { /* closed */ }
  };
  const rooms = new Set<() => void>();
  dc.binaryType = "arraybuffer";
  dc.bufferedAmountLowThreshold = RTC_LOW;
  dc.addEventListener("bufferedamountlow", () => { const waiting = [...rooms]; rooms.clear(); for (const go of waiting) go(); });
  dc.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data === "string") { end("text on a byte channel"); return; }
    const bytes = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
    if (!data.size) { early.push(bytes); return; }
    for (const listener of data) listener(bytes);
  });
  dc.addEventListener("close", () => end("closed"));
  dc.addEventListener("error", () => end("channel error"));
  pc.addEventListener("connectionstatechange", () => { if (["failed", "closed"].includes(pc.connectionState)) end(pc.connectionState); });
  return {
    path,
    send(bytes) {
      if (ended) return;
      try {
        for (let at = 0; at < bytes.length; at += RTC_PIECE) dc.send(bytes.subarray(at, at + RTC_PIECE));
      } catch { end("send failed"); }
    },
    room() {
      if (ended || dc.bufferedAmount <= RTC_HIGH) return Promise.resolve();
      return new Promise((resolve) => { rooms.add(resolve); closes.add(() => resolve()); });
    },
    onData(listener) { data.add(listener); for (const bytes of early.splice(0)) listener(bytes); },
    onClose(listener) { closes.add(listener); },
    close() { end("closed here"); },
  };
}

async function selectedPath(pc: RTCPeerConnection): Promise<string> {
  try {
    const stats = await wait(pc.getStats(), 1000, null);
    if (!stats) return "direct";
    const all = [...stats.values()] as Array<Record<string, unknown>>;
    const transport = all.find((entry) => entry.type === "transport" && entry.selectedCandidatePairId);
    const pair = all.find((entry) => entry.type === "candidate-pair" && (entry.id === transport?.selectedCandidatePairId || (!transport && entry.nominated && entry.state === "succeeded")));
    const types = [pair?.localCandidateId, pair?.remoteCandidateId].map((id) => all.find((entry) => entry.id === id)?.candidateType);
    return types.includes("relay") ? "turn" : "direct";
  } catch { return "direct"; }
}

/**
 * the webrtc way to the server: `signal` sends the offer over the sealed relay channel and resolves the agent's answer;
 * `turn` adds the signed-in account's turn servers (or none)
 */
export function rtcConnector({ Peer, signal, turn = accountTurn, stun = RTC_STUN, gatherMs = 1500, timeoutMs = 10_000 }: {
  Peer: PeerClass; signal(offer: RtcOffer): Promise<unknown>; turn?: () => Promise<IceServer[]>; stun?: string[]; gatherMs?: number; timeoutMs?: number;
}): () => Promise<DirectConn> {
  return async () => {
    const started = Date.now();
    const relays = await wait(turn(), 1500, [] as IceServer[]);
    const pc = new Peer({ iceServers: [...(stun.length ? [{ urls: stun }] : []), ...relays] });
    const fail = (error: Error): never => { try { pc.close(); } catch { /* closed */ } throw error; };
    let dc: RTCDataChannel, conn: DirectConn;
    try {
      dc = pc.createDataChannel(RTC_LABEL);
      conn = channelConn(dc, pc);
      await pc.setLocalDescription(await pc.createOffer());
      // the agent takes one offer with every candidate in it (no trickle): what gathers within gatherMs goes
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === "complete") { resolve(); return; }
        const timer = setTimeout(resolve, gatherMs);
        pc.addEventListener("icegatheringstatechange", () => { if (pc.iceGatheringState === "complete") { clearTimeout(timer); resolve(); } });
      });
      const offer = pc.localDescription;
      if (!offer?.sdp) return fail(new Error("no offer"));
      const answer = await signal({ type: "offer", sdp: offer.sdp }) as { type?: unknown; sdp?: unknown } | null;
      if (answer?.type !== "answer" || typeof answer.sdp !== "string") return fail(new Error("the server sent no answer"));
      await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    } catch (error) { return fail(error instanceof Error ? error : new Error(String(error))); }
    const opened = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), Math.max(1000, timeoutMs - (Date.now() - started)));
      if (dc.readyState === "open") { clearTimeout(timer); resolve(true); return; }
      dc.addEventListener("open", () => { clearTimeout(timer); resolve(true); });
      pc.addEventListener("connectionstatechange", () => { if (["failed", "closed"].includes(pc.connectionState)) { clearTimeout(timer); resolve(false); } });
    });
    if (!opened) return fail(new Error("webrtc did not connect"));
    conn.path = await selectedPath(pc);
    return conn;
  };
}
