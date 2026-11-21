// Many bots at once against a fake-engine fixture: N bots each run T streamed turns concurrently while the server's
// responsiveness, memory, CPU and database growth are sampled. Nothing real is touched (control-madani's fixture).
//   node --experimental-strip-types scripts/stress/many-bots.ts [--bots 12] [--turns 5] [--cadence 24:20]
import { execFileSync } from "node:child_process";
import { get } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { launchVerificationServer } from "../control-madani.ts";
import { fixtureApi } from "../testing/preview-fixture.ts";
import { waitForJob } from "../mcp-server.ts";

const { values } = parseArgs({ options: {
  bots: { type: "string", default: "12" }, turns: { type: "string", default: "5" }, cadence: { type: "string", default: "24:20" },
} });
const botCount = Number(values.bots);
const turns = Number(values.turns);
const reply = "word ".repeat(400).trim();
const replyDir = mkdtempSync(join(tmpdir(), "madani-stress-"));
writeFileSync(join(replyDir, "reply.txt"), reply);
const fixture = await launchVerificationServer({
  ...process.env, FAKE_CLAUDE_STREAM_CADENCE: values.cadence, FAKE_CLAUDE_REPLY_FILE: join(replyDir, "reply.txt"), FAKE_CLAUDE_TOOL_CALLS: "[]",
});
const url = fixture.info.url;
const api = fixtureApi(url, { headers: { origin: url } });

function dirBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    try { total += entry.isDirectory() ? dirBytes(path) : statSync(path).size; } catch {}
  }
  return total;
}
function tree(pid: number): { rssMb: number; cpu: number; procs: number } {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,%cpu="], { encoding: "utf8" }).trim().split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
  const kids = new Map<number, number[]>();
  for (const [p, pp] of rows) kids.set(pp, [...(kids.get(pp) ?? []), p]);
  const all = new Set<number>(); const queue = [pid];
  while (queue.length) { const next = queue.pop()!; all.add(next); queue.push(...(kids.get(next) ?? [])); }
  let rss = 0, cpu = 0;
  for (const [p, , r, c] of rows) if (all.has(p)) { rss += r; cpu += c; }
  return { rssMb: Math.round(rss / 1024), cpu: Math.round(cpu), procs: all.size };
}
const serverRss = () => Math.round(Number(execFileSync("ps", ["-o", "rss=", "-p", String(fixture.info.pid)], { encoding: "utf8" }).trim()) / 1024);

// a fresh connection per probe: undici's reused sockets add up to 400 ms on macOS even against a bare node:http server
const probe = () => new Promise<number>((done) => {
  const t0 = performance.now();
  get(`${url}/api/health`, { agent: false }, (res) => { res.resume(); res.on("end", () => done(performance.now() - t0)); })
    .on("error", () => done(performance.now() - t0));
});
const lags: number[] = [];
let sampling = true;
const samples: Array<ReturnType<typeof tree> & { serverMb: number }> = [];
const sampler = (async () => {
  let tick = 0;
  while (sampling) {
    lags.push(await probe());
    if (tick++ % 10 === 0) samples.push({ ...tree(fixture.info.pid), serverMb: serverRss() });
    await new Promise((done) => setTimeout(done, 100));
  }
})();

