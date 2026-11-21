// the direct path to a linked vps: one ssh connection to the server's own sshd on port 22, which every vps already
// answers, so no port is opened and no setting is changed. the app's key there is restricted to one forced command,
// `agent.mjs direct`, which speaks the relay's sealed frames on its stdin/stdout: the end-to-end sealing, the replay guard
// and the server identity stay exactly as they are on the relay, and sshd's host key is pinned on top. stun hole punching
// (webrtc) was measured first and fails against a vps whose firewall drops unsolicited udp when the app sits behind a
// symmetric nat (most vpns), while tcp 22 is open on every vps; see apps/link-service/README.md "Direct path".
// where a network blocks port 22 (Jio, often), the same byte stream rides a websocket to the server's own https on 443,
// with its tls key pinned the same way (wssConnector). ssh is tried first, then 443, and the relay stays underneath.
import { X509Certificate, createHash, createHmac, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { connect as netConnect, isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { Duplex } from "node:stream";
import { checkServerIdentity, connect as tlsConnect } from "node:tls";

import { connectedSocket, openFrame, sealBytes, sealFrame, throughProxy } from "./vps-link-protocol.mjs";
import { clampMss } from "./tcp-clamp.mjs";
import { shortHash, trail } from "./trail.mjs";

// ---- direct transport shared with apps/link-service/agent.mjs (keep both in step; a test checks they interoperate) ----
/** each end writes this first; a login shell's greeting before it is skipped */
export const DIRECT_MAGIC = Buffer.from("\0OMBD1\n", "latin1");
export const REC_SEALED = 1;
export const REC_ACK = 2;
/** a stream's bytes go out in pieces this size, taking turns with the other streams */
const DIRECT_PIECE = 16 * 1024;
/**
 * stream bytes sent and not yet acknowledged: what the path delivers in its round trip plus DIRECT_QUEUE_MS, measured
 * from the acks, so a transfer fills the path and an api frame still waits at most about that long behind it
 */
export const DIRECT_INFLIGHT = 384 * 1024;
const DIRECT_INFLIGHT_MIN = 384 * 1024;
const DIRECT_INFLIGHT_MAX = 8 * 1024 * 1024;
const DIRECT_QUEUE_MS = 250;
const DIRECT_ACK_EVERY = 32 * 1024;
const DIRECT_MAX_RECORD = 1024 * 1024;
const DIRECT_HIGH = 2 * 1024 * 1024;
const DIRECT_LOW = 512 * 1024;
/**
 * a lane's streams (egress: a bot's tls handshakes and pages) have their own allowance of unacknowledged bytes and go
 * first in each round, so a full desktop window never holds a page's first bytes back for an ack
 */
const DIRECT_LANE_INFLIGHT = 256 * 1024;

export function directRecord(type, payload) {
  const head = Buffer.allocUnsafe(5);
  head.writeUInt32BE(payload.length + 1, 0);
  head[4] = type;
  return Buffer.concat([head, payload]);
}

/** records out of a byte stream: [u32 length][type][payload]. throws on anything malformed */
export function directReader(onRecord) {
  let buf = Buffer.alloc(0), synced = false;
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    if (!synced) {
      const at = buf.indexOf(DIRECT_MAGIC);
      if (at < 0) {
        if (buf.length > 64 * 1024) throw new Error("no direct link here");
        return;
      }
      buf = buf.subarray(at + DIRECT_MAGIC.length);
      synced = true;
    }
    while (buf.length >= 5) {
      const length = buf.readUInt32BE(0);
      if (length < 1 || length > DIRECT_MAX_RECORD) throw new Error("malformed record");
      if (buf.length < 4 + length) break;
      const type = buf[4], payload = buf.subarray(5, 4 + length);
      buf = buf.subarray(4 + length);
      onRecord(type, payload);
    }
  };
}

/**
 * the sending half of a direct link. a frame for a stream with bytes still queued waits behind them (its order is kept);
 * every other frame goes first. queued bytes take turns, a piece per stream, with at most DIRECT_INFLIGHT unacknowledged,
 * so a busy desktop or a download never holds an api call back for long. `bytes(r, chunk, true)` puts a stream in the
 * lane (DIRECT_LANE_INFLIGHT).
 */
export function createDirectWriter({ sealFrame: sealOne, sealBytes: sealPiece, write, inflight: fixed = null, now = () => performance.now() }) {
  const urgent = [];
  // the path, from the acks: the smallest round trip lately and the best delivery rate lately
  const sent = [];
  let sentTotal = 0, ackedTotal = 0, minRtt = null, minAt = 0, rateFrom = null, rates = [];
  let inflight = fixed ?? DIRECT_INFLIGHT;
  function learn(count) {
    const t = now();
    ackedTotal += count;
    let at = null;
    while (sent.length && sent[0].end <= ackedTotal) at = sent.shift().at;
    if (at !== null) {
      const sample = t - at;
      if (minRtt === null || sample <= minRtt || t - minAt > 10_000) { minRtt = sample; minAt = t; }
    }
    if (rateFrom === null) rateFrom = { t, bytes: ackedTotal - count };
    // acks arrive in bunches: rates over a couple of round trips, averaged, and the window grows by half at most per step
    if (minRtt !== null && t - rateFrom.t >= Math.max(2 * minRtt, 300)) {
      rates = [...rates.slice(-3), ((ackedTotal - rateFrom.bytes) * 1000) / (t - rateFrom.t)];
      rateFrom = { t, bytes: ackedTotal };
      const rate = rates.reduce((sum, one) => sum + one, 0) / rates.length;
      if (fixed === null) inflight = Math.min(DIRECT_INFLIGHT_MAX, inflight * 1.5, Math.max(DIRECT_INFLIGHT_MIN, (rate * (minRtt + DIRECT_QUEUE_MS)) / 1000));
    }
  }
  const streams = new Map();
  const drains = new Set();
  // what is unacknowledged, oldest first, by lane: the other end acks bytes in the order they left
  const flight = [];
  let queued = 0, unacked = 0, laneUnacked = 0, received = 0, blocked = false, closed = false, scheduled = false;
  const release = () => { const waiting = [...drains]; drains.clear(); for (const resume of waiting) resume(); };
  function piece(r, items) {
    const item = items[0];
    let need = Math.min(DIRECT_PIECE, item.size);
    const pieces = [];
    while (need > 0) {
      const part = item.parts[0];
      if (part.length <= need) { pieces.push(part); item.parts.shift(); need -= part.length; }
      else { pieces.push(part.subarray(0, need)); item.parts[0] = part.subarray(need); need = 0; }
    }
    const one = pieces.length === 1 ? pieces[0] : Buffer.concat(pieces);
    item.size -= one.length;
    queued -= one.length;
    if (items.lane) laneUnacked += one.length; else unacked += one.length;
    const last = flight[flight.length - 1];
    if (last && last.lane === Boolean(items.lane)) last.size += one.length; else flight.push({ lane: Boolean(items.lane), size: one.length });
    sentTotal += one.length;
    sent.push({ end: sentTotal, at: now() });
    if (sent.length > 4096) sent.shift();
    if (!item.size) items.shift();
    streams.delete(r);
    if (items.length) streams.set(r, items);
    return directRecord(REC_SEALED, sealPiece(r, one));
  }
  function next() {
    if (urgent.length) return urgent.shift();
    for (const lane of [true, false]) {
      for (const [r, items] of streams) {
        if (Boolean(items.lane) !== lane) continue;
        const item = items[0];
        if (!item.record) {
          if (lane ? laneUnacked >= DIRECT_LANE_INFLIGHT : unacked >= inflight) continue;
          return piece(r, items);
        }
        // a frame that waited behind its stream's bytes; the stream goes to the back of the line
        items.shift();
        streams.delete(r);
        if (items.length) streams.set(r, items);
        return item.record;
      }
    }
    return null;
  }
  /**
   * what is ready goes out as one write, a turn after the first of it: sshd does not set nodelay for a session without a
   * pty, so a reply's head, bytes and end written apart would each wait for an ack (a round trip, or a delayed ack)
   */
  function pump() {
    scheduled = false;
    const out = [];
    let size = 0;
    while (!blocked && !closed) {
      const record = next();
      if (!record) break;
      out.push(record);
      size += record.length;
      if (size >= 256 * 1024) { if (write(out.length === 1 ? out[0] : Buffer.concat(out)) === false) blocked = true; out.length = 0; size = 0; }
    }
    if (out.length && !closed && write(out.length === 1 ? out[0] : Buffer.concat(out)) === false) blocked = true;
    if (drains.size && queued < DIRECT_LOW) release();
  }
  const kick = () => { if (!scheduled && !closed) { scheduled = true; setImmediate(pump); } };
  return {
    push(frame) {
      if (closed) return;
      const record = directRecord(REC_SEALED, sealOne(frame));
      const items = frame.r ? streams.get(frame.r) : undefined;
      if (items) items.push({ record }); else urgent.push(record);
      kick();
    },
    /** false: stop reading this stream until `onDrain` calls back */
    bytes(r, chunk, lane = false) {
      if (closed) return true;
      let items = streams.get(r);
      if (!items) { streams.set(r, (items = [])); items.lane = lane; }
      const last = items[items.length - 1];
      if (last && !last.record) { last.parts.push(chunk); last.size += chunk.length; }
      else items.push({ parts: [chunk], size: chunk.length });
      queued += chunk.length;
      kick();
      return queued < DIRECT_HIGH;
    },
    onDrain(resume) { if (closed || queued < DIRECT_LOW) resume(); else drains.add(resume); },
    discard(r) {
      const items = streams.get(r);
      if (!items) return;
      for (const item of items) if (!item.record) queued -= item.size;
      streams.delete(r);
      if (queued < DIRECT_LOW) release();
    },
    /** the other end got this many stream bytes */
    acked(count) {
      for (let left = count; left > 0 && flight.length;) {
        const head = flight[0], used = Math.min(left, head.size);
        head.size -= used;
        left -= used;
        if (head.lane) laneUnacked -= used; else unacked -= used;
        if (!head.size) flight.shift();
      }
      learn(count);
      kick();
    },
    /** stream bytes that arrived here: acknowledged every so often, ahead of everything else */
    received(count) {
      received += count;
      if (received < DIRECT_ACK_EVERY || closed) return;
      const payload = Buffer.alloc(4);
      payload.writeUInt32BE(received, 0);
      received = 0;
      urgent.unshift(directRecord(REC_ACK, payload));
      kick();
    },
    drained() { blocked = false; kick(); },
    close() { closed = true; urgent.length = 0; streams.clear(); queued = 0; release(); },
    get size() { return queued; },
    get unacked() { return unacked + laneUnacked; },
    get inflight() { return inflight; },
  };
}

/** the direct path over https: one websocket (rfc 6455) of binary messages that carry the same byte stream as ssh */
export const WS_PATH = "/omb-direct";
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const WS_MAX_FRAME = 4 * 1024 * 1024;
export const wsAccept = (key) => createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");

/** one websocket frame; the client masks what it sends (the rfc requires it), the server never does */
export function wsFrame(opcode, payload, masked) {
  const length = payload.length;
  const extra = length < 126 ? 0 : length < 65536 ? 2 : 8;
  const head = Buffer.alloc(2 + extra + (masked ? 4 : 0));
  head[0] = 0x80 | opcode;
  head[1] = (masked ? 0x80 : 0) | (extra === 0 ? length : extra === 2 ? 126 : 127);
  if (extra === 2) head.writeUInt16BE(length, 2);
  else if (extra === 8) head.writeBigUInt64BE(BigInt(length), 2);
  if (!masked) return Buffer.concat([head, payload]);
  const mask = randomBytes(4);
  mask.copy(head, 2 + extra);
  const body = Buffer.allocUnsafe(length);
  for (let at = 0; at < length; at += 1) body[at] = payload[at] ^ mask[at & 3];
  return Buffer.concat([head, body]);
}

/** frames out of a byte stream: data to `onData`, pings answered by the caller, a close ends it. text only with `onText`; throws on anything else */
export function wsReader({ masked, onData, onPing = () => {}, onClose = () => {}, onText = null }) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f, hasMask = (buf[1] & 0x80) !== 0;
      if (hasMask !== masked) throw new Error("websocket masking is wrong");
      let length = buf[1] & 0x7f, at = 2;
      if (length === 126) { if (buf.length < 4) return; length = buf.readUInt16BE(2); at = 4; }
      else if (length === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(WS_MAX_FRAME)) throw new Error("websocket frame too large");
        length = Number(big);
        at = 10;
      }
      if (length > WS_MAX_FRAME) throw new Error("websocket frame too large");
      const start = at + (hasMask ? 4 : 0), end = start + length;
      if (buf.length < end) return;
      let payload = buf.subarray(start, end);
      if (hasMask) {
        const mask = buf.subarray(at, start), open = Buffer.allocUnsafe(length);
        for (let i = 0; i < length; i += 1) open[i] = payload[i] ^ mask[i & 3];
        payload = open;
      }
      buf = buf.subarray(end);
      if (opcode === 0 || opcode === 2) { if (payload.length) onData(payload); }
      else if (opcode === 8) { onClose(); return; }
      else if (opcode === 9) onPing(payload);
      else if (opcode === 1 && onText) onText(payload.toString("utf8"));
      else if (opcode !== 10) throw new Error("not a binary websocket");
    }
  };
}

