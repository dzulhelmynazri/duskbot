// Phone sync end to end against an isolated fixture (docs/verification/README.md): a fake phone pairs from the QR payload,
// lists bots, sends and hears the reply on the event stream, uploads and downloads a file, opens a websocket, and is
// refused once revoked, over the VPS relay path (link service + link agent) and the Mac companion path.
//   node --experimental-strip-types scripts/mobile-sync-e2e.ts
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMobileSessions } from "../apps/companion/src/mobile.ts";
import { createProxyHandler } from "../apps/companion/src/proxy.ts";
import { createTunnelProxy, sealKeyOf, sha256hex, x25519Pair } from "../electron/vps-link-protocol.mjs";
import { createPhoneHub, harnessSync } from "../apps/link-service/agent.mjs";
import { createLinkService } from "../apps/link-service/src/app.mjs";
import { parseMobileLink, type MobilePairingResponse, type MobileRedeemResponse } from "../shared/mobile-link.ts";
import { lookupKeys, openLookup } from "../server/mobile/lookup.ts";

const results: Array<{ path: string; step: string; ok: boolean; detail?: string }> = [];
function check(path: string, step: string, ok: boolean, detail?: string) {
  results.push({ path, step, ok, ...(detail ? { detail } : {}) });
  console.log(`${ok ? "ok  " : "FAIL"} [${path}] ${step}${detail ? `: ${detail}` : ""}`);
}
const listen = (server: Server) => new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function launchFixture(): Promise<{ url: string; stop: () => void }> {
  const child = spawn(process.execPath, ["--experimental-strip-types", "scripts/control-madani.ts", "launch"], { stdio: ["ignore", "pipe", "inherit"] });
  let text = "";
  const url = await new Promise<string>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      const match = /"url":\s*"(http:\/\/127\.0\.0\.1:\d+)"/.exec(text);
      if (match) resolve(match[1]);
    });
    child.once("exit", (code) => reject(new Error(`fixture exited ${code}`)));
  });
  return { url, stop: () => child.kill("SIGINT") };
}

