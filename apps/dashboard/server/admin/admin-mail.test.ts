// every email the owner or the ops inbox can get, in one place. the policy: a real payment event, a real outage (one
// "something's wrong", one "back to normal") and one daily digest when the day had news. signups, waitlist joins, cloud
// lifecycle, reconciler steps and backups never email: they live in admin and the digest. a new sender fails here first.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAudit } from "../../../cloud-service/src/audit.ts";
import { memorySink } from "../analytics/sink.ts";
import { isTestAccount, isTestAddress, memoryMailer } from "../auth/mail.ts";
import { ALERT_KINDS, createAlerts, parseAlerts } from "./alerts.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dirname, "../../../..");
const SOURCES = ["apps/dashboard/server", "apps/cloud-service/src", "server"];

/** each file that hands a message to a mailer, and who it writes to */
const SENDERS: Record<string, "customer" | "admin"> = {
  "apps/dashboard/server/app.ts": "customer",
  "apps/dashboard/server/auth/index.ts": "customer",
  // paid, spike, digest (ALERT_KINDS below)
  "apps/dashboard/server/admin/alerts.ts": "admin",
  // outages: "something's wrong" once per incident, "back to normal" once, and the daily email of ones the caps held back
  "apps/dashboard/server/incidents/index.ts": "admin",
  // one email per new @devs report, never a repeat, at most RATES.mailsPerDay a day
  "apps/dashboard/server/bug-reports/index.ts": "admin",
};
/** the only places an admin or alert address list reaches a sender */
const ADMIN_WIRING: Record<string, RegExp[]> = {
  "apps/dashboard/server/app.ts": [/createAlerts\(\{[^\n]*emails: \(\) => adminEmails/],
  "apps/dashboard/server/main.ts": [/createIncidents\(\{[^\n]*to: \(\) => alertEmails/, /bugReports: \{[^\n]*mail: \{ on: alertsOn && process\.env\.MADANI_BUG_REPORT_MAIL === "1", to: \(\) => alertEmails/],
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) return [];
    return statSync(path).isDirectory() ? files(path) : /\.(ts|mjs|js)$/.test(name) && !/\.test\.|\.spec\./.test(name) ? [path] : [];
  });
}
const sources = SOURCES.flatMap(dir => files(join(ROOT, dir))).map(path => ({ path: relative(ROOT, path), text: readFileSync(path, "utf8") }));

describe("admin and ops email triggers", () => {
  afterEach(() => vi.restoreAllMocks());

  it("only paid, spike and digest are admin alert kinds", () => {
    expect([...ALERT_KINDS]).toEqual(["paid", "spike", "digest"]);
    expect([...parseAlerts("all")]).toEqual(["paid", "spike", "digest"]);
    expect([...parseAlerts("signup,waitlist,digest")]).toEqual(["digest"]);
  });

  it("every file that sends mail is known, and only alerts and incidents write to the admins", () => {
    const sending = sources.filter(file => /\bmailers?\b[^\n;]*\.send\(|\.mailer\.send\(|\bmailer\.send\(/.test(file.text)).map(file => file.path).sort();
    expect(sending).toEqual(Object.keys(SENDERS).sort());
  });

  it("admin addresses reach a sender only through alerts and incidents", () => {
    for (const file of sources) {
      expect(file.text, `${file.path} names the retired ops inbox`).not.toMatch(/MADANI_OPS_ALERT_EMAIL/);
      const uses = file.text.split("\n").filter(line => /\b(adminEmails|alertEmails)\b/.test(line) && /\b(to|emails):\s*\(\)\s*=>/.test(line));
      const allowed = ADMIN_WIRING[file.path] ?? [];
      for (const line of uses) expect(allowed.some(pattern => pattern.test(line)), `${file.path}: ${line.trim().slice(0, 120)}`).toBe(true);
      if (allowed.length) expect(uses).toHaveLength(allowed.length);
    }
  });

  it("with every kind on, a quiet day, signups and waitlist joins send nothing", async () => {
    const time = { now: Date.parse("2026-11-14T09:00:00Z") }, mailer = memoryMailer(), sink = memorySink(() => time.now);
    const alerts = createAlerts({ kinds: parseAlerts("all"), emails: () => ["owner@example.test"], mailer, sink, now: () => time.now, panelUrl: "https://madani.bot/admin",
      totals: () => ({ signups: 0, paid: 0, waitlist: null, accounts: 3, clouds: { ready: 0, deleted: 0 } }) });
    await alerts.tick(); await alerts.tick();
    expect(mailer.outbox).toEqual([]);
    expect(Object.keys(alerts).sort()).toEqual(["close", "money", "paid", "tick"]);
    alerts.close();
  });

  it("a cloud deletion step is a plain log line, never an ALERT (which the console tap turns into an incident email)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {}), log = vi.spyOn(console, "log").mockImplementation(() => {});
    const hook = vi.fn();
    const audit = createAudit({ dataDir: mkdtempSync(join(tmpdir(), "audit-")), alert: hook });
    for (const action of ["delete_requested", "delete_accepted", "delete_refused", "deleted", "backups_deleted"]) audit.record({ cloudId: "c1", action, actor: "reconciler", reason: "owner_requested" });
    expect(warn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(5);
    expect(hook).toHaveBeenCalledTimes(5);
  });

  it("harness accounts never get courtesy mail, and madani.bot's own qa addresses never leave the service", () => {
    for (const address of ["a@qa.madani.test", "qa@madani.bot", "qa-smoke@madani.bot", "qa-smoke+buy-11140117@madani.bot", "QA-JP1@madani.bot"]) expect(isTestAddress(address), address).toBe(true);
    for (const address of ["madani-e2e-mwcp8u9n@fldubai.com", "madani-appconn-mwf6kpmf@fldubai.com"]) expect([isTestAddress(address), isTestAccount(address)], address).toEqual([false, true]);
    for (const address of ["hello@madani.bot", "quinn@madani.bot", "someone@gmail.com", "qa@example.com"]) expect(isTestAccount(address), address).toBe(false);
  });
});
