// One end-to-end run of a managed My Cloud: paid (fake billing), provisioned on InstaBox, paired, a bot made and messaged
// with a synthetic engine, a bot moved there from a local fixture with the app's own send, slept, backed up, woken, its
// machine deleted and rebuilt from the backup, then everything this run made deleted and proven gone. With --fake it
// also wakes the home through the public edge, rolls a signed update out to the running home and rolls a second one back
// after its self-test fails.
//
//   node --experimental-strip-types apps/cloud-service/scripts/e2e.ts --fake                     # loopback fake InstaBox, no VM
//   INSTABOX_API_KEY=... node --experimental-strip-types apps/cloud-service/scripts/e2e.ts --package release/home/omb-home.tgz --engine <fake-claude.mjs> --ledger <file>
//
// Real runs create at most two 2 vCPU machines (the cloud, and its rebuild) under a scope label of their own, and the
// teardown deletes every machine with that label whatever happened. Prints timings and ids, never a key or a token.
import { CLOUD_HOME } from "../../../electron/legacy-names.mjs";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http, { createServer } from "node:http";
import { generateEntitlementSigner } from "../../../shared/entitlement.ts";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createBilling } from "../../dashboard/server/billing/index.ts";
import { createStore } from "../../dashboard/server/store.ts";
import { startFakeInstaboxApi } from "../src/fake-instabox-api.ts";
import { createInstaboxProvider } from "../src/instabox.ts";
import { createCloudSend } from "../../../electron/cloud-send.mjs";
import { openOwnerSession } from "../../../electron/cloud-send-main.mjs";
import { launchVerificationServer } from "../../../scripts/control-madani.ts";
import { pagesRoutesFromEnv } from "../../dashboard/server/pages/routes.ts";
import { createSealer, parseSealKey } from "../../dashboard/server/clouds/seal.ts";
import { createPagesClient } from "../../../server/pages/client.ts";
import edge from "../edge/worker.js";
import { signRelease } from "../src/release-signing.ts";
import { fakeHookQueues } from "../src/fake-hook-queue.ts";

const args = process.argv.slice(2), fake = args.includes("--fake");
const option = (name: string) => { const at = args.indexOf(name); return at === -1 ? null : args[at + 1] ?? null; };
const scope = randomBytes(8).toString("hex");
const ledger = option("--ledger");
const t0 = Date.now(), marks: Array<{ step: string; ms: number; at: string }> = [];
let last = t0;
function mark(step: string) { const now = Date.now(); marks.push({ step, ms: now - last, at: new Date(now).toISOString() }); console.log(`[${((now - t0) / 1000).toFixed(1)}s] ${step} (+${((now - last) / 1000).toFixed(1)}s)`); last = now; }
function note(line: string) { console.log(`  ${line}`); if (ledger) appendFileSync(ledger, `${new Date().toISOString()} ${line}\n`); }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const dataDir = mkdtempSync(join(tmpdir(), "madani-managed-e2e-"));
const api = fake ? await startFakeInstaboxApi() : null;
// --fake: a release key of this run's own signs every home package, so the update path runs signed end to end; each fake
// machine keeps the version it runs and the one before, and a version listed here fails its self-test
const releaseKey = fake ? generateKeyPairSync("ed25519").privateKey : null;
const releaseSigning = releaseKey ? `e2e-rel:${releaseKey.export({ format: "der", type: "pkcs8" }).toString("base64url")}` : null;
const releasePublic = releaseKey ? `e2e-rel:${createPublicKey(releaseKey).export({ format: "jwk" }).x}` : null;
const versions = new Map<string, string>(), apps = new Map<string, { now: string | null; before: string | null }>(), failingSelfTest = new Set<string>();
const signedPackage = (version: string, file: string) => {
  writeFileSync(file, `fake package ${version}`);
  const sum = createHash("sha256").update(readFileSync(file)).digest("hex");
  versions.set(sum, version);
  return { sha256: sum, file, signature: signRelease({ kind: "home-package", name: "omb-home", version, sha256: sum, signedAt: Date.now() }, releaseSigning!) };
};
if (api) api.onExec(({ machine, cmd }) => {
  if (cmd.includes("omb-home start") && !machine.volume.size) {
    machine.volume.set("data/.omb-cloud-home.json", Buffer.from(JSON.stringify({ version: 1, machine: machine.metadata["omb.cloud"] })));
    machine.volume.set(`data/${CLOUD_HOME.dataName}/config.json`, Buffer.from("{}"));
  }
  const app = apps.get(machine.id) ?? { now: null, before: null };
  apps.set(machine.id, app);
  if (cmd.includes("omb-home install")) { const sum = /omb-home install \S+ ([a-f0-9]{64})/.exec(cmd)?.[1] ?? ""; app.before = app.now; app.now = versions.get(sum) ?? null; return { exitCode: 0, stdout: "installed\n" }; }
  if (cmd.includes("omb-home rollback")) { if (!app.before) return { exitCode: 2, stdout: "nothing to roll back to\n" }; app.now = app.before; app.before = null; return { exitCode: 0, stdout: "rolled back\n" }; }
  return null;
});
const key = api?.key ?? process.env.INSTABOX_API_KEY, baseUrl = api?.baseUrl ?? process.env.INSTABOX_BASE_URL;
if (!key) { console.error("INSTABOX_API_KEY is required (or --fake)."); process.exit(2); }
const packageFile = fake ? join(dataDir, "pkg.tgz") : resolve(option("--package") ?? "release/home/omb-home.tgz");
const firstRelease = fake ? signedPackage("1.0.0", packageFile) : null;
const sha256 = createHash("sha256").update(readFileSync(packageFile)).digest("hex");
const releaseFile = join(dataDir, "home-release.json");
const ops = createInstaboxProvider({ apiKey: key, baseUrl, scope, ...(fake ? { pollMs: 1 } : {}) });

