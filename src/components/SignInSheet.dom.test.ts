// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { stopWaitingInBrowser } from "@/lib/account-intent";
import { closeSignIn, openSignIn } from "@/lib/sign-in-sheet";
import { SignInSheetHost } from "./SignInSheet";
import { AccountsSheet } from "./AccountMenu";

let host: HTMLDivElement, root: Root;
const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
const q = (selector: string) => document.querySelector<HTMLElement>(selector);

function desktop() {
  let status = "signed-out";
  const listeners = new Set<(state: unknown) => void>();
  const cloudAccount = {
    state: vi.fn(async () => ({ status, ...(status === "connected" ? { account: { id: "a", email: "p@qa.madani.test" } } : {}) })),
    continueInBrowser: vi.fn(async () => { status = "connecting"; return { outcome: "browser", state: { status } }; }),
    reopen: vi.fn(async () => ({ status })), cancel: vi.fn(async () => { status = "signed-out"; return { status }; }),
    onState: vi.fn((callback: (state: unknown) => void) => { listeners.add(callback); return () => listeners.delete(callback); }),
  };
  const accounts = { list: vi.fn(async () => ({ active: null, saved: [] })), onChanged: vi.fn(() => () => {}), signOut: vi.fn() };
  vi.stubGlobal("madaniDesktop", { cloudAccount, accounts });
  const become = async (next: string) => { status = next; await act(async () => { for (const listen of listeners) listen({ status, ...(next === "connected" ? { account: { id: "a" } } : {}) }); }); await settle(); };
  return { cloudAccount, become };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); closeSignIn(); stopWaitingInBrowser(); host.remove(); document.body.innerHTML = ""; vi.unstubAllGlobals(); });

it("sign in continues in the browser for its context, with one calm sheet: Open again and Cancel, never Settings", async () => {
  const { cloudAccount } = desktop();
  await act(async () => { root.render(createElement(SignInSheetHost)); });
  await act(async () => { openSignIn(); });
  await settle();
  expect(cloudAccount.continueInBrowser).toHaveBeenCalledWith({ kind: "signin" });
  expect(q("[data-continue-in-browser=signin]")?.textContent).toContain("Continue in your browser");
  await act(async () => { q("[data-continue-open]")!.click(); });
  expect(cloudAccount.reopen).toHaveBeenCalledTimes(1);
  await act(async () => { q("[data-continue-cancel]")!.click(); });
  await settle();
  expect(cloudAccount.cancel).toHaveBeenCalledTimes(1);
  expect(q("[data-continue-in-browser]")).toBeNull();
});

it("finished in the browser: the app signs itself in, the sheet goes and what the person was doing goes on", async () => {
  const { become } = desktop();
  const then = vi.fn();
  await act(async () => { root.render(createElement(SignInSheetHost)); });
  await act(async () => { openSignIn({ after: then }); });
  await settle();
  expect(q("[data-continue-in-browser]")).toBeTruthy();
  await become("connected");
  expect(q("[data-continue-in-browser]")).toBeNull();
  expect(then).toHaveBeenCalledTimes(1);
});

it("the account sheet over a place, with nobody signed in, continues in the browser at once", async () => {
  const { cloudAccount } = desktop();
  await act(async () => { root.render(createElement(AccountsSheet, { onClose: () => {} })); });
  await settle();
  expect(cloudAccount.continueInBrowser).toHaveBeenCalledWith({ kind: "signin" });
  expect(q("[data-continue-in-browser]")).toBeTruthy();
});
