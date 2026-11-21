// Link grants (apps/link-service/src/grant.mjs): a signed-in app asks for one before it opens a setup session, so every
// relay tunnel belongs to a madani account. Signed with MADANI_LINK_GRANT_SIGNING_KEY, else the entitlement key, whose public
// half the link service pins; a loopback service uses its own development key.
import { createHash, sign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACCOUNT_ROUTES } from "../../../shared/account-api.ts";
import { generateEntitlementSigner, parseEntitlementSigner, type EntitlementSigner } from "../../../shared/entitlement.ts";

export const LINK_GRANT_PATH = ACCOUNT_ROUTES.linkGrant;
export const LINK_GRANT_TTL_MS = 5 * 60_000;
export interface LinkGrantAnswer { v: 1; grant: string; expiresAt: number }

/** the opaque account reference a link grant carries: never the account id or an email */
export const linkAccountRef = (accountId: string) => createHash("sha256").update(`madani-link-account:${accountId}`).digest("hex").slice(0, 32);

export function signLinkGrant(accountId: string, signer: EntitlementSigner, now: number): LinkGrantAnswer {
  const exp = now + LINK_GRANT_TTL_MS;
  const head = `l1.${signer.kid}.${Buffer.from(JSON.stringify({ v: 1, aud: "link", acct: linkAccountRef(accountId), iat: now, exp })).toString("base64url")}`;
  return { v: 1, grant: `${head}.${sign(null, Buffer.from(head), signer.privateKey).toString("base64url")}`, expiresAt: exp };
}

export function linkGrantSignerFromEnv(env: NodeJS.ProcessEnv, { dataDir, loopback }: { dataDir: string; loopback: boolean }): EntitlementSigner | null {
  const key = env.MADANI_LINK_GRANT_SIGNING_KEY || env.MADANI_ENTITLEMENT_SIGNING_KEY;
  if (key) return parseEntitlementSigner(key);
  if (!loopback) return null;
  const path = join(dataDir, "link-grant-dev-key");
  if (!existsSync(path)) writeFileSync(path, generateEntitlementSigner("dev-local").env, { mode: 0o600, flag: "wx" });
  return parseEntitlementSigner(readFileSync(path, "utf8").trim());
}
