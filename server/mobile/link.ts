// Phones paired with this workspace (shared/mobile-link.ts): short-lived grants, the devices they opened, the relay
// channels the vps link agent serves for them, and push registrations.
//
// Security: a device is its workspace session (server/sessions.ts, hashed token, revocable); every request it makes is
// authorized by that session exactly as any remote client's. The relay agent learns only channel ids, token verifiers,
// phone public keys and, for a grant's five minutes, that grant's channel key. Grant channels reach redeem and nothing else
// (apps/link-service/agent.mjs).
import { createHash, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { z } from "zod";

import {
  DEFAULT_MOBILE_RELAY,
  MOBILE_GRANT_TTL_MS,
  MOBILE_LINK_VERSION,
  MOBILE_PLATFORMS,
  PUSH_SERVICES,
  mobileLinkUrl,
  mobileTransports,
  type MobileDevice,
  type MobileLinkPayload,
  type MobilePairingResponse,
  type MobileRedeemResponse,
  type MobileRoutesResponse,
  type MobileTransport,
} from "../../shared/mobile-link.ts";
import type { CompanionEndpoint } from "../../shared/pairing-link.ts";
import type { NotificationLogEntry } from "../../shared/notification.ts";
import { labelFromUserAgent, ownerOrAdmin, requestSource, type RequestAuth } from "../request-auth.ts";
import { cloudPowerNow } from "../cloud-power.ts";
import { formatPairingCode, type Scope, type SessionRegistry } from "../sessions.ts";
import { postLookup } from "./lookup.ts";
import { createPhonePresence } from "./presence.ts";
import { createPushSender, pushRelayBase, type PushMessage, type PushSender } from "./push.ts";
import { createTurnActivities } from "./turn-activity.ts";
import type { TurnActivityAttributes, TurnActivityEvent } from "../../shared/phone-activity.ts";

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const B64URL_KEY = /^[A-Za-z0-9_-]{43}$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** an agent that has not asked for news this long is gone, and the relay leaves the pairing payload */
const AGENT_LIVE_MS = 40_000;
/** under the 15 s the phone apps wait for a relay answer: a redeem answered without its channel leaves the phone on
 * Wi-Fi alone for good */
const APPLY_WAIT_MS = 10_000;
const SYNC_WAIT_MAX_S = 25;
const MAX_DEVICES = 24;
/** a push the service could not take is tried again after these */
const PUSH_RETRY_MS = [10_000, 60_000];
/** a notification waits this long before it pushes, so one read right away (on any device) never buzzes */
export const PUSH_GRACE_MS = 4_000;

const relayId = () => Array.from(randomBytes(10), (byte) => B32[byte & 31]).join("");

const INSTALL_ID = /^[A-Za-z0-9-]{16,64}$/;
const deviceSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().min(1),
  name: z.string().max(80),
  platform: z.enum(MOBILE_PLATFORMS),
  app: z.string().max(40).optional(),
  install: z.string().regex(INSTALL_ID).optional(),
  createdAt: z.number(),
  relay: z.object({ channel: z.string().regex(/^[a-z2-7]{10}$/), verifier: z.string().regex(HEX64), pub: z.string().regex(B64URL_KEY) }).nullable(),
  push: z.object({ service: z.enum(PUSH_SERVICES), token: z.string().min(8).max(4096), environment: z.enum(["sandbox", "production"]).optional(), updatedAt: z.number() }).nullable(),
  /** the iPhone's Live Activity push-to-start token */
  activityStart: z.object({ token: z.string().min(8).max(4096), environment: z.enum(["sandbox", "production"]).optional(), updatedAt: z.number() }).nullable().optional(),
});
type DeviceRecord = z.infer<typeof deviceSchema>;
const fileSchema = z.object({ v: z.literal(1), devices: z.array(deviceSchema) });

/** the channel set the agent should serve, as POST /api/mobile/relay/sync answers it */
export type RelayChannel =
  | { id: string; kind: "grant"; verifier: string; key: string; expiresAt: number }
  | { id: string; kind: "device"; verifier: string; pub: string };

interface Grant { pairingId: string; channel: { id: string; verifier: string; key: string } | null; expiresAt: number }
interface Agent { base: string; tunnel: string; pub: string; origin: string | null; spki: string | null; seenAt: number }

