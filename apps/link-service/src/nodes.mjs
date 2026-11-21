// more than one link service node. every node keeps the whole directory (tunnels and phone channels: ids, sha256
// verifiers, the account ref and the node the tunnel lives on, never a token or anything sealed), copied to the others
// every few seconds and at once on a change. so any node answers "where does this server live", and a node can serve a
// tunnel the moment it moves there, even while the node it came from is dead. setup sessions stay on the node that made
// them. a tunnel's queues live only on its home node: the server and the app both talk to that one.
//
// LINK_NODES="contabo=https://link.madani.bot@eu,oracle-in=https://link-in.madani.bot@asia" is the same on every node; the
// first is the default home (tunnels from before nodes existed, and the fallback). LINK_NODE_ID says which one this is.
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const NODE_ID = /^[a-z][a-z0-9-]{1,30}$/;
/** a peer that has not answered a sync for this long is down: nothing is placed there and its servers move on reconnect */
export const PEER_DOWN_MS = 30_000;
export const SYNC_EVERY_MS = 5_000;
/** records per sync post; a node far behind catches up over a few rounds */
export const SYNC_BATCH = 2000;
/** a deleted tunnel or channel is remembered this long, so a node that was away cannot bring it back */
export const TOMBSTONE_MS = 30 * 24 * 60 * 60_000;
/** new servers stop going to a node whose month traffic is on course past this share of its allowance */
export const PLACE_STOP_FRACTION = 0.7;
/** a server already on a node moves off it on reconnect once the month's traffic passed this share */
export const MOVE_OFF_FRACTION = 0.85;
export const TUNNEL_FIELDS = Object.freeze(["id", "createdAt", "vpsVerifier", "appVerifier", "acct", "home", "addr", "polled", "rev"]);
/** a server's sealed address (agent.mjs createAddressBook), opaque here */
export const SEALED_ADDRESS_MAX = 4096;
export const CHANNEL_FIELDS = Object.freeze(["id", "tunnel", "verifier", "kind", "expiresAt", "createdAt", "rev"]);

/** LINK_NODES, LINK_NODE_ID: the node list and which one this is; null when this service runs alone */
export function parseNodes(list, selfId) {
  if (!list) return null;
  const nodes = [];
  for (const part of list.split(",").map((item) => item.trim()).filter(Boolean)) {
    const match = /^([a-z][a-z0-9-]{1,30})=(https?:\/\/[^/\s@]+)(?:@([a-z]{2,12}))?$/.exec(part);
    if (!match) throw new Error(`LINK_NODES: "${part.slice(0, 60)}" is not id=https://host@region`);
    if (nodes.some((node) => node.id === match[1])) throw new Error(`LINK_NODES: ${match[1]} is listed twice`);
    nodes.push({ id: match[1], url: match[2], region: match[3] ?? null });
  }
  if (!nodes.length) return null;
  const id = selfId || nodes[0].id;
  if (!NODE_ID.test(id) || !nodes.some((node) => node.id === id)) throw new Error(`LINK_NODE_ID ${String(id).slice(0, 40)} is not in LINK_NODES`);
  return { self: nodes.find((node) => node.id === id), nodes, defaultId: nodes[0].id };
}

export const sameSecret = (presented, secret) => typeof presented === "string" && typeof secret === "string" && presented.length > 0
  && timingSafeEqual(createHash("sha256").update(presented).digest(), createHash("sha256").update(secret).digest());

const fraction = (value, of) => (Number.isFinite(value) && Number.isFinite(of) && of > 0 ? value / of : 0);

/**
 * how full a node is, from its health summary: each part 0 (empty) to 1 (at its limit).
 * budget is the month's traffic so far or on course, against the allowance; the rest are live
 */
export function loadOf(health) {
  // busy tunnels, tunnels in use (open desktops) and servers reading here, each against its cap: the fullest counts
  const active = Math.max(fraction(health?.tunnels, health?.maxTunnels), fraction(health?.connected, health?.maxConnected), fraction(health?.servers, health?.maxServers));
  const bandwidth = fraction(health?.bytesPerSecOut, health?.ceilingBytesPerSec);
  const budget = Math.max(fraction(health?.monthBytesOut, health?.allowanceBytes), fraction(health?.projectedBytesOut, health?.allowanceBytes));
  const spent = fraction(health?.monthBytesOut, health?.allowanceBytes);
  const box = Math.max(fraction(health?.cpu, 100), fraction(health?.mem, 100));
  return { active, bandwidth, budget, spent, box };
}

/** why a node takes no new servers, or null when it does */
export function refusesNew(node, stop = PLACE_STOP_FRACTION) {
  if (!node.up) return "down";
  if (node.health?.paused) return "paused";
  const load = loadOf(node.health);
  if (load.active >= 0.9) return "tunnels";
  if (load.bandwidth >= 0.85) return "bandwidth";
  if (load.budget >= stop) return "month traffic";
  if (load.box >= 0.9) return "cpu or memory";
  return null;
}

