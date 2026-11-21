#!/usr/bin/env node
// How long the app takes to open over a slow link: from navigation to the bots in the sidebar and the open chat's
// messages, cold (empty browser profile) and warm (the same profile reopened), with every request's timing.
//
//   on the server, as its user:  node scripts/bench-load.mjs record --out /tmp/madani-load [--url http://127.0.0.1:8799]
//   on a Mac:                    node scripts/bench-load.mjs run --fixture <copied dir> --dist dist [--rtt 564] [--kbps 10000]
//                                 [--runs 5] [--out result.json]
//
// `record` reads the GETs the app makes while it opens (read-only, the CLI's loopback trust) into a folder. `run` serves
// the built app and that folder from a loopback server that holds every answer back one round trip and shares one
// downlink between them, like the VPS link (docs/verification/wire-latency.md), then opens it in headless Chromium.
import { execFileSync } from "node:child_process";
import { createSecureServer } from "node:http2";
import { X509Certificate, createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const mode = args[0];
const opt = (name, fallback) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : fallback; };

const CURSOR = "bench0001:1";
const keyOf = (pathAndQuery) => createHash("sha256").update(pathAndQuery).digest("hex").slice(0, 24);

/** what the app reads while it opens (a run prints what it asked for that the folder lacks); a query-less entry answers
 * any query on its path */
const BOOT_PATHS = (selected) => [
  "/api/brand", "/api/auth/session", "/api/config", "/api/instances", "/api/live/call", "/api/routines", "/api/webhooks",
  "/api/notifications", "/api/inbox", "/api/app-triggers", "/api/computer/egress", "/api/connectors/connected",
  "/api/connectors/catalog", "/api/connectors/directory", "/api/mcp/servers", "/api/logins",
  `/api/bots?messages=200&selected=${selected}`, "/api/bots?messages=200", "/api/bots?messages=0", "/api/transcripts?limit=50",
];

