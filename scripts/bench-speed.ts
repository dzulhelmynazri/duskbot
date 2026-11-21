// End-to-end speed of one disposable fake-engine fixture: server cold start, the UI's first paint and load requests,
// and a reply's hops from send to the first visible text. See docs/verification/speed.md.
import { spawn, type ChildProcess } from "node:child_process";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { verificationServerEnvironment } from "./control-madani.ts";
import { removeTempDir, waitForExit } from "../server/testing/cleanup.ts";
import { freePortBlock } from "../server/testing/ports.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const { values: opts } = parseArgs({
  options: {
    server: { type: "string", default: "built" },
    runs: { type: "string", default: "3" },
    replies: { type: "string", default: "5" },
    bots: { type: "string", default: "50" },
    "cpu-prof": { type: "string" },
    playwright: { type: "string", default: process.env.MADANI_BENCH_PLAYWRIGHT ?? "" },
    only: { type: "string", default: "start,ui,reply" },
    json: { type: "string" },
    cold: { type: "boolean", default: false },
  },
});
const phases = new Set(opts.only!.split(","));

type Fixture = { url: string; dataDir: string; child: ChildProcess; marks: Record<string, number>; t0: number; stampFile: string; log: string[] };

const median = (values: number[]) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : NaN;
};
const round = (value: number) => Math.round(value * 10) / 10;

function engineWrapper(dataDir: string): { cli: string; stampFile: string } {
  const stampFile = join(dataDir, "engine-stamps.ndjson");
  const cli = join(dataDir, "timed-fake-claude.mjs");
  const fake = pathToFileURL(join(ROOT, "server", "testing", "fake-claude-cli.ts")).href;
  writeFileSync(cli, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const stamp = (event) => appendFileSync(${JSON.stringify(stampFile)}, JSON.stringify({ event, at: Date.now(), pid: process.pid }) + "\\n");
stamp("spawn");
const write = process.stdout.write.bind(process.stdout);
let first = true;
process.stdout.write = (chunk, ...rest) => { if (first && String(chunk).includes('"text_delta"') || first && String(chunk).includes('"assistant"')) { first = false; stamp("first-text"); } return write(chunk, ...rest); };
process.stdin.on("data", () => { stamp("stdin"); first = true; });
await import(${JSON.stringify(fake)});
`, { mode: 0o755 });
  return { cli, stampFile };
}

async function startFixture(dataDir: string | null, cpuProf?: string, server = opts.server): Promise<Fixture> {
  const port = await freePortBlock([0, 1], 21_000, 2_000);
  const url = `http://127.0.0.1:${port}`;
  const fresh = !dataDir;
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), "madanibot-bench-"));
  const { cli, stampFile } = engineWrapper(dir);
  if (fresh) {
    mkdirSync(join(dir, "tmp"), { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      features: { smartSetupChoices: false },
      instances: { claude: { driver: "claudeAgent", displayName: "Bench fixture", config: { cli } } },
    }, null, 2));
  }
  const env = { ...verificationServerEnvironment(process.env, dir, port), MADANI_STATIC_DIR: join(ROOT, "dist"), MADANI_DEV_TRUST_LOCAL_BROWSER: "1" };
  const entry = server === "ts"
    ? ["--experimental-strip-types", join(ROOT, "server", "index.ts")]
    : [join(ROOT, "dist-server", "desktop-entry.mjs")];
  if (server !== "ts") env.MADANI_SERVER_COMPILE_CACHE = join(tmpdir(), "madanibot-bench-compile-cache");
  const args = [...(cpuProf ? ["--cpu-prof", `--cpu-prof-dir=${cpuProf}`] : []), ...entry];
  const t0 = performance.now();
  const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  const marks: Record<string, number> = {};
  const log: string[] = [];
  const onLine = (chunk: Buffer) => {
    for (const line of String(chunk).split("\n")) {
      if (!line) continue;
      log.push(`${round(performance.now() - t0)} ${line}`);
      if (line.includes("madanibot server on") && marks.listening === undefined) marks.listening = performance.now() - t0;
    }
  };
  child.stdout!.on("data", onLine);
  child.stderr!.on("data", onLine);
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited:\n${log.slice(-30).join("\n")}`);
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) { marks.health = performance.now() - t0; break; }
    } catch {}
    if (Date.now() > deadline) throw new Error(`server never answered:\n${log.slice(-30).join("\n")}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const bots = await fetch(`${url}/api/bots`, { headers: { origin: url } });
  await bots.arrayBuffer();
  marks.bots = performance.now() - t0;
  return { url, dataDir: dir, child, marks, t0, stampFile, log };
}

