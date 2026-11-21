import { useEffect, useState } from "react";
import { openSignIn } from "@/lib/sign-in-sheet";
const browserSignIn = () => Boolean(window.madaniDesktop?.cloudAccount?.continueInBrowser);
import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import type { CloudOffer } from "../../electron/cloud-home.mjs";
import { api, useStore } from "@/state/store";
import { track } from "@/lib/analytics";
import { buyOfferAllowed, cloudNoticeKind, cloudPlanView, cloudTrialNotice, cloudTrialView, offerTrialDays } from "@/lib/cloud-plan";
import { jobRoutine, useCloudIntent } from "@/lib/cloud-intent";
import { isInvested } from "@/lib/cloud-upsell";
import { CLOUD_INTENT_GIVEN, cloudSetupStage } from "@/lib/cloud-setup";
import { cornerPopupWaits, firstChatQuiet } from "@/lib/corner-popup";
import { ASLEEP_NOTICE, BRING_NOTICE, CLOUD_INTRO, CLOUD_NOTICE, CLOUD_TRIAL_NOTICE, dismissNotice, GROK_MOVE_NOTICE, introShown, introStage, LATE_ROUTINE_NOTICE, launchNotice, markLaunchNotice, nextNotice, noticeSeen, TWO_PLACES_NOTICE, usedBefore, WHATS_NEW_NOTICE } from "@/lib/notices";
import { lateRoutineRun } from "@/lib/late-routine";
import { asleepFresh, useAsleepWork } from "@/lib/asleep-work";
import { trackUpsell } from "@/lib/cloud-upsell";
import { useAllowanceNotice } from "@/lib/allowance-notice";
import { useTwoPlaces } from "@/lib/two-places";
import { useUpdateDigest } from "@/lib/update-digest";
import { useServerBehindHint } from "@/lib/server-behind";
import { useBringNotice } from "@/lib/bring-notice";
import { focusBringFind, knowsLine } from "@/lib/first-run-import";
import { cloudSignInDue, onboardingCloudOffered, useWelcomeOnScreen, type WelcomeViewer } from "@/lib/onboarding";
import { t } from "@/lib/i18n";
import { engineReady } from "./EngineLibrary";
import { CLOUD_NOTICE_CARD, cloudNoticeStep, CloudNoticeCard } from "./CloudNotice";
import { CloudTrialIntroCard } from "./CloudTrialIntro";
import { AsleepWorkCard, LateRoutineCard } from "./LateRoutineCard";
import { useMoveQuiet } from "./CloudSendStrip";
import { CloudTrialNoticeCard, useCloudPlanSnapshot } from "./CloudTrialNotice";
import { NoticeCard, NoticeToast, NotNowButton, PRIMARY_BUTTON } from "./NoticeCard";
import { Download } from "../icons";
import { useDesktopNotices } from "./notice-dialogs";
import { useLateCloudOnScreen } from "./onboarding/late-cloud";
import { localDesktopPage } from "./onboarding/WelcomeGate";
import { TwoPlacesCard } from "./TwoPlacesCard";
import { FeedbackCard } from "./FeedbackCard";
import { feedbackDue } from "@/lib/feedback-prompt";
import { noticeActed, noticeClosed, noticeOnScreen } from "@/lib/notice-clock";

const trialKey = (trial: { state: string; endsAt: number }) => `${trial.state}:${trial.endsAt}`;

