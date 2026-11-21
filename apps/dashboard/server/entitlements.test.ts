import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { generateEntitlementSigner, parseEntitlementSigner, entitlementPublicKey, verifyEntitlement } from "../../../shared/entitlement.ts";
import type { StoredCloud } from "./clouds/types.ts";
import { entitlementSignerFromEnv } from "./entitlements.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const dir = () => { const d = mkdtempSync(join(tmpdir(), "madani-ent-")); dirs.push(d); return d; };
const cloud = { id: `c${"5".repeat(24)}`, accountId: "acct_secret@example.test", kind: "shared_s", backend: "managed" } as StoredCloud;
const NOW = 1_800_000_000_000;

it("a service that runs hosted homes refuses to start without its signing key", () => {
  expect(() => entitlementSignerFromEnv({}, { dataDir: dir(), loopback: false, now: () => NOW, required: true })).toThrow("MADANI_ENTITLEMENT_SIGNING_KEY");
  expect(entitlementSignerFromEnv({}, { dataDir: dir(), loopback: false, now: () => NOW, required: false })).toBeNull();
});

it("signs a day-long token for the cloud, its homes and the app, naming no email", () => {
  const key = generateEntitlementSigner("svc-1");
  const signer = entitlementSignerFromEnv({ MADANI_ENTITLEMENT_SIGNING_KEY: key.env }, { dataDir: dir(), loopback: false, now: () => NOW, required: true })!;
  const token = signer.sign(cloud);
  const verdict = verifyEntitlement(token, { keys: [key.publicKey], audience: "home", cloudId: cloud.id, now: NOW });
  expect(verdict).toMatchObject({ ok: true, claims: { aud: ["home", "app"], tier: "shared_s", features: ["cloud", "managed"], exp: NOW + 86_400_000 } });
  expect(Buffer.from(token.split(".")[2]!, "base64url").toString()).not.toContain("example.test");
});

it("a loopback service signs with a development key of its own, kept 0600 beside its data", () => {
  const d = dir();
  const signer = entitlementSignerFromEnv({}, { dataDir: d, loopback: true, now: () => NOW, required: false })!;
  expect(signer.kid).toBe("dev-local");
  expect(statSync(join(d, "entitlement-dev-key")).mode & 0o777).toBe(0o600);
  const again = entitlementSignerFromEnv({}, { dataDir: d, loopback: true, now: () => NOW, required: false })!;
  expect(again.sign(cloud).split(".")[1]).toBe("dev-local");
  expect(entitlementPublicKey(parseEntitlementSigner(generateEntitlementSigner("x").env)).kid).toBe("x");
});
