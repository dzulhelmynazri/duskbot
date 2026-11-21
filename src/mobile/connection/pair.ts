import { observePairing } from "@/lib/product-analytics";
import { appLinkFromUniversal, parseSignInLink, DEFAULT_MOBILE_RELAY, MOBILE_LOOKUP_SALT, pairingFromPayload, parseMobilePayload, parseMobilePairingLink, type MobileRedeemRequest, type MobileRedeemResponse, type MobileCapabilities, type MobileConnectionRecord, type MobilePairingPayload, type SignInService } from "../../../shared/mobile-link";
import { randomUuid } from "@/lib/random-uuid";
import { cleanPhoneSignInCode } from "../../../shared/account-api";
import type { MobilePlatform } from "../platform";
import { createRelaySecrets, hex, hkdf, sha256hex, subtle, unbase64, unseal, UnsupportedCryptoError, utf8, type RelaySecrets } from "../transport/link-crypto";
import { open as openRelay } from "../transport/relay";
import { directStillWorthIt, routeOrder, routeTimeout } from "./route-order";

export type TypedPairing = MobilePairingPayload;
export type TypedCode = { kind: "code"; code: string };
type PairErrorCode = "expired" | "unknown" | "store-qr" | "used" | "sign-in" | "limited" | "unreachable" | "mismatch" | "refused" | "relay-unavailable" | "invalid" | "unsupported";

// the desktop's clock stamps a grant's end; a phone a little ahead of it still tries, and the desktop decides
const CLOCK_SKEW_MS = 10 * 60_000;
const lapsed = (expiresAt: number | undefined) => Boolean(expiresAt && expiresAt + CLOCK_SKEW_MS <= Date.now());

/** A grant that says when it was issued lives its lifetime from when this phone first read it, timed on the phone's
 * clock alone, so a phone or computer clock set wrong never ends it early. */
async function grantLapsed(payload: MobilePairingPayload, platform: MobilePlatform): Promise<boolean> {
  if (payload.issuedAt === undefined || !payload.grantId || !payload.expiresAt) return lapsed(payload.expiresAt);
  const key = `madani.mobile.grantSeen.${payload.grantId}`, now = Date.now();
  const seen = Number(await platform.prefs.get(key));
  if (!Number.isSafeInteger(seen) || seen <= 0 || seen > now) { await platform.prefs.set(key, String(now)); return false; }
  return now - seen >= payload.expiresAt - payload.issuedAt;
}

/** Every link attempt ends this soon: one the computer never answers says it could not be reached, with Try again. */
export const LINK_DEADLINE_MS = 15_000;

export function linkDeadline<T>(work: Promise<T>, ms = LINK_DEADLINE_MS, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = () => { clearTimeout(timer); signal?.removeEventListener("abort", canceled); };
    const canceled = () => { stop(); reject(new PairError("unreachable")); };
    const timer = setTimeout(() => { stop(); reject(new PairError("unreachable")); }, ms);
    if (signal?.aborted) { canceled(); return; }
    signal?.addEventListener("abort", canceled, { once: true });
    work.then((value) => { stop(); resolve(value); }, (error: unknown) => { stop(); reject(error); });
  });
}

/** a request's own time limit, ended early when the person cancels the link */
const limit = (ms: number, signal?: AbortSignal) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms));

export class PairError extends Error {
  readonly code: PairErrorCode;
  constructor(code: PairErrorCode) {
    super(`mobile.pair.${code}`);
    this.name = "PairError";
    this.code = code;
  }
}

/** the desktop's App Store qr, read by a phone that already has the app */
export function isStoreLink(input: string): boolean {
  return /^https:\/\/(apps\.apple\.com|play\.google\.com)\//i.test(input.trim()) || /^https:\/\/madani\.bot\/download\/?$/i.test(input.trim());
}

/** What a scanned qr is, whichever kind the desktop, the site or an older build drew: the https universal links and their
 * madanibot:// forms (a pairing, a madani cloud log in), the old store qr, or a typed code. Null for anything else. */
export type Scanned = { kind: "store" } | { kind: "signin"; email: string; code?: string; service?: SignInService; cloud?: string } | { kind: "pair"; payload: TypedPairing } | TypedCode
  /** a desktop's madani cloud code (8 letters): it logs the phone in to the account */
  | { kind: "account"; code: string };
export function readScanned(input: string): Scanned | null {
  if (isStoreLink(input)) return { kind: "store" };
  const signIn = parseSignInLink(input);
  if (signIn) return { kind: "signin", ...signIn };
  const account = cleanPhoneSignInCode(input);
  if (account) return { kind: "account", code: account };
  const parsed = parseTypedPairing(input);
  if (!parsed) return null;
  return "kind" in parsed ? parsed : { kind: "pair", payload: parsed };
}