export function AppNotices({ quiet = false, viewer = null, now = Date.now }: { quiet?: boolean; viewer?: WelcomeViewer | null; now?: () => number }) {
  const { state, dispatch } = useStore();
  const remote = window.madaniDesktop?.remoteClient?.active === true;
  const local = localDesktopPage();
  const bridge = !remote && local ? window.madaniDesktop?.cloudAccount : undefined;
  const desktop = remote ? undefined : window.madaniDesktop?.desktopNotices;
  const desktopState = useDesktopNotices(desktop);
  // Asked once main has restored the Cloud sign-in, which it waits for before answering desktopState.
  const planBridge = !remote && (bridge || (viewer?.cloudHome && (desktopState || !desktop))) ? window.madaniDesktop?.cloudPlan : undefined;
  const [account, setAccount] = useState<CloudAccountState | null>(null);
  const plan = useCloudPlanSnapshot(planBridge);
  const [offer, setOffer] = useState<CloudOffer | null | undefined>(undefined);
  const [organization, setOrganization] = useState<boolean | null>(window.madaniDesktop?.organization ? null : false);
  const [closed, setClosed] = useState(false);
  const [introOpen, setIntroOpen] = useState(false);
  const [trialOpen, setTrialOpen] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [askFeedback, setAskFeedback] = useState(() => feedbackDue());
  const intent = useCloudIntent();
  const moving = useMoveQuiet(now);
  // only a server install (a Cloud home, a VPS) has a line: the desktop app's own server never updates itself
  const digest = useUpdateDigest();
  // the weekly allowance at 80% and at 100%: one quiet line each, never in a chat, the amounts left to Usage
  const allowance = useAllowanceNotice();
  // this app's page on an older server: what it hides, said once
  const behind = useServerBehindHint();
  // Bots in two places: this computer's page only, where main knows what lives here.
  const two = useTwoPlaces();
  const twoFact = !local || two.suggest === null ? false : two.suggest === undefined ? null : true;
  // other AI tools here with memory or skills never brought in: the import, offered once
  const bring = useBringNotice();
  const welcomeCovers = useWelcomeOnScreen(), makingCovers = useLateCloudOnScreen();
  useEffect(() => {
    if (!bridge) return;
    let active = true, updated = false;
    const unsubscribe = bridge.onState(next => { updated = true; if (active) setAccount(next); });
    void bridge.state().then(next => { if (active && !updated) setAccount(next); }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, [bridge]);
  useEffect(() => {
    const org = window.madaniDesktop?.organization;
    if (!org) return;
    let active = true;
    const read = (next: { status: string; organization?: unknown }) => { if (active) setOrganization(next.status !== "signed-out" && Boolean(next.organization)); };
    const unsubscribe = org.onState(read);
    void org.state().then(read, () => { if (active) setOrganization(false); });
    return () => { active = false; unsubscribe(); };
  }, []);
  const view = bridge ? cloudPlanView(account) : null;
  const record = state.config?.onboarding;
  const introAllowed = Boolean(bridge) && organization !== true && !onboardingCloudOffered(record);
  const stage = introStage(record, now());
  const trialDue = cloudTrialNotice(plan);
  const wantOffer = Boolean(bridge?.offer) && introAllowed && view !== null && buyOfferAllowed(view) && stage !== "done";
  const offerKey = wantOffer ? `${view?.kind}:${JSON.stringify(account?.offer ?? null)}` : null;
  useEffect(() => {
    if (!offerKey || !bridge?.offer) return;
    let active = true;
    const answer = (next: CloudOffer | null) => { if (active) setOffer(next); };
    void bridge.offer().then(answer, () => answer(null));
    return () => { active = false; };
  }, [offerKey, bridge]);

  const trial = plan?.trial;
  const key = trial ? trialKey(trial) : null;
  const setupRecord = record && (intent.pending || intent.sent) ? { ...record, hintsSeen: [...record.hintsSeen, CLOUD_INTENT_GIVEN] } : record;
  const setupHere = cloudSignInDue(viewer, state, engineReady)
    || ["waiting", "shown"].includes(cloudSetupStage({ viewer, connected: state.connected, enginesKnown: state.instances.length > 0,
      engineReady: state.instances.some(engineReady), onboarding: setupRecord, planned: Boolean(jobRoutine(state.routines, intent.sent)) }));
  const waits = cornerPopupWaits(state, { quiet, idle: true, viewer, duringFirstChat: true }) || Boolean(state.cloudAdd) || state.cloudHowTo || setupHere || welcomeCovers || makingCovers;
  const kind = view ? cloudNoticeKind(view, account) : null;
  const introDue = (): boolean | null => {
    if (!introAllowed || !view) return false;
    if (view.kind === "unknown" || view.kind === "connecting" || organization === null) return null;
    // the corner card is the louder pitch: only once someone is invested (shared/cloud-upsell.ts), never in their first chats
    if (!buyOfferAllowed(view) || !usedBefore(state.bots) || !isInvested(state)) return false;
    if (offer === undefined) return null;
    if (offerTrialDays(offer) === null) return false;
    if (stage === "resting" && !introOpen) return false;
    return introOpen || stage === "due" ? true : null;
  };
  // a routine here that ran late or not at all while this computer slept: the plainest case for madani cloud, said once
  const late = bridge && !noticeSeen(record, LATE_ROUTINE_NOTICE) ? lateRoutineRun(state.routines ?? [], state.routineRuns ?? [], now()) : null;
  const asleep = useAsleepWork(state.bots, Boolean(bridge) && !noticeSeen(record, ASLEEP_NOTICE), now);
  const slept = bridge && !noticeSeen(record, ASLEEP_NOTICE) ? asleepFresh(asleep, now()) : null;
  const cloudCardDue = (found: unknown): boolean | null => {
    if (!found || !view) return false;
    if (view.kind === "unknown" || view.kind === "connecting" || organization === null) return null;
    return organization === false && buyOfferAllowed(view) && !state.config?.cloudHome && !state.config?.managedPolicy;
  };
  const cards = Boolean(bridge || planBridge);
  const launch = launchNotice();
  const notice = waits || closed ? null
    : firstChatQuiet(state) ? null
    : cards || twoFact !== false || bring.fact !== false ? nextNotice({
    [GROK_MOVE_NOTICE]: false,
    [WHATS_NEW_NOTICE]: false,
    [BRING_NOTICE]: bring.fact,
    [TWO_PLACES_NOTICE]: twoFact,
    [LATE_ROUTINE_NOTICE]: moving ? false : moving === null ? null : cloudCardDue(late),
    [ASLEEP_NOTICE]: moving ? false : moving === null ? null : cloudCardDue(slept),
    [CLOUD_INTRO]: moving ? false : moving === null ? null : introDue(),
    [CLOUD_TRIAL_NOTICE]: planBridge && plan === null ? null : Boolean(key && (trialDue || trialOpen === key)),
    [CLOUD_NOTICE]: !view ? false : view.kind === "unknown" ? null
      : Boolean(kind && !noticeSeen(record, CLOUD_NOTICE_CARD[kind].dismissed)),
  }, id => id === CLOUD_INTRO && stage === "done" && !introOpen, launch) : null;

  const shownKey = notice === CLOUD_TRIAL_NOTICE ? key : notice;
  useEffect(() => {
    if (!shownKey || !notice) return;
    markLaunchNotice(notice);
    if (shownKey === CLOUD_INTRO) {
      setIntroOpen(true);
      track("cloud_card_shown", { variant: view?.kind === "signed-out" ? "signed_out" : "free" });
      const patch = introShown(record, now());
      if (patch) void api("/api/config", { method: "PUT", body: JSON.stringify(patch) }).then(config => dispatch({ type: "configStatus", config })).catch(() => {});
    } else if (notice === CLOUD_TRIAL_NOTICE && trialOpen !== shownKey) {
      setTrialOpen(shownKey);
      void planBridge?.noticeSeen?.().catch(() => {});

    }
  }, [shownKey]);

  const save = (id: string) => {
    const patch = dismissNotice(record, id);
    if (patch) void api("/api/config", { method: "PUT", body: JSON.stringify(patch) })
      .then(config => dispatch({ type: "configStatus", config })).catch(() => {});
  };
  const close = () => { noticeClosed(); setClosed(true); setTrialOpen(null); setFailed(false); };
  const card = toast ? null
    : notice === CLOUD_INTRO ? (offer ? notice : null)
    : notice === LATE_ROUTINE_NOTICE ? (late ? notice : null)
    : notice === ASLEEP_NOTICE ? (slept ? notice : null)
    : notice === CLOUD_TRIAL_NOTICE ? (trial ? notice : null)
    : notice === CLOUD_NOTICE ? (kind && bridge ? notice : null)
    : notice === TWO_PLACES_NOTICE ? (two.suggest ? notice : null)
    : notice === BRING_NOTICE ? (bring.find ? notice : null) : null;
  useEffect(() => { noticeOnScreen(card); }, [card]);
  if (toast) return <NoticeToast text={toast} onDone={() => setToast(null)} />;
  if (!notice && digest && !waits) return <NoticeToast text={digest.line} onDone={digest.seen} />;
  if (!notice && allowance && !waits) {
    return <NoticeToast text={t(allowance.level === "over" ? "notices.allowance.over" : "notices.allowance.near")} tone={allowance.level === "over" ? "warning" : undefined}
      onDone={allowance.seen} action={{ label: t("notices.allowance.see"), onClick: () => dispatch({ type: "toggleAppSettings", open: true, section: "usage" }) }} />;
  }
  if (!notice && behind && !waits) return <NoticeToast text={behind.text} onDone={behind.seen} action={behind.action} />;
  if (!notice && askFeedback && !waits && usedBefore(state.bots)) return <FeedbackCard onDone={() => setAskFeedback(false)} />;
  if (!notice) return null;

  if (notice === CLOUD_INTRO && offer) {
    const done = (action: string) => { track("cloud_card_action", { action, ms: noticeActed() }); close(); save(CLOUD_INTRO); };
    return <CloudTrialIntroCard offer={offer}
      onStart={() => { done("start"); dispatch({ type: "openCloudAdd", source: "app_card" }); }}
      onHowTo={() => { done("howto"); dispatch({ type: "cloudHowTo", open: true }); }}
      onSignIn={view?.kind === "signed-out" ? () => { track("cloud_card_action", { action: "signin", ms: noticeActed() }); close(); dispatch({ type: "openCloudAdd", source: "app_card", signIn: true }); } : undefined}
      onNotNow={() => { done("not_now"); setToast(t("cloudIntro.later")); }}
      onDismiss={() => { done("close"); setToast(t("cloudIntro.later")); }} />;
  }
  if (notice === LATE_ROUTINE_NOTICE && late) {
    const done = (action: string) => { track("late_routine_card", { action, missed: late.ranAt === null, ms: noticeActed() }); close(); save(LATE_ROUTINE_NOTICE); };
    return <LateRoutineCard late={late} now={now()}
      onStart={() => { trackUpsell("click", "app_late_routine"); done("start"); dispatch({ type: "openCloudAdd", source: "app_late_routine", ...(view?.kind === "signed-out" ? { signIn: true as const } : {}) }); }}
      onNotNow={() => { trackUpsell("dismiss", "app_late_routine"); done("not_now"); }} />;
  }
  if (notice === ASLEEP_NOTICE && slept) {
    const done = () => { close(); save(ASLEEP_NOTICE); };
    return <AsleepWorkCard slept={slept}
      onStart={() => { trackUpsell("click", "app_asleep"); done(); dispatch({ type: "openCloudAdd", source: "app_asleep", ...(view?.kind === "signed-out" ? { signIn: true as const } : {}) }); }}
      onNotNow={() => { trackUpsell("dismiss", "app_asleep"); done(); }} />;
  }
  if (notice === CLOUD_TRIAL_NOTICE && trial) {
    const shown = cloudTrialView(trial);
    const act = () => { setFailed(false); void planBridge?.manage().then(() => { noticeClosed(true); close(); }, () => setFailed(true)); };
    return <CloudTrialNoticeCard view={shown} failed={failed} onAction={act} onClose={close} />;
  }
  if (notice === CLOUD_NOTICE && kind && bridge) {
    const act = () => {
      if (busy) return;
      // signed out: the sign-in continues in the browser for its context; an ended sign-in starts again there too
      if (kind !== "sign-in-again" && browserSignIn()) { noticeClosed(true); close(); openSignIn(); return; }
      setFailed(false); setBusy(true);
      void cloudNoticeStep(kind, bridge).then(next => { noticeClosed(true); setAccount(next); }, () => setFailed(true)).finally(() => setBusy(false));
    };
    return <CloudNoticeCard kind={kind} busy={busy} failed={failed} onAction={act} onNotNow={() => { close(); save(CLOUD_NOTICE_CARD[kind].dismissed); }} />;
  }
  if (notice === BRING_NOTICE && bring.find) {
    const find = bring.find;
    const done = (action: string) => { track("bring_card", { action, ms: noticeActed() }); close(); save(BRING_NOTICE); };
    return <NoticeCard titleId="bring-notice-title" notice="bring" icon={Download} title={t("notices.bring.title", { app: find.app })} onDismiss={() => done("close")}>
      <p className="mb-3 mt-1 text-pretty text-[13px] text-ink-secondary">
        {`${knowsLine(find)} ${t("notices.bring.body")}`}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" data-bring-review="" className={PRIMARY_BUTTON} onClick={() => { done("review"); focusBringFind(find.id); dispatch({ type: "toggleAppSettings", open: true, section: "import" }); }}>{t("notices.bring.review")}</button>
        <NotNowButton onClick={() => done("not_now")} />
      </div>
    </NoticeCard>;
  }
  if (notice === TWO_PLACES_NOTICE && two.suggest) {
    const { key, kind } = two.suggest;
    return <TwoPlacesCard key={key} suggest={two.suggest}
      onBring={() => { track("two_places_card", { action: "bring", kind, ms: noticeActed() }); return two.accept(key).then(close); }}
      onDismiss={() => { track("two_places_card", { action: "not_now", kind, ms: noticeActed() }); two.dismiss(key); close(); }} />;
  }
  return null;
}
