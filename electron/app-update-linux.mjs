// an AppImage installs its own updates: the release's AppImage is downloaded, checked against the signed manifest's
// SHA256SUMS, and swapped in for the running file with one rename in its own folder, so the person's desktop entry,
// autostart entry and path keep working. the running copy is unaffected: the AppImage runtime (type 2) mounts the file
// it opened, and a rename leaves that open inode alive until the app exits. "restart to update" relaunches $APPIMAGE.
// a .deb is not touched here; it keeps the download link (dpkg owns its files).
import { accessSync, chmodSync, closeSync, constants, copyFileSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { assetIn, mirrorUrl, newer, zipUrl } from "./app-update.mjs";
import { hashOf } from "./app-update-download.mjs";

/** what the updater left in its folder after a swap: `{ version }` */
export const SWAPPED = "appimage-installed.json";

/** the version the updater last swapped in, or null */
export function swappedVersion(dir) {
  try { return JSON.parse(readFileSync(join(dir, SWAPPED), "utf8"))?.version ?? null; } catch { return null; }
}

/** the release's AppImage in a SHA256SUMS text: `{ name, sha256 }`, or null (only x64 AppImages are built) */
export const appImageIn = (sums, version) => assetIn(sums, `MadaniBot-${version}-x86_64.AppImage`);
/** madani.bot's copy, then the downloads repo's stable name (the same bytes, checked against the same sha256) */
export const appImageSources = (version, name) => [mirrorUrl(version, name), zipUrl(version, "MadaniBot.AppImage")];

const writableDir = (dir) => { try { accessSync(dir, constants.W_OK); return true; } catch { return false; } };
const isFile = (file) => { try { return statSync(file).isFile(); } catch { return false; } };

/**
 * whether the updater can replace the AppImage at `file`: "readonly" when there is no such file or its folder can't be
 * written (a rename needs the folder, not the file), else null
 */
export function appImagePlace(file, { exists = isFile, writable = writableDir } = {}) {
  if (typeof file !== "string" || !file.startsWith("/") || !exists(file)) return "readonly";
  return writable(dirname(file)) ? null : "readonly";
}

/** the swapped-in file's mode: the old one's, readable and executable by everyone who could run it before */
export const swappedMode = (mode) => (mode & 0o7777) | 0o555;

/**
 * `prepare(file, version)` moves the verified download next to `target` (a copy when it is on another disk), checks it
 * again, makes it executable and renames it over `target`; `install()` relaunches `target` and quits. `failed(version)`:
 * that version was swapped in and this app is still older (the file was moved back, or a copy elsewhere was opened).
 */
export function appImageInstaller({ target, dir, current, relaunch, quit, log = () => {}, fs = { renameSync, copyFileSync, chmodSync, statSync, rmSync } }) {
  const swapped = join(dir, SWAPPED);
  return {
    async prepare(file, version) {
      const temp = join(dirname(target), `.${basename(target)}.${version}.part`);
      try {
        try { fs.renameSync(file, temp); } catch (error) {
          if (error?.code !== "EXDEV") throw error;
          const expected = await hashOf(file);
          fs.copyFileSync(file, temp);
          if ((await hashOf(temp)) !== expected) throw new Error("the update changed while it was copied into place");
          fs.rmSync(file, { force: true });
        }
        flush(temp);
        fs.chmodSync(temp, swappedMode(fs.statSync(target).mode));
        fs.renameSync(temp, target);
      } catch (error) {
        fs.rmSync(temp, { force: true });
        throw error;
      }
      try { writeFileSync(swapped, JSON.stringify({ version })); } catch { /* failed() can't tell then */ }
      log(`app update: ${version} replaced ${basename(target)}`);
    },
    install() {
      relaunch(target);
      quit();
    },
    failed(next) {
      return swappedVersion(dir) === next && newer(next, current);
    },
  };
}

function flush(file) {
  let fd = null;
  try { fd = openSync(file, "r"); fsyncSync(fd); } catch { /* best effort before the rename */ } finally { if (fd !== null) closeSync(fd); }
}

/** the arguments the relaunched AppImage gets: the person's own switches (--no-sandbox and the like), never a one-shot link */
export const relaunchArgs = (argv) => argv.filter((arg) => arg.startsWith("--") && arg !== "--madani-hidden");

/** createAppUpdater's options for the AppImage at `env.APPIMAGE` (main adds what every platform shares) */
export function appImageUpdates({ app, dir, env = process.env, argv = process.argv, log }) {
  const target = env.APPIMAGE;
  return {
    platform: "linux", appImage: true, signed: async () => true, blocked: async () => appImagePlace(target),
    asset: appImageIn, sources: appImageSources, keep: [SWAPPED],
    installer: appImageInstaller({ target, dir, current: app.getVersion(), log, quit: () => app.quit(),
      relaunch: (file) => app.relaunch({ execPath: file, args: relaunchArgs(argv.slice(1)) }) }),
  };
}
