// Refuses a deploy whose managed home package settings disagree, before anything ships: the file on the server, its
// signature and MADANI_MANAGED_HOME_PACKAGE_SHA256 must name the same package, or the service refuses to start
// ("Release signature is for another artifact") and the site is down. Reads the built env file; looks at the files on
// the deploy host over ssh (MADANI_PACKAGE_SSH_HOST, default contabo). Prints names and short hashes only, never a value
// of anything secret.
//
//   node deploy/account/check-home-package.mjs <env file>
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) { console.error("usage: check-home-package.mjs <env file>"); process.exit(2); }
const env = Object.fromEntries(readFileSync(file, "utf8").split("\n").map((line) => /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())).filter(Boolean)
  .map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]));
const pkg = env.MADANI_MANAGED_HOME_PACKAGE_FILE, sigFile = env.MADANI_MANAGED_HOME_PACKAGE_SIGNATURE_FILE, sha = env.MADANI_MANAGED_HOME_PACKAGE_SHA256;
if (!pkg && !sigFile && !sha) { console.log("home package: none configured"); process.exit(0); }
const fail = (why) => { console.error(`refusing to deploy: the home package settings disagree (${why}). Fix MADANI_MANAGED_HOME_PACKAGE_* in madani.env.`); process.exit(1); };
if (!pkg || !sha) fail("FILE and SHA256 go together");
if (!/^[0-9a-f]{64}$/.test(sha)) fail("SHA256 is not a sha256");
const host = process.env.MADANI_PACKAGE_SSH_HOST || "contabo";
const quote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
let remote;
try {
  remote = execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20", host,
    `sha256sum ${quote(pkg)} | cut -d' ' -f1; ${sigFile ? `cat ${quote(sigFile)}` : "echo"}`], { encoding: "utf8", timeout: 120_000 }).trim().split("\n");
} catch (error) { fail(`could not read ${pkg} on ${host}: ${String(error.message).split("\n")[0]}`); }
const [onDisk, signature = ""] = remote;
if (onDisk !== sha) fail(`${pkg} is ${onDisk.slice(0, 12)}, SHA256 says ${sha.slice(0, 12)}`);
if (sigFile) {
  let signed = null;
  try { signed = JSON.parse(Buffer.from(signature.trim().split(".")[2] ?? "", "base64url").toString("utf8")); } catch {}
  if (!signed || signed.kind !== "home-package") fail(`${sigFile} is not a home package signature`);
  if (signed.sha256 !== sha) fail(`${sigFile} signs ${String(signed.sha256).slice(0, 12)}, SHA256 says ${sha.slice(0, 12)}`);
  console.log(`home package: ${pkg} ${sha.slice(0, 12)}, signed ${signed.version}`);
} else console.log(`home package: ${pkg} ${sha.slice(0, 12)} (no signature file)`);
