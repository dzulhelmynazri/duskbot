// The account service's signer for entitlements (shared/entitlement.ts): a hosted home and the app accept a cloud only with
// a fresh one. The private key is MADANI_ENTITLEMENT_SIGNING_KEY (`kid:<base64url pkcs8>`), only in this service's
// environment; its public key must be pinned in shared/entitlement.ts and electron/entitlement.mjs before it signs.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENTITLEMENT_DEFAULT_TTL_MS, generateEntitlementSigner, parseEntitlementSigner, signEntitlement, type EntitlementSigner } from "../../../shared/entitlement.ts";
import type { StoredCloud } from "./clouds/types.ts";

export interface EntitlementSignerOptions { dataDir: string; loopback: boolean; now(): number; required: boolean; ttlMs?: number }

export function entitlementSignerFromEnv(env: NodeJS.ProcessEnv, options: EntitlementSignerOptions): { sign(cloud: StoredCloud): string; kid: string } | null {
  let signer: EntitlementSigner | null = null;
  if (env.MADANI_ENTITLEMENT_SIGNING_KEY) signer = parseEntitlementSigner(env.MADANI_ENTITLEMENT_SIGNING_KEY);
  else if (options.required) throw new Error("MADANI_ENTITLEMENT_SIGNING_KEY is required: hosted homes refuse clients without a signed entitlement.");
  else if (options.loopback) {
    // a loopback service signs with its own development key; a home or app trusts it only when told (MADANI_ENTITLEMENT_DEV_KEYS)
    const path = join(options.dataDir, "entitlement-dev-key");
    if (!existsSync(path)) writeFileSync(path, generateEntitlementSigner("dev-local").env, { mode: 0o600, flag: "wx" });
    signer = parseEntitlementSigner(readFileSync(path, "utf8").trim());
  }
  if (!signer) return null;
  const key = signer, ttl = options.ttlMs ?? ENTITLEMENT_DEFAULT_TTL_MS;
  return {
    kid: key.kid,
    sign(cloud) {
      const iat = options.now();
      return signEntitlement({ aud: ["home", "app"], cloud: cloud.id, acct: createHash("sha256").update(`omb-account:${cloud.accountId}`).digest("hex").slice(0, 16),
        tier: cloud.kind, features: cloud.backend ? ["cloud", "managed"] : ["cloud"], iat, exp: iat + ttl }, key);
    },
  };
}
