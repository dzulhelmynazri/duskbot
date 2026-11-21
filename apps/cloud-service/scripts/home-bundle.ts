// A home bundle from the command line (src/bundle.ts): describe a home volume's tar by layer, seal it under a passphrase
// for a move outside this service, open and check one. Prints counts, sizes and paths, never a file's contents.
//
//   node --experimental-strip-types apps/cloud-service/scripts/home-bundle.ts inspect <volume.tar> --cloud <id>
//   MADANI_BUNDLE_PASSPHRASE=... node --experimental-strip-types apps/cloud-service/scripts/home-bundle.ts seal <volume.tar> --cloud <id> --source mac|vps|managed --out <file.dhb>
//   MADANI_BUNDLE_PASSPHRASE=... node --experimental-strip-types apps/cloud-service/scripts/home-bundle.ts open <file.dhb> --out <volume.tar>
import { readFileSync, writeFileSync } from "node:fs";
import { bundleMismatches, openBundle, sealBundle, volumeManifest, type BundleManifest } from "../src/bundle.ts";

const [command, input] = process.argv.slice(2), args = process.argv.slice(4);
const option = (name: string) => { const at = args.indexOf(name); return at === -1 ? null : args[at + 1] ?? null; };
const passphrase = () => { const value = process.env.MADANI_BUNDLE_PASSPHRASE; if (!value) { console.error("MADANI_BUNDLE_PASSPHRASE is required."); process.exit(2); } return value; };
function summary(m: BundleManifest) {
  console.log(`${m.format} v${m.v} cloud ${m.cloudId} from ${m.source.kind}${m.source.host ? ` (${m.source.host})` : ""}: ${m.files.length} files`);
  for (const [layer, n] of Object.entries(m.layers)) console.log(`  ${layer.padEnd(12)} ${String(n!.files).padStart(7)} files ${(n!.bytes / 1024 / 1024).toFixed(1).padStart(9)} MiB`);
}
if (!input || !["inspect", "seal", "open"].includes(command ?? "")) { console.error("usage: home-bundle inspect|seal|open <file> [--cloud id] [--source kind] [--out file]"); process.exit(2); }
if (command === "open") {
  const { manifest, tar } = openBundle(readFileSync(input), passphrase());
  const bad = bundleMismatches(manifest, tar);
  summary(manifest);
  if (bad.length) { console.error(`${bad.length} files differ from the manifest: ${bad.slice(0, 10).join(", ")}`); process.exit(1); }
  if (option("--out")) writeFileSync(option("--out")!, tar, { mode: 0o600 });
  console.log("checked: every file matches its manifest");
} else {
  const cloud = option("--cloud");
  if (!cloud) { console.error("--cloud <id> is required."); process.exit(2); }
  const tar = readFileSync(input), kind = (option("--source") ?? "managed") as BundleManifest["source"]["kind"];
  const manifest = volumeManifest(tar, cloud, { kind });
  const { root: _root, ...plain } = manifest;
  summary(plain);
  if (command === "seal") {
    const out = option("--out");
    if (!out) { console.error("--out <file> is required."); process.exit(2); }
    writeFileSync(out, sealBundle(plain, tar, passphrase()), { mode: 0o600 });
    console.log(`sealed ${out}`);
  }
}
