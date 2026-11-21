import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createLinkService } from "../apps/link-service/src/app.mjs";
import { jsonFile } from "./desktop-prefs.mjs";
import { createPhoneRelay, installPhoneRelay, phoneRelayStore, proxyFromResolved, systemProxy } from "./phone-relay.mjs";
import { createTunnelProxy, sealKeyOf, sha256hex, x25519Pair } from "./vps-link-protocol.mjs";

const linkRoot = fileURLToPath(new URL("../apps/link-service/", import.meta.url));
const OWNER = "owner-token-for-tests";
const ACCT = "0123456789abcdef0123456789abcdef";

const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});
async function until(check, ms = 8000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() >= end) throw new Error("did not reach the expected state");
    await delay(20);
  }
}
const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

function grantSigner() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x;
  return {
    keys: [{ kid: "test", x }],
    grant() {
      const iat = Date.now();
      const payload = Buffer.from(JSON.stringify({ v: 1, aud: "link", acct: ACCT, iat, exp: iat + 5 * 60_000 })).toString("base64url");
      const signature = sign(null, Buffer.from(`l1.test.${payload}`), privateKey).toString("base64url");
      return `l1.test.${payload}.${signature}`;
    },
  };
}

/** kept per workspace like the real store; `peek` reads the default workspace's entry */
function memoryStore() {
  const kept = new Map();
  return {
    read: async (at) => structuredClone(kept.get(at) ?? null),
    write: async (at, next) => { kept.set(at, structuredClone(next)); },
    peek: (at = "") => kept.get(at) ?? null,
    kept,
  };
}

/** a link service, a stand-in harness that answers the sync only for the owner token, and the pieces to drive them */
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "madani-phone-relay-"));
  const signer = grantSigner();
  const service = createLinkService({ base: "http://link.test", dataDir: join(dir, "data"), scriptPath: join(linkRoot, "install.sh"), agentPath: join(linkRoot, "agent.mjs"), trustProxy: false, grantKeys: signer.keys });
  const relayServer = createServer((req, res) => void service.handler(req, res));
  const base = `http://127.0.0.1:${await listen(relayServer)}`;
  const harness = { channels: [], rev: 1, syncs: [], seen: [], waiters: new Set() };
  const harnessServer = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const path = req.url.split("?", 1)[0];
      if (path === "/api/mobile/relay/sync") {
        if (req.headers["x-madani-desktop-owner"] !== OWNER) return json(res, 403, { error: "only the link agent on this server" });
        const input = JSON.parse(Buffer.concat(chunks).toString());
        harness.syncs.push(input);
        if (harness.rev > input.applied || !input.wait) return json(res, 200, { rev: harness.rev, channels: harness.channels });
        const reply = () => { clearTimeout(timer); harness.waiters.delete(reply); if (!res.destroyed) json(res, 200, { rev: harness.rev, channels: harness.channels }); };
        const timer = setTimeout(reply, 200);
        harness.waiters.add(reply);
        return;
      }
      harness.seen.push({ method: req.method, path, headers: req.headers });
      json(res, 200, { ok: true, path });
    });
  });
  const harnessPort = await listen(harnessServer);
  const proxies = [];
  let relay = null;
  t.after(async () => {
    relay?.stop();
    await relay?.settled();
    await Promise.all(proxies.map((proxy) => proxy.close()));
    service.close();
    for (const server of [relayServer, harnessServer]) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    base, service, harness, signer, dir,
    change(channels) { harness.channels = channels; harness.rev += 1; for (const reply of Array.from(harness.waiters)) reply(); },
    relay(overrides = {}) {
      relay = createPhoneRelay({
        base, wanted: () => true, signedIn: () => true, linkGrant: async () => signer.grant(), label: () => "test mac",
        store: memoryStore(), loadHub: () => import("../apps/link-service/agent.mjs"),
        port: () => harnessPort, ownerToken: () => OWNER, checkMs: 50, retryMs: [50], ...overrides,
      });
      return relay;
    },
    async phone(channel, key, token) {
      const proxy = createTunnelProxy({ base, id: channel, route: `${base}/v1/channels/${channel}`, key: key.toString("base64url"), token, replyTimeoutMs: 5000 });
      proxies.push(proxy);
      const origin = new URL(await proxy.start());
      return (path, init = {}) => fetch(`${origin.origin}${path}`, { ...init, signal: AbortSignal.timeout(8000) });
    },
  };
}

