// @vitest-environment happy-dom
import { act, createElement, Fragment, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { AccountGate } from "../account/AccountGate";
import { SignInOffer, SIGN_IN_OFFER_KEY } from "../account/SignInOffer";
import { PlatformContext, webPlatform, type MobilePlatform } from "../platform";
import { firstStep, Onboarding } from "./Onboarding";
import { typedCodeComplete } from "./code-field";
import { redeemPairing } from "../connection/pair";
import { MOBILE_LINK_VERSION, mobileLinkUrl, universalPairLink, type MobileLinkPayload } from "../../../shared/mobile-link";
import { sealLookup } from "../../../server/mobile/lookup";

vi.mock("@/components/Avatar", () => ({ MausAvatar: () => createElement("span"), BotAvatar: () => createElement("span") }));
// steps swap without waiting on exit animations, so each choice lands on its screen at once
vi.mock("motion/react", async (original) => {
  const actual = await original<typeof import("motion/react")>();
  const strip = ({ initial: _i, animate: _a, exit: _e, transition: _t, whileTap: _w, variants: _v, layout: _l, ...rest }: Record<string, unknown>) => rest;
  const motion = new Proxy({}, { get: (_, tag: string) => (props: Record<string, unknown>) => createElement(tag, strip(props)) });
  return { ...actual, motion, AnimatePresence: ({ children }: { children: ReactNode }) => createElement(Fragment, null, children), useReducedMotion: () => true };
});
vi.mock("../connection/pair", async (original) => ({
  ...await original<typeof import("../connection/pair")>(),
  redeemPairing: vi.fn(async (payload: { name?: string }) => ({ record: { id: "linked", label: payload.name ?? "" }, token: "session" })),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const origin = "https://madani.bot";
const account = { id: "person", email: "person@example.com" };
const token = `omc_${"t".repeat(43)}`;
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
let host: HTMLDivElement, root: Root, platform: MobilePlatform, prefs: Map<string, string>, secrets: Map<string, string>;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  setLocale("en"); window.history.replaceState({}, "", "/");
  vi.stubEnv("VITE_MADANI_ALLOW_SIGNED_OUT", ""); vi.stubEnv("VITE_MADANI_ACCOUNT_ORIGIN", "");
  host = document.createElement("div"); document.body.append(host);
  prefs = new Map(); secrets = new Map();
  platform = { ...webPlatform(), native: true, kind: "android",
    prefs: { get: async (key) => prefs.get(key) ?? null, set: async (key, value) => { prefs.set(key, value); }, remove: async (key) => { prefs.delete(key); } },
    secrets: { get: async (key) => secrets.get(key) ?? null, set: async (key, value) => { secrets.set(key, value); }, remove: async (key) => { secrets.delete(key); } },
    onAppUrl: () => () => {}, onResume: () => () => {}, openExternal: vi.fn(async () => {}), camera: undefined };
  fetcher = vi.fn<typeof fetch>(async () => response({ v: 1, providers: [], signupOpen: true })); vi.stubGlobal("fetch", fetcher);
});
afterEach(async () => { await act(async () => root?.unmount()); host.remove(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

const mount = (child: ReactNode) => act(async () => {
  root = createRoot(host);
  root.render(createElement(PlatformContext, { value: platform }, createElement(AccountGate, null, child)));
});
const onboarding = (props: Partial<Parameters<typeof Onboarding>[0]> = {}) => createElement(Onboarding, { onLinked: vi.fn(), ...props });
const entries = () => [...host.querySelectorAll<HTMLButtonElement>("[data-entry]")];
const press = (selector: string) => act(async () => { host.querySelector<HTMLButtonElement>(selector)!.click(); });
const heading = () => host.querySelector("h1")?.textContent;

it("log in opens the account sign-in straight away", async () => {
  await mount(onboarding());
  await press("[data-entry=signin]");
  expect(heading()).toBe("Log in to madani bot");
  expect(host.querySelector("input[type=email]")).not.toBeNull();
});

it("enter a code opens the code field straight away, with no intro in between", async () => {
  await mount(onboarding());
  await press("[data-entry=code]");
  expect(heading()).toBe("Enter the code");
  expect(host.querySelector("input[autocomplete=one-time-code]")).not.toBeNull();
});

it("android back steps back through onboarding and leaves the app from the first screen", async () => {
  let back: (() => boolean) | undefined;
  platform = { ...platform, onBack: (listener) => { back = listener; return () => { back = undefined; }; } };
  await mount(onboarding());
  expect(back?.(), "the first screen hands back to android, which minimizes").toBe(false);
  await press("[data-entry=code]");
  expect(heading()).toBe("Enter the code");
  let handled: boolean | undefined;
  await act(async () => { handled = back?.(); });
  expect(handled).toBe(true);
  expect(entries().map((button) => button.dataset.entry)).toEqual(["scan", "signin", "code"]);
});

it("scan without a camera falls back to the code field", async () => {
  await mount(onboarding());
  await press("[data-entry=scan]");
  expect(heading()).toBe("Enter the code");
});

it("picks the first screen from what the phone already has", () => {
  expect(firstStep({ incoming: false, signedIn: false, adding: false })).toBe("welcome");
  expect(firstStep({ incoming: false, signedIn: true, adding: false })).toBe("clouds");
  expect(firstStep({ incoming: true, signedIn: true, adding: false })).toBe("confirm");
  expect(firstStep({ incoming: false, signedIn: true, adding: true })).toBe("welcome");
  // a sign-in asked for from Settings goes to it, or straight to the clouds once signed in
  expect(firstStep({ incoming: false, signedIn: false, adding: true, startAt: "signin" })).toBe("signin");
  expect(firstStep({ incoming: false, signedIn: true, adding: true, startAt: "signin" })).toBe("clouds");
  expect(firstStep({ incoming: true, signedIn: false, adding: true, startAt: "signin" })).toBe("confirm");
});

it("leads with scanning your own computer, logging in to a madani cloud next to it, and typing a code as the quiet way", async () => {
  await mount(onboarding());
  const [scan, signIn, code] = entries();
  expect(scan?.dataset.entry).toBe("scan");
  expect(signIn?.dataset.entry).toBe("signin");
  expect(code?.dataset.entry).toBe("code");
  expect(scan?.className).toContain("bg-ink ");
  expect(signIn?.className, "a real choice, never outranking the scan").toContain("bg-ink/[0.05]");
  expect(code?.className).not.toContain("bg-ink");
  expect(entries().map((button) => button.textContent)).toEqual(["Scan a QR code", "Log in to madani cloud", "Enter a code"]);
  expect(host.textContent).not.toContain("demo");
});

it("a typed code the relay never had says so, not expired, and offers logging in", async () => {
  // a browser's /pair code from a cloud's settings was typed here and read as "That code expired"
  fetcher.mockImplementation(async (input) => String(input).includes("/v1/lookups/") ? response({ error: "not found", code: "not_found" }, 404) : response({ v: 1, providers: [], signupOpen: true }));
  await mount(onboarding());
  await press("[data-entry=code]");
  const field = host.querySelector<HTMLInputElement>("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "ABCD-EFGH-2345");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { host.querySelector<HTMLFormElement>("form")!.requestSubmit(); });
  for (let i = 0; i < 100 && !host.querySelector("[role=alert]"); i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  const alert = host.querySelector("[role=alert]")?.textContent ?? "";
  expect(alert).toContain("We couldn't find that code");
  expect(alert).not.toMatch(/expired/i);
  await press("[data-failure-sign-in]");
  expect(host.querySelector("[data-step]")?.getAttribute("data-step")).toBe("signin");
});

describe("a sign-in the Keychain kept through a delete and reinstall", () => {
  const cloud = { id: "home", name: "Home cloud", role: "owner", teamId: null, managed: true, status: "ready", origin: "https://home.example.com", primary: true, power: { state: "asleep" } };
  const computer = { id: "ws_mac", name: "Studio Mac", kind: "mac", presence: "online", environmentId: "env-mac" };
  let pairs: number, sessionEnded: boolean;
  const keptSignIn = (session: () => Response = () => response({ ok: true, clouds: [cloud] })) => {
    secrets.set("madani.account", JSON.stringify({ origin, token, expiresAt: Date.now() + 60_000, account, deviceId: "phone" }));
    pairs = 0; sessionEnded = false;
    fetcher.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/cloud/desktop/session")) { if (init?.method === "DELETE") { sessionEnded = true; return response({ ok: true }); } return session(); }
      if (url.endsWith("/v1/app/computers")) return response({ v: 1, computers: [computer] });
      if (url.endsWith("/api/cloud/desktop/pairing")) { pairs++; return response({ cloudContractVersion: 1, origin: cloud.origin, code: "ABCD-EFGH-JKLM", expiresAt: Date.now() + 60_000 }); }
      return response({ v: 1, providers: [], signupOpen: true });
    });
  };
  const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };

  it("opens the account's places to pick from, with sign out and another account, and never opens one by itself", async () => {
    keptSignIn();
    const onLinked = vi.fn();
    await mount(onboarding({ onLinked }));
    await settle();
    expect(heading()).toBe("Pick where to work");
    expect(host.textContent).not.toMatch(/asleep/i);
    expect(pairs).toBe(0);
    expect(onLinked).not.toHaveBeenCalled();
    expect([...host.querySelectorAll<HTMLElement>("[data-place-kind]")].map((row) => row.dataset.placeKind)).toEqual(["cloud", "computer"]);
    expect(host.querySelector("[data-entry=sign-out]")?.textContent).toBe("Sign out");
    expect(host.querySelector("[data-entry=other-account]")).not.toBeNull();
    expect(prefs.get("madani.mobile.installed")).toBe("1");
    await press("[data-testid=mobile-cloud-connect][data-place-kind=cloud]");
    await settle();
    expect(pairs).toBe(1);
    expect(onLinked).toHaveBeenCalledWith(expect.objectContaining({ id: "linked" }), "session", "Home cloud");
  });

  it("Sign out there ends the session on the service and forgets it on the phone", async () => {
    keptSignIn();
    await mount(onboarding());
    await settle();
    await press("[data-entry=sign-out]");
    await settle();
    expect(sessionEnded).toBe(true);
    expect(secrets.has("madani.account")).toBe(false);
  });

  it("one the service no longer knows is forgotten, and the phone starts on its first screen", async () => {
    keptSignIn(() => response({ error: "invalid_token", code: "invalid_token" }, 401));
    await mount(onboarding());
    await settle();
    expect(secrets.has("madani.account")).toBe(false);
    expect(entries().map((button) => button.dataset.entry)).toEqual(["scan", "signin", "code"]);
  });

  it("a sign-in made on the phone still opens its only cloud by itself", async () => {
    keptSignIn();
    secrets.delete("madani.account");
    fetcher.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/cloud/app/sign-in/phone")) return response({ cloudContractVersion: 1, accessToken: token, expiresAt: Date.now() + 86_400_000, device: { id: "phone" }, account });
      if (url.endsWith("/api/cloud/desktop/session")) return response({ ok: true, clouds: [cloud] });
      if (url.endsWith("/api/cloud/desktop/pairing")) { pairs++; return response({ cloudContractVersion: 1, origin: cloud.origin, code: "ABCD-EFGH-JKLM", expiresAt: Date.now() + 60_000 }); }
      return response({ v: 1, providers: [], signupOpen: true });
    });
    const onLinked = vi.fn();
    await mount(onboarding({ onLinked }));
    await press("[data-entry=code]");
    await act(async () => {
      const input = host.querySelector<HTMLInputElement>("input[autocomplete=one-time-code]")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "ABCDEFGH");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await press("button[type=submit]");
    await settle();
    expect(pairs).toBe(1);
    expect(onLinked).toHaveBeenCalledWith(expect.objectContaining({ id: "linked" }), "session", "Home cloud");
  });
});

it("a signed-in account with no cloud is pointed at linking a computer", async () => {
  secrets.set("madani.account", JSON.stringify({ origin, token, expiresAt: Date.now() + 60_000, account, deviceId: "phone" }));
  fetcher.mockImplementation(async (input) => String(input).endsWith("/api/cloud/desktop/session") ? response({ ok: true, clouds: [] }) : response({}));
  await mount(onboarding());
  expect(heading()).toBe("No cloud yet");
  expect([...host.querySelectorAll("button")].map((button) => button.textContent)).toEqual(expect.arrayContaining(["Scan a QR code", "Enter a code"]));
});

it("the store apps never offer an account to a phone paired with its own computer", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  document.documentElement.dataset.mobileApp = "ios";
  try {
    await mount(createElement(SignInOffer));
    await act(async () => { vi.advanceTimersByTime(3000); });
    await act(async () => {});
    expect(host.querySelector("[data-sign-in-offer]")).toBeNull();
  } finally { delete document.documentElement.dataset.mobileApp; }
});

it("after a QR or code link, offers the account sign-in once, quietly, and remembers not now", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await mount(createElement(SignInOffer));
  expect(host.querySelector("[data-sign-in-offer]")).toBeNull();
  await act(async () => { vi.advanceTimersByTime(3000); });
  await act(async () => {});
  expect(host.querySelector("[data-sign-in-offer]")).not.toBeNull();
  await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Not now")!.click(); });
  expect(host.querySelector("[data-sign-in-offer]")).toBeNull();
  expect(prefs.get(SIGN_IN_OFFER_KEY)).toBe("dismissed");
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => { root.render(createElement(PlatformContext, { value: platform }, createElement(AccountGate, null, createElement(SignInOffer)))); });
  await act(async () => { vi.advanceTimersByTime(3000); });
  await act(async () => {});
  expect(host.querySelector("[data-sign-in-offer]")).toBeNull();
});