/**
 * a websocket over `socket` as a plain duplex byte stream; `head` is what arrived after the handshake. `heartbeatMs`
 * sends the text "ping" that often (the cloud relay answers "pong" without waking) and ends a socket silent for 3 beats
 */
export function wsDuplex(socket, { client, head = null, onText = null, heartbeatMs = 0 }) {
  let ended = false, heardAt = Date.now();
  const duplex = new Duplex({
    writableHighWaterMark: 1024 * 1024,
    write(chunk, _encoding, callback) { if (socket.destroyed) callback(new Error("closed")); else socket.write(wsFrame(2, chunk, client), callback); },
    final(callback) { if (!socket.destroyed) socket.end(wsFrame(8, Buffer.alloc(0), client)); callback(); },
    read() { socket.resume(); },
    destroy(error, callback) { socket.destroy(); callback(error); },
  });
  const finish = () => { if (!ended) { ended = true; duplex.push(null); } };
  const read = wsReader({
    masked: !client,
    onData: (data) => { if (!ended && !duplex.push(data)) socket.pause(); },
    onPing: (data) => { if (!socket.destroyed) socket.write(wsFrame(10, data, client)); },
    onClose: () => { finish(); socket.end(); },
    onText: onText ?? (heartbeatMs ? () => {} : null),
  });
  const take = (chunk) => { heardAt = Date.now(); try { read(chunk); } catch (error) { duplex.destroy(error); } };
  const beat = heartbeatMs ? setInterval(() => {
    if (Date.now() - heardAt > heartbeatMs * 3) { socket.destroy(); return; }
    if (!socket.destroyed) socket.write(wsFrame(1, Buffer.from("ping"), client));
  }, heartbeatMs) : null;
  beat?.unref?.();
  socket.on("data", take);
  socket.once("end", finish);
  socket.once("close", () => { clearInterval(beat); finish(); duplex.destroy(); });
  socket.on("error", (error) => duplex.destroy(error));
  if (head?.length) take(head);
  return duplex;
}
// ---- end direct transport ----


