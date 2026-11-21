// `pnpm dev:app [electron args]`: the Vite UI plus the desktop app, which runs the harness from source as its own
// child (electron/dev-server-child.mjs). MADANI_PORT, MADANI_UI_PORT and MADANI_DATA_DIR work as they do for dev:server and dev.
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { takeRelaunchRequest } from "./dev-relaunch.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const uiPort = Number(process.env.MADANI_UI_PORT) || 5199;
const env = { ...process.env, MADANI_DEV_OWN_SERVER: "1", ELECTRON_START_URL: process.env.ELECTRON_START_URL || `http://127.0.0.1:${uiPort}` };
// the dev app has the packaged app's account (sign-in sheet, madani cloud, checkout) against preview, test payments only;
// it never blocks on the sign-in gate. MADANI_CLOUD_ORIGIN or MADANI_CLOUD_STAGING given by hand win.
if (!env.MADANI_CLOUD_ORIGIN && env.MADANI_CLOUD_STAGING !== "1") env.MADANI_CLOUD_ORIGIN = "https://preview.madani.bot";
env.MADANI_ALLOW_SIGNED_OUT ??= "1";
// the dev app pairs phones like the packaged app: typed codes go through the default relay
env.MADANI_MOBILE_RELAY ??= "default";
// the dev app reports its usage to preview (tagged +dev), so the owner's own testing shows in the admin; MADANI_ANALYTICS=0 stops it
if (env.MADANI_CLOUD_ORIGIN === "https://preview.madani.bot") env.MADANI_ANALYTICS ??= "1";
delete env.ELECTRON_RUN_AS_NODE;
// a relaunch inside the app (Start fresh, desktop remote change) asks this runner to restart Electron; Vite stays up
const relaunchFile = path.join(os.tmpdir(), `madani-dev-relaunch-${process.pid}.json`);
env.MADANI_DEV_RELAUNCH_FILE = relaunchFile;

const prepared = spawnSync(process.execPath, ["scripts/prepare-cloudflared.mjs", "--current"], { cwd: root, stdio: "inherit" });
if (prepared.status !== 0) process.exit(prepared.status ?? 1);

const children = new Set();
let ending = false;
const end = (code) => {
  if (ending) return;
  ending = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code ?? 0;
};
const run = (command, args, { relaunches = false } = {}) => {
  const child = spawn(command, args, { cwd: root, env, stdio: "inherit" });
  children.add(child);
  child.once("exit", (code) => {
    children.delete(child);
    const again = relaunches && !ending ? takeRelaunchRequest(relaunchFile) : null;
    if (again) run(command, again, { relaunches });
    else end(code);
  });
  return child;
};
process.once("SIGINT", () => end(0));
process.once("SIGTERM", () => end(0));

// a taken UI port must fail loudly: Vite would move to the next port while the window still loads this one
run(process.execPath, [fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url)), "--strictPort"]);
for (let attempt = 0; attempt < 120 && !ending; attempt += 1) {
  if (await fetch(env.ELECTRON_START_URL).then(() => true, () => false)) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!ending) run(require("electron"), [".", ...process.argv.slice(2)], { relaunches: true });