export function parseTypedPairing(input: string): MobilePairingPayload | TypedCode | null {
  // the desktop's qr is an https link (a camera opens the app with it); the app's own scanner reads it the same way
  const value = appLinkFromUniversal(input) ?? input.trim();
  if (value.startsWith("madanibot:")) return parseMobilePairingLink(value);
  const code = value.replace(/[-\s]/g, "").toUpperCase();
  if (/^[A-Z0-9]{12}$/.test(code)) return { kind: "code", code };
  const match = /^(\S+)\s+([A-Za-z0-9]{12})$/.exec(value);
  if (!match) return null;
  try {
    const origin = new URL(match[1].includes("://") ? match[1] : `https://${match[1]}`);
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash || match[1].includes("\\")) return null;
    return { v: 1, transport: "https", origin: origin.origin, credential: "", code: match[2].toUpperCase() };
  } catch { return null; }
}

const pendingAttempts = new WeakMap<MobilePlatform, Map<string, Promise<string>>>();

const INSTALL_KEY = "madani.mobile.install";

/** this app install's own id, made on first use and kept in its preferences */
export async function installId(platform: MobilePlatform): Promise<string> {
  const saved = await platform.prefs.get(INSTALL_KEY);
  if (saved) return saved;
  const id = randomUuid();
  await platform.prefs.set(INSTALL_KEY, id);
  return id;
}

async function attemptId(payload: TypedPairing, platform: MobilePlatform, origin: string): Promise<string> {
  const digest = await subtle().digest("SHA-256", new TextEncoder().encode(payload.credential || `${origin}\0${payload.code}`));
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 12);
  const key = payload.via ? `madani.mobile.attempt.${payload.grantId}` : `madani.mobile.pairAttempt.${hash}`;
  let attempts = pendingAttempts.get(platform);
  if (!attempts) { attempts = new Map(); pendingAttempts.set(platform, attempts); }
  const existing = attempts.get(key);
  if (existing) return existing;
  const request = (async () => {
    const saved = await platform.prefs.get(key);
    if (saved) return saved;
    const id = randomUuid();
    await platform.prefs.set(key, id);
    return id;
  })().finally(() => attempts.delete(key));
  attempts.set(key, request);
  return request;
}

type PairAnswer = {
  token?: string;
  serverName?: string;
  device?: { id?: string; capabilities?: Partial<MobileCapabilities> };
  environmentId?: string;
  scopes?: string[];
  id?: string;
  capabilities?: Partial<MobileCapabilities>;
  code?: string;
  error?: string;
};

async function answerOf(response: Response): Promise<PairAnswer> {
  const answer: unknown = await response.json().catch(() => null);
  return answer && typeof answer === "object" && !Array.isArray(answer) ? answer as PairAnswer : {};
}

function responseError(status: number, answer: PairAnswer): PairError {
  const said = `${answer.code ?? ""} ${answer.error ?? ""}`;
  if (status === 410 || (status === 400 || status === 401) && /expired/i.test(said)) return new PairError("expired");
  if (status === 403 && /sign_in_instead/.test(said)) return new PairError("sign-in");
  if (status === 409) return new PairError("used");
  if (status === 429) return new PairError("limited");
  if (status === 401 || status === 403) return new PairError("refused");
  return new PairError(status >= 500 ? "unreachable" : "invalid");
}

