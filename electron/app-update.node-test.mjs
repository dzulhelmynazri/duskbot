import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAppUpdater, DESKTOP_MANIFEST_URL, DOWNLOAD_PAGE, installerIn, installerUrl, justUpdated, LOOKUP_BACKOFF_MS, MANIFEST_SOURCES, mirrorUrl, OFFLINE_CHECKS_BEFORE_FAILED, POLICY_SOURCES, quietNow, RELEASE_KEYS, storedBucket, sumsUrl, updatePlace, verifiedRelease, zipIn, zipUrl } from "./app-update.mjs";
import { failReason, resumableDownload, UpdateError } from "./app-update-download.mjs";
import { updateFailStage } from "./experience-relay.mjs";

const { privateKey } = generateKeyPairSync("ed25519");
const keys = [{ kid: "test-desk", x: createPublicKey(privateKey).export({ format: "jwk" }).x }];
const sha = (value) => createHash("sha256").update(value).digest("hex");
function manifest(version, sums, kid = "test-desk", key = privateKey) {
  const head = `r1.${kid}.${Buffer.from(JSON.stringify({ v: 1, kind: "desktop", name: "madani bot", version, sha256: sha(sums), signedAt: 1 })).toString("base64url")}`;
  return { v: 1, version, sha256sums: sha(sums), signature: `${head}.${sign(null, Buffer.from(head), key).toString("base64url")}` };
}
const IDLE = { ready: null, available: null, progress: null, checking: false, failed: false, retrying: false, blocked: null, manual: null };
const noWait = { wait: async () => {} };

/** a Response for `body`, honouring a Range header like GitHub and madani.bot do */
function served(body, init = {}) {
  const bytes = Buffer.from(body);
  const range = /^bytes=(\d+)-$/.exec(init.headers?.range ?? "");
  if (range) {
    const from = Number(range[1]);
    if (from >= bytes.length) return new Response(null, { status: 416 });
    return new Response(bytes.subarray(from), { status: 206, headers: { "content-length": String(bytes.length - from), "content-range": `bytes ${from}-${bytes.length - 1}/${bytes.length}` } });
  }
  return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
}
/** a body that sends `bytes` and then fails ("drop", as a reset socket does) or goes quiet for good ("stall") */
function breaks(bytes, how, total = bytes.length * 4) {
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(bytes)); if (how === "drop") setTimeout(() => controller.error(new TypeError("terminated")), 5); } });
  return new Response(stream, { status: 200, headers: { "content-length": String(total) } });
}

/** a release `version` on the network, its zip `zip`, and an updater around it */
function world({ version = "1.1.0", current = "1.0.0", signed = true, zip = Buffer.from("zip bytes"), sumsZip = zip, manifestKey = privateKey, prepare = async () => {}, drop = [], blocked = null, installs = true, platform = "darwin", extra = {}, download = noWait, options = {} } = {}) {
  const sums = `${sha(sumsZip)}  MadaniBot-${version}-arm64.zip\n${sha("x")}  MadaniBot-${version}-x64.zip\n${sha("exe")}  MadaniBot-${version}-setup.exe\n${sha("deb")}  MadaniBot-${version}-amd64.deb\n`;
  const routes = new Map([
    [DESKTOP_MANIFEST_URL, JSON.stringify(manifest(version, sums, "test-desk", manifestKey))],
    [sumsUrl(version), sums],
    [zipUrl(version, `MadaniBot-${version}-arm64.zip`), zip],
    ...Object.entries(extra),
  ]);
  for (const url of drop) routes.delete(url);
  const w = { told: 0, prepared: [], installed: 0, states: [], fetched: [], failures: [], routes, dir: mkdtempSync(join(tmpdir(), "madani-app-update-")), quiet: false, timers: [] };
  w.updater = createAppUpdater({
    current, arch: "arm64", dir: w.dir, keys, signed: async () => signed, blocked: async () => blocked, installs, platform, download,
    fetchImpl: async (url, init) => {
      w.fetched.push(init?.method === "HEAD" ? `HEAD ${url}` : url);
      const body = routes.get(url);
      if (typeof body === "function") return body(init);
      return body === undefined ? new Response("no", { status: 404 }) : served(body, init);
    },
    installer: { prepare: async (file, v) => { w.prepared.push({ file, v, bytes: readFileSync(file) }); await prepare(); }, install: () => { w.installed += 1; } },
    quiet: async () => w.quiet, fallback: { check: async () => { w.told += 1; return null; } }, onState: (s) => w.states.push(s), onFailed: (m, info) => w.failures.push({ m, ...info }),
    timers: { setTimeout: (fn) => { w.timers.push(fn); return w.timers.length; }, clearTimeout: () => {} }, ...options,
  });
  return w;
}
const done = (w) => rmSync(w.dir, { recursive: true, force: true });

