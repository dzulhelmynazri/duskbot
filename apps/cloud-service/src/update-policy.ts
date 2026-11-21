// The signed update policy (shared/update-guard.ts): the floor no install may run below and the versions pulled after
// release. CI signs it with the release key (scripts/sign-update-policy.ts); this service serves it, unchanged, at
// `GET /v1/updates/policy` for self-hosted installs, and applies it to its own managed homes. The operator blocks a bad
// version by writing a newly signed file at MADANI_UPDATE_POLICY_FILE: it is read again whenever the file changes, and a
// file that does not verify is ignored (the last good one stays).
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { parsePolicy, type UpdatePolicy } from "../../../shared/update-guard.ts";
import { signRelease, verifyRelease, type ReleaseKey } from "./release-signing.ts";

export const UPDATE_POLICY_PATH = "/v1/updates/policy";
/** the policy as it travels: its exact JSON body and a release signature over that body's sha256 */
export interface SignedPolicy { body: string; signature: string }

const sha = (body: string) => createHash("sha256").update(body).digest("hex");

export function signPolicy(policy: UpdatePolicy, signingKey: string, now = Date.now()): SignedPolicy {
  const body = JSON.stringify(parsePolicy(policy));
  return { body, signature: signRelease({ kind: "update-policy", name: "update-policy", version: String(policy.serial), sha256: sha(body), signedAt: now }, signingKey) };
}

/** the policy a signed document carries; throws unless a pinned key signed exactly this body */
export function verifyPolicy(doc: unknown, keys: readonly ReleaseKey[]): UpdatePolicy {
  const given = doc as Partial<SignedPolicy> | null;
  if (!given || typeof given.body !== "string" || typeof given.signature !== "string" || given.body.length > 64_000) throw new Error("Invalid signed update policy.");
  const manifest = verifyRelease(given.signature, { kind: "update-policy", name: "update-policy", sha256: sha(given.body) }, keys);
  const policy = parsePolicy(JSON.parse(given.body));
  if (manifest.version !== String(policy.serial)) throw new Error("The update policy's serial does not match its signature.");
  return policy;
}

/** MADANI_UPDATE_POLICY_FILE, verified, re-read when it changes; null with no file */
export function createPolicySource(file: string | null | undefined, keys: readonly ReleaseKey[], log: (line: string) => void = line => console.warn(line)) {
  let held: { mtime: number; doc: SignedPolicy; policy: UpdatePolicy } | null = null, refused = 0;
  function current() {
    if (!file) return null;
    let mtime: number;
    try { mtime = statSync(file).mtimeMs; } catch { return held; }
    if (held?.mtime === mtime || refused === mtime) return held;
    try {
      const doc = JSON.parse(readFileSync(file, "utf8")) as SignedPolicy;
      const policy = verifyPolicy(doc, keys);
      if (held && policy.serial < held.policy.serial) throw new Error("an older serial");
      held = { mtime, doc: { body: doc.body, signature: doc.signature }, policy };
    } catch (error) {
      refused = mtime;
      log(`updates: ALERT the update policy at MADANI_UPDATE_POLICY_FILE was not taken (${error instanceof Error ? error.message : String(error)}); the last good one stays`);
    }
    return held;
  }
  return {
    policy: (): UpdatePolicy | null => current()?.policy ?? null,
    signed: (): SignedPolicy | null => current()?.doc ?? null,
  };
}
export type PolicySource = ReturnType<typeof createPolicySource>;
