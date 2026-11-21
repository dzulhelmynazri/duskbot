import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { DesktopPlan } from "./types.ts";
import { AI_STASH_TTL_MS, createAiStash, memoryAiStashStore, parseAiSignIns } from "./ai-stash.ts";
import { createFakeCloudProvider } from "./fake-provider.ts";
import { createFakePoolDriver } from "./fake-pool-driver.ts";
import { createPoolProvider } from "./pool.ts";
import { createSealer } from "./seal.ts";
import { CloudError, createCloudsService } from "./service.ts";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
const plan: DesktopPlan = { kind: "dedicated", placement: "dedicated", spec: { vcpu: 2, ramGb: 4, diskGb: 40 }, botComputers: null };
const auth = JSON.stringify({ tokens: { access_token: "codex-secret-token" } });

function fixture(sealKey: Buffer | null = Buffer.alloc(32, 7)) {
  const dataDir = mkdtempSync(join(tmpdir(), "madani-ai-stash-")); cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  let at = 1_790_000_000_000;
  const now = () => at;
  const store = memoryAiStashStore(now), sealer = createSealer(sealKey);
  const put = vi.spyOn(store, "put");
  const aiStash = createAiStash({ store, sealer, now });
  const driver = createFakePoolDriver({ hosts: [{ id: "pool1", region: "eu", domain: "pool.example.test", draining: false, capacity: { vcpu: 16, ramGb: 32, diskGb: 200, slots: 10 } }] });
  const home = { healthy: vi.fn(async () => true), pair: vi.fn(), signIns: vi.fn(async () => {}) };
  const service = createCloudsService({ dataDir, aiStash, providers: { dedicated: createFakeCloudProvider(), pool: createPoolProvider({ driver }) },
    workspaces: { register: () => "workspace-1", lastReportAt: () => null, remove: () => {} }, home, sealer,
    config: { adminOrigin: "https://admin.example.test", dashboardUrl: "https://dash.example.test", image: "ghcr.io/example/madanibot-cloud-home:1.2.3", poolQuota: (_k, spec, botComputers) => ({ ...spec, netMbps: 100, pids: 1000, botComputers }) }, now });
  cleanup.push(() => service.close());
  const order = (accountId = "a") => service.order({ ...plan, accountId, name: "My desktop", color: "blue", region: "eu" });
  return { service, store, put, home, order, advance: (ms: number) => { at += ms; } };
}

it("takes only a ChatGPT login that is a JSON object, once, within its size", () => {
  expect(parseAiSignIns([{ kind: "codex-auth", auth }])).toEqual([{ kind: "codex-auth", auth }]);
  expect(parseAiSignIns([])).toBeNull();
  expect(parseAiSignIns([{ kind: "codex-auth", auth: "not json" }])).toBeNull();
  expect(parseAiSignIns([{ kind: "claude-token", auth: "sk-ant-oat01-x" }]), "a Claude sign-in is never held").toBeNull();
  expect(parseAiSignIns([{ kind: "codex-auth", auth }, { kind: "codex-auth", auth }])).toBeNull();
  expect(parseAiSignIns([{ kind: "codex-auth", auth: JSON.stringify({ x: "y".repeat(40_000) }) }])).toBeNull();
});

it("holds a sign-in sealed while the Cloud is made, hands it to the Cloud once it runs, then deletes it", async () => {
  const f = fixture(), c = f.order();
  f.service.activate(c.id, "sub1", plan);
  await f.service.holdSignIns!("a", c.id, [{ kind: "codex-auth", auth }]);
  const stored = f.put.mock.calls[0]![0];
  expect(stored.sealed).not.toContain("codex-secret-token");
  expect(stored.expiresAt).toBe(1_790_000_000_000 + AI_STASH_TTL_MS);
  for (let n = 0; n < 20 && c.status === "provisioning"; n++) await f.service.reconcile();
  expect(c.status).toBe("running");
  await f.service.reconcile();
  expect(f.home.signIns).toHaveBeenCalledExactlyOnceWith(c.origin, expect.any(String), [{ kind: "codex-auth", auth }]);
  expect(await f.store.pending()).toEqual([]);
  await f.service.reconcile();
  expect(f.home.signIns, "delivered once").toHaveBeenCalledOnce();
});