/** a port an isp blocks is tried less and less often, down to every two minutes (the relay carries the window meanwhile, so it is not left there long) */
export const BACKOFF_MS = [1000, 5000, 15_000, 30_000, 60_000, 2 * 60_000];
/** up over a lesser way, the better ones are tried again after these (the last repeats) */
export const UPGRADE_MS = [20_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000];
/** a link that lasted this long was really up: its loss starts the backoff over */
const STABLE_MS = 60_000;

/**
 * where this computer is on the network: its ipv4 addresses and its ipv6 /64 prefixes (privacy addresses rotate inside
 * the prefix every few hours, which is not a new network)
 */
export function networkFingerprint(interfaces = networkInterfaces()) {
  const seen = new Set();
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (entry.family === "IPv4" || entry.family === 4) seen.add(`${name} ${entry.address}`);
      else if (!/^fe80:/i.test(entry.address)) seen.add(`${name} ${entry.address.split(":").slice(0, 4).join(":")}`);
    }
  }
  return [...seen].sort().join(",");
}

/**
 * one direct link, kept up in the background: dial, wait for the agent's sealed hello, ping for liveness and rtt, redial
 * with backoff. `connect()` gives { readable, writable, close }. while it is not up, the caller uses the relay.
 */
export function createDirectLink({ id, key: keyText, guard, connect, onFrame, onChange = () => {}, onFailure = () => {}, log = () => {}, pingMs = 5000, helloMs = 20_000, connectMs = 30_000, backoff = BACKOFF_MS, network = networkFingerprint, watchMs = 15_000, hello = {}, better = null, idle = () => true, upgradeMs = UPGRADE_MS }) {
  const key = Buffer.from(keyText, "base64url");
  let state = "idle", conn = null, writer = null, closed = false, attempt = 0, retryTimer = null, watchTimer = null, pingTimer = null, helloTimer = null;
  let rtt = null, everUp = false, pingSeq = 0, suspect = false, heardAt = 0, upAt = 0, failing = false, failedOn = null, via = null, peer = null;
  const outstanding = new Map();
  const waiters = new Set();
  const set = (next, extra = {}) => { state = next; for (const wake of Array.from(waiters)) wake(); onChange({ state, ...extra }); };
  const ready = () => state === "up" && !suspect;
  const here = () => { try { return network(); } catch { return null; } };
  /** a new network is a new chance: the backoff starts over and the next dial goes now */
  const moved = () => failedOn !== null && here() !== failedOn;

  function retry() {
    if (closed) return;
    clearTimeout(retryTimer);
    clearInterval(watchTimer);
    const ms = backoff[Math.min(attempt, backoff.length - 1)];
    attempt += 1;
    set("waiting");
    retryTimer = setTimeout(() => void dial(), ms);
    retryTimer.unref?.();
    if (ms > watchMs) {
      watchTimer = setInterval(() => { if (state === "waiting" && moved()) { attempt = 0; void dial(); } }, watchMs);
      watchTimer.unref?.();
    }
  }

  function failed() {
    failing = true;
    failedOn = here();
    retry();
  }

  function drop(reason) {
    if (!conn) return;
    const was = state;
    const gone = conn;
    conn = null;
    clearInterval(pingTimer);
    clearTimeout(helloTimer);
    outstanding.clear();
    writer?.close();
    writer = null;
    suspect = false;
    try { gone.close(); } catch { /* already closed */ }
    log(`vps link: direct path ${was === "up" ? "lost" : "failed"} (${reason})`);
    trail(was === "up" ? "link.direct.lost" : "link.direct.failed", { link: shortHash(id), via, reason, ...(was === "up" ? { upMs: Math.round(performance.now() - upAt) } : {}) });
    set("down", { lost: was === "up" });
    if (was !== "up") { failed(); return; }
    if (performance.now() - upAt >= STABLE_MS) attempt = 0;
    retry();
  }

  function ping(deadlineMs) {
    if (!writer) return;
    const n = (pingSeq += 1);
    outstanding.set(n, performance.now());
    writer.push({ t: "ping", n });
    const limit = deadlineMs ?? Math.max(4000, (rtt ?? 1000) * 4);
    // a busy link answers late but keeps delivering: only silence means it is gone
    const check = () => {
      if (!outstanding.has(n) || !conn) return;
      if (performance.now() - heardAt >= limit) drop("no answer");
      else setTimeout(check, limit / 2).unref?.();
    };
    setTimeout(check, limit).unref?.();
  }

  /**
   * up over a lesser way (the cloudflare tunnel, a relay): the better ones are tried again now and then, and taken when
   * one connects while nothing rides this link, so a stream is never cut for it
   */
  let upgradeTimer = null, upgradeStep = 0;
  function planUpgrade() {
    clearTimeout(upgradeTimer);
    if (!better || closed || !conn) return;
    upgradeTimer = setTimeout(async () => {
      if (closed || !conn || state !== "up") return;
      if (!idle()) { planUpgrade(); return; }
      const from = via;
      const next = await better(from).catch(() => null);
      if (!next) { upgradeStep += 1; planUpgrade(); return; }
      if (closed || !conn || via !== from || state !== "up" || !idle()) { next.close?.(); planUpgrade(); return; }
      log(`vps link: the direct path moves up from ${from} to ${next.via}`);
      const old = conn;
      conn = null;
      clearInterval(pingTimer);
      clearTimeout(helloTimer);
      outstanding.clear();
      writer?.close();
      writer = null;
      try { old.close(); } catch { /* already closed */ }
      upgradeStep = 0;
      set("connecting");
      adopt(next);
    }, upgradeMs[Math.min(upgradeStep, upgradeMs.length - 1)]);
    upgradeTimer.unref?.();
  }

  async function dial() {
    if (closed || conn || state === "connecting") return;
    clearTimeout(retryTimer);
    clearInterval(watchTimer);
    set("connecting");
    let link, deadline = null;
    // a connector that never settles must not keep the link "connecting" for good
    const dialing = (async () => connect())();
    try { link = await Promise.race([dialing, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("no answer in time")), connectMs); deadline.unref?.(); })]); }
    catch (error) {
      void dialing.then((late) => late?.close?.(), () => {});
      if (closed) return;
      log(`vps link: direct path did not connect (${error?.message ?? error})`);
      onFailure(error);
      failed();
      return;
    } finally { clearTimeout(deadline); }
    if (closed) { link.close(); return; }
    adopt(link);
  }

  function adopt(link) {
    conn = link;
    via = link.via ?? "ssh";
    const mine = link;
    writer = createDirectWriter({
      sealFrame: (frame) => sealFrame(key, id, "to-vps", frame, true),
      sealBytes: (r, bytes) => sealBytes(key, id, "to-vps", r, bytes, true),
      write: (record) => conn === mine && link.writable.write(record),
    });
    const read = directReader((type, payload) => {
      if (conn !== mine) return;
      heardAt = performance.now();
      if (type === REC_ACK && payload.length === 4) { writer.acked(payload.readUInt32BE(0)); return; }
      if (type !== REC_SEALED) return;
      let frame = null;
      try { frame = openFrame(key, id, "to-app", payload, guard); } catch { log("vps link: dropped a direct frame that did not open"); }
      if (!frame) return;
      if (frame.t === "hello") {
        clearTimeout(helloTimer);
        peer = frame;
        everUp = true;
        failing = false;
        failedOn = null;
        upAt = performance.now();
        set("up");
        trail("link.direct.up", { link: shortHash(id), via });
        // the cloud relay bills while a message wakes it, so a transport may ping less often there
        const every = typeof pingMs === "function" ? pingMs(via) : pingMs;
        pingTimer = setInterval(() => ping(), every);
        pingTimer.unref?.();
        ping();
        planUpgrade();
        return;
      }
      if (frame.t === "pong") {
        const sent = outstanding.get(frame.n);
        if (sent !== undefined) {
          outstanding.delete(frame.n);
          rtt = rtt === null ? performance.now() - sent : rtt * 0.7 + (performance.now() - sent) * 0.3;
          if (suspect) { suspect = false; set("up"); }
        }
        return;
      }
      if (state !== "up") return;
      if (frame.t === "bytes") writer.received(frame.b.length);
      onFrame(frame);
    });
    link.readable.on("data", (chunk) => { try { read(chunk); } catch (error) { if (conn === mine) drop(error.message); } });
    // "closed", with what the transport knows of why when it can tell (ssh: the command's exit, the connection's end)
    const ended = () => { if (conn !== mine) return; let why = null; try { why = link.why?.() ?? null; } catch { /* no reason */ } drop(why ? `closed: ${why}` : "closed"); };
    link.readable.on("end", () => setImmediate(ended));
    link.readable.on("close", () => setImmediate(ended));
    link.readable.on("error", (error) => { if (conn === mine) drop(error?.message ?? "error"); });
    link.writable.on("error", (error) => { if (conn === mine) drop(error?.message ?? "error"); });
    link.writable.on("drain", () => { if (conn === mine) writer.drained(); });
    helloTimer = setTimeout(() => { if (conn === mine) drop("no hello"); }, helloMs);
    helloTimer.unref?.();
    link.writable.write(DIRECT_MAGIC);
    writer.push({ ...hello, t: "hello", v: 1 });
  }

  return {
    start() { if (!closed && state === "idle") void dial(); },
    ready,
    state: () => state,
    rtt: () => rtt,
    everUp: () => everUp,
    /** the last dial on this network failed: nothing should wait for this path until it says hello */
    failing: () => failing,
    /** resolves true once up, false after `ms` or when the link gave up for now */
    whenUp(ms) {
      if (ready()) return Promise.resolve(true);
      return new Promise((resolve) => {
        const timer = setTimeout(() => { waiters.delete(wake); resolve(false); }, ms);
        const wake = () => { if (ready() || state === "waiting" || state === "closed") { clearTimeout(timer); waiters.delete(wake); resolve(ready()); } };
        waiters.add(wake);
      });
    },
    /** "ssh" or "wss": how the connection that is up now got there */
    via: () => (conn ? via : null),
    /** the agent's last direct hello as it came (vps-link-compat.mjs agentInfo reads it), null before one */
    peer: () => peer,
    push: (frame) => writer?.push(frame),
    bytes: (r, chunk, lane = false) => (writer ? writer.bytes(r, chunk, lane) : true),
    queued: () => writer?.size ?? 0,
    onDrain: (resume) => (writer ? writer.onDrain(resume) : resume()),
    discard: (r) => writer?.discard(r),
    /**
     * after a wake or a network change: new requests take the relay until a quick ping proves this connection alive. a
     * path that keeps failing is dialled again now only from a different network; on the same one it keeps its backoff
     */
    nudge() {
      if (closed) return;
      if (state === "up") { suspect = true; set("up"); ping(Math.max(1500, (rtt ?? 500) * 3)); }
      else if ((state === "waiting" || state === "down") && (!failing || moved())) { attempt = 0; failing = false; void dial(); }
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(retryTimer);
      clearTimeout(upgradeTimer);
      clearInterval(watchTimer);
      const gone = conn;
      conn = null;
      clearInterval(pingTimer);
      clearTimeout(helloTimer);
      writer?.close();
      try { gone?.close(); } catch { /* already closed */ }
      set("closed");
    },
  };
}

