import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import type { WorkspaceBackupSummary } from "../../shared/workspace-backup";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import { applyWorkspaceClientState, collectWorkspaceClientState, WORKSPACE_RESTORE_MARKER } from "@/lib/workspace-backup-client";
import { Card as RowsCard, CardLabel, FormDialog, FormField, ItemRow, NavRow, NoteRow } from "./ListRows";
import { textFieldCls } from "./ui/GrokDialog";
import { GROK_HOVER_TINT } from "./SidebarSimpleTop";
import { cn } from "@/lib/cn";
import { friendlyError } from "@/lib/plain-error";

type BackupStatus = { busy: boolean; pendingRestore?: boolean; lastRestoreId?: string };
const buttonClass = cn("cursor-pointer inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-accent-ink disabled:opacity-40", GROK_HOVER_TINT);
const validPassword = (value: string) => value.length >= 12 && value.length <= 1024;

/** A renderer reload cannot apply a restore; the owning server must restart. */
export function WorkspaceBackupRestartNotice({ onRetry }: { onRetry?: () => void } = {}) {
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState(false);
  const lock = useRef(false);
  const relaunch = typeof window !== "undefined" && !window.madaniDesktop?.remoteClient?.active ? window.madaniDesktop?.relaunch : undefined;
  const restart = async () => {
    if (!relaunch || lock.current || restarting) return;
    lock.current = true; setRestarting(true); setError(false);
    try {
      if (!await relaunch()) throw new Error("Restart unavailable");
    } catch {
      lock.current = false; setRestarting(false); setError(true);
    }
  };
  return <div role="status" className="flex max-w-lg flex-col gap-2.5 text-[13px] leading-[18px]">
    <p>{t(relaunch ? "backup.restartDesktop" : "backup.restart")}</p>
    {relaunch && <button type="button" className="ui-button ui-button-primary self-start" disabled={restarting} onClick={() => void restart()}>{restarting ? t("settings.updates.restartingShort") : t("backup.restartAction")}</button>}
    {!relaunch && onRetry && <button type="button" className="ui-button self-start" onClick={onRetry}>{t("connectors.action.retry")}</button>}
    {error && <p role="alert" className="text-[13px] text-danger">{t("backup.restartFailed")}</p>}
  </div>;
}

export function WorkspaceBackupSummaryView({ summary }: { summary: WorkspaceBackupSummary }) {
  const facts: Array<[string, string | number]> = [
    [t("backup.date"), new Date(summary.createdAt).toLocaleString()],
    [t("backup.version"), summary.appVersion],
    [t("backup.bots"), summary.bots],
    [t("backup.groups"), summary.groups],
    [t("backup.threads"), summary.threads],
    [t("backup.messages"), summary.messages],
    [t("backup.files"), summary.files],
    [t("backup.bytes"), summary.bytes.toLocaleString()],
  ];
  return <section aria-label={t("backup.preview")} className="flex flex-col">
    <CardLabel>{t("backup.preview")}</CardLabel>
    {facts.map(([label, value]) => <ItemRow key={label} title={label} value={String(value)} />)}
    {summary.warnings.map((warning, index) => <NoteRow key={`w${index}`} tone="warn">{warning}</NoteRow>)}
    {summary.exclusions.length > 0 && <ItemRow title={t("backup.exclusions")} hint={summary.exclusions.join(" · ")} />}
  </section>;
}

