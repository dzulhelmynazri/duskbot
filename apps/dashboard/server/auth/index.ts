import type { IncomingMessage, ServerResponse } from "node:http";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { accountIntentPath, cleanAccountIntent, type AccountIntent } from "../../../../shared/account-api.ts";
import { ACCOUNT_ROUTES as R, cleanPhoneSignInCode, PHONE_SIGN_IN_CODE_LENGTH, PHONE_SIGN_IN_TTL_MS, APP_AUTH_REDIRECT, APP_LANDING_PATH, CSRF_COOKIE, WEBSITE_HOMES, CSRF_HEADER, EMAIL_CODE_DIGITS, EMAIL_CODE_TRIES, EMAIL_CODE_TTL_SECONDS, EMAIL_RESEND_SECONDS, HANDOFF_PAGES, HANDOFF_PLANS, NOTIFICATION_DEFAULTS, OAUTH_PROVIDERS, SESSION_COOKIE } from "../../../../shared/account-api.ts";
import type { AccountAnswer, AccountErrorCode, AccountView, AppGrant, NotificationPrefs, AppSessionIdentity, HandoffAnswer, OAuthErrorCode, OAuthProvider, PhoneSignInGrant, WebHandoffAnswer, WebsiteHome, WebsiteSetup } from "../../../../shared/account-api.ts";
import { generatePairingCode, PAIRING_CODE_ALPHABET } from "../../../../server/sessions.ts";
import { CHECKOUT_SOURCES } from "../../../../shared/billing-api.ts";
import { parseUserAvatarChoice } from "../../../../shared/user-avatar.ts";
import { createAuthStore } from "./store.ts";
import type { Account, AdminRole, Identity, Session, StoredPhoneCode } from "./store.ts";
import { codeMessage, isTestAddress, magicLinkMessage, recoveryMessage } from "./mail.ts";
import type { Mailer } from "./mail.ts";
import { emailConfig } from "../email/templates.ts";
import type { EmailConfig } from "../email/templates.ts";
import { createProviderRegistry, type ProviderConfigs, type ProviderProfile } from "./providers.ts";
import { clientIp, rateIp } from "../client-ip.ts";

/** sign-in limits an hour, set so a real person never meets them; the per-code tries (EMAIL_CODE_TRIES), the resend
 *  wait and the overall mail cap are what stop abuse */
/** sign-in limits. starts are emails: one address gets at most startsPerEmail an hour and emailsPerAddressPerDay a day, so
 *  nobody can use us to flood a stranger's inbox. mailPerDay sits under brevo's free 300 a day, and addresses with no
 *  account (signups) only get newAddressShare of it, so a spray of made-up addresses never locks existing people out */
export const AUTH_LIMITS = { nativeApplePerIp: 300, startsPerIp: 60, startsPerEmail: 6, emailsPerAddressPerDay: 12, verifiesPerIp: 600, oauthPerIp: 600, deviceAuthorizePerIp: 300,
  mailPerHour: 120, mailPerDay: 250, newAddressShare: 0.8, handoffsPerSession: 60, handoffsPerIp: 600,
  phoneCodesPerSession: 20, phoneCodesPerAccount: 40, phoneRedeemsPerIp: 30, phoneWrongPerHour: 1000 };
/** App Review's fixed-code address (MADANI_REVIEW_EMAIL): starts an hour and a day */
export const REVIEW_LIMITS = { startsPerHour: 30, startsPerDay: 120 };
/** a web handoff link: how long it lives, and how many one account holds unredeemed at once (older ones are dropped) */
export const HANDOFF_TTL_MS = 120_000, HANDOFF_OUTSTANDING = 5;
/** live phone sign-in codes one account holds at once (older ones end), and how long a spent or ended one is remembered */
export const PHONE_CODES_OUTSTANDING = 3, PHONE_CODE_REMEMBERED_MS = 60 * 60_000;

export interface AuthOptions {
  dataDir: string; publicUrl: string; mailer: Mailer; email?: EmailConfig; now?: () => number; fetch?: typeof fetch;
  /** where the page is served on publicUrl ("/dashboard" when it shares the origin with the site, "" at the root) */
  pageBase?: string;
  /** sign-in emails the service sends an hour across everyone (MADANI_AUTH_MAIL_PER_HOUR, default AUTH_LIMITS.mailPerHour) */
  mailPerHour?: number;
  /** and a day (MADANI_AUTH_MAIL_PER_DAY, default AUTH_LIMITS.mailPerDay); raise it with the brevo plan */
  mailPerDay?: number;
  /** a service-wide sign-in mail limit was reached ("hour", "day" or "new" for the signup share of the day) */
  onMailLimit?: (kind: "hour" | "day" | "new") => void;
  oauth?: ProviderConfigs;
  /** App Review's sign-in (reviewAccountFromEnv): this one address signs in to the apps with this fixed code, and no email
   *  is sent to it. security: the code is checked only for this exact address, under the same per-address and per-ip
   *  limits and tries as an emailed code, and nothing else about the account changes */
  review?: ReviewAccount | null;
  dev: boolean; signupOpen: boolean; trustProxy: boolean; legacyAccounts?: () => Array<{ id: string; email: string }>;
  /** false before launch (waitlist-only): the website has no first steps then, so an account made by an app's sign-in counts
   *  as onboarded there at once */
  websiteFirstSteps?: boolean;
}
export interface ReviewAccount { email: string; code: string }
/** MADANI_REVIEW_EMAIL and MADANI_REVIEW_CODE (EMAIL_CODE_DIGITS digits, what the apps' code field takes), both or none */
export function reviewAccountFromEnv(env: Record<string, string | undefined>): ReviewAccount | null {
  const email = cleanEmail(env.MADANI_REVIEW_EMAIL), code = env.MADANI_REVIEW_CODE?.trim() ?? "";
  if (!env.MADANI_REVIEW_EMAIL && !env.MADANI_REVIEW_CODE) return null;
  if (!email || !new RegExp(`^\\d{${EMAIL_CODE_DIGITS}}$`).test(code)) throw new Error(`MADANI_REVIEW_EMAIL needs a valid address and MADANI_REVIEW_CODE ${EMAIL_CODE_DIGITS} digits.`);
  return { email, code };
}
export class AuthError extends Error {
  status: number;
  code: AccountErrorCode;
  fields: Record<string, unknown>;
  constructor(status: number, code: AccountErrorCode, fields: Record<string, unknown> = {}) {
    super(messages[code] ?? "Request failed."); this.status = status; this.code = code; this.fields = fields;
  }
}
const messages: Partial<Record<AccountErrorCode, string>> = {
  billing_active: "Cancel your plan and madani cloud before deleting your account.",
  delete_on_account_page: "Delete your account on your account page.",
  invalid_request: "Invalid request.", invalid_email: "Enter a valid email address.", wrong_code: "Code is incorrect.", invalid_code: "Code is incorrect.",
  expired: "Sign-in has expired.", rate_limited: "Try again later.", signup_closed: "New accounts are not available.", signed_out: "Sign in to continue.",
  csrf: "Refresh the page and try again.", confirm: "Confirm the account to continue.", other_account: "This browser is signed in to another account.", forbidden: "Request is not allowed.", not_found: "Not found.", invalid_token: "Session is invalid.", invalid_grant: "Grant is invalid.",
};
const day = 86_400_000, hour = 3_600_000;
const random = () => randomBytes(32).toString("base64url");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const opaque = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const controls = (value: string) => [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const label = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.trim().length <= max && !controls(value);
export function cleanEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && !controls(email) && /^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email) ? email : null;
}
export function isAppCorsRoute(path: string) {
  return path.startsWith("/api/cloud/app/sign-in/") || [R.appSession, R.appAvatar, R.enrollGrant, R.webHandoff, R.appToken, R.appDeleteAccount].some(route => route === path);
}
interface DeviceInfo { name: string; platform: string; appVersion: string | null }
interface Attempt { email: string; codeHash: string; pending?: string; device: DeviceInfo | null; expiresAt: number; tries: number }
interface DeviceAuthorization { userCode: string; device: DeviceInfo; expiresAt: number; interval: number; lastPollAt: number | null; accountId: string | null; denied: boolean; intent?: AccountIntent; createdAt?: number }
interface AppFlow { challenge: string; state: string; landing?: true; expiresAt: number }
interface OAuthState { provider: OAuthProvider; nonce: string; verifier: string; bindingHash: string; next: string; linkAccount: string | null; linkSession: string | null; appFlow?: string; expiresAt: number }
interface PendingIdentity { provider: OAuthProvider; profile: ProviderProfile; next: string; appFlow?: string; bindingHash: string; expiresAt: number }
interface Handoff { accountId: string; sessionId: string; next: string; expiresAt: number }
interface BodyHelpers { readBody(req: IncomingMessage): Promise<Buffer>; bodyObject(body: Buffer): Record<string, unknown> }

