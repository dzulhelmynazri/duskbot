import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { storeApp } from "@/lib/store-app";
import type { CloudSource } from "@/lib/cloud-plan";
import { investedBy, type InvestedFacts } from "../../shared/cloud-upsell";
import { firstChatQuiet, firstReplyPending } from "@/lib/corner-popup";
import { cloudUpsellAllowed, investedFacts, isInvested, markAlwaysOn, trackUpsell, watchUpsell } from "@/lib/cloud-upsell";
import { endNudge, nextNudgeAt, noteNudgeSession, nudgeDay, nudgeEligible, nudgeShowing, nudgeVersion, takeNudge, watchNudge } from "@/lib/cloud-nudge";
import { CLOUD_INTRO, dismissNotice, INVESTED_NOTICE, LATE_ROUTINE_NOTICE, launchNotice, noticeSeen, watchLaunchNotice } from "@/lib/notices";
import { t } from "@/lib/i18n";
import { api, useStore } from "@/state/store";
import { SpotCloudCard, SpotCtaCard, type SpotCta } from "./SidebarSpot";
import { localDesktopPage } from "./onboarding/WelcomeGate";
import { useCloudPlan } from "./ProIntroduction";
import { deviceWord } from "./vps-link/parts";

/** whether this computer's page may offer madani cloud at all: someone who could buy it (signed out or free), no organization,
 * not already on a cloud or under a managed policy. null while the plan or organization is still loading. */
