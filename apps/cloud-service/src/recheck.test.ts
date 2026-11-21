// an independent re-check of recovery, retention and the backup secret, over one shared data dir
import { CLOUD_HOME } from "../../../electron/legacy-names.mjs";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { spawnSync } from "node:child_process";
import { lockDataDir } from "../../dashboard/server/data-dir-lock.ts";
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
  const dataDir = mkdtempSync(join(tmpdir(), "madani-recheck-")); cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
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
  function instance(secret: Buffer = BACKUP_SECRET, previous: Buffer | null = null) {
    const provider = createInstaboxProvider({ apiKey: api.key, baseUrl: api.baseUrl, scope: "0123456789abcdef", pollMs: 1, settleMs: 5_000, now });
    const home = { healthy: vi.fn(async () => true), pair: vi.fn(async () => ({ code: "ABCD-EFGH-JKLM", expiresAt: at + 300_000 })),
      power: vi.fn(async () => ({ ...power })), sleep: vi.fn(async () => ({ ok: power.idle, nextDueAt: power.nextDueAt })), plan: vi.fn(async () => {}) };
    const audit = createAudit({ dataDir, now });
    const backups = createBackupStore({ dir: join(dataDir, "managed-backups"), now });
    const workspaces = { register: vi.fn(() => "workspace-1"), lastReportAt: vi.fn(() => null), remove: vi.fn() };
    const service = createCloudsService({ dataDir, now, home, sealer: createSealer(SEAL), workspaces,
      providers: { dedicated: createFakeCloudProvider(), pool: { ...createFakeCloudProvider(), suspend: async () => {}, resume: async () => {} } },
      config: { adminOrigin: "https://admin.example.test", dashboardUrl: "https://dash.example.test", image: "ghcr.io/example/home:1", poolQuota: (_k, spec, botComputers) => ({ ...spec, netMbps: 1, pids: 1, botComputers }) },
      managed: createManagedCloud({ provider, backups, audit, kinds: ["shared_s", "shared_m", "dedicated"], backupSecret: secret, previousBackupSecret: previous,
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


type S = ReturnType<typeof createCloudsService>;
/** a cloud with one backup and, on its disk only, data newer than that backup */
async function withUnbackedData(f: F, s: S) {
  const { c, sub } = await f.paid(s);
  f.advance(DAY_MS); await sleepCycle(f, s, c);
  await wake(f, s, c);
  f.api.machines.get(c.serverId!)!.volume.set(`data/${CLOUD_HOME.dataName}/precious.json`, Buffer.from("newer"));
  await sleepCycle(f, s, c);
  expect(c.managed!.backups).toHaveLength(1);
  return { c, sub, original: c.serverId! };
}
/** the provider answers 404 for `id` (and, when `unlisted`, leaves it out of the account list) until restored */
function blackout(provider: ReturnType<F["instance"]>["provider"], id: string, unlisted: boolean) {
  const machine = provider.machine, listed = provider.listed;
  provider.machine = async x => x === id ? null : machine(x);
  if (unlisted) provider.listed = async x => x === id ? false : listed(x);
  return () => { provider.machine = machine; provider.listed = listed; };
}
/** the unbacked data is still somewhere: on a machine, or in a provider snapshot of one */
const holds = (f: F) => [...f.api.machines.values(), ...f.api.snapshots.values()].some(x => x.volume.has(`data/${CLOUD_HOME.dataName}/precious.json`));

for (const count of [1, 2, 3]) {
  it(`${count} 404s inside 30 minutes, then an answer: no rebuild`, async () => {
    const f = await fixture(); const { service: s, provider } = f.instance();
    const { c, original } = await withUnbackedData(f, s);
    const restore = blackout(provider, original, true);
    for (let n = 0; n < count; n++) { c.nextAttemptAt = 0; await s.reconcile(); f.advance(9 * 60_000); }
    restore(); c.nextAttemptAt = 0; await s.reconcile();
    expect(c.serverId).toBe(original); expect(c.managed!.attempt).toBe(0); expect(c.managed!.missingSince ?? null).toBeNull();
  });
}

it("404s for over 30 minutes while the provider's list still shows the machine: no rebuild", async () => {
  const f = await fixture(); const { service: s, provider } = f.instance();
  const { c, original } = await withUnbackedData(f, s);
  const restore = blackout(provider, original, false);
  for (let n = 0; n < 12; n++) { f.advance(11 * 60_000); c.nextAttemptAt = 0; await s.reconcile(); }
  restore();
  expect(c.managed!.attempt).toBe(0); expect(c.serverId).toBe(original);
});

it("3 404s spread just under 30 minutes and unlisted: still no rebuild", async () => {
  const f = await fixture(); const { service: s, provider } = f.instance();
  const { c, original } = await withUnbackedData(f, s);
  blackout(provider, original, true);
  for (const gap of [0, 14 * 60_000, 15 * 60_000]) { f.advance(gap); c.nextAttemptAt = 0; await s.reconcile(); }
  expect(c.managed!.attempt).toBe(0);
});

it("confirmed lost (404 and unlisted past 30 minutes) but the disk comes back: rebuilt, the original saved whole as a snapshot before its disk is deleted", async () => {
  const f = await fixture(); const { service: s, provider, audit } = f.instance();
  const { c, original } = await withUnbackedData(f, s);
  const restore = blackout(provider, original, true);
  for (let n = 0; n < 8 && c.managed!.attempt === 0; n++) { f.advance(11 * 60_000); c.nextAttemptAt = 0; await s.reconcile(); }
  expect(c.managed!.attempt).toBe(1);
  await f.settle(s, c, c => c.status === "running" && c.serverId !== original);
  restore();
  // the reconciler keeps running while the home sleeps: time passes between passes
  for (let day = 0; day < 60; day++) { f.advance(DAY_MS); if (c.status === "sleeping") await wake(f, s, c); await sleepCycle(f, s, c); for (let n = 0; n < 3; n++) { f.advance(11 * 60_000); c.nextAttemptAt = 0; await s.reconcile(); } }
  expect(f.api.deletes()).toHaveLength(0);
  expect(holds(f)).toBe(true);
  const retired = c.managed!.retired.find(r => r.serverId === original)!;
  expect(f.api.snapshots.get(retired.snapshotId!)!.volume.has(`data/${CLOUD_HOME.dataName}/precious.json`)).toBe(true);
  expect(f.api.machines.has(original)).toBe(false);
  expect(audit.entries(c.id).map(e => e.action)).not.toContain("delete_requested");
});

it("an ended plan's cloud that is confirmed lost keeps its notices and is not deleted before 30 days", async () => {
  const f = await fixture(); const { service: s, provider } = f.instance();
  const { c, sub, original } = await withUnbackedData(f, s);
  sub.status = "ended"; sub.currentPeriodEnd = f.now(); sub.lastEventAt = f.now();
  await f.settle(s, c, c => c.status === "stopped");
  for (let n = 0; n < 3; n++) { c.nextAttemptAt = 0; await s.reconcile(); }
  const endedAt = f.now();
  blackout(provider, original, true);
  for (let n = 0; n < 8; n++) { f.advance(11 * 60_000); c.nextAttemptAt = 0; await s.reconcile(); }
  while (f.now() < endedAt + 30 * DAY_MS - DAY_MS) { f.advance(DAY_MS); c.nextAttemptAt = 0; await s.reconcile(); }
  expect(f.api.deletes()).toHaveLength(0);
  expect(f.notices.filter(n => n.cloudId === c.id).map(n => n.kind)).toEqual(expect.arrayContaining(["ended", "left_7"]));
});

it("the data-dir lock: another process is refused, a dead process's lock is taken over", () => {
  const dir = mkdtempSync(join(tmpdir(), "madani-lock-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const unlock = lockDataDir(dir);
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "-e", `import("${join(process.cwd(), "apps/dashboard/server/data-dir-lock.ts")}").then(m => { try { m.lockDataDir(${JSON.stringify(dir)}); console.log("TOOK"); } catch (e) { console.log("REFUSED " + e.name); } })`], { encoding: "utf8" });
  expect(child.stdout).toContain("REFUSED DataDirLockedError");
  unlock();
  // a crashed process on this host (pid no longer alive)
  writeFileSync(join(dir, ".writer.lock"), JSON.stringify({ pid: 2 ** 22 - 3, host: hostname(), at: Date.now() - 1000 }));
  const again = lockDataDir(dir); again();
  // another host's lock is never taken over
  writeFileSync(join(dir, ".writer.lock"), JSON.stringify({ pid: 1, host: "other-host", at: Date.now() }));
  expect(() => lockDataDir(dir)).toThrow("already using");
  rmSync(join(dir, ".writer.lock"));
});

it("a stale lock left by an earlier run that had this same pid (a restarted container's pid 1) is taken over", () => {
  const dir = mkdtempSync(join(tmpdir(), "madani-lock-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, ".writer.lock"), JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() - 3_600_000 }));
  let took = false;
  try { lockDataDir(dir)(); took = true; } catch {}
  expect(took, "the service cannot start after a crash when it gets the same pid again").toBe(true);
});

it("a cancel written to the record by another writer stops a due owner deletion", async () => {
  const f = await fixture(); const A = f.instance();
  const { c, sub } = await f.paid(A.service);
  sub.status = "ended"; sub.currentPeriodEnd = f.now(); sub.lastEventAt = f.now();
  await f.settle(A.service, c, c => c.status === "stopped");
  A.service.managed!.requestDelete(c, t => `#${t}`);
  A.service.managed!.confirmDelete(c, f.notices.findLast(n => n.kind === "delete_requested")!.link!.slice(1));
  const file = join(f.dataDir, "clouds.json"), stored = JSON.parse(readFileSync(file, "utf8"));
  stored.clouds.find((x: { id: string }) => x.id === c.id).managed.deleteRequest.cancelledAt = f.now();
  writeFileSync(file, JSON.stringify(stored));
  f.advance(8 * DAY_MS);
  for (let n = 0; n < 4; n++) { c.nextAttemptAt = 0; await A.service.reconcile(); }
  expect(f.api.deletes()).toHaveLength(0);
});

it("a changed backup secret refuses to start unless the previous one is given, and then every backup opens with the new one", async () => {
  const f = await fixture(); const A = f.instance();
  const { c, sub } = await f.paid(A.service);
  sub.status = "ended"; sub.currentPeriodEnd = f.now(); sub.lastEventAt = f.now();
  await f.settle(A.service, c, c => c.status === "stopped");
  await f.settle(A.service, c, c => (c.managed!.backups.at(-1)?.verifiedAt ?? null) !== null);
  A.service.close();
  // the operator sets MADANI_MANAGED_BACKUP_KEY (or rotates the seal key) after backups were written
  expect(() => f.instance(Buffer.alloc(32, 1))).toThrow("backup secret changed");
  // given the old one, every backup is sealed again first
  const B = f.instance(Buffer.alloc(32, 1), BACKUP_SECRET); const cB = B.service.get(c.id)!;
  const file = cB.managed!.backups.at(-1)!.file;
  expect(B.backups.read(c.id, homeBackupKey(Buffer.alloc(32, 1), c.id), file).length).toBeGreaterThan(0);
  expect(() => B.backups.read(c.id, homeBackupKey(BACKUP_SECRET, c.id), file)).toThrow("integrity");
  f.advance(46 * DAY_MS);
  for (let n = 0; n < 6; n++) { cB.nextAttemptAt = 0; await B.service.reconcile(); }
  expect(cB.status).toBe("destroyed");
});

it("retention never deletes a machine whose final backup no longer opens, and says so", async () => {
  const f = await fixture(); const A = f.instance();
  const { c, sub } = await f.paid(A.service);
  sub.status = "ended"; sub.currentPeriodEnd = f.now(); sub.lastEventAt = f.now();
  await f.settle(A.service, c, c => c.status === "stopped");
  await f.settle(A.service, c, c => (c.managed!.backups.at(-1)?.verifiedAt ?? null) !== null);
  const path = join(f.dataDir, "managed-backups", c.id, c.managed!.backups.at(-1)!.file);
  chmodSync(path, 0o600); const bytes = readFileSync(path); bytes[bytes.length - 20]! ^= 0xff; writeFileSync(path, bytes);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  f.advance(46 * DAY_MS);
  for (let n = 0; n < 6; n++) { c.nextAttemptAt = 0; await A.service.reconcile(); }
  expect(f.api.deletes()).toHaveLength(0);
  expect(A.audit.entries(c.id).map(e => `${e.action}:${e.reason}`)).toContain("delete_refused:backup_unreadable");
  expect(warn.mock.calls.flat().join(" ")).toContain("ALERT");
});

it("a plan upgrade resizes the machine at its next sleep, its disk kept, and it comes back on the new size", async () => {
  const f = await fixture(); const { service: s } = f.instance();
  const { c } = await f.paid(s);
  s.changePlan(c.id, { kind: "shared_m", placement: "pool", spec: { vcpu: 4, ramGb: 8, diskGb: 40 }, botComputers: 2 });
  f.advance(DAY_MS); f.power.idle = true; f.power.busy = [];
  await f.settle(s, c, c => c.status === "running" && c.spec.vcpu === 4, 40);
  const machine = f.api.machines.get(c.serverId!)!;
  expect([machine.vcpus, machine.memMiB]).toEqual([4, 8192]);
  expect(machine.volume.has(`data/${CLOUD_HOME.dataName}/bots.json`)).toBe(true);
  expect(c.managed!.attempt).toBe(0);
});

it("no create, wake or resize hands the provider a secret, an env or a vault", async () => {
  const f = await fixture(); const { service: s } = f.instance();
  const { c } = await f.paid(s);
  f.power.idle = true; f.power.busy = []; f.advance(5 * 60_000);
  await f.settle(s, c, c => c.status === "sleeping", 60, 5 * 60_000);
  await s.power(c.accountId, c.id, "on"); await f.settle(s, c, c => c.status === "running");
  s.changePlan(c.id, { kind: "shared_m", placement: "pool", spec: { vcpu: 4, ramGb: 8, diskGb: 40 }, botComputers: 2 });
  f.advance(DAY_MS);
  await f.settle(s, c, c => c.status === "running" && c.spec.vcpu === 4, 80, 5 * 60_000);
  f.power.idle = true; f.power.busy = []; f.advance(5 * 60_000);
  await f.settle(s, c, c => c.status === "sleeping", 60, 5 * 60_000);
  for (let n = 0; n < 3; n++) { c.nextAttemptAt = 0; await s.reconcile(); }
  await s.power(c.accountId, c.id, "on"); await f.settle(s, c, c => c.status === "running", 20);
  const resumes = f.api.requests.filter(r => r.method === "POST" && /\/(resume|start)$/.test(r.path));
  expect(resumes.length).toBeGreaterThanOrEqual(2);
  const secret = createSealer(SEAL).unseal(c.bootstrapSecret);
  for (const r of f.api.requests) expect(JSON.stringify(r.body ?? "")).not.toContain(secret);
  expect(f.api.requests.find(r => r.method === "POST" && r.path === "/v1/machines")!.body).toMatchObject({ vault: false, secrets: [] });
});
