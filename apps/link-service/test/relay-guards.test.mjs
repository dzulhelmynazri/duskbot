// what keeps the relay from being a free pipe or a memory sink: a tunnel's byte budget, unread frames expiring, one cap
// on every queue together, setup sessions only for a signed madani account (and a few tunnels each), and per-address limits
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { FAIR_USE_DEFAULTS, fairRate } from "../src/fair-use.mjs";
import { FRAME_TTL_MS, LANE_BURST_BYTES, LANE_BYTES_PER_SECOND, MAX_HOLD_MS, TUNNELS_PER_ACCOUNT, TUNNEL_BURST_BYTES, TUNNEL_BYTES_PER_SECOND, createLinkService, sha256hex } from "../src/app.mjs";
import { ACTIVE_MS, DEFAULT_LIMITS, LIMIT_RANGES, MONTH_ALLOWANCE_BYTES, loadLimits, saveLimits, validateLimits } from "../src/relay-limits.mjs";
import { TUNNEL_IDLE_MS } from "../src/store.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const id = "abcdefghij", vps = "v".repeat(43), app = "a".repeat(43), epoch = "e".repeat(12);
const MB = 1024 * 1024;
let service, server, base, dir, time, waits;

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const keys = [{ kid: "test-1", x: publicKey.export({ format: "jwk" }).x }];
const acct = "0123456789abcdef0123456789abcdef";
function grant({ who = acct, iat = time, exp = time + 5 * 60_000, kid = "test-1", key = privateKey } = {}) {
  const head = `l1.${kid}.${Buffer.from(JSON.stringify({ v: 1, aud: "link", acct: who, iat, exp })).toString("base64url")}`;
  return `${head}.${sign(null, Buffer.from(head), key).toString("base64url")}`;
}

