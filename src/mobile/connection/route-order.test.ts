import { describe, expect, it } from "vitest";

import type { MobileTransport } from "../../../shared/mobile-link";
import {
  COMPANION_HEAD_START_MS, DIRECT_BUDGET_MS, DIRECT_TRY_MS, directStillWorthIt, HTTPS_HEAD_START_MS, raceRoutes, RELAY_HEAD_START_MS, routeHeadStart,
  routeOrder, routeTimeout, type RouteOutcome,
} from "./route-order";

const relay: MobileTransport = { kind: "relay", base: "https://link.madani.bot", channel: "abcdefghij", token: "t", key: "k".repeat(43) };
const lan: MobileTransport = { kind: "companion", url: "http://192.168.1.20:8810", net: "lan", priority: 200 };
const tailnet: MobileTransport = { kind: "companion", url: "http://mac.tail.ts.net:8810", net: "tailnet", priority: 100 };
const https: MobileTransport = { kind: "https", url: "https://box.example.com" };

describe("route order", () => {
  it("tries a computer's tailnet and wi-fi first, briefly, and its relay after them", () => {
    const routes = [relay, tailnet, lan];
    expect(routeOrder(routes)).toEqual([tailnet, lan, relay]);
    expect(routeTimeout(lan, routes, 15_000)).toBe(DIRECT_TRY_MS);
    expect(routeTimeout(relay, routes, 20_000)).toBe(20_000);
  });

  it("keeps a server's order and a companion-only computer's full wait", () => {
    expect(routeOrder([https, relay])).toEqual([https, relay]);
    expect(routeOrder([lan, tailnet])).toEqual([lan, tailnet]);
    expect(routeTimeout(lan, [lan], 15_000)).toBe(15_000);
  });

  it("stops trying direct routes once their budget is spent, only when a relay waits", () => {
    expect(directStillWorthIt(lan, [lan, relay], 0, DIRECT_BUDGET_MS - 1)).toBe(true);
    expect(directStillWorthIt(lan, [lan, relay], 0, DIRECT_BUDGET_MS)).toBe(false);
    expect(directStillWorthIt(relay, [lan, relay], 0, DIRECT_BUDGET_MS * 10)).toBe(true);
    expect(directStillWorthIt(lan, [lan], 0, DIRECT_BUDGET_MS * 10)).toBe(true);
  });
});

describe("racing routes", () => {
  const hang = (signal: AbortSignal) => new Promise<RouteOutcome<string>>((resolve) => signal.addEventListener("abort", () => resolve({ kind: "failed" })));

  it("a route that never answers holds the next one up only for its head start", async () => {
    const aborted: string[] = [];
    const started = Date.now();
    const result = await raceRoutes(["dead secure access", "dead tailnet", "wi-fi"], {
      headStart: () => 20, signal: new AbortController().signal,
      attempt: (route, signal) => {
        signal.addEventListener("abort", () => aborted.push(route));
        return route === "wi-fi" ? Promise.resolve({ kind: "ok", value: route }) : hang(signal);
      },
    });
    expect(result).toEqual({ won: "wi-fi" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(aborted.sort()).toEqual(["dead secure access", "dead tailnet", "wi-fi"]);
  });

  it("a failed route starts the next at once, and the earlier one still wins when it answers first", async () => {
    const tried: string[] = [];
    const result = await raceRoutes(["refused", "wi-fi", "relay"], {
      headStart: () => 60_000, signal: new AbortController().signal,
      attempt: async (route) => { tried.push(route); return route === "refused" ? { kind: "failed" } : { kind: "ok", value: route }; },
    });
    expect(result).toEqual({ won: "wi-fi" });
    expect(tried).toEqual(["refused", "wi-fi"]);
  });

  it("a final answer settles at once; a late winner is discarded", async () => {
    const discarded: string[] = [];
    let late: (outcome: RouteOutcome<string>) => void = () => {};
    const result = await raceRoutes<string, string>(["slow", "revoked"], {
      headStart: () => 1, signal: new AbortController().signal, discard: (value) => discarded.push(value),
      attempt: (route) => route === "slow" ? new Promise<RouteOutcome<string>>((resolve) => { late = resolve; }) : Promise.resolve({ kind: "final" }),
    });
    expect(result).toEqual({ outcomes: [undefined, { kind: "final" }] });
    late({ kind: "ok", value: "slow" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(discarded).toEqual(["slow"]);
  });

  it("gives a companion a short lead and an Android relay a long one", () => {
    expect(routeHeadStart(lan, [lan, relay])).toBe(COMPANION_HEAD_START_MS);
    expect(routeHeadStart(relay, [lan, relay], "android")).toBe(RELAY_HEAD_START_MS);
    expect(routeHeadStart(https, [https, lan])).toBe(HTTPS_HEAD_START_MS);
  });
});

describe("on Android", () => {
  it("tries the relay first and keeps the computer's own network as the fallback, with its full time", () => {
    const lan = { kind: "companion", url: "http://192.168.1.4:8810", net: "lan", priority: 0 } as const;
    const relay = { kind: "relay", url: "wss://link.madani.bot", channel: "c", agentPub: "k" } as unknown as MobileTransport;
    expect(routeOrder([lan, relay], "android")).toEqual([relay, lan]);
    expect(routeOrder([lan, relay], "ios")).toEqual([lan, relay]);
    expect(routeTimeout(lan, [lan, relay], 15_000, "android")).toBe(15_000);
    expect(directStillWorthIt(lan, [lan, relay], 0, 60_000, "android")).toBe(true);
  });
});
