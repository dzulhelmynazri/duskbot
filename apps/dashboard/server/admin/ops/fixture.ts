import type { OpsAnswer, OpsBox, OpsCheck } from "../../../src/admin/ops-types.ts";

const DAY = 86_400_000, GB_BYTES = 1e9;
const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);

export const FIXTURE_PEOPLE = [
  ["acct_fx_mara", "mara@madanibot.test", "pro"], ["acct_fx_oskar", "oskar@madanibot.test", "starter"], ["acct_fx_lin", "lin@madanibot.test", "pro"],
  ["acct_fx_tess", "tess@madanibot.test", "starter"], ["acct_fx_ravi", "ravi@madanibot.test", "max"], ["acct_fx_juno", "juno@madanibot.test", "starter"],
  ["acct_fx_ikaika", "ikaika@madanibot.test", "pro"], ["acct_fx_bo", "bo@madanibot.test", "starter"],
] as const;
/** sign-in emails in the made-up month: account, emails sent, of them codes */
export const FIXTURE_MAIL: ReadonlyArray<readonly [string, number, number]> = [
  ["acct_fx_ravi", 41, 34], ["acct_fx_oskar", 12, 11], ["acct_fx_mara", 6, 3], ["acct_fx_lin", 4, 2], ["acct_fx_tess", 3, 1], ["acct_fx_juno", 2, 1],
];