async function start(options = {}, keep = false) {
  if (!keep) { time = Date.now(); dir = mkdtempSync(join(tmpdir(), "madani-relay-guards-")); }
  waits = [];
  // a held post's wait passes on the test clock at once
  service = createLinkService({ base: "http://link.test", dataDir: dir, scriptPath: join(root, "install.sh"), agentPath: join(root, "agent.mjs"), trustProxy: true, now: () => time,
    sleep: async (ms) => { waits.push(ms); time += ms; }, ...options });
  service.store.tunnels.set(id, { id, createdAt: time, vpsVerifier: sha256hex(vps), appVerifier: sha256hex(app), seenAt: null });
  server = createServer((req, res) => void service.handler(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
}
async function stop() {
  service?.close();
  server?.closeAllConnections();
  await new Promise((resolve) => server ? server.close(resolve) : resolve());
  service = server = null;
}
afterEach(async () => {
  await stop();
  rmSync(dir, { recursive: true, force: true });
});

const request = (path, { token, method = "GET", body, ip = "198.51.100.1" } = {}) => fetch(`${base}${path}`, {
  method, headers: { "x-real-ip": ip, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});
/** `count` frames of 1 MiB of base64url text each, 0.75 MiB decoded: the relay charges decoded bytes */
const frames = (count) => Array.from({ length: count }, () => "a".repeat(MB));
const toVps = (list, extra = {}) => request(`/v1/tunnels/${id}/to-vps`, { token: app, method: "POST", body: { frames: list, ...extra } });
const read = () => request(`/v1/tunnels/${id}/to-vps`, { token: vps }).then((res) => res.json());
const newSession = (body = {}, ip) => request("/v1/sessions", { method: "POST", ip, body: { verifier: "f".repeat(64), appPub: "k".repeat(43), ...body } });

const other = "klmnopqrst", otherApp = "b".repeat(43), otherVps = "w".repeat(43);
const addOther = () => service.store.tunnels.set(other, { id: other, createdAt: time, vpsVerifier: sha256hex(otherVps), appVerifier: sha256hex(otherApp), seenAt: null });
const otherToVps = (list, extra = {}) => request(`/v1/tunnels/${other}/to-vps`, { token: otherApp, method: "POST", body: { frames: list, ...extra } });
const otherRead = () => request(`/v1/tunnels/${other}/to-vps`, { token: otherVps }).then((res) => res.json());

describe("a tunnel's byte budget", () => {
  it("takes a 24 MiB burst, then slows posts to 3 MiB a second instead of refusing them", async () => {
    expect([TUNNEL_BYTES_PER_SECOND, TUNNEL_BURST_BYTES]).toEqual([3 * MB, 24 * MB]);
    await start();
    // 3 MiB of frame text a post: eight fit the burst without waiting
    for (let i = 0; i < 8; i += 1) { expect((await toVps(frames(3), { epoch, seq: i })).status).toBe(200); await read(); }
    expect(waits).toEqual([]);
    for (let i = 8; i < 11; i += 1) { expect((await toVps(frames(3), { epoch, seq: i })).status).toBe(200); await read(); }
    expect(waits).toEqual([1000, 1000, 1000]);
  });

  it(`refuses with a retry-after only when the wait would pass ${MAX_HOLD_MS / 1000} s`, async () => {
    await start({ limits: { perTunnelBytesPerSec: 64 * 1024, burstBytes: MB } });
    const refused = await toVps(frames(3), { epoch, seq: 0 });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ code: "rate_limited" });
    expect(Number(refused.headers.get("retry-after"))).toBe(32);
    expect((await toVps(["a".repeat(4000)], { epoch, seq: 0 })).status).toBe(200);
    expect(waits).toEqual([]);
  });

  it("holds the egress lane to 6 MiB a second", async () => {
    expect([LANE_BYTES_PER_SECOND, LANE_BURST_BYTES]).toEqual([6 * MB, 8 * MB]);
    await start();
    for (let i = 0; i < 2; i += 1) { expect((await toVps(frames(3), { lane: true })).status).toBe(200); await read(); }
    expect(waits).toEqual([]);
    expect((await toVps(frames(3), { lane: true })).status).toBe(200);
    expect(waits).toEqual([Math.ceil(1000 / 6)]);
  });

  it("keeps busy tunnels together under the global ceiling, slowing them rather than refusing", async () => {
    const ceiling = 4 * MB;
    await start({ limits: { globalCeilingBytesPerSec: ceiling, burstBytes: 4 * MB } });
    addOther();
    const t0 = time;
    let sent = 0;
    for (let i = 0; i < 20; i += 1) {
      expect((await toVps(frames(3), { epoch, seq: i })).status).toBe(200); await read();
      expect((await otherToVps(frames(3), { epoch, seq: i })).status).toBe(200); await otherRead();
      sent += 6 * MB;
    }
    // never more than the global burst plus the ceiling's rate, and not much less either
    expect(sent).toBeLessThanOrEqual(2 * ceiling + ceiling * (time - t0) / 1000);
    expect((time - t0) / 1000).toBeLessThan(sent / ceiling + 2);
  });

  it("gives a busy tunnel its full rate alone and an even share of the ceiling while another is busy", async () => {
    const limits = { globalCeilingBytesPerSec: 4 * MB, burstBytes: MB };
    await start({ limits });
    expect((await toVps(frames(3), { epoch, seq: 0 })).status).toBe(200);
    // 2 MiB past its burst at 3 MiB a second
    expect(waits).toEqual([Math.ceil(2000 / 3)]);
    await stop();
    await start({ limits });
    addOther();
    expect((await otherToVps(frames(3), { epoch, seq: 0 })).status).toBe(200);
    waits = [];
    expect((await toVps(frames(3), { epoch, seq: 0 })).status).toBe(200);
    // the same 2 MiB at half the 4 MiB ceiling
    expect(waits).toEqual([1000]);
  });

  it("shares the ceiling between accounts first: two busy servers of one account get together what one of another gets", async () => {
    await start({ limits: { globalCeilingBytesPerSec: 4 * MB, burstBytes: MB } });
    addOther();
    service.store.tunnels.get(id).acct = acct;
    service.store.tunnels.get(other).acct = acct;
    const third = "thirdtunnl", thirdApp = "c".repeat(43);
    service.store.tunnels.set(third, { id: third, createdAt: time, vpsVerifier: sha256hex("x".repeat(43)), appVerifier: sha256hex(thirdApp), seenAt: null, acct: "f".repeat(32) });
    expect((await toVps(frames(3), { epoch, seq: 0 })).status).toBe(200);
    expect((await otherToVps(frames(3), { epoch, seq: 0 })).status).toBe(200);
    waits = [];
    expect((await request(`/v1/tunnels/${third}/to-vps`, { token: thirdApp, method: "POST", body: { frames: frames(3), epoch, seq: 0 } })).status).toBe(200);
    // the other account alone gets half the 4 MiB ceiling (2 MiB past its burst in a second), not a third of it
    expect(waits).toEqual([1000]);
  });

  it("answers relay_busy to a new tunnel once maxTunnels are busy, never to one already relaying", async () => {
    await start({ limits: { maxTunnels: 1 }, statsToken: "s".repeat(32) });
    addOther();
    // a trickle (a desktop's hello) is in use, not busy: the other still gets on
    expect((await toVps(["a".repeat(4000)], { epoch, seq: 0 })).status).toBe(200);
    expect((await otherToVps(["a".repeat(4000)], { epoch, seq: 0 })).status).toBe(200);
    time += ACTIVE_MS + 1;
    expect((await toVps(frames(2), { epoch, seq: 1 })).status).toBe(200);
    const busy = await otherToVps(["a".repeat(4000)], { epoch: "f".repeat(12), seq: 0 });
    expect(busy.status).toBe(503);
    expect(await busy.json()).toMatchObject({ code: "relay_busy" });
    expect(busy.headers.get("retry-after")).toBe("60");
    expect((await toVps(["a".repeat(4000)], { epoch, seq: 2 })).status).toBe(200);
    expect((await (await request("/ops/relay/stats", { token: "s".repeat(32) })).json()).now).toMatchObject({ tunnels: 1, connected: 1 });
    time += ACTIVE_MS + 1;
    expect((await otherToVps(["a".repeat(4000)], { epoch: "f".repeat(12), seq: 0 })).status).toBe(200);
  });

  it("answers relay_busy to a new tunnel once maxConnected are in use; one in use may still turn busy", async () => {
    await start({ limits: { maxConnected: 1, maxTunnels: 1 }, statsToken: "s".repeat(32) });
    addOther();
    expect((await toVps(["a".repeat(4000)], { epoch, seq: 0 })).status).toBe(200);
    const full = await otherToVps(["a".repeat(4000)], { epoch, seq: 0 });
    expect(full.status).toBe(503);
    expect(await full.json()).toMatchObject({ code: "relay_busy" });
    // the one in use goes on to stream a screen past the busy cap's threshold
    expect((await toVps(frames(2), { epoch, seq: 1 })).status).toBe(200);
    const stats = await (await request("/ops/relay/stats", { token: "s".repeat(32) })).json();
    expect(stats.now).toMatchObject({ tunnels: 1, connected: 1 });
    expect(stats.limits).toMatchObject({ maxConnected: 1, maxTunnels: 1 });
    expect(stats.busy).toBe(true);
  });

  it("never cuts a tunnel off for its day: an account past its month's full speed is slowed instead", async () => {
    await start();
    const tunnel = service.store.tunnels.get(id);
    tunnel.day = Math.floor(time / 86_400_000);
    tunnel.dayBytes = 100 * 1024 ** 3;
    expect((await toVps(["a".repeat(4000)], { epoch, seq: 0 })).status).toBe(200);
  });
});

describe("fair use, per account over the month", () => {
  const GB = 1000 ** 3;
  it("is full speed to 20 GB, then slower along a smooth curve to the floor at 80 GB, then the chat rate", () => {
    const top = FAIR_USE_DEFAULTS.accountBytesPerSec;
    expect(fairRate(0)).toBe(top);
    expect(fairRate(20 * GB)).toBe(top);
    const points = [25, 35, 50, 65, 79].map((gb) => fairRate(gb * GB));
    for (let i = 1; i < points.length; i += 1) expect(points[i]).toBeLessThan(points[i - 1]);
    // halfway along the curve in bytes is halfway in the log of the rate
    expect(Math.abs(Math.log(fairRate(50 * GB)) - (Math.log(top) + Math.log(FAIR_USE_DEFAULTS.floorBytesPerSec)) / 2)).toBeLessThan(0.01);
    expect(fairRate(80 * GB)).toBe(FAIR_USE_DEFAULTS.chatBytesPerSec);
    expect(fairRate(500 * GB)).toBe(32_000);
  });

  it("slows a heavy account's bulk but lets its chat through at once, and sums its month across nodes", async () => {
    await start({ limits: { accountBurstSeconds: 0 } });
    service.store.tunnels.get(id).acct = acct;
    const monthNow = new Date(time).toISOString().slice(0, 7);
    waits = [];
    // a chat sized post goes through the small allowance at once
    expect((await toVps(["a".repeat(2000)], { epoch, seq: 0 })).status).toBe(200);
    expect(waits).toEqual([]);
    await stop();
    await start({ limits: { accountBurstSeconds: 0 } }, true);
    service.store.tunnels.get(id).acct = acct;
    service.fairUse.merge("oracle-in", { month: monthNow, accounts: { [`a:${acct}`]: 90 * GB } });
    expect(service.fairUse.total(`a:${acct}`)).toBe(90 * GB + 2000);
    waits = [];
    expect((await toVps(["a".repeat(64_000)], { epoch, seq: 0 })).status).toBe(200);
    // 64 KB at the 32 KB/s chat rate
    expect(waits.length).toBe(1);
    expect(waits[0]).toBeGreaterThanOrEqual(1900);
    waits = [];
    expect((await toVps(["a".repeat(1000)], { epoch, seq: 1 })).status).toBe(200);
    expect(waits).toEqual([]);
  });

  it("counts how apps reach their servers (a session once, again when its way changes) and who chats now", async () => {
    const statsToken = "s".repeat(32);
    await start({ statsToken });
    service.store.tunnels.get(id).acct = acct;
    const report = (body) => request(`/v1/tunnels/${id}/report`, { token: app, method: "POST", body });
    expect((await report({ path: "sideways" })).status).toBe(400);
    expect((await request(`/v1/tunnels/${id}/report`, { token: vps, method: "POST", body: { path: "direct" } })).status).toBe(404);
    expect((await report({ path: "relay" })).status).toBe(200);
    expect((await report({ path: "relay", chatAgoMs: 1000 })).status).toBe(200);
    expect((await report({ path: "direct", chatAgoMs: 2000 })).status).toBe(200);
    const stats = async () => (await request("/ops/relay/stats", { token: statsToken })).json();
    let body = await stats();
    expect(body.paths).toMatchObject({ direct: 1, cloudflare: 0, relay: 1 });
    expect(body.now.chatting).toBe(1);
    time += 15 * 60_000;
    body = await stats();
    expect(body.now.chatting).toBe(0);
    time += 20 * 60_000;
    expect((await report({ path: "direct" })).status).toBe(200);
    expect((await stats()).paths).toMatchObject({ direct: 2, relay: 1 });
  });

  it("shows each account's month and its rate on the ops stats", async () => {
    const statsToken = "s".repeat(32);
    await start({ statsToken });
    service.store.tunnels.get(id).acct = acct;
    expect((await toVps(frames(1), { epoch, seq: 0 })).status).toBe(200);
    const body = await (await request("/ops/relay/stats", { token: statsToken })).json();
    expect(body.fairUse.accounts[0]).toMatchObject({ account: acct, monthBytes: MB, bytesPerSec: FAIR_USE_DEFAULTS.accountBytesPerSec });
  });
});

describe("the owner's relay ops endpoints", () => {
  const statsToken = "s".repeat(32);
  const ops = (path, opts = {}) => request(path, { token: statsToken, ...opts });

  it("needs the stats token and hides without one", async () => {
    await start();
    expect((await request("/ops/relay/stats", { token: statsToken })).status).toBe(404);
    await stop();
    await start({ statsToken }, true);
    expect((await request("/ops/relay/stats")).status).toBe(401);
    expect((await request("/ops/relay/stats", { token: app })).status).toBe(401);
    expect((await request("/ops/relay/limits", { token: app, method: "PUT", body: { maxTunnels: 5 } })).status).toBe(401);
  });

  it("reports now, today, month, limits and the busiest accounts in the agreed shape", async () => {
    await start({ statsToken });
    service.store.tunnels.get(id).acct = acct;
    expect((await toVps(frames(3), { epoch, seq: 0 })).status).toBe(200);
    expect((await read()).frames).toHaveLength(3);
    time += 1000;
    const body = await (await ops("/ops/relay/stats")).json();
    expect(Object.keys(body).sort()).toEqual(["box", "busy", "fairUse", "limits", "month", "node", "nodes", "now", "paths", "relay", "today", "top", "turn"]);
    expect(body.node).toMatchObject({ id: "contabo", default: true, accepting: true });
    expect(body.relay).toBe("contabo");
    expect(Object.keys(body.now).sort()).toEqual(["accounts", "bytesPerSecIn", "bytesPerSecOut", "chatting", "connected", "cpu", "rssMb", "servers", "tunnels"]);
    expect(body.now).toMatchObject({ tunnels: 1, connected: 1, servers: 1, accounts: 1, bytesPerSecIn: Math.round(3 * MB / 10), bytesPerSecOut: Math.round(3 * MB / 10) });
    expect(body.today).toEqual({ bytesOut: 3 * MB, bytesIn: 3 * MB });
    expect(body.month).toMatchObject({ bytesOut: 3 * MB, bytesIn: 3 * MB, allowanceBytes: MONTH_ALLOWANCE_BYTES });
    expect(body.month.projectedBytesOut).toBeGreaterThanOrEqual(3 * MB);
    expect(body.limits).toEqual({ ...DEFAULT_LIMITS });
    expect(body.top).toEqual([{ account: acct, tunnels: 1, bytesToday: 3 * MB }]);
    expect(body.busy).toBe(false);
  });

  it("changes limits at runtime, refuses bad ones, and keeps them and the totals across a restart", async () => {
    await start({ statsToken });
    for (const bad of [{}, { maxTunnels: 0 }, { maxConnected: 0 }, { perTunnelBytesPerSec: 1.5 }, { nope: 1 }, { burstBytes: "big" }, { paused: "yes" }]) {
      const refused = await ops("/ops/relay/limits", { method: "PUT", body: bad });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ code: "invalid_limits" });
    }
    const changed = await ops("/ops/relay/limits", { method: "PUT", body: { maxConnected: 1, accountFullSpeedBytes: 200 * MB } });
    expect(changed.status).toBe(200);
    expect((await changed.json()).limits).toEqual({ ...DEFAULT_LIMITS, maxConnected: 1, accountFullSpeedBytes: 200 * MB });
    addOther();
    expect((await toVps(["a".repeat(4000)], { epoch, seq: 0 })).status).toBe(200);
    expect((await otherToVps(["a".repeat(4000)], { epoch, seq: 0 })).status).toBe(503);
    await stop();
    await start({ statsToken }, true);
    addOther();
    const body = await (await ops("/ops/relay/stats")).json();
    expect(body.limits).toMatchObject({ maxConnected: 1, accountFullSpeedBytes: 200 * MB });
    expect(body.today.bytesIn).toBe(4000);
    // paused: the tunnel already relaying keeps going, a new one gets the busy answer, until unpaused
    expect((await toVps(["a".repeat(4000)], { epoch, seq: 1 })).status).toBe(200);
    expect((await ops("/ops/relay/limits", { method: "PUT", body: { paused: true, maxConnected: 1000 } })).status).toBe(200);
    expect((await toVps(["a".repeat(4000)], { epoch, seq: 2 })).status).toBe(200);
    const paused = await otherToVps(["a".repeat(4000)], { epoch, seq: 0 });
    expect(paused.status).toBe(503);
    expect(await paused.json()).toMatchObject({ code: "relay_busy" });
    expect((await (await ops("/ops/relay/stats")).json()).busy).toBe(true);
    expect((await ops("/ops/relay/limits", { method: "PUT", body: { paused: false } })).status).toBe(200);
    expect((await otherToVps(["a".repeat(4000)], { epoch, seq: 0 })).status).toBe(200);
  });
});