let ssh2 = null;
/** the vendored ssh2 (electron/vendor: the packaged app ships no node_modules), loaded on first use */
export function loadSsh2() {
  ssh2 ??= createRequire(import.meta.url)("./vendor/ssh2.cjs");
  return ssh2;
}

/** a new key for the direct link: { privateKey (openssh), publicKey ("ssh-ed25519 AAAA...") } */
export function newDirectKey() {
  const pair = loadSsh2().utils.generateKeyPairSync("ed25519");
  return { privateKey: pair.private, publicKey: pair.public.trim().split(/\s+/).slice(0, 2).join(" ") };
}

/**
 * dials sshd and opens one channel. only a host key the agent sent inside the sealed tunnel is accepted, so neither the
 * network nor the relay can stand in for the server; the server's forced command ignores what is asked to run.
 */
export function sshConnector({ host, port = 22, user, privateKey, hostKeys, timeoutMs = 20_000, bannerMs = 7000 }) {
  const pinned = hostKeys.map((entry) => Buffer.from(String(entry).split(/\s+/)[1] ?? "", "base64")).filter((blob) => blob.length > 0);
  // an rsa host key signs with sha-2 on any recent sshd
  const types = [...new Set(hostKeys.flatMap((entry) => { const type = String(entry).split(/\s+/)[0]; return type === "ssh-rsa" ? ["rsa-sha2-512", "rsa-sha2-256", "ssh-rsa"] : [type]; }))];
  return () => new Promise((resolve, reject) => {
    const { Client } = loadSsh2();
    const client = new Client();
    const sock = netConnect({ host, port });
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 15_000);
    sock.once("connect", () => void clampMss(sock));
    let settled = false, refused = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      client.end();
      sock.destroy();
      reject(refused ? Object.assign(new Error("the server's ssh key is not the one it said"), { code: "HOSTKEY" }) : error);
    };
    // ssh2 can emit more than one error (e.g. a reset then "Connection lost before handshake"): every one must be
    // handled, or an uncaught exception takes down the main process; after settling, the channel's close drops the link
    client.on("error", (error) => fail(error));
    sock.on("error", (error) => fail(error));
    // sshd greets first, so a port that is blocked (syn dropped) or held by a middlebox is known in seconds, not at the
    // end of the whole handshake's timeout
    const silent = setTimeout(() => { if (!sock.bytesRead) fail(Object.assign(new Error("the server's ssh port did not answer"), { code: "ETIMEDOUT", level: "client-timeout" })); }, bannerMs);
    silent.unref?.();
    // ssh2 stops its own timeout when the socket closes and does not always say why: a close before the channel opens fails
    sock.once("close", () => { clearTimeout(silent); fail(Object.assign(new Error("the connection closed before the handshake"), { level: "client-socket" })); });
    client.once("ready", () => {
      client.exec("omb-direct", (error, channel) => {
        if (error) return fail(error);
        clearTimeout(silent);
        settled = true;
        // why it ended, for the "direct path lost" line: the server's command exiting (and what it said on stderr),
        // the server closing the channel, or the connection itself going (an error, a keepalive with no answer)
        let exited = null, said = "", gone = null;
        channel.on("exit", (code, signal) => { exited = signal ? `signal ${signal}` : `code ${code}`; });
        channel.stderr?.on?.("data", (chunk) => { said = `${said}${chunk}`.slice(-300); });
        client.on("error", (problem) => { gone ??= problem?.message ?? String(problem); });
        client.once("close", () => { gone ??= "the connection closed"; });
        const why = () => {
          const parts = [];
          if (exited) parts.push(`the server's direct command exited (${exited})`);
          if (said.trim()) parts.push(`it said: ${said.trim().split("\n").at(-1).slice(0, 160)}`);
          if (gone) parts.push(gone);
          return parts.length ? parts.join("; ") : "the server ended the channel";
        };
        resolve({ readable: channel, writable: channel, why, close: () => { channel.destroy?.(); client.end(); sock.destroy(); } });
      });
    });
    client.connect({
      sock, username: user, privateKey, readyTimeout: timeoutMs, keepaliveInterval: 15_000, keepaliveCountMax: 2,
      algorithms: { serverHostKey: types },
      hostVerifier: (presented) => {
        const ok = pinned.some((blob) => blob.equals(presented));
        if (!ok) refused = true;
        return ok;
      },
    });
  });
}

