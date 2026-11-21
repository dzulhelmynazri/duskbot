import { CLOUD_HOME } from "../../../electron/legacy-names.mjs";
// the lifecycle tests' fake provider, billing and home, shared by the backend's test files
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, vi } from "vitest";
import type { StoredSubscription } from "../../dashboard/server/billing/store.ts";
import { startFakeInstaboxApi } from "./fake-instabox-api.ts";
import { createInstaboxProvider } from "./instabox.ts";
import { createAudit } from "./audit.ts";
import { createBackupStore } from "./backups.ts";
import { DEFAULT_MANAGED_SETTINGS, type ManagedSettings } from "./lifecycle.ts";
import type { ReleaseKey } from "./release-signing.ts";
import type { ProviderCostProfile } from "./power/cost.ts";
import type { HomeRelease } from "./home-update.ts";
import type { PolicySource } from "./update-policy.ts";
import type { HomeUpdateReport } from "../../dashboard/server/clouds/types.ts";
import { DAY_MS, entitlementOf } from "./retention.ts";
import { createFakeCloudProvider } from "../../dashboard/server/clouds/fake-provider.ts";
import { createSealer } from "../../dashboard/server/clouds/seal.ts";
import { createManagedCloud } from "./index.ts";
import { createCloudsService } from "../../dashboard/server/clouds/service.ts";
import type { DesktopPlan, HomePower, StoredCloud } from "../../dashboard/server/clouds/types.ts";

export const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
export const plan: DesktopPlan = { kind: "shared_s", placement: "pool", spec: { vcpu: 2, ramGb: 4, diskGb: 20 }, botComputers: 2 };
export const SHA = "a".repeat(64);
export const BACKUP_SECRET = Buffer.alloc(32, 9);