it("the sign-in offer opens the sign-in without leaving the app", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await mount(createElement(SignInOffer));
  await act(async () => { vi.advanceTimersByTime(3000); });
  await act(async () => {});
  await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent === "Log in")!.click(); });
  expect(host.querySelector("[role=dialog] h1")?.textContent).toBe("Log in to madani bot");
});

it("a scan of the desktop's App Store qr says so, and the screen after a failed scan offers scanning again", async () => {
  platform = { ...platform, camera: {
    permission: async () => "granted", request: async () => "granted",
    start: async ({ onCode }: { onCode: (text: string) => void }) => { setTimeout(() => onCode("https://apps.apple.com/app/id6834725640"), 0); return { stop: async () => {} }; },
  } as unknown as MobilePlatform["camera"] };
  await mount(onboarding());
  await press("[data-entry=scan]");
  for (let i = 0; i < 100 && !host.querySelector("[role=alert]"); i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  expect(host.querySelector("[data-step]")?.getAttribute("data-step")).toBe("code");
  expect(host.querySelector("[role=alert]")?.textContent).toContain("That's the App Store code");
  const again = host.querySelector<HTMLButtonElement>("[data-scan-again]");
  expect(again?.disabled, "never a disabled Try again over an empty field").toBe(false);
  expect(host.querySelector("button[type=submit]")).toBeNull();
});

it("a scan of a madani cloud's log in qr with no code opens the log in with its email filled in", async () => {
  platform = { ...platform, camera: {
    permission: async () => "granted", request: async () => "granted",
    start: async ({ onCode }: { onCode: (text: string) => void }) => { setTimeout(() => onCode("https://madani.bot/m/signin#email=person%40example.com"), 0); return { stop: async () => {} }; },
  } as unknown as MobilePlatform["camera"] };
  await mount(onboarding());
  await press("[data-entry=scan]");
  for (let i = 0; i < 100 && !host.querySelector("input[type=email]"); i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  expect(heading()).toBe("Log in to madani bot");
  expect(host.querySelector<HTMLInputElement>("input[type=email]")?.value).toBe("person@example.com");
});

describe("a madani cloud's log in qr for another account than the phone's", () => {
  const signedInWithoutClouds = () => {
    secrets.set("madani.account", JSON.stringify({ origin, token, expiresAt: Date.now() + 60_000, account, deviceId: "phone" }));
    fetcher.mockImplementation(async (input) => String(input).endsWith("/api/cloud/desktop/session") ? response({ ok: true, clouds: [] }) : response({ v: 1, providers: [], signupOpen: true }));
  };
  const settle = async (done: () => boolean) => { for (let i = 0; i < 100 && !done(); i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); }); };

  it("scanned from the no-cloud screen, asks before switching, then logs in to the qr's account instead of landing back on the same screen", async () => {
    signedInWithoutClouds();
    platform = { ...platform, camera: {
      permission: async () => "granted", request: async () => "granted",
      start: async ({ onCode }: { onCode: (text: string) => void }) => { setTimeout(() => onCode("https://madani.bot/m/signin#email=owner%40example.com"), 0); return { stop: async () => {} }; },
    } as unknown as MobilePlatform["camera"] };
    await mount(onboarding());
    const scan = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Scan a QR code");
    await settle(() => Boolean(scan()));
    expect(heading()).toBe("No cloud yet");
    await act(async () => { scan()!.click(); });
    await settle(() => Boolean(host.querySelector("[data-entry=switch-account]")));
    expect(heading()).toBe("Log in as owner@example.com?");
    expect(secrets.has("madani.account"), "nothing changes before the person says so").toBe(true);
    await press("[data-entry=switch-account]");
    await settle(() => Boolean(host.querySelector("input[type=email]")));
    expect(heading()).toBe("Log in to madani bot");
    expect(host.querySelector<HTMLInputElement>("input[type=email]")?.value).toBe("owner@example.com");
    expect(secrets.has("madani.account"), "the account in use stays until the other one signs in").toBe(true);
  });

  it("opened from the camera, does the same", async () => {
    signedInWithoutClouds();
    await mount(onboarding({ startAt: "signin", email: "owner@example.com" }));
    await settle(() => Boolean(host.querySelector("[data-entry=switch-account]")));
    await press("[data-entry=switch-account]");
    await settle(() => Boolean(host.querySelector("input[type=email]")));
    expect(host.querySelector<HTMLInputElement>("input[type=email]")?.value).toBe("owner@example.com");
  });
});

