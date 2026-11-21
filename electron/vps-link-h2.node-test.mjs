// relayFetch: the relay transport over one http/2 connection, with keepAliveFetch behind it for an origin without h2
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { createSecureServer } from "node:http2";
import { connect as netConnect, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createLinkService } from "../apps/link-service/src/app.mjs";
import { createTunnelAgent, relayFetch as agentRelayFetch } from "../apps/link-service/agent.mjs";
import { createTunnelProxy, relayFetch, sha256hex } from "./vps-link-protocol.mjs";

let pem = null;
function certificate() {
  if (pem !== null) return pem;
  const dir = mkdtempSync(join(tmpdir(), "madani-h2-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "ignore" });
    pem = { key: readFileSync(join(dir, "key.pem"), "utf8"), cert: readFileSync(join(dir, "cert.pem"), "utf8") };
  } catch { pem = false; }
  finally { rmSync(dir, { recursive: true, force: true }); }
  return pem;
}

async function serve(server) {
  const connections = [];
  server.on("secureConnection", (socket) => connections.push({ alpn: socket.alpnProtocol, resumed: socket.isSessionReused() }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `https://127.0.0.1:${server.address().port}`, connections, close: async () => { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); } };
}

for (const [side, factory] of [["app", relayFetch], ["VPS", agentRelayFetch]]) {
  test(`${side} relay fetch carries concurrent requests and a streamed read over one http/2 connection`, { timeout: 10_000 }, async (t) => {
    const tls = certificate();
    if (!tls) { t.skip("no openssl here"); return; }
    const sessions = [];
    const server = createSecureServer({ ...tls, allowHTTP1: true }, (req, res) => {
      if (req.url === "/stream") {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.write("one\n");
        setTimeout(() => res.end("two\n"), 50);
        return;
      }
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => { res.writeHead(200, { "content-type": "text/plain", "x-method": req.method }); res.end(`${req.url}:${Buffer.concat(chunks)}`); });
    });
    server.on("session", (session) => sessions.push(session));
    const target = await serve(server);
    const go = factory({ tls: { ca: tls.cert } });
    try {
      let connected = 0;
      const first = await go(`${target.origin}/a`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x", onConnected: () => { connected += 1; } });
      assert.equal(first.status, 200);
      assert.equal(first.headers.get("x-method"), "POST");
      assert.equal(await first.text(), "/a:x");
      assert.equal(connected, 1);
      assert.equal(go.multiplexed(), true);
      assert.equal(go.postsInFlight(), 8);
      const streamed = await go(`${target.origin}/stream`);
      const reader = streamed.body.getReader();
      const replies = await Promise.all(Array.from({ length: 6 }, (_, i) => go(`${target.origin}/b${i}?q=1`).then((response) => response.text())));
      assert.deepEqual(replies, Array.from({ length: 6 }, (_, i) => `/b${i}?q=1:`));
      assert.equal(new TextDecoder().decode((await reader.read()).value), "one\n");
      assert.equal(new TextDecoder().decode((await reader.read()).value), "two\n");
      assert.equal((await reader.read()).done, true);
      assert.deepEqual(target.connections.map((one) => one.alpn), ["h2"]);
      assert.equal(sessions.length, 1);
    } finally {
      go.close();
      await target.close();
    }
  });

  test(`${side} relay fetch opens a fresh connection when the relay says goaway, and resumes tls after a reset`, { timeout: 10_000 }, async (t) => {
    const tls = certificate();
    if (!tls) { t.skip("no openssl here"); return; }
    const server = createSecureServer({ ...tls, allowHTTP1: true }, (req, res) => res.end("ok"));
    let latest = null;
    server.on("session", (session) => { latest = session; });
    const target = await serve(server);
    const go = factory({ tls: { ca: tls.cert } });
    try {
      assert.equal(await (await go(`${target.origin}/one`)).text(), "ok");
      latest.goaway();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(await (await go(`${target.origin}/two`)).text(), "ok");
      go.reset();
      assert.equal(await (await go(`${target.origin}/three`)).text(), "ok");
      assert.equal(target.connections.length, 3);
      assert.equal(target.connections[2].resumed, true);
    } finally {
      go.close();
      await target.close();
    }
  });

  test(`${side} relay fetch drops a connection that went silent and asks again on a fresh one`, { timeout: 10_000 }, async (t) => {
    const tls = certificate();
    if (!tls) { t.skip("no openssl here"); return; }
    const target = await serve(createSecureServer({ ...tls, allowHTTP1: true }, (req, res) => res.end(`ok ${req.url}`)));
    // a path that can go dead without closing, like a hotspot that changed under the app
    const pipes = [];
    const middle = createNetServer((inbound) => {
      const entry = { frozen: false };
      const outbound = netConnect(Number(new URL(target.origin).port), "127.0.0.1");
      inbound.on("data", (chunk) => { if (!entry.frozen) outbound.write(chunk); });
      outbound.on("data", (chunk) => { if (!entry.frozen) inbound.write(chunk); });
      for (const one of [inbound, outbound]) one.on("error", () => {});
      inbound.on("close", () => outbound.destroy());
      outbound.on("close", () => inbound.destroy());
      pipes.push(entry);
    });
    await new Promise((resolve) => middle.listen(0, "127.0.0.1", resolve));
    const go = factory({ tls: { ca: tls.cert }, dial: () => netConnect(middle.address().port, "127.0.0.1"), checkMs: 100, pingMs: 200 });
    try {
      assert.equal(await (await go(`${target.origin}/one`)).text(), "ok /one");
      for (const entry of pipes) entry.frozen = true;
      const started = Date.now();
      await assert.rejects(go(`${target.origin}/two`, { signal: AbortSignal.timeout(5000) }), (error) => error?.name !== "TimeoutError");
      assert.ok(Date.now() - started < 2000, `dropped after ${Date.now() - started} ms`);
      assert.equal(await (await go(`${target.origin}/three`)).text(), "ok /three");
      assert.equal(target.connections.length, 2);
    } finally {
      go.close();
      middle.close();
      await target.close();
    }
  });

  test(`${side} relay fetch falls back to keep-alive http/1.1 for a relay without h2`, { timeout: 10_000 }, async (t) => {
    const tls = certificate();
    if (!tls) { t.skip("no openssl here"); return; }
    const target = await serve(createHttpsServer(tls, (req, res) => res.end(`h1 ${req.url}`)));
    const go = factory({ tls: { ca: tls.cert } });
    try {
      assert.equal(await (await go(`${target.origin}/x`)).text(), "h1 /x");
      assert.equal(await (await go(`${target.origin}/y`)).text(), "h1 /y");
      assert.equal(go.multiplexed(), false);
      assert.equal(go.postsInFlight(), 3);
    } finally {
      go.close();
      await target.close();
    }
  });
}

test("an aborted request over http/2 rejects and leaves the connection usable", { timeout: 10_000 }, async (t) => {
  const tls = certificate();
  if (!tls) { t.skip("no openssl here"); return; }
  const target = await serve(createSecureServer({ ...tls, allowHTTP1: true }, (req, res) => { if (req.url === "/slow") setTimeout(() => res.end("late"), 2000); else res.end("ok"); }));
  const go = relayFetch({ tls: { ca: tls.cert } });
  try {
    const abort = new AbortController();
    const slow = go(`${target.origin}/slow`, { signal: abort.signal });
    setTimeout(() => abort.abort(new Error("stopped")), 30);
    await assert.rejects(slow, /stopped/);
    assert.equal(await (await go(`${target.origin}/fast`)).text(), "ok");
    assert.equal(target.connections.length, 1);
  } finally {
    go.close();
    await target.close();
  }
});

test("the tunnel runs end to end over an http/2 relay", { timeout: 10_000 }, async (t) => {
  const tls = certificate();
  if (!tls) { t.skip("no openssl here"); return; }
  const root = fileURLToPath(new URL("../apps/link-service/", import.meta.url));
  const service = createLinkService({ base: "https://fixture.invalid", scriptPath: `${root}install.sh`, agentPath: `${root}agent.mjs`, trustProxy: false });
  const credentials = { id: "abcdefghij", key: Buffer.alloc(32, 7).toString("base64url"), token: "a".repeat(43) };
  const vpsToken = "v".repeat(43);
  service.store.tunnels.set(credentials.id, { id: credentials.id, vpsVerifier: sha256hex(vpsToken), appVerifier: sha256hex(credentials.token) });
  const relay = await serve(createSecureServer({ ...tls, allowHTTP1: true }, (req, res) => void service.handler(req, res)));
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ path: req.url })); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const agentFetch = agentRelayFetch({ tls: { ca: tls.cert } });
  const appFetch = relayFetch({ tls: { ca: tls.cert } });
  const agent = createTunnelAgent({ ...credentials, base: relay.origin, token: vpsToken, server: { host: "127.0.0.1", port: server.address().port }, fetchImpl: agentFetch, log: () => {} });
  const running = agent.run();
  const proxy = createTunnelProxy({ ...credentials, base: relay.origin, fetch: appFetch, log: () => {} });
  try {
    const origin = new URL(await proxy.start());
    const { request } = await import("node:http");
    const replies = await Promise.all(Array.from({ length: 12 }, (_, i) => new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: origin.port, path: `/api/n${i}`, headers: { host: origin.host } }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString()).path));
      });
      req.on("error", reject);
      req.end();
    })));
    assert.deepEqual(replies, Array.from({ length: 12 }, (_, i) => `/api/n${i}`));
    assert.equal(appFetch.multiplexed(), true);
    assert.equal(agentFetch.multiplexed(), true);
    assert.deepEqual([...new Set(relay.connections.map((one) => one.alpn))], ["h2"]);
    assert.equal(relay.connections.length, 2);
  } finally {
    agent.stop();
    await running;
    await proxy.close();
    agentFetch.close();
    appFetch.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    service.close();
    await relay.close();
  }
});

