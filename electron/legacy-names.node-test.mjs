import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  aliasLegacyCookies, aliasLegacyEnv, aliasLegacyHeaders, carryLegacySafeStorageKey, devAppName, hasTokenPrefix, readHeader, withCurrentFormat, dataDirFor, defaultCompanionDir, defaultDataDir, fromLegacyLink,
  fromLegacyPath, isOwnAppId, isOwnHeader, LEGACY, migrateLegacyDir, migrateLegacyStorage, migrateLegacyUserData, safeStorageItem,
  toLegacyPath, withLegacyHeaders,
} from "./legacy-names.mjs";

const OLD = LEGACY.devName;
const home = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omb-legacy-names-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

test("old env names count as the new ones, and a new name already set wins", () => {
  assert.equal(aliasLegacyEnv({ OGB_PORT: "9" }).MADANI_PORT, "9");
  const env = aliasLegacyEnv({ [`${LEGACY.envPrefixes[0]}DATA_DIR`]: "/old", [`${LEGACY.envPrefixes[1]}TOKEN`]: "t", [`${LEGACY.envPrefixes[0]}PORT`]: "1", MADANI_PORT: "2" });
  assert.equal(env.MADANI_DATA_DIR, "/old");
  assert.equal(env.MADANI_TOKEN, "t");
  assert.equal(env.MADANI_PORT, "2");
  assert.equal(env[`${LEGACY.envPrefixes[0]}DATA_DIR`], undefined, "moved, so no secret stays under a name the env filters miss");
  const lower = aliasLegacyEnv({ [`${LEGACY.envPrefixes[0].toLowerCase()}cloud_ready_token`]: "t" });
  assert.deepEqual(lower, { MADANI_cloud_ready_token: "t" }, "windows spells env names in any case");
});

test("never adopts OpenMausBot's folders: the data and companion folders are always madani bot's own", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-off-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, LEGACY.dataDirName));
  fs.writeFileSync(path.join(home, LEGACY.dataDirName, "bots.json"), "[]");
  fs.mkdirSync(path.join(home, LEGACY.companionDirName));
  assert.equal(defaultDataDir(home), path.join(home, ".madanibot"));
  assert.equal(dataDirFor(undefined, home), path.join(home, ".madanibot"));
  assert.equal(defaultCompanionDir(home), path.join(home, ".madanibot-companion"));
  assert.ok(fs.existsSync(path.join(home, LEGACY.dataDirName, "bots.json")), "the old folder is left as it was");
  assert.ok(!fs.existsSync(path.join(home, ".madanibot")), "nothing is copied in");
});

test("a new folder that already holds data wins, and the old one is left as it was", (t) => {
  const dir = home(t);
  write(path.join(dir, LEGACY.dataDirName, "config.json"), "old");
  write(path.join(dir, ".madanibot", "config.json"), "new");
  assert.equal(defaultDataDir(dir), path.join(dir, ".madanibot"));
  assert.equal(fs.readFileSync(path.join(dir, LEGACY.dataDirName, "config.json"), "utf8"), "old");
  assert.ok(!fs.lstatSync(path.join(dir, LEGACY.dataDirName)).isSymbolicLink());
});

test("a move that fails keeps using the old folder where it is", (t) => {
  const dir = home(t);
  const old = path.join(dir, LEGACY.dataDirName);
  write(path.join(old, "config.json"), "{}");
  const refusing = { ...fs, renameSync: () => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); } };
  assert.equal(migrateLegacyDir(path.join(dir, ".madanibot"), old, { fs: refusing }), old);
  assert.ok(fs.existsSync(path.join(old, "config.json")));
});

test("electron's own folder is copied, not moved, without chromium's locks", (t) => {
  const appData = home(t);
  const old = path.join(appData, LEGACY.product);
  write(path.join(old, "credentials.bin"), "sealed");
  write(path.join(old, "Local Storage", "leveldb", "000001.log"), "prefs");
  write(path.join(old, "SingletonLock"), "x");
  const next = path.join(appData, "Madani Bot");
  assert.equal(migrateLegacyUserData(next, appData), true);
  assert.equal(fs.readFileSync(path.join(next, "credentials.bin"), "utf8"), "sealed");
  assert.equal(fs.readFileSync(path.join(next, "Local Storage", "leveldb", "000001.log"), "utf8"), "prefs");
  assert.ok(!fs.existsSync(path.join(next, "SingletonLock")));
  assert.equal(fs.readFileSync(path.join(old, "credentials.bin"), "utf8"), "sealed", "an older build started again finds its own");
  assert.equal(migrateLegacyUserData(next, appData), false, "once");
  const dev = home(t);
  write(path.join(dev, OLD, "window-state.json"), "{}");
  assert.equal(migrateLegacyUserData(path.join(dev, "madanibot"), dev, { packaged: false }), true);
});

