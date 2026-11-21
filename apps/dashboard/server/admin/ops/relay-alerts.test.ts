import { describe, expect, it } from "vitest";
import { createErrorCounter } from "../health.ts";
import { memoryInfraStore } from "../infra.ts";
import { createOps } from "./index.ts";
import { RELAY_RULE_PREFIX, relayNodeReadings } from "./relay-alerts.ts";
import { createRelays } from "./relays.ts";
import { memoryOpsStore } from "./store.ts";
import type { OpsRelayCard, OpsRelayStats } from "../../../src/admin/ops-types.ts";

const MINUTE = 60_000, NOW = Date.UTC(2026, 10, 13, 12);
const stats = (over: Partial<OpsRelayStats> = {}): OpsRelayStats => ({
  relay: "oracle-in", now: { tunnels: 10, accounts: 8, bytesPerSecOut: 1e6, bytesPerSecIn: 2e5, cpu: 3, rssMb: 120 }, today: { bytesOut: 1e9, bytesIn: 1e8 },
  month: { bytesOut: 50e9, bytesIn: 5e9, projectedBytesOut: 120e9, allowanceBytes: 10e12 }, limits: { globalCeilingBytesPerSec: 25e6, maxTunnels: 150, paused: false }, top: [], busy: false,
  node: { id: "oracle-in", region: "asia", url: "https://link-in.madani.bot", default: false, homed: 10, accepting: true, refuses: null, load: { active: 0, bandwidth: 0, budget: 0, spent: 0, box: 0 } },
  nodes: [{ id: "contabo", url: "https://link.madani.bot", region: "eu", self: false, up: true, lastOkAt: NOW, lastError: null, homed: 3, tunnels: 2, accepting: true }],
  box: { iface: "enp0s6", cpu: 20, mem: 40, cores: 2, bytesPerSecOut: 1.2e6, bytesPerSecIn: 3e5, monthBytesOut: 60e9, monthBytesIn: 9e9, projectedBytesOut: 150e9, countingSince: null },
  turn: { ok: true, at: NOW, rttMs: 1, downSince: null, urls: [] }, ...over,
});
const card = (over: Partial<OpsRelayCard> = {}): OpsRelayCard => ({ id: "oracle-in", label: "oracle in relay", url: "https://link-in.madani.bot", at: NOW, configured: true, ok: true, error: null, stats: stats(), ...over });
const breached = (cards: OpsRelayCard[]) => relayNodeReadings(cards).filter(r => r.breach).map(r => r.id.slice(RELAY_RULE_PREFIX.length));

describe("relay node readings", () => {
  it("are quiet for a healthy node and skip the cloudflare relay", () => {
    expect(breached([card(), card({ id: "cloudflare", ok: false })])).toEqual([]);
  });

  it("trip early: 60% of the ceiling, month on course past 70%, cpu or memory past 80, tunnels past 70%, turn down, no answer", () => {
    const hot = stats({ now: { tunnels: 110, accounts: 90, bytesPerSecOut: 16e6, bytesPerSecIn: 1e6, cpu: 50, rssMb: 900 },
      box: { iface: "enp0s6", cpu: 85, mem: 82, cores: 2, bytesPerSecOut: 17e6, bytesPerSecIn: 1e6, monthBytesOut: 2e12, monthBytesIn: 1e11, projectedBytesOut: 7.5e12, countingSince: null },
      turn: { ok: false, at: NOW, rttMs: null, downSince: NOW, urls: [] } });
    expect(breached([card({ stats: hot })])).toEqual(["oracle-in-bandwidth", "oracle-in-month", "oracle-in-cpu", "oracle-in-mem", "oracle-in-tunnels", "oracle-in-turn"]);
    expect(breached([card({ ok: false, error: "The relay can't be reached.", stats: null })])).toEqual(["oracle-in-down"]);
  });

  it("counts tunnels in use and servers against their own caps under the one tunnels rule", () => {
    const limits = { globalCeilingBytesPerSec: 25e6, maxTunnels: 150, maxConnected: 1000, maxServers: 1500, paused: false };
    const desks = stats({ limits, now: { tunnels: 10, connected: 800, servers: 900, accounts: 8, bytesPerSecOut: 1e6, bytesPerSecIn: 2e5, cpu: 3, rssMb: 120 } });
    const reading = relayNodeReadings([card({ stats: desks })]).find(r => r.id.endsWith("-tunnels"))!;
    expect(reading).toMatchObject({ breach: true, value: "800 of 1000 in use" });
    const servers = stats({ limits, now: { tunnels: 10, connected: 100, servers: 1200, accounts: 8, bytesPerSecOut: 1e6, bytesPerSecIn: 2e5, cpu: 3, rssMb: 120 } });
    expect(relayNodeReadings([card({ stats: servers })]).find(r => r.id.endsWith("-tunnels"))).toMatchObject({ breach: true, value: "1200 of 1500 servers" });
    expect(breached([card({ stats: stats({ limits }) })])).toEqual([]);
  });

  it("names the node and says what to do, in a name the incident emails accept", () => {
    for (const reading of relayNodeReadings([card()])) {
      expect(reading.label).toMatch(/^[A-Za-z_$][\w$ .:-]{0,60}$/);
      expect(reading.label).toContain("oracle-in");
      expect(reading.action.length).toBeGreaterThan(30);
    }
  });

  it("does not believe a month pace from the first few gigabytes", () => {
    const early = stats({ box: { ...stats().box!, monthBytesOut: 50e9, projectedBytesOut: 9e12 } });
    expect(breached([card({ stats: early })])).toEqual([]);
  });
});

