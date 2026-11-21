import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Folder, MoreHorizontal } from "../icons";
import type { CloudFilesBridge, CloudFilesDisk, CloudFilesState, FolderCheck, SharedFolder } from "../../electron/cloud-sync.mjs";
import { cn } from "@/lib/cn";
import { cloudFilesBridge, useCloudFiles } from "@/lib/cloud-files";
import { activeLocale, t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { ConfirmDialog } from "./ConfirmDialog";
import { Card, Switch } from "./SettingsPrimitives";
import { MENU_SHEET } from "./menu-recipe";
import { friendlyError } from "@/lib/plain-error";
import { ArtState } from "./ui/Art";

const REFUSAL: Record<string, LocaleKey> = {
  "too-broad": "files.refusal.tooBroad", "app-data": "files.refusal.appData", "already-shared": "files.refusal.alreadyShared",
  "not-a-folder": "files.refusal.notAFolder", private: "files.refusal.private",
};
type Run = (action: () => Promise<CloudFilesState | void>) => Promise<void>;
type Ask = { kind: "share"; check: FolderCheck } | { kind: "stop"; folder: SharedFolder };

const count = (value: number) => new Intl.NumberFormat(activeLocale()).format(value);
const formatBytes = (value: number) => {
  const power = value >= 1024 ** 3 ? 3 : value >= 1024 ** 2 ? 2 : 1;
  return `${new Intl.NumberFormat(activeLocale(), { maximumFractionDigits: power === 3 ? 1 : 0 }).format(value / 1024 ** power)} ${["", "KB", "MB", "GB"][power]}`;
};

export function folderSize(check: FolderCheck): string {
  const files = check.partial ? t("files.countMore", { count: count(check.files) })
    : check.files === 1 ? t("files.countOne") : t("files.count", { count: count(check.files) });
  return `${files} · ${formatBytes(check.bytes)}`;
}

export function refusalText(refusal: string): string {
  return t(REFUSAL[refusal] ?? "files.refusal.other");
}

export function folderStatus(folder: SharedFolder): string {
  if (folder.status === "copying") return t("files.status.copying", { done: count(folder.done), files: count(folder.files) });
  if (folder.status === "confirm-deletes") return t(folder.pendingDeletes === 1 ? "files.status.deletesOne" : "files.status.deletes", { count: count(folder.pendingDeletes) });
  if (folder.status === "problem") return folder.problem || t("files.status.problem");
  return t(folder.status === "waiting" ? "files.status.waiting" : folder.status === "missing" ? "files.status.missing" : "files.status.synced");
}

// Electron wraps what main threw: "Error invoking remote method 'files:share': Error: …". One line of it, no stack.
export function failureText(error: unknown): string {
  const line = friendlyError(error, "");
  return line ? t("files.failedWith", { reason: line }) : t("files.failed");
}

/** The folders this computer shares with My Cloud and where Cloud bots' work lands, as Settings > madani cloud shows
 * them. Security: main decides every path; this shows main's state and passes the person's choices (tokens, folder ids). */
export function CloudFilesSettings() {
  const bridge = cloudFilesBridge();
  return bridge ? <FilesSection bridge={bridge} /> : null;
}

function FilesSection({ bridge }: { bridge: CloudFilesBridge }) {
  const [state, setState] = useCloudFiles(bridge);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const run: Run = async (action) => {
    setBusy(true);
    setFailed(null);
    try { const next = await action(); if (next) setState(next); }
    catch (error) { setFailed(failureText(error)); }
    finally { setBusy(false); }
  };
  const close = () => setAsk(null);
  const share = (token: string) => { close(); void run(() => bridge.share(token)); };
  const moreSpace = () => void run(() => bridge.moreSpace());
  if (!state || state.phase === "unavailable") return null;
  return <div data-settings-block="files" className="contents">
    <Card title={t("files.shared.title")} subtitle={t("files.shared.help")}>
      <div className="flex flex-col items-start gap-3">
        {(state.phase === "offline" || state.phase === "asleep" || state.phase === "signed-out") && <p role="status" data-files-phase={state.phase} className="text-[13px] text-ink-secondary">
          {t(state.phase === "asleep" ? "files.asleep" : state.phase === "offline" ? "files.offline" : "files.signedOut")}</p>}
        {failed && <p role="alert" className="text-[13px] text-danger">{failed}</p>}
        {state.shared.length > 0
          ? <ul className="flex w-full flex-col divide-y divide-transparent">
            {state.shared.map((folder) => <FolderRow key={folder.id} folder={folder} bridge={bridge} busy={busy} run={run} onStop={() => setAsk({ kind: "stop", folder })} />)}
          </ul>
          : <ArtState data-art-state="files" art="parcel" title={t("empty.files.title")} className="w-full py-4">{t("empty.files.hint")}</ArtState>}
        <button type="button" disabled={busy} className="ui-button"
          onClick={() => void run(async () => { const check = await bridge.pickFolder(); if (check) setAsk({ kind: "share", check }); })}>{t("files.add")}</button>
        {state.disk && <Storage disk={state.disk} busy={busy} onMore={moreSpace} />}
      </div>
    </Card>
    <Card title={t("files.outputs.title")}>
      <div className="flex flex-col items-start gap-3">
        <div className="flex w-full items-start justify-between gap-4">
          <div className="min-w-0">
            <p id="files-outputs-switch" className="text-[14px] text-ink">{t("files.outputs.switch")}</p>
            <p className="mt-1 text-[12px] text-ink-secondary">{t("files.outputs.help")}</p>
          </div>
          <Switch checked={state.outputs.enabled} disabled={busy} aria-labelledby="files-outputs-switch"
            onClick={() => void run(() => bridge.setOutputs(!state.outputs.enabled))} />
        </div>
        {state.outputs.problem && <p className="text-[12px] text-danger">{state.outputs.problem}</p>}
        {state.outputs.enabled && <button type="button" className="ui-button" onClick={() => void run(() => bridge.open({ outputs: true }))}>{t("files.outputs.open")}</button>}
      </div>
    </Card>
    {ask?.kind === "share" && (ask.check.refusal
      ? <FilesDialog label={refusalText(ask.check.refusal)} onClose={close}
        actions={<button type="button" autoFocus className="ui-button ui-button-primary" onClick={close}>{t("files.ok")}</button>} />
      : <ConfirmDialog open tone="neutral" title={t("files.share.title", { name: ask.check.name })}
        body={t("confirm.filesShare", { size: folderSize(ask.check) })} confirmLabel={t("files.share.confirm")}
        onCancel={close} onConfirm={() => share(ask.check.token)} />)}
    {ask?.kind === "stop" && <ConfirmDialog open title={t("files.stop.title", { name: ask.folder.name })} body={t("confirm.filesStop")}
      confirmLabel={t("files.stop")} onCancel={close} onConfirm={() => { close(); void run(() => bridge.stopSharing(ask.folder.id)); }} />}
  </div>;
}

function FolderRow({ folder, bridge, busy, run, onStop }: { folder: SharedFolder; bridge: CloudFilesBridge; busy: boolean; run: Run; onStop: () => void }) {
  const button = (label: string, action: () => void, primary = false) =>
    <button type="button" disabled={busy} className={cn("ui-button ui-button-sm", primary && "ui-button-primary")} onClick={action}>{label}</button>;
  const actions = folder.status === "waiting" ? button(t("files.moreSpace"), () => void run(() => bridge.moreSpace()))
    : folder.status === "confirm-deletes" ? <>
      {button(t("files.deletes.remove"), () => void run(() => bridge.answerDeletes(folder.id, true)))}
      {button(t("files.deletes.keep"), () => void run(() => bridge.answerDeletes(folder.id, false)))}
    </>
    : folder.status === "missing" ? <>
      {button(t("files.locate"), () => void run(() => bridge.locate(folder.id)), true)}
      {button(t("files.stop"), onStop)}
    </> : null;
  return <li data-files-folder={folder.status} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
    <Folder size={18} className="mt-0.5 shrink-0 text-ink-secondary" />
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="truncate text-[14px] text-ink" title={folder.pcPath}>{folder.name}</span>
      <span className={cn("text-[12px]", folder.status === "problem" || folder.status === "missing" ? "text-danger" : "text-ink-secondary")}>{folderStatus(folder)}</span>
      {actions && <div className="mt-1.5 flex flex-wrap gap-2">{actions}</div>}
    </div>
    <FolderMenu name={folder.name} busy={busy} onOpen={() => void run(() => bridge.open({ folderId: folder.id }))} onStop={onStop} />
  </li>;
}

function FolderMenu({ name, busy, onOpen, onStop }: { name: string; busy: boolean; onOpen: () => void; onStop: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } };
    const onDown = (event: PointerEvent) => { if (event.target instanceof Node && !ref.current?.contains(event.target)) setOpen(false); };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown);
    return () => { window.removeEventListener("keydown", onKey, true); window.removeEventListener("pointerdown", onDown); };
  }, [open]);
  const item = (label: string, action: () => void, danger = false) => <button type="button" role="menuitem" disabled={busy}
    className={cn("ui-menu-row w-full text-left", danger ? "text-danger" : "text-ink")} onClick={() => { setOpen(false); action(); }}>{label}</button>;
  return <div ref={ref} className="relative shrink-0">
    <button type="button" aria-haspopup="menu" aria-expanded={open} aria-label={t("files.more", { name })}
      className="ui-icon-button hover:bg-control hover:text-ink" onClick={() => setOpen((value) => !value)}><MoreHorizontal size={16} /></button>
    {open && <div role="menu" className={cn("absolute right-0 top-full z-40 mt-1 w-[220px] overflow-hidden text-[13px]", MENU_SHEET)}>
      {item(t("files.openHere"), onOpen)}
      {item(t("files.stop"), onStop, true)}
    </div>}
  </div>;
}

