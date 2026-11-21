// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { sessionCheck, sessionEnded } from "@/lib/session-ended";
import { api } from "@/state/api";
import type { MobileConnectionRecord } from "../../../shared/mobile-link";
import { PlatformContext, webPlatform, type MobilePlatform } from "../platform";
import { ConnectionGate, pairedButUnreachable } from "./ConnectionGate";
import { PairError } from "./pair";
import { AccountGate } from "../account/AccountGate";

vi.mock("@/components/Avatar", () => ({ MausAvatar: () => createElement("span") }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const record = (id: string, label: string): MobileConnectionRecord => ({
  id, environmentId: `env-${id}`, label, transport: "https", origin: `https://${id}.example.test`, sessionRef: `token.${id}`,
  capabilities: {} as MobileConnectionRecord["capabilities"], addedAt: 1, lastUsedAt: 1,
});
let host: HTMLDivElement, root: Root, platform: MobilePlatform, prefs: Map<string, string>;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  setLocale("en");
  host = document.createElement("div"); document.body.append(host);
  prefs = new Map([["madani.mobile.connections.v1", JSON.stringify([record("mac", "Studio Mac"), record("vps", "Box")])], ["madani.mobile.active.v1", "mac"]]);
  const secrets = new Map([["token.mac", "mac-token"], ["token.vps", "vps-token"]]);
  platform = { ...webPlatform(),
    prefs: { get: async (key) => prefs.get(key) ?? null, set: async (key, value) => { prefs.set(key, value); }, remove: async (key) => { prefs.delete(key); } },
    secrets: { get: async (key) => secrets.get(key) ?? null, set: async (key, value) => { secrets.set(key, value); }, remove: async (key) => { secrets.delete(key); } },
  };
  fetcher = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", fetcher);
  // happy-dom has no EventSource; the installed transport wraps it
  vi.stubGlobal("EventSource", class {});
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const mount = () => act(async () => {
  root = createRoot(host);
  root.render(createElement(PlatformContext, { value: platform }, createElement(ConnectionGate, null, createElement("p", null, "home"))));
});
const settle = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); });
const click = (text: string) => act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent?.includes(text))!.click(); });

it("an offline server at launch keeps the link, retries, and offers the other saved installations", async () => {
  fetcher.mockRejectedValue(new TypeError("offline"));
  await mount(); await settle();
  expect(host.querySelector("h1")?.textContent).toBe("Can't reach Studio Mac");
  expect(host.textContent).not.toContain("Link to your");
  expect(host.textContent).toContain("Box");
  expect(prefs.get("madani.mobile.active.v1")).toBe("mac");

  fetcher.mockResolvedValue(new Response("{}"));
  await click("Try again"); await settle();
  expect(host.textContent).toBe("home");
});

it("a madani cloud its edge says was deleted is said once, never retried, and Remove takes it off and opens the next place", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fetcher.mockImplementation(async (input) => String(input).startsWith("https://mac.example.test")
    ? new Response("This madani bot was deleted.", { status: 410, headers: { "x-madani-cloud-power": "gone" } })
    : new Response("{}"));
  await mount(); await settle();
  expect(host.querySelector("h1")?.textContent).toBe("Studio Mac was deleted");
  expect(host.textContent).not.toContain("Try again");
  const asked = fetcher.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
  window.dispatchEvent(new Event("online"));
  await settle();
  expect(fetcher.mock.calls.length).toBe(asked);
  await click("Remove from this phone"); await settle();
  expect(JSON.parse(prefs.get("madani.mobile.connections.v1")!).map((entry: MobileConnectionRecord) => entry.id)).toEqual(["vps"]);
  expect(prefs.get("madani.mobile.active.v1")).toBe("vps");
  expect(host.textContent).toBe("home");
  vi.useRealTimers();
});

