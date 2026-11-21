// per-hop latency of the vps link (docs/verification/wire-latency.md). a fake madanibot server and the real link agent
// (the vps), the real relay, and the real app proxy with a stand-in renderer (the mac) each run on their own thread, and
// every network leg goes through a proxy that delays it like the real one. timestamps come from one clock.
//   node scripts/bench-wire.mjs [--path relay|direct] [--runs 30] [--vps-relay 72] [--mac-relay 210] [--mac-vps 158]
//                               [--kbps 0] [--gzip] [--h2] [--json out.json]
// --h2: the relay speaks tls with http/2 (as nginx does in front of the real one), so both ends use relayFetch's h2
// one-way delays default to the measured link (2026-11-07): vps<->relay rtt 144 ms, mac<->relay 420, mac<->vps 316.
import { connect as netConnect, createServer as createNetServer } from "node:net";
import { parseArgs } from "node:util";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { writeFileSync } from "node:fs";

const now = () => performance.timeOrigin + performance.now();
const id = "abcdefghij";
const keyText = Buffer.alloc(32, 7).toString("base64url");
const appToken = "a".repeat(43), vpsToken = "v".repeat(43);

/** frames shaped like the live ones (2026-11-07): a ~2 kB bot frame repeated with small changes, a ~360 B text delta */
const word = () => Math.random().toString(36).slice(2, 10);
const botBase = { id: crypto.randomUUID(), name: "Moss", threadId: crypto.randomUUID(), modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
  tasks: Array.from({ length: 8 }, () => ({ threadId: crypto.randomUUID(), title: `${word()} ${word()} ${word()}`, updatedAt: Date.now() })),
  skills: Array.from({ length: 6 }, () => ({ name: word(), enabled: true })) };
const botFrame = (seq) => ({ kind: "bot", bot: { ...botBase, busy: seq % 2 === 0, activity: seq % 3 ? "thinking" : "tool", lastActiveAt: Date.now() }, seq });
const deltaFrame = (seq) => ({ kind: "runtime", event: { type: "content.delta", eventId: crypto.randomUUID(), threadId: botBase.threadId, turnId: botBase.id, streamKind: "assistant_text", delta: Array.from({ length: 8 }, word).join(" "), createdAt: new Date().toISOString() }, seq });

/** seqs named in a chunk of sse text */
const seqsIn = (text) => [...text.matchAll(/"seq":(\d+)/g)].map((match) => Number(match[1]));

/** a tcp proxy that holds each direction's bytes `oneWayMs` (and, with `kbps`, their serialization time), in order */
function delayProxy({ target, oneWayMs, kbps = 0 }) {
  return createNetServer((down) => {
    down.setNoDelay(true);
    const up = netConnect(target);
    up.setNoDelay(true);
    const lane = (from, to) => {
      const queue = [];
      let timer = null, wireFree = 0, ended = false;
      const flush = () => {
        timer = null;
        const t = performance.now();
        while (queue.length && queue[0].at <= t + 0.5) to.write(queue.shift().chunk);
        if (queue.length) timer = setTimeout(flush, Math.max(0, queue[0].at - performance.now()));
        else if (ended) to.end();
      };
      from.on("data", (chunk) => {
        const t = performance.now();
        const sent = kbps ? (wireFree = Math.max(wireFree, t) + (chunk.length * 8) / kbps) : t;
        queue.push({ at: sent + oneWayMs, chunk });
        if (!timer) timer = setTimeout(flush, Math.max(0, queue[0].at - t));
      });
      from.on("end", () => { ended = true; if (!queue.length && !timer) to.end(); });
      from.on("error", () => to.destroy());
      from.on("close", () => { if (!queue.length) to.destroy(); });
    };
    lane(down, up);
    lane(up, down);
  });
}
const listen = (server, port = 0) => new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server.address().port)));

// ---- threads ----

