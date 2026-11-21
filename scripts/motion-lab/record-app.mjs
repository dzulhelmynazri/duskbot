// Clips of the real phone app: open and close a chat, the bot sheet, a send and its reply. Run against a phone preview
// on a fixture (MADANI_MOBILE_PORT=5371 pnpm mobile:preview --fixture), never a live workspace:
//   node scripts/motion-lab/record-app.mjs http://127.0.0.1:5371/ <out dir> [push|sheet|reply]
// With --desktop, the desktop app (MADANI_PORT=<fixture harness port> MADANI_UI_PORT=5373 vite) at 1280 x 800: switching
// chats, the palette filtering and closing, a send and its reply.
// Headless Chrome cannot screenshot 60 times a second, so the page clocks (performance.now, Date, rAF, timers) and the
// document timeline run at RATE while frames are captured, stamped with page time, and resampled to 60 fps.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openChrome } from "./chrome.mjs";

const desktop = process.argv.includes("--desktop");
const [url, out, only] = process.argv.slice(2).filter((arg) => arg !== "--desktop");
const RATE = 0.1;
const [W, H, DSF] = desktop ? [1280, 800, 1.5] : [390, 844, 2];

const SHIM = `(() => {
  const rp = performance.now.bind(performance), rd = Date.now, rraf = requestAnimationFrame.bind(window), rst = setTimeout.bind(window), rsi = setInterval.bind(window);
  let rate = 1, r0 = rp(), v0 = r0; const p0 = r0, d0 = rd();
  const now = () => v0 + (rp() - r0) * rate;
  window.__setRate = (next) => { v0 = now(); r0 = rp(); rate = next; };
  performance.now = now;
  Date.now = () => d0 + (now() - p0);
  window.requestAnimationFrame = (cb) => rraf(() => cb(now()));
  window.setTimeout = (fn, ms = 0, ...a) => rst(fn, (ms || 0) / rate, ...a);
  window.setInterval = (fn, ms = 0, ...a) => rsi(fn, Math.max(4, (ms || 0) / rate), ...a);
})();`;

