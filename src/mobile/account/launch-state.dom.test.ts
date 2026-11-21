// @vitest-environment happy-dom
import { act, createElement, StrictMode, useContext } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { MobileConnectionRecord } from "../../../shared/mobile-link";
import { AccountGate, useMobileAccount } from "./AccountGate";
import { ConnectionGate } from "../connection/ConnectionGate";
import { ActiveConnection } from "../connection/active";
import { readOpenChat, rememberOpenChat } from "../open-chat-restore";
import { PlatformContext, webPlatform, type MobilePlatform } from "../platform";
import { INSTALLED_KEY } from "./install";
import { signOutPhone } from "./sign-out";
import { phoneIdentity } from "./identity";
import { useConnections } from "../connection/connections";
import { accountRows, settingsIdentity } from "../sheets/SettingsSheet";
import { PREVIEW_ORIGIN } from "./environment";

vi.mock("@/components/Avatar", () => ({ MausAvatar: () => createElement("span") }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ACCOUNT = "https://madani.bot";
const CLOUD = "https://d0123456789abcdef0123.madani.bot";
const person = { id: "person", email: "person@example.com" };
const accountToken = `omc_${"t".repeat(43)}`;
const cloudRecord: MobileConnectionRecord = {
  id: "cloud", environmentId: "env-cloud", label: "my cloud", transport: "https", origin: CLOUD, sessionRef: "token.cloud", deviceId: "device-cloud",
  capabilities: {} as MobileConnectionRecord["capabilities"], addedAt: 1, lastUsedAt: 1,
};

let host: HTMLDivElement, root: Root | null, platform: MobilePlatform, prefs: Map<string, string>, secrets: Map<string, string>;
let accountAnswer: () => Promise<Response>;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const session = () => json({ account: person, expiresAt: Date.now() + 86_400_000, clouds: [{ id: "c1", name: "my cloud", role: "owner", status: "ready", origin: CLOUD }], teams: [] });

/** each launch is a new platform object, as a new process is: nothing kept in memory from the last one */
function launchPlatform(kind: "ios" | "android" = "ios"): MobilePlatform {
  return { ...webPlatform(), native: true, kind,
    prefs: { get: async (key) => prefs.get(key) ?? null, set: async (key, value) => { prefs.set(key, value); }, remove: async (key) => { prefs.delete(key); }, keys: async () => [...prefs.keys()] },
    secrets: { get: async (key) => secrets.get(key) ?? null, set: async (key, value) => { secrets.set(key, value); }, remove: async (key) => { secrets.delete(key); } } };
}
const keepSignIn = () => secrets.set("madani.account", JSON.stringify({ origin: ACCOUNT, token: accountToken, expiresAt: Date.now() + 86_400_000, account: person, deviceId: "phone" }));
const keepCloud = () => {
  prefs.set("madani.mobile.connections.v1", JSON.stringify([cloudRecord]));
  prefs.set("madani.mobile.active.v1", "cloud");
  secrets.set("token.cloud", "cloud-token");
};

beforeEach(() => {
  setLocale("en"); vi.stubEnv("VITE_MADANI_ALLOW_SIGNED_OUT", ""); vi.stubEnv("VITE_MADANI_ACCOUNT_ORIGIN", "");
  host = document.createElement("div"); document.body.append(host); root = null;
  prefs = new Map(); secrets = new Map(); sessionStorage.clear();
  accountAnswer = async () => session();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith(ACCOUNT)) return accountAnswer();
    if (url.startsWith(CLOUD)) return json({});
    return json({}, 404);
  }));
  vi.stubGlobal("EventSource", class {});
  platform = launchPlatform();
});
afterEach(async () => { await act(async () => root?.unmount()); host.remove(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

/** the app's inside: which account it shows, on which place, and the chat it would open again */
function Inside() {
  const account = useMobileAccount();
  const place = useContext(ActiveConnection);
  return createElement("p", { "data-inside": "" }, `${account?.account?.email ?? "signed out"} on ${place} chat ${readOpenChat(place)}`);
}
/** what Settings would say and offer, read the way Settings reads it; its presence means the chats are open */
function Settings() {
  const account = useMobileAccount();
  const { connections, activeId, loaded } = useConnections();
  if (!loaded) return null;
  const who = phoneIdentity({ account: account?.account, connections, activeId });
  const rows = accountRows({ native: true, identity: who, offered: account?.offered });
  const shown = Object.entries(rows).filter(([, on]) => on).map(([row]) => row).join(",");
  return createElement("p", { "data-settings": "" }, `${settingsIdentity({ identity: who }).subtitle} | ${shown}`);
}
const settings = () => host.querySelector("[data-settings]")?.textContent ?? null;
const launchSettings = async () => {
  await act(async () => {
    root = createRoot(host);
    root.render(createElement(StrictMode, null, createElement(PlatformContext, { value: platform },
      createElement(AccountGate, null, createElement(ConnectionGate, null, createElement(Settings))))));
  });
  await settle();
};
const settle = () => act(async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 5)); });
const launch = async () => {
  await act(async () => {
    root = createRoot(host);
    root.render(createElement(StrictMode, null, createElement(PlatformContext, { value: platform },
      createElement(AccountGate, null, createElement(ConnectionGate, null, createElement(Inside))))));
  });
  await settle();
};
const inside = () => host.querySelector("[data-inside]")?.textContent ?? null;
const heading = () => host.querySelector("h1")?.textContent ?? null;

