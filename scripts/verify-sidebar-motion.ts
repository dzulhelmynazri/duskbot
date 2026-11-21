// The sidebar opening and closing in the real app, against a disposable fake-engine server: stills of it open and as
// avatars in each skin, a frame strip of each move sampled every 1/60 s, and the frame times of each move with the CPU
// slowed 4x, with what layout, style and script cost each toggle. Run: node --experimental-strip-types scripts/verify-sidebar-motion.ts <dir> [--label before]
// Headless Chrome (MADANI_CDP_CHROME, else the installed Google Chrome) in a throwaway profile; files go to <dir>.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { launchVerificationServer, runControlMadani } from "./control-madani.ts";
import { fixtureApi, mountPreview, type MountedPreview } from "./testing/preview-fixture.ts";

const out = resolve(process.argv[2] ?? "");
const labelAt = process.argv.indexOf("--label");
const label = labelAt === -1 ? "after" : process.argv[labelAt + 1]!;
const CHROME = process.env.MADANI_CDP_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const [WIDTH, HEIGHT] = [1280, 800];
const FRAME_MS = 1000 / 60;
const BOTS: Record<string, string> = { Research: "pink", Inbox: "teal", Writer: "yellow", Travel: "blue", Recipes: "coral", Notes: "green", Ledger: "purple", Garden: "green", Taxes: "blue" };
const ARCHIVED = ["Garden", "Taxes"];
const NAMES = Object.keys(BOTS);

async function openChrome(profile: string) {
  const chrome = spawn(CHROME, ["--headless=new", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "--use-mock-keychain", "--password-store=basic",
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], { stdio: "ignore" });
  let port = "";
  for (let i = 0; i < 100 && !port; i++) {
    await delay(100);
    try { port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]!.trim(); } catch {}
  }
  if (!port) { chrome.kill(); throw new Error("Chrome did not start"); }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
  const socket = new WebSocket(targets.find((target) => target.type === "page")!.webSocketDebuggerUrl);
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
  let next = 0;
  const waiting = new Map<number, { done: (value: any) => void; fail: (error: Error) => void }>();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    const call = waiting.get(message.id);
    if (!call) return;
    waiting.delete(message.id);
    if (message.error) call.fail(new Error(message.error.message)); else call.done(message.result);
  };
  const send = (method: string, params: object = {}) => new Promise<any>((done, fail) => {
    const id = ++next;
    const timer = setTimeout(() => { waiting.delete(id); fail(new Error(`${method} got no answer`)); }, 30_000);
    waiting.set(id, { done: (value) => { clearTimeout(timer); done(value); }, fail: (error) => { clearTimeout(timer); fail(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression: string) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  };
  const until = async (condition: string, what: string) => {
    const end = Date.now() + 60_000;
    while (!(await evaluate(condition).catch(() => false))) {
      if (Date.now() > end) throw new Error(`${what} never showed`);
      await delay(250);
    }
  };
  const shot = async (file: string, scale = 2) => {
    await send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: scale, mobile: false });
    const { data } = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 } });
    writeFileSync(file, Buffer.from(data, "base64"));
  };
  return { send, evaluate, until, shot, close() { socket.close(); chrome.kill(); } };
}

/** The ⌘\ the sidebar listens for, sent the way a key press reaches the page. */
const TOGGLE = `window.dispatchEvent(new KeyboardEvent("keydown", { key: "\\\\", metaKey: true, ctrlKey: true, bubbles: true, cancelable: true }))`;

/** rAF deltas over the 900ms after one toggle, the time the toggle's own handler took, and the main thread's long tasks
 * meanwhile. */
