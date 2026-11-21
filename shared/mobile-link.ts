// The phone link: how the mobile app pairs with one workspace (a VPS or a Mac) and reaches it from anywhere.
//
// A desktop owner or admin opens a short-lived grant (POST /api/mobile/pairing). It is shown three ways: a QR of
// `mobileLinkUrl(payload)`, the same `madanibot://pair?m=...` deep link, and a typed code. The phone redeems the
// grant once (POST /api/mobile/redeem) and from then on holds one workspace session token, the same credential on
// every route: a direct HTTPS origin, the link relay (a VPS without public ingress) or the Mac's companion sidecar.
//
// Relay protocol (link-service): a channel is the phone's own sealed pipe to the VPS agent, never the Mac's tunnel.
//   POST {base}/v1/channels/{channel}/to-vps   bearer: the channel token   {frames, epoch, seq}
//   GET  {base}/v1/channels/{channel}/to-app?wait=25&stream=1               ndjson {frames} lines
//   DELETE {base}/v1/channels/{channel}                                    the phone forgets its channel
// Frames are the Mac tunnel's frames (electron/vps-link-protocol.mjs sealFrame/sealBytes/openFrame) with the channel
// id in place of the tunnel id: AES-256-GCM, AAD `{channel}|to-vps` or `{channel}|to-app`, timestamped, replay-checked.
// A grant's channel key travels in the QR. A device channel's key is X25519: HKDF(ECDH(phone, agent)) exactly as
// vps-link-protocol.mjs sealKeyOf(myPriv, myPub, theirPub, channel), with the agent's public key from the redeem reply.
//
// Typed code lookup: the code is the grant's 12-symbol pairing code. The phone normalizes it (uppercase, no dashes or
// spaces), derives HKDF-SHA256(ikm = code, salt = MOBILE_LOOKUP_SALT, info = "lookup", 16 bytes) as a hex lookup id and
// HKDF-SHA256(ikm = code, salt = MOBILE_LOOKUP_SALT, info = "seal", 32 bytes) as an AES-256-GCM key, fetches
// GET {relay}/v1/lookups/{id} -> {sealed} and opens it (iv 12, ciphertext, tag 16, AAD = the lookup id) into the same
// payload the QR carries.

import { qrEndpoints, type CompanionEndpoint, type CompanionEndpointKind } from "./pairing-link.ts";

export const MOBILE_LINK_VERSION = 2;
export const MOBILE_LOOKUP_SALT = "omb-mobile-v1";
export const DEFAULT_MOBILE_RELAY = "https://link.madani.bot";
/** A grant lives this long; the QR, the deep link and the typed code die together. */
export const MOBILE_GRANT_TTL_MS = 10 * 60_000;
export const MOBILE_PLATFORMS = ["ios", "android", "other"] as const;
export type MobilePlatform = (typeof MOBILE_PLATFORMS)[number];
export const PUSH_SERVICES = ["apns", "fcm"] as const;
export type PushService = (typeof PUSH_SERVICES)[number];

/** One way to reach the workspace, in the order the phone should try them. */
export type MobileTransport =
  /** The workspace's own HTTPS origin. `spki`: base64 sha256 of the leaf key, pinned when the certificate is self-made. */
  | { kind: "https"; url: string; spki?: string }
  /** The grant's one-time relay channel; its token and key open only that channel and only until the grant ends. */
  | { kind: "relay"; base: string; channel: string; token: string; key: string }
  /** The Mac's companion sidecar: native requests only (no Origin header), at one of its advertised addresses. */
  | { kind: "companion"; url: string; net: CompanionEndpointKind; priority: number };

/** What the QR, the deep link and the typed-code lookup carry. */
export interface MobileLinkPayload {
  v: typeof MOBILE_LINK_VERSION;
  workspace: { name: string; environmentId: string | null; kind: "vps" | "mac" | "server" };
  /** `secret` is a single-use pairing credential; `expiresAt` is epoch ms; `issuedAt` is the issuing server's clock when
   * it made the grant, so a phone can time the grant's lifetime on its own clock whatever either clock says. */
  grant: { id: string; secret: string; expiresAt: number; issuedAt?: number };
  via: MobileTransport[];
}

