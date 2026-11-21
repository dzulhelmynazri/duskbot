// Builds the app package a managed My Cloud home installs (apps/cloud-service/src/home.ts, `omb-home install`): the
// bundled server with its launcher, the built UI, skills, the home's edge config, the docker gate and the bot computer
// kit, and the data tools' native modules for the linux-x64 machines. Private like the VPS package: serve it only to the account service (MADANI_MANAGED_HOME_PACKAGE_FILE, or an https URL
// the operator controls as MADANI_MANAGED_HOME_PACKAGE_URL) with its sha256 as MADANI_MANAGED_HOME_PACKAGE_SHA256.
//
//   node apps/cloud-service/scripts/build-home-package.mjs                # build, pack into release/home/omb-home.tgz
//   node apps/cloud-service/scripts/build-home-package.mjs --skip-build   # pack what dist-server/ and dist/ already hold
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stageDuckdb } from "../../../scripts/prepare-duckdb.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const run = (cmd, argv) => execFileSync(cmd, argv, { cwd: root, stdio: "inherit" });
if (!process.argv.includes("--skip-build")) {
  run("pnpm", ["build:server"]);
  run("pnpm", ["exec", "vite", "build"]);
}
for (const required of ["dist-server/cloud-home-start.js", "dist-server/index.js", "dist/index.html", "skills", "apps/cloud-service/deploy/Caddyfile", "apps/link-service/docker-gate.mjs", "deploy/bot-desktop"]) {
  if (!existsSync(join(root, required))) { console.error(`missing ${required}: build first`); process.exit(1); }
}
const out = join(root, "release", "home"), stage = join(out, "stage");
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "cloud"), { recursive: true });
mkdirSync(join(stage, "link"), { recursive: true });
cpSync(join(root, "dist-server"), join(stage, "dist-server"), { recursive: true });
cpSync(join(root, "dist"), join(stage, "dist"), { recursive: true });
cpSync(join(root, "skills"), join(stage, "skills"), { recursive: true });
cpSync(join(root, "deploy", "bot-desktop"), join(stage, "deploy", "bot-desktop"), { recursive: true });
cpSync(join(root, "shared", "bot-desktop.ts"), join(stage, "shared", "bot-desktop.ts"));
cpSync(join(root, "apps", "cloud-service", "deploy", "Caddyfile"), join(stage, "cloud", "Caddyfile"));
cpSync(join(root, "apps", "link-service", "docker-gate.mjs"), join(stage, "link", "docker-gate.mjs"));
// the data tools' native modules: the bundled server resolves them from <app>/node_modules
const natives = mkdtempSync(join(tmpdir(), "madani-home-native-"));
try {
  const [tree] = await stageDuckdb({ root, stage: natives, targets: [{ platform: "linux", arch: "x64" }] });
  cpSync(join(tree, "node_modules"), join(stage, "node_modules"), { recursive: true });
} finally { rmSync(natives, { recursive: true, force: true }); }
const file = join(out, "omb-home.tgz");
// no owners and no macOS metadata: the sandbox extracts as root and makes every file root's
const gnu = execFileSync("tar", ["--version"], { encoding: "utf8" }).includes("GNU");
execFileSync("tar", [...(gnu ? ["--owner=0", "--group=0", "--numeric-owner"] : ["--uid", "0", "--gid", "0", "--no-mac-metadata", "--no-xattrs"]), "-czf", file, "-C", stage, "."],
  { cwd: root, stdio: "inherit", env: { ...process.env, COPYFILE_DISABLE: "1" } });
rmSync(stage, { recursive: true, force: true });
const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
console.log(`${file}\nMADANI_MANAGED_HOME_PACKAGE_SHA256=${sha256}`);