async function redeemLegacyPairing(payload: MobilePairingPayload, platform: MobilePlatform, signal?: AbortSignal): Promise<{ record: MobileConnectionRecord; token: string }> {
  if (payload.transport === "relay") throw new PairError("relay-unavailable");
  let origin: URL;
  try {
    origin = new URL(payload.origin ?? "");
    if (!(["https:", ...(payload.transport === "companion" ? ["http:"] : [])].includes(origin.protocol)) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new PairError("invalid");
  } catch { throw new PairError("invalid"); }
  if (payload.credential ? !/^(?:madani|omb)_pair_[A-Za-z0-9_-]{43}$/.test(payload.credential) : !(payload.transport === "companion" ? /^\d{6}$/ : /^[A-Za-z0-9]{12}$/).test(payload.code ?? "")) throw new PairError("invalid");
  if (lapsed(payload.expiresAt)) throw new PairError("expired");
  try {
    const pairRequestId = await attemptId(payload, platform, origin.origin);
    const response = await fetch(`${origin.origin}/api/pair`, {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "omit", mode: "cors", redirect: "error",
      body: JSON.stringify({ ...(payload.credential ? { credential: payload.credential } : {}), ...(payload.code ? { code: payload.code } : {}), deviceName: platform.deviceName(), pairRequestId }),
      signal: limit(LINK_DEADLINE_MS, signal),
    });
    const paired = await answerOf(response);
    if (response.status !== 200 && response.status !== 201) throw responseError(response.status, paired);
    if (typeof paired.token !== "string" || !paired.token) throw new PairError("invalid");
    const sessionResponse = await fetch(`${origin.origin}/api/auth/session`, {
      headers: { Authorization: `Bearer ${paired.token}` }, credentials: "omit", mode: "cors", redirect: "error", signal: limit(LINK_DEADLINE_MS, signal),
    });
    const session = await answerOf(sessionResponse);
    const companionRefused = payload.transport === "companion" && [403, 404].includes(sessionResponse.status);
    if (!sessionResponse.ok && !companionRefused) throw responseError(sessionResponse.status, session);
    const identity = companionRefused ? {} : session;
    if (payload.environmentId && typeof identity.environmentId === "string" && payload.environmentId !== identity.environmentId) throw new PairError("mismatch");
    const advertised = { ...paired.device?.capabilities, ...paired.capabilities, ...identity.capabilities };
    const direct = payload.transport === "https";
    const capability = (key: keyof MobileCapabilities) => typeof advertised[key] === "boolean" ? advertised[key] : direct;
    const id = randomUuid();
    const now = Date.now();
    const record: MobileConnectionRecord = {
      id, environmentId: typeof identity.environmentId === "string" ? identity.environmentId : origin.origin,
      label: payload.name || (typeof paired.serverName === "string" && paired.serverName) || origin.host,
      transport: payload.transport, origin: origin.origin, sessionRef: `token.${id}`,
      ...(typeof identity.id === "string" ? { sessionId: identity.id } : typeof paired.device?.id === "string" ? { sessionId: paired.device.id } : {}),
      capabilities: {
        chat: true, uploads: true, computerView: true,
        computerControl: capability("computerControl"), routines: capability("routines"), notifications: capability("notifications"),
        settingsWrite: Array.isArray(identity.scopes) && identity.scopes.includes("admin"), openOnDesktop: false,
      },
      addedAt: now, lastUsedAt: now,
    };
    return { record, token: paired.token };
  } catch (error) {
    throw pairError(error);
  }
}

export function pairError(error: unknown): PairError {
  return error instanceof PairError ? error : new PairError(error instanceof UnsupportedCryptoError ? "unsupported" : "unreachable");
}

async function resolveTypedCodeResult(code: string, relayBase = DEFAULT_MOBILE_RELAY): Promise<MobilePairingPayload> {
  const normalized = code.replace(/[-\s]/g, "").toUpperCase();
  if (!/^[A-Z0-9]{12}$/.test(normalized)) throw new PairError("invalid");
  try {
    const id = hex(await hkdf(utf8(normalized), MOBILE_LOOKUP_SALT, "lookup", 16));
    const key = await hkdf(utf8(normalized), MOBILE_LOOKUP_SALT, "seal", 32);
    const response = await fetch(`${relayBase.replace(/\/$/, "")}/v1/lookups/${id}`, { credentials: "omit", redirect: "error", signal: AbortSignal.timeout(15_000) });
    // the relay forgets a lookup when its code ends, and never had one for a code made elsewhere (a browser's /pair code)
    if (response.status === 404) throw new PairError("unknown");
    if (!response.ok) throw responseError(response.status, await answerOf(response));
    let payload;
    try {
      const answer = await response.json() as { sealed: string };
      payload = parseMobilePayload(JSON.parse(new TextDecoder().decode(await unseal(key, id, answer.sealed))));
    } catch { throw new PairError("invalid"); }
    if (!payload) throw new PairError("invalid");
    if (payload.grant.issuedAt === undefined && lapsed(payload.grant.expiresAt)) throw new PairError("expired");
    return pairingFromPayload(payload);
  } catch (error) { throw pairError(error); }
}

const pendingKeys = new WeakMap<MobilePlatform, Map<string, Promise<RelaySecrets>>>();

export async function relaySecrets(platform: MobilePlatform, id: string): Promise<RelaySecrets> {
  let pending = pendingKeys.get(platform);
  if (!pending) { pending = new Map(); pendingKeys.set(platform, pending); }
  const existing = pending.get(id);
  if (existing) return existing;
  const request = (async () => {
    const saved = await platform.secrets.get(`relay.${id}`);
    if (saved) return JSON.parse(saved) as RelaySecrets;
    const keys = await createRelaySecrets();
    await platform.secrets.set(`relay.${id}`, JSON.stringify(keys));
    return keys;
  })().finally(() => pending.delete(id));
  pending.set(id, request);
  return request;
}

async function redeemPairingResult(payload: MobilePairingPayload, platform: MobilePlatform, signal?: AbortSignal): Promise<{ record: MobileConnectionRecord; token: string }> {
  if (!payload.via) return redeemLegacyPairing(payload, platform, signal);
  if (!payload.grantId || !payload.credential || !payload.via.length) throw new PairError("invalid");
  if (await grantLapsed(payload, platform)) throw new PairError("expired");
  try {
    const id = await attemptId(payload, platform, payload.origin ?? "");
    const grantRelay = payload.via.find((route) => route.kind === "relay");
    let keys: RelaySecrets | undefined;
    if (grantRelay) {
      try { keys = await relaySecrets(platform, id); }
      catch (error) { if (!(error instanceof UnsupportedCryptoError)) throw error; }
    }
    const request: MobileRedeemRequest = {
      secret: payload.credential, attemptId: id,
      device: { name: platform.deviceName(), platform: platform.kind === "web" ? "other" : platform.kind, app: platform.appVersion, install: await installId(platform) },
      ...(keys ? { relay: { pub: keys.pub, verifier: await sha256hex(keys.token) } } : {}),
    };
    let lastError = new PairError("unreachable");
    const startedAt = Date.now();
    for (const route of routeOrder(payload.via, platform.kind)) {
      if (signal?.aborted) break;
      if (route.kind === "relay" && !keys) { lastError = new PairError("unsupported"); continue; }
      if (route.kind === "companion" && !platform.native) { lastError = new PairError("unsupported"); continue; }
      if (!directStillWorthIt(route, payload.via, startedAt, Date.now(), platform.kind)) continue;
      let channel: ReturnType<typeof openRelay> | undefined;
      let response: Response;
      let answer: unknown;
      try {
        const headers = { "Content-Type": "application/json" };
        const body = JSON.stringify(request);
        if (route.kind === "relay") {
          const grant = openRelay(route.base, route.channel, route.token, unbase64(route.key));
          channel = grant;
          const ask = async () => {
            const reply = await grant.request("POST", "/api/mobile/redeem", headers, utf8(body), limit(12_000, signal));
            return { reply, answer: await reply.json().catch(() => null) as unknown };
          };
          ({ reply: response, answer } = await ask());
          // without its device channel the phone could never use the relay again; the same attempt asked again gets the device
          // it already opened, now with the channel once the desktop's link agent has opened it
          if (response.ok && !(answer as MobileRedeemResponse | null)?.relay) {
            const again = await ask().catch(() => null);
            if (again?.reply.ok && (again.answer as MobileRedeemResponse | null)?.relay) ({ reply: response, answer } = again);
          }
        } else {
          response = await fetch(`${route.url}/api/mobile/redeem`, { method: "POST", headers, body, credentials: "omit", redirect: "error", signal: limit(routeTimeout(route, payload.via, 15_000, platform.kind), signal) });
          answer = await response.json().catch(() => null);
        }
      } catch (error) { lastError = pairError(error); continue; }
      finally { channel?.close(); }
      if (!response.ok) throw responseError(response.status, answer && typeof answer === "object" ? answer as PairAnswer : {});
      const paired = answer as MobileRedeemResponse | null;
      if (!paired || typeof paired.token !== "string" || !paired.token || typeof paired.device?.id !== "string" || typeof paired.workspace?.name !== "string" || !Array.isArray(paired.scopes)) throw new PairError("invalid");
      if (payload.environmentId && paired.workspace.environmentId && payload.environmentId !== paired.workspace.environmentId) throw new PairError("mismatch");
      const origin = route.kind === "relay" ? undefined : route.url;
      const relay = paired.relay ?? (route.kind === "relay" ? { base: route.base, channel: route.channel } : undefined);
      const now = Date.now();
      const record: MobileConnectionRecord = {
        id, environmentId: paired.workspace.environmentId ?? origin ?? relay!.channel, label: paired.workspace.name,
        transport: route.kind, ...(origin ? { origin } : {}), ...(relay ? { relay } : {}), via: payload.via,
        deviceId: paired.device.id, sessionRef: `token.${id}`,
        capabilities: {
          chat: true, uploads: true, computerView: true, computerControl: route.kind !== "companion", routines: route.kind !== "companion",
          notifications: route.kind !== "companion", settingsWrite: paired.scopes.includes("admin"), openOnDesktop: false,
        },
        addedAt: now, lastUsedAt: now,
      };
      return { record, token: paired.token };
    }
    throw lastError;
  } catch (error) { throw pairError(error); }
}

export const resolveTypedCode = (code: string, relayBase = DEFAULT_MOBILE_RELAY) => observePairing(() => linkDeadline(resolveTypedCodeResult(code, relayBase)));
export const redeemPairing = (payload: MobilePairingPayload, platform: MobilePlatform, signal?: AbortSignal) =>
  observePairing(() => linkDeadline(redeemPairingResult(payload, platform, signal), LINK_DEADLINE_MS, signal));