async function owner(harness: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`${harness}${path}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

/** what a phone needs from any route: json calls, the event stream, uploads and a websocket handshake */
function phoneClient(origin: string, hostHeader: string | null, token: () => string | null) {
  const headers = (extra: Record<string, string> = {}) => ({ ...(token() ? { authorization: `Bearer ${token()}` } : {}), ...(hostHeader ? { host: hostHeader } : {}), ...extra });
  const raw = (method: string, path: string, body?: Buffer | string, extra: Record<string, string> = {}) => new Promise<{ status: number; body: Buffer; headers: Record<string, unknown> }>((resolve, reject) => {
    const req = httpRequest(`${origin}${path}`, { method, headers: headers({ ...(body !== undefined ? { "content-length": String(Buffer.byteLength(body)) } : {}), ...extra }) }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: res.headers }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
  return {
    raw,
    async json(method: string, path: string, body?: unknown) {
      const answer = await raw(method, path, body === undefined ? undefined : JSON.stringify(body), body === undefined ? {} : { "content-type": "application/json" });
      let parsed: any = null;
      try { parsed = JSON.parse(answer.body.toString("utf8")); } catch { parsed = answer.body.toString("utf8").slice(0, 200); }
      return { status: answer.status, body: parsed };
    },
    events(onFrame: (frame: any) => void) {
      let ended = false, status = 0;
      const req = httpRequest(`${origin}/api/events?screens=off`, { headers: headers({ accept: "text/event-stream" }) }, (res) => {
        status = res.statusCode ?? 0;
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
          for (let at = text.indexOf("\n\n"); at >= 0; at = text.indexOf("\n\n")) {
            const block = text.slice(0, at);
            text = text.slice(at + 2);
            const data = block.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
            if (data) { try { onFrame(JSON.parse(data)); } catch { /* not json */ } }
          }
        });
        res.on("end", () => { ended = true; });
        res.on("close", () => { ended = true; });
      });
      req.on("error", () => { ended = true; });
      req.end();
      return { close: () => req.destroy(), ended: () => ended, status: () => status };
    },
    upgrade(path: string) {
      return new Promise<string>((resolve) => {
        const req = httpRequest(`${origin}${path}`, { headers: headers({ connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": randomBytes(16).toString("base64") }) });
        req.on("upgrade", (res, socket) => { socket.destroy(); resolve(`101 ${res.headers.upgrade ?? ""}`); });
        req.on("response", (res) => { res.resume(); resolve(`${res.statusCode}`); });
        req.on("error", (error) => resolve(`error ${error.message}`));
        req.setTimeout(15_000, () => { req.destroy(); resolve("timeout"); });
        req.end();
      });
    },
  };
}

async function waitFor<T>(what: () => T | null | undefined, ms: number): Promise<T | null> {
  const until = Date.now() + ms;
  for (;;) {
    const value = what();
    if (value) return value;
    if (Date.now() > until) return null;
    await sleep(100);
  }
}

/** the same steps on either route: list, stream, send and hear the reply, upload and fetch, websocket, revoke */
async function exercise(label: string, harness: string, phone: ReturnType<typeof phoneClient>, botId: string, deviceId: string, afterRevoke: () => Promise<void> = async () => {}) {
  const bots = await phone.json("GET", "/api/bots?messages=0");
  check(label, "list bots", bots.status === 200 && Array.isArray(bots.body?.bots) && bots.body.bots.some((bot: { id: string }) => bot.id === botId), `${bots.status}, ${bots.body?.bots?.length ?? 0} bots`);

  const frames: any[] = [];
  const stream = phone.events((frame) => frames.push(frame));
  const hello = await waitFor(() => frames.find((frame) => frame.kind === "hello"), 10_000);
  check(label, "event stream opens with a cursor", Boolean(hello?.cursor), hello?.cursor);

  const sendId = randomUUID();
  const sent = await phone.json("POST", `/api/bots/${botId}/messages`, { text: `hello from the ${label} phone`, sendId });
  check(label, "send a message", sent.status === 200 || sent.status === 201 || sent.status === 202, `${sent.status}`);
  const mine = await waitFor(() => frames.find((frame) => frame.kind === "message" && frame.message?.role === "user" && String(frame.message?.text ?? "").includes(`${label} phone`)), 15_000);
  check(label, "own message arrives on the stream", Boolean(mine));
  const reply = await waitFor(() => frames.find((frame) => frame.kind === "message" && frame.message?.role === "bot" && frame.threadId === mine?.threadId && String(frame.message?.text ?? "").length > 0), 45_000);
  check(label, "bot reply arrives in real time", Boolean(reply), reply ? String(reply.message.text).slice(0, 60) : `frames: ${[...new Set(frames.map((frame) => frame.kind))].join(",")}`);

  const bytes = Buffer.from(`${randomBytes(150_000).toString("hex")}\n`);
  const uploaded = await phone.raw("POST", `/api/files?name=${encodeURIComponent("phone-note.txt")}&uploadId=${randomUUID()}`, bytes, { "content-type": "text/plain" });
  const file = JSON.parse(uploaded.body.toString("utf8") || "{}");
  check(label, "upload a file", uploaded.status === 201 && typeof file.path === "string", `${uploaded.status} ${file.path ?? uploaded.body.toString("utf8").slice(0, 120)}`);
  if (typeof file.path === "string") {
    const attach = await phone.json("POST", `/api/bots/${botId}/messages`, { text: `this file\n\n<attached-file path="${file.path}" name="phone-note.txt" />`, sendId: randomUUID() });
    const withFile = await waitFor(() => frames.find((frame) => frame.kind === "message" && frame.message?.role === "user" && String(frame.message?.text ?? "").includes(file.path)), 15_000);
    if (attach.status < 300 && withFile) {
      const got = await phone.raw("POST", `/api/threads/${withFile.threadId}/messages/${withFile.message.id}/file`, JSON.stringify({ path: file.path }), { "content-type": "application/json" });
      check(label, "download it back from the chat", got.status === 200 && createHash("sha256").update(got.body).digest("hex") === createHash("sha256").update(bytes).digest("hex"), `${got.status}, ${got.body.length} bytes`);
    } else check(label, "download it back from the chat", false, `attach ${attach.status}, message ${Boolean(withFile)}`);
  }

  const ws = await phone.upgrade("/api/desktop-viewer/local/shared/websockify");
  // the fixture has no desktop, so the harness's own viewer gate answers: proof the upgrade reached it with the phone's session
  check(label, "websocket upgrade reaches the harness viewer gate", /^(101|4\d\d)/.test(ws) && ws !== "401", ws);

  const removed = await owner(harness, "DELETE", `/api/mobile/devices/${deviceId}`);
  check(label, "owner revokes the phone", removed.status === 200, `${removed.status}`);
  await afterRevoke();
  const ended = await waitFor(() => stream.ended(), 5000);
  check(label, "its open event stream ends", Boolean(ended));
  const refused = await phone.json("GET", "/api/bots?messages=0").catch((error: Error) => ({ status: 0, body: error.message }));
  check(label, "revoked phone is refused", refused.status === 401 || refused.status === 502 || refused.status === 404, `${refused.status} ${JSON.stringify(refused.body).slice(0, 100)}`);
  const again = await phone.json("GET", "/api/bots?messages=0").catch((error: Error) => ({ status: 0, body: error.message }));
  check(label, "and stays refused", again.status === 401 || again.status === 502 || again.status === 404, `${again.status}`);
  stream.close();
}

async function relayPath(harness: string, botId: string, cleanups: Array<() => unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "madani-mobile-relay-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const service = createLinkService({ base: "http://link.test", dataDir: join(dir, "data"), scriptPath: "apps/link-service/install.sh", agentPath: "apps/link-service/agent.mjs", trustProxy: false });
  const relayServer = createServer((req, res) => void service.handler(req, res));
  const base = `http://127.0.0.1:${await listen(relayServer)}`;
  cleanups.push(() => { relayServer.closeAllConnections(); relayServer.close(); service.close(); });
  // the vps's tunnel as `agent.mjs link` would have left it
  const tunnel = "mobiletest", vpsToken = randomBytes(32).toString("base64url");
  service.store.tunnels.set(tunnel, { id: tunnel, createdAt: Date.now(), vpsVerifier: sha256hex(vpsToken), appVerifier: sha256hex(randomBytes(32).toString("base64url")), seenAt: null });
  const port = Number(new URL(harness).port);
  const hub = createPhoneHub({ base, id: tunnel, token: vpsToken, keys: x25519Pair(), server: { host: "127.0.0.1", port }, sync: harnessSync({ host: "127.0.0.1", port }), log: () => {} });
  void hub.run();
  cleanups.push(() => hub.stop());

  let pairing: { status: number; body: MobilePairingResponse } | null = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    pairing = await owner(harness, "POST", "/api/mobile/pairing", {});
    if (pairing.status === 200 && pairing.body.payload.via.some((one) => one.kind === "relay")) break;
    await sleep(300);
  }
  const payload = pairing?.status === 200 ? parseMobileLink(pairing.body.link) : null;
  const via = payload?.via.find((one) => one.kind === "relay");
  check("vps", "QR payload carries the phone's relay channel", Boolean(via && payload?.workspace.kind === "vps"), payload ? payload.via.map((one) => one.kind).join(",") : `${pairing?.status} ${JSON.stringify(pairing?.body).slice(0, 120)}`);
  if (!payload || via?.kind !== "relay") return;
  if (pairing!.body.code) {
    const found = await fetch(`${base}/v1/lookups/${lookupKeys(pairing!.body.code).id}`).then((response) => response.json()) as { sealed?: string };
    check("vps", "typed code finds the same payload on the relay", JSON.stringify(found.sealed ? openLookup(pairing!.body.code, found.sealed) : null) === JSON.stringify(payload));
  } else check("vps", "typed code finds the same payload on the relay", false, "no code");

  const grantProxy = createTunnelProxy({ base: via.base, id: via.channel, route: `${via.base}/v1/channels/${via.channel}`, key: via.key, token: via.token });
  const grantOrigin = await grantProxy.start();
  cleanups.push(() => grantProxy.close());
  const grantPhone = phoneClient(grantOrigin, new URL(grantOrigin).host, () => null);
  const sneak = await grantPhone.json("GET", "/api/bots?messages=0");
  check("vps", "the grant's channel reaches nothing but redeem", sneak.status === 502 && /pairing channel/.test(JSON.stringify(sneak.body)), `${sneak.status}`);

  const keys = x25519Pair(), relayToken = randomBytes(32).toString("base64url");
  const redeemed = await grantPhone.json("POST", "/api/mobile/redeem", { secret: payload.grant.secret, attemptId: randomUUID(), device: { name: "Relay phone", platform: "ios" }, relay: { pub: keys.pub, verifier: sha256hex(relayToken) } });
  const phoneAnswer = redeemed.body as MobileRedeemResponse;
  check("vps", "redeem over the relay gives a session and the phone's own channel", redeemed.status === 200 && Boolean(phoneAnswer.relay), `${redeemed.status}`);
  await grantProxy.close();
  if (!phoneAnswer.relay) return;

  const key = sealKeyOf(keys.priv, keys.pub, phoneAnswer.relay.agentPub, phoneAnswer.relay.channel).toString("base64url");
  const deviceProxy = createTunnelProxy({ base, id: phoneAnswer.relay.channel, route: `${base}/v1/channels/${phoneAnswer.relay.channel}`, key, token: relayToken });
  const origin = await deviceProxy.start();
  cleanups.push(() => deviceProxy.close());
  const phone = phoneClient(origin, new URL(origin).host, () => phoneAnswer.token);
  await exercise("vps", harness, phone, botId, phoneAnswer.device.id, async () => {
    const gone = await waitFor(() => (service.store.channels.has(phoneAnswer.relay!.channel) ? null : true), 5000);
    check("vps", "the relay forgets the phone's channel", Boolean(gone));
  });
}