const TIMED_TOGGLE = `(async () => {
  const stamps = [];
  const long = [];
  const observer = new PerformanceObserver((list) => { for (const entry of list.getEntries()) long.push(entry.duration); });
  observer.observe({ entryTypes: ["longtask"] });
  let on = true;
  const tick = (now) => { stamps.push(now); if (on) requestAnimationFrame(tick); };
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  requestAnimationFrame(tick);
  await new Promise((done) => setTimeout(done, 50));
  const start = performance.now();
  ${TOGGLE};
  const handler = performance.now() - start;
  await new Promise((done) => setTimeout(done, 900));
  on = false;
  observer.disconnect();
  return { deltas: stamps.slice(1).map((stamp, index) => stamp - stamps[index]), handler, long };
})()`;

type Run = { deltas: number[]; handler: number; long: number[]; cost: Record<string, number> };
const COST = ["LayoutCount", "RecalcStyleCount", "LayoutDuration", "RecalcStyleDuration", "ScriptDuration", "TaskDuration"];
const diff = (from: Record<string, number>, to: Record<string, number>) =>
  Object.fromEntries(COST.map((name) => [name, name.endsWith("Duration") ? +((to[name]! - from[name]!) * 1000).toFixed(1) : to[name]! - from[name]!]));

function summary(runs: Run[]) {
  const deltas = runs.flatMap((run) => run.deltas);
  const long = runs.flatMap((run) => run.long);
  const sorted = [...deltas].sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return {
    frames: deltas.length,
    meanMs: +(deltas.reduce((sum, value) => sum + value, 0) / deltas.length).toFixed(1),
    p95Ms: +pick(0.95).toFixed(1),
    maxMs: +sorted[sorted.length - 1]!.toFixed(1),
    over20ms: deltas.filter((value) => value > 20).length,
    over34ms: deltas.filter((value) => value > 34).length,
    toggleHandlerMs: runs.map((run) => +run.handler.toFixed(1)),
    longTasksMs: long.map((value) => Math.round(value)),
    perToggle: Object.fromEntries(COST.map((name) => [name.endsWith("Duration") ? `${name}Ms` : name, +(runs.reduce((sum, run) => sum + run.cost[name]!, 0) / runs.length).toFixed(1)])),
  };
}

