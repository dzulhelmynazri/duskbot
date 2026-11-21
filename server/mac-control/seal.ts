// Sealing for "cloud bots use this Mac" (docs/cloud-uses-mac.md): the hosting provider's proxy ends TLS before this
// machine, so jobs are sealed to the Mac's key and signed with this cloud's link key, whose public half the Mac gets
// from madani.bot.
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CLOUD_MAC_SEAL_INFO, cloudMacJobAad, cloudMacOutcomeAad, cloudMacSignedBytes, type SealedMacJob, type SealedMacOutcome } from "../../shared/cloud-mac.ts";

const KEY = /^[A-Za-z0-9_-]{43}$/;

export const isMacSealKey = (value: unknown): value is string => typeof value === "string" && KEY.test(value);

/** This cloud's link private key, read when needed: null when it has none (not enrolled with the Admin). */
export function readLinkSigningKey(dataDir: string): KeyObject | null {
  try {
    const saved = JSON.parse(readFileSync(join(dataDir, "dashboard-link.json"), "utf8")) as { privateKey?: unknown };
    if (typeof saved.privateKey !== "string") return null;
    const key = createPrivateKey({ key: Buffer.from(saved.privateKey, "base64"), format: "der", type: "pkcs8" });
    return key.asymmetricKeyType === "ed25519" ? key : null;
  } catch {
    return null;
  }
}

const x25519 = (x: string) => createPublicKey({ key: { kty: "OKP", crv: "X25519", x }, format: "jwk" });

export function sealMacJob(job: unknown, macKey: string, linkKey: KeyObject): { envelope: SealedMacJob; key: Buffer } {
  if (!isMacSealKey(macKey)) throw new Error("invalid Mac key");
  const one = generateKeyPairSync("x25519");
  const eph = (one.publicKey.export({ format: "jwk" }) as { x: string }).x;
  const key = Buffer.from(hkdfSync("sha256", diffieHellman({ privateKey: one.privateKey, publicKey: x25519(macKey) }), Buffer.alloc(0), CLOUD_MAC_SEAL_INFO, 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(cloudMacJobAad(macKey, eph)));
  const data = Buffer.concat([cipher.update(JSON.stringify(job), "utf8"), cipher.final(), cipher.getAuthTag()]).toString("base64url");
  const parts = { mac: macKey, eph, iv: iv.toString("base64url"), data };
  const sig = sign(null, Buffer.from(cloudMacSignedBytes(parts)), linkKey).toString("base64url");
  return { envelope: { v: 1, ...parts, sig }, key };
}

/** The outcome the Mac sealed with the job key; throws on anything that does not open. */
export function openMacOutcome(envelope: unknown, key: Buffer, jobId: string): unknown {
  const sealed = envelope as Partial<SealedMacOutcome> | null;
  if (!sealed || sealed.v !== 1 || typeof sealed.iv !== "string" || typeof sealed.data !== "string") throw new Error("not a sealed outcome");
  const bytes = Buffer.from(sealed.data, "base64url");
  if (bytes.length < 17) throw new Error("not a sealed outcome");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64url"));
  decipher.setAAD(Buffer.from(cloudMacOutcomeAad(jobId)));
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(0, bytes.length - 16)), decipher.final()]).toString("utf8"));
}