describe("a madani cloud's code from the desktop", () => {
  const phoneGrant = { cloudContractVersion: 1, accessToken: token, expiresAt: Date.now() + 86_400_000, device: { id: "phone" }, account };
  const route = (phone: () => Response) => fetcher.mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/api/cloud/app/sign-in/phone")) return phone();
    if (url.endsWith("/api/cloud/desktop/session")) return response({ ...phoneGrant, clouds: [] });
    return response({ v: 1, providers: [], signupOpen: true });
  });
  const type = (text: string) => act(async () => {
    const input = host.querySelector<HTMLInputElement>("input[autocomplete=one-time-code]")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const submit = () => press("button[type=submit]");
  const phoneCalls = () => fetcher.mock.calls.filter(([input]) => String(input).endsWith("/api/cloud/app/sign-in/phone"));

  it("typing its 8 letters logs the phone in with no email step and goes on to the clouds", async () => {
    route(() => response(phoneGrant));
    await mount(onboarding());
    await press("[data-entry=code]");
    await type("abcdefgh");
    expect(host.querySelector<HTMLInputElement>("input[autocomplete=one-time-code]")!.value).toBe("ABCD-EFGH");
    expect(host.querySelector<HTMLButtonElement>("button[type=submit]")!.disabled).toBe(false);
    await submit();
    expect(phoneCalls()).toHaveLength(1);
    expect(JSON.parse(String(phoneCalls()[0]![1]?.body))).toMatchObject({ code: "ABCDEFGH" });
    expect(host.querySelector("input[type=email]"), "never the email sign-in").toBeNull();
    expect(heading()).not.toBe("Enter the code");
    expect(secrets.has("madani.account")).toBe(true);
  });

  it.each([
    [410, "expired", "That code expired"], [409, "used", "That code was already used"], [400, "invalid_code", "We couldn't find that code"],
  ])("says what went wrong, next to the code (%s %s)", async (status, error, words) => {
    route(() => response({ error }, status));
    await mount(onboarding());
    await press("[data-entry=code]");
    await type("ABCDEFGH");
    await submit();
    expect(heading()).toBe("Enter the code");
    expect(host.textContent).toContain(words);
    expect(secrets.has("madani.account")).toBe(false);
  });

  it("the qr's link carries the code: it is redeemed at once", async () => {
    route(() => response(phoneGrant));
    await mount(onboarding({ signInCode: "ABCDEFGH", email: "person@example.com", startAt: "signin" }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(phoneCalls()).toHaveLength(1);
    expect(secrets.has("madani.account")).toBe(true);
    expect(host.querySelector("input[type=email]")).toBeNull();
  });

  it("a computer's code still needs all 12", () => {
    expect(typedCodeComplete("ABCD-EFGH")).toBe(true);
    expect(typedCodeComplete("ABCD-EFG2")).toBe(false);
    expect(typedCodeComplete("ABCD-EFGH-JK")).toBe(false);
    expect(typedCodeComplete("ABCD-EFGH-JK23")).toBe(true);
  });
});

describe("a madani cloud's QR always ends in that cloud, on its account", () => {
  const owner = { id: "owner", email: "owner@example.com" };
  const home = { id: "c1", name: "Home cloud", role: "owner", status: "ready", origin: "https://d0123456789abcdef0123.madani.bot", primary: true };
  const work = { id: "c2", name: "Work cloud", role: "owner", status: "ready", origin: "https://dfedcba9876543210fedc.madani.bot" };
  const grant = (who: typeof owner) => ({ cloudContractVersion: 1, accessToken: token, expiresAt: Date.now() + 86_400_000, device: { id: "phone" }, account: who });
  let paired: string[];
  const route = (clouds: unknown[]) => fetcher.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/cloud/app/sign-in/phone")) return response(grant(owner));
    if (url.endsWith("/api/cloud/desktop/session") && init?.method !== "DELETE") return response({ ok: true, clouds });
    if (url.endsWith("/v1/app/computers")) return response({ v: 1, computers: [] });
    if (url.endsWith("/api/cloud/desktop/pairing")) {
      const asked = JSON.parse(String(init?.body ?? "{}")) as { cloudId?: string };
      const cloud = [home, work].find((one) => one.id === asked.cloudId) ?? home;
      paired.push(cloud.id);
      return response({ cloudContractVersion: 1, origin: cloud.origin, code: "ABCD-EFGH-JKLM", expiresAt: Date.now() + 60_000 });
    }
    return response({ v: 1, providers: [], signupOpen: true });
  });
  const settle = async (done: () => boolean) => { for (let i = 0; i < 100 && !done(); i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); }); };
  const scanning = (text: string) => ({ ...platform, camera: {
    permission: async () => "granted", request: async () => "granted",
    start: async ({ onCode }: { onCode: (value: string) => void }) => { setTimeout(() => onCode(text), 0); return { stop: async () => {} }; },
  } as unknown as MobilePlatform["camera"] });
  beforeEach(() => { paired = []; });

  it("a signed-out phone scanning it in the app logs in and opens the cloud the QR was drawn on, of two", async () => {
    route([home, work]);
    platform = scanning(`https://madani.bot/m/signin#c=ABCDEFGH&email=owner%40example.com&o=${encodeURIComponent(work.origin)}`);
    const onLinked = vi.fn();
    await mount(onboarding({ onLinked }));
    await press("[data-entry=scan]");
    await settle(() => onLinked.mock.calls.length > 0);
    expect(paired).toEqual(["c2"]);
    expect(onLinked).toHaveBeenCalledWith(expect.objectContaining({ id: "linked" }), "session", "Work cloud");
  });

  it("from the camera, inside the app on another place, it opens the account's only cloud without a pick", async () => {
    route([home]);
    const onLinked = vi.fn();
    await mount(onboarding({ onLinked, startAtLink: true, onCancel: vi.fn(), startAt: "signin", email: owner.email, signInCode: "ABCDEFGH" }));
    await settle(() => onLinked.mock.calls.length > 0);
    expect(paired).toEqual(["c1"]);
  });

  it("a phone already linked to that cloud opens it instead of a picker with nothing to pick", async () => {
    route([home]);
    prefs.set("madani.mobile.connections.v1", JSON.stringify([{ id: "kept", environmentId: "env", label: "Home cloud", transport: "https", origin: home.origin, sessionRef: "token.kept", capabilities: {}, addedAt: 1, lastUsedAt: 1 }]));
    secrets.set("token.kept", "kept-token");
    secrets.set("madani.account", JSON.stringify({ origin, token, expiresAt: Date.now() + 60_000, account: owner, deviceId: "phone" }));
    const onOpen = vi.fn();
    await mount(onboarding({ onOpen, startAtLink: true, onCancel: vi.fn(), startAt: "signin", email: owner.email, signInCode: "ABCDEFGH", signInCloud: home.origin }));
    await settle(() => onOpen.mock.calls.length > 0);
    expect(onOpen).toHaveBeenCalledWith("kept");
    expect(paired).toEqual([]);
  });

  it("a phone on another account asks first; switching keeps that account and its clouds beside the new one, then opens the QR's cloud", async () => {
    route([home]);
    secrets.set("madani.account", JSON.stringify({ origin, token, expiresAt: Date.now() + 60_000, account, deviceId: "phone" }));
    prefs.set("madani.mobile.connections.v1", JSON.stringify([{ id: "old", environmentId: "env-old", label: "Old cloud", transport: "https", origin: "https://d1111111111111111111a.madani.bot", sessionRef: "token.old", capabilities: {}, addedAt: 1, lastUsedAt: 1 }]));
    secrets.set("token.old", "old-token");
    const onLinked = vi.fn();
    await mount(onboarding({ onLinked, startAt: "signin", email: owner.email, signInCode: "ABCDEFGH" }));
    await settle(() => Boolean(host.querySelector("[data-entry=switch-account]")));
    expect(heading()).toBe("Log in as owner@example.com?");
    expect(host.textContent).toContain(account.email);
    await press("[data-entry=switch-account]");
    await settle(() => onLinked.mock.calls.length > 0);
    expect(JSON.parse(prefs.get("madani.mobile.connections.v1") ?? "[]").map((one: { id: string }) => one.id)).toEqual(["old"]);
    expect(secrets.get("token.old")).toBe("old-token");
    expect(JSON.parse(secrets.get("madani.account.others") ?? "[]").map((one: { account: { email: string } }) => one.account.email)).toEqual([account.email]);
    expect(paired).toEqual(["c1"]);
  });
});

