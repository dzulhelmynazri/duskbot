import { execFile } from "node:child_process";
import { readFile, statfs } from "node:fs/promises";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { resolve4 } from "node:dns/promises";
import { connect } from "node:tls";
import { promisify } from "node:util";
import type { Db } from "mongodb";

const run = promisify(execFile);
export const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);
export const monthStart = (t: number) => Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), 1);

export class CollectorError extends Error {}
/** a third-party answer, read as json; any failure becomes a short reason that never carries the request's secrets */
async function getJson(fetcher: typeof fetch, url: string, init: RequestInit, what: string): Promise<any> {
  let res: Response;
  try { res = await fetcher(url, { ...init, signal: AbortSignal.timeout(15_000) }); } catch { throw new CollectorError(`${what} can't be reached`); }
  const body = await res.json().catch(() => null);
  if (res.status === 401 || res.status === 403) throw new CollectorError(`${what} refused the token (${res.status})`);
  if (!res.ok || body === null) throw new CollectorError(`${what} answered ${res.status}`);
  return body;
}

export interface WorkersDay { day: string; script: string; requests: number; cpuMs: number; errors: number }
export interface R2Bucket { name: string; bytes: number; objects: number }
export interface CloudflareData { days: WorkersDay[]; buckets: R2Bucket[] }

const CF_QUERY = `query($a:String!,$s:Time!,$e:Time!,$sd:Date!){viewer{accounts(filter:{accountTag:$a}){
  w:workersInvocationsAdaptive(limit:5000,filter:{datetime_geq:$s,datetime_leq:$e}){sum{requests errors cpuTimeUs} dimensions{scriptName date}}
  r:r2StorageAdaptiveGroups(limit:200,filter:{date_geq:$sd},orderBy:[date_DESC]){max{payloadSize metadataSize objectCount} dimensions{bucketName date}}}}}`;

/** Cloudflare GraphQL Analytics: this month's Worker requests and CPU per script and day, and each R2 bucket's newest size */
export async function collectCloudflare(input: { token: string; accountId: string; now: number; fetch: typeof fetch }): Promise<CloudflareData> {
  const start = monthStart(input.now);
  const body = await getJson(input.fetch, "https://api.cloudflare.com/client/v4/graphql", {
    method: "POST", headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
    body: JSON.stringify({ query: CF_QUERY, variables: { a: input.accountId, s: new Date(start).toISOString(), e: new Date(input.now).toISOString(), sd: dayKey(input.now - 3 * 86_400_000) } }),
  }, "cloudflare analytics");
  if (Array.isArray(body.errors) && body.errors.length) throw new CollectorError(`cloudflare analytics: ${String(body.errors[0]?.message ?? "error").slice(0, 120)}`);
  const account = body.data?.viewer?.accounts?.[0];
  if (!account) throw new CollectorError("cloudflare analytics: no such account");
  const days: WorkersDay[] = (account.w ?? []).map((row: any) => ({ day: String(row.dimensions?.date), script: String(row.dimensions?.scriptName ?? "unknown"),
    requests: Number(row.sum?.requests) || 0, cpuMs: Math.round((Number(row.sum?.cpuTimeUs) || 0) / 1000), errors: Number(row.sum?.errors) || 0 }));
  const newest = new Map<string, R2Bucket & { date: string }>();
  for (const row of account.r ?? []) {
    const name = String(row.dimensions?.bucketName), date = String(row.dimensions?.date);
    if ((newest.get(name)?.date ?? "") >= date) continue;
    newest.set(name, { name, date, bytes: (Number(row.max?.payloadSize) || 0) + (Number(row.max?.metadataSize) || 0), objects: Number(row.max?.objectCount) || 0 });
  }
  return { days, buckets: [...newest.values()].map(({ name, bytes, objects }) => ({ name, bytes, objects })).sort((a, b) => b.bytes - a.bytes) };
}

