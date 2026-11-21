// The account context redirect, the app side: every account step (sign in, upgrade or buy madani cloud, move bots to the
// cloud, billing) goes to the browser for its context, and the app shows one calm "Continue in your browser" sheet with
// Open again and Cancel while it waits. Returning to the app is optional: the app signs itself in when the browser
// sign-in is approved, and a purchase is picked up when the account changes.
//
//   import { continueInBrowser } from "@/lib/account-intent";
//   await continueInBrowser({ kind: "upgrade", plan: "pro", source: "app_onboarding", move: "computer" });
//
// The intent is bound to the browser sign-in on the account service (never trusted from a URL), or carried by the
// one-time web handoff when already signed in; the website lands on the plan checkout, billing or home.
import { useSyncExternalStore } from "react";
import type { AccountIntent } from "../../shared/account-api";

export type { AccountIntent } from "../../shared/account-api";
export type ContinueOutcome = "opened" | "browser" | "failed" | "unavailable";

let waiting: AccountIntent | null = null;
const watchers = new Set<() => void>();
const tell = () => { for (const watch of Array.from(watchers)) watch(); };

/** Opens the browser for `intent`; while a sign-in is under way the app shows the "Continue in your browser" sheet. */
export async function continueInBrowser(intent: AccountIntent): Promise<ContinueOutcome> {
  const bridge = typeof window === "undefined" ? undefined : window.madaniDesktop?.cloudAccount;
  if (!bridge?.continueInBrowser) return "unavailable";
  const answer = await bridge.continueInBrowser(intent);
  if (answer.outcome === "browser") { waiting = intent; tell(); }
  return answer.outcome;
}
/** the sheet is done (signed in, or the person cancelled) */
export function stopWaitingInBrowser(): void { waiting = null; tell(); }
/** the intent the app waits on in the browser, or null */
export function useWaitingInBrowser(): AccountIntent | null {
  return useSyncExternalStore((watch) => { watchers.add(watch); return () => { watchers.delete(watch); }; }, () => waiting, () => null);
}