describe("another account is always a tap away", () => {
  it("Add another account on the clouds screen opens an empty sign-in and keeps this account and its clouds", async () => {
    secrets.set("madani.account", JSON.stringify({ origin, token, expiresAt: Date.now() + 60_000, account, deviceId: "phone" }));
    prefs.set("madani.mobile.connections.v1", JSON.stringify([{ id: "wrong", environmentId: "env-w", label: "Wrong cloud", transport: "https", origin: "https://d2222222222222222222b.madani.bot", sessionRef: "token.wrong", capabilities: {}, addedAt: 1, lastUsedAt: 1 }]));
    secrets.set("token.wrong", "wrong-token");
    fetcher.mockImplementation(async (input) => String(input).endsWith("/api/cloud/desktop/session") ? response({ ok: true, clouds: [] }) : response({ v: 1, providers: [], signupOpen: true }));
    await mount(onboarding());
    for (let i = 0; i < 50 && !host.querySelector("[data-entry=other-account]"); i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    await press("[data-entry=other-account]");
    for (let i = 0; i < 50 && !host.querySelector("input[type=email]"); i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(heading()).toBe("Log in to madani bot");
    expect(host.querySelector<HTMLInputElement>("input[type=email]")?.value).toBe("");
    expect(secrets.has("madani.account")).toBe(true);
    expect(JSON.parse(prefs.get("madani.mobile.connections.v1") ?? "[]").map((one: { id: string }) => one.id)).toEqual(["wrong"]);
    expect(secrets.get("token.wrong")).toBe("wrong-token");
  });
});

describe("a signed-in desktop's QR signs the phone in as it pairs", () => {
  const linkPayload: MobileLinkPayload = {
    v: MOBILE_LINK_VERSION, workspace: { name: "Studio Mac", environmentId: "env-mac", kind: "vps" },
    grant: { id: "grant-1", secret: "s3cret", expiresAt: Date.now() + 5 * 60_000 },
    via: [{ kind: "https", url: "https://mac.example.org" }],
  } as MobileLinkPayload;
  const qr = universalPairLink(mobileLinkUrl(linkPayload), null, { code: "WXYZQRST", email: "owner@example.com" });
  const owner = { id: "owner", email: "owner@example.com" };
  const phoneCalls = () => fetcher.mock.calls.filter(([input]) => String(input).endsWith("/api/cloud/app/sign-in/phone"));
  const scanning = () => ({ ...platform, camera: {
    permission: async () => "granted", request: async () => "granted",
    start: async ({ onCode }: { onCode: (value: string) => void }) => { setTimeout(() => onCode(qr), 0); return { stop: async () => {} }; },
  } as unknown as MobilePlatform["camera"] });
  const settle = async (done: () => boolean) => { for (let i = 0; i < 100 && !done(); i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); }); };
  beforeEach(() => {
    fetcher.mockImplementation(async (input) => String(input).endsWith("/api/cloud/app/sign-in/phone")
      ? response({ cloudContractVersion: 1, accessToken: token, expiresAt: Date.now() + 86_400_000, device: { id: "phone" }, account: owner })
      : response({ v: 1, providers: [], signupOpen: true }));
  });

  it("a signed-out phone logs in to the desktop's account and pairs in one scan", async () => {
    platform = scanning();
    const onLinked = vi.fn();
    await mount(onboarding({ onLinked }));
    await press("[data-entry=scan]");
    await settle(() => onLinked.mock.calls.length > 0);
    expect(phoneCalls()).toHaveLength(1);
    expect(secrets.has("madani.account")).toBe(true);
    expect(onLinked).toHaveBeenCalledWith(expect.objectContaining({ id: "linked" }), "session", expect.any(String));
  });

  it("a phone on another account is asked first, then switches and pairs", async () => {
    secrets.set("madani.account", JSON.stringify({ origin, token, expiresAt: Date.now() + 60_000, account, deviceId: "phone" }));
    platform = scanning();
    const onLinked = vi.fn();
    await mount(onboarding({ onLinked, startAtLink: true, onCancel: vi.fn() }));
    await press("[data-entry=scan]");
    await settle(() => Boolean(host.querySelector("[data-entry=switch-account]")));
    expect(heading()).toBe("Log in as owner@example.com?");
    expect(onLinked).not.toHaveBeenCalled();
    await press("[data-entry=switch-account]");
    await settle(() => onLinked.mock.calls.length > 0);
    expect(phoneCalls()).toHaveLength(1);
    expect(onLinked).toHaveBeenCalled();
  });

  it("a sign-in that does not take never stops the pairing", async () => {
    fetcher.mockImplementation(async (input) => String(input).endsWith("/api/cloud/app/sign-in/phone") ? response({ error: "not found" }, 404) : response({ v: 1, providers: [], signupOpen: true }));
    platform = scanning();
    const onLinked = vi.fn();
    await mount(onboarding({ onLinked }));
    await press("[data-entry=scan]");
    await settle(() => onLinked.mock.calls.length > 0);
    expect(onLinked).toHaveBeenCalled();
    expect(secrets.has("madani.account")).toBe(false);
  });
});

