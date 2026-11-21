// the mac app installs its own updates. madani.bot's signed latest.json names the version and the sha256 of that
// release's SHA256SUMS; the zip for this mac's arch is downloaded from the public downloads repo (or madani.bot's copy,
// app-update-download.mjs), checked against those sums, and handed to Electron's autoUpdater (Squirrel.Mac) through a
// feed on 127.0.0.1 that only this process knows.
// Squirrel.Mac installs only an app signed with the same Developer ID as the running one (its designated requirement),
// and only one it can replace where it runs, so an unsigned build, or one run from a disk image or a translocated copy,
// is shown how to update by hand instead. Windows does the same with the release's NSIS installer (app-update-windows.mjs)
// and an AppImage by replacing its own file (app-update-linux.mjs); a .deb is shown a link to its own installer.
// a downloaded update installs when the app quits, or at a quiet moment (locked, or no window focused and nobody touched
// the mac for QUIET_IDLE_MS, with no turn, call or dictation running), and the app shows "restart to update" while it waits.
// the signed update policy (POLICY_SOURCES) may hold a version back: paused, blocked, below the floor, or outside its staged
// rollout share for this install's fixed bucket; a version held back is neither downloaded nor restarted into.
import { execFile } from "node:child_process";
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { accessSync, constants, createReadStream, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";

import { failReason, resumableDownload, UpdateError } from "./app-update-download.mjs";

export const DESKTOP_MANIFEST_URL = "https://madani.bot/releases/latest.json";
export const sumsUrl = (version) => `https://madani.bot/releases/${version}/SHA256SUMS`;
export const zipUrl = (version, name) => `https://github.com/dzulhelmynazri/madani-bot-releases/releases/download/v${version}/${name}`;
/** where the signed manifest can come from, in the order they are tried: madani.bot, then the downloads repo's latest
 * release (scripts/publish-downloads.sh uploads the same signed file there) */
export const MANIFEST_SOURCES = Object.freeze([DESKTOP_MANIFEST_URL, "https://github.com/dzulhelmynazri/madani-bot-releases/releases/latest/download/latest.json"]);
/** where a release's SHA256SUMS can come from; either copy must hash to the signed manifest's sha256 */
export const sumsSources = (version) => [sumsUrl(version), zipUrl(version, "SHA256SUMS")];
/** a lookup tries every source once per round, waiting this long before each next round */
export const LOOKUP_BACKOFF_MS = Object.freeze([3_000, 15_000]);
// failure codes that mean this computer reached no server at all (offline, DNS down, a dropped wifi)
const UNREACHABLE = new Set(["enotfound", "eai_again", "eai_fail", "timeout", "etimedout", "und_err_connect_timeout", "und_err_headers_timeout", "und_err_socket",
  "enetunreach", "enetdown", "ehostunreach", "ehostdown", "econnrefused", "econnreset", "econnaborted", "epipe", "terminated", "fetch_failed"]);
export const unreachable = (reason) => UNREACHABLE.has(String(reason));
/** an unreachable check counts as a failure only after this many in a row (hours apart), or when the person asked */
export const OFFLINE_CHECKS_BEFORE_FAILED = 6;
/** CI's release keys (apps/cloud-service/src/release-signing.ts pins the same ones; a test keeps them equal) */
export const RELEASE_KEYS = Object.freeze([{ kid: "rel-2026-11", x: "wtwZypDwVPBXZ25XsZOVpd0PZPBbVMhugheUj5_NLIM" }]);
const CHECK_EVERY_MS = 30 * 60_000;
/** each check lands somewhere in this much more, so every app does not ask madani.bot in the same minute */
const JITTER_MS = 10 * 60_000;
/** the signed update policy (shared/update-guard.ts), first answer that verifies wins: the account service, then madani.bot's copy */
export const POLICY_SOURCES = Object.freeze(["https://madani.bot/v1/updates/policy", "https://madani.bot/releases/update-policy.json"]);
const SEMVER = /^\d+\.\d+\.\d+$/;

/** `{ serial, floor, blocked, paused, rollout }` from a `{ body, signature }` policy a pinned key signed, or null */
export function verifiedPolicy(doc, keys = RELEASE_KEYS) {
  if (typeof doc?.body !== "string" || typeof doc?.signature !== "string" || doc.body.length > 64_000) return null;
  const parts = doc.signature.trim().split(".");
  if (parts.length !== 4 || parts[0] !== "r1" || !/^[A-Za-z0-9_-]+$/.test(parts[2]) || !/^[A-Za-z0-9_-]+$/.test(parts[3])) return null;
  const key = keys.find((item) => item.kid === parts[1]);
  if (!key) return null;
  try {
    const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.x }, format: "jwk" });
    if (!verify(null, Buffer.from(parts.slice(0, 3).join(".")), publicKey, Buffer.from(parts[3], "base64url"))) return null;
    const m = JSON.parse(Buffer.from(parts[2], "base64url").toString("utf8"));
    if (m.v !== 1 || m.kind !== "update-policy" || m.name !== "update-policy" || m.sha256 !== createHash("sha256").update(doc.body).digest("hex")) return null;
    const p = JSON.parse(doc.body);
    if (!Number.isSafeInteger(p.serial) || m.version !== String(p.serial) || (p.floor !== null && !SEMVER.test(p.floor ?? "")) || !Array.isArray(p.blocked)) return null;
    const rollout = p.rollout && typeof p.rollout === "object" ? Object.fromEntries(Object.entries(p.rollout).filter(([v, share]) => SEMVER.test(v) && Number.isInteger(share))) : {};
    return { serial: p.serial, floor: p.floor, blocked: p.blocked.filter((v) => typeof v === "string"), paused: p.paused === true, rollout };
  } catch {
    return null;
  }
}

