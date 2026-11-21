import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAppUpdater, DESKTOP_MANIFEST_URL, mirrorUrl, sumsUrl, zipUrl } from "./app-update.mjs";
import { appImageIn, appImageInstaller, appImagePlace, appImageSources, appImageUpdates, relaunchArgs, SWAPPED, swappedMode, swappedVersion } from "./app-update-linux.mjs";

const { privateKey } = generateKeyPairSync("ed25519");
const keys = [{ kid: "test-desk", x: createPublicKey(privateKey).export({ format: "jwk" }).x }];
const sha = (value) => createHash("sha256").update(value).digest("hex");
function manifest(version, sums) {
  const head = `r1.test-desk.${Buffer.from(JSON.stringify({ v: 1, kind: "desktop", name: "madani bot", version, sha256: sha(sums), signedAt: 1 })).toString("base64url")}`;
  return { v: 1, version, sha256sums: sha(sums), signature: `${head}.${sign(null, Buffer.from(head), privateKey).toString("base64url")}` };
}

const IMAGE = "MadaniBot-1.1.0-x86_64.AppImage";
const NEW = "new appimage bytes";

/** a person's AppImage at ~/Applications/Madani Bot.AppImage, version 1.0.0, and an updater that may replace it */
function world({ served = Buffer.from(NEW), routes: extra = {}, blocked, current = "1.0.0", fsImpl } = {}) {
  const sums = `${sha("zip")}  MadaniBot-1.1.0-x64.zip\n${sha(NEW)}  ${IMAGE}\n${sha("deb")}  MadaniBot-1.1.0-amd64.deb\n`;
  const routes = new Map([
    [DESKTOP_MANIFEST_URL, JSON.stringify(manifest("1.1.0", sums))],
    [sumsUrl("1.1.0"), sums],
    ...(served ? [[mirrorUrl("1.1.0", IMAGE), served]] : []),
    ...Object.entries(extra),
  ]);
  const root = mkdtempSync(join(tmpdir(), "madani-appimage-update-"));
  const apps = join(root, "Applications"), dir = join(root, "app-update");
  mkdirSync(apps);
  const target = join(apps, "Madani Bot.AppImage");
  writeFileSync(target, "old appimage bytes");
  chmodSync(target, 0o700);
  const w = { root, target, dir, fetched: [], relaunched: [], quits: 0, failures: [] };
  const installer = appImageInstaller({ target, dir, current, relaunch: (file) => w.relaunched.push(file), quit: () => { w.quits += 1; }, ...(fsImpl ? { fs: fsImpl } : {}) });
  w.updater = createAppUpdater({
    current, arch: "x64", dir, keys, platform: "linux", appImage: true, signed: async () => true,
    blocked: async () => blocked ?? appImagePlace(target), asset: appImageIn, sources: appImageSources, keep: [SWAPPED], installer,
    download: { wait: async () => {} },
    fetchImpl: async (url, init) => {
      w.fetched.push(init?.method === "HEAD" ? `HEAD ${url}` : url);
      const body = routes.get(url);
      return body === undefined ? new Response("no", { status: 404 }) : new Response(body);
    },
    quiet: async () => false, fallback: { check: async () => {} }, onFailed: (_m, info) => w.failures.push(info),
    timers: { setTimeout: () => 1, clearTimeout: () => {} },
  });
  return w;
}
const done = (w) => rmSync(w.root, { recursive: true, force: true });

test("an AppImage downloads its release, checked against the signed sums, and replaces its own file in place", async () => {
  const w = world();
  assert.equal(await w.updater.check(), "1.1.0");
  assert.equal(readFileSync(w.target, "utf8"), NEW);
  assert.equal(statSync(w.target).mode & 0o777, 0o755);
  assert.deepEqual(readdirSync(join(w.root, "Applications")), ["Madani Bot.AppImage"]);
  assert.equal(existsSync(join(w.dir, IMAGE)), false);
  assert.equal(swappedVersion(w.dir), "1.1.0");
  assert.equal(w.fetched.at(-1), mirrorUrl("1.1.0", IMAGE));
  assert.equal(w.updater.state().ready, "1.1.0");
  assert.equal(w.updater.restart(), true);
  assert.deepEqual(w.relaunched, [w.target]);
  assert.equal(w.quits, 1);
  done(w);
});

