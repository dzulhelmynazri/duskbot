import "../../../electron/legacy-names.mjs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { createErrorReporter, reportProcessErrors } from "../../../electron/error-report.mjs";
import { fileSpool } from "../../../electron/error-report-spool.mjs";
import { TRAIL_HEADER, configureTrail, createStdoutWriter, createTrailWriter, trail, validTrailId } from "../../../electron/trail.mjs";
import { createDashboardApp } from "./app.ts";
import { providersFromEnv } from "./auth/providers.ts";
import { createTestMailbox, mailerFromEnv } from "./auth/mail.ts";
import { mongoMailUsage } from "./auth/mail-router.ts";
import { persisted, useStateBackend } from "./persistence/backend.ts";
import { openMongoBackend } from "./persistence/mongo.ts";
import { mongoSink } from "./analytics/sink.ts";
import { mongoUsageStore } from "./analytics/usage.ts";
import { mongoInfraStore } from "./admin/infra.ts";
import { mongoOpsStore } from "./admin/ops/store.ts";
import { mongoWaitlist } from "./admin/waitlist.ts";
import { openLiveData } from "./admin/live.ts";
import { mongoWarmStore } from "./admin/web-warm.ts";
import { parseAdminEmails } from "./admin/index.ts";
import { emailConfig } from "./email/templates.ts";
import { createIncidents } from "./incidents/index.ts";
import { memoryIncidentStore, mongoIncidentStore } from "./incidents/store.ts";
import { mongoBugReportStore } from "./bug-reports/store.ts";
import { tapConsole, watchDatabase, watchProcess } from "./incidents/process.ts";
import { stateBackend } from "./persistence/backend.ts";
import { gracefulStop, listenWhenFree, readyGate } from "./serve.ts";

const port = Number(process.env.MADANI_DASHBOARD_PORT ?? 7480);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid dashboard port.");
const host = process.env.MADANI_DASHBOARD_HOST ?? "127.0.0.1";
// the port is taken as soon as it is free; requests that come while this start waits for the writer lease and loads
// are held until the app is ready instead of refused
const gate = readyGate();
const server = createServer((req, res) => gate.handle(req, res));
const listening = listenWhenFree(server, { port, host, log: line => console.warn(line) });
let databaseRef: { close(flushMs?: number): Promise<void> } | null = null;
const closers: Array<() => void> = [];
let stopping = false;
async function stop(why: string) {
  if (stopping) return;
  stopping = true;
  console.log(`dashboard service stopping (${why})`);
  // the supervisor (autorunner) sends SIGKILL 5 s after SIGTERM: the pending writes and the lease release fit before it
  const how = await gracefulStop({ server, closeApp: () => { for (const close of closers) close(); }, closeDatabase: () => databaseRef?.close(3_000) ?? Promise.resolve(), hardMs: 4_500,
    log: line => console.warn(line) });
  process.exit(how === "clean" ? 0 : 1);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void stop(signal));
const publicUrl = process.env.MADANI_DASHBOARD_PUBLIC_URL ?? `http://127.0.0.1:${port}`;
const home = process.env.HOME ?? process.env.USERPROFILE;
if (!process.env.MADANI_DASHBOARD_DATA && !home) throw new Error("Set MADANI_DASHBOARD_DATA.");
const dataDir = process.env.MADANI_DASHBOARD_DATA ?? `${home}/.madanibot-dashboard`;
const defaultStatic = decodeURIComponent(new URL("../dist", import.meta.url).pathname);
const staticDir = process.env.MADANI_DASHBOARD_STATIC ?? (existsSync(defaultStatic) ? defaultStatic : null);
const publicAddress = new URL(publicUrl);
const dev = process.env.MADANI_DASHBOARD_DEV === "1" || (publicAddress.protocol === "http:" && ["127.0.0.1", "localhost"].includes(publicAddress.hostname));
const version = (JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string }).version;
const environment = process.env.MADANI_ENVIRONMENT ?? (dev ? "development" : "production");
const service = createErrorReporter({ dsn: process.env.MADANI_ERROR_DSN, component: "dashboard", release: version, environment, spool: fileSpool(`${dataDir}/error-spool`) });
reportProcessErrors(service).flush();
const page = createErrorReporter({ dsn: process.env.MADANI_ERROR_DSN, component: "dashboard-web", release: version, environment });