describe("what a launch shows", () => {
  it.each(["ios", "android"] as const)("%s: an update from a build without the install marker opens signed in on its place at once, never as a reinstall", async (kind) => {
    platform = launchPlatform(kind);
    keepSignIn(); keepCloud();
    // an older build kept the open chat as a bare id
    sessionStorage.setItem("madani.mobile.openChat", "nova");
    accountAnswer = () => new Promise<Response>(() => {});
    await launch();
    expect(inside()).toBe("person@example.com on cloud chat null");
    expect(prefs.get(INSTALLED_KEY)).toBe("1");
    expect(secrets.has("madani.account")).toBe(true);
  });

  it.each(["ios", "android"] as const)("%s: an update holding a sign-in and other settings but no place is not a reinstall either: the account's places show at once", async (kind) => {
    platform = launchPlatform(kind);
    keepSignIn();
    prefs.set("madani.mobile.signInOffer", "dismissed");
    accountAnswer = () => new Promise<Response>(() => {});
    await launch();
    expect(heading()).toBe("Pick a cloud");
    expect(inside()).toBeNull();
    expect(prefs.get("madani.mobile.connections.v1")).toBeUndefined();
  });

  it("a real reinstall waits for the service before showing the kept sign-in, then lists the places and opens none by itself", async () => {
    keepSignIn();
    let answer: (value: Response) => void = () => {};
    accountAnswer = () => new Promise<Response>((resolve) => { answer = resolve; });
    await launch();
    expect(heading()).toBeNull();
    expect(inside()).toBeNull();
    accountAnswer = async () => session();
    await act(async () => { answer(session()); });
    await settle();
    expect(heading()).toBe("Pick a cloud");
    expect(prefs.get("madani.mobile.connections.v1")).toBeUndefined();
  });

  it("a reinstall whose kept sign-in the service no longer knows starts on the first screen, signed out", async () => {
    keepSignIn();
    accountAnswer = async () => json({ error: "invalid_token", code: "invalid_token" }, 401);
    await launch();
    expect(heading()).toBe("Your bots, on your phone");
    expect(secrets.has("madani.account")).toBe(false);
  });

  it("after Sign out the next launch is the first screen, with no chat to reopen", async () => {
    keepSignIn(); keepCloud(); prefs.set(INSTALLED_KEY, "1");
    rememberOpenChat("nova", "cloud");
    await signOutPhone({ platform, signOutAccount: async () => { secrets.delete("madani.account"); }, fetch: async () => json({}) });
    platform = launchPlatform();
    await launch();
    expect(heading()).toBe("Your bots, on your phone");
    expect(inside()).toBeNull();
    expect(readOpenChat("cloud")).toBeNull();
  });

  it("a cold start opens signed in on its place and reopens only the chat it kept for that place", async () => {
    keepSignIn(); keepCloud(); prefs.set(INSTALLED_KEY, "1");
    rememberOpenChat("nova", "cloud");
    accountAnswer = () => new Promise<Response>(() => {});
    await launch();
    expect(inside()).toBe("person@example.com on cloud chat nova");
    rememberOpenChat("nova", "other-place");
    expect(readOpenChat("cloud")).toBeNull();
  });
});