/** why the policy holds `version` back from this install (`bucket`: 0 to 99, fixed per install), or null */
export function policyHolds(policy, version, bucket) {
  if (!policy) return null;
  if (policy.paused) return "paused";
  if (policy.blocked.includes(version)) return "blocked";
  if (policy.floor && newer(policy.floor, version)) return "below_floor";
  const share = policy.rollout?.[version];
  return share !== undefined && bucket() >= share ? "rollout" : null;
}

/** this install's fixed rollout bucket, 0 to 99, kept beside the update folder */
export function storedBucket(file, random = Math.random) {
  try { const n = JSON.parse(readFileSync(file, "utf8")).bucket; if (Number.isInteger(n) && n >= 0 && n < 100) return n; } catch { /* first time */ }
  const bucket = Math.floor(random() * 100);
  try { writeFileSync(file, JSON.stringify({ bucket })); } catch { /* a new one next launch */ }
  return bucket;
}
export const QUIET_IDLE_MS = 10 * 60_000;

/** `{ version, sums }` from a desktop release manifest signed by a pinned key, or null */
export function verifiedRelease(body, keys = RELEASE_KEYS) {
  const parts = typeof body?.signature === "string" ? body.signature.trim().split(".") : [];
  if (parts.length !== 4 || parts[0] !== "r1" || !/^[A-Za-z0-9_-]+$/.test(parts[2]) || !/^[A-Za-z0-9_-]+$/.test(parts[3])) return null;
  const key = keys.find((item) => item.kid === parts[1]);
  if (!key) return null;
  try {
    const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.x }, format: "jwk" });
    if (!verify(null, Buffer.from(parts.slice(0, 3).join(".")), publicKey, Buffer.from(parts[3], "base64url"))) return null;
    const m = JSON.parse(Buffer.from(parts[2], "base64url").toString("utf8"));
    if (m.v !== 1 || m.kind !== "desktop" || !/^\d+\.\d+\.\d+$/.test(m.version ?? "") || !/^[0-9a-f]{64}$/.test(m.sha256 ?? "")) return null;
    return { version: m.version, sums: m.sha256 };
  } catch {
    return null;
  }
}

/** a > b for plain x.y.z versions */
export function newer(a, b) {
  const parse = (value) => /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value))?.slice(1).map(Number);
  const left = parse(a), right = parse(b);
  if (!left || !right) return false;
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] > right[i];
  return false;
}

/** this arch's zip in a SHA256SUMS text: `{ name, sha256 }`, or null */
export const zipIn = (sums, version, arch) => assetIn(sums, `MadaniBot-${version}-${arch}.zip`);
/** the windows installer in a SHA256SUMS text: `{ name, sha256 }`, or null */
export const setupIn = (sums, version) => assetIn(sums, `MadaniBot-${version}-setup.exe`);

