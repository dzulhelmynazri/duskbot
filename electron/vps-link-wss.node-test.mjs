// the direct path over https on 443: the app's websocket connector (vps-link-direct.mjs) against the agent's real
// listener and direct hub (apps/link-service/agent.mjs) behind a tls front like caddy's, with the key pin checked.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { X509Certificate, createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer as createTlsServer } from "node:tls";

import { control, createDirectHub, frameGuard, listenDirectWss, spkiOf, wssUrl } from "../apps/link-service/agent.mjs";
import { orderedConnect, wsDuplex, wsFrame, wsReader, wssConnector } from "./vps-link-direct.mjs";
import { createPins } from "./vps-link-main.mjs";
import { createTunnelProxy } from "./vps-link-protocol.mjs";
import { createVpsLink } from "./vps-link.mjs";

const ID = "aaaaaaaaaa";
const KEY = Buffer.alloc(32, 7).toString("base64url");
const listen = (server, host = "127.0.0.1") => new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));
const until = async (check, ms = 4000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

let pem = null;
function certificate() {
  if (pem) return pem;
  const dir = mkdtempSync(join(tmpdir(), "madani-wss-cert-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "ignore" });
    pem = { key: readFileSync(join(dir, "key.pem"), "utf8"), cert: readFileSync(join(dir, "cert.pem"), "utf8") };
    pem.spki = createHash("sha256").update(new X509Certificate(pem.cert).publicKey.export({ type: "spki", format: "der" })).digest("base64");
    return pem;
  } catch { return null; } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("websocket frames: masked from the app, plain from the server, any length, read a byte at a time", () => {
  for (const size of [0, 5, 125, 126, 65535, 65536, 300_000]) {
    for (const masked of [true, false]) {
      const payload = Buffer.alloc(size, size % 251);
      const frame = wsFrame(2, payload, masked);
      const got = [];
      const read = wsReader({ masked, onData: (data) => got.push(data) });
      if (size < 70_000) for (const byte of frame) read(Buffer.from([byte]));
      else read(frame);
      assert.deepEqual(Buffer.concat(got), payload, `${size} bytes, masked ${masked}`);
    }
  }
  const pings = [], closes = [];
  const read = wsReader({ masked: true, onData: () => {}, onPing: (data) => pings.push(data.toString()), onClose: () => closes.push(true) });
  read(Buffer.concat([wsFrame(9, Buffer.from("hi"), true), wsFrame(8, Buffer.alloc(0), true)]));
  assert.deepEqual(pings, ["hi"]);
  assert.equal(closes.length, 1);
  assert.throws(() => wsReader({ masked: false, onData: () => {} })(wsFrame(2, Buffer.from("x"), true)), /masking/);
  assert.throws(() => wsReader({ masked: true, onData: () => {} })(wsFrame(1, Buffer.from("text"), true)), /binary/);
});

/** a tls front like caddy's: it ends tls and passes the bytes to the agent's loopback listener */
async function front(tls, upstreamPort) {
  const server = createTlsServer({ key: tls.key, cert: tls.cert }, (socket) => {
    const upstream = netConnect({ host: "127.0.0.1", port: upstreamPort });
    socket.pipe(upstream).pipe(socket);
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
  });
  return { server, port: await listen(server) };
}

async function rig(t) {
  const tls = certificate();
  if (!tls) { t.skip("no openssl here"); return null; }
  const madani = createServer((req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end(`${req.method} ${req.url} ${req.headers["x-forwarded-for"]}`); });
  const madaniPort = await listen(madani);
  const hub = createDirectHub({ id: ID, key: KEY, server: { host: "127.0.0.1", port: madaniPort }, guard: frameGuard(), log: () => {} });
  const ws = await listenDirectWss(hub, { port: 0, log: () => {} });
  const edge = await front(tls, ws.address().port);
  const url = `wss://127.0.0.1:${edge.port}/omb-direct`;
  const close = async () => { hub.stop(); await Promise.all([new Promise((resolve) => ws.close(resolve)), new Promise((resolve) => edge.server.close(resolve)), new Promise((resolve) => madani.close(resolve))]); };
  return { tls, hub, url, close };
}

test("over 443 the app's requests reach the server through the agent's websocket, sealed, and stay remote", async (t) => {
  const r = await rig(t);
  if (!r) return;
  const proxy = createTunnelProxy({ base: "https://relay.test", id: ID, key: KEY, token: "t", fetch: async () => new Promise(() => {}), direct: { connect: wssConnector({ url: r.url, spki: r.tls.spki, tls: { ca: r.tls.cert } }) } });
  try {
    const origin = await proxy.start();
    await until(() => proxy.transport() === "direct");
    assert.equal(proxy.directVia(), "wss");
    const url = new URL("/api/thing?x=1", origin);
    const text = await new Promise((resolve, reject) => request({ host: "127.0.0.1", port: url.port, path: url.pathname + url.search, headers: { host: url.host } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString()));
    }).on("error", reject).end());
    assert.equal(text, "GET /api/thing?x=1 192.0.2.10");
  } finally { await proxy.close(); await r.close(); }
});

test("the key the agent reads is the one the app pins (an ec key's spki der, not its bare point)", async (t) => {
  const tls = certificate();
  if (!tls) { t.skip("no openssl here"); return; }
  const server = createTlsServer({ key: tls.key, cert: tls.cert }, (socket) => socket.end());
  const port = await listen(server);
  try {
    const read = await spkiOf("127.0.0.1", port, { ca: tls.cert });
    assert.equal(read, tls.spki);
    const pins = createPins();
    pins.add("box.example", read);
    const verdict = await new Promise((resolve) => pins.verify({ hostname: "box.example", verificationResult: "net::OK", certificate: { data: tls.cert } }, resolve));
    assert.equal(verdict, 0, "a direct-mode link pins what the agent sent");
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("a server whose https key is not the pinned one is never used", async (t) => {
  const r = await rig(t);
  if (!r) return;
  try {
    const wrong = createHash("sha256").update("another key").digest("base64");
    await assert.rejects(wssConnector({ url: r.url, spki: wrong, tls: { ca: r.tls.cert } })(), (error) => error.code === "PIN");
    assert.equal(r.hub.size, 0, "nothing reached the agent");
    await assert.rejects(wssConnector({ url: r.url.replace("/omb-direct", "/elsewhere"), spki: r.tls.spki, tls: { ca: r.tls.cert } })(), (error) => error.code === "NOWSS");
  } finally { await r.close(); }
});

test("a websocket that is not the agent's, or carries text, is refused", async () => {
  const hub = { accepted: 0, accept() { this.accepted += 1; } };
  const ws = await listenDirectWss(hub, { port: 0, log: () => {} });
  try {
    const answer = await new Promise((resolve) => {
      const socket = netConnect({ host: "127.0.0.1", port: ws.address().port });
      socket.on("data", (chunk) => { resolve(chunk.toString("latin1").split("\r\n")[0]); socket.destroy(); });
      socket.write("GET /omb-direct HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n\r\n");
    });
    assert.equal(answer, "HTTP/1.1 404 Not Found", "no key, no websocket");
    assert.equal(hub.accepted, 0);
  } finally { await new Promise((resolve) => ws.close(resolve)); }
  const pair = new (await import("node:stream")).PassThrough();
  const errors = [];
  const duplex = wsDuplex(pair, { client: false });
  duplex.on("error", (error) => errors.push(error.message));
  pair.emit("data", wsFrame(1, Buffer.from("text"), true));
  await until(() => errors.length);
  assert.match(errors[0], /binary/);
});

test("connections that never open a frame cannot crowd the app out of the hub", async () => {
  const { PassThrough } = await import("node:stream");
  const hub = createDirectHub({ id: ID, key: KEY, server: { host: "127.0.0.1", port: 9 }, guard: frameGuard(), log: () => {}, max: 2 });
  const strangers = [hub.accept(new PassThrough(), new PassThrough()), hub.accept(new PassThrough(), new PassThrough())];
  assert.equal(hub.size, 2);
  const proxy = createTunnelProxy({ base: "https://relay.test", id: ID, key: KEY, token: "t", fetch: async () => new Promise(() => {}), direct: { connect: async () => {
    const up = new PassThrough(), down = new PassThrough();
    hub.accept(up, down);
    return { readable: down, writable: up, close: () => { up.destroy(); down.destroy(); } };
  } } });
  try {
    await proxy.start();
    await until(() => proxy.transport() === "direct");
    assert.ok(hub.best(), "the app got in");
    assert.equal(await Promise.race([strangers[0].done, new Promise((resolve) => setTimeout(() => resolve("still open"), 200))]), "stopped", "the oldest stranger made room");
  } finally { await proxy.close(); hub.stop(); }
});

test("ssh first, then 443; a transport that failed on this network goes last there, and a new network tries ssh again", async () => {
  let network = "home", sshUp = false;
  const tries = [];
  const connect = orderedConnect([
    { name: "ssh", connect: async () => { tries.push("ssh"); if (!sshUp) throw Object.assign(new Error("blocked"), { code: "ETIMEDOUT" }); return { kind: "ssh" }; } },
    { name: "wss", connect: async () => { tries.push("wss"); return { kind: "wss" }; } },
  ], { network: () => network });
  assert.equal((await connect()).via, "wss");
  assert.deepEqual(tries.splice(0), ["ssh", "wss"]);
  assert.equal((await connect()).via, "wss");
  assert.deepEqual(tries.splice(0), ["wss"], "a blocked port costs nothing on the next dial");
  network = "office";
  sshUp = true;
  assert.equal((await connect()).via, "ssh");
  assert.deepEqual(tries.splice(0), ["ssh"]);
  const failing = orderedConnect([
    { name: "ssh", connect: async () => { throw Object.assign(new Error("key"), { code: "HOSTKEY" }); } },
    { name: "wss", connect: async () => { throw Object.assign(new Error("pin"), { code: "PIN" }); } },
  ], { network: () => "x" });
  await assert.rejects(failing(), (error) => error.errors.map((one) => one.code).join() === "HOSTKEY,PIN");
});

test("the agent names its https address and key only when it has one", async () => {
  const before = process.env.MADANI_LINK_WSS_URL;
  try {
    delete process.env.MADANI_LINK_WSS_URL;
    assert.equal(wssUrl({ origin: "https://203-0-113-10.sslip.io" }), "wss://203-0-113-10.sslip.io/omb-direct");
    assert.equal(wssUrl({ origin: null }), null);
    await assert.rejects(control("direct-wss", {}, { id: ID, origin: null }), /no https address/);
    process.env.MADANI_LINK_WSS_URL = "wss://box.example.com/omb-direct";
    const asked = [];
    const answer = await control("direct-wss", {}, { id: ID, origin: null, spkiOf: async (host, port) => { asked.push([host, port]); return "K".repeat(43) + "="; } });
    assert.deepEqual(answer, { v: 1, url: "wss://box.example.com/omb-direct", spki: "K".repeat(43) + "=" });
    assert.deepEqual(asked, [["box.example.com", 443]]);
    process.env.MADANI_LINK_WSS_URL = "https://box.example.com/x";
    assert.throws(() => wssUrl({}), /not a wss/);
  } finally { if (before === undefined) delete process.env.MADANI_LINK_WSS_URL; else process.env.MADANI_LINK_WSS_URL = before; }
});

test("the app asks once for the server's https details, keeps them, and dials ssh then 443", async () => {
  let value = { v: 1, links: [{ id: ID, base: "https://relay.test", name: "box", mode: "relay", origin: null, port: null, keyP: `p:${KEY}`, tokenP: "p:t" }], current: ID };
  const saved = { read: () => value, write: (next) => { value = JSON.parse(JSON.stringify(next)); } };
  const make = (answers) => {
    const used = [], asked = [], built = [];
    const link = createVpsLink({
      base: "https://relay.test", serverFetch: async () => new Response("{}"), store: saved, protect: async (text) => `p:${text}`, unprotect: async (text) => text.slice(2),
      label: () => "Mac", saveServer: () => "env", forgetServer: () => {}, switchTo: () => {}, ownHome: { start: async () => {}, view: () => null, away: () => false, home: () => null, chosen: () => null },
      ownHomeReset: () => {}, localRequest: async () => new Response("{}"), backups: { save: async () => ({}), open: async () => ({}) },
      localCredentials: { codexAuth: async () => null, claudeCli: async () => null, claudeToken: async () => "" }, relaunch: () => {},
      proxyFactory: () => ({
        start: async () => "http://vps-aaaaaaaaaa.localhost:1", close: async () => {}, nudge: () => {},
        control: async (op) => { if (op === "hello") return answers.hello ?? { protocol: 2, caps: ["direct-ssh", "direct-wss"] }; asked.push(op); const answer = answers[op]; if (answer instanceof Error) throw answer; return answer; },
        useDirect: (spec) => used.push(spec),
      }),
      direct: {
        newKey: () => ({ privateKey: "PRIVATE-KEY", publicKey: "ssh-ed25519 PUB" }),
        connector: () => async () => { built.push("ssh"); throw Object.assign(new Error("blocked"), { code: "ETIMEDOUT" }); },
        wssConnector: (config) => async () => { built.push(`wss ${config.url}`); return { readable: null, writable: null, close() {}, via: "wss" }; },
      },
    });
    return { link, used, asked, built };
  };
  const ssh = { v: 1, host: "203.0.113.10", port: 22, user: "omb-link", hostKeys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHOST"] };
  const wss = { v: 1, url: "wss://box.example.com/omb-direct", spki: "K".repeat(43) + "=" };
  const first = make({ "direct-key": ssh, "direct-wss": wss });
  await first.link.resume();
  await until(() => first.used.length === 1);
  assert.deepEqual(first.asked.sort(), ["direct-key", "direct-wss"]);
  assert.equal(value.links[0].wss.url, wss.url);
  const got = await first.used[0].connect();
  assert.equal(got.via, "wss");
  assert.deepEqual(first.built, ["ssh", "wss wss://box.example.com/omb-direct"]);
  await first.link.close();

  const again = make({});
  await again.link.resume();
  await until(() => again.used.length === 1);
  assert.deepEqual(again.asked, [], "saved details are used without asking");
  await again.link.close();

  value = { v: 1, links: [{ id: ID, base: "https://relay.test", name: "box", mode: "relay", origin: null, port: null, keyP: `p:${KEY}`, tokenP: "p:t" }], current: ID };
  const lying = make({ "direct-key": new Error("unknown request"), "direct-wss": { ...wss, spki: "short" } });
  await lying.link.resume();
  await until(() => value.links[0].wssCheckedAt);
  assert.equal(lying.used.length, 0, "an answer that is not a usable pin is never trusted");
  assert.equal(value.links[0].wss, undefined);
  await lying.link.close();
});
