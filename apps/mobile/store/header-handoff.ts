// The chat header while the bot's sheet opens over it, frame by frame, as the page draws it after the native glass hands
// it over (a recording stand-in plays the glass here, as in perf.ts). `--glyphs <json>` gives the stand-in the native
// header's symbols ({ back, right: { data, w, h } }), as GlassChromePlugin's `glyphs` sends them on an iPhone.
//
//   node --experimental-strip-types apps/mobile/store/header-handoff.ts --out dir [--glyphs glyphs.json]
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { startStage } from "./stage.ts";

const { values: args } = parseArgs({ options: { out: { type: "string" }, glyphs: { type: "string" } } });
if (!args.out) throw new Error("--out <dir>");
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const glyphs = args.glyphs ? JSON.parse(readFileSync(args.glyphs, "utf8")) : null;

const GLASS = `(() => {
  const record = window.__glassLog = [];
  const push = (kind) => (state) => record.push([performance.now(), kind, kind === "update" ? Boolean(state && state.header) : null]);
  window.__perfGlass = { update: push("update"), setText() {}, setAvatar: push("avatar"), focus() {}, blur() {}, clear: push("clear"), slide() {},
    ${glyphs ? `glyphs: async () => (${JSON.stringify(glyphs)}),` : ""}
    onEvent: (fn) => { window.__glassEmit = fn; return () => {}; } };
})()`;

const out = join(tmpdir(), `madani-header-build-${process.pid}`);
const build = spawnSync(join(repoRoot, "node_modules/.bin/vite"), ["build", "--config", "apps/mobile/store/perf.vite.config.ts", "--logLevel", "error"], { cwd: repoRoot, env: { ...process.env, MADANI_PERF_OUT: out }, stdio: "inherit" });
if (build.status !== 0) process.exit(1);
process.env.MADANI_PERF_OUT = out;

const stage = await startStage({ args: ["preview", "--config", "apps/mobile/store/perf.vite.config.ts"], ready: "Local" });
try {
  await stage.page.send("Page.addScriptToEvaluateOnNewDocument", { source: GLASS });
  await stage.home("light");
  await stage.chat("Nova");
  await stage.page.until(`document.documentElement.dataset.nativeGlassHeader !== undefined`, 10_000);
  await delay(600);
  mkdirSync(args.out, { recursive: true });
  // the page's header at rest, drawn over where the glass is, at the phone's own scale: its glyphs against the buttons
  const still = await stage.page.evaluate(`(() => {
    const style = document.head.appendChild(document.createElement("style"));
    style.textContent = "html[data-native-glass-header] .madani-mobile [data-glass-nav] [data-glass] { opacity: 1 !important }";
    const nav = document.querySelector("[data-glass-nav]").getBoundingClientRect();
    return { style: true, x: nav.left, y: nav.top, width: nav.width, height: nav.height };
  })()`);
  await delay(300);
  const shot = await stage.page.send("Page.captureScreenshot", { format: "png", clip: { x: still.x, y: still.y, width: still.width, height: still.height, scale: 1 } });
  writeFileSync(join(args.out, "header-still.png"), Buffer.from(shot.data, "base64"));
  await stage.page.evaluate(`document.head.lastElementChild.remove()`);
  await delay(300);
  const frames: Array<{ at: number; data: string }> = [];
  const off = stage.page.on("Page.screencastFrame", (frame: { metadata: { timestamp: number }; data: string; sessionId: number }) => {
    frames.push({ at: frame.metadata.timestamp * 1000, data: frame.data });
    void stage.page.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
  });
  await stage.page.send("Page.startScreencast", { format: "png", maxWidth: 1320, maxHeight: 2868, everyNthFrame: 1 });
  await delay(400);
  const tapAt = await stage.page.evaluate(`(() => { window.__glassEmit({ type: "tap", target: "title" }); return performance.timeOrigin + performance.now(); })()`);
  await delay(900);
  await stage.page.send("Page.stopScreencast");
  off();
  const list = frames.map((frame, i) => {
    const file = join(args.out!, `${String(i).padStart(3, "0")}.png`);
    writeFileSync(file, Buffer.from(frame.data, "base64"));
    return { file, ms: Math.round(frame.at - tapAt) };
  });
  const log = await stage.page.evaluate(`window.__glassLog.map(([t, kind, header]) => [Math.round(performance.timeOrigin + t - ${tapAt}), kind, header])`);
  const page = await stage.page.evaluate(`(() => { const s = getComputedStyle(document.querySelector("[data-glass=right]"), "::after"); return { glyphs: document.documentElement.dataset.nativeGlyphs ?? null, rightGlyph: s.maskImage !== "none" || s.webkitMaskImage !== "none" }; })()`);
  writeFileSync(join(args.out, "frames.json"), JSON.stringify({ frames: list, glass: log, page }, null, 2));
  console.log(JSON.stringify({ frames: list.length, page }));
} finally {
  await stage.stop();
}
process.exit(0);