describe("relay stats", () => {
  it("counts bytes and refusals per tunnel and day, and shows them only with the stats token", async () => {
    const statsToken = "s".repeat(32);
    await start({ statsToken });
    service.store.tunnels.get(id).acct = acct;
    expect((await toVps(frames(3), { epoch, seq: 0 })).status).toBe(200);
    const tunnel = service.store.tunnels.get(id);
    // a refusal: the relay is paused and this tunnel has gone quiet long enough to count as new
    await request("/ops/relay/limits", { token: statsToken, method: "PUT", body: { paused: true } });
    time += 3 * 60_000;
    expect((await toVps(["a".repeat(4000)], { epoch, seq: 1 })).status).toBe(503);
    await request("/ops/relay/limits", { token: statsToken, method: "PUT", body: { paused: false } });
    expect((await request("/v1/stats/relay")).status).toBe(401);
    expect((await request("/v1/stats/relay", { token: app })).status).toBe(401);
    const res = await request("/v1/stats/relay", { token: statsToken });
    expect(res.status).toBe(200);
    const day = new Date(time).toISOString().slice(0, 10);
    expect(await res.json()).toEqual({ limitBytes: 0, tunnels: [{ id, acct, days: { [day]: { bytes: 3 * MB, limited: 1 } } }] });
    for (let i = 1; i <= 4; i += 1) { time += 86_400_000; tunnel.dayBytes = 0; expect((await toVps(["a".repeat(4000)], { epoch, seq: 1 + i })).status).toBe(200); await read(); }
    expect(Object.keys(service.store.tunnels.get(id).relayDays)).toHaveLength(3);
  });

  it("hides the route when no stats token is set", async () => {
    await start();
    expect((await request("/v1/stats/relay", { token: "s".repeat(32) })).status).toBe(404);
  });
});

