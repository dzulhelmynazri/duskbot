import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVpsLifecycleHost } from "./vps-lifecycle-host.ts";
import { createVpsLifecycleStore } from "./vps-lifecycle-store.ts";
import type { VpsComputerStatus } from "./vps-computer.ts";
import type { VpsLifecycleState } from "./vps-lifecycle.ts";

const environment = "11111111-1111-4111-8111-111111111111";
const target = { ownerId: "fixture-bot", sshAlias: "fixture-vps", containerId: "a".repeat(64), startedAt: "2026-11-07T00:00:00.1Z" };
const folders: string[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-07T08:00:00Z")); });
afterEach(() => { vi.useRealTimers(); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

async function fixture(state?: VpsLifecycleState) {
  const folder = mkdtempSync(join(tmpdir(), "madani-lifecycle-host-")); folders.push(folder);
  const file = join(folder, "state.json");
  if (state) createVpsLifecycleStore(file, environment).save(state);
  let reserved = false;
  const status = { daemonUp: true, managed: true, ready: true, container: "running", container_id: target.containerId, container_started_at: "2026-11-07T00:00:00.100000000Z" } as VpsComputerStatus;
  const deps = {
    file, environmentId: environment,
    policy: () => ({ browserIdleMinutes: 1, screenIdleMinutes: 2, computerIdleMinutes: 3 }),
    allowed: vi.fn(() => true),
    busy: vi.fn((_stage: unknown, _target: unknown, own: boolean) => reserved && !own),
    reserve: vi.fn(() => { reserved = true; return () => { reserved = false; }; }),
    inspect: vi.fn(async () => status), observe: vi.fn(async () => {}), checkScreen: vi.fn(async () => true), adoptScreen: vi.fn(),
    withIdleScreen: vi.fn(async (_target: unknown, action: (idle: () => boolean) => Promise<void>) => { await action(() => true); return true; }),
    closeBrowser: vi.fn(async (_target: unknown, allowed: () => boolean) => { expect(allowed()).toBe(true); }),
    closeScreen: vi.fn(async () => true), stopComputer: vi.fn(async () => {}), completed: vi.fn(), failed: vi.fn(),
  };
  const host = createVpsLifecycleHost(deps);
  await host.ready;
  return { host, deps, status, state: () => JSON.parse(readFileSync(file, "utf8")) as VpsLifecycleState };
}

function observe(host: Awaited<ReturnType<typeof fixture>>["host"]) { host.observeScreen(target, { botId: target.ownerId }); }

describe("durable lifecycle host fences", () => {
  it("normalizes nanosecond receipts and rechecks its own lifecycle reservation before closing", async () => {
    const f = await fixture();
    try {
      observe(f.host);
      await vi.advanceTimersByTimeAsync(60_001);
      expect(f.deps.closeBrowser).toHaveBeenCalledOnce();
      expect(f.deps.closeBrowser.mock.calls[0]![0]).toMatchObject(target);
      expect(f.deps.reserve).toHaveBeenCalledOnce();
      expect(f.deps.failed).not.toHaveBeenCalled();
    } finally { await f.host.close(); }
  });
  it("refuses an identity replacement discovered during fresh inspection", async () => {
    const f = await fixture(); f.status.container_id = "b".repeat(64);
    try { observe(f.host); await vi.advanceTimersByTimeAsync(60_001); expect(f.deps.closeBrowser).not.toHaveBeenCalled(); expect(f.deps.stopComputer).not.toHaveBeenCalled(); }
    finally { await f.host.close(); }
  });
  it("retains durable records and retries transport failures instead of treating a missing response as a removed container", async () => {
    const f = await fixture(); Object.assign(f.status, { daemonUp: false, container_id: null, problem: "fixture SSH unavailable" });
    try {
      observe(f.host); await vi.advanceTimersByTimeAsync(60_001); await f.host.flush();
      expect(f.deps.closeBrowser).not.toHaveBeenCalled();
      expect(f.deps.failed).toHaveBeenCalledOnce();
      expect(f.state().entries.find(entry => entry.target.botId)?.failures).toBe(1);
    } finally { await f.host.close(); }
  });
  it("cancels a due close when real activity arrives during fresh inspection", async () => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.deps.inspect.mockImplementation(async () => { await gate; return f.status; });
    try {
      observe(f.host); await vi.advanceTimersByTimeAsync(60_001);
      expect(f.deps.inspect).toHaveBeenCalledOnce();
      f.host.activity(target, { botId: target.ownerId }); release();
      await vi.advanceTimersByTimeAsync(1);
      expect(f.deps.closeBrowser).not.toHaveBeenCalled();
      expect(f.deps.stopComputer).not.toHaveBeenCalled();
    } finally { release(); await f.host.close(); }
  });
  it("reactivates saved idle deadlines only after fresh reconciliation and never starts a computer", async () => {
    const lastActivityAt = Date.now() - 4 * 60_000;
    const record = { target, lastActivityAt, epoch: 1, completed: [], failures: 0 };
    const f = await fixture({ version: 1, entries: [record, { ...record, target: { ...target, botId: target.ownerId } }] });
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.deps.inspect).not.toHaveBeenCalled();
      await f.host.reconcile(); await vi.advanceTimersByTimeAsync(1);
      expect(f.deps.inspect).toHaveBeenCalled();
      expect(f.deps.observe).toHaveBeenCalledWith(target);
      expect(f.deps.stopComputer).toHaveBeenCalledOnce();
      expect(f.state().entries.every(entry => entry.lastActivityAt === lastActivityAt)).toBe(true);
    } finally { await f.host.close(); }
  });
});