const pct = (list: number[], p: number) => { const s = [...list].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0); };
const result: Record<string, unknown> = { bots: botCount, turns, cadence: values.cadence };
try {
  const baseDb = dirBytes(fixture.info.dataDir);
  const baseline = { ...tree(fixture.info.pid), serverMb: serverRss() };
  const idle: number[] = [];
  for (let i = 0; i < 20; i++) { idle.push(await probe()); await new Promise((done) => setTimeout(done, 100)); }
  result.idleHealthMs = { p50: pct(idle, 0.5), max: pct(idle, 1) };
  lags.length = 0;
  const bots: Array<{ id: string; threadId: string }> = [];
  for (let i = 0; i < botCount; i++) {
    const created = await api("POST", "/api/bots", { name: `Load ${i}` });
    await api("PATCH", `/api/bots/${created.bot.id}`, { computer: "off", browser: false });
    bots.push({ id: created.bot.id, threadId: created.bot.threadId });
  }
  const started = performance.now();
  const turnMs: number[] = [];
  const outcomes: Record<string, number> = {};
  const firstBotTurns: number[] = [];
  const slowTurns: Array<{ bot: number; turn: number; ms: number }> = [];
  result.slowTurns = slowTurns;
  await Promise.all(bots.map(async (bot) => {
    for (let t = 0; t < turns; t++) {
      const t0 = performance.now();
      const since = Date.now() - 1;
      await api("POST", `/api/bots/${bot.id}/messages`, { text: `turn ${t} please`, threadId: bot.threadId });
      const { job } = await waitForJob((path) => api("GET", path), bot.threadId, { scope: "turn", timeoutMs: 120_000, since });
      outcomes[job.state] = (outcomes[job.state] ?? 0) + 1;
      turnMs.push(performance.now() - t0);
      if (performance.now() - t0 > 2_000) slowTurns.push({ bot: bots.indexOf(bot), turn: t, ms: Math.round(performance.now() - t0) });
      if (bot === bots[0]) firstBotTurns.push(performance.now() - t0);
    }
  }));
  const wallMs = performance.now() - started;
  // every bot's thread must hold exactly turns user + turns bot messages
  const counts: number[] = [];
  for (const bot of bots) {
    const page = await api("GET", `/api/threads/${bot.threadId}/messages?limit=200`);
    counts.push(page.messages.length);
    if (bot === bots[0]) result.sampleRoles = page.messages.map((m: any) => `${m.role}:${String(m.text ?? "").slice(0, 20)}`);
  }
  const bucket = Math.max(1, Math.floor(firstBotTurns.length / 5));
  result.turnTrendMs = Array.from({ length: Math.ceil(firstBotTurns.length / bucket) }, (_, i) => pct(firstBotTurns.slice(i * bucket, (i + 1) * bucket), 0.5));
  const timed = async (path: string) => { const t0 = performance.now(); const body = await api("GET", path); return { ms: Math.round(performance.now() - t0), body }; };
  const reads: Record<string, number> = {};
  for (const path of ["/api/bots?messages=200", "/api/bots?messages=0", `/api/threads/${bots[0].threadId}/messages?limit=200`, "/api/inbox", "/api/search?q=please"]) {
    try { reads[path.replace(bots[0].threadId, "T")] = (await timed(path)).ms; } catch { reads[path] = -1; }
  }
  result.readMs = reads;
  await new Promise((done) => setTimeout(done, 1500));
  sampling = false; await sampler;
  Object.assign(result, {
    wallS: Math.round(wallMs / 100) / 10, outcomes, messagesPerThread: [...new Set(counts)],
    turnMs: { p50: pct(turnMs, 0.5), p95: pct(turnMs, 0.95), max: pct(turnMs, 1) },
    healthMs: { p50: pct(lags, 0.5), p95: pct(lags, 0.95), p99: pct(lags, 0.99), max: pct(lags, 1) },
    baseline, peak: { rssMb: Math.max(...samples.map((s) => s.rssMb)), serverMb: Math.max(...samples.map((s) => s.serverMb)),
      cpu: Math.max(...samples.map((s) => s.cpu)), procs: Math.max(...samples.map((s) => s.procs)) },
    after: { ...tree(fixture.info.pid), serverMb: serverRss() },
    dataGrowthKb: Math.round((dirBytes(fixture.info.dataDir) - baseDb) / 1024),
    dataTopKb: Object.fromEntries(readdirSync(fixture.info.dataDir, { withFileTypes: true })
      .map((entry) => { const path = join(fixture.info.dataDir, entry.name); return [entry.name, Math.round((entry.isDirectory() ? dirBytes(path) : statSync(path).size) / 1024)] as const; })
      .filter(([, kb]) => kb > 100).sort((a, b) => b[1] - a[1])),
  });
  const journalDir = join(fixture.info.dataDir, "memory-journal");
  try {
    const byPath: Record<string, { entries: number; beforeKb: number; actors: string[] }> = {};
    for (const file of readdirSync(journalDir)) {
      for (const line of readFileSync(join(journalDir, file), "utf8").split("\n").filter(Boolean)) {
        const entry = JSON.parse(line);
        const row = byPath[entry.path] ??= { entries: 0, beforeKb: 0, actors: [] };
        row.entries += 1; row.beforeKb += Math.round((entry.before?.length ?? 0) / 1024);
        if (!row.actors.includes(`${entry.actor}/${entry.via}`)) row.actors.push(`${entry.actor}/${entry.via}`);
      }
    }
    result.memoryJournal = byPath;
  } catch {}
} finally {
  sampling = false;
  console.log(JSON.stringify(result, null, 2));
  await fixture.close();
  rmSync(replyDir, { recursive: true, force: true });
}
