import { useState } from "react";
import { Loader2 } from "../../icons";

import { cloudPlanLabel, moneyBackLine, usd } from "@/lib/cloud-plan";
import { arrivedList, ipcErrorText, listOf } from "@/lib/cloud-send";
import { t } from "@/lib/i18n";
import { useOtherServerName } from "@/lib/other-server";
import { cheapestPlan, SIGN_IN_FIRST, useVpsCloudMove, useVpsCloudOffer, type VpsCloudMoveView, type VpsMoveCounts } from "@/lib/vps-cloud-move";
import { useStore } from "@/state/store";
import { GrokDialog, mdPrimaryCls, mdSecondaryCls } from "../ui/GrokDialog";
import { PlaceArt } from "../ui/PlaceArt";
import { deviceWord } from "../vps-link/parts";
import { Perk, Progress } from "./cloud-move-parts";

type Step = "buy" | "ready" | "setting-up" | "buying" | "moving" | "fallback" | "failed" | "done";

function stepOf(view: VpsCloudMoveView): Step {
  switch (view.stage) {
    case "none": return view.cloud === "ready" ? "ready" : view.cloud === "starting" ? "setting-up" : "buy";
    case "waiting": return "setting-up";
    default: return view.stage;
  }
}

const muted = "text-ink/[0.68]";
const note = "text-[12px] leading-4 text-ink/[0.56]";
const linkCls = "mt-3 cursor-pointer rounded-[4px] text-[12px] leading-4 text-ink/[0.56] outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus disabled:cursor-default";

function movingLine(view: Extract<VpsCloudMoveView, { stage: "moving" }>): string {
  if (view.phase === "wait") return view.waitingFor ? t("vpsMove.waitFor", { name: view.waitingFor }) : t("vpsMove.wait");
  if (view.phase === "finishing") return t("vpsMove.finishing");
  if (view.chats?.total) return t("vpsMove.chats", { done: Math.min(view.chats.done, view.chats.total), total: view.chats.total });
  return t("vpsMove.copy", { place: view.place });
}

function doneList(counts: VpsMoveCounts | undefined): string[] {
  if (!counts) return [];
  const n = (value: unknown) => (typeof value === "number" && value > 0 ? value : 0);
  return arrivedList({ bots: n(counts.bots), skills: n(counts.skills), logins: n(counts.logins), onePassword: counts.onePassword === true, chats: n(counts.chats), routines: n(counts.routines) });
}