export interface MobileLinkDeps {
  dataDir: string;
  sessions: Pick<SessionRegistry, "openPairing" | "exchange" | "list" | "isLive" | "revoke" | "onSessionRevoked" | "holdForPairedDevice">;
  workspace(): { name: string; environmentId: string | null; kind: "mac" | "server" };
  /** this server's own https origin when it has one */
  publicOrigin(): string | null;
  /** why phones may not pair here at all (a hosted or team workspace has its own sign-in), else null */
  refusal(): string | null;
  /** the relay that holds typed-code lookups; null turns typed codes off */
  lookupRelay: string | null;
  /** the Mac companion's addresses now, null when the desktop does not say (a server has none) */
  companion?: () => Promise<CompanionEndpoint[] | null>;
  push?: PushSender;
  /** whether the person already read this notification (on any device) */
  isRead?: (notificationId: string) => boolean;
  /** A madani cloud: its phones sign in with the account instead of pairing, so a phone's own bearer session may ask for a
   * relay channel, and is listed as a phone once it does. */
  adoptSessions?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

let activeNotify: ((notification: NotificationLogEntry, options: { adminOnly?: boolean; person?: string }) => void) | null = null;
let activeRead: ((ids: readonly string[]) => void) | null = null;
let activeTurnActivity: ((threadId: string, event: TurnActivityEvent, context: { attributes?: TurnActivityAttributes; reply?: string }) => void) | null = null;

/** a turn's progress, for the Live Activities phones show for its thread; a no-op until a workspace link exists */
export function turnActivityToPhones(threadId: string, event: TurnActivityEvent, context: { attributes?: TurnActivityAttributes; reply?: string } = {}): void {
  activeTurnActivity?.(threadId, event, context);
}

/** the event stream's `notify` frames, fanned out to registered phones; a no-op until a workspace link exists */
export function notifyPhones(notification: unknown, options: { adminOnly?: boolean; person?: string } = {}): void {
  const entry = notification as NotificationLogEntry | null;
  if (activeNotify && entry && typeof entry.id === "string" && typeof entry.threadId === "string") activeNotify(entry, options);
}

/** the event stream's `notifications.read` frames: a notification read anywhere never pushes after that */
export function readOnPhones(ids: unknown): void {
  if (activeRead && Array.isArray(ids)) activeRead(ids.filter((id): id is string => typeof id === "string"));
}

/** MADANI_MOBILE_RELAY: the relay that holds typed-code lookups when no link agent names one ("default" for the public one,
 * "none" for no typed codes); unset, the desktop app uses the public one and a server none */
export function mobileLookupRelay(env: NodeJS.ProcessEnv = process.env, desktop = false): string | null {
  const value = env.MADANI_MOBILE_RELAY?.trim();
  if (value === "default" || (!value && desktop)) return DEFAULT_MOBILE_RELAY;
  return value && /^https?:\/\/[^/\s]+$/.test(value) ? value : null;
}

type Json = (res: import("node:http").ServerResponse, status: number, body: unknown) => void;
type ReadBody = (req: IncomingMessage, limit?: number) => Promise<unknown>;

export function createMobileLink(deps: MobileLinkDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.warn(line));
  const push = deps.push ?? createPushSender(process.env, { relay: () => pushRelayBase(process.env, agentLive()?.base ?? deps.lookupRelay ?? DEFAULT_MOBILE_RELAY) });
  const file = join(deps.dataDir, "mobile-devices.json");
  let devices: DeviceRecord[] = load();
  for (const device of devices) deps.sessions.holdForPairedDevice(device.sessionId);
  const grants = new Map<string, Grant>();
  let agent: Agent | null = null;
  let rev = 1, applied = 0, failed = new Set<string>();
  const syncWaiters = new Set<() => void>();
  const applyWaiters = new Set<() => void>();
  const pushed = new Set<string>();
  const presence = createPhonePresence({ now });
  /** pushes waiting out their grace, one per phone and conversation: a newer notification there replaces the older */
  const waiting = new Map<string, { timer: ReturnType<typeof setTimeout>; id: string }>();
  /** not read on any device, and the phone is not open on that conversation */
  const stillNews = (device: DeviceRecord, message: PushMessage) => !deps.isRead?.(message.id) && !presence.viewing(device.id, message.threadId);

