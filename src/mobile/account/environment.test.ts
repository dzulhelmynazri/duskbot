// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chooseAccountOrigin, chosenAccountOrigin, environmentName, followSignInService, PREVIEW_ORIGIN, PRODUCTION_ORIGIN, signInServiceSwitch, takeHeldSignIn } from "./environment";
import { mobileAccountOrigin } from "./AccountGate";

const memory = () => { const map = new Map<string, string>(); return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) }; };
beforeEach(() => { vi.stubGlobal("localStorage", memory()); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("a store build signs in to madani.bot unless someone testing chose the preview stack, and can go back", () => {
  const store = memory();
  expect(chosenAccountOrigin(store)).toBe(PRODUCTION_ORIGIN);
  chooseAccountOrigin(PREVIEW_ORIGIN, store);
  expect(chosenAccountOrigin(store)).toBe(PREVIEW_ORIGIN);
  chooseAccountOrigin(PRODUCTION_ORIGIN, store);
  expect(chosenAccountOrigin(store)).toBe(PRODUCTION_ORIGIN);
});

it("the native app follows that choice, and a build's configured origin still wins", () => {
  expect(mobileAccountOrigin(true, new URLSearchParams())).toBe(PRODUCTION_ORIGIN);
  chooseAccountOrigin(PREVIEW_ORIGIN);
  expect(mobileAccountOrigin(true, new URLSearchParams())).toBe(PREVIEW_ORIGIN);
  vi.stubEnv("VITE_MADANI_ACCOUNT_ORIGIN", "https://configured.example");
  expect(mobileAccountOrigin(true, new URLSearchParams())).toBe("https://configured.example");
});

it("names every stack but madani.bot's own", () => {
  expect(environmentName(PRODUCTION_ORIGIN)).toBeNull();
  expect(environmentName(PREVIEW_ORIGIN)).toBe("Preview");
  expect(environmentName("http://127.0.0.1:9000")).toBe("127.0.0.1:9000");
});

it("a desktop's sign-in qr made on the other service moves the phone there and reopens the link once, after it reloads", async () => {
  const signOut = vi.fn(async () => {});
  const reload = vi.fn();
  const link = "https://madani.bot/m/signin#c=ABCDEFGH&email=a%40b.test&s=preview";
  expect(followSignInService(link, "production", { origin: PRODUCTION_ORIGIN, signOut }, reload)).toBe(false);
  expect(followSignInService(link, undefined, { origin: PRODUCTION_ORIGIN, signOut }, reload)).toBe(false);
  expect(followSignInService(link, "preview", { origin: PRODUCTION_ORIGIN, signOut }, reload)).toBe(true);
  await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
  expect(signOut).toHaveBeenCalledOnce();
  expect(chosenAccountOrigin()).toBe(PREVIEW_ORIGIN);
  expect(takeHeldSignIn()).toBe(link);
  expect(takeHeldSignIn()).toBeNull();
  // back on preview, the same link belongs here
  expect(signInServiceSwitch("preview", PREVIEW_ORIGIN)).toBeNull();
  expect(signInServiceSwitch("production", PREVIEW_ORIGIN)).toBe(PRODUCTION_ORIGIN);
});