function Storage({ disk, busy, onMore }: { disk: CloudFilesDisk; busy: boolean; onMore: () => void }) {
  const percent = disk.totalBytes > 0 ? Math.min(100, Math.round((disk.usedBytes / disk.totalBytes) * 100)) : 0;
  return <div className="flex w-full flex-col gap-1.5">
    <span className="text-[12px] text-ink-secondary">{t("files.storage", { used: formatBytes(disk.usedBytes), total: formatBytes(disk.totalBytes) })}</span>
    <div className="h-1 w-full overflow-hidden rounded-full bg-control" aria-hidden="true">
      <div className={cn("h-full rounded-full", disk.warn ? "bg-warning" : "bg-accent")} style={{ width: `${percent}%` }} />
    </div>
    {disk.warn && <div className="flex flex-wrap items-center gap-2">
      <span className="text-[12px] text-warning">{t("files.almostFull")}</span>
      <button type="button" disabled={busy} className="ui-button ui-button-sm" onClick={onMore}>{t("files.moreSpace")}</button>
    </div>}
  </div>;
}

function FilesDialog({ label, children, actions, onClose }: { label: string; children?: ReactNode; actions: ReactNode; onClose: () => void }) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); close.current(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return createPortal(<div className="ui-dialog-scrim fixed inset-0 z-50 flex items-center justify-center p-6" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <div role="dialog" aria-modal="true" aria-labelledby="files-dialog-label" className="ui-dialog w-full max-w-[440px] p-5">
      <h2 id="files-dialog-label" className="text-[15px] font-semibold text-ink">{label}</h2>
      {children}
      <div className="mt-5 flex justify-end gap-2">{actions}</div>
    </div>
  </div>, document.body);
}