/** why a server should leave the node it is on when it reconnects, or null to stay (sticky) */
export function mustLeave(node, move = MOVE_OFF_FRACTION) {
  if (!node || !node.up) return "down";
  if (node.health?.paused) return "paused";
  const load = loadOf(node.health);
  if (load.spent >= move) return "month traffic";
  if (load.active >= 1) return "tunnels";
  return null;
}

/**
 * where a server's tunnel goes. `nodes`: [{ id, url, region, up, acked, health }], `home`: where it is now (or null),
 * `rtt`: the server's own round trips to each node in ms. a server stays home unless home is down or past its hard
 * limits, or home is nearly full while another node is mostly empty. a new one goes to the least loaded node that takes
 * new servers, nearer nodes first (up to half a node's worth of load for a slow round trip); with none taking new
 * servers, to the least loaded node that is up and not paused (the default on a tie), so nobody is ever left without
 * a node and the overflow does not all land on one.
 * @returns {{ node: string, reason: string }}
 */
export function choosePlacement({ nodes, home = null, rtt = {}, defaultId, stop = PLACE_STOP_FRACTION }) {
  const usable = nodes.filter((node) => node.up && node.acked !== false);
  const rtts = usable.map((node) => rtt[node.id]).filter((ms) => Number.isFinite(ms) && ms >= 0);
  const best = rtts.length ? Math.min(...rtts) : null;
  const latency = (node) => {
    const ms = rtt[node.id];
    if (best === null) return 0;
    if (!Number.isFinite(ms) || ms < 0) return 0.25;
    return Math.min(0.5, Math.max(0, (ms - best) / 300));
  };
  const homed = usable.reduce((sum, node) => sum + (node.health?.homed ?? 0), 0);
  const score = (node) => {
    const load = loadOf(node.health);
    return 0.5 * Math.max(load.active, load.bandwidth) + 0.3 * (load.budget / stop) + 0.2 * fraction(node.health?.homed ?? 0, Math.max(1, homed)) + latency(node);
  };
  const open = usable.filter((node) => !refusesNew(node, stop)).sort((a, b) => score(a) - score(b) || (a.id === defaultId ? -1 : b.id === defaultId ? 1 : 0));
  // the server measured other nodes but not its home: it cannot reach it, whatever the nodes see of each other
  const unreached = home && rtts.length > 0 && !Number.isFinite(rtt[home]);
  const current = home && !unreached ? usable.find((node) => node.id === home) : null;
  if (current && !mustLeave(current)) {
    const load = loadOf(current.health), alternative = open.find((node) => node.id !== current.id);
    const crowded = Math.max(load.active, load.bandwidth) >= 0.85 && alternative && Math.max(loadOf(alternative.health).active, loadOf(alternative.health).bandwidth) <= 0.5;
    if (!crowded) return { node: current.id, reason: "home" };
    return { node: alternative.id, reason: "home is crowded" };
  }
  const away = open.filter((node) => !unreached || node.id !== home);
  if (away.length) return { node: away[0].id, reason: home ? `home ${unreached ? "is out of the server's reach" : current ? mustLeave(current) : "is down"}` : "new" };
  // every node is full: the least loaded one that can hold the record, not the default, so the overflow spreads
  const reachable = usable.filter((node) => (!unreached || node.id !== home) && !node.health?.paused);
  const fallback = [...(reachable.length ? reachable : usable)].sort((a, b) => score(a) - score(b) || (a.id === defaultId ? -1 : b.id === defaultId ? 1 : 0))[0];
  return { node: fallback?.id ?? defaultId, reason: "no node takes new servers" };
}

const pick = (record, fields) => { const out = {}; for (const key of fields) if (record[key] !== undefined) out[key] = record[key]; return out; };

/**
 * the directory's copy between nodes. `health()` is this node's summary, sent with every sync and read by the peers'
 * placement. the app calls `changed(record)` after it creates or changes a tunnel or channel, and `removed(kind, id)`
 * after it deletes one; `onRemoved(kind, record)` drops a tunnel's or channel's live state when a peer deleted it
 */
/** how often a node sends a peer its accounts' relay bytes this month (fair use across nodes) */
export const USAGE_EVERY_MS = 60_000;

