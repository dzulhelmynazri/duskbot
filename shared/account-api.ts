// the account contract of the hosted service (apps/dashboard/server): who a person is, how they sign in, and the sessions
// the website and the apps hold. version 1. the Admin contract v1 routes the desktop app already speaks
// (/api/cloud/app/sign-in/*, /api/cloud/desktop/{authorize,token,session}) keep their shapes; everything here is additive.
// owned by the accounts work: other modules import it, they do not edit it.

export type SignInProvider = "email" | "google" | "apple";
export const OAUTH_PROVIDERS = ["google", "apple"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

/** the email code the apps' sign-in sheet takes (Admin contract v1: eight digits). */
export const EMAIL_CODE_DIGITS = 8;
export const EMAIL_CODE_TTL_SECONDS = 600;
export const EMAIL_CODE_TRIES = 5;
export const EMAIL_RESEND_SECONDS = 30;

/** cookies the website session uses. the session cookie is HttpOnly; the csrf cookie is readable so the page can echo
 * it in CSRF_HEADER on every cookie-authenticated POST, PATCH and DELETE. */
export const SESSION_COOKIE = "madani_dash";
export const CSRF_COOKIE = "madani_csrf";
export const CSRF_HEADER = "x-madani-csrf";
/** a browser signed in before the rename holds the cookie under its old name until it signs in again */
export const CSRF_COOKIE_BEFORE = "omb_csrf";
export function readCsrfCookie(cookies: string): string | undefined {
  for (const name of [CSRF_COOKIE, CSRF_COOKIE_BEFORE]) {
    const part = cookies.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
    if (part) return part.slice(name.length + 1);
  }
  return undefined;
}

/** the deep link a phone sign-in returns to: madanibot://auth?code=...&state=... or ?error=...&state=... */
export const APP_AUTH_REDIRECT = "madanibot://auth";
/** the desktop app's provider sign-in (app start with landing=page) ends on this website page instead: it hands the deep
 * link (in the fragment, #code=...&state=...) to the app and says to head back, rather than leaving the provider's page up */
export const APP_LANDING_PATH = "/app-signed-in";

export interface AccountView {
  id: string;
  email: string;
  name: string | null;
  createdAt: number;
  /** every way this account can sign in, email first when it has one. */
  providers: SignInProvider[];
  /** the photo of the newest google or x sign-in, and the person's avatar choice (shared/user-avatar.ts); absent when none */
  avatarUrl?: string;
  avatar?: string;
}
export interface IdentityView {
  provider: OAuthProvider;
  /** the address the provider vouched for, or null (x often has none). */
  email: string | null;
  /** the provider's display handle or name, for the account page only. */
  label: string | null;
  addedAt: number;
}
export interface SessionView {
  id: string;
  kind: "web" | "desktop" | "mobile";
  /** the device's own name (the app sends it) or a browser label for the website. */
  name: string;
  platform: string | null;
  appVersion: string | null;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  /** the session this request came with. */
  current: boolean;
}
export interface ProviderView {
  id: OAuthProvider;
  /** configured with real keys (or a fixture provider): the button signs in. */
  enabled: boolean;
  /** not configured; only true on a development service, where the button says "coming soon". */
  comingSoon: boolean;
}

/** ?error= on /sign-in (and on the app deep link) after a provider sign-in that did not finish. */
export type OAuthErrorCode = "oauth_denied" | "oauth_failed" | "oauth_expired" | "provider_unavailable" | "signup_closed" | "identity_taken";

/** every route, for the page and the apps. methods and bodies are listed beside each. */
export const ACCOUNT_ROUTES = {
  // website, no session needed
  providers: "/v1/auth/providers", //           GET  -> ProvidersAnswer
  emailStart: "/v1/auth/start", //              POST { email, pending?, recover? } -> EmailStartAnswer
  emailVerify: "/v1/auth/verify", //            POST { attempt, code } -> WebSignInAnswer (+ session and csrf cookies)
  /** GET ?next=/path (same-origin path, default /): 302 to the provider; it comes back to oauthCallback and then to next. */
  oauthStart: (provider: OAuthProvider) => `/v1/auth/oauth/${provider}/start`,
  /** GET for google and x, POST form for apple (form_post). */
  oauthCallback: (provider: OAuthProvider) => `/v1/auth/oauth/${provider}/callback`,
  // website, session cookie (+ CSRF_HEADER on mutations)
  me: "/v1/me", //                              GET  -> MeAnswer
  signOut: "/v1/auth/signout", //               POST {} -> { ok: true } (this browser only)
  account: "/v1/account", //                    GET  -> AccountAnswer; PATCH { name } -> AccountAnswer
  notifications: "/v1/account/notifications", // GET -> NotificationPrefs; PUT Partial<NotificationPrefs> -> NotificationPrefs
  onboarded: "/v1/account/onboarded", //        POST {} -> { onboarded: true }
  identity: (provider: OAuthProvider) => `/v1/account/identities/${provider}`, // DELETE -> AccountAnswer (refused for the last way in)
  session: (id: string) => `/v1/account/sessions/${encodeURIComponent(id)}`, //  DELETE -> { ok: true }
  signOutEverywhere: "/v1/account/signout-everywhere", // POST {} -> { ok: true } (every browser and app, this one too)
  deleteAccount: "/v1/account/delete", //       POST { email, cancelBilling?, destroyDesktopsNow? } (email must equal the account's) -> { ok: true }
  /** link another provider to the signed-in account: GET oauthStart(provider)?link=1&next=/account. */
  deviceLookup: "/v1/auth/device", //           GET ?code=XXXXX-XXXXX -> DeviceLookupAnswer
  deviceApprove: "/v1/auth/device/approve", //  POST { userCode } -> { ok: true }
  deviceDeny: "/v1/auth/device/deny", //        POST { userCode } -> { ok: true }
  // apps
  /** GET ?provider&code_challenge&code_challenge_method=S256&state&redirect_uri=APP_AUTH_REDIRECT: 302 to the provider
   * (provider=email opens the website sign-in first); it ends at the deep link with a one-time code. */
  appStart: "/v1/auth/app/start",
  appToken: "/v1/auth/app/token", //            POST { code, codeVerifier, deviceName, platform, appVersion? } -> AppGrant
  /** bearer app session: a one-time token the app hands its own workspace so it enrolls into this account's dashboard. */
  enrollGrant: "/v1/app/enroll-grant", //       POST {} -> EnrollGrantAnswer
  /** bearer app session: takes a workspace this account owns off its dashboard, as when the app forgets a server it
   * linked there. never a madani cloud's own workspace. */
  workspaceUnlink: "/v1/app/workspace-unlink", // POST { workspaceId } -> { ok: true, removed: boolean }
  /** bearer app session: a five-minute signed grant the app hands the link service to open a VPS setup session. */
  linkGrant: "/v1/app/link-grant", //           POST {} -> { v: 1, grant, expiresAt }
  /** bearer desktop app session: a short letters-only code (and its QR) that logs a phone in to this account, single use,
   * PHONE_SIGN_IN_TTL_MS long. the phone redeems it at appPhoneSignIn. */
  phoneSignIn: "/v1/app/phone-sign-in", //      POST {} -> PhoneSignInGrant
  /** bearer app session: every computer and server this account holds (its madani clouds' own workspaces left out), with
   * presence. never another account's. */
  appComputers: "/v1/app/computers", //         GET -> AppComputersAnswer
  /** bearer app session: asks one of the account's computers, while it is online, for a one-time phone pairing link, so the
   * phone links to it without anyone at the computer. 404 for a computer that is not this account's; 409 { code }:
   * computer_offline (not seen lately, or did not answer in time), computer_unreachable (no route a phone can use, e.g.
   * phone access is off there), pair_refused (refused or too old to know how); 429 rate_limited. */
  appComputerPair: (id: string) => `/v1/app/computers/${encodeURIComponent(id)}/pair`, // POST {} -> AppComputerPairAnswer
  /** bearer app session: short-lived Cloudflare TURN credentials for the direct screen path; 503 when TURN is off. */
  screenIce: "/v1/app/screen-ice", //           POST {} -> { v: 1, iceServers, expiresAt }
  /** bearer app session: deletes the account from the app, as deleteAccount does on the website, cancelling any plan
   * (it does not renew; a madani cloud is deleted after its paid time and the usual grace). `email` must be the account's. */
  appDeleteAccount: "/v1/app/delete-account", // POST { email } -> { ok: true }
  /** bearer app session: a one-time link that opens the website signed in to the same account (WebHandoffRequest). */
  webHandoff: "/v1/app/web-handoff", //         POST WebHandoffRequest -> WebHandoffAnswer
  /** website, same-origin only (Origin must be the service's): redeems a WebHandoffAnswer link's token.
   * the token is not spent by a 409: { code: "confirm", email } for a signed-out browser (again with confirm: true), or
   * { code: "other_account", email } while it is signed in to another account (again with replace: true to switch). */
  handoffRedeem: "/v1/auth/handoff", //         POST { token, confirm?, replace? } -> HandoffAnswer (+ session and csrf cookies)
  // Admin contract v1 (unchanged shapes; bearer omc_ token where signed in)
  appEmailStart: "/api/cloud/app/sign-in/start",
  appEmailVerify: "/api/cloud/app/sign-in/verify",
  /** a native app's sign in with apple (AppleNativeSignIn): the identity token and authorization code from
   * ASAuthorizationAppleIDCredential -> AppGrant; errors { error: invalid_request | invalid_grant | signup_closed |
   * identity_taken | provider_unavailable | rate_limited } */
  appAppleSignIn: "/api/cloud/app/sign-in/apple",
  /** a phone redeems a desktop's PhoneSignInGrant code -> AppGrant; errors { error: invalid_request | invalid_code |
   * expired | used | rate_limited } */
  appPhoneSignIn: "/api/cloud/app/sign-in/phone", // POST { code, deviceName, platform, appVersion? }
  desktopAuthorize: "/api/cloud/desktop/authorize",
  desktopToken: "/api/cloud/desktop/token",
  appSession: "/api/cloud/desktop/session", //  GET -> AppSessionAnswer; DELETE {} -> { ok: true }
  /** bearer app session: the person's avatar (shared/user-avatar.ts): "photo", "g:<seed>", or null for the default. */
  appAvatar: "/v1/app/avatar", //               POST { avatar: string | null } -> { avatar: string | null }
} as const;

/** online: reachable now (it is holding its line to the service); asleep: seen within COMPUTER_ASLEEP_MS, so a laptop
 * lid or a stopped server; offline: longer than that, or never */
export type ComputerPresence = "online" | "asleep" | "offline";
export const COMPUTER_ASLEEP_MS = 24 * 60 * 60_000;
/** `id` is the workspace id; `environmentId` is the computer's own id (its phone links carry it), null from older apps;
 * `lastSeenAt` is the last time it spoke to the service, null when never */
export interface AppComputer { id: string; name: string; kind: "vps" | "mac" | "linux" | "windows"; presence: ComputerPresence; lastSeenAt: number | null; environmentId: string | null }
export interface AppComputersAnswer { v: 1; computers: AppComputer[] }
/** `link` is the computer's one-time phone pairing link (shared/mobile-link.ts mobileLinkUrl), dead at `expiresAt` */
export interface AppComputerPairAnswer { v: 1; link: string; expiresAt: number }

/** a phone sign-in code: letters only (server/sessions.ts PAIRING_CODE_ALPHABET), shown XXXX-XXXX, single use */
export const PHONE_SIGN_IN_CODE_LENGTH = 8;
export const PHONE_SIGN_IN_TTL_MS = 10 * 60_000;
/** `email`: the account the code logs into, for the desktop to show */
export interface PhoneSignInGrant { v: 1; code: string; expiresAt: number; email: string }
/** what a person typed or a link carried as a phone sign-in code, uppercase without dashes or spaces, or null */
export function cleanPhoneSignInCode(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const code = value.replace(/[\s-]/g, "").toUpperCase();
  return code.length === PHONE_SIGN_IN_CODE_LENGTH && /^[A-Z]+$/.test(code) ? code : null;
}

/** `nonce` is the raw nonce; the app sets the request's nonce to its sha-256 hex. `givenName`/`familyName` come from the
 * credential's fullName, which apple fills only the first time; send them whenever present. */
export interface AppleNativeSignIn { identityToken: string; authorizationCode: string; nonce: string; givenName?: string; familyName?: string; deviceName: string; platform: "ios" | "darwin"; appVersion: string }
/** `recovery`: start takes `recover: true` ("Can't sign in?"): the code goes out with the ways the address signs in (and a
 * one-time link for the website), or, for an address no account uses, only that. */
export interface ProvidersAnswer { v: 1; providers: ProviderView[]; signupOpen: boolean; recovery?: boolean }
export interface EmailStartAnswer { attempt: string; expiresIn: number; resendAfter: number; signupOpen: boolean }
export interface WebSignInAnswer { account: AccountView; csrfToken: string; created: boolean; redirect?: string }
export interface MeAnswer { account: AccountView; csrfToken: string }
/** the optional emails an account gets. receipts, payment problems, sign-in codes and deletion warnings always send. */
export interface NotificationPrefs {
  /** a cloud is ready, or was set up again from a backup */
  cloudStatus: boolean;
  /** launches and feature news */
  product: boolean;
}
export const NOTIFICATION_DEFAULTS: NotificationPrefs = { cloudStatus: true, product: true };
/** `onboarded`: the page's first-run steps were finished, in any browser */
export interface AccountAnswer { account: AccountView; identities: IdentityView[]; sessions: SessionView[]; notifications: NotificationPrefs; onboarded: boolean }
export interface DeviceLookupAnswer { /** this browser signed in after the app asked: approved without a click */ fresh?: boolean; /** and the account was made by this sign-in */ created?: true; device: { name: string; platform: string }; userCode: string; expiresAt: number; /** the app's account step, bound to this sign-in */ intent?: AccountIntent; /** where the website goes once approved */ next?: string }
/** what an app sign-in ends in (Admin contract v1's verify answer). */
export interface AppGrant {
  cloudContractVersion: 1;
  accessToken: string;
  expiresAt: number;
  device: { id: string };
  /** `name` and `avatarUrl` (https): absent when the account has none, and from services older than them. `avatar`: the
   * person's choice (shared/user-avatar.ts), absent for the default. */
  account: { id: string; email: string; name?: string; avatarUrl?: string; avatar?: string };
}
export interface EnrollGrantAnswer { v: 1; enrollToken: string; expiresAt: number; dashboardUrl: string }
/**
 * What the person was doing when an account step sent them to the browser (the account context redirect): the website
 * signs them in or up there, then lands on the right page, and the app picks the result up by itself.
 * - `signin`: the dashboard's home, then back to the app signed in.
 * - `upgrade`: the plan checkout for `plan` (pricing when none), then a "you're all set" page back to the app; `move` says
 *   the app moves bots once the cloud is ready ("computer" for this computer, or a server's workspace id).
 * - `billing`: the billing page.
 * The intent is bound to the app's browser sign-in on the service (short-lived, never trusted from the URL), or, already
 * signed in, carried by the one-time web handoff.
 */
export const ACCOUNT_INTENT_KINDS = ["signin", "upgrade", "billing"] as const;
export type AccountIntentKind = (typeof ACCOUNT_INTENT_KINDS)[number];
export interface AccountIntent { kind: AccountIntentKind; plan?: "plus" | "pro"; source?: string; move?: string }
/** the intent's checked form, or null: plan only for upgrade, a known kind, a short move id */
export function cleanAccountIntent(value: unknown): AccountIntent | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (!ACCOUNT_INTENT_KINDS.includes(input.kind as AccountIntentKind)) return null;
  const kind = input.kind as AccountIntentKind;
  const plan = kind === "upgrade" && (input.plan === "plus" || input.plan === "pro") ? input.plan : undefined;
  const source = typeof input.source === "string" && /^[a-z_]{2,40}$/.test(input.source) ? input.source : undefined;
  const move = kind === "upgrade" && typeof input.move === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(input.move) ? input.move : undefined;
  return { kind, ...(plan ? { plan } : {}), ...(source ? { source } : {}), ...(move ? { move } : {}) };
}
/** where the website goes for an intent once signed in: the plan checkout, billing, or home */
export function accountIntentPath(intent: AccountIntent | null): string {
  if (!intent || intent.kind === "signin") return "/";
  const query = new URLSearchParams({ ...(intent.plan ? { plan: intent.plan } : {}), ...(intent.source ? { src: intent.source } : {}), from: "app" });
  return `/billing?${query}`;
}
export const HANDOFF_PLANS = ["plus", "pro"] as const;
/** `source` is one of billing's CHECKOUT_SOURCES; the page it opens is built by the service from these, never sent. */
/** the website pages an app opens signed in: "plans" is billing with an optional plan and source, "workspace" a workspace
 * of the account (workspaceId), the rest the page of that name. */