describe("queued frames", () => {
  it("drops frames nobody read within a minute, and gives their room back", async () => {
    await start({ maxQueuedBytes: 3 * MB });
    expect((await toVps(frames(2), { epoch, seq: 0 })).status).toBe(200);
    const full = await toVps(frames(2), { epoch, seq: 1 });
    expect(full.status).toBe(503);
    expect(await full.json()).toMatchObject({ code: "busy" });
    time += FRAME_TTL_MS + 1;
    service.store.sweep();
    expect((await read()).frames).toEqual([]);
    expect((await toVps(frames(2), { epoch, seq: 1 })).status).toBe(200);
  });

  it("counts held out-of-order posts against the cap and frees them when the tunnel goes", async () => {
    await start({ maxQueuedBytes: 3 * MB });
    expect((await toVps(frames(2), { epoch, seq: 5 })).status).toBe(200);
    expect((await toVps(frames(2), { epoch, seq: 6 })).status).toBe(503);
    expect((await request(`/v1/tunnels/${id}`, { token: app, method: "DELETE" })).status).toBe(200);
    service.store.tunnels.set(id, { id, createdAt: time, vpsVerifier: sha256hex(vps), appVerifier: sha256hex(app), seenAt: null });
    expect((await toVps(frames(2), { epoch, seq: 0 })).status).toBe(200);
  });
});

