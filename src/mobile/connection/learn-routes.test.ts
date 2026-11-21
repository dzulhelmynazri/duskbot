import { describe, expect, it, vi } from "vitest";
import type { MobileConnectionRecord, MobileTransport } from "../../../shared/mobile-link";
import type { RelayChannel } from "../transport/relay";
import { learnRoutes, mergedRoutes } from "./learn-routes";

const relayRoute: MobileTransport = { kind: "relay", base: "https://link.madani.bot", channel: "abcdefghij", token: "t".repeat(43), key: "k".repeat(43) };
const oldWifi: MobileTransport = { kind: "companion", url: "http://192.168.1.4:8810", net: "lan", priority: 200 };
const record = (via: MobileTransport[]): MobileConnectionRecord => ({
  id: "mac", environmentId: "env", label: "Mac", transport: "relay", via, sessionRef: "token.mac",
  capabilities: {} as MobileConnectionRecord["capabilities"], addedAt: 1, lastUsedAt: 1,
});
const onRelay = { kind: "relay" as const, channel: {} as RelayChannel, token: "s" };

describe("a phone learning where its place is now", () => {
  it("takes the computer's new Wi-Fi address and a new https address, keeping its relay", () => {
    const via = mergedRoutes(record([relayRoute, oldWifi]), {
      https: [{ kind: "https", url: "https://box.example.com" }],
      companion: [{ kind: "companion", url: "http://192.168.1.9:8810", net: "lan", priority: 200 }],
    }, onRelay);
    expect(via).toEqual([{ kind: "https", url: "https://box.example.com" }, relayRoute, { kind: "companion", url: "http://192.168.1.9:8810", net: "lan", priority: 200 }]);
  });

  it("keeps its Wi-Fi addresses when the computer did not say, and changes nothing when nothing moved", () => {
    expect(mergedRoutes(record([relayRoute, oldWifi]), { https: [], companion: null }, onRelay)).toBeNull();
  });

  it("never drops the route it just connected over", () => {
    const via = mergedRoutes(record([oldWifi]), { https: [], companion: [] }, { kind: "bearer", origin: oldWifi.url, token: "s" });
    expect(via).toBeNull();
    const cloud = { ...record([]), via: undefined, transport: "https" as const, origin: "https://d1.madani.bot" };
    expect(mergedRoutes(cloud, { https: [], companion: null }, { kind: "bearer", origin: "https://d1.madani.bot", token: "s" })).toBeNull();
  });

  it("saves what the place says, and an older place without the route keeps what is saved", async () => {
    const save = vi.fn(async () => {});
    const answer = { https: [{ kind: "https", url: "https://box.example.com" }], companion: null };
    await learnRoutes(record([relayRoute]), onRelay, save, (async () => new Response(JSON.stringify(answer))) as typeof fetch);
    expect(save).toHaveBeenCalledWith("mac", [answer.https[0], relayRoute]);
    save.mockClear();
    await learnRoutes(record([relayRoute]), onRelay, save, (async () => new Response("{}", { status: 404 })) as typeof fetch);
    await learnRoutes(record([relayRoute]), onRelay, save, (async () => { throw new TypeError("offline"); }) as typeof fetch);
    await learnRoutes(record([relayRoute]), { ...onRelay, asleep: true }, save, (async () => new Response(JSON.stringify(answer))) as typeof fetch);
    expect(save).not.toHaveBeenCalled();
  });
});

describe("a pairing without a working relay channel", () => {
  const wifi = { kind: "bearer" as const, origin: oldWifi.url, token: "s" };
  const keys = async () => ({ pub: "P".repeat(43), priv: "x", token: "phone-token" });
  const channel = { base: "https://link.madani.bot", channel: "bcdefghijk", agentPub: "A".repeat(43) };

  it("asks the place for one when it has a relay but none for this phone, and saves it beside the routes it had", async () => {
    const save = vi.fn(async () => {});
    const asked: Array<[string, RequestInit | undefined]> = [];
    const ask = (async (path: string, init?: RequestInit) => {
      asked.push([path, init]);
      return path === "/api/mobile/routes" ? new Response(JSON.stringify({ https: [], companion: null, relay: null })) : new Response(JSON.stringify(channel));
    }) as typeof fetch;
    await learnRoutes(record([oldWifi]), wifi, save, ask, keys);
    expect(asked.map(([path]) => path)).toEqual(["/api/mobile/routes", "/api/mobile/relay"]);
    expect(JSON.parse(String(asked[1][1]?.body))).toEqual({ pub: "P".repeat(43), verifier: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(save).toHaveBeenCalledWith("mac", [oldWifi], channel);
  });

  it("takes the channel the place serves now when it moved, and asks nothing when it is the same", async () => {
    const save = vi.fn(async () => {});
    const ask = (async () => new Response(JSON.stringify({ https: [], companion: null, relay: channel }))) as typeof fetch;
    await learnRoutes({ ...record([oldWifi]), relay: { base: channel.base, channel: channel.channel, agentPub: "B".repeat(43) } }, wifi, save, ask, keys);
    expect(save).toHaveBeenCalledWith("mac", [oldWifi], channel);
    save.mockClear();
    await learnRoutes({ ...record([oldWifi]), relay: channel }, wifi, save, ask, keys);
    expect(save).not.toHaveBeenCalled();
  });
});

describe("a madani cloud signed in with the account", () => {
  it("keeps its https address beside the relay channel it opens", async () => {
    const save = vi.fn(async () => {});
    const channel = { base: "https://link.madani.bot", channel: "cdefghijkl", agentPub: "C".repeat(43) };
    const ask = (async (path: string) => new Response(JSON.stringify(path === "/api/mobile/routes" ? { https: [], companion: null, relay: null } : channel))) as typeof fetch;
    const cloud: MobileConnectionRecord = { ...record([]), via: undefined, transport: "https", origin: "https://d1.madani.bot" };
    await learnRoutes(cloud, { kind: "bearer", origin: "https://d1.madani.bot", token: "s" }, save, ask, async () => ({ pub: "P".repeat(43), priv: "x", token: "t" }));
    expect(save).toHaveBeenCalledWith("mac", [{ kind: "https", url: "https://d1.madani.bot" }], channel);
  });
});