async function record() {
  const base = opt("url", "http://127.0.0.1:8799");
  const out = opt("out", "/tmp/madani-load");
  mkdirSync(out, { recursive: true });
  const headers = { "x-madani-cli": "1" };
  const bots = await (await fetch(`${base}/api/bots?messages=0`, { headers })).json();
  const selected = opt("selected", bots.bots?.find((bot) => bot.name === (opt("bot", "Cinder")))?.id ?? bots.bots?.[0]?.id ?? "");
  const extra = (opt("paths", "") || "").split(",").filter(Boolean);
  const index = {};
  for (const path of [...BOOT_PATHS(selected), ...extra]) {
    const started = Date.now();
    const response = await fetch(`${base}${path}`, { headers });
    const body = Buffer.from(await response.arrayBuffer());
    const file = keyOf(path);
    writeFileSync(join(out, file), body);
    index[path] = { file, status: response.status, type: response.headers.get("content-type") ?? "application/json", bytes: body.length, serverMs: Date.now() - started };
    console.log(`${response.status} ${String(body.length).padStart(8)} B ${String(Date.now() - started).padStart(5)} ms ${path}`);
  }
  writeFileSync(join(out, "index.json"), JSON.stringify({ selected, paths: index }, null, 1));
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2" };

/** one downlink every answer shares: bytes leave at `kbps`, in arrival order, after `rtt` (request and answer legs) */
function link({ rttMs, kbps }) {
  let free = 0;
  return (bytes) => {
    const now = Date.now();
    const start = Math.max(now + rttMs, free);
    free = start + (bytes * 8) / kbps;
    return free - now;
  };
}

function serve({ dist, fixture, rttMs, kbps, misses }) {
  const index = JSON.parse(readFileSync(join(fixture, "index.json"), "utf8"));
  const wire = link({ rttMs, kbps });
  const encoded = new Map();
  // one multiplexed http/2 connection, as the app has to the relay: no six-connections-per-host queue
  const certDir = mkdtempSync(join(tmpdir(), "madani-load-cert-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-subj", "/CN=127.0.0.1", "-days", "1", "-keyout", join(certDir, "key.pem"), "-out", join(certDir, "cert.pem")], { stdio: "ignore" });
  const tls = { key: readFileSync(join(certDir, "key.pem")), cert: readFileSync(join(certDir, "cert.pem")) };
  rmSync(certDir, { recursive: true, force: true });
  const server = createSecureServer({ ...tls, allowHTTP1: true }, (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (status, headers, body) => {
      const wait = wire(body.length + 300);
      setTimeout(() => { if (!res.destroyed) { res.writeHead(status, { ...headers, "content-length": body.length }); res.end(body); } }, wait);
    };
    if (url.pathname === "/api/events") {
      // nothing happens on this server, so a stream that resumes from the snapshot's cursor has nothing to replay
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(`data: ${JSON.stringify({ kind: "hello", cursor: CURSOR, resumed: url.searchParams.get("since") === CURSOR })}\n\n`);
      }, rttMs);
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      const hit = index.paths[url.pathname + url.search] ?? index.paths[url.pathname] ?? Object.entries(index.paths).find(([path]) => path.split("?")[0] === url.pathname)?.[1];
      if (!hit || req.method !== "GET") {
        misses.add(`${req.method} ${url.pathname}${url.search}`);
        return send(req.method === "GET" ? 404 : 200, { "content-type": "application/json" }, Buffer.from(req.method === "GET" ? '{"error":"not recorded"}' : "{}"));
      }
      let raw = readFileSync(join(fixture, hit.file));
      // a server with the snapshot cursor (server/routes/threads.ts) puts it in every list of bots
      if (url.pathname === "/api/bots" && hit.status === 200) raw = Buffer.from(JSON.stringify({ ...JSON.parse(raw.toString("utf8")), cursor: CURSOR }));
      // the link gzips json (server/harness/tunnel-gzip.ts)
      return send(hit.status, { "content-type": hit.type, "content-encoding": "gzip", "cache-control": "no-store" }, gzipSync(raw, { level: 1 }));
    }
    const file = join(dist, url.pathname === "/" || !extname(url.pathname) ? "index.html" : url.pathname.replace(/\.\./g, ""));
    if (!existsSync(file)) return send(404, { "content-type": "text/plain" }, Buffer.from("missing"));
    const type = MIME[extname(file)] ?? "application/octet-stream";
    const immutable = url.pathname.startsWith("/assets/");
    let body = readFileSync(file);
    const headers = { "content-type": type, "cache-control": type === "text/html" ? "no-cache" : immutable ? "public, max-age=31536000, immutable" : "no-cache" };
    if (immutable && /javascript|css|svg|json/.test(type) && body.length > 1024) {
      if (!encoded.has(file)) encoded.set(file, gzipSync(body, { level: 6 }));
      body = encoded.get(file);
      headers["content-encoding"] = "gzip";
    }
    send(200, headers, body);
  });
  // chromium keeps no http cache for a certificate it had to ignore, so it is told to trust this one's key instead
  const spki = createHash("sha256").update(new X509Certificate(tls.cert).publicKey.export({ type: "spki", format: "der" })).digest("base64");
  return new Promise((resolveStart) => server.listen(0, "127.0.0.1", () => resolveStart({ server, port: server.address().port, selected: index.selected, spki })));
}

/** what the page reports: first paint, the sidebar's first bot row, the open chat's first message row */
const PROBE = () => {
  const marks = {};
  const mark = (name) => { if (!(name in marks)) marks[name] = performance.now(); };
  new PerformanceObserver((list) => { for (const entry of list.getEntries()) if (entry.name === "first-contentful-paint") marks.fcp = entry.startTime; }).observe({ type: "paint", buffered: true });
  const check = () => {
    if (document.querySelector("[data-sidebar-bot-row]")) mark("bots");
    if (document.querySelector("[data-message-row]")) mark("chat");
  };
  new MutationObserver(check).observe(document, { subtree: true, childList: true });
  Object.defineProperty(window, "__loadMarks", { value: marks });
};