const c = await openChrome();
const clips = [];
try {
  await c.send("Page.enable");
  await c.send("Animation.enable");
  await c.send("Page.addScriptToEvaluateOnNewDocument", { source: SHIM });
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: DSF, mobile: !desktop });
  if (!desktop) await c.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await c.send("Page.navigate", { url });
  await delay(5000);
  const find = (expr) => c.evaluate(`(() => { const el = ${expr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  const tap = async (expr) => {
    const at = await find(expr);
    if (!at) throw new Error(`nothing to tap: ${expr}`);
    if (desktop) {
      await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
      await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1 });
      await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: 1 });
      return;
    }
    await c.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: at.x, y: at.y }] });
    await delay(60 / (c.rate ?? 1));
    await c.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  const key = async (name, code, keyCode, modifiers = 0) => {
    await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: name, code, windowsVirtualKeyCode: keyCode, modifiers });
    await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code, windowsVirtualKeyCode: keyCode, modifiers });
  };
  const button = (label) => `[...document.querySelectorAll("button")].find(b => b.getAttribute("aria-label") === ${JSON.stringify(label)} || b.textContent.trim() === ${JSON.stringify(label)})`;
  const row = (name) => `[...document.querySelectorAll("button[data-long-press]")].find(b => b.textContent.trim().startsWith(${JSON.stringify(name)}))`;
  const setRate = async (rate) => { c.rate = rate; await c.evaluate(`__setRate(${rate})`); await c.send("Animation.setPlaybackRate", { playbackRate: rate }); };

  /** steps: [{ at: page ms, run: async () => {} }]; records `length` page ms */
  async function record(name, length, steps) {
    const frames = join(out, `.app-${name}`);
    rmSync(frames, { recursive: true, force: true });
    mkdirSync(frames, { recursive: true });
    await setRate(RATE);
    const start = await c.evaluate("performance.now()");
    const shots = [];
    const pending = [...steps];
    for (;;) {
      const t = (await c.evaluate("performance.now()")) - start;
      while (pending.length && pending[0].at <= t) await pending.shift().run();
      if (t > length) break;
      const shot = await c.send("Page.captureScreenshot", { format: "png" });
      shots.push({ t, data: shot.data });
    }
    await setRate(1);
    const count = Math.round((length / 1000) * 60);
    for (let i = 0; i <= count; i++) {
      const want = (i * 1000) / 60;
      let best = shots[0];
      for (const s of shots) if (s.t <= want + 4) best = s;
      writeFileSync(join(frames, `${String(i).padStart(4, "0")}.png`), Buffer.from(best.data, "base64"));
    }
    const gaps = shots.slice(1).map((s, i) => s.t - shots[i].t);
    const file = `real-app-${name}.mp4`;
    const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "60", "-i", join(frames, "%04d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", "-movflags", "+faststart", join(out, file)], { stdio: ["ignore", "inherit", "inherit"] });
    if (r.status !== 0) throw new Error("ffmpeg failed");
    rmSync(frames, { recursive: true, force: true });
    console.log(`${file}: ${shots.length} captures, median step ${gaps.sort((a, b) => a - b)[gaps.length >> 1]?.toFixed(1)} ms page time`);
    clips.push(file);
  }

  if (desktop) {
    const side = (name) => `[...document.querySelectorAll("[data-sidebar-bot-row]")].find(r => r.textContent.trim().startsWith(${JSON.stringify(name)}))`;
    if (await find(`document.querySelector("[data-funnel-start]")`)) { await tap(`document.querySelector("[data-funnel-start]")`); await delay(3000); }
    if (!only || only === "switch") {
      await record("desktop-switch-chat", 2400, [
        { at: 250, run: () => tap(side("Echo")) },
        { at: 1300, run: () => tap(side("Juno")) },
      ]);
      await delay(1500);
    }
    if (!only || only === "palette") {
      await record("desktop-palette", 3000, [
        { at: 250, run: () => key("k", "KeyK", 75, 4) },
        { at: 1000, run: () => c.send("Input.insertText", { text: "ju" }) },
        { at: 2000, run: () => key("Escape", "Escape", 27) },
      ]);
      await delay(1500);
    }
    if (!only || only === "reply") {
      await tap(side("Basil")); await delay(2500);
      await tap(`document.querySelector("textarea")`); await delay(500);
      await c.send("Input.insertText", { text: "which of the three has the balcony?" });
      await delay(800);
      await record("desktop-send-and-reply", 4200, [{ at: 250, run: () => key("Enter", "Enter", 13) }]);
    }
  }
  if (!desktop && await find(button("Allow"))) { await tap(button("Allow")); await delay(2500); }

  if (!desktop && (!only || only === "push")) {
    await record("open-close-chat", 2600, [
      { at: 250, run: () => tap(row("Juno")) },
      { at: 1400, run: () => tap(button("Back")) },
    ]);
    await delay(2000);
  }
  if (!desktop && (!only || only === "sheet")) {
    await tap(row("Juno")); await delay(2500);
    await record("sheet", 2700, [
      { at: 250, run: () => tap(button("Open Juno's profile")) },
      { at: 1500, run: () => c.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }).then(() => c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })) },
    ]);
    await delay(1500);
    await tap(button("Back")); await delay(2000);
  }
  if (!desktop && (!only || only === "reply")) {
    await tap(row("Echo")); await delay(2500);
    await tap(`document.querySelector("textarea")`); await delay(500);
    await c.send("Input.insertText", { text: "what's left in the inbox?" });
    await delay(800);
    await record("send-and-reply", 4200, [
      { at: 250, run: () => tap(`[...document.querySelectorAll("button")].find(b => /^send/i.test(b.getAttribute("aria-label") || ""))`) },
    ]);
  }
} finally {
  await c.close();
}
console.log(clips.join("\n"));