test("pins the same release keys as the service", () => {
  const pinned = readFileSync(new URL("../apps/cloud-service/src/release-signing.ts", import.meta.url), "utf8");
  const service = [...pinned.matchAll(/\{ kid: "([^"]+)", x: "([^"]+)" \}/g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(RELEASE_KEYS.map((k) => `${k.kid}:${k.x}`), service);
});

test("a newer signed release is downloaded, checked against the signed sums, and handed to the installer", async () => {
  const w = world();
  assert.equal(await w.updater.check(), "1.1.0");
  assert.equal(w.prepared.length, 1);
  assert.equal(w.prepared[0].v, "1.1.0");
  assert.equal(w.prepared[0].bytes.toString(), "zip bytes");
  assert.deepEqual(w.states.at(0), { ...IDLE, checking: true });
  assert.deepEqual(w.states.find((s) => s.available), { ...IDLE, available: "1.1.0", progress: 0, checking: true });
  assert.deepEqual(w.states.at(-1), { ...IDLE, ready: "1.1.0", available: "1.1.0" });
  assert.deepEqual(w.updater.state(), { ...IDLE, ready: "1.1.0", available: "1.1.0" });
  assert.equal(w.told, 0);
  done(w);
});

function policyDoc(policy, key = privateKey) {
  const body = JSON.stringify(policy);
  const head = `r1.test-desk.${Buffer.from(JSON.stringify({ v: 1, kind: "update-policy", name: "update-policy", version: String(policy.serial), sha256: sha(body), signedAt: 1 })).toString("base64url")}`;
  return JSON.stringify({ body, signature: `${head}.${sign(null, Buffer.from(head), key).toString("base64url")}` });
}

test("the signed update policy holds a paused, blocked or staged version back, and a newer policy lets it in", async () => {
  const paused = world({ extra: { [POLICY_SOURCES[0]]: policyDoc({ serial: 2, floor: null, blocked: [], paused: true }) } });
  assert.equal(await paused.updater.check(), null);
  assert.equal(paused.prepared.length, 0);
  assert.equal(paused.told, 0);
  paused.routes.set(POLICY_SOURCES[0], policyDoc({ serial: 3, floor: null, blocked: [] }));
  assert.equal(await paused.updater.check(), "1.1.0");
  done(paused);

  const forged = world({ extra: { [POLICY_SOURCES[0]]: policyDoc({ serial: 2, floor: null, blocked: [], paused: true }, generateKeyPairSync("ed25519").privateKey),
    [POLICY_SOURCES[1]]: policyDoc({ serial: 1, floor: null, blocked: ["1.1.0"] }) } });
  assert.equal(await forged.updater.check(), null);
  assert.equal(forged.prepared.length, 0);
  done(forged);

  const staged = (bucket) => world({ extra: { [POLICY_SOURCES[1]]: policyDoc({ serial: 1, floor: null, blocked: [], rollout: { "1.1.0": 20 } }) }, options: { bucket: () => bucket } });
  const inside = staged(19), outside = staged(20);
  assert.equal(await inside.updater.check(), "1.1.0");
  assert.equal(await outside.updater.check(), null);
  done(inside); done(outside);
});

test("a policy that pauses after the download keeps the quiet restart from happening", async () => {
  const w = world();
  await w.updater.check();
  w.routes.set(POLICY_SOURCES[0], policyDoc({ serial: 5, floor: null, blocked: [], paused: true }));
  await w.updater.check();
  w.quiet = true;
  await w.timers.shift()();
  assert.equal(w.installed, 0);
  done(w);
});

test("an install keeps its rollout bucket", () => {
  const dir = mkdtempSync(join(tmpdir(), "madani-bucket-")), file = join(dir, "b.json");
  assert.equal(storedBucket(file, () => 0.42), 42);
  assert.equal(storedBucket(file, () => 0.99), 42);
  rmSync(dir, { recursive: true, force: true });
});

test("it restarts into the update only at a quiet moment, or when the person asks", async () => {
  const w = world();
  await w.updater.check();
  await w.timers.shift()();
  assert.equal(w.installed, 0);
  w.quiet = true;
  await w.timers.shift()();
  assert.equal(w.installed, 1);
  assert.equal(w.updater.restart(), false);
  done(w);
  const asked = world();
  assert.equal(asked.updater.restart(), false);
  await asked.updater.check();
  assert.equal(asked.updater.restart(), true);
  assert.equal(asked.installed, 1);
  done(asked);
});

test("an unsigned build downloads nothing: it names the version and madani.bot, and tells the person", async () => {
  const w = world({ signed: false });
  assert.equal(await w.updater.check(), null);
  assert.equal(w.told, 1);
  assert.deepEqual(w.fetched, [DESKTOP_MANIFEST_URL, sumsUrl("1.1.0")]);
  assert.deepEqual(w.updater.state(), { ...IDLE, available: "1.1.0", manual: { version: "1.1.0", url: DOWNLOAD_PAGE } });
  done(w);
});

test("a forged manifest, sums that don't match it, or a zip that doesn't match its sum install nothing and tell the person", async () => {
  const forged = world({ manifestKey: generateKeyPairSync("ed25519").privateKey });
  const swapped = world({ zip: Buffer.from("other bytes"), sumsZip: Buffer.from("zip bytes") });
  for (const w of [forged, swapped]) {
    assert.equal(await w.updater.check(), null);
    assert.equal(w.prepared.length, 0);
    assert.equal(w.told, 1);
  }
  assert.deepEqual(forged.failures.map((f) => [f.stage, f.reason]), [["manifest", "not_signed"]]);
  assert.deepEqual(swapped.failures.map((f) => [f.stage, f.reason]), [["checksum", "checksum"]]);
  assert.equal(swapped.fetched.filter((u) => u === zipUrl("1.1.0", "MadaniBot-1.1.0-arm64.zip")).length, 2, "a mismatch is fetched once more from scratch, then given up");
  for (const w of [forged, swapped]) done(w);
});

test("nothing newer, nothing done; an installer that fails falls back to the notice", async () => {
  const same = world({ current: "1.1.0" });
  assert.equal(await same.updater.check(), null);
  assert.equal(same.told, 0);
  assert.deepEqual(same.updater.state(), IDLE);
  assert.deepEqual(same.states.map((s) => s.checking), [true, false], "a check is never silent: the window hears it start and end");
  done(same);
  const broken = world({ prepare: async () => { throw new Error("Could not get code signature for running application"); } });
  assert.equal(await broken.updater.check(), null);
  assert.equal(broken.told, 1);
  assert.equal(broken.states.some((s) => s.ready), false);
  assert.deepEqual(broken.updater.state(), { ...IDLE, available: "1.1.0", failed: true });
  assert.equal(broken.failures[0].stage, "install");
  assert.equal(broken.failures[0].reason, "install_could_not_get_code_signature_for");
  assert.equal(updateFailStage(broken.failures[0].m), "install", broken.failures[0].m);
  done(broken);
  const unpublished = world({ drop: [zipUrl("1.1.0", "MadaniBot-1.1.0-arm64.zip")] });
  assert.equal(await unpublished.updater.check(), null);
  assert.equal(unpublished.told, 1);
  assert.deepEqual([unpublished.failures[0].stage, unpublished.failures[0].reason], ["download", "http_404"]);
  done(unpublished);
});

test("the download's progress reaches the window in whole percents, and a failed one can be tried again", async () => {
  const w = world({ zip: Buffer.alloc(256 * 1024, 7) });
  await w.updater.check();
  const shown = w.states.map((s) => s.progress).filter((p) => p !== null);
  assert.equal(shown[0], 0);
  assert.ok(shown.length > 1 && shown.at(-1) > 0.5, `progress was told: ${shown}`);
  assert.ok(shown.every((p, i) => i === 0 || p >= shown[i - 1]), "progress only climbs");
  assert.ok(shown.every((p) => p <= 0.99 && Math.round(p * 100) === p * 100), "whole percents, never 100 before ready");
  done(w);
  let fail = true;
  const retry = world({ prepare: async () => { if (fail) { fail = false; throw new Error("busy"); } } });
  assert.equal(await retry.updater.check(), null);
  assert.deepEqual(retry.updater.state(), { ...IDLE, available: "1.1.0", failed: true });
  assert.equal(await retry.updater.check(), "1.1.0");
  assert.equal(retry.updater.state().ready, "1.1.0");
  done(retry);
});

test("a dropped download resumes from its .part with a Range request instead of starting over", async () => {
  const zip = Buffer.alloc(64 * 1024, 3);
  const url = zipUrl("1.1.0", "MadaniBot-1.1.0-arm64.zip");
  const asked = [];
  let tries = 0;
  const w = world({ zip, extra: { [url]: (init) => { asked.push(init?.headers?.range ?? null); tries += 1; return tries === 1 ? breaks(zip.subarray(0, 20_000), "drop", zip.length) : served(zip, init); } } });
  w.routes.set(mirrorUrl("1.1.0", "MadaniBot-1.1.0-arm64.zip"), (init) => { asked.push(`mirror ${init?.headers?.range ?? null}`); return served(zip, init); });
  assert.equal(await w.updater.check(), "1.1.0");
  assert.deepEqual(asked, [null, "mirror bytes=20000-"], "the second try asks the other source for the rest only");
  assert.equal(w.prepared[0].bytes.equals(zip), true);
  assert.ok(w.states.some((s) => s.retrying && s.progress !== null), "the window hears the download paused, with how far it got");
  assert.equal(w.states.at(-1).retrying, false);
  done(w);
});

test("GitHub failing (an error answer or no answer at all) falls back to madani.bot's copy", async () => {
  const zip = Buffer.from("the real zip");
  const name = "MadaniBot-1.1.0-arm64.zip";
  for (const github of [() => new Response("rate limited", { status: 403 }), () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }) }); }]) {
    const w = world({ zip, extra: { [zipUrl("1.1.0", name)]: github, [mirrorUrl("1.1.0", name)]: zip } });
    assert.equal(await w.updater.check(), "1.1.0");
    assert.deepEqual(w.fetched.filter((u) => u.endsWith(".zip")), [zipUrl("1.1.0", name), mirrorUrl("1.1.0", name)]);
    done(w);
  }
});