export interface BrevoData { today: { sent: number; delivered: number; bounced: number; blocked: number }; month: { sent: number }; plan: { type: string; credits: number | null } | null }
/** Brevo transactional statistics for today and the month; the plan read needs an account-scoped key and is optional */
export async function collectBrevo(input: { apiKey: string; now: number; fetch: typeof fetch }): Promise<BrevoData> {
  const headers = { "api-key": input.apiKey, accept: "application/json" };
  const base = "https://api.brevo.com/v3";
  const [today, month, account] = await Promise.all([
    getJson(input.fetch, `${base}/smtp/statistics/aggregatedReport?startDate=${dayKey(input.now)}&endDate=${dayKey(input.now)}`, { headers }, "brevo"),
    getJson(input.fetch, `${base}/smtp/statistics/aggregatedReport?startDate=${dayKey(monthStart(input.now))}&endDate=${dayKey(input.now)}`, { headers }, "brevo")
      .catch(() => null),
    getJson(input.fetch, `${base}/account`, { headers }, "brevo account").catch(() => null),
  ]);
  const n = (v: unknown) => Number(v) || 0;
  const plan = Array.isArray(account?.plan) ? account.plan.find((p: any) => p?.type) : null;
  return {
    today: { sent: n(today.requests), delivered: n(today.delivered), bounced: n(today.hardBounces) + n(today.softBounces), blocked: n(today.blocked) },
    month: { sent: Math.max(n(month?.requests), n(today.requests)) },
    plan: plan ? { type: String(plan.type), credits: typeof plan.credits === "number" ? plan.credits : null } : null,
  };
}

export interface ComposioData {
  days: Array<{ day: string; calls: number }>;
  installations: Array<{ id: string; machine: string | null; days: Record<string, number> }>;
  registrations: Array<{ ip: string; day: string; count: number }>;
  queue: { events: number; bytes: number } | null;
}
/** the broker's own counters (GET /v1/stats/usage, its stats token) */
export async function collectComposio(input: { url: string; token: string; fetch: typeof fetch }): Promise<ComposioData> {
  const body = await getJson(input.fetch, `${input.url.replace(/\/+$/, "")}/v1/stats/usage?days=7`, { headers: { authorization: `Bearer ${input.token}` } }, "composio broker");
  return {
    days: Array.isArray(body.days) ? body.days.map((d: any) => ({ day: String(d.day), calls: Number(d.calls) || 0 })) : [],
    installations: Array.isArray(body.installations) ? body.installations.map((i: any) => ({ id: String(i.id), machine: typeof i.machine === "string" ? i.machine : null,
      days: Object.fromEntries(Object.entries(i.days ?? {}).map(([day, n]) => [day, Number(n) || 0])) })) : [],
    registrations: Array.isArray(body.registrations) ? body.registrations.map((r: any) => ({ ip: String(r.ip), day: String(r.day), count: Number(r.count) || 0 })) : [],
    queue: body.queue ? { events: Number(body.queue.events) || 0, bytes: Number(body.queue.bytes) || 0 } : null,
  };
}

export interface RelayData { limitBytes: number; tunnels: Array<{ id: string; accountId: string | null; days: Record<string, { bytes: number; limited: number }> }> }
/** the link service's per-tunnel relay counters (GET /v1/stats/relay, its stats token) */
export async function collectRelay(input: { url: string; token: string; fetch: typeof fetch }): Promise<RelayData> {
  const body = await getJson(input.fetch, `${input.url.replace(/\/+$/, "")}/v1/stats/relay`, { headers: { authorization: `Bearer ${input.token}` } }, "link service");
  return {
    limitBytes: Number(body.limitBytes) || 0,
    tunnels: Array.isArray(body.tunnels) ? body.tunnels.map((t: any) => ({ id: String(t.id), accountId: typeof t.acct === "string" ? t.acct : null,
      days: Object.fromEntries(Object.entries(t.days ?? {}).map(([day, v]: [string, any]) => [day, { bytes: Number(v?.bytes) || 0, limited: Number(v?.limited) || 0 }])) })) : [],
  };
}