describe("linking can always be left", () => {
  const payload = { v: 1, transport: "https", origin: "https://mac.example.org", credential: `omb_pair_${"a".repeat(43)}`, name: "Studio Mac" } as const;
  it("Cancel works while it links, stops the attempt, and a late answer is dropped", async () => {
    let finish: (value: unknown) => void = () => {};
    let seen: AbortSignal | undefined;
    vi.mocked(redeemPairing).mockImplementationOnce((_payload, _platform, signal) => { seen = signal; return new Promise((resolve) => { finish = resolve as (value: unknown) => void; }) as never; });
    const onLinked = vi.fn();
    const onCancel = vi.fn();
    await mount(onboarding({ initial: payload, onLinked, onCancel, startAtLink: true }));
    const link = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Link")!;
    await act(async () => { link.click(); });
    const cancel = host.querySelector<HTMLButtonElement>("[data-link-cancel]")!;
    expect(cancel.disabled).toBe(false);
    await act(async () => { cancel.click(); });
    expect(seen?.aborted).toBe(true);
    expect(onCancel).toHaveBeenCalledOnce();
    await act(async () => { finish({ record: { id: "late", label: "x" }, token: "t" }); });
    expect(onLinked).not.toHaveBeenCalled();
  });

  it("Android back while it links stops it and steps back", async () => {
    let back: (() => boolean) | undefined;
    platform = { ...platform, onBack: (listener) => { back = listener; return () => { back = undefined; }; } };
    let seen: AbortSignal | undefined;
    vi.mocked(redeemPairing).mockImplementationOnce((_payload, _platform, signal) => { seen = signal; return new Promise(() => {}) as never; });
    await mount(onboarding({ initial: payload }));
    const link = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Link")!;
    await act(async () => { link.click(); });
    let handled: boolean | undefined;
    await act(async () => { handled = back?.(); });
    expect(handled).toBe(true);
    expect(seen?.aborted).toBe(true);
    expect(entries().map((button) => button.dataset.entry)).toEqual(["scan", "signin", "code"]);
  });
});

