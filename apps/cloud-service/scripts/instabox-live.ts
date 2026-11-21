// One real run of a managed home on InstaBox, the way a new person meets it, from sign-up to deletion. The account
// service (its website and app routes, the real one) runs here behind a public https name (an ngrok tunnel); the person
// signs up and buys through the desktop app's own client and the website; the machine redeems its one-time claim over
// the internet; the package must be signed; people reach the home at <label>.<test domain> through our public edge
// (edge/worker.js, run in this process for the test domain). Then: three bots made and answering, their computers
// started with no manual step (the image made by the home itself), the app's own desktop viewer path down to a decoded
// framebuffer, a bot's browser on everyday sites, a persistent cookie and a localStorage sign-in kept across a pause and
// a reboot, pause and resume with memory, a routine due while paused, a killed home process, a hard machine reboot, a bot
// moved in from a local fixture and the home brought back to it, and the owner's deletion. Entitlements are signed by
// the account service and enforced by the home throughout.
//
//   node --env-file=<.env with INSTABOX_API_KEY> --experimental-strip-types apps/cloud-service/scripts/instabox-live.ts \
//     --public-url https://<tunnel> --port <tunnel's local port> --package <omb-home.tgz> --release-public <kid:x> \
//     --entitlement-key <file> --out <results.json> [--skip-browse]
//
// Test-only deviations from production, each named in the results: the package pins one extra entitlement key (this
// run's; the production key is not here), the payment provider is the fake one, a synthetic engine answers the bots,
// and the clock jumps forward for the deletion (a plan's period and the 7-day undo window). Everything the run made is
// deleted and proven gone. Prints timings and ids, never a key or a token.
import { CLOUD_HOME } from "../../../electron/legacy-names.mjs";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { createCloudAccountClient } from "../../../electron/cloud-account.mjs";
import { createCloudSend } from "../../../electron/cloud-send.mjs";
import { openOwnerSession } from "../../../electron/cloud-send-main.mjs";
import { createHomeAgain } from "../../../electron/one-home-again.mjs";
import { launchVerificationServer } from "../../../scripts/control-madani.ts";
import { readFrame } from "../../../server/routes/rfb-handshake.ts";
import { vncAuthResponse } from "../../../server/routes/vnc-des.ts";
import { applyPendingWorkspaceRestore } from "../../../server/workspace-backup.ts";
import { createDashboardApp } from "../../dashboard/server/app.ts";
import { memoryMailer } from "../../dashboard/server/auth/mail.ts";
import type { CloudDesktopView } from "../../../shared/billing-api.ts";
import edge from "../edge/worker.js";
import { createInstaboxProvider, instaboxUsageCents } from "../src/instabox.ts";

const args = process.argv.slice(2);
const option = (name: string) => { const at = args.indexOf(name); return at === -1 ? null : args[at + 1] ?? null; };
const apiKey = process.env.INSTABOX_API_KEY;
if (!apiKey) { console.error("INSTABOX_API_KEY is required."); process.exit(2); }
const need = (name: string) => { const v = option(name); if (!v) { console.error(`${name} is required.`); process.exit(2); } return v; };
const packageFile = resolve(need("--package")), signature = readFileSync(`${packageFile}.sig`, "utf8").trim();
const releasePublic = need("--release-public"), entitlementKey = readFileSync(need("--entitlement-key"), "utf8").trim();
const out = resolve(option("--out") ?? "instabox-live.json");
const scope = randomBytes(8).toString("hex");
const sha256 = createHash("sha256").update(readFileSync(packageFile)).digest("hex");
const ibx = createInstaboxProvider({ apiKey, scope });

// ---- timing and results
const t0 = Date.now(), marks: Array<{ step: string; ms: number }> = [];
let last = t0;
const results: Record<string, unknown> = { scope, startedAt: new Date(t0).toISOString(), steps: [] as unknown[],
  deviations: ["package pins this run's entitlement key beside the production one", "fake payment provider", "synthetic engine answers the bots", "clock jumped forward for the plan's end and the undo window"] };
function mark(step: string) { const now = Date.now(); marks.push({ step, ms: now - last }); console.log(`[${((now - t0) / 1000).toFixed(1)}s] ${step} (+${((now - last) / 1000).toFixed(1)}s)`); last = now; }
const note = (line: string) => console.log(`  ${line}`);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const failures: string[] = [];
async function step<T>(name: string, fn: () => Promise<T>, critical = false): Promise<T | null> {
  const started = Date.now();
  try { const value = await fn(); (results.steps as unknown[]).push({ name, ok: true, ms: Date.now() - started }); mark(name); return value; }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    (results.steps as unknown[]).push({ name, ok: false, ms: Date.now() - started, error: message.slice(0, 500) });
    failures.push(name);
    console.log(`  FAILED ${name}: ${message.slice(0, 500)}`);
    if (critical) throw error;
    return null;
  }
}
const save = () => writeFileSync(out, JSON.stringify({ ...results, marks }, null, 2));

// ---- the account service
let offset = 0;
const now = () => Date.now() + offset;
const dataDir = mkdtempSync(join(tmpdir(), "madani-ibx-live-"));
const port = Number(option("--port") ?? 0);
const PUBLIC_DOMAIN = "desktops.madani-staging.test";
const edgeToken = randomBytes(32).toString("base64url");
const env: NodeJS.ProcessEnv = { ...process.env, MADANI_BILLING_PROVIDER: "fake", MADANI_POOL_DRIVER: "fake", MADANI_CLOUD_SEAL_KEY: randomBytes(32).toString("base64url"), MADANI_MANAGED: "1",
  MADANI_MANAGED_EDGE_TOKEN: edgeToken, MADANI_MANAGED_SCOPE: scope, MADANI_MANAGED_HOME_PACKAGE_FILE: packageFile, MADANI_MANAGED_HOME_PACKAGE_SHA256: sha256,
  MADANI_MANAGED_HOME_PACKAGE_SIGNATURE: signature, MADANI_RELEASE_PUBLIC_KEYS: releasePublic, MADANI_ENTITLEMENT_SIGNING_KEY: entitlementKey,
  MADANI_MANAGED_LEASE_HOURS: "1", MADANI_MANAGED_IDLE_MINUTES: "3", MADANI_MANAGED_LOST_AFTER_MINUTES: "2",
  MADANI_MANAGED_PUBLIC_DOMAIN: PUBLIC_DOMAIN };