export function createAuth(options: AuthOptions) {
  const now = options.now ?? Date.now;
  const publicUrl = new URL(options.publicUrl).origin, pageBase = options.pageBase ?? "", pages = `${publicUrl}${pageBase}`;
  const emailCfg = options.email ?? emailConfig(process.env, { publicUrl, pageBase });
  const store = createAuthStore(options.dataDir), state = store.state;
  const providers = createProviderRegistry(options.oauth, { fetch: options.fetch, now });
  const oauthStates = new Map<string, OAuthState>();
  const pendingIdentities = new Map<string, PendingIdentity>();
  const appFlows = new Map<string, AppFlow>();
  const appCodes = new Map<string, { challenge: string; accountId: string; expiresAt: number }>();
  // sign-in codes in flight are saved (only their hmac), so a deploy between sending a code and typing it does not kill it
  const attempts = new Map<string, Attempt>((state.codes ?? []).map(({ id, ...item }) => [id, item]));
  const saveAttempts = () => { state.codes = [...attempts].map(([id, item]) => ({ id, ...item })); store.changed(); };
  attempts.set = function (key, value) { Map.prototype.set.call(this, key, value); saveAttempts(); return this; };
  attempts.delete = function (key) { const had = Map.prototype.delete.call(this, key); if (had) saveAttempts(); return had; };
  // desktop sign-ins waiting for approval are saved too: a deploy while the approve page is open must not end them
  const devices = new Map<string, DeviceAuthorization>((state.devices ?? []).map(({ id, ...item }) => [id, item]));
  const saveDevices = () => { state.devices = [...devices].map(([id, item]) => ({ id, ...item })); store.changed(); };
  devices.set = function (key, value) { Map.prototype.set.call(this, key, value); saveDevices(); return this; };
  devices.delete = function (key) { const had = Map.prototype.delete.call(this, key); if (had) saveDevices(); return had; };
  const expiredDevices = new Map<string, number>();
  // phone sign-in codes are saved (only their hmac) so a deploy does not end the code on a desktop's screen
  const phoneCodes = new Map<string, StoredPhoneCode>((state.phoneCodes ?? []).map(item => [item.codeHash, item]));
  const savePhoneCodes = () => { state.phoneCodes = [...phoneCodes.values()]; store.changed(); };
  const grants = new Map<string, { accountId: string; sessionId: string; expiresAt: number }>();
  // kept apart from `grants`: an enroll token never signs a browser in, and a handoff token never enrolls a workspace
  const handoffs = new Map<string, Handoff>();
  const limits = new Map<string, { count: number; until: number }>();
  const sentAt = new Map<string, number>();
  const extensions: Array<(accountId: string) => Promise<Record<string, unknown>> | Record<string, unknown>> = [];
  const beforeDeleteHooks: Array<(owner: Account, body: Record<string, unknown>) => void | Promise<void>> = [];
  const deletedHooks: Array<(accountId: string, email: string | null) => void | Promise<void>> = [];
  const createdHooks: Array<(account: Account) => void> = [];
  const signedInHooks: Array<(account: Account) => void> = [];
  const sessionHooks: Array<(session: Session) => void> = [];
  const appSeenHooks: Array<(session: Session) => void> = [];
  const hmac = (value: string) => createHmac("sha256", store.secret).update(value).digest("base64url");
  const sealKey = createHash("sha256").update(`provider-token:${store.secret}`).digest();
  function seal(value: string) {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", sealKey, iv), data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
  }
  function unseal(value: string) {
    const raw = Buffer.from(value, "base64url"), decipher = createDecipheriv("aes-256-gcm", sealKey, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  }
  /** best effort: a deletion or unlink never waits on Apple answering */
  /** the sealed grants of an identity: the newest refresh token per client id, as json; a bare token (the first format) is the
   *  services id's */
  type Grant = { clientId?: string; token: string };
  function grantsOf(identity: Identity): Grant[] {
    if (!identity.revoke) return [];
    let text: string;
    try { text = unseal(identity.revoke); } catch { return []; }
    try {
      const data = JSON.parse(text) as unknown;
      if (Array.isArray(data)) return data.filter((item): item is Grant => typeof item?.token === "string" && (item.clientId === undefined || typeof item.clientId === "string"));
    } catch { /* the first format */ }
    return [{ token: text }];
  }
  async function revokeProvider(identity: Identity) {
    const provider = providers.get(identity.provider);
    if (!provider?.revoke) return;
    await Promise.all(grantsOf(identity).map(async grant => {
      try { await provider.revoke!(grant.token, grant.clientId); } catch { console.error(`Revoking a ${identity.provider} sign-in failed.`); }
    }));
  }
  const csrfFor = (session: Session) => hmac(session.tokenHash);
  const fail = (status: number, code: AccountErrorCode, fields?: Record<string, unknown>): never => { throw new AuthError(status, code, fields); };
  const account = (id: string) => state.accounts.find(item => item.id === id) ?? null;
  function sweep() {
    const time = now();
    for (const [key, item] of oauthStates) if (item.expiresAt + 600_000 <= time) oauthStates.delete(key);
    for (const [key, item] of pendingIdentities) if (item.expiresAt <= time) pendingIdentities.delete(key);
    for (const [key, item] of appFlows) if (item.expiresAt + 900_000 <= time) appFlows.delete(key);
    for (const [key, item] of appCodes) if (item.expiresAt <= time) appCodes.delete(key);
    for (const [key, item] of attempts) if (item.expiresAt <= time) attempts.delete(key);
    for (const [key, item] of grants) if (item.expiresAt <= time) grants.delete(key);
    for (const [key, item] of handoffs) if (item.expiresAt <= time) handoffs.delete(key);
    let phoneGone = false;
    for (const [key, item] of phoneCodes) if (item.expiresAt + PHONE_CODE_REMEMBERED_MS <= time) { phoneCodes.delete(key); phoneGone = true; }
    if (phoneGone) savePhoneCodes();
    for (const [key, item] of devices) if (item.expiresAt <= time) { expiredDevices.set(key, item.expiresAt + hour); devices.delete(key); }
    for (const [key, until] of expiredDevices) if (until <= time) expiredDevices.delete(key);
    for (const [key, item] of limits) if (item.until <= time) limits.delete(key);
    for (const [key, timeSent] of sentAt) if (timeSent + EMAIL_RESEND_SECONDS * 1000 <= time) sentAt.delete(key);
    dropSessions(item => item.expiresAt <= time);
  }
  /** removes sessions, and with them every handoff web session whose app session is gone (security: no orphan outlives it) */
  function dropSessions(drop: (session: Session) => boolean) {
    const gone = new Set(state.sessions.filter(drop).map(item => item.id));
    const sessions = state.sessions.filter(item => !gone.has(item.id));
    const live = new Set(sessions.map(item => item.id));
    state.sessions = sessions.filter(item => !item.parentId || live.has(item.parentId));
    if (gone.size || state.sessions.length !== sessions.length) store.changed();
  }
  const timer = setInterval(sweep, 60_000);
  timer.unref();
  const ip = (req: IncomingMessage) => rateIp(clientIp(req, options.trustProxy));
  function rate(key: string, max: number, windowMs = hour, onFull?: () => void) {
    const item = limits.get(key) ?? { count: 0, until: now() + windowMs };
    limits.set(key, item);
    if (++item.count > max) { if (item.count === max + 1) onFull?.(); fail(429, "rate_limited"); }
  }
  function lookup(token: string, web: boolean) {
    sweep();
    const tokenHash = hash(token);
    const session = state.sessions.find(item => item.tokenHash === tokenHash && (item.kind === "web") === web);
    const owner = session && account(session.accountId);
    return session && owner ? { account: owner, session } : null;
  }
  function webSession(req: IncomingMessage) {
    const token = req.headers.cookie?.split(";").map(item => item.trim()).find(item => item.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
    return opaque(token) ? lookup(token, true) : null;
  }
  function requireWeb(req: IncomingMessage, { mutation }: { mutation: boolean }) {
    const found = webSession(req);
    if (!found) return fail(401, "signed_out");
    if (mutation) {
      const csrf = req.headers[CSRF_HEADER];
      if (typeof csrf !== "string" || !opaque(csrf) || !timingSafeEqual(Buffer.from(csrf), Buffer.from(csrfFor(found.session)))) fail(403, "csrf");
    }
    return found.account;
  }
  function appSession(req: IncomingMessage) {
    const bearer = req.headers.authorization;
    if (!bearer || !/^Bearer omc_[A-Za-z0-9_-]{43}$/.test(bearer)) return null;
    const found = lookup(bearer.slice(7), false);
    if (!found) return null;
    let changed = false;
    if (now() - found.session.lastSeenAt >= 60_000) { found.session.lastSeenAt = now(); changed = true; }
    if (found.session.expiresAt - now() < 30 * day) { found.session.expiresAt = now() + 90 * day; changed = true; }
    if (changed) store.changed();
    for (const hook of appSeenHooks) hook(found.session);
    return found;
  }
  function view(owner: Account): AccountView {
    return { id: owner.id, email: owner.email, name: owner.name, createdAt: owner.createdAt, providers: ["email", ...OAUTH_PROVIDERS.filter(provider => state.identities.some(item => item.accountId === owner.id && item.provider === provider))],
      ...(owner.avatarUrl ? { avatarUrl: owner.avatarUrl } : {}), ...(owner.avatar ? { avatar: owner.avatar } : {}) };
  }
  function notificationsOf(owner: Account): NotificationPrefs {
    return { cloudStatus: owner.notifications?.cloudStatus ?? NOTIFICATION_DEFAULTS.cloudStatus, product: owner.notifications?.product ?? NOTIFICATION_DEFAULTS.product };
  }
  function accountAnswer(owner: Account, current: string | undefined): AccountAnswer {
    return { notifications: notificationsOf(owner), onboarded: owner.onboardedAt !== undefined, account: view(owner), identities: state.identities.filter(item => item.accountId === owner.id).map(({ provider, email, label, addedAt }) => ({ provider, email, label, addedAt })),
      sessions: state.sessions.filter(item => item.accountId === owner.id).sort((a, b) => b.createdAt - a.createdAt).map(({ id, kind, name, platform, appVersion, createdAt, lastSeenAt, expiresAt }) =>
        ({ id, kind, name, platform, appVersion, createdAt, lastSeenAt, expiresAt, current: id === current })) };
  }
  function cookies(res: ServerResponse, token = "", csrf = "") {
    const flags = `Path=/; Max-Age=${token ? 30 * day / 1000 : 0}${publicUrl.startsWith("https:") ? "; Secure" : ""}`;
    res.setHeader("set-cookie", [`${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; ${flags}`, `${CSRF_COOKIE}=${csrf}; SameSite=Strict; ${flags}`]);
  }
  function makeSession(owner: Account, device: DeviceInfo | null, { signedInAt = now(), parentId }: { signedInAt?: number; parentId?: string } = {}) {
    const token = `${device ? "omc_" : ""}${random()}`;
    const session: Session = { id: `ses_${randomBytes(16).toString("base64url")}`, accountId: owner.id, tokenHash: hash(token),
      kind: device ? ["ios", "android"].includes(device.platform) ? "mobile" : "desktop" : "web", name: device?.name ?? "Browser",
      platform: device?.platform ?? null, appVersion: device?.appVersion ?? null, createdAt: signedInAt, lastSeenAt: now(), expiresAt: now() + (device ? 90 : 30) * day, ...(parentId ? { parentId } : {}) };
    state.sessions.push(session);
    store.changed();
    for (const hook of sessionHooks) hook(session);
    return { token, session };
  }
  function identity(owner: Account, session: Session): AppSessionIdentity {
    return { cloudContractVersion: 1, expiresAt: session.expiresAt, device: { id: session.id },
      account: { id: owner.id, email: owner.email, ...(owner.name ? { name: owner.name } : {}), ...(owner.avatarUrl ? { avatarUrl: owner.avatarUrl } : {}), ...(owner.avatar ? { avatar: owner.avatar } : {}) } };
  }
  /** an account signed in to an app had its first run there: the website never walks it through a second one */
  function onboardedInApp(owner: Account) { if (owner.onboardedAt === undefined) { owner.onboardedAt = now(); store.changed(); } }
  /** made by an app's browser sign-in, its website first steps not done yet: the app waits on them, so its links to the
   *  website (a handoff) open them rather than end them */
  const websiteStepsOpen = (owner: Account) => owner.onboardedAt === undefined && owner.signedUpFrom !== undefined && options.websiteFirstSteps !== false;
  /** `onboard` false: the account was just made through this app's sign-in, and the website is taking it through its first
   *  steps (name, plan) right now; that finishes them there, not this */
  function appGrant(owner: Account, device: DeviceInfo, { onboard = true }: { onboard?: boolean } = {}): AppGrant {
    if (onboard) onboardedInApp(owner);
    const { token, session } = makeSession(owner, device);
    return { ...identity(owner, session), accessToken: token };
  }
  function deviceInfo(data: Record<string, unknown>, versionRequired: boolean): DeviceInfo {
    if (!label(data.deviceName, 100) || (data.deviceName as string).length > 100 || typeof data.platform !== "string" || !["darwin", "win32", "linux", "ios", "android"].includes(data.platform)
      || ((versionRequired || data.appVersion !== undefined) && (typeof data.appVersion !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/.test(data.appVersion)))) return fail(400, "invalid_request");
    return { name: data.deviceName, platform: data.platform, appVersion: typeof data.appVersion === "string" ? data.appVersion : null };
  }
  /** `magicNext`: the desktop app's email sign-in: a one-time link to the website that signs in (or up) and goes on there */
  async function start(req: IncomingMessage, data: Record<string, unknown>, app: boolean, magicNext?: string) {
    const email = cleanEmail(data.email);
    if (!email) return fail(400, app ? "invalid_request" : "invalid_email");
    if (data.pending !== undefined && (app || !opaque(data.pending) || !pendingFor(req, data.pending))) fail(400, "invalid_request");
    if (data.recover !== undefined && (data.recover !== true || data.pending !== undefined)) fail(400, "invalid_request");
    const device = app ? deviceInfo(data, true) : null;
    // the resend wait, by its own clock: the sweep that drops it runs only once a minute
    if ((sentAt.get(email) ?? -Infinity) + EMAIL_RESEND_SECONDS * 1000 > now()) fail(429, "rate_limited");
    rate(`start:${ip(req)}`, AUTH_LIMITS.startsPerIp);
    // App Review's address sends no mail and is tried by several reviewers and devices: roomier limits, still far too few to guess its code
    const review = app && options.review && email === options.review.email && data.recover === undefined;
    rate(`email:${email}`, review ? REVIEW_LIMITS.startsPerHour : AUTH_LIMITS.startsPerEmail);
    rate(`email-day:${email}`, review ? REVIEW_LIMITS.startsPerDay : AUTH_LIMITS.emailsPerAddressPerDay, day);
    if (review && options.review) {
      sentAt.set(email, now());
      const attempt = random();
      attempts.set(hash(attempt), { email, codeHash: hmac(`${attempt}:${options.review.code}`), device, expiresAt: now() + EMAIL_CODE_TTL_SECONDS * 1000, tries: 0 });
      return { cloudContractVersion: 1, attempt, expiresIn: EMAIL_CODE_TTL_SECONDS, resendAfter: EMAIL_RESEND_SECONDS, signupOpen: options.signupOpen };
    }
    // every address and caller together: one botnet spread over many addresses cannot burn the mail quota or our sender reputation
    const perDay = options.mailPerDay ?? AUTH_LIMITS.mailPerDay, limited = (kind: "hour" | "day" | "new") => () => options.onMailLimit?.(kind);
    // the signup share first, so a spray it turns away does not eat the day that is kept for existing accounts
    // a test address's mail never leaves the service (mail.ts), so it spends none of the provider's quota
    if (!isTestAddress(email)) {
      if (!state.accounts.some(item => item.email === email)) rate("mail:new", Math.floor(perDay * AUTH_LIMITS.newAddressShare), day, limited("new"));
      rate("mail:all", options.mailPerHour ?? AUTH_LIMITS.mailPerHour, hour, limited("hour"));
      rate("mail:day", perDay, day, limited("day"));
    }
    sentAt.set(email, now());
    const attempt = random(), code = randomInt(0, 100_000_000).toString().padStart(8, "0");
    const item: Attempt = { email, ...(typeof data.pending === "string" ? { pending: data.pending } : {}), codeHash: hmac(`${attempt}:${code}`), device, expiresAt: now() + EMAIL_CODE_TTL_SECONDS * 1000, tries: 0 };
    attempts.set(hash(attempt), item);
    if (data.recover === true) {
      // can't sign in: the code, a one-time link for the website, and the ways this address signs in; for no account, only
      // that. answered before delivery, the same either way, so the answer never tells whether the address has an account
      const owner = state.accounts.find(item => item.email === email);
      // the attempt (not a secret without its code) rides in the query so a page that only opens for a real flow can check it
      const link = owner && !app ? `${pages}/sign-in?${new URLSearchParams({ attempt })}#${new URLSearchParams({ code })}` : null;
      void options.mailer.send(recoveryMessage(email, { code, link, ways: owner ? view(owner).providers : null }, emailCfg)).catch(() => console.error("Email delivery failed."));
    } else if (magicNext) {
      if (options.signupOpen || state.accounts.some(item => item.email === email)) {
        const link = `${pages}/sign-in?${new URLSearchParams({ attempt, next: magicNext })}#${new URLSearchParams({ code })}`;
        try { await options.mailer.send(magicLinkMessage(email, link, emailCfg)); } catch { attempts.delete(hash(attempt)); fail(502, "failed"); }
      }
    } else if (options.signupOpen) {
      try { await options.mailer.send(codeMessage(email, code, emailCfg)); } catch { attempts.delete(hash(attempt)); fail(502, "failed"); }
    } else if (state.accounts.some(item => item.email === email)) {
      // signups closed: answer before delivery so timing and mail failures never tell whether the address has an account
      void options.mailer.send(codeMessage(email, code, emailCfg)).catch(() => console.error("Email delivery failed."));
    }
    return { ...(app ? { cloudContractVersion: 1 } : {}), attempt, expiresIn: EMAIL_CODE_TTL_SECONDS, resendAfter: EMAIL_RESEND_SECONDS, signupOpen: options.signupOpen };
  }
  function verifyEmail(req: IncomingMessage, res: ServerResponse, data: Record<string, unknown>, app: boolean) {
    rate(`verify:${ip(req)}`, AUTH_LIMITS.verifiesPerIp);
    const key = opaque(data.attempt) ? hash(data.attempt) : "";
    const attempt = attempts.get(key);
    if (!attempt || attempt.expiresAt <= now()) return fail(410, "expired");
    if (!!attempt.device !== app) return fail(400, "invalid_request");
    let owner = state.accounts.find(item => item.email === attempt.email);
    const supplied = hmac(`${data.attempt}:${typeof data.code === "string" ? data.code : ""}`);
    if (!timingSafeEqual(Buffer.from(supplied), Buffer.from(attempt.codeHash))) {
      if (++attempt.tries >= EMAIL_CODE_TRIES) attempts.delete(key); else saveAttempts();
      return fail(400, app ? "invalid_code" : "wrong_code");
    }
    attempts.delete(key);
    // the code was used: the resend wait guarded it, so signing out and in again at once may send the next one
    sentAt.delete(attempt.email);
    if (!owner && !options.signupOpen && !(app && options.review?.email === attempt.email)) return fail(403, "signup_closed");
    // a pending identity finishes only in the browser that signed in to the provider, never through a link sent to someone else
    const pending = attempt.pending ? pendingFor(req, attempt.pending) : undefined;
    if (attempt.pending && (!pending || pending.expiresAt <= now())) return fail(410, "expired");
    if (pending?.appFlow && !activeFlow(pending.appFlow)) return fail(410, "expired");
    if (pending) {
      const existing = linkedIdentity(pending.provider, pending.profile.subject);
      if (existing && existing.accountId !== owner?.id) return fail(409, "identity_taken");
    }
    const created = !owner;
    if (!owner) {
      const legacy = options.legacyAccounts?.().find(item => cleanEmail(item.email) === attempt.email);
      owner = { id: legacy?.id ?? `acct_${randomBytes(16).toString("base64url")}`, email: attempt.email, name: null, createdAt: now() };
      state.accounts.push(owner);
      store.changed();
    }
    let redirect: string | undefined;
    if (pending && attempt.pending) {
      pendingIdentities.delete(attempt.pending);
      attach(owner, pending.provider, pending.profile);
      redirect = pending.appFlow ? appRedirect(pending.appFlow, owner) : pending.next;
    }
    for (const hook of signedInHooks) hook(owner);
    if (created) for (const hook of createdHooks) hook(owner);
    if (attempt.device) return appGrant(owner, attempt.device);
    const { token, session } = makeSession(owner, null), csrfToken = csrfFor(session);
    cookies(res, token, csrfToken);
    return { account: view(owner), csrfToken, created, ...(redirect ? { redirect } : {}) };
  }
  const equal = (a: string, b: string) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
  function nextPath(value: string | null) {
    if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || controls(value) || value.length > 512) return "/";
    const target = new URL(value, publicUrl);
    if (target.origin !== publicUrl || target.pathname.startsWith("//")) return "/";
    return `${target.pathname}${target.search}${target.hash}`;
  }
  const linkedIdentity = (provider: OAuthProvider, subject: string) => state.identities.find(item => item.provider === provider && item.subject === subject);
  function attach(owner: Account, provider: OAuthProvider, profile: ProviderProfile) {
    const existing = linkedIdentity(provider, profile.subject);
    if (existing && existing.accountId !== owner.id) return fail(409, "identity_taken");
    // the newest apple refresh token per client (the website's services id, the iphone app's bundle id) replaces the last
    const fresh = profile.refreshToken ? { clientId: profile.refreshClient, token: profile.refreshToken } : null;
    const revoke = fresh ? { revoke: seal(JSON.stringify([...(existing ? grantsOf(existing) : []).filter(item => item.clientId !== fresh.clientId), fresh])) } : {};
    if (!existing) state.identities.push({ accountId: owner.id, provider, subject: profile.subject, email: profile.email, label: profile.label, addedAt: now(), ...revoke });
    else if (revoke.revoke) existing.revoke = revoke.revoke;
    if (owner.name === null && profile.name) owner.name = profile.name;
    if (profile.picture) owner.avatarUrl = profile.picture;
    store.changed();
  }
  function pendingFor(req: IncomingMessage, id: string) {
    const item = pendingIdentities.get(id), cookie = binding(req);
    return item && opaque(cookie) && equal(hash(cookie), item.bindingHash) ? item : undefined;
  }
  function binding(req: IncomingMessage) {
    return req.headers.cookie?.split(";").map(item => item.trim()).find(item => item.startsWith("madani_oauth="))?.slice(11);
  }
  function oauthCookie(res: ServerResponse, value = "") {
    const secure = publicUrl.startsWith("https:");
    res.appendHeader("set-cookie", `madani_oauth=${value}; HttpOnly; Path=/v1/auth; Max-Age=${value ? 600 : 0}; SameSite=${secure ? "None; Secure" : "Lax"}`);
  }
  function redirect(res: ServerResponse, location: string) { res.writeHead(302, { location, "referrer-policy": "no-referrer" }); res.end(); }
  function oauthError(res: ServerResponse, code: OAuthErrorCode, next = "/", flowId?: string) {
    const flow = flowId ? appFlows.get(flowId) : undefined;
    if (flowId) appFlows.delete(flowId);
    const query = new URLSearchParams({ error: code, ...(flow ? { state: flow.state } : { next }) });
    oauthCookie(res);
    redirect(res, `${flow ? APP_AUTH_REDIRECT : `${pageBase}/sign-in`}?${query}`);
  }
  function activeFlow(id: string) { const flow = appFlows.get(id); return flow && flow.expiresAt > now() ? flow : null; }
  function appRedirect(id: string, owner: Account) {
    const flow = activeFlow(id);
    if (!flow) return fail(410, "expired");
    appFlows.delete(id);
    const code = random();
    appCodes.set(hash(code), { challenge: flow.challenge, accountId: owner.id, expiresAt: now() + 300_000 });
    const query = new URLSearchParams({ code, state: flow.state });
    // the desktop app: a page of ours that opens the app and says so, never the provider's page left up in the browser
    return flow.landing ? `${pageBase}${APP_LANDING_PATH}#${query}` : `${APP_AUTH_REDIRECT}?${query}`;
  }
  function oauthStart(req: IncomingMessage, res: ServerResponse, url: URL, id: string, flowId?: string) {
    const next = nextPath(url.searchParams.get("next")), provider = providers.get(id as OAuthProvider);
    if (!provider) return oauthError(res, "provider_unavailable", next, flowId);
    const link = url.searchParams.get("link") === "1" ? webSession(req) : null;
    if (url.searchParams.get("link") === "1" && !link) return oauthError(res, "oauth_failed", next, flowId);
    const existing = binding(req), cookie = opaque(existing) ? existing : random();
    const key = random(), nonce = random(), verifier = id === "apple" ? "" : random();
    oauthStates.set(hash(key), { provider: provider.id, nonce, verifier, bindingHash: hash(cookie), next, linkAccount: link?.account.id ?? null,
      linkSession: link?.session.id ?? null, ...(flowId ? { appFlow: flowId } : {}), expiresAt: now() + 600_000 });
    oauthCookie(res, cookie);
    redirect(res, provider.authorize({ state: key, nonce, verifier, redirectUri: `${publicUrl}${R.oauthCallback(provider.id)}` }));
  }
  async function oauthCallback(req: IncomingMessage, res: ServerResponse, url: URL, id: string, helpers: BodyHelpers) {
    let item: OAuthState | undefined;
    try {
      let params = url.searchParams;
      if (id === "apple" && req.method === "POST") {
        if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/x-www-form-urlencoded") throw new Error();
        const raw = await helpers.readBody(req);
        if (raw.length > 65_536 || url.search) throw new Error();
        params = new URLSearchParams(raw.toString("utf8"));
      }
      const key = params.get("state"), stored = opaque(key) ? oauthStates.get(hash(key)) : undefined;
      if (opaque(key)) oauthStates.delete(hash(key));
      if (!stored || stored.provider !== id) throw new Error();
      item = stored;
      const cookie = binding(req);
      if (!opaque(cookie) || !equal(hash(cookie), item.bindingHash)) throw new Error();
      if (item.expiresAt <= now() || (item.appFlow && !activeFlow(item.appFlow))) return oauthError(res, "oauth_expired", item.next, item.appFlow);
      if (req.method !== (id === "apple" ? "POST" : "GET") || [...params.keys()].some(key => params.getAll(key).length !== 1)) throw new Error();
      if (params.get("error") === "access_denied") return oauthError(res, "oauth_denied", item.next, item.appFlow);
      const code = params.get("code"), provider = providers.get(item.provider);
      if (params.has("error") || !code || code.length > 4096 || controls(code) || !provider) throw new Error();
      const profile = await provider.profile({ code, nonce: item.nonce, verifier: item.verifier, redirectUri: `${publicUrl}${R.oauthCallback(item.provider)}`, user: params.get("user") ?? undefined });
      if (item.expiresAt <= now() || (item.appFlow && !activeFlow(item.appFlow))) return oauthError(res, "oauth_expired", item.next, item.appFlow);
      const existing = linkedIdentity(item.provider, profile.subject);
      let owner: Account | null | undefined, created = false;
      if (item.linkAccount) {
        owner = account(item.linkAccount);
        if (!owner || !state.sessions.some(session => session.id === item!.linkSession && session.accountId === owner!.id && session.expiresAt > now())) throw new Error();
        if (existing && existing.accountId !== owner.id) return oauthError(res, "identity_taken", item.next, item.appFlow);
      } else if (existing) { owner = account(existing.accountId); if (!owner) throw new Error(); }
      else if (profile.email) owner = state.accounts.find(owner => owner.email === profile.email);
      if (!owner && !profile.email) {
        const pending = random();
        pendingIdentities.set(pending, { provider: item.provider, profile, next: item.next, appFlow: item.appFlow, bindingHash: item.bindingHash, expiresAt: now() + 600_000 });
        oauthCookie(res, cookie);
        return redirect(res, `${pageBase}/sign-in?${new URLSearchParams({ pending, next: item.next })}`);
      }
      if (!owner) {
        if (!options.signupOpen) return oauthError(res, "signup_closed", item.next, item.appFlow);
        const legacy = options.legacyAccounts?.().find(owner => cleanEmail(owner.email) === profile.email);
        owner = { id: legacy?.id ?? `acct_${randomBytes(16).toString("base64url")}`, email: profile.email!, name: null, createdAt: now() };
        state.accounts.push(owner);
        created = true;
      }
      attach(owner, item.provider, profile);
      for (const hook of signedInHooks) hook(owner);
      if (created) for (const hook of createdHooks) hook(owner);
      if (item.appFlow) { const location = appRedirect(item.appFlow, owner); oauthCookie(res); return redirect(res, location); }
      const { token, session } = makeSession(owner, null);
      cookies(res, token, csrfFor(session)); oauthCookie(res);
      redirect(res, `${pageBase}${item.next}`);
    } catch { oauthError(res, "oauth_failed", item?.next, item?.appFlow); }
  }
  /** the iphone app's sign in with apple: a verified identity token and its code make an app session, linking by apple's
   *  verified email (a private relay address too) exactly as the web flow does */
  async function nativeApple(req: IncomingMessage, data: Record<string, unknown>): Promise<AppGrant> {
    rate(`oauth:${ip(req)}`, AUTH_LIMITS.oauthPerIp);
    rate(`native-apple:${ip(req)}`, AUTH_LIMITS.nativeApplePerIp);
    if (!providers.nativeApple) return fail(503, "provider_unavailable");
    const known = ["identityToken", "authorizationCode", "nonce", "givenName", "familyName", "deviceName", "platform", "appVersion"];
    const name = (value: unknown) => value === undefined || value === null || (typeof value === "string" && value.length <= 80 && !controls(value));
    if (Object.keys(data).some(key => !known.includes(key)) || typeof data.identityToken !== "string" || data.identityToken.length > 8192
      || typeof data.authorizationCode !== "string" || !/^[A-Za-z0-9._-]{1,512}$/.test(data.authorizationCode)
      || typeof data.nonce !== "string" || !/^[A-Za-z0-9._~-]{16,128}$/.test(data.nonce) || !name(data.givenName) || !name(data.familyName)
      || !["ios", "darwin"].includes(data.platform as string)) return fail(400, "invalid_request");
    const device = deviceInfo(data, true);
    let profile: ProviderProfile;
    try {
      profile = await providers.nativeApple({ identityToken: data.identityToken, authorizationCode: data.authorizationCode, nonce: data.nonce, givenName: data.givenName as string | undefined, familyName: data.familyName as string | undefined });
    } catch { return fail(400, "invalid_grant"); }
    const existing = linkedIdentity("apple", profile.subject);
    let owner = existing ? account(existing.accountId) : profile.email ? state.accounts.find(item => item.email === profile.email) ?? null : null, created = false;
    if (existing && !owner) return fail(400, "invalid_grant");
    if (!owner) {
      // apple always shares an address (a private relay one if the person hides theirs); none means the token is not usable
      if (!profile.email) return fail(400, "invalid_grant");
      if (!options.signupOpen) return fail(403, "signup_closed");
      const legacy = options.legacyAccounts?.().find(item => cleanEmail(item.email) === profile.email);
      owner = { id: legacy?.id ?? `acct_${randomBytes(16).toString("base64url")}`, email: profile.email, name: null, createdAt: now() };
      state.accounts.push(owner);
      created = true;
    }
    attach(owner, "apple", profile);
    for (const hook of signedInHooks) hook(owner);
    if (created) for (const hook of createdHooks) hook(owner);
    return appGrant(owner, device);
  }
  const liveAppSession = (grant: { accountId: string; sessionId: string }) =>
    state.sessions.find(item => item.id === grant.sessionId && item.accountId === grant.accountId && item.kind !== "web" && item.expiresAt > now()) ?? null;
  function issueHandoff(found: { account: Account; session: Session }, data: Record<string, unknown>): WebHandoffAnswer {
    const page = typeof data.next === "string" && Object.hasOwn(HANDOFF_PAGES, data.next) ? data.next as keyof typeof HANDOFF_PAGES : null;
    const plans = page === "plans", workspace = page === "workspace";
    if (!page || (!plans && (data.plan !== undefined || data.source !== undefined)) || (data.plan !== undefined && !(HANDOFF_PLANS as readonly unknown[]).includes(data.plan))
      || (data.source !== undefined && (data.source === "other" || !(CHECKOUT_SOURCES as readonly unknown[]).includes(data.source)))
      || (workspace ? typeof data.workspaceId !== "string" || !/^ws_[A-Za-z0-9_-]{1,64}$/.test(data.workspaceId) : data.workspaceId !== undefined)
      || (data.token !== undefined && (!opaque(data.token) || handoffs.has(hash(data.token))))) return fail(400, "invalid_request");
    rate(`handoff:${found.session.id}`, AUTH_LIMITS.handoffsPerSession);
    const query = new URLSearchParams({ ...(typeof data.plan === "string" ? { plan: data.plan } : {}), ...(typeof data.source === "string" ? { src: data.source } : {}),
      ...(workspace ? { workspace: data.workspaceId as string } : {}) }).toString();
    const mine = [...handoffs].filter(([, item]) => item.accountId === found.account.id);
    for (const [key] of mine.slice(0, Math.max(0, mine.length - HANDOFF_OUTSTANDING + 1))) handoffs.delete(key);
    // the app's own token (32 random bytes it made) lets it open the browser before this answer arrives
    const token = opaque(data.token) ? data.token : random(), expiresAt = now() + HANDOFF_TTL_MS;
    handoffs.set(hash(token), { accountId: found.account.id, sessionId: found.session.id, next: `${HANDOFF_PAGES[page]}${query ? `?${query}` : ""}`, expiresAt });
    return { v: 1, url: `${pages}/handoff#t=${token}`, expiresAt };
  }
  function redeemHandoff(req: IncomingMessage, res: ServerResponse, data: Record<string, unknown>): HandoffAnswer {
    // a browser always sends Origin on a fetch POST; anything without our own is a cross-site form or a script elsewhere
    const site = req.headers["sec-fetch-site"];
    if (req.headers.origin !== publicUrl || (site !== undefined && site !== "same-origin")) return fail(403, "forbidden");
    rate(`handoff:${ip(req)}`, AUTH_LIMITS.handoffsPerIp);
    if ((data.replace !== undefined && data.replace !== true) || (data.confirm !== undefined && data.confirm !== true)) return fail(400, "invalid_request");
    const key = opaque(data.token) ? hash(data.token) : "", grant = handoffs.get(key);
    const owner = grant && grant.expiresAt > now() ? account(grant.accountId) : null, appSessionFound = grant && owner ? liveAppSession(grant) : null;
    if (!grant || !owner || !appSessionFound) { handoffs.delete(key); return fail(410, "expired"); }
    const current = webSession(req);
    // security (login csrf: anyone with an app session can mint a link and send it): a browser is never signed in, or
    // switched to another account, without its own click. the link is not spent by asking, so the confirm can use it
    if (current && current.account.id !== owner.id && data.replace !== true) return fail(409, "other_account", { email: owner.email });
    if (!current && data.confirm !== true) return fail(409, "confirm", { email: owner.email });
    handoffs.delete(key);
    if (!websiteStepsOpen(owner)) onboardedInApp(owner);
    if (current && current.account.id === owner.id) return { account: view(owner), csrfToken: csrfFor(current.session), next: grant.next };
    if (current) dropSessions(item => item === current.session);
    // security: the web session is only as fresh as the app sign-in behind it, so it never passes a "signed in recently"
    // check, and it ends with that app session
    const { token, session } = makeSession(owner, null, { signedInAt: Math.min(now(), appSessionFound.createdAt), parentId: appSessionFound.id }), csrfToken = csrfFor(session);
    cookies(res, token, csrfToken);
    return { account: view(owner), csrfToken, next: grant.next };
  }
  /** a phone sign-in code from a signed-in desktop: single use, bound to the account and to the desktop session (it ends
   *  with that session), PHONE_SIGN_IN_TTL_MS long. security: only a desktop app session mints one, so a phone or a
   *  browser never hands its sign-in on, and an account holds at most PHONE_CODES_OUTSTANDING live */
  function mintPhoneCode(found: { account: Account; session: Session }): PhoneSignInGrant {
    if (found.session.kind !== "desktop") return fail(403, "forbidden");
    rate(`phone-code:${found.session.id}`, AUTH_LIMITS.phoneCodesPerSession);
    rate(`phone-code-account:${found.account.id}`, AUTH_LIMITS.phoneCodesPerAccount);
    const live = [...phoneCodes.values()].filter(item => item.accountId === found.account.id && !item.usedAt && item.expiresAt > now()).sort((a, b) => a.expiresAt - b.expiresAt);
    for (const item of live.slice(0, Math.max(0, live.length - PHONE_CODES_OUTSTANDING + 1))) item.expiresAt = now();
    let code: string;
    do code = generatePairingCode(PHONE_SIGN_IN_CODE_LENGTH); while (phoneCodes.has(hmac(`phone:${code}`)));
    const expiresAt = now() + PHONE_SIGN_IN_TTL_MS;
    phoneCodes.set(hmac(`phone:${code}`), { codeHash: hmac(`phone:${code}`), accountId: found.account.id, sessionId: found.session.id, expiresAt, purgeAt: expiresAt + PHONE_CODE_REMEMBERED_MS });
    savePhoneCodes();
    return { v: 1, code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt, email: found.account.email };
  }
  /** a phone's typed or scanned code -> its own app session. security: per-ip and service-wide wrong-code limits keep a
   *  guess at an 8-letter code (24^8) hopeless; a spent, ended or orphaned code never signs in */
  function redeemPhoneCode(req: IncomingMessage, data: Record<string, unknown>): AppGrant {
    rate(`phone-redeem:${ip(req)}`, AUTH_LIMITS.phoneRedeemsPerIp);
    const wrong = limits.get("phone-wrong");
    if (wrong && wrong.until > now() && wrong.count >= AUTH_LIMITS.phoneWrongPerHour) return fail(429, "rate_limited");
    const code = cleanPhoneSignInCode(data.code);
    const device = deviceInfo(data, false);
    if (!code || [...code].some(char => !PAIRING_CODE_ALPHABET.includes(char))) return fail(400, "invalid_code");
    const item = phoneCodes.get(hmac(`phone:${code}`));
    if (!item) {
      const counter = wrong && wrong.until > now() ? wrong : { count: 0, until: now() + hour };
      counter.count += 1; limits.set("phone-wrong", counter);
      return fail(400, "invalid_code");
    }
    if (item.usedAt) return fail(409, "used");
    const owner = account(item.accountId);
    if (item.expiresAt <= now() || !owner || !liveAppSession(item)) return fail(410, "expired");
    item.usedAt = now();
    savePhoneCodes();
    for (const hook of signedInHooks) hook(owner);
    return appGrant(owner, device);
  }
  /** the account, its ways in and every session, at once; `email` must be the account's own, as the person typed or confirmed it */
  async function deleteAccount(owner: Account, data: Record<string, unknown>) {
    if (cleanEmail(data.email) !== owner.email) fail(400, "invalid_request");
    for (const hook of beforeDeleteHooks) await hook(owner, data);
    removeSessions(owner.id);
    const linked = state.identities.filter(item => item.accountId === owner.id);
    state.accounts = state.accounts.filter(item => item !== owner);
    state.identities = state.identities.filter(item => item.accountId !== owner.id);
    for (const [key, grant] of grants) if (grant.accountId === owner.id) grants.delete(key);
    for (const [key, item] of handoffs) if (item.accountId === owner.id) handoffs.delete(key);
    for (const [key, attempt] of attempts) if (attempt.email === owner.email) attempts.delete(key);
    store.close();
    await Promise.all(linked.map(revokeProvider));
    for (const hook of deletedHooks) { try { await hook(owner.id, owner.email); } catch { console.error("Account deletion cleanup failed."); } }
  }
  function removeSessions(accountId: string) {
    dropSessions(item => item.accountId === accountId);
    for (const [key, item] of handoffs) if (item.accountId === accountId) handoffs.delete(key);
    for (const [key, code] of appCodes) if (code.accountId === accountId) appCodes.delete(key);
    for (const [key, item] of oauthStates) if (item.linkAccount === accountId) oauthStates.delete(key);
    for (const [key, device] of devices) if (device.accountId === accountId) devices.delete(key);
    store.changed();
  }
  async function handle(req: IncomingMessage, res: ServerResponse, url: URL, helpers: BodyHelpers): Promise<boolean> {
    const path = url.pathname, method = req.method ?? "GET", cors = isAppCorsRoute(path);
    const routes: string[] = [R.providers, R.emailStart, R.emailVerify, R.signOut, R.me, R.account, R.notifications, R.onboarded, R.signOutEverywhere, R.deleteAccount, R.deviceLookup, R.deviceApprove, R.deviceDeny,
      R.appEmailStart, R.appEmailVerify, R.appAppleSignIn, R.desktopAuthorize, R.desktopToken, R.appSession, R.appAvatar, R.enrollGrant, R.webHandoff, R.handoffRedeem, R.appToken, R.appStart, R.appDeleteAccount, R.phoneSignIn, R.appPhoneSignIn];
    if (!routes.includes(path) && !path.startsWith("/v1/auth/oauth/") && !path.startsWith("/v1/account/identities/") && !path.startsWith("/v1/account/sessions/") && !cors) return false;
    res.setHeader("cache-control", "no-store");
    if (cors) {
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-headers", "content-type, authorization, x-madani-version");
      res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
      if (method === "OPTIONS") { res.writeHead(204); res.end(); return true; }
    }
    function json(value: unknown, status = 200) { res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(value)); }
    try {
      sweep();
      const oauth = /^\/v1\/auth\/oauth\/([^/]+)\/(start|callback)$/.exec(path);
      if (oauth?.[2] === "callback") { await oauthCallback(req, res, url, oauth[1]!, helpers); return true; }
      if (method === "GET" && oauth?.[2] === "start") {
        rate(`oauth:${ip(req)}`, AUTH_LIMITS.oauthPerIp); oauthStart(req, res, url, oauth[1]!); return true;
      }
      if (method === "GET" && path === R.appStart) {
        rate(`oauth:${ip(req)}`, AUTH_LIMITS.oauthPerIp);
        const provider = url.searchParams.get("provider"), challenge = url.searchParams.get("code_challenge"), appState = url.searchParams.get("state");
        if (!provider || !providers.has(provider as OAuthProvider) || !challenge || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)
          || url.searchParams.get("code_challenge_method") !== "S256" || !appState || !/^[A-Za-z0-9_-]{16,256}$/.test(appState)
          || url.searchParams.get("redirect_uri") !== APP_AUTH_REDIRECT || url.searchParams.has("link") || (url.searchParams.has("landing") && url.searchParams.get("landing") !== "page") || [...url.searchParams.keys()].some(key => url.searchParams.getAll(key).length !== 1)) return fail(400, "invalid_request");
        const flowId = random();
        appFlows.set(flowId, { challenge, state: appState, ...(url.searchParams.get("landing") === "page" ? { landing: true as const } : {}), expiresAt: now() + 600_000 });
        oauthStart(req, res, url, provider, flowId); return true;
      }
      const mutation = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
      const data = mutation ? helpers.bodyObject(await helpers.readBody(req)) : {};
      if (method === "POST" && path === R.appToken) {
        const key = opaque(data.code) ? hash(data.code) : "", code = appCodes.get(key);
        appCodes.delete(key);
        const owner = code && account(code.accountId);
        if (!code || !owner || code.expiresAt <= now() || typeof data.codeVerifier !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(data.codeVerifier)
          || !equal(createHash("sha256").update(data.codeVerifier).digest("base64url"), code.challenge)) return fail(400, "invalid_grant");
        let device: DeviceInfo;
        try { device = deviceInfo(data, false); } catch { return fail(400, "invalid_grant"); }
        json(appGrant(owner, device));
      }
      else if (method === "POST" && path === R.appAppleSignIn) json(await nativeApple(req, data));
      else if (method === "POST" && path === R.appPhoneSignIn) json(redeemPhoneCode(req, data));
      else if (method === "POST" && (path === R.emailStart || path === R.appEmailStart)) json(await start(req, data, path === R.appEmailStart));
      else if (method === "POST" && (path === R.emailVerify || path === R.appEmailVerify)) json(verifyEmail(req, res, data, path === R.appEmailVerify));
      else if (method === "POST" && path === R.signOut) {
        const found = webSession(req);
        if (found) dropSessions(item => item === found.session);
        cookies(res); json({ ok: true });
      } else if (method === "GET" && path === R.providers) {
        json({ v: 1, providers: OAUTH_PROVIDERS.map(id => ({ id, enabled: providers.has(id), comingSoon: !providers.has(id) && options.dev })), signupOpen: options.signupOpen, recovery: true });
      } else if (method === "GET" && path === R.me) {
        const owner = requireWeb(req, { mutation: false });
        json({ account: view(owner), csrfToken: csrfFor(webSession(req)!.session) });
      } else if ((method === "GET" || method === "PATCH") && path === R.account) {
        const owner = requireWeb(req, { mutation });
        if (mutation) {
          if (data.name !== null && !label(data.name, 80)) fail(400, "invalid_request");
          owner.name = data.name === null ? null : (data.name as string).trim(); store.changed();
        }
        json(accountAnswer(owner, webSession(req)?.session.id));
      } else if ((method === "GET" || method === "PUT") && path === R.notifications) {
        const owner = requireWeb(req, { mutation });
        if (mutation) {
          const keys = Object.keys(data);
          if (!keys.length || keys.some(key => !Object.hasOwn(NOTIFICATION_DEFAULTS, key) || typeof data[key] !== "boolean")) fail(400, "invalid_request");
          owner.notifications = { ...owner.notifications, ...data as Partial<NotificationPrefs> }; store.changed();
        }
        json(notificationsOf(owner));
      } else if (method === "POST" && path === R.onboarded) {
        const owner = requireWeb(req, { mutation: true });
        if (data.home !== undefined && !WEBSITE_HOMES.includes(data.home as WebsiteHome)) return fail(400, "invalid_request");
        if (owner.onboardedAt === undefined) {
          owner.onboardedAt = now();
          if (data.home !== undefined) owner.onboardedHome = data.home as WebsiteHome;
          store.changed();
        }
        json({ onboarded: true });
      } else if (method === "DELETE" && path.startsWith("/v1/account/identities/")) {
        const owner = requireWeb(req, { mutation: true }), provider = path.slice("/v1/account/identities/".length);
        const linked = state.identities.find(item => item.accountId === owner.id && item.provider === provider);
        if (!linked) fail(404, "not_found");
        if (!owner.email && state.identities.filter(item => item.accountId === owner.id).length <= 1) fail(409, "last_identity");
        state.identities = state.identities.filter(item => item !== linked); store.changed();
        await revokeProvider(linked!);
        json(accountAnswer(owner, webSession(req)?.session.id));
      } else if (method === "DELETE" && path.startsWith("/v1/account/sessions/")) {
        const owner = requireWeb(req, { mutation: true }), id = decodeURIComponent(path.slice("/v1/account/sessions/".length));
        const session = state.sessions.find(item => item.accountId === owner.id && item.id === id);
        if (!session) fail(404, "not_found");
        dropSessions(item => item === session); json({ ok: true });
      } else if (method === "POST" && (path === R.signOutEverywhere || path === R.deleteAccount)) {
        const owner = requireWeb(req, { mutation: true });
        if (path === R.deleteAccount) await deleteAccount(owner, data);
        else removeSessions(owner.id);
        cookies(res); json({ ok: true });
      } else if (method === "POST" && path === R.appDeleteAccount) {
        const found = appSession(req);
        if (!found) return fail(401, "invalid_token");
        // the phone app's own Delete account. Older desktop apps sent this from "Start fresh" (with destroyDesktopsNow), which
        // cancelled a plan or trial as part of a local reset: that is refused, account deletion is done on the account page
        if (data.destroyDesktopsNow !== undefined) return fail(409, "delete_on_account_page");
        await deleteAccount(found.account, { email: data.email, cancelBilling: true });
        json({ ok: true });
      } else if (path === R.deviceLookup && method === "GET") {
        const viewer = requireWeb(req, { mutation: false });
        const device = [...devices.values()].find(item => item.userCode === url.searchParams.get("code") && !item.accountId && !item.denied);
        if (!device) return fail(404, "not_found");
        // this browser signed in (or up) after the app asked, through the page the app opened: that was the approval, the
        // page goes on without asking. one signed in before is still asked, so a code sent to someone is never one click
        const session = webSession(req)?.session;
        const fresh = Boolean(session && !session.parentId && device.createdAt !== undefined && session.createdAt > device.createdAt);
        // and this account was made by it: the website takes it through its first steps (the app's sign-in leaves them open)
        const created = fresh && viewer.createdAt > device.createdAt!;
        json({ fresh, ...(created ? { created } : {}), device: { name: device.device.name, platform: device.device.platform }, userCode: device.userCode, expiresAt: device.expiresAt, ...(device.intent ? { intent: device.intent, next: accountIntentPath(device.intent) } : {}) });
      } else if (method === "POST" && (path === R.deviceApprove || path === R.deviceDeny)) {
        const owner = requireWeb(req, { mutation: true });
        const device = [...devices.values()].find(item => item.userCode === data.userCode && !item.accountId && !item.denied);
        if (!device) return fail(404, "not_found");
        device.accountId = owner.id;
        device.denied = path === R.deviceDeny;
        // which app install a new account came from: its sign-up started in that app and came back to it here
        if (!device.denied && device.createdAt !== undefined && owner.createdAt >= device.createdAt && !owner.signedUpFrom) {
          owner.signedUpFrom = { name: device.device.name, platform: device.device.platform, appVersion: device.device.appVersion, at: now() }; store.changed();
          console.log(`desktop sign-up ${owner.id} from ${device.device.platform} ${device.device.appVersion ?? "dev"}`);
        }
        saveDevices();
        json({ ok: true });
      } else if (method === "POST" && path === R.desktopAuthorize) {
        const device = deviceInfo(data, false);
        rate(`authorize:${ip(req)}`, AUTH_LIMITS.deviceAuthorizePerIp);
        const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        let userCode: string;
        do { const chars = Array.from({ length: 10 }, () => alphabet[randomInt(alphabet.length)]).join(""); userCode = `${chars.slice(0, 5)}-${chars.slice(5)}`; }
        while ([...devices.values()].some(item => item.userCode === userCode));
        const deviceCode = random();
        // what the app was doing (shared/account-api.ts AccountIntent): bound to this sign-in, so the website trusts it, not the URL
        const intent = data.intent === undefined ? null : cleanAccountIntent(data.intent);
        if (data.intent !== undefined && !intent) return fail(400, "invalid_request");
        if (data.email !== undefined && typeof data.email !== "string") return fail(400, "invalid_request");
        devices.set(hash(deviceCode), { userCode, device, expiresAt: now() + 900_000, interval: 5, lastPollAt: null, accountId: null, denied: false, createdAt: now(), ...(intent ? { intent } : {}) });
        // an email instead of a browser: the magic link opens the website at this sign-in, and the app keeps polling
        if (typeof data.email === "string") {
          try { await start(req, { email: data.email }, false, `/cloud/desktop?code=${userCode}`); } catch (error) { devices.delete(hash(deviceCode)); throw error; }
        }
        json({ cloudContractVersion: 1, deviceCode, userCode, verificationUri: `${pages}/cloud/desktop`, verificationUriComplete: `${pages}/cloud/desktop?code=${userCode}`, expiresIn: 900, interval: 5 });
      } else if (method === "POST" && path === R.desktopToken) {
        const key = opaque(data.deviceCode) ? hash(data.deviceCode) : "", device = devices.get(key);
        if (!device) return fail(400, expiredDevices.has(key) ? "expired_token" : "invalid_grant");
        // a second of slack: poll timers and network delay jitter around the interval
        if (device.lastPollAt !== null && now() - device.lastPollAt < device.interval * 1000 - 1000) {
          device.lastPollAt = now(); device.interval += 5; fail(400, "slow_down", { interval: device.interval });
        }
        device.lastPollAt = now();
        if (device.denied) { devices.delete(key); fail(400, "access_denied"); }
        if (!device.accountId) return fail(400, "authorization_pending");
        const owner = account(device.accountId);
        devices.delete(key);
        if (!owner) return fail(400, "invalid_grant");
        for (const hook of signedInHooks) hook(owner);
        const madeHere = Boolean(owner.signedUpFrom && device.createdAt !== undefined && owner.signedUpFrom.at >= device.createdAt);
        json(appGrant(owner, device.device, { onboard: !madeHere || options.websiteFirstSteps === false }));
      } else if ((method === "GET" || method === "DELETE") && path === R.appSession) {
        const found = appSession(req);
        if (!found) return fail(401, "invalid_token");
        if (method === "DELETE") { dropSessions(item => item === found.session); json({ ok: true }); }
        else {
          let extra: Record<string, unknown> = { entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 0 } };
          for (const extension of extensions) extra = { ...extra, ...await extension(found.account.id) };
          if (!state.sessions.includes(found.session)) return fail(401, "invalid_token");
          const websiteSetup: WebsiteSetup | undefined = found.account.onboardedAt === undefined ? "open" : found.account.onboardedHome;
          json({ ...extra, ...identity(found.account, found.session), handoffUrl: `${pages}/handoff`, ...(websiteSetup ? { websiteSetup } : {}) });
        }
      } else if (method === "POST" && path === R.appAvatar) {
        const found = appSession(req);
        if (!found) return fail(401, "invalid_token");
        const choice = data.avatar === null ? null : parseUserAvatarChoice(data.avatar);
        // the photo only while a sign-in still gives one
        if ((data.avatar !== null && !choice) || (choice === "photo" && !found.account.avatarUrl)) return fail(400, "invalid_request");
        if (choice) found.account.avatar = choice; else delete found.account.avatar;
        store.changed();
        json({ avatar: found.account.avatar ?? null });
      } else if (method === "POST" && path === R.enrollGrant) {
        const found = appSession(req);
        if (!found) return fail(401, "invalid_token");
        const enrollToken = random(), expiresAt = now() + 600_000;
        grants.set(hash(enrollToken), { accountId: found.account.id, sessionId: found.session.id, expiresAt });
        json({ v: 1, enrollToken, expiresAt, dashboardUrl: publicUrl });
      } else if (method === "POST" && path === R.phoneSignIn) {
        const found = appSession(req);
        if (!found) return fail(401, "invalid_token");
        json(mintPhoneCode(found));
      } else if (method === "POST" && path === R.webHandoff) {
        const found = appSession(req);
        if (!found) return fail(401, "invalid_token");
        json(issueHandoff(found, data));
      } else if (method === "POST" && path === R.handoffRedeem) json(redeemHandoff(req, res, data));
      else fail(404, "not_found");
    } catch (error) {
      const known = error as { status?: number; code?: string; message?: string };
      if (path === R.appToken) { json({ error: "invalid_grant" }, 400); return true; }
      const status = known.status ?? 500, code = known.code ?? "failed";
      json({ error: path.startsWith("/api/cloud/") ? code : known.status ? known.message : "Request failed.", ...(path.startsWith("/api/cloud/") ? {} : { code }), ...(error instanceof AuthError ? error.fields : {}) }, status);
    }
    return true;
  }
  return {
    handle, webSession, requireWeb, appSession, account,
    /** before launch: whether a desktop sign-in code or an emailed link's attempt is live, so its page may open */
    prelaunchLive: {
      device: (code: string) => [...devices.values()].some(item => item.userCode === code && item.expiresAt > now() && !item.denied),
      attempt: (value: string) => { const item = opaque(value) ? attempts.get(hash(value)) : undefined; return Boolean(item && item.expiresAt > now()); },
    },
    /** whether an optional email may go to this account; required mail (billing, security, deletion) never asks */
    wantsEmail: (accountId: string, kind: keyof NotificationPrefs) => { const owner = account(accountId); return owner !== null && notificationsOf(owner)[kind]; },
    accountByEmail: (email: string) => state.accounts.find(item => item.email === email) ?? null,
    setAdminRole(accountId: string, role: AdminRole | null) {
      const owner = account(accountId);
      if (!owner) return null;
      if (role) owner.adminRole = role; else delete owner.adminRole;
      store.changed();
      return owner;
    },
    /** what the account holds, for its owner's export: no token, hash or code */
    exportAccount(owner: Account) {
      const { account: profile, identities, sessions, notifications, onboarded } = accountAnswer(owner, undefined);
      return { account: profile, identities, sessions: sessions.map(({ current: _current, ...session }) => session), notifications, onboarded };
    },
    extendSession(fn: (accountId: string) => Promise<Record<string, unknown>> | Record<string, unknown>) { extensions.push(fn); },
    beforeAccountDelete(fn: (owner: Account, body: Record<string, unknown>) => void | Promise<void>) { beforeDeleteHooks.push(fn); },
    onAccountDeleted(fn: (accountId: string, email: string | null) => void | Promise<void>) { deletedHooks.push(fn); },
    /** a new account, after its first sign-in */
    onAccountCreated(fn: (account: Account) => void) { createdHooks.push(fn); },
    onSignedIn(fn: (account: Account) => void) { signedInHooks.push(fn); },
    /** every new session, web or app, after it is stored */
    onSessionCreated(fn: (session: Session) => void) { sessionHooks.push(fn); },
    /** an app's bearer session was used (its periodic session refresh is the heartbeat) */
    onAppSeen(fn: (session: Session) => void) { appSeenHooks.push(fn); },
    /** the operator's read of every account, identity and session; callers never change them */
    directory: (): { readonly accounts: readonly Account[]; readonly identities: readonly Identity[]; readonly sessions: readonly Session[] } => state,
    consumeEnrollGrant(token: string) {
      sweep();
      const key = hash(token), grant = grants.get(key);
      grants.delete(key);
      // a grant dies with the app session that asked for it (signed out, revoked, everywhere)
      return grant && account(grant.accountId) && state.sessions.some(item => item.id === grant.sessionId && item.accountId === grant.accountId && item.expiresAt > now()) ? grant.accountId : null;
    },
    close() { clearInterval(timer); store.close(); },
  };
}