test("app relay fetch never sends one origin's requests over another origin's http/2 connection, and warming a new origin moves it", { timeout: 10_000 }, async (t) => {
  const tls = certificate();
  if (!tls) { t.skip("no openssl here"); return; }
  const named = (name) => createSecureServer({ ...tls, allowHTTP1: true }, (req, res) => { res.writeHead(200, { "x-server": name }); res.end(`${name}:${req.httpVersion}`); });
  const a = await serve(named("a")), b = await serve(named("b"));
  const go = relayFetch({ tls: { ca: tls.cert } });
  try {
    const stopA = go.warm(a.origin);
    assert.equal(await (await go(`${a.origin}/x`)).text(), "a:2.0");
    // another origin (asking another node) while a is home: answered by b itself, over http/1.1
    assert.equal(await (await go(`${b.origin}/x`)).text(), "b:1.1");
    assert.equal(await (await go(`${a.origin}/x`)).text(), "a:2.0");
    // the tunnel moved to b: b gets the http/2 connection, a is asked over http/1.1
    stopA();
    const stopB = go.warm(b.origin);
    assert.equal(await (await go(`${b.origin}/x`)).text(), "b:2.0");
    assert.equal(await (await go(`${a.origin}/x`)).text(), "a:1.1");
    stopB();
  } finally { go.close(); await a.close(); await b.close(); }
});