test("a signed-in computer makes its own tunnel and serves a paired phone end to end, as a remote client", async (t) => {
  const f = await fixture(t);
  const store = memoryStore();
  const relay = f.relay({ store });
  relay.start();
  await until(() => f.harness.syncs.length > 0);
  const { pub, tunnel } = f.harness.syncs[0];
  assert.match(tunnel, /^[a-z2-7]{10}$/);
  assert.equal(f.service.store.tunnels.get(tunnel)?.acct !== undefined, true, "the tunnel belongs to the account that granted it");
  assert.equal(store.peek().tunnel.id, tunnel);
  assert.equal(store.peek().keys.pub, pub);

  const phone = x25519Pair(), token = randomBytes(32).toString("base64url"), channel = "phoneaaaaa";
  f.change([{ id: channel, kind: "device", pub: phone.pub, verifier: sha256hex(token) }]);
  assert.equal((await relay.ready(5000)).status, "ready");
  await until(() => f.service.store.channels.has(channel));

  const get = await f.phone(channel, sealKeyOf(phone.priv, phone.pub, pub, channel), token);
  const answer = await get("/api/auth/session", { headers: { authorization: "Bearer madani_sess_phone", "x-madani-desktop-owner": OWNER, cookie: "a=b" } });
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { ok: true, path: "/api/auth/session" });
  const seen = f.harness.seen.at(-1);
  assert.equal(seen.headers.authorization, "Bearer madani_sess_phone");
  assert.equal(seen.headers["x-madani-desktop-owner"], undefined, "a phone can never carry the owner token");
  assert.equal(seen.headers.cookie, undefined);
  assert.match(seen.headers["x-forwarded-for"], /^198\.51\.100\./, "every phone request reaches the harness as remote");

  f.service.store.flush();
  const saved = readFileSync(join(f.dir, "data", "state.json"), "utf8");
  for (const secret of [token, store.peek().tunnel.token, store.peek().keys.priv]) assert.equal(saved.includes(secret), false, "the link service keeps no token or key");
});

test("a frame from anyone without the phone's key never reaches the harness", async (t) => {
  const f = await fixture(t);
  const relay = f.relay();
  relay.start();
  await until(() => f.harness.syncs.length > 0);
  const phone = x25519Pair(), token = randomBytes(32).toString("base64url"), channel = "phoneaaaab";
  f.change([{ id: channel, kind: "device", pub: phone.pub, verifier: sha256hex(token) }]);
  await relay.ready(5000);
  await until(() => f.service.store.channels.has(channel));
  const forged = await f.phone(channel, randomBytes(32), token);
  await assert.rejects(forged("/api/auth/session").then(async (response) => { if (!response.ok) throw new Error(String(response.status)); return response; }));
  assert.equal(f.harness.seen.length, 0);
});

test("without a madani account no tunnel is made and the state says so", async (t) => {
  const f = await fixture(t);
  const relay = f.relay({ linkGrant: async () => null, signedIn: () => false });
  assert.equal((await relay.ready(200)).status, "signed-out");
  assert.equal(f.service.store.tunnels.size, 0);
  assert.equal(f.harness.syncs.length, 0);
});

test("remote access off keeps the hub down", async (t) => {
  const f = await fixture(t);
  let wanted = false;
  const relay = f.relay({ wanted: () => wanted });
  assert.equal((await relay.ready(200)).status, "off");
  assert.equal(f.harness.syncs.length, 0);
  wanted = true;
  assert.equal((await relay.ready(5000)).status, "ready");
  wanted = false;
  assert.equal((await relay.ready(200)).status, "off");
});

test("a refused tunnel says why and tries again later", async (t) => {
  const f = await fixture(t);
  f.service.store.tunnels.clear();
  const relay = f.relay({ linkGrant: async () => "l1.test.bad.grant" });
  const state = await relay.ready(500);
  assert.equal(state.status, "error");
  assert.equal(state.code, "account_required");
});

test("a tunnel the link service dropped is made again with the same phone keys", async (t) => {
  const f = await fixture(t);
  const store = memoryStore();
  const relay = f.relay({ store });
  assert.equal((await relay.ready(5000)).status, "ready");
  const first = store.peek();
  const gone = await fetch(`${f.base}/v1/tunnels/${first.tunnel.id}`, { method: "DELETE", headers: { authorization: `Bearer ${first.tunnel.token}` } });
  assert.equal(gone.status, 200);
  f.change([]);
  await until(() => store.peek().tunnel && store.peek().tunnel.id !== first.tunnel.id);
  assert.equal(store.peek().keys.pub, first.keys.pub, "phones keep the key their channels were made with");
  await until(() => relay.state().status === "ready" && f.harness.syncs.at(-1).tunnel === store.peek().tunnel.id);
});