const PIN_ERROR = "the server's https key is not the one it said";

/**
 * dials the agent's websocket on the server's own https (port 443 unless the url says otherwise). the tls key must hash to
 * `spki`, which the agent sent inside the sealed tunnel, on top of the usual certificate checks: neither the network
 * nor the relay can stand in for the server, and the frames inside stay sealed end to end as on every path.
 */
export function wssConnector({ url, spki, timeoutMs = 15_000, connect: dial = netConnect, tls: tlsOptions = {}, headers = {}, heartbeatMs = 0, via = "wss", proxy = null }) {
  const target = new URL(url);
  // plain ws:// only for a local relay under test; spki null: the usual certificate checks alone (the cloud relay)
  const plain = target.protocol === "ws:";
  const host = target.hostname.replace(/^\[|\]$/g, ""), port = Number(target.port) || (plain ? 80 : 443);
  // `proxy`: the network's https proxy for this url ({ host, port } or null), tunnelled with CONNECT
  return async () => {
    const through = proxy ? await Promise.resolve(proxy(target)).catch(() => null) : null;
    const tunnelled = through ? await throughProxy(through, host, port, timeoutMs) : null;
    return opened(tunnelled);
  };
  function opened(tunnelled) { return new Promise((resolve, reject) => {
    let settled = false, pinned = false;
    const raw = tunnelled ?? dial({ host, port });
    raw.setNoDelay?.(true);
    raw.setKeepAlive?.(true, 15_000);
    raw.once("connect", () => void clampMss(raw));
    let socket = null;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      raw.destroy();
      reject(error?.code === "PIN" || (error?.message === PIN_ERROR) ? Object.assign(new Error(PIN_ERROR), { code: "PIN" }) : error);
    };
    const timer = setTimeout(() => fail(Object.assign(new Error("the server's https did not answer"), { code: "ETIMEDOUT" })), timeoutMs);
    timer.unref?.();
    connectedSocket(raw, { timeoutMs }).then(() => { if (!settled) secure(); }, fail);
    const secure = () => {
      if (plain) { socket = raw; pinned = true; watch(); handshake(); return; }
      socket = tlsConnect({
        socket: raw, host, ...(isIP(host) ? {} : { servername: host }), ALPNProtocols: ["http/1.1"], ...tlsOptions,
        checkServerIdentity: (name, cert) => {
          const usual = checkServerIdentity(name, cert);
          if (usual) return usual;
          if (spki === null) { pinned = true; return undefined; }
          // the spki der, as the agent's spkiOf hashes it (node's cert.pubkey is the bare point for an ec key)
          pinned = Boolean(cert.raw) && createHash("sha256").update(new X509Certificate(cert.raw).publicKey.export({ type: "spki", format: "der" })).digest("base64") === spki;
          return pinned ? undefined : Object.assign(new Error(PIN_ERROR), { code: "PIN" });
        },
      });
      watch();
      socket.once("secureConnect", () => {
        if (!pinned) { fail(Object.assign(new Error(PIN_ERROR), { code: "PIN" })); return; }
        handshake();
      });
    };
    const nonce = randomBytes(16).toString("base64");
    const watch = () => {
      socket.on("error", fail);
      socket.once("close", () => fail(new Error("the connection closed before the handshake")));
    };
    const handshake = () => {
      socket.write([`GET ${target.pathname}${target.search} HTTP/1.1`, `Host: ${target.host}`, "Upgrade: websocket", "Connection: Upgrade",
        `Sec-WebSocket-Key: ${nonce}`, "Sec-WebSocket-Version: 13", ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`), "", ""].join("\r\n"));
      let buffered = Buffer.alloc(0);
      const onData = (chunk) => {
        buffered = Buffer.concat([buffered, chunk]);
        const end = buffered.indexOf("\r\n\r\n");
        if (end < 0) { if (buffered.length > 16 * 1024) fail(new Error("the server's answer was not a websocket")); return; }
        socket.off("data", onData);
        const lines = buffered.subarray(0, end).toString("latin1").split("\r\n");
        const status = /^HTTP\/1\.1 (\d{3})/.exec(lines[0])?.[1];
        const answered = new Map(lines.slice(1).map((line) => [line.slice(0, line.indexOf(":")).trim().toLowerCase(), line.slice(line.indexOf(":") + 1).trim()]));
        if (status !== "101" || answered.get("sec-websocket-accept") !== wsAccept(nonce)) {
          fail(Object.assign(new Error(`the server's https answered ${status ?? "something else"} for the direct path`), { code: status === "404" ? "NOWSS" : "EPROTO", status: Number(status) || 0 }));
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.off("error", fail);
        socket.removeAllListeners("close");
        socket.setKeepAlive?.(true, 15_000);
        const duplex = wsDuplex(socket, { client: true, head: buffered.subarray(end + 4), heartbeatMs });
        resolve({ readable: duplex, writable: duplex, close: () => duplex.destroy(), via });
      };
      socket.on("data", onData);
    };
  }); }
}