export function WorkspaceBackupSettings() {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [busy, setBusy] = useState<"export" | "preview" | "restore" | null>(null);
  const lock = useRef(false);
  const alive = useRef(true);
  const [error, setError] = useState<string | null>(null);
  const [exportPassword, setExportPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [importPassword, setImportPassword] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [uploadedId, setUploadedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ id: string; summary: WorkspaceBackupSummary } | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [download, setDownload] = useState<{ url: string; filename: string } | null>(null);
  const [exportOpen, setExportOpen] = useState(false);

  const refresh = async () => {
    try {
      const result: BackupStatus = await api("/api/workspace-backup/status");
      if (alive.current) { setStatus(result); setError(null); }
    } catch (cause) {
      if (alive.current) { setStatus(null); setError(friendlyError(cause)); }
    }
  };
  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => { alive.current = false; };
  }, []);

  const perform = async (operation: NonNullable<typeof busy>, work: () => Promise<void>) => {
    if (lock.current || !status || status.busy || status.pendingRestore) return;
    lock.current = true;
    setBusy(operation);
    setError(null);
    try { await work(); }
    catch (cause) { if (alive.current) setError(friendlyError(cause)); }
    finally { lock.current = false; if (alive.current) setBusy(null); }
  };

  const exportBackup = () => perform("export", async () => {
    if (!validPassword(exportPassword) || exportPassword !== confirmPassword) return;
    const result: { id: string; filename: string } = await api("/api/workspace-backup/export", {
      method: "POST", body: JSON.stringify({ password: exportPassword, clientState: collectWorkspaceClientState() }),
    });
    if (alive.current) { setExportPassword(""); setConfirmPassword(""); setExportOpen(false); }
    if (!alive.current) return;
    const url = `/api/workspace-backup/download/${encodeURIComponent(result.id)}`;
    setDownload({ url, filename: result.filename });
    const link = document.createElement("a");
    link.href = url;
    link.download = result.filename;
    document.body.append(link);
    link.click();
    link.remove();
  });

  const previewBackup = () => perform("preview", async () => {
    if (!file || !importPassword) return;
    setPreview(null);
    setConfirmation("");
    let id = uploadedId;
    if (!id) {
      const result: { id: string } = await api("/api/workspace-backup/upload", {
        method: "POST", headers: { "content-type": "application/octet-stream" }, body: file,
      });
      id = result.id;
      if (alive.current) setUploadedId(id);
    }
    const result: { id: string; summary: WorkspaceBackupSummary } = await api("/api/workspace-backup/preview", {
      method: "POST", body: JSON.stringify({ id, password: importPassword }),
    }).catch((cause: unknown) => {
      if (cause instanceof Error && "status" in cause && cause.status === 404 && alive.current) setUploadedId(null);
      throw cause;
    });
    if (alive.current) { setPreview({ id: result.id, summary: result.summary }); setUploadedId(null); setImportPassword(""); }
  });

  const restoreBackup = () => perform("restore", async () => {
    if (!preview || confirmation !== "REPLACE") return;
    // The stage ID is the restore ID: persist it before the request so a lost response still lets this browser recover
    // its drafts at boot.
    localStorage.setItem(WORKSPACE_RESTORE_MARKER, preview.id);
    try {
      await api("/api/workspace-backup/restore", {
        method: "POST", body: JSON.stringify({ id: preview.id, confirmation: "REPLACE" }),
      });
    } catch (cause) {
      if (cause instanceof Error && "status" in cause && cause.status === 404 && alive.current) {
        setPreview(null); setUploadedId(null); setConfirmation("");
      }
      throw cause;
    }
    if (alive.current) { setStatus({ busy: false, pendingRestore: true }); setPreview(null); setConfirmation(""); }
  });

  const disabled = busy !== null || !status || status.busy || Boolean(status.pendingRestore);
  const exportReady = validPassword(exportPassword) && exportPassword === confirmPassword;
  // closing the import dialog drops the chosen file, its upload and any validated stage
  const closeImport = () => { setFile(null); setUploadedId(null); setPreview(null); setConfirmation(""); setImportPassword(""); setError(null); };
  return <>
    {status?.pendingRestore ? <RowsCard data-settings-block="workspace-backup"><div className="px-2 py-1.5 text-[13px] leading-[18px]"><WorkspaceBackupRestartNotice /></div></RowsCard> : <>
      <RowsCard data-settings-block="workspace-backup">
        {(!status || status.busy) && <ItemRow title={status?.busy ? t("backup.serverBusy") : t("backup.checkStatus")}>
          <button type="button" className="ui-button" onClick={() => void refresh()}>{t("connectors.action.retry")}</button>
        </ItemRow>}
        <ItemRow title={t("settings.w6c.backup.exportTitle")} hint={t("settings.w6c.backup.exportHint")}>
          <button type="button" className="ui-button" disabled={disabled} onClick={() => { setError(null); setExportOpen(true); }}>{t("backup.export")}</button>
        </ItemRow>
        {download && <NavRow external title={t("backup.downloadAgain", { filename: download.filename })} onClick={() => {
          const link = document.createElement("a"); link.href = download.url; link.download = download.filename; document.body.append(link); link.click(); link.remove();
        }} />}
        <ItemRow title={t("backup.import")} hint={t("settings.s2.backup.importHint")}>
          {/* the native picker, drawn as the row's pill */}
          <label className={cn("ui-button cursor-pointer", disabled && "pointer-events-none opacity-45")}>
            {t("settings.s2.backup.chooseFile")}
            <input type="file" accept=".madanibackup,.ombbackup" disabled={disabled} className="sr-only"
              onChange={(event) => { setFile(event.target.files?.[0] ?? null); setUploadedId(null); setPreview(null); setConfirmation(""); setImportPassword(""); setError(null); }} />
          </label>
        </ItemRow>
        {error && !exportOpen && !file && <NoteRow tone="danger">{error}</NoteRow>}
      </RowsCard>
      <AnimatePresence>{exportOpen && <FormDialog key="backup-export" data-panel-modal="backup-export" title={t("backup.export")} description={t("backup.passwordHint")}
        saveLabel={busy === "export" ? t("backup.exporting") : t("settings.w6c.backup.exportTitle")} canSave={exportReady} busy={busy !== null} error={error ?? undefined}
        onSave={exportBackup} onClose={() => { setExportOpen(false); setExportPassword(""); setConfirmPassword(""); }}>
        <FormField label={t("backup.exportPassword")}>
          <input type="password" autoComplete="new-password" minLength={12} maxLength={1024} required disabled={disabled} placeholder={t("settings.w6c.backup.passwordPlaceholder")} value={exportPassword} onChange={(event) => setExportPassword(event.target.value)} className={textFieldCls} />
        </FormField>
        <FormField label={t("backup.confirmPassword")}>
          <input type="password" autoComplete="new-password" minLength={12} maxLength={1024} required disabled={disabled} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} className={textFieldCls} />
        </FormField>
      </FormDialog>}</AnimatePresence>
      <AnimatePresence>{file && !preview && <FormDialog key="backup-import" data-panel-modal="backup-import" title={t("backup.import")} description={file.name}
        saveLabel={busy === "preview" ? t("backup.validating") : t("backup.validate")} canSave={Boolean(importPassword)} busy={busy !== null} error={error ?? undefined}
        onSave={previewBackup} onClose={closeImport}>
        <FormField label={t("backup.importPassword")}>
          <input type="password" autoComplete="off" maxLength={1024} required disabled={disabled} value={importPassword} onChange={(event) => setImportPassword(event.target.value)} className={textFieldCls} />
        </FormField>
      </FormDialog>}</AnimatePresence>
      <AnimatePresence>{preview && <FormDialog key="backup-restore" data-panel-modal="backup-restore" title={t("backup.preview")} description={t("backup.replaceWarning")} width={460}
        saveLabel={busy === "restore" ? t("backup.restoring") : t("backup.replace")} canSave={confirmation === "REPLACE"} busy={busy !== null} error={error ?? undefined}
        onSave={restoreBackup} onClose={closeImport}>
        <div className="-mx-2"><WorkspaceBackupSummaryView summary={preview.summary} /></div>
        <NoteRow tone="danger">{t("backup.trustWarning")}</NoteRow>
        <FormField label={t("backup.confirmReplace")}>
          <input value={confirmation} autoComplete="off" spellCheck={false} disabled={disabled} onChange={(event) => setConfirmation(event.target.value)} className={textFieldCls} />
        </FormField>
      </FormDialog>}</AnimatePresence>
    </>}
  </>;
}

