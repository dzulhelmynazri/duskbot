// two link service nodes: the directory copied between them, where a server is placed and found, failing over when its
// node dies, deletes that stay deleted, and turn credentials
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { createAddressBook, placeTunnel } from "../agent.mjs";
import { createTunnelProxy, newLinkKeys, seal, vpsTokenOf } from "../../../electron/vps-link-protocol.mjs";
import { createLinkService, sha256hex } from "../src/app.mjs";
import { choosePlacement, loadOf, parseNodes, refusesNew } from "../src/nodes.mjs";
import { turnCredential } from "../src/turn.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const id = "abcdefghij", vps = "v".repeat(43), app = "a".repeat(43);
const peerToken = "p".repeat(40), turnSecret = "t".repeat(40);
const GB = 1e9;

describe("parseNodes", () => {
  it("reads the list, the first is the default home", () => {
    const config = parseNodes("contabo=https://link.madani.bot@eu,oracle-in=https://link-in.madani.bot@asia", "oracle-in");
    expect(config.defaultId).toBe("contabo");
    expect(config.self).toEqual({ id: "oracle-in", url: "https://link-in.madani.bot", region: "asia" });
    expect(parseNodes("", "x")).toBeNull();
    expect(() => parseNodes("contabo=https://a", "nope")).toThrow(/not in LINK_NODES/);
    expect(() => parseNodes("contabo=ftp://a", "contabo")).toThrow(/not id=/);
  });
});

const healthy = (extra = {}) => ({ tunnels: 10, maxTunnels: 150, bytesPerSecOut: 1e6, ceilingBytesPerSec: 10e6, monthBytesOut: 100 * GB, projectedBytesOut: 300 * GB, allowanceBytes: 10_000 * GB, cpu: 10, mem: 30, homed: 10, ...extra });
const node = (id, health = healthy(), extra = {}) => ({ id, up: true, acked: true, health, ...extra });

