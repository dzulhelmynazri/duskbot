import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from "@hpke/core";
import {
  CARD_SECRET_INFO, cardSecretAAD, SEALED_VALUE_INFO, sealedValueAAD, sealKeySigningInput,
  type CardSealKey, type SealedCardSecret, type SealPurpose,
} from "../../shared/saved-secrets.ts";

// Security: a secret leaves this app only sealed for the server that keeps it, so the relay between them (the VPS
// link tunnel, a Cloud's proxy) never carries it in the clear. A key is sealed for only once the server's identity
// signed it and, in the desktop app, that identity is the one pinned for the server the page belongs to: a relay that
// hands over a key of its own gets nothing.

/** The server's key was not signed by the identity this app trusts for it; nothing was sealed. */
export class SealTrustError extends Error {
  constructor(message = "this server could not prove it is the one this app linked, so nothing was sent.") {
    super(message);
    this.name = "SealTrustError";
  }
}

const b64url = (bytes: ArrayBuffer | Uint8Array) => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text = "";
  for (const byte of view) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
};

const fromB64url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));

const trusted = new Set<string>();

type SealTrustBridge = { check(identity: string): Promise<{ ok: boolean; pinned: boolean }> };

/** The desktop app's pin for the server this page belongs to; absent outside it. */
function pinCheck(): SealTrustBridge["check"] | null {
  const bridge = (globalThis as { madaniDesktop?: { sealTrust?: SealTrustBridge } }).madaniDesktop?.sealTrust;
  return bridge ? (identity) => bridge.check(identity) : null;
}

/** Throws SealTrustError unless the server's identity signed this key and, where the desktop app pins one, it is the pinned identity. */
export async function trustSealKey(key: CardSealKey): Promise<void> {
  const { identity, signature } = key;
  if (typeof identity !== "string" || typeof signature !== "string") throw new SealTrustError();
  const memo = [key.keyId, key.x, key.y, identity, signature].join(".");
  if (trusted.has(memo)) return;
  const [x, y, extra] = identity.split(".");
  let signed = false;
  try {
    if (!x || !y || extra !== undefined) throw new SealTrustError();
    const publicKey = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x, y, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    signed = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, fromB64url(signature), sealKeySigningInput(key, identity));
  } catch {
    signed = false;
  }
  if (!signed) throw new SealTrustError();
  const check = pinCheck();
  if (check && !(await check(identity).catch(() => ({ ok: false, pinned: true }))).ok) throw new SealTrustError();
  trusted.add(memo);
}

async function hpkeSeal(plain: Uint8Array, key: CardSealKey, info: string, aad: Uint8Array): Promise<SealedCardSecret> {
  try {
    await trustSealKey(key);
    const suite = new CipherSuite({ kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
    const recipientPublicKey = await suite.kem.importKey("jwk", { kty: "EC", crv: "P-256", x: key.x, y: key.y, ext: true, key_ops: [] }, true);
    const sealed = await suite.seal({ recipientPublicKey, info: new TextEncoder().encode(info) }, plain, aad);
    return { keyId: key.keyId, encapsulatedKey: b64url(sealed.enc), ciphertext: b64url(sealed.ct) };
  } finally {
    plain.fill(0);
  }
}

export async function sealCardSecret(
  value: string,
  key: CardSealKey,
  context: { botId: string; threadId: string; messageId: string; requestKey: string; remember: boolean },
): Promise<SealedCardSecret> {
  return hpkeSeal(new TextEncoder().encode(value), key, CARD_SECRET_INFO, cardSecretAAD({ keyId: key.keyId, ...context }));
}

/** Named values sealed together for one purpose and target (shared/saved-secrets.ts sealedValueAAD). */
export async function sealValues(values: Record<string, string>, key: CardSealKey, purpose: SealPurpose, target: readonly string[]): Promise<SealedCardSecret> {
  return hpkeSeal(new TextEncoder().encode(JSON.stringify({ values })), key, SEALED_VALUE_INFO, sealedValueAAD(key.keyId, purpose, target));
}
