import { randomBytes } from "node:crypto";
import { createManagedDesktopStore, retryDelay, unreadableRecord } from "./managed-desktop.mjs";
import { CLOUD_MACHINE_CONNECTABLE, cloudUnreachableText, parseCloudOffer, parseCloudPurchase, parseCloudSummary, parseCloudTeams, parseCloudRoom, parseCloudTrial, parseCloudUsage, parsePairingGrant, parsePublicOffer, withoutTrial } from "./cloud-home.mjs";
import { CLOUD_ID, CLOUD_SWATCHES, cleanCloudListName, ORGANIZATION_BLOCKS, otherOwnClouds, ownCloud, parseCloudList, parseCloudRenewal, parseOrganizations, releaseVersion } from "./cloud-list.mjs";
import { planTeam, teamPlan } from "./cloud-team-plan.mjs";
import { linkSignIn } from "./cloud-signin-link.mjs";
import { APP_PROVIDERS, APP_TOKEN, cleanCode, cleanEmail, LINK_MS, LINK_PROVIDERS, linkFailure, parseAppLink, parseProviders, parseSignInStart, SIGN_IN_START, SIGN_IN_TRIES, SIGN_IN_VERIFY, signInIdentity, startFailure, verifyFailure } from "./cloud-signin.mjs";
import { TRAIL_HEADER, newTrailId, trail, trailError } from "./trail.mjs";

export const CLOUD_ORIGIN = "https://madani.bot";
/** The staging Admin (Dodo test mode, real test Clouds): a fixed address, on only with MADANI_CLOUD_STAGING=1. */
export const STAGING_CLOUD_ORIGIN = "https://preview.madani.bot";
/** Which Admin this app signs in to, and the files that depend on it (the sign-in, saved servers with the Cloud's
 * entry, Files' state, the Cloud's chosen name): staging never reads or writes production's. */
export function cloudTarget(env = process.env) {
  if (customOrigin(env?.MADANI_CLOUD_ORIGIN)) return { origin: env.MADANI_CLOUD_ORIGIN, staging: false, custom: true, file: "cloud-account-custom.bin", saved: "cloud-accounts-custom.bin", places: "account-places-custom.json", environments: "environments-custom.json", sync: "cloud-sync-custom", look: "cloud-home-look-custom.json" };
  return env?.MADANI_CLOUD_STAGING === "1"
    ? { origin: STAGING_CLOUD_ORIGIN, staging: true, custom: false, file: "cloud-account-staging.bin", saved: "cloud-accounts-staging.bin", places: "account-places-staging.json", environments: "environments-staging.json", sync: "cloud-sync-staging", look: "cloud-home-look-staging.json" }
    : { origin: CLOUD_ORIGIN, staging: false, custom: false, file: "cloud-account.bin", saved: "cloud-accounts.bin", places: "account-places.json", environments: "environments.json", sync: "cloud-sync", look: "cloud-home-look.json" };
}
const TOKEN = /^omc_[A-Za-z0-9_-]{43}$/;
const CODE = /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/;
const PRIVATE_CODE = /^[A-Za-z0-9_-]{43}$/;
/** What the Admin says of a Cloud of this account's a computer moved to (POST moved-to). */
const MOVED_TO = Object.freeze(["deleted", "ended", "live", "unknown"]);
const TIER = /^[a-z][a-z0-9-]{0,23}$/;
const REFRESH_MS = 60_000;
const STEADY_MS = 15 * 60_000;
const SETUP_REFRESH_MS = 15_000;
/** While My Cloud sleeps and Files or lending waits for it: the session every 15 s, so they resume soon after it wakes. */
const ASLEEP_REFRESH_MS = 15_000;
const WAKE_STATES = Object.freeze(["awake", "waking", "asleep"]);
/** What a person did that may wake a sleeping Cloud: opening the app or viewing chats never does (the Admin answers `asleep`). */
export const WAKE_INTENTS = Object.freeze(["type", "click", "send", "open", "view"]);
/** While a checkout this app opened waits for its payment and setup: the session every 3 s (30 minutes at most). */
const WATCH_REFRESH_MS = 3_000;
const CHECKING_AFTER = 2;
const MAX_ENROLL_SECONDS = 1800;
const OFFER_MS = 10 * 60_000, OFFER_RETRY_MS = 30_000;
const CHECKOUT_WATCH_MS = 30 * 60_000, CHECKOUT_KEPT_MS = 24 * 3600_000;
const WEBSITE_SETUPS = Object.freeze(["open", "free", "cloud"]);
export const CHECKOUT_SOURCES = Object.freeze(["app_card", "app_howto", "app_menu", "app_settings", "app_routines", "app_pages", "app_whats_new_pro", "app_whats_new_team", "app_onboarding", "app_computer_move", "app_sidebar", "app_invested", "app_always_on", "app_bot_panel", "app_late_routine", "app_asleep"]);
export const UPGRADE_SOURCES = Object.freeze(["app_usage", "app_settings", "app_room"]);
const UPGRADE_TIERS = Object.freeze(["starter", "personal", "pro", "max"]);
const UPGRADE_REFUSALS = Object.freeze(["payment_failed", "not_subscribed", "already_on_plan", "plan_change_unavailable", "confirmation_required", "price_changed", "rate_limited"]);
const CONFIRMATION = /^[A-Za-z0-9_-]{43}$/;
/** The cancel sheet's reasons, as the Admin takes them. */
export const CLOUD_CANCEL_ANSWERS = Object.freeze(["feature", "price", "setup", "broken", "later", "other"]);
const SURVEY_TEXT_MAX = 2_000, SURVEY_WAIT_MS = 8_000;
/**
 * The cancel sheet's survey as main sends it: one reason and each box trimmed, at most 2,000 characters. Words without a
 * reason are kept as `other`; null when nothing was said, and for anything that isn't a survey (it is never sent then).
 */
export function cancelSurvey(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const box = value => typeof value === "string" ? value.trim() : "";
  const answer = CLOUD_CANCEL_ANSWERS.includes(input.answer) ? input.answer : null, expected = box(input.expected), improve = box(input.improve);
  if ((input.answer !== undefined && input.answer !== null && !answer) || expected.length > SURVEY_TEXT_MAX || improve.length > SURVEY_TEXT_MAX) return null;
  if (!answer && !expected && !improve) return null;
  return { answer: answer ?? "other", ...(expected ? { expected } : {}), ...(improve ? { improve } : {}) };
}
/** Why the Admin won't open another Cloud's checkout now (POST clouds, 409 `addBlocked`; contract v1). */
export const ADD_BLOCKS = Object.freeze(["cap", "checkout_open", "rate", "signups_closed"]);
const ADD_INTERVALS = Object.freeze(["month", "year"]);
const CHECKOUT_ORIGIN = "https://checkout.dodopayments.com", TEST_CHECKOUT_ORIGIN = "https://test.checkout.dodopayments.com";
/** Only Dodo's own HTTPS checkout origin, with no credentials and no fragment; anything else is never opened. Staging's
 * Admin sells in Dodo's test mode, so its checkouts are only Dodo's test page. */
export function checkoutDestination(value, { fixture = false, staging = false, custom = false } = {}) {
  if (typeof value !== "string" || value.length > 2048) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  const allowed = fixture || custom ? [CHECKOUT_ORIGIN, TEST_CHECKOUT_ORIGIN] : staging ? [TEST_CHECKOUT_ORIGIN] : [CHECKOUT_ORIGIN];
  if (!allowed.includes(url.origin) || url.username || url.password || url.hash || value.includes("#")) return null;
  return url.href;
}
const HANDOFF_PLANS = Object.freeze(["plus", "pro"]);
/** The website pages a handoff opens (shared/account-api.ts HANDOFF_PAGES), and where each is when the browser signs in itself. */
export const HANDOFF_PAGES = Object.freeze({ plans: "/billing", home: "/", workspace: "/", cloud: "/cloud", billing: "/billing", account: "/account", usage: "/usage" });
/** The service's page for approving this app's sign-in: on its own origin, at /cloud/desktop under the page's base (a
 *  service that shares its origin with the site serves the page at /dashboard), for exactly this code. */
