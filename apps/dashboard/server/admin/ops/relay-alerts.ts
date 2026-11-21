// early warnings for the link relay nodes, read every minute from each node's GET /ops/relay/stats (relays.ts). each
// rule fires one incident email after its time (math.ts step) and one "back to normal" when it clears, never repeats.
// the thresholds sit well before anything breaks, so there is time to act.
import type { OpsRelayCard } from "../../../src/admin/ops-types.ts";

const MINUTE = 60_000;
export const RELAY_RULES = {
  downForMs: 2 * MINUTE,
  bandwidthShare: 0.6, bandwidthForMs: 10 * MINUTE,
  monthShare: 0.7, monthForMs: 30 * MINUTE,
  cpuPct: 80, memPct: 80, boxForMs: 10 * MINUTE,
  tunnelShare: 0.7, tunnelsForMs: 5 * MINUTE,
  turnForMs: 2 * MINUTE,
} as const;
/** every relay node rule id starts with this; the 5 minute ops rules leave them alone */
export const RELAY_RULE_PREFIX = "relay-node-";

export interface RelayReading { id: string; label: string; threshold: string; forMs: number; breach: boolean | null; value: string | null; action: string }

const pct = (value: number) => `${Math.round(value)}%`;
const mbit = (bytesPerSec: number) => `${Math.round((bytesPerSec * 8) / 1e6)} mbit/s`;
const tb = (bytes: number) => `${(bytes / 1e12).toFixed(bytes >= 1e13 ? 1 : 2)} tb`;

/** the readings for every link node card (the cloudflare relay has its own limits and is left out) */
export function relayNodeReadings(cards: readonly OpsRelayCard[]): RelayReading[] {
  const out: RelayReading[] = [];
  for (const card of cards) {
    if (card.id === "cloudflare" || !card.configured) continue;
    const name = card.id, s = card.stats, id = (rule: string) => `${RELAY_RULE_PREFIX}${name}-${rule}`;
    const where = card.url.replace(/^https?:\/\//, "");
    out.push({ id: id("down"), label: `link node ${name} down`, threshold: "no answer for 2 min", forMs: RELAY_RULES.downForMs,
      breach: !card.ok, value: card.ok ? "up" : card.error ?? "no answer",
      action: `its servers move to the other node by themselves, in under a minute. check ${where}/healthz; on the box: systemctl status ${name === "contabo" ? "the autorunner app omb-link (deploy logs omb-link)" : "madani-link-node, journalctl -u madani-link-node"}.` });
    if (!s) continue;
    const limits = s.limits ?? {}, ceiling = typeof limits.globalCeilingBytesPerSec === "number" ? limits.globalCeilingBytesPerSec : null;
    out.push({ id: id("bandwidth"), label: `link node ${name} bandwidth high`, threshold: `over ${pct(RELAY_RULES.bandwidthShare * 100)} of its ceiling for 10 min`, forMs: RELAY_RULES.bandwidthForMs,
      breach: ceiling ? s.now.bytesPerSecOut > ceiling * RELAY_RULES.bandwidthShare : null, value: ceiling ? `${mbit(s.now.bytesPerSecOut)} of ${mbit(ceiling)}` : null,
      action: "new servers already go to the other node while this one is past 85%. if it stays high, raise the ceiling in admin ops (if the box can take it) or add a node." });
    const allowance = s.month.allowanceBytes, sent = s.box?.monthBytesOut ?? s.month.bytesOut, projected = s.box?.projectedBytesOut ?? s.month.projectedBytesOut;
    out.push({ id: id("month"), label: `link node ${name} month traffic high`, threshold: `projected over ${pct(RELAY_RULES.monthShare * 100)} of the allowance for 30 min`, forMs: RELAY_RULES.monthForMs,
      // a few early gigabytes project wildly; wait for 2% of the allowance before believing the pace
      breach: allowance ? projected > allowance * RELAY_RULES.monthShare && sent > allowance * 0.02 : null,
      value: allowance ? `${tb(sent)} sent, ${tb(projected)} at this pace, allowance ${tb(allowance)}` : null,
      action: "new servers stop going to this node at 70% on their own, and its servers move off at 85% when they reconnect. if it keeps climbing, pause new tunnels here in admin ops or add a node; oracle bills past its free 10 tb." });
    const box = s.box;
    out.push({ id: id("cpu"), label: `link node ${name} cpu high`, threshold: `over ${RELAY_RULES.cpuPct}% for 10 min`, forMs: RELAY_RULES.boxForMs,
      breach: box?.cpu != null ? box.cpu > RELAY_RULES.cpuPct : null, value: box?.cpu != null ? pct(box.cpu) : null,
      action: "see what is busy on the box (top). new servers skip a node past 90%; lower the ceiling or the tunnel cap in admin ops if the relay is the cause." });
    out.push({ id: id("mem"), label: `link node ${name} memory high`, threshold: `over ${RELAY_RULES.memPct}% for 10 min`, forMs: RELAY_RULES.boxForMs,
      breach: box?.mem != null ? box.mem > RELAY_RULES.memPct : null, value: box?.mem != null ? pct(box.mem) : null,
      action: `the link service itself used ${s.now.rssMb ?? "?"} mb. look for what grew (top, docker stats); restarting the link service moves its servers to the other node for a moment.` });
    // busy tunnels, tunnels in use (open desktops) and servers reading here, each against its own cap
    const caps = ([["busy", s.now.tunnels, limits.maxTunnels], ["in use", s.now.connected, limits.maxConnected], ["servers", s.now.servers, limits.maxServers]] as const)
      .flatMap(([what, count, max]) => typeof count === "number" && typeof max === "number" && max > 0 ? [{ what, count, max }] : []);
    const fullest = caps.length ? caps.reduce((a, b) => (b.count / b.max > a.count / a.max ? b : a)) : null;
    out.push({ id: id("tunnels"), label: `link node ${name} tunnels near the cap`, threshold: `over ${pct(RELAY_RULES.tunnelShare * 100)} of max tunnels, tunnels in use or servers for 5 min`, forMs: RELAY_RULES.tunnelsForMs,
      breach: fullest ? fullest.count > fullest.max * RELAY_RULES.tunnelShare : null, value: fullest ? `${fullest.count} of ${fullest.max} ${fullest.what}` : null,
      action: "new servers go to the other node from 90%. raise the cap in admin ops if the node's cpu allows (docs/capacity.md), or add a node (apps/link-service/deploy/add-node.sh)." });
    if (s.turn) out.push({ id: id("turn"), label: `turn on link node ${name} down`, threshold: "no stun answer for 2 min", forMs: RELAY_RULES.turnForMs,
      breach: s.turn.ok === null ? null : !s.turn.ok, value: s.turn.ok === null ? null : s.turn.ok ? "up" : "no answer",
      action: "webrtc falls back to cloudflare turn and then the relay meanwhile. on the box: systemctl status coturn, journalctl -u coturn." });
  }
  return out;
}
