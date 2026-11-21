// the server's crashes and fatal errors go to MADANI_ERROR_DSN when it is set (the desktop app passes its own only while
// the person has not turned reports off); otherwise this does nothing. electron/error-report.mjs says what an event holds.
import { join } from "node:path";
import { createErrorReporter, reportProcessErrors } from "../electron/error-report.mjs";
import { fileSpool } from "../electron/error-report-spool.mjs";
import { DATA_DIR } from "./config.ts";
import { serverVersion } from "./environment.ts";

export const serverErrors = reportProcessErrors(createErrorReporter({
  dsn: process.env.MADANI_ERROR_DSN,
  component: "server",
  release: serverVersion(),
  environment: process.env.MADANI_ENVIRONMENT ?? "production",
  spool: fileSpool(join(DATA_DIR, "error-spool")),
}));
serverErrors.flush();
