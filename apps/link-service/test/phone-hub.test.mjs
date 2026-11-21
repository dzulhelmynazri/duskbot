import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLinkService } from "../src/app.mjs";
import { createPhoneHub, createServing, harnessSync, noteRelayDate, sealKeyOf, x25519Pair } from "../agent.mjs";
import { createTunnelProxy, frameGuard, openFrame, sealFrame, sha256hex } from "../../../electron/vps-link-protocol.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const id = "abcdefghij", cid = "phoneaaaaa", second = "phoneaaaab";
const vps = "v".repeat(43), app = "a".repeat(43);
const address = (channel) => `198.51.100.${1 + (createHash("sha256").update(channel).digest()[0] % 254)}`;
const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});
async function until(check) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= end) throw new Error("fixture did not reach the expected state");
    await delay(10);
  }
}
const json = (res, body) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

it("refuses control before reading its data and filters a request path without its query", async () => {
  const frames = [], allow = vi.fn(() => false);
  let touched = false;
  const serving = createServing({ controls: false, allow, sink: { push: (frame) => frames.push(frame) } });
  await serving.handle({ t: "ctl", r: "control", op: "codex-auth", get data() { touched = true; return { auth: "{}" }; } });
  await serving.handle({ t: "req", r: "request", method: "POST", path: "/api/json?x=1" });
  expect(touched).toBe(false);
  expect(allow).toHaveBeenCalledWith("POST", "/api/json");
  expect(frames).toEqual([
    { t: "ctl", r: "control", ok: false, error: "not allowed" },
    { t: "err", r: "request", message: "This pairing channel only redeems its grant." },
  ]);
  serving.destroyAll();
});

it("answers a request frame node refuses with an error instead of crashing the agent", async () => {
  const frames = [];
  const serving = createServing({ controls: false, server: { host: "127.0.0.1", port: 9 }, sink: { push: (frame) => frames.push(frame) } });
  await serving.handle({ t: "req", r: "malformed", method: "POST", path: "/api/mobile/redeem", headers: { "bad header": "1" }, end: true });
  expect(frames).toEqual([{ t: "err", r: "malformed", message: "That request could not be sent." }]);
  serving.destroyAll();
});

