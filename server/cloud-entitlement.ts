// A hosted Cloud home works only while it holds a fresh entitlement signed by the account service for its own machine id
// (shared/entitlement.ts). The account service pushes one through the signed POST /api/cloud/entitlement and refreshes it
// well before it expires. Without a valid one the home answers its signed admin routes and its liveness probe, and
// refuses everything else, pairing included, once its boot env says MADANI_CLOUD_ENTITLEMENT=required. A release build trusts
// only the pinned keys; a run from source (tests, development) also trusts MADANI_ENTITLEMENT_DEV_KEYS.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEntitlementKeys, PINNED_ENTITLEMENT_KEYS, verifyEntitlement, type EntitlementPublicKey, type EntitlementVerdict } from "../shared/entitlement.ts";
import { writeFileAtomic } from "./atomic.ts";

export const CLOUD_ENTITLEMENT_PATH = "/api/cloud/entitlement";
const FILE = "cloud-entitlement";
/** answered without an entitlement: the home's own liveness probe (the edge and `omb-home start` read it) */
const OPEN = [/^\/api\/health$/];

/** the bundled release build runs as .js; tests and development run this file as .ts */
const FROM_SOURCE = import.meta.url.endsWith(".ts");

export interface CloudEntitlementOptions {
  dataDir: string;
  machineId: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  fromSource?: boolean;
}

export function createCloudEntitlement(options: CloudEntitlementOptions) {
  const env = options.env ?? process.env, now = options.now ?? Date.now, file = join(options.dataDir, FILE);
  const fromSource = options.fromSource ?? FROM_SOURCE;
  // every home this account service provisions is told so in its boot env; homes another Admin runs from the same
  // release (Fly, Team) keep working until that Admin pushes entitlements too
  const required = env.MADANI_CLOUD_ENTITLEMENT === "required";
  const keys: EntitlementPublicKey[] = [...PINNED_ENTITLEMENT_KEYS, ...(fromSource ? parseEntitlementKeys(env.MADANI_ENTITLEMENT_DEV_KEYS) : [])];
  let token: string | null = null;
  try { token = readFileSync(file, "utf8").trim() || null; } catch { token = null; }
  const check = (value: string | null): EntitlementVerdict => verifyEntitlement(value, { keys, audience: "home", cloudId: options.machineId, now: now() });

  return {
    required,
    /** the account service's push: kept only when it verifies for this machine and lasts longer than the one held */
    accept(value: unknown): EntitlementVerdict {
      const verdict = check(typeof value === "string" ? value : null);
      if (!verdict.ok) return verdict;
      const held = check(token);
      if (!held.ok || held.claims.exp <= verdict.claims.exp) {
        token = value as string;
        writeFileAtomic(file, token, { mode: 0o600 });
      }
      return verdict;
    },
    valid(): boolean { return check(token).ok; },
    /** null: serve it; otherwise the refusal to send */
    gate(path: string): { status: number; body: { error: string } } | null {
      if (!required || OPEN.some((pattern) => pattern.test(path))) return null;
      return check(token).ok ? null : { status: 403, body: { error: "entitlement_required" } };
    },
    expiresAt(): number | null { const held = check(token); return held.ok ? held.claims.exp : null; },
  };
}
export type CloudEntitlement = ReturnType<typeof createCloudEntitlement>;