/** The move sheet on a VPS's own page: its bots go straight to madani cloud, one state at a time as main tells it. */
export function VpsCloudMoveSheet({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const { bridge, view, set } = useVpsCloudMove(true);
  const serverName = useOtherServerName();
  const device = deviceWord();
  const step = view ? stepOf(view) : null;
  const offer = useVpsCloudOffer(step === "buy");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  if (!bridge || !view || !step) return null;
  const place = "place" in view ? view.place : (serverName ?? "");
  const bots = state.bots.filter((bot) => !bot.hidden && !bot.movedTo).length;
  // Get madani cloud buys the cheapest plan, named with its price before the browser opens
  const plan = cheapestPlan(offer);
  const planName = plan ? plan.label ?? cloudPlanLabel(plan.tier) : null;
  const price = plan ? usd(plan.amount / 100) : null;
  const trialDays = plan?.trialDays ?? null;
  const moneyBack = moneyBackLine(offer);

  const run = (work: () => Promise<VpsCloudMoveView>, onError?: (message: string | null) => boolean) => {
    if (busy) return;
    setBusy(true); setFailed(null);
    void work().then((next) => { setBusy(false); set(next); }, (cause: unknown) => {
      setBusy(false);
      const message = ipcErrorText(cause);
      if (!onError?.(message)) setFailed(message ?? t("place.cloudDesktop.failed"));
    });
  };
  // signed out, main opens the sign-in over this page and the checkout follows it (view.signingIn); an app with no sign-in
  // of its own still never sends the person elsewhere first: the account sheet, or this computer's buying sheet
  const buy = () => run(() => bridge.buy(plan?.tier === "pro" ? "pro" : "plus"), (message) => {
    if (message !== SIGN_IN_FIRST) return false;
    if (window.madaniDesktop?.cloudAccount) { onClose(); dispatch({ type: "openCloudAdd", source: "app_computer_move", signIn: true }); return true; }
    if (window.madaniDesktop?.accountSheet) { void window.madaniDesktop.accountSheet.open().catch(() => {}); return true; }
    return false;
  });
  const signingIn = view.stage === "buying" && view.signingIn === true;
  const signIn = () => run(() => bridge.signIn ? bridge.signIn() : Promise.resolve(view));
  const start = () => run(() => bridge.start());
  const retry = () => run(() => bridge.retry());
  const cancel = () => run(() => bridge.cancel());

  const title = step === "buy" || step === "ready" ? t("vpsMove.title")
    : step === "setting-up" ? t("vpsMove.settingUpTitle")
    : step === "buying" ? (signingIn ? t("vpsMove.signInTitle") : t("vpsMove.buyingTitle"))
    : step === "moving" ? t("cloudMove.movingTitle")
    : step === "fallback" ? t("vpsMove.fallbackTitle", { device })
    : step === "failed" ? t("vpsMove.failedTitle")
    : t("vpsMove.doneTitle");

  const close = { label: t("botPanel.ui.commonClose"), act: onClose };
  const notNow = { label: t("notice.notNow"), act: onClose };
  const primary = step === "buy" ? { label: trialDays ? t("botPanel.ui.cloudIntroStart") : t("vpsMove.get"), act: buy }
    : step === "ready" ? { label: bots === 1 ? t("cloudMove.moveOne") : t("cloudMove.moveMany", { count: bots }), act: start }
    : step === "failed" ? { label: t("vpsMove.retry"), act: retry }
    : signingIn ? { label: t("vpsMove.signIn"), act: signIn }
    : null;
  const secondary = signingIn ? { label: t("continueBrowser.cancel"), act: cancel } : step === "buy" || step === "ready" || step === "buying" ? notNow : close;
  const extra = step === "buying" && !signingIn ? { label: t("vpsMove.checkoutAgain"), act: buy } : null;
  const body = bots === 1 ? t("vpsMove.bodyOne", { place }) : t("vpsMove.bodyMany", { count: bots, place });

  return (
    <GrokDialog data-panel-modal="cloud-move" art={<PlaceArt name="cloud" size={44} />} title={<span className="block whitespace-normal">{title}</span>} width={440} onClose={onClose}
      footer={<>
        <button type="button" className={mdSecondaryCls} onClick={secondary.act}>{secondary.label}</button>
        {extra && <button type="button" className={mdSecondaryCls} disabled={busy} onClick={extra.act}>{extra.label}</button>}
        {primary && <button type="button" data-cloud-move-action={step} className={mdPrimaryCls} disabled={busy} onClick={primary.act}>
          {busy && <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}{primary.label}
        </button>}
      </>}>
      <div data-cloud-move-stage={`vps-${step}`} className="text-[13px] leading-[18px] text-ink">
        {step === "buy" && <>
          <p className={`mb-3 ${muted}`}>{body}</p>
          <ul className="mb-3 flex flex-col gap-2">
            <Perk>{t("vpsMove.perk.server")}</Perk>
            <Perk>{t("vpsMove.perk.awake", { device })}</Perk>
          </ul>
          {price && planName && <p data-cloud-move-price="" className="text-ink">{trialDays ? t("vpsMove.planTrial", { plan: planName, days: trialDays, price }) : t("vpsMove.plan", { plan: planName, price })}</p>}
          <p className={`mt-1 ${note}`}>{[t("vpsMove.afterPay", { place }), moneyBack].filter(Boolean).join(" ")}</p>
        </>}
        {step === "ready" && <>
          <p className={`mb-1 ${muted}`}>{body}</p>
          <p className={muted}>{t("vpsMove.readyNote", { device })}</p>
        </>}
        {step === "setting-up" && <Progress line={t("vpsMove.settingUp")} />}
        {step === "buying" && <>
          <p className={muted}>{signingIn ? t("vpsMove.signInBody", { place }) : t("vpsMove.buying", { place })}</p>
          <button type="button" className={linkCls} disabled={busy} onClick={cancel}>{t("vpsMove.cancel")}</button>
        </>}
        {view.stage === "moving" && <>
          <Progress line={movingLine(view)} />
          {view.retrying && <p className={`mb-1 ${note}`}>{t("vpsMove.retrying")}</p>}
          <p className={note}>{t("vpsMove.movingNote", { place })}</p>
        </>}
        {view.stage === "fallback" && <>
          <p className={`mb-1 ${muted}`}>{t(view.why === "outdated" ? "vpsMove.fallbackOutdated" : "vpsMove.fallback", { place, device })}</p>
          <p className={muted}>{t("vpsMove.fallbackRestart")}</p>
          <Progress line={t("vpsMove.fallbackProgress", { device })} />
        </>}
        {view.stage === "failed" && <>
          {view.error && <p role="alert" className="mb-1 text-danger">{view.error}</p>}
          <p className={muted}>{t("vpsMove.failed", { place })}</p>
        </>}
        {view.stage === "done" && <>
          <p className={`mb-1 ${muted}`}>{doneList(view.counts).length ? t("vpsMove.doneList", { place, list: listOf(doneList(view.counts)) }) : t("vpsMove.done")}</p>
          {view.stays && <p data-vps-move-stays="" className={note}>{view.stays}</p>}
        </>}
        {failed && <p role="alert" className="mt-3 text-[13px] text-danger">{failed}</p>}
      </div>
    </GrokDialog>
  );
}
