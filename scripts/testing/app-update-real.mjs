// a real mac update without opening a window: unpacks a published older build into a temp folder, then runs this
// checkout's updater (electron/app-update.mjs) against the live signed manifest, SHA256SUMS and the real zip, with
// GitHub failing once and the madani.bot download dropping part way (both injected at fetch), so it falls back and
// resumes. the zip goes through squirrelInstaller's real 127.0.0.1 feed to a stand-in for Squirrel.Mac that does what
// Squirrel checks before a swap (unzip with ditto, the new app must satisfy the running app's designated requirement)
// and then swaps the bundle in the temp folder. Squirrel.Mac itself only runs inside the launched app, so not here.
//   node scripts/testing/app-update-real.mjs [--from 0.2.14] [--keep]
import { execFileSync, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAppUpdater, squirrelInstaller, zipUrl } from "../../electron/app-update.mjs";

const arg = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at > 0 ? process.argv[at + 1] : fallback; };
const from = arg("from", "0.2.14"), keep = process.argv.includes("--keep"), arch = process.arch;
const DROP_AT = 90 * 1024 * 1024;
const work = mkdtempSync(join(tmpdir(), "madani-update-real-"));
const run = (file, args) => execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const version = (app) => run("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", join(app, "Contents/Info.plist")]);
const say = (line) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);

say(`work folder ${work}`);
const oldZip = join(work, `MadaniBot-${from}-${arch}.zip`);
say(`REAL download of the published ${from} build`);
run("/usr/bin/curl", ["-fsSL", "--retry", "3", "-o", oldZip, zipUrl(from, `MadaniBot-${from}-${arch}.zip`)]);
mkdirSync(join(work, "Applications"));
run("/usr/bin/ditto", ["-x", "-k", oldZip, join(work, "Applications")]);
rmSync(oldZip);
const installed = join(work, "Applications", "Madani Bot.app");
const current = version(installed);
const shown = spawnSync("/usr/bin/codesign", ["-d", "-r-", installed], { encoding: "utf8" });
const requirement = /^designated => (.+)$/m.exec(`${shown.stdout}\n${shown.stderr}`)?.[1] ?? "";
if (!requirement) throw new Error("the old app has no designated requirement: is it signed?");
say(`old app ${current}, designated requirement: ${requirement.slice(0, 110)}...`);

const log = [];
let githubFailed = false, dropped = false;
async function fetchImpl(url, init = {}) {
  const range = init.headers?.range ?? null;
  if (url.endsWith(".zip") && url.startsWith("https://github.com/") && !githubFailed) {
    githubFailed = true;
    log.push(`SIMULATED  ${url} -> 503 (GitHub outage)`);
    return new Response("simulated outage", { status: 503 });
  }
  const answer = await fetch(url, init);
  log.push(`REAL       ${init.method ?? "GET"} ${url}${range ? ` (range ${range})` : ""} -> ${answer.status}`);
  if (url.endsWith(".zip") && url.startsWith("https://madani.bot/") && !dropped && answer.body) {
    dropped = true;
    let sent = 0;
    const cut = new TransformStream({ transform(chunk, controller) {
      sent += chunk.byteLength;
      if (sent > DROP_AT) { log.push(`SIMULATED  connection drop after ${Math.round(sent / 1048576)} MB`); controller.error(new TypeError("terminated")); return; }
      controller.enqueue(chunk);
    } });
    return new Response(answer.body.pipeThrough(cut), { status: answer.status, headers: answer.headers });
  }
  return answer;
}

/** stands in for Electron's autoUpdater: reads the feed and zip from squirrelInstaller's server, checks it as Squirrel.Mac would */
const staged = join(work, "staged");
const squirrel = Object.assign(new EventEmitter(), {
  feed: null, swapped: null,
  setFeedURL({ url }) { this.feed = url; },
  checkForUpdates() {
    void (async () => {
      const feed = await (await fetch(this.feed)).json();
      say(`REAL feed on 127.0.0.1 names ${feed.name}`);
      const zip = join(work, "squirrel-update.zip");
      writeFileSync(zip, Buffer.from(await (await fetch(feed.url)).arrayBuffer()));
      mkdirSync(staged);
      run("/usr/bin/ditto", ["-x", "-k", zip, staged]);
      run("/usr/bin/codesign", ["--verify", "--deep", "--strict", `-R=${requirement}`, join(staged, "Madani Bot.app")]);
      say(`REAL codesign: the new app satisfies the running app's designated requirement (Squirrel.Mac's check)`);
      this.emit("update-downloaded");
    })().catch((error) => this.emit("error", error));
  },
  quitAndInstall() {
    renameSync(installed, `${installed}.old`);
    renameSync(join(staged, "Madani Bot.app"), installed);
    rmSync(`${installed}.old`, { recursive: true, force: true });
    this.swapped = version(installed);
  },
});

const states = [];
const updater = createAppUpdater({
  current, arch, dir: join(work, "app-update"), fetchImpl, signed: async () => true, blocked: async () => null,
  installer: squirrelInstaller({ autoUpdater: squirrel }), quiet: async () => false, fallback: { check: async () => say("fallback notice") },
  log: say, onFailed: (message, info) => say(`FAILED ${info.stage}/${info.reason}: ${message}`),
  onState: (s) => { const tag = s.ready ? `ready ${s.ready}` : s.retrying ? `retrying at ${Math.round((s.progress ?? 0) * 100)}%` : s.progress !== null && s.progress !== undefined ? `downloading` : s.checking ? "checking" : "idle"; if (states.at(-1) !== tag) states.push(tag); },
});
const started = Date.now();
const ready = await updater.check();
say(`updater.check() -> ${ready} in ${Math.round((Date.now() - started) / 1000)}s`);
for (const line of log) console.log(`  ${line}`);
console.log(`  states: ${states.join(" > ")}`);
if (!ready) process.exit(1);
updater.restart();
say(`after the swap ${installed} is ${squirrel.swapped}`);
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", installed]);
say("REAL codesign --verify --deep --strict on the swapped app: ok");
updater.stop();
if (!keep) rmSync(work, { recursive: true, force: true });
process.exit(squirrel.swapped === ready ? 0 : 1);