export interface HostData {
  cpu: number | null; mem: number; disk: number | null; load: [number, number, number]; cores: number; memTotalBytes: number; diskTotalBytes: number | null;
  /** outMonth: this utc month's bytes sent (vnstat), null without vnstat */
  net: { inToday: number; outToday: number; inRate: number; outRate: number; rx: number; tx: number; outMonth?: number | null } | null;
  backups: Array<{ set: string; result: string; lastRunAt: number | null; lastOkAt: number | null }>;
}

function cpuTimes() { return cpus().reduce((sum, cpu) => { const t = cpu.times; return { idle: sum.idle + t.idle, total: sum.total + t.user + t.nice + t.sys + t.idle + t.irq }; }, { idle: 0, total: 0 }); }
async function memUsed(): Promise<number> {
  const info = await readFile("/proc/meminfo", "utf8").catch(() => null);
  const available = info ? Number(/MemAvailable:\s+(\d+)/.exec(info)?.[1]) * 1024 : NaN;
  return Number.isFinite(available) ? totalmem() - available : totalmem() - freemem();
}
/** the interfaces that are the box's own traffic: not loopback, and not container or vpn interfaces that repeat it */
const ownInterface = (name: string) => name !== "lo" && !/^(docker|veth|br-|tailscale)/.test(name);
/** bytes received and sent by every interface but loopback, from /proc/net/dev */
export function netCounters(text: string): { rx: number; tx: number } {
  let rx = 0, tx = 0;
  for (const line of text.split("\n").slice(2)) {
    const [name, rest] = line.split(":");
    if (!rest || !ownInterface(name!.trim())) continue;
    const fields = rest.trim().split(/\s+/).map(Number);
    rx += fields[0] || 0; tx += fields[8] || 0;
  }
  return { rx, tx };
}
/** vnstat 2's json: today's bytes per interface, summed */
export function vnstatToday(json: string, day: string): { rx: number; tx: number } | null {
  try {
    const data = JSON.parse(json);
    let rx = 0, tx = 0, found = false;
    for (const iface of data.interfaces ?? []) for (const d of typeof iface.name === "string" && !ownInterface(iface.name) ? [] : iface.traffic?.day ?? []) {
      const key = `${d.date?.year}-${String(d.date?.month).padStart(2, "0")}-${String(d.date?.day).padStart(2, "0")}`;
      if (key === day) { rx += Number(d.rx) || 0; tx += Number(d.tx) || 0; found = true; }
    }
    return found ? { rx, tx } : null;
  } catch { return null; }
}
/** vnstat 2's json: this month's bytes per own interface, summed (the 32 tb allowance counts what leaves the box) */
export function vnstatMonth(json: string, month: string): { rx: number; tx: number } | null {
  try {
    const data = JSON.parse(json);
    let rx = 0, tx = 0, found = false;
    for (const iface of data.interfaces ?? []) for (const m of typeof iface.name === "string" && !ownInterface(iface.name) ? [] : iface.traffic?.month ?? []) {
      if (`${m.date?.year}-${String(m.date?.month).padStart(2, "0")}` === month) { rx += Number(m.rx) || 0; tx += Number(m.tx) || 0; found = true; }
    }
    return found ? { rx, tx } : null;
  } catch { return null; }
}
/** systemd's view of one backup set's last run: `systemctl show madani-backup@<set>.service` */
export function backupRun(show: string): { result: string; exitedAt: number | null } {
  const value = (name: string) => new RegExp(`^${name}=(.*)$`, "m").exec(show)?.[1]?.trim() ?? "";
  const at = Date.parse(value("ExecMainExitTimestamp").replace(/^\w{3} /, "").replace(/ ([A-Z]{2,5})$/, ""));
  return { result: value("Result") || "unknown", exitedAt: Number.isFinite(at) ? at : null };
}

