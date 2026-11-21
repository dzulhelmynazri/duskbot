import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileConnectionRecord } from "../../../shared/mobile-link";
import { webPlatform, type MobilePlatform, type TurnActivityBridge } from "../platform";
import { forgetCloudPlaces, removePlace, signOutPhone } from "./sign-out";
import { claimFreshInstall, INSTALLED_KEY } from "./install";

const CONNECTIONS = "madani.mobile.connections.v1";
const ACTIVE = "madani.mobile.active.v1";
const CLOUD_ORIGIN = "https://d0123456789abcdef0123.madani.bot";
const record = (id: string, extra: Partial<MobileConnectionRecord> = {}): MobileConnectionRecord => ({
  id, environmentId: `env-${id}`, label: id, transport: "https", sessionRef: `token.${id}`, deviceId: `device-${id}`,
  capabilities: {} as MobileConnectionRecord["capabilities"], addedAt: 1, lastUsedAt: 1, ...extra,
});
const cloud = record("cloud", { origin: CLOUD_ORIGIN, lastUsedAt: 30 });
const mac = record("mac", { transport: "relay", relay: { base: "wss://relay.example.test", channel: "mac-channel" }, lastUsedAt: 20 });
const box = record("box", { origin: "https://box.example.org", lastUsedAt: 10 });

let prefs: Map<string, string>, secrets: Map<string, string>, platform: MobilePlatform, fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
let ended: string[];
const save = (records: MobileConnectionRecord[], active: string) => {
  prefs.set(CONNECTIONS, JSON.stringify(records));
  prefs.set(ACTIVE, active);
  for (const one of records) {
    secrets.set(one.sessionRef, `session-${one.id}`);
    secrets.set(`relay.${one.id}`, "{}");
    prefs.set(`madani.mobile.push.${one.id}`, "{}");
    prefs.set(`madani.mobile.outbox.${one.id}`, "[]");
    prefs.set(`madani.account.enrolled.${one.id}`, "person");
  }
};
const saved = () => (JSON.parse(prefs.get(CONNECTIONS) ?? "[]") as MobileConnectionRecord[]).map((one) => one.id);
const leftFor = (id: string) => [secrets.has(`token.${id}`), secrets.has(`relay.${id}`), prefs.has(`madani.mobile.push.${id}`), prefs.has(`madani.mobile.outbox.${id}`), prefs.has(`madani.account.enrolled.${id}`)];

beforeEach(() => {
  prefs = new Map(); secrets = new Map(); ended = [];
  const activities: TurnActivityBridge = {
    start: async () => null, update: async () => {}, end: async (id) => { ended.push(id); },
    list: async () => [{ id: "turn-1", botId: "bot", threadId: "thread", startedAt: 1 }],
    onToken: () => () => {}, onStartToken: () => () => {}, lineKey: async () => null,
  };
  // each test gets its own platform object: the connection store is kept per platform
  platform = { ...webPlatform(), native: true, kind: "ios", turnActivity: activities,
    prefs: { get: async (key) => prefs.get(key) ?? null, set: async (key, value) => { prefs.set(key, value); }, remove: async (key) => { prefs.delete(key); } },
    secrets: { get: async (key) => secrets.get(key) ?? null, set: async (key, value) => { secrets.set(key, value); }, remove: async (key) => { secrets.delete(key); } },
  };
  fetcher = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
});