/** a transport that failed on a network is tried last there for this long, so a blocked port costs nothing per dial */
const SKIP_FAILED_MS = 30 * 60_000;

/** after one way connects, a better ranked one still dialling gets this long to connect too and be taken instead */
export const PREFER_GRACE_MS = 3000;
/** ways start this far apart, best first, so a quick good one spares the others the dial */
export const STAGGER_MS = 250;

/**
 * one connect() over several transports, best first (ssh, 443, webrtc, the cloudflare tunnel, then the cloud relay):
 * the ways that did not fail on this network start together, STAGGER_MS apart, and the best ranked one that connects
 * wins (a lesser one that connects first waits PREFER_GRACE_MS for the better ones); the losers are closed. a way that
 * failed on this network is tried after them, one at a time, and `last` ways (the cloud relay, billed per message) only
 * when nothing else connected. the error of the last try is thrown with every try's error in `errors`, best first.
 * `connect.better(via)` dials only the ways ranked above `via`, for an upgrade: a link, or null.
 */
export function orderedConnect(list, { network = networkFingerprint, now = Date.now, log = () => {}, last = new Set(["cloud"]), graceMs = PREFER_GRACE_MS, staggerMs = STAGGER_MS } = {}) {
  const failed = new Map();
  const here = () => { try { return network(); } catch { return null; } };
  const rank = (name) => list.findIndex((one) => one.name === name);
  /** the ways in `group` together: the best that connects, or null with their errors pushed */
  async function race(group, errors, at) {
    if (!group.length) return null;
    return new Promise((resolve) => {
      const results = new Map();
      let settled = false, graceTimer = null;
      const timers = [];
      const finish = () => {
        if (settled) return;
        const done = group.every((one) => results.has(one.name));
        const best = group.find((one) => results.get(one.name)?.link);
        if (!best) { if (done) { settled = true; resolve(null); } return; }
        // a better ranked way still dialling gets a moment
        const better = group.slice(0, group.indexOf(best)).some((one) => !results.has(one.name));
        if (better && graceTimer !== false) { if (!graceTimer) graceTimer = setTimeout(() => { graceTimer = false; finish(); }, graceMs); return; }
        settled = true;
        clearTimeout(graceTimer);
        for (const timer of timers) clearTimeout(timer);
        for (const [name, result] of results) if (result.link && name !== best.name) result.link.close?.();
        resolve({ ...results.get(best.name).link, via: best.name });
      };
      const started = new Set();
      const launch = (i) => {
        const one = group[i];
        if (settled || !one || started.has(one.name)) return;
        started.add(one.name);
        clearTimeout(timers[i]);
        void Promise.resolve().then(() => one.connect()).then((link) => {
          failed.delete(one.name);
          trail("link.attempt", { way: one.name, ok: true });
          if (settled) { link?.close?.(); return; }
          results.set(one.name, { link });
          finish();
        }, (error) => {
          failed.set(one.name, { on: at, at: now() });
          const tagged = Object.assign(error ?? new Error("failed"), { via: one.name });
          errors.push(tagged);
          if (list.length > 1) log(`vps link: direct path over ${one.name} did not connect (${error?.message ?? error})`);
          trail("link.attempt", { way: one.name, ok: false, errCode: error?.code ?? error?.level, msg: error?.message });
          results.set(one.name, { error: tagged });
          // the next way starts now instead of waiting for its turn
          launch(group.findIndex((other) => !started.has(other.name)));
          finish();
        });
      };
      group.forEach((_one, i) => { timers[i] = setTimeout(() => launch(i), i * staggerMs); timers[i].unref?.(); });
      launch(0);
    });
  }
  async function connect(ways = list) {
    const at = here();
    const fresh = (name) => { const seen = failed.get(name); return !seen || seen.on !== at || now() - seen.at > SKIP_FAILED_MS; };
    const errors = [];
    const first = ways.filter((one) => !last.has(one.name) && fresh(one.name));
    const won = await race(first, errors, at);
    if (won) return won;
    for (const one of ways.filter((way) => !first.includes(way))) {
      const link = await race([one], errors, at);
      if (link) return link;
    }
    errors.sort((a, b) => rank(a.via) - rank(b.via));
    throw Object.assign(errors.at(-1) ?? new Error("no direct transport"), { errors });
  }
  const go = () => connect();
  go.better = async (via) => {
    const above = list.slice(0, Math.max(0, rank(via))).filter((one) => !last.has(one.name));
    if (!above.length) return null;
    try { return await connect(above); } catch { return null; }
  };
  return go;
}

