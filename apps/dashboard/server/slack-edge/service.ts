import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { SLACK_EDGE_LIMITS, SLACK_EDGE_VERSION, appTokenHash, edgeEventKind, sealForDesktop, validEdgePublicKey } from "../../../../shared/slack-edge.ts";
import type { SlackEdgeEvent, SlackEdgeSyncAnswer } from "../../../../shared/slack-edge.ts";
import type { DesktopKind, WakeStat } from "../../../../shared/billing-api.ts";
import { createJsonStore } from "../billing/json-store.ts";
import type { createSealer } from "../clouds/seal.ts";
import type { CloudsService, StoredCloud } from "../clouds/types.ts";

export class EdgeError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) { super(code); this.name = "EdgeError"; this.status = status; this.code = code; }
}

/** one Socket Mode connection with a bot's app-level token (server/slack/socket.ts in production, fake in tests) */
export interface EdgeSocket { start(): void; stop(): void }
export type EdgeSocketFactory = (input: { appToken: string; onEvent(payload: Record<string, unknown>): void; onState(state: string, error?: string): void }) => EdgeSocket;

interface StoredBot { botId: string; appId: string; botUserId: string; tokenHash: string; sealedToken: string | null; error?: string }
interface StoredReg {
  cloudId: string; workspaceId: string; enabled: boolean;
  publicKey: string | null; bots: StoredBot[];
  lastSyncAt: number;
  /** the wake request already timed, so one wake is counted once */
  measuredWake: number | null;
  lastWakeAskAt: number | null;
  dropped: number;
}
interface StoredEvent { id: string; cloudId: string; botId: string; eventId: string; receivedAt: number; sealed: string; wake: boolean }
interface WakeSample { kind: Exclude<DesktopKind, "none">; ms: number; at: number }
interface State { v: 1; regs: StoredReg[]; events: StoredEvent[]; wakes: WakeSample[] }

export interface SlackWakeView { available: boolean; enabled: boolean; state: "off" | "waiting" | "holding" | "waking"; bots: number; buffered: number }

export interface SlackEdgeOptions {
  dataDir: string;
  clouds: CloudsService;
  /** MADANI_SLACK_EDGE=1 on the service; off means every desktop reads enabled: false and nothing is held */
  enabled: boolean;
  sealer: ReturnType<typeof createSealer>;
  socket: EdgeSocketFactory;
  now?: () => number;
  log?: (line: string) => void;
  /** after a wake, how long the edge keeps holding while it waits for the desktop to take over */
  handoverMs?: number;
  minWakeSamples?: number;
}

const ASLEEP = new Set<StoredCloud["status"]>(["stopped", "sleeping"]);
const GONE = new Set<StoredCloud["status"]>(["destroying", "destroyed", "suspended", "error", "checkout"]);
const WAKE_RETRY_MS = 60_000;
const MAX_WAKE_SAMPLE_MS = 10 * 60_000;
const id = (prefix: string) => `${prefix}_${randomBytes(12).toString("base64url")}`;
const botIdShape = /^[A-Za-z0-9_-]{1,80}$/, slackIdShape = /^[A-Z0-9]{2,40}$/;

