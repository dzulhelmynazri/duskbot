import { useEffect, useState } from "react";
import { HANDED_KEY } from "./switch-hold-key";

let opened: boolean | undefined;

/** This page was opened by a switch of place (main says so, or the page before handed its mascot on). Read once per
 * page: it stays true for the page's life. */
export function openedBySwitch(): boolean {
  if (opened !== undefined) return opened;
  if (typeof window === "undefined") return false;
  try {
    opened = window.madaniDesktop?.workspaces?.arrived?.() === true || Boolean((window as unknown as Record<string, unknown>)[HANDED_KEY]);
  } catch {
    opened = false;
  }
  return opened;
}

/** A switch of place is under way, or this page is the one it opened: no time for a corner card. */
export function usePlaceSwitchQuiet(): boolean {
  const [switching, setSwitching] = useState(false);
  useEffect(() => window.madaniDesktop?.workspaces?.onSwitching?.(setSwitching), []);
  return switching || openedBySwitch();
}

/** Tests only. */
export function forgetPlaceSwitch(): void {
  opened = undefined;
}
