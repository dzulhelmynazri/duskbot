import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import { teamPlan } from "../../electron/cloud-team-plan.mjs";
import type { LocaleKey } from "@/locales";
import { cloudPlanView } from "./cloud-plan";
import type { Action } from "@/state/store";
import { isOwnerOrAdmin, readSessionState, type SessionState } from "./session";
import { PHONE_PAIRING_ACTION as PHONE_PAIRING_WIDGET_ACTION, type WidgetNode, type WidgetRoot } from "../../shared/widget";

export type PhonePairingTarget = "computer" | "cloud" | "server";

export const phonePairingSettingsAction = (): Extract<Action, { type: "toggleAppSettings" }> => ({
  type: "toggleAppSettings",
  open: true,
  section: "companion",
  phonePairing: true,
});

export function currentPhonePairingTarget(cloudHome: boolean): PhonePairingTarget {
  const madaniDesktop = typeof window === "undefined" ? undefined : (window.madaniDesktop as { companion?: unknown; remoteClient?: { active?: boolean } } | undefined);
  return phonePairingTarget({ companion: Boolean(madaniDesktop?.companion), remoteClient: madaniDesktop?.remoteClient?.active === true, cloudHome });
}

export function phonePairingTarget(input: { companion: boolean; remoteClient: boolean; cloudHome: boolean }): PhonePairingTarget {
  if (input.cloudHome) return "cloud";
  return input.companion && !input.remoteClient ? "computer" : "server";
}

export interface PhonePairingAccess {
  session: SessionState | null;
  pairingCodes: boolean;
}

export interface ConnectPhoneEntry {
  target: PhonePairingTarget;
  subtitleKey: LocaleKey;
  /** A Team Cloud's name: everyone in the team opens it on their own phone. */
  team?: string;
}

const SUBTITLE: Record<PhonePairingTarget, LocaleKey> = {
  computer: "sidebar.menu.connectPhone.computer",
  cloud: "sidebar.menu.connectPhone.cloud",
  server: "sidebar.menu.connectPhone.server",
};

export function connectPhoneEntry(target: PhonePairingTarget, access: PhonePairingAccess | null): ConnectPhoneEntry | null {
  const team = access?.session?.kind === "session" ? access.session.team?.name : undefined;
  if (team) return { target, subtitleKey: "sidebar.menu.connectPhone.team", team };
  if (target !== "computer" && !(access && access.pairingCodes && isOwnerOrAdmin(access.session))) return null;
  return { target, subtitleKey: SUBTITLE[target] };
}

export type CloudPhoneDestination = "ready" | "not-ready" | null;

export function cloudPhoneDestination(account: CloudAccountState | null | undefined): CloudPhoneDestination {
  if (cloudPlanView(account).kind !== "paid" || teamPlan(account)) return null;
  return account?.status === "connected" && account.machine?.status === "ready" ? "ready" : "not-ready";
}

export interface PhoneDestination extends ConnectPhoneEntry {
  id: "cloud" | "here";
  noteKey?: LocaleKey;
}

export function phoneDestinations(entry: ConnectPhoneEntry | null, cloud: CloudPhoneDestination): PhoneDestination[] {
  if (!entry) return [];
  const here: PhoneDestination = { ...entry, id: "here" };
  if (entry.target !== "computer" || !cloud) return [here];
  if (cloud === "not-ready") return [{ ...here, noteKey: "sidebar.menu.connectPhone.cloudNotReady" }];
  return [{ id: "cloud", target: "cloud", subtitleKey: "sidebar.menu.connectPhone.cloudAlwaysOn" }, here];
}

let pending: Promise<PhonePairingAccess> | null = null;

export function loadPhonePairingAccess(fetchImpl: typeof fetch = fetch): Promise<PhonePairingAccess> {
  pending ??= readSessionState(fetchImpl).then(async (session): Promise<PhonePairingAccess> => {
    if (!isOwnerOrAdmin(session)) return { session, pairingCodes: false };
    return { session, pairingCodes: true };
  });
  return pending;
}

export function resetPhonePairingAccess(): void {
  pending = null;
}

const PHONE_PAIRING_ACTION = "data-phone-pairing-action";

interface PairingRoot {
  scrollIntoView?: (options: ScrollIntoViewOptions) => void;
  querySelector: (selector: string) => { focus: (options?: FocusOptions) => void } | null;
  focus: (options?: FocusOptions) => void;
}

/** Deferred a frame: Settings settles its own scroll position after its sections' effects run. Only as far as needed:
 * the phone page opens with its pairing ways already in view under what the phone app is, which must stay on screen. */
export function revealPhonePairing(
  root: PairingRoot | null,
  schedule: (callback: () => void) => unknown = (callback) => window.requestAnimationFrame(callback),
): boolean {
  if (!root) return false;
  schedule(() => {
    root.scrollIntoView?.({ block: "nearest" });
    (root.querySelector(`[${PHONE_PAIRING_ACTION}]:not([disabled])`) ?? root).focus({ preventScroll: true });
  });
  return true;
}

/** `?desktop-settings=phone` only opens Settings on the phone pairing; it never makes a code by itself. */
export function takePhonePairingRequest(href: string): string | null {
  const url = new URL(href);
  if (url.searchParams.get("desktop-settings") !== "phone") return null;
  url.searchParams.delete("desktop-settings");
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Where a page signed in by the app goes next: the phone pairing, or back to a path of this same server. */
export function pairedDestination(search: string): string {
  const params = new URLSearchParams(search);
  if (params.get("desktop-settings") === "phone") return "/?desktop-settings=phone";
  const next = params.get("next");
  return next && /^\/(?!\/)/.test(next) && !next.startsWith("/pair") && !/[\\\s]/.test(next) ? next : "/";
}

const pairsPhone = (action: unknown): boolean =>
  typeof action === "object" && action !== null && (action as { type?: unknown }).type === PHONE_PAIRING_WIDGET_ACTION;

/** A bot's card without its phone-pairing buttons and rows, for while the phone app is hidden: nothing to press that
 * goes nowhere. */
export function withoutPhonePairing(root: WidgetRoot): WidgetRoot {
  const prune = (node: WidgetNode): WidgetNode => {
    if (!Array.isArray(node.children)) return node;
    const children = node.children
      .filter((child) => !((child.type === "Button" || child.type === "ListViewItem") && pairsPhone(child.onClickAction)))
      .map(prune);
    return { ...node, children };
  };
  const pruned = prune(root);
  for (const key of ["confirm", "cancel"] as const) {
    const spec = pruned[key];
    if (typeof spec === "object" && spec !== null && pairsPhone((spec as { action?: unknown }).action)) delete pruned[key];
  }
  return pruned;
}
