#!/usr/bin/env -S node --experimental-strip-types
// Switching between conversations, on an isolated fixture only: a temporary HOME and data folder, the fake engine,
// the production build, and a headless Chrome with its own profile. For each switch it reports the time from the
// click to the frame the final messages (and the pictures in view) are painted, the layout shifts in that time, how
// often the rows in view changed after the first paint, and how far from the bottom the first paint sat.
//   node --experimental-strip-types scripts/bench-switching.ts [--chrome PATH] [--messages 80] [--latency 220]
//     [--dist DIR] [--out FILE] [--screenshots DIR]
// Passes: cold (nothing cached), warm (each chat seen once), rehydrate (the same after the server restarts and the
// app reloads its snapshot), reload (a new page load on the same browser profile), each local and with --latency ms.
// --live instead changes chats while another is open and counts what opening them then changes (bench-switching-live.ts).
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { verificationServerArgs, verificationServerEnvironment } from "./control-madani.ts";
import { launchChrome, type Page } from "./testing/bench-desktop-page.ts";
import { liveEngineEnvironment, livePasses, STREAM_HANDLE } from "./testing/bench-switching-live.ts";
import { removeTempDir, waitForExit } from "../server/testing/cleanup.ts";
import { freePortBlock } from "../server/testing/ports.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    chrome: { type: "string" },
    messages: { type: "string", default: "80" },
    latency: { type: "string", default: "220" },
    dist: { type: "string" },
    out: { type: "string" },
    screenshots: { type: "string" },
    probe: { type: "string" },
    advanced: { type: "boolean", default: false },
    live: { type: "boolean", default: false },
  },
});
const STORAGE = { "madani-analytics-opt-out": "1", "madani-email-gate": "skipped", "madani-simple-mode-prompt": "1", "grok-move-2026-11": "1", "madani-advanced-mode": "0" } as Record<string, string>;
const log = (line: string) => process.stderr.write(`bench-switching: ${line}\n`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const median = (samples: number[]) => { const sorted = [...samples].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : NaN; };
const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
const work = mkdtempSync(join(tmpdir(), "madanibot-bench-work-"));
const chromePath = values.chrome ?? join(process.env.HOME ?? "", "Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell");

interface Chat { id: string; threadId: string; name: string; lastId: string }

/** Runs in the page: clicks a sidebar row and samples every frame until the chat's final rows and pictures show. */
const SWITCH = (botId: string, lastId: string, name: string, timeoutMs: number) => `new Promise((resolve) => {
  const shifts = [];
  const observer = new PerformanceObserver((list) => { for (const entry of list.getEntries()) shifts.push({ value: entry.value, at: entry.startTime }); });
  observer.observe({ type: "layout-shift" });
  const row = document.querySelector('[data-sidebar-bot-row="${botId}"]');
  if (!row) { observer.disconnect(); resolve({ error: "no sidebar row" }); return; }
  const scroller = () => document.querySelector("[role=log]")?.closest(".glass-scroller");
  // transcript rows are display: contents, so their box is their children's
  const rect = (element) => { const boxes = getComputedStyle(element).display === "contents" ? [...element.children].map((child) => child.getBoundingClientRect()) : [element.getBoundingClientRect()];
    return boxes.length ? { top: Math.min(...boxes.map((b) => b.top)), bottom: Math.max(...boxes.map((b) => b.bottom)) } : { top: 0, bottom: 0 }; };
  const inView = (element, box) => { const r = rect(element); return r.bottom > box.top && r.top < box.bottom && r.bottom > r.top; };
  const sample = () => {
    const log = document.querySelector("[role=log]");
    const box = scroller()?.getBoundingClientRect();
    if (!log || !box || !String(log.getAttribute("aria-label") || "").includes(${JSON.stringify(name)})) return null;
    const rows = [...log.querySelectorAll("[data-mid]")].filter((element) => inView(element, box));
    const visible = rows.map((element) => element.getAttribute("data-mid"));
    // what each row in view says, so a row redrawn with new words counts as much as a row that came or went
    const content = rows.map((element) => element.getAttribute("data-mid") + ":" + element.textContent).join("\n");
    // the conversation's own pictures; a link's site icon comes from the internet and says nothing about switching
    const pictures = [...log.querySelectorAll('img[src^="/api/attachments/"], img[src^="blob:"]')].filter((image) => inView(image, box));
    const placeholders = [...log.querySelectorAll("[role=status]")].filter((element) => inView(element, box)).length;
    const shown = pictures.every((image) => image.complete && image.naturalWidth > 0 && getComputedStyle(image).opacity === "1");
    const el = scroller();
    return { visible: visible.join(","), content, hasLast: Boolean(log.querySelector('[data-mid="${lastId}"]')), shown, placeholders, gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) };
  };
  const started = performance.now();
  let first = null, final = null, previous = null, said = null, changes = 0, contentChanges = 0, placeholderFrames = 0, frames = 0, look = null, lastChange = 0, skeletonFrames = 0;
  const step = () => {
    const now = performance.now();
    const s = sample();
    frames += 1;
    const seen = s ? [s.visible, s.placeholders, s.shown, s.gap < 4].join("|") : "none";
    if (seen !== look) { look = seen; lastChange = now - started; }
    if (document.querySelector("[data-transcript-skeleton]")) skeletonFrames += 1;
    if (s && s.visible) {
      if (!first) first = { at: now - started, gap: s.gap, hasLast: s.hasLast };
      else if (previous !== null && s.visible !== previous) changes += 1;
      if (said !== null && s.content !== said) contentChanges += 1;
      previous = s.visible;
      said = s.content;
      if (s.placeholders) placeholderFrames += 1;
      if (!final && s.hasLast && s.shown && s.placeholders === 0 && s.gap < 4) final = { at: now - started, gap: s.gap };
    }
    if (final && now - started > final.at + 1200 || now - started > ${timeoutMs}) {
      observer.disconnect();
      const late = shifts.filter((shift) => shift.at >= started);
      const settled = Math.max(lastChange, ...late.map((shift) => shift.at - started));
      const reads = performance.getEntriesByType("resource").filter((entry) => entry.startTime >= started && new RegExp("/api/threads/|/api/transcripts|/tasks/").test(entry.name)).map((entry) => Math.round(entry.duration));
      resolve({ firstPaintMs: first ? Math.round(first.at) : null, firstGap: first?.gap ?? null, firstHadLast: first?.hasLast ?? false,
        finalMs: final ? Math.round(final.at) : null, settledMs: Math.round(settled), skeletonFrames, threadReadsMs: reads, cls: Math.round(late.reduce((sum, shift) => sum + shift.value, 0) * 10000) / 10000,
        shifts: late.length, viewportChanges: changes, contentChanges, placeholderFrames, frames });
      return;
    }
    requestAnimationFrame(step);
  };
  row.click();
  requestAnimationFrame(step);
})`;

async function buildUi(outDir: string) {
  const { build } = await import("vite");
  await build({ configFile: join(ROOT, "vite.config.ts"), root: ROOT, logLevel: "warn", mode: "production", build: { outDir, emptyOutDir: true, reportCompressedSize: false, chunkSizeWarningLimit: 100_000 } });
}

function newDataDir(): string {
  const dir = mkdtempSync(join("/tmp", "madanibot-bench-"));
  mkdirSync(join(dir, "tmp"), { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    features: { smartSetupChoices: false },
    language: "en",
    instances: { claude: { driver: "claudeAgent", displayName: "Bench fixture", config: { cli: join(ROOT, "server", "testing", "fake-claude-cli.ts") } } },
  }, null, 2));
  return dir;
}