describe("phone hub without sockets", () => {
  let hub, running, calls, registrations, replies, reader, syncing, replyStatus, registration;
  const agentKeys = x25519Pair(), key = Buffer.alloc(32, 7), anotherKey = Buffer.alloc(32, 8);
  const spec = (channel = cid, channelKey = key) => ({ id: channel, kind: "grant", verifier: sha256hex("phone token"), key: channelKey.toString("base64url"), expiresAt: Date.now() + 60_000 });
  const line = (value) => new TextEncoder().encode(`${JSON.stringify(value)}\n`);
  beforeEach(() => {
    calls = []; registrations = []; replies = []; reader = null; syncing = null; replyStatus = 200;
    registration = () => new Response('{"ok":true}', { status: 200 });
    hub = null; running = null;
  });
  afterEach(async () => { hub?.stop(); await running; });
  async function start(list = [spec()], { jsonRead = false } = {}) {
    hub = createPhoneHub({ base: "http://relay.test", id, token: vps, keys: agentKeys, log: () => {},
      sync: async (input) => {
        calls.push(input);
        if (calls.length === 1) return { rev: 1, channels: list };
        return new Promise((resolve, reject) => {
          syncing = resolve;
          input.signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
        });
      },
      fetchImpl: async (url, init) => {
        if (init.method === "PUT") { registrations.push(JSON.parse(init.body)); return registration(); }
        if (init.method === "POST") { replies.push({ channel: url.split("/").at(-2), ...JSON.parse(init.body) }); return new Response('{"ordered":true}', { status: replyStatus }); }
        if (jsonRead) return new Promise((resolve, reject) => {
          reader = (batch) => resolve(new Response(JSON.stringify({ batches: [batch] }), { headers: { "content-type": "application/json" } }));
          init.signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
        });
        return new Response(new ReadableStream({ start(controller) {
          reader = (batch) => controller.enqueue(line(batch));
          controller.enqueue(line({ frames: [] }));
          init.signal.addEventListener("abort", () => controller.error(new Error("stopped")), { once: true });
        } }), { headers: { "content-type": "application/x-ndjson" } });
      },
    });
    running = hub.run();
    await until(() => calls.length === 2 && reader);
  }
  const control = (channel = cid, channelKey = key, r = "controlaaaaa") => ({ channel, frames: [sealFrame(channelKey, channel, "to-vps", { t: "ctl", r, op: "ping" })] });

  it("says once when the channel sync and read are back after failing", async () => {
    const lines = [];
    let syncs = 0, reads = 0;
    hub = createPhoneHub({ base: "http://relay.test", id, token: vps, keys: agentKeys, log: (text) => lines.push(text),
      sync: async (input) => {
        syncs += 1;
        if (syncs === 1) throw new Error("relay unreachable");
        if (syncs === 2) return { rev: 1, channels: [spec()] };
        return new Promise((_resolve, reject) => input.signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true }));
      },
      fetchImpl: async (url, init) => {
        if (init.method === "PUT") return new Response('{"ok":true}', { status: 200 });
        reads += 1;
        if (reads === 1) return new Response("", { status: 502 });
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(line({ frames: [] }));
          init.signal.addEventListener("abort", () => controller.error(new Error("stopped")), { once: true });
        } }), { headers: { "content-type": "application/x-ndjson" } });
      },
    });
    running = hub.run();
    await until(() => lines.includes("link: phone channel sync is back after 1 retry") && lines.includes("link: phone channel read is back after 1 retry"));
    expect(lines.filter((text) => text.startsWith("link: phone channel sync"))).toEqual([
      "link: phone channel sync retrying (relay unreachable)", "link: phone channel sync is back after 1 retry",
    ]);
    expect(lines.filter((text) => text.startsWith("link: phone channel read"))).toEqual([
      "link: phone channel read retrying", "link: phone channel read is back after 1 retry",
    ]);
  });

  it("registers a pairing grant's end in the relay's time, so a computer whose clock is 30 minutes slow still opens its pairing channel", async () => {
    noteRelayDate(new Date(Date.now() + 30 * 60_000).toUTCString());
    try {
      const grant = spec();
      await start([grant]);
      const sent = registrations[0].channels[0].expiresAt;
      expect(sent - grant.expiresAt).toBeGreaterThan(29 * 60_000);
      expect(sent - grant.expiresAt).toBeLessThan(31 * 60_000);
    } finally { noteRelayDate(new Date().toUTCString()); }
  });

  it("opens each channel separately, drops replays and unknown channels, and seals replies for their owner", async () => {
    await start([spec(), spec(second, anotherKey)]);
    const first = control();
    reader({ channel: "unknownaaa", frames: first.frames });
    reader({ channel: second, frames: first.frames });
    reader(first);
    reader(first);
    reader(control(second, anotherKey));
    await until(() => replies.length === 2);
    expect(calls[0]).toMatchObject({ applied: 0, wait: 0 });
    expect(calls[1]).toMatchObject({ applied: 1, wait: 25, failed: [] });
    expect(registrations[0].channels.every((channel) => !channel.key && !channel.pub)).toBe(true);
    for (const reply of replies) {
      const channelKey = reply.channel === cid ? key : anotherKey;
      expect(reply.seq).toBe(0);
      expect(reply.epoch).toMatch(/^[a-z2-7]{12}$/);
      expect(reply.frames).toHaveLength(1);
      expect(openFrame(channelKey, reply.channel, "to-app", reply.frames[0], frameGuard())).toMatchObject({ t: "ctl", r: "controlaaaaa", ok: false, error: "not allowed" });
    }
    syncing({ rev: 2, channels: [spec(second, anotherKey)] });
    await until(() => calls.length === 3);
    reader(control());
    reader(control(second, anotherKey, "controlaaaab"));
    await until(() => replies.length === 3);
    expect(replies.at(-1).channel).toBe(second);
  });

  it("keeps a re-created channel's replay guard, so a relay cannot replay a frame after dropping it", async () => {
    await start([spec()]);
    const first = control();
    reader(first);
    await until(() => replies.length === 1);
    syncing({ rev: 2, channels: [] });
    await until(() => calls.length === 3);
    syncing({ rev: 3, channels: [spec()] });
    await until(() => calls.length === 4);
    reader(first);
    reader(control(cid, key, "controlaaaab"));
    await until(() => replies.length === 2);
    await delay(25);
    expect(replies).toHaveLength(2);
    expect(openFrame(key, cid, "to-app", replies[1].frames[0], frameGuard())).toMatchObject({ r: "controlaaaab" });
  });

  it("fails only the channel whose phone key no agreement can use", async () => {
    const zero = { id: second, kind: "device", verifier: sha256hex("t"), pub: Buffer.alloc(32).toString("base64url") };
    await start([spec(), zero]);
    expect(registrations[0].channels.map((channel) => channel.id)).toEqual([cid]);
    expect(calls[1]).toMatchObject({ applied: 1, failed: [second] });
  });

  it("leaves out every taken channel in turn, so one leftover tunnel never blocks the rest", async () => {
    const third = "phoneaaaac";
    registration = () => registrations.length === 1 ? new Response(JSON.stringify({ code: "taken", id: second }), { status: 409 })
      : registrations.length === 2 ? new Response(JSON.stringify({ code: "taken", id: third }), { status: 409 }) : new Response("{}", { status: 200 });
    await start([spec(), spec(second, anotherKey), spec(third, anotherKey)]);
    expect(registrations.map((body) => body.channels.map((channel) => channel.id))).toEqual([[cid, second, third], [cid, third], [cid]]);
    expect(calls[1]).toMatchObject({ applied: 1, failed: [second, third] });
  });

  it("retries a taken registration exactly once and reports the failed id at the applied revision", async () => {
    registration = () => registrations.length === 1 ? new Response(JSON.stringify({ code: "taken", id: second }), { status: 409 }) : new Response("{}", { status: 200 });
    await start([spec(), spec(second, anotherKey)]);
    expect(registrations.map((body) => body.channels.map((channel) => channel.id))).toEqual([[cid, second], [cid]]);
    expect(calls[1]).toMatchObject({ applied: 1, failed: [second], wait: 25 });
    syncing({ rev: 2, channels: [spec()] });
    await until(() => calls.length === 3);
    expect(calls[2]).toMatchObject({ applied: 2, failed: [] });
  });

  it("handles a JSON aggregate and drops a channel when its reply post returns 404", async () => {
    await start([spec()], { jsonRead: true });
    replyStatus = 404;
    const deliver = reader;
    deliver(control());
    await until(() => replies.length === 1 && reader !== deliver);
    reader(control());
    await delay(25);
    expect(replies).toHaveLength(1);
  });

  it("stops both loops when channel registration says the tunnel is gone", async () => {
    registration = () => new Response("{}", { status: 404 });
    hub = createPhoneHub({ base: "http://relay.test", id, token: vps, keys: agentKeys,
      sync: async () => ({ rev: 1, channels: [] }),
      fetchImpl: async (url, init) => init.method === "PUT" ? registration() : new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true })),
    });
    running = hub.run();
    await running;
  });
});

