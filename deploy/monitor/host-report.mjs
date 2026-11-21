#!/usr/bin/env node
// a box's own numbers (cpu, memory, root disk, load) and the newest backup per set it holds, posted to the account
// service's ops page every 5 minutes by madani-host-report.timer. node built-ins only.
//   MADANI_OPS_REPORT_URL    https://madani.bot/v1/ops/report
//   MADANI_OPS_REPORT_TOKEN  the account service's MADANI_OPS_REPORT_TOKEN
//   MADANI_HOST_NAME         the name the ops page shows (default oracle)
//   MADANI_BACKUP_ROOT       folder holding <set>/{runs,daily,weekly} (default /srv/madani-backups/data)
import { readFileSync, readdirSync, statSync, statfsSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const cpuTimes = () => cpus().reduce((sum, cpu) => { const t = cpu.times; return { idle: sum.idle + t.idle, total: sum.total + t.user + t.nice + t.sys + t.idle + t.irq }; }, { idle: 0, total: 0 });
const round1 = n => Math.round(n * 10) / 10;

/** the newest file's modification time per set under root/<set>/{runs,daily,weekly} */
export function newestBackups(root) {
  let sets = [];
  try { sets = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^[a-z0-9-]{1,40}$/.test(entry.name)).map(entry => entry.name); } catch { return []; }
  return sets.map(set => {
    let at = null;
    for (const kind of ["runs", "daily", "weekly"]) {
      let names = [];
      try { names = readdirSync(join(root, set, kind)); } catch { continue; }
      for (const name of names) { try { const m = statSync(join(root, set, kind, name)).mtimeMs; if (at === null || m > at) at = Math.round(m); } catch {} }
    }
    return { set, at };
  });
}

export async function collect(env = process.env) {
  const a = cpuTimes();
  await new Promise(resolve => setTimeout(resolve, 1000));
  const b = cpuTimes();
  let available = null;
  try { available = Number(/MemAvailable:\s+(\d+)/.exec(readFileSync("/proc/meminfo", "utf8"))?.[1]) * 1024 || null; } catch {}
  const fs = statfsSync("/");
  return {
    host: env.MADANI_HOST_NAME || "oracle",
    cpu: b.total > a.total ? round1((1 - (b.idle - a.idle) / (b.total - a.total)) * 100) : null,
    mem: round1((totalmem() - (available ?? freemem())) / totalmem() * 100),
    disk: round1((1 - fs.bavail / fs.blocks) * 100),
    load: loadavg().map(n => Math.round(n * 100) / 100), cores: cpus().length,
    memTotalBytes: totalmem(), diskTotalBytes: fs.blocks * fs.bsize,
    backups: newestBackups(env.MADANI_BACKUP_ROOT || "/srv/madani-backups/data"),
  };
}

async function main() {
  const url = process.env.MADANI_OPS_REPORT_URL, token = process.env.MADANI_OPS_REPORT_TOKEN;
  if (!url || !token) { console.error("set MADANI_OPS_REPORT_URL and MADANI_OPS_REPORT_TOKEN"); process.exit(2); }
  const report = await collect();
  const res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "madani-host-report/1" },
    body: JSON.stringify(report), signal: AbortSignal.timeout(20_000) });
  if (!res.ok) { console.error(`host report: the account service answered ${res.status}`); process.exit(1); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
