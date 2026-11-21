// Move to Cloud desktop: what the person gets, its price, and one button that runs the rest. No Cloud yet: checkout
// (recorded as app_computer_move), and after payment the bots move by themselves; kept here before: one tap moves them.
// While they move the sheet says how far it got, and Stop or Move back is the way back. Opened from any bot's Computer tab.
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "../../icons";

import { cloudPlanView, moneyBackLine, offerTrialDays, usd } from "@/lib/cloud-plan";
import { MOVE_IN_PROGRESS, cloudMoveStage, moveFollowUp, moveIntended, readMoveIntent, writeMoveIntent, type CloudMoveStage, type CloudMoveTarget } from "@/lib/cloud-move";
import { ipcErrorText, moveLine } from "@/lib/cloud-send";
import { t } from "@/lib/i18n";
import { desktopShowsOtherServer, useOtherServerName } from "@/lib/other-server";
import { useCloudOffer } from "@/lib/use-cloud-offer";
import { vpsCloudMoveBridge } from "@/lib/vps-cloud-move";
import { useStore } from "@/state/store";
import { GrokDialog, mdPrimaryCls, mdSecondaryCls } from "../ui/GrokDialog";
import { PlaceArt } from "../ui/PlaceArt";
import { deviceWord } from "../vps-link/parts";
import { useCloudDesktop } from "./CloudDesktop";
import { Perk, Progress } from "./cloud-move-parts";
import { VpsCloudMoveSheet } from "./VpsCloudMoveSheet";

/** The sheet's state and its one next step, shared by the sheet and the watcher that finishes a move after checkout. */
function useCloudMove(onBuy?: () => void) {
  const { state, dispatch } = useStore();
  const cloudDesktop = useCloudDesktop();
  const elsewhere = desktopShowsOtherServer();
  const stage: CloudMoveStage | null = cloudDesktop ? cloudMoveStage(cloudDesktop.view, cloudDesktop.keep) : elsewhere ? "elsewhere" : null;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const run = (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setFailed(null);
    void work().then(() => setBusy(false), (cause: unknown) => { setBusy(false); setFailed(ipcErrorText(cause) ?? t("place.cloudDesktop.failed")); });
  };
  const signedOut = cloudDesktop?.account ? cloudPlanView(cloudDesktop.account).kind === "signed-out" : false;
  const buy = () => {
    writeMoveIntent(true);
    onBuy?.();
    dispatch({ type: "openCloudAdd", source: "app_computer_move", ...(signedOut ? { signIn: true as const } : {}) });
  };
  const move = () => { writeMoveIntent(false); if (cloudDesktop) run(() => cloudDesktop.moveNow()); };
  const keepHere = () => { writeMoveIntent(false); if (cloudDesktop) run(() => cloudDesktop.setKeep(true)); };

  // a move asked for here goes on after checkout with no second tap, and is forgotten once there is nothing left to do
  const followed = useRef<CloudMoveStage | null>(null);
  useEffect(() => {
    if (!stage || followed.current === stage) return;
    followed.current = stage;
    const next = moveFollowUp(stage, moveIntended(readMoveIntent(), Date.now()));
    if (next === "move") move();
    else if (next === "clear") writeMoveIntent(false);
  });

  const bots = state.bots.filter((bot) => !bot.hidden && !bot.movedTo).length;
  return { stage, cloudDesktop, busy, failed, buy, move, keepHere, run, bots, cloudHome: state.config?.cloudHome === true };
}

/** Finishes a move asked for here once its checkout is paid, while no sheet is open. */
export function CloudMoveWatcher() {
  useCloudMove();
  return null;
}

