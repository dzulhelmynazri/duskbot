// How the phone app feels, in numbers: the production build on the stage.ts fixture in headless Chrome at 440 x 956 with
// the CPU slowed (4x by default), driven with real taps and touch scrolls. Each interaction reports tap to first motion and
// to landing, frames dropped, long tasks, React commits and the components they rendered, requests, calls over the native
// glass bridge (a recording stand-in), and style and layout work. `--video <dir>` also keeps the screencast of each chat
// switch for frame strips.
//
//   node --experimental-strip-types apps/mobile/store/perf.ts --out perf.json [--rate 4] [--runs 3] [--video dir] [--only sheet|switch] [--long 320]
//     [--bots 50] [--trace trace.json]
//   MADANI_STAGE_PLATFORM=android runs it as the Android app: a Pixel 7's screen, no native glass, typed into the page's composer
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { startStage, js, stagePictureUrl, type Stage } from "./stage.ts";
import { TEAM } from "./team.mjs";

const { values: args } = parseArgs({ options: { out: { type: "string" }, rate: { type: "string", default: "4" }, runs: { type: "string", default: "3" }, video: { type: "string" }, profile: { type: "string" }, only: { type: "string" }, long: { type: "string", default: "320" },
  bots: { type: "string", default: "50" }, trace: { type: "string" } } });
const ANDROID = process.env.MADANI_STAGE_PLATFORM === "android";
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const RATE = Number(args.rate);
const RUNS = Number(args.runs);
const LONG = "Quill";

// a long chat to scroll and switch into: 320 messages by default of lists, code, links, tables and pictures, as a working
// chat reads after a few weeks
const quill = TEAM.find((one) => one.name === LONG)!;
const long: Array<[string, string, number]> = [];
const table = (i: number) => `\n\n| channel | sent | opened |\n| --- | --- | --- |\n| email | ${1200 + i} | 41% |\n| push | ${800 + i} | 63% |\n| sms | ${300 + i} | 72% |`;
for (let i = 0; i < Number(args.long); i += 1) {
  const ago = 60 * 24 * 6 - i * ((6 * 24 * 60) / Number(args.long));
  const take = (i + 1) / 2;
  long.push(i % 2 === 0
    ? ["me", `draft ${i / 2 + 1}: can you tighten the intro and give me three options for the closing line?`, ago]
    : [LONG, `here's take ${take}:\n\n1. **lead with the result**, then the why\n2. cut the second paragraph to two lines\n3. end on the ask\n\n\`\`\`\nsubject: quick update on the launch\n\`\`\`\n\nthe closing options are in [the doc](https://example.com/doc/${i}). want me to send the shortest one?${take % 5 === 0 ? table(i) : ""}${take % 7 === 0 ? `\n\n![launch photo ${take}](${stagePictureUrl(take)})` : ""}`, ago - 1]);
}
(quill as { chat: unknown[] }).chat = [...long, ...quill.chat];
// a home of many bots (a workspace holds at most 100), as a busy team's phone lists them
const COLORS = ["purple", "blue", "pink", "orange", "teal", "yellow", "coral", "green"];
for (let i = TEAM.length; i < Number(args.bots); i += 1) {
  (TEAM as unknown as Array<Record<string, unknown>>).push({ name: `Helper ${i + 1}`, color: COLORS[i % COLORS.length], body: "pip", chat: [["me", `task ${i + 1}: check the numbers`, 600 + i * 30], [`Helper ${i + 1}`, `done, the numbers for task ${i + 1} add up.`, 599 + i * 30]] });
}

