import { useEffect, useRef, useState } from "react";
import type { ManagedDesktopState } from "../../electron/managed-desktop.mjs";
import type { WorkspaceBackupSummary } from "../../shared/workspace-backup";
import { activeLocale, t } from "@/lib/i18n";
import { collectWorkspaceClientState, WORKSPACE_RESTORE_MARKER } from "@/lib/workspace-backup-client";
import { Card as RowsCard, ItemRow, NoteRow, SwitchRow } from "./ListRows";
import { textFieldCls } from "./ui/GrokDialog";
import { WorkspaceBackupRestartNotice, WorkspaceBackupSummaryView } from "./WorkspaceBackupSettings";
import { ArtState } from "./ui/Art";

type BackupBridge = NonNullable<NonNullable<Window["madaniDesktop"]>["companyBackups"]>;
type BackupList = Awaited<ReturnType<BackupBridge["list"]>>;
type Dialog = { kind: "create" | "schedule" } | { kind: "restore" | "delete"; entry: CompanyBackupEntry };
const inputClass = `mt-1 ${textFieldCls}`;
const bytes = (value: number) => {
  const power = value >= 1024 ** 3 ? 3 : value >= 1024 ** 2 ? 2 : 1;
  return `${new Intl.NumberFormat(activeLocale(), { maximumFractionDigits: 2 }).format(value / 1024 ** power)} ${["", "KiB", "MiB", "GiB"][power]}`;
};
const dateLabel = (entry: CompanyBackupEntry) => {
  const date = new Date(entry.completedAt ?? entry.createdAt ?? NaN);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(activeLocale(), { dateStyle: "medium", timeStyle: "short" }).format(date)
    : t("companyBackup.unknownDate");
};

/** Security: local connection snapshots are allowed here; cloud calls start only below the capability gate. */
export function CompanyBackupSettings() {
  const organization = window.madaniDesktop?.remoteClient?.active ? undefined : window.madaniDesktop?.organization;
  const bridge = organization ? window.madaniDesktop?.companyBackups : undefined;
  const [connection, setConnection] = useState<ManagedDesktopState | null>(null);
  const generation = useRef(0);
  const revision = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    const initialRevision = revision.current;
    setConnection(null);
    const receive = (next: ManagedDesktopState) => {
      if (generation.current !== current) return;
      revision.current++;
      setConnection(next);
    };
    const unsubscribe = organization?.onState(receive);
    void organization?.state().then((next) => {
      if (revision.current === initialRevision) receive(next);
    }).catch(() => { /* Fail closed without advertising company features. */ });
    return () => { generation.current++; unsubscribe?.(); };
  }, [organization]);
  if (!bridge || !connection) return null;
  if (connection.status !== "connected" || connection.cloudBackups !== true || !connection.organization?.id || !connection.organization.name?.trim() || !connection.email) return <SavedCompanyBackupSchedule bridge={bridge} />;
  return <ConnectedCompanyBackupSettings key={`${connection.organization.id}:${connection.email}:${connection.deviceId ?? ""}`} connection={connection} bridge={bridge} />;
}

/** Local only: reads the saved schedule from Electron main, never the cloud. */
export function SavedCompanyBackupSchedule({ bridge }: { bridge: BackupBridge }) {
  const [schedule, setSchedule] = useState<CompanyBackupState["schedule"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    const unsubscribe = bridge.onState(next => { if (current === generation.current) setSchedule(next.schedule ?? null); });
    void bridge.state().then(next => { if (current === generation.current) setSchedule(next.schedule ?? null); }).catch(() => {});
    return () => { generation.current++; unsubscribe(); };
  }, [bridge]);
  if (!bridge.configureSchedule || !schedule?.enabled) return null;
  const turnOff = async () => {
    if (busy || !bridge.configureSchedule) return;
    const current = generation.current;
    setBusy(true); setError("");
    try { const next = await bridge.configureSchedule({ enabled: false }); if (current === generation.current) setSchedule(next.schedule ?? null); }
    catch { if (current === generation.current) setError(t("companyBackup.scheduleFailed")); }
    finally { if (current === generation.current) setBusy(false); }
  };
  return <RowsCard label={t("companyBackup.title")} data-settings-block="company-backups">
    <NoteRow>{t("companyBackup.savedSchedule")}</NoteRow>
    <SwitchRow title={t("companyBackup.daily")} label={t("companyBackup.daily")} checked disabled={busy} onChange={() => void turnOff()}
      hint={<span role="status">{t(`companyBackup.scheduleStatus.${schedule.status}`)}</span>} />
    {error && <NoteRow tone="danger">{error}</NoteRow>}
  </RowsCard>;
}