export function createSlackEdge(options: SlackEdgeOptions) {
  const now = options.now ?? Date.now, log = options.log ?? ((line: string) => console.warn(`slack edge: ${line}`));
  const handoverMs = options.handoverMs ?? 10 * 60_000, minSamples = options.minWakeSamples ?? 10;
  const store = createJsonStore<State>(join(options.dataDir, "slack-edge.json"), () => ({ v: 1, regs: [], events: [], wakes: [] }),
    (v): v is State => !!v && typeof v === "object" && (v as State).v === 1 && Array.isArray((v as State).regs) && Array.isArray((v as State).events) && Array.isArray((v as State).wakes));
  const state = store.state;
  /** runtime only: the sockets held for a sleeping desktop, rebuilt from cloud status after a restart */
  const holding = new Map<string, { since: number; sockets: Map<string, EdgeSocket> }>();
  let closed = false;

  const regOf = (cloudId: string) => state.regs.find(r => r.cloudId === cloudId) ?? null;
  const eventsOf = (cloudId: string) => state.events.filter(e => e.cloudId === cloudId);
  function ensureReg(cloud: StoredCloud): StoredReg {
    let reg = regOf(cloud.id);
    if (!reg) {
      reg = { cloudId: cloud.id, workspaceId: cloud.workspaceId ?? "", enabled: false, publicKey: null, bots: [], lastSyncAt: 0, measuredWake: null, lastWakeAskAt: null, dropped: 0 };
      state.regs.push(reg);
    }
    if (cloud.workspaceId) reg.workspaceId = cloud.workspaceId;
    return reg;
  }
  function release(cloudId: string) {
    const held = holding.get(cloudId);
    if (!held) return;
    for (const socket of held.sockets.values()) socket.stop();
    holding.delete(cloudId);
  }
  function forgetTokens(reg: StoredReg) { for (const bot of reg.bots) bot.sealedToken = null; }

  function prune() {
    const cutoff = now() - SLACK_EDGE_LIMITS.ttlMs;
    const before = state.events.length;
    state.events = state.events.filter(e => e.receivedAt > cutoff && state.regs.some(r => r.cloudId === e.cloudId));
    if (state.events.length !== before) store.changed();
  }

  /** the event is sealed before anything is stored; only type fields are read, never the text */
  function receive(cloudId: string, botId: string, payload: Record<string, unknown>) {
    const reg = regOf(cloudId), bot = reg?.bots.find(b => b.botId === botId), cloud = options.clouds.get(cloudId);
    if (!reg || !bot || !reg.publicKey || !cloud) return;
    const kind = edgeEventKind(payload, bot.botUserId);
    if (kind === "drop") return;
    const eventId = typeof payload.event_id === "string" ? payload.event_id.slice(0, 80) : id("ev");
    if (state.events.some(e => e.cloudId === cloudId && e.eventId === eventId)) return;
    const plain = JSON.stringify(payload);
    if (Buffer.byteLength(plain) > SLACK_EDGE_LIMITS.eventBytes) { reg.dropped++; store.changed(); return; }
    const sealed = sealForDesktop(reg.publicKey, botId, plain);
    state.events.push({ id: id("sev"), cloudId, botId, eventId, receivedAt: now(), sealed, wake: kind === "wake" });
    let mine = eventsOf(cloudId), bytes = mine.reduce((n, e) => n + e.sealed.length, 0);
    while (mine.length > SLACK_EDGE_LIMITS.events || bytes > SLACK_EDGE_LIMITS.sealedBytes) {
      const oldest = mine[0]!;
      state.events.splice(state.events.indexOf(oldest), 1);
      bytes -= oldest.sealed.length; mine = mine.slice(1); reg.dropped++;
    }
    store.commit();
    if (kind === "wake") wake(reg, cloud);
  }

  function wake(reg: StoredReg, cloud: StoredCloud) {
    if (!ASLEEP.has(cloud.status) || reg.lastWakeAskAt !== null && now() - reg.lastWakeAskAt < WAKE_RETRY_MS) return;
    reg.lastWakeAskAt = now(); store.changed();
    void options.clouds.power(cloud.accountId, cloud.id, "on").catch(() => log("a wake was refused."));
  }

  function hold(reg: StoredReg) {
    if (holding.has(reg.cloudId) || !reg.publicKey) return;
    const sockets = new Map<string, EdgeSocket>();
    for (const bot of reg.bots) {
      if (!bot.sealedToken) continue;
      let appToken: string;
      try { appToken = options.sealer.unseal(bot.sealedToken); } catch { bot.sealedToken = null; bot.error = "token unreadable"; continue; }
      const cloudId = reg.cloudId, botId = bot.botId;
      const socket = options.socket({ appToken, onEvent: payload => { try { receive(cloudId, botId, payload); } catch { log("an event could not be kept."); } },
        onState: (value, error) => { if (value === "error") { bot.error = error ?? "socket error"; store.changed(); } } });
      sockets.set(botId, socket);
    }
    if (!sockets.size) return;
    holding.set(reg.cloudId, { since: now(), sockets });
    for (const socket of sockets.values()) socket.start();
  }

  function tick() {
    if (closed) return;
    prune();
    for (const reg of state.regs) {
      const cloud = options.clouds.get(reg.cloudId);
      if (!cloud || GONE.has(cloud.status) || cloud.ended) {
        release(reg.cloudId);
        if (!cloud || cloud.status === "destroyed") { forgetTokens(reg); reg.enabled = false; store.changed(); }
        continue;
      }
      if (!options.enabled || !reg.enabled) { release(reg.cloudId); continue; }
      const asleep = ASLEEP.has(cloud.status);
      const held = holding.get(reg.cloudId);
      const wokeAt = cloud.wakeRequestedAt ?? 0;
      // after a wake the edge keeps the connection until the desktop syncs, so nothing is missed while it boots
      const handingOver = !asleep && wokeAt > reg.lastSyncAt && now() - wokeAt < handoverMs;
      if (asleep || handingOver) {
        if (!held) hold(reg);
        if (asleep && eventsOf(reg.cloudId).some(e => e.wake)) wake(reg, cloud);
      } else if (held && now() - held.since >= handoverMs) release(reg.cloudId);
    }
  }

  function measure(reg: StoredReg, cloud: StoredCloud) {
    const asked = cloud.wakeRequestedAt;
    if (asked === undefined || cloud.status !== "running" || reg.measuredWake === asked || reg.lastSyncAt >= asked) return;
    reg.measuredWake = asked;
    const ms = now() - asked;
    if (ms > 0 && ms <= MAX_WAKE_SAMPLE_MS) {
      state.wakes.push({ kind: cloud.kind, ms, at: now() });
      const mine = state.wakes.filter(w => w.kind === cloud.kind);
      if (mine.length > 200) state.wakes.splice(state.wakes.indexOf(mine[0]!), 1);
    }
  }

  function view(cloud: StoredCloud): SlackWakeView {
    const reg = regOf(cloud.id), enabled = options.enabled && !!reg?.enabled, mine = eventsOf(cloud.id);
    const mode = !enabled ? "off" : holding.has(cloud.id) ? (mine.some(e => e.wake) && ASLEEP.has(cloud.status) ? "waking" : "holding") : "waiting";
    return { available: options.enabled, enabled, state: mode, bots: reg?.bots.filter(b => b.sealedToken).length ?? 0, buffered: mine.length };
  }

  function parseBots(value: unknown) {
    if (!Array.isArray(value) || value.length > SLACK_EDGE_LIMITS.bots) throw new EdgeError(400, "invalid_request");
    return value.map(item => {
      const bot = item as Record<string, unknown>;
      if (!bot || typeof bot !== "object" || typeof bot.botId !== "string" || !botIdShape.test(bot.botId) || typeof bot.appId !== "string" || !slackIdShape.test(bot.appId)
        || typeof bot.botUserId !== "string" || !slackIdShape.test(bot.botUserId) || typeof bot.tokenHash !== "string" || !/^[0-9a-f]{64}$/.test(bot.tokenHash)) throw new EdgeError(400, "invalid_request");
      return { botId: bot.botId, appId: bot.appId, botUserId: bot.botUserId, tokenHash: bot.tokenHash };
    });
  }

  const timer = setInterval(tick, 15_000);
  timer.unref();
  return {
    /** a desktop's signed sync: acks handled events, refreshes its bots, takes over from the edge once it is awake */
    sync(workspaceId: string, body: Record<string, unknown>): SlackEdgeSyncAnswer {
      if (body.v !== SLACK_EDGE_VERSION || !validEdgePublicKey(body.publicKey)) throw new EdgeError(400, "invalid_request");
      const bots = parseBots(body.bots);
      if (!Array.isArray(body.ack) || body.ack.length > 200 || body.ack.some(a => typeof a !== "string")) throw new EdgeError(400, "invalid_request");
      const cloud = options.clouds.byWorkspace(workspaceId);
      if (!cloud) return { v: SLACK_EDGE_VERSION, enabled: false, needTokens: [], events: [] };
      const reg = ensureReg(cloud), acked = new Set(body.ack as string[]);
      state.events = state.events.filter(e => e.cloudId !== cloud.id || !acked.has(e.id));
      measure(reg, cloud);
      reg.lastSyncAt = now();
      reg.lastWakeAskAt = null;
      reg.publicKey = body.publicKey;
      const enabled = options.enabled && reg.enabled;
      if (!enabled) { forgetTokens(reg); release(cloud.id); }
      const kept = new Map(reg.bots.map(b => [b.botId, b]));
      reg.bots = bots.map(b => {
        const old = kept.get(b.botId);
        const same = old && old.appId === b.appId && old.botUserId === b.botUserId && old.tokenHash === b.tokenHash;
        return { ...b, sealedToken: enabled && same ? old.sealedToken : null };
      });
      // the desktop is awake and runs its own sockets again
      if (!ASLEEP.has(cloud.status)) release(cloud.id);
      store.commit();
      const events: SlackEdgeEvent[] = eventsOf(cloud.id).slice(0, SLACK_EDGE_LIMITS.events).map(({ id, botId, receivedAt, sealed }) => ({ id, botId, receivedAt, sealed }));
      return { v: SLACK_EDGE_VERSION, enabled, needTokens: enabled ? reg.bots.filter(b => !b.sealedToken).map(b => b.botId) : [], events };
    },
    /** app-level tokens for bots the edge asked for; each must match the hash the last sync named */
    tokens(workspaceId: string, body: Record<string, unknown>) {
      if (body.v !== SLACK_EDGE_VERSION || !Array.isArray(body.tokens) || body.tokens.length > SLACK_EDGE_LIMITS.bots) throw new EdgeError(400, "invalid_request");
      const cloud = options.clouds.byWorkspace(workspaceId), reg = cloud ? regOf(cloud.id) : null;
      if (!cloud || !reg || !options.enabled || !reg.enabled) throw new EdgeError(409, "not_enabled");
      for (const item of body.tokens as Array<Record<string, unknown>>) {
        const bot = reg.bots.find(b => b.botId === item?.botId);
        if (!bot || typeof item.appToken !== "string" || !/^xapp-[A-Za-z0-9-]{10,250}$/.test(item.appToken) || appTokenHash(item.appToken) !== bot.tokenHash) throw new EdgeError(400, "invalid_request");
        bot.sealedToken = options.sealer.seal(item.appToken); bot.error = undefined;
      }
      store.commit();
      tick();
      return { ok: true as const };
    },
    view,
    setEnabled(cloud: StoredCloud, enabled: boolean): SlackWakeView {
      if (!options.enabled) throw new EdgeError(409, "not_available");
      if (GONE.has(cloud.status) || cloud.ended) throw new EdgeError(409, "unavailable");
      const reg = ensureReg(cloud);
      reg.enabled = enabled;
      if (!enabled) { forgetTokens(reg); release(cloud.id); }
      store.commit();
      return view(cloud);
    },
    wakeStats(): Partial<Record<Exclude<DesktopKind, "none">, WakeStat>> {
      const out: Partial<Record<Exclude<DesktopKind, "none">, WakeStat>> = {};
      for (const kind of ["shared_s", "shared_m", "dedicated"] as const) {
        const ms = state.wakes.filter(w => w.kind === kind).map(w => w.ms).sort((a, b) => a - b);
        if (ms.length < minSamples) continue;
        const at = (q: number) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))]!;
        out[kind] = { medianMs: at(0.5), p90Ms: at(0.9), samples: ms.length };
      }
      return out;
    },
    accountDeleted(cloudIds: string[]) {
      for (const cloudId of cloudIds) release(cloudId);
      state.regs = state.regs.filter(r => !cloudIds.includes(r.cloudId));
      state.events = state.events.filter(e => !cloudIds.includes(e.cloudId));
      store.commit();
    },
    tick,
    holding: (cloudId: string) => holding.has(cloudId),
    close() { closed = true; clearInterval(timer); for (const cloudId of Array.from(holding.keys())) release(cloudId); store.close(); },
  };
}
export type SlackEdge = ReturnType<typeof createSlackEdge>;