/** `name` in a SHA256SUMS text: `{ name, sha256 }`, or null */
export function assetIn(sums, name) {
  for (const line of String(sums).split("\n")) {
    const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line.trim());
    if (match && match[2] === name) return { name, sha256: match[1] };
  }
  return null;
}

/**
 * whether the running app is signed with a Developer ID (the only kind Squirrel.Mac will update): `codesign -dv` on the
 * bundle names a Developer ID Application authority and a team
 */
export function developerIdSigned(bundle, run = (file, args) => new Promise((resolve) => execFile(file, args, { timeout: 15_000 }, (_error, stdout, stderr) => resolve(`${stdout}\n${stderr}`)))) {
  return run("/usr/bin/codesign", ["-dv", "--verbose=4", bundle]).then((out) => /^Authority=Developer ID Application: /m.test(out) && /^TeamIdentifier=[A-Z0-9]{10}$/m.test(out), () => false);
}

const writableDir = (dir) => { try { accessSync(dir, constants.W_OK); return true; } catch { return false; } };

/**
 * whether Squirrel.Mac can replace the app at `bundle`: "move" for a copy macOS translocated (opened straight from
 * Downloads or a disk image without being moved) or one on a read-only disk image, "readonly" when its folder can't be
 * written (an admin's /Applications for a standard account), else null
 */
export function updatePlace(bundle, writable = writableDir) {
  if (bundle.includes("/AppTranslocation/")) return "move";
  if (writable(dirname(bundle))) return null;
  return bundle.startsWith("/Volumes/") ? "move" : "readonly";
}

/**
 * Squirrel.Mac fed from 127.0.0.1: a feed and the verified zip at an unguessable path, for one download, closed after.
 * `autoUpdater` is Electron's.
 */
export function squirrelInstaller({ autoUpdater, timeoutMs = 15 * 60_000 }) {
  return {
    async prepare(file, version) {
      const token = randomBytes(16).toString("hex"), size = statSync(file).size;
      let port = 0;
      const server = createServer((req, res) => {
        if (req.method === "GET" && req.url === `/${token}/feed.json`) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ url: `http://127.0.0.1:${port}/${token}/update.zip`, name: version }));
        }
        if (req.method === "GET" && req.url === `/${token}/update.zip`) {
          res.writeHead(200, { "content-type": "application/zip", "content-length": String(size) });
          return void pipeline(createReadStream(file), res).catch(() => {});
        }
        res.writeHead(404).end();
      });
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      port = server.address().port;
      let done, failed;
      const settled = new Promise((resolve, reject) => { done = resolve; failed = reject; });
      const timer = setTimeout(() => failed(new Error("the update did not unpack in time")), timeoutMs);
      autoUpdater.once("update-downloaded", done);
      autoUpdater.once("error", failed);
      try {
        autoUpdater.setFeedURL({ url: `http://127.0.0.1:${port}/${token}/feed.json`, serverType: "json" });
        autoUpdater.checkForUpdates();
        await settled;
      } finally {
        clearTimeout(timer);
        autoUpdater.removeListener("update-downloaded", done);
        autoUpdater.removeListener("error", failed);
        server.close();
      }
    },
    install() { autoUpdater.quitAndInstall(); },
  };
}

/**
 * quiet enough to restart: nothing runs on this computer's server or in a call (update-when-quiet-main.mjs quietSignals),
 * and the screen is locked, or no window of this app is focused and nobody touched this mac or typed in the app for
 * QUIET_IDLE_MS
 */
export async function quietNow(signals, now = Date.now()) {
  if (signals.busy?.()) return false;
  const away = signals.locked() || (!signals.focused?.() && signals.idleMs() >= QUIET_IDLE_MS && now - (signals.typedAt() ?? 0) >= QUIET_IDLE_MS);
  if (!away) return false;
  try { return (await signals.work()) === null; } catch { return false; }
}

/**
 * whether this launch is the first of a newer version (so the window can say "updated to" once); remembers `current`.
 * with nothing remembered (a version before this one did not), `installedHere` says this updater left `current`'s zip.
 */
export function justUpdated(memory, current, installedHere = () => false) {
  let before = null;
  try { before = memory.read()?.version ?? null; } catch { /* first run, or unreadable */ }
  if (before === current) return false;
  try { memory.write({ version: current }); } catch { /* says it again next time */ }
  return typeof before === "string" ? newer(current, before) : installedHere();
}

