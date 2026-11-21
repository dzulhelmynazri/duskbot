// stages the windows x64 natives on a mac or linux host, for `pnpm package:win:cross` (no windows machine needed).
// package:prepare stages this host's own natives; this adds win32-x64's beside them.
// electron-builder then needs wine on PATH for the nsis uninstaller (a portable wow64 build such as Kron4ek/Wine-Builds works
// without root); the exe and zip need nothing more. the result is unsigned, so SmartScreen warns.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareCloudflared } from "./prepare-cloudflared.mjs";
import { stageBrowserTarget } from "./prepare-browser.mjs";
import { stageDuckdb } from "./prepare-duckdb.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const node = (script, env = {}) => {
  const result = spawnSync(process.execPath, [join(root, "scripts", script)], { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });
  if (result.status !== 0) throw new Error(`${script} failed`);
};

// the windows app ships only its own adb, not this host's
rmSync(join(root, "dist-native", "android-platform-tools"), { recursive: true, force: true });
node("prepare-android-tools.mjs", { MADANI_ANDROID_TOOLS_PLATFORM: "win32" });
await prepareCloudflared({ root, platform: "win32", arch: "x64" });
await stageBrowserTarget(root, "win32-x64");
await stageDuckdb({ root, targets: [{ platform: "win32", arch: "x64" }], sign: false });
node("prepare-cua-win.mjs");