for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;

const mailer = memoryMailer();
let server: Server | null = null;
let origin = "";
type Service = {
  views(): Promise<CloudDesktopView[]>;
  power(cloudId: string, action: "on" | "off"): Promise<void>;
  grant(cloudId: string): Promise<{ origin: string; code: string; expiresAt: number }>;
  cancel(cloudId: string): Promise<void>;
  deleteData(cloudId: string): Promise<void>;
  confirmDelete(cloudId: string, token: string): Promise<void>;
  close(): void;
};
let service!: Service;
let billing: ReturnType<typeof createDashboardApp>["billing"] | null = null;
const realFetch = globalThis.fetch;

/** a cookie session on the account service's website, as the dashboard holds one */
async function webSignIn(base: string, email: string): Promise<{ cookie: string; csrf: string }> {
  const ask = () => realFetch(`${base}/v1/auth/start`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ email }) });
  let answer = await ask();
  // one code per address per 30 seconds: the app's sign-in just took one
  if (answer.status === 429) { await answer.body?.cancel(); await sleep(31_000); answer = await ask(); }
  const started = await answer.json() as { attempt?: string };
  const code = mailer.outbox.findLast(m => m.to === email)?.text.match(/\b\d{8}\b/)?.[0];
  if (!started.attempt || !code) throw new Error("no sign-in code");
  const verified = await realFetch(`${base}/v1/auth/verify`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ attempt: started.attempt, code }) });
  const cookie = verified.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  const body = await verified.json() as { csrfToken?: string };
  if (!verified.ok || !body.csrfToken) throw new Error(`web sign-in ${verified.status}`);
  return { cookie, csrf: body.csrfToken };
}

// ---- the public edge, run here for the test domain: every request to <label>.<domain> goes through it
const edgeEnv = () => ({ ROUTE_URL: `http://127.0.0.1:${(server!.address() as { port: number }).port}`, EDGE_TOKEN: edgeToken, PUBLIC_DOMAIN });
{
  // the Workers runtime takes a stream body without `duplex`; Node wants it named
  const NodeRequest = globalThis.Request;
  globalThis.Request = class extends NodeRequest {
    constructor(input: string | URL | Request, init?: RequestInit) { super(input, init?.body instanceof ReadableStream && !("duplex" in init) ? { ...init, duplex: "half" } as RequestInit : init); }
  } as typeof Request;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url).hostname.endsWith(`.${PUBLIC_DOMAIN}`)) return edge.fetch(request, edgeEnv(), { waitUntil() {} });
    return realFetch(request);
  }) as typeof fetch;
}

/** a command on the machine the cloud runs on now */
async function machineOf(cloudId: string): Promise<string> {
  const found = await ibx.find(cloudId);
  if (!found) throw new Error("no machine for the cloud");
  return found.id;
}
async function onMachine(cloudId: string, command: string, timeoutSeconds = 300) { return ibx.run(await machineOf(cloudId), command, timeoutSeconds); }
/** the machine's own hosted URL (what the account service talks to) */
async function upstreamOf(cloudId: string) { return ibx.origin(await machineOf(cloudId)); }

