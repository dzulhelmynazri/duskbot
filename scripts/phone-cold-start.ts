// How long a phone app takes from launch to its chat list, and whether a bot's reply reaches it live, on an isolated
// fixture: iPhone 1.2's own connection code (scripts/testing/shipped-phone.ts) and this tree's, against a computer whose
// saved routes put ones that never answer (a secure access address, a tailnet name) ahead of its Wi-Fi address, and a
// relay whose computer is not reading it. The live stream is asked the way the iPhone's web view asks it (a preflight,
// then a read with Origin capacitor://localhost) of this tree's companion and of desktop 0.2.20's.
//   node --experimental-strip-types scripts/phone-cold-start.ts
// Everything listens on 127.0.0.1 and lives in temp folders; the person's app and data are never touched.
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { createServer as createTcpServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

import { createMobileSessions } from "../apps/companion/src/mobile.ts";
import { createProxyHandler } from "../apps/companion/src/proxy.ts";
import { universalPairLink, type MobilePairingResponse } from "../shared/mobile-link.ts";
import { launchVerificationServer } from "./control-madani.ts";
import { fakePlatform, loadShippedPhone, SHIPPED_PHONES, type PhoneRecord, type ShippedPhone } from "./testing/shipped-phone.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OWNER = randomBytes(32).toString("base64url");
const APP_ORIGIN = "capacitor://localhost";
const RELEASED_DESKTOP = "v0.2.20";

const rows: string[] = [];
let failed = 0;
const report = (line: string, ok = true) => { if (!ok) failed += 1; rows.push(`${ok ? "ok  " : "FAIL"} ${line}`); console.log(rows.at(-1)); };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = (server: Server | ReturnType<typeof createTcpServer>) => new Promise<number>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
});

/** this tree's phone connection code, bundled the way shipped-phone.ts bundles a shipped build */
async function loadThisTree(scratch: string): Promise<ShippedPhone> {
  const at = join(scratch, "this-tree");
  mkdirSync(at, { recursive: true });
  const entry = join(at, "entry.ts");
  writeFileSync(entry, [
    `export { readScanned, redeemPairing, resolveTypedCode, PairError } from ${JSON.stringify(join(ROOT, "src/mobile/connection/pair"))};`,
    `export { connectToWorkspace, createConnectionStore } from ${JSON.stringify(join(ROOT, "src/mobile/connection/connections"))};`,
  ].join("\n"));
  const out = join(at, "phone.mjs");
  await build({
    entryPoints: [entry], outfile: out, bundle: true, format: "esm", platform: "node", target: "node22", logLevel: "error",
    alias: { "@": join(ROOT, "src") }, nodePaths: [join(ROOT, "node_modules")], loader: { ".css": "empty", ".svg": "empty", ".png": "empty", ".json": "json" },
    define: { "import.meta.env": "{}" },
  });
  return await import(pathToFileURL(out).href) as ShippedPhone;
}

/** the companion's request handler as a released desktop shipped it */
async function releasedCompanion(scratch: string): Promise<typeof createProxyHandler> {
  const at = join(scratch, RELEASED_DESKTOP);
  mkdirSync(at, { recursive: true });
  const archive = execFileSync("git", ["archive", RELEASED_DESKTOP, "apps/companion/src", "shared", "electron/legacy-names.mjs"], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", at], { input: archive });
  return (await import(pathToFileURL(join(at, "apps/companion/src/proxy.ts")).href) as { createProxyHandler: typeof createProxyHandler }).createProxyHandler;
}

/** accepts connections and never says a word, as a route to an address nobody answers on does */
async function silentRoute(): Promise<{ port: number; close(): void }> {
  const sockets = new Set<Socket>();
  const server = createTcpServer((socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {}); });
  const port = await listen(server);
  return { port, close: () => { for (const socket of sockets) socket.destroy(); server.close(); } };
}

async function owner(base: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { "x-madani-desktop-owner": OWNER, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

/** launch to first content: the route walk, then the chat list over the route it found */
async function coldStart(phone: ShippedPhone, record: PhoneRecord, token: string, kind: "ios" | "android") {
  const platform = fakePlatform(kind, "cold start");
  await platform.secrets.set(`token.${record.id}`, token);
  const started = performance.now();
  try {
    const transport = await phone.connectToWorkspace(record, token, platform, AbortSignal.timeout(90_000));
    if (transport.kind !== "bearer") return { ms: performance.now() - started, route: transport.kind };
    const list = await fetch(`${transport.origin}/api/bots?messages=0`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    const body = await list.json().catch(() => null) as { bots?: unknown[] } | null;
    return { ms: performance.now() - started, route: transport.origin, bots: list.status === 200 ? body?.bots?.length ?? 0 : -list.status };
  } catch (error) {
    return { ms: performance.now() - started, route: `error ${(error as { code?: string }).code ?? (error as Error).message}` };
  }
}

/** the live stream as the iPhone's web view opens it, a message sent over native http, and its reply heard live */
async function liveReply(origin: string, token: string, botId: string): Promise<string> {
  const preflight = await fetch(`${origin}/api/events?screens=off`, {
    method: "OPTIONS", headers: { origin: APP_ORIGIN, "access-control-request-method": "GET", "access-control-request-headers": "authorization" },
  });
  await preflight.body?.cancel();
  if (preflight.status >= 300 || preflight.headers.get("access-control-allow-origin") !== APP_ORIGIN) return `preflight refused (${preflight.status})`;
  const stop = new AbortController();
  const stream = await fetch(`${origin}/api/events?screens=off`, {
    headers: { origin: APP_ORIGIN, authorization: `Bearer ${token}`, accept: "text/event-stream" }, signal: stop.signal,
  });
  if (stream.status !== 200 || stream.headers.get("access-control-allow-origin") !== APP_ORIGIN) { stop.abort(); return `stream refused (${stream.status})`; }
  const frames: any[] = [];
  void (async () => {
    const reader = stream.body!.getReader(), decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      for (let at = text.indexOf("\n\n"); at >= 0; at = text.indexOf("\n\n")) {
        const data = text.slice(0, at).split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
        text = text.slice(at + 2);
        if (data) { try { frames.push(JSON.parse(data)); } catch { /* a comment */ } }
      }
    }
  })().catch(() => {});
  try {
    const words = `cold start ${randomUUID().slice(0, 6)}`;
    const sent = await fetch(`${origin}/api/bots/${botId}/messages`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ text: words, sendId: randomUUID() }),
    });
    await sent.body?.cancel();
    if (sent.status >= 300) return `send refused (${sent.status})`;
    const sentAt = performance.now();
    for (;;) {
      const mine = frames.find((frame) => frame.kind === "message" && frame.message?.role === "user" && String(frame.message?.text ?? "").includes(words));
      const reply = mine && frames.find((frame) => frame.kind === "message" && frame.message?.role === "bot" && frame.threadId === mine.threadId && String(frame.message?.text ?? "").length > 0);
      if (reply) return `reply arrived live ${Math.round(performance.now() - sentAt)} ms after the send`;
      if (performance.now() - sentAt > 60_000) return "no reply on the stream within 60 s";
      await sleep(100);
    }
  } finally { stop.abort(); }
}

