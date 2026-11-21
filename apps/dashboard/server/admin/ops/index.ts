import { timingSafeEqual, createHash } from "node:crypto";
import type { Db } from "mongodb";
import type { OpsAccountsAnswer, OpsAccountsRange, OpsAnswer, OpsSuspect, OpsBox, OpsCheck, OpsLevel, OpsMeter, OpsRule, OpsSource, OpsSourceId, OpsSpend } from "../../../src/admin/ops-types.ts";
import type { StoredCloud } from "../../clouds/types.ts";
import type { LedgerEntry } from "../../billing/ledger.ts";
import type { ErrorCounter } from "../health.ts";
import { DODO_FEE, type InfraStore, type MarginCustomer } from "../infra.ts";
import {
  collectBrevo, collectCerts, collectCloudflare, collectComposio, collectHost, collectMongo, collectProbes, collectRelay, CollectorError, dayKey, monthStart, parseReport, probeTargets,
  type BrevoData, type CertData, type CloudflareData, type ComposioData, type HostData, type MongoData, type ProbeResult, type RelayData, type ReportData,
} from "./collectors.ts";
import { median, ratioOf, robustZ, step, suspects, type SignalInput, type SignalSpec } from "./math.ts";
import type { OpsDaily, OpsRuleState, OpsStore } from "./store.ts";
import { RELAY_RULE_PREFIX, relayNodeReadings } from "./relay-alerts.ts";
import { createRelays } from "./relays.ts";
import { rangeDays, topAccounts } from "./accounts.ts";
import type { OpsRelayCard } from "../../../src/admin/ops-types.ts";
import { FIXTURE_MAIL, FIXTURE_PEOPLE } from "./fixture.ts";
import type { MailUsage } from "../../auth/mail-router.ts";

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR, GB_BYTES = 1e9;
/** Cloudflare Workers Paid, as of 2026-11: $5 a month with 10m requests and 30m CPU ms, then $0.30 per million requests and $0.02 per million CPU ms */
export const WORKERS_PLAN = { label: "workers paid", baseCents: 500, includedRequests: 10_000_000, includedCpuMs: 30_000_000, requestCentsPerMillion: 30, cpuCentsPerMillionMs: 2 } as const;
/** R2 standard storage: 10 gb-month free, then $0.015 per gb-month */
export const R2_PLAN = { freeBytes: 10 * GB_BYTES, centsPerGbMonth: 1.5 } as const;
/** the composio broker's limits (apps/cloudflare/composio-broker/src/budgets.ts) */
export const BREVO_MONTHLY_BUDGET = 10_000;
/** the ops_latest entry with each account's plan and the people to look at */
export const ACCOUNT_NOTES = "account-notes";
export interface AccountNotes { plans: Record<string, string>; suspects: OpsSuspect[] }
export const COMPOSIO_LIMITS = { installation: 10_000, account: 50_000 } as const;

export const THRESHOLDS = {
  r2Bytes: 8 * GB_BYTES, diskPct: 85, memPct: 90, memForMs: 10 * MINUTE, downForMs: 4 * MINUTE, backupHours: 26, reportStaleMs: 30 * MINUTE,
  certWatchDays: 21, certBadDays: 10, outlierRatio: 3, outlierFloorCents: 1_000, outlierFloorEgressGb: 50,
  /** contabo upload: sustained past this share of MADANI_OPS_UPLINK_MBIT for this long is an incident */
  uploadPct: 70, uploadForMs: 15 * MINUTE,
  /** the account database past this size (all its data, indexes not counted); brevo's day past this share of its limit */
  mongoBytes: 5 * GB_BYTES, brevoDayPct: 80,
  /** resend's day past this share of its cap: codes start going through brevo (and its promotions tab) soon */
  resendDayPct: 80,
} as const;

type Level = OpsLevel;
const SOURCES: Array<{ id: OpsSourceId; label: string; every: "5m" | "1h" }> = [
  { id: "host", label: "contabo box", every: "5m" }, { id: "probes", label: "service checks", every: "5m" }, { id: "mongo", label: "mongodb", every: "5m" },
  { id: "oracle", label: "oracle box", every: "5m" }, { id: "certs", label: "certificates and dns", every: "1h" }, { id: "cloudflare", label: "cloudflare", every: "1h" },
  { id: "brevo", label: "brevo", every: "1h" }, { id: "composio", label: "composio broker", every: "1h" }, { id: "relay", label: "link relay", every: "1h" },
];

export interface OpsIncidents {
  report(input: { source: "ops"; name: string; message: string; key: string }): string | null;
  recovered(id: string, message: string): Promise<boolean>;
}
export interface OpsOptions {
  store: OpsStore;
  env: NodeJS.ProcessEnv;
  now: () => number;
  fetch?: typeof fetch;
  db: Db | null;
  infra: InfraStore;
  clouds: () => readonly StoredCloud[];
  egress: (cloud: StoredCloud) => "slowed" | "paused" | null;
  emails: () => Map<string, string>;
  customers: () => readonly MarginCustomer[];
  ledger: () => readonly LedgerEntry[];
  invoices: () => ReadonlyArray<{ accountId: string; status: string; createdAt: number }>;
  errors: ErrorCounter;
  incidents: OpsIncidents | null;
  /** this service's public origin, probed as the account service */
  selfUrl: string | null;
  environment: string;
  /** made-up answers for the fixture service when nothing was collected */
  fixture?: () => OpsAnswer;
  /** the host sampler reads this box; off in tests */
  host?: boolean;
  /** this service's sends per mail provider against its caps (auth/mail-router.ts); null with console mail */
  mailUsage?: (() => Promise<MailUsage>) | null;
}

const sameToken = (presented: string, expected: string) => {
  const a = createHash("sha256").update(presented).digest(), b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
};
const pct = (n: number | null | undefined) => n === null || n === undefined ? "?" : `${Math.round(n)}%`;
const gb = (bytes: number) => bytes >= 10 * GB_BYTES ? `${Math.round(bytes / GB_BYTES)} gb` : `${Math.round(bytes / GB_BYTES * 10) / 10} gb`;
const millions = (n: number) => n >= 1e6 ? `${Math.round(n / 1e5) / 10}m` : n >= 1e3 ? `${Math.round(n / 100) / 10}k` : String(n);
const ago = (ms: number) => ms < HOUR ? `${Math.max(1, Math.round(ms / MINUTE))}m ago` : ms < 2 * DAY ? `${Math.round(ms / HOUR)}h ago` : `${Math.round(ms / DAY)} days ago`;
const levelOf = (value: number | null, watch: number, bad: number): Level => value === null ? "unknown" : value >= bad ? "bad" : value >= watch ? "watch" : "ok";
const meter = (used: number, limit: number | null, projected: number | null): OpsMeter =>
  ({ used, limit, projected, level: limit === null ? "unknown" : used >= limit ? "bad" : (projected ?? used) >= limit ? "watch" : "ok" });