describe("signing out on the phone", () => {
  it("with only a madani cloud: forgets it everywhere on the phone, revokes it there, ends the account and lands on the first screen", async () => {
    save([cloud], "cloud");
    const signOutAccount = vi.fn(async () => {});
    expect(await signOutPhone({ platform, signOutAccount, fetch: fetcher })).toBe("first-screen");
    expect(saved()).toEqual([]);
    expect(prefs.has(ACTIVE)).toBe(false);
    expect(leftFor("cloud")).toEqual([false, false, false, false, false]);
    expect(signOutAccount).toHaveBeenCalledOnce();
    expect(ended).toEqual(["turn-1"]);
    expect(fetcher).toHaveBeenCalledWith(`${CLOUD_ORIGIN}/api/mobile/devices/device-cloud`, expect.objectContaining({
      method: "DELETE", headers: { Authorization: "Bearer session-cloud" }, credentials: "omit", redirect: "error",
    }));
  });

  it("keeps computers paired with their own QR or code and opens the one used last", async () => {
    save([cloud, mac, box], "cloud");
    expect(await signOutPhone({ platform, signOutAccount: async () => {}, fetch: fetcher })).toBe("workspace");
    expect(saved()).toEqual(["mac", "box"]);
    expect(prefs.get(ACTIVE)).toBe("mac");
    expect(leftFor("mac")).toEqual([true, true, true, true, true]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("forgets the cloud on the phone even when the cloud can't be reached to revoke it", async () => {
    save([cloud], "cloud");
    fetcher.mockRejectedValue(new TypeError("offline"));
    expect(await signOutPhone({ platform, signOutAccount: async () => {}, fetch: fetcher })).toBe("first-screen");
    expect(saved()).toEqual([]);
    expect(secrets.has("token.cloud")).toBe(false);
  });

  it("never waits on a stuck account service to finish signing out on the phone", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      save([cloud], "cloud");
      const landing = signOutPhone({ platform, signOutAccount: () => new Promise(() => {}), fetch: fetcher });
      await vi.advanceTimersByTimeAsync(6_000);
      expect(await landing).toBe("first-screen");
    } finally { vi.useRealTimers(); }
  });

  it("a deleted account's clouds leave the phone the same way", async () => {
    save([cloud, box], "box");
    await forgetCloudPlaces(platform, fetcher);
    expect(saved()).toEqual(["box"]);
    expect(prefs.get(ACTIVE)).toBe("box");
  });
});

describe("two accounts, each with its own madani cloud", () => {
  const aliceCloud = record("alice-cloud", { origin: "https://d1111111111111111111a.madani.bot", account: { id: "alice", email: "alice@example.com" }, lastUsedAt: 30 });
  const bobCloud = record("bob-cloud", { origin: "https://d2222222222222222222b.madani.bot", account: { id: "bob", email: "bob@example.com" }, lastUsedAt: 20 });

  it("signing out of one takes only its cloud and opens the other account's", async () => {
    save([aliceCloud, bobCloud], "alice-cloud");
    expect(await signOutPhone({ platform, signOutAccount: async () => {}, signedOut: { account: "alice", othersStay: true }, fetch: fetcher })).toBe("workspace");
    expect(saved()).toEqual(["bob-cloud"]);
    expect(prefs.get(ACTIVE)).toBe("bob-cloud");
    expect(leftFor("bob-cloud")).toEqual([true, true, true, true, true]);
    expect(leftFor("alice-cloud")).toEqual([false, false, false, false, false]);
  });

  it("a cloud the phone linked before it knew whose it was leaves with the account that lists it, and no other", async () => {
    const untagged = record("old-cloud", { origin: "https://d3333333333333333333c.madani.bot", lastUsedAt: 40 });
    save([untagged, bobCloud], "old-cloud");
    await signOutPhone({ platform, signOutAccount: async () => {}, signedOut: { account: "bob", othersStay: true, listed: [] }, fetch: fetcher });
    expect(saved()).toEqual(["old-cloud"]);
    await signOutPhone({ platform, signOutAccount: async () => {}, signedOut: { account: "alice", othersStay: true, listed: [untagged.origin!] }, fetch: fetcher });
    expect(saved()).toEqual([]);
  });

  it("the last account to sign out takes every cloud with it", async () => {
    save([aliceCloud, bobCloud, mac], "alice-cloud");
    await signOutPhone({ platform, signOutAccount: async () => {}, signedOut: { account: "alice", othersStay: false }, fetch: fetcher });
    expect(saved()).toEqual(["mac"]);
  });
});

describe("removing this computer", () => {
  it("ends the pairing there and here, and opens what is left", async () => {
    save([box, mac], "box");
    expect(await removePlace(platform, "box", fetcher)).toBe("workspace");
    expect(fetcher).toHaveBeenCalledWith("https://box.example.org/api/mobile/devices/device-box", expect.objectContaining({ method: "DELETE" }));
    expect(saved()).toEqual(["mac"]);
    expect(prefs.get(ACTIVE)).toBe("mac");
    expect(leftFor("box")).toEqual([false, false, false, false, false]);
  });

  it("the last one leaves the phone on its first screen", async () => {
    save([mac], "mac");
    expect(await removePlace(platform, "mac", fetcher)).toBe("first-screen");
    expect(fetcher, "a relay-only computer has no address to ask").not.toHaveBeenCalled();
    expect(saved()).toEqual([]);
  });
});

describe("a new install", () => {
  it("is claimed once: the first launch with no places, never again", async () => {
    expect(await claimFreshInstall(platform)).toBe(true);
    expect(prefs.get(INSTALLED_KEY)).toBe("1");
    expect(await claimFreshInstall({ ...platform })).toBe(false);
  });

  it("an update from a build without the marker keeps its places and is not one", async () => {
    save([box], "box");
    expect(await claimFreshInstall(platform)).toBe(false);
    expect(prefs.get(INSTALLED_KEY)).toBe("1");
  });
});
