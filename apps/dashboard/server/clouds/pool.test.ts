import { expect, it } from "vitest";
import { createFakePoolDriver } from "./fake-pool-driver.ts";
import { createPoolProvider, PoolFullError } from "./pool.ts";
import type { PoolHost, SlotQuota } from "./types.ts";

const quota: SlotQuota = { vcpu: 2, ramGb: 4, diskGb: 20, netMbps: 100, pids: 1000, botComputers: 1 };
function host(id: string, ramGb = 8, extra: Partial<PoolHost> = {}): PoolHost { return { id, region: "eu", domain: `${id}.example.test`, draining: false, capacity: { vcpu: 4, ramGb, diskGb: 100, slots: 10 }, ...extra }; }
const input = (id: number, region = "eu", q = quota) => ({ cloudId: `c${id.toString(16).padStart(24, "0")}`, region, spec: { vcpu: q.vcpu, ramGb: q.ramGb, diskGb: q.diskGb }, quota: q, userData: JSON.stringify({ env: {} }) });
it("chooses best RAM fit, breaks ties by id, filters region and draining hosts, and preserves the slot origin", async () => {
  const driver = createFakePoolDriver({ hosts: [host("large", 32), host("b"), host("a"), host("other", 4, { region: "us" }), host("drain", 4, { draining: true })] });
  const provider = createPoolProvider({ driver });
  const server = await provider.create(input(1));
  expect(server.id).toMatch(/^a:/); expect(server.origin).toBe(`https://${input(1).cloudId}.a.example.test`);
  expect((await provider.create(input(1))).id).toBe(server.id);
  expect(driver.calls.filter(c => c.method === "createSlot")).toHaveLength(1);
  const call = driver.calls.find(c => c.method === "createSlot")!;
  expect(JSON.parse((call.input as { bootstrap: string }).bootstrap).env.MADANI_PUBLIC_URL).toBe(server.origin);
  expect((await provider.create(input(2, "us"))).id).toMatch(/^other:/);
});
it("scales CPU, RAM and disk capacity independently and counts stopped slots", async () => {
  const driver = createFakePoolDriver({ hosts: [host("one", 4, { capacity: { vcpu: 2, ramGb: 4, diskGb: 20, slots: 3 } })] });
  const provider = createPoolProvider({ driver, cpuOvercommit: 2, ramOvercommit: 2, diskOvercommit: 2 });
  const first = await provider.create(input(1)); await provider.power(first.id, "off"); await provider.create(input(2));
  const row = (await provider.capacity())[0];
  expect(row.used).toEqual({ vcpu: 4, ramGb: 8, diskGb: 40, slots: 2 });
  expect(row.free).toEqual({ vcpu: 0, ramGb: 0, diskGb: 0, slots: 1 });
  await expect(provider.create(input(3))).rejects.toBeInstanceOf(PoolFullError);
});
it("serializes ten simultaneous placements without overbooking", async () => {
  const driver = createFakePoolDriver({ hosts: [host("a"), host("b")] }), provider = createPoolProvider({ driver });
  const results = await Promise.allSettled(Array.from({ length: 10 }, (_, n) => provider.create(input(n + 1))));
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(4);
  expect(results.filter(r => r.status === "rejected").every(r => r.status === "rejected" && r.reason instanceof PoolFullError)).toBe(true);
  for (const row of await provider.capacity()) expect(row.free.ramGb).toBe(0);
});
it("refuses quota growth on a full host, applies live limits and supports suspend, resume and deletion", async () => {
  const driver = createFakePoolDriver({ hosts: [host("a")] }), provider = createPoolProvider({ driver });
  const first = await provider.create(input(1)), second = await provider.create(input(2));
  await expect(provider.resize(first.id, { vcpu: 2, ramGb: 5, diskGb: 20 })).rejects.toBeInstanceOf(PoolFullError);
  await provider.destroy(second.id);
  const next = { ...quota, ramGb: 6, netMbps: 200, pids: 2000, botComputers: 2 };
  await provider.resize(first.id, next, next);
  expect((await driver.slots("a"))[0].quota).toEqual(next);
  await provider.suspend(first.id, "abuse"); expect((await provider.status(first.id)).state).toBe("off");
  await expect(provider.power(first.id, "on")).rejects.toThrow();
  await provider.resume(first.id); expect((await provider.status(first.id)).state).toBe("running");
  await provider.destroy(first.id); expect((await provider.status(first.id)).state).toBe("missing");
  await expect(provider.create(input(3, "missing"))).rejects.toBeInstanceOf(PoolFullError);
});
it("reserves slot count even with room in every resource dimension and recovers after driver failures", async () => {
  const driver = createFakePoolDriver({ hosts: [host("a", 100, { capacity: { vcpu: 100, ramGb: 100, diskGb: 1000, slots: 1 } })] });
  const provider = createPoolProvider({ driver }); driver.failNext = "createSlot";
  await expect(provider.create(input(1))).rejects.toMatchObject({ retryable: true });
  await provider.create(input(1)); await expect(provider.create(input(2))).rejects.toBeInstanceOf(PoolFullError);
});
