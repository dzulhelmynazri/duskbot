import { configure as configureAnalytics } from "@/lib/product-analytics";
import { parseUserAvatarChoice } from "../../../shared/user-avatar";
import { cleanCode, cleanEmail, parseSignInStart, SIGN_IN_TRIES, startFailure, verifyFailure } from "../../../electron/cloud-signin.mjs";
import { ACCOUNT_ROUTES, APP_AUTH_REDIRECT, cleanPhoneSignInCode, OAUTH_PROVIDERS, type OAuthErrorCode, type OAuthProvider } from "../../../shared/account-api";
import type { CloudSignInStart } from "../../../electron/cloud-account.mjs";
import type { SignInVerify } from "@/components/account-gate/bridge";
import type { MobilePlatform } from "../platform";
import { cleanIce, type IceServer } from "../transport/direct-rtc";

/** `avatarUrl` (https) and `avatar` (shared/user-avatar.ts): the face the account service names, both optional. */
export type MobileAccount = { id: string; email: string; avatarUrl?: string; avatar?: string };
/** The account's photo and avatar choice from a grant or session read, only in the shapes the service sends. */
export function mobileFace(account: unknown): Pick<MobileAccount, "avatarUrl" | "avatar"> {
  if (!account || typeof account !== "object") return {};
  const { avatarUrl, avatar } = account as Record<string, unknown>;
  let photo: string | null = null;
  if (typeof avatarUrl === "string" && avatarUrl.length <= 1024) { try { const url = new URL(avatarUrl); if (url.protocol === "https:" && !url.username && !url.password) photo = url.href; } catch { /* not an address */ } }
  const choice = parseUserAvatarChoice(avatar);
  return { ...(photo ? { avatarUrl: photo } : {}), ...(choice ? { avatar: choice } : {}) };
}
export type MobileCloud = { id: string; name: string; status: string; origin: string | null; primary: boolean; asleep: boolean };
/** a team's madani cloud this account is a member of, as the session lists it */
export type MobileTeamCloud = { id: string; name: string; status: string; origin: string | null; asleep: boolean };
/** one of the account's computers (a Mac, a pc or a server it linked), as the service lists it */
export type MobileComputer = { id: string; name: string; kind: "vps" | "mac" | "linux" | "windows"; presence: "online" | "asleep" | "offline"; environmentId: string | null };
/** what the account has, beyond any computer this phone linked itself */
export type AccountPlaces = { clouds: MobileCloud[]; teams: MobileTeamCloud[]; computers: MobileComputer[] };
/** `asleep`: the computer is not online to answer; `unavailable`: it answered but made no pairing a phone can use */
export type ComputerPairResult = { outcome: "paired"; link: string } | { outcome: "asleep" | "unavailable" | "limited" | "signed-out" | "failed" };
export type CloudPairGrant = { origin: string; code: string; expiresAt: number };
export type CloudPairResult = { outcome: "paired"; grant: CloudPairGrant } | { outcome: "asleep" | "unavailable" | "signed-out" | "failed" };
type StoredGrant = { origin: string; token: string; expiresAt: number; account: MobileAccount; deviceId: string };
export type AuthResult = false | SignInVerify | { outcome: OAuthErrorCode | "invalid-state" };
/** a desktop's phone sign-in code, redeemed: signed in, or why not */
export type PhoneCodeResult = { outcome: "signed-in" | "wrong-code" | "expired" | "used" | "limited" | "offline" | "failed" };
export type AppleProblem = "failed" | "unavailable" | "signup-closed" | "taken" | "rate-limited" | "offline";
export type AppleResult = { outcome: "signed-in" | "canceled" } | { outcome: AppleProblem };
const APPLE_ERRORS: Record<string, AppleProblem> = { invalid_request: "failed", invalid_grant: "failed", signup_closed: "signup-closed", identity_taken: "taken", provider_unavailable: "unavailable", rate_limited: "rate-limited" };

/** A fresh raw nonce for Sign in with Apple and the sha-256 hex Apple is given: the token carries the hash, the service
 * gets the raw value and checks the two match, so a token taken from somewhere else is useless here. */