export const DOWNLOAD_PAGE = "https://madani.bot/download";
/** madani.bot's own copy of a release file, next to its SHA256SUMS (scripts/mirror-release.sh puts it there) */
export const mirrorUrl = (version, name) => `https://madani.bot/releases/${version}/${name}`;
/** where a release's update zip can come from, in the order they are tried */
export const zipSources = (version, name) => [zipUrl(version, name), mirrorUrl(version, name)];
/** where a release's windows installer can come from: madani.bot's copy, then the downloads repo's stable name (the same
 * bytes, checked against the same sha256) */
export const setupSources = (version, name) => [mirrorUrl(version, name), zipUrl(version, "MadaniBot-setup.exe")];

// the downloads repo keeps the installers under the stable names madani.bot/download links to
const STABLE = { "setup.exe": "MadaniBot-setup.exe", "x86_64.AppImage": "MadaniBot.AppImage", "amd64.deb": "MadaniBot-amd64.deb" };

/** the installer someone on `platform` runs by hand, named as SHA256SUMS names it, or null */
export function installerIn(sums, version, platform, { appImage = false } = {}) {
  const end = platform === "win32" ? "setup.exe" : platform === "linux" ? (appImage ? "x86_64.AppImage" : "amd64.deb") : null;
  if (!end) return null;
  const name = `MadaniBot-${version}-${end}`;
  return String(sums).split("\n").some((line) => /^[0-9a-f]{64} {2}/.test(line.trim()) && line.trim().slice(66) === name) ? name : null;
}

/** a link that downloads `name` itself: madani.bot's copy when it has one, else the downloads repo's, else the download page */
export async function installerUrl(version, name, fetchImpl = fetch) {
  if (!name) return DOWNLOAD_PAGE;
  try {
    const answer = await fetchImpl(mirrorUrl(version, name), { method: "HEAD", signal: AbortSignal.timeout(15_000) });
    if (answer.ok) return mirrorUrl(version, name);
  } catch { /* the downloads repo then */ }
  const stable = STABLE[name.slice(`MadaniBot-${version}-`.length)];
  return stable ? zipUrl(version, stable) : DOWNLOAD_PAGE;
}

/**
 * keeps the app current. on a mac or a windows install (`installs`) that may install it (`signed()`, a Developer ID on a
 * mac) and runs from a place it may replace (`blocked()` is null), it downloads the update (`asset(sums, version)` from
 * `sources(version, name)`) and restarts into it; otherwise the state names what the person can do: `blocked: "move"`
 * (move the app to Applications) or `manual` (`{ version, url }`, a link to download the release by hand). a version
 * `installer.failed(version)` says did not install is offered by hand too, until `check({ again: true })` (the person
 * asked) tries it once more. `fallback.check()` (update-notice.mjs) also tells an unsigned build, and any failure.
 * `onState` hears: `available` (a newer version), `progress` (0 to 1) while it downloads, `retrying` while a failed try
 * waits for the next, `ready` once it waits for a restart, `checking` while a check runs, `failed` when the last could
 * not finish. `onFailed(message, { stage, reason })`: `reason` is a short word, never a path.
 */