export async function homeFixture(options: { costProfile?: ProviderCostProfile; retentionDays?: number; setupPolls?: number; settings?: Partial<ManagedSettings>; releaseKeys?: ReleaseKey[]; edgeToken?: string;
  entitlements?: { sign(cloud: StoredCloud): string }; release?: () => HomeRelease | null; updatePolicy?: PolicySource } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "madani-home-")); cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  let at = Date.UTC(2026, 10, 9, 12);
  const now = () => at;
  const api = await startFakeInstaboxApi({ now, setupPolls: options.setupPolls }); cleanup.push(() => api.close());
  // the machine: the launcher marks its volume on first start, a bot writes data
  api.onExec(({ machine, cmd }) => {
    if (cmd.includes("omb-home rollback")) return { exitCode: 0, stdout: "rolled back\n" };
    if (cmd.includes("omb-home start") && !machine.volume.size) {
      machine.volume.set("data/.omb-cloud-home.json", Buffer.from(JSON.stringify({ version: 1, machine: machine.metadata["omb.cloud"] })));
      machine.volume.set(`data/${CLOUD_HOME.dataName}/bots.json`, Buffer.from(JSON.stringify([{ id: "bot-1", name: "Test bot" }])));
    }
    return null;
  });
  const provider = createInstaboxProvider({ apiKey: api.key, baseUrl: api.baseUrl, scope: "0123456789abcdef", pollMs: 1, settleMs: 5_000, now });
  const power: HomePower = { idle: false, busy: ["recent-activity"], lastActivityAt: null, nextDueAt: null, wokeAt: at };
  const update: HomeUpdateReport = { version: null, selfTest: null, runs: [] };
  const home = { update: vi.fn(async () => ({ ...update, runs: [...update.runs] })), healthy: vi.fn(async () => true), pair: vi.fn(async () => ({ code: "ABCD-EFGH-JKLM", expiresAt: at + 300_000 })),
    power: vi.fn(async () => ({ ...power })), entitle: vi.fn(async (_origin: string, _secret: string, _token: string) => ({ expiresAt: at + DAY_MS })), sleep: vi.fn(async () => ({ ok: power.idle, nextDueAt: power.nextDueAt })), plan: vi.fn(async () => {}) };
  const subscriptions: StoredSubscription[] = [];
  const notices: Array<{ cloudId: string; kind: string; at: number | null; link?: string }> = [];
  const alerts: string[] = [];
  const audit = createAudit({ dataDir, now, alert: entry => alerts.push(`${entry.action}:${entry.reason}`) });
  const backups = createBackupStore({ dir: join(dataDir, "managed-backups"), now });
  const workspaces = { register: vi.fn(() => "workspace-1"), lastReportAt: vi.fn(() => null), remove: vi.fn() };
  const service = createCloudsService({ dataDir, now, home, ...(options.entitlements ? { entitlements: options.entitlements } : {}), sealer: createSealer(Buffer.alloc(32, 7)), workspaces,
    providers: { dedicated: createFakeCloudProvider(), pool: { ...createFakeCloudProvider(), suspend: async () => {}, resume: async () => {} } },
    config: { adminOrigin: "https://admin.example.test", dashboardUrl: "https://dash.example.test", image: "ghcr.io/example/home:1", poolQuota: (_k, spec, botComputers) => ({ ...spec, netMbps: 1, pids: 1, botComputers }) },
    managed: createManagedCloud({ provider, backups, audit, kinds: ["shared_s", "shared_m", "dedicated"], backupSecret: BACKUP_SECRET,
      settings: { ...DEFAULT_MANAGED_SETTINGS, package: { sha256: SHA, url: "https://packages.example.test/home.tgz" }, ...(options.retentionDays ? { retentionDays: options.retentionDays } : {}), ...options.settings },
      ...(options.releaseKeys ? { releaseKeys: options.releaseKeys } : {}), ...(options.edgeToken ? { edgeToken: options.edgeToken } : {}),
      ...(options.costProfile ? { costProfile: options.costProfile } : {}), ...(options.release ? { release: options.release } : {}), ...(options.updatePolicy ? { updatePolicy: options.updatePolicy } : {}),
      entitlement: cloud => entitlementOf(subscriptions, cloud, at),
      notify: (cloud, kind, when, link) => notices.push({ cloudId: cloud.id, kind, at: when, ...(link ? { link } : {}) }) }) });
  cleanup.push(() => service.close());
  function subscribe(c: StoredCloud) {
    const sub = { id: `sub_${c.id}`, accountId: c.accountId, cloudId: c.id, status: "active", currentPeriodEnd: at + 30 * DAY_MS, currentPeriodStart: at, updatedAt: at, lastEventAt: at } as unknown as StoredSubscription;
    subscriptions.push(sub); return sub;
  }
  async function paid(accountId = "acct_1") {
    const c = service.order({ ...plan, accountId, name: "My Cloud", color: null, region: "eu" });
    const sub = subscribe(c);
    service.activate(c.id, sub.id, plan);
    for (let n = 0; n < 20 && c.status === "provisioning"; n++) { await service.reconcile(); c.nextAttemptAt = 0; }
    return { c, sub };
  }
  /** reconciles until `until` holds; `stepMs` lets time pass between passes (the power policy decides as time goes by) */
  async function settle(c: StoredCloud, until: (c: StoredCloud) => boolean, max = 20, stepMs = 0) {
    for (let n = 0; n < max && !until(c); n++) { c.nextAttemptAt = 0; await service.reconcile(); if (!until(c)) at += stepMs; }
    expect(until(c)).toBe(true);
  }
  /** an idle home, left alone until the policy puts it to sleep (at most five hours) */
  async function asleep(c: StoredCloud) {
    power.idle = true; power.busy = [];
    await settle(c, x => x.status === "sleeping", 60, 5 * 60_000);
  }
  return { api, provider, service, home, power, update, subscriptions, notices, alerts, audit, backups, dataDir, paid, settle, asleep, workspaces,
    advance(ms: number) { at += ms; }, now };
}