/** the env names each collector needs; a collector without them is shown as not configured and never runs */
export function opsConfig(env: NodeJS.ProcessEnv) {
  const cfToken = env.MADANI_CF_ANALYTICS_TOKEN || "", cfAccount = env.MADANI_CF_ACCOUNT_ID || "";
  return {
    cloudflare: cfToken && cfAccount ? { token: cfToken, accountId: cfAccount } : null,
    brevo: env.MADANI_BREVO_API_KEY ? { apiKey: env.MADANI_BREVO_API_KEY } : null,
    composio: env.MADANI_COMPOSIO_BROKER_STATS_TOKEN ? { url: env.MADANI_COMPOSIO_BROKER_URL || "https://composio.madani.bot", token: env.MADANI_COMPOSIO_BROKER_STATS_TOKEN } : null,
    relay: env.MADANI_LINK_STATS_TOKEN ? { url: env.MADANI_LINK_URL || "https://link.madani.bot", token: env.MADANI_LINK_STATS_TOKEN } : null,
    reportToken: env.MADANI_OPS_REPORT_TOKEN && env.MADANI_OPS_REPORT_TOKEN.length >= 24 ? env.MADANI_OPS_REPORT_TOKEN : null,
    backupSets: (env.MADANI_OPS_BACKUP_SETS ?? "madani make").split(/[\s,]+/).filter(set => /^[a-z0-9-]{1,40}$/.test(set)),
    certHosts: (env.MADANI_OPS_CERT_HOSTS ?? "madani.bot preview.madani.bot link.madani.bot composio.madani.bot").split(/[\s,]+/).filter(host => /^[a-z0-9.-]{3,253}$/.test(host)),
    brevoDaily: Number(env.MADANI_BREVO_DAILY_LIMIT) > 0 ? Number(env.MADANI_BREVO_DAILY_LIMIT) : 300,
    brevoMonthly: Number(env.MADANI_BREVO_MONTHLY_LIMIT) > 0 ? Number(env.MADANI_BREVO_MONTHLY_LIMIT) : null,
    /** MADANI_OPS_FIXED_CENTS: "contabo vps=1500,oracle=0": flat monthly bills shown as spend lines */
    /** MADANI_OPS_UPLINK_MBIT: contabo's dependable upload (the lowest measured, 120); MADANI_OPS_EGRESS_ALLOWANCE_TB: its monthly outgoing allowance */
    uplinkMbit: Number(env.MADANI_OPS_UPLINK_MBIT) > 0 ? Number(env.MADANI_OPS_UPLINK_MBIT) : 120,
    egressAllowanceBytes: (Number(env.MADANI_OPS_EGRESS_ALLOWANCE_TB) > 0 ? Number(env.MADANI_OPS_EGRESS_ALLOWANCE_TB) : 32) * 1e12,
    fixed: (env.MADANI_OPS_FIXED_CENTS ?? "").split(",").flatMap(part => { const [label, cents] = part.split("="); const n = Number(cents); return label?.trim() && Number.isSafeInteger(n) && n >= 0 ? [{ label: label.trim().toLowerCase().slice(0, 40), cents: n }] : []; }),
  };
}