export function createCluster({ config, store, token, dir = null, now = Date.now, fetch: fetchImpl = fetch, log = () => {}, health = () => ({}), onRemoved = () => {}, everyMs = SYNC_EVERY_MS, usage = null, onUsage = () => {} }) {
  const self = config.self;
  const file = dir ? join(dir, "cluster.json") : null;
  let saved = null;
  try { saved = file ? JSON.parse(readFileSync(file, "utf8")) : null; } catch {}
  /** kind:id -> { kind, id, at } */
  const gone = new Map(Object.entries(saved?.gone ?? {}));
  const peers = new Map(config.nodes.filter((node) => node.id !== self.id).map((node) => [node.id, {
    ...node, acked: Number(saved?.acked?.[node.id]) || 0, lastOkAt: null, lastError: null, health: null, sending: null,
  }]));
  let lastRev = 0, timer = null, soon = null, dirty = false;
  const rev = () => (lastRev = Math.max(now(), lastRev + 1));
  // records from before nodes existed get a revision now, so they are copied to the peers once
  for (const map of [store.tunnels, store.channels]) for (const record of map.values()) if (!Number.isFinite(record.rev)) { record.rev = rev(); }
  for (const map of [store.tunnels, store.channels]) for (const record of map.values()) lastRev = Math.max(lastRev, record.rev);

  function persist() {
    if (!file || !dirty) return;
    dirty = false;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 1, gone: Object.fromEntries(gone), acked: Object.fromEntries([...peers].map(([id, peer]) => [id, peer.acked])) }), { mode: 0o600 });
      renameSync(tmp, file);
    } catch (error) { log(`link: could not save cluster state (${error?.message ?? error})`); }
  }
  function nudge() {
    if (soon || !peers.size) return;
    soon = setTimeout(() => { soon = null; void syncAll(); }, 150);
    soon.unref?.();
  }
  function changed(record) { record.rev = rev(); store.save(); nudge(); }
  function removed(kind, id) { gone.set(`${kind}:${id}`, { kind, id, at: rev() }); dirty = true; persist(); nudge(); }

  function changesSince(since) {
    const out = [];
    for (const tunnel of store.tunnels.values()) if (tunnel.rev > since) out.push({ k: "tunnel", r: pick(tunnel, TUNNEL_FIELDS) });
    for (const channel of store.channels.values()) if (channel.rev > since) out.push({ k: "channel", r: pick(channel, CHANNEL_FIELDS) });
    for (const mark of gone.values()) if (mark.at > since) out.push({ k: "gone", r: mark });
    out.sort((a, b) => (a.r.rev ?? a.r.at) - (b.r.rev ?? b.r.at));
    return out.slice(0, SYNC_BATCH);
  }

  const validTunnel = (r) => typeof r?.id === "string" && /^[a-z2-7]{10}$/.test(r.id) && /^[0-9a-f]{64}$/.test(r.vpsVerifier ?? "") && /^[0-9a-f]{64}$/.test(r.appVerifier ?? "")
    && Number.isFinite(r.rev) && (r.home === undefined || r.home === null || NODE_ID.test(r.home)) && (r.acct === undefined || typeof r.acct === "string")
    && (r.polled === undefined || typeof r.polled === "boolean")
    && (r.addr === undefined || (typeof r.addr === "string" && r.addr.length <= SEALED_ADDRESS_MAX && /^[A-Za-z0-9_-]+$/.test(r.addr)));
  const validChannel = (r) => typeof r?.id === "string" && /^[a-z2-7]{10}$/.test(r.id) && /^[a-z2-7]{10}$/.test(r.tunnel ?? "") && /^[0-9a-f]{64}$/.test(r.verifier ?? "")
    && (r.kind === "grant" || r.kind === "device") && Number.isFinite(r.rev);

  /** a peer's records: newer ones win (by revision, then node id), a tombstone wins over anything older than it */
  function apply(from, records) {
    let applied = 0, changedStore = false;
    for (const item of Array.isArray(records) ? records.slice(0, SYNC_BATCH) : []) {
      const r = item?.r;
      if (item?.k === "gone") {
        if ((r?.kind !== "tunnel" && r?.kind !== "channel") || typeof r.id !== "string" || !Number.isFinite(r.at)) continue;
        const key = `${r.kind}:${r.id}`, mark = gone.get(key);
        if (!mark || mark.at < r.at) { gone.set(key, { kind: r.kind, id: r.id, at: r.at }); dirty = true; }
        lastRev = Math.max(lastRev, r.at);
        const map = r.kind === "tunnel" ? store.tunnels : store.channels, local = map.get(r.id);
        if (local && (local.rev ?? 0) <= r.at) {
          map.delete(r.id);
          changedStore = true;
          applied += 1;
          onRemoved(r.kind, local);
        }
        continue;
      }
      const kind = item?.k, valid = kind === "tunnel" ? validTunnel(r) : kind === "channel" ? validChannel(r) : false;
      if (!valid) continue;
      const mark = gone.get(`${kind}:${r.id}`);
      if (mark && mark.at >= r.rev) continue;
      const map = kind === "tunnel" ? store.tunnels : store.channels, local = map.get(r.id);
      lastRev = Math.max(lastRev, r.rev);
      if (local && (local.rev > r.rev || (local.rev === r.rev && self.id <= from))) continue;
      const fields = kind === "tunnel" ? TUNNEL_FIELDS : CHANNEL_FIELDS;
      const next = local ?? {};
      for (const key of fields) if (key in r) next[key] = r[key]; else if (key !== "id") delete next[key];
      if (kind === "tunnel" && !local) next.seenAt = null;
      if (kind === "channel" && !local) next.seenAt = null;
      map.set(r.id, next);
      changedStore = true;
      applied += 1;
    }
    if (changedStore) store.save();
    persist();
    return applied;
  }

  async function syncPeer(peer) {
    if (peer.sending) return peer.sending;
    peer.sending = (async () => {
      const records = changesSince(peer.acked);
      const withUsage = usage && now() - (peer.usageAt ?? 0) >= USAGE_EVERY_MS;
      const top = records.length ? records.at(-1).r.rev ?? records.at(-1).r.at : peer.acked;
      try {
        const response = await fetchImpl(`${peer.url}/internal/v1/sync`, {
          method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ from: self.id, health: health(), records, ...(withUsage ? { usage: usage() } : {}) }), signal: AbortSignal.timeout(10_000),
        });
        const answer = await response.json().catch(() => null);
        if (!response.ok || !answer?.ok) throw new Error(`answered ${response.status}`);
        if (peer.lastOkAt === null || now() - peer.lastOkAt > PEER_DOWN_MS) log(`link: node ${peer.id} is reachable`);
        peer.lastOkAt = now(); peer.lastError = null; peer.health = answer.health ?? null;
        if (withUsage) peer.usageAt = now();
        if (top > peer.acked) { peer.acked = top; dirty = true; persist(); }
        return true;
      } catch (error) {
        const was = peer.lastOkAt !== null && now() - peer.lastOkAt <= PEER_DOWN_MS;
        peer.lastError = error?.message ?? String(error);
        if (was && now() - peer.lastOkAt > PEER_DOWN_MS) log(`link: node ${peer.id} stopped answering (${peer.lastError})`);
        return false;
      } finally { peer.sending = null; }
    })();
    return peer.sending;
  }
  const syncAll = () => Promise.all([...peers.values()].map(syncPeer));

  function sweep() {
    const t = now();
    for (const [key, mark] of gone) if (t - mark.at > TOMBSTONE_MS) { gone.delete(key); dirty = true; }
    persist();
  }

  /** the incoming side: POST /internal/v1/sync from a peer */
  function receive(body) {
    const peer = typeof body?.from === "string" ? peers.get(body.from) : null;
    if (!peer) return null;
    const applied = apply(peer.id, body.records);
    // a peer's own sync proves it runs, not that anyone can reach it (its nginx may be down): up is only what this
    // node's syncs to it see
    if (body.health && typeof body.health === "object") peer.health = body.health;
    if (body.usage && typeof body.usage === "object") onUsage(peer.id, body.usage);
    return { ok: true, applied, health: health() };
  }

  const isUp = (peer) => peer.lastOkAt !== null && now() - peer.lastOkAt <= PEER_DOWN_MS;
  /** every node as placement and the ops page see it; `record`: the tunnel, so a peer that may not have it is skipped */
  function view(record = null) {
    return [
      { id: self.id, url: self.url, region: self.region, self: true, up: true, acked: true, lastOkAt: now(), health: health() },
      ...[...peers.values()].map((peer) => ({ id: peer.id, url: peer.url, region: peer.region, self: false, up: isUp(peer),
        acked: record ? (record.rev ?? 0) <= peer.acked : true, lastOkAt: peer.lastOkAt, lastError: peer.lastError, health: peer.health })),
    ];
  }
  /** make sure `peer` holds `record` before a server is sent there: one sync now, if it is behind */
  async function ensureOn(peerId, record) {
    const peer = peers.get(peerId);
    if (!peer) return peerId === self.id;
    if ((record.rev ?? 0) <= peer.acked) return true;
    await syncPeer(peer);
    if ((record.rev ?? 0) <= peer.acked) return true;
    // a sync already in flight may have started before the record changed
    await syncPeer(peer);
    return (record.rev ?? 0) <= peer.acked;
  }

  return {
    self, defaultId: config.defaultId, nodes: config.nodes, changed, removed, receive, view, ensureOn, sweep, syncAll,
    urlOf: (id) => config.nodes.find((node) => node.id === id)?.url ?? null,
    isGone: (kind, id) => gone.has(`${kind}:${id}`),
    start() { if (timer || !peers.size) return; void syncAll(); timer = setInterval(() => void syncAll(), everyMs); timer.unref?.(); },
    stop() { clearInterval(timer); timer = null; clearTimeout(soon); soon = null; persist(); },
  };
}