it("the unreachable screen tries again as soon as the app is back in front or on another network", async () => {
  const resumed = new Set<() => void>(), moved = new Set<() => void>();
  platform = { ...platform,
    onResume: (listener) => { resumed.add(listener); return () => resumed.delete(listener); },
    onNetworkChange: (listener) => { moved.add(listener); return () => moved.delete(listener); } };
  fetcher.mockRejectedValue(new TypeError("offline"));
  await mount(); await settle();
  expect(host.querySelector("h1")?.textContent).toBe("Can't reach Studio Mac");
  fetcher.mockResolvedValue(new Response("{}"));
  await act(async () => { for (const listener of resumed) listener(); }); await settle();
  expect(host.textContent).toBe("home");
  await act(async () => root.unmount());
  fetcher.mockRejectedValue(new TypeError("offline"));
  await mount(); await settle();
  expect(host.querySelector("h1")?.textContent).toBe("Can't reach Studio Mac");
  fetcher.mockResolvedValue(new Response("{}"));
  await act(async () => { for (const listener of moved) listener(); }); await settle();
  expect(host.textContent).toBe("home");
});

it("switches to another saved installation from the unreachable screen", async () => {
  fetcher.mockImplementation(async (input) => String(input).startsWith("https://vps.") ? new Response("{}") : Promise.reject(new TypeError("offline")));
  await mount(); await settle();
  await click("Box"); await settle();
  expect(prefs.get("madani.mobile.active.v1")).toBe("vps");
  expect(host.textContent).toBe("home");
});

it("a refused token still goes to pairing", async () => {
  fetcher.mockResolvedValue(new Response("{}", { status: 401 }));
  await mount(); await settle();
  expect(host.querySelector("h1")?.textContent).not.toContain("Can't reach");
  expect(prefs.get("madani.mobile.active.v1")).toBeUndefined();
});

it("a phone removed on the computer while the app is open leaves for pairing at once, with the reason", async () => {
  fetcher.mockResolvedValue(new Response("{}"));
  await mount(); await settle();
  expect(host.textContent).toBe("home");

  fetcher.mockImplementation(async () => new Response('{"error":"unauthorized"}', { status: 401 }));
  await act(async () => { await api("/api/bots").catch(() => {}); await sessionCheck(); });
  await settle();
  expect(host.textContent).not.toBe("home");
  expect(host.textContent).toContain("This phone was unlinked");
  expect(prefs.get("madani.mobile.active.v1")).toBeUndefined();
  expect(prefs.get("madani.mobile.connections.v1")).not.toContain("Studio Mac");
  expect(sessionEnded()).toBe(false);
});

it("a refused request on a session that still answers changes nothing", async () => {
  fetcher.mockResolvedValue(new Response("{}"));
  await mount(); await settle();
  fetcher.mockImplementation(async (input) => String(input instanceof Request ? input.url : input).endsWith("/api/auth/session") ? new Response("{}") : new Response("{}", { status: 401 }));
  await act(async () => { await api("/api/bots").catch(() => {}); await sessionCheck(); });
  await settle();
  expect(host.textContent).toBe("home");
  expect(prefs.get("madani.mobile.active.v1")).toBe("mac");
});

it("a madani cloud asleep at launch opens on its chats and is woken, never the can't reach screen it could not leave", async () => {
  // the edge never wakes a cloud for a read, so the launch check only ever hears that it sleeps
  fetcher.mockImplementation(async (input, init) => {
    const method = (input instanceof Request ? input.method : init?.method) ?? "GET";
    return method === "GET" ? new Response("asleep", { status: 503, headers: { "x-madani-cloud-power": "asleep", "retry-after": "5" } }) : new Response("{}");
  });
  await mount(); await settle();
  expect(host.textContent).toBe("home");
  const posts = fetcher.mock.calls.filter(([input, init]) => ((input instanceof Request ? input.method : init?.method) ?? "GET") === "POST");
  expect(posts.map(([input]) => String(input instanceof Request ? input.url : input))).toContain("https://mac.example.test/api/cloud/wake");
});

