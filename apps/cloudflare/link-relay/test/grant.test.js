import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";

import { verifyLinkGrant as nodeVerify } from "../../../link-service/src/grant.mjs";
import { PINNED_GRANT_KEYS as NODE_PINNED } from "../../../link-service/src/grant.mjs";
import { PINNED_GRANT_KEYS, parseGrantKeys, verifyLinkGrant } from "../src/grant.js";
import { forwardCode, sameHex, sha256hex } from "../src/protocol.js";

const pair = generateKeyPairSync("ed25519");
const x = pair.publicKey.export({ format: "jwk" }).x;
const keys = [{ kid: "test-1", x }];
function grant(claims, kid = "test-1", key = pair.privateKey) {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signed = `l1.${kid}.${payload}`;
  return `${signed}.${sign(null, Buffer.from(signed), key).toString("base64url")}`;
}
const now = Date.UTC(2026, 10, 13);
const good = { v: 1, aud: "link", acct: "0123456789abcdef0123456789abcdef", iat: now, exp: now + 10 * 60_000 };

describe("verifyLinkGrant (webcrypto)", () => {
  it("pins the same key as the link service", () => expect(PINNED_GRANT_KEYS).toEqual(NODE_PINNED));

  it("accepts what the link service accepts and names the account", async () => {
    const token = grant(good);
    expect(await verifyLinkGrant(token, { keys, now })).toEqual({ ok: true, acct: good.acct });
    expect(nodeVerify(token, { keys, now })).toEqual({ ok: true, acct: good.acct });
  });

  it("refuses a forged, foreign, expired, long or wrong-audience grant", async () => {
    const other = generateKeyPairSync("ed25519").privateKey;
    expect((await verifyLinkGrant(grant(good, "test-1", other), { keys, now })).error).toBe("bad_signature");
    expect((await verifyLinkGrant(grant(good, "nope"), { keys, now })).error).toBe("unknown_key");
    expect((await verifyLinkGrant(grant(good), { keys, now: good.exp + 3 * 60_000 })).error).toBe("expired");
    expect((await verifyLinkGrant(grant({ ...good, exp: now + 60 * 60_000 }), { keys, now })).error).toBe("too_long");
    expect((await verifyLinkGrant(grant({ ...good, aud: "relay" }), { keys, now })).error).toBe("malformed");
    expect((await verifyLinkGrant("l1.x.y", { keys, now })).error).toBe("malformed");
    expect((await verifyLinkGrant(grant(good), { now })).error).toBe("unknown_key");
  });

  it("reads GRANT_KEYS like MADANI_LINK_GRANT_KEYS", () => {
    expect(parseGrantKeys(`test-1:${x}`)).toEqual(keys);
    expect(parseGrantKeys("")).toBeNull();
    expect(() => parseGrantKeys("bad")).toThrow();
  });
});

describe("protocol helpers", () => {
  it("hashes and compares verifiers", async () => {
    const hex = await sha256hex("abc");
    expect(hex).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sameHex(hex, hex)).toBe(true);
    expect(sameHex(hex, hex.replace("b", "c"))).toBe(false);
    expect(sameHex(hex, "ab")).toBe(false);
  });
  it("forwards only close codes a server may send", () => {
    expect(forwardCode(1006)).toBe(1000);
    expect(forwardCode(1005)).toBe(1000);
    expect(forwardCode(1011)).toBe(1011);
    expect(forwardCode(4003)).toBe(4003);
  });
});