  function later(device: DeviceRecord, message: PushMessage) {
    const key = `${device.id}\n${message.threadId}`;
    clearTimeout(waiting.get(key)?.timer);
    const timer = setTimeout(() => {
      if (waiting.get(key)?.timer === timer) waiting.delete(key);
      if (devices.includes(device) && device.push && stillNews(device, message)) void deliver(device, message);
    }, PUSH_GRACE_MS);
    timer.unref?.();
    waiting.set(key, { timer, id: message.id });
  }
  /** a phone showing this conversation that then goes quiet without saying it went away was likely suspended before it
   * could, and never saw this: it gets the push. One that checks in again was open and showed it. */
  function unlessCheckedIn(device: DeviceRecord, message: PushMessage) {
    const at = now();
    const timer = setTimeout(() => {
      if (!devices.includes(device) || !device.push || presence.reportedSince(device.id, at) || deps.isRead?.(message.id)) return;
      void deliver(device, message);
    }, Math.max(0, presence.overdueIn(device.id)));
    timer.unref?.();
  }
  function read(ids: readonly string[]) {
    const done = new Set(ids);
    for (const [key, one] of waiting) if (done.has(one.id)) { clearTimeout(one.timer); waiting.delete(key); }
  }
  const activities = createTurnActivities({
    now,
    send: (target, message) => push.sendActivity?.({ service: "apns", ...target }, message) ?? Promise.resolve("skipped"),
    startTargets: () => {
      const live = new Set(deps.sessions.list().map((session) => session.id));
      return devices.flatMap((device) => device.activityStart && live.has(device.sessionId) && presence.away(device.id)
        ? [{ deviceId: device.id, token: device.activityStart.token, ...(device.activityStart.environment ? { environment: device.activityStart.environment } : {}) }]
        : []);
    },
  });

  /** sends now; a push the service could not take goes again at 10 s and 60 s while it is still news to the phone */
  function deliver(device: DeviceRecord, message: PushMessage, attempt = 0): Promise<void> {
    const registration = device.push;
    if (!registration) return Promise.resolve();
    return push.send({ service: registration.service, token: registration.token, ...(registration.environment ? { environment: registration.environment } : {}) }, message)
      .catch(() => "failed" as const)
      .then((outcome) => {
        if (outcome === "gone" && device.push === registration) { device.push = null; persist(); }
        const wait = PUSH_RETRY_MS[attempt];
        if (outcome !== "failed" || wait === undefined) return;
        const timer = setTimeout(() => {
          if (device.push !== registration || !devices.includes(device) || !stillNews(device, message)) return;
          void deliver(device, message, attempt + 1);
        }, wait);
        timer.unref?.();
      });
  }