test("without madani.bot's copy it takes the downloads repo's stable AppImage", async () => {
  assert.deepEqual(appImageSources("1.1.0", IMAGE), [mirrorUrl("1.1.0", IMAGE), zipUrl("1.1.0", "MadaniBot.AppImage")]);
  const w = world({ served: undefined, routes: { [zipUrl("1.1.0", "MadaniBot.AppImage")]: Buffer.from(NEW) } });
  assert.equal(await w.updater.check(), "1.1.0");
  assert.equal(readFileSync(w.target, "utf8"), NEW);
  done(w);
});

test("an AppImage whose bytes do not match the signed sums is never put in place", async () => {
  const w = world({ served: Buffer.from("tampered bytes") });
  assert.equal(await w.updater.check(), null);
  assert.equal(readFileSync(w.target, "utf8"), "old appimage bytes");
  assert.equal(w.updater.state().failed, true);
  assert.equal(w.failures[0].stage, "checksum");
  assert.equal(swappedVersion(w.dir), null);
  done(w);
});

test("an AppImage in a folder it can't write gets a link to the new AppImage instead", async () => {
  const w = world({ blocked: "readonly" });
  assert.equal(await w.updater.check(), null);
  assert.deepEqual(w.updater.state().manual, { version: "1.1.0", url: mirrorUrl("1.1.0", IMAGE) });
  assert.equal(w.failures[0].reason, "read_only");
  assert.equal(readFileSync(w.target, "utf8"), "old appimage bytes");
  done(w);
});

test("a download on another disk is copied next to the AppImage and checked before the swap", async () => {
  let crossed = 0;
  const w = world({ fsImpl: { ...fs, renameSync: (from, to) => { if (!crossed++ && from.endsWith(IMAGE)) throw Object.assign(new Error("cross-device"), { code: "EXDEV" }); return fs.renameSync(from, to); } } });
  assert.equal(await w.updater.check(), "1.1.0");
  assert.equal(readFileSync(w.target, "utf8"), NEW);
  assert.deepEqual(readdirSync(join(w.root, "Applications")), ["Madani Bot.AppImage"]);
  done(w);
});

test("a swap that fails leaves the old AppImage and no part file", async () => {
  const w = world({ fsImpl: { ...fs, chmodSync: () => { throw Object.assign(new Error("not permitted"), { code: "EPERM" }); } } });
  assert.equal(await w.updater.check(), null);
  assert.equal(w.failures[0].stage, "install");
  assert.equal(readFileSync(w.target, "utf8"), "old appimage bytes");
  assert.deepEqual(readdirSync(join(w.root, "Applications")), ["Madani Bot.AppImage"]);
  done(w);
});

test("a version that was swapped in while this app stays older is offered by hand until the person asks again", async () => {
  const w = world();
  mkdirSync(w.dir, { recursive: true });
  writeFileSync(join(w.dir, SWAPPED), JSON.stringify({ version: "1.1.0" }));
  assert.equal(await w.updater.check(), null);
  assert.equal(w.updater.state().manual?.url, mirrorUrl("1.1.0", IMAGE));
  assert.equal(await w.updater.check({ again: true }), "1.1.0");
  done(w);
});

test("appImagePlace, the swapped file's mode and the relaunch arguments", () => {
  assert.equal(appImagePlace(undefined), "readonly");
  assert.equal(appImagePlace("relative.AppImage", { exists: () => true, writable: () => true }), "readonly");
  assert.equal(appImagePlace("/home/me/Madani.AppImage", { exists: () => false, writable: () => true }), "readonly");
  assert.equal(appImagePlace("/opt/Madani.AppImage", { exists: () => true, writable: () => false }), "readonly");
  assert.equal(appImagePlace("/home/me/Madani.AppImage", { exists: () => true, writable: () => true }), null);
  assert.equal(swappedMode(0o100700), 0o755);
  assert.equal(swappedMode(0o100775), 0o775);
  assert.deepEqual(relaunchArgs(["--no-sandbox", "madanibot://chat/1", "--madani-hidden", "--ozone-platform=wayland"]), ["--no-sandbox", "--ozone-platform=wayland"]);
});

test("appImageUpdates relaunches $APPIMAGE with the person's switches", () => {
  const calls = [];
  const app = { getVersion: () => "1.0.0", quit: () => calls.push("quit"), relaunch: (options) => calls.push(options) };
  const options = appImageUpdates({ app, dir: "/tmp/none", env: { APPIMAGE: "/home/me/Madani Bot.AppImage" }, argv: ["/tmp/.mount_x/madanibot", "--no-sandbox"] });
  assert.equal(options.platform, "linux");
  assert.equal(options.appImage, true);
  options.installer.install();
  assert.deepEqual(calls, [{ execPath: "/home/me/Madani Bot.AppImage", args: ["--no-sandbox"] }, "quit"]);
});