/** the cloud relay (apps/cloudflare/link-relay): MADANI_RELAY_URL moves it, `off` turns it off */
export const CLOUD_RELAY_URL = "https://relay.madani.bot";
export function cloudRelayUrl(env = process.env) {
  const value = (env.MADANI_RELAY_URL ?? "").trim();
  if (value === "off") return null;
  try {
    const url = new URL(value || CLOUD_RELAY_URL);
    return ["https:", "http:"].includes(url.protocol) ? url.origin : null;
  } catch { return null; }
}
/** the relay's bearer for a tunnel, from the tunnel key both ends hold (agent.mjs relayTokenOf): the relay keeps only its sha256 */
export const relayTokenOf = (key, id) => createHmac("sha256", Buffer.from(key, "base64url")).update(`madani-relay-v1|${id}`).digest("base64url");
export const RELAY_HEARTBEAT_MS = 25_000;

/** binds the tunnel at the relay to the madani account of a fresh link grant; throws with `status` when refused */
export async function cloudRegister({ url, id, key, grant, fetch: fetchImpl = fetch, timeoutMs = 15_000 }) {
  if (typeof grant !== "string" || !grant) throw Object.assign(new Error("the cloud relay needs a signed-in madani account"), { code: "NO_GRANT" });
  const verifier = createHash("sha256").update(relayTokenOf(key, id)).digest("hex");
  const response = await fetchImpl(`${url}/v1/t/${id}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant, verifier }), signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(typeof body?.error === "string" ? body.error : `the cloud relay answered ${response.status}`), { status: response.status, code: body?.code });
}

/** the app's end of the cloud relay: one websocket per session, carrying the direct path's byte stream through the relay */
export function cloudConnector({ url, id, key, ...rest }) {
  const target = new URL(`${url}/v1/t/${id}/app`);
  target.protocol = target.protocol === "http:" ? "ws:" : "wss:";
  return wssConnector({ url: target.href, spki: null, headers: { authorization: `Bearer ${relayTokenOf(key, id)}` }, heartbeatMs: RELAY_HEARTBEAT_MS, via: "cloud", ...rest });
}