if (!process.env.MONGODB_URI && !dev) throw new Error("MONGODB_URI is required outside local development (docs/mongodb.md).");
const database = process.env.MONGODB_URI
  ? await openMongoBackend({ uri: process.env.MONGODB_URI, db: process.env.MONGODB_DB || "madani", acquireWaitMs: Infinity,
    onLeaseLost: error => { console.error(error.message); process.exit(1); } })
  : null;
databaseRef = database;
if (database) { useStateBackend(database.backend); console.log("state: mongodb"); } else console.log("state: json files (development)");
// the waitlist the admin shows: MADANI_WAITLIST_DB names the database the madani.bot site writes, "off" shows none
const waitlistDb = process.env.MADANI_WAITLIST_DB?.trim();
const trackOrigins = (process.env.MADANI_TRACK_ORIGINS ?? "").split(",").map(item => item.trim()).filter(Boolean);
const analytics = { ...(database ? { sink: await mongoSink(database.db), usage: await mongoUsageStore(database.db), infra: await mongoInfraStore(database.db), ops: await mongoOpsStore(database.db), db: database.db, waitlist: waitlistDb === "off" ? null : mongoWaitlist(waitlistDb ? database.sibling(waitlistDb) : database.db) } : {}), trackOrigins };
// preview's admin shows madani.bot's analytics: MADANI_ADMIN_ANALYTICS_URI is a user with only read on MADANI_ADMIN_ANALYTICS_DB (madani_prod)
const liveUri = process.env.MADANI_ADMIN_ANALYTICS_URI?.trim(), liveDb = process.env.MADANI_ADMIN_ANALYTICS_DB?.trim();
const live = liveUri && liveDb ? await openLiveData(liveUri, liveDb, "madani.bot")
  .catch((error: Error) => { console.warn(`admin: the live analytics could not be opened (${error.name}); showing this service's own`); return null; }) : null;
if (live) console.log(`admin: analytics read from ${liveDb} (${live.label}), read only`);
const adminEmails = parseAdminEmails(process.env.MADANI_ADMIN_EMAILS);
console.log(`admin: ${adminEmails.length} allowed account${adminEmails.length === 1 ? "" : "s"}`);

// each provider's sends today and this month, for its caps (auth/mail-router.ts); this service counts its own
const mailer = mailerFromEnv(process.env, { dev, usage: database ? await mongoMailUsage(database.db) : undefined });
const alertEmails = process.env.MADANI_ALERT_EMAILS ? parseAdminEmails(process.env.MADANI_ALERT_EMAILS) : adminEmails;
// "something's wrong" mail comes from production only: preview's incidents are test runs and stay on its health page.
// MADANI_ALERTS=on mails from any environment (a one-off check), off from none
const alertsOn = process.env.MADANI_ALERTS !== "off" && alertEmails.length > 0 && (!dev || !!process.env.MADANI_ALERT_EMAILS)
  && (environment === "production" || process.env.MADANI_ALERTS === "on");
// an alert brevo refuses gets a second try through resend, within resend's caps
const fallbackMailer = "only" in mailer ? mailer.only("resend") : null;
const incidentStore = database ? await mongoIncidentStore(database.db).catch(() => { console.warn("incidents: the incidents collection is unavailable; kept in memory"); return memoryIncidentStore(); }) : memoryIncidentStore();
const pagePublic = new URL(publicUrl).origin;
const incidents = createIncidents({ env: environment, store: incidentStore, to: () => alertEmails, mailers: fallbackMailer ? [mailer, fallbackMailer] : [mailer],
  email: emailConfig(process.env, { publicUrl: pagePublic, pageBase: process.env.MADANI_DASHBOARD_PAGE_BASE || "" }), panelUrl: `${pagePublic}/admin/health`, mail: alertsOn });
