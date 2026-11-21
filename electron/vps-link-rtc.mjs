// the direct path over webrtc: the same sealed byte stream as ssh, 443 and the cloud relay (vps-link-direct.mjs), on one
// reliable, ordered data channel to the server's link agent. the offer and answer go as one sealed control op
// ("direct-rtc") over the tunnel that is already up, so the dtls fingerprints in them come from the two ends that hold the
// tunnel key; the agent then reads only frames sealed with that key, as on every other path. stun (and cloudflare's turn
// when the signed-in account has it) find the way; no port is opened anywhere.
import { createRequire } from "node:module";
import { join } from "node:path";
import { Duplex } from "node:stream";

// ---- shared with apps/link-service/agent.mjs (keep both in step; a test checks they interoperate) ----
export const RTC_LABEL = "madani-link";
/** a stream write goes out in messages this size: every webrtc stack takes 64 KB */
export const RTC_PIECE = 64 * 1024;
const RTC_HIGH = 4 * 1024 * 1024;
const RTC_LOW = 1024 * 1024;

/** a node-datachannel data channel as a byte stream; writes wait while more than RTC_HIGH is queued */
export function channelDuplex(dc) {
  let waiting = null;
  const duplex = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      try {
        for (let at = 0; at < chunk.length; at += RTC_PIECE) dc.sendMessageBinary(chunk.subarray(at, at + RTC_PIECE));
      } catch (error) { callback(error); return; }
      if (dc.bufferedAmount() > RTC_HIGH) waiting = callback;
      else callback();
    },
    destroy(error, callback) {
      try { dc.close(); } catch { /* closed */ }
      callback(error);
    },
  });
  dc.setBufferedAmountLowThreshold(RTC_LOW);
  dc.onBufferedAmountLow(() => { const go = waiting; waiting = null; go?.(); });
  dc.onMessage((message) => {
    if (typeof message === "string") { duplex.destroy(new Error("text on a byte channel")); return; }
    duplex.push(Buffer.isBuffer(message) ? message : Buffer.from(message));
  });
  dc.onClosed(() => { duplex.push(null); duplex.destroy(); });
  dc.onError((error) => duplex.destroy(new Error(String(error))));
  return duplex;
}
// ---- end of the shared part ----

export const RTC_STUN = ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"];

/** WebRTC's { urls, username, credential } as node-datachannel takes them; turns: only on 443 or 5349 with tls */
export function iceServers(list) {
  const out = [];
  for (const server of Array.isArray(list) ? list : []) {
    for (const url of Array.isArray(server?.urls) ? server.urls : [server?.urls]) {
      const match = /^(stun|turns?):([a-z0-9.-]+)(?::(\d{1,5}))?(?:\?transport=(udp|tcp))?$/i.exec(typeof url === "string" ? url : "");
      if (!match) continue;
      const [, scheme, hostname, port, transport] = match;
      if (scheme.toLowerCase() === "stun") { out.push(`stun:${hostname}:${port ?? 3478}`); continue; }
      if (typeof server.username !== "string" || typeof server.credential !== "string") continue;
      const tls = scheme.toLowerCase() === "turns";
      out.push({ hostname, port: Number(port ?? (tls ? 5349 : 3478)), username: server.username, password: server.credential,
        relayType: tls ? "TurnTls" : transport?.toLowerCase() === "tcp" ? "TurnTcp" : "TurnUdp" });
    }
  }
  return out;
}

/** node-datachannel from the app's native tree (resources/duckdb/node_modules) or beside this file; null when missing */
export function loadDataChannel(dirs = [process.env.MADANI_DUCKDB_DIR, process.resourcesPath && join(process.resourcesPath, "duckdb")].filter(Boolean)) {
  if (process.env.MADANI_LINK_RTC === "off") return null;
  for (const anchor of [...dirs.map((dir) => join(dir, "node_modules", "anchor.js")), import.meta.url]) {
    try {
      const loaded = createRequire(anchor)("node-datachannel");
      if (typeof loaded?.PeerConnection === "function") return loaded;
    } catch { /* not there */ }
  }
  return null;
}

function gathered(pc, ms) {
  return new Promise((resolve) => {
    if (pc.gatheringState() === "complete") { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    pc.onGatheringStateChange((state) => { if (state === "complete") { clearTimeout(timer); resolve(); } });
  });
}

/**
 * the webrtc way to the server, as a connector for orderedConnect: `signal` sends the offer over the sealed tunnel and
 * resolves the agent's answer; `turn` adds the signed-in account's turn servers (or none)
 */
export function rtcConnector({ ndc, signal, turn = async () => [], stun = RTC_STUN, gatherMs = 1500, timeoutMs = 8000, now = Date.now }) {
  return async () => {
    const started = now();
    const relays = await Promise.race([turn().catch(() => []), new Promise((resolve) => setTimeout(() => resolve([]), 1500))]);
    const pc = new ndc.PeerConnection("madani-link", { iceServers: [...iceServers(stun.map((urls) => ({ urls }))), ...iceServers(relays)], maxMessageSize: 256 * 1024 });
    const fail = (error) => { try { pc.close(); } catch { /* closed */ } throw error; };
    let dc;
    try {
      dc = pc.createDataChannel(RTC_LABEL);
      await gathered(pc, gatherMs);
      const offer = pc.localDescription();
      if (!offer) fail(new Error("no offer"));
      const answer = await signal({ type: "offer", sdp: offer.sdp });
      if (answer?.type !== "answer" || typeof answer.sdp !== "string") fail(new Error("the server sent no answer"));
      pc.setRemoteDescription(answer.sdp, "answer");
    } catch (error) { fail(error); }
    const opened = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), Math.max(1000, timeoutMs - (now() - started)));
      if (dc.isOpen()) { clearTimeout(timer); resolve(true); return; }
      dc.onOpen(() => { clearTimeout(timer); resolve(true); });
      pc.onStateChange((state) => { if (state === "failed" || state === "closed") { clearTimeout(timer); resolve(false); } });
    });
    if (!opened) fail(Object.assign(new Error("webrtc did not connect"), { code: "RTC_TIMEOUT" }));
    const pair = pc.getSelectedCandidatePair();
    const duplex = channelDuplex(dc);
    duplex.once("close", () => { try { pc.close(); } catch { /* closed */ } });
    const relayed = pair?.local?.type === "relay" || pair?.remote?.type === "relay";
    return { readable: duplex, writable: duplex, close: () => duplex.destroy(), path: relayed ? "turn" : "direct", pair: `${pair?.local?.type ?? "?"}/${pair?.remote?.type ?? "?"}` };
  };
}
