import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAppUpdater, DESKTOP_MANIFEST_URL, mirrorUrl, setupIn, setupSources, sumsUrl, zipUrl } from "./app-update.mjs";
import { nsisInstaller, setupArgs, TRIED, windowsPlace } from "./app-update-windows.mjs";

const { privateKey } = generateKeyPairSync("ed25519");
const keys = [{ kid: "test-desk", x: createPublicKey(privateKey).export({ format: "jwk" }).x }];
const sha = (value) => createHash("sha256").update(value).digest("hex");
function manifest(version, sums) {
  const head = `r1.test-desk.${Buffer.from(JSON.stringify({ v: 1, kind: "desktop", name: "madani bot", version, sha256: sha(sums), signedAt: 1 })).toString("base64url")}`;
  return { v: 1, version, sha256sums: sha(sums), signature: `${head}.${sign(null, Buffer.from(head), privateKey).toString("base64url")}` };
}

const SETUP = "MadaniBot-1.1.0-setup.exe";

function world({ exe = Buffer.from("setup bytes"), routes: extra = {}, installer = null, blocked = null } = {}) {
  const sums = `${sha("zip")}  MadaniBot-1.1.0-x64.zip\n${sha(Buffer.from("setup bytes"))}  ${SETUP}\n${sha("win zip")}  MadaniBot-1.1.0-win-x64.zip\n`;
  const routes = new Map([
    [DESKTOP_MANIFEST_URL, JSON.stringify(manifest("1.1.0", sums))],
    [sumsUrl("1.1.0"), sums],
    ...(exe ? [[mirrorUrl("1.1.0", SETUP), exe]] : []),
    ...Object.entries(extra),
  ]);
  const w = { fetched: [], prepared: [], installed: 0, failures: [], told: 0, dir: mkdtempSync(join(tmpdir(), "madani-win-update-")) };
  w.updater = createAppUpdater({
    current: "1.0.0", arch: "x64", dir: w.dir, keys, platform: "win32", signed: async () => true, blocked: async () => blocked,
    asset: setupIn, sources: setupSources, keep: [TRIED], download: { wait: async () => {} },
    fetchImpl: async (url, init) => {
      w.fetched.push(init?.method === "HEAD" ? `HEAD ${url}` : url);
      const body = routes.get(url);
      return body === undefined ? new Response("no", { status: 404 }) : new Response(body);
    },
    installer: installer?.(w) ?? { prepare: async (file, v) => { w.prepared.push({ file, v, bytes: readFileSync(file).toString() }); }, install: () => { w.installed += 1; } },
    quiet: async () => false, fallback: { check: async () => { w.told += 1; } }, onFailed: (m, info) => w.failures.push(info),
    timers: { setTimeout: () => 1, clearTimeout: () => {} },
  });
  return w;
}
const done = (w) => rmSync(w.dir, { recursive: true, force: true });

test("windows downloads the release's installer from madani.bot, checked against the signed sums", async () => {
  const w = world();
  assert.equal(await w.updater.check(), "1.1.0");
  assert.equal(w.prepared.length, 1);
  assert.equal(w.prepared[0].bytes, "setup bytes");
  assert.equal(w.prepared[0].file, join(w.dir, SETUP));
  assert.equal(w.fetched.at(-1), mirrorUrl("1.1.0", SETUP));
  assert.equal(w.updater.state().ready, "1.1.0");
  done(w);
});

test("without madani.bot's copy it takes the downloads repo's stable installer, and a changed one installs nothing", async () => {
  const repo = world({ exe: undefined, routes: { [zipUrl("1.1.0", "MadaniBot-setup.exe")]: Buffer.from("setup bytes") } });
  assert.deepEqual(setupSources("1.1.0", SETUP), [mirrorUrl("1.1.0", SETUP), zipUrl("1.1.0", "MadaniBot-setup.exe")]);
  assert.equal(await repo.updater.check(), "1.1.0");
  assert.equal(repo.prepared[0].bytes, "setup bytes");
  done(repo);

  const tampered = world({ exe: Buffer.from("evil bytes"), routes: { [zipUrl("1.1.0", "MadaniBot-setup.exe")]: Buffer.from("evil bytes") } });
  assert.equal(await tampered.updater.check(), null);
  assert.equal(tampered.prepared.length, 0);
  assert.equal(tampered.failures.at(-1).stage, "checksum");
  assert.equal(tampered.told, 1);
  done(tampered);
});