export async function appleNonce(): Promise<{ raw: string; hash: string }> {
  const raw = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)));
  return { raw, hash: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("") };
}
const TOKEN = /^omc_[A-Za-z0-9_-]{43}$/;
const OPAQUE = /^[A-Za-z0-9_-]{43}$/;
const SECRET = "madani.account";
/** the phone's other signed-in accounts, each with its own session, kept beside the one in use */
const OTHERS = "madani.account.others";
const MAX_OTHERS = 5;
const PENDING = "madani.account.pending";
const OAUTH_ERRORS: readonly string[] = ["oauth_denied", "oauth_failed", "oauth_expired", "provider_unavailable", "signup_closed", "identity_taken"];
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const identity = (value: unknown): value is MobileAccount => object(value) && typeof value.id === "string" && Boolean(value.id) && typeof value.email === "string" && Boolean(cleanEmail(value.email));
const expiry = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const savedGrant = (value: unknown): StoredGrant | null =>
  object(value) && typeof value.origin === "string" && typeof value.token === "string" && TOKEN.test(value.token) && expiry(value.expiresAt)
    && identity(value.account) && typeof value.deviceId === "string" && value.deviceId ? value as StoredGrant : null;
const parse = (value: string | null): unknown => { try { return value ? JSON.parse(value) : null; } catch { return null; } };
const savedOthers = (value: unknown): StoredGrant[] => Array.isArray(value) ? value.map(savedGrant).filter((one): one is StoredGrant => one !== null).slice(0, MAX_OTHERS) : [];

/** The account service the sign-in kept in the Keychain was made on, whatever this launch would sign in to. */
export async function keptSignInOrigin(platform: Pick<MobilePlatform, "secrets">): Promise<string | null> {
  const saved = savedGrant(parse(await platform.secrets.get(SECRET).catch(() => null)));
  return saved?.origin ?? null;
}
const CLOUD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const GRANT_CODE = /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;
const MAX_GRANT_MS = 10 * 60_000;
/** the account service stamps a grant's end by its clock; a phone whose clock is this far off either way still takes it */
const CLOCK_SLACK_MS = 10 * 60_000;
const MAX_CLOUDS = 20;
const CLOUD_PAIRING = "/api/cloud/desktop/pairing";
const CLOUD_WAKE = "/api/cloud/desktop/wake";

function httpsOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try { const url = new URL(value); return url.protocol === "https:" && url.origin === value && !url.username && !url.password ? value : null; } catch { return null; }
}

export function parseOwnClouds(input: unknown): MobileCloud[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const clouds: MobileCloud[] = [];
  for (const entry of input.slice(0, MAX_CLOUDS)) {
    if (!object(entry) || typeof entry.id !== "string" || !CLOUD_ID.test(entry.id) || seen.has(entry.id)) continue;
    if (entry.role !== "owner" || (entry.teamId !== null && entry.teamId !== undefined) || entry.managed === false || typeof entry.status !== "string") continue;
    seen.add(entry.id);
    const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim().slice(0, 40) : "my cloud";
    const asleep = entry.status === "ready" && object(entry.power) && (entry.power.state === "asleep" || entry.power.state === "waking");
    clouds.push({ id: entry.id, name, status: entry.status, origin: httpsOrigin(entry.origin), primary: entry.primary === true, asleep });
  }
  return clouds.sort((a, b) => Number(b.primary) - Number(a.primary));
}

export function parseTeamClouds(input: unknown): MobileTeamCloud[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const teams: MobileTeamCloud[] = [];
  for (const entry of input.slice(0, MAX_CLOUDS)) {
    if (!object(entry) || typeof entry.id !== "string" || !CLOUD_ID.test(entry.id) || seen.has(entry.id) || !object(entry.machine) || typeof entry.machine.state !== "string") continue;
    seen.add(entry.id);
    const machine = entry.machine, status = entry.machine.state;
    const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim().slice(0, 40) : "team cloud";
    const asleep = status === "ready" && object(machine.power) && (machine.power.state === "asleep" || machine.power.state === "waking");
    teams.push({ id: entry.id, name, status, origin: httpsOrigin(machine.origin), asleep });
  }
  return teams;
}