/** made-up numbers for the fixture service and screenshots; never served when anything real was collected */
export function opsFixture(now: number): OpsAnswer {
  const start = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
  const end = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 1, 1);
  const elapsed = Math.max(1 / 30, (now - start) / (end - start));
  const days = Array.from({ length: Math.max(1, Math.ceil((now - start) / DAY)) }, (_, i) => dayKey(start + i * DAY));
  const wave = (i: number, base: number, swing: number) => Math.round(base + swing * Math.sin(i * 1.3) + swing * 0.4 * Math.cos(i * 0.7));
  const people = FIXTURE_PEOPLE;
  const customers = people.map(([accountId, email, plan], i) => {
    const heavy = i === 4, awakeHours = heavy ? 690 : wave(i, 120, 60), egressGb = heavy ? 412 : i === 1 ? 140 : wave(i, 18, 9);
    const costCents = Math.round(awakeHours * 4.1 + egressGb * 0.9);
    return { accountId, email, plan, machines: heavy ? 2 : 1, awakeHours, vcpuHours: awakeHours * 2, memGiBHours: awakeHours * 4, egressGb, costCents,
      projectedCents: Math.round(costCents / elapsed), egressState: heavy ? "paused" as const : i === 1 ? "slowed" as const : null };
  });
  const machines = customers.flatMap((c, i) => Array.from({ length: c.machines }, (_, n) => ({
    cloudId: `c${String(i).padStart(2, "0")}${String(n).padStart(22, "0")}`, accountId: c.accountId, email: c.email, serverId: `srv_fx_${i}_${n}`,
    awakeHours: Math.round(c.awakeHours / c.machines), vcpuHours: Math.round(c.vcpuHours / c.machines), memGiBHours: Math.round(c.memGiBHours / c.machines), diskGiB: 40,
    egressGb: Math.round(c.egressGb / c.machines), costCents: Math.round(c.costCents / c.machines), todayCents: Math.round(c.costCents / c.machines / days.length), egressState: c.egressState })));
  const instaCost = customers.reduce((s, c) => s + c.costCents, 0);
  const workersReq = 2_480_000, workersCpu = 4_100_000, r2Bytes = 4.2 * GB_BYTES;
  const series = (base: number, swing: number) => Array.from({ length: 288 }, (_, i) => ({ at: now - (287 - i) * 300_000, cpu: Math.max(1, wave(i / 8, base, swing)), mem: wave(i / 20, 41, 4), disk: 27 }));
  const boxes: OpsBox[] = [
    { name: "contabo", at: now - 60_000, cpu: 23, mem: 42, disk: 27, load: [1.4, 1.1, 0.9], cores: 12, memTotalBytes: 48 * 1024 ** 3, diskTotalBytes: 193 * 1024 ** 3,
      net: { inToday: 38.2 * GB_BYTES, outToday: 51.6 * GB_BYTES, inRate: 2_400_000, outRate: 3_100_000 }, series: series(22, 9) },
    { name: "oracle", at: now - 240_000, cpu: 3, mem: 18, disk: 61, load: [0.1, 0.08, 0.05], cores: 2, memTotalBytes: 12 * 1024 ** 3, diskTotalBytes: 193 * 1024 ** 3, net: null, series: series(3, 1).map(p => ({ ...p, mem: 18, disk: 61 })) },
  ];
  const check = (id: string, group: OpsCheck["group"], name: string, level: OpsCheck["level"], value: string, detail: string | null = null, latencyMs: number | null = null): OpsCheck =>
    ({ id, group, name, level, value, detail, at: now - 90_000, latencyMs });
  return {
    now, month: dayKey(start).slice(0, 7), elapsed: Math.round(elapsed * 1000) / 1000, fixture: true,
    sources: [
      ["host", "contabo box", "5m"], ["probes", "service checks", "5m"], ["mongo", "mongodb", "5m"], ["certs", "certificates and dns", "1h"], ["cloudflare", "cloudflare", "1h"],
      ["brevo", "brevo", "1h"], ["composio", "composio broker", "1h"], ["relay", "link relay", "1h"], ["oracle", "oracle box", "5m"],
    ].map(([id, label, every]) => ({ id: id as OpsAnswer["sources"][number]["id"], label: label!, configured: true, at: now - 120_000, ok: id !== "brevo", error: id === "brevo" ? "the api key can't read the plan" : null, every: every as "5m" | "1h" })),
    spend: {
      totals: { monthCents: instaCost + 500 + 410, projectedCents: Math.round((instaCost + 410) / elapsed) + 500, todayCents: Math.round(instaCost / days.length) },
      lines: [
        { provider: "instabox", label: "instabox", monthCents: instaCost, projectedCents: Math.round(instaCost / elapsed), note: "compute and disk at list prices" },
        { provider: "workers", label: "cloudflare workers", monthCents: 500, projectedCents: 500, note: "$5 base, no overage at this pace" },
        { provider: "r2", label: "r2 storage", monthCents: 0, projectedCents: 0, note: "inside the 10 gb free tier" },
        { provider: "dodo", label: "dodo fees", monthCents: 410, projectedCents: Math.round(410 / elapsed), note: "6% + 40¢ a payment, estimated" },
        { provider: "brevo", label: "brevo", monthCents: 0, projectedCents: 0, note: "free plan" },
        { provider: "composio", label: "composio", monthCents: 0, projectedCents: 0, note: "tool calls counted, billed by composio" },
        { provider: "relay", label: "link relay", monthCents: 0, projectedCents: 0, note: "runs on the contabo box" },
      ],
      instabox: {
        totals: { machines: machines.length, customers: customers.length, awakeHours: customers.reduce((s, c) => s + c.awakeHours, 0), vcpuHours: customers.reduce((s, c) => s + c.vcpuHours, 0),
          memGiBHours: customers.reduce((s, c) => s + c.memGiBHours, 0), egressGb: customers.reduce((s, c) => s + c.egressGb, 0), costCents: instaCost, todayCents: Math.round(instaCost / days.length), projectedCents: Math.round(instaCost / elapsed) },
        days: days.map((day, i) => ({ day, costCents: wave(i, instaCost / days.length, instaCost / days.length / 4), egressGb: wave(i, 30, 12), awakeHours: wave(i, 70, 20) })),
        machines, customers: [...customers].sort((a, b) => b.costCents - a.costCents),
        outliers: [
          { accountId: "acct_fx_ravi", email: "ravi@madanibot.test", metric: "egress", value: 412, median: 18, ratio: 22.9, z: 14.2 },
          { accountId: "acct_fx_ravi", email: "ravi@madanibot.test", metric: "awake", value: 690, median: 120, ratio: 5.8, z: 6.1 },
          { accountId: "acct_fx_oskar", email: "oskar@madanibot.test", metric: "egress", value: 140, median: 18, ratio: 7.8, z: 4.5 },
        ],
        limited: [{ accountId: "acct_fx_ravi", email: "ravi@madanibot.test", cloudId: machines.find(m => m.accountId === "acct_fx_ravi")!.cloudId, state: "paused", egressGb: 412 },
          { accountId: "acct_fx_oskar", email: "oskar@madanibot.test", cloudId: machines.find(m => m.accountId === "acct_fx_oskar")!.cloudId, state: "slowed", egressGb: 140 }],
      },
      workers: {
        plan: { label: "workers paid", baseCents: 500, includedRequests: 10_000_000, includedCpuMs: 30_000_000, requestCentsPerMillion: 30, cpuCentsPerMillionMs: 2 },
        requests: { used: workersReq, limit: 10_000_000, projected: Math.round(workersReq / elapsed), level: "ok" },
        cpuMs: { used: workersCpu, limit: 30_000_000, projected: Math.round(workersCpu / elapsed), level: "ok" }, overageCents: 0,
        scripts: [{ name: "madani-edge", requests: 1_920_000, cpuMs: 3_300_000, errors: 41, todayRequests: 88_000, todayCpuMs: 150_000 },
          { name: "madanibot-composio", requests: 560_000, cpuMs: 800_000, errors: 3, todayRequests: 24_000, todayCpuMs: 36_000 }],
        days: days.map((day, i) => ({ day, requests: wave(i, workersReq / days.length, 30_000), cpuMs: wave(i, workersCpu / days.length, 40_000) })),
      },
      r2: { freeBytes: 10 * GB_BYTES, total: { used: r2Bytes, limit: 10 * GB_BYTES, projected: null, level: "ok" }, overageCents: 0,
        buckets: [{ name: "makedesign", bytes: 3.8 * GB_BYTES, objects: 7025 }, { name: "madani-backups", bytes: 0.4 * GB_BYTES, objects: 22 }] },
      composio: {
        limits: { installation: 10_000, account: 50_000 }, today: { calls: 10_650, installations: 31 }, week: { calls: 41_300 },
        days: days.slice(-7).map((day, i) => ({ day, calls: wave(i, 5_900, 1_200) })),
        top: [["inst_fx_a", "acct_fx_ravi", "ravi@madanibot.test", 8_420], ["inst_fx_b", "acct_fx_mara", "mara@madanibot.test", 1_210], ["inst_fx_c", null, null, 640], ["inst_fx_d", "acct_fx_lin", "lin@madanibot.test", 380]]
          .map(([installationId, accountId, email, today]) => ({ installationId: installationId as string, accountId: accountId as string | null, email: email as string | null, today: today as number, week: (today as number) * 5, share: Math.round((today as number) / 10_650 * 1000) / 1000 })),
        nearLimit: 1, queue: { events: 14, bytes: 42_000 }, registrationsTopIp: [{ ip: "203.0.113.9", today: 22 }, { ip: "198.51.100.4", today: 3 }],
      },
      brevo: { today: { sent: 41, delivered: 40, bounced: 1, blocked: 0 }, month: { sent: 612 }, daily: { used: 41, limit: 300, projected: null, level: "ok" }, monthly: { used: 612, limit: 10_000, projected: Math.round(612 / elapsed), level: "ok" }, plan: "free" },
      mail: { providers: [
        { provider: "resend", configured: true, sends: "codes, receipts and cloud ready", daily: { used: 23, limit: 100, projected: null, level: "ok" },
          monthly: { used: 318, limit: 3_000, projected: Math.round(318 / elapsed), level: "ok" }, fallbacks: { today: 0, month: 2 }, lastError: { at: now - 3 * 86_400_000, reason: "http 429 rate_limit_exceeded" } },
        { provider: "brevo", configured: true, sends: "everything else", daily: { used: 18, limit: 300, projected: null, level: "ok" },
          monthly: { used: 294, limit: 10_000, projected: Math.round(294 / elapsed), level: "ok" }, fallbacks: { today: 0, month: 0 }, lastError: null },
      ] },
      dodo: { monthCents: 410, todayCents: 46, payments: 9, grossCents: 4_100, rate: { rate: 0.06, fixedCents: 40 }, estimated: true, lastWebhookAt: now - 3 * 3_600_000 },
      relay: {
        dailyLimitBytes: 20 * 1024 ** 3, today: { bytes: 6.1 * GB_BYTES, tunnels: 23, limited: 2 }, month: { bytes: 74 * GB_BYTES },
        days: days.map((day, i) => ({ day, bytes: wave(i, 5 * GB_BYTES, 1.5 * GB_BYTES) })),
        top: [["tun_fx_1", "acct_fx_oskar", "oskar@madanibot.test", 3.9 * GB_BYTES, 31 * GB_BYTES, 2], ["tun_fx_2", "acct_fx_mara", "mara@madanibot.test", 0.9 * GB_BYTES, 12 * GB_BYTES, 0], ["tun_fx_3", "acct_fx_tess", "tess@madanibot.test", 0.4 * GB_BYTES, 6 * GB_BYTES, 0]]
          .map(([tunnelId, accountId, email, todayBytes, monthBytes, limited]) => ({ tunnelId: tunnelId as string, accountId: accountId as string, email: email as string, todayBytes: todayBytes as number, monthBytes: monthBytes as number, limited: limited as number })),
      },
    },
    health: {
      boxes,
      checks: [
        check("box-contabo-disk", "boxes", "contabo disk", "ok", "27%"), check("box-contabo-mem", "boxes", "contabo memory", "ok", "42%"), check("box-oracle-disk", "boxes", "oracle disk", "ok", "61%"),
        check("probe-account", "services", "account service", "ok", "up", null, 38), check("probe-preview", "services", "preview", "ok", "up", null, 51), check("probe-link", "services", "link service", "ok", "up", null, 44),
        check("probe-broker", "services", "composio broker", "ok", "up", null, 92), check("probe-site", "services", "madani.bot", "ok", "up", null, 61), check("probe-instabox", "providers", "instabox api", "ok", "up", null, 210),
        check("mongo", "data", "mongodb", "ok", "primary", "rs0 · oplog 41h · 212 MB"), check("dodo-webhook", "providers", "dodo webhooks", "ok", "3h ago"), check("brevo-send", "providers", "brevo sending", "ok", "40 of 41 delivered today"),
        check("errors", "services", "server errors", "watch", "7 in the last hour", "3 open incidents"),
        check("backup-madani", "backups", "madani backup", "ok", "2h ago"), check("backup-make", "backups", "make backup", "ok", "11h ago"), check("backup-oracle", "backups", "oracle copy", "ok", "2h ago"),
        check("cert-madani.bot", "certs", "madani.bot", "ok", "71 days"), check("cert-link.madani.bot", "certs", "link.madani.bot", "watch", "12 days"), check("dns-madani.bot", "certs", "dns madani.bot", "ok", "resolves"),
      ],
    },
    abuse: [
      { key: "acct_fx_ravi", accountId: "acct_fx_ravi", email: "ravi@madanibot.test", ip: null, score: 31.6, why: "egress 23x the median, awake 5.8x, 8,420 tool calls today (84% of the limit)",
        signals: [{ kind: "egress", value: 412, median: 18, ratio: 22.9, label: "412 gb egress" }, { kind: "awake", value: 690, median: 120, ratio: 5.8, label: "690 h awake" }, { kind: "tool_calls", value: 8_420, median: 380, ratio: 22.2, label: "8,420 tool calls today" }] },
      { key: "acct_fx_oskar", accountId: "acct_fx_oskar", email: "oskar@madanibot.test", ip: null, score: 12.1, why: "egress 7.8x the median, 31 gb through the relay, hit the relay limit twice",
        signals: [{ kind: "egress", value: 140, median: 18, ratio: 7.8, label: "140 gb egress" }, { kind: "relay", value: 31, median: 6, ratio: 5.2, label: "31 gb relay" }] },
      { key: "ip:203.0.113.9", accountId: null, email: null, ip: "203.0.113.9", score: 7.3, why: "22 broker registrations from one address today",
        signals: [{ kind: "signups_ip", value: 22, median: 1, ratio: 22, label: "22 registrations today" }] },
    ],
    alerts: [
      { id: "workers-requests", label: "workers requests over quota", threshold: "projected > 10m this month", state: "ok", since: null, value: "2.5m, 6.2m at this pace", lastFiredAt: null },
      { id: "r2-storage", label: "r2 storage", threshold: "> 8 gb", state: "ok", since: null, value: "4.2 gb", lastFiredAt: null },
      { id: "box-contabo-disk", label: "contabo disk", threshold: "> 85%", state: "ok", since: null, value: "27%", lastFiredAt: null },
      { id: "box-contabo-mem", label: "contabo memory", threshold: "> 90% for 10 min", state: "ok", since: null, value: "42%", lastFiredAt: null },
      { id: "service-down", label: "a service down", threshold: "2 checks in a row", state: "ok", since: null, value: "all up", lastFiredAt: now - 4 * DAY },
      { id: "backup-age", label: "backup age", threshold: "> 26 h", state: "ok", since: null, value: "2h", lastFiredAt: null },
      { id: "outlier", label: "a customer past 3x the median", threshold: "> 3x median and > $10", state: "firing", since: now - 5 * 3_600_000, value: "ravi@madanibot.test egress 23x", lastFiredAt: now - 5 * 3_600_000 },
    ],
  };
}