const dnsMiss = () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND madani.bot"), { code: "ENOTFOUND" }) }); };

test("madani.bot unreachable (DNS, a proxy) takes the signed manifest and its sums from the downloads repo", async () => {
  const probe = world();
  const manifestCopy = probe.routes.get(DESKTOP_MANIFEST_URL), sumsCopy = probe.routes.get(sumsUrl("1.1.0"));
  done(probe);
  const w = world({ extra: { [DESKTOP_MANIFEST_URL]: dnsMiss, [sumsUrl("1.1.0")]: dnsMiss, [MANIFEST_SOURCES[1]]: manifestCopy, [zipUrl("1.1.0", "SHA256SUMS")]: sumsCopy } });
  assert.equal(await w.updater.check(), "1.1.0");
  assert.deepEqual(w.fetched.slice(0, 4), [DESKTOP_MANIFEST_URL, MANIFEST_SOURCES[1], sumsUrl("1.1.0"), zipUrl("1.1.0", "SHA256SUMS")]);
  assert.deepEqual(w.failures, []);
  done(w);
  const forged = world({ extra: { [DESKTOP_MANIFEST_URL]: dnsMiss, [MANIFEST_SOURCES[1]]: JSON.stringify(manifest("1.1.0", "other sums", "test-desk", generateKeyPairSync("ed25519").privateKey)) } });
  assert.equal(await forged.updater.check(), null);
  assert.deepEqual(forged.failures.map((f) => [f.stage, f.reason]), [["manifest", "not_signed"]]);
  assert.equal(forged.prepared.length, 0);
  done(forged);
});