/** POST /api/mobile/pairing, owner or admin only. `companion`: the Mac's sidecar addresses the desktop adds. */
export interface MobilePairingRequest {
  scopes?: ("admin" | "client")[];
  label?: string;
  companion?: CompanionEndpoint[];
}

export interface MobilePairingResponse {
  payload: MobileLinkPayload;
  link: string;
  /** The typed code, formatted XXXX-XXXX-XXXX. Null when no relay could hold its lookup. */
  code: string | null;
  expiresAt: number;
}

/** POST /api/mobile/redeem, public: the grant's secret (or typed code) is the authorization. */
export interface MobileRedeemRequest {
  secret: string;
  /** Stable across retries of one attempt, so a lost answer can be fetched again. */
  attemptId: string;
  /** `install`: made once per phone app install and kept in its preferences; a pairing that carries the install of an
   * earlier pairing with this workspace replaces it. */
  device: { name: string; platform: MobilePlatform; app?: string; install?: string };
  /** Ask for a long-lived relay channel: the phone's X25519 public key and sha256 hex of a token it generated. */
  relay?: { pub: string; verifier: string };
}

export interface MobileDevice {
  id: string;
  name: string;
  platform: MobilePlatform;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  relay: boolean;
  push: PushService | null;
}

export interface MobileRedeemResponse {
  /** The workspace session bearer token (`madani_sess_...`), the phone's only workspace credential. */
  token: string;
  device: MobileDevice;
  workspace: MobileLinkPayload["workspace"];
  scopes: ("admin" | "client")[];
  /** The phone's own relay channel when it asked for one and this workspace has a relay. */
  relay?: { base: string; channel: string; agentPub: string };
}

/** GET /api/mobile/routes with a paired phone's own session: the ways to this workspace now, so a phone that paired
 * before an address changed (a new Wi-Fi address, a domain, a renamed tunnel) learns them. `companion` is null when
 * the computer did not say, and the phone keeps the ones it has; a relay is the phone's own channel and never listed. */
export interface MobileRoutesResponse {
  https: Extract<MobileTransport, { kind: "https" }>[];
  companion: Extract<MobileTransport, { kind: "companion" }>[] | null;
  /** The asking phone's relay channel as the place serves it now; null when the place has a relay but no channel for
   * this phone (POST /api/mobile/relay with a MobileRelayAsk opens one); absent when the place has no relay now. */
  relay?: MobileRelayChannel | null;
}

/** POST /api/mobile/relay with the phone's own session: its X25519 public key and sha256 hex of a token it made. */
export interface MobileRelayAsk { pub: string; verifier: string }

/** A phone's own relay channel: where it is, and the place's key half to derive the channel key with. */
export interface MobileRelayChannel { base: string; channel: string; agentPub: string }

/** PUT /api/mobile/push with the device's own session. */
export interface MobilePushRegistration {
  service: PushService;
  token: string;
  /** APNs only: which gateway the token belongs to. */
  environment?: "sandbox" | "production";
}

const B64URL = /^[A-Za-z0-9_-]+$/;
const RELAY_ID = /^[a-z2-7]{10}$/;