/** the box this service runs on: cpu over one second, memory, the root disk, load, network and the backup timers */
export async function collectHost(input: { now: number; previous: HostData | null; previousAt: number | null; backupSets: string[] }): Promise<HostData> {
  const a = cpuTimes();
  await new Promise(resolve => setTimeout(resolve, 1000));
  const b = cpuTimes();
  const cpu = b.total > a.total ? Math.round((1 - (b.idle - a.idle) / (b.total - a.total)) * 1000) / 10 : null;
  const [used, fs, dev, vn, vnm] = await Promise.all([
    memUsed(), statfs("/").catch(() => null), readFile("/proc/net/dev", "utf8").catch(() => null),
    run("vnstat", ["--json", "d", "2"], { timeout: 5000 }).then(out => out.stdout, () => null),
    run("vnstat", ["--json", "m", "1"], { timeout: 5000 }).then(out => out.stdout, () => null),
  ]);
  const counters = dev ? netCounters(dev) : null, today = vn ? vnstatToday(vn, dayKey(input.now)) : null;
  const month = vnm ? vnstatMonth(vnm, dayKey(input.now).slice(0, 7)) : null;
  const prevNet = input.previous?.net, span = input.previousAt ? (input.now - input.previousAt) / 1000 : 0;
  const rate = (now: number, before: number | undefined) => before !== undefined && span > 0 && now >= before ? Math.round((now - before) / span) : 0;
  const backups: HostData["backups"] = [];
  for (const set of input.backupSets) {
    const show = await run("systemctl", ["show", `madani-backup@${set}.service`, "-p", "Result", "-p", "ExecMainExitTimestamp"], { timeout: 5000 }).then(out => out.stdout, () => null);
    if (show === null) continue;
    const { result, exitedAt } = backupRun(show), before = input.previous?.backups.find(item => item.set === set);
    backups.push({ set, result, lastRunAt: exitedAt, lastOkAt: result === "success" && exitedAt ? Math.max(exitedAt, before?.lastOkAt ?? 0) : before?.lastOkAt ?? null });
  }
  const total = fs ? fs.blocks * fs.bsize : null;
  return {
    cpu, mem: Math.round(used / totalmem() * 1000) / 10, disk: fs && total ? Math.round((1 - fs.bavail / fs.blocks) * 1000) / 10 : null,
    load: loadavg().map(n => Math.round(n * 100) / 100) as [number, number, number], cores: cpus().length, memTotalBytes: totalmem(), diskTotalBytes: total,
    net: counters ? { inToday: today?.rx ?? 0, outToday: today?.tx ?? 0, inRate: rate(counters.rx, prevNet?.rx), outRate: rate(counters.tx, prevNet?.tx), rx: counters.rx, tx: counters.tx, outMonth: month?.tx ?? null } : null,
    backups,
  };
}

export interface ProbeTarget { id: string; name: string; url: string; group: "services" | "providers"; expect?: string }
export interface ProbeResult { id: string; name: string; url: string; group: "services" | "providers"; ok: boolean; status: number | null; latencyMs: number | null }
/** MADANI_OPS_PROBES: "id=name=https://url,..." replaces the defaults */
export function probeTargets(value: string | undefined, self: string | null): ProbeTarget[] {
  if (value) return value.split(",").map(part => part.trim()).filter(Boolean).flatMap(part => {
    const [id, name, ...rest] = part.split("="), url = rest.join("=");
    try { return /^[a-z0-9-]{1,30}$/.test(id ?? "") && name && ["http:", "https:"].includes(new URL(url).protocol) ? [{ id: id!, name, url, group: id === "instabox" ? "providers" as const : "services" as const }] : []; } catch { return []; }
  });
  return [
    ...(self ? [{ id: "account", name: "account service", url: `${self}/v1/health`, group: "services" as const }] : []),
    { id: "site", name: "madani.bot", url: "https://madani.bot/", group: "services" },
    { id: "preview", name: "preview", url: "https://preview.madani.bot/v1/health", group: "services" },
    { id: "link", name: "link service", url: "https://link.madani.bot/healthz", group: "services" },
    { id: "broker", name: "composio broker", url: "https://composio.madani.bot/health", group: "services" },
    { id: "instabox", name: "instabox api", url: "https://api.instabox.sh/v1/openapi.json", group: "providers" },
  ];
}
export async function collectProbes(targets: readonly ProbeTarget[], fetcher: typeof fetch): Promise<ProbeResult[]> {
  return Promise.all(targets.map(async target => {
    const started = performance.now();
    try {
      const res = await fetcher(target.url, { redirect: "follow", signal: AbortSignal.timeout(8000), headers: { "user-agent": "madani-ops/1" } });
      await res.body?.cancel().catch(() => {});
      return { id: target.id, name: target.name, url: target.url, group: target.group, ok: res.status < 500, status: res.status, latencyMs: Math.round(performance.now() - started) };
    } catch {
      return { id: target.id, name: target.name, url: target.url, group: target.group, ok: false, status: null, latencyMs: null };
    }
  }));
}