// the homes' signed reads go to the real origins; in --fake mode the "homes" answer from here
const hooksSeen: string[] = [];
// what the fake homes say about their power: at work until the lifecycle scenario changes it
const fakePower: { idle: boolean; busy: string[]; lastActivityAt: number | null; nextDueAt: number | null } = { idle: false, busy: ["turn"], lastActivityAt: null, nextDueAt: null };
// the runs the fake homes say finished (the update scenario's trial reads them)
const fakeRuns: Array<{ id: string; ok: boolean; at: number }> = [];
// the edge step swaps the global fetch for the Worker's; everything else keeps the real one
const realFetch = globalThis.fetch;
const homeFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (fake && url.hostname.endsWith(".instabox.tech")) {
    const up = [...api!.machines.values()].find(x => [...x.ports.values()].some(u => new URL(u).hostname === url.hostname));
    if (up && up.state !== "running") return new Response("down", { status: 503 });
    if (url.pathname.startsWith("/hooks/")) { hooksSeen.push(`${init?.method ?? "GET"} ${url.pathname} ${init?.body ? new TextDecoder().decode(init.body as ArrayBuffer) : ""}`); return new Response("ok", { status: 200 }); }
    const running = up ? apps.get(up.id)?.now ?? null : null;
    const body = url.pathname === "/api/cloud/health" ? { v: 1 } : url.pathname === "/api/cloud/power" ? { v: 1, ...fakePower }
      : url.pathname === "/api/cloud/update" ? { v: 1, version: running, selfTest: running && failingSelfTest.has(running) ? "failed" : "passed", runs: fakeRuns }
      : url.pathname === "/api/cloud/pairing" ? { code: "ABCD-EFGH-JKLM", expiresAt: Date.now() + 300_000 }
      : url.pathname === "/api/cloud/entitlement" ? { ok: true, expiresAt: Date.now() + 86_400_000 } : { ok: true };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }
  return realFetch(input, init);
};

