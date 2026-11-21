import assert from "node:assert/strict";
import { request, ServerResponse } from "node:http";
import { connect, Socket } from "node:net";
import { once } from "node:events";
import test from "node:test";

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createOutbox, createTunnelProxy, keepAliveFetch, openFrame, sealBytes, sealFrame } from "./vps-link-protocol.mjs";
import { createOutbox as createAgentOutbox, keepAliveFetch as agentKeepAliveFetch } from "../apps/link-service/agent.mjs";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const options = { base: "https://link.example.test", id: "aaaaaaaaaa", key: Buffer.alloc(32).toString("base64url"), token: "fixture-token" };

for (const [side, factory] of [["app", createOutbox], ["VPS", createAgentOutbox]]) {
  test(`${side} outbox sends a new control in the next batch despite a desktop backlog`, { timeout: 2000 }, async () => {
    const first = deferred(), release = deferred(), control = deferred(), complete = deferred();
    const abort = new AbortController();
    const posts = [];
    const bytes = Buffer.alloc(2 * 1024 * 1024);
    for (let index = 0; index < 16; index += 1) bytes.fill(index, index * 128 * 1024, (index + 1) * 128 * 1024);
    const outbox = factory({
      seal: (r, chunk) => `${r}:${chunk.toString("base64url")}`, delayMs: 0, signal: abort.signal,
      post: async (frames) => {
        posts.push(frames);
        if (posts.length === 1) { first.resolve(); await release.promise; }
        if (frames.includes("control")) control.resolve(posts.length);
        if (frames.includes("end")) complete.resolve();
        return true;
      },
    });
    try {
      outbox.push("head", "desktop");
      outbox.bytes("desktop", bytes);
      outbox.push("end", "desktop");
      await first.promise;
      outbox.push("control", "ping");
      release.resolve();
      assert.equal(await control.promise, 2);
      await complete.promise;
      assert.deepEqual(Buffer.concat(posts.flat().filter((value) => value.startsWith("desktop:")).map((value) => Buffer.from(value.slice(8), "base64url"))), bytes);
      assert.equal(posts[0][0], "head");
      assert.equal(posts.at(-1).at(-1), "end");
      assert.equal(posts.flat().filter((value) => value === "end").length, 1);
      for (const frames of posts) assert.ok(JSON.stringify({ frames }).length < 1_000_000);
    } finally {
      release.resolve();
      abort.abort();
    }
  });

  test(`${side} outbox discards a cancelled stream's queued frames while another stream proceeds`, { timeout: 2000 }, async () => {
    const first = deferred(), release = deferred(), complete = deferred();
    const abort = new AbortController();
    const posts = [];
    let resumed = false;
    const outbox = factory({
      seal: (r, chunk) => `${r}:${chunk.toString("base64url")}`, delayMs: 0, signal: abort.signal,
      post: async (frames) => {
        posts.push(frames);
        if (posts.length === 1) { first.resolve(); await release.promise; }
        if (frames.includes("healthy")) complete.resolve();
        return true;
      },
    });
    try {
      outbox.bytes("cancelled", Buffer.alloc(3 * 1024 * 1024));
      outbox.onDrain(() => { resumed = true; });
      await first.promise;
      outbox.discard("cancelled");
      outbox.push("cancel", "cancelled");
      outbox.push("healthy", "other");
      release.resolve();
      await complete.promise;
      assert.equal(posts.length, 2);
      assert.deepEqual(posts[1], ["cancel", "healthy"]);
      assert.equal(resumed, true);
    } finally {
      release.resolve();
      abort.abort();
    }
  });
}

test("closing the tunnel aborts both its pending poll and its pending upload", { timeout: 2000 }, async () => {
  const uploading = deferred();
  const aborted = new Set();
  const proxy = createTunnelProxy({ ...options, fetch: (url, init) => new Promise((_resolve, reject) => {
    const side = String(url).includes("/to-vps") ? "upload" : "poll";
    if (side === "upload") uploading.resolve();
    init.signal.addEventListener("abort", () => { aborted.add(side); reject(init.signal.reason); }, { once: true });
  }) });
  await proxy.start();
  const ping = proxy.control("ping").then(() => assert.fail("no response expected"), (error) => error.message);
  await uploading.promise;
  await proxy.close();
  assert.equal(await ping, "closed");
  assert.deepEqual([...aborted].sort(), ["poll", "upload"]);
});