const fixture = await launchVerificationServer();
let ui: MountedPreview | undefined;
try {
  const api = fixtureApi(fixture.info.url, { headers: { origin: fixture.info.url } });
  for (const name of NAMES) await runControlMadani(["new-bot", "--name", name, "--url", fixture.info.url]);
  await api("PATCH", "/api/config", { language: "en" });
  const { bots } = await api("GET", "/api/bots?messages=0") as { bots: Array<{ id: string; name: string }> };
  const ids = Object.fromEntries(NAMES.map((name) => [name, bots.find((bot) => bot.name === name)!.id]));
  for (const name of NAMES) await api("PATCH", `/api/bots/${ids[name]}`, { color: BOTS[name] });
  for (const name of ["Writer", "Travel", "Recipes"]) await api("PATCH", `/api/bots/${ids[name]}`, { pinned: true });
  await api("POST", "/api/sidebar-sections", { name: "Work", botIds: [ids.Research, ids.Notes] });
  for (const name of ARCHIVED) await api("PATCH", `/api/bots/${ids[name]}`, { hidden: true });
  for (const text of ["Plan the week from my inbox", "Draft a reply to the landlord about the heater", "What is left on the tax return", "Book the dentist for Tuesday", "Find the cheapest train to Leeds on Friday", "Which bills are due this month", "Sort the receipts folder by month", "Summarise the three newsletters"]) {
    await runControlMadani(["run", "Inbox", text, "--url", fixture.info.url, "--timeout", "60s"]).catch(() => undefined);
  }
  ui = await mountPreview(fixture, { entry: "/scripts/testing/sidebar-motion-preview.tsx", route: "/__sidebar-motion.html", title: "Isolated sidebar motion", logLevel: "warn" });
  mkdirSync(out, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), "madani-sidebar-motion-chrome-"));
  const chrome = await openChrome(profile);
  const timings: Record<string, ReturnType<typeof summary>> = {};
  try {
    const load = async (skin: string, rail: boolean) => {
      await chrome.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false });
      await chrome.send("Page.navigate", { url: `${ui!.previewUrl}?skin=${skin}${rail ? "&rail=1" : ""}` });
      await chrome.until(`Boolean(document.querySelector('[data-sidebar-bot-row="${ids.Inbox}"]'))`, "the bot rows");
      await delay(600);
      await chrome.evaluate(`document.querySelector('[data-sidebar-bot-row="${ids.Inbox}"]').click()`);
      await delay(1200);
    };
    for (const skin of ["daylight", "midnight"]) for (const rail of [false, true]) {
      await load(skin, rail);
      const file = join(out, `${label}-${rail ? "compact" : "expanded"}-${skin}.png`);
      await chrome.shot(file);
      console.log(file);
    }
    await load("daylight", false);
    await chrome.evaluate(`[...document.querySelectorAll("[data-sidebar] button")].find((node) => node.textContent.trim().startsWith("Archived"))?.click()`);
    await delay(700);
    await chrome.shot(join(out, `${label}-expanded-archived-open-daylight.png`));
    await chrome.evaluate(`[...document.querySelectorAll("[data-sidebar] [role=button]")].find((node) => node.textContent.includes("Taxes"))?.click()`);
    await delay(900);
    await chrome.shot(join(out, `${label}-archived-chat-opened-daylight.png`));
    // the frame strips: every animation the toggle starts, paused and stepped by hand, 1/60 s a frame
    for (const [move, rail] of [["close", false], ["open", true]] as const) {
      await load("daylight", rail);
      await chrome.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
      await chrome.evaluate(`(async () => { ${TOGGLE}; await Promise.resolve(); await new Promise((done) => setTimeout(done, 0));
        document.querySelectorAll("*").forEach((node) => getComputedStyle(node).width);
        window.__held = document.getAnimations(); window.__held.forEach((animation) => { animation.pause(); animation.currentTime = 0; }); })()`);
      const dir = join(out, `${label}-${move}-frames`);
      mkdirSync(dir, { recursive: true });
      for (let frame = 0; frame < 48; frame++) {
        await chrome.evaluate(`window.__held.forEach((animation) => { animation.currentTime = ${frame * FRAME_MS}; })`);
        await delay(40);
        await chrome.shot(join(dir, `${String(frame).padStart(2, "0")}.png`), 1);
      }
      const strip = join(out, `${label}-${move}-strip.png`);
      spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", join(dir, "%02d.png"), "-vf", "select='not(mod(n\\,3))',crop=760:800:0:0,scale=380:-1,tile=8x2:padding=4:color=gray", "-frames:v", "1", strip]);
      spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "60", "-i", join(dir, "%02d.png"), "-pix_fmt", "yuv420p", "-vf", "crop=760:800:0:0", join(out, `${label}-${move}-60fps.mp4`)]);
      console.log(strip);
    }
    await chrome.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    for (const [move, rail] of [["close", false], ["open", true]] as const) {
      const runs: Run[] = [];
      const metrics = async () => Object.fromEntries((await chrome.send("Performance.getMetrics")).metrics.map((metric: { name: string; value: number }) => [metric.name, metric.value])) as Record<string, number>;
      for (let attempt = 0; attempt < 3; attempt++) {
        await load("daylight", rail);
        await chrome.send("Performance.enable", { timeDomain: "threadTicks" });
        const before = await metrics();
        runs.push({ ...await chrome.evaluate(TIMED_TOGGLE), cost: diff(before, await metrics()) });
        await chrome.send("Performance.disable");
      }
      timings[move] = summary(runs);
    }
    await chrome.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    writeFileSync(join(out, `${label}-frame-times.json`), JSON.stringify({ cpuSlowdown: 4, runsPerMove: 3, windowMs: 900, ...timings }, null, 2));
    console.log(JSON.stringify(timings, null, 2));
  } finally {
    chrome.close();
    await delay(500);
    rmSync(profile, { recursive: true, force: true });
  }
} finally {
  await ui?.close();
  await fixture.close();
}