function originOf(value: unknown, protocols: readonly string[]): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (!protocols.includes(url.protocol) || url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Keeps only well-formed transports, drops duplicates and caps the list, so a QR never carries a stray URL. */
export function mobileTransports(list: readonly unknown[]): MobileTransport[] {
  const out: MobileTransport[] = [];
  const seen = new Set<string>();
  const companions: CompanionEndpoint[] = [];
  for (const item of list) {
    const one = item as Record<string, unknown> | null;
    if (!one || typeof one !== "object") continue;
    if (one.kind === "https") {
      const url = originOf(one.url, ["https:"]);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push({ kind: "https", url, ...(typeof one.spki === "string" && /^[A-Za-z0-9+/]{43}=$/.test(one.spki) ? { spki: one.spki } : {}) });
    } else if (one.kind === "relay") {
      const base = originOf(one.base, ["https:", "http:"]);
      if (!base || typeof one.channel !== "string" || !RELAY_ID.test(one.channel) || typeof one.token !== "string" || !B64URL.test(one.token) || one.token.length > 200
        || typeof one.key !== "string" || !B64URL.test(one.key) || one.key.length !== 43) continue;
      out.push({ kind: "relay", base, channel: one.channel, token: one.token, key: one.key });
    } else if (one.kind === "companion") {
      companions.push({ url: String(one.url), kind: one.net as CompanionEndpointKind, priority: Number(one.priority) });
    }
  }
  for (const endpoint of qrEndpoints(companions)) {
    if (seen.has(endpoint.url)) continue;
    seen.add(endpoint.url);
    out.push({ kind: "companion", url: endpoint.url, net: endpoint.kind, priority: endpoint.priority });
  }
  return out.slice(0, 10);
}

const toBase64Url = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromBase64Url = (value: string): string => {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
};

export function mobileLinkUrl(payload: MobileLinkPayload): string {
  return `madanibot://pair?m=${toBase64Url(JSON.stringify(payload))}`;
}

/** The payload a scanned QR or opened deep link carries, validated; null for anything else (an older link included). */
export function parseMobileLink(link: string): MobileLinkPayload | null {
  try {
    const url = new URL(link);
    if (url.protocol !== "madanibot:" || (url.host !== "pair" && url.pathname.replace(/^\/+/, "") !== "pair")) return null;
    const encoded = url.searchParams.get("m");
    if (!encoded || encoded.length > 8192 || !B64URL.test(encoded)) return null;
    return parseMobilePayload(JSON.parse(fromBase64Url(encoded)));
  } catch {
    return null;
  }
}

export function parseMobilePayload(value: unknown): MobileLinkPayload | null {
  const one = value as Partial<MobileLinkPayload> | null;
  if (!one || one.v !== MOBILE_LINK_VERSION || !one.workspace || !one.grant || !Array.isArray(one.via)) return null;
  const { workspace, grant } = one;
  if (typeof workspace.name !== "string" || !["vps", "mac", "server"].includes(workspace.kind)) return null;
  if (typeof grant.id !== "string" || typeof grant.secret !== "string" || !Number.isSafeInteger(grant.expiresAt)) return null;
  const via = mobileTransports(one.via);
  if (!via.length) return null;
  return {
    v: MOBILE_LINK_VERSION,
    workspace: { name: workspace.name.slice(0, 80), environmentId: typeof workspace.environmentId === "string" ? workspace.environmentId : null, kind: workspace.kind },
    grant: { id: grant.id, secret: grant.secret, expiresAt: grant.expiresAt, ...(Number.isSafeInteger(grant.issuedAt) && grant.issuedAt! <= grant.expiresAt ? { issuedAt: grant.issuedAt } : {}) },
    via,
  };
}

// The phone app's own records, kept beside the contract so both sides read one file. Long-lived tokens never appear
// here: a connection holds a reference into the phone's Keychain/Keystore, not the secret.

/** How the phone reaches a workspace, by the first route that answered. */
export type MobileTransportKind = MobileTransport["kind"];

export interface MobileRelayRoute {
  base: string;
  channel: string;
  /** The grant's one-time channel token and key (QR), or the device's own channel after redeem (key derived, not stored). */
  token?: string;
  key?: string;
  agentPub?: string;
}

/** A pairing link as the phone acts on it: the v2 payload's routes and grant, or an older server link's origin and
 * credential. Redeeming `credential` once mints the phone's own session. */
export interface MobilePairingPayload {
  v: number;
  transport: MobileTransportKind;
  /** The first direct origin: https, or the companion's address. */
  origin?: string;
  relay?: MobileRelayRoute;
  credential: string;
  code?: string;
  name?: string;
  environmentId?: string;
  endpoints?: CompanionEndpoint[];
  expiresAt?: number;
  issuedAt?: number;
  /** Every route of a v2 link, in the order to try them. Absent for an older link. */
  via?: MobileTransport[];
  grantId?: string;
  workspaceKind?: MobileLinkPayload["workspace"]["kind"];
}

/** What the phone may do on this connection, from the server's answer, never guessed from the transport. */
export interface MobileCapabilities {
  chat: boolean;
  uploads: boolean;
  computerView: boolean;
  computerControl: boolean;
  routines: boolean;
  settingsWrite: boolean;
  notifications: boolean;
  openOnDesktop: boolean;
}

/** One linked workspace on the phone. */
export interface MobileConnectionRecord {
  id: string;
  environmentId: string;
  label: string;
  transport: MobileTransportKind;
  origin?: string;
  relay?: MobileRelayRoute;
  /** The relay channel was opened after pairing, so `via` has no relay entry for it: it is walked as a route all the same. */
  relayLate?: true;
  /** Every route the workspace offered, tried in order on reconnect. */
  via?: MobileTransport[];
  /** Key of the bearer token in secure storage. */
  sessionRef: string;
  sessionId?: string;
  deviceId?: string;
  capabilities: MobileCapabilities;
  /** Server identity pin (SPKI) recorded at pairing. */
  identityPin?: string;
  /** The madani bot account this place belongs to, as that account listed it while the phone was signed in to it. */
  account?: { id: string; email: string };
  addedAt: number;
  lastUsedAt: number;
}

/** A place in a workspace, opened by link in either direction. The desktop's own chat links
 * (madanibot://thread/..., madanibot://bot/...) open chats; this adds views and notification targets. */
export interface MobileOpenTarget {
  environmentId?: string;
  botId?: string;
  groupId?: string;
  threadId?: string;
  messageId?: string;
  view?: "chat" | "computer" | "profile" | "routines" | "settings" | "notifications";
}

const LEGACY_CREDENTIAL = /^(?:madani|omb)_pair_[A-Za-z0-9_-]{43}$/;
const VIEWS = new Set<NonNullable<MobileOpenTarget["view"]>>(["chat", "computer", "profile", "routines", "settings", "notifications"]);

/** The phone's view of a v2 payload: the first direct origin and the relay route pulled out of `via`. */
export function pairingFromPayload(payload: MobileLinkPayload): MobilePairingPayload {
  const direct = payload.via.find((route) => route.kind === "https") ?? payload.via.find((route) => route.kind === "companion");
  const relay = payload.via.find((route): route is Extract<MobileTransport, { kind: "relay" }> => route.kind === "relay");
  const companions = payload.via.filter((route): route is Extract<MobileTransport, { kind: "companion" }> => route.kind === "companion");
  return {
    v: payload.v,
    transport: payload.via[0]!.kind,
    ...(direct ? { origin: direct.url } : {}),
    ...(relay ? { relay: { base: relay.base, channel: relay.channel, token: relay.token, key: relay.key } } : {}),
    credential: payload.grant.secret,
    name: payload.workspace.name,
    ...(payload.workspace.environmentId ? { environmentId: payload.workspace.environmentId } : {}),
    ...(companions.length ? { endpoints: companions.map((route) => ({ url: route.url, kind: route.net, priority: route.priority })) } : {}),
    expiresAt: payload.grant.expiresAt,
    ...(payload.grant.issuedAt !== undefined ? { issuedAt: payload.grant.issuedAt } : {}),
    via: payload.via,
    grantId: payload.grant.id,
    workspaceKind: payload.workspace.kind,
  };
}

function legacyOrigin(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `http://${value}`);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/** A scanned QR or opened pairing link: a v2 link first, else an older `madanibot://pair?address=&token=` link from
 * the server pairing card or the companion. Null when it is neither or anything required is malformed. */
export function parseMobilePairingLink(link: string): MobilePairingPayload | null {
  const payload = parseMobileLink(link.trim());
  if (payload) return pairingFromPayload(payload);
  let url: URL;
  try { url = new URL(link.trim()); } catch { return null; }
  if (url.protocol !== "madanibot:" || (url.hostname || url.pathname.replace(/^\/+/, "")) !== "pair") return null;
  const q = url.searchParams;
  const credential = q.get("token") ?? "";
  if (!LEGACY_CREDENTIAL.test(credential)) return null;
  const code = q.get("code") ?? undefined;
  if (code !== undefined && !/^[A-Za-z0-9]{6,12}$/.test(code)) return null;
  const origin = legacyOrigin(q.get("address"));
  if (!origin) return null;
  return {
    v: 1,
    transport: code ? "companion" : "https",
    origin,
    credential,
    ...(code ? { code } : {}),
    ...(q.get("name")?.trim() ? { name: q.get("name")!.trim() } : {}),
  };
}

/** `madanibot://open?...`: a view or notification target on the phone. */
export function mobileOpenLink(target: MobileOpenTarget): string {
  const fields: Array<[string, string | undefined]> = [
    ["env", target.environmentId], ["bot", target.botId], ["group", target.groupId],
    ["thread", target.threadId], ["message", target.messageId], ["view", target.view],
  ];
  const query = fields.filter(([, value]) => value).map(([key, value]) => `${key}=${encodeURIComponent(value!)}`).join("&");
  return `madanibot://open${query ? `?${query}` : ""}`;
}

/** The hosts whose `/m/` pages the phone app opens itself (the app's associated domains). */
export const UNIVERSAL_LINK_HOSTS: readonly string[] = ["madani.bot"];

/** The account sign-in a signed-in desktop's pairing QR carries beside the pairing: its phone sign-in code (`a=`,
 * shared/account-api.ts PhoneSignInGrant), the account's email (`ae=`) and its service (`as=`). The phone logs in to that
 * account and pairs in one step; apps that predate it pair alone. */
export type PairSignIn = { code: string; email: string; service?: SignInService };

/** The desktop's one QR: `https://madani.bot/m/pair#m=...&c=CODE`. With the app, iOS opens it there (the `m` pairs); without
 * it, the site's page sends them to the store and shows the typed code. Both ride after the `#`, which no server sees. */
export function universalPairLink(deepLink: string, code: string | null, signIn?: { code: string; email: string; serviceOrigin?: string | null } | null): string {
  let query = "";
  try { query = new URL(deepLink).search.slice(1); } catch {}
  const typed = code?.replace(/[^a-z0-9]/gi, "").toUpperCase();
  const account = signIn?.code.replace(/[^a-z]/gi, "").toUpperCase();
  const service = signIn?.serviceOrigin ? SIGN_IN_SERVICES[signIn.serviceOrigin] : undefined;
  const fields = [query, ...(typed ? [`c=${typed}`] : []), ...(account && signIn?.email.trim() ? [`a=${account}`, `ae=${encodeURIComponent(signIn.email.trim())}`] : []),
    ...(account && service ? [`as=${service}`] : [])].filter(Boolean);
  return `https://${UNIVERSAL_LINK_HOSTS[0]}/m/pair#${fields.join("&")}`;
}

/** The account sign-in a pairing QR or link carries, or null for one without it. */
export function pairSignIn(link: string): PairSignIn | null {
  const app = appLinkFromUniversal(link) ?? link.trim();
  let url: URL;
  try { url = new URL(app); } catch { return null; }
  if (url.protocol !== "madanibot:" || (url.hostname || url.pathname.replace(/^\/+/, "")) !== "pair") return null;
  const code = (url.searchParams.get("a") ?? "").toUpperCase();
  const email = (url.searchParams.get("ae") ?? "").trim();
  const service = url.searchParams.get("as");
  if (!/^[A-Z]{8}$/.test(code) || email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email)) return null;
  return { code, email, ...(service === "production" || service === "preview" ? { service } : {}) };
}

