import { useSyncExternalStore } from "react";
import { hintSeen, type OnboardingStatus } from "@/lib/onboarding";

/** Kept by an install whose cloud was made or opened from this computer's first run, or by the one late hand-off: the
 * hand-off never runs again. */
export const CLOUD_OPENED_HERE = "cloud-opened-here-v1";

/** The first run's record, kept as the one that made its cloud from here when it went the madani cloud way. */
export function cloudOpenedHere<Patch extends { onboarding: { hintsSeen?: string[] } }>(patch: Patch, cloud: boolean, had: readonly string[] = []): Patch {
  if (!cloud) return patch;
  const hints = patch.onboarding.hintsSeen ?? [...had];
  return hints.includes(CLOUD_OPENED_HERE) ? patch : { ...patch, onboarding: { ...patch.onboarding, hintsSeen: [...hints, CLOUD_OPENED_HERE] } };
}

interface OwnCloudAccount {
  status?: string;
  purchase?: unknown;
  renewal?: unknown;
  machine?: { status: string };
  clouds?: Array<{ primary: boolean; runsOn: string; role?: string; status: string }>;
}

export type OwnCloudStage = "making" | "made";

const MADE = ["ready", "stopped", "offline", "payment_problem"];

/** The account's own cloud, never a team's Cloud someone else pays for: "making" while its paid plan's cloud is being
 * made or not made yet, "made" once it exists (ready, asleep, stopped, offline); null without one. */
export function ownCloudStage(account: OwnCloudAccount | null | undefined): OwnCloudStage | null {
  if (account?.status !== "connected") return null;
  if (account.clouds) {
    const own = account.clouds.find((cloud) => cloud.primary && cloud.runsOn === "cloud" && cloud.role === "owner");
    if (!own) return null;
    if (own.status === "setting_up") return "making";
    return MADE.includes(own.status) ? "made" : null;
  }
  const machine = account.machine?.status;
  const paid = Boolean(account.purchase || account.renewal);
  if (paid && machine && machine !== "provisioning" && machine !== "failed") return "made";
  if (account.purchase) return "making";
  return paid && machine === "provisioning" ? "making" : null;
}

/** A plan that arrived after this computer's first run ended (a late payment, one bought on the website later), with no
 * cloud made or opened from here yet. "making": the person is taken into the cloud being made, once. "made": the cloud
 * already exists, so the hint is only recorded. A page a switch of place opened shows that place, never the making. */
export function lateCloudDue(facts: {
  local: boolean;
  canSave: boolean;
  config: { onboarding?: OnboardingStatus; team?: unknown; cloudHome?: boolean } | null | undefined;
  account: OwnCloudAccount | null | undefined;
  welcomeShown: boolean;
  switched?: boolean;
}): OwnCloudStage | null {
  const { config } = facts;
  if (!facts.local || !facts.canSave || facts.welcomeShown || !config || config.team || config.cloudHome) return null;
  if (!config.onboarding?.completedAt || hintSeen(config.onboarding, CLOUD_OPENED_HERE)) return null;
  const stage = ownCloudStage(facts.account);
  return stage === "making" && facts.switched ? null : stage;
}

let lateCloudShown = false;
const lateCloudListeners = new Set<() => void>();
/** The late plan's making screen covers the window: corner cards wait until it closes. */
export function setLateCloudOnScreen(on: boolean): void {
  if (lateCloudShown === on) return;
  lateCloudShown = on;
  lateCloudListeners.forEach((listener) => listener());
}
export function useLateCloudOnScreen(): boolean {
  return useSyncExternalStore((listener) => { lateCloudListeners.add(listener); return () => { lateCloudListeners.delete(listener); }; },
    () => lateCloudShown, () => false);
}
