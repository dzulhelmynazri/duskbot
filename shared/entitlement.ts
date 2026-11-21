// Signed entitlements: the account service signs a short-lived token (Ed25519) naming one cloud, its plan and features;
// a hosted home and the app verify it offline against pinned public keys. Format: `e1.<kid>.<payload>.<signature>`,
// base64url, the signature over `e1.<kid>.<payload>`. A key id lets a new key ship in the pinned list before it signs.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";

export const ENTITLEMENT_PREFIX = "e1";
/** clocks on a VM, a laptop and the account service may disagree by this much */
export const ENTITLEMENT_SKEW_MS = 5 * 60_000;
/** a token claiming a longer life than this is refused, whoever signed it */
export const ENTITLEMENT_MAX_TTL_MS = 7 * 24 * 3_600_000;
export const ENTITLEMENT_DEFAULT_TTL_MS = 24 * 3_600_000;
export type EntitlementAudience = "home" | "app";

export interface EntitlementClaims {
  v: 1;
  aud: EntitlementAudience[];
  /** the cloud this token is for */
  cloud: string;
  /** an opaque account reference, never an email */
  acct: string;
  tier: string;
  features: string[];
  iat: number;
  exp: number;
}
export interface EntitlementPublicKey { kid: string; x: string }
export interface EntitlementSigner { kid: string; privateKey: KeyObject }

/** Production keys, newest first. Add the next key here one release before the account service signs with it. */
export const PINNED_ENTITLEMENT_KEYS: readonly EntitlementPublicKey[] = [
  { kid: "ent-2026-11", x: "h4GwuuVu6HGLupu68zCsKbN2CWf7lt0cCNxBjWIZ-HI" },
];

const KID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const CLOUD_ID = /^c[0-9a-f]{24}$/;

const b64 = (data: Buffer | string) => Buffer.from(data).toString("base64url");

export function publicKeyObject(key: EntitlementPublicKey): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.x }, format: "jwk" });
}

/** `kid:<base64url pkcs8 der>`, as the account service's MADANI_ENTITLEMENT_SIGNING_KEY holds it */
export function parseEntitlementSigner(value: string): EntitlementSigner {
  const at = value.indexOf(":");
  const kid = value.slice(0, at), der = value.slice(at + 1).trim();
  if (at < 1 || !KID.test(kid) || !B64URL.test(der)) throw new Error("Invalid entitlement signing key.");
  const privateKey = createPrivateKey({ key: Buffer.from(der, "base64url"), format: "der", type: "pkcs8" });
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Invalid entitlement signing key.");
  return { kid, privateKey };
}

/** `kid:x,kid:x`: extra public keys for a test or staging deployment */
export function parseEntitlementKeys(value: string | undefined): EntitlementPublicKey[] {
  if (!value?.trim()) return [];
  return value.split(",").map((item) => {
    const [kid, x] = item.trim().split(":");
    if (!kid || !x || !KID.test(kid) || !B64URL.test(x) || Buffer.from(x, "base64url").length !== 32) throw new Error("Invalid entitlement public key.");
    return { kid, x };
  });
}

export function entitlementPublicKey(signer: EntitlementSigner): EntitlementPublicKey {
  const jwk = createPublicKey(signer.privateKey).export({ format: "jwk" });
  return { kid: signer.kid, x: String(jwk.x) };
}

export function generateEntitlementSigner(kid: string): { signer: EntitlementSigner; env: string; publicKey: EntitlementPublicKey } {
  if (!KID.test(kid)) throw new Error("Invalid key id.");
  const { privateKey } = generateKeyPairSync("ed25519");
  const signer = { kid, privateKey };
  return { signer, env: `${kid}:${b64(privateKey.export({ format: "der", type: "pkcs8" }))}`, publicKey: entitlementPublicKey(signer) };
}

export function signEntitlement(claims: Omit<EntitlementClaims, "v">, signer: EntitlementSigner): string {
  if (!KID.test(signer.kid) || !CLOUD_ID.test(claims.cloud) || claims.exp <= claims.iat || claims.exp - claims.iat > ENTITLEMENT_MAX_TTL_MS) throw new Error("Invalid entitlement.");
  const head = `${ENTITLEMENT_PREFIX}.${signer.kid}.${b64(JSON.stringify({ v: 1, ...claims }))}`;
  return `${head}.${b64(sign(null, Buffer.from(head), signer.privateKey))}`;
}

export type EntitlementVerdict =
  | { ok: true; claims: EntitlementClaims; kid: string }
  | { ok: false; error: "malformed" | "unknown_key" | "bad_signature" | "expired" | "not_yet_valid" | "wrong_audience" | "wrong_cloud" | "too_long" };

export function verifyEntitlement(token: unknown, options: { keys: readonly EntitlementPublicKey[]; audience: EntitlementAudience; cloudId?: string; now?: number }): EntitlementVerdict {
  if (typeof token !== "string" || token.length > 4096) return { ok: false, error: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== ENTITLEMENT_PREFIX || !KID.test(parts[1]!) || !B64URL.test(parts[2]!) || !B64URL.test(parts[3]!)) return { ok: false, error: "malformed" };
  const key = options.keys.find((one) => one.kid === parts[1]);
  if (!key) return { ok: false, error: "unknown_key" };
  let good = false;
  try { good = verify(null, Buffer.from(`${parts[0]}.${parts[1]}.${parts[2]}`), publicKeyObject(key), Buffer.from(parts[3]!, "base64url")); } catch { good = false; }
  if (!good) return { ok: false, error: "bad_signature" };
  let claims: EntitlementClaims;
  try { claims = JSON.parse(Buffer.from(parts[2]!, "base64url").toString("utf8")) as EntitlementClaims; } catch { return { ok: false, error: "malformed" }; }
  if (!claims || claims.v !== 1 || !Array.isArray(claims.aud) || typeof claims.cloud !== "string" || typeof claims.tier !== "string" || !Array.isArray(claims.features)
    || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)) return { ok: false, error: "malformed" };
  const now = options.now ?? Date.now();
  if (claims.exp - claims.iat > ENTITLEMENT_MAX_TTL_MS) return { ok: false, error: "too_long" };
  if (claims.iat - ENTITLEMENT_SKEW_MS > now) return { ok: false, error: "not_yet_valid" };
  if (claims.exp + ENTITLEMENT_SKEW_MS <= now) return { ok: false, error: "expired" };
  if (!claims.aud.includes(options.audience)) return { ok: false, error: "wrong_audience" };
  if (options.cloudId !== undefined && claims.cloud !== options.cloudId) return { ok: false, error: "wrong_cloud" };
  return { ok: true, claims, kid: key.kid };
}
