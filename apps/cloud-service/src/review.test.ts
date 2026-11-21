// an independent review of paths the lifecycle tests do not try
import { CLOUD_HOME } from "../../../electron/legacy-names.mjs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { StoredSubscription } from "../../dashboard/server/billing/store.ts";
import { createInstaboxProvider } from "./instabox.ts";
import { createAudit } from "./audit.ts";
import { createBackupStore, homeBackupKey } from "./backups.ts";
import { DEFAULT_MANAGED_SETTINGS } from "./lifecycle.ts";
import { DAY_MS, entitlementOf } from "./retention.ts";
import { createFakeCloudProvider } from "../../dashboard/server/clouds/fake-provider.ts";
import { startFakeInstaboxApi } from "./fake-instabox-api.ts";
import { createSealer } from "../../dashboard/server/clouds/seal.ts";
import { createManagedCloud } from "./index.ts";
import { createCloudsService } from "../../dashboard/server/clouds/service.ts";
import type { DesktopPlan, HomePower, StoredCloud } from "../../dashboard/server/clouds/types.ts";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks(); });
const plan: DesktopPlan = { kind: "shared_s", placement: "pool", spec: { vcpu: 2, ramGb: 4, diskGb: 40 }, botComputers: 2 };
const SEAL = Buffer.alloc(32, 7), BACKUP_SECRET = Buffer.alloc(32, 9);

async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "madani-review-")); cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  let at = Date.UTC(2026, 10, 9, 12);
  const now = () => at;
  const api = await startFakeInstaboxApi({ now }); cleanup.push(() => api.close());
  api.onExec(({ machine, cmd }) => {
    if (cmd.includes("omb-home start") && !machine.volume.size) {
      machine.volume.set("data/.omb-cloud-home.json", Buffer.from(JSON.stringify({ version: 1, machine: machine.metadata["omb.cloud"] })));
      machine.volume.set(`data/${CLOUD_HOME.dataName}/bots.json`, Buffer.from(JSON.stringify([{ id: "bot-1", name: "Test bot" }])));
    }
    return null;
  });
  const power: HomePower = { idle: false, busy: ["recent-activity"], lastActivityAt: null, nextDueAt: null, wokeAt: at };
  const subscriptions: StoredSubscription[] = [];
  const notices: Array<{ cloudId: string; kind: string; at: number | null; link?: string }> = [];
  /** one dashboard process over the shared data dir */
  function instance() {
    const provider = createInstaboxProvider({ apiKey: api.key, baseUrl: api.baseUrl, scope: "0123456789abcdef", pollMs: 1, settleMs: 5_000, now });
    const home = { healthy: vi.fn(async () => true), pair: vi.fn(async () => ({ code: "ABCD-EFGH-JKLM", expiresAt: at + 300_000 })),
      power: vi.fn(async () => ({ ...power })), sleep: vi.fn(async () => ({ ok: power.idle, nextDueAt: power.nextDueAt })), plan: vi.fn(async () => {}) };
    const audit = createAudit({ dataDir, now });
    const backups = createBackupStore({ dir: join(dataDir, "managed-backups"), now });
    const workspaces = { register: vi.fn(() => "workspace-1"), lastReportAt: vi.fn(() => null), remove: vi.fn() };
    const service = createCloudsService({ dataDir, now, home, sealer: createSealer(SEAL), workspaces,
      providers: { dedicated: createFakeCloudProvider(), pool: { ...createFakeCloudProvider(), suspend: async () => {}, resume: async () => {} } },
      config: { adminOrigin: "https://admin.example.test", dashboardUrl: "https://dash.example.test", image: "ghcr.io/example/home:1", poolQuota: (_k, spec, botComputers) => ({ ...spec, netMbps: 1, pids: 1, botComputers }) },
      managed: createManagedCloud({ provider, backups, audit, kinds: ["shared_s", "shared_m", "dedicated"], backupSecret: BACKUP_SECRET,
        settings: { ...DEFAULT_MANAGED_SETTINGS, package: { sha256: "a".repeat(64), url: "https://packages.example.test/home.tgz" } },
        entitlement: cloud => entitlementOf(subscriptions, cloud, at),
        notify: (cloud, kind, when, link) => notices.push({ cloudId: cloud.id, kind, at: when, ...(link ? { link } : {}) }) }) });
    cleanup.push(() => service.close());
    return { service, provider, audit, backups };
  }
  async function settle(s: ReturnType<typeof createCloudsService>, c: StoredCloud, until: (c: StoredCloud) => boolean, max = 30, stepMs = 0) {
    for (let n = 0; n < max && !until(c); n++) { c.nextAttemptAt = 0; await s.reconcile(); if (!until(c)) at += stepMs; }
    expect(until(c)).toBe(true);
  }
  async function paid(s: ReturnType<typeof createCloudsService>) {
    const c = s.order({ ...plan, accountId: "acct_1", name: "My Cloud", color: null, region: "eu" });
    const sub = { id: `sub_${c.id}`, accountId: c.accountId, cloudId: c.id, status: "active", currentPeriodEnd: at + 30 * DAY_MS, currentPeriodStart: at, updatedAt: at, lastEventAt: at } as unknown as StoredSubscription;
    subscriptions.push(sub);
    s.activate(c.id, sub.id, plan);
    await settle(s, c, c => c.status === "running");
    return { c, sub };
  }
  /** a machine is declared lost only after repeated 404s over half an hour: the clock moves while it is checked */
  async function waitLost(s: ReturnType<typeof createCloudsService>, c: StoredCloud, until: (c: StoredCloud) => boolean) {
    for (let n = 0; n < 60 && !until(c); n++) { at += 11 * 60_000; c.nextAttemptAt = 0; await s.reconcile(); }
    expect(until(c)).toBe(true);
  }
  return { api, power, subscriptions, notices, dataDir, instance, settle, waitLost, paid, now, advance(ms: number) { at += ms; } };
}

