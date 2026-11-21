import { useState, type ReactNode } from "react";
import type { CloudSendNotice } from "../../electron/cloud-send.mjs";
import { Loader2 } from "../icons";
import { moveOfferBridge, moveSheetState } from "@/lib/cloud-move-offer";
import { t } from "@/lib/i18n";
import { useCloudSendNotice } from "./CloudSendStrip";
import { ItemRow } from "./ListRows";
import { mdPrimaryCls } from "./ui/GrokDialog";

/** Settings → Computer, one row under the workspaces: Move to madani cloud while one is offered; while the bots move, how it
 * goes, and Try again when it got stuck. With nothing offered or under way, `otherwise` (Get madani cloud, say). */
export function CloudMoveRow({ otherwise = null }: { otherwise?: ReactNode }) {
  const bridge = moveOfferBridge();
  const [notice, setNotice] = useCloudSendNotice(bridge);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const moving = moveSheetState(notice?.move);
  const offered = Boolean(notice?.offer) && !moving;
  const stuck = failed || moving === "failed";
  if (!offered && moving !== "moving" && !stuck) return <>{otherwise}</>;

  const run = (work: () => Promise<CloudSendNotice> | undefined) => {
    if (busy) return;
    const started = work();
    if (!started) return;
    setBusy(true); setFailed(false);
    void started.then(setNotice).catch(() => setFailed(true)).finally(() => setBusy(false));
  };
  const hint = stuck ? t("cloudMoveOffer.failed") : moving === "moving" ? t("cloudMoveOffer.moving") : t("settings.docs.ws.moveHint");
  const spinner = busy && <Loader2 aria-hidden="true" className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />;
  return (
    <ItemRow data-panel-row="workspace-move" title={t("cloudMoveOffer.banner")} hint={<span role="status">{hint}</span>} tone={stuck ? "warn" : undefined}>
      {moving === "moving" && !stuck && <Loader2 size={14} aria-hidden="true" className="shrink-0 animate-spin text-ink-secondary motion-reduce:animate-none" />}
      {stuck && <button type="button" className={mdPrimaryCls} disabled={busy} aria-busy={busy || undefined}
        onClick={() => run(() => (moving === "failed" ? bridge?.moveRetry?.() : bridge?.moveOfferAccept?.("settings")))}>{spinner}{t("cloudMoveOffer.tryAgain")}</button>}
      {offered && !stuck && <button type="button" data-cloud-move-accept="settings" className={mdPrimaryCls} disabled={busy} aria-busy={busy || undefined}
        onClick={() => run(() => bridge?.moveOfferAccept?.("settings"))}>{spinner}{t("cloudMoveOffer.move")}</button>}
    </ItemRow>
  );
}
