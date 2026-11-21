import fs from "node:fs";
import path from "node:path";
import { createErrorReporter, reportProcessErrors } from "./error-report.mjs";
import { fileSpool } from "./error-report-spool.mjs";

/** the build's error endpoint: MADANI_ERROR_DSN, else `madanibot.errorDsn` that the release workflow writes into package.json */
export function desktopErrorDsn(env, appPath, files = fs) {
  if (env.MADANI_ERROR_DSN) return env.MADANI_ERROR_DSN;
  try { return JSON.parse(files.readFileSync(path.join(appPath, "package.json"), "utf8"))?.madanibot?.errorDsn ?? null; } catch { return null; }
}

const CRASHES = new Set(["crashed", "oom", "launch-failed", "integrity-failure", "abnormal-exit"]);

/**
 * crashes of the app, its pages and its server, while the person keeps reports on. the server child inherits
 * MADANI_ERROR_DSN from this process only then.
 */
export function startDesktopErrorReporting({ app, prefs, env = process.env, files = fs }) {
  const dsn = desktopErrorDsn(env, app.getAppPath(), files);
  const enabled = Boolean(dsn) && prefs.errorReports() && env.MADANI_ERROR_REPORTS !== "0";
  if (enabled) env.MADANI_ERROR_DSN = dsn; else delete env.MADANI_ERROR_DSN;
  const reporter = createErrorReporter({ dsn, enabled, component: "desktop", release: app.getVersion(), environment: app.isPackaged ? "production" : "development",
    spool: fileSpool(path.join(app.getPath("userData"), "error-spool")) });
  reportProcessErrors(reporter).flush();
  if (reporter.enabled) {
    app.on("render-process-gone", (_event, _contents, details) => { if (CRASHES.has(details?.reason)) reporter.capture(new Error(`page process ${details.reason}`), { tags: { exit: details.exitCode ?? "none" } }); });
    app.on("child-process-gone", (_event, details) => { if (CRASHES.has(details?.reason)) reporter.capture(new Error(`${details.type} process ${details.reason}`), { tags: { exit: details.exitCode ?? "none" } }); });
  }
  return reporter;
}