// a real home is a release build: it trusts only the pinned entitlement key, so a real run signs with the production one
const entitlementKey = process.env.MADANI_ENTITLEMENT_SIGNING_KEY ?? (fake ? generateEntitlementSigner("dev-e2e").env : "");
if (!entitlementKey) { console.error("MADANI_ENTITLEMENT_SIGNING_KEY is required for a real run (the release home refuses anything else)."); process.exit(2); }
const sealKey = randomBytes(32).toString("base64url"), edgeToken = randomBytes(32).toString("base64url"), PUBLIC_DOMAIN = "desktops.e2e.invalid";
const store = createStore(dataDir);
const account = { id: "acct_e2e", email: "e2e@example.test" };
const billing = createBilling({ dataDir, publicUrl: "https://dashboard.e2e.invalid", dashboard: { state: store.state, changed: () => store.changed() }, fetch: homeFetch,
  accounts: { fromCookie: () => account, fromBearer: () => account },
  mail: (cloud, letter) => note(`notice to owner: ${letter.subject} for ${cloud.id}`),
  alert: entry => note(`ALERT ${entry.action} ${entry.cloudId} (${entry.reason})`),
  env: { MADANI_BILLING_PROVIDER: "fake", MADANI_CLOUD_SEAL_KEY: sealKey, MADANI_MANAGED: "1", MADANI_MANAGED_EDGE_TOKEN: edgeToken, ...(fake ? { MADANI_MANAGED_PUBLIC_DOMAIN: PUBLIC_DOMAIN } : {}), INSTABOX_API_KEY: key, ...(baseUrl ? { INSTABOX_BASE_URL: baseUrl } : {}), MADANI_MANAGED_SCOPE: scope,
    MADANI_MANAGED_KINDS: "shared_s", MADANI_MANAGED_HOME_PACKAGE_FILE: packageFile, MADANI_MANAGED_HOME_PACKAGE_SHA256: sha256,
    ...(firstRelease ? { MADANI_MANAGED_HOME_PACKAGE_SIGNATURE: firstRelease.signature, MADANI_RELEASE_PUBLIC_KEYS: releasePublic!, MADANI_MANAGED_HOME_RELEASE_FILE: releaseFile } : {}), MADANI_MANAGED_LEASE_HOURS: "1", MADANI_MANAGED_IDLE_MINUTES: "5", MADANI_MANAGED_LOST_AFTER_MINUTES: "2", MADANI_POOL_DRIVER: "fake",
    // no machine can reach this harness, and nobody uses it: no claim, no public domain, an unsigned test package
    MADANI_MANAGED_TEST_HARNESS: "1", MADANI_ENTITLEMENT_SIGNING_KEY: entitlementKey } });
// published pages: the account service's own routes, with object storage in memory for this run
let pages: ReturnType<typeof pagesRoutesFromEnv>;
const webhooks = createServer((req, res) => void (async () => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (await pages.handle(req, res, url)) return;
  const managed = billing.clouds.managed;
  if (managed?.handle && await managed.handle(req, res, url, { publicUrl: hookBase, clientIp: () => "127.0.0.1", readJson: async () => ({}),
    json: (r, status, data) => { r.writeHead(status, { "content-type": "application/json" }); r.end(JSON.stringify(data)); } })) return;
  if (await billing.handle(req, res, url)) return;
  res.writeHead(404); res.end();
})());
await new Promise<void>(r => webhooks.listen(0, "127.0.0.1", r));
const hookBase = `http://127.0.0.1:${(webhooks.address() as { port: number }).port}`;
pages = pagesRoutesFromEnv({ dataDir, publicUrl: hookBase, clouds: billing.clouds, env: { MADANI_PAGES_STORE: "memory", MADANI_CLOUD_SEAL_KEY: sealKey } });

const created = new Set<string>();
async function track() { for (const s of await ops.inventory()) if (!created.has(s.id)) { created.add(s.id); note(`created machine ${s.id} (${s.type}) for ${s.cloudId}`); } }
let local: Awaited<ReturnType<typeof launchVerificationServer>> | null = null;
const results: Record<string, unknown> = { scope };

async function reconcileUntil(cloudId: string, done: () => boolean, limitMs: number, label: string) {
  const deadline = Date.now() + limitMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`${label}: timed out (status ${billing.clouds.get(cloudId)?.status}, step ${billing.clouds.get(cloudId)?.setupStep}, error ${billing.clouds.get(cloudId)?.error})`);
    const c = billing.clouds.get(cloudId)!; c.nextAttemptAt = 0;
    await billing.clouds.reconcile(); await track();
    if (!done()) await sleep(fake ? 200 : 3000);
  }
}
async function json(response: Response) { const text = await response.text(); try { return JSON.parse(text); } catch { return { raw: text.slice(0, 200) }; } }

