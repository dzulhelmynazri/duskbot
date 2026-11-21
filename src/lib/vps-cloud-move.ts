import { useEffect, useState } from "react";
import type { CloudOffer } from "../../electron/cloud-home.mjs";

export type VpsMoveRoute = "direct" | "via-mac";
export interface VpsMoveCounts { bots?: number; chats?: number; routines?: number; skills?: number; [key: string]: unknown }

export type VpsCloudMoveView =
  | { stage: "none"; cloud: "signed-out" | "none" | "starting" | "ready" }
  | { stage: "buying" | "waiting"; place: string; route: VpsMoveRoute; /** the purchase waits on the sign-in main opened over this page */ signingIn?: true }
  | { stage: "moving"; place: string; route: VpsMoveRoute; phase: string; chats?: { done: number; total: number }; waitingFor?: string; retrying?: boolean; error?: string | null }
  | { stage: "fallback"; place: string; route: "via-mac"; why?: "outdated" | "vps_failing"; phase?: string }
  | { stage: "failed"; place: string; route: VpsMoveRoute; error: string | null }
  | { stage: "done"; place: string; route: VpsMoveRoute; counts?: VpsMoveCounts; stays?: string };

export interface VpsCloudMoveBridge {
  view(): Promise<VpsCloudMoveView>;
  /** The four below need the person's click. */
  start(): Promise<VpsCloudMoveView>;
  /** Opens the plans on madani.bot already signed in; signed out, main opens the sign-in here first (`signingIn`) and the
   *  checkout follows it by itself. Rejects with "Sign in to madani cloud first." only where this app has no sign-in. */
  buy(plan?: "plus" | "pro"): Promise<VpsCloudMoveView>;
  /** What madani cloud sells, signed in or out; absent on an older app. */
  offer?(): Promise<CloudOffer | null>;
  retry(): Promise<VpsCloudMoveView>;
  /** The sign-in a purchase waits on, opened again. */
  signIn?(): Promise<VpsCloudMoveView>;
  /** Only before anything moved. */
  cancel(): Promise<VpsCloudMoveView>;
  onChange(callback: (view: VpsCloudMoveView) => void): () => void;
  /** True once when the person asked for this server's move sheet from elsewhere (the rail, the dashboard). */
  asked?(): Promise<boolean>;
  onShow?(callback: () => void): () => void;
}

export const SIGN_IN_FIRST = "Sign in to madani cloud first.";

export function vpsCloudMoveBridge(): VpsCloudMoveBridge | null {
  const bridge = typeof window === "undefined" ? undefined : window.madaniDesktop?.vpsCloudMove;
  return bridge ?? null;
}

/** The move's view as main tells it: read once, then every change. Null until the first answer, or with no bridge. */
export function useVpsCloudMove(enabled: boolean): { bridge: VpsCloudMoveBridge | null; view: VpsCloudMoveView | null; set: (view: VpsCloudMoveView) => void } {
  const bridge = enabled ? vpsCloudMoveBridge() : null;
  const [view, setView] = useState<VpsCloudMoveView | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let alive = true, changed = false;
    const off = bridge.onChange((next) => { changed = true; if (alive) setView(next); });
    void bridge.view().then((next) => { if (alive && !changed) setView(next); }, () => {});
    return () => { alive = false; off(); };
  }, [bridge]);
  return { bridge, view: bridge ? view : null, set: setView };
}

/** The plans' price: cloudAdd is the one account bridge a server's page gets. */
export function useVpsCloudOffer(enabled: boolean): CloudOffer | null {
  const move = enabled ? window.madaniDesktop?.vpsCloudMove : undefined;
  const add = enabled ? window.madaniDesktop?.cloudAdd : undefined;
  const [offer, setOffer] = useState<CloudOffer | null>(null);
  useEffect(() => {
    let alive = true;
    if (move?.offer) void move.offer().then((next) => { if (alive && next) setOffer(next); }, () => {});
    else if (add?.state) void add.state().then((view) => { if (alive && view.signedIn) setOffer(view.offer); }, () => {});
    return () => { alive = false; };
  }, [move, add]);
  return offer;
}

/** the plan Get madani cloud buys: the cheapest one on offer (Plus) */
export function cheapestPlan(offer: CloudOffer | null): CloudOffer["plans"][number] | null {
  return offer?.plans.length ? offer.plans.reduce((low, plan) => (plan.amount < low.amount ? plan : low)) : null;
}