export function createOps(options: OpsOptions) {
  const { store, now } = options;
  const fetcher = options.fetch ?? fetch;
  const config = opsConfig(options.env);
  // production only unless MADANI_OPS_ALERTS says otherwise, so preview on the same box never doubles an email
  const alertsOn = options.env.MADANI_OPS_ALERTS === "on" || (options.env.MADANI_OPS_ALERTS !== "off" && options.environment === "production");
  const targets = probeTargets(options.env.MADANI_OPS_PROBES, options.selfUrl);
  const counters = { limited: new Map<string, number>(), signups: new Map<string, { count: number; accounts: Set<string> }>(), mail: new Map<string, { sent: number; codes: number }>() };
  let hostPrev: { data: HostData; at: number } | null = null;
  let running: Promise<string[]> | null = null, closed = false;
  const timers: Array<ReturnType<typeof setInterval>> = [];

  async function save(source: OpsSourceId, work: () => Promise<unknown>, sample?: (data: any) => unknown): Promise<boolean> {
    const at = now();
    try {
      const data = await work();
      await store.setLatest({ source, at, ok: true, error: null, data });
      if (sample) await store.addSample({ source, at, data: sample(data) });
      return true;
    } catch (error) {
      const message = error instanceof CollectorError ? error.message : `${source} failed (${error instanceof Error ? error.name : "error"})`;
      const before = (await store.latest()).find(entry => entry.source === source);
      await store.setLatest({ source, at, ok: false, error: message, data: before?.data ?? null });
      return false;
    }
  }

  async function flushCounters() {
    const day = dayKey(now()), rows: OpsDaily[] = [];
    for (const [ip, count] of counters.limited) rows.push({ source: "limited", day, key: ip, accountId: null, values: { count } });
    for (const [ip, item] of counters.signups) rows.push({ source: "signups", day, key: ip, accountId: [...item.accounts].at(-1) ?? null, values: { count: item.count } });
    for (const [accountId, item] of counters.mail) rows.push({ source: "mail", day, key: accountId, accountId, values: { sent: item.sent, codes: item.codes } });
    counters.limited.clear(); counters.signups.clear(); counters.mail.clear();
    await store.addDaily(rows);
  }

  async function health(): Promise<string[]> {
    const ran: string[] = [];
    const jobs: Array<Promise<void>> = [];
    if (options.host !== false && process.platform === "linux") jobs.push(save("host", async () => {
      const data = await collectHost({ now: now(), previous: hostPrev?.data ?? null, previousAt: hostPrev?.at ?? null, backupSets: config.backupSets });
      hostPrev = { data, at: now() };
      return data;
    }, (data: HostData) => ({ cpu: data.cpu, mem: data.mem, disk: data.disk })).then(() => { ran.push("host"); }));
    jobs.push(save("probes", () => collectProbes(targets, fetcher)).then(() => { ran.push("probes"); }));
    if (options.db) jobs.push(save("mongo", () => collectMongo(options.db!)).then(() => { ran.push("mongo"); }));
    jobs.push(flushCounters().catch(() => {}));
    await Promise.all(jobs);
    return ran;
  }

  async function usage(): Promise<string[]> {
    const ran: string[] = [];
    const at = now();
    await Promise.all([
      config.cloudflare && save("cloudflare", () => collectCloudflare({ ...config.cloudflare!, now: at, fetch: fetcher })).then(() => { ran.push("cloudflare"); }),
      config.brevo && save("brevo", () => collectBrevo({ ...config.brevo!, now: at, fetch: fetcher })).then(() => { ran.push("brevo"); }),
      config.composio && save("composio", async () => {
        const data = await collectComposio({ ...config.composio!, fetch: fetcher });
        const owner = machineOwner();
        await store.putDaily(data.installations.flatMap(inst => Object.entries(inst.days).map(([day, calls]) => ({ source: "tool_calls", day, key: inst.id, accountId: owner(inst.machine), values: { calls } }))));
        await store.putDaily(data.registrations.map(r => ({ source: "registrations", day: r.day, key: r.ip, accountId: null, values: { count: r.count } })));
        return data;
      }).then(() => { ran.push("composio"); }),
      config.relay && save("relay", async () => {
        const data = await collectRelay({ ...config.relay!, fetch: fetcher });
        await store.putDaily(data.tunnels.flatMap(t => Object.entries(t.days).map(([day, v]) => ({ source: "relay", day, key: t.id, accountId: t.accountId, values: { bytes: v.bytes, limited: v.limited } }))));
        return data;
      }).then(() => { ran.push("relay"); }),
      save("certs", () => collectCerts(config.certHosts)).then(() => { ran.push("certs"); }),
    ]);
    return ran;
  }

  function machineOwner() {
    const clouds = options.clouds();
    return (machine: string | null) => machine ? clouds.find(c => c.id === machine || c.serverId === machine)?.accountId ?? null : null;
  }

  /** each account's plan and the people to look at, kept in ops_latest so another service's admin can read them (preview reading madani.bot) */
  async function saveAccountNotes() {
    const snap = await snapshot(), emails = options.emails();
    const data: AccountNotes = { plans: Object.fromEntries(options.customers().map(c => [c.accountId, c.plan])), suspects: abuseOf(snap, spendOf(snap, emails), emails) };
    await store.setLatest({ source: ACCOUNT_NOTES, at: now(), ok: true, error: null, data });
  }

  /** collects (both cadences when `all`), then checks the alert rules; a second call while one runs joins it */
  function collect(all = true): Promise<string[]> {
    if (running) return running;
    running = (async () => {
      const ran = [...await health(), ...(all ? await usage() : [])];
      await evaluate().catch(error => console.warn(`ops: the alert rules could not be checked (${(error as Error).message})`));
      await saveAccountNotes().catch(error => console.warn(`ops: the account notes could not be saved (${(error as Error).message})`));
      return ran;
    })().finally(() => { running = null; });
    return running;
  }

  async function report(body: Record<string, unknown>): Promise<boolean> {
    const parsed = parseReport(body);
    if (!parsed) return false;
    const source = parsed.host === "oracle" ? "oracle" : `report-${parsed.host}`;
    await store.setLatest({ source, at: now(), ok: true, error: null, data: parsed });
    await store.addSample({ source, at: now(), data: { cpu: parsed.cpu, mem: parsed.mem, disk: parsed.disk } });
    return true;
  }
  function authorizeReport(header: string | undefined): "ok" | "off" | "denied" {
    if (!config.reportToken) return "off";
    const presented = /^Bearer (\S{24,512})$/.exec(header ?? "")?.[1];
    return presented && sameToken(presented, config.reportToken) ? "ok" : "denied";
  }

  async function snapshot() {
    const time = now(), start = monthStart(time), today = dayKey(time), from = dayKey(start);
    const [latestList, infraRows, relayRows, toolRows, registrationRows, limitedRows, signupRows, ruleStates, mail] = await Promise.all([
      store.latest(), options.infra.range(from, today), store.daily("relay", from, today), store.daily("tool_calls", dayKey(time - 6 * DAY), today),
      store.daily("registrations", today, today), store.daily("limited", today, today), store.daily("signups", today, today), store.rules(),
      options.mailUsage ? options.mailUsage().catch(() => null) : null,
    ]);
    const latest = new Map(latestList.map(entry => [entry.source, entry]));
    return { time, start, today, latest, infraRows, relayRows, toolRows, registrationRows, limitedRows, signupRows, ruleStates, mail };
  }
  type Snapshot = Awaited<ReturnType<typeof snapshot>>;
  const dataOf = <T>(snap: Snapshot, source: string): T | null => (snap.latest.get(source)?.data as T | undefined) ?? null;

  function instabox(snap: Snapshot, emails: Map<string, string>) {
    const elapsed = elapsedOf(snap.time);
    const clouds = new Map(options.clouds().map(c => [c.id, c]));
    const machines = new Map<string, { cloudId: string; accountId: string; serverId: string; running: number; vcpu: number; mem: number; disk: number; diskDays: number; egress: number; cost: number; today: number }>();
    const days = new Map<string, { cost: number; egress: number; running: number }>();
    for (const row of snap.infraRows) {
      const m = machines.get(row.cloudId) ?? { cloudId: row.cloudId, accountId: row.accountId, serverId: row.serverId, running: 0, vcpu: 0, mem: 0, disk: 0, diskDays: 0, egress: 0, cost: 0, today: 0 };
      m.running += row.runningSeconds; m.vcpu += row.vcpuSeconds; m.mem += row.memGiBSeconds; m.disk += row.diskGiBSeconds; m.diskDays++; m.egress += row.egressBytes; m.cost += row.costCents; m.serverId = row.serverId;
      if (row.day === snap.today) m.today += row.costCents;
      machines.set(row.cloudId, m);
      const d = days.get(row.day) ?? { cost: 0, egress: 0, running: 0 };
      d.cost += row.costCents; d.egress += row.egressBytes; d.running += row.runningSeconds;
      days.set(row.day, d);
    }
    const egressState = (cloudId: string) => { const c = clouds.get(cloudId); return c ? options.egress(c) : null; };
    const machineRows = [...machines.values()].map(m => ({
      cloudId: m.cloudId, accountId: m.accountId, email: emails.get(m.accountId) ?? null, serverId: m.serverId,
      awakeHours: round1(m.running / 3600), vcpuHours: round1(m.vcpu / 3600), memGiBHours: round1(m.mem / 3600), diskGiB: round1(m.diskDays ? m.disk / (m.diskDays * 86_400) : 0),
      egressGb: round1(m.egress / GB_BYTES), costCents: Math.round(m.cost), todayCents: Math.round(m.today), egressState: egressState(m.cloudId),
    })).sort((a, b) => b.costCents - a.costCents);
    const plans = new Map(options.customers().map(c => [c.accountId, c.plan]));
    const byAccount = new Map<string, typeof machineRows>();
    for (const m of machineRows) byAccount.set(m.accountId, [...byAccount.get(m.accountId) ?? [], m]);
    const worst = (states: Array<"slowed" | "paused" | null>) => states.includes("paused") ? "paused" as const : states.includes("slowed") ? "slowed" as const : null;
    const customers = [...byAccount].map(([accountId, list]) => {
      const sum = (pick: (m: typeof list[number]) => number) => round1(list.reduce((s, m) => s + pick(m), 0));
      const costCents = Math.round(list.reduce((s, m) => s + m.costCents, 0));
      return { accountId, email: emails.get(accountId) ?? null, plan: plans.get(accountId) ?? "none", machines: list.length, awakeHours: sum(m => m.awakeHours), vcpuHours: sum(m => m.vcpuHours),
        memGiBHours: sum(m => m.memGiBHours), egressGb: sum(m => m.egressGb), costCents, projectedCents: Math.round(costCents / elapsed), egressState: worst(list.map(m => m.egressState)) };
    }).sort((a, b) => b.costCents - a.costCents);
    const outliers = (["awake", "egress", "cost"] as const).flatMap(metric => {
      const pick = (c: typeof customers[number]) => metric === "awake" ? c.awakeHours : metric === "egress" ? c.egressGb : c.costCents;
      const values = customers.map(pick), mid = median(values);
      return customers.map(c => ({ accountId: c.accountId, email: c.email, metric, value: pick(c), median: round1(mid), ratio: ratioOf(pick(c), mid, metric === "cost" ? 100 : 1), z: robustZ(pick(c), values) }));
    }).filter(o => (o.ratio ?? 0) >= 2 || (o.z ?? 0) >= 3).sort((a, b) => (b.z ?? b.ratio ?? 0) - (a.z ?? a.ratio ?? 0) || (b.ratio ?? 0) - (a.ratio ?? 0)).slice(0, 10);
    const limited = machineRows.filter(m => m.egressState).map(m => ({ accountId: m.accountId, email: m.email, cloudId: m.cloudId, state: m.egressState!, egressGb: m.egressGb }));
    for (const c of options.clouds()) {
      const state = options.egress(c);
      if (state && !limited.some(row => row.cloudId === c.id)) limited.push({ accountId: c.accountId, email: emails.get(c.accountId) ?? null, cloudId: c.id, state, egressGb: 0 });
    }
    const cost = customers.reduce((s, c) => s + c.costCents, 0);
    return {
      totals: { machines: machineRows.length, customers: customers.length, awakeHours: round1(machineRows.reduce((s, m) => s + m.awakeHours, 0)), vcpuHours: round1(machineRows.reduce((s, m) => s + m.vcpuHours, 0)),
        memGiBHours: round1(machineRows.reduce((s, m) => s + m.memGiBHours, 0)), egressGb: round1(machineRows.reduce((s, m) => s + m.egressGb, 0)), costCents: cost,
        todayCents: machineRows.reduce((s, m) => s + m.todayCents, 0), projectedCents: Math.round(cost / elapsed) },
      days: [...days].sort((a, b) => a[0].localeCompare(b[0])).map(([day, d]) => ({ day, costCents: Math.round(d.cost), egressGb: round1(d.egress / GB_BYTES), awakeHours: round1(d.running / 3600) })),
      machines: machineRows, customers, outliers, limited,
    };
  }

  function workersOf(snap: Snapshot): OpsSpend["workers"] {
    const cf = dataOf<CloudflareData>(snap, "cloudflare");
    if (!cf) return null;
    const elapsed = elapsedOf(snap.time);
    const scripts = new Map<string, { requests: number; cpuMs: number; errors: number; todayRequests: number; todayCpuMs: number }>();
    const days = new Map<string, { requests: number; cpuMs: number }>();
    for (const row of cf.days) {
      const s = scripts.get(row.script) ?? { requests: 0, cpuMs: 0, errors: 0, todayRequests: 0, todayCpuMs: 0 };
      s.requests += row.requests; s.cpuMs += row.cpuMs; s.errors += row.errors;
      if (row.day === snap.today) { s.todayRequests += row.requests; s.todayCpuMs += row.cpuMs; }
      scripts.set(row.script, s);
      const d = days.get(row.day) ?? { requests: 0, cpuMs: 0 };
      d.requests += row.requests; d.cpuMs += row.cpuMs; days.set(row.day, d);
    }
    const requests = [...scripts.values()].reduce((s, r) => s + r.requests, 0), cpuMs = [...scripts.values()].reduce((s, r) => s + r.cpuMs, 0);
    const projectedRequests = Math.round(requests / elapsed), projectedCpu = Math.round(cpuMs / elapsed);
    return {
      plan: { ...WORKERS_PLAN }, requests: meter(requests, WORKERS_PLAN.includedRequests, projectedRequests), cpuMs: meter(cpuMs, WORKERS_PLAN.includedCpuMs, projectedCpu),
      overageCents: workersOverage(projectedRequests, projectedCpu),
      scripts: [...scripts].map(([name, s]) => ({ name, ...s })).sort((a, b) => b.requests - a.requests),
      days: [...days].sort((a, b) => a[0].localeCompare(b[0])).map(([day, d]) => ({ day, ...d })),
    };
  }

  function r2Of(snap: Snapshot): OpsSpend["r2"] {
    const cf = dataOf<CloudflareData>(snap, "cloudflare");
    if (!cf) return null;
    const used = cf.buckets.reduce((s, b) => s + b.bytes, 0);
    return { freeBytes: R2_PLAN.freeBytes, total: { ...meter(used, R2_PLAN.freeBytes, null), level: used >= R2_PLAN.freeBytes ? "bad" : used >= THRESHOLDS.r2Bytes ? "watch" : "ok" },
      overageCents: r2Overage(used), buckets: cf.buckets };
  }

  function composioOf(snap: Snapshot, emails: Map<string, string>): OpsSpend["composio"] {
    const data = dataOf<ComposioData>(snap, "composio");
    if (!data) return null;
    const byInst = new Map<string, { accountId: string | null; today: number; week: number }>();
    for (const row of snap.toolRows) {
      const inst = byInst.get(row.key) ?? { accountId: row.accountId, today: 0, week: 0 };
      inst.week += row.values.calls ?? 0;
      if (row.day === snap.today) inst.today += row.values.calls ?? 0;
      inst.accountId ??= row.accountId;
      byInst.set(row.key, inst);
    }
    const todayCalls = [...byInst.values()].reduce((s, i) => s + i.today, 0);
    return {
      limits: { ...COMPOSIO_LIMITS },
      today: { calls: todayCalls, installations: [...byInst.values()].filter(i => i.today > 0).length },
      week: { calls: [...byInst.values()].reduce((s, i) => s + i.week, 0) },
      days: data.days,
      top: [...byInst].map(([installationId, i]) => ({ installationId, accountId: i.accountId, email: i.accountId ? emails.get(i.accountId) ?? null : null, today: i.today, week: i.week, share: todayCalls ? Math.round(i.today / todayCalls * 1000) / 1000 : 0 }))
        .sort((a, b) => b.today - a.today || b.week - a.week).slice(0, 10),
      nearLimit: [...byInst.values()].filter(i => i.today >= COMPOSIO_LIMITS.installation * 0.8).length,
      queue: data.queue,
      registrationsTopIp: snap.registrationRows.map(r => ({ ip: r.key, today: r.values.count ?? 0 })).sort((a, b) => b.today - a.today).slice(0, 5),
    };
  }

  function brevoOf(snap: Snapshot): OpsSpend["brevo"] {
    const data = dataOf<BrevoData>(snap, "brevo");
    if (!data) return null;
    const free = data.plan?.type === "free";
    const daily = free || !data.plan ? config.brevoDaily : null;
    // the owner budgets 10,000 a month when neither the env nor the plan says
    const monthly = config.brevoMonthly ?? (!free && data.plan?.credits != null ? data.plan.credits + data.month.sent : BREVO_MONTHLY_BUDGET);
    return { today: data.today, month: data.month, plan: data.plan?.type ?? null,
      daily: meter(data.today.sent, daily, null), monthly: meter(data.month.sent, monthly, Math.round(data.month.sent / elapsedOf(snap.time))) };
  }

  function mailOf(snap: Snapshot): OpsSpend["mail"] {
    if (!snap.mail) return null;
    const elapsed = elapsedOf(snap.time);
    return { providers: snap.mail.providers.map(p => ({ provider: p.provider, configured: p.configured,
      sends: p.provider === "resend" ? "codes, receipts and cloud ready" : "everything else",
      daily: meter(p.today.sent, p.caps.daily, null), monthly: meter(p.month.sent, p.caps.monthly, Math.round(p.month.sent / elapsed)),
      fallbacks: { today: p.today.fallbacks, month: p.month.fallbacks }, lastError: p.lastError })) };
  }

  function dodoOf(snap: Snapshot): OpsSpend["dodo"] {
    let monthCents = 0, todayCents = 0, payments = 0, grossCents = 0, lastWebhookAt: number | null = null;
    const todayStart = Date.parse(`${snap.today}T00:00:00Z`);
    for (const entry of options.ledger()) {
      if (entry.via === "webhook" && (lastWebhookAt === null || entry.recordedAt > lastWebhookAt)) lastWebhookAt = entry.recordedAt;
      if (entry.type !== "payment.succeeded" || !entry.amountCents || entry.at < snap.start) continue;
      const fee = entry.amountCents * DODO_FEE.rate + DODO_FEE.fixedCents;
      monthCents += fee; payments++; grossCents += entry.amountCents;
      if (entry.at >= todayStart) todayCents += fee;
    }
    return { monthCents: Math.round(monthCents), todayCents: Math.round(todayCents), payments, grossCents, rate: { ...DODO_FEE }, estimated: true, lastWebhookAt };
  }

  function relayOf(snap: Snapshot, emails: Map<string, string>): OpsSpend["relay"] {
    const data = dataOf<RelayData>(snap, "relay");
    if (!data) return null;
    const byTunnel = new Map<string, { accountId: string | null; today: number; month: number; limited: number }>();
    const days = new Map<string, number>();
    for (const row of snap.relayRows) {
      const t = byTunnel.get(row.key) ?? { accountId: row.accountId, today: 0, month: 0, limited: 0 };
      t.month += row.values.bytes ?? 0;
      if (row.day === snap.today) { t.today += row.values.bytes ?? 0; t.limited += row.values.limited ?? 0; }
      byTunnel.set(row.key, t);
      days.set(row.day, (days.get(row.day) ?? 0) + (row.values.bytes ?? 0));
    }
    const list = [...byTunnel.values()];
    return {
      dailyLimitBytes: data.limitBytes,
      today: { bytes: list.reduce((s, t) => s + t.today, 0), tunnels: list.filter(t => t.today > 0).length, limited: list.reduce((s, t) => s + t.limited, 0) },
      month: { bytes: list.reduce((s, t) => s + t.month, 0) },
      days: [...days].sort((a, b) => a[0].localeCompare(b[0])).map(([day, bytes]) => ({ day, bytes })),
      top: [...byTunnel].map(([tunnelId, t]) => ({ tunnelId, accountId: t.accountId, email: t.accountId ? emails.get(t.accountId) ?? null : null, todayBytes: t.today, monthBytes: t.month, limited: t.limited }))
        .sort((a, b) => b.todayBytes - a.todayBytes || b.monthBytes - a.monthBytes).slice(0, 10),
    };
  }

  function spendOf(snap: Snapshot, emails: Map<string, string>): OpsSpend {
    const elapsed = elapsedOf(snap.time);
    const box = instabox(snap, emails), workers = workersOf(snap), r2 = r2Of(snap), dodo = dodoOf(snap);
    const used = workers ? workersOverage(workers.requests.used, workers.cpuMs.used) : 0;
    const lines: OpsSpend["lines"] = [
      { provider: "instabox", label: "instabox", monthCents: box.totals.costCents, projectedCents: box.totals.projectedCents, note: "compute and disk at list prices" },
      { provider: "workers", label: "cloudflare workers", monthCents: WORKERS_PLAN.baseCents + used, projectedCents: WORKERS_PLAN.baseCents + (workers?.overageCents ?? 0),
        note: workers ? workers.overageCents ? `$5 base and $${(workers.overageCents / 100).toFixed(2)} over at this pace` : "$5 base, no overage at this pace" : "$5 base; usage not collected yet" },
      { provider: "r2", label: "r2 storage", monthCents: r2?.overageCents ?? 0, projectedCents: r2?.overageCents ?? 0, note: r2 ? r2.overageCents ? "past the 10 gb free tier" : "inside the 10 gb free tier" : "not collected yet" },
      { provider: "dodo", label: "dodo fees", monthCents: dodo.monthCents, projectedCents: Math.round(dodo.monthCents / elapsed), note: `${DODO_FEE.rate * 100}% + ${DODO_FEE.fixedCents}¢ a payment, estimated` },
    ];
    const fixed = config.fixed.map(item => ({ provider: "instabox" as const, label: item.label, monthCents: Math.round(item.cents * elapsed), projectedCents: item.cents, note: "flat monthly" }));
    const all = [...lines, ...fixed];
    return {
      totals: { monthCents: all.reduce((s, l) => s + l.monthCents, 0), projectedCents: all.reduce((s, l) => s + l.projectedCents, 0), todayCents: box.totals.todayCents + dodo.todayCents },
      lines: all, instabox: box, workers, r2, composio: composioOf(snap, emails), brevo: brevoOf(snap), mail: mailOf(snap), dodo, relay: relayOf(snap, emails),
    };
  }

  async function boxesOf(snap: Snapshot): Promise<OpsBox[]> {
    const since = snap.time - DAY;
    const [hostSeries, oracleSeries] = await Promise.all([store.samples("host", since, 300), store.samples("oracle", since, 300)]);
    const series = (list: Awaited<ReturnType<OpsStore["samples"]>>) => list.map(s => { const d = s.data as { cpu: number | null; mem: number | null; disk: number | null }; return { at: s.at, cpu: d.cpu ?? null, mem: d.mem ?? null, disk: d.disk ?? null }; });
    const host = snap.latest.get("host"), hostData = host?.data as HostData | null | undefined;
    const oracle = snap.latest.get("oracle"), oracleData = oracle?.data as ReportData | null | undefined;
    return [
      { name: "contabo", at: host?.at ?? null, cpu: hostData?.cpu ?? null, mem: hostData?.mem ?? null, disk: hostData?.disk ?? null, load: hostData?.load ?? null, cores: hostData?.cores ?? null,
        memTotalBytes: hostData?.memTotalBytes ?? null, diskTotalBytes: hostData?.diskTotalBytes ?? null,
        net: hostData?.net ? { inToday: hostData.net.inToday, outToday: hostData.net.outToday, inRate: hostData.net.inRate, outRate: hostData.net.outRate } : null, series: series(hostSeries) },
      { name: "oracle", at: oracle?.at ?? null, cpu: oracleData?.cpu ?? null, mem: oracleData?.mem ?? null, disk: oracleData?.disk ?? null, load: oracleData?.load ?? null, cores: oracleData?.cores ?? null,
        memTotalBytes: oracleData?.memTotalBytes ?? null, diskTotalBytes: oracleData?.diskTotalBytes ?? null, net: null, series: series(oracleSeries) },
    ];
  }

  /** every rule's reading from the latest collected data; null where the data isn't there */
  function readings(snap: Snapshot, spend: OpsSpend): Array<{ id: string; label: string; threshold: string; forMs: number; breach: boolean | null; value: string | null }> {
    const out: ReturnType<typeof readings> = [];
    const w = spend.workers;
    out.push({ id: "workers-quota", label: "workers over the included quota", threshold: "projected > 10m requests or 30m cpu ms this month", forMs: 0,
      breach: w ? (w.requests.projected ?? 0) > WORKERS_PLAN.includedRequests || (w.cpuMs.projected ?? 0) > WORKERS_PLAN.includedCpuMs : null,
      value: w ? `${millions(w.requests.used)} requests (${millions(w.requests.projected ?? 0)} at this pace), ${millions(w.cpuMs.used)} cpu ms` : null });
    out.push({ id: "r2-storage", label: "r2 storage", threshold: "> 8 gb", forMs: 0, breach: spend.r2 ? spend.r2.total.used > THRESHOLDS.r2Bytes : null, value: spend.r2 ? gb(spend.r2.total.used) : null });
    const host = snap.latest.get("host"), hostData = host?.data as HostData | null | undefined;
    out.push({ id: "contabo-disk", label: "contabo disk", threshold: `> ${THRESHOLDS.diskPct}%`, forMs: 0, breach: hostData?.disk != null ? hostData.disk > THRESHOLDS.diskPct : null, value: hostData ? pct(hostData.disk) : null });
    out.push({ id: "contabo-mem", label: "contabo memory", threshold: `> ${THRESHOLDS.memPct}% for 10 min`, forMs: THRESHOLDS.memForMs, breach: hostData ? hostData.mem > THRESHOLDS.memPct : null, value: hostData ? pct(hostData.mem) : null });
    // the relay and every other service share this upload; contabo throttles to 100 mbit/s past a 10 day average above it
    const net = hostData?.net ?? null;
    out.push({ id: "contabo-upload", label: "contabo upload", threshold: `> ${THRESHOLDS.uploadPct}% of ${config.uplinkMbit} mbit/s for 15 min`, forMs: THRESHOLDS.uploadForMs,
      breach: net ? net.outRate * 8 / 1e6 > config.uplinkMbit * THRESHOLDS.uploadPct / 100 : null, value: net ? `${Math.round(net.outRate * 8 / 1e5) / 10} mbit/s` : null });
    const sentMonth = net?.outMonth ?? null, projected = sentMonth === null ? null : Math.round(sentMonth / elapsedOf(snap.time));
    out.push({ id: "contabo-egress-month", label: "contabo monthly upload", threshold: `on course past ${config.egressAllowanceBytes / 1e12} tb this month`, forMs: 0,
      breach: projected === null ? null : projected > config.egressAllowanceBytes, value: sentMonth === null ? null : `${gb(sentMonth)} so far, ${gb(projected!)} at this pace` });
    const oracle = snap.latest.get("oracle"), oracleData = oracle?.data as ReportData | null | undefined;
    out.push({ id: "oracle-disk", label: "oracle disk", threshold: `> ${THRESHOLDS.diskPct}%`, forMs: 0, breach: oracleData?.disk != null ? oracleData.disk > THRESHOLDS.diskPct : null, value: oracleData ? pct(oracleData.disk) : null });
    out.push({ id: "oracle-report", label: "oracle box reporting", threshold: "a report in the last 30 min", forMs: 0, breach: oracle ? snap.time - oracle.at > THRESHOLDS.reportStaleMs : null, value: oracle ? ago(snap.time - oracle.at) : null });
    // the oracle uptime check already emails about the site, api, preview and link; these are the ones it can't see
    const probes = (snap.latest.get("probes")?.data as ProbeResult[] | null | undefined) ?? null;
    for (const id of ["broker", "instabox"]) {
      const probe = probes?.find(p => p.id === id);
      out.push({ id: `service-${id}`, label: `${probe?.name ?? id} down`, threshold: "failing for 4 min", forMs: THRESHOLDS.downForMs, breach: probe ? !probe.ok : null, value: probe ? probe.ok ? "up" : probe.status ? `http ${probe.status}` : "no answer" : null });
    }
    const mongo = snap.latest.get("mongo");
    if (options.db) out.push({ id: "mongo", label: "mongodb", threshold: "unreachable or not primary for 4 min", forMs: THRESHOLDS.downForMs,
      breach: mongo ? !mongo.ok || !(mongo.data as MongoData | null)?.primary : null, value: mongo ? mongo.ok ? (mongo.data as MongoData).primary ? "primary" : "not primary" : mongo.error : null });
    if (options.db) {
      const d = mongo?.ok ? mongo.data as MongoData | null : null;
      out.push({ id: "mongo-size", label: "mongodb size", threshold: `> ${THRESHOLDS.mongoBytes / GB_BYTES} gb`, forMs: 0, breach: d ? d.storageBytes > THRESHOLDS.mongoBytes : null, value: d ? gb(d.storageBytes) : null });
    }
    // cloud notices, these alerts and (when resend is full or failing) sign-in codes go through brevo: a day near its limit means mail stops soon
    const day = spend.brevo?.daily;
    out.push({ id: "brevo-day", label: "brevo emails today", threshold: `> ${THRESHOLDS.brevoDayPct}% of the daily limit`, forMs: 0,
      breach: day?.limit ? day.used > day.limit * THRESHOLDS.brevoDayPct / 100 : null, value: day?.limit ? `${day.used} of ${day.limit}` : null });
    // codes, receipts and cloud ready go through resend; past its cap they go through brevo instead (and land in promotions)
    const resend = spend.mail?.providers.find(p => p.provider === "resend" && p.configured);
    if (resend) out.push({ id: "resend-day", label: "resend emails today", threshold: `> ${THRESHOLDS.resendDayPct}% of the daily cap`, forMs: 0,
      breach: resend.daily.limit ? resend.daily.used > resend.daily.limit * THRESHOLDS.resendDayPct / 100 : null, value: resend.daily.limit ? `${resend.daily.used} of ${resend.daily.limit}` : null });
    // one incident a day at most: the rule stays firing until the day's count resets
    if (spend.mail) {
      const passed = spend.mail.providers.filter(p => p.fallbacks.today > 0);
      out.push({ id: "mail-fallback", label: "emails sent through the other provider", threshold: "any today (a cap reached or a provider failing)", forMs: 0,
        breach: passed.length > 0, value: passed.length ? passed.map(p => `${p.fallbacks.today} passed over by ${p.provider}${p.lastError ? ` (last error ${p.lastError.reason})` : ""}`).join(", ") : "none" });
    }
    for (const b of backupsOf(snap)) out.push({ id: `backup-${b.id}`, label: `${b.name} backup`, threshold: `older than ${THRESHOLDS.backupHours} h`, forMs: 0,
      breach: b.at === null ? true : snap.time - b.at > THRESHOLDS.backupHours * HOUR, value: b.at === null ? "never seen" : ago(snap.time - b.at) });
    for (const c of spend.instabox.customers) {
      const metrics = [
        { kind: "cost", value: c.costCents, floor: THRESHOLDS.outlierFloorCents, list: spend.instabox.customers.map(x => x.costCents), label: `$${(c.costCents / 100).toFixed(2)} this month` },
        { kind: "egress", value: c.egressGb, floor: THRESHOLDS.outlierFloorEgressGb, list: spend.instabox.customers.map(x => x.egressGb), label: `${c.egressGb} gb egress` },
      ];
      const hit = metrics.find(m => m.value >= m.floor && (ratioOf(m.value, median(m.list), m.kind === "cost" ? 100 : 1) ?? 0) >= THRESHOLDS.outlierRatio);
      out.push({ id: `outlier-${c.accountId}`, label: `outlier: ${c.email ?? c.accountId}`, threshold: "past 3x the fleet median", forMs: 0, breach: !!hit, value: hit ? `${hit.label}, ${ratioOf(hit.value, median(hit.list), hit.kind === "cost" ? 100 : 1)}x the median` : "normal" });
    }
    return out;
  }

  function backupsOf(snap: Snapshot): Array<{ id: string; name: string; at: number | null; result: string | null }> {
    const hostData = snap.latest.get("host")?.data as HostData | null | undefined, oracleData = snap.latest.get("oracle")?.data as ReportData | null | undefined;
    return [
      ...(hostData?.backups ?? []).map(b => ({ id: b.set, name: b.set, at: b.lastOkAt, result: b.result })),
      ...(oracleData?.backups ?? []).map(b => ({ id: `oracle-${b.set}`, name: `oracle copy of ${b.set}`, at: b.at, result: null })),
    ];
  }

  // the link relay nodes, every minute: a node down for 2 minutes has to be heard about in minutes, not at the next 5
  const relayCards = options.env.MADANI_LINK_STATS_TOKEN ? createRelays({ env: options.env, fetch: fetcher, now, accounts: () => [] }) : null;
  let relayRunning: Promise<void> | null = null;
  function relayTick(): Promise<void> {
    if (!relayCards) return Promise.resolve();
    if (relayRunning) return relayRunning;
    relayRunning = (async () => {
      const { relays } = await relayCards.list();
      const list = relayNodeReadings(relays), time = now();
      const states = new Map((await store.rules()).map(s => [s.id, s]));
      const changed: OpsRuleState[] = [];
      for (const reading of list) {
        const prev = states.get(reading.id) ?? { id: reading.id, state: "ok" as const, since: null, value: null, incidentId: null, lastFiredAt: null, updatedAt: 0 };
        const { next, event } = step(prev, reading, reading.forMs, time);
        if (event === "fire" && alertsOn && options.incidents) next.incidentId = options.incidents.report({ source: "ops", name: reading.label.slice(0, 60), message: `${reading.value ?? ""} (alert when ${reading.threshold}). what to do: ${reading.action}`, key: `ops-${reading.id}-${next.since}` });
        if (event === "recover" && alertsOn && options.incidents && prev.incidentId) await options.incidents.recovered(prev.incidentId, `${reading.label} is back to normal: ${reading.value ?? "ok"}.`).catch(() => false);
        if (event || next.state !== prev.state || next.value !== prev.value) changed.push(next);
      }
      await store.putRules(changed);
      lastRelayReadings = list;
    })().catch(error => console.warn(`ops: the relay node rules could not be checked (${(error as Error).message})`)).finally(() => { relayRunning = null; });
    return relayRunning;
  }
  let lastRelayReadings: ReturnType<typeof relayNodeReadings> = [];

  let evaluating: Promise<void> | null = null;
  async function evaluate(): Promise<void> {
    if (evaluating) return evaluating;
    evaluating = (async () => {
      const snap = await snapshot(), spend = spendOf(snap, options.emails());
      const states = new Map(snap.ruleStates.map(s => [s.id, s]));
      const list = readings(snap, spend);
      const seen = new Set(list.map(r => r.id));
      for (const stale of states.values()) if (!seen.has(stale.id) && stale.state !== "ok" && !stale.id.startsWith(RELAY_RULE_PREFIX)) list.push({ id: stale.id, label: stale.id, threshold: "", forMs: 0, breach: false, value: "gone" });
      const changed: OpsRuleState[] = [];
      for (const reading of list) {
        const prev = states.get(reading.id) ?? { id: reading.id, state: "ok" as const, since: null, value: null, incidentId: null, lastFiredAt: null, updatedAt: 0 };
        const { next, event } = step(prev, reading, reading.forMs, snap.time);
        if (event === "fire" && alertsOn && options.incidents) next.incidentId = options.incidents.report({ source: "ops", name: reading.label.slice(0, 60), message: `${reading.value ?? ""} (alert when ${reading.threshold})`, key: `ops-${reading.id}-${next.since}` });
        if (event === "recover" && alertsOn && options.incidents && prev.incidentId) await options.incidents.recovered(prev.incidentId, `${reading.label} is back to normal: ${reading.value ?? "ok"}.`).catch(() => false);
        if (event || next.state !== prev.state || next.value !== prev.value) changed.push(next);
      }
      await store.putRules(changed);
    })().finally(() => { evaluating = null; });
    return evaluating;
  }

  function checksOf(snap: Snapshot, spend: OpsSpend, boxes: OpsBox[]): OpsCheck[] {
    const checks: OpsCheck[] = [];
    const add = (id: string, group: OpsCheck["group"], name: string, level: Level, value: string, detail: string | null = null, at: number | null = null, latencyMs: number | null = null) =>
      checks.push({ id, group, name, level, value, detail, at, latencyMs });
    for (const box of boxes) {
      const stale = box.at === null || snap.time - box.at > (box.name === "oracle" ? THRESHOLDS.reportStaleMs : 15 * MINUTE);
      if (box.at === null) { add(`${box.name}-seen`, "boxes", `${box.name} box`, "unknown", "no report yet"); continue; }
      if (stale) add(`${box.name}-seen`, "boxes", `${box.name} box`, "bad", `last heard ${ago(snap.time - box.at)}`, null, box.at);
      add(`${box.name}-cpu`, "boxes", `${box.name} cpu`, levelOf(box.cpu, 80, 95), pct(box.cpu), box.load ? `load ${box.load.join(" ")}` : null, box.at);
      add(`${box.name}-mem`, "boxes", `${box.name} memory`, levelOf(box.mem, 80, THRESHOLDS.memPct), pct(box.mem), null, box.at);
      add(`${box.name}-disk`, "boxes", `${box.name} disk`, levelOf(box.disk, 75, THRESHOLDS.diskPct), pct(box.disk), null, box.at);
    }
    const probes = snap.latest.get("probes");
    for (const p of (probes?.data as ProbeResult[] | null) ?? []) add(`probe-${p.id}`, p.group, p.name, p.ok ? (p.latencyMs ?? 0) > 2000 ? "watch" : "ok" : "bad", p.ok ? "up" : p.status ? `http ${p.status}` : "no answer", p.url, probes!.at, p.latencyMs);
    const errors = options.errors.counts();
    add("errors", "services", "server errors", levelOf(errors.service.hour, 1, 20), `${errors.service.hour} in the last hour`, `${errors.service.day} today, ${errors.page.day} page errors today`, snap.time);
    if (spend.composio?.queue) add("broker-queue", "services", "app event queue", levelOf(spend.composio.queue.events, 1000, 10_000), `${spend.composio.queue.events} waiting`, null, snap.latest.get("composio")?.at ?? null);
    const mongo = snap.latest.get("mongo");
    if (mongo) {
      const d = mongo.data as MongoData | null;
      add("mongo", "data", "mongodb", !mongo.ok ? "bad" : d?.primary ? "ok" : "bad", !mongo.ok ? "unreachable" : d?.primary ? "primary" : "not primary",
        d ? [d.setName, d.oplogHours !== null ? `oplog ${d.oplogHours}h` : null, `${Math.round(d.dataBytes / 1e6)} MB`].filter(Boolean).join(" · ") : mongo.error, mongo.at, d?.latencyMs ?? null);
    } else if (options.db) add("mongo", "data", "mongodb", "unknown", "not checked yet");
    const dodo = spend.dodo;
    add("dodo-webhook", "providers", "dodo webhooks", dodo.lastWebhookAt === null ? "unknown" : snap.time - dodo.lastWebhookAt > 14 * DAY ? "watch" : "ok", dodo.lastWebhookAt === null ? "none yet" : ago(snap.time - dodo.lastWebhookAt), null, dodo.lastWebhookAt);
    if (spend.brevo) {
      const b = spend.brevo.today, bad = b.bounced + b.blocked;
      add("brevo-send", "providers", "brevo sending", b.sent >= 10 && bad / b.sent > 0.2 ? "bad" : bad > 0 ? "watch" : "ok", `${b.delivered} of ${b.sent} delivered today`, null, snap.latest.get("brevo")?.at ?? null);
    }
    for (const b of backupsOf(snap)) add(`backup-${b.id}`, "backups", `${b.name} backup`, b.at === null ? "bad" : levelOf((snap.time - b.at) / HOUR, 20, THRESHOLDS.backupHours),
      b.at === null ? "never seen" : ago(snap.time - b.at), b.result && b.result !== "success" ? `last run: ${b.result}` : null, b.at);
    const certs = snap.latest.get("certs");
    for (const c of (certs?.data as CertData[] | null) ?? []) {
      const days = c.expiresAt === null ? null : Math.floor((c.expiresAt - snap.time) / DAY);
      add(`cert-${c.host}`, "certs", c.host, days === null ? "bad" : days < THRESHOLDS.certBadDays ? "bad" : days < THRESHOLDS.certWatchDays ? "watch" : "ok", days === null ? "unreadable" : `${days} days`, c.resolves ? null : "dns does not resolve", certs!.at);
      if (!c.resolves) add(`dns-${c.host}`, "certs", `dns ${c.host}`, "bad", "does not resolve", null, certs!.at);
    }
    return checks;
  }

  function abuseOf(snap: Snapshot, spend: OpsSpend, emails: Map<string, string>) {
    const inputs = new Map<string, SignalInput>();
    const account = (id: string) => { let row = inputs.get(id); if (!row) inputs.set(id, row = { key: id, accountId: id, email: emails.get(id) ?? null, ip: null, values: {} }); return row; };
    const ip = (addr: string) => { const key = `ip:${addr}`; let row = inputs.get(key); if (!row) inputs.set(key, row = { key, accountId: null, email: null, ip: addr, values: {} }); return row; };
    for (const c of spend.instabox.customers) Object.assign(account(c.accountId).values, { egress: c.egressGb, awake: c.awakeHours, cost: c.costCents });
    for (const t of spend.relay?.top ?? []) if (t.accountId) account(t.accountId).values.relay = (account(t.accountId).values.relay ?? 0) + Math.round(t.monthBytes / GB_BYTES * 10) / 10;
    for (const row of snap.relayRows) if (row.accountId && row.day === snap.today && row.values.limited) account(row.accountId).values.rate_limited = (account(row.accountId).values.rate_limited ?? 0) + row.values.limited;
    for (const row of snap.toolRows) if (row.accountId && row.day === snap.today) account(row.accountId).values.tool_calls = (account(row.accountId).values.tool_calls ?? 0) + (row.values.calls ?? 0);
    const monthStartAt = snap.start;
    for (const inv of options.invoices()) if (inv.status === "failed" && inv.createdAt >= monthStartAt) account(inv.accountId).values.failed_payments = (account(inv.accountId).values.failed_payments ?? 0) + 1;
    for (const row of [...snap.signupRows, ...snap.registrationRows]) ip(row.key).values.signups_ip = (ip(row.key).values.signups_ip ?? 0) + (row.values.count ?? 0);
    for (const row of snap.limitedRows) ip(row.key).values.rate_limited = (ip(row.key).values.rate_limited ?? 0) + (row.values.count ?? 0);
    return suspects([...inputs.values()], SIGNALS);
  }

  async function answer(): Promise<OpsAnswer> {
    const snap = await snapshot();
    if (options.fixture && snap.latest.size === 0 && snap.infraRows.length === 0) return options.fixture();
    const emails = options.emails();
    const spend = spendOf(snap, emails), boxes = await boxesOf(snap);
    const ruleStates = new Map(snap.ruleStates.map(s => [s.id, s]));
    const alerts: OpsRule[] = readings(snap, spend).map(r => {
      const s = ruleStates.get(r.id);
      return { id: r.id, label: r.label, threshold: r.threshold, state: s?.state ?? "ok", since: s?.since ?? null, value: r.value ?? s?.value ?? null, lastFiredAt: s?.lastFiredAt ?? null };
    }).filter(rule => !rule.id.startsWith("outlier-") || rule.state !== "ok" || rule.lastFiredAt !== null);
    for (const r of lastRelayReadings) {
      const s = ruleStates.get(r.id);
      alerts.push({ id: r.id, label: r.label, threshold: r.threshold, state: s?.state ?? "ok", since: s?.since ?? null, value: r.value ?? s?.value ?? null, lastFiredAt: s?.lastFiredAt ?? null });
    }
    const configured: Record<OpsSourceId, boolean> = { host: options.host !== false && process.platform === "linux", probes: true, mongo: !!options.db, oracle: !!config.reportToken,
      certs: true, cloudflare: !!config.cloudflare, brevo: !!config.brevo, composio: !!config.composio, relay: !!config.relay };
    const sources: OpsSource[] = SOURCES.map(s => { const l = snap.latest.get(s.id); return { ...s, configured: configured[s.id], at: l?.at ?? null, ok: l?.ok ?? false, error: l?.error ?? null }; });
    return { now: snap.time, month: dayKey(snap.start).slice(0, 7), elapsed: Math.round(elapsedOf(snap.time) * 1000) / 1000, fixture: false, sources, spend,
      health: { checks: checksOf(snap, spend, boxes), boxes }, abuse: abuseOf(snap, spend, emails), alerts };
  }

  return {
    answer,
    collect: async () => ({ ran: await collect(true) }),
    collectHealth: () => collect(false),
    report,
    authorizeReport,
    evaluate,
    noteLimited(ip: string | null) { if (ip) counters.limited.set(ip, (counters.limited.get(ip) ?? 0) + 1); },
    /** an email the service sent to an account's address; `code` when it was a sign-in code */
    noteMail(accountId: string, code: boolean) {
      const item = counters.mail.get(accountId) ?? { sent: 0, codes: 0 };
      item.sent++; if (code) item.codes++;
      counters.mail.set(accountId, item);
    },
    /** the top accounts table, from this service's own numbers */
    async accounts(relays: readonly OpsRelayCard[], query: { range?: OpsAccountsRange; limit?: number } = {}): Promise<OpsAccountsAnswer> {
      const time = now(), range = query.range ?? "month", { from, to } = rangeDays(range, time), today = dayKey(time), month = dayKey(monthStart(time)).slice(0, 7);
      const monthly = range === "month" ? relays : [], limit = query.limit;
      const [infraRows, mailRows, latest] = await Promise.all([options.infra.range(from, to), store.daily("mail", from, to), store.latest()]);
      const emails = options.emails();
      if (options.fixture && latest.length === 0 && infraRows.length === 0) {
        const sample = options.fixture();
        const fx = sample.spend.instabox.machines.map(m => ({ day: today, cloudId: m.cloudId, accountId: m.accountId, serverId: m.serverId, runningSeconds: m.awakeHours * 3600, vcpuSeconds: 0, memGiBSeconds: 0,
          diskGiBSeconds: 0, egressBytes: m.egressGb * GB_BYTES, computeCents: m.costCents, diskCents: 0, costCents: m.costCents, collectedAt: time }));
        const states = new Map(sample.spend.instabox.customers.map(c => [c.accountId, c.egressState]));
        return topAccounts({ now: time, month, range, limit, data: "own", fixture: true, plans: new Map(sample.spend.instabox.customers.map(c => [c.accountId, c.plan])), accounts: [...[...emails].map(([id, email]) => ({ id, email })), ...FIXTURE_PEOPLE.map(([id, email]) => ({ id, email }))],
          relays: monthly, infra: fx, mail: FIXTURE_MAIL.map(([accountId, sent, codes]) => ({ source: "mail", day: today, key: accountId, accountId, values: { sent, codes } })),
          egress: id => states.get(id) ?? null, suspects: sample.abuse });
      }
      const clouds = options.clouds();
      const egress = (accountId: string) => { const states = clouds.filter(c => c.accountId === accountId).map(c => options.egress(c)); return states.includes("paused") ? "paused" as const : states.includes("slowed") ? "slowed" as const : null; };
      const snap = await snapshot();
      const people = [...emails].map(([id, email]) => ({ id, email })), sample = options.fixture ? FIXTURE_PEOPLE.map(([id, email]) => ({ id, email })) : [];
      return topAccounts({ now: time, month, range, limit, data: "own", plans: new Map(options.customers().map(c => [c.accountId, c.plan])), accounts: [...people, ...sample], relays: monthly, infra: infraRows, mail: mailRows, egress,
        suspects: abuseOf(snap, spendOf(snap, emails), emails) });
    },
    noteSignup(ip: string | null, accountId: string) {
      if (!ip) return;
      const item = counters.signups.get(ip) ?? { count: 0, accounts: new Set<string>() };
      item.count++; item.accounts.add(accountId); counters.signups.set(ip, item);
    },
    start() {
      if (timers.length || closed) return;
      const tick = (all: boolean) => () => { void collect(all).catch(error => console.warn(`ops: collection failed (${(error as Error).message})`)); };
      const first = setTimeout(tick(true), 90_000);
      first.unref?.();
      timers.push(setInterval(tick(false), 5 * MINUTE), setInterval(tick(true), HOUR), setInterval(() => void relayTick(), MINUTE));
      for (const timer of timers) timer.unref?.();
    },
    /** the relay node rules now (every minute on its own once started) */
    relayTick,
    close() { closed = true; for (const timer of timers) clearInterval(timer); timers.length = 0; },
  };
}
export type Ops = ReturnType<typeof createOps>;