const WORKSPACE_ID = /^ws_[A-Za-z0-9_-]{1,64}$/;
const COMPUTER_KINDS: readonly string[] = ["vps", "mac", "linux", "windows"];
const PRESENCE: readonly string[] = ["online", "asleep", "offline"];
const MAX_COMPUTERS = 50;

export function parseComputers(input: unknown): MobileComputer[] {
  if (!object(input) || input.v !== 1 || !Array.isArray(input.computers)) return [];
  const seen = new Set<string>();
  const computers: MobileComputer[] = [];
  for (const entry of input.computers.slice(0, MAX_COMPUTERS)) {
    if (!object(entry) || typeof entry.id !== "string" || !WORKSPACE_ID.test(entry.id) || seen.has(entry.id)) continue;
    if (typeof entry.kind !== "string" || !COMPUTER_KINDS.includes(entry.kind) || typeof entry.presence !== "string" || !PRESENCE.includes(entry.presence)) continue;
    seen.add(entry.id);
    const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim().slice(0, 40) : entry.kind === "vps" ? "server" : "computer";
    const environmentId = typeof entry.environmentId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(entry.environmentId) ? entry.environmentId : null;
    computers.push({ id: entry.id, name, kind: entry.kind as MobileComputer["kind"], presence: entry.presence as MobileComputer["presence"], environmentId });
  }
  return computers;
}

/** the computer's pairing link, only a v2 phone link whose grant is still live */
export function parseComputerPair(input: unknown, now = Date.now()): string | null {
  if (!object(input) || input.v !== 1 || typeof input.link !== "string" || input.link.length > 8192 || !/^madanibot:\/\/pair\?m=[A-Za-z0-9_-]+$/.test(input.link)) return null;
  return expiry(input.expiresAt) && input.expiresAt > now - CLOCK_SLACK_MS && input.expiresAt <= now + MAX_GRANT_MS + CLOCK_SLACK_MS ? input.link : null;
}