async function main() {
  const scratch = mkdtempSync(join(tmpdir(), "phone-cold-start-"));
  const cleanups: Array<() => unknown> = [() => rmSync(scratch, { recursive: true, force: true })];
  try {
    const phones = { "iPhone 1.2": await loadShippedPhone(ROOT, SHIPPED_PHONES.ios, join(scratch, "phones")), "this tree": await loadThisTree(scratch) };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (input, init = {}) => realFetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), "x-madani-desktop-owner": OWNER } });
    let fixture: Awaited<ReturnType<typeof launchVerificationServer>>;
    try { fixture = await launchVerificationServer({ ...process.env, MADANI_TEST_DESKTOP_OWNER_TOKEN: OWNER }); } finally { globalThis.fetch = realFetch; }
    cleanups.push(() => fixture.close());
    const desk = fixture.info.url, harnessPort = Number(new URL(desk).port);
    const bot = await owner(desk, "POST", "/api/bots", { name: "Probe" });
    const botId: string = bot.body?.bot?.id;

    const mobile = createMobileSessions({ file: join(scratch, "companion", "mobile-sessions.json") });
    const options = { harnessPort, mobile, authenticate: () => null, redeem: () => ({ error: "not here" }), serverName: () => "Cold start Mac" };
    const serve = async (handler: RequestListener) => {
      const server = createServer(handler);
      cleanups.push(() => { server.closeAllConnections(); server.close(); });
      return `http://127.0.0.1:${await listen(server)}`;
    };
    const companion = await serve(createProxyHandler(options) as unknown as RequestListener);
    const released = await serve((await releasedCompanion(scratch))(options as never) as unknown as RequestListener);
    const secureAccess = await silentRoute(), tailnet = await silentRoute();
    cleanups.push(() => secureAccess.close(), () => tailnet.close());

    // paired on Wi-Fi alone, the way a released desktop pairs a phone that has no relay
    const offer = await owner(desk, "POST", "/api/mobile/pairing", { companion: [{ url: companion, kind: "lan", priority: 200 }] });
    const body = offer.body as MobilePairingResponse;
    const shipped = phones["iPhone 1.2"];
    const payload = shipped.readScanned(universalPairLink(body.link, body.code))?.payload;
    const paired = await shipped.redeemPairing(payload, fakePlatform("ios", "pairing"));
    report(`iPhone 1.2 pairs over Wi-Fi with the fixture`, paired.record.transport === "companion");
    const lan = { kind: "companion", url: companion, net: "lan", priority: 200 };
    const dead = {
      secureAccess: { kind: "companion", url: `https://127.0.0.1:${secureAccess.port}`, net: "hosted", priority: 0 },
      tailnet: { kind: "companion", url: `http://127.0.0.1:${tailnet.port}`, net: "tailnet", priority: 100 },
    };
    const layouts: Array<[string, unknown[]]> = [
      ["Wi-Fi only", [lan]],
      ["secure access that never answers, then Wi-Fi", [dead.secureAccess, lan]],
      ["secure access and tailnet that never answer, then Wi-Fi", [dead.secureAccess, dead.tailnet, lan]],
    ];
    for (const [label, via] of layouts) {
      for (const [name, phone] of Object.entries(phones)) {
        const record = { ...paired.record, via } as PhoneRecord;
        const result = await coldStart(phone, record, paired.token, "ios");
        report(`${name}, ${label}: first content in ${Math.round(result.ms)} ms over ${result.route === companion ? "Wi-Fi" : result.route} (${result.bots ?? "?"} bots)`, result.route === companion && (result.bots ?? 0) > 0);
      }
    }

    const before = await liveReply(released, paired.token, botId);
    report(`desktop ${RELEASED_DESKTOP} companion, iPhone web view stream: ${before}`, true);
    const after = await liveReply(companion, paired.token, botId);
    report(`this tree's companion, iPhone web view stream: ${after}`, after.startsWith("reply arrived live"));
  } finally {
    for (const cleanup of cleanups.reverse()) { try { await cleanup(); } catch { /* best effort */ } }
  }
}

await main().catch((error: Error) => report(`the run finished: ${error.stack ?? error}`, false));
console.log(`\n${rows.length - failed}/${rows.length} ok`);
process.exit(failed ? 1 : 0);
