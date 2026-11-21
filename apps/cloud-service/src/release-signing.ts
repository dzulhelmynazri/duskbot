// Release artifacts (the home package, the desktop kit) are signed in CI with an Ed25519 release key. The service
// checks the signature before it hands a package to a machine, and the machine checks it again before it installs, with
// the same pinned public keys. A signature binds the artifact's sha256, its kind and version, so a valid signature for
// one artifact never vouches for another.
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";

export interface ReleaseKey { kid: string; x: string }
export type ReleaseKind = "home-package" | "desktop" | "vps-package" | "update-policy";
export interface ReleaseManifest { v: 1; kind: ReleaseKind; name: string; version: string; sha256: string; signedAt: number }

/** CI's release keys, newest first; ship the next one here before CI signs with it */
export const PINNED_RELEASE_KEYS: readonly ReleaseKey[] = [
  { kid: "rel-2026-11", x: "wtwZypDwVPBXZ25XsZOVpd0PZPBbVMhugheUj5_NLIM" },
];

const KID = /^[a-z0-9][a-z0-9-]{0,31}$/, B64URL = /^[A-Za-z0-9_-]+$/;
const keyObject = (key: ReleaseKey) => createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.x }, format: "jwk" });

/** `kid:x,kid:x`, added to the pinned keys for a test or staging service */
export function parseReleaseKeys(value: string | undefined): ReleaseKey[] {
  if (!value?.trim()) return [];
  return value.split(",").map(item => {
    const [kid, x] = item.trim().split(":");
    if (!kid || !x || !KID.test(kid) || !B64URL.test(x) || Buffer.from(x, "base64url").length !== 32) throw new Error("Invalid release public key.");
    return { kid, x };
  });
}

/** `r1.<kid>.<manifest>.<signature>`; the private key is `kid:<base64url pkcs8>` (CI's MADANI_RELEASE_SIGNING_KEY) */
export function signRelease(manifest: Omit<ReleaseManifest, "v">, signingKey: string): string {
  const at = signingKey.indexOf(":"), kid = signingKey.slice(0, at);
  if (at < 1 || !KID.test(kid) || !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new Error("Invalid release signing input.");
  const privateKey = createPrivateKey({ key: Buffer.from(signingKey.slice(at + 1).trim(), "base64url"), format: "der", type: "pkcs8" });
  const head = `r1.${kid}.${Buffer.from(JSON.stringify({ v: 1, ...manifest })).toString("base64url")}`;
  return `${head}.${sign(null, Buffer.from(head), privateKey).toString("base64url")}`;
}

export function verifyRelease(signature: string, expect: { kind: ReleaseKind; sha256?: string; name?: string }, keys: readonly ReleaseKey[] = PINNED_RELEASE_KEYS): ReleaseManifest {
  const parts = signature.trim().split(".");
  if (parts.length !== 4 || parts[0] !== "r1" || !B64URL.test(parts[2]!) || !B64URL.test(parts[3]!)) throw new Error("Release signature is malformed.");
  const key = keys.find(k => k.kid === parts[1]);
  if (!key) throw new Error("Release signature is from an unknown key.");
  if (!verify(null, Buffer.from(parts.slice(0, 3).join(".")), keyObject(key), Buffer.from(parts[3]!, "base64url"))) throw new Error("Release signature does not verify.");
  const manifest = JSON.parse(Buffer.from(parts[2]!, "base64url").toString("utf8")) as ReleaseManifest;
  if (manifest.v !== 1 || manifest.kind !== expect.kind || (expect.sha256 !== undefined && manifest.sha256 !== expect.sha256) || (expect.name !== undefined && manifest.name !== expect.name)) {
    throw new Error("Release signature is for another artifact.");
  }
  return manifest;
}

export function readReleaseSignature(path: string): string { return readFileSync(path, "utf8").trim(); }

/**
 * The machine's own check, run by root's `omb-home install` with the pinned node before anything is unpacked:
 * `node -e <this> <signature file> <sha256> <kind> [print]`, `print` writing the signed version. The keys are fixed into the
 * script the service generates.
 */
export function machineVerifyScript(keys: readonly ReleaseKey[]): string {
  return `const c=require("node:crypto"),fs=require("node:fs");const keys=${JSON.stringify(keys)};
const [file,sum,kind]=process.argv.slice(1);const p=fs.readFileSync(file,"utf8").trim().split(".");
if(p.length!==4||p[0]!=="r1")process.exit(3);const k=keys.find(x=>x.kid===p[1]);if(!k)process.exit(3);
const pub=c.createPublicKey({key:{kty:"OKP",crv:"Ed25519",x:k.x},format:"jwk"});
if(!c.verify(null,Buffer.from(p.slice(0,3).join(".")),pub,Buffer.from(p[3],"base64url")))process.exit(3);
const m=JSON.parse(Buffer.from(p[2],"base64url").toString());if(m.v!==1||m.kind!==kind||m.sha256!==sum)process.exit(3);
if(process.argv[4]==="print"&&/^\\d+\\.\\d+\\.\\d+$/.test(m.version))process.stdout.write(m.version);`;
}