test("a network blip is waited out and tried again; an offline computer is not a failure until it lasts or the person asks", async () => {
  const probe = world();
  const manifestText = probe.routes.get(DESKTOP_MANIFEST_URL);
  done(probe);
  let hiccups = 2;
  const waits = [];
  const blip = world({ download: { wait: async (ms) => { waits.push(ms); } }, extra: { [DESKTOP_MANIFEST_URL]: (init) => (hiccups-- > 0 ? new Response("busy", { status: 503 }) : served(manifestText, init)), [MANIFEST_SOURCES[1]]: dnsMiss } });
  assert.equal(await blip.updater.check(), "1.1.0");
  assert.deepEqual(waits, LOOKUP_BACKOFF_MS);
  done(blip);

  const off = world({ extra: { [DESKTOP_MANIFEST_URL]: dnsMiss, [MANIFEST_SOURCES[1]]: () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); } } });
  for (let i = 1; i < OFFLINE_CHECKS_BEFORE_FAILED; i += 1) {
    assert.equal(await off.updater.check(), null);
    assert.equal(off.updater.state().failed, false);
  }
  assert.deepEqual([off.failures.length, off.told], [0, 0]);
  await off.updater.check();
  assert.deepEqual(off.failures.map((f) => [f.stage, f.reason]), [["manifest", "enotfound"]]);
  assert.equal(off.updater.state().failed, true);
  await off.updater.check({ again: true });
  assert.equal(off.failures.length, 2);
  done(off);
});