test("the installer runs silently on quit, starts the app again only for a restart, and never while Windows ends the session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "madani-nsis-"));
  const file = join(dir, SETUP);
  writeFileSync(file, "setup bytes");
  writeFileSync(`${file}:Zone.Identifier`, "[ZoneTransfer]\r\nZoneId=3\r\n");
  const make = () => {
    const runs = [], quits = [];
    const installer = nsisInstaller({ dir, current: "1.0.0", quit: () => quits.push(1), spawn: (cmd, args, options) => { runs.push({ cmd, args, options }); return { on() {}, unref() {} }; } });
    return { installer, runs, quits };
  };

  const idle = make();
  assert.equal(idle.installer.quitting(), false);
  assert.equal(idle.runs.length, 0);

  const restart = make();
  await restart.installer.prepare(file, "1.1.0");
  // windows reads `name:Zone.Identifier` as the file's mark; elsewhere it is a file of that name, gone the same way
  assert.equal(existsSync(`${file}:Zone.Identifier`), false);
  restart.installer.install();
  assert.equal(restart.quits.length, 1);
  assert.equal(restart.installer.quitting({ ending: true }), true);
  assert.deepEqual(restart.runs[0].args, ["/S", "--updated", "--force-run"]);
  assert.equal(restart.runs[0].cmd, file);
  assert.equal(restart.runs[0].options.detached, true);
  assert.equal(restart.runs[0].options.shell, undefined);
  assert.equal(restart.installer.quitting(), false);
  assert.equal(restart.runs.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, TRIED), "utf8")), { version: "1.1.0" });

  const plain = make();
  await plain.installer.prepare(file, "1.1.0");
  assert.equal(plain.installer.quitting(), true);
  assert.deepEqual(plain.runs[0].args, setupArgs(false));
  assert.deepEqual(setupArgs(false), ["/S", "--updated"]);

  const logoff = make();
  await logoff.installer.prepare(file, "1.1.0");
  assert.equal(logoff.installer.quitting({ ending: true }), false);
  assert.equal(logoff.runs.length, 0);

  const broken = nsisInstaller({ dir, current: "1.0.0", quit: () => {}, spawn: () => { throw Object.assign(new Error("blocked"), { code: "EACCES" }); } });
  await broken.prepare(file, "1.1.0");
  assert.equal(broken.quitting(), false);
  rmSync(dir, { recursive: true, force: true });
});

test("a version whose installer ran but did not install is offered by hand, until the person asks again", async () => {
  const later = nsisInstaller({ dir: "/nowhere", current: "1.0.0", quit: () => {} });
  assert.equal(later.failed("1.1.0"), false);

  const w = world({ installer: (w) => {
    writeFileSync(join(w.dir, TRIED), JSON.stringify({ version: "1.1.0" }));
    const real = nsisInstaller({ dir: w.dir, current: "1.0.0", quit: () => {} });
    return { ...real, prepare: async (file, v) => { w.prepared.push({ file, v }); await real.prepare(file, v); } };
  } });
  assert.equal(await w.updater.check(), null);
  assert.equal(w.prepared.length, 0);
  assert.deepEqual(w.updater.state().manual, { version: "1.1.0", url: mirrorUrl("1.1.0", SETUP) });
  assert.equal(w.failures.at(-1).reason, "did_not_install");
  assert.equal(await w.updater.check({ again: true }), "1.1.0");
  assert.equal(w.prepared.length, 1);
  assert.equal(existsSync(join(w.dir, TRIED)), true);
  assert.equal(w.updater.state().manual, null);
  done(w);

  const installed = mkdtempSync(join(tmpdir(), "madani-nsis-"));
  writeFileSync(join(installed, TRIED), JSON.stringify({ version: "1.1.0" }));
  assert.equal(nsisInstaller({ dir: installed, current: "1.1.0", quit: () => {} }).failed("1.1.0"), false);
  rmSync(installed, { recursive: true, force: true });
});

test("only an NSIS install it can write updates itself; the portable zip is pointed at the installer", async () => {
  const exe = join("C:", "Users", "a", "AppData", "Local", "Programs", "madani-bot", "Madani Bot.exe");
  assert.equal(windowsPlace(exe, { list: () => ["Madani Bot.exe", "Uninstall Madani Bot.exe"], writable: () => true }), null);
  assert.equal(windowsPlace(exe, { list: () => ["Madani Bot.exe", "Uninstall Madani Bot.exe"], writable: () => false }), "readonly");
  assert.equal(windowsPlace(exe, { list: () => ["Madani Bot.exe", "resources"], writable: () => true }), "portable");
  assert.equal(windowsPlace(exe, { list: () => { throw new Error("gone"); } }), "portable");

  const w = world({ blocked: "portable" });
  assert.equal(await w.updater.check(), null);
  assert.equal(w.prepared.length, 0);
  assert.deepEqual(w.updater.state().manual, { version: "1.1.0", url: mirrorUrl("1.1.0", SETUP) });
  assert.equal(w.failures.at(-1).reason, "portable");
  done(w);
});