test("an unlinked tunnel refuses new requests and controls immediately", { timeout: 2000 }, async () => {
  const proxy = createTunnelProxy({ ...options, fetch: async () => Response.json({}, { status: 404 }) });
  const origin = new URL(await proxy.start());
  await tick();
  await assert.rejects(proxy.control("ping"), /not connected/);
  const response = await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: origin.port, path: "/api/bots", headers: { host: origin.host } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(response, 502);
  await proxy.close();
});

test("a successful POST wakes a failed poll's retry delay for new controls", { timeout: 2000 }, async () => {
  const retrying = deferred();
  const key = Buffer.from(options.key, "base64url");
  let polls = 0, controlId;
  const proxy = createTunnelProxy({ ...options, log: retrying.resolve, fetch: async (url, init) => {
    if (String(url).includes("/to-vps")) {
      controlId = openFrame(key, options.id, "to-vps", JSON.parse(init.body).frames[0]).r;
      return Response.json({ ok: true });
    }
    if (++polls === 1) throw new Error("temporary poll disconnect");
    if (controlId) {
      const r = controlId;
      controlId = null;
      return Response.json({ frames: [sealFrame(key, options.id, "to-app", { t: "ctl", r, ok: true, data: { ok: true } })] });
    }
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  } });
  let deadline;
  try {
    await proxy.start();
    await retrying.promise;
    const ping = proxy.control("ping").catch((error) => ({ error: error.message }));
    const result = await Promise.race([ping, new Promise((resolve) => { deadline = setTimeout(() => resolve("retry delay"), 300); })]);
    assert.deepEqual(result, { ok: true });
  } finally {
    clearTimeout(deadline);
    await proxy.close();
  }
});

for (const [side, factory] of [["app", createOutbox], ["VPS", createAgentOutbox]]) {
  test(`${side} outbox posts one turn's frames together in the next turn, without waiting on a timer`, { timeout: 2000 }, async () => {
    const abort = new AbortController();
    const posts = [];
    const outbox = factory({ seal: (r, chunk) => `${r}:${chunk.length}`, delayMs: 0, signal: abort.signal, post: async (frames) => { posts.push(frames); return true; } });
    outbox.push("head", "aaaaaaaaaaaa");
    outbox.bytes("aaaaaaaaaaaa", Buffer.alloc(10));
    outbox.push("end", "aaaaaaaaaaaa");
    await tick();
    await tick();
    try {
      assert.deepEqual(posts, [["head", "aaaaaaaaaaaa:10", "end"]]);
    } finally { abort.abort(); }
  });
}

test("outbox cancellation clears queued bytes and releases a paused producer without posting", async () => {
  const abort = new AbortController();
  let posted = false, resumed = false;
  const outbox = createOutbox({ seal: () => "sealed", post: async () => { posted = true; }, delayMs: 1000, signal: abort.signal });
  assert.equal(outbox.bytes("aaaaaaaaaaaa", Buffer.alloc(3 * 1024 * 1024)), false);
  outbox.onDrain(() => { resumed = true; });
  abort.abort();
  await tick();
  assert.equal(outbox.size, 0);
  assert.equal(resumed, true);
  assert.equal(posted, false);
  outbox.push("late");
  outbox.bytes("aaaaaaaaaaaa", Buffer.alloc(10));
  assert.equal(outbox.size, 0);
});

test("a failed outbox post releases backpressure and permits a later flush", { timeout: 2000 }, async () => {
  const drained = deferred();
  const flushed = deferred();
  const errors = [];
  let posted = 0;
  const outbox = createOutbox({
    seal: () => "sealed", delayMs: 0,
    post: async () => { if (++posted === 1) throw new Error("offline"); flushed.resolve(); },
    onError: (error) => errors.push(error.message),
  });
  assert.equal(outbox.bytes("aaaaaaaaaaaa", Buffer.alloc(3 * 1024 * 1024)), false);
  outbox.onDrain(drained.resolve);
  await drained.promise;
  assert.deepEqual(errors, ["offline"]);
  assert.equal(outbox.size, 0);
  outbox.push("later");
  await flushed.promise;
  assert.equal(posted, 2);
});