test("a connection that goes quiet is given up after the stall time and resumed, not waited on for half an hour", async () => {
  const dir = mkdtempSync(join(tmpdir(), "madani-stall-"));
  const zip = Buffer.alloc(10_000, 9);
  const seen = [];
  let tries = 0;
  const started = Date.now();
  await resumableDownload({ sources: ["https://a.test/z", "https://b.test/z"], file: join(dir, "z.zip"), sha256: sha(zip), stallMs: 80, wait: async () => {},
    fetchImpl: async (url, init) => { seen.push([url, init?.headers?.range ?? null]); tries += 1; return tries === 1 ? breaks(zip.subarray(0, 4000), "stall", zip.length) : served(zip, init); },
    onRetry: (error) => seen.push(failReason(error)) });
  assert.ok(Date.now() - started < 2_000);
  assert.deepEqual(seen, [["https://a.test/z", null], "stalled", ["https://b.test/z", "bytes=4000-"]]);
  assert.equal(readFileSync(join(dir, "z.zip")).equals(zip), true);
  rmSync(dir, { recursive: true, force: true });
});

test("a mac that wakes mid-download goes on at once from where it got", async () => {
  const zip = Buffer.alloc(30_000, 5);
  const url = zipUrl("1.1.0", "MadaniBot-1.1.0-arm64.zip");
  let tries = 0;
  const w = world({ zip, download: { stallMs: 60_000, wait: async (ms) => { assert.equal(ms, 0, "a wake waits for nothing"); } }, extra: { [url]: (init) => (++tries === 1 ? breaks(zip.subarray(0, 1000), "stall", zip.length) : served(zip, init)) } });
  w.routes.set(mirrorUrl("1.1.0", "MadaniBot-1.1.0-arm64.zip"), (init) => served(zip, init));
  const checking = w.updater.check();
  await new Promise((resolve) => setTimeout(resolve, 30));
  w.updater.soon();
  assert.equal(await checking, "1.1.0");
  done(w);
});