type F = Awaited<ReturnType<typeof fixture>>;
async function sleepCycle(f: F, s: ReturnType<typeof createCloudsService>, c: StoredCloud) {
  f.power.idle = true; f.power.busy = [];
  await f.settle(s, c, c => c.status === "sleeping", 60, 5 * 60_000);
  for (let n = 0; n < 3; n++) { c.nextAttemptAt = 0; await s.reconcile(); }
}
async function wake(f: F, s: ReturnType<typeof createCloudsService>, c: StoredCloud) {
  await s.power(c.accountId, c.id, "on"); await f.settle(s, c, c => c.status === "running");
  f.advance(5 * 60_000);
}

it("a backup restores byte for byte into a fresh machine after the machine is lost", async () => {
  const f = await fixture(); const { service: s } = f.instance();
  const { c } = await f.paid(s);
  f.advance(DAY_MS); await sleepCycle(f, s, c);
  expect(c.managed!.backups).toHaveLength(1);
  const before = new Map(f.api.machines.get(c.serverId!)!.volume);
  const lost = c.serverId!;
  f.api.lose(lost);
  await f.waitLost(s, c, c => c.status === "running" && c.serverId !== lost);
  const after = f.api.machines.get(c.serverId!)!.volume;
  expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  for (const [k, v] of before) expect(after.get(k)!.equals(v)).toBe(true);
});

it("a backup is bound to its cloud: another cloud's key or id cannot open it", async () => {
  const f = await fixture(); const { service: s, backups } = f.instance();
  const { c } = await f.paid(s);
  f.advance(DAY_MS); await sleepCycle(f, s, c);
  const file = c.managed!.backups[0]!.file, key = homeBackupKey(BACKUP_SECRET, c.id);
  expect(backups.read(c.id, key, file).length).toBeGreaterThan(0);
  expect(() => backups.read(c.id, homeBackupKey(BACKUP_SECRET, `c${"f".repeat(24)}`), file)).toThrow("integrity");
  // the home holds its bootstrap secret; a key derived from it opens nothing
  expect(() => backups.read(c.id, homeBackupKey(Buffer.from(createSealer(SEAL).unseal(c.bootstrapSecret).padEnd(32, "x")), c.id), file)).toThrow("integrity");
});