describe("setup sessions need a madani account", () => {
  it("refuses a session without a valid grant", async () => {
    await start({ grantKeys: keys });
    for (const bad of [undefined, "nope", grant({ exp: time - 10 * 60_000, iat: time - 20 * 60_000 }), grant({ kid: "other" }),
      grant({ key: generateKeyPairSync("ed25519").privateKey }), grant({ exp: time + 60 * 60_000 })]) {
      const refused = await newSession(bad === undefined ? {} : { grant: bad });
      expect(refused.status).toBe(401);
      expect(await refused.json()).toMatchObject({ code: "account_required" });
    }
  });

  it("opens one with a grant, and the tunnel it makes belongs to that account", async () => {
    await start({ grantKeys: keys });
    const made = await newSession({ grant: grant() });
    expect(made.status).toBe(201);
    const { id: sid } = await made.json();
    expect(service.store.sessions.get(sid).acct).toBe(acct);
    const token = `${sid}-${"s".repeat(26)}`;
    service.store.sessions.get(sid).vpsVerifier = sha256hex(token);
    expect((await request(`/v1/sessions/${sid}/claim`, { token, method: "POST", body: {} })).status).toBe(200);
    const linked = await request(`/v1/sessions/${sid}/result`, { token, method: "POST", body: { sealed: "c2VhbGVk", vpsPub: "k".repeat(43), tunnel: { vps: "1".repeat(64), app: "2".repeat(64) } } });
    expect(linked.status).toBe(200);
    expect(service.store.tunnels.get(sid).acct).toBe(acct);
  });

  it(`allows ${TUNNELS_PER_ACCOUNT} tunnels per account`, async () => {
    expect(TUNNELS_PER_ACCOUNT).toBe(20);
    await start({ grantKeys: keys });
    for (let i = 0; i < TUNNELS_PER_ACCOUNT; i += 1) { const tid = `acctt${i.toString(36).padStart(2, "0")}aaa`; service.store.tunnels.set(tid, { id: tid, createdAt: time, acct, seenAt: null }); }
    const refused = await newSession({ grant: grant() });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "tunnel_limit" });
    expect((await newSession({ grant: grant({ who: "f".repeat(32) }) })).status).toBe(201);
  });

  it("holds at most 5 unused commands per account and 10 new ones a minute, so one account cannot fill the store", async () => {
    await start({ grantKeys: keys });
    const ids = [];
    for (let i = 0; i < 7; i += 1) {
      const made = await newSession({ grant: grant() }, `198.51.100.${i + 1}`);
      expect(made.status).toBe(201);
      ids.push((await made.json()).id);
    }
    const kept = [...service.store.sessions.values()].filter((one) => one.acct === acct).map((one) => one.id);
    expect(kept).toEqual(ids.slice(2));
    for (let i = 7; i < 10; i += 1) expect((await newSession({ grant: grant() }, `198.51.100.${i + 1}`)).status).toBe(201);
    const refused = await newSession({ grant: grant() }, "198.51.100.99");
    expect(refused.status).toBe(429);
    expect((await newSession({ grant: grant({ who: "f".repeat(32) }) }, "198.51.100.98")).status).toBe(201);
  });

  it("keeps sessions open to anyone only when no keys are set (local development)", async () => {
    await start();
    expect((await newSession()).status).toBe(201);
  });
});

