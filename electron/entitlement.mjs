// The app's offline check of the account service's signed entitlements (shared/entitlement.ts is the reference; a parity
// test keeps the two in step). A managed cloud desktop is offered only with a token that verifies for its cloud.
import { createPublicKey, verify } from "node:crypto";

export const ENTITLEMENT_SKEW_MS = 5 * 60_000;
export const ENTITLEMENT_MAX_TTL_MS = 7 * 24 * 3_600_000;
/** kept equal to PINNED_ENTITLEMENT_KEYS in shared/entitlement.ts */
export const PINNED_ENTITLEMENT_KEYS = Object.freeze([
  Object.freeze({ kid: "ent-2026-11", x: "h4GwuuVu6HGLupu68zCsKbN2CWf7lt0cCNxBjWIZ-HI" }),
]);
const KID = /^[a-z0-9][a-z0-9-]{0,31}$/, B64URL = /^[A-Za-z0-9_-]+$/;

/** Extra keys for a development build only: `kid:x,kid:x`. A packaged app trusts the pinned keys alone. */
export function entitlementKeys(env = process.env, packaged = true) {
  const extra = packaged ? [] : String(env.MADANI_ENTITLEMENT_DEV_KEYS ?? "").split(",").map((item) => item.trim().split(":"))
    .filter(([kid, x]) => kid && x && KID.test(kid) && B64URL.test(x)).map(([kid, x]) => ({ kid, x }));
  return [...PINNED_ENTITLEMENT_KEYS, ...extra];
}

/** @returns {{ ok: true, claims: any } | { ok: false, error: string }} */
export function verifyEntitlement(token, { keys = PINNED_ENTITLEMENT_KEYS, audience = "app", cloudId, now = Date.now() } = {}) {
  if (typeof token !== "string" || token.length > 4096) return { ok: false, error: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "e1" || !KID.test(parts[1]) || !B64URL.test(parts[2]) || !B64URL.test(parts[3])) return { ok: false, error: "malformed" };
  const key = keys.find((one) => one.kid === parts[1]);
  if (!key) return { ok: false, error: "unknown_key" };
  let good = false;
  try {
    good = verify(null, Buffer.from(parts.slice(0, 3).join(".")), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.x }, format: "jwk" }), Buffer.from(parts[3], "base64url"));
  } catch { good = false; }
  if (!good) return { ok: false, error: "bad_signature" };
  let claims;
  try { claims = JSON.parse(Buffer.from(parts[2], "base64url").toString("utf8")); } catch { return { ok: false, error: "malformed" }; }
  if (!claims || claims.v !== 1 || !Array.isArray(claims.aud) || typeof claims.cloud !== "string" || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)) return { ok: false, error: "malformed" };
  if (claims.exp - claims.iat > ENTITLEMENT_MAX_TTL_MS) return { ok: false, error: "too_long" };
  if (claims.iat - ENTITLEMENT_SKEW_MS > now) return { ok: false, error: "not_yet_valid" };
  if (claims.exp + ENTITLEMENT_SKEW_MS <= now) return { ok: false, error: "expired" };
  if (!claims.aud.includes(audience)) return { ok: false, error: "wrong_audience" };
  if (cloudId !== undefined && claims.cloud !== cloudId) return { ok: false, error: "wrong_cloud" };
  return { ok: true, claims };
}