export function createAppUpdater({ current, arch, dir, fetchImpl = fetch, keys = RELEASE_KEYS, installs = true, platform = "darwin", appImage = false, signed, blocked = async () => null,
  asset = (sums, version) => zipIn(sums, version, arch), sources = zipSources, keep = [], installer, quiet, fallback, onState = () => {}, onFailed = () => {}, log = () => {}, firstDelayMs = 20_000, intervalMs = CHECK_EVERY_MS, jitterMs = JITTER_MS, random = Math.random,
  quietEveryMs = 60_000, timers = globalThis, download = {}, policySources = POLICY_SOURCES, bucket = () => storedBucket(join(dirname(dir), "update-bucket.json")) }) {
  let ready = null, available = null, progress = null, timer = null, quietTimer = null, checking = null, installing = false, failed = false, retrying = false, stuck = null, manual = null, kick = null, again = false;
  const toldBlocked = new Set();
  const state = () => ({ ready, available, progress, checking: checking !== null, failed, retrying, blocked: stuck, manual });
  const tell = () => onState(state());
  const report = (version, why) => {
    if (toldBlocked.has(`${version}:${why}`)) return;
    toldBlocked.add(`${version}:${why}`);
    try { onFailed(why, { stage: "other", reason: why }); } catch {}
  };

  let offlineChecks = 0;
  const wait = download.wait ?? ((ms) => new Promise((resolve) => timers.setTimeout(resolve, ms)));

  async function textFrom(url, limit) {
    let response;
    try { response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000), cache: "no-store" }); } catch (error) { throw new UpdateError("manifest", failReason(error), String(error?.message ?? error)); }
    if (!response.ok) { await response.body?.cancel?.().catch(() => {}); throw new UpdateError("manifest", `http_${response.status}`, `${new URL(url).pathname} answered ${response.status}`); }
    const body = await response.text();
    if (body.length > limit) throw new UpdateError("manifest", "too_large");
    return body;
  }

  /** what `accept` makes of the first of `urls` it takes. every source is tried each round, and another round follows
   * (after a wait) only while every failure looks like the network: unreachable, a 5xx or a 429. throws the last
   * round's first failure that is not the network, else its first */
  async function firstOf(urls, limit, accept) {
    for (let round = 0; ; round += 1) {
      let first = null, telling = null;
      for (const url of urls) {
        try { return accept(await textFrom(url, limit)); } catch (error) {
          first ??= error;
          const reason = failReason(error);
          if (!unreachable(reason) && !/^http_(5\d\d|429)$/.test(reason)) telling ??= error;
        }
      }
      if (telling || round >= LOOKUP_BACKOFF_MS.length) throw telling ?? first;
      await wait(LOOKUP_BACKOFF_MS[round]);
    }
  }

  const signedRelease = (text) => {
    let body;
    try { body = JSON.parse(text); } catch (error) { throw new UpdateError("manifest", "bad_json", String(error?.message ?? error)); }
    const release = verifiedRelease(body, keys);
    if (!release) throw new UpdateError("manifest", "not_signed", "the release manifest is not signed by a pinned key");
    return release;
  };
  const matchingSums = (release) => (text) => {
    if (createHash("sha256").update(text).digest("hex") !== release.sums) throw new UpdateError("checksum", "sums_mismatch", "SHA256SUMS does not match the signed manifest");
    return text;
  };

  /** the newest signed release when it is newer than this app: `{ version, sums }` (the verified SHA256SUMS text) */
  async function lookup() {
    const release = await firstOf(MANIFEST_SOURCES, 64 * 1024, signedRelease);
    if (!newer(release.version, current)) return null;
    const sums = await firstOf(sumsSources(release.version), 64 * 1024, matchingSums(release));
    return { version: release.version, sums };
  }

  let policy = null, heldBack = null, myBucket = null;
  const bucketOf = () => (myBucket ??= bucket());
  /** the newest signed policy any source gives; one that fails or is older than the one held changes nothing */
  async function refreshPolicy() {
    for (const url of policySources) {
      try {
        const answer = await fetchImpl(url, { signal: AbortSignal.timeout(15_000), cache: "no-store" });
        if (!answer.ok) { await answer.body?.cancel?.().catch(() => {}); continue; }
        const text = await answer.text();
        const found = text.length <= 64 * 1024 ? verifiedPolicy(JSON.parse(text), keys) : null;
        if (found && found.serial > (policy?.serial ?? 0)) policy = found;
        if (found) return;
      } catch { /* the next source */ }
    }
  }
  const holds = (version) => policyHolds(policy, version, bucketOf);

  async function run() {
    if (ready) { await refreshPolicy(); return ready; }
    const release = await lookup();
    if (!release) { available = manual = stuck = null; return null; }
    const { version, sums } = release;
    available = version;
    if (!installs) { manual = { version, url: await installerUrl(version, installerIn(sums, version, platform, { appImage }), fetchImpl) }; return null; }
    if (!(await signed())) { manual = { version, url: DOWNLOAD_PAGE }; await fallback.check(); return null; }
    const where = await blocked().catch(() => null);
    if (where === "move") { stuck = "move"; manual = null; report(version, "translocated"); return null; }
    const byHand = async () => installerUrl(version, installerIn(sums, version, platform, { appImage }), fetchImpl);
    if (where === "readonly") { stuck = null; manual = { version, url: platform === "darwin" ? DOWNLOAD_PAGE : await byHand() }; report(version, "read_only"); return null; }
    if (where === "portable") { stuck = null; manual = { version, url: await byHand() }; report(version, "portable"); return null; }
    if (installer.failed?.(version) && !again) { stuck = null; manual = { version, url: await byHand() }; report(version, "did_not_install"); return null; }
    stuck = manual = null;
    await refreshPolicy();
    const hold = holds(version);
    if (hold) {
      if (heldBack !== `${version}:${hold}`) { heldBack = `${version}:${hold}`; log(`app update: ${version} is held back (${hold})`); }
      available = null;
      return null;
    }
    const zip = asset(sums, version);
    if (!zip) throw new UpdateError("manifest", "no_zip", `release ${version} has no update for ${platform} ${arch}`);
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(dir)) if (name !== zip.name && name !== `${zip.name}.part` && !keep.includes(name)) rmSync(join(dir, name), { recursive: true, force: true });
    const file = join(dir, zip.name);
    progress = 0; retrying = false; tell();
    try {
      await resumableDownload({ sources: sources(version, zip.name), file, sha256: zip.sha256, fetchImpl, ...download,
        setKick: (fn) => { kick = fn; },
        onProgress: (fraction) => {
          // whole percents, so the window hears at most a hundred changes
          const now = fraction === null ? progress : Math.min(99, Math.floor(fraction * 100)) / 100;
          if (now !== progress || retrying) { progress = now; retrying = false; tell(); }
        },
        onRetry: (error, tries) => { retrying = true; log(`app update: download try ${tries} failed (${failReason(error)}), trying again`); tell(); } });
      try { await installer.prepare(file, version); } catch (error) { throw new UpdateError("install", `install_${failReason(error)}`.slice(0, 40).replace(/_+$/, ""), `the update could not install: ${error instanceof Error ? error.message : String(error)}`); }
    } finally { progress = null; retrying = false; kick = null; }
    ready = version;
    log(`app update: ${ready} is ready; it installs on quit or at a quiet moment`);
    tell();
    watchQuiet();
    return ready;
  }

  function check({ again: asked = false } = {}) {
    if (asked) again = true;
    if (checking) return checking;
    failed = false;
    checking = run().then((result) => { offlineChecks = 0; return result; }, async (error) => {
      const offline = error instanceof UpdateError && error.stage === "manifest" && unreachable(error.code);
      offlineChecks = offline ? offlineChecks + 1 : 0;
      if (offline && !asked && offlineChecks < OFFLINE_CHECKS_BEFORE_FAILED) { log(`app update: no network for the check (${error.code}); trying at the next one`); return null; }
      offlineChecks = 0;
      failed = true;
      const message = error instanceof Error ? error.message : String(error);
      log(`app update: ${message}; telling the person instead`);
      try { onFailed(message, { stage: error instanceof UpdateError ? error.stage : null, reason: failReason(error) }); } catch {}
      await fallback.check();
      return null;
    }).finally(() => { checking = null; tell(); });
    tell();
    return checking;
  }

  function watchQuiet() {
    if (quietTimer) return;
    const look = async () => {
      quietTimer = null;
      if (installing) return;
      if (!holds(ready) && await quiet().catch(() => false)) return restart();
      quietTimer = timers.setTimeout(look, quietEveryMs);
      quietTimer?.unref?.();
    };
    quietTimer = timers.setTimeout(look, quietEveryMs);
    quietTimer?.unref?.();
  }

  function restart() {
    if (!ready || installing) return false;
    installing = true;
    log(`app update: restarting into ${ready}`);
    installer.install();
    return true;
  }

  const later = (delay) => { timer = timers.setTimeout(() => { void check().finally(() => later(intervalMs + Math.floor(random() * jitterMs))); }, delay); timer?.unref?.(); };
  return {
    check, restart,
    state,
    start() {
      if (timer) return;
      later(firstDelayMs);
    },
    /** the mac woke: a download in flight goes on from where it got (its socket died in the sleep), and the next check
     * comes after `delayMs` (the network needs a moment), then every half hour from there */
    soon(delayMs = 30_000) {
      kick?.();
      if (!timer) return;
      timers.clearTimeout(timer);
      later(delayMs);
    },
    stop() { if (timer) timers.clearTimeout(timer); if (quietTimer) timers.clearTimeout(quietTimer); timer = quietTimer = null; },
  };
}