test("it gives up after its tries with the last reason, and a full disk stops at once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "madani-tries-"));
  let tries = 0;
  const waits = [];
  await assert.rejects(resumableDownload({ sources: ["https://a.test/z"], file: join(dir, "z.zip"), sha256: sha("z"), attempts: 3, wait: async (ms) => { waits.push(ms); },
    fetchImpl: async () => { tries += 1; return new Response("busy", { status: 503 }); } }), (error) => error instanceof UpdateError && error.code === "http_503" && error.stage === "download");
  assert.equal(tries, 3);
  assert.deepEqual(waits, [2_000, 5_000], "waits a little longer after each failed try");
  tries = 0;
  await assert.rejects(resumableDownload({ sources: ["https://a.test/z"], file: join(dir, "z.zip"), sha256: sha("z"), wait: async () => {},
    fetchImpl: async () => { tries += 1; throw Object.assign(new Error(`ENOSPC: no space left on device, write '${dir}/z.zip.part'`), { code: "ENOSPC" }); } }), (error) => error.code === "disk_full");
  assert.equal(tries, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("a .part longer than the file (416) is checked as it is, and a finished file is never fetched again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "madani-done-"));
  const zip = Buffer.from("all of it");
  writeFileSync(join(dir, "z.zip.part"), zip);
  const seen = [];
  await resumableDownload({ sources: ["https://a.test/z"], file: join(dir, "z.zip"), sha256: sha(zip), fetchImpl: async (url, init) => { seen.push(init?.headers?.range); return served(zip, init); } });
  assert.deepEqual(seen, ["bytes=9-"]);
  await resumableDownload({ sources: ["https://a.test/z"], file: join(dir, "z.zip"), sha256: sha(zip), fetchImpl: async () => { throw new Error("not again"); } });
  rmSync(dir, { recursive: true, force: true });
});

test("failure reasons are short words with no paths, urls or quoted text", () => {
  assert.equal(failReason(new TypeError("terminated", { cause: { code: "UND_ERR_SOCKET" } })), "terminated_und_err_socket");
  assert.equal(failReason(new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } })), "enotfound");
  assert.equal(failReason(Object.assign(new Error("EACCES: permission denied, open '/Users/sam/Library/x'"), { code: "EACCES" })), "no_access");
  assert.equal(failReason(new Error("Cannot update while running on a read-only volume. The application is on /Volumes/madani bot/MadaniBot.app")), "cannot_update_while_running_on_a_read_on");
  assert.equal(failReason(new Error("could not open /Users/sam/Library/Application Support/x and https://example.com/a?b=c 'sam@example.com'")), "could_not_open");
  assert.equal(failReason(new DOMException("The operation was aborted due to timeout", "TimeoutError")), "timeout");
  for (const reason of ["terminated_und_err_socket", "no_access", "cannot_update_while_running_on_a_read_on"]) assert.match(reason, /^[a-z][a-z0-9_]{0,39}$/);
  assert.equal(updateFailStage("terminated"), "download", "a dropped download is a download failure, not other");
});

