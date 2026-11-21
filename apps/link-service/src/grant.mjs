// link grants: the account service signs a short-lived token (Ed25519) naming an opaque account reference; the link service
// opens a setup session only with a fresh one, so every tunnel belongs to a madani account. format: `l1.<kid>.<payload>.<sig>`,
// base64url, the signature over `l1.<kid>.<payload>`; payload `{ v: 1, aud: "link", acct, iat, exp }`.
import { createPublicKey, verify } from "node:crypto";

export const GRANT_PREFIX = "l1";
export const GRANT_MAX_TTL_MS = 15 * 60_000;
export const GRANT_SKEW_MS = 2 * 60_000;
/** the account service's entitlement keys (shared/entitlement.ts PINNED_ENTITLEMENT_KEYS): it signs link grants with the same key */
export const PINNED_GRANT_KEYS = Object.freeze([{ kid: "ent-2026-11", x: "h4GwuuVu6HGLupu68zCsKbN2CWf7lt0cCNxBjWIZ-HI" }]);

const KID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const ACCT = /^[0-9a-f]{32}$/;

/** `kid:x,kid:x` (MADANI_LINK_GRANT_KEYS): the public keys to trust instead of the pinned ones */
export function parseGrantKeys(value) {
  if (!value?.trim()) return null;
  return value.split(",").map((item) => {
    const [kid, x] = item.trim().split(":");
    if (!kid || !x || !KID.test(kid) || !B64URL.test(x) || Buffer.from(x, "base64url").length !== 32) throw new Error("MADANI_LINK_GRANT_KEYS must be kid:x pairs of Ed25519 public keys.");
    return { kid, x };
  });
}

/** @returns {{ ok: true, acct: string } | { ok: false, error: string }} */
export function verifyLinkGrant(token, { keys, now = Date.now() }) {
  if (typeof token !== "string" || token.length > 1024) return { ok: false, error: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== GRANT_PREFIX || !KID.test(parts[1]) || !B64URL.test(parts[2]) || !B64URL.test(parts[3])) return { ok: false, error: "malformed" };
  const key = keys.find((one) => one.kid === parts[1]);
  if (!key) return { ok: false, error: "unknown_key" };
  let good = false;
  try {
    good = verify(null, Buffer.from(`${parts[0]}.${parts[1]}.${parts[2]}`), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.x }, format: "jwk" }), Buffer.from(parts[3], "base64url"));
  } catch { good = false; }
  if (!good) return { ok: false, error: "bad_signature" };
  let claims;
  try { claims = JSON.parse(Buffer.from(parts[2], "base64url").toString("utf8")); } catch { return { ok: false, error: "malformed" }; }
  if (!claims || claims.v !== 1 || claims.aud !== "link" || typeof claims.acct !== "string" || !ACCT.test(claims.acct) || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)) {
    return { ok: false, error: "malformed" };
  }
  if (claims.exp - claims.iat > GRANT_MAX_TTL_MS) return { ok: false, error: "too_long" };
  if (claims.iat - GRANT_SKEW_MS > now) return { ok: false, error: "not_yet_valid" };
  if (claims.exp + GRANT_SKEW_MS <= now) return { ok: false, error: "expired" };
  return { ok: true, acct: claims.acct };
}