const reversing = { available: async () => true, encrypt: async (text) => Buffer.from([...Buffer.from(text)].reverse()), decrypt: async (bytes) => ({ result: Buffer.from([...bytes].reverse()).toString() }) };

test("the saved tunnel is encrypted, kept per workspace, and the first save works on a fresh install", async () => {
  const dir = mkdtempSync(join(tmpdir(), "madani-phone-relay-store-"));
  try {
    const store = phoneRelayStore({ jsonFile, userData: dir, encryption: reversing });
    assert.equal(await store.read("/data/one"), null);
    await store.write("/data/one", { tunnel: { id: "abcdefghij", token: "secret-token" } });
    assert.equal(readFileSync(join(dir, "phone-relay.json"), "utf8").includes("secret-token"), false);
    await store.write("/data/two", { tunnel: { id: "bcdefghijk", token: "other-token" } });
    assert.deepEqual(await store.read("/data/one"), { tunnel: { id: "abcdefghij", token: "secret-token" } });
    assert.deepEqual(await store.read("/data/two"), { tunnel: { id: "bcdefghijk", token: "other-token" } });
    assert.equal(await store.read("/data/three"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable store file is set aside, never overwritten in place", async () => {
  const dir = mkdtempSync(join(tmpdir(), "madani-phone-relay-store-"));
  try {
    writeFileSync(join(dir, "phone-relay.json"), "{not json");
    const store = phoneRelayStore({ jsonFile, userData: dir, encryption: reversing });
    assert.equal(await store.read("/data/one"), null);
    await store.write("/data/one", { tunnel: null });
    assert.ok(readdirSync(dir).some((name) => name.startsWith("phone-relay.json.unreadable-")));
    assert.deepEqual(await store.read("/data/one"), { tunnel: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a tunnel whose save failed is ended at once, so failed saves never use up the account's tunnels", async (t) => {
  const f = await fixture(t);
  const store = { read: async () => null, write: async () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); } };
  const relay = f.relay({ store });
  const state = await relay.ready(500);
  assert.equal(state.status, "error");
  assert.equal(state.code, "save_failed");
  assert.equal(f.service.store.tunnels.size, 0);
  assert.equal(f.harness.syncs.length, 0);
});

test("a workspace switch while its tunnel is made writes nothing for the other workspace and ends that tunnel", async (t) => {
  const f = await fixture(t);
  let folder = "/data/one";
  const store = memoryStore();
  const relay = f.relay({ store, scope: () => folder, fetch: async (url, init) => {
    if (String(url).endsWith("/result")) folder = "/data/two";
    return fetch(url, init);
  } });
  await relay.ready(500);
  await relay.settled();
  assert.equal(store.kept.size, 0, "no tunnel or key landed under either workspace");
  assert.equal(f.service.store.tunnels.size, 0, "the tunnel made for the first workspace was ended");
  assert.equal(f.harness.syncs.length, 0);
});

test("another workspace's harness never replaces a tunnel's channels", async (t) => {
  const f = await fixture(t);
  let folder = "/data/one";
  const store = memoryStore(), kept = store.kept;
  const relay = f.relay({ store, scope: () => folder });
  const phone = x25519Pair(), channel = "phoneaaaac";
  f.change([{ id: channel, kind: "device", pub: phone.pub, verifier: sha256hex("token") }]);
  assert.equal((await relay.ready(5000)).status, "ready");
  await until(() => f.service.store.channels.has(channel));
  const first = kept.get("/data/one").tunnel.id;
  folder = "/data/two";
  f.change([]);
  await until(() => kept.get("/data/two")?.tunnel && f.harness.syncs.at(-1).tunnel === kept.get("/data/two").tunnel.id && f.harness.syncs.at(-1).applied === f.harness.rev);
  assert.notEqual(kept.get("/data/two").tunnel.id, first);
  assert.equal(f.service.store.channels.get(channel)?.tunnel, first, "the first workspace's phone keeps its channel");
});

test("a phone request that lands after a workspace switch never reaches the other workspace's harness", async (t) => {
  const f = await fixture(t);
  let folder = "/data/one";
  const store = memoryStore();
  const relay = f.relay({ store, scope: () => folder, checkMs: 60_000 });
  const phone = x25519Pair(), token = randomBytes(32).toString("base64url"), channel = "phoneaaaad";
  f.change([{ id: channel, kind: "device", pub: phone.pub, verifier: sha256hex(token) }]);
  assert.equal((await relay.ready(5000)).status, "ready");
  await until(() => f.service.store.channels.has(channel));
  const { pub } = f.harness.syncs.at(-1);
  const get = await f.phone(channel, sealKeyOf(phone.priv, phone.pub, pub, channel), token);
  assert.equal((await get("/api/auth/session")).status, 200);
  const before = f.harness.seen.length;
  folder = "/data/two";
  const late = await get("/api/auth/session").then((response) => response.status, () => "failed");
  assert.notEqual(late, 200);
  assert.notEqual(late, 401);
  assert.equal(f.harness.seen.length, before, "the request never reached a harness");
});

test("a relay waiting out a failure tries again as soon as the computer wakes", async (t) => {
  const f = await fixture(t);
  let down = true;
  const relay = f.relay({ retryMs: [600_000], fetch: (...args) => (down ? Promise.reject(new TypeError("fetch failed")) : fetch(...args)) });
  relay.start();
  await until(() => relay.state().status === "error");
  down = false;
  await delay(200);
  assert.equal(relay.state().status, "error", "the failure's wait still holds");
  relay.wake();
  await until(() => relay.state().status === "ready");
});

test("the computer's proxy settings reach the relay hub: the first plain http proxy, or direct", async () => {
  assert.equal(proxyFromResolved("DIRECT"), null);
  assert.deepEqual(proxyFromResolved("PROXY proxy.corp:3128; DIRECT"), { host: "proxy.corp", port: 3128 });
  assert.deepEqual(proxyFromResolved("SOCKS5 s.corp:1080; PROXY [fd00::1]:8080"), { host: "fd00::1", port: 8080 });
  assert.equal(proxyFromResolved("SOCKS5 s.corp:1080"), null);
  assert.equal(proxyFromResolved(""), null);
  const asked = [];
  const proxy = systemProxy(() => ({ resolveProxy: async (url) => { asked.push(url); return "PROXY p.corp:8080"; } }));
  assert.deepEqual(await proxy(new URL("https://link.madani.bot/v1/x")), { host: "p.corp", port: 8080 });
  assert.deepEqual(asked, ["https://link.madani.bot/v1/x"]);
  assert.equal(await systemProxy(() => ({ resolveProxy: async () => { throw new Error("no"); } }))(new URL("https://link.madani.bot")), null);
});

test("installed before the app is ready, the relay still answers the page and asks for the proxy only when it dials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "madani-phone-relay-install-"));
  const before = process.env.MADANI_PHONE_RELAY;
  process.env.MADANI_PHONE_RELAY = "off";
  try {
    let ready = false;
    // electron 39's session.defaultSession getter throws until app ready
    const session = { get defaultSession() { if (!ready) throw new TypeError("Session can only be received when app is ready"); return { resolveProxy: async () => "DIRECT" }; } };
    const handlers = new Map();
    const relay = installPhoneRelay({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, guard: (_name, handler) => handler, session,
      jsonFile, userData: dir, dataDir: () => dir, encryption: { available: async () => false }, wanted: () => false,
      signedIn: () => false, linkGrant: async () => null, label: () => "test phones", port: () => 1, ownerToken: () => OWNER, log: () => {},
    });
    assert.deepEqual([...handlers.keys()].sort(), ["phone-relay:ready", "phone-relay:state"]);
    assert.equal(typeof relay.state().status, "string");
    ready = true;
  } finally {
    if (before === undefined) delete process.env.MADANI_PHONE_RELAY; else process.env.MADANI_PHONE_RELAY = before;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main installs the relay at load without reading the default session, which throws before app ready", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const wiring = main.split("\n").find((line) => line.includes('import("./phone-relay.mjs")'));
  assert.ok(wiring, "main.mjs imports the phone relay");
  const install = wiring.slice(wiring.indexOf('import("./phone-relay.mjs")'));
  assert.doesNotMatch(install.slice(0, install.indexOf("}));") + 3), /defaultSession/);
  assert.match(install, /installPhoneRelay\(\{[^}]*\bsession\b/);
  assert.match(install, /\.catch\(/, "a relay that cannot start is logged");
});