try {
  mark("start");
  // 1. paid: a fake checkout completes and its signed webhooks activate the cloud
  const answer = await billing.service.checkout(account, { kind: "cart", cart: { interval: "month", license: { kind: "none" }, desktop: { kind: "shared_s", region: "us-west-2" } } } as never, { source: "e2e" } as never) as { cloudId: string };
  const checkout = (JSON.parse(readFileSync(join(dataDir, "billing.json"), "utf8")) as { checkouts: Array<{ providerSessionId: string | null; cloudId: string | null }> }).checkouts.at(-1)!;
  for (const delivery of billing.fake!.complete(checkout.providerSessionId!)) {
    const res = await fetch(`${hookBase}/v1/billing/webhooks/dodo`, { method: "POST", headers: { "content-type": "application/json", ...delivery.headers }, body: new Uint8Array(delivery.body) });
    if (!res.ok) throw new Error(`webhook refused: ${res.status}`);
  }
  const cloudId = answer.cloudId ?? checkout.cloudId!;
  const cloud = () => billing.clouds.get(cloudId)!;
  note(`cloud ${cloudId} backend=${cloud().backend} status=${cloud().status}`);
  mark("paid and activated");

  // 2. provisioned on InstaBox
  await reconcileUntil(cloudId, () => cloud().status === "running", 25 * 60_000, "provision");
  note(`origin ${cloud().origin} machine ${cloud().serverId}`);
  results.provisionMs = Date.now() - last; mark("provisioned and healthy");

  // a synthetic engine on the home, so a bot can answer (test tooling only, never part of the product install)
  if (!fake) {
    const engine = readFileSync(resolve(option("--engine")!));
    const wrapper = `#!/bin/sh\nif [ "$1" = auth ]; then echo '{"loggedIn":true,"email":"person@example.test"}'; exit 0; fi\nexport FAKE_CLAUDE_VERSION=2.1.284\nexec ${CLOUD_HOME.root}/node/bin/node /opt/madani-test/fake-claude.mjs "$@"\n`;
    await ops.upload(cloud().serverId!, "/data/home/fake-claude.mjs", engine);
    await ops.upload(cloud().serverId!, "/data/home/claude-wrapper.sh", Buffer.from(wrapper));
    const done = await ops.run(cloud().serverId!, "sudo install -d -m 0755 /opt/madani-test && sudo install -m 0755 /data/home/fake-claude.mjs /opt/madani-test/fake-claude.mjs && sudo install -m 0755 /data/home/claude-wrapper.sh /usr/local/bin/claude && sudo systemctl restart omb-home && sleep 10 && echo ok", 120);
    note(`synthetic engine installed: ${done.ok}`);
  }

  // 3. linked: the account's pairing, redeemed at the home as the app redeems it
  const target = { origin: cloud().origin!, grant: () => billing.clouds.pair(account.id, cloudId) };
  let session: Awaited<ReturnType<typeof openOwnerSession>> | null = null;
  if (!fake) {
    session = await openOwnerSession(target, fetch, { label: "Cloud e2e", background: false });
    const health = await session.call("GET", "/api/health");
    note(`paired; /api/health ${health.status}`);
    mark("paired");
    // 4. a bot made there, and messaged
    const made = await session.call("POST", "/api/bots", { name: "Cloud e2e bot" });
    const botId = made.body?.bot?.id as string, threadId = made.body?.bot?.threadId as string;
    note(`bot on the cloud: ${made.status} ${botId}`);
    const sent = await session.call("POST", `/api/bots/${botId}/messages`, { text: "hello from the cloud e2e run", threadId });
    let reply: string | null = null;
    for (let n = 0; n < 60 && !reply; n++) {
      await sleep(2000);
      const rows = await session.call("GET", `/api/threads/${threadId}/messages?limit=20`);
      const messages = (rows.body?.messages ?? []) as Array<{ role?: string; kind?: string; text?: string }>;
      reply = messages.find(m => m.role === "bot" && m.kind === "text" && m.text?.trim())?.text ?? null;
    }
    note(`message sent ${sent.status}; reply: ${reply ? JSON.stringify(reply.slice(0, 80)) : "none"}`);
    results.botId = botId; results.reply = reply !== null;
    mark("bot made and answered");

    // 5. a bot moved there from this computer, with the app's own send (cloud-send.mjs)
    local = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_VERSION: "2.1.284" });
    const localApi = (route: string, init?: RequestInit) => fetch(`${local!.info.url}${route}`, init);
    const mine = await json(await localApi("/api/bots", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Moved to the cloud" }) }));
    const movedId = mine.bot.id as string;
    const localSent = await localApi(`/api/bots/${movedId}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "a chat that should move with me", threadId: mine.bot.threadId }) });
    await sleep(8000);
    note(`local bot ${movedId}: message ${localSent.status}`);
    const reader = await openOwnerSession(target, fetch, { label: "Cloud e2e read", background: true });
    let kept: unknown = null;
    const send = createCloudSend({
      local: (route: string, init?: RequestInit) => localApi(route, init),
      cloud: { origin: () => target.origin, asleep: () => false, read: (route: string) => reader.fetch!(route),
        open: () => openOwnerSession(target, fetch, { label: "Cloud e2e move", background: false }) },
      handoff: async () => { throw new Error("no sign-ins in this run"); },
      store: { read: () => kept, write: (value: unknown) => { kept = value; } },
    });
    let outcome: unknown;
    try { outcome = await send.send({ reason: "button" }); } catch (error) { note(`send failed: ${error instanceof Error ? error.message : String(error)}`); }
    const there = await session.call("GET", "/api/bots?messages=0");
    const movedThere = (there.body?.bots ?? []).find((b: { name?: string }) => b.name === "Moved to the cloud");
    const arrived = Boolean(movedThere);
    if (movedThere?.threadId) { const rows = await session.call("GET", `/api/threads/${movedThere.threadId}/messages?limit=20`); note(`moved chat rows on the cloud: ${(rows.body?.messages ?? []).length}`); results.movedRows = (rows.body?.messages ?? []).length; }
    note(`moved bot arrived on the cloud: ${arrived}; sent ${JSON.stringify((outcome as { result?: { bots?: unknown[] } } | undefined)?.result?.bots?.length ?? null)} bots`);
    results.moved = arrived;
    mark("bot moved there");
  }

  // 6. paused: the owner sleeps it (the idle handshake is the same stop), and its volume, read from the running home first,
  // is backed up off the provider
  await billing.clouds.power(account.id, cloudId, "off");
  await reconcileUntil(cloudId, () => cloud().status === "sleeping", 10 * 60_000, "sleep");
  mark("asleep (machine paused)");
  await reconcileUntil(cloudId, () => (cloud().managed?.backups.at(-1)?.verifiedAt ?? null) !== null, 15 * 60_000, "backup");
  const backup = cloud().managed!.backups.at(-1)!;
  note(`backup ${backup.file}: ${backup.bytes} bytes, verified`);
  results.backupBytes = backup.bytes;
  mark("backed up and verified");

  // 6b. a page the bot published stays up while its machine sleeps: object storage behind our edge, no wake per view
  const secret = createSealer(parseSealKey(sealKey)).unseal(cloud().bootstrapSecret);
  const client = createPagesClient({ access: () => ({ kind: "home", url: `${hookBase}/api/cloud/pages/token`, machineId: cloudId, secret }) });
  const published = await client.publish({ title: "e2e report", files: [{ path: "index.html", data: Buffer.from("<h1>report</h1>") }] });
  if (!published.ok) throw new Error(`publish refused: ${published.message}`);
  const view = await new Promise<{ status: number; body: string; csp: string }>((resolveView) => {
    const req = (http.request)({ host: "127.0.0.1", port: Number(new URL(hookBase).port), path: "/", headers: { host: new URL(published.url).host } }, res => {
      let body = ""; res.on("data", d => { body += d; }); res.on("end", () => resolveView({ status: res.statusCode ?? 0, body, csp: String(res.headers["content-security-policy"] ?? "") }));
    });
    req.end();
  });
  note(`page ${published.url}: ${view.status} ${JSON.stringify(view.body)} while the machine is ${api ? api.machines.get(cloud().serverId!)!.state : "asleep"}; sandboxed ${view.csp.startsWith("sandbox")}`);
  results.pageServedAsleep = view.status === 200 && cloud().status === "sleeping";
  mark("page served while asleep");

  // 6c. a webhook through our public edge wakes the sleeping machine and is held until it answers (fake: no real domain)
  if (fake) {
    const env = { ROUTE_URL: hookBase, EDGE_TOKEN: edgeToken, PUBLIC_DOMAIN };
    const edgeFetch: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init), url = new URL(request.url);
      if (url.origin === hookBase) return realFetch(request);
      return homeFetch(url.href, { method: request.method, headers: request.headers, body: request.body ? await request.arrayBuffer() : undefined });
    };
    const real = globalThis.fetch;
    globalThis.fetch = edgeFetch;
    const asleepAt = Date.now();
    const looper = setInterval(() => { const c = cloud(); c.nextAttemptAt = 0; }, 100);
    try {
      const hook = await edge.fetch(new Request(`${cloud().origin}/hooks/github`, { method: "POST", body: "{\"ref\":\"main\"}" }), env, { waitUntil() {} });
      note(`webhook through the edge: ${hook.status}; delivered ${JSON.stringify(hooksSeen.at(-1))}; held ${Date.now() - asleepAt} ms`);
      results.webhookWoke = hook.status === 200 && cloud().status === "running";
      results.webhookWakeMs = Date.now() - asleepAt;
    } finally { globalThis.fetch = real; clearInterval(looper); }
    mark("webhook woke it through the edge");
    await billing.clouds.power(account.id, cloudId, "off");
    await reconcileUntil(cloudId, () => cloud().status === "sleeping", 10 * 60_000, "sleep again");

    // 6d. with the hook queue bound, the edge answers at once (202) and the queue delivers after the wake, from a fresh isolate
    const queued: Parameters<typeof edge.fetch>[1] = { ...env, HOOK_SEAL_KEY: randomBytes(32).toString("base64url") };
    const queues = fakeHookQueues(() => queued);
    queued.HOOK_QUEUE = queues.namespace;
    globalThis.fetch = edgeFetch;
    const quiet = console.log;
    const lines: string[] = [];
    console.log = (line: string) => { lines.push(line); };
    const sentAt = Date.now(), seen = hooksSeen.length, label = cloud().managed!.label!;
    const queueLooper = setInterval(() => { const c = cloud(); c.nextAttemptAt = 0; }, 100);
    try {
      const hook = await edge.fetch(new Request(`${cloud().origin}/hooks/github`, { method: "POST", body: "{\"ref\":\"queued\"}", headers: { "x-github-delivery": "e2e-1" } }), queued, { waitUntil() {} });
      const answeredMs = Date.now() - sentAt;
      queues.restart(label);
      for (let n = 0; n < 240 && hooksSeen.length === seen; n++) { await sleep(250); await queues.runAlarm(label); }
      console.log = quiet;
      note(`queued webhook: ${hook.status} in ${answeredMs} ms; delivered ${JSON.stringify(hooksSeen.at(-1))} after ${Date.now() - sentAt} ms; ${lines.filter(l => l.includes("edge_hook_delivered")).length} delivery line`);
      results.webhookQueued = hook.status === 202 && answeredMs < 2_000 && hooksSeen.length === seen + 1 && hooksSeen.at(-1)!.endsWith("{\"ref\":\"queued\"}") && cloud().status === "running";
      results.webhookQueuedMs = Date.now() - sentAt;
    } finally { console.log = quiet; globalThis.fetch = real; clearInterval(queueLooper); }
    if (!results.webhookQueued) throw new Error("the queued webhook was not delivered after the wake");
    mark("queued webhook delivered after the wake");
    await billing.clouds.power(account.id, cloudId, "off");
    await reconcileUntil(cloudId, () => cloud().status === "sleeping", 10 * 60_000, "sleep after the queued hook");
  }

  // 7. resumed for its owner
  await billing.clouds.power(account.id, cloudId, "on");
  await reconcileUntil(cloudId, () => cloud().status === "running", 10 * 60_000, "wake");
  results.wakeMs = Date.now() - last; mark("woken and healthy");

  // 7b. the power policy and its rails on the live service: a home that says it is idle is not stopped right after a wake,
  // nor while it works, nor with a run about to start; a burst of webhooks at an awake home starts nothing; and every
  // start this run made is in the ledger's rolling windows
  if (fake) {
    const decide = async () => { cloud().nextAttemptAt = 0; cloud().managed!.lastPowerAt = 0; await billing.clouds.reconcile(); return cloud().managed!.stayReason ?? null; };
    Object.assign(fakePower, { idle: true, busy: [], lastActivityAt: null, nextDueAt: null });
    const justWoken = [await decide(), await decide(), await decide()];
    // the same home, as if it had been up ten minutes (the rest of this run cannot wait out the real minimum uptime)
    cloud().powerSince = Date.now() - 10 * 60_000;
    Object.assign(fakePower, { idle: false, busy: ["turn"] });
    const working = await decide();
    Object.assign(fakePower, { idle: false, busy: ["due-soon"], nextDueAt: Date.now() + 2 * 60_000 });
    const runDue = await decide();
    const resumes = () => api!.requests.filter(r => r.method === "POST" && r.path.endsWith("/resume")).length, before = resumes();
    const burst: number[] = [];
    for (let n = 0; n < 10; n++) {
      const asked = await fetch(`${hookBase}/v1/managed/edge/wake?label=${cloud().managed!.label}&reason=webhook`, { method: "POST", headers: { authorization: `Bearer ${edgeToken}` } });
      burst.push(asked.status); await asked.body?.cancel(); await decide();
    }
    const ledger = JSON.parse(readFileSync(join(dataDir, "provider-starts.json"), "utf8")) as { v: number; times: number[] };
    results.lifecycle = { justWoken, working, runDue, status: cloud().status, startsInLedger: ledger.times.length, resumesDuringBurst: resumes() - before, burst: [...new Set(burst)], power: cloud().managed!.power?.starts.length ?? 0 };
    note(`power policy: just woken ${JSON.stringify(justWoken)}, working ${working}, run due ${runDue}; ledger v${ledger.v} holds ${ledger.times.length} starts`);
    if (cloud().status !== "running" || !justWoken.every(r => r === "min_uptime" || r?.startsWith("busy:")) || working !== "busy:turn" || runDue !== "busy:due-soon" || ledger.v !== 2 || ledger.times.length < 2 || resumes() !== before)
      throw new Error(`the power rails did not hold: ${JSON.stringify(results.lifecycle)}`);
    Object.assign(fakePower, { idle: false, busy: ["turn"], nextDueAt: null });
    mark("power policy and rails held");
  }
  // 7c. staged updates: a newer signed release goes in at an idle moment and settles after its self-test and two runs;
  // the next one fails its self-test and is rolled back to the version before on its own
  if (fake) {
    const pass = async () => { cloud().nextAttemptAt = 0; cloud().managed!.lastPowerAt = 0; await billing.clouds.reconcile(); };
    const running = () => apps.get(cloud().serverId!)?.now ?? null;
    const actions = () => (JSON.parse(`[${readFileSync(join(dataDir, "managed-audit.jsonl"), "utf8").trim().split("\n").join(",")}]`) as Array<{ cloudId: string; action: string; reason: string; detail?: Record<string, unknown> }>)
      .filter(e => e.cloudId === cloudId && e.action.startsWith("update_") && e.action !== "update_policy");
    Object.assign(fakePower, { idle: false, busy: ["turn"], nextDueAt: null });
    writeFileSync(releaseFile, JSON.stringify(signedPackage("1.1.0", join(dataDir, "pkg-1.1.0.tgz"))));
    await pass(); await pass();
    const heldWhileBusy = running();
    fakePower.busy = [];
    for (let n = 0; n < 5 && running() !== "1.1.0"; n++) await pass();
    fakeRuns.push({ id: "run-1", ok: true, at: Date.now() + 1 }, { id: "run-2", ok: true, at: Date.now() + 2 });
    for (let n = 0; n < 5 && cloud().managed!.update?.guard.trial; n++) await pass();
    const updated = { running: running(), last: cloud().managed!.update?.guard.last ?? null };
    note(`update: held at ${heldWhileBusy} while a turn ran, then ${JSON.stringify(updated)}`);
    mark("updated to 1.1.0");
    failingSelfTest.add("1.2.0"); fakeRuns.length = 0;
    writeFileSync(releaseFile, JSON.stringify(signedPackage("1.2.0", join(dataDir, "pkg-1.2.0.tgz"))));
    for (let n = 0; n < 8 && !actions().some(e => e.action === "update_rolled_back"); n++) await pass();
    for (let n = 0; n < 3; n++) await pass();
    const rolled = { running: running(), installed: cloud().managed!.installed, last: cloud().managed!.update?.guard.last ?? null, status: cloud().status };
    note(`update to 1.2.0: ${JSON.stringify(rolled)}`);
    results.updates = { heldWhileBusy, updated, rolled, audit: actions().map(e => `${e.action}:${e.reason}`) };
    if (heldWhileBusy !== "1.0.0" || updated.running !== "1.1.0" || updated.last?.kind !== "updated" || rolled.running !== "1.1.0" || rolled.last?.kind !== "rolled_back"
      || rolled.last?.reason !== "self_test" || rolled.status !== "running" || !actions().some(e => e.action === "update_refused" && e.reason === "failed_here"))
      throw new Error(`the update path did not hold: ${JSON.stringify(results.updates)}`);
    Object.assign(fakePower, { idle: false, busy: ["turn"], nextDueAt: null });
    mark("update rolled back after a failed self-test");
  }
  if (session) {
    const bots = await session.call("GET", "/api/bots?messages=0");
    note(`after wake the session still works: ${bots.status}, bots ${JSON.stringify((bots.body?.bots ?? bots.body ?? []).map((b: { name?: string }) => b.name))}`);
  }

  // 8. the machine is deleted out from under it: rebuilt from the backup into a fresh one
  const lost = cloud().serverId!;
  if (api) api.lose(lost); else await ops.requestDelete(lost);
  note(`deleted machine ${lost} (as if it were lost)`);
  for (let n = 0; n < 40 && (await ops.machine(lost)) !== null; n++) await sleep(fake ? 0 : 3000);
  await reconcileUntil(cloudId, () => cloud().status === "running" && cloud().serverId !== lost, 30 * 60_000, "recovery");
  note(`recovered into ${cloud().serverId} at ${cloud().origin}`);
  results.recoveryMs = Date.now() - last; mark("recovered from backup");
  if (!fake) {
    const again = await openOwnerSession({ origin: cloud().origin!, grant: () => billing.clouds.pair(account.id, cloudId) }, fetch, { label: "Cloud e2e after recovery", background: true });
    const bots = await again.call("GET", "/api/bots?messages=0");
    const names = (bots.body?.bots ?? bots.body ?? []).map((b: { name?: string }) => b.name);
    note(`after recovery: bots ${JSON.stringify(names)}`);
    results.recoveredBots = names;
  }
} catch (error) {
  console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  results.failed = error instanceof Error ? error.message : String(error);
} finally {
  // teardown: every machine under this run's scope, deleted and proven gone with a direct read
  await track().catch(() => {});
  for (const id of created) {
    const answer = await ops.requestDelete(id).catch(error => ({ error: String(error) }));
    note(`teardown delete ${id}: ${JSON.stringify(answer)}`);
  }
  for (let n = 0; n < 40; n++) {
    const left = (await Promise.all([...created].map(async id => (await ops.machine(id).catch(() => ({ id }))) ? id : null))).filter(Boolean);
    if (!left.length) break;
    await sleep(fake ? 0 : 3000);
  }
  const remaining = (await Promise.all([...created].map(async id => (await ops.machine(id).catch(() => ({ id }))) ? id : null))).filter(Boolean);
  const listed = await ops.inventory().catch(() => [{ id: "unknown" }]);
  note(`after teardown: direct reads find ${remaining.length}, scope list finds ${listed.length}`);
  results.leftOnProvider = remaining.length + listed.length;
  results.machines = [...created];
  results.marks = marks;
  billing.close(); store.close?.(); webhooks.close(); await api?.close(); await local?.close().catch(() => {});
  rmSync(dataDir, { recursive: true, force: true });
  console.log(JSON.stringify(results, null, 2));
  process.exit(results.failed ? 1 : 0);
}