/** A madani cloud's QR: `https://madani.bot/m/signin#c=CODE&email=...`. `c`, a desktop's phone sign-in code
 * (shared/account-api.ts PhoneSignInGrant), logs the app in; without it the app opens its madani cloud sign-in with the email
 * filled in, as an app too old to know `c` does. */
/** The account service a sign-in link's code belongs to, as the link names it (`s=`): a code from one is unknown to the other. */
export type SignInService = "production" | "preview";
const SIGN_IN_SERVICES: Record<string, SignInService> = { "https://madani.bot": "production", "https://preview.madani.bot": "preview" };

/** A madani cloud's own address (`o=`): the cloud a QR drawn on it opens once the phone is logged in. */
const CLOUD_ORIGIN = /^https:\/\/d[0-9a-f]{20}\.madani\.bot$/;

export function universalSignInLink(email?: string | null, code?: string | null, serviceOrigin?: string | null, cloudOrigin?: string | null): string {
  const value = email?.trim(), typed = code?.replace(/[^a-z]/gi, "").toUpperCase();
  const service = serviceOrigin ? SIGN_IN_SERVICES[serviceOrigin] : undefined;
  const cloud = cloudOrigin && CLOUD_ORIGIN.test(cloudOrigin) ? cloudOrigin : undefined;
  const fields = [...(typed ? [`c=${typed}`] : []), ...(value ? [`email=${encodeURIComponent(value)}`] : []), ...(service ? [`s=${service}`] : []),
    ...(cloud ? [`o=${encodeURIComponent(cloud)}`] : [])];
  return `https://${UNIVERSAL_LINK_HOSTS[0]}/m/signin${fields.length ? `#${fields.join("&")}` : ""}`;
}