describe("two accounts, each with its own madani cloud", () => {
  const cloudOrigin = "https://d2222222222222222222b.madani.bot";
  const tokenOf = (who: string) => `omc_${who[0]!.repeat(43)}`;
  const kept = (id: string) => ({ origin: "https://madani.bot", token: tokenOf(id), expiresAt: Date.now() + 86_400_000, deviceId: "phone", account: { id, email: `${id}@example.com` } });
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  let secrets: Map<string, string>;
  const asked = (path: string) => fetcher.mock.calls.filter(([input]) => String(input).endsWith(path));
  const authOf = (call: Parameters<typeof fetch>) => (call[1]?.headers as Record<string, string> | undefined)?.authorization;
  const bobCloud = (tagged: boolean): MobileConnectionRecord => ({ ...record("bob-cloud", "Bob cloud"), origin: cloudOrigin, ...(tagged ? { account: { id: "bob", email: "bob@example.com" } } : {}) });
  const start = async (cloud: MobileConnectionRecord) => {
    vi.stubEnv("VITE_MADANI_ALLOW_SIGNED_OUT", ""); vi.stubEnv("VITE_MADANI_ACCOUNT_ORIGIN", "");
    secrets = new Map([["token.bob-cloud", "cloud-token"], ["madani.account", JSON.stringify(kept("alice"))], ["madani.account.others", JSON.stringify([kept("bob")])]]);
    prefs = new Map([["madani.mobile.connections.v1", JSON.stringify([cloud])], ["madani.mobile.active.v1", "bob-cloud"], ["madani.mobile.installed", "1"]]);
    platform = { ...platform, native: true, kind: "android",
      prefs: { get: async (key) => prefs.get(key) ?? null, set: async (key, value) => { prefs.set(key, value); }, remove: async (key) => { prefs.delete(key); } },
      secrets: { get: async (key) => secrets.get(key) ?? null, set: async (key, value) => { secrets.set(key, value); }, remove: async (key) => { secrets.delete(key); } },
      onAppUrl: () => () => {}, onResume: () => () => {} };
    fetcher.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith(cloudOrigin)) return json({});
      if (url.endsWith("/api/cloud/desktop/session")) {
        const bob = authOf([input, init]) ===`Bearer ${tokenOf("bob")}`;
        return json({ clouds: bob ? [{ id: "cb", role: "owner", teamId: null, status: "ready", origin: cloudOrigin, name: "Bob cloud" }] : [], teams: [] });
      }
      return json({ error: "not_found" }, 404);
    });
    await act(async () => {
      root = createRoot(host);
      root.render(createElement(PlatformContext, { value: platform }, createElement(AccountGate, null, createElement(ConnectionGate, null, createElement("p", null, "home")))));
    });
    for (let i = 0; i < 30 && JSON.parse(secrets.get("madani.account")!).account.id !== "bob"; i++) await settle();
    await settle();
  };
  afterEach(() => { vi.unstubAllEnvs(); });

  it("opening the other account's cloud puts that account in use and keeps the first one signed in", async () => {
    await start(bobCloud(true));
    expect(host.textContent).toBe("home");
    expect(JSON.parse(secrets.get("madani.account")!).account.id).toBe("bob");
    expect(JSON.parse(secrets.get("madani.account.others")!).map((one: { account: { id: string } }) => one.account.id)).toEqual(["alice"]);
    expect(asked("/v1/app/enroll-grant").map(authOf).filter((auth) => auth === `Bearer ${tokenOf("alice")}`), "never enrolled into the other account").toEqual([]);
  });

  it("a cloud linked before the phone knew whose it was is tagged with the account that lists it, which takes over", async () => {
    await start(bobCloud(false));
    expect(JSON.parse(secrets.get("madani.account")!).account.id).toBe("bob");
    expect(JSON.parse(prefs.get("madani.mobile.connections.v1")!)[0].account).toEqual({ id: "bob", email: "bob@example.com" });
    expect(asked("/v1/app/enroll-grant").map(authOf).filter((auth) => auth === `Bearer ${tokenOf("alice")}`)).toEqual([]);
  });
});

it("keeps a pairing the computer accepted when the first connect fails, and drops only a refused one", () => {
  expect(pairedButUnreachable(new PairError("unreachable"))).toBe(true);
  expect(pairedButUnreachable(new TypeError("Load failed"))).toBe(true);
  expect(pairedButUnreachable(new PairError("refused"))).toBe(false);
});
