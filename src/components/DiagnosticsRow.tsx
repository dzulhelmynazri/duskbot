import { useState } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { SettingRow } from "./SettingsPrimitives";
import { friendlyError } from "@/lib/plain-error";

/**
 * Where this app's logs are, and the recent part of them to share with support. Security: the report never holds
 * credential values (electron/diagnostics.mjs redacts every line); opening the folder only shows main's own logs folder.
 */
export function DiagnosticsRow({ simple = false }: { simple?: boolean }) {
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const [folder, setFolder] = useState<string | null>(null);

  const exportDiagnostics = async () => {
    if (!window.madaniDesktop?.exportDiagnostics || exporting) return;
    setExporting(true);
    setResult(null);
    try {
      const path = await window.madaniDesktop.exportDiagnostics();
      if (path) setResult({ kind: "success", message: t("settings.diagnostics.saved", { path }) });
    } catch (e) {
      setResult({ kind: "error", message: friendlyError(e) });
    } finally {
      setExporting(false);
    }
  };

  const openLogs = async () => {
    if (!window.madaniDesktop?.openLogsFolder) return;
    setResult(null);
    try {
      const opened = await window.madaniDesktop.openLogsFolder();
      setFolder(opened.folder);
      if (!opened.opened) setResult({ kind: "error", message: t("settings.diagnostics.openFailed", { folder: opened.folder }) });
    } catch (e) {
      setResult({ kind: "error", message: friendlyError(e) });
    }
  };

  // My Cloud's page in the app, or a browser: this computer's logs are not reachable from here.
  const here = Boolean(window.madaniDesktop?.exportDiagnostics);
  return (
    <SettingRow
      title={t("settings.diagnostics.title")}
      subtitle={t(simple ? "settings.w6c.diagnostics.subtitle" : "settings.diagnostics.subtitle")}
      message={<>
        {folder && result?.kind !== "error" && <span role="status" data-logs-folder className="block break-all text-ink-secondary">{t("settings.diagnostics.logsAt", { folder })}</span>}
        {result && <span role={result.kind === "error" ? "alert" : "status"} className={cn("block break-all", result.kind === "error" ? "text-danger" : "text-ink-secondary")}>
          {result.message}
        </span>}
        {!(simple && here) && <span data-logs-help className="block text-ink-tertiary">{t(here ? "settings.diagnostics.logsHelp" : simple ? "settings.w6c.diagnostics.elsewhere" : "settings.diagnostics.elsewhere")}</span>}
      </>}
    >
      {here && <div className="flex flex-wrap gap-2">
        {window.madaniDesktop?.openLogsFolder && <button type="button" onClick={() => void openLogs()} className="ui-button">{t("settings.diagnostics.openLogs")}</button>}
        <button
          onClick={() => void exportDiagnostics()}
          disabled={exporting}
          aria-label={t("settings.diagnostics.aria")}
          className="ui-button"
        >
          {exporting ? t("settings.diagnostics.exporting") : t("settings.diagnostics.export")}
        </button>
      </div>}
    </SettingRow>
  );
}