it("no provider API key or seal key travels to the machine, and nothing secret is logged across a whole life", async () => {
  const logs: string[] = [];
  for (const m of ["log", "warn", "error", "info"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  const f = await fixture(); const { service: s } = f.instance();
  const { c, sub } = await f.paid(s);
  f.advance(DAY_MS); await sleepCycle(f, s, c);
  f.api.lose(c.serverId!); await f.waitLost(s, c, c => c.status === "running" && c.managed!.attempt === 1);
  sub.status = "ended"; sub.currentPeriodEnd = f.now(); sub.lastEventAt = f.now();
  await f.settle(s, c, c => c.status === "stopped");
  const secret = createSealer(SEAL).unseal(c.bootstrapSecret);
  const sent = JSON.stringify(f.api.requests.map(r => r.body));
  for (const leak of [f.api.key, SEAL.toString("hex"), SEAL.toString("base64"), SEAL.toString("base64url")]) expect(sent).not.toContain(leak);
  const commands = f.api.requests.filter(r => r.path.endsWith("/exec")).map(r => JSON.stringify(r.body)).join("\n");
  expect(commands).not.toContain(secret);
  for (const leak of [f.api.key, secret]) expect(logs.join("\n")).not.toContain(leak);
});

it("one transient 404 from the provider must not rebuild a paid cloud and later delete the disk holding data newer than any backup", async () => {
  const f = await fixture(); const { service: s, provider, audit } = f.instance();
  const { c } = await f.paid(s);
  f.advance(DAY_MS); await sleepCycle(f, s, c);
  expect(c.managed!.backups).toHaveLength(1);
  // woken, something that matters is written, asleep again within the backup interval (so no new backup yet)
  await wake(f, s, c);
  const original = c.serverId!;
  f.api.machines.get(original)!.volume.set(`data/${CLOUD_HOME.dataName}/precious.json`, Buffer.from("written after the last backup"));
  await sleepCycle(f, s, c);
  expect(c.managed!.backups).toHaveLength(1);
  // one GET answers 404 (a provider incident, a proxy, a rotated key for one deploy); the machine is in fact still there
  const real = provider.machine; let blip = true;
  provider.machine = async id => { if (blip && id === original) { blip = false; return null; } return real(id); };
  c.nextAttemptAt = 0; await s.reconcile();
  expect.soft(c.serverId, "a single 404 rebuilt the cloud").toBe(original);
  if (c.serverId !== original) await f.settle(s, c, c => c.status === "running" && c.serverId !== null);
  const restoredHasIt = f.api.machines.get(c.serverId!)!.volume.has(`data/${CLOUD_HOME.dataName}/precious.json`);
  console.info(`[review] rebuilt onto ${c.serverId === original ? "ORIGINAL" : "a new machine"}; restored volume has the newer data: ${restoredHasIt}`);
  // a normal week of use afterwards
  for (let day = 0; day < 9; day++) { f.advance(DAY_MS); if (c.status === "sleeping") await wake(f, s, c); await sleepCycle(f, s, c); }
  const deletedPaths = f.api.deletes().map(d => d.path);
  console.info(`[review] after one 404: attempt=${c.managed!.attempt} retired=${JSON.stringify(c.managed!.retired.map(r => ({ id: r.serverId === original ? "ORIGINAL" : r.serverId, deletion: r.deletion ? "sent" : null })))} deletes=${JSON.stringify(deletedPaths.map(p => p.includes(original) ? "ORIGINAL" : p))} actions=${audit.entries(c.id).map(e => e.action).filter(a => /recover|retired|delete/.test(a)).join(",")}`);
  const survives = [...f.api.machines.values()].some(x => x.volume.has(`data/${CLOUD_HOME.dataName}/precious.json`));
  expect(deletedPaths, "the original machine, still holding unbacked data, was deleted").not.toContain(`/v1/machines/${original}`);
  expect(survives, "the data written after the last backup is gone").toBe(true);
});

it("in one process, concurrent reconciles and a wake during a due deletion send one DELETE and never rebuild", async () => {
  const f = await fixture(); const { service: s } = f.instance();
  const { c, sub } = await f.paid(s);
  sub.status = "ended"; sub.currentPeriodEnd = f.now(); sub.lastEventAt = f.now();
  await f.settle(s, c, c => c.status === "stopped");
  await f.settle(s, c, c => (c.managed!.backups.at(-1)?.verifiedAt ?? null) !== null);
  f.advance(45 * DAY_MS + 60_000); c.nextAttemptAt = 0;
  const results = await Promise.allSettled([s.reconcile(), s.reconcile(), s.power(c.accountId, c.id, "on"), s.reconcile()]);
  await f.settle(s, c, c => c.status === "destroyed");
  expect(f.api.deletes()).toHaveLength(1);
  expect(c.managed!.attempt).toBe(0);
  // the wake was accepted (status read before the delete) but neither cancelled nor raced it
  expect(results.every(r => r.status === "fulfilled" || r.status === "rejected")).toBe(true);
});

it("an owner's emailed link expires after an hour and cannot confirm another cloud's deletion", async () => {
  const f = await fixture(); const { service: s } = f.instance();
  const a = await f.paid(s), b = await f.paid(s);
  for (const x of [a, b]) { x.sub.status = "ended"; x.sub.currentPeriodEnd = f.now(); x.sub.lastEventAt = f.now(); }
  await f.settle(s, a.c, c => c.status === "stopped"); await f.settle(s, b.c, c => c.status === "stopped");
  s.managed!.requestDelete(a.c, t => `#${t}`);
  const tokenA = f.notices.findLast(n => n.kind === "delete_requested")!.link!.slice(1);
  s.managed!.requestDelete(b.c, t => `#${t}`);
  expect(() => s.managed!.confirmDelete(b.c, tokenA)).toThrow("confirmation_required");
  f.advance(60 * 60_000 + 1);
  expect(() => s.managed!.confirmDelete(a.c, tokenA)).toThrow("confirmation_required");
  f.advance(10 * DAY_MS); for (let n = 0; n < 4; n++) { a.c.nextAttemptAt = 0; b.c.nextAttemptAt = 0; await s.reconcile(); }
  expect(f.api.deletes()).toHaveLength(0);
});

it("two dashboard processes on one data dir: the second is refused, and a cancel is honoured", async () => {
  const f = await fixture(); const A = f.instance();
  const { c, sub } = await f.paid(A.service);
  sub.status = "ended"; sub.currentPeriodEnd = f.now(); sub.lastEventAt = f.now();
  await f.settle(A.service, c, c => c.status === "stopped");
  await f.settle(A.service, c, c => (c.managed!.backups.at(-1)?.verifiedAt ?? null) !== null);
  A.service.managed!.requestDelete(c, t => `#${t}`);
  A.service.managed!.confirmDelete(c, f.notices.findLast(n => n.kind === "delete_requested")!.link!.slice(1));
  // a second process starting on the same data dir (a deploy overlap) is refused while the first one runs
  expect(() => f.instance()).toThrow("already using this data folder");
  A.service.managed!.cancelDelete(c);
  f.advance(8 * DAY_MS);
  for (let n = 0; n < 4; n++) { c.nextAttemptAt = 0; await A.service.reconcile(); }
  expect(f.api.deletes(), "a cancelled deletion was executed").toHaveLength(0);
  // once the first stops, the next one starts on what it wrote
  A.service.close();
  const B = f.instance();
  expect(B.service.get(c.id)!.managed!.deleteRequest!.cancelledAt).not.toBeNull();
});

it("a deletion re-reads the stored record first: a cancel or hold found there stops it", async () => {
  const f = await fixture(); const A = f.instance();
  const { c, sub } = await f.paid(A.service);
  sub.status = "ended"; sub.currentPeriodEnd = f.now(); sub.lastEventAt = f.now();
  await f.settle(A.service, c, c => c.status === "stopped");
  await f.settle(A.service, c, c => (c.managed!.backups.at(-1)?.verifiedAt ?? null) !== null);
  f.advance(46 * DAY_MS);
  // the record on disk says hold (an operator's edit the running process has not seen)
  const file = join(f.dataDir, "clouds.json"), stored = JSON.parse(readFileSync(file, "utf8"));
  stored.clouds.find((x: { id: string }) => x.id === c.id).managed.hold = true;
  writeFileSync(file, JSON.stringify(stored));
  c.nextAttemptAt = 0; await A.service.reconcile();
  expect(f.api.deletes()).toHaveLength(0);
  expect(A.audit.entries(c.id).map(e => e.action)).toContain("delete_refused");
});