await incidents.load().catch(() => console.warn("incidents: recent incidents could not be loaded"));
tapConsole(incidents);
watchProcess(incidents, { spoolPath: `${dataDir}/incident-spool` });
watchDatabase(incidents, () => stateBackend()?.health() ?? null);
console.log(`alerts: ${alertsOn ? `emailing ${alertEmails.length} address${alertEmails.length === 1 ? "" : "es"}` : "off"}`);

// mail to @qa.madani.test never leaves the service; only preview and development keep it for test harnesses to read
const testMail = createTestMailbox({ readable: environment === "preview" || dev });
console.log(`test mail: ${testMail.readable ? "kept for harnesses" : "dropped"}`);
// without MongoDB (development) reports are kept in memory; production refuses to start without it above
const bugReportStore = database ? await mongoBugReportStore(database.db) : undefined;
const app = createDashboardApp({ errors: { service, page }, incidents, bugReports: { store: bugReportStore, mail: { on: alertsOn && process.env.MADANI_BUG_REPORT_MAIL === "1", to: () => alertEmails, mailers: fallbackMailer ? [mailer, fallbackMailer] : [mailer] } }, version, dataDir, publicUrl, mailer, testMail, oauth: providersFromEnv(process.env), dev,
  signupOpen: process.env.MADANI_AUTH_SIGNUP_OPEN !== "0", trustProxy: process.env.MADANI_TRUST_PROXY === "1", staticDir: staticDir || null,
  pageBase: process.env.MADANI_DASHBOARD_PAGE_BASE || "", waitlistOnly: process.env.MADANI_PRELAUNCH_WAITLIST_ONLY === "1", mailPerHour: process.env.MADANI_AUTH_MAIL_PER_HOUR ? Number(process.env.MADANI_AUTH_MAIL_PER_HOUR) : undefined, mailPerDay: process.env.MADANI_AUTH_MAIL_PER_DAY ? Number(process.env.MADANI_AUTH_MAIL_PER_DAY) : undefined, siteUpstream: process.env.MADANI_SITE_UPSTREAM || null, linkUpstream: process.env.MADANI_LINK_UPSTREAM || null,
  analytics, admin: { emails: adminEmails, environment, live, readCacheMs: 30_000, warm: database ? { store: await mongoWarmStore(database.db) } : null, backupDir: process.env.MADANI_BACKUP_DIR || (database ? "/root/backups/mongo-madani" : null) } });

/** a client hears an answer only once what the request changed is written; when that fails it gets a dropped
 *  connection, never a success that was not kept */
// the debug trail (electron/trail.mjs): a request the app named with x-madani-trail is one line here, in the same format as
// the app's own, so one action can be followed across machines. MADANI_TRAIL_DIR writes a file; otherwise the service's output.
configureTrail({ src: "cloud", writer: process.env.MADANI_TRAIL_DIR ? createTrailWriter({ dir: process.env.MADANI_TRAIL_DIR, prefix: "trail-cloud", capBytes: 50 * 1024 * 1024 }) : createStdoutWriter() });
function traced(req: IncomingMessage, res: ServerResponse) {
  const cid = req.headers[TRAIL_HEADER];
  if (validTrailId(cid)) {
    const startedAt = Date.now();
    res.once("close", () => trail("cloud.req", { cid, method: req.method, path: req.url, status: res.statusCode, ms: Date.now() - startedAt }));
  }
  return durable(req, res);
}
function durable(req: IncomingMessage, res: ServerResponse) {
  if (database && req.url?.split("?")[0] !== "/v1/health") {
    const end = res.end.bind(res) as (...args: unknown[]) => ServerResponse;
    res.end = ((...args: unknown[]) => {
      persisted().then(() => end(...args), () => { console.error("persistence: a response was dropped because its changes were not written"); res.destroy(); });
      return res;
    }) as ServerResponse["end"];
  }
  return app.handle(req, res);
}
closers.push(() => app.close(), () => void incidents.close());
gate.open(traced);
await listening;
console.log(`dashboard service listening on http://${host}:${port}`);