describe("the camera question comes up in place", () => {
  it("asks the system right away, opens the scanner on yes, and on no stays with one line and Open settings", async () => {
    const request = vi.fn(async () => "denied" as const);
    const openSettings = vi.fn(async () => {});
    platform = { ...platform, camera: { permission: async () => "prompt", request, openSettings, start: async () => ({ stop: async () => {} }) } as unknown as MobilePlatform["camera"] };
    await mount(onboarding());
    await press("[data-entry=scan]");
    expect(request).toHaveBeenCalledOnce();
    expect(heading()).toBe("Your bots, on your phone");
    expect(host.textContent).toContain("Turn the camera on in settings");
    await press("[data-camera-settings]");
    expect(openSettings).toHaveBeenCalledOnce();
  });
});

describe("linking always ends within its deadline", () => {
  const payload = { v: 1, transport: "https", origin: "https://mac.example.org", credential: `omb_pair_${"a".repeat(43)}`, name: "Studio Mac" } as const;
  const linkButton = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Link" || button.textContent === "Try again");

  it("a QR's carried sign-in that never answers and a computer that never answers end at 15 s with can't reach and Try again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fetcher.mockImplementation((input) => String(input).endsWith("/api/cloud/app/sign-in/phone") ? new Promise<Response>(() => {}) : Promise.resolve(response({ v: 1, providers: [], signupOpen: true })));
    let seen: AbortSignal | undefined;
    vi.mocked(redeemPairing).mockImplementationOnce((_payload, _platform, signal) => { seen = signal; return new Promise(() => {}) as never; });
    const onLinked = vi.fn();
    await mount(onboarding({ initial: payload, initialSignIn: { code: "WXYZQRST", email: "owner@example.com" }, onLinked }));
    await act(async () => { linkButton()!.click(); });
    expect(host.querySelector("main")?.getAttribute("aria-busy")).toBe("true");
    await act(async () => { await vi.advanceTimersByTimeAsync(14_000); });
    expect(host.querySelector("[role=alert]")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_100); });
    expect(host.querySelector("main")?.getAttribute("aria-busy")).toBe("false");
    expect(host.querySelector("[role=alert]")?.textContent).toContain("Can't reach your computer");
    expect(linkButton()?.disabled, "its button links again").toBe(false);
    expect(seen?.aborted ?? true).toBe(true);
    expect(onLinked).not.toHaveBeenCalled();
  });

  it("a typed code's lookup and its pairing share the 15 s, never 15 s each", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const linkPayload = {
      v: MOBILE_LINK_VERSION, workspace: { name: "Studio Mac", environmentId: "env-mac", kind: "mac" },
      grant: { id: "grant-1", secret: "s3cret", expiresAt: Date.now() + 5 * 60_000 }, via: [{ kind: "https", url: "https://mac.example.org" }],
    } as MobileLinkPayload;
    const { sealed } = sealLookup("ABCDEFGHJKLM", linkPayload);
    fetcher.mockImplementation(async (input) => {
      if (!String(input).includes("/v1/lookups/")) return response({ v: 1, providers: [], signupOpen: true });
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      return response({ sealed });
    });
    vi.mocked(redeemPairing).mockImplementationOnce(() => new Promise(() => {}) as never);
    await mount(onboarding());
    await press("[data-entry=code]");
    const field = host.querySelector<HTMLInputElement>("input[autocomplete=one-time-code]")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "ABCD-EFGH-JKLM");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { host.querySelector<HTMLFormElement>("form")!.requestSubmit(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_500); });
    expect(vi.mocked(redeemPairing)).toHaveBeenCalled();
    expect(host.querySelector("main")?.getAttribute("aria-busy")).toBe("true");
    await act(async () => { await vi.advanceTimersByTimeAsync(4_600); });
    expect(host.querySelector("main")?.getAttribute("aria-busy")).toBe("false");
    expect(host.querySelector("[role=alert]")?.textContent).toContain("Can't reach your computer");
  });
});