export interface MongoData { ok: boolean; primary: boolean; setName: string | null; oplogHours: number | null; dataBytes: number; storageBytes: number; collections: number; latencyMs: number }
/** this service's own database: who is primary, the oplog's window when the user may read it, and the database's size */
export async function collectMongo(db: Db): Promise<MongoData> {
  const started = performance.now();
  const [hello, stats] = await Promise.all([db.admin().command({ hello: 1 }), db.command({ dbStats: 1 })]);
  const latencyMs = Math.round(performance.now() - started);
  let oplogHours: number | null = null;
  try {
    const oplog = db.client.db("local").collection("oplog.rs");
    const [first, last] = await Promise.all([oplog.find({}, { projection: { ts: 1 } }).sort({ $natural: 1 }).limit(1).next(), oplog.find({}, { projection: { ts: 1 } }).sort({ $natural: -1 }).limit(1).next()]);
    if (first?.ts && last?.ts) oplogHours = Math.round((last.ts.getHighBits() - first.ts.getHighBits()) / 360) / 10;
  } catch {}
  return { ok: true, primary: !!hello.isWritablePrimary, setName: hello.setName ?? null, oplogHours, dataBytes: Number(stats.dataSize) || 0, storageBytes: Number(stats.storageSize) || 0, collections: Number(stats.collections) || 0, latencyMs };
}

export interface CertData { host: string; expiresAt: number | null; resolves: boolean }
export function certificateExpiry(host: string): Promise<number | null> {
  return new Promise(done => {
    const socket = connect({ host, port: 443, servername: host, timeout: 10_000 }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      done(cert?.valid_to ? Date.parse(cert.valid_to) : null);
    });
    socket.on("error", () => done(null));
    socket.on("timeout", () => { socket.destroy(); done(null); });
  });
}
export async function collectCerts(hosts: readonly string[], check: { expiry: (host: string) => Promise<number | null>; resolve: (host: string) => Promise<boolean> } = { expiry: certificateExpiry, resolve: host => resolve4(host).then(list => list.length > 0, () => false) }): Promise<CertData[]> {
  return Promise.all(hosts.map(async host => { const [expiresAt, resolves] = await Promise.all([check.expiry(host), check.resolve(host)]); return { host, expiresAt, resolves }; }));
}

export interface ReportData {
  host: string; cpu: number | null; mem: number | null; disk: number | null; load: [number, number, number] | null; cores: number | null;
  memTotalBytes: number | null; diskTotalBytes: number | null; backups: Array<{ set: string; at: number | null }>;
}
const num = (v: unknown, max = Number.MAX_SAFE_INTEGER) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : null;
/** a pushed host report (deploy/monitor/host-report.mjs), checked field by field; unknown fields are dropped */
export function parseReport(body: Record<string, unknown>): ReportData | null {
  const host = typeof body.host === "string" && /^[a-z0-9-]{1,30}$/.test(body.host) ? body.host : null;
  if (!host) return null;
  const load = Array.isArray(body.load) && body.load.length === 3 && body.load.every(v => num(v, 10_000) !== null) ? body.load as [number, number, number] : null;
  const backups = Array.isArray(body.backups) ? body.backups.slice(0, 20).flatMap((b: any) => typeof b?.set === "string" && /^[a-z0-9-]{1,40}$/.test(b.set) ? [{ set: b.set, at: num(b.at) }] : []) : [];
  return { host, cpu: num(body.cpu, 100), mem: num(body.mem, 100), disk: num(body.disk, 100), load, cores: num(body.cores, 1024), memTotalBytes: num(body.memTotalBytes), diskTotalBytes: num(body.diskTotalBytes), backups };
}
