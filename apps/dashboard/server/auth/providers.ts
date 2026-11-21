import { createHash, createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { OAUTH_PROVIDERS, type OAuthProvider } from "../../../../shared/account-api.ts";
import { createJwtVerifier, decodeJws, fetchJson, signEs256Jwt } from "./jwt.ts";

export interface ProviderConfig {
  clientId: string; clientSecret?: string; authorizeUrl: string; tokenUrl: string; revokeUrl?: string; jwksUrl?: string; issuers?: string[]; scopes: string;
  apple?: { teamId: string; keyId: string; privateKey: string };
  /** apple: the native apps' bundle ids (bot.madani.mobile) whose identity tokens /api/cloud/app/sign-in/apple accepts */
  nativeClientIds?: string[];
}
export type ProviderConfigs = Partial<Record<OAuthProvider, ProviderConfig>>;
/** `refreshToken`: Apple's, kept (sealed) only so the account's deletion can revoke it, with the client id that got it
 *  (`refreshClient`: the website's services id, or the iphone app's bundle id); `privateEmail`: an apple private relay
 *  address, which only gets mail from a registered email source (account@madani.bot) */
/** `picture`: the provider's https profile photo (google); apple shares none */
export interface ProviderProfile { subject: string; email: string | null; label: string | null; name: string | null; picture?: string | null; refreshToken?: string; refreshClient?: string; privateEmail?: boolean }
export interface NativeAppleInput { identityToken: string; authorizationCode: string; nonce: string; givenName?: string | null; familyName?: string | null }
export interface Provider {
  id: OAuthProvider;
  authorize(input: { state: string; nonce: string; verifier: string; redirectUri: string }): string;
  profile(input: { code: string; nonce: string; verifier: string; redirectUri: string; user?: string }): Promise<ProviderProfile>;
  /** Apple only: ends the app's grant (Sign in with Apple's REST revoke), as App Store guideline 5.1.1(v) asks on deletion;
   *  `clientId` is the client that got the token (default the services id) */
  revoke?(refreshToken: string, clientId?: string): Promise<void>;
}
const defaults = {
  google: { authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrl: "https://oauth2.googleapis.com/token", jwksUrl: "https://www.googleapis.com/oauth2/v3/certs", issuers: ["https://accounts.google.com", "accounts.google.com"], scopes: "openid email profile" },
  apple: { authorizeUrl: "https://appleid.apple.com/auth/authorize", tokenUrl: "https://appleid.apple.com/auth/token", revokeUrl: "https://appleid.apple.com/auth/revoke", jwksUrl: "https://appleid.apple.com/auth/keys", issuers: ["https://appleid.apple.com"], scopes: "name email" },
};
const text = (value: unknown, max: number) => typeof value === "string" && value.trim() && value.trim().length <= max && !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ? value.trim() : null;
/** an https photo address the app may show: no credentials, no port games, at most 1024 characters */
export function pictureUrl(value: unknown): string | null {
  const address = text(value, 1024);
  if (!address) return null;
  try {
    const url = new URL(address);
    return url.protocol === "https:" && !url.username && !url.password && !url.port ? url.href : null;
  } catch { return null; }
}
function email(value: unknown) {
  const address = text(value, 254)?.toLowerCase();
  return address && /^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/.test(address) ? address : null;
}
export function createProviderRegistry(configs: ProviderConfigs = {}, options: { fetch?: typeof fetch; now?: () => number } = {}) {
  const request = options.fetch ?? fetch, now = options.now ?? Date.now, verifyJwt = createJwtVerifier(options);
  const registry = new Map<OAuthProvider, Provider>();
  for (const id of OAUTH_PROVIDERS) {
    const config = configs[id];
    if (!config) continue;
    const appleSecret = (clientId = config.clientId) => {
      if (!config.apple) throw new Error("Apple signing configuration is missing.");
      const iat = Math.floor(now() / 1000);
      return signEs256Jwt({ alg: "ES256", kid: config.apple.keyId }, { iss: config.apple.teamId, iat, exp: iat + 600, aud: "https://appleid.apple.com", sub: clientId }, config.apple.privateKey);
    };
    registry.set(id, { id,
      ...(id === "apple" ? { async revoke(refreshToken: string, clientId = config.clientId) {
        if (clientId !== config.clientId && !config.nativeClientIds?.includes(clientId)) throw new Error("Unknown Apple client.");
        const body = new URLSearchParams({ client_id: clientId, client_secret: appleSecret(clientId), token: refreshToken, token_type_hint: "refresh_token" });
        const response = await request(config.revokeUrl ?? defaults.apple.revokeUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString(), redirect: "error", signal: AbortSignal.timeout(10_000) });
        await response.body?.cancel();
        if (!response.ok) throw new Error("Apple revoke failed.");
      } } : {}),
      authorize({ state, nonce, verifier, redirectUri }) {
        const url = new URL(config.authorizeUrl);
        const params = { client_id: config.clientId, redirect_uri: redirectUri, response_type: "code", scope: config.scopes, state };
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
        if (id === "apple") url.searchParams.set("response_mode", "form_post");
        else { url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url")); url.searchParams.set("code_challenge_method", "S256"); }
        url.searchParams.set("nonce", nonce);
        // google: always offer the account chooser, so someone can sign in with a different account
        if (id === "google") url.searchParams.set("prompt", "select_account");
        return url.href;
      },
      async profile({ code, nonce, verifier, redirectUri, user }) {
        const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
        const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
        body.set("client_id", config.clientId);
        if (id !== "apple") body.set("code_verifier", verifier);
        if (id === "apple") body.set("client_secret", appleSecret());
        else if (id === "google" && config.clientSecret) body.set("client_secret", config.clientSecret);
        const tokens = await fetchJson(request, config.tokenUrl, { method: "POST", headers, body: body.toString() });
        if (typeof tokens.id_token !== "string" || !config.jwksUrl || !config.issuers) throw new Error("Missing identity token.");
        const claims = await verifyJwt(tokens.id_token, { jwksUrl: config.jwksUrl, issuers: config.issuers, clientId: config.clientId, nonce, algorithms: ["RS256"] });
        if (!text(claims.sub, 256)) throw new Error("Invalid provider subject.");
        let name = id === "google" ? text(claims.name, 80) : null;
        if (id === "apple" && user) {
          const data = JSON.parse(user) as { name?: { firstName?: unknown; lastName?: unknown } };
          name = text([text(data?.name?.firstName, 80), text(data?.name?.lastName, 80)].filter(Boolean).join(" "), 80);
        }
        const verified = claims.email_verified === true || (id === "apple" && claims.email_verified === "true"), address = verified ? email(claims.email) : null;
        // google is authoritative only for gmail and for a workspace domain (hd); other addresses go through an email code
        const trusted = id !== "google" || (address !== null && (/@(gmail|googlemail)\.com$/.test(address) || (typeof claims.hd === "string" && address.endsWith(`@${claims.hd.toLowerCase()}`))));
        const refreshToken = id === "apple" && typeof tokens.refresh_token === "string" && tokens.refresh_token.length <= 2048 ? tokens.refresh_token : undefined;
        const picture = id === "google" ? pictureUrl(claims.picture) : null;
        return { subject: claims.sub as string, email: trusted ? address : null, label: name, name, picture, ...(refreshToken ? { refreshToken, refreshClient: config.clientId } : {}),
          ...(id === "apple" ? { privateEmail: claims.is_private_email === true || claims.is_private_email === "true" } : {}) };
      },
    });
  }
  const apple = configs.apple;
  /** a native app's sign in with apple: its identity token (audience a native bundle id, nonce the sha-256 hex of the raw
   *  nonce the app sent) and the one-time authorization code, redeemed here for the refresh token deletion revokes */
  async function nativeApple(input: NativeAppleInput): Promise<ProviderProfile> {
    if (!apple?.apple || !apple.jwksUrl || !apple.issuers || !apple.nativeClientIds?.length) throw new Error("Native Apple sign-in is not configured.");
    const clientId = apple.nativeClientIds.find(value => value === decodeJws(input.identityToken).claims.aud);
    if (!clientId) throw new Error("Invalid identity token.");
    const claims = await verifyJwt(input.identityToken, { jwksUrl: apple.jwksUrl, issuers: apple.issuers, clientId, nonce: createHash("sha256").update(input.nonce).digest("hex"), algorithms: ["RS256"] });
    if (!text(claims.sub, 256)) throw new Error("Invalid provider subject.");
    const iat = Math.floor(now() / 1000);
    const secret = signEs256Jwt({ alg: "ES256", kid: apple.apple.keyId }, { iss: apple.apple.teamId, iat, exp: iat + 600, aud: "https://appleid.apple.com", sub: clientId }, apple.apple.privateKey);
    const body = new URLSearchParams({ grant_type: "authorization_code", code: input.authorizationCode, client_id: clientId, client_secret: secret });
    const tokens = await fetchJson(request, apple.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
    // the code must belong to the same person as the token (apple answered over tls, so its id_token is read, not re-verified)
    if (typeof tokens.id_token !== "string" || decodeJws(tokens.id_token).claims.sub !== claims.sub) throw new Error("Authorization code does not match.");
    const verified = claims.email_verified === true || claims.email_verified === "true", name = text([text(input.givenName, 80), text(input.familyName, 80)].filter(Boolean).join(" "), 80);
    const refreshToken = typeof tokens.refresh_token === "string" && tokens.refresh_token && tokens.refresh_token.length <= 2048 ? tokens.refresh_token : undefined;
    return { subject: claims.sub as string, email: verified ? email(claims.email) : null, label: name, name, privateEmail: claims.is_private_email === true || claims.is_private_email === "true",
      ...(refreshToken ? { refreshToken, refreshClient: clientId } : {}) };
  }
  return Object.assign(registry, { nativeApple: apple?.nativeClientIds?.length ? nativeApple : null });
}
export function providersFromEnv(env: NodeJS.ProcessEnv): ProviderConfigs {
  const configs: ProviderConfigs = {};
  function required(name: string) {
    const value = env[name];
    if (!value?.trim()) throw new Error(`Missing ${name} for sign-in provider.`);
    return value;
  }
  for (const id of OAUTH_PROVIDERS) {
    const prefix = `MADANI_AUTH_${id.toUpperCase()}_`;
    if (!Object.keys(env).some(key => key.startsWith(prefix) && env[key] !== undefined)) continue;
    const clientId = required(`${prefix}CLIENT_ID`);
    if (id === "google") configs.google = { ...defaults.google, clientId, clientSecret: required(`${prefix}CLIENT_SECRET`) };
    else {
      const teamId = required(`${prefix}TEAM_ID`), keyId = required(`${prefix}KEY_ID`);
      let privateKey: string;
      // a pem with escaped newlines, or the pem base64-encoded on one line (what madani.env holds: no spaces for `. .env`)
      if (env.MADANI_AUTH_APPLE_PRIVATE_KEY) privateKey = env.MADANI_AUTH_APPLE_PRIVATE_KEY.includes("-----BEGIN") ? env.MADANI_AUTH_APPLE_PRIVATE_KEY.replace(/\\n/g, "\n") : Buffer.from(env.MADANI_AUTH_APPLE_PRIVATE_KEY.trim(), "base64").toString("utf8");
      else if (env.MADANI_AUTH_APPLE_PRIVATE_KEY_FILE) {
        try { privateKey = readFileSync(env.MADANI_AUTH_APPLE_PRIVATE_KEY_FILE, "utf8"); } catch { throw new Error("Cannot read MADANI_AUTH_APPLE_PRIVATE_KEY_FILE."); }
      } else throw new Error("Missing MADANI_AUTH_APPLE_PRIVATE_KEY or MADANI_AUTH_APPLE_PRIVATE_KEY_FILE for sign-in provider.");
      try {
        const key = createPrivateKey(privateKey);
        if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error();
      } catch { throw new Error("Invalid MADANI_AUTH_APPLE_PRIVATE_KEY or MADANI_AUTH_APPLE_PRIVATE_KEY_FILE: expected a P-256 private key."); }
      const nativeClientIds = (env.MADANI_AUTH_APPLE_NATIVE_CLIENT_IDS ?? "").split(",").map(value => value.trim()).filter(Boolean);
      if (nativeClientIds.some(value => !/^[A-Za-z0-9.-]{1,155}$/.test(value))) throw new Error("Invalid MADANI_AUTH_APPLE_NATIVE_CLIENT_IDS: expected comma-separated bundle ids.");
      configs.apple = { ...defaults.apple, clientId, apple: { teamId, keyId, privateKey }, ...(nativeClientIds.length ? { nativeClientIds } : {}) };
    }
  }
  return configs;
}
