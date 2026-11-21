// CI signs a release artifact with MADANI_RELEASE_SIGNING_KEY (from the release environment only), writing <file>.sig.
//
//   node apps/cloud-service/scripts/sign-release.ts release/home/omb-home.tgz --kind home-package --name omb-home --version 0.1.150
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseReleaseKeys, PINNED_RELEASE_KEYS, signRelease, verifyRelease, type ReleaseKind } from "../src/release-signing.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { kind: { type: "string" }, name: { type: "string" }, version: { type: "string" }, sha256: { type: "string" } } });
const key = process.env.MADANI_RELEASE_SIGNING_KEY;
const kind = values.kind as ReleaseKind | undefined;
if (!key || !kind || !["home-package", "desktop", "vps-package"].includes(kind) || !values.name || !values.version || (!positionals[0] && !values.sha256)) {
  console.error("usage: MADANI_RELEASE_SIGNING_KEY=... sign-release.ts <file> | --sha256 <hex> --kind home-package|desktop|vps-package --name <name> --version <v>");
  process.exit(2);
}
const sha256 = values.sha256 ?? createHash("sha256").update(readFileSync(positionals[0]!)).digest("hex");
const signature = signRelease({ kind, name: values.name, version: values.version, sha256, signedAt: Date.now() }, key);
// a key the machines do not pin would sign something nothing installs: refuse it here
verifyRelease(signature, { kind, sha256 }, [...PINNED_RELEASE_KEYS, ...parseReleaseKeys(process.env.MADANI_RELEASE_PUBLIC_KEYS)]);
const out = `${positionals[0] ?? values.name}.sig`;
writeFileSync(out, `${signature}\n`);
console.log(`${out}\nsha256=${sha256}`);