export function CloudMoveSheet({ target, onClose }: { target: CloudMoveTarget; onClose: () => void }) {
  const { stage, cloudDesktop, busy, failed, buy, move, keepHere, run, bots, cloudHome } = useCloudMove(onClose);
  const otherServer = useOtherServerName();
  const device = deviceWord();
  const [confirmBack, setConfirmBack] = useState(false);
  const offering = stage === "buy" || stage === "resume" || stage === "ready" || stage === "elsewhere";
  const offer = useCloudOffer(stage === "buy" || stage === "resume", cloudDesktop?.account?.offer);
  const trialDays = offerTrialDays(offer);
  const cheapest = offer?.plans.length ? Math.min(...offer.plans.map((plan) => plan.amount)) : null;
  const price = cheapest !== null ? usd(cheapest / 100) : null;
  const moneyBack = moneyBackLine(offer);

  if (!stage) return null;
  if (stage === "elsewhere" && target === "cloud" && !cloudHome && vpsCloudMoveBridge()) return <VpsCloudMoveSheet onClose={onClose} />;
  const back = stage === "moved" && (target === "home" || confirmBack);
  const title = back ? t("place.cloudDesktop.backTitle")
    : stage === "preparing" ? t("cloudMove.preparingTitle")
    : stage === "moving" ? t("cloudMove.movingTitle")
    : stage === "moved" ? t("cloudMove.movedTitle")
    : stage === "coming-back" ? t("cloudMove.comingBackTitle")
    : stage === "elsewhere" && target === "home" ? t("runsOn.moveHome", { device })
    : t("runsOn.moveCloud");
  const line = cloudDesktop?.move ? moveLine(cloudDesktop.move, cloudDesktop.cloudPage ? "cloud" : "local", "panel") : null;
  const switchPlace = () => { onClose(); void window.madaniDesktop?.workspaces?.menu().catch(() => {}); };

  const primary = (() => {
    switch (stage) {
      case "buy": return { label: trialDays ? t("botPanel.ui.cloudIntroStart") : t("cloudMove.get"), act: buy };
      case "resume": return { label: t("place.cloudDesktop.finish"), act: buy };
      case "ready": return { label: bots === 1 ? t("cloudMove.moveOne") : t("cloudMove.moveMany", { count: bots }), act: move };
      case "moved": return back ? { label: t("place.cloudDesktop.backConfirm"), act: () => { setConfirmBack(false); keepHere(); } }
        : cloudDesktop?.openHome ? { label: t("runsOn.openCloud"), act: () => run(async () => { await cloudDesktop.openHome!(); onClose(); }) } : null;
      case "open": return cloudDesktop?.openHome ? { label: t("runsOn.openCloud"), act: () => run(async () => { await cloudDesktop.openHome!(); onClose(); }) } : null;
      case "manage": return cloudDesktop?.openPlan ? { label: t("cloudMove.openPlan"), act: () => run(() => cloudDesktop.openPlan!()) } : null;
      case "elsewhere": return window.madaniDesktop?.workspaces?.menu ? { label: t("cloudMove.switch", { device }), act: switchPlace } : null;
      default: return null;
    }
  })();
  const secondary = MOVE_IN_PROGRESS.has(stage)
    ? stage === "moving" ? { label: t("cloudMove.stop"), act: keepHere } : { label: t("botPanel.ui.commonClose"), act: onClose }
    : stage === "moved" && !back && !cloudDesktop?.cloudPage ? { label: t("cloudMove.back", { device }), act: () => setConfirmBack(true) }
    : back && target !== "home" ? { label: t("botPanel.ui.commonCancel"), act: () => setConfirmBack(false) }
    : { label: offering ? t("notice.notNow") : t("botPanel.ui.commonClose"), act: onClose };

  return (
    <GrokDialog data-panel-modal="cloud-move" art={<PlaceArt name={back || target === "home" ? "direct" : "cloud"} size={44} />} title={<span className="block whitespace-normal">{title}</span>} width={440} onClose={onClose}
      footer={<>
        <button type="button" className={mdSecondaryCls} disabled={busy && secondary.act !== onClose} onClick={secondary.act}>{secondary.label}</button>
        {primary && <button type="button" data-cloud-move-action={stage} className={mdPrimaryCls} disabled={busy} onClick={primary.act}>
          {busy && <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}{primary.label}
        </button>}
      </>}>
      <div data-cloud-move-stage={stage} className="text-[13px] leading-[18px] text-ink">
        {offering && !back && <>
          <p className="mb-3 text-ink/[0.68]">{stage === "elsewhere"
            ? t(target === "home" ? "cloudMove.elsewhereHome" : "cloudMove.elsewhereCloud", { name: otherServer ?? "", device })
            : bots === 1 ? t("cloudMove.bodyOne") : t("cloudMove.bodyMany", { count: bots })}</p>
          {target === "cloud" && <ul className="mb-3 flex flex-col gap-2">
            <Perk>{t("cloudMove.perk.awake", { device })}</Perk>
            <Perk>{t("cloudMove.perk.fast", { device })}</Perk>
            <Perk>{t("cloudMove.perk.care")}</Perk>
          </ul>}
          {price && <p data-cloud-move-price="" className="text-ink">{trialDays ? t("cloudMove.trialPrice", { days: trialDays, price }) : t("cloudMove.price", { price })}</p>}
          {(stage === "buy" || stage === "resume") && <p className="mt-1 text-[12px] leading-4 text-ink/[0.56]">{[t("cloudMove.afterPay"), moneyBack].filter(Boolean).join(" ")}</p>}
        </>}
        {back && <p className="text-ink/[0.68]">{t("place.cloudDesktop.backBody")}</p>}
        {stage === "preparing" && <Progress line={t("cloudMove.preparing")} />}
        {stage === "moving" && <><Progress line={line?.text ?? t("place.cloudDesktop.moving")} /><p className="text-[12px] leading-4 text-ink/[0.56]">{t("cloudMove.movingNote")}</p></>}
        {stage === "coming-back" && <Progress line={t("cloudMove.comingBack")} />}
        {stage === "moved" && !back && <p className="text-ink/[0.68]">{line?.kind === "done" ? line.text : t("cloudMove.moved")}</p>}
        {stage === "manage" && <p className="text-ink/[0.68]">{t("cloudMove.manage")}</p>}
        {stage === "open" && <p className="text-ink/[0.68]">{t("cloudMove.openOnly")}</p>}
        {failed && <p role="alert" className="mt-3 text-[13px] text-danger">{failed}</p>}
      </div>
    </GrokDialog>
  );
}