async function stop(fixture: Fixture, keep = false) {
  await waitForExit(fixture.child, { signal: "SIGTERM" });
  if (!keep) await removeTempDir(fixture.dataDir);
}

// node:http, not fetch: Node 26's fetch (undici) on a reused connection here sometimes waits 0.2-2 s before the server
// sees the request, which no browser does.
const keepAlive = new HttpAgent({ keepAlive: true });
const api = (fixture: Fixture, path: string, init: { method?: string; body?: string } = {}) => new Promise<any>((resolve, reject) => {
  const request = httpRequest(`${fixture.url}${path}`, {
    method: init.method ?? "GET", agent: keepAlive,
    headers: { "content-type": "application/json", origin: fixture.url, ...(init.body ? { "content-length": Buffer.byteLength(init.body) } : {}) },
  }, (response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("end", () => {
      const text = Buffer.concat(chunks).toString();
      if ((response.statusCode ?? 500) >= 400) reject(new Error(`${path}: ${response.statusCode} ${text}`));
      else resolve(text ? JSON.parse(text) : null);
    });
  });
  request.on("error", reject);
  request.end(init.body);
});

const results: Record<string, number> = {};
const report = (name: string, values: number[]) => {
  results[name] = round(median(values));
  console.log(`${name.padEnd(48)} p50 ${String(round(median(values))).padStart(8)} ms   [${values.map(round).join(", ")}]`);
};

async function coldStart() {
  const runs = Number(opts.runs);
  const listening: number[] = [], health: number[] = [], bots: number[] = [], restartHealth: number[] = [];
  for (let run = 0; run < runs; run += 1) {
    const fixture = await startFixture(null, run === 0 ? opts["cpu-prof"] : undefined);
    if (process.env.MADANI_BENCH_TRACE) console.log(fixture.log.filter((line) => line.includes(process.env.MADANI_BENCH_TRACE!)).join("\n"));
    listening.push(fixture.marks.listening); health.push(fixture.marks.health); bots.push(fixture.marks.bots);
    await stop(fixture, true);
    const again = await startFixture(fixture.dataDir, run === 0 ? opts["cpu-prof"] : undefined);
    if (process.env.MADANI_BENCH_TRACE) console.log(again.log.filter((line) => line.includes(process.env.MADANI_BENCH_TRACE!)).join("\n"));
    restartHealth.push(again.marks.health);
    await stop(again);
  }
  report("start: spawn -> listening (fresh)", listening);
  report("start: spawn -> /api/health (fresh)", health);
  report("start: spawn -> /api/bots read (fresh)", bots);
  report("start: spawn -> /api/health (restart)", restartHealth);
}

async function seedBots(fixture: Fixture, count: number) {
  const existing = (await api(fixture, "/api/bots?messages=0")).bots.length;
  for (let index = existing; index < count; index += 1) {
    await api(fixture, "/api/bots", { method: "POST", body: JSON.stringify({ name: `Bench ${index}` }) });
  }
}