describe("choosePlacement", () => {
  it("puts a new server on the node nearer to it when both have room", () => {
    const nodes = [node("contabo"), node("oracle-in")];
    expect(choosePlacement({ nodes, rtt: { contabo: 160, "oracle-in": 25 }, defaultId: "contabo" })).toEqual({ node: "oracle-in", reason: "new" });
    expect(choosePlacement({ nodes, rtt: { contabo: 20, "oracle-in": 150 }, defaultId: "contabo" }).node).toBe("contabo");
  });

  it("goes past the nearer node when it is far more loaded", () => {
    const nodes = [node("contabo", healthy({ tunnels: 5 })), node("oracle-in", healthy({ tunnels: 120, bytesPerSecOut: 7e6 }))];
    expect(choosePlacement({ nodes, rtt: { contabo: 120, "oracle-in": 30 }, defaultId: "contabo" }).node).toBe("contabo");
  });

  it("stops placing on a node whose month is on course past 70% of its allowance", () => {
    const oracle = node("oracle-in", healthy({ projectedBytesOut: 7_100 * GB }));
    expect(refusesNew(oracle)).toBe("month traffic");
    expect(choosePlacement({ nodes: [node("contabo"), oracle], rtt: { contabo: 200, "oracle-in": 10 }, defaultId: "contabo" }).node).toBe("contabo");
  });

  it("is sticky: a server stays home on reconnect while home is fine, even when another node is nearer", () => {
    const nodes = [node("contabo"), node("oracle-in")];
    expect(choosePlacement({ nodes, home: "contabo", rtt: { contabo: 200, "oracle-in": 10 }, defaultId: "contabo" })).toEqual({ node: "contabo", reason: "home" });
  });

  it("moves a server off a home that is down, past 85% of its month, or crowded while another is mostly empty", () => {
    const base = { rtt: {}, defaultId: "contabo" };
    expect(choosePlacement({ ...base, nodes: [node("contabo", healthy(), { up: false }), node("oracle-in")], home: "contabo" }).node).toBe("oracle-in");
    expect(choosePlacement({ ...base, nodes: [node("contabo"), node("oracle-in", healthy({ monthBytesOut: 8_600 * GB }))], home: "oracle-in" }).node).toBe("contabo");
    expect(choosePlacement({ ...base, nodes: [node("contabo", healthy({ tunnels: 140 })), node("oracle-in", healthy({ tunnels: 5 }))], home: "contabo" }))
      .toEqual({ node: "oracle-in", reason: "home is crowded" });
  });

  it("moves a server off a paused home, and off a home the server itself cannot reach while it reaches another", () => {
    const base = { defaultId: "contabo" };
    expect(choosePlacement({ ...base, nodes: [node("contabo", healthy({ paused: true })), node("oracle-in")], home: "contabo", rtt: {} })).toEqual({ node: "oracle-in", reason: "home paused" });
    // both nodes see each other up, but the server measured only oracle: contabo's front is down for it
    expect(choosePlacement({ ...base, nodes: [node("contabo"), node("oracle-in")], home: "contabo", rtt: { "oracle-in": 40 } })).toEqual({ node: "oracle-in", reason: "home is out of the server's reach" });
    // nothing measured (one node known, or an older agent): no conclusion
    expect(choosePlacement({ ...base, nodes: [node("contabo"), node("oracle-in")], home: "contabo", rtt: {} }).node).toBe("contabo");
  });

  it("never sends a server to a peer that may not hold its record yet, and falls back to the default node when none takes new ones", () => {
    expect(choosePlacement({ nodes: [node("contabo"), node("oracle-in", healthy(), { acked: false })], rtt: { "oracle-in": 1, contabo: 300 }, defaultId: "contabo" }).node).toBe("contabo");
    const full = healthy({ paused: true });
    expect(choosePlacement({ nodes: [node("contabo", full), node("oracle-in", full)], defaultId: "contabo" })).toEqual({ node: "contabo", reason: "no node takes new servers" });
  });

  it("spreads the overflow to the least loaded node when every node is full, never to a paused one", () => {
    const crowded = healthy({ tunnels: 149 }), packed = healthy({ tunnels: 150, connected: 2000, maxConnected: 2000 });
    expect(choosePlacement({ nodes: [node("contabo", packed), node("oracle-in", crowded)], defaultId: "contabo" })).toEqual({ node: "oracle-in", reason: "no node takes new servers" });
    expect(choosePlacement({ nodes: [node("contabo", packed), node("oracle-in", healthy({ tunnels: 140, paused: true }))], defaultId: "contabo" }).node).toBe("contabo");
  });

  it("reads load as fractions of each limit, the fuller of busy tunnels and tunnels in use", () => {
    expect(loadOf(healthy())).toMatchObject({ active: 10 / 150, bandwidth: 0.1, budget: 0.03 });
    expect(loadOf(healthy({ connected: 1800, maxConnected: 2000 })).active).toBe(0.9);
    // a node in use by many open desktops takes no new servers, even with few busy tunnels
    expect(refusesNew(node("contabo", healthy({ connected: 1800, maxConnected: 2000 })))).toBe("tunnels");
    // and one most servers already read from, whether or not anyone has a desktop open
    expect(refusesNew(node("contabo", healthy({ servers: 1400, maxServers: 1500 })))).toBe("tunnels");
    expect(choosePlacement({ nodes: [node("contabo", healthy({ servers: 1500, maxServers: 1500 })), node("oracle-in")], home: "contabo", defaultId: "contabo" }).node).toBe("oracle-in");
  });
});

describe("turn credentials", () => {
  it("follows the turn rest api: expiry:label, base64 hmac-sha1 of it", () => {
    const made = turnCredential(turnSecret, "abcdefghij", 1_000_000_000_000, 600);
    expect(made.username).toBe("1000000600:abcdefghij");
    expect(made.credential).toBe(createHmac("sha1", turnSecret).update(made.username).digest("base64"));
  });
});