describe("relay node alerts", () => {
  it("one email when a node has been down for 2 minutes, none while it stays down, one when it is back", async () => {
    let time = NOW, up = true;
    const reports: Array<{ name: string; message: string; key: string }> = [], recoveries: string[] = [];
    const fetcher = (async (url: string) => {
      if (String(url).startsWith("https://link-in.madani.bot") && !up) throw new TypeError("fetch failed");
      if (String(url).startsWith("https://relay.madani.bot")) return new Response("{}", { status: 404 });
      const self = String(url).startsWith("https://link.madani.bot") ? "contabo" : "oracle-in";
      return Response.json(stats({ relay: self, nodes: [{ id: "oracle-in", url: "https://link-in.madani.bot", region: "asia", self: self === "oracle-in", up: true, lastOkAt: NOW, lastError: null, homed: 1, tunnels: 1, accepting: true }] }));
    }) as unknown as typeof fetch;
    const ops = createOps({ store: memoryOpsStore(), env: { MADANI_OPS_CERT_HOSTS: " ", MADANI_LINK_STATS_TOKEN: "s".repeat(30), MADANI_CF_RELAY_OPS_TOKEN: "c".repeat(30) }, now: () => time, fetch: fetcher,
      db: null, infra: memoryInfraStore(), clouds: () => [], egress: () => null, emails: () => new Map(), customers: () => [], ledger: () => [], invoices: () => [],
      errors: createErrorCounter(() => time), selfUrl: null, environment: "production", host: false,
      incidents: { report: input => { reports.push(input); return `inc-${reports.length}`; }, recovered: async id => { recoveries.push(id); return true; } } });
    await ops.relayTick();
    up = false;
    for (let i = 0; i <= 4; i += 1) { time = NOW + (i + 1) * MINUTE; await ops.relayTick(); }
    expect(reports.map(r => r.name)).toEqual(["link node oracle-in down"]);
    expect(reports[0]!.message).toContain("what to do");
    up = true;
    time += MINUTE; await ops.relayTick();
    time += MINUTE; await ops.relayTick();
    expect(recoveries).toEqual(["inc-1"]);
    expect(reports).toHaveLength(1);
    // the ops page lists them, and the 5 minute rules leave them alone
    await ops.evaluate();
    expect((await ops.answer()).alerts.find(rule => rule.id === `${RELAY_RULE_PREFIX}oracle-in-down`)).toMatchObject({ state: "ok" });
    expect(recoveries).toEqual(["inc-1"]);
  });

  it("finds a link node it was not told about from the first node's peers", async () => {
    const fetcher = (async (url: string) => String(url).startsWith("https://relay.madani.bot") ? new Response("{}", { status: 404 })
      : Response.json(stats({ relay: String(url).includes("link-in") ? "oracle-in" : "contabo" }))) as unknown as typeof fetch;
    const relays = createRelays({ env: { MADANI_LINK_STATS_TOKEN: "s".repeat(30), MADANI_LINK_NODES: "" }, fetch: fetcher, now: () => NOW, accounts: () => [] });
    const nodes = stats().nodes!.map(node => ({ ...node, id: "oracle-in", url: "https://link-in.madani.bot" }));
    const listed = await createRelays({ env: { MADANI_LINK_STATS_TOKEN: "s".repeat(30) }, now: () => NOW, accounts: () => [],
      fetch: (async (url: string) => String(url).startsWith("https://relay.madani.bot") ? new Response("{}", { status: 404 }) : Response.json(stats({ nodes }))) as unknown as typeof fetch }).list();
    expect(listed.relays.map(r => r.id)).toEqual(["contabo", "oracle-in", "cloudflare"]);
    expect(listed.relays[1]!.label).toBe("oracle in relay (asia)");
    expect((await relays.list()).relays.map(r => r.id)).toContain("contabo");
  });
});