export function desktopApprovalLink(value, origin, userCode) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.origin === origin && /^(?:\/[a-z0-9-]+)?\/cloud\/desktop$/.test(url.pathname) && url.search === `?code=${userCode}` && !url.hash && !url.username && !url.password;
  } catch { return false; }
}
/** An account step's context (shared/account-api.ts AccountIntent), checked the same way: signin, upgrade (plan, move) or billing. */
export const ACCOUNT_INTENT_KINDS = Object.freeze(["signin", "upgrade", "billing"]);
/** where a plain sign-in started, so the website can say what is going on: linking the person's own server */
const SIGNIN_SOURCES = Object.freeze(["server_link"]);
export function cleanAccountIntent(value) {
  if (!value || typeof value !== "object" || !ACCOUNT_INTENT_KINDS.includes(value.kind)) return null;
  const kind = value.kind;
  const plan = kind === "upgrade" && (value.plan === "plus" || value.plan === "pro") ? value.plan : undefined;
  const source = CHECKOUT_SOURCES.includes(value.source) || (kind === "signin" && SIGNIN_SOURCES.includes(value.source)) ? value.source : undefined;
  const move = kind === "upgrade" && typeof value.move === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value.move) ? value.move : undefined;
  return { kind, ...(plan ? { plan } : {}), ...(source ? { source } : {}), ...(move ? { move } : {}) };
}
const WORKSPACE_ID = /^ws_[A-Za-z0-9_-]{1,64}$/;
const HANDOFF_PATHS = Object.freeze(["/handoff", "/dashboard/handoff"]);
/** Only this Admin's own handoff page with a one-time token in the fragment: no query, no credentials, nothing else. */
export function handoffDestination(value, origin) {
  if (typeof value !== "string" || value.length > 512) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.origin !== origin || url.username || url.password || url.search || !HANDOFF_PATHS.includes(url.pathname)
    || !/^#t=[A-Za-z0-9_-]{43}$/.test(url.hash) || value !== `${origin}${url.pathname}${url.hash}`) return null;
  return value;
}
/** the session's handoff page (no token yet): this Admin's own /handoff or /dashboard/handoff, nothing else */
export function handoffPage(value, origin) {
  if (typeof value !== "string" || value.length > 256) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  return url.origin === origin && !url.username && !url.password && !url.search && !url.hash && HANDOFF_PATHS.includes(url.pathname) && value === `${origin}${url.pathname}` ? value : null;
}
function customOrigin(value) {
  if (typeof value !== "string") return false;
  try { const url = new URL(value); return value === url.origin && (url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))); } catch { return false; }
}
// never accept an address from the renderer.
export function cloudOrigin(value = CLOUD_ORIGIN, fixture = false, custom = false) {
  const url = new URL(value);
  if (value !== url.origin || (![CLOUD_ORIGIN, STAGING_CLOUD_ORIGIN].includes(value) && !(custom && customOrigin(value)) && !(fixture && url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("Invalid madani cloud address.");
  }
  return value;
}
export const createCloudAccountStore = createManagedDesktopStore;
// oxlint-disable-next-line no-control-regex
const text = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);

/** The account's name, photo and chosen avatar as the Admin names them, all optional (an older Admin sends none): the photo
 * only as an https address without credentials or a port, at most 1024 characters; the avatar only as shared/user-avatar.ts
 * spells one. */
export function accountProfile(account) {
  const name = text(account?.name, 80) && account.name.trim() ? account.name.trim() : null;
  let avatarUrl = null;
  if (text(account?.avatarUrl, 1024)) {
    try {
      const url = new URL(account.avatarUrl);
      if (url.protocol === "https:" && !url.username && !url.password && !url.port) avatarUrl = url.href;
    } catch { /* not an address */ }
  }
  const avatar = typeof account?.avatar === "string" && AVATAR_CHOICE.test(account.avatar) ? account.avatar : null;
  return { ...(name ? { name } : {}), ...(avatarUrl ? { avatarUrl } : {}), ...(avatar ? { avatar } : {}) };
}
const AVATAR_CHOICE = /^(?:photo|drawn|g:[a-z0-9]{1,16})$/;
const timestamp = value => Number.isSafeInteger(value) && value > 0;
/** Display only: the last verified plan, never an entitlement. */
function planHint(value) {
  if (!value || typeof value !== "object" || typeof value.active !== "boolean") return null;
  return { ...(typeof value.tier === "string" && TIER.test(value.tier) ? { tier: value.tier } : {}), active: value.active };
}
/** Only the Admin's own JSON "invalid_token" ends a sign-in; a 401/403 page from Cloudflare or a proxy does not. */
const signInEnded = error => [401, 403].includes(error?.status) && error.code === "invalid_token";
const sameHint = (left, right) => (left?.tier ?? null) === (right?.tier ?? null) && (left?.active ?? null) === (right?.active ?? null);
/** Whether the Admin opens another Cloud's checkout for this account now, as its session says (`canAdd` and
 * `addBlocked`, both optional): without its word the answer is yes, and POST clouds says otherwise. */
function addOffer(result) {
  if (result?.canAdd !== false) return { canAdd: true };
  return { canAdd: false, blocked: ADD_BLOCKS.includes(result.addBlocked) ? result.addBlocked : "cap" };
}

export function createCloudAccountClient({ store, openBrowser, platform, deviceName, appVersion,
  origin = CLOUD_ORIGIN, fixture = false, custom = false, fetch: fetcher = globalThis.fetch, now = Date.now, onState = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout, warn = message => console.warn(message), awaitingWake = () => false, appLinks = false }) {
  origin = cloudOrigin(origin, fixture, custom);
  const staging = origin === STAGING_CLOUD_ORIGIN;
  let grant = null, issued = null, cleanup = null, pending = null, cleanupNeeded = false;
  /** @type {{ grant: unknown, until: number, iceServers: Array<{ urls: string[], username?: string, credential?: string }> } | null} */
  let screenIceCache = null;
  let value = { status: "signed-out", message: "restoring" }, generation = 0, timer = null, closed = false, clearing = null, refreshing = null;
  let verifiedUntil = 0, restoring = false, controller = new AbortController(), failures = 0;
  // expiries the account service issues are in its own time: read against its clock (its Date header), so a computer
  // whose clock is far ahead or behind does not see a fresh sign-in as expired
  let skew = 0, skewKnown = false;
  const serverNow = () => now() + skew;
  function noteServerDate(response) {
    const at = Date.parse(response.headers?.get?.("date") ?? "");
    skewKnown = true;
    if (!Number.isFinite(at)) return;
    const offset = at - now();
    skew = Math.abs(offset) < 5_000 ? 0 : offset;
  }
  let plan = null, savedHint = null;
  /** The signed-in account's name and photo, from its last sign-in or session read (accountProfile). */
  let profile = null;
  /** The plan's own Cloud that Cancel and Keep act on, as the last verified session names it. */
  let renewalCloud = null;
  let offerCache = null, offerPending = null, waking = false;
  /** The checkout this app opened, its address kept here for Reopen and Copy link: never published, never asked for again. */
  let opened = null;
  /** Another Cloud this app is buying (POST clouds): its id, name, colour and plan, and its checkout page, kept like `opened`'s. */
  let adding = null;
  // the website's handoff page, from the last session read (handoffPage)
  let handoffAt = null;
  /** An email code on its way: the attempt the Admin answered, kept in main only. */
  let emailed = null;
  const newerPlans = new Set();
  const lastPlan = () => plan && grant && plan.accountId === grant.account.id ? { ...(plan.tier ? { tier: plan.tier } : {}), active: plan.active } : null;
  const view = (status, message) => {
    const known = status === "connected" ? null : lastPlan();
    const named = grant && profile?.accountId === grant.account.id ? profile.fields : {};
    return { status, ...(message ? { message } : {}), ...(grant ? { account: { ...grant.account, ...named }, deviceId: grant.device.id, expiresAt: grant.expiresAt } : {}), ...(known ? { lastPlan: known } : {}) };
  };
  const checkout = () => opened && now() - opened.startedAt < CHECKOUT_KEPT_MS
    ? { plan: opened.plan, startedAt: opened.startedAt, ...(opened.signIn ? { signIn: true } : {}), ...(opened.url ? { link: true } : {}), ...(opened.done ? { done: true } : {}),
      ...(opened.source === null ? { found: true } : {}) } : null;
  const buying = () => adding && now() - adding.startedAt < CHECKOUT_KEPT_MS
    ? { cloudId: adding.cloudId, name: adding.name, color: adding.color, tier: adding.tier, startedAt: adding.startedAt, ...(adding.url ? { link: true } : {}), ...(adding.done ? { done: true } : {}) } : null;
  const withCheckout = current => {
    const open = checkout(), add = buying(), shown = waking && current.status === "connected" ? { ...current, waking: true } : current;
    const next = { ...shown, ...(open ? { checkout: open } : {}), ...(add ? { adding: add } : {}) };
    return staging ? { ...next, staging: true } : next;
  };
  const state = () => {
    if (value.status === "connected") {
      if (grant && grant.expiresAt <= serverNow()) return structuredClone(withCheckout(view("reauth-required", "expired")));
      if (serverNow() >= verifiedUntil) return structuredClone(withCheckout(view("unavailable", "verification-expired")));
      if (failures >= CHECKING_AFTER) return structuredClone(withCheckout({ ...value, checking: true }));
    }
    return structuredClone(withCheckout(value));
  };
  const watching = () => Boolean(opened && now() - opened.startedAt < CHECKOUT_WATCH_MS);
  const watchingAdd = () => Boolean(adding && !adding.done && now() - adding.startedAt < CHECKOUT_WATCH_MS);
  const publish = next => { value = next; onState(state()); return state(); };
  const record = (saved, hint) => ({ ...saved, ...(hint ? { planHint: hint } : {}) });
  const stopTimer = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const schedule = (work, delay) => {
    stopTimer();
    if (!closed) { timer = setTimer(() => { timer = null; void work().catch(() => {}); }, Math.max(1, delay)); timer?.unref?.(); }
  };
  const reset = () => { generation++; stopTimer(); controller.abort(); controller = new AbortController(); pending = null; emailed = null; verifiedUntil = 0; failures = 0; return generation; };
  // `quiet`: another account is taking over (quiesce to reload): this sign-in's grant is still in memory, and nothing may ask for
  // it or write it over the one taking its place, whoever asks (a window coming to the front, Settings' Refresh).
  let quiet = false;
  const current = stamp => !closed && !quiet && generation === stamp;
  const versionHeader = text(appVersion, 40) && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/.test(appVersion) ? { "x-madani-version": appVersion } : {};
  async function request(route, { method = "GET", body, token, signal = controller.signal, path = `/api/cloud/desktop/${route}`, timeoutMs = 20_000 } = {}) {
    // the trail: the account service records the same id (apps/dashboard/server/main.ts)
    const cid = newTrailId(), startedAt = Date.now();
    let response;
    try {
      response = await fetcher(`${origin}${path}`, {
        method, redirect: "error", credentials: "omit", cache: "no-store",
        headers: { accept: "application/json", [TRAIL_HEADER]: cid, ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}`, ...versionHeader } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
    } catch (error) {
      trailError("cloud.unreachable", error, { cid, method, path, ms: Date.now() - startedAt });
      throw error;
    }
    trail("cloud.req", { cid, method, path, status: response.status, ms: Date.now() - startedAt });
    noteServerDate(response);
    const reader = response.body?.getReader(), chunks = []; let size = 0;
    try {
      if (reader) while (true) {
        const { done, value: chunk } = await reader.read(); if (done) break;
        size += chunk.byteLength; if (size > 64 * 1024) throw new Error("Cloud response too large.");
        chunks.push(chunk);
      }
    } catch (error) { await reader?.cancel().catch(() => {}); throw error; }
    finally { reader?.releaseLock(); }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
      if (!response.ok) throw Object.assign(new Error("Cloud request failed."), { status: response.status, opaque: true });
      throw new Error("Invalid Cloud response.");
    }
    if (!response.ok) throw Object.assign(new Error("Cloud request failed."), { status: response.status, code: path.startsWith("/v1/") ? data?.code : data?.error, interval: data?.interval, blocked: data?.addBlocked,
      ...(typeof data?.checkoutUrl === "string" ? { checkoutUrl: data.checkoutUrl } : {}) });
    return data;
  }
  function identity(result) {
    if (result?.cloudContractVersion !== 1 || !timestamp(result.expiresAt) || !text(result.device?.id, 128) ||
      !text(result.account?.id, 128) || !text(result.account?.email, 254)) throw new Error("Invalid Cloud identity.");
    return { expiresAt: result.expiresAt, device: { id: result.device.id }, account: { id: result.account.id, email: result.account.email } };
  }
  function validateGrant(saved) {
    if (saved?.origin !== origin || !TOKEN.test(saved.token)) throw new Error("Invalid Cloud credential.");
    return { origin, token: saved.token, ...identity({ ...saved, cloudContractVersion: 1 }) };
  }
  /** A plan newer than this app is paid with its tier, never a lockout; a malformed tier is no tier. */
  function entitlement(input) {
    const newer = typeof input?.plan === "string" && !["free", "pro"].includes(input.plan) && TIER.test(input.plan);
    if (!input || !(newer || ["free", "pro"].includes(input.plan)) || !["active", "inactive"].includes(input.status) ||
      !(input.expiresAt === null || timestamp(input.expiresAt)) || !Number.isSafeInteger(input.version) || input.version < 0) throw new Error("Invalid Cloud entitlement.");
    const plan = input.plan === "free" ? "free" : "pro";
    if (input.status === "active" && (plan !== "pro" || input.expiresAt === null || input.expiresAt <= serverNow())) throw new Error("Invalid active Cloud entitlement.");
    if (newer && !newerPlans.has(input.plan)) { newerPlans.add(input.plan); warn(`[cloud] madani cloud sent plan "${input.plan}", newer than this app; treating it as paid.`); }
    const tier = typeof input.tier === "string" && TIER.test(input.tier) ? input.tier : newer ? input.plan : undefined;
    return { plan, ...(tier ? { tier } : {}), status: input.status,
      expiresAt: input.expiresAt, version: input.version };
  }
  // Security: an upgrade preview's confirmation stays here, never in a page, and is used once.
  const confirmations = new Map();
  async function upgradeFailure(error, signedIn, browser = true) {
    if (signInEnded(error)) { await refresh().catch(() => {}); return { outcome: "failed" }; }
    if (!browser && (!error?.status || error.opaque || error.status === 504)) return { outcome: "unconfirmed" };
    if (!error?.opaque && UPGRADE_REFUSALS.includes(error?.code)) return { outcome: "refused", code: error.code };
    if (browser && grant === signedIn && !error?.opaque && ([404, 405, 501].includes(error?.status) || (error?.status === 503 && error.code === "temporarily_unavailable"))) {
      await openBrowser(`${origin}/cloud`);
      return { outcome: "browser" };
    }
    return { outcome: "failed" };
  }
  /**
   * An Admin without the app's Cancel and Keep (its own 404, 405 or 501) opens the Cloud page's billing instead. Its `not_found`
   * is the Cloud, not the route: the session is read again.
   */
  async function renewalFailure(error, signedIn) {
    if (signInEnded(error)) return { outcome: "failed", state: await refresh().catch(() => state()) };
    if (grant === signedIn && !error?.opaque && [404, 405, 501].includes(error?.status) && error.code !== "not_found") {
      await openBrowser(`${origin}/billing`);
      return { outcome: "browser" };
    }
    return { outcome: "failed", state: [404, 409].includes(error?.status) ? await refresh().catch(() => state()) : state() };
  }
  async function revoke(previous) {
    try { await request("session", { method: "DELETE", body: {}, token: previous.token, signal: AbortSignal.timeout(20_000) }); }
    catch (error) { if (![401, 403].includes(error?.status) || error.opaque) throw error; }
  }
  function homeTarget() {
    const current = state();
    const machine = current.status === "connected" ? current.machine : undefined;
    return machine?.origin && CLOUD_MACHINE_CONNECTABLE.includes(machine.status) ? { origin: machine.origin } : null;
  }
  function otherOwnCloud(cloudId) {
    const current = state();
    return current.status === "connected" ? otherOwnClouds(current.clouds).find(cloud => cloud.id === cloudId) ?? null : null;
  }
  function forget({ quiet = false } = {}) {
    if (clearing) return clearing;
    const previous = grant ?? issued ?? cleanup, stamp = reset();
    grant = null; issued = null; cleanup = previous; cleanupNeeded = true; plan = null; savedHint = null; opened = null; adding = null; renewalCloud = null;
    if (!quiet) publish({ status: "signed-out" });
    const operation = (async () => {
      const [persisted, revoked] = await Promise.allSettled([Promise.resolve().then(() => store.write(null)), previous ? revoke(previous) : Promise.resolve()]);
      if (persisted.status === "fulfilled") { cleanup = null; cleanupNeeded = false; }
      if (!current(stamp)) return state();
      if (persisted.status === "rejected") return publish({ status: "unavailable", message: "signout-storage-failed" });
      if (quiet) return state();
      return publish({ status: "signed-out", ...(revoked.status === "rejected" ? { message: "signout-local-only" } : {}) });
    })().finally(() => { if (clearing === operation) clearing = null; });
    clearing = operation; return operation;
  }
  const signOut = () => forget();
  async function synchronize(stamp) {
    if (!grant || !current(stamp)) return state();
    // before the service's clock is known (a restart), the session read itself decides: the service refuses an expired token
    if (skewKnown && grant.expiresAt <= serverNow()) { stopTimer(); return publish(view("reauth-required", "expired")); }
    try {
      const previous = grant, result = await request("session", { token: previous.token });
      if (!current(stamp) || grant !== previous) return state();
      const next = identity(result);
      handoffAt = handoffPage(result.handoffUrl, origin);
      profile = { accountId: next.account.id, fields: accountProfile(result.account) };
      if (next.device.id !== previous.device.id || next.account.id !== previous.account.id || next.account.email !== previous.account.email || next.expiresAt <= serverNow()) {
        throw Object.assign(new Error("Cloud identity changed."), { status: 401, code: "invalid_token" });
      }
      const access = entitlement(result.entitlement);
      const machine = parseCloudSummary(result.cloud), teams = parseCloudTeams(result.teams);
      const purchase = parseCloudPurchase(result.cloud?.purchase);
      const trial = parseCloudTrial(result.cloud?.trial), offer = parseCloudOffer(result.offer);
      const usage = access.status === "active" ? parseCloudUsage(result.cloud?.usage) : null, room = usage ? parseCloudRoom(result.cloud?.room) : null;
      const websiteSetup = WEBSITE_SETUPS.includes(result.websiteSetup) ? result.websiteSetup : null;
      const clouds = parseCloudList(result.clouds), more = clouds ? addOffer(result) : null, latest = clouds ? releaseVersion(result.latestVersion) : null;
      const organizations = clouds ? parseOrganizations(result.organizations) : null;
      const { cloudId: renewingCloud = null, ...renewal } = parseCloudRenewal(result.clouds) ?? {};
      const hint = access.plan === "pro" ? { ...(access.tier ? { tier: access.tier } : {}), active: access.status === "active" } : null;
      if (next.expiresAt !== previous.expiresAt) {
        const replacement = { ...previous, expiresAt: next.expiresAt };
        await store.write(record(replacement, hint));
        if (!current(stamp) || grant !== previous) return state();
        grant = replacement; savedHint = hint;
      } else if (!sameHint(savedHint, hint)) {
        try { await store.write(record(previous, hint)); savedHint = hint; } catch {}
        if (!current(stamp) || grant !== previous) return state();
      }
      plan = hint ? { accountId: grant.account.id, ...hint } : null;
      renewalCloud = renewingCloud;
      failures = 0;
      // A checkout the Admin still holds open, with none kept here (this app restarted mid-checkout): watched as this
      // app's own from first sight, so payment, setup and "ready" are followed as closely as before the restart.
      if (!opened && offer?.checkout && offer.checkout.openUntil > serverNow() && access.status !== "active") {
        opened = { plan: offer.checkout.plan, source: null, startedAt: now() };
      }
      // Another Cloud at checkout with none kept here (this app restarted mid-checkout, or it was bought elsewhere): watched
      // as this app's own, so "ready" is said for it too.
      const waitingCloud = otherOwnClouds(clouds).find(cloud => cloud.status === "checkout");
      if (!adding && waitingCloud) adding = { cloudId: waitingCloud.id, name: waitingCloud.name, color: waitingCloud.color, tier: waitingCloud.tier, startedAt: now(), url: null };
      // A checkout kept from the Admin's "one is still open" answer, before the session listed its Cloud: that Cloud now.
      else if (adding && adding.cloudId === null && waitingCloud) adding = { ...adding, cloudId: waitingCloud.id, name: waitingCloud.name, color: waitingCloud.color, tier: waitingCloud.tier ?? adding.tier };
      verifiedUntil = Math.min(grant.expiresAt, serverNow() + STEADY_MS,
        access.status === "active" && access.expiresAt !== null ? access.expiresAt : Infinity);
      publish({ ...view("connected"), entitlement: access, ...(machine ? { machine } : {}), ...(teams.length ? { teams } : {}), ...(purchase ? { purchase } : {}),
        ...(trial ? { trial } : {}), ...(offer ? { offer } : {}), ...(usage ? { usage } : {}), ...(room ? { room } : {}), ...(renewingCloud ? { renewal } : {}), ...(websiteSetup ? { websiteSetup } : {}),
        ...(clouds ? { clouds, addCloud: more } : {}), ...(organizations ? { organizations } : {}), ...(latest ? { latestVersion: latest } : {}), verifiedAt: now(), verifiedUntil });
      const planCloud = teamPlan(value) ? planTeam(value)?.machine ?? null : machine;
      const settingUp = planCloud?.status === "provisioning" || (access.status === "active" && !planCloud) || Boolean(purchase) || otherOwnClouds(clouds).some(cloud => cloud.status === "setting_up");
      const added = adding ? clouds?.find(cloud => cloud.id === adding.cloudId) ?? null : null;
      const paying = watchingAdd() && Boolean(adding.url) && (!added || added.status === "checkout");
      const delay = (watching() && planCloud?.status !== "ready") || paying || websiteSetup === "open" ? WATCH_REFRESH_MS : settingUp ? SETUP_REFRESH_MS : awaitingWake() ? ASLEEP_REFRESH_MS : REFRESH_MS;
      schedule(refresh, Math.min(delay, verifiedUntil - serverNow()));
    } catch (error) {
      if (!current(stamp)) return state();
      if (signInEnded(error)) { verifiedUntil = 0; failures = 0; stopTimer(); return publish(view("reauth-required", "access-ended")); }
      failures++;
      if (value.status === "connected") publish(value);
      else publish(view("unavailable", "unreachable"));
      schedule(refresh, Math.min(retryDelay(failures), grant.expiresAt - serverNow()));
    }
    return state();
  }
  function refresh() {
    if (clearing) return clearing;
    if (refreshing?.stamp === generation) return refreshing.operation;
    const entry = { stamp: generation, operation: null };
    entry.operation = synchronize(generation).finally(() => { if (refreshing === entry) refreshing = null; });
    refreshing = entry; return entry.operation;
  }
  /** A token the Admin just issued: stored where every sign-in goes, then this computer is signed in with it. One no
   * longer wanted (the sign-in was superseded or cancelled meanwhile) is revoked, never left behind. */
  async function adopt(result, stamp, wanted = () => true) {
    const next = validateGrant({ origin, token: result?.accessToken, ...identity(result) });
    if (!current(stamp) || !wanted()) { await revoke(next).catch(() => {}); return false; }
    if (next.expiresAt <= serverNow()) throw new Error("Expired Cloud credential.");
    issued = next;
    await store.write(next);
    if (!current(stamp)) return false;
    grant = next; issued = null; pending = null; emailed = null; savedHint = null;
    profile = { accountId: next.account.id, fields: accountProfile(result.account) };
    if (plan?.accountId !== next.account.id) plan = null;
    return true;
  }
  async function poll() {
    const attempt = pending, stamp = generation;
    if (!attempt || !current(stamp)) return state();
    if (now() >= attempt.expiresAt) { pending = null; opened = null; return publish({ status: "signed-out", message: "enrollment-expired" }); }
    try {
      const result = await request("token", { method: "POST", body: { deviceCode: attempt.deviceCode } });
      if (!(await adopt(result, stamp))) return state();
      return await signedInWith(opened, stamp);
    } catch (error) {
      if (!current(stamp)) return state();
      if (issued) return signOut();
      if (error?.code === "slow_down") attempt.interval = Math.min(60_000, Math.max(attempt.interval + 5000, Number.isSafeInteger(error.interval) ? error.interval * 1000 : 0));
      else if (["access_denied", "expired_token", "invalid_grant"].includes(error?.code)) { pending = null; opened = null; return publish({ status: "signed-out", message: "enrollment-ended" }); }
      else if (error?.status && !error.opaque && error.code !== "authorization_pending" && error.status !== 429) { pending = null; opened = null; return publish({ status: "signed-out", message: "signin-failed" }); }
      schedule(poll, Math.min(attempt.interval, attempt.expiresAt - now()));
      return state();
    }
  }
  /** Signed in: the session is read at once, so a plan already bought is there with it; one chosen before signing in goes
   * straight on to its checkout, unless the account already has a plan. */
  async function signedInWith(intent, stamp) {
    const signedIn = await refresh();
    if (intent && current(stamp) && opened === intent && signedIn.status === "connected") {
      if (signedIn.entitlement?.plan !== "free" || signedIn.purchase || signedIn.machine) { opened = null; return publish(value); }
      if (!signedIn.offer) return (await openCheckout(intent.plan, intent.source).catch(() => ({ state: state() }))).state;
    }
    return signedIn;
  }
  /** The browser came back with this app's sign-in link: its one-time code, redeemed with the verifier kept here. A link
   * this app didn't start, or one already used, does nothing. */
  async function finishLink(raw) {
    const answer = parseAppLink(raw), attempt = pending;
    if (!answer || !attempt?.link || answer.state !== attempt.link.state) return { outcome: "ignored", state: state() };
    const stamp = generation;
    pending = null; stopTimer();
    if (now() >= attempt.expiresAt) { opened = null; return { outcome: "failed", state: publish({ status: "signed-out", message: "enrollment-expired" }) }; }
    if ("error" in answer) { opened = null; return { outcome: "failed", state: publish({ status: "signed-out", message: linkFailure(answer.error) }) }; }
    try {
      const result = await request(null, { method: "POST", path: APP_TOKEN,
        body: { code: answer.code, codeVerifier: attempt.link.verifier, deviceName, platform, ...(text(appVersion, 40) && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/.test(appVersion) ? { appVersion } : {}) } });
      if (!(await adopt(result, stamp))) return { outcome: "failed", state: state() };
      return { outcome: "signed-in", state: await signedInWith(opened, stamp) };
    } catch {
      if (!current(stamp)) return { outcome: "failed", state: state() };
      if (issued) return { outcome: "failed", state: await signOut() };
      opened = null;
      return { outcome: "failed", state: publish({ status: "signed-out", message: "signin-failed" }) };
    }
  }
  /** Which provider buttons sign in, as the service says; none from one that doesn't say or can't be reached, and the
   * emailed code stays. */
  async function signInOptions() {
    try { return parseProviders(await request(null, { path: APP_PROVIDERS, timeoutMs: 8_000, signal: AbortSignal.timeout(8_000) })); }
    catch { return { providers: [], recovery: false }; }
  }
  async function begin(intent = null, { provider, account = null, email } = {}) {
    if (!intent || typeof intent !== "object" || !text(intent.plan, 24) || !CHECKOUT_SOURCES.includes(intent.source)) intent = null;
    // the checkout a signed-out purchase leads to is bound to the sign-in on the service as an upgrade intent, never put in the
    // page's URL: the website's sign-in reads a plan in the URL as a plan pick and goes to billing, so the person never
    // approved this app and it never signed in
    account = cleanAccountIntent(account) ?? (intent ? cleanAccountIntent({ kind: "upgrade", plan: intent.plan === "starter" ? "plus" : intent.plan, source: intent.source }) : null);
    if (closed || restoring || clearing || grant || issued || cleanupNeeded) throw new Error("Sign out before starting another Cloud connection.");
    const stamp = reset();
    opened = intent ? { plan: intent.plan, source: intent.source, startedAt: now(), signIn: true } : null;
    // the packaged app owns madanibot://, so the browser comes back here signed in: no code to compare, no page to approve
    const magic = typeof email === "string" ? cleanEmail(email) : null;
    if (typeof email === "string" && !magic) throw new Error("Invalid email.");
    const link = !magic && appLinks && LINK_PROVIDERS.includes(provider) ? linkSignIn(origin, provider) : null;
    if (link) {
      pending = { link: { verifier: link.verifier, state: link.state }, verificationUri: link.url, expiresAt: now() + LINK_MS };
      publish({ status: "connecting", browser: provider });
      try { await openBrowser(link.url); } catch { if (current(stamp)) { pending = null; opened = null; publish({ status: "signed-out", message: "signin-failed" }); } return state(); }
      if (current(stamp)) schedule(async () => { if (current(stamp) && pending?.link) { pending = null; opened = null; publish({ status: "signed-out", message: "enrollment-expired" }); } }, LINK_MS);
      return state();
    }
    publish({ status: "connecting" });
    try {
      if (!text(deviceName, 100) || !["darwin", "win32", "linux"].includes(platform)) throw new Error("Invalid desktop.");
      const result = await request("authorize", { method: "POST", body: { deviceName, platform, ...(text(appVersion, 40) ? { appVersion } : {}), ...(account ? { intent: account } : {}), ...(magic ? { email: magic } : {}) } });
      if (!current(stamp)) return state();
      if (result.cloudContractVersion !== 1 || !PRIVATE_CODE.test(result.deviceCode) || !CODE.test(result.userCode) ||
        !desktopApprovalLink(result.verificationUriComplete, origin, result.userCode) || !Number.isSafeInteger(result.expiresIn) || result.expiresIn < 1 || result.expiresIn > MAX_ENROLL_SECONDS ||
        !Number.isSafeInteger(result.interval) || result.interval < 5 || result.interval > 60) throw new Error("Invalid Cloud authorization.");
      const next = "";
      pending = { deviceCode: result.deviceCode, verificationUri: ["google", "apple"].includes(provider) ? `${origin}/v1/auth/oauth/${provider}/start?next=${encodeURIComponent(`/cloud/desktop?code=${result.userCode}`)}` : `${result.verificationUriComplete}${next}`, expiresAt: now() + result.expiresIn * 1000, interval: result.interval * 1000 };
      publish({ status: "connecting", enrollment: { userCode: result.userCode, expiresAt: pending.expiresAt }, ...(magic ? { magic } : {}) });
      // a magic link: the person opens it from their mail, so no page opens here
      if (!magic) await openBrowser(pending.verificationUri);
      if (current(stamp)) schedule(poll, pending.interval);
    } catch { if (current(stamp)) { pending = null; opened = null; publish({ status: "signed-out", message: "signin-failed" }); } }
    return state();
  }
  /** A website page in the browser, already signed in as this app's account through a one-time link: "plans" with an optional
   * plan and source, "workspace" with one of the account's workspaces, or another page of HANDOFF_PAGES. An Admin without the
   * link (or one that fails) gets the plain page, where the browser may ask to sign in. */
  async function webHandoff({ page = "plans", plan, source, workspaceId } = {}) {
    if (!Object.hasOwn(HANDOFF_PAGES, page) || (plan !== undefined && !HANDOFF_PLANS.includes(plan)) || (source !== undefined && !CHECKOUT_SOURCES.includes(source))
      || (page !== "plans" && (plan !== undefined || source !== undefined)) || (page === "workspace") !== WORKSPACE_ID.test(workspaceId ?? "")) throw new Error("Invalid web handoff.");
    const signedIn = grant;
    if (!signedIn || state().status === "reauth-required") return { signedOut: true };
    const query = new URLSearchParams({ ...(plan ? { plan } : {}), ...(source ? { src: source } : {}), ...(page === "workspace" ? { workspace: workspaceId } : {}) }).toString();
    const asked = { next: page, ...(plan ? { plan } : {}), ...(source ? { source } : {}), ...(page === "workspace" ? { workspaceId } : {}) };
    // the handoff page is known from the session: the browser opens at once on a token made here, and the Admin learns
    // it alongside (the page waits a few seconds for it), so the click never waits on a round trip
    if (handoffAt) {
      const token = randomBytes(32).toString("base64url");
      void request("", { path: "/v1/app/web-handoff", method: "POST", token: signedIn.token, body: { ...asked, token } })
        .catch(error => { if (signInEnded(error)) refresh().catch(() => {}); });
      await openBrowser(`${handoffAt}#t=${token}`);
      return { opened: true };
    }
    let destination = null;
    try {
      const result = await request("", { path: "/v1/app/web-handoff", method: "POST", token: signedIn.token, body: asked });
      destination = result?.v === 1 ? handoffDestination(result.url, origin) : null;
    } catch (error) {
      if (signInEnded(error)) { await refresh().catch(() => {}); return { signedOut: true }; }
    }
    if (grant !== signedIn) return { opened: false };
    if (destination) { await openBrowser(destination); return { opened: true }; }
    await openBrowser(`${origin}${HANDOFF_PAGES[page]}${query ? `?${query}` : ""}`);
    return { opened: true, fallback: true };
  }
  const signInBlocked = () => closed || restoring || clearing || grant || issued || cleanupNeeded;
  /** Sends the 8-digit code to `email`. Nothing is signed in yet; the answer says what the sheet shows next. */
  async function emailStart(email, { recover = false } = {}) {
    if (signInBlocked() || value.status === "connecting") throw new Error("Sign out before starting another Cloud connection.");
    const address = cleanEmail(email), app = signInIdentity({ deviceName, platform, appVersion });
    if (!address) return { outcome: "invalid-email" };
    if (!app) return { outcome: "browser" };
    const stamp = generation;
    // A code already sent stays good until a new one is: a refused Resend (too many, offline) must not lose it.
    if (emailed && emailed.email !== address) emailed = null;
    try {
      const started = parseSignInStart(await request(null, { method: "POST", path: SIGN_IN_START, body: { email: address, ...app, ...(recover === true ? { recover: true } : {}) } }));
      if (!current(stamp)) return { outcome: "failed" };
      if (!started) return { outcome: "failed" };
      emailed = { attempt: started.attempt, email: address, expiresAt: now() + started.expiresIn * 1000, wrong: 0 };
      return { outcome: "sent", email: address, expiresAt: emailed.expiresAt, resendAt: now() + started.resendAfter * 1000, signupOpen: started.signupOpen };
    } catch (error) {
      return current(stamp) ? { outcome: startFailure(error) } : { outcome: "failed" };
    }
  }
  /** Checks the code; on success the token is stored like the browser sign-in's and the session is read at once. */
  async function emailVerify(code) {
    const attempt = emailed, digits = cleanCode(code);
    if (!attempt || now() >= attempt.expiresAt) { emailed = null; return { outcome: "expired" }; }
    if (!digits) return { outcome: "wrong-code", triesLeft: SIGN_IN_TRIES - attempt.wrong };
    if (signInBlocked()) throw new Error("Sign out before starting another Cloud connection.");
    // a code is single-use: one that can't be kept afterwards must not be spent
    if (store.ready && !(await store.ready())) return { outcome: "storage" };
    const stamp = generation;
    try {
      const result = await request(null, { method: "POST", path: SIGN_IN_VERIFY, body: { attempt: attempt.attempt, code: digits } });
      if (!(await adopt(result, stamp, () => emailed === attempt))) return { outcome: "failed" };
      return { outcome: "signed-in", state: await refresh() };
    } catch (error) {
      if (!current(stamp)) return { outcome: "failed" };
      if (issued) { await signOut(); return { outcome: "storage" }; }
      const outcome = verifyFailure(error);
      if (outcome === "wrong-code" && emailed === attempt) {
        attempt.wrong++;
        if (attempt.wrong < SIGN_IN_TRIES) return { outcome, triesLeft: SIGN_IN_TRIES - attempt.wrong };
      }
      if (emailed === attempt) emailed = null;
      return { outcome: outcome === "wrong-code" ? "expired" : outcome };
    }
  }
  async function openCheckout(plan, source) {
    if (typeof plan !== "string" || !TIER.test(plan) || !CHECKOUT_SOURCES.includes(source)) throw new Error("Invalid Cloud checkout.");
    const current = state();
    if (current.status === "signed-out" && !grant) return { outcome: "signing-in", state: await begin({ plan, source }) };
    if (current.status !== "connected" || !grant) throw new Error("Sign in to madani cloud before choosing a plan.");
    const signedIn = grant;
    let destination;
    try {
      const result = await request("checkout", { method: "POST", body: { plan, source }, token: signedIn.token });
      destination = checkoutDestination(result?.url, { fixture, staging, custom });
      if (result?.cloudContractVersion !== 1 || !destination) return { outcome: "failed", state: state() };
    } catch (error) {
      if (!error?.opaque && error?.status === 409) return { outcome: "conflict", state: await refresh() };
      if (!error?.opaque && error?.status === 429) return { outcome: "rate-limited", state: state() };
      if (signInEnded(error)) return { outcome: "failed", state: await refresh() };
      // the Admin paused the app's checkout (503 temporarily_unavailable): the Cloud page's billing still takes the plan
      const paused = !error?.opaque && error?.status === 503 && error.code === "temporarily_unavailable";
      if (![404, 405, 501].includes(error?.status) && !paused) return { outcome: "failed", state: state() };
      destination = `${origin}/billing?${new URLSearchParams({ plan, src: source })}`;
    }
    if (grant !== signedIn) return { outcome: "failed", state: state() };
    await openBrowser(destination);
    opened = { plan, source, startedAt: now(), url: destination };
    publish(value);
    schedule(refresh, WATCH_REFRESH_MS);
    return { outcome: "opened", state: state() };
  }
  /** Reopen checkout: the same page again, never a new one from the Admin; only with none kept here (the browser
   * sign-in led to it, or the app restarted) is the Admin asked, and it reopens the open one. Watches 30 minutes more. */
  async function reopenCheckout(plan, source) {
    const kept = opened;
    if (!kept?.url) return openCheckout(kept?.plan ?? plan, kept?.source ?? source);
    await openBrowser(kept.url);
    if (opened !== kept) return { outcome: "failed", state: state() };
    opened = { ...kept, startedAt: now() };
    publish(value);
    schedule(refresh, WATCH_REFRESH_MS);
    return { outcome: "opened", state: state() };
  }
  /** A sign-in that may only be locked in the keychain is kept, never removed, and read again shortly. */
  async function restoreFailed(stamp, unreadable) {
    cleanupNeeded = true;
    if (unreadable) {
      const removed = await store.write(null).then(() => true, () => false);
      if (!current(stamp)) return state();
      if (removed) { cleanupNeeded = false; failures = 0; return publish({ status: "signed-out", message: "restore-removed" }); }
    }
    failures++;
    if (value.message !== "restore-failed") publish({ status: "unavailable", message: "restore-failed" });
    schedule(start, retryDelay(failures));
    return state();
  }
  async function start() {
    const stamp = generation;
    restoring = true; verifiedUntil = 0;
    let saved, restored = null, failed = false, unreadable = false;
    try { saved = await store.read(); } catch (error) { failed = true; unreadable = unreadableRecord(error); }
    if (!failed) try { restored = saved ? validateGrant(saved) : null; } catch { failed = unreadable = true; }
    restoring = false;
    if (!current(stamp)) return state();
    if (failed) return restoreFailed(stamp, unreadable);
    grant = restored; cleanupNeeded = false; failures = 0;
    savedHint = grant ? planHint(saved.planHint) : null;
    plan = grant && savedHint ? { accountId: grant.account.id, ...savedHint } : null;
    if (!grant) return ["restoring", "restore-failed"].includes(value.message) ? publish({ status: "signed-out" }) : state();
    return refresh();
  }
  return {
    state,
    start,
    begin,
    async enrollGrant() {
      const signedIn = grant;
      if (!signedIn || state().status !== "connected") return null;
      try {
        const result = await request("", { path: "/v1/app/enroll-grant", method: "POST", body: {}, token: signedIn.token });
        if (grant !== signedIn || result?.v !== 1 || typeof result.enrollToken !== "string" || result.enrollToken.length !== 43 || !PRIVATE_CODE.test(result.enrollToken) || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= serverNow() || typeof result.dashboardUrl !== "string" || new URL(result.dashboardUrl).origin !== origin) return null;
        return { enrollToken: result.enrollToken, dashboardUrl: result.dashboardUrl };
      } catch (error) { if (signInEnded(error)) await refresh().catch(() => {}); return null; }
    },
    /** Keeps the person's avatar on the account ("photo", "g:<seed>", or null for the default): true once the account
     * service has it, null when signed out or it did not answer. */
    async setAvatar(choice) {
      const signedIn = grant;
      if (!signedIn || state().status !== "connected" || (choice !== null && (typeof choice !== "string" || !AVATAR_CHOICE.test(choice)))) return null;
      try {
        const result = await request("", { path: "/v1/app/avatar", method: "POST", body: { avatar: choice }, token: signedIn.token });
        if (grant !== signedIn || (result?.avatar !== choice)) return null;
        const { avatar: _old, ...rest } = profile?.accountId === signedIn.account.id ? profile.fields : {};
        profile = { accountId: signedIn.account.id, fields: { ...rest, ...(choice ? { avatar: choice } : {}) } };
        if (value.account) { const { avatar: _was, ...account } = value.account; publish({ ...value, account: { ...account, ...(choice ? { avatar: choice } : {}) } }); }
        return true;
      } catch (error) { if (signInEnded(error)) await refresh().catch(() => {}); return null; }
    },
    /** Takes a workspace this account owns off its dashboard (a server this app forgot): true once it is gone, null when
     * signed out or the account service did not answer. */
    async unlinkWorkspace(workspaceId) {
      const signedIn = grant;
      if (!signedIn || state().status !== "connected" || typeof workspaceId !== "string" || !/^ws_[A-Za-z0-9_-]{1,64}$/.test(workspaceId)) return null;
      try {
        const result = await request("", { path: "/v1/app/workspace-unlink", method: "POST", body: { workspaceId }, token: signedIn.token });
        return result?.ok === true ? true : null;
      } catch (error) { if (signInEnded(error)) await refresh().catch(() => {}); return null; }
    },
    /** A five-minute signed grant for the link service, so a VPS setup session belongs to this account; null when signed out. */
    async linkGrant() {
      const signedIn = grant;
      if (!signedIn || state().status !== "connected") return null;
      try {
        const result = await request("", { path: "/v1/app/link-grant", method: "POST", body: {}, token: signedIn.token });
        if (grant !== signedIn || result?.v !== 1 || typeof result.grant !== "string" || !/^l1\.[a-z0-9-]{1,32}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(result.grant) || result.grant.length > 1024) return null;
        return result.grant;
      } catch (error) { if (signInEnded(error)) await refresh().catch(() => {}); return null; }
    },
    /** A ten-minute, single-use letters-only code (and the account's email) that logs a phone in to this account
     * (ACCOUNT_ROUTES.phoneSignIn): { outcome: "code", code, expiresAt, email, service } or { outcome: "signed-out" | "limited" | "unsupported" | "failed" }. */
    async phoneSignIn() {
      const signedIn = grant;
      if (!signedIn || state().status !== "connected") return { outcome: "signed-out" };
      try {
        const result = await request("", { path: "/v1/app/phone-sign-in", method: "POST", body: {}, token: signedIn.token });
        if (grant !== signedIn || result?.v !== 1 || typeof result.code !== "string" || !/^[A-Z]{4}-[A-Z]{4}$/.test(result.code)
          || !timestamp(result.expiresAt) || !text(result.email, 254)) return { outcome: "failed" };
        return { outcome: "code", code: result.code, expiresAt: result.expiresAt, email: result.email, service: origin };
      } catch (error) {
        if (signInEnded(error)) { await refresh().catch(() => {}); return { outcome: "signed-out" }; }
        return { outcome: error?.status === 429 ? "limited" : error?.status === 404 ? "unsupported" : "failed" };
      }
    },
    /** Short-lived Cloudflare TURN servers for the direct screen path, kept until shortly before they expire; null when signed out or off. */
    async screenIce() {
      const signedIn = grant;
      if (!signedIn || state().status !== "connected") return null;
      if (screenIceCache?.grant === signedIn && screenIceCache.until > serverNow()) return screenIceCache.iceServers;
      try {
        const result = await request("", { path: "/v1/app/screen-ice", method: "POST", body: {}, token: signedIn.token });
        const servers = Array.isArray(result?.iceServers) ? result.iceServers.filter((one) => one && Array.isArray(one.urls) && one.urls.every((url) => typeof url === "string" && /^(?:stuns?|turns?):[a-z0-9.-]+\.cloudflare\.com(?::\d{1,5})?(?:\?transport=(?:udp|tcp))?$/i.test(url))
          && (one.username === undefined || (typeof one.username === "string" && typeof one.credential === "string"))).slice(0, 4) : [];
        if (grant !== signedIn || result?.v !== 1 || !servers.length || !Number.isSafeInteger(result.expiresAt)) return null;
        screenIceCache = { grant: signedIn, until: Math.min(result.expiresAt - 10 * 60_000, serverNow() + 60 * 60_000), iceServers: servers };
        return servers;
      } catch (error) { if (signInEnded(error)) await refresh().catch(() => {}); return null; }
    },
    emailStart, emailVerify,
    emailCancel() { emailed = null; },
    finishLink, signInOptions,
    checkout: openCheckout,
    reopenCheckout,
    /** For main's clipboard only: the kept checkout page, while it is the one being waited on. */
    checkoutLink: () => (opened?.url && now() - opened.startedAt < CHECKOUT_KEPT_MS ? opened.url : null),
    checkoutPending: watching,
    /** The Cloud this checkout bought was opened, announced or shown ready: the purchase is over (Add a Cloud… says one Cloud for now). */
    checkoutDone() { if (opened && !opened.done) { opened = { ...opened, done: true }; publish(value); } },
    async signInAgain() {
      if (state().status !== "reauth-required") throw new Error("This computer is still signed in to madani cloud.");
      publish({ status: "connecting" });
      const forgotten = await forget({ quiet: true });
      if (forgotten.status === "unavailable") return forgotten;
      return begin();
    },
    async reopen() {
      if (pending && value.status === "connecting" && pending.expiresAt > now()) await openBrowser(pending.verificationUri);
      return state();
    },
    cancel: () => { if (!pending && value.status !== "connecting") return Promise.resolve(state()); opened = null; return signOut(); },
    refresh, signOut,
    async openDashboard() { await webHandoff({ page: "cloud" }); return state(); },
    /**
     * An account step in the browser, for its context (the account context redirect): already signed in, the one-time
     * handoff opens the right page (the plan checkout, billing or home) with no second sign-in; signed out, the browser
     * sign-in opens with the intent bound to it, the website lands on that page after signing in or up, and this app
     * signs itself in when the person approves (polling, or madanibot://auth). Returning to the app is optional.
     * Answers `opened` (already signed in), `browser` (a sign-in under way: state().status is "connecting") or `failed` (the
     * sign-in did not start).
     */
    async continueInBrowser(input) {
      const intent = cleanAccountIntent(input);
      if (!intent) throw new Error("Invalid account step.");
      const signedIn = grant && state().status === "connected";
      if (signedIn) {
        const page = intent.kind === "upgrade" ? "plans" : intent.kind === "billing" ? "billing" : "home";
        const source = intent.kind === "upgrade" && intent.source ? intent.source : undefined;
        const opened = await webHandoff({ page, ...(page === "plans" && intent.plan ? { plan: intent.plan } : {}), ...(page === "plans" && source ? { source } : {}) });
        if (!opened?.signedOut) {
          if (intent.kind === "upgrade") schedule(refresh, WATCH_REFRESH_MS);
          return { outcome: "opened", state: state() };
        }
      }
      if (value.status === "connecting") { if (pending && pending.expiresAt > now()) await openBrowser(pending.verificationUri); return { outcome: "browser", state: state() }; }
      const checkout = intent.kind === "upgrade" && intent.plan && intent.source ? { plan: intent.plan, source: intent.source } : null;
      await begin(checkout, { account: intent });
      // the sign-in could not start (the service refused, the browser didn't open): never "continue in your browser" over nothing
      return { outcome: value.status === "connecting" ? "browser" : "failed", state: state() };
    },
    webHandoff,
    async upgradePreview(plan, source) {
      if (!UPGRADE_TIERS.includes(plan) || !UPGRADE_SOURCES.includes(source)) throw new Error("Invalid Cloud upgrade.");
      const signedIn = grant;
      if (!signedIn || state().status !== "connected") return { outcome: "failed" };
      let result;
      try { result = await request("upgrade/preview", { method: "POST", body: { plan, source }, token: signedIn.token, timeoutMs: 60_000 }); }
      catch (error) { return upgradeFailure(error, signedIn); }
      if (grant !== signedIn || result?.cloudContractVersion !== 1) return { outcome: "failed" };
      if (["upgraded", "pending"].includes(result.status)) { await refresh(); return { outcome: "settled", status: result.status, tier: TIER.test(result.tier) ? result.tier : plan }; }
      const cents = value => Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000;
      if (result.tier !== plan || !cents(result.price) || result.price < 1 || !cents(result.chargeNow) || !cents(result.tax ?? 0) || result.currency !== "USD"
        || typeof result.trial !== "boolean" || !CONFIRMATION.test(result.confirmation ?? "") || !timestamp(result.expiresAt)) return { outcome: "failed" };
      confirmations.set(plan, { token: result.confirmation, expiresAt: Math.min(result.expiresAt, serverNow() + 10 * 60_000), account: signedIn.account.id });
      return { outcome: "preview", preview: { plan, ...(TIER.test(result.from ?? "") ? { from: result.from } : {}), trial: result.trial, price: result.price,
        chargeNow: result.chargeNow, tax: result.tax ?? 0, ...(timestamp(result.nextBillingAt) ? { nextBillingAt: result.nextBillingAt } : {}), expiresAt: result.expiresAt } };
    },
    async upgrade(plan, source) {
      if (!UPGRADE_TIERS.includes(plan) || !UPGRADE_SOURCES.includes(source)) throw new Error("Invalid Cloud upgrade.");
      const signedIn = grant, agreed = confirmations.get(plan);
      confirmations.delete(plan);
      if (!signedIn || state().status !== "connected") return { outcome: "failed" };
      if (!agreed || agreed.account !== signedIn.account.id || agreed.expiresAt <= serverNow()) return { outcome: "refused", code: "confirmation_required" };
      let result;
      try { result = await request("upgrade", { method: "POST", body: { plan, confirmation: agreed.token, source }, token: signedIn.token, timeoutMs: 120_000 }); }
      catch (error) { const failure = await upgradeFailure(error, signedIn, false); await refresh().catch(() => {}); return failure; }
      await refresh().catch(() => {});
      if (result?.cloudContractVersion !== 1 || !["upgraded", "pending"].includes(result.status)) return { outcome: "failed" };
      return { outcome: result.status, tier: TIER.test(result.tier ?? "") ? result.tier : plan };
    },
    /**
     * Cancel trial / Cancel plan: the survey first when the person said anything (given SURVEY_WAIT_MS, and let go when it
     * fails or is refused), then renewal off for the plan's own Cloud, named by the verified session, never by a page.
     * `cancelled`: when it ends, from the Admin's answer (`renewal`), and whether the survey was kept; `browser`: this Admin
     * can't cancel from the app yet, so its Cloud page's billing opened instead; `failed`: nothing changed.
     */
    async cancelPlan(input) {
      const signedIn = grant, cloudId = renewalCloud;
      if (!signedIn || !cloudId || state().status !== "connected") return { outcome: "failed", state: state() };
      const survey = cancelSurvey(input);
      let surveyed = false;
      if (survey) {
        try { await request("feedback", { method: "POST", body: { cloudId, ...survey }, token: signedIn.token, timeoutMs: SURVEY_WAIT_MS }); surveyed = true; }
        catch {}
      }
      if (grant !== signedIn) return { outcome: "failed", state: state() };
      let result;
      try { result = await request(`clouds/${cloudId}/cancel`, { method: "POST", body: {}, token: signedIn.token, timeoutMs: 60_000 }); }
      catch (error) { return renewalFailure(error, signedIn); }
      const { cloudId: answered, ...renewal } = result?.cloudContractVersion === 1 ? parseCloudRenewal([result.cloud]) ?? {} : {};
      return { outcome: "cancelled", renewal: answered === cloudId ? renewal : null, surveyed, state: await refresh().catch(() => state()) };
    },
    /**
     * The first run's AI sign-ins for the account's own Cloud while it is being made: the Admin holds them sealed, for a
     * day at most, and hands them to that Cloud once it runs. The Cloud is the session's own, never one a page names;
     * `items` never reach a log here.
     */
    async holdSignIns(items) {
      const signedIn = grant, current = state();
      const cloud = current.clouds?.find(entry => entry.primary && entry.runsOn === "cloud" && ["checkout", "setting_up", "ready"].includes(entry.status));
      if (!signedIn || current.status !== "connected" || !cloud) return { outcome: "no-cloud" };
      if (!Array.isArray(items) || !items.length) return { outcome: "nothing" };
      const hold = (list) => request(`clouds/${encodeURIComponent(cloud.id)}/ai-signins`, { method: "POST", body: { items: list }, token: signedIn.token, timeoutMs: 30_000 });
      try { await hold(items); }
      catch (error) {
        // an older Admin refuses kinds it doesn't know: it still holds the ChatGPT login, the one kind it always took
        const known = items.filter(item => item?.kind === "codex-auth");
        if (error?.status !== 400 || !known.length || known.length === items.length) return { outcome: "failed" };
        try { await hold(known); } catch { return { outcome: "failed" }; }
      }
      return { outcome: "held" };
    },
    /** Keep my plan: renewal back on for the same Cloud, as `cancelPlan` names it. */
    async keepPlan() {
      const signedIn = grant, cloudId = renewalCloud;
      if (!signedIn || !cloudId || state().status !== "connected") return { outcome: "failed", state: state() };
      try { await request(`clouds/${cloudId}/keep`, { method: "POST", body: {}, token: signedIn.token, timeoutMs: 60_000 }); }
      catch (error) { return renewalFailure(error, signedIn); }
      return { outcome: "kept", state: await refresh().catch(() => state()) };
    },
    async offer() {
      const current = state();
      if (current.status === "connected" && current.offer) return current.offer;
      if (!offerCache || now() >= offerCache.until) {
        offerPending ??= request(null, { path: "/api/public/config", signal: AbortSignal.timeout(10_000) }).then(
          config => { const offer = parsePublicOffer(config); offerCache = { value: offer, until: now() + (offer ? OFFER_MS : OFFER_RETRY_MS) }; return offer; },
          () => { offerCache = { value: null, until: now() + OFFER_RETRY_MS }; return null; },
        ).finally(() => { offerPending = null; });
        await offerPending;
      }
      return current.status === "connected" ? withoutTrial(offerCache.value) : offerCache.value;
    },
    /** Not now on the room card: the Admin offers this Cloud nothing more for two weeks. The Cloud is the session's own. */
    async roomNotNow(id) {
      const signedIn = grant;
      if (!signedIn || state().status !== "connected") return false;
      try { await request("room", { method: "POST", body: { ...(typeof id === "string" ? { id } : {}), answer: "not_now" }, token: signedIn.token }); }
      catch { return false; }
      await refresh().catch(() => {});
      return true;
    },
    /** Restart now, after an upgrade: the bigger size goes at once instead of the next idle moment (`restarting`), or the
     * Cloud already has it (`current`); `failed` when the Admin couldn't be asked. */
    async restartNow() {
      const signedIn = grant;
      if (!signedIn || state().status !== "connected") return "failed";
      try {
        const result = await request("resize-now", { method: "POST", body: {}, token: signedIn.token, timeoutMs: 30_000 });
        return ["restarting", "current"].includes(result?.state) ? result.state : "failed";
      } catch { return "failed"; }
    },
    async interest(kind) {
      if (kind !== "another_cloud") throw new Error("Invalid Cloud interest.");
      const signedIn = grant;
      if (!signedIn || state().status !== "connected") throw new Error("Sign in to madani cloud first.");
      const result = await request("interest", { method: "POST", body: { kind }, token: signedIn.token });
      if (result?.ok !== true) throw new Error("Invalid Cloud response.");
    },
    homeTarget,
    /** The Admin's last verified word on a Cloud whose plan sleeps, kept while a re-check fails; null for any other. */
    power: () => (value.status === "connected" ? value.machine?.power ?? null : null),
    /** The same for the Cloud at `origin`: My Cloud's `cloud.power`, or another's from the Clouds list (contract v1, Oct 30). */
    powerOf: origin => {
      if (value.status !== "connected" || typeof origin !== "string" || !origin) return null;
      if (value.machine?.origin === origin) return value.machine.power ?? null;
      return (value.clouds ?? []).find(cloud => cloud.origin === origin)?.power ?? null;
    },
    /** Starts a sleeping Cloud through the Admin (`awake` once started, `waking` if it is still starting), then reads the
     *  session again so Files and lending resume. `intent` says what the person did: `type`, `click` and `send` wake it,
     *  `open` and `view` leave it `asleep`. Null when there is nothing to wake or the Admin can't say. */
    async wakeHome(intent) {
      const current = grant, power = value.status === "connected" ? value.machine?.power : null;
      if (!current || !power || power.state === "awake") return null;
      if (!WAKE_INTENTS.includes(intent)) throw new Error("Invalid wake intent.");
      let woke = null;
      try {
        const result = await request("wake", { method: "POST", body: { intent }, token: current.token });
        woke = WAKE_STATES.includes(result?.state) ? result.state : null;
      } catch {}
      await refresh().catch(() => {});
      return woke;
    },
    /** Opening a sleeping Cloud takes a moment: the state says so meanwhile. */
    setWaking(on) {
      if (waking === (on === true)) return;
      waking = on === true;
      publish(value);
    },
    async growDisk(sizeGb) {
      const current = grant;
      if (!current || state().status !== "connected") throw new Error("My Cloud is not ready yet.");
      if (!Number.isSafeInteger(sizeGb) || sizeGb < 1 || sizeGb > 10_000) throw new Error("Invalid Cloud disk size.");
      let result;
      try { result = await request("disk", { method: "POST", body: { sizeGb }, token: current.token }); } catch (error) {
        if ([404, 405, 501].includes(error?.status)) return { supported: false };
        if ([409, 422].includes(error?.status)) return { supported: true, refused: true };
        throw error;
      }
      const disk = result?.disk;
      if (!disk || !Number.isSafeInteger(disk.gb) || !Number.isSafeInteger(disk.maxGb) || disk.gb < 1 || disk.maxGb < disk.gb) throw new Error("Invalid Cloud disk response.");
      return { supported: true, disk: { gb: disk.gb, maxGb: disk.maxGb } };
    },
    /** The code goes to main only, for one navigation, and is not kept. `cloudId`: another Cloud of the person's own
     * that the verified session lists (the Admin answers 404 once it is not theirs any more: `gone`); none is My Cloud,
     * which an older Admin pairs from the same empty body. The grant must be for that Cloud's own address. */
    async pairHome(cloudId = null) {
      const current = grant;
      if (cloudId !== null) {
        const cloud = otherOwnCloud(cloudId);
        if (!current || !cloud) throw Object.assign(new Error("That Cloud is no longer one of yours."), { gone: true });
        if (!cloud.origin || !["ready", "offline"].includes(cloud.status)) throw new Error(`${cloud.name} isn't ready to open yet.`);
        let result;
        try { result = await request("pairing", { method: "POST", body: { cloudId }, token: current.token }); } catch (error) {
          if (error?.status === 404 && !error.opaque) { void refresh().catch(() => {}); throw Object.assign(new Error(`${cloud.name} is no longer one of your Clouds.`), { gone: true }); }
          if (error?.status === 409) throw new Error(`${cloud.name} isn't running right now.`);
          throw error;
        }
        const pairing = parsePairingGrant(result, cloud.origin, serverNow());
        if (!pairing) throw new Error("Invalid Cloud pairing response.");
        return pairing;
      }
      const target = homeTarget();
      if (!target || !current) throw new Error("My Cloud is not ready to connect yet.");
      let result;
      try { result = await request("pairing", { method: "POST", body: {}, token: current.token }); } catch (error) {
        const why = cloudUnreachableText(await refresh().catch(() => state()), target.origin);
        throw why ? new Error(why) : error;
      }
      const pairing = parsePairingGrant(result, target.origin, serverNow());
      if (!pairing) throw new Error("Invalid Cloud pairing response.");
      return pairing;
    },
    /** The signed-in account's token for main's usage reports to this same origin (product-events.mjs); never leaves main. */
    eventToken: () => (!closed && !quiet && grant && grant.expiresAt > now() ? grant.token : null),
    /** `origin` is the address of a Cloud the person owns (My Cloud or another of theirs), by the verified session only. */
    isOwnCloud(origin) {
      const current = state();
      if (typeof origin !== "string" || !origin || current.status !== "connected") return false;
      return current.machine?.origin === origin || (current.clouds ?? []).some(cloud => ownCloud(cloud) && cloud.origin === origin);
    },
    /** Buys another Cloud (POST clouds; contract v1): the plan, how often it is paid, its name and its swatch. The
     * Admin's checkout opens in the browser and its page is kept here for Reopen and Copy link, as the first Cloud's is;
     * the session is then read every few seconds until the Cloud is paid for. `unsupported`: this Admin sells one Cloud
     * per account; `blocked` with the Admin's reason. */
    async addCloud({ tier, interval = "month", name, color = null, source = null } = {}) {
      const cleanName = cleanCloudListName(name);
      if (typeof tier !== "string" || !TIER.test(tier) || !ADD_INTERVALS.includes(interval) || !cleanName || !(color === null || CLOUD_SWATCHES.includes(color))
        || !(source === null || CHECKOUT_SOURCES.includes(source))) {
        throw new Error("Invalid Cloud to add.");
      }
      const signedIn = grant;
      if (!signedIn || state().status !== "connected") return { outcome: "failed" };
      if (!value.clouds) return { outcome: "unsupported" };
      if (value.addCloud?.canAdd === false) return { outcome: "blocked", blocked: value.addCloud.blocked };
      let result;
      try { result = await request("clouds", { method: "POST", body: { tier, interval, name: cleanName, ...(color ? { color } : {}), ...(source ? { source } : {}) }, token: signedIn.token }); } catch (error) {
        if (signInEnded(error)) { await refresh().catch(() => {}); return { outcome: "failed" }; }
        // The Admin's own reason wins, whatever the status (409 cap or open checkout, 429 rate, 503 sign-ups closed).
        const blocked = !error?.opaque && ADD_BLOCKS.includes(error?.blocked) ? error.blocked : null;
        if (blocked === "checkout_open") {
          // Another Cloud's checkout is still open: its page is kept here, as one this app opened, to reopen or copy.
          const open = checkoutDestination(error.checkoutUrl, { fixture, staging, custom });
          const listed = otherOwnClouds(value.clouds).find(cloud => cloud.status === "checkout") ?? null;
          if (open && grant === signedIn) {
            adding = { cloudId: listed?.id ?? null, name: listed?.name ?? cleanName, color: listed ? listed.color : color, tier: listed?.tier ?? tier, startedAt: now(), url: open };
            publish(value);
            schedule(refresh, WATCH_REFRESH_MS);
          }
        }
        if (blocked) return { outcome: "blocked", blocked };
        if (!error?.opaque && error?.status === 409) return { outcome: "blocked", blocked: "cap" };
        if (!error?.opaque && error?.status === 429) return { outcome: "blocked", blocked: "rate" };
        if ([404, 405, 501].includes(error?.status)) return { outcome: "unsupported" };
        return { outcome: "failed" };
      }
      const destination = checkoutDestination(result?.checkoutUrl, { fixture, staging, custom });
      if ((result?.cloudContractVersion !== undefined && result.cloudContractVersion !== 1) || typeof result?.cloudId !== "string" || !CLOUD_ID.test(result.cloudId) || !destination) return { outcome: "failed" };
      if (grant !== signedIn) return { outcome: "failed" };
      await openBrowser(destination);
      adding = { cloudId: result.cloudId, name: cleanName, color, tier, startedAt: now(), url: destination };
      publish(value);
      schedule(refresh, WATCH_REFRESH_MS);
      return { outcome: "opened", state: state() };
    },
    /** A new organization on the Team plan this account pays for (POST organizations, contract v1): its name and swatch, and
     * no checkout. `added` once the Admin made it (the session is read again, so the rail shows it being set up); `blocked`
     * with the Admin's reason; `taken` when another of the plan's has that name; `unsupported` from an Admin without it. */
    async addOrganization({ name, color = null } = {}) {
      const cleanName = cleanCloudListName(name);
      if (!cleanName || !(color === null || CLOUD_SWATCHES.includes(color))) throw new Error("Invalid organization to add.");
      const signedIn = grant;
      if (!signedIn || state().status !== "connected") return { outcome: "failed" };
      if (!value.organizations) return { outcome: "unsupported" };
      let result;
      try { result = await request("organizations", { method: "POST", body: { name: cleanName, ...(color ? { color } : {}) }, token: signedIn.token }); } catch (error) {
        if (signInEnded(error)) { await refresh().catch(() => {}); return { outcome: "failed" }; }
        if (!error?.opaque && ORGANIZATION_BLOCKS.includes(error?.blocked)) return { outcome: "blocked", blocked: error.blocked };
        if (!error?.opaque && error?.code === "name_taken") return { outcome: "taken" };
        if (!error?.opaque && error?.status === 429) return { outcome: "blocked", blocked: "rate" };
        if ([404, 405, 501].includes(error?.status)) return { outcome: "unsupported" };
        return { outcome: "failed" };
      }
      if (grant === signedIn) await refresh().catch(() => {});
      return { outcome: "added", ...(typeof result?.cloud?.id === "string" && CLOUD_ID.test(result.cloud.id) ? { cloudId: result.cloud.id } : {}) };
    },
    /** A Cloud's colour (PATCH clouds/:id, contract v1), which only its owner or its team's Super admin and Admins
     * change: `saved` once the Admin keeps it (the session is read again, so every place follows); `refused` when the
     * Admin says it is someone else's to change; `unsupported` from an Admin without the route or the list. */
    async setCloudColor(cloudId, color) {
      if (typeof cloudId !== "string" || !CLOUD_ID.test(cloudId) || !(color === null || CLOUD_SWATCHES.includes(color))) throw new Error("Invalid Cloud color.");
      const signedIn = grant;
      if (!signedIn || state().status !== "connected") return { outcome: "failed" };
      if (!value.clouds?.some(cloud => cloud.id === cloudId && cloud.managed !== false)) return { outcome: "unsupported" };
      try { await request(`clouds/${encodeURIComponent(cloudId)}`, { method: "PATCH", body: { color }, token: signedIn.token }); } catch (error) {
        if (signInEnded(error)) { await refresh().catch(() => {}); return { outcome: "failed" }; }
        if (!error?.opaque && error?.status === 403) return { outcome: "refused" };
        if ([404, 405, 501].includes(error?.status)) return { outcome: "unsupported" };
        return { outcome: "failed" };
      }
      if (grant === signedIn) await refresh().catch(() => {});
      return { outcome: "saved" };
    },
    /** Remove from list (POST clouds/:id/hide, contract v1): one of the person's own Clouds the verified session says they may
     * take off their list (`removable`: it ended, or was never paid for). Only the list changes on the Admin; its files still go
     * when they were going to. `removed` once the Admin did (the session is read again, so every list here follows); `refused`
     * when it says that Cloud can't be removed now; `gone` when it is not theirs any more; `unsupported` from an Admin without
     * Remove from list (whose session never says `removable`). */
    async hideCloud(cloudId) {
      if (typeof cloudId !== "string" || !CLOUD_ID.test(cloudId)) throw new Error("Invalid Cloud to remove.");
      const signedIn = grant;
      if (!signedIn || state().status !== "connected") return { outcome: "failed" };
      if (!value.clouds?.some(cloud => cloud.id === cloudId && cloud.removable === true)) return { outcome: "unsupported" };
      try { await request(`clouds/${encodeURIComponent(cloudId)}/hide`, { method: "POST", body: {}, token: signedIn.token }); } catch (error) {
        if (signInEnded(error)) { await refresh().catch(() => {}); return { outcome: "failed" }; }
        if (!error?.opaque && error?.code === "not_removable") { await refresh().catch(() => {}); return { outcome: "refused" }; }
        if (!error?.opaque && error?.code === "not_found") { await refresh().catch(() => {}); return { outcome: "gone" }; }
        if ([404, 405, 501].includes(error?.status)) return { outcome: "unsupported" };
        return { outcome: "failed" };
      }
      if (grant === signedIn) await refresh().catch(() => {});
      return { outcome: "removed" };
    },
    /** The Cloud being bought's checkout, again: the same page while it is kept here; false when there is none. */
    async reopenAdd() {
      const kept = adding;
      if (!kept?.url) return false;
      await openBrowser(kept.url);
      if (adding !== kept) return false;
      adding = { ...kept, startedAt: now() };
      publish(value);
      schedule(refresh, WATCH_REFRESH_MS);
      return true;
    },
    /** For main's clipboard only: that checkout's page. */
    addLink: () => (adding?.url && now() - adding.startedAt < CHECKOUT_KEPT_MS ? adding.url : null),
    /** The Cloud this app bought was opened or announced: that purchase is over. */
    addDone() { if (adding && !adding.done) { adding = { ...adding, done: true }; publish(value); } },
    /** A one-time code for a team's Cloud, signed by the Admin with this person's membership: main only, for one
     * navigation. The Admin answers 404 once they are no longer in the team (`gone`), 409 while its Cloud isn't running. */
    async pairTeam(teamId) {
      const current = grant, team = value.status === "connected" ? value.teams?.find(entry => entry.id === teamId) ?? null : null;
      if (!current || !team) throw Object.assign(new Error("You're no longer in this team."), { gone: true });
      const origin = team.machine?.origin;
      if (!origin || !CLOUD_MACHINE_CONNECTABLE.includes(team.machine.status)) throw new Error(`${team.name} isn't ready to open yet.`);
      let result;
      try { result = await request(`teams/${encodeURIComponent(teamId)}/pairing`, { method: "POST", body: {}, token: current.token }); } catch (error) {
        if (error?.status === 404 && !error.opaque) { void refresh().catch(() => {}); throw Object.assign(new Error(`You're no longer in ${team.name}.`), { gone: true }); }
        if (error?.status === 409) throw new Error(`${team.name} isn't running right now.`);
        throw error;
      }
      const pairing = parsePairingGrant(result, origin, serverNow());
      if (!pairing) throw new Error("Invalid Cloud pairing response.");
      return pairing;
    },
    /** A Cloud that ended and that the Admin still holds, started for its owner's export only: a one-time code for it
     * (main only, not kept), `starting` while it starts, `notHeld` when it is not held (yet), `deleted` once it is gone.
     * `installation`: this computer, which the Admin lets take it only if it is the one the Cloud's things come home to. */
    async exportHome({ installation } = {}) {
      const current = grant;
      if (!current) throw new Error("Sign in to madani cloud first.");
      let result;
      try { result = await request("export", { method: "POST", body: installation ? { installation } : {}, token: current.token }); } catch (error) {
        if (error?.status === 409) return { notHeld: true };
        if (error?.status === 410) return { deleted: true };
        throw error;
      }
      if (result?.cloudContractVersion === 1 && result.state === "starting") return { starting: true };
      const pairing = typeof result?.origin === "string" && result.origin.startsWith("https://") ? parsePairingGrant(result, result.origin, serverNow()) : null;
      if (!pairing) throw new Error("Invalid Cloud export response.");
      return { grant: pairing };
    },
    /** Tells the Admin that this computer's move to My Cloud is done, as `installation` (POST /api/cloud/desktop/moved):
     * only such a computer can be the one an ended Cloud's things come home to. False when the Admin can't take it yet. */
    async reportMove({ installation }) {
      const current = grant;
      if (!current) return false;
      try { await request("moved", { method: "POST", body: { installation }, token: current.token }); return true; }
      catch (error) { if (error?.status === 404 && !error.opaque) return false; throw error; }
    },
    /** Tells the Admin that this computer, as `installation`, keeps its bots on itself again (POST
     * /api/cloud/desktop/kept): it no longer counts as moved, so an ended Cloud's things never come home to it. False when
     * the Admin can't take it yet. */
    async reportKept({ installation }) {
      const current = grant;
      if (!current) return false;
      try { await request("kept", { method: "POST", body: { installation }, token: current.token }); return true; }
      catch (error) { if (error?.status === 404 && !error.opaque) return false; throw error; }
    },
    /** The Admin's word on this account's own Cloud at `origin` (POST /api/cloud/desktop/moved-to), for a computer frozen
     * for a Cloud that is not My Cloud now: "deleted", "ended" (stopped and kept only until it is deleted), "live", or
     * "unknown" (none of this account's ever was). Null without a verified sign-in, or from an Admin that doesn't say (404). */
    async movedTo(cloudOrigin) {
      const current = grant;
      if (!current || value.status !== "connected" || typeof cloudOrigin !== "string") return null;
      let result;
      try { result = await request("moved-to", { method: "POST", body: { origin: cloudOrigin }, token: current.token }); }
      catch (error) { if (error?.status === 404 && !error.opaque) return null; throw error; }
      return grant === current && result?.cloudContractVersion === 1 && MOVED_TO.includes(result.state) ? result.state : null;
    },
    /** Asks the Admin for a backup of this account's own Cloud at `cloudOrigin` now (POST /api/cloud/desktop/backup), once a
     * move into it was checked: "started", or "not_managed" for a Cloud the Admin does not back up. Null without a sign-in, or
     * from an Admin that doesn't take it (404). */
    async requestBackup(cloudOrigin) {
      const current = grant;
      if (!current || typeof cloudOrigin !== "string") return null;
      let result;
      try { result = await request("backup", { method: "POST", body: { origin: cloudOrigin }, token: current.token }); }
      catch (error) { if (error?.status === 404 && !error.opaque) return null; throw error; }
      return result?.state === "started" || result?.state === "not_managed" ? result.state : null;
    },
    /** Tells the Admin where this computer's move to My Cloud stands (POST /api/cloud/desktop/move-status; move-status.mjs
     * builds `report`). False when there is no sign-in or the Admin doesn't take it yet (404). */
    async reportMoveStatus(report) {
      const current = grant;
      if (!current) return false;
      try { await request("move-status", { method: "POST", body: report, token: current.token, timeoutMs: 15_000 }); return true; }
      catch (error) { if (error?.status === 404 && !error.opaque) return false; throw error; }
    },
    /** This sign-in's own X research relay access while its plan is paid:
     * `{ url, token }` for the local server (electron/included-x.mjs), or null
     * when there is no sign-in, the Admin says the plan is not active (402) or
     * it does not offer X research (404). Never kept on disk. The relay must
     * be on the Cloud's own origin: the token goes nowhere else. */
    async xResearchAccess() {
      const current = grant;
      if (!current) return null;
      let result;
      try { result = await request("services/x", { method: "POST", body: {}, token: current.token }); }
      catch (error) { if (error?.status === 402 || error?.status === 404) return null; throw error; }
      let relay = null;
      try { relay = typeof result?.url === "string" ? new URL(result.url) : null; } catch { relay = null; }
      if (result?.cloudContractVersion !== 1 || !relay || relay.origin !== origin || typeof result.token !== "string" || !/^(?:madani|omb)_xd_[A-Za-z0-9_-]{43}$/.test(result.token)) {
        throw new Error("Invalid Cloud X research response.");
      }
      return { url: result.url, token: result.token };
    },
    /** This sign-in's own pages token, for any plan: `{ url, token }` for the local server (electron/included-pages.mjs),
     * or null when there is no sign-in or the Admin does not offer pages yet (404). Never kept on disk. The token route
     * must be on the Cloud's own origin: the token goes nowhere else. */
    async pagesAccess() {
      const current = grant;
      if (!current) return null;
      let result;
      try { result = await request("services/pages", { method: "POST", body: {}, token: current.token }); }
      catch (error) { if (error?.status === 404) return null; throw error; }
      let target = null;
      try { target = typeof result?.url === "string" ? new URL(result.url) : null; } catch { target = null; }
      if (result?.cloudContractVersion !== 1 || !target || target.origin !== origin || typeof result.token !== "string" || !/^(?:madani|omb)_pd_[A-Za-z0-9_-]{43}$/.test(result.token)) {
        throw new Error("Invalid Cloud pages response.");
      }
      return { url: result.url, token: result.token };
    },
    /** another account takes over: nothing more is asked or written for this sign-in. */
    quiesce() { quiet = true; reset(); },
    /** Reads the sign-in saved in `store` afresh: nothing of the one before stays. Told once, when the Admin has answered. */
    reload() {
      quiet = false;
      reset();
      grant = null; issued = null; cleanup = null; cleanupNeeded = false; plan = null; savedHint = null; opened = null; adding = null; renewalCloud = null; offerCache = null; waking = false;
      confirmations.clear();
      value = { status: "signed-out", message: "restoring" };
      return start();
    },
    /** Ends a sign-in that waits on this device, at the Admin. */
    revokeSaved: revoke,
    close() { closed = true; reset(); },
  };
}

export function cloudMenuSublabel(state, date) {
  if (state?.status !== "connected") return null;
  const trial = state.trial;
  if (state.entitlement?.plan === "pro" && state.entitlement.status === "active") {
    if (trial?.state === "active" || trial?.state === "ending") return `Free trial until ${date(trial.endsAt)}`;
    return state.machine?.power?.sleeps ? "Sleeps when idle" : "Always on";
  }
  return state.machine || trial ? "Stopped" : null;
}

/** Who runs My Cloud's machine, as the session's list says (`provider`); nothing from an Admin that doesn't say. */
const homeProvider = clouds => {
  const provider = Array.isArray(clouds) ? clouds.find(cloud => cloud.primary && ownCloud(cloud))?.provider : undefined;
  return typeof provider === "string" ? { provider } : {};
};

/** What the person's own Cloud page may show of the plan: never the account, a credential or an address. */
export function cloudPlanSnapshot(state, { notice = null } = {}) {
  const tier = state?.status === "connected" ? state.entitlement?.tier : state?.lastPlan?.tier;
  const named = typeof tier === "string" ? { tier } : {};
  const trial = state?.status === "connected"
    ? { ...(state.trial ? { trial: state.trial } : {}), ...(notice && state.trial ? { notice } : {}),
      ...(state.machine?.power?.sleeps ? { sleeps: true } : {}), ...(state.usage ? { usage: state.usage } : {}), ...(state.room ? { room: state.room } : {}),
      ...(state.renewal ? { renewal: state.renewal } : {}), ...homeProvider(state.clouds) } : {};
  if (state?.status === "connected" && state.entitlement?.plan === "pro") return { status: state.entitlement.status === "active" ? "paid" : "attention", ...named, ...trial };
  if (state?.status === "reauth-required") return { status: "signin", ...(state.lastPlan ? { tier: state.lastPlan.tier ?? "pro" } : {}) };
  if (state?.status !== "connected" && state?.lastPlan) return { status: "checking", ...named };
  return { status: "none", ...trial };
}
