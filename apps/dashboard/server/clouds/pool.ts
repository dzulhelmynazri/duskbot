import type { CloudProvider, PoolHost, PoolHostDriver, ProviderServer, SlotQuota, SlotState } from "./types.ts";
import { RetryableCloudError } from "./http.ts";

export class PoolFullError extends RetryableCloudError {
  constructor() { super("Cloud pool is full."); this.name = "PoolFullError"; }
}

type Capacity = PoolHost["capacity"];
export function createPoolProvider(options: { driver: PoolHostDriver; cpuOvercommit?: number; ramOvercommit?: number; diskOvercommit?: number; now?: () => number }) {
  const { driver } = options;
  const factors = { vcpu: options.cpuOvercommit ?? 2, ramGb: options.ramOvercommit ?? 1, diskGb: options.diskOvercommit ?? 1, slots: 1 };
  if (Object.values(factors).some(v => !Number.isFinite(v) || v <= 0)) throw new Error("Invalid pool overcommit.");
  let pending = Promise.resolve();
  function serialized<T>(fn: () => Promise<T>): Promise<T> { const result = pending.then(fn); pending = result.then(() => {}, () => {}); return result; }
  const encode = (slot: SlotState) => `${encodeURIComponent(slot.hostId)}:${encodeURIComponent(slot.id)}`;
  function decode(id: string): [string, string] {
    const parts = id.split(":");
    if (parts.length !== 2) throw new Error("Invalid pool server id.");
    return [decodeURIComponent(parts[0]), decodeURIComponent(parts[1])];
  }
  async function capacity() {
    const hosts = await driver.hosts();
    return Promise.all(hosts.map(async host => {
      const slots = (await driver.slots(host.id)).filter(s => s.state !== "missing");
      const used: Capacity = { vcpu: 0, ramGb: 0, diskGb: 0, slots: slots.length };
      for (const slot of slots) for (const key of ["vcpu", "ramGb", "diskGb"] as const) used[key] += slot.quota[key];
      const free = { ...used };
      for (const key of ["vcpu", "ramGb", "diskGb", "slots"] as const) free[key] = host.capacity[key] * factors[key] - used[key];
      return { host, used, free };
    }));
  }
  function validate(quota: SlotQuota) {
    if ([quota.vcpu, quota.ramGb, quota.diskGb, quota.netMbps, quota.pids].some(v => !Number.isFinite(v) || v <= 0) || (quota.botComputers !== null && (!Number.isSafeInteger(quota.botComputers) || quota.botComputers < 0))) throw new Error("Invalid pool quota.");
  }
  function fits(free: Capacity, quota: SlotQuota) { return free.slots >= 1 && free.vcpu >= quota.vcpu && free.ramGb >= quota.ramGb && free.diskGb >= quota.diskGb; }
  async function server(slot: SlotState, cloudId?: string): Promise<ProviderServer> {
    const host = (await driver.hosts()).find(h => h.id === slot.hostId);
    if (!host) throw new Error("Missing pool host.");
    const id = cloudId ?? slot.cloudId;
    return { id: encode(slot), state: slot.state === "suspended" ? "off" : slot.state, ipv4: null, serverType: "pool", diskGb: slot.quota.diskGb, ...(id ? { origin: `https://${id}.${host.domain}` } : {}) };
  }
  const cloudIds = new Map<string, string>();
  const provider = {
    name: "pool" as const, capacity,
    async find(cloudId: string) { const slot = await driver.findSlot(cloudId); if (!slot) return null; cloudIds.set(encode(slot), cloudId); return server(slot, cloudId); },
    async create(input: Parameters<CloudProvider["create"]>[0]): Promise<ProviderServer> {
      return serialized(async () => {
        const existing = await provider.find(input.cloudId); if (existing) return existing;
        const quota = input.quota; if (!quota) throw new Error("Pool quota required."); validate(quota);
        const hosts = (await capacity()).filter(h => h.host.region === input.region && !h.host.draining && fits(h.free, quota));
        hosts.sort((a, b) => (a.free.ramGb - quota.ramGb) - (b.free.ramGb - quota.ramGb) || a.host.id.localeCompare(b.host.id));
        if (!hosts.length) throw new PoolFullError();
        const host = hosts[0].host;
        const bootstrap = JSON.parse(input.userData) as { env: Record<string, string> };
        bootstrap.env.MADANI_PUBLIC_URL = `https://${input.cloudId}.${host.domain}`;
        const slot = await driver.createSlot(host.id, { cloudId: input.cloudId, quota, bootstrap: JSON.stringify(bootstrap) });
        cloudIds.set(encode(slot), input.cloudId); return server(slot, input.cloudId);
      });
    },
    async status(id: string) { const [hostId, slotId] = decode(id), slot = await driver.slot(hostId, slotId); return slot ? server(slot, cloudIds.get(id)) : { id, state: "missing" as const, ipv4: null, serverType: "pool", diskGb: 0 }; },
    async power(id: string, action: "on" | "off") { await driver.power(...decode(id), action); },
    async resize(id: string, spec: Parameters<CloudProvider["resize"]>[1], quota?: SlotQuota) {
      await serialized(async () => {
        const [hostId, slotId] = decode(id), slot = await driver.slot(hostId, slotId);
        if (!slot) throw new Error("Missing pool slot.");
        const next = quota ?? { ...slot.quota, ...spec }; validate(next);
        const row = (await capacity()).find(h => h.host.id === hostId);
        if (!row || !fits({ vcpu: row.free.vcpu + slot.quota.vcpu, ramGb: row.free.ramGb + slot.quota.ramGb, diskGb: row.free.diskGb + slot.quota.diskGb, slots: row.free.slots + 1 }, next)) throw new PoolFullError();
        await driver.setQuota(hostId, slotId, next);
      });
    },
    async destroy(id: string) { await serialized(() => driver.destroySlot(...decode(id))); cloudIds.delete(id); },
    async suspend(id: string, reason: string) { await driver.suspend(...decode(id), reason); },
    async resume(id: string) { await driver.resume(...decode(id)); },
  } satisfies CloudProvider & { capacity: typeof capacity; suspend(id: string, reason: string): Promise<void>; resume(id: string): Promise<void> };
  return provider;
}