async function ui() {
  if (!opts.playwright || !existsSync(opts.playwright)) { console.log("ui: skipped (pass --playwright <path to playwright/index.mjs>)"); return; }
  // the built server never trusts a local browser without a sign-in, so the page runs against the TypeScript server
  const { chromium } = await import(pathToFileURL(opts.playwright).href);
  const fixture = await startFixture(null, undefined, "ts");
  const browser = await chromium.launch({ headless: true, args: ["--use-mock-keychain", "--password-store=basic"] });
  try {
    await api(fixture, "/api/config", { method: "PATCH", body: JSON.stringify({ language: "en" }) }).catch(() => {});
    await seedBots(fixture, Number(opts.bots));
    const fleet = (await api(fixture, "/api/bots?messages=0")).bots as Array<{ id: string; name: string; threadId: string }>;
    const longBot = fleet[0];
    for (let index = 0; index < 200; index += 1) {
      await api(fixture, `/api/bots/${longBot.id}/messages`, { method: "POST", body: JSON.stringify({ text: `message ${index} ${"lorem ipsum ".repeat(index % 7 * 6)}`, threadId: longBot.threadId }) });
      if (index % 20 === 19) await waitIdle(fixture, longBot.id);
    }
    await waitIdle(fixture, longBot.id);
    const firstPaint: number[] = [], sidebar: number[] = [], composer: number[] = [], load: number[] = [], switchMs: number[] = [], longOpen: number[] = [];
    const routes = new Map<string, number[]>();
    for (let run = 0; run < Number(opts.runs); run += 1) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await context.addInitScript((storage: Record<string, string>) => { for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value); }, { "madani-analytics-opt-out": "1", "madani-email-gate": "skipped", "madani-simple-mode-prompt": "1", "grok-move-2026-11": "1" });
      const page = await context.newPage();
      const started = new Map<any, number>();
      page.on("request", (request: any) => started.set(request, performance.now()));
      page.on("requestfinished", (request: any) => {
        const path = new URL(request.url()).pathname;
        if (!path.startsWith("/api/") || path === "/api/events") return;
        const key = `${request.method()} ${path.replace(/[0-9a-f-]{8,}|bot-[\w-]+|t-[\w-]+/g, ":id")}`;
        routes.set(key, [...(routes.get(key) ?? []), performance.now() - started.get(request)!]);
      });
      const t0 = performance.now();
      await page.goto(fixture.url, { waitUntil: "commit" });
      await page.waitForFunction(() => performance.getEntriesByName("first-contentful-paint").length > 0, null, { timeout: 30_000, polling: 5 });
      firstPaint.push(await page.evaluate(() => performance.getEntriesByName("first-contentful-paint")[0].startTime));
      await page.locator(`[data-sidebar-bot-row="${fleet[fleet.length - 1].id}"]`).first().waitFor({ timeout: 30_000 }).catch(async (error: unknown) => { if (process.env.MADANI_BENCH_SHOT) await page.screenshot({ path: process.env.MADANI_BENCH_SHOT }); console.log("rows", await page.locator("[data-sidebar-bot-row]").count()); throw error; });
      sidebar.push(performance.now() - t0);
      await page.locator("textarea").first().waitFor({ state: "visible", timeout: 30_000 });
      composer.push(performance.now() - t0);
      await page.waitForLoadState("networkidle").catch(() => {});
      load.push(performance.now() - t0);
      for (const target of [fleet[5], fleet[12], fleet[30 % fleet.length]]) {
        const s0 = performance.now();
        await page.locator(`[data-sidebar-bot-row="${target.id}"]`).first().click();
        await page.locator(`textarea[aria-label="Message ${target.name}"]`).waitFor({ timeout: 10_000 });
        switchMs.push(performance.now() - s0);
      }
      const l0 = performance.now();
      await page.locator(`[data-sidebar-bot-row="${longBot.id}"]`).first().click();
      await page.getByText("message 199", { exact: false }).first().waitFor({ timeout: 15_000 });
      longOpen.push(performance.now() - l0);
      await context.close();
    }
    report("ui: navigation -> first contentful paint", firstPaint);
    report(`ui: navigation -> sidebar lists ${fleet.length} bots`, sidebar);
    report("ui: navigation -> composer visible", composer);
    report("ui: navigation -> network idle", load);
    report("ui: switch chat -> composer of that bot", switchMs);
    report("ui: open 200-message chat -> last message shown", longOpen);
    for (const [route, times] of [...routes].sort((a, b) => median(b[1]) - median(a[1])).slice(0, 25)) report(`api: ${route} (x${times.length})`, times);
  } finally {
    await browser.close();
    await stop(fixture);
  }
}