function pendingRestoreId(): string | null {
  try { return localStorage.getItem(WORKSPACE_RESTORE_MARKER); } catch { return null; }
}

/** Do not mount stale composer caches before the initiating browser recovers. */
export function WorkspaceBackupRecovery({ children }: { children: ReactNode }) {
  const [restoreId] = useState(pendingRestoreId);
  const [ready, setReady] = useState(!restoreId);
  const [error, setError] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!restoreId) return;
    let alive = true;
    setError(null);
    void (async () => {
      const status: BackupStatus = await api("/api/workspace-backup/status");
      if (!alive) return;
      if (status.pendingRestore) { setRestartRequired(true); return; }
      if (status.lastRestoreId !== restoreId) {
        localStorage.removeItem(WORKSPACE_RESTORE_MARKER);
        setReady(true);
        return;
      }
      const result = await api("/api/workspace-backup/client-state", { method: "POST", body: JSON.stringify({ restoreId }) });
      if (!alive) return;
      applyWorkspaceClientState(result.clientState);
      localStorage.removeItem(WORKSPACE_RESTORE_MARKER);
      window.location.reload();
    })().catch((cause) => { if (alive) setError(friendlyError(cause)); });
    return () => { alive = false; };
  }, [restoreId, attempt]);
  if (ready) return children;
  const continueWithoutDrafts = () => {
    try {
      localStorage.removeItem(WORKSPACE_RESTORE_MARKER);
      window.location.reload();
    } catch (cause) { setError(friendlyError(cause)); }
  };
  return <main className="flex h-dvh flex-col items-center justify-center gap-4 bg-app p-6 text-ink">
    {restartRequired ? <WorkspaceBackupRestartNotice onRetry={() => { setRestartRequired(false); setAttempt((value) => value + 1); }} /> : <p className="max-w-lg text-[14px]">{t("backup.recovering")}</p>}
    {error && <p role="alert" className="max-w-lg break-words text-[13px] text-danger">{error}</p>}
    {error && <button type="button" className={buttonClass} onClick={() => { setRestartRequired(false); setAttempt((value) => value + 1); }}>{t("connectors.action.retry")}</button>}
    {error && <>
      <p className="max-w-lg text-[13px] text-ink-secondary">{t("backup.skipDraftsHint")}</p>
      <button type="button" className={cn("cursor-pointer rounded-lg border border-transparent bg-control px-3 py-2 text-[13px] font-medium text-ink", GROK_HOVER_TINT)} onClick={continueWithoutDrafts}>{t("backup.skipDrafts")}</button>
    </>}
  </main>;
}