it("keeps it for another try when the Cloud can't take it yet", async () => {
  const f = fixture(), c = f.order();
  f.service.activate(c.id, "sub1", plan);
  await f.service.holdSignIns!("a", c.id, [{ kind: "codex-auth", auth }]);
  f.home.signIns.mockRejectedValueOnce(new Error("down"));
  for (let n = 0; n < 20 && c.status === "provisioning"; n++) await f.service.reconcile();
  expect(f.home.signIns).toHaveBeenCalledOnce();
  expect(await f.store.pending()).toEqual([c.id]);
  await f.service.reconcile();
  expect(await f.store.pending()).toEqual([]);
});

it("hands a Cloud on an older image the ChatGPT login alone when it refuses the kinds it doesn't know", async () => {
  const f = fixture(), c = f.order();
  f.service.activate(c.id, "sub1", plan);
  const grok = { kind: "grok-auth" as const, auth };
  await f.service.holdSignIns!("a", c.id, [{ kind: "codex-auth", auth }, grok]);
  f.home.signIns.mockRejectedValueOnce(Object.assign(new Error("refused"), { status: 400 }));
  for (let n = 0; n < 20 && c.status === "provisioning"; n++) await f.service.reconcile();
  await f.service.reconcile();
  expect(f.home.signIns.mock.calls.map(call => (call as unknown[])[2])).toEqual([[{ kind: "codex-auth", auth }, grok], [{ kind: "codex-auth", auth }]]);
  expect(await f.store.pending()).toEqual([]);
});

it("keeps a refused batch for another try when the refusal wasn't about the kinds", async () => {
  const f = fixture(), c = f.order();
  f.service.activate(c.id, "sub1", plan);
  await f.service.holdSignIns!("a", c.id, [{ kind: "codex-auth", auth }, { kind: "grok-auth", auth }]);
  f.home.signIns.mockRejectedValueOnce(Object.assign(new Error("down"), { status: 503 }));
  for (let n = 0; n < 20 && c.status === "provisioning"; n++) await f.service.reconcile();
  expect(f.home.signIns).toHaveBeenCalledOnce();
  expect(await f.store.pending()).toEqual([c.id]);
});

it("is refused for another account's Cloud, an ended one, or without a seal key, and expires after a day", async () => {
  const f = fixture(), c = f.order();
  await expect(f.service.holdSignIns!("b", c.id, [{ kind: "codex-auth", auth }])).rejects.toBeInstanceOf(CloudError);
  await f.service.holdSignIns!("a", c.id, [{ kind: "codex-auth", auth }]);
  f.advance(AI_STASH_TTL_MS + 1);
  expect(await f.store.pending()).toEqual([]);
  const unsealed = fixture(null), other = unsealed.order();
  await expect(unsealed.service.holdSignIns!("a", other.id, [{ kind: "codex-auth", auth }])).rejects.toMatchObject({ status: 503 });
  expect(unsealed.put).not.toHaveBeenCalled();
});

it("drops what is held when the checkout is abandoned or the owner cancels", async () => {
  const f = fixture(), c = f.order(), d = f.order();
  await f.service.holdSignIns!("a", c.id, [{ kind: "codex-auth", auth }]);
  await f.service.holdSignIns!("a", d.id, [{ kind: "codex-auth", auth }]);
  f.service.abandon(c.id);
  await f.service.dropSignIns!("a", d.id);
  await vi.waitFor(async () => expect(await f.store.pending()).toEqual([]));
  await expect(f.service.holdSignIns!("a", c.id, [{ kind: "codex-auth", auth }])).rejects.toMatchObject({ status: 409 });
});