export function parsePairGrant(input: unknown, origin: string | null, now = Date.now()): CloudPairGrant | null {
  if (!object(input) || input.cloudContractVersion !== 1 || !httpsOrigin(input.origin) || (origin !== null && input.origin !== origin)) return null;
  if (typeof input.code !== "string" || !GRANT_CODE.test(input.code)) return null;
  if (!expiry(input.expiresAt) || input.expiresAt <= now - CLOCK_SLACK_MS || input.expiresAt > now + MAX_GRANT_MS + CLOCK_SLACK_MS) return null;
  return { origin: input.origin as string, code: input.code, expiresAt: input.expiresAt };
}
const base64url = (value: Uint8Array) => btoa(String.fromCharCode(...value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function isAccountAuthUrl(value: string): boolean {
  try { const url = new URL(value); return `${url.protocol}//${url.host}` === APP_AUTH_REDIRECT && !url.pathname && !url.username && !url.password && !url.hash; } catch { return false; }
}

class AccountRequestError extends Error {
  constructor(readonly status: number, readonly code?: string, readonly opaque = false) { super("Account request failed"); }
}

/** The phone the app runs on, as analytics counts it: the phone page in a browser says which phone from its user agent,
 * so an iPhone opening it is not counted as a linux computer. */
export function analyticsPlatform(kind: MobilePlatform["kind"], userAgent: string): "ios" | "android" | "linux" {
  if (kind !== "web") return kind;
  if (/iPhone|iPad|iPod/.test(userAgent)) return "ios";
  return /Android/.test(userAgent) ? "android" : "linux";
}

export function createMobileAccount({ platform, origin, fetch: requestFetch = globalThis.fetch }: {
  platform: MobilePlatform; origin: string; fetch?: typeof globalThis.fetch;
}) {
  let grant: StoredGrant | null = null;
  let others: StoredGrant[] = [];
  let attempt: { id: string; email: string; expiresAt: number; wrong: number } | null = null;
  let generation = 0;
  let iceCache: { grant: StoredGrant; until: number; servers: IceServer[] } | null = null;
  const analytics = () => configureAnalytics({ origin, token: grant?.token ?? null, platform: analyticsPlatform(platform.kind, globalThis.navigator?.userAgent ?? ""), version: platform.appVersion, kind: "mobile" });
  analytics();
  const device = () => ({ deviceName: platform.deviceName().trim().slice(0, 100), platform: platform.kind === "web" ? "linux" : platform.kind,
    appVersion: /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/.test(platform.appVersion) ? platform.appVersion : "0.0.0" });
  const request = async (path: string, method = "GET", body?: unknown, token?: string): Promise<unknown> => {
    const response = await requestFetch(`${origin}${path}`, { method, credentials: "omit", redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { "content-type": "application/json", accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (Number(response.headers.get("content-length")) > 65_536) { await response.body?.cancel(); throw new AccountRequestError(response.status, undefined, true); }
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let text = "", size = 0;
    if (reader) {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 65_536) { await reader.cancel(); throw new AccountRequestError(response.status, undefined, true); }
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally { reader.releaseLock(); }
    }
    let result: unknown;
    try { result = JSON.parse(text); } catch { throw new AccountRequestError(response.status, undefined, true); }
    // the /v1 routes answer { error: text, code }; the Admin contract's /api/cloud routes { error: code }
    if (!response.ok) throw new AccountRequestError(response.status, object(result) ? typeof result.code === "string" ? result.code : typeof result.error === "string" ? result.error : undefined : undefined);
    return result;
  };
  const readOthers = async () => savedOthers(parse(await platform.secrets.get(OTHERS).catch(() => null)));
  const writeOthers = async (next: StoredGrant[]) => {
    others = next.slice(0, MAX_OTHERS);
    if (others.length) await platform.secrets.set(OTHERS, JSON.stringify(others));
    else await platform.secrets.remove(OTHERS);
  };
  const endSession = (token: string) => request(ACCOUNT_ROUTES.appSession, "DELETE", {}, token).then(() => {}, () => {});
  /** `next` becomes the account in use; the one it replaces stays signed in beside it, unless it is the same account */
  const take = async (next: StoredGrant | null) => {
    const before = grant;
    const kept = (await readOthers()).filter((one) => one.account.id !== next?.account.id && one.account.id !== before?.account.id);
    const keepBefore = before && next && before.account.id !== next.account.id ? [before] : [];
    if (next) await platform.secrets.set(SECRET, JSON.stringify(next));
    else await platform.secrets.remove(SECRET);
    await writeOthers([...keepBefore, ...kept]);
    grant = next; iceCache = null; analytics();
    if (before && next && before.account.id === next.account.id && before.token !== next.token) void endSession(before.token);
  };
  const usable = (one: StoredGrant) => one.origin === origin && one.expiresAt > Date.now();
  const tokenOf = (accountId?: string): string | null => {
    if (!accountId || accountId === grant?.account.id) return grant?.token ?? null;
    const other = others.find((one) => one.account.id === accountId);
    return other && usable(other) ? other.token : null;
  };
  /** each kept session is checked, which slides its end on the service; one the service no longer knows is forgotten */
  const refreshOthers = async () => {
    const kept = (await readOthers()).filter((one) => one.origin === origin);
    const answers = await Promise.all(kept.map(async (one): Promise<StoredGrant | null> => {
      try {
        const session = await request(ACCOUNT_ROUTES.appSession, "GET", undefined, one.token);
        const renewed = object(session) && expiry(session.expiresAt) && session.expiresAt > one.expiresAt ? session.expiresAt : one.expiresAt;
        return { ...one, expiresAt: renewed, account: { id: one.account.id, email: one.account.email, ...mobileFace(object(session) ? session.account : null) } };
      } catch (error) {
        return error instanceof AccountRequestError && error.status === 401 && error.code === "invalid_token" ? null : one;
      }
    }));
    const checked = new Map(kept.map((one, index) => [one.token, answers[index]]));
    await writeOthers((await readOthers()).flatMap((one) => {
      const answer = checked.get(one.token);
      return answer === undefined ? [one] : answer ? [answer] : [];
    }));
  };
  /** with no account in use, the next one still signed in on the phone takes over */
  const promote = async (): Promise<StoredGrant | null> => {
    grant = null;
    const next = (await readOthers()).find(usable) ?? null;
    if (next) await take(next);
    return next;
  };
  const adopt = async (value: unknown, stamp: number): Promise<boolean> => {
    if (stamp !== generation || !object(value) || value.cloudContractVersion !== 1 || typeof value.accessToken !== "string" || !TOKEN.test(value.accessToken)
      || !expiry(value.expiresAt) || value.expiresAt <= Date.now() || !object(value.device) || typeof value.device.id !== "string" || !value.device.id || !identity(value.account)) return false;
    const next = { origin, token: value.accessToken, expiresAt: value.expiresAt, account: { id: value.account.id, email: value.account.email, ...mobileFace(value.account) }, deviceId: value.device.id };
    await take(next);
    if (stamp !== generation) { await platform.secrets.remove(SECRET); grant = null; analytics(); return false; }
    attempt = null;
    return true;
  };
  const pairing = async (path: string, body: unknown, cloudOrigin: string | null, accountId?: string): Promise<CloudPairResult> => {
    const token = tokenOf(accountId);
    if (!token) return { outcome: "signed-out" };
    try {
      const paired = parsePairGrant(await request(path, "POST", body, token), cloudOrigin);
      return paired ? { outcome: "paired", grant: paired } : { outcome: "failed" };
    } catch (error) {
      if (!(error instanceof AccountRequestError) || error.opaque) return { outcome: "failed" };
      if (error.status === 401) return { outcome: "signed-out" };
      if (error.status === 409 && error.code === "not_running") return { outcome: "asleep" };
      if (error.status === 409 || error.status === 404) return { outcome: "unavailable" };
      return { outcome: "failed" };
    }
  };
  return {
    account: () => grant?.account ?? null,
    /** every account signed in on this phone, the one in use first */
    accounts: (): MobileAccount[] => [...(grant ? [grant.account] : []), ...others.filter((one) => usable(one) && one.account.id !== grant?.account.id).map((one) => one.account)],
    /** Another signed-in account becomes the one in use; the one in use before stays signed in. */
    async switchAccount(accountId: string): Promise<MobileAccount | null> {
      if (grant?.account.id === accountId) return grant.account;
      const target = (await readOthers()).find((one) => one.account.id === accountId);
      if (!target || !usable(target)) return null;
      ++generation;
      attempt = null;
      await take(target);
      return target.account;
    },
    /** The saved sign-in as the Keychain has it, at once and without the network, so a launch never waits on it. */
    async cached(): Promise<MobileAccount | null> {
      const saved = savedGrant(parse(await platform.secrets.get(SECRET)));
      others = await readOthers();
      if (saved && saved.origin === origin && saved.expiresAt > Date.now()) { grant = saved; analytics(); }
      return grant?.account ?? null;
    },
    async restore(): Promise<MobileAccount | null> {
      const stamp = generation;
      others = await readOthers();
      if (others.length) void refreshOthers().catch(() => {});
      const value = parse(await platform.secrets.get(SECRET));
      if (!object(value) || value.origin !== origin) { grant = null; analytics(); return (await promote())?.account ?? null; }
      const saved = savedGrant(value);
      if (!saved) { grant = null; analytics(); await platform.secrets.remove(SECRET); return (await promote())?.account ?? null; }
      try {
        const session = await request(ACCOUNT_ROUTES.appSession, "GET", undefined, saved.token);
        if (stamp !== generation) return null;
        // the face may have changed on another device, and the service slides the session's end on every check
        const { avatarUrl: _photo, avatar: _choice, ...rest } = saved.account;
        const renewed = object(session) && expiry(session.expiresAt) && session.expiresAt > saved.expiresAt ? session.expiresAt : saved.expiresAt;
        grant = { ...saved, expiresAt: renewed, account: { ...rest, ...mobileFace(object(session) ? session.account : null) } };
        if (renewed !== saved.expiresAt) await platform.secrets.set(SECRET, JSON.stringify(grant));
      } catch (error) {
        if (stamp !== generation) return null;
        // only the service saying the session is gone signs the phone out; an outage, a rate limit or a captive
        // portal's page keeps a session that has not run out
        if (error instanceof AccountRequestError && error.status === 401 && error.code === "invalid_token") { grant = null; await platform.secrets.remove(SECRET); await promote(); }
        else grant = saved.expiresAt > Date.now() ? saved : null;
      }
      analytics();
      return grant?.account ?? null;
    },
    async emailStart(email: string): Promise<CloudSignInStart> {
      const address = cleanEmail(email);
      if (!address) return { outcome: "invalid-email" };
      if (attempt?.email !== address) attempt = null;
      const stamp = generation;
      try {
        const result = parseSignInStart(await request(ACCOUNT_ROUTES.appEmailStart, "POST", { email: address, ...device() }));
        if (!result || stamp !== generation) return { outcome: "failed" };
        attempt = { id: result.attempt, email: address, expiresAt: Date.now() + result.expiresIn * 1000, wrong: 0 };
        return { outcome: "sent", email: address, expiresAt: attempt.expiresAt, resendAt: Date.now() + result.resendAfter * 1000, signupOpen: result.signupOpen };
      } catch (error) { return { outcome: startFailure(error) }; }
    },
    async emailVerify(code: string): Promise<SignInVerify> {
      const pending = attempt, digits = cleanCode(code);
      if (!pending || Date.now() >= pending.expiresAt) { attempt = null; return { outcome: "expired" }; }
      if (!digits) return { outcome: "wrong-code", triesLeft: SIGN_IN_TRIES - pending.wrong };
      const stamp = generation;
      try {
        const value = await request(ACCOUNT_ROUTES.appEmailVerify, "POST", { attempt: pending.id, code: digits });
        return { outcome: await adopt(value, stamp) ? "signed-in" : "failed" };
      } catch (error) {
        const outcome = verifyFailure(error);
        if (outcome === "wrong-code" && attempt === pending && ++pending.wrong < SIGN_IN_TRIES) return { outcome, triesLeft: SIGN_IN_TRIES - pending.wrong };
        if (attempt === pending) attempt = null;
        return { outcome: outcome === "wrong-code" ? "expired" : outcome };
      }
    },
    cancelEmail() { attempt = null; },
    /** A code a signed-in desktop showed (typed, or carried by its qr's link) logs this phone in to that account; an
     * account the phone was using before stays signed in beside it. */
    async phoneCode(code: string): Promise<PhoneCodeResult> {
      const typed = cleanPhoneSignInCode(code);
      if (!typed) return { outcome: "wrong-code" };
      const stamp = ++generation;
      try {
        const value = await request(ACCOUNT_ROUTES.appPhoneSignIn, "POST", { code: typed, ...device() });
        return { outcome: await adopt(value, stamp) ? "signed-in" : "failed" };
      } catch (error) {
        if (!(error instanceof AccountRequestError)) return { outcome: "offline" };
        if (error.code === "invalid_code") return { outcome: "wrong-code" };
        if (error.code === "expired" || error.code === "used") return { outcome: error.code };
        if (error.status === 429) return { outcome: "limited" };
        return { outcome: "failed" };
      }
    },
    /** The sign-in providers the service has switched on; none when it cannot be asked, so no button leads nowhere. */
    async providers(): Promise<OAuthProvider[]> {
      try {
        const answer = await request(ACCOUNT_ROUTES.providers);
        if (!object(answer) || answer.v !== 1 || !Array.isArray(answer.providers)) return [];
        const on = new Set(answer.providers.filter((one): one is { id: string } => object(one) && one.enabled === true && typeof one.id === "string").map((one) => one.id));
        return OAUTH_PROVIDERS.filter((provider) => on.has(provider));
      } catch { return []; }
    },
    async oauthStart(provider: OAuthProvider): Promise<void> {
      const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
      const state = base64url(crypto.getRandomValues(new Uint8Array(24)));
      const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
      await platform.secrets.set(PENDING, JSON.stringify({ verifier, state, provider, at: Date.now(), origin }));
      try {
        await platform.openExternal(`${origin}${ACCOUNT_ROUTES.appStart}?${new URLSearchParams({ provider, code_challenge: challenge, code_challenge_method: "S256", state, redirect_uri: APP_AUTH_REDIRECT, landing: "page" })}`);
      } catch (error) { await platform.secrets.remove(PENDING); throw error; }
    },
    /** Sign in with Apple in the system sheet, then the account service's native sign-in; the session is kept as the
     * email code's is. Closing the sheet is "canceled", said to no one. */
    async appleNative(): Promise<AppleResult> {
      if (!platform.appleSignIn) return { outcome: "unavailable" };
      const stamp = ++generation;
      const nonce = await appleNonce();
      let credential;
      try { credential = await platform.appleSignIn(nonce.hash); } catch { return { outcome: "failed" }; }
      if (!credential) return { outcome: "canceled" };
      const name = (value: string | undefined) => value?.trim().slice(0, 80) || undefined;
      try {
        const value = await request(ACCOUNT_ROUTES.appAppleSignIn, "POST", { identityToken: credential.identityToken, authorizationCode: credential.authorizationCode, nonce: nonce.raw,
          ...(name(credential.givenName) ? { givenName: name(credential.givenName) } : {}), ...(name(credential.familyName) ? { familyName: name(credential.familyName) } : {}), ...device() });
        return { outcome: await adopt(value, stamp) ? "signed-in" : "failed" };
      } catch (error) {
        if (!(error instanceof AccountRequestError)) return { outcome: "offline" };
        return { outcome: (error.code && APPLE_ERRORS[error.code]) || "failed" };
      }
    },
    async handleAuthUrl(value: string): Promise<AuthResult> {
      if (!isAccountAuthUrl(value)) return false;
      const url = new URL(value);
      const stamp = ++generation;
      const pending = parse(await platform.secrets.get(PENDING));
      await platform.secrets.remove(PENDING);
      if (!object(pending) || pending.origin !== origin || typeof pending.state !== "string" || url.searchParams.get("state") !== pending.state
        || typeof pending.verifier !== "string" || !OPAQUE.test(pending.verifier) || typeof pending.at !== "number" || pending.at > Date.now() || Date.now() - pending.at >= 15 * 60_000) return { outcome: "invalid-state" };
      const error = url.searchParams.get("error");
      if (error) return { outcome: OAUTH_ERRORS.includes(error) ? error as OAuthErrorCode : "oauth_failed" };
      const code = url.searchParams.get("code");
      if (!code) return { outcome: "failed" };
      try {
        const result = await request(ACCOUNT_ROUTES.appToken, "POST", { code, codeVerifier: pending.verifier, ...device() });
        return { outcome: await adopt(result, stamp) ? "signed-in" : "failed" };
      } catch { return { outcome: "failed" }; }
    },
    /** Signs the account in use out; the next account still signed in on the phone, if any, takes over. */
    async signOut(): Promise<MobileAccount | null> {
      ++generation;
      const token = grant?.token;
      grant = null; attempt = null; analytics();
      await Promise.all([platform.secrets.remove(SECRET), platform.secrets.remove(PENDING)]);
      const next = await promote();
      if (token) await endSession(token);
      return next?.account ?? null;
    },
    /** Every account on the phone signs out, for a move to another account service. */
    async signOutAll(): Promise<void> {
      const kept = await readOthers();
      await writeOthers([]);
      await this.signOut();
      await Promise.all(kept.filter((one) => one.origin === origin).map((one) => endSession(one.token)));
    },
    /** Deletes the account for good from the app itself (App Store guideline 5.1.1(v)); the phone is signed out after. */
    async deleteAccount(): Promise<"deleted" | "signed-out" | "failed"> {
      const signedIn = grant;
      if (!signedIn) return "signed-out";
      let outcome: "deleted" | "signed-out" = "deleted";
      try {
        await request(ACCOUNT_ROUTES.appDeleteAccount, "POST", { email: signedIn.account.email }, signedIn.token);
      } catch (error) {
        // this sign-in is already gone (deleted or signed out elsewhere): the phone forgets it the same way
        if (!(error instanceof AccountRequestError) || error.status !== 401) return "failed";
        outcome = "signed-out";
      }
      ++generation;
      grant = null; attempt = null; iceCache = null; analytics();
      await Promise.all([platform.secrets.remove(SECRET), platform.secrets.remove(PENDING)]);
      await promote();
      return outcome;
    },
    async clouds(): Promise<MobileCloud[] | null> {
      if (!grant) return null;
      try {
        const value = await request(ACCOUNT_ROUTES.appSession, "GET", undefined, grant.token);
        return object(value) ? parseOwnClouds(value.clouds) : [];
      } catch { return null; }
    },
    /** the account's own clouds, its teams' clouds and its computers; null when signed out or the session is unreadable.
     * a service without the computers list answers none */
    async places(accountId?: string): Promise<AccountPlaces | null> {
      const token = tokenOf(accountId);
      if (!token) return null;
      try {
        const [value, computers] = await Promise.all([request(ACCOUNT_ROUTES.appSession, "GET", undefined, token),
          request(ACCOUNT_ROUTES.appComputers, "GET", undefined, token).then(parseComputers, () => [])]);
        return object(value) ? { clouds: parseOwnClouds(value.clouds), teams: parseTeamClouds(value.teams), computers } : { clouds: [], teams: [], computers };
      } catch { return null; }
    },
    /** a one-time pairing link from one of the account's computers, asked of it through the service while it is online */
    async pairComputer(computer: Pick<MobileComputer, "id">, accountId?: string): Promise<ComputerPairResult> {
      const token = tokenOf(accountId);
      if (!token) return { outcome: "signed-out" };
      try {
        const link = parseComputerPair(await request(ACCOUNT_ROUTES.appComputerPair(computer.id), "POST", {}, token));
        return link ? { outcome: "paired", link } : { outcome: "failed" };
      } catch (error) {
        if (!(error instanceof AccountRequestError) || error.opaque) return { outcome: "failed" };
        if (error.status === 401) return { outcome: "signed-out" };
        if (error.status === 429) return { outcome: "limited" };
        if (error.status === 409 && error.code === "computer_offline") return { outcome: "asleep" };
        if (error.status === 409 || error.status === 404) return { outcome: "unavailable" };
        return { outcome: "failed" };
      }
    },
    pairCloud(cloud: Pick<MobileCloud, "id" | "origin">, accountId?: string): Promise<CloudPairResult> {
      return pairing(CLOUD_PAIRING, { cloudId: cloud.id }, cloud.origin, accountId);
    },
    /** a pairing grant for a team's cloud; the service signs it only for a current member */
    pairTeamCloud(cloud: Pick<MobileTeamCloud, "id" | "origin">, accountId?: string): Promise<CloudPairResult> {
      return pairing(`/api/cloud/desktop/teams/${encodeURIComponent(cloud.id)}/pairing`, {}, cloud.origin, accountId);
    },
    /** Wakes the account's primary Cloud, the one the wake route answers for. */
    async wakeCloud(accountId?: string): Promise<boolean> {
      const token = tokenOf(accountId);
      if (!token) return false;
      try { await request(CLOUD_WAKE, "POST", { intent: "click" }, token); return true; } catch { return false; }
    },
    /** Cloudflare TURN for the phone's direct link to its server, minted for this sign-in; none when signed out. */
    async screenIce(): Promise<IceServer[]> {
      const signedIn = grant;
      if (!signedIn) return [];
      if (iceCache?.grant === signedIn && iceCache.until > Date.now()) return iceCache.servers;
      try {
        const value = await request(ACCOUNT_ROUTES.screenIce, "POST", {}, signedIn.token);
        if (!object(value) || value.v !== 1 || !expiry(value.expiresAt)) return [];
        const servers = cleanIce(value.iceServers);
        iceCache = { grant: signedIn, until: Math.min(value.expiresAt - 10 * 60_000, Date.now() + 60 * 60_000), servers };
        return servers;
      } catch { return []; }
    },
    async enrollGrant(): Promise<{ enrollToken: string; dashboardUrl: string } | null> {
      if (!grant) return null;
      try {
        const value = await request(ACCOUNT_ROUTES.enrollGrant, "POST", {}, grant.token);
        if (!object(value) || typeof value.enrollToken !== "string" || !OPAQUE.test(value.enrollToken) || typeof value.dashboardUrl !== "string") return null;
        const url = new URL(value.dashboardUrl);
        return url.origin === origin && !url.username && !url.password ? { enrollToken: value.enrollToken, dashboardUrl: value.dashboardUrl } : null;
      } catch { return null; }
    },
  };
}