async function vpsThread({ relayBase, directPort, gzip, ca }) {
  const { createServer } = await import("node:http");
  // without --gzip the stream is written as the server wrote it before server/harness/sse-gzip.ts
  const { gzipTunnelReplies } = gzip ? await import("../server/harness/tunnel-gzip.ts") : {};
  const { openEventStream } = gzip ? await import("../server/harness/sse-gzip.ts") : { openEventStream: (res, headers) => { res.writeHead(200, headers); return res; } };
  const { createTunnelAgent, keepAliveFetch, openFrame, relayFetch, serveDirect } = await import("../apps/link-service/agent.mjs");
  const key = Buffer.from(keyText, "base64url");
  const streams = new Set();
  const marks = [];
  const handle = (req, res) => {
    const t = now();
    if (req.url.startsWith("/api/events")) {
      // the real server's event stream head: gzipped for a forwarded request when --gzip (server/harness/sse-gzip.ts)
      const out = openEventStream(res, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" });
      out.write(`data: ${JSON.stringify({ kind: "hello" })}\n\n`);
      streams.add(out);
      req.on("close", () => streams.delete(out));
      return;
    }
    const seq = Number(new URL(req.url, "http://x").searchParams.get("seq"));
    marks.push({ seq, hop: "server-in", t });
    const size = Number(new URL(req.url, "http://x").searchParams.get("size") ?? 64);
    const body = JSON.stringify({ seq, pad: "x".repeat(Math.max(0, size - 30)) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
    marks.push({ seq, hop: "server-out", t: now() });
  };
  const server = createServer(gzip ? gzipTunnelReplies(handle) : handle);
  const port = await listen(server);
  // the agent's own fetch, tapped: when each reply post leaves
  const inner = ca && relayFetch ? relayFetch({ tls: { ca } }) : keepAliveFetch();
  const tapped = (url, init = {}) => {
    if (init.method === "POST") {
      const t = now();
      setImmediate(() => {
        for (const sealed of JSON.parse(init.body).frames) {
          try {
            const frame = openFrame(key, id, "to-app", sealed);
            const text = frame.t === "bytes" ? frame.b.toString("utf8") : JSON.stringify(frame);
            for (const seq of seqsIn(text)) marks.push({ seq, hop: "agent-post", t });
          } catch { /* not ours */ }
        }
      });
    }
    if (init.method === "POST" || !String(url).includes("/to-vps")) return inner(url, init);
    return inner(url, init).then((response) => {
      const reader = response.body.getReader();
      const body = new ReadableStream({
        async pull(controller) {
          const { value, done } = await reader.read();
          if (done) { controller.close(); return; }
          const t = now();
          const text = Buffer.from(value).toString("utf8");
          setImmediate(() => {
            for (const line of text.split("\n")) {
              let parsed = null;
              try { parsed = JSON.parse(line); } catch { continue; }
              for (const sealed of parsed.frames ?? []) {
                try { const frame = openFrame(key, id, "to-vps", sealed); for (const seq of seqsIn(JSON.stringify(frame).replaceAll("seq=", '"seq":'))) marks.push({ seq, hop: "agent-in", t }); } catch { /* not ours */ }
              }
            }
          });
          controller.enqueue(value);
        },
        cancel: (reason) => reader.cancel(reason),
      });
      return new Response(body, { status: response.status, headers: response.headers });
    });
  };
  Object.assign(tapped, { connectAware: inner.connectAware, warm: inner.warm, close: inner.close, reset: inner.reset, postsInFlight: inner.postsInFlight, multiplexed: inner.multiplexed });
  const agent = createTunnelAgent({ base: relayBase, id, key: keyText, token: vpsToken, server: { host: "127.0.0.1", port }, fetchImpl: tapped, log: () => {}, ...(workerData.aheadMs ? { aheadMs: workerData.aheadMs } : {}) });
  void agent.run();
  // the direct path's server half, as sshd would start it for each connection
  const direct = createNetServer((socket) => {
    serveDirect({ input: socket, output: socket, id, key: keyText, server: { host: "127.0.0.1", port }, log: () => {} });
  });
  const directListen = await listen(direct, directPort);
  parentPort.on("message", (message) => {
    if (message.t === "emit") {
      // one write per event, like server/sse-fanout.ts; `gapMs` spreads them over turns of the event loop
      const send = (one) => {
        const frame = `id: s:${one.seq}\ndata: ${JSON.stringify(one.size > 1000 ? botFrame(one.seq) : deltaFrame(one.seq))}\n\n`;
        const t = now();
        for (const res of streams) res.write(frame);
        marks.push({ seq: one.seq, hop: "server-emit", t });
      };
      if (!message.gapMs) for (const one of message.events) send(one);
      else message.events.forEach((one, index) => setTimeout(() => send(one), index * message.gapMs));
    } else if (message.t === "marks") parentPort.postMessage({ t: "marks", marks: marks.splice(0) });
  });
  parentPort.postMessage({ t: "ready", directPort: directListen });
}

async function relayThread({ tls }) {
  const { createServer } = await import("node:http");
  const { createSecureServer } = await import("node:http2");
  const { fileURLToPath } = await import("node:url");
  const { createLinkService, sha256hex } = await import("../apps/link-service/src/app.mjs");
  const { openFrame } = await import("../apps/link-service/agent.mjs");
  const key = Buffer.from(keyText, "base64url");
  const root = fileURLToPath(new URL("../apps/link-service/", import.meta.url));
  const service = createLinkService({ base: "http://fixture.invalid", scriptPath: `${root}install.sh`, agentPath: `${root}agent.mjs`, trustProxy: false });
  service.store.tunnels.set(id, { id, vpsVerifier: sha256hex(vpsToken), appVerifier: sha256hex(appToken) });
  const marks = [];
  const handle = (req, res) => {
    // the relay's write of each streamed line to the app
    if (req.method === "GET" && req.url.includes("/to-app")) {
      const write = res.write.bind(res);
      res.write = (chunk, ...rest) => {
        const t = now();
        const text = String(chunk);
        setImmediate(() => {
          for (const line of text.split("\n")) {
            if (!line) continue;
            for (const sealed of JSON.parse(line).frames ?? []) {
              try {
                const frame = openFrame(key, id, "to-app", sealed);
                const inner = frame.t === "bytes" ? frame.b.toString("utf8") : JSON.stringify(frame);
                for (const seq of seqsIn(inner)) marks.push({ seq, hop: "relay-out", t });
              } catch { /* not ours */ }
            }
          }
        });
        return write(chunk, ...rest);
      };
    }
    void service.handler(req, res);
  };
  const server = tls ? createSecureServer({ ...tls, allowHTTP1: true }, handle) : createServer(handle);
  // as apps/link-service/src/server.mjs: an idle keep-alive socket is not closed under a client about to reuse it
  server.keepAliveTimeout = 65_000;
  const port = await listen(server);
  parentPort.on("message", (message) => { if (message.t === "marks") parentPort.postMessage({ t: "marks", marks: marks.splice(0) }); });
  parentPort.postMessage({ t: "ready", port });
}

async function macThread({ relayBase, directTarget, path, gzip, ca }) {
  const { request } = await import("node:http");
  const { createGunzip } = await import("node:zlib");
  const { createTunnelProxy, keepAliveFetch, openFrame, relayFetch } = await import("../electron/vps-link-protocol.mjs");
  const key = Buffer.from(keyText, "base64url");
  const marks = [];
  // the app's fetch, tapped: when each streamed line of replies arrives
  const inner = ca && relayFetch ? relayFetch({ tls: { ca } }) : keepAliveFetch();
  const tapped = async (url, init = {}) => {
    if (init.method === "POST") {
      const t = now();
      setImmediate(() => {
        for (const sealed of JSON.parse(init.body).frames) {
          try { const frame = openFrame(key, id, "to-vps", sealed); for (const seq of seqsIn(JSON.stringify(frame).replaceAll("seq=", '"seq":'))) marks.push({ seq, hop: "app-post", t }); } catch { /* not ours */ }
        }
      });
    }
    const response = await inner(url, init);
    if (init.method === "POST" || !String(url).includes("/to-app")) return response;
    const reader = response.body.getReader();
    const body = new ReadableStream({
      async pull(controller) {
        const { value, done } = await reader.read();
        if (done) { controller.close(); return; }
        const t = now();
        const text = Buffer.from(value).toString("utf8");
        setImmediate(() => {
          for (const line of text.split("\n")) {
            let parsed = null;
            try { parsed = JSON.parse(line); } catch { continue; }
            for (const sealed of parsed.frames ?? []) {
              try {
                const frame = openFrame(key, id, "to-app", sealed);
                const innerText = frame.t === "bytes" ? frame.b.toString("utf8") : JSON.stringify(frame);
                for (const seq of seqsIn(innerText)) marks.push({ seq, hop: "app-in", t });
              } catch { /* not ours */ }
            }
          }
        });
        controller.enqueue(value);
      },
      cancel: (reason) => reader.cancel(reason),
    });
    return new Response(body, { status: response.status, headers: response.headers });
  };
  Object.assign(tapped, { connectAware: inner.connectAware, warm: inner.warm, close: inner.close, reset: inner.reset, postsInFlight: inner.postsInFlight, multiplexed: inner.multiplexed });
  const direct = path === "direct" ? {
    connect: () => new Promise((resolve, reject) => {
      const socket = netConnect(directTarget);
      socket.setNoDelay(true);
      socket.once("connect", () => resolve({ readable: socket, writable: socket, close: () => socket.destroy() }));
      socket.once("error", reject);
    }),
  } : null;
  const proxy = createTunnelProxy({ base: relayBase, id, key: keyText, token: appToken, fetch: tapped, direct, log: () => {}, ...(workerData.aheadMs ? { aheadMs: workerData.aheadMs } : {}) });
  const origin = new URL(await proxy.start());
  if (direct) {
    const end = performance.now() + 10_000;
    while (proxy.transport() !== "direct") {
      if (performance.now() > end) throw new Error("the direct path did not come up");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  // the renderer's event stream
  await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: origin.port, path: "/api/events", headers: { host: origin.host, accept: "text/event-stream", ...(gzip ? { "accept-encoding": "gzip, deflate" } : {}) } }, (res) => {
      let text = "";
      const body = res.headers["content-encoding"] === "gzip" ? res.pipe(createGunzip()) : res;
      body.setEncoding("utf8");
      body.on("data", (chunk) => {
        const t = now();
        text += chunk;
        let at;
        while ((at = text.indexOf("\n\n")) >= 0) {
          for (const seq of seqsIn(text.slice(0, at))) marks.push({ seq, hop: "client-event", t });
          text = text.slice(at + 2);
        }
      });
      resolve();
    });
    req.on("error", reject);
    req.end();
  });
  const call = (seq, size) => new Promise((resolve, reject) => {
    const t = now();
    marks.push({ seq, hop: "client-send", t });
    const req = request({ host: "127.0.0.1", port: origin.port, path: `/api/ping?seq=${seq}&size=${size}`, headers: { host: origin.host } }, (res) => {
      res.resume();
      res.on("end", () => { marks.push({ seq, hop: "client-reply", t: now() }); resolve(); });
    });
    req.on("error", reject);
    req.end();
  });
  parentPort.on("message", async (message) => {
    if (message.t === "call") { await call(message.seq, message.size); parentPort.postMessage({ t: "called", seq: message.seq }); }
    else if (message.t === "calls") { await Promise.all(message.seqs.map((seq) => call(seq, message.size))); parentPort.postMessage({ t: "called", seq: message.seqs[0] }); }
    else if (message.t === "marks") parentPort.postMessage({ t: "marks", marks: marks.splice(0) });
    else if (message.t === "close") { await proxy.close(); parentPort.postMessage({ t: "closed" }); }
  });
  parentPort.postMessage({ t: "ready", transport: proxy.transport() });
}

// ---- driver ----

let aheadMs = null;
function spawn(role, data) {
  const worker = new Worker(new URL(import.meta.url), { workerData: { role, aheadMs, ...data } });
  const waiters = [];
  worker.on("message", (message) => { const at = waiters.findIndex((one) => one.t === message.t); if (at >= 0) waiters.splice(at, 1)[0].resolve(message); });
  worker.on("error", (error) => { console.error(`${role} thread failed:`, error); process.exit(1); });
  const next = (t) => new Promise((resolve) => waiters.push({ t, resolve }));
  return { worker, next, ask: (message, answer) => { const reply = next(answer); worker.postMessage(message); return reply; } };
}

const q = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const stats = (values) => {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  return sorted.length ? { n: sorted.length, p50: +q(sorted, 0.5).toFixed(1), p95: +q(sorted, 0.95).toFixed(1), min: +sorted[0].toFixed(1) } : null;
};

async function main() {
  const { values } = parseArgs({ options: {
    path: { type: "string", default: "relay" }, runs: { type: "string", default: "30" },
    "vps-relay": { type: "string", default: "72" }, "mac-relay": { type: "string", default: "210" }, "mac-vps": { type: "string", default: "158" },
    kbps: { type: "string", default: "0" }, json: { type: "string" }, burst: { type: "string", default: "12" }, gzip: { type: "boolean", default: false }, h2: { type: "boolean", default: false }, "ahead-ms": { type: "string" },
  } });
  const runs = Number(values.runs), kbps = Number(values.kbps);
  // --ahead-ms: when each end asks for its next streamed read (default 21 s into a 25 s read)
  if (values["ahead-ms"]) aheadMs = Number(values["ahead-ms"]);
  let tls = null;
  if (values.h2) {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(`${tmpdir()}/bench-wire-`);
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", `${dir}/key.pem`, "-out", `${dir}/cert.pem`], { stdio: "ignore" });
    tls = { key: readFileSync(`${dir}/key.pem`, "utf8"), cert: readFileSync(`${dir}/cert.pem`, "utf8") };
    rmSync(dir, { recursive: true, force: true });
  }
  const scheme = tls ? "https" : "http";
  const relay = spawn("relay", { tls });
  const { port: relayPort } = await relay.next("ready");
  const vpsSide = delayProxy({ target: { host: "127.0.0.1", port: relayPort }, oneWayMs: Number(values["vps-relay"]) });
  const macSide = delayProxy({ target: { host: "127.0.0.1", port: relayPort }, oneWayMs: Number(values["mac-relay"]), kbps });
  const [vpsRelayPort, macRelayPort] = await Promise.all([listen(vpsSide), listen(macSide)]);
  const vps = spawn("vps", { relayBase: `${scheme}://127.0.0.1:${vpsRelayPort}`, directPort: 0, gzip: values.gzip, ca: tls?.cert });
  const { directPort } = await vps.next("ready");
  const directSide = delayProxy({ target: { host: "127.0.0.1", port: directPort }, oneWayMs: Number(values["mac-vps"]), kbps });
  const directProxyPort = await listen(directSide);
  const mac = spawn("mac", { relayBase: `${scheme}://127.0.0.1:${macRelayPort}`, ca: tls?.cert, directTarget: { host: "127.0.0.1", port: directProxyPort }, path: values.path, gzip: values.gzip });
  const { transport } = await mac.next("ready");
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await pause(1500);

  // (a) single events, spaced so each travels alone; then bursts of `burst` 2 kB events, like a turn's end
  let seq = 1;
  const singles = [], bursts = [];
  for (let i = 0; i < runs; i++) { singles.push(seq); vps.worker.postMessage({ t: "emit", events: [{ seq: seq++, size: 360 }] }); await pause(700); }
  for (let i = 0; i < Math.max(5, Math.round(runs / 4)); i++) {
    const events = Array.from({ length: Number(values.burst) }, () => ({ seq: seq++, size: 2000 }));
    bursts.push(events.map((one) => one.seq));
    vps.worker.postMessage({ t: "emit", events });
    await pause(1500);
  }
  // a turn's frames as the server really writes them: one every few milliseconds
  const trickles = [];
  for (let i = 0; i < Math.max(5, Math.round(runs / 4)); i++) {
    const events = Array.from({ length: Number(values.burst) }, () => ({ seq: seq++, size: 2000 }));
    trickles.push(events.map((one) => one.seq));
    vps.worker.postMessage({ t: "emit", events, gapMs: 3 });
    await pause(1500);
  }
  // a page's burst: 20 requests at once (startup asks about that many)
  const together = [];
  for (let i = 0; i < Math.max(3, Math.round(runs / 6)); i++) {
    const seqs = Array.from({ length: 20 }, () => seq++);
    together.push(...seqs);
    await mac.ask({ t: "calls", seqs, size: 200 }, "called");
    await pause(1000);
  }
  // (b) requests: small replies one at a time
  const calls = [];
  for (let i = 0; i < runs; i++) { calls.push(seq); await mac.ask({ t: "call", seq: seq++, size: 200 }, "called"); await pause(50); }
  await pause(800);

  const marks = [...(await vps.ask({ t: "marks" }, "marks")).marks, ...(await relay.ask({ t: "marks" }, "marks")).marks, ...(await mac.ask({ t: "marks" }, "marks")).marks];
  const at = new Map();
  for (const mark of marks) { const key = `${mark.seq}|${mark.hop}`; if (!at.has(key)) at.set(key, mark.t); }
  const get = (s, hop) => at.get(`${s}|${hop}`);
  const span = (list, from, to) => stats(list.map((s) => get(s, to) - get(s, from)));
  const eventHops = (list) => ({
    "server write -> agent post": span(list, "server-emit", "agent-post"),
    "agent post -> relay streams it": span(list, "agent-post", "relay-out"),
    "relay -> app proxy": span(list, "relay-out", "app-in"),
    "app proxy -> renderer event": span(list, "app-in", "client-event"),
    total: span(list, "server-emit", "client-event"),
  });
  const report = {
    path: transport, gzip: values.gzip, h2: values.h2, runs, delays: { vpsRelay: +values["vps-relay"], macRelay: +values["mac-relay"], macVps: +values["mac-vps"], kbps },
    event: transport === "direct" ? { total: span(singles, "server-emit", "client-event") } : eventHops(singles),
    burst: { lastOfBurst: stats(bursts.map((list) => get(list.at(-1), "client-event") - get(list[0], "server-emit"))) },
    trickle: { lastOfTurn: stats(trickles.map((list) => get(list.at(-1), "client-event") - get(list.at(-1), "server-emit"))), each: span(trickles.flat(), "server-emit", "client-event"), hops: transport === "direct" ? undefined : eventHops(trickles.flat()) },
    together: { each: span(together, "client-send", "client-reply"), "client -> server": span(together, "client-send", "server-in"), "client -> app post": span(together, "client-send", "app-post"), "app post -> agent": span(together, "app-post", "agent-in"), "agent -> server": span(together, "agent-in", "server-in"), "server -> client": span(together, "server-out", "client-reply") },
    request: {
      "client -> server": span(calls, "client-send", "server-in"),
      "server -> client": span(calls, "server-out", "client-reply"),
      total: span(calls, "client-send", "client-reply"),
    },
  };
  console.log(JSON.stringify(report, null, 1));
  if (values.json) writeFileSync(values.json, JSON.stringify(report, null, 1));
  await mac.ask({ t: "close" }, "closed");
  process.exit(0);
}

if (isMainThread) await main();
else if (workerData.role === "vps") await vpsThread(workerData);
else if (workerData.role === "relay") await relayThread(workerData);
else await macThread(workerData);