test("the keychain key is copied under the new app name through stdin, only when the new one is missing", () => {
  const items = new Map([[`${LEGACY.product} Safe Storage|${LEGACY.product} Key`, "s3cret\"key"]]);
  const calls = [];
  const run = (args, input) => {
    calls.push({ args, input });
    if (args[0] === "-i") {
      const [, service, account, secret] = /-s "(.*)" -a "(.*)" -w "(.*)"\n$/.exec(input);
      items.set(`${service}|${account}`, secret.replace(/\\(.)/g, "$1"));
      return { status: 0 };
    }
    const key = `${args[2]}|${args[4]}`;
    return items.has(key) ? { status: 0, stdout: args.includes("-w") ? `${items.get(key)}\n` : "" } : { status: 44 };
  };
  assert.equal(carryLegacySafeStorageKey({ name: "Madani Bot", run }), "copied");
  const next = safeStorageItem("Madani Bot");
  assert.equal(items.get(`${next.service}|${next.account}`), "s3cret\"key");
  assert.ok(calls.every((call) => !call.args.some((arg) => arg.includes("s3cret"))), "never in a process list");
  assert.equal(carryLegacySafeStorageKey({ name: "Madani Bot", run }), "present");
  assert.equal(carryLegacySafeStorageKey({ name: "madanibot", packaged: false, run: () => ({ status: 44 }) }), "none");
});

test("the mac dev app's own keychain key starts as a copy of the shared one, readable by the dev electron without a prompt", () => {
  const items = new Map([["madanibot Safe Storage|madanibot Key", "shared"]]);
  const inputs = [];
  const run = (args, input) => {
    if (args[0] === "-i") {
      inputs.push(input);
      const [, service, account, secret] = /-s "(.*)" -a "(.*)" -T ".*" -w "(.*)"\n$/.exec(input);
      items.set(`${service}|${account}`, secret);
      return { status: 0 };
    }
    const key = `${args[2]}|${args[4]}`;
    return items.has(key) ? { status: 0, stdout: args.includes("-w") ? `${items.get(key)}\n` : "" } : { status: 44 };
  };
  const name = devAppName("madanibot");
  assert.equal(name, "madanibot dev");
  const carry = () => carryLegacySafeStorageKey({ name, packaged: false, from: ["madanibot", OLD], trust: "/x/Electron.app/Contents/MacOS/Electron", run });
  assert.equal(carry(), "copied");
  assert.equal(items.get("madanibot dev Safe Storage|madanibot dev Key"), "shared");
  assert.match(inputs[0], / -T "\/x\/Electron.app\/Contents\/MacOS\/Electron" /);
  assert.equal(carry(), "present");
  items.clear();
  assert.equal(carry(), "none", "a fresh mac: electron makes the dev key itself");
});

test("links with the old scheme open like new ones", () => {
  assert.equal(fromLegacyLink(`${OLD}://thread/t1?bot=b1`), "madanibot://thread/t1?bot=b1");
  assert.equal(fromLegacyLink(`${OLD.toUpperCase()}://cloud`), "madanibot://cloud");
  assert.equal(fromLegacyLink("madanibot://bot/b1"), "madanibot://bot/b1");
  assert.equal(fromLegacyLink("https://example.test/"), "https://example.test/");
});

test("old header names read as new ones; a proxy strips both; an old peer gets both", () => {
  const headers = aliasLegacyHeaders({ [`${LEGACY.headerPrefix}companion`]: "1", [`${LEGACY.headerPrefix}cli`]: "old", "x-madani-cli": "new" });
  assert.deepEqual(headers, { "x-madani-companion": "1", "x-madani-cli": "new" });
  assert.ok(isOwnHeader(`${LEGACY.headerPrefix}desktop-owner`) && isOwnHeader("X-Madani-Desktop-Owner") && !isOwnHeader("x-other"));
  assert.deepEqual(withLegacyHeaders({ "x-madani-cli": "1", accept: "a" }), { "x-madani-cli": "1", accept: "a", [`${LEGACY.headerPrefix}cli`]: "1", "x-omb-cli": "1" });
});

