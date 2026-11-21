import { describe, expect, it } from "vitest";
import { generateEntitlementSigner, PINNED_ENTITLEMENT_KEYS as SHARED_KEYS, signEntitlement, verifyEntitlement as sharedVerify } from "../shared/entitlement.ts";
import { entitlementKeys, PINNED_ENTITLEMENT_KEYS, verifyEntitlement } from "./entitlement.mjs";

const CLOUD = `c${"1".repeat(24)}`, NOW = 1_800_000_000_000;

describe("the app's entitlement check", () => {
  it("pins the same keys as the account service's reference", () => {
    expect(PINNED_ENTITLEMENT_KEYS.map((k) => ({ ...k }))).toEqual(SHARED_KEYS.map((k) => ({ ...k })));
  });

  it("agrees with the reference verifier on good and bad tokens", () => {
    const { signer, publicKey } = generateEntitlementSigner("dev-1"), other = generateEntitlementSigner("dev-2");
    const base = { aud: ["app"], cloud: CLOUD, acct: "a", tier: "pro", features: [], iat: NOW, exp: NOW + 3_600_000 };
    const cases = [
      [signEntitlement(base, signer), { keys: [publicKey], audience: "app", cloudId: CLOUD, now: NOW }],
      [signEntitlement(base, signer), { keys: [other.publicKey], audience: "app", now: NOW }],
      [signEntitlement(base, signer), { keys: [publicKey], audience: "home", now: NOW }],
      [signEntitlement(base, signer), { keys: [publicKey], audience: "app", cloudId: `c${"2".repeat(24)}`, now: NOW }],
      [signEntitlement(base, signer), { keys: [publicKey], audience: "app", now: NOW + 3 * 3_600_000 }],
      ["e1.dev-1.e30.AA", { keys: [publicKey], audience: "app", now: NOW }],
    ];
    for (const [token, options] of cases) {
      const ours = verifyEntitlement(token, options), reference = sharedVerify(token, options);
      expect(ours.ok ? "ok" : ours.error).toBe(reference.ok ? "ok" : reference.error);
    }
  });

  it("trusts development keys only outside a packaged app", () => {
    const env = { MADANI_ENTITLEMENT_DEV_KEYS: "dev-9:h4GwuuVu6HGLupu68zCsKbN2CWf7lt0cCNxBjWIZ-HI" };
    expect(entitlementKeys(env, true)).toHaveLength(PINNED_ENTITLEMENT_KEYS.length);
    expect(entitlementKeys(env, false).map((k) => k.kid)).toContain("dev-9");
  });
});