const INSTRUMENT = `(() => {
  const perf = window.__perf = { frames: [], longtasks: [], commits: [], fetches: [], glass: [], walk: false, tapAt: 0, marks: {} };
  addEventListener("pointerdown", (e) => { perf.tapAt = performance.now(); }, { capture: true });
  const tick = (t) => { perf.frames.push(t); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  try { new PerformanceObserver((list) => { for (const e of list.getEntries()) perf.longtasks.push([e.startTime, e.duration]); }).observe({ type: "longtask", buffered: true }); } catch {}
  perf.shifts = [];
  try { new PerformanceObserver((list) => { for (const e of list.getEntries()) perf.shifts.push([e.startTime, e.value]); }).observe({ type: "layout-shift", buffered: true }); } catch {}
  perf.fonts = [];
  document.fonts?.addEventListener("loadingdone", (e) => { for (const face of e.fontfaces) perf.fonts.push([performance.now(), face.family]); });
  const realFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input.url;
    const entry = [performance.now(), String(url).replace(location.origin, ""), 0];
    perf.fetches.push(entry);
    return realFetch.apply(this, arguments).then((res) => { entry[2] = performance.now() - entry[0]; return res; });
  };
  const name = (t) => !t ? "?" : typeof t === "string" ? null : t.displayName || t.name || (t.type && (t.type.displayName || t.type.name)) || (t.render && (t.render.displayName || t.render.name)) || null;
  const count = (fiber, out) => {
    const stack = [fiber];
    while (stack.length) {
      const f = stack.pop();
      const prev = f.alternate;
      if ((typeof f.type === "function" || (f.type && typeof f.type === "object")) && (!prev || (f.flags & 1))) {
        const n = name(f.type);
        if (n) out[n] = (out[n] || 0) + 1;
      }
      if (prev && f.child === prev.child) { if (f.sibling) stack.push(f.sibling); continue; }
      if (f.sibling) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
    }
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, renderers: new Map(), isDisabled: false,
    inject() { return 1; }, checkDCE() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, onScheduleFiberRoot() {},
    onCommitFiberRoot(id, root) {
      const at = performance.now();
      const out = {};
      if (perf.walk) count(root.current.child, out);
      perf.commits.push([at, out]);
    },
  };
  let header = false;
  const glass = (kind) => (state) => {
    const swap = kind === "update" && Boolean(state?.header) !== header;
    if (kind === "update") header = Boolean(state?.header);
    perf.glass.push([performance.now(), kind, state === undefined ? 0 : JSON.stringify(state).length, swap]);
  };
  window.__perfGlass = { update: glass("update"), setText: glass("text"), setAvatar: glass("avatar"), focus() {}, blur() {}, clear: glass("clear"), slide: glass("slide"), onEvent: (fn) => { perf.emit = fn; return () => {}; } };
  // the pushed page's position each frame, for when a slide starts and lands
  // read as drawn only while it may move (an inline transform changed, or keyframes run), so a resting page is not restyled
  let inline = null, x = null;
  const watch = () => {
    const el = document.querySelector(".mobile-page");
    if (!el) x = null;
    else if (el.style.transform !== inline || el.getAnimations().length) { inline = el.style.transform; x = new DOMMatrixReadOnly(getComputedStyle(el).transform).m41; }
    const last = perf.pagePath?.at(-1);
    if (perf.pagePath && (!last || last[1] !== x)) perf.pagePath.push([performance.now(), x]);
    // an open sheet's rise: its y each frame while one is on screen
    const sheet = document.querySelector(".mobile-sheet");
    const y = sheet ? new DOMMatrixReadOnly(getComputedStyle(sheet).transform).m42 : null;
    const top = perf.sheetPath?.at(-1);
    if (perf.sheetPath && (!top || top[1] !== y)) perf.sheetPath.push([performance.now(), y]);
    requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);
})()`;

type Result = Record<string, number | string | Record<string, number> | string[]>;

async function metrics(stage: Stage): Promise<Record<string, number>> {
  const { metrics: list } = await stage.page.send("Performance.getMetrics");
  return Object.fromEntries(list.map((m: { name: string; value: number }) => [m.name, m.value]));
}