test("a stalled HTTP response is bounded and cancelled while another response completes", { timeout: 5000 }, async () => {
  const key = Buffer.from(options.key, "base64url");
  const requests = new Map();
  const ready = deferred(), cancelled = deferred(), incoming = deferred();
  let firstPoll = true, maxBuffered = 0;
  const write = ServerResponse.prototype.write;
  ServerResponse.prototype.write = function (...args) {
    const result = write.apply(this, args);
    maxBuffered = Math.max(maxBuffered, this.writableLength);
    return result;
  };
  const proxy = createTunnelProxy({ ...options, fetch: async (url, init) => {
    if (String(url).includes("/to-vps")) {
      for (const sealed of JSON.parse(init.body).frames) {
        const frame = openFrame(key, options.id, "to-vps", sealed);
        if (frame.t === "req") { requests.set(frame.path, frame.r); if (requests.size === 2) ready.resolve(); }
        if (frame.t === "cancel") cancelled.resolve(frame.r);
      }
      return Response.json({});
    }
    if (firstPoll) { firstPoll = false; return incoming.promise; }
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  } });
  let slowReq;
  try {
    const origin = new URL(await proxy.start());
    const slow = new Promise((resolve) => {
      slowReq = request({ host: "127.0.0.1", port: origin.port, path: "/slow", headers: { host: origin.host } }, (res) => {
        res.pause();
        res.on("aborted", resolve);
        res.on("error", resolve);
      });
      slowReq.on("error", resolve);
      slowReq.end();
    });
    const healthy = new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: origin.port, path: "/healthy", headers: { host: origin.host } }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks).toString()));
      });
      req.on("error", reject);
      req.end();
    });
    await ready.promise;
    const slowId = requests.get("/slow"), healthyId = requests.get("/healthy");
    const frame = (value) => sealFrame(key, options.id, "to-app", value);
    const chunk = Buffer.alloc(128 * 1024);
    incoming.resolve(Response.json({ frames: [
      frame({ t: "head", r: slowId, status: 200 }),
      ...Array.from({ length: 128 }, () => sealBytes(key, options.id, "to-app", slowId, chunk)),
      frame({ t: "head", r: healthyId, status: 200 }),
      sealBytes(key, options.id, "to-app", healthyId, Buffer.from("healthy")),
      frame({ t: "end", r: healthyId }),
    ] }));
    assert.equal(await healthy, "healthy");
    assert.equal(await cancelled.promise, slowId);
    assert.ok(maxBuffered <= 8 * 1024 * 1024, `buffered ${maxBuffered} bytes`);
    slowReq.destroy();
    await slow;
  } finally {
    slowReq?.destroy();
    await proxy.close();
    ServerResponse.prototype.write = write;
  }
});

test("relay POST bodies are read to the end, so the next post reuses the connection", { timeout: 2000 }, async () => {
  let read = 0, cancelled = 0;
  const response = deferred();
  const proxy = createTunnelProxy({ ...options, fetch: async (url, init) => {
    if (String(url).includes("/to-vps")) return { ok: true, text: async () => { read += 1; response.resolve(); return "{\"ok\":true}"; }, body: { cancel: async () => { cancelled += 1; } } };
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  } });
  await proxy.start();
  const ping = proxy.control("ping").catch(() => {});
  await response.promise;
  assert.equal(read, 1);
  assert.equal(cancelled, 0);
  await proxy.close();
  await ping;
});