describe("typing a computer's code", () => {
  const field = () => host.querySelector<HTMLInputElement>("input[autocomplete=one-time-code]")!;
  const key = (text: string) => act(async () => {
    const input = field();
    const next = input.value + text;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, next);
    input.setSelectionRange(next.length, next.length);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const lookups = () => fetcher.mock.calls.filter(([input]) => String(input).includes("/v1/lookups/"));
  const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); }); };

  it("adds the dashes as it goes, links by itself on the last character, once, and keeps the keyboard up", async () => {
    fetcher.mockImplementation(async (input) => String(input).includes("/v1/lookups/") ? new Promise<Response>(() => {}) : response({ v: 1, providers: [], signupOpen: true }));
    await mount(onboarding());
    await press("[data-entry=code]");
    for (const letter of "abcdefghjkl") await key(letter);
    expect(field().value).toBe("ABCD-EFGH-JKL");
    expect(field().selectionStart).toBe(13);
    await settle();
    expect(lookups()).toHaveLength(0);
    await key("m");
    await settle();
    expect(field().value).toBe("ABCD-EFGH-JKLM");
    expect(lookups()).toHaveLength(1);
    expect(field().disabled, "a disabled field drops the keyboard").toBe(false);
    expect(field().readOnly).toBe(true);
    await act(async () => { host.querySelector<HTMLFormElement>("form")!.requestSubmit(); });
    await key("n");
    await settle();
    expect(lookups(), "never sent twice").toHaveLength(1);
  });

  it("a pasted code in any form links at once", async () => {
    fetcher.mockImplementation(async (input) => String(input).includes("/v1/lookups/") ? new Promise<Response>(() => {}) : response({ v: 1, providers: [], signupOpen: true }));
    await mount(onboarding());
    await press("[data-entry=code]");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field(), "abcd efgh jklm");
      field().dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(field().value).toBe("ABCD-EFGH-JKLM");
    await settle();
    expect(lookups()).toHaveLength(1);
  });
});
