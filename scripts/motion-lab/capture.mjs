// Frame-by-frame capture for the motion labs: bundles an entry, opens it in headless Chrome (MADANI_CDP_CHROME, else the
// installed Google Chrome, in a throwaway profile), seeks every animation to each 60 fps frame and encodes mp4s with
// ffmpeg from PATH.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const CHROME = process.env.MADANI_CDP_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const FPS = 60;

/** Writes `<out>/live.html` from `entry` and records each job ({ query, file, scale }) into `<out>/<file>`. */
export async function recordClips(out, entry, jobs) {
  mkdirSync(out, { recursive: true });
  const bundle = await build({ entryPoints: [entry], bundle: true, write: false, format: "iife", platform: "browser", target: "chrome120", define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error" });
  const live = join(out, "live.html");
  writeFileSync(live, `<!doctype html><meta charset="utf-8"><title>motion lab</title><body><script>${bundle.outputFiles[0].text.replace(/<\/script/g, "<\\/script")}</script>`);

  const profile = mkdtempSync(join(tmpdir(), "motion-lab-"));
  const chrome = spawn(CHROME, ["--headless=new", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "--use-mock-keychain", "--password-store=basic",
    "--allow-file-access-from-files", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], { stdio: "ignore" });
  const done = [];
  try {
    let port = "";
    for (let i = 0; i < 100 && !port; i++) {
      await delay(100);
      try { port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0].trim(); } catch {}
    }
    if (!port) throw new Error("Chrome did not start");
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const socket = new WebSocket(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
    await new Promise((resolve, fail) => { socket.onopen = resolve; socket.onerror = fail; });
    let next = 0;
    const waiting = new Map();
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      const call = waiting.get(message.id);
      if (!call) return;
      waiting.delete(message.id);
      if (message.error) call.fail(new Error(message.error.message)); else call.resolve(message.result);
    };
    const send = (method, params = {}) => new Promise((resolve, fail) => {
      const id = ++next;
      waiting.set(id, { resolve, fail });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result?.value;
    };
    await send("Page.enable");

    for (const { query, file, scale } of jobs) {
      await send("Emulation.setDeviceMetricsOverride", { width: 2400, height: 1100, deviceScaleFactor: scale, mobile: false });
      await send("Page.navigate", { url: `${pathToFileURL(live).href}?${query}&capture=1` });
      let lab = null;
      for (let i = 0; i < 100 && !lab; i++) { await delay(50); lab = await evaluate("window.lab && { duration: lab.duration, width: lab.width, height: lab.height }").catch(() => null); }
      if (!lab) throw new Error(`${query} never mounted`);
      await send("Emulation.setDeviceMetricsOverride", { width: lab.width, height: lab.height, deviceScaleFactor: scale, mobile: false });
      const frames = join(out, `.frames-${file}`);
      rmSync(frames, { recursive: true, force: true });
      mkdirSync(frames);
      const count = Math.ceil((lab.duration / 1000) * FPS);
      for (let i = 0; i <= count; i++) {
        await evaluate(`lab.seek(${(i * 1000) / FPS})`);
        const shot = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: lab.width, height: lab.height, scale: 1 } });
        writeFileSync(join(frames, `${String(i).padStart(4, "0")}.png`), Buffer.from(shot.data, "base64"));
      }
      const encoded = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", join(frames, "%04d.png"),
        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", "-preset", "slow", "-movflags", "+faststart", join(out, file)], { stdio: ["ignore", "inherit", "inherit"] });
      if (encoded.status !== 0) throw new Error(`ffmpeg failed on ${file}`);
      rmSync(frames, { recursive: true, force: true });
      done.push({ file, frames: count + 1, duration: Math.round(lab.duration) });
      console.log(`${file}: ${count + 1} frames, ${Math.round(lab.duration)} ms`);
    }
    socket.close();
  } finally {
    const exited = new Promise((resolve) => chrome.once("exit", resolve));
    chrome.kill();
    await exited;
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  return done;
}