describe("idle tunnels", () => {
  it("drops a tunnel whose server has not polled for a week", async () => {
    await start();
    time += TUNNEL_IDLE_MS + 1;
    service.store.sweep();
    expect(service.store.tunnels.has(id)).toBe(false);
  });
});

describe("per-address limits", () => {
  it("refuses an address past its request rate, not its neighbours", async () => {
    await start({ ipLimits: { concurrent: 100, perSecond: 1, burst: 5 } });
    for (let i = 0; i < 5; i += 1) expect((await request("/healthz")).status).toBe(200);
    const refused = await request("/healthz");
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ code: "rate_limited" });
    expect((await request("/healthz", { ip: "198.51.100.2" })).status).toBe(200);
    time += 1000;
    expect((await request("/healthz")).status).toBe(200);
  });

  it("refuses an address holding too many requests open, and frees the slot when one ends", async () => {
    await start({ ipLimits: { concurrent: 2, perSecond: 100, burst: 100 } });
    const abort = new AbortController();
    const held = [0, 1].map(() => fetch(`${base}/v1/tunnels/${id}/to-vps?wait=20`, { headers: { "x-real-ip": "198.51.100.1", authorization: `Bearer ${vps}` }, signal: abort.signal }).catch(() => null));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await request("/healthz")).status).toBe(429);
    abort.abort();
    await Promise.all(held);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await request("/healthz")).status).toBe(200);
  });
});

describe("retired limits", () => {
  it("the old per tunnel day cap in a saved file or a post is skipped, and the rest of the file still counts", () => {
    expect(LIMIT_RANGES.perTunnelDailyBytes).toBeUndefined();
    expect(validateLimits({ perTunnelDailyBytes: 5, maxTunnels: 90 })).toEqual({ limits: { ...DEFAULT_LIMITS, maxTunnels: 90 } });
    const dir = mkdtempSync(join(tmpdir(), "limits-"));
    try {
      saveLimits(dir, { ...DEFAULT_LIMITS, perTunnelDailyBytes: 25e9, maxTunnels: 110 });
      const loaded = loadLimits(dir);
      expect(loaded.maxTunnels).toBe(110);
      expect("perTunnelDailyBytes" in loaded).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
