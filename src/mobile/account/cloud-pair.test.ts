import { describe, expect, it, vi } from "vitest";
import type { CloudPairResult, MobileCloud } from "./account-client";
import { cloudPairing, cloudPairingPayload } from "./cloud-pair";

const cloud: MobileCloud = { id: "c1", name: "Studio", status: "ready", origin: "https://d1.madani.bot", primary: true, asleep: true };
const grant = { origin: "https://d1.madani.bot", code: "ABCD-EFGH-JKLM", expiresAt: Date.now() + 300_000 };
const answers = (...results: CloudPairResult[]) => { const pairCloud = vi.fn<(c: MobileCloud) => Promise<CloudPairResult>>(); for (const r of results) pairCloud.mockResolvedValueOnce(r); return pairCloud; };

describe("cloudPairing", () => {
  it("pairs at once with a running cloud", async () => {
    const account = { pairCloud: answers({ outcome: "paired", grant }), wakeCloud: vi.fn(async () => true) };
    expect(await cloudPairing(account, cloud)).toEqual({ outcome: "paired", grant });
    expect(account.wakeCloud).not.toHaveBeenCalled();
  });
  it("wakes an asleep cloud and asks again until it answers", async () => {
    const onWaking = vi.fn(), wait = vi.fn(async () => {});
    const account = { pairCloud: answers({ outcome: "asleep" }, { outcome: "asleep" }, { outcome: "paired", grant }), wakeCloud: vi.fn(async () => true) };
    expect(await cloudPairing(account, cloud, { onWaking, wait })).toEqual({ outcome: "paired", grant });
    expect(onWaking).toHaveBeenCalledOnce(); expect(account.wakeCloud).toHaveBeenCalledOnce(); expect(wait).toHaveBeenCalledTimes(2);
  });
  it("gives up after its tries, and stops at once when the wake is refused", async () => {
    const asleep = { outcome: "asleep" } as const;
    const stillAsleep = { pairCloud: vi.fn(async () => asleep as CloudPairResult), wakeCloud: vi.fn(async () => true) };
    expect(await cloudPairing(stillAsleep, cloud, { wait: async () => {}, tries: 3 })).toEqual(asleep);
    expect(stillAsleep.pairCloud).toHaveBeenCalledTimes(4);
    const refused = { pairCloud: vi.fn(async () => asleep as CloudPairResult), wakeCloud: vi.fn(async () => false) };
    expect(await cloudPairing(refused, cloud, { wait: async () => {} })).toEqual(asleep);
    expect(refused.pairCloud).toHaveBeenCalledOnce();
  });
  it("never wakes the primary cloud for another one that sleeps", async () => {
    const account = { pairCloud: answers({ outcome: "asleep" }), wakeCloud: vi.fn(async () => true) };
    expect(await cloudPairing(account, { ...cloud, id: "c2", primary: false }, { wait: async () => {} })).toEqual({ outcome: "asleep" });
    expect(account.wakeCloud).not.toHaveBeenCalled();
    expect(account.pairCloud).toHaveBeenCalledOnce();
  });
  it("hands the existing pairing path the code without its dashes", () => {
    expect(cloudPairingPayload(cloud, grant)).toEqual({ v: 1, transport: "https", origin: grant.origin, credential: "", code: "ABCDEFGHJKLM", name: "Studio", expiresAt: grant.expiresAt });
  });
});
