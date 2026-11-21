// A new Ed25519 key for entitlements (account service) or releases (CI). The private key goes to a 0600 file and is
// never printed; the public key is printed for the pinned list (shared/entitlement.ts or src/release-signing.ts).
//
//   node apps/cloud-service/scripts/keygen.mjs ent-2027-05 ~/.config/madanibot/keys
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [kid, dir] = process.argv.slice(2);
if (!kid || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(kid) || !dir) { console.error("usage: keygen.mjs <kid> <dir>"); process.exit(2); }
mkdirSync(dir, { recursive: true, mode: 0o700 });
const file = join(dir, `${kid}.key`);
if (existsSync(file)) { console.error(`${file} exists; pick a new kid`); process.exit(1); }
const { privateKey } = generateKeyPairSync("ed25519");
writeFileSync(file, `${kid}:${privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url")}\n`, { mode: 0o600, flag: "wx" });
console.log(`private key: ${file}\npublic key:  { kid: "${kid}", x: "${createPublicKey(privateKey).export({ format: "jwk" }).x}" }`);
