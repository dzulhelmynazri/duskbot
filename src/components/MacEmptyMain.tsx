// This computer's own app while it has no bots and the person's live somewhere else: a dialog over the normal chat, once
// per place, saying where they are and the ways on: switch to that place (as its row on the places hub does), or bring
// them back here when they moved off this computer.
import { useCallback, useState, useSyncExternalStore, useEffect } from "react";
import type { ElsewherePlace } from "@/lib/bots-elsewhere";
import { t } from "@/lib/i18n";
import { usePlaces } from "@/lib/places";
import { useVpsLink, type VpsWhere } from "@/lib/vps-link";
import { GrokDialog, mdPrimaryCls, mdSecondaryCls, rowHintCls } from "./ui/GrokDialog";
import { PlaceArt } from "./ui/PlaceArt";
import { askConfirm } from "./ConfirmDialog";
import { deviceWord, message } from "./vps-link/parts";
import { bringAsk, moveBackAsk, moveBackLine } from "./vps-link/TransferSettings";

const SEEN = "madani-mac-empty-seen";
const watchers = new Set<() => void>();
function seenPlaces(): string {
  try { return localStorage.getItem(SEEN) ?? "[]"; } catch { return "[]"; }
}
function markSeen(id: string): void {
  try {
    const list = (JSON.parse(seenPlaces()) as unknown[]).filter((entry): entry is string => typeof entry === "string" && entry !== id);
    localStorage.setItem(SEEN, JSON.stringify([...list, id].slice(-20)));
  } catch { /* storage full or off */ }
  for (const watch of watchers) watch();
}

/** Whether the dialog for this place is up: once per place, until the person closes it or takes one of its ways on. */
export function useMacEmptyPrompt(from: ElsewherePlace | null): [boolean, () => void] {
  const seen = useSyncExternalStore((watch) => { watchers.add(watch); return () => { watchers.delete(watch); }; }, seenPlaces, () => "[]");
  const id = from?.id ?? null;
  const shown = id !== null && !(JSON.parse(seen) as unknown[]).includes(id);
  const dismiss = useCallback(() => { if (id) markSeen(id); }, [id]);
  return [shown, dismiss];
}

export function MacEmptyMain({ from, onClose }: { from: ElsewherePlace; onClose: () => void }) {
  const device = deviceWord();
  const { bridge: link, view } = useVpsLink();
  const [where, setWhere] = useState<VpsWhere | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    void link?.where().then((place) => { if (alive) setWhere(place); }, () => {});
    return () => { alive = false; };
  }, [link]);
  // back from the server this computer moved them to, or from a saved server of the person's own while this one is empty
  const movedBack = Boolean(link && where?.place === "vps" && where.server);
  const bring = !movedBack && !where?.blocked && where?.bring?.some((place) => place.id === from.id) ? from.id : null;
  const back = movedBack || bring !== null;
  const name = movedBack ? where!.server!.name : from.name;
  const progress = moveBackLine(view.back, device);
  const bringBack = async () => {
    if (busy || !link || !await askConfirm({ ...(bring ? bringAsk(name, device) : moveBackAsk(name, device)), layer: "z-[70]" })) return;
    setBusy(true); setError("");
    try { await (bring ? link.moveBack(bring) : link.moveBack()); setNote(t("macEmpty.bringing")); } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  };
  const rail = usePlaces();
  const switchThere = () => {
    if (busy) return;
    const workspaces = window.madaniDesktop?.workspaces;
    const go = rail.places.some((place) => place.id === from.id) && workspaces?.open ? workspaces.open(from.id) : window.madaniDesktop?.elsewhere?.open(from.id);
    if (!go) return;
    setBusy(true); setError("");
    void Promise.resolve(go).then((opened) => { if (opened === false) setError(t("macEmpty.failed", { name })); }, () => setError(t("macEmpty.failed", { name }))).finally(() => setBusy(false));
  };
  return (
    <GrokDialog
      data-mac-empty={from.id}
      width={560}
      art={<PlaceArt name={from.why === "cloud" || from.why === "team" ? "cloud" : "server"} size={44} />}
      title={<span title={name}>{t("macEmpty.title", { name })}</span>}
      description={t(back ? "macEmpty.body" : "macEmpty.bodyOpen", { device })}
      onClose={onClose}
      footer={
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
          <button type="button" data-mac-empty-later="" className={mdSecondaryCls} onClick={onClose}>{t("macEmpty.notNow")}</button>
          {back && <button type="button" data-mac-empty-back="" className={mdSecondaryCls} disabled={busy || Boolean(note)} onClick={() => void bringBack()}>{t("macEmpty.bringBack", { device })}</button>}
          <button type="button" data-mac-empty-open="" data-autofocus="" className={`${mdPrimaryCls} max-w-full min-w-0`} disabled={busy || Boolean(note)} onClick={switchThere}><span className="truncate">{t("macEmpty.open", { name })}</span></button>
        </div>
      }
    >
      {(progress ?? note) && <p role="status" className={`${rowHintCls} m-0`}>{progress ?? note}</p>}
      {error && <p role="alert" className="m-0 text-[13px] leading-[18px] text-danger [overflow-wrap:anywhere]">{error}</p>}
    </GrokDialog>
  );
}