/** Security: a new connection identity remounts this panel, clearing passwords and staged previews. */
export function ConnectedCompanyBackupSettings({ connection, bridge }: { connection: ManagedDesktopState; bridge: BackupBridge }) {
  const [state, setState] = useState<CompanyBackupState | null>(null);
  const [listing, setListing] = useState<BackupList | null>(null);
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<"create" | "prepare" | "restore" | "delete" | "schedule" | null>(null);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [preview, setPreview] = useState<{ id: string; summary: WorkspaceBackupSummary } | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);
  const generation = useRef(0);
  const revision = useRef(0);
  const listRequest = useRef(0);
  const completedBackup = useRef<number | undefined>(undefined);
  const lock = useRef(false);
  const nativeDialog = useRef<HTMLDialogElement>(null);

  const refresh = async () => {
    const current = generation.current;
    const request = ++listRequest.current;
    const initialRevision = revision.current;
    setLoading(true);
    try {
      await Promise.all([
        bridge.state().then(next => {
          // Local pending-restore authority must survive an unavailable cloud list.
          if (current === generation.current && request === listRequest.current && revision.current === initialRevision) setState(next);
        }),
        bridge.list().then(result => {
          if (current === generation.current && request === listRequest.current) setListing(result);
        }),
      ]);
      if (current === generation.current && request === listRequest.current) setError("");
    } catch {
      if (current === generation.current && request === listRequest.current) setError(t("companyBackup.loadFailed"));
    } finally {
      if (current === generation.current && request === listRequest.current) setLoading(false);
    }
  };

  useEffect(() => {
    const current = ++generation.current;
    const receive = (next: CompanyBackupState) => {
      if (current !== generation.current) return;
      revision.current++;
      setState(next);
      const completedAt = next.lastBackupAt ?? next.schedule?.lastBackupAt;
      if (!next.busy && !next.pendingRestore && completedAt && completedAt !== completedBackup.current) {
        completedBackup.current = completedAt;
        void refresh();
      }
    };
    const unsubscribe = bridge.onState(receive);
    void refresh();
    return () => { generation.current++; listRequest.current++; unsubscribe(); };
  }, [bridge]);

  useEffect(() => {
    const element = nativeDialog.current;
    if (!dialog || !element) return;
    element.showModal();
    return () => { element.close(); };
  }, [dialog]);

  const needsRestart = restartRequired || state?.pendingRestore === true;
  const disabled = action !== null || !state || state.busy || needsRestart;
  const closeDialog = () => {
    setDialog(null); setPassword(""); setConfirmation(""); setPreview(null);
  };
  const openDialog = (next: Dialog) => {
    if (disabled || lock.current) return;
    setError(""); setPassword(""); setConfirmation(""); setPreview(null); setDialog(next);
  };
  const perform = async (kind: NonNullable<typeof action>, work: (isCurrent: () => boolean) => Promise<void>) => {
    if (disabled || lock.current) return;
    lock.current = true; setAction(kind); setError("");
    const current = generation.current;
    try { await work(() => current === generation.current); }
    catch { if (current === generation.current) setError(t(kind === "restore" ? "companyBackup.restoreFailed" : "companyBackup.actionFailed")); }
    finally { lock.current = false; if (current === generation.current) setAction(null); }
  };
  const create = () => {
    if (dialog?.kind !== "create") return;
    void perform("create", async (isCurrent) => {
      await bridge.create({ clientState: collectWorkspaceClientState() });
      if (isCurrent()) { closeDialog(); await refresh(); }
    });
  };
  const configureSchedule = async (enabled: boolean) => {
    if (!bridge.configureSchedule || lock.current || !state ||
        (enabled && (disabled || dialog?.kind !== "schedule" || confirmation !== "BACK UP THIS WORKSPACE DAILY"))) return;
    // Turning off must stay possible while the native scheduler uploads; main cancels only that scheduled operation.
    lock.current = true; setAction("schedule"); setError("");
    const current = generation.current, initialRevision = revision.current;
    setConfirmation("");
    try {
      const next = await bridge.configureSchedule(enabled
        ? { enabled: true, confirmation: "BACK UP THIS WORKSPACE DAILY" }
        : { enabled: false });
      if (current === generation.current) {
        if (revision.current === initialRevision) setState(next);
        closeDialog();
      }
    } catch {
      if (current === generation.current) setError(t("companyBackup.scheduleFailed"));
    } finally {
      lock.current = false;
      if (current === generation.current) setAction(null);
    }
  };
  const prepare = () => {
    if (dialog?.kind !== "restore" || (dialog.entry.passwordRequired !== false && (password.length < 12 || password.length > 1024))) return;
    void perform("prepare", async (isCurrent) => {
      const secret = password;
      setPassword(""); setPreview(null); setConfirmation("");
      const result = await bridge.prepareRestore({ id: dialog.entry.id, ...(dialog.entry.passwordRequired !== false ? { password: secret } : {}) });
      if (isCurrent()) setPreview(result);
    });
  };
  const restore = () => {
    if (dialog?.kind !== "restore" || !preview || confirmation !== "REPLACE") return;
    void perform("restore", async (isCurrent) => {
      // Boot recovery reads this stage ID even if the response is lost; without storage, never start a replacement we
      // cannot recover.
      const existingRestore = localStorage.getItem(WORKSPACE_RESTORE_MARKER);
      if (existingRestore && existingRestore !== preview.id) throw new Error("An earlier restore needs recovery first.");
      localStorage.setItem(WORKSPACE_RESTORE_MARKER, preview.id);
      await bridge.restore({ id: preview.id, confirmation: "REPLACE" });
      if (isCurrent()) { setRestartRequired(true); closeDialog(); }
    });
  };
  const deleteBackup = () => {
    if (dialog?.kind !== "delete" || confirmation !== "DELETE") return;
    void perform("delete", async (isCurrent) => {
      await bridge.delete({ id: dialog.entry.id, confirmation: "DELETE" });
      if (isCurrent()) { closeDialog(); await refresh(); }
    });
  };
  const cancelTransfer = async () => {
    const current = generation.current;
    try { await bridge.cancel(); }
    catch { if (current === generation.current) setError(t("companyBackup.actionFailed")); }
  };

  const ready = listing?.backups.filter((entry) => entry.status === "ready") ?? [];
  const pending = listing ? listing.backups.length - ready.length : 0;
  const progress = state?.progress;
  const statusMessage = error || state?.message;
  // one row: what is happening, how far, and Cancel
  const busyView = (state?.busy || action) && <div role="status" className="contents">
    <ItemRow title={action === "restore" ? t("backup.restoring") : progress ? t(`companyBackup.phase.${progress.phase}`) : t("companyBackup.working")}
      hint={progress && progress.totalBytes > 0 ? <>
        <progress className="block h-1 w-full accent-accent" max={progress.totalBytes} value={Math.min(progress.bytesTransferred, progress.totalBytes)} aria-label={t("companyBackup.progress")} />
        {t("companyBackup.transferred", { done: bytes(progress.bytesTransferred), total: bytes(progress.totalBytes) })}
      </> : undefined}>
      {state?.busy && action !== "restore" && <button type="button" className="ui-button" onClick={() => void cancelTransfer()}>{t("companyBackup.cancelTransfer")}</button>}
    </ItemRow>
  </div>;
  const title = dialog?.kind === "restore" ? t("companyBackup.restore") : dialog?.kind === "delete" ? t("companyBackup.delete") : dialog?.kind === "schedule" ? t("companyBackup.enableSchedule") : t("companyBackup.create");
  const schedule = state?.schedule;
  const scheduledDate = (value: number) => new Intl.DateTimeFormat(activeLocale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

  const scheduleHint = schedule && [
    t(`companyBackup.scheduleStatus.${schedule.status}`),
    schedule.enabled && schedule.nextBackupAt && Number.isFinite(schedule.nextBackupAt) ? t("companyBackup.nextBackup", { date: scheduledDate(schedule.nextBackupAt) }) : "",
    schedule.lastBackupAt && Number.isFinite(schedule.lastBackupAt) ? t("companyBackup.lastScheduledBackup", { date: scheduledDate(schedule.lastBackupAt) }) : "",
    schedule.message ?? "",
  ].filter(Boolean).join(" · ");
  return <RowsCard label={t("companyBackup.title")} data-settings-block="company-backups">
    <NoteRow>{t("companyBackup.account", { organization: connection.organization?.name ?? "", email: connection.email ?? "" })}</NoteRow>
    {bridge.configureSchedule && schedule && <SwitchRow title={t("companyBackup.daily")} label={t("companyBackup.daily")} hint={<span role="status">{scheduleHint}</span>}
      checked={schedule.enabled} disabled={action !== null || !state || (!schedule.enabled && disabled)}
      onChange={() => schedule.enabled ? void configureSchedule(false) : openDialog({ kind: "schedule" })} />}
    {needsRestart ? <div className="px-2 py-1.5"><WorkspaceBackupRestartNotice /></div> : <>
      <ItemRow title={t("companyBackup.create")}
        hint={listing ? t("companyBackup.quota", { used: bytes(listing.usedBytes), total: bytes(listing.limits.ownerQuotaBytes), count: listing.limits.retainedSnapshots }) : loading ? <span role="status">{t("companyBackup.loading")}</span> : undefined}>
        <button type="button" className="ui-button" disabled={action !== null || state?.busy || needsRestart || loading} onClick={() => void refresh()}>{t("companyBackup.refresh")}</button>
        <button type="button" className="ui-button" disabled={disabled} onClick={() => openDialog({ kind: "create" })}>{t("companyBackup.create")}</button>
      </ItemRow>
      {pending > 0 && <NoteRow><span role="status">{t("companyBackup.pending", { count: pending })}</span></NoteRow>}
      {listing && ready.length === 0 && <ArtState data-art-state="backups" art="server" title={t("empty.backups.title")} className="py-6">{t("empty.backups.hint")}</ArtState>}
      {ready.map((entry) => <ItemRow key={entry.id} title={dateLabel(entry)}
        hint={<>{bytes(entry.sizeBytes)}{entry.appVersion ? ` · ${entry.appVersion}` : ""} · <span className="break-all">{entry.id}</span></>}>
        <button type="button" className="ui-button" disabled={disabled} onClick={() => openDialog({ kind: "restore", entry })}>{t("companyBackup.restore")}</button>
        <button type="button" className="ui-button text-danger" disabled={disabled} onClick={() => openDialog({ kind: "delete", entry })}>{t("companyBackup.delete")}</button>
      </ItemRow>)}
    </>}
    {!dialog && busyView}
    {!dialog && statusMessage && <NoteRow tone="danger">{statusMessage}</NoteRow>}
    {dialog && <dialog ref={nativeDialog} aria-labelledby="company-backup-dialog-title" onKeyDown={(event) => {
      // The enclosing Settings dialog has its own window-level keyboard trap.
      if (event.key === "Escape" || event.key === "Tab") event.stopPropagation();
    }} onCancel={(event) => { event.preventDefault(); if (!action) closeDialog(); }} className="ui-dialog fixed inset-0 m-auto max-h-[85dvh] w-[min(30rem,calc(100vw-2rem))] overflow-y-auto p-5 text-[13px] leading-[18px] text-ink backdrop:bg-black/50">
      <div className="flex flex-col gap-3">
        <h3 id="company-backup-dialog-title" className="text-[15px] font-medium leading-[22px]">{title}</h3>
        {needsRestart && <WorkspaceBackupRestartNotice />}
        {(dialog.kind === "restore" || dialog.kind === "delete") && <div className="text-[13px] text-ink-secondary"><p>{dateLabel(dialog.entry)} · {bytes(dialog.entry.sizeBytes)}</p><code className="break-all text-[11px]">{dialog.entry.id}</code></div>}
        {(dialog.kind === "create" || dialog.kind === "schedule") && <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); if (dialog.kind === "schedule") void configureSchedule(true); else create(); }}>
          <p className="text-[13px] text-ink">{t(dialog.kind === "schedule" ? "companyBackup.scheduleWarning" : "companyBackup.managedUploadWarning", { organization: connection.organization?.name ?? "", email: connection.email ?? "" })}</p>
          <p className="text-[13px] text-ink-secondary">{t("backup.excluded")}</p><p className="text-[13px] text-ink-secondary">{t("companyBackup.managedPrivacy")}</p>
          <p className="text-[13px] text-ink-secondary">{t("companyBackup.managedEncryption")}</p>
          {dialog.kind === "schedule" && <label className="flex items-start gap-2 text-[13px]"><input className="mt-1 accent-accent" type="checkbox" required disabled={disabled} checked={confirmation === "BACK UP THIS WORKSPACE DAILY"} onChange={event => setConfirmation(event.target.checked ? "BACK UP THIS WORKSPACE DAILY" : "")} /><span>{t("companyBackup.scheduleConsent")}</span></label>}
          <button type="submit" className="ui-button ui-button-primary self-end" disabled={disabled || (dialog.kind === "schedule" && confirmation !== "BACK UP THIS WORKSPACE DAILY")}>{t(dialog.kind === "schedule" ? "companyBackup.enableSchedule" : "companyBackup.create")}</button>
        </form>}
        {dialog.kind === "restore" && (!preview ? <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); prepare(); }}>
          <p className="text-[13px] text-ink-secondary">{t("companyBackup.previewHelp")}</p>
          {dialog.entry.passwordRequired !== false && <label className="text-[13px]">{t("backup.importPassword")}<input type="password" autoComplete="off" required minLength={12} maxLength={1024} disabled={disabled} value={password} onChange={(event) => setPassword(event.target.value)} className={inputClass} /></label>}
          <button type="submit" className="ui-button ui-button-primary self-end" disabled={disabled || (dialog.entry.passwordRequired !== false && (password.length < 12 || password.length > 1024))}>{t("backup.validate")}</button>
        </form> : <>
          <WorkspaceBackupSummaryView summary={preview.summary} />
          <p className="text-[13px] text-danger">{t("backup.replaceWarning")}</p><p className="text-[13px] text-danger">{t("backup.trustWarning")}</p>
          <label className="text-[13px]">{t("backup.confirmReplace")}<input autoComplete="off" spellCheck={false} maxLength={7} disabled={disabled} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className={inputClass} /></label>
          <button type="button" className="ui-button ui-button-danger self-end" disabled={disabled || confirmation !== "REPLACE"} onClick={restore}>{t("backup.replace")}</button>
        </>)}
        {dialog.kind === "delete" && <>
          <p className="text-[13px] text-danger">{t("companyBackup.deleteWarning")}</p>
          <label className="text-[13px]">{t("companyBackup.confirmDelete")}<input autoComplete="off" spellCheck={false} maxLength={6} disabled={disabled} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className={inputClass} /></label>
          <button type="button" className="ui-button ui-button-danger self-end" disabled={disabled || confirmation !== "DELETE"} onClick={deleteBackup}>{t("companyBackup.delete")}</button>
        </>}
        {busyView}
        {statusMessage && <p role="alert" className="break-words text-[13px] text-danger">{statusMessage}</p>}
        <button type="button" autoFocus className="ui-button self-end" disabled={action !== null} onClick={closeDialog}>{t("companyBackup.cancel")}</button>
      </div>
    </dialog>}
  </RowsCard>;
}