test("a stalled desktop socket is bounded and cancelled without blocking HTTP", { timeout: 5000 }, async () => {
  const key = Buffer.from(options.key, "base64url");
  const requests = new Map();
  const ready = deferred(), cancelled = deferred(), incoming = deferred();
  let firstPoll = true, maxBuffered = 0, proxyPort;
  const write = Socket.prototype.write;
  Socket.prototype.write = function (...args) {
    const result = write.apply(this, args);
    if (this.localPort === proxyPort) maxBuffered = Math.max(maxBuffered, this.writableLength);
    return result;
  };
  const proxy = createTunnelProxy({ ...options, fetch: async (url, init) => {
    if (String(url).includes("/to-vps")) {
      for (const sealed of JSON.parse(init.body).frames) {
        const frame = openFrame(key, options.id, "to-vps", sealed);
        if (frame.t === "req") { requests.set(frame.path, frame.r); if (requests.size === 2) ready.resolve(); }
        if (frame.t === "cancel") cancelled.resolve(frame.r);
      }
      return Response.json({});
    }
    if (firstPoll) { firstPoll = false; return incoming.promise; }
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  } });
  let desktop;
  try {
    const origin = new URL(await proxy.start());
    proxyPort = Number(origin.port);
    desktop = connect(proxyPort, "127.0.0.1");
    desktop.on("error", () => {});
    await once(desktop, "connect");
    desktop.write(`GET /desktop HTTP/1.1\r\nHost: ${origin.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
    desktop.pause();
    const healthy = new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: proxyPort, path: "/healthy", headers: { host: origin.host } }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks).toString()));
      });
      req.on("error", reject);
      req.end();
    });
    await ready.promise;
    const desktopId = requests.get("/desktop"), healthyId = requests.get("/healthy");
    const frame = (value) => sealFrame(key, options.id, "to-app", value);
    const chunk = Buffer.alloc(128 * 1024);
    incoming.resolve(Response.json({ frames: [
      frame({ t: "head", r: desktopId, status: 101 }),
      ...Array.from({ length: 128 }, () => sealBytes(key, options.id, "to-app", desktopId, chunk)),
      frame({ t: "head", r: healthyId, status: 200 }),
      sealBytes(key, options.id, "to-app", healthyId, Buffer.from("healthy")),
      frame({ t: "end", r: healthyId }),
    ] }));
    assert.equal(await healthy, "healthy");
    assert.equal(await cancelled.promise, desktopId);
    assert.ok(maxBuffered <= 8 * 1024 * 1024, `buffered ${maxBuffered} bytes`);
  } finally {
    desktop?.destroy();
    await proxy.close();
    Socket.prototype.write = write;
  }
});

test("a streamed read a proxy holds back falls back to plain long polls", { timeout: 3000 }, async () => {
  const urls = [];
  const fellBack = deferred();
  const lines = [];
  const proxy = createTunnelProxy({ ...options, stallMs: 50, log: (line) => lines.push(line), fetch: (url, init) => {
    urls.push(String(url));
    if (String(url).includes("&stream=1")) return Promise.resolve(new Response(new ReadableStream({ start(controller) { init.signal.addEventListener("abort", () => controller.error(init.signal.reason), { once: true }); } }), { headers: { "content-type": "application/x-ndjson" } }));
    fellBack.resolve();
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  } });
  await proxy.start();
  await fellBack.promise;
  assert.ok(urls[0].includes("/to-app?wait=25&stream=1"));
  assert.ok(urls.at(-1).endsWith("/to-app?wait=25"));
  assert.ok(lines.some((line) => line.includes("polling instead")));
  await proxy.close();
});

test("the keep-alive fetch reuses one socket across posts", { timeout: 3000 }, async () => {
  const { createServer } = await import("node:http");
  const { keepAliveFetch } = await import("./vps-link-protocol.mjs");
  const sockets = new Set();
  const server = createServer((req, res) => { sockets.add(req.socket); req.resume(); req.on("end", () => res.end('{"ok":true}')); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const go = keepAliveFetch();
  try {
    for (let i = 0; i < 5; i += 1) {
      const response = await go(`http://127.0.0.1:${server.address().port}/v1/x`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(await response.text(), '{"ok":true}');
    }
    assert.equal(sockets.size, 1);
  } finally {
    go.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

for (const [side, factory] of [["app", keepAliveFetch], ["VPS", agentKeepAliveFetch]]) {
  test(`${side} keep-alive fetch resumes its tls session after a reset`, { timeout: 10_000 }, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "madani-tls-"));
    try {
      execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "ignore" });
    } catch { rmSync(dir, { recursive: true, force: true }); t.skip("no openssl here"); return; }
    const server = createHttpsServer({ key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) }, (req, res) => res.end("ok"));
    const reused = [];
    server.on("secureConnection", (socket) => reused.push(socket.isSessionReused()));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    const go = factory();
    try {
      const url = `https://127.0.0.1:${server.address().port}/`;
      assert.equal(await (await go(url)).text(), "ok");
      go.reset();
      assert.equal(await (await go(url)).text(), "ok");
      assert.deepEqual(reused, [false, true]);
    } finally {
      go.close();
      if (before === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = before;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