async function run() {
  const playwright = opt("playwright", process.env.MADANI_PLAYWRIGHT ?? "playwright-core");
  const { chromium } = await import(playwright);
  const executablePath = opt("chrome", process.env.MADANI_CHROME);
  const dist = resolve(opt("dist", "dist"));
  const fixture = resolve(opt("fixture", "/tmp/madani-load"));
  const rttMs = Number(opt("rtt", "564"));
  const kbps = Number(opt("kbps", "10000"));
  const runs = Number(opt("runs", "3"));
  const misses = new Set();
  const { server, port, selected, spki } = await serve({ dist, fixture, rttMs, kbps, misses });
  const origin = `https://127.0.0.1:${port}`;
  const results = [];
  for (let i = 0; i < runs; i += 1) {
    const profile = mkdtempSync(join(tmpdir(), "madani-load-"));
    for (const phase of ["cold", "warm"]) {
      const context = await chromium.launchPersistentContext(profile, {
        executablePath, headless: true, viewport: { width: 1400, height: 900 },
        args: [`--ignore-certificate-errors-spki-list=${spki}`, "--use-mock-keychain", "--password-store=basic"],
      });
      await context.addInitScript(PROBE);
      if (phase === "cold") await context.addInitScript((id) => { try { localStorage.setItem("madanibot.lastConversation.v1", id); } catch { } }, selected);
      const page = context.pages()[0] ?? await context.newPage();
      const requests = [];
      page.on("requestfinished", async (request) => {
        const timing = request.timing();
        const sizes = await request.sizes().catch(() => ({ responseBodySize: 0 }));
        requests.push({ url: request.url().replace(origin, ""), start: Math.round(timing.startTime - navStart), end: Math.round(timing.startTime - navStart + timing.responseEnd), bytes: sizes.responseBodySize, cached: timing.responseEnd < 2 });
      });
      const navStart = Date.now();
      await page.goto(origin, { waitUntil: "commit" });
      await page.waitForFunction(() => window.__loadMarks?.bots !== undefined && window.__loadMarks?.chat !== undefined, null, { timeout: 60_000, polling: 25 }).catch(() => {});
      const marks = await page.evaluate(() => ({ ...window.__loadMarks, nav: performance.timeOrigin }));
      const offset = marks.nav - navStart;
      const round = (value) => (value === undefined ? null : Math.round(value + offset));
      await page.waitForTimeout(500);
      results.push({ run: i, phase, fcp: round(marks.fcp), bots: round(marks.bots), chat: round(marks.chat), requests: requests.sort((a, b) => a.start - b.start) });
      console.log(`${phase} run ${i}: fcp ${round(marks.fcp)} bots ${round(marks.bots)} chat ${round(marks.chat)} ms, ${requests.length} requests, ${requests.filter((r) => r.url.startsWith("/api/")).length} api`);
      await context.close();
    }
    rmSync(profile, { recursive: true, force: true });
  }
  server.close();
  const median = (values) => { const sorted = values.filter((v) => v !== null).sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null; };
  const summary = Object.fromEntries(["cold", "warm"].map((phase) => {
    const rows = results.filter((r) => r.phase === phase);
    return [phase, { fcp: median(rows.map((r) => r.fcp)), bots: median(rows.map((r) => r.bots)), chat: median(rows.map((r) => r.chat)) }];
  }));
  console.log(JSON.stringify({ rttMs, kbps, summary }));
  if (misses.size) console.log(`not recorded: ${[...misses].join(" ")}`);
  const out = opt("out", "");
  if (out) writeFileSync(out, JSON.stringify({ rttMs, kbps, summary, results, misses: [...misses] }, null, 1));
}

if (mode === "record") await record();
else if (mode === "run") await run();
else { console.error("usage: bench-load.mjs record|run (see the header)"); process.exit(2); }