async function waitIdle(fixture: Fixture, botId: string) {
  for (let tries = 0; tries < 400; tries += 1) {
    const bot = (await api(fixture, "/api/bots?messages=0")).bots.find((candidate: any) => candidate.id === botId);
    if (bot && !bot.busy && !bot.working && bot.status !== "working") return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function reply() {
  const fixture = await startFixture(null, phases.has("start") ? undefined : opts["cpu-prof"]);
  try {
    const fleet = (await api(fixture, "/api/bots?messages=0")).bots as Array<{ id: string; threadId: string }>;
    let bot = fleet[0];
    const events = await fetch(`${fixture.url}/api/events`, { headers: { origin: fixture.url, accept: "text/event-stream" } });
    const reader = events.body!.getReader();
    const listeners: Array<(frame: any, at: number) => void> = [];
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) return;
        const at = performance.now();
        buffer += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
          const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5)).join("\n");
          if (!data) continue;
          try { const frame = JSON.parse(data); for (const listener of listeners) listener(frame, at); } catch {}
        }
      }
    })();
    const accepted: number[] = [], spawned: number[] = [], firstEngineText: number[] = [], firstFrame: number[] = [], done: number[] = [], overhead: number[] = [], delivered: number[] = [];
    for (let run = 0; run < Number(opts.replies); run += 1) {
      writeFileSync(fixture.stampFile, "");
      if (opts.cold) bot = (await api(fixture, "/api/bots", { method: "POST", body: JSON.stringify({ name: `Cold ${run}`, greeting: false }) })).bot;
      const marks: Record<string, number> = {};
      const settled = new Promise<void>((resolve) => {
        listeners[0] = (frame, at) => {
          const frames = Array.isArray(frame) ? frame : [frame];
          for (const item of frames) {
            const event = item?.kind === "runtime" ? item.event : null;
            const text = event?.type === "content.delta" || (item?.kind === "message" && item.threadId === bot.threadId && item.message?.role === "bot" && item.message?.kind === "text");
            if (text && marks.frame === undefined) marks.frame = at;
            if ((event?.type === "turn.completed" && event.threadId === bot.threadId) && marks.done === undefined) { marks.done = at; resolve(); }
          }
        };
      });
      const t0 = performance.now();
      const wall0 = Date.now();
      await api(fixture, `/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: `ping ${run}`, threadId: bot.threadId }) });
      marks.accepted = performance.now();
      await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, 30_000))]);
      const stamps = readFileSync(fixture.stampFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { event: string; at: number });
      const at = (event: string) => { const hit = stamps.find((stamp) => stamp.event === event); return hit ? hit.at - wall0 : NaN; };
      accepted.push(marks.accepted - t0);
      spawned.push(at("spawn")); firstEngineText.push(at("first-text"));
      firstFrame.push(marks.frame - t0); done.push(marks.done - t0);
      overhead.push(at("stdin")); delivered.push(marks.frame - t0 - at("first-text"));
      if (process.env.MADANI_BENCH_TRACE) {
        console.log(fixture.log.filter((line) => line.includes(process.env.MADANI_BENCH_TRACE!)).join("\n"));
        console.log(`stamps: ${stamps.map((stamp) => `${stamp.event}@${stamp.at - wall0}`).join(" ")} frame@${round(marks.frame - t0)} sent@${round(t0 - fixture.t0)} accepted@${round(marks.accepted - fixture.t0)}`);
        fixture.log.length = 0;
      }
      await waitIdle(fixture, bot.id);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    report(`reply${opts.cold ? " (new chat)" : ""}: send -> POST answered`, accepted);
    report(`reply${opts.cold ? " (new chat)" : ""}: send -> engine process spawned`, spawned);
    report(`reply${opts.cold ? " (new chat)" : ""}: send -> prompt written to engine (overhead)`, overhead);
    report(`reply${opts.cold ? " (new chat)" : ""}: send -> engine first text`, firstEngineText);
    report(`reply${opts.cold ? " (new chat)" : ""}: send -> first text frame on /api/events`, firstFrame);
    report(`reply${opts.cold ? " (new chat)" : ""}: engine first text -> frame on /api/events`, delivered);
    report(`reply${opts.cold ? " (new chat)" : ""}: send -> turn.completed frame`, done);
    void reader.cancel().catch(() => {});
  } finally {
    await stop(fixture);
  }
}

async function writes() {
  const fixture = await startFixture(null);
  try {
    await seedBots(fixture, Number(opts.bots));
    const bot = (await api(fixture, "/api/bots?messages=0")).bots[0] as { id: string; threadId: string };
    const other = (await api(fixture, `/api/bots/${bot.id}/tasks`, { method: "POST", body: JSON.stringify({ title: "Other" }) })).task?.threadId as string | undefined;
    const read: number[] = [], switched: number[] = [];
    for (let run = 0; run < Number(opts.runs) + 2; run += 1) {
      await api(fixture, `/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: `read ${run}`, threadId: bot.threadId }) });
      await waitIdle(fixture, bot.id);
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      let t0 = performance.now();
      await api(fixture, `/api/bots/${bot.id}/read`, { method: "POST", body: JSON.stringify({ threadId: bot.threadId }) });
      read.push(performance.now() - t0);
      if (other) {
        t0 = performance.now();
        await api(fixture, `/api/bots/${bot.id}/tasks/${run % 2 ? bot.threadId : other}?messages=200`, { method: "POST", body: "{}" });
        switched.push(performance.now() - t0);
      }
    }
    report(`writes: mark a chat read (${opts.bots} bots)`, read);
    if (switched.length) report(`writes: switch thread (${opts.bots} bots)`, switched);
  } finally {
    await stop(fixture);
  }
}

if (phases.has("writes")) await writes();
if (phases.has("start")) await coldStart();
if (phases.has("reply")) await reply();
if (phases.has("ui")) await ui();
if (opts.json) appendFileSync(opts.json, `${JSON.stringify({ at: new Date().toISOString(), results })}\n`);
process.exit(0);