/** `madanibot://signin?c=...&email=...` (or the https link it stands for): the email to sign in with ("" when it names none)
 * and the phone sign-in code it carries, if any. */
export function parseSignInLink(link: string): { email: string; code?: string; service?: SignInService; cloud?: string } | null {
  const app = appLinkFromUniversal(link) ?? link.trim();
  let url: URL;
  try { url = new URL(app); } catch { return null; }
  if (url.protocol !== "madanibot:" || (url.hostname || url.pathname.replace(/^\/+/, "")) !== "signin") return null;
  const email = (url.searchParams.get("email") ?? "").trim();
  const code = (url.searchParams.get("c") ?? "").toUpperCase();
  const service = url.searchParams.get("s");
  const cloud = url.searchParams.get("o") ?? "";
  return { email: email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(email) ? email : "", ...(/^[A-Z]{8}$/.test(code) ? { code } : {}),
    ...(service === "production" || service === "preview" ? { service } : {}), ...(CLOUD_ORIGIN.test(cloud) ? { cloud } : {}) };
}

/** `https://madani.bot/m/open?...`, `https://madani.bot/m/pair#...` and `https://madani.bot/m/signin#...` as the `madanibot://`
 * link each stands for, or null for any other address. A pairing link carries its secret after the `#`, which a browser
 * never sends to the site. */
