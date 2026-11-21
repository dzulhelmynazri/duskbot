import { useEffect, useState } from "react";

import type { CloudAccountState, CloudPlanSnapshot } from "../../../electron/cloud-account.mjs";
import type { KeepHereState } from "../../../electron/cloud-send.mjs";
import { cloudDesktopHint, cloudDesktopOnCloud, cloudDesktopOnComputer, type CloudDesktopView } from "@/lib/cloud-desktop";
import { ipcErrorText } from "@/lib/cloud-send";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import { ConfirmDialog } from "../ConfirmDialog";
import { ItemRow, NavRow } from "../ListRows";
import { useCloudSendNotice } from "../CloudSendStrip";

/** The bridges the row runs on: only in the desktop app, and only where main offers the one-time move's switch. */
function bridges(cloudPage: boolean) {
  const madaniDesktop = typeof window === "undefined" || window.madaniDesktop?.remoteClient?.active ? undefined : window.madaniDesktop;
  const send = madaniDesktop?.cloudSendPage?.keepHere && madaniDesktop.cloudSendPage.setKeepHere ? madaniDesktop.cloudSendPage : undefined;
  const account = cloudPage ? undefined : madaniDesktop?.cloudAccount;
  const plan = cloudPage ? madaniDesktop?.cloudPlan : undefined;
  return send && (account || plan) ? { send, account, plan } : null;
}

/**
 * The works-on choices' cloud desktop row: where the person's cloud desktop stands, and choosing it runs that step's own flow,
 * never the bot's place. No Cloud: Add a Cloud. Ready: this computer's bots move there (the one-time move, once the person
 * confirms), or it opens once they are there. On its own page: they move back. Null outside the desktop app.
 */
export function useCloudDesktop() {
  const { state, dispatch } = useStore();
  const cloudPage = state.config?.cloudHome === true;
  const bridge = bridges(cloudPage);
  const [account, setAccount] = useState<CloudAccountState | null>(null);
  const [plan, setPlan] = useState<CloudPlanSnapshot | null>(null);
  const [keep, setKeep] = useState<KeepHereState | null>(null);
  const [notice] = useCloudSendNotice(bridge?.send);
  const [confirming, setConfirming] = useState<"move" | "back" | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const accountBridge = bridge?.account, planBridge = bridge?.plan, send = bridge?.send;
  useEffect(() => {
    if (!accountBridge) return;
    let alive = true, updated = false;
    const unsubscribe = accountBridge.onState((next) => { updated = true; if (alive) setAccount(next); });
    void accountBridge.state().then((next) => { if (alive && !updated) setAccount(next); }).catch(() => {});
    return () => { alive = false; unsubscribe(); };
  }, [accountBridge]);
  // the plan and the switch have no change event of their own: read again whenever the move's line or the session moves
  useEffect(() => {
    if (!planBridge) return;
    let alive = true;
    void planBridge.state().then((next) => { if (alive) setPlan(next); }).catch(() => {});
    return () => { alive = false; };
  }, [planBridge, notice]);
  useEffect(() => {
    if (!send?.keepHere) return;
    let alive = true;
    void send.keepHere().then((next) => { if (alive) setKeep(next); }).catch(() => {});
    return () => { alive = false; };
  }, [send, notice, account]);

  const view: CloudDesktopView | null = !bridge ? null
    : cloudPage ? cloudDesktopOnCloud(plan, keep) : cloudDesktopOnComputer(account, keep, notice?.move ?? null);

  const run = (work: () => Promise<unknown>, after?: () => void) => {
    if (busy) return;
    setBusy(true); setFailed(null);
    void work().then(() => { setBusy(false); after?.(); }, (cause: unknown) => { setBusy(false); setFailed(ipcErrorText(cause) ?? t("place.cloudDesktop.failed")); });
  };
  // the first move waits for the person's yes (main's move offer): Move is that yes, never only the keep-here switch turned off
  const offerWaits = Boolean(send?.moveOfferAccept && notice?.offer && notice.offer.stage !== "none");
  const moveNow = async () => {
    if (offerWaits) { await send!.moveOfferAccept!("settings"); return setKeep(await send!.keepHere!()); }
    setKeep(await send!.setKeepHere!(false));
  };
  const switchKeep = (on: boolean) => run(async () => { if (on) setKeep(await send!.setKeepHere!(true)); else await moveNow(); }, () => setConfirming(null));

  const choose = () => {
    if (!view?.acts || busy) return;
    setFailed(null);
    switch (view.step) {
      case "get":
      case "finish": dispatch({ type: "openCloudAdd", source: "app_menu" }); return;
      case "manage": if (accountBridge) run(() => accountBridge.openDashboard()); return;
      case "open": if (accountBridge) run(() => accountBridge.connectHome()); return;
      case "move": setConfirming("move"); return;
      case "back": setConfirming("back"); return;
    }
  };

  const place = view?.name ?? t("botPanel.ui.placeCloudDesktopTitle");
  const error = failed && <p role="alert" className="mt-2 text-[13px] text-danger">{failed}</p>;
  const dialog = bridge && (
    <ConfirmDialog
      open={confirming !== null}
      title={confirming === "back" ? t("botPanel.ui.placeCloudDesktopBackTitle") : t("botPanel.ui.placeCloudDesktopMoveTitle", { place })}
      body={<>{confirming === "back" ? t("place.cloudDesktop.backBody") : t("place.cloudDesktop.moveBody", { place })}{error}</>}
      confirmLabel={confirming === "back" ? t("botPanel.ui.placeCloudDesktopBackConfirm") : t("botPanel.ui.placeCloudDesktopMoveConfirm")}
      cancelLabel={t("botPanel.ui.commonCancel")}
      tone="neutral"
      pending={busy}
      onCancel={() => { if (!busy) { setConfirming(null); setFailed(null); } }}
      onConfirm={() => switchKeep(confirming === "back")}
    />
  );

  return view && {
    view,
    cloudPage,
    account,
    keep,
    /** the one-time move's line from main, while it runs or once it is done */
    move: notice?.move ?? null,
    /** off moves this computer's bots to the Cloud desktop; on keeps them here, and brings them back once moved */
    setKeep: (on: boolean) => send!.setKeepHere!(on).then((next) => { setKeep(next); return next; }),
    /** moves this computer's bots to the Cloud desktop: the offer's yes while it waits for one, else keep-here off */
    moveNow,
    openHome: accountBridge ? () => accountBridge.connectHome() : undefined,
    openPlan: accountBridge ? () => accountBridge.openDashboard() : undefined,
    label: t("botPanel.ui.placeCloudDesktopTitle"),
    // a failure outside the confirm (Open, Manage) says why on the row itself
    hint: failed && confirming === null ? failed : cloudDesktopHint(view.step),
    busy,
    choose,
    dialog,
  };
}

export type CloudDesktopRow = NonNullable<ReturnType<typeof useCloudDesktop>>;

/** The row under the works-on choices, apart from them: it never changes where the bot works. A step that does nothing
 * yet (setting up, moving) is a plain row with where things stand. */
export function CloudDesktopListRow({ cloudDesktop }: { cloudDesktop: CloudDesktopRow }) {
  if (!cloudDesktop.view.acts) return <ItemRow data-panel-row="cloud-desktop" title={cloudDesktop.label} hint={cloudDesktop.hint} />;
  return <NavRow data-panel-row="cloud-desktop" title={cloudDesktop.label} hint={cloudDesktop.hint} disabled={cloudDesktop.busy} onClick={cloudDesktop.choose} />;
}