describe("phone relay hub", () => {
  let dir, service, relay, harness, base, server, keys, hub, running, channels, rev, seen, syncSeen;
  let sockets, timers, waiters, proxies, agentPosts, puts;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "omb-phone-hub-"));
    sockets = new Set(); timers = new Set(); waiters = new Set(); proxies = [];
    channels = []; rev = 1; seen = []; syncSeen = []; agentPosts = []; puts = [];
    hub = null; running = null;
    keys = x25519Pair();
    service = createLinkService({ base: "http://link.test", dataDir: join(dir, "data"), scriptPath: join(root, "install.sh"), agentPath: join(root, "agent.mjs"), trustProxy: false });
    service.store.tunnels.set(id, { id, createdAt: Date.now(), vpsVerifier: sha256hex(vps), appVerifier: sha256hex(app), seenAt: null });
    relay = createServer((req, res) => void service.handler(req, res));
    base = `http://127.0.0.1:${await listen(relay)}`;
    harness = createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        const path = req.url.split("?", 1)[0];
        if (path === "/api/mobile/relay/sync") {
          const input = JSON.parse(body.toString());
          syncSeen.push({ ...input, headers: req.headers });
          if (rev > input.applied || !input.wait) return json(res, { rev, channels });
          const reply = () => { clearTimeout(timer); timers.delete(timer); waiters.delete(reply); if (!res.destroyed) json(res, { rev, channels }); };
          const timer = setTimeout(reply, input.wait * 1000);
          timers.add(timer); waiters.add(reply);
          res.once("close", () => { clearTimeout(timer); timers.delete(timer); waiters.delete(reply); });
          return;
        }
        seen.push({ method: req.method, path, url: req.url, headers: req.headers });
        if (path === "/api/upload") return json(res, { length: body.length, sha256: sha256hex(body) });
        if (path === "/api/mobile/redeem") return json(res, { token: "omb_sess_test" });
        if (path === "/api/events") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write("data: one\n\n");
          const timer = setTimeout(() => { timers.delete(timer); res.end("data: two\n\n"); }, 300);
          timers.add(timer);
          return;
        }
        json(res, { ok: true });
      });
    });
    harness.on("upgrade", (req, socket, head) => {
      seen.push({ method: req.method, path: req.url.split("?", 1)[0], headers: req.headers });
      if (req.url !== "/ws") return socket.destroy();
      const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      if (head.length) socket.write(head);
      socket.pipe(socket);
    });
    for (const listener of [relay, harness]) listener.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
    server = { host: "127.0.0.1", port: await listen(harness) };
  });

  afterEach(async () => {
    hub?.stop();
    await running;
    await Promise.all(proxies.map((proxy) => proxy.close()));
    service?.close();
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    for (const listener of [relay, harness]) if (listener?.listening) {
      listener.closeAllConnections();
      await new Promise((resolve) => listener.close(resolve));
    }
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  function device(channel = cid) {
    const phone = x25519Pair(), token = randomBytes(32).toString("base64url");
    const key = sealKeyOf(phone.priv, phone.pub, keys.pub, channel);
    expect(key).toEqual(sealKeyOf(keys.priv, keys.pub, phone.pub, channel));
    return { channel, token, key, spec: { id: channel, kind: "device", pub: phone.pub, verifier: sha256hex(token) } };
  }
  function grant() {
    const token = randomBytes(32).toString("base64url"), key = randomBytes(32);
    return { channel: cid, token, key, spec: { id: cid, kind: "grant", key: key.toString("base64url"), verifier: sha256hex(token), expiresAt: Date.now() + 60_000 } };
  }
  function change(list) {
    channels = list;
    rev += 1;
    for (const reply of Array.from(waiters)) reply();
  }
  async function start(list, { polling = false, aheadMs, where } = {}) {
    change(list);
    hub = createPhoneHub({ base, id, token: vps, keys, server, sync: harnessSync(server), origin: "https://vps.example", spki: null, log: () => {}, ...(aheadMs ? { aheadMs } : {}), ...(where ? { where } : {}), fetchImpl: (url, init) => {
      if (init.method === "PUT") puts.push(JSON.parse(init.body));
      if (init.method === "POST") agentPosts.push({ url, ...JSON.parse(init.body) });
      return fetch(polling ? url.replace(/&stream=1$/, "") : url, init);
    } });
    running = hub.run();
    await until(() => syncSeen.some((input) => input.applied === rev));
  }
  async function phone(info) {
    const proxy = createTunnelProxy({ base, id: info.channel, route: `${base}/v1/channels/${info.channel}`, key: info.key.toString("base64url"), token: info.token, replyTimeoutMs: 5000 });
    proxies.push(proxy);
    const origin = new URL(await proxy.start());
    return { proxy, port: origin.port, host: origin.host, get: (path, init = {}) => fetch(`${origin.origin}${path}`, { ...init, signal: AbortSignal.timeout(8000) }) };
  }
  const post = (info, frames) => fetch(`${base}/v1/channels/${info.channel}/to-vps`, { method: "POST", headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json" }, body: JSON.stringify({ frames }) });

  it("tells the server where phones reach it now, each round, keeping the last one known when it cannot be read", async () => {
    const spki = `${"A".repeat(43)}=`;
    let address = { mode: "direct", via: "domain", origin: "https://box.example", spki };
    await start([], { where: async () => address });
    expect(syncSeen[0]).toMatchObject({ origin: "https://box.example", spki });
    address = { mode: "direct", via: "quick", origin: "https://new-name.trycloudflare.com", spki: null };
    change([]);
    await until(() => syncSeen.some((input) => input.origin === "https://new-name.trycloudflare.com"));
    address = null;
    change([]);
    await until(() => syncSeen.some((input) => input.applied === rev));
    expect(syncSeen.at(-1)).toMatchObject({ origin: "https://new-name.trycloudflare.com", spki: null });
    address = { mode: "relay", via: "relay", origin: null, spki: null };
    change([]);
    await until(() => syncSeen.at(-1).origin === null);
  });

  it("registers through owner loopback sync and only forwards the grant's three allowed paths", async () => {
    const info = grant();
    await start([info.spec]);
    expect(syncSeen[0]).toMatchObject({ base, tunnel: id, pub: keys.pub, applied: 0, failed: [], wait: 0, origin: "https://vps.example", spki: null, headers: { "x-madani-cli": "1" } });
    expect(syncSeen[1]).toMatchObject({ applied: rev, wait: 25 });
    expect(puts[0]).toEqual({ channels: [{ id: cid, verifier: info.spec.verifier, kind: "grant", expiresAt: info.spec.expiresAt }] });
    const client = await phone(info);
    expect(hub.usedAt()).toBe(0);
    const redeemed = await client.get("/api/mobile/redeem?attempt=1", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(await redeemed.json()).toEqual({ token: "omb_sess_test" });
    // a phone in use keeps the agent's self-update waiting, like the app does
    expect(hub.usedAt()).toBeGreaterThan(0);
    for (const path of ["/.well-known/madanibot/environment?x=1", "/api/health"]) expect((await client.get(path)).status).toBe(200);
    for (const [method, path] of [["GET", "/api/json"], ["POST", "/api/health"], ["GET", "/api/mobile/redeem"], ["GET", "/api/mobile/redeem/../relay/sync"]]) {
      const refused = await client.get(path, { method });
      expect(refused.status).toBe(502);
      expect(await refused.json()).toEqual({ error: "This pairing channel only redeems its grant." });
    }
    expect(seen.map((entry) => entry.path)).toEqual(["/api/mobile/redeem", "/.well-known/madanibot/environment", "/api/health"]);
  });

  it("serves a device's JSON request using its independently derived key", async () => {
    const info = device();
    await start([info.spec]);
    const client = await phone(info);
    expect(await (await client.get("/api/json")).json()).toEqual({ ok: true });
    expect(puts[0]).toEqual({ channels: [{ id: cid, verifier: info.spec.verifier, kind: "device" }] });
    expect(agentPosts.every((entry) => entry.url === `${base}/v1/tunnels/${id}/channels/${cid}/to-app`)).toBe(true);
  });

  it("preserves every byte of a 3 MB upload", async () => {
    const info = device();
    await start([info.spec]);
    const client = await phone(info), body = randomBytes(3 * 1024 * 1024);
    const response = await client.get("/api/upload", { method: "POST", body });
    expect(await response.json()).toEqual({ length: body.length, sha256: sha256hex(body) });
  });

  it("delivers the first SSE event while the second is still pending", async () => {
    const info = device();
    await start([info.spec]);
    const client = await phone(info), response = await client.get("/api/events");
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let first = "";
    while (!first.includes("\n\n")) {
      const { done, value } = await reader.read();
      if (done) break;
      first += decoder.decode(value);
    }
    expect(first).toContain("data: one");
    expect(first).not.toContain("data: two");
    let rest = "";
    for (;;) { const { done, value } = await reader.read(); if (done) break; rest += decoder.decode(value); }
    expect(rest).toContain("data: two");
  });

  it("echoes binary WebSocket bytes in both directions", async () => {
    const info = device();
    await start([info.spec]);
    const client = await phone(info);
    const socket = await new Promise((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: client.port, path: "/ws", headers: { host: client.host, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": randomBytes(16).toString("base64"), "x-madani-cli": "1", cookie: "owner=true" } });
      req.on("upgrade", (res, socket, head) => { expect(res.statusCode).toBe(101); expect(head.length).toBe(0); resolve(socket); });
      req.on("response", () => reject(new Error("upgrade refused")));
      req.on("error", reject);
      req.end();
    });
    try {
      const payload = randomBytes(256 * 1024 + 7), chunks = [];
      socket.on("data", (chunk) => chunks.push(chunk));
      socket.write(payload);
      await until(() => Buffer.concat(chunks).length >= payload.length);
      expect(Buffer.concat(chunks)).toEqual(payload);
      const headers = seen.find((entry) => entry.path === "/ws").headers;
      expect(headers["x-forwarded-for"]).toBe(address(cid));
      expect(headers["x-madani-cli"]).toBeUndefined();
      expect(headers.cookie).toBeUndefined();
    } finally { socket.destroy(); }
  });

  it("strips phone trust and cookie headers and supplies its channel's remote address", async () => {
    const info = device();
    await start([info.spec]);
    const client = await phone(info);
    await (await client.get("/api/json", { headers: { "X-Madani-Cli": "1", "x-madani-service": "owner", "x-madani-custom": "true", cookie: "session=owner", "x-forwarded-for": "127.0.0.1", authorization: "Bearer omb_sess_test" } })).text();
    expect(seen[0].headers["x-forwarded-for"]).toBe(address(cid));
    expect(Object.keys(seen[0].headers).some((name) => name.startsWith("x-madani-"))).toBe(false);
    expect(seen[0].headers.cookie).toBeUndefined();
    expect(seen[0].headers.authorization).toBe("Bearer omb_sess_test");
  });

  it("refuses a phone control frame without executing its credential write", async () => {
    const info = device(), file = join(dir, "phone-auth.json");
    vi.stubEnv("MADANI_LINK_CODEX_AUTH_FILE", file);
    await start([info.spec]);
    const client = await phone(info);
    await expect(client.proxy.control("codex-auth", { auth: "{}" })).rejects.toThrow("not allowed");
    expect(existsSync(file)).toBe(false);
    expect(seen).toEqual([]);
  });

  it("forgets a removed channel and answers the phone's next request with 502", async () => {
    const info = device();
    await start([info.spec]);
    const client = await phone(info);
    expect((await client.get("/api/json")).status).toBe(200);
    change([]);
    await until(() => syncSeen.some((input) => input.applied === rev));
    expect(service.store.channels.has(cid)).toBe(false);
    const response = await client.get("/api/json");
    expect(response.status).toBe(502);
    expect(seen).toHaveLength(1);
  });

  it("isolates two phones, including a frame sealed for the other channel", async () => {
    const one = device(), two = device(second);
    await start([one.spec, two.spec]);
    const first = await phone(one), next = await phone(two);
    await post(two, [sealFrame(one.key, cid, "to-vps", { t: "req", r: "wrong", method: "GET", path: "/crossed", end: true })]);
    const answers = await Promise.all([first.get("/api/json?phone=one"), next.get("/api/json?phone=two")]);
    expect(await Promise.all(answers.map((response) => response.json()))).toEqual([{ ok: true }, { ok: true }]);
    expect(seen.map((entry) => entry.url).sort()).toEqual(["/api/json?phone=one", "/api/json?phone=two"]);
    expect(seen.find((entry) => entry.url.endsWith("one")).headers["x-forwarded-for"]).toBe(address(cid));
    expect(seen.find((entry) => entry.url.endsWith("two")).headers["x-forwarded-for"]).toBe(address(second));
    const guards = new Map([[cid, frameGuard()], [second, frameGuard()]]);
    for (const entry of agentPosts) {
      const channel = entry.url.split("/").at(-2), owner = channel === cid ? one : two, other = channel === cid ? two : one;
      for (const sealed of entry.frames) {
        expect(openFrame(owner.key, channel, "to-app", sealed, guards.get(channel))).toBeTruthy();
        expect(() => openFrame(other.key, other.channel, "to-app", sealed, frameGuard())).toThrow();
      }
    }
  });

  it("reports a taken channel to the harness after retrying once without it", async () => {
    const one = device(), taken = device(second), other = "klmnopqrst";
    service.store.tunnels.set(other, { id: other, createdAt: Date.now(), vpsVerifier: sha256hex(vps), appVerifier: sha256hex(app), seenAt: null });
    service.store.channels.set(second, { id: second, tunnel: other, kind: "device", verifier: taken.spec.verifier, expiresAt: null, createdAt: Date.now(), seenAt: null });
    await start([one.spec, taken.spec]);
    expect(puts).toHaveLength(2);
    expect(puts[0].channels.map((channel) => channel.id)).toEqual([cid, second]);
    expect(puts[1].channels.map((channel) => channel.id)).toEqual([cid]);
    expect(syncSeen[1]).toMatchObject({ applied: rev, failed: [second] });
    expect(service.store.channels.get(second).tunnel).toBe(other);
    const client = await phone(one);
    expect((await client.get("/api/json")).status).toBe(200);
    change([one.spec]);
    await until(() => syncSeen.some((input) => input.applied === rev));
    expect(syncSeen.at(-1).failed).toEqual([]);
  });

  it("accepts aggregated JSON batches from a non-streaming relay", async () => {
    const info = device();
    await start([info.spec], { polling: true });
    const client = await phone(info);
    expect(await (await client.get("/api/json")).json()).toEqual({ ok: true });
  });
});
