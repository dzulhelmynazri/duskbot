import { afterEach, describe, expect, it } from "vitest";

import { createCardSealer } from "./card-seal.ts";
import { sealCardSecret, sealValues, SealTrustError, trustSealKey } from "../src/lib/card-seal.ts";

const holder = globalThis as { madaniDesktop?: unknown };
afterEach(() => { delete holder.madaniDesktop; });

/** the desktop app's pin for this page's server, as main answers it */
function pinned(identity: string) {
  const asked: string[] = [];
  holder.madaniDesktop = { sealTrust: { check: async (offered: string) => { asked.push(offered); return { ok: offered === identity, pinned: true }; } } };
  return asked;
}

describe("sealing only for a key the server's identity signed", () => {
  it("seals for the pinned server's signed key", async () => {
    const server = createCardSealer();
    const asked = pinned(server.identity());
    const sealed = await sealValues({ password: "fake-pass" }, server.publicKey(), "login.update", ["l1"]);
    expect(await server.openValues(sealed, "login.update", ["l1"], ["password"])).toEqual({ password: "fake-pass" });
    expect(asked).toEqual([server.identity()]);
  });

  it("refuses a key a relay substituted, signed by an identity of its own", async () => {
    const server = createCardSealer();
    const relay = createCardSealer();
    pinned(server.identity());
    await expect(sealValues({ password: "fake-pass" }, relay.publicKey(), "login.update", ["l1"])).rejects.toBeInstanceOf(SealTrustError);
    await expect(sealCardSecret("fake-pass", relay.publicKey(), { botId: "b", threadId: "t", messageId: "m", requestKey: "r", remember: false })).rejects.toBeInstanceOf(SealTrustError);
  });

  it("refuses the relay's key under the real identity's name, and a key nobody signed", async () => {
    const server = createCardSealer();
    const relay = createCardSealer();
    pinned(server.identity());
    const { keyId, x, y } = relay.publicKey();
    const real = server.publicKey();
    await expect(trustSealKey({ ...real, keyId, x, y })).rejects.toBeInstanceOf(SealTrustError);
    await expect(trustSealKey({ version: 1, keyId, x, y })).rejects.toBeInstanceOf(SealTrustError);
    await expect(trustSealKey({ ...real, signature: relay.publicKey().signature })).rejects.toBeInstanceOf(SealTrustError);
  });

  it("checks the signature alone where no desktop app pins one", async () => {
    const server = createCardSealer();
    await expect(trustSealKey(server.publicKey())).resolves.toBeUndefined();
    const relay = createCardSealer();
    await expect(trustSealKey({ ...relay.publicKey(), identity: server.identity() })).rejects.toBeInstanceOf(SealTrustError);
  });
});