export const HANDOFF_PAGES = { plans: "/billing", home: "/", workspace: "/", cloud: "/cloud", billing: "/billing", account: "/account", usage: "/usage" } as const;
export type HandoffPage = keyof typeof HANDOFF_PAGES;
/** `token`: one the app made itself, so it opens the browser on `${handoffUrl}#t=<token>` before this request lands (the page waits for it) */
export interface WebHandoffRequest { next: HandoffPage; plan?: (typeof HANDOFF_PLANS)[number]; source?: string; workspaceId?: string; token?: string }
/** `url` is `${publicUrl}${pageBase}/handoff#t=<token>`: the token only in the fragment, single use, about two minutes. */
export interface WebHandoffAnswer { v: 1; url: string; expiresAt: number }
/** `next` is an app path (no page base) built from the issued link, e.g. "/billing?plan=pro&src=app_computer_move". */
export interface HandoffAnswer { account: AccountView; csrfToken: string; next: string }
/** GET /api/cloud/desktop/session: the identity part. billing adds entitlement, cloud and the rest beside it. */
export interface AppSessionIdentity {
  cloudContractVersion: 1;
  expiresAt: number;
  device: { id: string };
  account: { id: string; email: string };
  /** the website's handoff page, `${publicUrl}${pageBase}/handoff`, so the app can open it at once (WebHandoffRequest.token) */
  handoffUrl?: string;
  /** "open": this account was just made through the app's browser sign-in and the website is taking it through its first
   * steps (name, plan) now; the app's first run waits for them. "free" or "cloud": those steps are done, and where they
   * put the bots. absent: done before, elsewhere, or a service older than this field */
  websiteSetup?: WebsiteSetup;
}
/** where the website's first steps put the bots: this computer (free) or madani cloud (a plan picked, its checkout opened) */
export type WebsiteHome = "free" | "cloud";
export type WebsiteSetup = "open" | WebsiteHome;
export const WEBSITE_HOMES: readonly WebsiteHome[] = ["free", "cloud"];

/** the error answer of the /v1 routes: { error: human text, code }. the Admin contract v1 routes (/api/cloud/*) answer
 * { error: code } instead, as the shipped apps read it. */
export type AccountErrorCode =
  | "billing_active" | "delete_on_account_page"
  | "invalid_request" | "invalid_email" | "wrong_code" | "invalid_code" | "expired" | "rate_limited" | "signup_closed"
  | "used" | "signed_out" | "confirm" | "other_account" | "invalid_token" | "forbidden" | "csrf" | "not_found" | "last_identity" | "identity_taken"
  | "authorization_pending" | "slow_down" | "access_denied" | "expired_token" | "invalid_grant" | "provider_unavailable" | "failed";