test("a translocated or disk-image copy is asked to move, an unwritable folder downloads by hand, and nothing is downloaded", async () => {
  assert.equal(updatePlace("/private/var/folders/x/T/AppTranslocation/ABC/d/MadaniBot.app", () => true), "move");
  assert.equal(updatePlace("/Volumes/madani bot/MadaniBot.app", () => false), "move");
  assert.equal(updatePlace("/Applications/MadaniBot.app", () => false), "readonly");
  assert.equal(updatePlace("/Applications/MadaniBot.app", () => true), null);
  const move = world({ blocked: "move" });
  assert.equal(await move.updater.check(), null);
  assert.deepEqual(move.updater.state(), { ...IDLE, available: "1.1.0", blocked: "move" });
  await move.updater.check();
  assert.deepEqual(move.failures, [{ m: "translocated", stage: "other", reason: "translocated" }], "said once per version");
  assert.equal(move.fetched.some((u) => u.endsWith(".zip")), false);
  done(move);
  const readonly = world({ blocked: "readonly" });
  await readonly.updater.check();
  assert.deepEqual(readonly.updater.state().manual, { version: "1.1.0", url: DOWNLOAD_PAGE });
  assert.equal(readonly.failures[0].reason, "read_only");
  done(readonly);
});

test("Windows and Linux are given their own installer: madani.bot's copy, or the downloads repo's", async () => {
  const exe = mirrorUrl("1.1.0", "MadaniBot-1.1.0-setup.exe");
  const win = world({ installs: false, platform: "win32", extra: { [exe]: "exe" } });
  assert.equal(await win.updater.check(), null);
  assert.deepEqual(win.updater.state(), { ...IDLE, available: "1.1.0", manual: { version: "1.1.0", url: exe } });
  assert.equal(win.fetched.includes(`HEAD ${exe}`), true);
  assert.equal(win.fetched.some((u) => u.endsWith(".zip")), false);
  done(win);
  const linux = world({ installs: false, platform: "linux" });
  await linux.updater.check();
  assert.equal(linux.updater.state().manual.url, zipUrl("1.1.0", "MadaniBot-amd64.deb"), "no copy on madani.bot: the downloads repo's stable name");
  done(linux);
  assert.equal(installerIn(`${"a".repeat(64)}  MadaniBot-1.1.0-x86_64.AppImage\n`, "1.1.0", "linux", { appImage: true }), "MadaniBot-1.1.0-x86_64.AppImage");
  assert.equal(installerIn(`${"a".repeat(64)}  MadaniBot-1.1.0-amd64.deb\n`, "1.1.0", "linux", { appImage: true }), null);
  assert.equal(await installerUrl("1.1.0", null), DOWNLOAD_PAGE);
});

test("verifiedRelease and zipIn read only what they vouch for", () => {
  assert.equal(verifiedRelease({ signature: "r1.rel-2026-11.e30.AAAA" }), null);
  assert.equal(verifiedRelease({}), null);
  assert.deepEqual(zipIn(`${"a".repeat(64)}  MadaniBot-1.2.3-x64.zip\n`, "1.2.3", "x64"), { name: "MadaniBot-1.2.3-x64.zip", sha256: "a".repeat(64) });
  assert.equal(zipIn(`${"a".repeat(64)}  MadaniBot-1.2.3-x64.zip\n`, "1.2.3", "arm64"), null);
});

test("quiet: away (locked, or idle and not typing) and nothing running", async () => {
  const signals = (o = {}) => ({ locked: () => false, idleMs: () => 0, typedAt: () => 0, work: async () => null, busy: () => null, ...o });
  const now = 100 * 60_000;
  assert.equal(await quietNow(signals({ locked: () => true }), now), true);
  assert.equal(await quietNow(signals({ idleMs: () => 11 * 60_000 }), now), true);
  assert.equal(await quietNow(signals(), now), false);
  assert.equal(await quietNow(signals({ idleMs: () => 11 * 60_000, typedAt: () => now - 60_000 }), now), false);
  assert.equal(await quietNow(signals({ locked: () => true, work: async () => "bot" }), now), false);
  assert.equal(await quietNow(signals({ locked: () => true, work: async () => { throw new Error("no answer"); } }), now), false);
  assert.equal(await quietNow(signals({ locked: () => true, busy: () => "moving" }), now), false);
  assert.equal(await quietNow(signals({ idleMs: () => 11 * 60_000, focused: () => true }), now), false, "a focused window is in use");
  assert.equal(await quietNow(signals({ locked: () => true, focused: () => true }), now), true);
  assert.equal(await quietNow(signals({ idleMs: () => 11 * 60_000, busy: () => "dictation" }), now), false);
});