async function companionPath(harness: string, botId: string, cleanups: Array<() => unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "madani-mobile-companion-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const mobile = createMobileSessions({ file: join(dir, "mobile-sessions.json") });
  const proxy = createProxyHandler({ harnessPort: Number(new URL(harness).port), mobile, authenticate: () => null, redeem: () => ({ error: "no companion pairing here" }), serverName: () => "Test Mac" });
  const server = createServer(proxy);
  server.on("upgrade", proxy.upgrade);
  const companion = `http://127.0.0.1:${await listen(server)}`;
  cleanups.push(() => { server.closeAllConnections(); server.close(); });

  const pairing = await owner(harness, "POST", "/api/mobile/pairing", { companion: [{ url: companion, kind: "lan", priority: 30 }] });
  const payload = pairing.status === 200 ? parseMobileLink((pairing.body as MobilePairingResponse).link) : null;
  const via = payload?.via.find((one) => one.kind === "companion");
  check("mac", "QR payload carries the companion address", Boolean(via), payload ? payload.via.map((one) => one.kind).join(",") : `${pairing.status}`);
  if (!payload || !via) return;
  let token: string | null = null;
  const phone = phoneClient(via.url, null, () => token);
  const redeemed = await phone.json("POST", "/api/mobile/redeem", { secret: payload.grant.secret, attemptId: randomUUID(), device: { name: "Mac phone", platform: "android" } });
  const answer = redeemed.body as MobileRedeemResponse;
  check("mac", "redeem through the companion gives a session", redeemed.status === 200 && (answer.token ?? "").startsWith("madani_sess_"), `${redeemed.status}`);
  token = answer.token;
  const browser = await fetch(`${companion}/api/bots?messages=0`, { headers: { authorization: `Bearer ${token}`, origin: "https://evil.example" } });
  check("mac", "a browser origin is still refused at the companion", browser.status === 403, `${browser.status}`);
  await exercise("mac", harness, phone, botId, answer.device.id);
  check("mac", "the companion dropped the revoked session", !mobile.has(token!));
}

async function main() {
  const fixture = await launchFixture();
  const cleanups: Array<() => unknown> = [() => fixture.stop()];
  try {
    const harness = fixture.url;
    console.log(`fixture ${harness}`);
    const bot = await owner(harness, "POST", "/api/bots", { name: "Probe" });
    const botId = bot.body?.bot?.id;
    check("setup", "create a test bot in the fixture", bot.status < 300 && typeof botId === "string", `${bot.status}`);
    await relayPath(harness, botId, cleanups);
    await companionPath(harness, botId, cleanups);
  } finally {
    for (const cleanup of cleanups.reverse()) { try { await cleanup(); } catch { /* best effort */ } }
  }
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

await main();