test("the old well-known path answers as the new one, and a server id under either name is ours", () => {
  assert.equal(fromLegacyPath(`${LEGACY.wellKnown}/environment`), "/.well-known/madanibot/environment");
  assert.equal(fromLegacyPath("/api/bots"), "/api/bots");
  assert.equal(toLegacyPath("/.well-known/madanibot/environment"), `${LEGACY.wellKnown}/environment`);
  assert.ok(isOwnAppId("madanibot") && isOwnAppId(LEGACY.appId) && !isOwnAppId("other"));
});

test("preferences saved under the old prefix carry over once; the new value wins", () => {
  const data = new Map([[`${LEGACY.storagePrefixes[0]}sidebarDensity`, "compact"], [`${LEGACY.storagePrefixes[0]}botPanelOpen.v1`, "1"], ["madanibot.botPanelOpen.v1", "0"], ["omb-skin", "madani"]]);
  const storage = { get length() { return data.size; }, key: (i) => [...data.keys()][i] ?? null, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) };
  data.set("omb.mobile.introSeen", "1");
  assert.equal(migrateLegacyStorage(storage), 3);
  assert.equal(data.get("madanibot.sidebarDensity"), "compact");
  assert.equal(data.get("madanibot.botPanelOpen.v1"), "0");
  assert.equal(data.get("madani-skin"), "madani", "the short-name keys move to madani-* and madani.*");
  assert.equal(data.get("madani.mobile.introSeen"), "1");
  assert.equal(migrateLegacyStorage(storage), 0);
});

test("x-omb-* headers and omb_* cookies read as the new names, and an old peer still gets x-omb-*", () => {
  const headers = aliasLegacyHeaders({ "x-omb-cloud-signature": "v1=a", "x-openmaus-secret": "s", "x-madani-cloud-nonce": "n", "x-omb-cloud-nonce": "old" });
  assert.deepEqual(headers, { "x-madani-cloud-signature": "v1=a", "x-madani-secret": "s", "x-madani-cloud-nonce": "n" });
  assert.ok(isOwnHeader("x-omb-poller") && isOwnHeader("x-madani-poller") && !isOwnHeader("x-other"));
  assert.equal(withLegacyHeaders({ "x-madani-background": "1" })["x-omb-background"], "1");
  assert.equal(readHeader(new Headers({ "x-omb-cloud-power": "asleep" }), "x-madani-cloud-power"), "asleep");
  assert.equal(readHeader(new Headers({ "x-omb-cloud-power": "waking", "x-madani-cloud-power": "asleep" }), "x-madani-cloud-power"), "asleep");
  assert.deepEqual(aliasLegacyCookies({ cookie: "omb_dash=a; omb_csrf=b; madani_csrf=c; theme=x" }), { cookie: "madani_dash=a; omb_csrf=b; madani_csrf=c; theme=x" });
});

test("tokens minted before the rename are still tokens", () => {
  assert.ok(hasTokenPrefix("omb_sess_abc", "sess") && hasTokenPrefix("madani_sess_abc", "sess"));
  assert.ok(!hasTokenPrefix("omb_pair_abc", "sess") && !hasTokenPrefix(undefined, "sess"));
});

test("a file from before the rename reads as the current format; the old well-known link path answers as the new one", () => {
  assert.deepEqual(withCurrentFormat({ format: "openmaus.package", version: 2 }), { format: "openmaus.package", version: 2 });
  const current = { format: "madani.team" };
  assert.equal(withCurrentFormat(current), current);
  assert.equal(withCurrentFormat("text"), "text");
  assert.equal(fromLegacyPath("/.well-known/omb-link/abc"), "/.well-known/madani-link/abc");
  assert.equal(toLegacyPath("/.well-known/madani-link/abc"), "/.well-known/omb-link/abc");
});

test("a folder electron opened before the copy ran is set aside when it holds only caches", (t) => {
  const appData = home(t);
  write(path.join(appData, OLD, "environments.json"), '{"activeId":"vps"}');
  write(path.join(appData, OLD, "vps-link.json"), "{}");
  const next = path.join(appData, "madanibot");
  write(path.join(next, "Cookies"), "cache");
  assert.equal(migrateLegacyUserData(next, appData, { packaged: false }), true);
  assert.equal(fs.readFileSync(path.join(next, "environments.json"), "utf8"), '{"activeId":"vps"}');
  assert.ok(fs.readdirSync(appData).some((name) => name.startsWith("madanibot.fresh-")), "the opened folder is kept aside, not deleted");
  write(path.join(next, "window-state.json"), "{}");
  assert.equal(migrateLegacyUserData(next, appData, { packaged: false }), false, "a used folder is never replaced");
});