async function center(stage: Stage, selector: string): Promise<{ x: number; y: number }> {
  const box = await stage.page.evaluate(`(() => { const el = ${selector}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!box) throw new Error(`nothing at ${selector.slice(0, 100)}`);
  return box;
}

async function tap(stage: Stage, selector: string) {
  const { x, y } = await center(stage, selector);
  await stage.page.send("Input.synthesizeTapGesture", { x, y, duration: 40, gestureSourceType: "touch" });
}

const row = (name: string) => `[...document.querySelectorAll(".mobile-nav button")].find((el) => el.textContent.trim().toLowerCase().startsWith(${js(name.toLowerCase())}))`;
const BACK = `document.querySelector("[data-mobile-chat] [data-glass=back]")`;
const TITLE = `document.querySelector("[data-mobile-chat] [data-glass=title]")`;
const LOG = `document.querySelector("[data-mobile-chat] [role=log]")`;

/** Runs `act`, waits `settle` ms, and reports what the page did from the start of the window. */
async function measure(stage: Stage, label: string, act: () => Promise<void>, settle: number, walk = false): Promise<Result> {
  await stage.page.evaluate(`(() => { const p = window.__perf; p.walk = ${walk}; p.start = performance.now(); p.tapAt = 0; p.pagePath = []; p.sheetPath = []; p.frames.length = 0; p.longtasks.length = 0; p.commits.length = 0; p.fetches.length = 0; p.glass.length = 0; })()`);
  const before = await metrics(stage);
  await act();
  await delay(settle);
  const after = await metrics(stage);
  const page = await stage.page.evaluate(`(() => {
    const p = window.__perf, from = p.start, tap = p.tapAt || from;
    const frames = p.frames.filter((t) => t >= from);
    const gaps = frames.slice(1).map((t, i) => t - frames[i]);
    const sorted = [...gaps].sort((a, b) => a - b);
    const longtasks = p.longtasks.filter(([s]) => s >= from);
    const rendered = {};
    for (const [, out] of p.commits) for (const [k, v] of Object.entries(out)) rendered[k] = (rendered[k] || 0) + v;
    const path = p.pagePath;
    const width = innerWidth;
    const moved = path.find(([, x]) => x !== null && x < width - 0.5 && x > 0.5);
    const landed = path.find(([t, x]) => x !== null && Math.abs(x) < 0.5 && (!moved || t >= moved[0]));
    const gone = path.find(([, x]) => x === null || x >= width - 0.5);
    const sheetPath = p.sheetPath.filter(([, y]) => y !== null);
    const rose = sheetPath.find(([, y]) => y < sheetPath[0][1] - 0.5);
    const sheetLanded = sheetPath.find(([, y]) => Math.abs(y) < 0.5);
    return {
      ...(sheetPath.length ? { tapToSheet: Math.round(sheetPath[0][0] - tap), tapToSheetMove: rose ? Math.round(rose[0] - tap) : -1, tapToSheetLand: sheetLanded ? Math.round(sheetLanded[0] - tap) : -1 } : {}),
      tapToMove: moved ? Math.round(moved[0] - tap) : -1,
      tapToLand: landed ? Math.round(landed[0] - tap) : -1,
      tapToGone: gone ? Math.round(gone[0] - tap) : -1,
      frames: frames.length,
      dropped: gaps.reduce((n, g) => n + Math.max(0, Math.round(g / 16.67) - 1), 0),
      worstFrame: Math.round(Math.max(0, ...gaps)),
      p50Frame: Math.round((sorted[Math.floor(0.5 * sorted.length)] ?? 0) * 10) / 10,
      p95Frame: Math.round((sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))] ?? 0) * 10) / 10,
      longTasks: longtasks.length,
      longTaskMs: Math.round(longtasks.reduce((n, [, d]) => n + d, 0)),
      worstTask: Math.round(Math.max(0, ...longtasks.map(([, d]) => d))),
      commits: p.commits.length,
      fibers: Object.values(rendered).reduce((a, b) => a + b, 0),
      topRendered: Object.fromEntries(Object.entries(rendered).sort((a, b) => b[1] - a[1]).slice(0, 12)),
      requests: p.fetches.length,
      requestUrls: p.fetches.map(([, u, d]) => u.split("?")[0] + " " + Math.round(d) + "ms"),
      glassUpdates: p.glass.filter(([, k]) => k === "update").length,
      glassAvatars: p.glass.filter(([, k]) => k === "avatar").length,
      glassSlides: p.glass.filter(([, k]) => k === "slide").length,
      // the native header taken down and put back: each one swaps the glass pill for the page's own
      glassHeaderSwaps: p.glass.filter(([, , , swap]) => swap).length,
      glassBytes: p.glass.reduce((n, [, , b]) => n + b, 0),
      // what the page holds once the interaction settles: every element, the open chat's own and its message rows
      domNodes: document.getElementsByTagName("*").length,
      chatNodes: document.querySelector("[data-mobile-chat]")?.getElementsByTagName("*").length ?? 0,
      messageRows: document.querySelectorAll("[data-mobile-chat] [data-message-row]").length,
    };
  })()`);
  const d = (k: string) => Math.round(((after[k] ?? 0) - (before[k] ?? 0)) * (k.endsWith("Duration") ? 1000 : 1));
  const result: Result = { label, ...page, layouts: d("LayoutCount"), styleRecalcs: d("RecalcStyleCount"), layoutMs: d("LayoutDuration"), styleMs: d("RecalcStyleDuration"), scriptMs: d("ScriptDuration") };
  console.log(`${label}: ${JSON.stringify(Object.fromEntries(Object.entries(result).filter(([k]) => !["topRendered", "requestUrls", "label"].includes(k))))}`);
  return result;
}

const landed = (stage: Stage) => stage.page.until(`(() => { const el = document.querySelector(".mobile-page"); return el && Math.abs(new DOMMatrixReadOnly(getComputedStyle(el).transform).m41) < 0.5 && ${LOG}; })()`, 15_000);
const home = (stage: Stage) => stage.page.until(`!document.querySelector(".mobile-page")`, 15_000);

async function openChat(stage: Stage, name: string, walk = false) {
  const result = await measure(stage, `home -> ${name}`, async () => { await tap(stage, row(name)); await landed(stage); }, 600, walk);
  return result;
}
async function back(stage: Stage, walk = false) {
  return measure(stage, "chat -> back", async () => { await tap(stage, BACK); await home(stage); }, 400, walk);
}

/** The screencast of one chat switch, frame by frame with their times from the tap. */
async function recordSwitch(stage: Stage, name: string, dir: string) {
  mkdirSync(dir, { recursive: true });
  const frames: Array<{ at: number; data: string }> = [];
  const off = stage.page.on("Page.screencastFrame", (frame) => {
    frames.push({ at: frame.metadata.timestamp * 1000, data: frame.data });
    void stage.page.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
  });
  await stage.page.send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: 440, maxHeight: 956, everyNthFrame: 1 });
  await delay(400);
  await stage.page.evaluate(`window.__perf.tapAt = 0`);
  await tap(stage, row(name));
  await landed(stage).catch(() => {});
  await delay(700);
  await stage.page.send("Page.stopScreencast");
  off();
  const tapEpoch = await stage.page.evaluate(`performance.timeOrigin + window.__perf.tapAt`);
  const list = frames.map((frame, i) => {
    const file = join(dir, `${String(i).padStart(3, "0")}.jpg`);
    writeFileSync(file, Buffer.from(frame.data, "base64"));
    return { file, ms: Math.round(frame.at - tapEpoch) };
  });
  writeFileSync(join(dir, "frames.json"), JSON.stringify(list, null, 2));
}

const STREAMED = Array.from({ length: 12 }, (_, i) => `${i + 1}. **${["mon", "tue", "wed", "thu", "fri", "sat"][i % 6]}**: the review at ${9 + (i % 8)}:00, then a block for the deck, and the gym after six if the call ends on time.`).join("\n") + "\n\nthat leaves thursday afternoon open for the launch prep. want me to hold it?";

const TYPED = "can you move friday's dinner to saturday?";

/** Types TYPED one character at a time, 120 ms apart, and keeps in window.__typed each keystroke's time from the key to
 * the end of the frame after it (a rAF, then a task queued from it, which runs once that frame is drawn). The native field
 * is the iPhone's: its text reaches the page over the glass bridge. The page field is the page's own textarea (Android,
 * and the iPhone's fallback). */
async function typeLine(stage: Stage, field: "native" | "page") {
  await stage.page.evaluate(`(async () => {
    const field = ${js(field)};
    const text = ${js(TYPED)};
    const box = document.querySelector("[data-mobile-chat] [data-tour=composer] textarea");
    if (field === "page") box.focus();
    const lat = window.__typed = [];
    const painted = () => new Promise((done) => requestAnimationFrame(() => { const c = new MessageChannel(); c.port1.onmessage = () => done(); c.port2.postMessage(0); }));
    for (let i = 1; i <= text.length; i++) {
      const start = performance.now();
      if (field === "native") window.__perf.emit({ type: "text", text: text.slice(0, i) });
      else document.execCommand("insertText", false, text[i - 1]);
      await painted();
      lat.push(performance.now() - start);
      await new Promise((done) => setTimeout(done, 120));
    }
  })()`);
}

async function clearField(stage: Stage, field: "native" | "page") {
  await stage.page.evaluate(field === "native"
    ? `window.__perf.emit({ type: "text", text: "" })`
    : `(() => { const box = document.querySelector("[data-mobile-chat] [data-tour=composer] textarea"); box.focus(); box.select(); document.execCommand("delete"); box.blur(); })()`);
  await delay(400);
}

/** a finger drags a bot message 120 px to the right over about 300 ms, past the reply threshold, and lets go */
async function swipeReply(stage: Stage) {
  const at = await stage.page.evaluate(`(() => { const b = [...document.querySelectorAll("[data-mobile-chat] [data-message-row]:not(.items-end)")].filter((row) => row.querySelector("[data-testid=message-actions] button[aria-label^='Reply' i]") && row.querySelector("[data-chat-bubble]")).at(-1).querySelector("[data-chat-bubble]").getBoundingClientRect(); return { x: b.left + 60, y: b.top + Math.min(24, b.height / 2) }; })()`);
  await stage.page.evaluate(`window.__perf.tapAt = performance.now()`);
  await stage.page.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: at.x, y: at.y }] });
  for (let step = 1; step <= 18; step += 1) {
    await stage.page.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: at.x + step * (120 / 18), y: at.y + step * 0.2 }] });
    await delay(16);
  }
  await stage.page.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

console.log("building the phone app");
const out = join(tmpdir(), `madani-perf-build-${process.pid}`);
const build = spawnSync(join(repoRoot, "node_modules/.bin/vite"), ["build", "--config", "apps/mobile/store/perf.vite.config.ts", "--logLevel", "warn"], { cwd: repoRoot, env: { ...process.env, MADANI_PERF_OUT: out }, stdio: "inherit" });
if (build.status !== 0) process.exit(1);
process.env.MADANI_PERF_OUT = out;

// about 30 tokens a second, four characters to a token
process.env.FAKE_CLAUDE_STREAM_CADENCE ??= "4:33";
const stage = await startStage({ args: ["preview", "--config", "apps/mobile/store/perf.vite.config.ts"], ready: "Local" }, { "stream probe": STREAMED });
const results: Result[] = [];
try {
  await stage.page.send("Performance.enable");
  await stage.page.send("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENT });
  await stage.home("light");
  await stage.page.send("Emulation.setCPUThrottlingRate", { rate: RATE });

  // cold start: a reload to the chat list on screen
  await stage.page.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await stage.page.evaluate(`location.reload()`);
  await stage.page.until(`window.__perf && ${row("Nova")}`, 30_000);
  await delay(3000);
  await stage.page.send("Emulation.setCPUThrottlingRate", { rate: RATE });
  const cold = await stage.page.evaluate(`(() => { const nav = performance.getEntriesByType("navigation")[0]; const fcp = performance.getEntriesByName("first-contentful-paint")[0]; const p = window.__perf; return { domContentLoaded: Math.round(nav.domContentLoadedEventEnd), firstContentfulPaint: Math.round(fcp?.startTime ?? -1), requests: p.fetches.length, layoutShift: Math.round(p.shifts.reduce((n, [, v]) => n + v, 0) * 1000) / 1000, shifts: p.shifts.length, fontsLoadedAt: p.fonts.map(([t, f]) => f + " " + Math.round(t)) }; })()`);
  console.log(`cold start (unthrottled): ${JSON.stringify(cold)}`);
  results.push({ label: "cold start (unthrottled)", ...cold });

  for (let run = 0; run < (args.only === "sheet" ? 0 : RUNS); run += 1) {
    const walk = run === RUNS - 1;
    results.push(await openChat(stage, LONG, walk));
    results.push(await back(stage, walk));
    results.push(await openChat(stage, "Nova", walk));
    results.push(await back(stage, walk));
  }

  if (args.trace) {
    // a timeline of one long chat opening: every style and layout pass with the script that forced it
    await stage.page.send("Tracing.start", { categories: ["devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack,v8.execute", process.env.MADANI_TRACE_CATEGORIES].filter(Boolean).join(","), transferMode: "ReturnAsStream" });
    await openChat(stage, LONG);
    const done = new Promise<{ stream: string }>((resolve) => { const off = stage.page.on("Tracing.tracingComplete", (event) => { off(); resolve(event); }); });
    await stage.page.send("Tracing.end");
    const { stream } = await done;
    let trace = "";
    for (;;) {
      const chunk = await stage.page.send("IO.read", { handle: stream, size: 1 << 20 });
      trace += chunk.base64Encoded ? Buffer.from(chunk.data, "base64").toString("utf8") : chunk.data;
      if (chunk.eof) break;
    }
    await stage.page.send("IO.close", { handle: stream });
    writeFileSync(args.trace, trace);
    await back(stage);
  }

  if (args.only !== "switch") {
  if (args.only !== "sheet") {
  results.push(await measure(stage, `scroll home (${args.bots} bots)`, async () => {
    await stage.page.send("Input.synthesizeScrollGesture", { x: 220, y: 600, yDistance: -3000, speed: 2400, gestureSourceType: "touch", repeatCount: 1 });
    await stage.page.send("Input.synthesizeScrollGesture", { x: 220, y: 300, yDistance: 3000, speed: 2400, gestureSourceType: "touch", repeatCount: 1 });
  }, 500, true));
  await openChat(stage, LONG);
  results.push(await measure(stage, "idle chat, 2 s", async () => {}, 2000, true));
  results.push(await measure(stage, `scroll ${LONG}`, async () => {
    const { x, y } = { x: 220, y: 480 };
    await stage.page.send("Input.synthesizeScrollGesture", { x, y, yDistance: 4000, speed: 2400, gestureSourceType: "touch", repeatCount: 1 });
  }, 500, true));
  results.push(await measure(stage, `scroll ${LONG} back down`, async () => {
    const { x, y } = { x: 220, y: 480 };
    await stage.page.send("Input.synthesizeScrollGesture", { x, y, yDistance: -4000, speed: 2400, gestureSourceType: "touch", repeatCount: 1 });
  }, 500, true));
  await back(stage);
  }

  await openChat(stage, "Nova");
  if (args.only !== "sheet") results.push(await measure(stage, "send a message (and its reply)", async () => {
    if (ANDROID) {
      await tap(stage, `document.querySelector("[data-mobile-chat] textarea")`);
      await stage.page.send("Input.insertText", { text: "what's on for tomorrow?" });
      await delay(300);
      await tap(stage, `[...document.querySelectorAll("[data-mobile-chat] [data-tour=composer] button")].find((el) => /^send/i.test(el.getAttribute("aria-label") ?? ""))`);
    } else {
      // typed and sent through the glass bridge, as the native composer does
      await stage.page.evaluate(`window.__perf.emit({ type: "text", text: "what's on for tomorrow?" })`);
      await delay(300);
      await stage.page.evaluate(`window.__perf.emit({ type: "button", index: 0, kind: "send" })`);
    }
    await stage.page.until(`[...document.querySelectorAll("[data-mobile-chat] [data-message-row]")].some((row) => row.textContent.includes("on for tomorrow"))`, 5000);
  }, 5000, true));
  if (args.only !== "sheet") {
    // typing at about eight characters a second: each keystroke's time from the key to the frame that draws it
    for (const field of ANDROID ? ["page"] as const : ["native", "page"] as const) {
      const result = await measure(stage, `type 40 characters (${field} field)`, () => typeLine(stage, field), 300, true);
      const lat = (await stage.page.evaluate(`window.__typed`)) as number[];
      const sorted = [...lat].sort((a, b) => a - b);
      const at = (q: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! * 10) / 10;
      Object.assign(result, { keyToPaintP50: at(0.5), keyToPaintP95: at(0.95), keyToPaintMax: Math.round(Math.max(...sorted)) });
      console.log(`  keystroke to paint: p50 ${at(0.5)} ms, p95 ${at(0.95)} ms, max ${Math.round(Math.max(...sorted))} ms`);
      results.push(result);
      await clearField(stage, field);
    }
  }
  if (args.only !== "sheet" && !ANDROID) {
    // a long answer streamed at about 30 tokens a second: what each token costs the page while it reads
    await stage.page.evaluate(`window.__perf.emit({ type: "text", text: "stream probe: plan my week" })`);
    await delay(300);
    results.push(await measure(stage, "stream a reply (30 tok/s)", async () => {
      await stage.page.evaluate(`window.__perf.emit({ type: "button", index: 1, kind: "send" })`);
      await stage.page.until(`[...document.querySelectorAll("[data-mobile-chat] [data-message-row]")].some((row) => row.textContent.includes(${js(STREAMED.slice(-30))}))`, 60_000);
    }, 800, true));
    results.push(await measure(stage, "swipe a message to reply", () => swipeReply(stage), 600, true));
    await delay(400);
  }
  results.push(await measure(stage, "open the bot sheet", async () => {
    await tap(stage, TITLE);
    await stage.page.until(`[...document.querySelectorAll("[role=dialog]")].some((el) => el.getBoundingClientRect().width > 0)`, 10_000);
  }, 800, true));
  const sheetGone = () => stage.page.until(`!document.querySelector(".mobile-sheet")`, 10_000);
  results.push(await measure(stage, "close the bot sheet", async () => {
    await stage.page.evaluate(`document.querySelector(".mobile-sheet").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await sheetGone();
  }, 400, true));
  // as on an iPhone: the native pill's touch reaches the page over the glass bridge
  for (let run = 0; run < (ANDROID ? 0 : RUNS); run += 1) {
    results.push(await measure(stage, "open the bot sheet from the native pill", async () => {
      await stage.page.evaluate(`(() => { window.__perf.tapAt = performance.now(); window.__perf.emit({ type: "tap", target: "title" }); })()`);
      await stage.page.until(`[...document.querySelectorAll("[role=dialog]")].some((el) => el.getBoundingClientRect().width > 0)`, 10_000);
    }, 800, run === RUNS - 1));
    await stage.page.evaluate(`document.querySelector(".mobile-sheet").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await sheetGone();
    await delay(400);
  }

  }

  if (args.profile) {
    // where the page thread's time goes while a long chat opens: self time by function, heaviest first
    await stage.home("light");
    // a reload reopens the chat that was open
    if (await stage.page.evaluate(`Boolean(${BACK})`)) { await tap(stage, BACK); await home(stage); await delay(500); }
    await stage.page.send("Emulation.setCPUThrottlingRate", { rate: RATE });
    await stage.page.send("Profiler.enable");
    await stage.page.send("Profiler.setSamplingInterval", { interval: 200 });
    await stage.page.send("Profiler.start");
    await openChat(stage, LONG);
    const { profile } = await stage.page.send("Profiler.stop");
    await back(stage);
    writeFileSync(args.profile, JSON.stringify(profile));
    const spent = new Map<number, number>();
    profile.samples.forEach((id: number, i: number) => spent.set(id, (spent.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000));
    const self = new Map<string, number>();
    for (const node of profile.nodes) {
      const { functionName, url, lineNumber } = node.callFrame;
      const key = `${functionName || "(anonymous)"} ${String(url).split("/").pop()}:${lineNumber}`;
      self.set(key, (self.get(key) ?? 0) + (spent.get(node.id) ?? 0));
    }
    for (const [key, ms] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`${ms.toFixed(1).padStart(8)} ms  ${key}`);
    // and the components that rendered, by the time spent inside them (their own and everything they called)
    const byId = new Map(profile.nodes.map((node: { id: number }) => [node.id, node]));
    const total = (node: { id: number; children?: number[] }): number => (spent.get(node.id) ?? 0) + (node.children ?? []).reduce((n, id) => n + total(byId.get(id) as { id: number }), 0);
    const inside = new Map<string, number>();
    const walk = (node: { id: number; children?: number[]; callFrame: { functionName: string } }, open: Set<string>) => {
      const name = node.callFrame.functionName;
      const component = /^[A-Z][A-Za-z0-9]+$/.test(name) && !open.has(name);
      if (component) inside.set(name, (inside.get(name) ?? 0) + total(node));
      const next = component ? new Set([...open, name]) : open;
      for (const id of node.children ?? []) walk(byId.get(id) as typeof node, next);
    };
    walk(profile.nodes[0], new Set());
    console.log("components, inclusive:");
    for (const [key, ms] of [...inside].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`${ms.toFixed(1).padStart(8)} ms  ${key}`);
  }

  if (args.video) {
    await stage.home("light");
    await stage.page.send("Emulation.setCPUThrottlingRate", { rate: RATE });
    await recordSwitch(stage, LONG, join(args.video, "long-chat"));
    await tap(stage, BACK);
    await home(stage);
    await delay(800);
    await recordSwitch(stage, "Nova", join(args.video, "short-chat"));
  }
} finally {
  if (args.out) writeFileSync(args.out, JSON.stringify({ rate: RATE, runs: RUNS, at: new Date().toISOString(), results }, null, 2));
  await stage.stop();
}
process.exit(0);