describe("Settings in each storage state, and the chats", () => {
  let stored: Map<string, string>;
  beforeEach(() => {
    prefs.set(INSTALLED_KEY, "1");
    stored = new Map();
    vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } });
  });

  it("a madani cloud link with no account session (the owner's phone): chats open, Settings says the cloud and Sign out, never Log in", async () => {
    keepCloud();
    await launchSettings();
    expect(settings()).toBe("my cloud | signOut");
  });

  it("a madani cloud link whose account the phone learned, with the session gone: signed in as that email, Sign out", async () => {
    keepCloud();
    prefs.set("madani.mobile.connections.v1", JSON.stringify([{ ...cloudRecord, account: person }]));
    await launchSettings();
    expect(settings()).toBe("person@example.com | signOut");
  });

  it("a madani cloud link and an expired session the service refuses: still the cloud and Sign out, never Log in", async () => {
    keepCloud();
    secrets.set("madani.account", JSON.stringify({ origin: ACCOUNT, token: accountToken, expiresAt: Date.now() - 1000, account: person, deviceId: "phone" }));
    accountAnswer = async () => json({ error: "invalid_token", code: "invalid_token" }, 401);
    await launchSettings();
    expect(settings()).toBe("my cloud | signOut");
  });

  it("both: signed in as the account, Sign out and Delete account, and the cloud learns whose it is", async () => {
    keepSignIn(); keepCloud();
    await launchSettings();
    expect(settings()).toBe("person@example.com | signOut,deleteAccount");
    const [saved] = JSON.parse(prefs.get("madani.mobile.connections.v1")!) as MobileConnectionRecord[];
    expect(saved?.account).toEqual(person);
  });

  it("an account session with no link: the account's places to pick from, signed in", async () => {
    keepSignIn();
    await launchSettings();
    expect(settings()).toBeNull();
    expect(heading()).toBe("Pick a cloud");
  });

  it("neither: the first screen; with only a paired computer, Connected to it and the madani cloud sign-in apart", async () => {
    await launchSettings();
    expect(heading()).toBe("Your bots, on your phone");
    await act(async () => root?.unmount());
    prefs.set("madani.mobile.connections.v1", JSON.stringify([{ ...cloudRecord, id: "mac", label: "Studio Mac", origin: CLOUD.replace("d0123456789abcdef0123.madani.bot", "mac.example.org"), sessionRef: "token.mac" }]));
    prefs.set("madani.mobile.active.v1", "mac");
    secrets.set("token.mac", "mac-token");
    platform = launchPlatform();
    vi.stubGlobal("fetch", vi.fn(async () => json({})));
    await launchSettings();
    expect(settings()).toBe("Connected to Studio Mac | cloudSignIn");
  });

  it("a sign-in kept from the preview stack is followed there instead of showing signed out", async () => {
    secrets.set("madani.account", JSON.stringify({ origin: PREVIEW_ORIGIN, token: accountToken, expiresAt: Date.now() + 86_400_000, account: person, deviceId: "phone" }));
    keepCloud();
    const asked: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => { asked.push(String(input)); return String(input).startsWith(PREVIEW_ORIGIN) ? session() : json({}); }));
    await launchSettings();
    expect(stored.get("madani.mobile.environment")).toBe("preview");
    expect(settings()).toBe("person@example.com | signOut,deleteAccount");
    expect(asked.some((url) => url.startsWith(`${PREVIEW_ORIGIN}/`))).toBe(true);
  });
});