  function load(): DeviceRecord[] {
    try {
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (parsed.success) return parsed.data.devices;
      log("mobile: mobile-devices.json is not readable; starting with no phones");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") log(`mobile: could not read phones (${(error as Error).message})`);
    }
    return [];
  }
  function persist() {
    mkdirSync(deps.dataDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, devices }), { mode: 0o600 });
    renameSync(tmp, file);
  }
  function bump() {
    rev += 1;
    for (const wake of syncWaiters) wake();
    syncWaiters.clear();
  }

  /** devices whose session ended some other way (expiry, the session list in settings) go with it */
  function prune(): boolean {
    const live = devices.filter((device) => deps.sessions.isLive(device.sessionId));
    if (live.length === devices.length) return false;
    for (const device of devices) if (!live.includes(device)) { presence.forget(device.id); activities.forgetDevice(device.id); }
    devices = live;
    persist();
    bump();
    return true;
  }
  deps.sessions.onSessionRevoked((sessionId) => {
    if (!devices.some((device) => device.sessionId === sessionId)) return;
    for (const device of devices) if (device.sessionId === sessionId) { presence.forget(device.id); activities.forgetDevice(device.id); }
    devices = devices.filter((device) => device.sessionId !== sessionId);
    persist();
    bump();
  });

  function agentLive(): Agent | null {
    return agent && (now() - agent.seenAt < AGENT_LIVE_MS || syncWaiters.size > 0) ? agent : null;
  }

  /** resolves once the agent registered `wanted` with the relay; false when it did not in time or the relay refused */
  function applied_(wanted: number, channel: string): Promise<boolean> {
    if (applied >= wanted) return Promise.resolve(!failed.has(channel));
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); applyWaiters.delete(check); resolve(applied >= wanted && !failed.has(channel)); };
      const check = () => { if (applied >= wanted) done(); };
      const timer = setTimeout(done, APPLY_WAIT_MS);
      timer.unref?.();
      applyWaiters.add(check);
    });
  }

  function channels(): RelayChannel[] {
    const out: RelayChannel[] = [];
    for (const [id, grant] of grants) {
      // a redeemed grant keeps its channel until it expires, so the redeem answer can still travel back over it
      if (grant.expiresAt <= now()) { grants.delete(id); continue; }
      if (grant.channel) out.push({ id: grant.channel.id, kind: "grant", verifier: grant.channel.verifier, key: grant.channel.key, expiresAt: grant.expiresAt });
    }
    for (const device of devices) if (device.relay) out.push({ id: device.relay.channel, kind: "device", verifier: device.relay.verifier, pub: device.relay.pub });
    return out;
  }

  function publicDevice(device: DeviceRecord): MobileDevice | null {
    const session = deps.sessions.list().find((one) => one.id === device.sessionId);
    if (!session) return null;
    return { id: device.id, name: device.name, platform: device.platform, createdAt: device.createdAt, lastSeenAt: session.lastSeenAt, expiresAt: session.expiresAt, relay: Boolean(device.relay), push: device.push?.service ?? null };
  }

  function workspace(): MobileLinkPayload["workspace"] {
    const own = deps.workspace();
    // a desktop serves its phones through its own relay hub too, and stays a computer to them
    return { name: own.name.slice(0, 80), environmentId: own.environmentId, kind: own.kind === "server" && agentLive() ? "vps" : own.kind };
  }

  function httpsRoutes(): MobileTransport[] {
    const relay = agentLive();
    return mobileTransports([deps.publicOrigin(), relay?.origin ?? null].filter((url): url is string => typeof url === "string")
      .map((url) => ({ kind: "https", url, ...(url === relay?.origin && relay.spki ? { spki: relay.spki } : {}) })));
  }

  async function routes(device: DeviceRecord | null): Promise<MobileRoutesResponse> {
    const companion = deps.companion ? await deps.companion().catch(() => null) : null;
    const isHttps = (route: MobileTransport): route is MobileRoutesResponse["https"][number] => route.kind === "https";
    const isCompanion = (route: MobileTransport): route is NonNullable<MobileRoutesResponse["companion"]>[number] => route.kind === "companion";
    return {
      https: httpsRoutes().filter(isHttps),
      companion: companion ? mobileTransports(companion.slice(0, 16).map((one) => ({ ...one, kind: "companion", net: one.kind }))).filter(isCompanion) : null,
      ...relayOf(device),
    };
  }

  function relayOf(device: DeviceRecord | null): Pick<MobileRoutesResponse, "relay"> {
    const relay = agentLive();
    if (!relay) return {};
    return { relay: device?.relay && !failed.has(device.relay.channel) ? { base: relay.base, channel: device.relay.channel, agentPub: relay.pub } : null };
  }

  /** a paired phone with no relay channel (paired while this place had no relay, or its keys lost) asks for one */
  async function relayFor(device: DeviceRecord, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    if (typeof body.pub !== "string" || !usableX25519(body.pub) || typeof body.verifier !== "string" || !HEX64.test(body.verifier)) return { status: 400, body: { error: "relay needs pub (base64url x25519) and verifier (sha256 hex)" } };
    const relay = agentLive();
    if (!relay) return { status: 409, body: { error: "This place has no relay right now.", code: "no_relay" } };
    if (!devices.includes(device)) { devices.push(device); deps.sessions.holdForPairedDevice(device.sessionId); }
    device.relay = { channel: device.relay && !failed.has(device.relay.channel) ? device.relay.channel : relayId(), verifier: body.verifier, pub: body.pub };
    persist();
    bump();
    if (!await applied_(rev, device.relay.channel)) return { status: 503, body: { error: "The relay did not take this phone yet.", code: "not_applied" } };
    return { status: 200, body: { base: relay.base, channel: device.relay.channel, agentPub: relay.pub } };
  }

  async function pairing(auth: RequestAuth, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    if (!ownerOrAdmin(auth) || (auth.kind === "loopback" && auth.companionDevice)) return { status: 403, body: { error: "Only the owner or an admin can pair a phone." } };
    const refusal = deps.refusal();
    if (refusal) return { status: 403, body: { error: refusal, code: "sign_in_instead" } };
    prune();
    if (devices.length >= MAX_DEVICES) return { status: 409, body: { error: `This workspace already has ${MAX_DEVICES} phones. Remove one first.` } };
    const allowed: Scope[] = auth.kind === "loopback" ? ["admin", "client"] : auth.scopes.filter((scope): scope is Scope => scope === "admin" || scope === "client");
    const asked = Array.isArray(body.scopes) ? body.scopes.filter((scope): scope is Scope => scope === "admin" || scope === "client") : allowed;
    const scopes = asked.filter((scope) => allowed.includes(scope));
    if (!scopes.length) return { status: 400, body: { error: "scopes must be admin and/or client" } };
    if (!scopes.includes("client")) scopes.push("client");
    const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 60) : "Phone";
    const companion = Array.isArray(body.companion) ? body.companion.slice(0, 16).map((one) => ({ ...(one as object), kind: "companion", net: (one as { kind?: unknown })?.kind })) : [];

    const opened = deps.sessions.openPairing({ scopes, label, ttlMs: MOBILE_GRANT_TTL_MS });
    const relay = agentLive();
    const grant: Grant = { pairingId: opened.id, channel: null, expiresAt: opened.expiresAt };
    let relayTransport: MobileTransport | null = null;
    if (relay) {
      const token = randomBytes(32).toString("base64url");
      grant.channel = { id: relayId(), verifier: sha256hex(token), key: randomBytes(32).toString("base64url") };
      grants.set(opened.id, grant);
      bump();
      if (await applied_(rev, grant.channel.id)) relayTransport = { kind: "relay", base: relay.base, channel: grant.channel.id, token, key: grant.channel.key };
      else log("mobile: the link agent did not open the pairing's relay channel in time");
    }
    const via = mobileTransports([...httpsRoutes(), ...(relayTransport ? [relayTransport] : []), ...companion]);
    if (!via.length) {
      grants.delete(opened.id);
      return { status: 409, body: { error: "A phone cannot reach this workspace yet: turn on phone access or give it a public address first.", code: "unreachable" } };
    }
    const payload: MobileLinkPayload = { v: MOBILE_LINK_VERSION, workspace: workspace(), grant: { id: opened.id, secret: opened.credential, expiresAt: opened.expiresAt, issuedAt: now() }, via };
    const lookupBase = relay?.base ?? deps.lookupRelay;
    const typed = lookupBase && await postLookup(lookupBase, opened.code, payload, opened.expiresAt - now(), deps.fetch) ? formatPairingCode(opened.code) : null;
    const answer: MobilePairingResponse = { payload, link: mobileLinkUrl(payload), code: typed, expiresAt: opened.expiresAt };
    return { status: 200, body: answer };
  }

  async function redeem(req: IncomingMessage, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    const refusal = deps.refusal();
    if (refusal) return { status: 403, body: { error: refusal, code: "sign_in_instead" } };
    const secret = typeof body.secret === "string" ? body.secret.slice(0, 200) : "";
    const attemptId = typeof body.attemptId === "string" ? body.attemptId : undefined;
    const device = body.device as Record<string, unknown> | undefined;
    const name = typeof device?.name === "string" ? device.name.slice(0, 80) : "";
    const platform = MOBILE_PLATFORMS.find((one) => one === device?.platform) ?? "other";
    const app = typeof device?.app === "string" ? device.app.replace(/[^\w .+-]/g, "").slice(0, 40) : undefined;
    const install = typeof device?.install === "string" && INSTALL_ID.test(device.install) ? device.install : undefined;
    const relayAsk = body.relay as Record<string, unknown> | undefined;
    if (relayAsk !== undefined && (typeof relayAsk?.pub !== "string" || !usableX25519(relayAsk.pub) || typeof relayAsk.verifier !== "string" || !HEX64.test(relayAsk.verifier))) {
      return { status: 400, body: { error: "relay needs pub (base64url x25519) and verifier (sha256 hex)" } };
    }
    if (!secret) return { status: 400, body: { error: "secret is required" } };
    const exchanged = deps.sessions.exchange({ code: secret, label: name, attemptId, source: requestSource(req), fallbackLabel: labelFromUserAgent(req.headers["user-agent"]) });
    // a wrong secret here is an expired or already used grant (the phone only has what the desktop made): 410 reads as
    // expired on every app version, where 401 read as "refused"
    if (!exchanged.ok) return exchanged.status === 401 ? { status: 410, body: { error: exchanged.error, code: "expired" } } : { status: exchanged.status, body: { error: exchanged.error } };
    deps.sessions.holdForPairedDevice(exchanged.session.id);
    // a retried attempt gets the device it already opened
    let record = devices.find((one) => one.sessionId === exchanged.session.id);
    if (!record) {
      record = { id: randomUUID(), sessionId: exchanged.session.id, name: exchanged.session.label, platform, ...(app ? { app } : {}), ...(install ? { install } : {}), createdAt: now(), relay: null, push: null };
      devices.push(record);
      const kept = record;
      if (install) for (const replaced of devices.filter((one) => one !== kept && one.install === install)) revoke(replaced.id);
    }
    const relay = agentLive();
    let relayAnswer: MobileRedeemResponse["relay"];
    if (relayAsk && relay) {
      record.relay ??= { channel: relayId(), verifier: String(relayAsk.verifier), pub: String(relayAsk.pub) };
      persist();
      bump();
      if (await applied_(rev, record.relay.channel)) relayAnswer = { base: relay.base, channel: record.relay.channel, agentPub: relay.pub };
    } else persist();
    const answer: MobileRedeemResponse = {
      token: exchanged.token,
      device: publicDevice(record)!,
      workspace: workspace(),
      scopes: exchanged.session.scopes,
      ...(relayAnswer ? { relay: relayAnswer } : {}),
    };
    return { status: 200, body: answer };
  }

  function revoke(id: string): boolean {
    const device = devices.find((one) => one.id === id);
    if (!device) return false;
    presence.forget(id);
    activities.forgetDevice(id);
    devices = devices.filter((one) => one.id !== id);
    persist();
    bump();
    deps.sessions.revoke(device.sessionId);
    return true;
  }

  async function sync(body: Record<string, unknown>, closed: AbortSignal): Promise<{ status: number; body: unknown }> {
    const base = typeof body.base === "string" && /^https?:\/\/[^/\s]+$/.test(body.base) ? body.base : null;
    const tunnel = typeof body.tunnel === "string" && /^[a-z2-7]{10}$/.test(body.tunnel) ? body.tunnel : null;
    const pub = typeof body.pub === "string" && B64URL_KEY.test(body.pub) ? body.pub : null;
    if (!base || !tunnel || !pub) return { status: 400, body: { error: "base, tunnel and pub are required" } };
    const origin = typeof body.origin === "string" && /^https:\/\/[a-z0-9.-]+$/.test(body.origin) ? body.origin : null;
    const spki = typeof body.spki === "string" && /^[A-Za-z0-9+/]{43}=$/.test(body.spki) ? body.spki : null;
    agent = { base, tunnel, pub, origin, spki, seenAt: now() };
    const done = Number.isSafeInteger(body.applied) ? Number(body.applied) : 0;
    if (done > applied && done <= rev) {
      applied = done;
      failed = new Set(Array.isArray(body.failed) ? body.failed.filter((id): id is string => typeof id === "string") : []);
      for (const check of Array.from(applyWaiters)) check();
    }
    prune();
    const wait = Math.min(SYNC_WAIT_MAX_S, Math.max(0, Number(body.wait) || 0)) * 1000;
    if (rev <= done && wait > 0) {
      await new Promise<void>((resolve) => {
        const finish = () => { clearTimeout(timer); syncWaiters.delete(finish); closed.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, wait);
        syncWaiters.add(finish);
        closed.addEventListener("abort", finish, { once: true });
      });
      if (agent) agent.seenAt = now();
    }
    return { status: 200, body: { rev, channels: channels() } };
  }

  async function notify(notification: NotificationLogEntry, options: { adminOnly?: boolean; person?: string } = {}) {
    if (options.person || notification.forPerson || pushed.has(notification.id)) return;
    pushed.add(notification.id);
    if (pushed.size > 500) pushed.delete(pushed.values().next().value!);
    const targets = devices.filter((device) => device.push);
    if (!targets.length) return;
    const sessions = new Map(deps.sessions.list().map((session) => [session.id, session]));
    const message: PushMessage = { id: notification.id, kind: notification.kind, title: notification.title, botId: notification.botId, botName: notification.botName, threadId: notification.threadId, ...(notification.groupId ? { groupId: notification.groupId } : {}), ...(notification.requestId ? { requestId: notification.requestId } : {}) };
    await Promise.all(targets.map((device) => {
      const session = sessions.get(device.sessionId);
      if (!session || (options.adminOnly && !session.scopes.includes("admin")) || !device.push) return;
      if (!presence.viewing(device.id, message.threadId)) later(device, message);
      else unlessCheckedIn(device, message);
    }));
  }

  const deviceOf = (auth: RequestAuth) => (auth.kind === "session" ? devices.find((device) => device.sessionId === auth.session.id) ?? null : null);
  const adoptable = (auth: RequestAuth) => Boolean(deps.adoptSessions) && auth.kind === "session" && auth.via === "bearer";
  /** a cloud phone's own session, listed as a phone the first time it asks for a relay channel */
  function adopt(auth: RequestAuth): DeviceRecord | null {
    if (auth.kind !== "session" || devices.length >= MAX_DEVICES) return null;
    return { id: randomUUID(), sessionId: auth.session.id, name: auth.session.label.slice(0, 80), platform: "other", createdAt: now(), relay: null, push: null };
  }

  activeNotify = (notification, options) => { void notify(notification, options).catch((error) => log(`mobile: push failed (${(error as Error).message})`)); };
  activeTurnActivity = (threadId, event, context) => activities.event(threadId, event, context);
  activeRead = read;

  return {
    /** the channel sync of a phone hub running in this process (a madani cloud's), as POST /api/mobile/relay/sync answers it */
    async relaySync(input: Record<string, unknown>): Promise<unknown> {
      const closed = new AbortController();
      if (input.signal instanceof AbortSignal) input.signal.addEventListener("abort", () => closed.abort(), { once: true });
      const answer = await sync(input, closed.signal);
      if (answer.status !== 200) throw new Error(`phone sync answered ${answer.status}`);
      return answer.body;
    },
    /** POST /api/mobile/redeem, before the auth gate: the grant's secret is the authorization */
    async publicRoute(req: IncomingMessage, res: import("node:http").ServerResponse, path: string, method: string, json: Json, readBody: ReadBody): Promise<boolean> {
      if (path !== "/api/mobile/redeem") return false;
      if (method !== "POST") { json(res, 405, { error: "method not allowed" }); return true; }
      if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) { json(res, 415, { error: "send JSON" }); return true; }
      const body = await readBody(req, 16_384) as Record<string, unknown> | null;
      const answer = await redeem(req, body && typeof body === "object" ? body : {});
      if (answer.status !== 200) log(`mobile: redeem refused from ${requestSource(req)} (${answer.status})`);
      res.setHeader("cache-control", "no-store");
      json(res, answer.status, answer.body);
      return true;
    },
    /** behind the auth gate */
    async route(ctx: { req: IncomingMessage; res: import("node:http").ServerResponse; path: string; method: string; auth: RequestAuth; json: Json; readBody: ReadBody }): Promise<boolean> {
      const { req, res, path, method, auth, json } = ctx;
      if (!path.startsWith("/api/mobile/")) return false;
      const body = async () => { const value = await ctx.readBody(req, 64_000); return value && typeof value === "object" ? value as Record<string, unknown> : {}; };
      res.setHeader("cache-control", "no-store");
      if (path === "/api/mobile/pairing" && method === "POST") { const answer = await pairing(auth, await body()); json(res, answer.status, answer.body); return true; }
      if (path === "/api/mobile/devices" && method === "GET") {
        if (!ownerOrAdmin(auth)) { json(res, 403, { error: "Only the owner or an admin can see phones." }); return true; }
        prune();
        json(res, 200, { devices: devices.map(publicDevice).filter(Boolean), current: deviceOf(auth)?.id ?? null });
        return true;
      }
      const one = /^\/api\/mobile\/devices\/([\w-]{1,64})$/.exec(path);
      if (one && method === "DELETE") {
        const own = deviceOf(auth)?.id === one[1];
        if (!own && !ownerOrAdmin(auth)) { json(res, 403, { error: "Only the owner or an admin can remove a phone." }); return true; }
        const removed = revoke(one[1]);
        json(res, removed ? 200 : 404, removed ? { ok: true } : { error: "no such phone" });
        return true;
      }
      if (path === "/api/mobile/routes" && method === "GET") {
        const device = deviceOf(auth);
        if (!device && !adoptable(auth)) { json(res, 404, { error: "this session is not a paired phone" }); return true; }
        json(res, 200, await routes(device));
        return true;
      }
      if (path === "/api/mobile/relay" && method === "POST") {
        const device = deviceOf(auth) ?? (adoptable(auth) ? adopt(auth) : null);
        if (!device) { json(res, 404, { error: "this session is not a paired phone" }); return true; }
        const answer = await relayFor(device, await body());
        json(res, answer.status, answer.body);
        return true;
      }
      if (path === "/api/mobile/device" && method === "GET") {
        const device = deviceOf(auth);
        json(res, device ? 200 : 404, device ? { device: publicDevice(device) } : { error: "this session is not a paired phone" });
        return true;
      }
      if (path === "/api/mobile/push" && (method === "PUT" || method === "DELETE")) {
        const device = deviceOf(auth);
        if (!device) { json(res, 403, { error: "only a paired phone registers for push" }); return true; }
        if (method === "DELETE") { device.push = null; persist(); json(res, 200, { ok: true }); return true; }
        const value = await body();
        const service = PUSH_SERVICES.find((one) => one === value.service);
        const token = typeof value.token === "string" ? value.token.trim() : "";
        const environment = value.environment === "sandbox" || value.environment === "production" ? value.environment : undefined;
        if (!service || !/^[\w:.-]{8,4096}$/.test(token)) { json(res, 400, { error: "service must be apns or fcm, with its device token" }); return true; }
        device.push = { service, token, ...(environment ? { environment } : {}), updatedAt: now() };
        for (const replaced of devices.filter((one) => one !== device && one.push?.service === service && one.push.token === token)) revoke(replaced.id);
        persist();
        json(res, 200, { ok: true, delivering: push.delivers?.(service) ?? push.configured.includes(service) });
        return true;
      }
      if ((path === "/api/mobile/activity" || path === "/api/mobile/activity-start") && (method === "PUT" || method === "DELETE")) {
        const device = deviceOf(auth);
        if (!device || device.platform !== "ios") { json(res, 403, { error: "only a paired iPhone shows Live Activities" }); return true; }
        const value = await body();
        const token = typeof value.token === "string" ? value.token.trim() : "";
        const environment = value.environment === "sandbox" || value.environment === "production" ? value.environment : undefined;
        if (path === "/api/mobile/activity-start") {
          if (method === "DELETE") device.activityStart = null;
          else if (/^[0-9a-f]{16,512}$/i.test(token)) device.activityStart = { token, ...(environment ? { environment } : {}), updatedAt: now() };
          else { json(res, 400, { error: "token must be the push-to-start token, hex" }); return true; }
          persist();
          json(res, 200, { ok: true });
          return true;
        }
        const threadId = typeof value.threadId === "string" && /^[\w:.-]{1,128}$/.test(value.threadId) ? value.threadId : null;
        if (!threadId) { json(res, 400, { error: "threadId is required" }); return true; }
        if (method === "DELETE") { activities.unregister(device.id, threadId); json(res, 200, { ok: true }); return true; }
        if (!/^[0-9a-f]{16,512}$/i.test(token)) { json(res, 400, { error: "token must be the activity's push token, hex" }); return true; }
        activities.register(device.id, {
          threadId, token, ...(environment ? { environment } : {}),
          ...(typeof value.key === "string" ? { key: value.key } : {}),
          ...(typeof value.startedAt === "number" ? { startedAt: value.startedAt } : {}),
        });
        json(res, 200, { ok: true, delivering: push.delivers?.("apns") ?? push.configured.includes("apns") });
        return true;
      }
      if (path === "/api/mobile/presence" && method === "PUT") {
        const device = deviceOf(auth);
        if (!device) { json(res, 403, { error: "only a paired phone reports where it is" }); return true; }
        const value = await body();
        if (typeof value.away !== "boolean") { json(res, 400, { error: "away must be true or false" }); return true; }
        const viewing = value.threadId ?? null;
        if (viewing !== null && (typeof viewing !== "string" || !/^[\w:.-]{1,128}$/.test(viewing))) { json(res, 400, { error: "threadId must be a conversation id or null" }); return true; }
        presence.report(device.id, value.away, viewing);
        // the app open in the foreground on a Cloud home: the same hint as the desktop's focus, never someone using it
        if (!value.away) cloudPowerNow()?.noteFocus?.();
        json(res, 200, { ok: true });
        return true;
      }
      if (path === "/api/mobile/relay/sync" && method === "POST") {
        // the link agent on this server only: owner-trust loopback, never a session, a companion phone or a service caller
        if (auth.kind !== "loopback" || auth.trust === "service" || auth.companionDevice) { json(res, 403, { error: "only the link agent on this server" }); return true; }
        const closed = new AbortController();
        res.once("close", () => closed.abort());
        const answer = await sync(await body(), closed.signal);
        if (!res.writableEnded && !res.destroyed) json(res, answer.status, answer.body);
        return true;
      }
      return false;
    },
    notify: (notification: NotificationLogEntry, options?: { adminOnly?: boolean; person?: string }) => notify(notification, options),
    /** these notifications were read somewhere: their pushes still waiting out the grace never go */
    read,
    turnActivity: (threadId: string, event: TurnActivityEvent, context?: { attributes?: TurnActivityAttributes; reply?: string }) => activities.event(threadId, event, context),
    /** for tests */
    activities: (threadId: string) => activities.state(threadId),
    /** for tests */
    state: () => ({ rev, applied, devices: devices.map((device) => ({ ...device })), grants: grants.size, agent }),
  };
}

/** a low-order point (all zeros, say) makes every agreement fail, so the agent could never derive this phone's key */
function usableX25519(pub: string): boolean {
  if (!B64URL_KEY.test(pub)) return false;
  try {
    const mine = generateKeyPairSync("x25519");
    diffieHellman({ privateKey: mine.privateKey, publicKey: createPublicKey({ key: { kty: "OKP", crv: "X25519", x: pub }, format: "jwk" }) });
    return true;
  } catch {
    return false;
  }
}

function sha256hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