describe("two nodes", () => {
  const running = [];
  afterEach(async () => {
    for (const one of running.splice(0)) await one.stop();
  });

  /** a node on a real port; LINK_NODES needs the ports first, so the list is filled in by `config` */
  const skew = {};
  async function boot(nodeId, ports, dir = mkdtempSync(join(tmpdir(), `madani-node-${nodeId}-`))) {
    skew[nodeId] = 0;
    const nodes = parseNodes(`contabo=http://127.0.0.1:${ports.contabo},oracle-in=http://127.0.0.1:${ports["oracle-in"]}@asia`, nodeId);
    const service = createLinkService({ base: nodes.self.url, dataDir: dir, scriptPath: join(root, "install.sh"), agentPath: join(root, "agent.mjs"), statsToken: "s".repeat(30), now: () => Date.now() + skew[nodeId],
      nodes, peerToken, turn: { secret: turnSecret } });
    const server = createServer((req, res) => void service.handler(req, res));
    await new Promise((resolve) => server.listen(ports[nodeId], "127.0.0.1", resolve));
    const one = {
      id: nodeId, service, dir, url: nodes.self.url,
      async stop() { service.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); },
    };
    running.push(one);
    return one;
  }
  async function freePorts() {
    const ports = {};
    for (const name of ["contabo", "oracle-in"]) {
      const probe = createServer();
      await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
      ports[name] = probe.address().port;
      await new Promise((resolve) => probe.close(resolve));
    }
    return ports;
  }
  const call = (url, path, { token, method = "GET", body } = {}) => fetch(`${url}${path}`, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  function link(contabo) {
    const tunnel = { id, createdAt: Date.now(), vpsVerifier: sha256hex(vps), appVerifier: sha256hex(app), seenAt: null };
    contabo.service.store.tunnels.set(id, tunnel);
    contabo.service.cluster.changed(tunnel);
    return tunnel;
  }

  it("copies a new tunnel to the other node, places it, and the app finds it where its server polls", async () => {
    const ports = await freePorts();
    const contabo = await boot("contabo", ports), oracle = await boot("oracle-in", ports);
    link(contabo);
    await contabo.service.cluster.syncAll();
    expect(oracle.service.store.tunnels.get(id)).toMatchObject({ vpsVerifier: sha256hex(vps), appVerifier: sha256hex(app) });

    // a server near mumbai is placed on oracle
    await oracle.service.cluster.syncAll();
    const placed = await call(contabo.url, `/v1/tunnels/${id}/place`, { token: vps, method: "POST", body: { rtt: { contabo: 170, "oracle-in": 20 } } }).then((res) => res.json());
    expect(placed).toMatchObject({ node: "oracle-in", url: oracle.url, reason: "new" });
    expect(placed.nodes.map((n) => n.id)).toEqual(["contabo", "oracle-in"]);
    // the app's token only reads; it cannot place
    expect((await call(contabo.url, `/v1/tunnels/${id}/place`, { token: app, method: "POST", body: {} })).status).toBe(404);

    // the home moves when the server reads there, never on a placement it may not follow: the app is sent to the
    // default node until then (and to oracle after 4 s without an answer, or at once by a 409)
    expect((await call(contabo.url, `/v1/tunnels/${id}/node`, { token: app }).then((res) => res.json())).node).toBe("contabo");
    expect((await call(oracle.url, `/v1/tunnels/${id}/to-vps`, { token: vps })).status).toBe(200);
    await oracle.service.cluster.syncAll();
    for (const one of [contabo, oracle]) {
      expect(await call(one.url, `/v1/tunnels/${id}/node`, { token: app }).then((res) => res.json())).toMatchObject({ node: "oracle-in", url: oracle.url, up: true });
    }

    // the node it linked through queues nothing for a server that reads on oracle: it says where to go instead
    const refused = await call(contabo.url, `/v1/tunnels/${id}/to-vps`, { token: app, method: "POST", body: { frames: ["aGk"] } });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "moved", node: "oracle-in", url: oracle.url });
    expect((await call(contabo.url, `/v1/tunnels/${id}/to-app?wait=0`, { token: app })).status).toBe(409);
    expect(contabo.service.store.tunnels.get(id)).toMatchObject({ home: "oracle-in" });

    // relayed end to end on oracle
    expect((await call(oracle.url, `/v1/tunnels/${id}/to-vps`, { token: app, method: "POST", body: { frames: ["aGk"] } })).status).toBe(200);
    expect(await call(oracle.url, `/v1/tunnels/${id}/to-vps`, { token: vps }).then((res) => res.json())).toEqual({ frames: ["aGk"] });

    // sticky on reconnect
    const again = await call(oracle.url, `/v1/tunnels/${id}/place`, { token: vps, method: "POST", body: { rtt: { contabo: 1, "oracle-in": 200 } } }).then((res) => res.json());
    expect(again).toMatchObject({ node: "oracle-in", reason: "home" });

    // ops shows both nodes from either one
    const stats = await call(contabo.url, "/ops/relay/stats", { token: "s".repeat(30) }).then((res) => res.json());
    expect(stats.relay).toBe("contabo");
    expect(stats.node).toMatchObject({ id: "contabo", default: true, accepting: true });
    expect(stats.nodes.map((n) => [n.id, n.up])).toEqual([["contabo", true], ["oracle-in", true]]);
  });

  it("moves a server to the surviving node when its home dies, and a phone channel follows", async () => {
    const ports = await freePorts();
    const contabo = await boot("contabo", ports), oracle = await boot("oracle-in", ports);
    link(contabo);
    await contabo.service.cluster.syncAll();
    expect((await call(oracle.url, `/v1/tunnels/${id}/to-vps`, { token: vps })).status).toBe(200);
    // the server registers a phone channel on oracle
    const channel = "chanchanch", phone = "q".repeat(43);
    expect((await call(oracle.url, `/v1/tunnels/${id}/channels`, { token: vps, method: "PUT", body: { channels: [{ id: channel, verifier: sha256hex(phone), kind: "device" }] } })).status).toBe(200);
    await oracle.service.cluster.syncAll();
    expect(contabo.service.store.channels.get(channel)).toBeTruthy();

    await oracle.stop();
    running.splice(running.indexOf(oracle), 1);
    // contabo notices once oracle has missed syncs for PEER_DOWN_MS
    await contabo.service.cluster.syncAll();
    expect(contabo.service.cluster.view().find((n) => n.id === "oracle-in")).toMatchObject({ up: true });
    skew.contabo = 31_000;
    await contabo.service.cluster.syncAll();
    expect(contabo.service.cluster.view().find((n) => n.id === "oracle-in")).toMatchObject({ up: false });

    const placed = await call(contabo.url, `/v1/tunnels/${id}/place`, { token: vps, method: "POST", body: { rtt: { "oracle-in": 10 } } }).then((res) => res.json());
    expect(placed).toMatchObject({ node: "contabo" });
    expect((await call(contabo.url, `/v1/tunnels/${id}/to-vps`, { token: vps })).status).toBe(200);
    expect(await call(contabo.url, `/v1/channels/${channel}/node`, { token: phone }).then((res) => res.json())).toMatchObject({ node: "contabo" });
    expect((await call(contabo.url, `/v1/channels/${channel}/to-vps`, { token: phone, method: "POST", body: { frames: ["aGk"] } })).status).toBe(200);
  });

  it("a server linked through a node that is not the default is at home there until it polls, and still placed as new", async () => {
    const ports = await freePorts();
    const contabo = await boot("contabo", ports), oracle = await boot("oracle-in", ports);
    const keys = newLinkKeys();
    const made = await call(oracle.url, "/v1/sessions", { method: "POST", body: { verifier: keys.verifier, appPub: keys.pub } }).then((res) => res.json());
    const vpsSession = vpsTokenOf(keys.secret);
    expect((await call(oracle.url, `/v1/sessions/${made.id}/claim`, { token: vpsSession, method: "POST", body: {} })).status).toBe(200);
    const result = await call(oracle.url, `/v1/sessions/${made.id}/result`, { token: vpsSession, method: "POST", body: { sealed: seal(Buffer.alloc(32), made.id, Buffer.from("{}")), vpsPub: keys.pub, tunnel: { vps: sha256hex(vps), app: sha256hex(app) } } });
    expect(result.status).toBe(200);
    // the app's first requests land where it linked, not bounced to the default node
    expect((await call(oracle.url, `/v1/tunnels/${made.id}/to-vps`, { token: app, method: "POST", body: { frames: ["aGk"] } })).status).toBe(200);
    await oracle.service.cluster.syncAll();
    const placed = await call(contabo.url, `/v1/tunnels/${made.id}/place`, { token: vps, method: "POST", body: { rtt: { contabo: 10, "oracle-in": 200 } } }).then((res) => res.json());
    expect(placed).toMatchObject({ node: "contabo", reason: "new" });
  });

  it("keeps the server's sealed address in the directory: any node hands it to the app, nobody else opens it", async () => {
    const ports = await freePorts();
    const contabo = await boot("contabo", ports), oracle = await boot("oracle-in", ports);
    link(contabo);
    await contabo.service.cluster.syncAll();
    const key = Buffer.alloc(32, 3).toString("base64url");
    let address = { mode: "direct", via: "cloudflare", origin: "https://one-two.trycloudflare.com", spki: null };
    const book = createAddressBook({ base: oracle.url, id, key, token: vps, read: async () => address });
    expect(await book.publish()).toBe(true);
    expect(await book.publish()).toBe(false);
    await oracle.service.cluster.syncAll();
    const stored = contabo.service.store.tunnels.get(id).addr;
    expect(stored).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(stored).not.toContain("trycloudflare");
    expect((await call(contabo.url, `/v1/tunnels/${id}/address`, { token: app, method: "PUT", body: { sealed: "x" } })).status).toBe(404);

    const proxy = createTunnelProxy({ base: contabo.url, id, key, token: app, follow: true });
    try {
      expect(await proxy.sealedAddress()).toEqual(address);
      expect(await proxy.sealedAddress()).toBeNull();
      address = { ...address, origin: "https://three-four.trycloudflare.com" };
      expect(await book.publish()).toBe(true);
      await oracle.service.cluster.syncAll();
      expect(await proxy.sealedAddress()).toEqual(address);
    } finally { await proxy.close(); }
  });

  it("a delete on one node stays deleted on the other, even one that was away", async () => {
    const ports = await freePorts();
    const contabo = await boot("contabo", ports);
    let oracle = await boot("oracle-in", ports);
    link(contabo);
    await contabo.service.cluster.syncAll();
    const oracleDir = oracle.dir;
    await oracle.stop();
    running.splice(running.indexOf(oracle), 1);
    expect((await call(contabo.url, `/v1/tunnels/${id}`, { token: app, method: "DELETE" })).status).toBe(200);
    oracle = await boot("oracle-in", ports, oracleDir);
    expect(oracle.service.store.tunnels.has(id)).toBe(true);
    // oracle comes back and sends its (older) copy first: it must not bring the tunnel back
    await oracle.service.cluster.syncAll();
    expect(contabo.service.store.tunnels.has(id)).toBe(false);
    await contabo.service.cluster.syncAll();
    expect(oracle.service.store.tunnels.has(id)).toBe(false);
    expect((await call(oracle.url, `/v1/tunnels/${id}/to-vps`, { token: vps })).status).toBe(404);
  });

  it("refuses a sync without the peer token, and answers turn credentials for the tunnel's home first", async () => {
    const ports = await freePorts();
    const contabo = await boot("contabo", ports), oracle = await boot("oracle-in", ports);
    link(contabo);
    expect((await call(contabo.url, "/internal/v1/sync", { token: "x".repeat(40), method: "POST", body: { from: "oracle-in", records: [] } })).status).toBe(404);
    const turn = await call(contabo.url, `/v1/tunnels/${id}/turn`, { token: app }).then((res) => res.json());
    expect(turn.iceServers[0].urls).toEqual(["stun:stun.cloudflare.com:3478"]);
    expect(turn.iceServers[1].urls[0]).toBe("turn:127.0.0.1:3478?transport=udp");
    expect(turn.iceServers[1].username).toMatch(new RegExp(`^\\d+:${id}$`));
    expect(turn.iceServers[1].credential).toBe(createHmac("sha1", turnSecret).update(turn.iceServers[1].username).digest("base64"));
    expect((await call(contabo.url, `/v1/tunnels/${id}/turn`, { token: "nope" })).status).toBe(404);
    const listed = await call(oracle.url, "/v1/nodes").then((res) => res.json());
    expect(listed).toMatchObject({ self: "oracle-in", default: "contabo" });
  });

  it("the agent places itself through the node it was linked by, and through a known node when that one is dead", async () => {
    const ports = await freePorts();
    const contabo = await boot("contabo", ports), oracle = await boot("oracle-in", ports);
    link(contabo);
    await contabo.service.cluster.syncAll();
    await oracle.service.cluster.syncAll();
    const first = await placeTunnel({ base: contabo.url, id, token: vps });
    expect(first).toMatchObject({ node: expect.any(String), nodes: [{ id: "contabo", url: contabo.url }, { id: "oracle-in", url: oracle.url }] });
    await contabo.stop();
    running.splice(running.indexOf(contabo), 1);
    skew["oracle-in"] = 31_000;
    await oracle.service.cluster.syncAll();
    const moved = await placeTunnel({ base: contabo.url, id, token: vps, known: first.nodes });
    expect(moved).toMatchObject({ node: "oracle-in", url: oracle.url });
    expect(await placeTunnel({ base: oracle.url, id, token: "nope" })).toEqual({ unlinked: true });
  });
});
