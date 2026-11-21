// The model menu's pill pair, headless, frame by frame: a pick slides the fill across in about 200ms (in between
// positions, never a jump), the words' ink crossfades, a quick second pick retargets mid-slide, and the app's
// reduced-motion switch makes the fill jump. Frames go to MADANI_UI_EVIDENCE_DIR/sliding-pills.
//
//   MADANI_UI_E2E=1 pnpm exec vitest run scripts/testing/sliding-pills.e2e.test.ts
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { ensureUiBrowser } from "./control-madani-ui.ts";
import { mountPreview, REPO_ROOT, type MountedPreview } from "./preview-fixture.ts";
import { connect } from "./chat-gallery/cdp.ts";

const enabled = process.env.MADANI_UI_E2E === "1";
type Row = { t: number; x: number; ink: string };

(enabled ? it : it.skip)("slides the picked fill instead of jumping", async () => {
  let preview: MountedPreview | undefined;
  let chrome: ChildProcess | undefined;
  let cdp: Awaited<ReturnType<typeof connect>> | undefined;
  const evidence = join(process.env.MADANI_UI_EVIDENCE_DIR || join(REPO_ROOT, ".madani-scratch", "verify-evidence"), "sliding-pills");
  mkdirSync(evidence, { recursive: true });
  try {
    const tools = await ensureUiBrowser();
    if (!tools.chrome) throw new Error("needs the pinned Chrome for Testing");
    // no server behind this page: nothing on it calls /api
    preview = await mountPreview({ info: { url: "http://127.0.0.1:9" } }, { entry: "/scripts/testing/sliding-pills-preview.tsx", route: "/__sliding-pills.html", title: "Pills", logLevel: "warn", hmr: false });
    const profile = mkdtempSync(join(tmpdir(), "madani-pills-chrome-"));
    chrome = spawn(tools.chrome, ["--headless=new", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--password-store=basic", "--use-mock-keychain", "--hide-scrollbars", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], {
      env: { PATH: process.env.PATH, HOME: profile, USERPROFILE: profile }, stdio: "ignore",
    });
    const portFile = join(profile, "DevToolsActivePort");
    await expect.poll(() => existsSync(portFile), { timeout: 30_000 }).toBe(true);
    const [port, endpoint] = readFileSync(portFile, "utf8").trim().split("\n");
    cdp = await connect(`ws://127.0.0.1:${port}${endpoint}`);
    const target = await cdp.request("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.request("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const request = (method: string, params: unknown = {}) => cdp!.request(method, params, sessionId);
    const evaluate = async (expression: string) => {
      const response = await request("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
      return response.result.value;
    };
    let frames: Array<{ at: number; data: string }> | null = null;
    cdp.on((method, params) => {
      if (method !== "Page.screencastFrame") return;
      frames?.push({ at: params.metadata.timestamp, data: params.data });
      void request("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => undefined);
    });
    await request("Page.enable");
    await request("Emulation.setDeviceMetricsOverride", { width: 420, height: 220, deviceScaleFactor: 2, mobile: false });
    const click = async (selector: string) => {
      const p = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      await request("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y });
      await request("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 1 });
      await request("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 1 });
    };
    // the thumb's x and the "All bots" ink every frame for `ms`
    const track = (ms: number) => evaluate(`new Promise((done) => {
      const rows = []; const start = performance.now();
      const thumb = document.querySelector("[data-picker-scope] [data-segmented-pill]"), all = document.querySelector('[data-scope-pill="all"]');
      const tick = (now) => {
        rows.push({ t: Math.round(now - start), x: +thumb.getBoundingClientRect().x.toFixed(1), ink: getComputedStyle(all).color });
        if (now - start < ${ms}) requestAnimationFrame(tick); else done(rows);
      };
      requestAnimationFrame(tick);
    })`) as Promise<Row[]>;
    const flow = async (name: string, query: string, act: () => Promise<unknown>) => {
      await request("Page.navigate", { url: `${preview!.previewUrl}${query}` });
      await expect.poll(() => evaluate(`Boolean(document.querySelector("[data-picker-scope]"))`), { timeout: 60_000, interval: 200 }).toBe(true);
      await evaluate(`document.fonts.ready.then(() => new Promise((done) => setTimeout(done, 300)))`);
      frames = [];
      await request("Page.startScreencast", { format: "png", everyNthFrame: 1 });
      const started = Date.now() / 1000;
      const tracked = track(450);
      await act();
      const rows = await tracked;
      await request("Page.stopScreencast");
      const dir = join(evidence, name);
      mkdirSync(dir, { recursive: true });
      for (const frame of frames) writeFileSync(join(dir, `${String(Math.max(0, Math.round((frame.at - started) * 1000))).padStart(5, "0")}.png`), Buffer.from(frame.data, "base64"));
      frames = null;
      writeFileSync(join(dir, "track.json"), JSON.stringify(rows, null, 1));
      return rows;
    };

    const slide = await flow("01-this-to-all", "", () => click('[data-scope-pill="all"]'));
    const back = await flow("02-retarget", "", async () => { await click('[data-scope-pill="all"]'); await evaluate(`new Promise((done) => setTimeout(done, 70))`); await click('[data-scope-pill="bot"]'); });
    const reduced = await flow("03-reduced", "?reduced", () => click('[data-scope-pill="all"]'));

    const xs = (rows: Row[]) => [...new Set(rows.map((row) => row.x))];
    const from = slide[0]!.x, to = slide.at(-1)!.x;
    expect(to).toBeGreaterThan(from);
    // it passes through in-between places, and is home by about 200ms
    expect(xs(slide).filter((x) => x > from && x < to).length).toBeGreaterThanOrEqual(3);
    expect(slide.find((row) => Math.abs(row.x - to) < 0.5)!.t).toBeLessThanOrEqual(260);
    // the ink crossfades through in-between colours too
    expect(new Set(slide.map((row) => row.ink)).size).toBeGreaterThan(2);
    // a second pick mid-slide turns it around from where it is, never past the far pill
    expect(Math.max(...back.map((row) => row.x))).toBeLessThan(to);
    expect(back.at(-1)!.x).toBe(from);
    // the app's reduced-motion switch: the fill jumps straight there
    expect(xs(reduced).filter((x) => x > from && x < to)).toEqual([]);
  } finally {
    cdp?.close();
    if (chrome && chrome.exitCode === null) { chrome.kill(); await waitForExit(chrome).catch(() => undefined); }
    await preview?.close();
  }
}, 180_000);