test("the first check comes soon after launch, and a wake checks again soon", async () => {
  const delays = [];
  const w = world();
  const updater = createAppUpdater({ current: "1.0.0", arch: "arm64", dir: w.dir, keys, signed: async () => false, installer: {}, quiet: async () => false, fallback: { check: async () => null },
    timers: { setTimeout: (_fn, ms) => { delays.push(ms); return delays.length; }, clearTimeout: () => {} } });
  updater.soon();
  assert.deepEqual(delays, [], "nothing before start");
  updater.start();
  assert.ok(delays[0] <= 30_000, `first check after ${delays[0]}ms`);
  updater.soon();
  assert.equal(delays[1], 30_000);
  done(w);
});

test("justUpdated says so once, for a newer version, and never on a first run unless this updater installed it", () => {
  const memory = (version) => { const m = { saved: version === undefined ? undefined : { version }, read: () => { if (!m.saved) throw new Error("ENOENT"); return m.saved; }, write: (v) => { m.saved = v; } }; return m; };
  const older = memory("0.2.12");
  assert.equal(justUpdated(older, "0.2.13"), true);
  assert.equal(justUpdated(older, "0.2.13"), false);
  assert.equal(justUpdated(memory("0.2.13"), "0.2.12"), false);
  const fresh = memory();
  assert.equal(justUpdated(fresh, "0.2.13"), false);
  assert.deepEqual(fresh.saved, { version: "0.2.13" });
  assert.equal(justUpdated(memory(), "0.2.13", () => true), true);
});

test("Squirrel.Mac gets the verified zip from a feed on 127.0.0.1 at an unguessable path, closed once it unpacked", async () => {
  const { EventEmitter } = await import("node:events");
  const { squirrelInstaller } = await import("./app-update.mjs");
  const { writeFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "madani-squirrel-"));
  const file = join(dir, "MadaniBot-1.1.0-arm64.zip");
  writeFileSync(file, "the zip");
  const updater = Object.assign(new EventEmitter(), {
    feed: null, quit: 0, got: null, guessed: null,
    setFeedURL({ url, serverType }) { assert.equal(serverType, "json"); this.feed = url; },
    checkForUpdates() {
      void (async () => {
        const feed = await (await fetch(this.feed)).json();
        assert.match(feed.url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/update\.zip$/);
        this.guessed = (await fetch(new URL("/update.zip", feed.url))).status;
        this.got = await (await fetch(feed.url)).text();
        this.emit("update-downloaded");
      })().catch((error) => this.emit("error", error));
    },
    quitAndInstall() { this.quit += 1; },
  });
  const installer = squirrelInstaller({ autoUpdater: updater });
  await installer.prepare(file, "1.1.0");
  assert.equal(updater.got, "the zip");
  assert.equal(updater.guessed, 404);
  await assert.rejects(fetch(updater.feed));
  installer.install();
  assert.equal(updater.quit, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("My Cloud's page, once it is home, hears this app's own update and may restart into it, as this computer's page does", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const preload = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");
  assert.match(/const HOME_PAGE = \[([^\]]*)\]/.exec(preload)?.[1] ?? "", /"appUpdate"/, "the home page's bridge has appUpdate");
  for (const channel of ["state", "restart", "download", "open", "move", "seen"]) {
    assert.match(main, new RegExp(`ipcMain\\.handle\\("app-update:${channel}", localOrHome\\("app-update:${channel}",`), channel);
  }
  const tell = /const tellAppUpdate = (.*)$/m.exec(main)?.[1] ?? "";
  assert.match(tell, /senderIsLocal\(page\) \|\| homeWindow\.homePage\(page\)/, "a ready update is pushed to the home page too");
});