export function appLinkFromUniversal(link: string): string | null {
  let url: URL;
  try { url = new URL(link.trim()); } catch { return null; }
  if (url.protocol !== "https:" || !UNIVERSAL_LINK_HOSTS.includes(url.hostname) || url.port || url.username || url.password) return null;
  const fragment = url.hash.slice(1);
  if (url.pathname === "/m/open") {
    const query = url.search.slice(1) || fragment;
    return `madanibot://open${query ? `?${query}` : ""}`;
  }
  if (url.pathname === "/m/pair" && fragment && !url.search) return `madanibot://pair?${fragment}`;
  if (url.pathname === "/m/signin" && !url.search) return `madanibot://signin${fragment ? `?${fragment}` : ""}`;
  return null;
}

export function parseMobileOpenLink(link: string): MobileOpenTarget | null {
  let url: URL;
  try { url = new URL(link.trim()); } catch { return null; }
  if (url.protocol !== "madanibot:" || (url.hostname || url.pathname.replace(/^\/+/, "")) !== "open") return null;
  const q = url.searchParams;
  const id = (key: string) => { const value = q.get(key); return value && /^[A-Za-z0-9_.:-]{1,200}$/.test(value) ? value : undefined; };
  const view = q.get("view") as MobileOpenTarget["view"] | null;
  const target: MobileOpenTarget = {
    environmentId: id("env"), botId: id("bot"), groupId: id("group"), threadId: id("thread"), messageId: id("message"),
    view: view && VIEWS.has(view) ? view : undefined,
  };
  for (const key of Object.keys(target) as (keyof MobileOpenTarget)[]) if (target[key] === undefined) delete target[key];
  return target;
}