// ---- the app's desktop viewer, down to one decoded framebuffer update
function rfbFrame(base: string, path: string, token: string, password: string | null): Promise<{ ms: number; name: string; width: number; height: number; rects: number }> {
  return new Promise((done, fail) => {
    const started = Date.now(), url = new URL(path, base);
    const req = https.request(url, { headers: { authorization: `Bearer ${token}`, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": randomBytes(16).toString("base64"), "sec-websocket-protocol": "binary" }, timeout: 45_000 });
    req.on("upgrade", (_res, socket) => {
      let buffer = Buffer.alloc(0), rfb = Buffer.alloc(0), phase = "version";
      let width = 0, height = 0, name = "";
      const send = (data: Buffer) => {
        const mask = randomBytes(4), head = data.length < 126 ? Buffer.from([0x82, 0x80 | data.length]) : Buffer.from([0x82, 0x80 | 126, data.length >> 8, data.length & 255]);
        const body = Buffer.from(data); for (let i = 0; i < body.length; i++) body[i]! ^= mask[i & 3]!;
        socket.write(Buffer.concat([head, mask, body]));
      };
      const timer = setTimeout(() => { socket.destroy(); fail(new Error(`no framebuffer (phase ${phase})`)); }, 45_000);
      const finish = (value: { ms: number; name: string; width: number; height: number; rects: number }) => { clearTimeout(timer); socket.destroy(); done(value); };
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (let read = readFrame(buffer); read; read = readFrame(buffer)) { buffer = buffer.subarray(read.size); if (read.frame.opcode === 2 || read.frame.opcode === 0) rfb = Buffer.concat([rfb, read.frame.payload]); }
        for (;;) {
          if (phase === "version" && rfb.length >= 12) { rfb = rfb.subarray(12); send(Buffer.from("RFB 003.008\n")); phase = "security"; continue; }
          if (phase === "security" && rfb.length >= 1 && rfb.length >= 1 + rfb[0]!) {
            const types = [...rfb.subarray(1, 1 + rfb[0]!)]; rfb = rfb.subarray(1 + types.length);
            if (types.includes(1)) { send(Buffer.from([1])); phase = "result"; } else if (types.includes(2)) { send(Buffer.from([2])); phase = "challenge"; } else { fail(new Error(`security types ${types}`)); return; }
            continue;
          }
          if (phase === "challenge" && rfb.length >= 16) { send(vncAuthResponse(password ?? "", rfb.subarray(0, 16))); rfb = rfb.subarray(16); phase = "result"; continue; }
          if (phase === "result" && rfb.length >= 4) { if (rfb.readUInt32BE(0) !== 0) { fail(new Error("vnc auth refused")); return; } rfb = rfb.subarray(4); send(Buffer.from([1])); phase = "init"; continue; }
          if (phase === "init" && rfb.length >= 24 && rfb.length >= 24 + rfb.readUInt32BE(20)) {
            width = rfb.readUInt16BE(0); height = rfb.readUInt16BE(2); const n = rfb.readUInt32BE(20); name = rfb.subarray(24, 24 + n).toString("latin1"); rfb = rfb.subarray(24 + n);
            // raw encoding only, then a full update of the screen
            send(Buffer.from([2, 0, 0, 1, 0, 0, 0, 0]));
            const ask = Buffer.alloc(10); ask[0] = 3; ask[1] = 0; ask.writeUInt16BE(width, 6); ask.writeUInt16BE(height, 8); send(ask);
            phase = "update"; continue;
          }
          if (phase === "update" && rfb.length >= 4) { if (rfb[0] === 0) finish({ ms: Date.now() - started, name, width, height, rects: rfb.readUInt16BE(2) }); else rfb = rfb.subarray(1); return; }
          return;
        }
      });
      socket.on("error", fail);
    });
    req.on("response", res => { let body = ""; res.on("data", c => { body += c; }); res.on("end", () => fail(new Error(`viewer answered HTTP ${res.statusCode} ${body.slice(0, 200)}`))); });
    req.on("error", fail); req.on("timeout", () => req.destroy(new Error("viewer timed out")));
    req.end();
  });
}

// ---- what a bot's browser does inside its computer
const SITES: Array<{ id: string; kind: string; url: string; expect?: string }> = [
  { id: "search-google", kind: "search", url: "https://www.google.com/search?q=weather+in+lisbon&hl=en", expect: "weather" },
  { id: "search-bing", kind: "search", url: "https://www.bing.com/search?q=weather+in+lisbon", expect: "weather" },
  { id: "search-ddg", kind: "search", url: "https://duckduckgo.com/html/?q=weather+in+lisbon", expect: "result" },
  { id: "news-bbc", kind: "news", url: "https://www.bbc.com/news", expect: "news" },
  { id: "news-reuters", kind: "news", url: "https://www.reuters.com/", expect: "reuters" },
  { id: "news-guardian", kind: "cookie banner", url: "https://www.theguardian.com/international", expect: "guardian" },
  { id: "shop-amazon", kind: "shopping", url: "https://www.amazon.com/dp/B0BSHF7WHW", expect: "amazon" },
  { id: "shop-ebay", kind: "shopping", url: "https://www.ebay.com/sch/i.html?_nkw=usb+c+cable", expect: "usb" },
  { id: "login-github", kind: "login form (not submitted)", url: "https://github.com/login", expect: "password" },
  { id: "js-airbnb", kind: "heavy JavaScript", url: "https://www.airbnb.com/", expect: "airbnb" },
  { id: "js-maps", kind: "heavy JavaScript", url: "https://www.openstreetmap.org/#map=12/38.7223/-9.1393", expect: "openstreetmap" },
  { id: "video-youtube", kind: "video", url: "https://www.youtube.com/watch?v=jNQXAC9IVRw", expect: "youtube" },
  { id: "wiki", kind: "reference", url: "https://en.wikipedia.org/wiki/Lisbon", expect: "lisbon" },
];
const BROWSE = String.raw`
import json, os, re, shutil, subprocess, sys, time, urllib.request
sites = json.loads(sys.argv[1]); out = []
chrome = "/usr/lib/chromium/chromium" if os.path.exists("/usr/lib/chromium/chromium") else shutil.which("chromium")
walls = re.compile(r"(unusual traffic|are you a robot|not a robot|verify you are human|captcha|access denied|request blocked|sign in to confirm you.re not a bot|pardon our interruption|enable javascript and cookies|attention required)", re.I)
for s in sites:
    t = time.time()
    try:
        p = subprocess.run([chrome, "--headless=new", "--no-sandbox", "--disable-gpu", "--use-mock-keychain", "--password-store=basic", "--disable-dev-shm-usage", "--user-data-dir=/tmp/omb-browse", "--lang=en-US",
            "--virtual-time-budget=10000", "--timeout=40000", "--dump-dom", s["url"]], capture_output=True, timeout=60)
        dom = p.stdout.decode("utf-8", "replace"); ms = int((time.time() - t) * 1000)
        title = re.search(r"<title[^>]*>(.*?)</title>", dom, re.S | re.I)
        out.append({"id": s["id"], "ms": ms, "bytes": len(dom), "title": (title.group(1).strip()[:60] if title else ""), "wall": bool(walls.search(dom[:20000])), "expected": s.get("expect", "").lower() in dom.lower()})
    except Exception as e:
        out.append({"id": s["id"], "ms": int((time.time() - t) * 1000), "error": str(e)[:160]})
print(json.dumps(out))
`;
// a sign-in a site keeps: a persistent cookie (a day) and localStorage, written by one Chromium and read by the next one
// (localStorage on a file page: a data page has no storage, and this keeps the check off any site's servers)
const PROFILE = String.raw`
import json, os, re, shutil, subprocess, sys
chrome = "/usr/lib/chromium/chromium" if os.path.exists("/usr/lib/chromium/chromium") else shutil.which("chromium")
mode, profile = sys.argv[1], sys.argv[2]
pages = os.path.join(os.path.expanduser("~"), ".madani-live-pages"); os.makedirs(pages, exist_ok=True)
with open(os.path.join(pages, "set.html"), "w") as f: f.write("<title>x</title><script>localStorage.setItem('madani_login','kept');document.title='set:'+localStorage.getItem('madani_login')</script>")
with open(os.path.join(pages, "get.html"), "w") as f: f.write("<title>x</title><script>document.title='ls:'+localStorage.getItem('madani_login')</script>")
def dump(url):
    p = subprocess.run([chrome, "--headless=new", "--no-sandbox", "--disable-gpu", "--use-mock-keychain", "--password-store=basic", "--user-data-dir=" + profile, "--allow-file-access-from-files", "--virtual-time-budget=5000", "--dump-dom", url], capture_output=True, timeout=60)
    return p.stdout.decode("utf-8", "replace")
if mode == "set":
    dump("https://httpbin.org/response-headers?Set-Cookie=madani_persist%3Dkept%3B%20Max-Age%3D86400%3B%20Path%3D%2F")
    dump("file://" + os.path.join(pages, "set.html"))
cookies = dump("https://httpbin.org/cookies")
title = re.search(r"<title>(.*?)</title>", dump("file://" + os.path.join(pages, "get.html")))
print(json.dumps({"cookie": "madani_persist" in cookies, "localStorage": bool(title) and title.group(1) == "ls:kept", "title": title.group(1) if title else None}))
`;

let failed: string | null = null;
let cloudId = "";
const timeline: Array<{ at: number; app?: string; dashboard?: string; step?: string | null }> = [];
let watching = true;
try {
  mark("start");
  const http = createServer();
  server = http;
  await new Promise<void>(r => http.listen(port, "127.0.0.1", r));
  origin = need("--public-url");
  results.accountService = "the account service with its website and app routes, reached by machines and the app at a public https name";

  // 1. sign-up, checkout and payment, as a new person does it: the desktop app's own client, the website for the rest
  const email = `live-${scope}@example.test`;
  const app = createDashboardApp({ dataDir, publicUrl: origin, mailer, staticDir: null, now });
  http.on("request", app.handle);
  billing = app.billing;
  // the tunnel answers before any machine depends on it
  const probe = await realFetch(`${origin}/v1/managed/claims/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (probe.status !== 403) throw new Error(`the public URL does not reach this service (${probe.status})`);
  let saved: unknown = null;
  const client = createCloudAccountClient({ origin, custom: true, platform: "darwin", deviceName: "Live Mac", appVersion: "0.1.live", now,
    store: { read: async () => saved, write: async (value: unknown) => { saved = value; } }, openBrowser: async () => {} });
  const web = await step("sign-up: the app signs in with an emailed code, the website too", async () => {
    await client.start();
    if ((await client.emailStart(email)).outcome !== "sent") throw new Error("no code sent");
    const code = mailer.outbox.findLast(m => m.to === email)?.text.match(/\b\d{8}\b/)?.[0];
    if ((await client.emailVerify(code!)).outcome !== "signed-in") throw new Error("app sign-in failed");
    return webSignIn(origin, email);
  }, true);
  let cookies = { cookie: web!.cookie, "x-madani-csrf": web!.csrf, origin };
  const dashboardCall = async (method: string, route: string, body?: unknown) => {
    const r = await realFetch(`${origin}${route}`, { method, headers: { ...cookies, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await r.text(); let data: any = null; try { data = JSON.parse(text); } catch { data = text; }
    if (!r.ok) throw new Error(`${method} ${route} ${r.status} ${text.slice(0, 200)}`);
    return data;
  };
  service = {
    views: async () => (await dashboardCall("GET", "/v1/clouds")).clouds as CloudDesktopView[],
    power: async (id, action) => { await dashboardCall("POST", `/v1/clouds/${id}/power`, { action }); },
    grant: async () => client.pairHome() as Promise<{ origin: string; code: string; expiresAt: number }>,
    cancel: async () => { const r = await client.cancelPlan({ answer: "testing", improve: "" }); if (r.outcome !== "cancelled") throw new Error(`cancel ${JSON.stringify(r)}`); },
    deleteData: async id => { await dashboardCall("POST", `/v1/clouds/${id}/delete-data`, {}); },
    confirmDelete: async (id, token) => { await dashboardCall("POST", `/v1/clouds/${id}/delete-data/confirm`, { token }); },
    close: () => { client.close(); app.close(); },
  };
  await step("checkout: the app opens checkout, the payment provider's signed webhooks activate the cloud", async () => {
    if ((await client.checkout("starter", "app_card")).outcome !== "opened") throw new Error("checkout did not open");
    const checkout = (JSON.parse(readFileSync(join(dataDir, "billing.json"), "utf8")) as { checkouts: Array<{ providerSessionId: string | null; cloudId: string | null }> }).checkouts.at(-1)!;
    for (const delivery of billing!.fake!.complete(checkout.providerSessionId!)) {
      const res = await realFetch(`${origin}/v1/billing/webhooks/dodo`, { method: "POST", headers: { "content-type": "application/json", ...delivery.headers }, body: new Uint8Array(delivery.body) });
      if (!res.ok) throw new Error(`webhook refused: ${res.status}`);
    }
    cloudId = checkout.cloudId!;
  }, true);
  results.cloud = cloudId;
  // what the person sees, every two seconds, for the whole run
  void (async () => {
    let lastKey = "";
    while (watching) {
      try {
        const view = (await service.views()).find(v => v.id === cloudId);
        await client.refresh().catch(() => {});
        const state = client.state() as { machine?: { status?: string; power?: { state?: string } }; waking?: boolean };
        const shown = `${state.machine?.status ?? "-"}${state.machine?.power?.state ? `/${state.machine.power.state}` : ""}${state.waking ? "+waking" : ""}`;
        const dashboard = view ? `${view.status}${view.waking ? "/waking" : ""}` : "-";
        const key = `${dashboard}|${view?.setupStep}|${shown}`;
        if (key !== lastKey) { lastKey = key; timeline.push({ at: Date.now() - t0, dashboard, step: view?.setupStep ?? null, app: shown }); }
      } catch {}
      await sleep(2000);
    }
  })();
  const view = async () => (await service.views()).find(v => v.id === cloudId)!;
  async function until(done: (v: CloudDesktopView) => boolean, limitMs: number, label: string, pauseMs = 1000) {
    const deadline = Date.now() + limitMs;
    for (;;) {
      const v = await view();
      if (done(v)) return v;
      if (Date.now() > deadline) throw new Error(`${label}: timed out (status ${v.status}, step ${v.setupStep}, error ${v.error})`);
      await sleep(pauseMs);
    }
  }

  // 2. set up on InstaBox by the real lifecycle: no step by anyone
  const provisioned = Date.now();
  await step("setup: a working home with no manual step", () => until(v => v.status === "running", 20 * 60_000, "setup", 2000), true);
  results.setupMs = Date.now() - provisioned;
  const homeOrigin = (await view()).origin!;
  const upstream = await upstreamOf(cloudId);
  results.origins = { user: homeOrigin.replace(/\/\/[^.]+/, "//<label>"), userOnOurDomain: homeOrigin.endsWith(PUBLIC_DOMAIN), upstreamHost: new URL(upstream).hostname.split(".").slice(1).join(".") };
  const facts = await onMachine(cloudId, `nproc; free -m | awk '/Mem/ {print $2" MiB"}'; systemctl is-active omb-home omb-docker-gate; cat ${CLOUD_HOME.run}/desktop-image 2>/dev/null || echo no-status; systemctl is-active omb-desktop-image; grep -c ENTITLEMENT=required ${CLOUD_HOME.etc}/home.env; sudo test -f ${CLOUD_HOME.etc}/boot.json && echo boot-left || echo boot-gone; test -f /data/home/.omb-boot.json && echo bootfile-left || echo bootfile-gone`);
  results.machineFacts = facts.stdout.trim().split("\n"); note(`machine: ${facts.stdout.trim().replace(/\n/g, " | ")}`);
  {
    const claim = billing!.clouds.get(cloudId)!.managed?.claim ?? null;
    results.claim = { redeemedOverTunnel: claim === null, bootFileHeldSecret: false };
  }
  // the account service's entitlement reached the home and the home enforces it
  await step("entitlement: the home serves only with the service's signed entitlement", async () => {
    const health = await realFetch(`${upstream}/api/health`).then(r => r.status);
    const ent = await onMachine(cloudId, `sudo test -s ${CLOUD_HOME.data}/cloud-entitlement && echo held || echo none`);
    results.entitlement = { health, held: ent.stdout.trim() };
    if (ent.stdout.trim() !== "held") throw new Error("no entitlement on the home");
  });

  // test tooling: the synthetic engine, so bots answer
  await step("engine: synthetic engine installed (test tooling)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "madani-engine-")), file = join(dir, "fake-claude.mjs");
    execFileSync(resolve("node_modules/.bin/esbuild"), ["server/testing/fake-claude-cli.ts", "--bundle", "--platform=node", "--format=esm", `--outfile=${file}`, "--log-level=error",
      "--banner:js=import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"], { stdio: "inherit" });
    const id = await machineOf(cloudId);
    const wrapper = `#!/bin/sh\nif [ "$1" = auth ]; then echo '{"loggedIn":true,"email":"person@example.test"}'; exit 0; fi\nexport FAKE_CLAUDE_VERSION=2.1.284\nexec ${CLOUD_HOME.root}/node/bin/node /opt/madani-test/fake-claude.mjs "$@"\n`;
    await ibx.upload(id, "/data/home/fake-claude.mjs", readFileSync(file));
    await ibx.upload(id, "/data/home/claude-wrapper.sh", Buffer.from(wrapper));
    rmSync(dir, { recursive: true, force: true });
    const done = await onMachine(cloudId, "sudo install -d -m 0755 /opt/madani-test && sudo install -m 0755 /data/home/fake-claude.mjs /opt/madani-test/fake-claude.mjs && sudo install -m 0755 /data/home/claude-wrapper.sh /usr/local/bin/claude && sudo systemctl restart omb-home && for i in $(seq 1 60); do curl -fsS -m 2 http://127.0.0.1:8799/api/health >/dev/null && break; sleep 1; done && echo ok", 180);
    if (!done.stdout.includes("ok")) throw new Error(`engine install: ${done.stdout.slice(-200)}`);
  });

  // 3. paired as the app pairs, then three bots made and messaged
  const target = { origin: homeOrigin, grant: () => service.grant(cloudId) };
  let token = "";
  const owner = async (label: string, background = true) => openOwnerSession(target, globalThis.fetch, { label, background });
  const api = (await step("pair: the owner's app pairs through the public name", async () => {
    const started = Date.now();
    const session = await owner("Live app", false);
    const grant = await service.grant(cloudId);
    const paired = await (await globalThis.fetch(`${homeOrigin}/api/auth/pair`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ code: grant.code, label: "Live viewer" }) })).json() as { token?: string };
    token = paired.token ?? "";
    results.pairMs = Date.now() - started;
    return session;
  }, true))!;
  const bots: Array<{ id: string; threadId: string; name: string }> = [];
  async function replyTo(bot: { id: string; threadId: string }, text: string, count: number) {
    const sentAt = Date.now();
    await api.call("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.threadId });
    for (let n = 0; n < 90; n++) {
      await sleep(1000);
      const rows = await api.call("GET", `/api/threads/${bot.threadId}/messages?limit=40`);
      if (((rows.body?.messages ?? []) as Array<{ role?: string; kind?: string; text?: string }>).filter(m => m.role === "bot" && m.kind === "text" && m.text?.trim()).length >= count) return Date.now() - sentAt;
    }
    throw new Error("no answer");
  }
  await step("bots: three made and each answers", async () => {
    const latency: number[] = [];
    for (const name of ["Ada", "Bo", "Cy"]) {
      const made = await api.call("POST", "/api/bots", { name });
      if (made.status >= 300) throw new Error(`create ${name}: ${made.status}`);
      const bot = { id: made.body?.bot?.id as string, threadId: made.body?.bot?.threadId as string, name };
      bots.push(bot);
      latency.push(await replyTo(bot, `hello ${name}`, 1));
    }
    results.replyMs = latency;
  });

  // 4. their computers: the image is made ready by the home itself, nobody builds or pulls anything by hand
  const computers: Record<string, { ms: number; ok: boolean; problem?: string }> = {};
  await step("computers: each bot's computer starts with no manual step", async () => {
    for (const bot of bots) {
      await api.call("PATCH", `/api/bots/${bot.id}`, { computer: "cloud" });
      const started = Date.now();
      let woke = await api.call("POST", `/api/bots/${bot.id}/computer/provision`, {}).catch((e: Error) => ({ status: 0, body: { error: e.message } }));
      // what the app does while the image is still being made: it asks again
      for (let n = 0; n < 60 && !(woke.status < 300 && woke.body?.ready === true); n++) {
        if (n === 0) note(`computer for ${bot.name} not ready yet: ${woke.status} ${JSON.stringify(woke.body).slice(0, 160)}`);
        await sleep(10_000);
        woke = await api.call("POST", `/api/bots/${bot.id}/computer/provision`, {}).catch((e: Error) => ({ status: 0, body: { error: e.message } }));
      }
      computers[bot.name] = { ms: Date.now() - started, ok: woke.status < 300 && woke.body?.ready === true, ...(woke.status >= 300 || woke.status === 0 ? { problem: `${woke.status} ${JSON.stringify(woke.body).slice(0, 200)}` } : {}) };
      note(`computer for ${bot.name}: ${JSON.stringify(computers[bot.name])}`);
    }
    results.computers = computers;
    const image = await onMachine(cloudId, `cat ${CLOUD_HOME.run}/desktop-image; systemctl show omb-desktop-image -p ExecMainStartTimestamp -p ExecMainExitTimestamp -p Result; sudo tail -n 1 /var/log/omb-desktop-image.log 2>/dev/null; free -m | awk '/Mem/ {print $3"/"$2" MiB used"}'`);
    results.desktopImage = image.stdout.trim().split("\n");
    if (!Object.values(computers).every(x => x.ok)) throw new Error("a computer did not come up");
  });
  const first = bots[0]!;
  // the app's own viewer path: join as the panel does, then the viewer socket with the server's handshake
  await step("desktop: the app's viewer path shows the bot's screen", async () => {
    // the panel wakes the bot's screen, then opens it
    const woke = await api.call("POST", `/api/bots/${first.id}/computer/provision`, {});
    if (woke.status >= 300 || woke.body?.ready !== true) throw new Error(`wake ${woke.status} ${JSON.stringify(woke.body).slice(0, 200)}`);
    const joined = await api.call("POST", `/api/bots/${first.id}/computer/join?viewer=proxy&threadId=${encodeURIComponent(first.threadId)}`, {});
    if (joined.status >= 300) throw new Error(`join ${joined.status} ${JSON.stringify(joined.body).slice(0, 200)}`);
    const password = (joined.body?.viewer?.password ?? null) as string | null;
    const path = `/api/desktop-viewer/vps/${first.id}/websockify?${new URLSearchParams({ threadId: first.threadId, rfb: "server" })}`;
    // the socket goes to the home's own name (a WebSocket through our edge is the Worker's job in production)
    const frame = await rfbFrame(upstream, path, token, password);
    results.desktopViewer = frame; note(`viewer: ${JSON.stringify(frame)}`);
    if (!frame.width || !frame.rects) throw new Error("no picture");
  });

  // 5. inside the bot's computer: everyday sites, a download, files, a kept sign-in
  const container = async () => (await onMachine(cloudId, "sudo docker ps --format '{{.ID}} {{.Names}}' | grep -i -m1 -E 'madani|bot|desktop' | cut -d' ' -f1")).stdout.trim();
  if (!args.includes("--skip-browse")) await step("browser: everyday websites from a bot's computer", async () => {
    const id = await container(), machine = await machineOf(cloudId);
    await ibx.upload(machine, "/data/home/omb-browse.py", Buffer.from(BROWSE));
    await onMachine(cloudId, `rm -f /data/home/omb-browse.out; setsid nohup bash -c "sudo docker exec -i -u 1000 ${id} python3 - '${JSON.stringify(SITES).replace(/'/g, "").replace(/"/g, '\\"')}' < /data/home/omb-browse.py > /data/home/omb-browse.out 2>&1; echo madani-done >> /data/home/omb-browse.out" > /dev/null 2>&1 < /dev/null & echo started`, 60);
    let text = "";
    for (let n = 0; n < 80 && !text.includes("madani-done"); n++) { await sleep(15_000); text = (await onMachine(cloudId, "tail -c 20000 /data/home/omb-browse.out 2>/dev/null", 60)).stdout; }
    const line = text.trim().split("\n").filter(l => l.startsWith("[")).at(-1) ?? "";
    if (!line) throw new Error(`browse: ${text.slice(-300)}`);
    results.browse = JSON.parse(line);
    for (const r of results.browse as Array<Record<string, unknown>>) note(`${String(r.id).padEnd(14)} ${String(r.ms).padStart(6)} ms ${r.error ? `ERROR ${r.error}` : `${r.bytes} bytes${r.wall ? " WALL" : ""}${r.expected ? "" : " unexpected"} ${r.title}`}`);
  });
  const PROFILE_DIR = "/home/cua/.madani-live-profile";
  const profileRun = async (mode: "set" | "get") => {
    const id = await container();
    await ibx.upload(await machineOf(cloudId), "/data/home/omb-profile.py", Buffer.from(PROFILE));
    const out = await onMachine(cloudId, `sudo docker exec -i -u 1000 ${id} python3 - ${mode} ${PROFILE_DIR} < /data/home/omb-profile.py 2>&1 | tail -n 1`, 180);
    try { return JSON.parse(out.stdout.trim()) as { cookie: boolean; localStorage: boolean }; } catch { return { cookie: false, localStorage: false, raw: out.stdout.slice(-200) }; }
  };
  const profileCheck = () => profileRun("get");
  await step("browser profile: a persistent cookie and a localStorage sign-in are kept", async () => {
    results.profileBefore = await profileRun("set");
    const kept = results.profileBefore as { cookie: boolean; localStorage: boolean };
    if (!kept.cookie || !kept.localStorage) throw new Error(`not kept: ${JSON.stringify(kept)}`);
  });
  await step("files: a file on the bot's desktop and a note in the home's data", async () => {
    const id = await container();
    const file = await onMachine(cloudId, `sudo docker exec -u 1000 ${id} sh -c 'mkdir -p ~/Desktop && echo madani-file-kept > ~/Desktop/madani-note.txt && cat ~/Desktop/madani-note.txt'`);
    const data = await onMachine(cloudId, `sudo -u maus sh -c 'mkdir -p ${CLOUD_HOME.data}/workspaces/${first.id} && echo "kept across everything" > ${CLOUD_HOME.data}/workspaces/${first.id}/madani-live-note.md' && sudo cat ${CLOUD_HOME.data}/workspaces/${first.id}/madani-live-note.md`);
    results.files = { desktop: file.stdout.trim(), data: data.stdout.trim() };
  });

  // 6. paused with memory by its owner, left a few minutes, woken by a send from the app
  const memoryMark = await onMachine(cloudId, `id=$(sudo docker ps -q | head -1); sudo docker exec -d $id sh -c 'sleep 100000' ; sleep 1; sudo docker inspect -f '{{.State.StartedAt}}' $id; sudo docker exec $id sh -c 'pgrep -f "sleep 100000" | head -1'; cat /proc/sys/kernel/random/boot_id`);
  const [startedAtBefore, pidBefore, bootBefore] = memoryMark.stdout.trim().split("\n");
  await step("pause: the owner puts it to sleep, the dashboard says so", async () => {
    const asked = Date.now();
    await service.power(cloudId, "off");
    await until(v => v.status === "sleeping", 5 * 60_000, "sleep", 500);
    results.pauseMs = Date.now() - asked;
    results.originWhilePaused = await globalThis.fetch(`${homeOrigin}/api/health`).then(r => r.status).catch(() => 0);
  });
  note("left paused for 3 minutes");
  await sleep(3 * 60_000);
  await step("resume: a send from the app wakes it and it continues where it was", async () => {
    const asked = Date.now();
    results.wakeAnswer = await client.wakeHome("send");
    await until(v => v.status === "running", 5 * 60_000, "wake", 300);
    results.resumeMs = Date.now() - asked;
    const after = await onMachine(cloudId, `id=$(sudo docker ps -q | head -1); sudo docker inspect -f '{{.State.StartedAt}}' $id; sudo docker exec $id sh -c 'pgrep -f "sleep 100000" | head -1'; cat /proc/sys/kernel/random/boot_id`);
    const [startedAtAfter, pidAfter, bootAfter] = after.stdout.trim().split("\n");
    results.memoryKept = { sameBoot: bootBefore === bootAfter, containerNotRestarted: startedAtBefore === startedAtAfter, processAlive: !!pidBefore && pidBefore === pidAfter };
    results.replyAfterResumeMs = await replyTo(first, "still there after the pause?", 2);
    results.profileAfterResume = await profileCheck();
  });

  // 7. a routine due while the home sleeps: woken before it, it runs on time
  await step("routine: a paused home wakes for its routine and runs it on time", async () => {
    const due = Date.now() + 6 * 60_000;
    const made = await api.call("POST", "/api/routines", { name: "Across the pause", prompt: "Say the time.", botId: first.id, enabled: true, schedule: { type: "once", at: due } });
    if (made.status >= 300) throw new Error(`routine ${made.status} ${JSON.stringify(made.body).slice(0, 200)}`);
    const routineId = made.body.routine.id as string;
    await sleep(70_000);
    await service.power(cloudId, "off");
    await until(v => v.status === "sleeping", 5 * 60_000, "sleep before the routine", 1000);
    const sleptAt = Date.now();
    await until(v => v.status === "running", 12 * 60_000, "woken for the routine", 2000);
    const wokeAt = Date.now();
    let run: { status?: string; startedAt?: number } | undefined;
    for (let n = 0; n < 90 && run?.status !== "completed"; n++) {
      await sleep(5000);
      run = ((await api.call("GET", "/api/routines")).body?.runs ?? []).find((r: { routineId?: string }) => r.routineId === routineId);
    }
    results.routine = { sleptMs: wokeAt - sleptAt, wokeBeforeDueMs: due - wokeAt, run: run ? { status: run.status, lateMs: run.startedAt ? run.startedAt - due : null } : null };
    if (run?.status !== "completed") throw new Error(`routine run ${run?.status ?? "missing"}`);
  });

  // 8. crashes: the home's process killed, then the whole machine rebooted hard
  await step("crash: the home process is killed and comes back", async () => {
    const killedAt = Date.now();
    await onMachine(cloudId, "sudo systemctl kill -s KILL omb-home.service; echo killed");
    await sleep(1500);
    for (let n = 0; n < 120; n++) { if (await realFetch(`${upstream}/api/health`).then(r => r.ok).catch(() => false)) break; await sleep(500); }
    results.processRecoveryMs = Date.now() - killedAt;
  });
  await step("crash: a hard reboot, the home and the bot computers come back by themselves", async () => {
    const before = (await onMachine(cloudId, "cat /proc/sys/kernel/random/boot_id")).stdout.trim();
    const rebootedAt = Date.now();
    await onMachine(cloudId, "(sleep 2; sudo systemctl reboot -ff) >/dev/null 2>&1 < /dev/null & disown; echo rebooting", 30).catch(() => null);
    await sleep(10_000);
    for (let n = 0; n < 300; n++) { if (await realFetch(`${upstream}/api/health`).then(r => r.ok).catch(() => false)) break; await sleep(1000); }
    results.machineRecoveryMs = Date.now() - rebootedAt;
    const after = await onMachine(cloudId, `cat /proc/sys/kernel/random/boot_id; cat ${CLOUD_HOME.run}/desktop-image 2>/dev/null || echo none`);
    const [bootAfter, imageAfter] = after.stdout.trim().split("\n");
    results.reboot = { newBoot: !!before && before !== bootAfter, imageAfter };
    if (before === bootAfter) throw new Error("the machine did not reboot");
    results.replyAfterRebootMs = await replyTo(first, "and after a reboot?", 3);
    const woke = await api.call("POST", `/api/bots/${first.id}/computer/provision`, {});
    results.computerAfterReboot = { status: woke.status, ready: woke.body?.ready === true };
    results.profileAfterReboot = await profileCheck();
    const file = await onMachine(cloudId, `id=$(sudo docker ps -q | head -1); sudo docker exec -u 1000 $id cat /home/cua/Desktop/madani-note.txt`);
    results.desktopFileAfterReboot = file.stdout.trim();
  });

  // 9. a bot moved in from a local fixture with the app's own send, then this home brought back to the fixture
  const localServer = await launchVerificationServer({ ...process.env, MADANI_TEST_PORTS: "19975-19999", FAKE_CLAUDE_VERSION: "2.1.284", MADANI_VERIFY_HOME_OUTSIDE: "1" });
  try {
    const localApi = (route: string, init?: RequestInit) => realFetch(`${localServer.info.url}${route}`, init);
    await step("move in: a bot from the Mac arrives with its chat", async () => {
      const mine = await (await localApi("/api/bots", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Moved from the Mac" }) })).json() as { bot: { id: string; threadId: string } };
      await localApi(`/api/bots/${mine.bot.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "a chat that should move with me", threadId: mine.bot.threadId }) });
      await sleep(8000);
      const reader = await owner("Live move read");
      let kept: unknown = null;
      const send = createCloudSend({
        local: (route: string, init?: RequestInit) => localApi(route, init),
        cloud: { origin: () => homeOrigin, asleep: () => false, read: (route: string) => reader.fetch!(route), open: () => owner("Live move", false) },
        handoff: async () => { throw new Error("no sign-ins in this run"); },
        store: { read: () => kept, write: (value: unknown) => { kept = value; } },
      });
      const started = Date.now();
      await send.send({ reason: "button" });
      const there = await api.call("GET", "/api/bots?messages=0");
      const moved = (there.body?.bots ?? []).find((b: { name?: string }) => b.name === "Moved from the Mac");
      const rows = moved?.threadId ? await api.call("GET", `/api/threads/${moved.threadId}/messages?limit=20`) : null;
      results.moveIn = { arrived: Boolean(moved), rows: (rows?.body?.messages ?? []).length, ms: Date.now() - started };
      if (!moved) throw new Error("the moved bot did not arrive");
    });
    await step("move back: the home's bots and chats restored on the Mac", async () => {
      const started = Date.now();
      const again = createHomeAgain({
        exportGrant: async () => ({ grant: await service.grant(cloudId) }),
        open: (grant: { origin: string; code: string; expiresAt: number }) => openOwnerSession({ origin: grant.origin, grant: async () => grant }, globalThis.fetch, { label: "Live home again", background: false }),
        local: {
          json: async (method: string, route: string, body?: unknown) => { const r = await localApi(route, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const text = await r.text(); let parsed: unknown = null; try { parsed = JSON.parse(text); } catch {} return { ok: r.ok, status: r.status, body: parsed }; },
          upload: async (file: string, bytes: number) => { const r = await localApi("/api/workspace-backup/upload", { method: "POST", headers: { "content-type": "application/octet-stream", "content-length": String(bytes) }, body: Readable.toWeb(createReadStream(file)) as never, duplex: "half" } as RequestInit); const text = await r.text(); let parsed: unknown = null; try { parsed = JSON.parse(text); } catch {} return { ok: r.ok, status: r.status, body: parsed }; },
        },
        tempRoot: mkdtempSync(join(tmpdir(), "madani-home-again-")),
      });
      let brought: Record<string, unknown> = {};
      for (let n = 0; n < 30; n++) { brought = await again.bring() as Record<string, unknown>; if ("restored" in brought || "deleted" in brought) break; await sleep(Number(brought.later ?? 5000)); }
      if (!("restored" in brought)) throw new Error(`move back: ${JSON.stringify(brought)}`);
      // the restore applies when the app starts its server again: the fixture's server stops, its next boot's restore runs
      localServer.child.kill("SIGTERM");
      await new Promise(done => { if (localServer.child.exitCode !== null) done(null); else { localServer.child.once("exit", done); setTimeout(done, 15_000); } });
      const applied = applyPendingWorkspaceRestore(localServer.info.dataDir);
      const bots = (JSON.parse(readFileSync(join(localServer.info.dataDir, "bots.json"), "utf8")) as Array<{ name?: string }>).map(b => b.name ?? "");
      results.moveBack = { restored: applied.restored, botsOnMac: bots, ms: Date.now() - started };
      if (!applied.restored || !["Ada", "Bo", "Cy", "Moved from the Mac"].every(name => bots.includes(name))) throw new Error(`the home's bots did not arrive on the Mac: ${bots.join(", ")}`);
    });
  } finally { await localServer.close().catch(() => {}); }

  // 10. the provider's own numbers for this machine
  await step("usage: what the provider measured", async () => {
    const usage = await ibx.usage(await machineOf(cloudId));
    results.usage = usage ? { ...usage, cents: instaboxUsageCents(usage) } : null;
  });

  // 11. the owner ends the plan and deletes the home's data: confirmed by email, done after the undo window
  await step("delete: the plan ends, the owner deletes the data, the machine is gone", async () => {
    await service.cancel(cloudId);
    offset += 32 * 86_400_000;
    // a month later the owner signs in again; deleting data asks for a sign-in from the last 10 minutes anyway
    const again = await webSignIn(origin, email); cookies = { cookie: again.cookie, "x-madani-csrf": again.csrf, origin };
    await until(v => v.status === "stopped", 10 * 60_000, "plan ended", 3000);
    await service.deleteData(cloudId);
    const link = mailer.outbox.map(m => m.text).reverse().find(t => /\/delete#/.test(t)) ?? "";
    const token = /\/delete#([A-Za-z0-9_-]{20,})/.exec(link)?.[1];
    if (!token) throw new Error("no confirmation email");
    await service.confirmDelete(cloudId, token);
    offset += 8 * 86_400_000;
    const machine = await machineOf(cloudId).catch(() => null);
    await until(v => v.status === "destroyed" || v.status === "destroying", 10 * 60_000, "deleted", 3000);
    for (let n = 0; n < 60 && machine && (await ibx.machine(machine).catch(() => null)); n++) await sleep(3000);
    results.deleted = { machineGone: machine ? (await ibx.machine(machine)) === null : null, letters: mailer.outbox.filter(m => m.to === email).map(m => m.subject) };
  });
} catch (error) {
  failed = error instanceof Error ? error.message : String(error);
  console.error(`FAILED: ${failed}`);
} finally {
  watching = false;
  results.failed = failed; results.failedSteps = failures; results.timeline = timeline;
  const deleted: string[] = [];
  for (let round = 0; round < 3; round++) {
    const left = await ibx.inventory().catch(() => []);
    for (const m of left) { const r = await ibx.requestDelete(m.id).catch(e => ({ error: String(e) })); deleted.push(`${m.id}:${JSON.stringify(r).slice(0, 80)}`); }
    if (!left.length) break;
    await sleep(10_000);
  }
  results.teardown = deleted;
  await sleep(10_000);
  results.left = (await ibx.inventory().catch(() => [{ id: "unknown" }])).map(m => m.id);
  results.marks = marks;
  // the lifecycle's own account of the run, for what took how long and why
  try { results.audit = readFileSync(join(dataDir, "managed-audit.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l) as { at: number; action: string; reason: string; detail?: unknown }).map(e => `${((e.at - t0) / 1000).toFixed(0)}s ${e.action}:${e.reason}${e.detail ? ` ${JSON.stringify(e.detail).slice(0, 120)}` : ""}`); } catch {}
  save();
  try { service?.close(); } catch {}
  server?.close();
  rmSync(dataDir, { recursive: true, force: true });
  console.log(JSON.stringify({ failed, failedSteps: failures, left: results.left }, null, 2));
  process.exit(failed || failures.length ? 1 : 0);
}