/** One fake-engine server on a fixed port, so a restart keeps the page's origin. */
async function startServer(dataDir: string, port: number, staticDir: string): Promise<() => Promise<void>> {
  const env = verificationServerEnvironment({ LANG: process.env.LANG, TZ: process.env.TZ }, dataDir, port);
  env.MADANI_STATIC_DIR = staticDir;
  if (values.live) Object.assign(env, liveEngineEnvironment(dataDir));
  const logFd = openSync(join(work, `server-${port}.log`), "a", 0o600);
  const child: ChildProcess = spawn(process.execPath, verificationServerArgs(env), { cwd: ROOT, env, stdio: ["ignore", logFd, logFd] });
  closeSync(logFd);
  for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return () => waitForExit(child, { signal: "SIGTERM" }).then(() => undefined);
    } catch { /* not listening yet */ }
    await sleep(25);
  }
  child.kill("SIGKILL");
  throw new Error(`fixture server did not become ready; see ${work}`);
}

async function run() {
  const dist = values.dist ?? join(work, "dist");
  if (!values.dist) {
    log("building the app");
    await buildUi(dist);
  }
  const dataDir = newDataDir();
  const seedOut = execFileSync(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts", "testing", "bench-switching-seed.ts"), values.messages!], {
    cwd: ROOT, encoding: "utf8", env: { PATH: dirname(process.execPath), HOME: dataDir, MADANI_DATA_DIR: dataDir, TMPDIR: join(dataDir, "tmp") }, maxBuffer: 16 * 1024 * 1024,
  });
  const { chats } = JSON.parse(seedOut.trim().split("\n").at(-1)!) as { chats: Chat[] };
  const port = await freePortBlock([0, 1]);
  const url = `http://127.0.0.1:${port}`;
  let stop = await startServer(dataDir, port, dist);
  const chrome = await launchChrome(chromePath);
  const result: Record<string, unknown> = { messagesPerChat: Number(values.messages), latencyMs: Number(values.latency) };
  try {
    if (values.advanced) STORAGE["madani-advanced-mode"] = "1";
    if (values.probe) {
      const page = await chrome.newPage({ storage: STORAGE });
      await page.send("Page.navigate", { url });
      await page.waitFor(`document.querySelector('[data-sidebar-bot-row]') && document.querySelector('[role=log]')`, 60_000);
      await sleep(1_500);
      if (values.probe === "sidebar") {
        // a real pointer click on a row near the bottom of a scrolled sidebar, then where the sidebar sits
        const find = `(() => { const rows = [...document.querySelectorAll("[data-sidebar-bot-row]")]; let sc = rows.at(-1).parentElement;
          while (sc && !(sc.scrollHeight > sc.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement; return sc; })()`;
        const results = [];
        for (const pick of [-2, -3, -4]) {
          const at = await page.evaluate<{ x: number; y: number; before: number; name: string }>(`(() => { const sc = ${find}; sc.scrollTop = sc.scrollHeight;
            const row = [...document.querySelectorAll("[data-sidebar-bot-row]")].at(${pick}); const r = row.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2, before: sc.scrollTop, name: row.textContent.slice(0, 10) }; })()`);
          await sleep(200);
          for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
          const after: number[] = [];
          for (const ms of [30, 200, 800]) { await sleep(ms); after.push(await page.evaluate<number>(`${find}.scrollTop`)); }
          results.push({ ...at, after, opened: await page.evaluate(`document.querySelector("[role=log]")?.getAttribute("aria-label")`) });
        }
        process.stdout.write(`${JSON.stringify(results)}\n`);
        return;
      }
      const expression = values.probe === "switch" ? SWITCH(chats[1]!.id, chats[1]!.lastId, chats[1]!.name, 15_000) : values.probe.replaceAll("CHATS", JSON.stringify(chats));
      process.stdout.write(`${JSON.stringify(await page.evaluate(expression))}\n`);
      return;
    }
    for (const latency of [0, Number(values.latency)]) {
      const condition = latency ? `latency${latency}ms` : "local";
      log(`${condition}: cold page`);
      const page = await chrome.newPage({ storage: STORAGE });
      await page.send("Page.addScriptToEvaluateOnNewDocument", { source: STREAM_HANDLE });
      await page.send("Network.enable", {});
      await page.send("Storage.clearDataForOrigin", { origin: url, storageTypes: "indexeddb,cache_storage" });
      if (latency) await page.send("Network.emulateNetworkConditions", { offline: false, latency, downloadThroughput: 2_500_000, uploadThroughput: 1_250_000 });
      const passes: Record<string, unknown> = {};
      const launches: unknown[] = [];
      const open = async () => {
        await page.send("Page.navigate", { url });
        if (!await page.waitFor(`document.querySelector('[data-sidebar-bot-row]') && document.querySelector('[role=log]')`, 60_000)) throw new Error("the app did not open");
        await sleep(1_500);
        // launch to every chat cached: the snapshot, then the one read that brings every conversation
        launches.push(await page.evaluate(`(() => { const at = (part) => performance.getEntriesByType("resource").find((entry) => entry.name.includes(part));
          const bots = at("/api/bots?"), all = at("/api/transcripts");
          return { snapshotMs: bots ? Math.round(bots.responseEnd) : null, allChatsMs: all ? Math.round(all.responseEnd) : null, allChatsBytes: all ? all.decodedBodySize : null,
            sidebarRows: document.querySelectorAll("[data-sidebar-bot-row]").length }; })()`));
        // start every pass from a quiet bot, so all five chats are switches
        await page.evaluate(`[...document.querySelectorAll('[data-sidebar-bot-row]')].find((row) => row.textContent.includes("Quiet 1"))?.click()`);
        await sleep(1_500);
      };
      const pass = async (label: string, shots = false) => {
        const switches: Array<Record<string, unknown>> = [];
        for (const chat of chats) {
          const sample = await page.evaluate<Record<string, unknown>>(SWITCH(chat.id, chat.lastId, chat.name, 15_000));
          switches.push({ chat: chat.name, ...sample });
          if (shots && values.screenshots) await screenshot(page, join(values.screenshots, `${condition}-${label}-${chat.name}.png`));
          await sleep(400);
        }
        const finals = switches.map((entry) => Number(entry.finalMs)).filter(Number.isFinite);
        const settled = switches.map((entry) => Number(entry.settledMs)).filter(Number.isFinite);
        passes[label] = {
          clickToSettledMs: { median: median(settled), max: Math.max(...settled) },
          clickToFinalMs: { median: median(finals), max: Math.max(...finals) },
          skeletonFrames: switches.reduce((sum, entry) => sum + Number(entry.skeletonFrames || 0), 0),
          firstPaintMs: { median: median(switches.map((entry) => Number(entry.firstPaintMs)).filter(Number.isFinite)) },
          cls: { total: round(switches.reduce((sum, entry) => sum + Number(entry.cls || 0), 0), 4), max: Math.max(...switches.map((entry) => Number(entry.cls || 0))) },
          viewportChanges: switches.reduce((sum, entry) => sum + Number(entry.viewportChanges || 0), 0),
          placeholderFrames: switches.reduce((sum, entry) => sum + Number(entry.placeholderFrames || 0), 0),
          firstPaintNotAtBottom: switches.filter((entry) => Number(entry.firstGap) > 4).length,
          firstPaintWithoutNewest: switches.filter((entry) => entry.firstHadLast === false).length,
          switches,
        };
      };
      await open();
      if (values.live) {
        result[condition] = { launches, ...await livePasses(page, url, chats, SWITCH, async () => { await stop(); stop = await startServer(dataDir, port, dist); }) };
        await page.close();
        continue;
      }
      await pass("cold", true);
      await page.evaluate(`[...document.querySelectorAll('[data-sidebar-bot-row]')].find((row) => row.textContent.includes("Quiet 1"))?.click()`);
      await sleep(800);
      await pass("warm");
      log(`${condition}: server restart`);
      await stop();
      stop = await startServer(dataDir, port, dist);
      // the stream reconnects on its own backoff and the app reloads its snapshot
      await sleep(6_000);
      await pass("rehydrate");
      log(`${condition}: reload`);
      await open();
      await pass("reload");
      result[condition] = { launches, ...passes };
      await page.close();
    }
  } finally {
    await chrome.close();
    await stop();
    await removeTempDir(dataDir);
  }
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (values.out) writeFileSync(values.out, text);
  process.stdout.write(text);
}

async function screenshot(page: Page, path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const { data } = await page.send("Page.captureScreenshot", { format: "png" }) as { data: string };
  writeFileSync(path, Buffer.from(data, "base64"));
}

try {
  await run();
} finally {
  await removeTempDir(work);
}