const round1 = (n: number) => Math.round(n * 10) / 10;
export function elapsedOf(now: number) {
  const start = monthStart(now), end = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 1, 1);
  return Math.min(1, Math.max(DAY, now - start) / (end - start));
}
export function workersOverage(requests: number, cpuMs: number) {
  return Math.round(Math.max(0, requests - WORKERS_PLAN.includedRequests) / 1e6 * WORKERS_PLAN.requestCentsPerMillion + Math.max(0, cpuMs - WORKERS_PLAN.includedCpuMs) / 1e6 * WORKERS_PLAN.cpuCentsPerMillionMs);
}
export function r2Overage(bytes: number) { return Math.round(Math.max(0, bytes - R2_PLAN.freeBytes) / GB_BYTES * R2_PLAN.centsPerGbMonth); }

const fmt = (n: number) => n.toLocaleString("en-US");
export const SIGNALS: SignalSpec[] = [
  { kind: "egress", floor: 5, flagRatio: 3, label: v => `${v} gb egress`, weight: 1.5 },
  { kind: "awake", floor: 24, flagRatio: 3, label: v => `${v} h awake` },
  { kind: "cost", floor: 300, flagRatio: 3, label: v => `$${(v / 100).toFixed(2)} infra`, weight: 1.5 },
  { kind: "relay", floor: 1, flagRatio: 3, label: v => `${v} gb relay` },
  { kind: "tool_calls", floor: 200, flagRatio: 3, label: v => `${fmt(v)} tool calls today` },
  { kind: "signups_ip", floor: 1, baseline: 1, flagRatio: 5, label: v => `${fmt(v)} signups from one address today`, weight: 2 },
  { kind: "failed_payments", floor: 1, baseline: 1, flagRatio: 2, label: v => `${v} failed payments this month` },
  { kind: "rate_limited", floor: 10, baseline: 10, flagRatio: 3, label: v => `${fmt(v)} rate-limited requests today` },
];