export function useCloudUpsell(): { allowed: boolean | null; open: (source: CloudSource) => void } {
  const { state, dispatch } = useStore();
  const plan = useCloudPlan();
  const organization = window.madaniDesktop?.organization;
  const [managed, setManaged] = useState<boolean | null>(organization ? null : false);
  useEffect(() => {
    if (!organization) return;
    let active = true, updated = false;
    const accept = (next: Awaited<ReturnType<typeof organization.state>>) => {
      if (active) setManaged(next.status !== "signed-out" && Boolean(next.organization));
    };
    const unsubscribe = organization.onState(next => { updated = true; accept(next); });
    void organization.state().then(next => { if (!updated) accept(next); }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, [organization]);
  const here = !storeApp() && localDesktopPage() && window.madaniDesktop?.remoteClient?.active !== true && Boolean(state.config)
    && !state.config?.cloudHome && !state.config?.managedPolicy;
  const allowed = cloudUpsellAllowed({ here, view: plan?.view ?? null, managed });
  const signedOut = plan?.view.kind === "signed-out";
  const open = (source: CloudSource) => dispatch({ type: "openCloudAdd", source, ...(signedOut ? { signIn: true as const } : {}) });
  return { allowed, open };
}

const CLOUD_NOTICES = new Set<string>([CLOUD_INTRO, LATE_ROUTINE_NOTICE]);
const INVESTED_LINE = { bots: "cloudUpsell.invested.bots", messages: "cloudUpsell.invested.messages", routines: "cloudUpsell.invested.routines" } as const;
// the invested pitch holds the card for the rest of the launch it first showed in
let launchInvested: InvestedFacts | null = null;

/** the madani cloud offer in the sidebar's spot, in Give feedback's place, as the website's sidebar card: at most twice a
 * day the app is used (lib/cloud-nudge.ts), never during first run, and only for an account without madani cloud. A launch
 * that already showed a cloud notice in the corner leaves it out, so the pitch is said once. Someone clearly invested
 * (shared/cloud-upsell.ts INVESTED) gets it in their own numbers instead, once per account. `covered`: an update holds the
 * spot, so no showing starts under it. */
export function useSidebarCloudCta(covered = false): SpotCta | null {
  return useSidebarOfferCta(covered);
}

function useSidebarOfferCta(covered: boolean): SpotCta | null {
  const { state, dispatch } = useStore();
  const { allowed, open } = useCloudUpsell();
  const [held, setHeld] = useState<InvestedFacts | null>(launchInvested);
  const [, setTick] = useState(0);
  useSyncExternalStore(watchNudge, nudgeVersion, nudgeVersion);
  const settled = firstReplyPending(state) === false && !firstChatQuiet(state) && !state.welcomeOpen;
  // a corner cloud card claiming this launch hides this one right away: one madani cloud offer on screen at a time
  const notice = useSyncExternalStore(watchLaunchNotice, launchNotice, () => null);
  const eligible = !covered && nudgeEligible({ allowed, settled, cornerCard: Boolean(notice && CLOUD_NOTICES.has(notice)) });
  const showing = nudgeShowing();
  const visible = eligible && showing;
  const record = state.config?.onboarding;
  const due = visible && !held && !noticeSeen(record, INVESTED_NOTICE) && isInvested(state) ? investedFacts(state) : null;
  const invested = held ?? due;
  const by = invested ? investedBy(invested) : null;
  const source: CloudSource = by ? "app_invested" : "app_sidebar";
  useEffect(() => { noteNudgeSession(); }, []);
  // not showing yet: start a showing when one is due, or wake up when the next one will be
  useEffect(() => {
    if (!eligible || showing) return;
    if (takeNudge()) return;
    const at = nextNudgeAt(nudgeDay());
    if (at === null) return;
    const timer = setTimeout(() => setTick(tick => tick + 1), Math.min(Math.max(at - Date.now(), 1000), 2 ** 31 - 1));
    return () => clearTimeout(timer);
  });
  const reported = useRef(false);
  useEffect(() => {
    if (!visible || reported.current) return;
    reported.current = true;
    trackUpsell("shown", source);
    if (!due) return;
    launchInvested = due;
    setHeld(due);
    const patch = dismissNotice(record, INVESTED_NOTICE);
    if (patch) void api("/api/config", { method: "PUT", body: JSON.stringify(patch) }).then(config => dispatch({ type: "configStatus", config })).catch(() => {});
  }, [visible]);
  useEffect(() => { if (!visible) reported.current = false; }, [visible]);
  useEffect(() => { if (visible) return watchUpsell(source); }, [visible, source]);
  if (!visible) return null;
  const device = deviceWord();
  const title = by && invested ? t(INVESTED_LINE[by], { count: invested[by] }) : t("cloudUpsell.nudge.title");
  return {
    id: by ? "cloud-invested" : "cloud",
    title,
    hint: t(by ? "cloudUpsell.invested.body" : "cloudUpsell.nudge.body", { device }),
    art: "clock",
    closeLabel: t("cloudUpsell.hide"),
    card: by ? { title, body: t("cloudUpsell.invested.body", { device }), action: t("runsOn.getCloud"), invested: true }
      : { body: t("cloudUpsell.side.body", { device }), action: t("cloudUpsell.side.action"), invested: false },
    onClose: () => { trackUpsell("dismiss", source); endNudge(); },
    onStart: () => { trackUpsell("click", source); endNudge(); open(source); },
  };
}

/** the offer on its own, as the spot draws it */
export function SidebarCloudCard() {
  const cta = useSidebarCloudCta();
  return cta ? (cta.card ? <SpotCloudCard cta={cta} card={cta.card} /> : <SpotCtaCard cta={cta} />) : null;
}

/** the 24/7 line inside a flow that makes something run on its own (a schedule, an app event, another app sending
 * something) on this computer: it only runs while the computer is awake. Seeing it starts the same cooldown as the
 * new-routine dialog, so that dialog does not repeat it. */
export function AlwaysOnNote({ className }: { className?: string }) {
  const { allowed, open } = useCloudUpsell();
  const { state } = useStore();
  const shown = useRef(false);
  const visible = allowed === true && firstReplyPending(state) === false;
  useEffect(() => {
    if (!visible || shown.current) return;
    shown.current = true;
    markAlwaysOn();
    trackUpsell("shown", "app_always_on");
  }, [visible]);
  useEffect(() => { if (visible) return watchUpsell("app_always_on"); }, [visible]);
  if (!visible) return null;
  return (
    <p data-always-on-note="" className={`m-0 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-[12px] leading-4 text-ink-secondary ${className ?? ""}`}>
      <span>{t("cloudUpsell.alwaysOn", { device: deviceWord() })}</span>
      <button type="button" className="cursor-pointer rounded-[4px] font-medium text-accent-text underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
        onClick={() => { trackUpsell("click", "app_always_on"); open("app_always_on"); }}>{t("cloudUpsell.alwaysOnAction")}</button>
    </p>
  );
}
