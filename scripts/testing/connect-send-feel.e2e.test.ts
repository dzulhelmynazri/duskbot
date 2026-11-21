// Headless frames of two feels: Send held grayed until the server has the message, then crossfading to the mic; and
// Connect an AI opening with nothing running, its panel growing in, each stage crossfading, Cancel folding it away.
// Frames go to MADANI_MOTION_SHOTS (default ~/Desktop/madani-motion-shots)/send and /connect.
//
//   MADANI_UI_E2E=1 pnpm exec vitest run scripts/testing/connect-send-feel.e2e.test.ts
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../control-madani.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { ensureUiBrowser } from "./control-madani-ui.ts";
import { fixtureApi, mountPreview, type MountedPreview } from "./preview-fixture.ts";
import { connect } from "./chat-gallery/cdp.ts";
import { NOTICES } from "../../src/lib/notices.ts";

const enabled = process.env.MADANI_UI_E2E === "1";
const SHOTS = process.env.MADANI_MOTION_SHOTS || join(homedir(), "Desktop", "madani-motion-shots");
const SEND_LAG = 900;

type SendRow = { t: number; send: boolean; disabled: boolean; ghost: boolean; mic: boolean; fill: string | null; arrow: number | null; userRows: number; posted: boolean };

(enabled ? it : it.skip)("holds Send until the message is in, and opens Connect an AI with nothing running", async () => {
  let fixture: VerificationServer | undefined;
  let preview: MountedPreview | undefined;
  let chrome: ChildProcess | undefined;
  let cdp: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    const tools = await ensureUiBrowser();
    if (!tools.chrome) throw new Error("needs the pinned Chrome for Testing");
    fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_REPLIES: JSON.stringify([["Sure."], ["Sure."]]) });
    const api = fixtureApi(fixture.info.url);
    await api("PATCH", "/api/config", { language: "en" });
    const { bots } = await api("GET", "/api/bots");
    for (const bot of bots.filter((bot: { defaultBot?: unknown }) => bot.defaultBot)) await api("PATCH", `/api/bots/${bot.id}`, { welcomed: true });
    preview = await mountPreview(fixture, { entry: "/scripts/testing/connect-send-feel-preview.tsx", route: "/__connect-send.html", title: "Feel", logLevel: "warn", hmr: false });
    const profile = join(fixture.info.dataDir, "chrome");
    mkdirSync(profile, { recursive: true });
    const mouse = "--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2";
    chrome = spawn(tools.chrome, ["--headless=new", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--password-store=basic", "--use-mock-keychain", "--hide-scrollbars", "--deny-permission-prompts", mouse, "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], {
      env: { PATH: process.env.PATH, HOME: fixture.info.dataDir, USERPROFILE: fixture.info.dataDir }, stdio: "ignore",
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
    const errors: string[] = [];
    let frames: Array<{ at: number; data: string }> | null = null;
    cdp.on((method, params) => {
      if (method === "Runtime.exceptionThrown") errors.push(params.exceptionDetails?.exception?.description?.split("\n")[0] ?? params.exceptionDetails?.text);
      if (method === "Page.screencastFrame") {
        frames?.push({ at: params.metadata.timestamp, data: params.data });
        void request("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => undefined);
      }
    });
    await request("Page.enable");
    await request("Runtime.enable");
    await request("Page.addScriptToEvaluateOnNewDocument", { source: `try { for (const notice of ${JSON.stringify(NOTICES)}) localStorage.setItem(notice, "1"); } catch {}` });
    const wait = (ms: number) => evaluate(`new Promise((done) => setTimeout(done, ${ms}))`);
    await request("Emulation.setDeviceMetricsOverride", { width: 900, height: 640, deviceScaleFactor: 1, mobile: false });
    /** Screencast frames while `act` runs and `ms` after, saved as <ms since start>.png under `dir`. */
    const film = async (dir: string, ms: number, act: () => Promise<unknown>) => {
      mkdirSync(dir, { recursive: true });
      frames = [];
      await request("Page.startScreencast", { format: "png", everyNthFrame: 1 });
      const started = Date.now() / 1000;
      const result = await act();
      await wait(ms);
      await request("Page.stopScreencast");
      for (const frame of frames) writeFileSync(join(dir, `${String(Math.max(0, Math.round((frame.at - started) * 1000))).padStart(5, "0")}.png`), Buffer.from(frame.data, "base64"));
      frames = null;
      return result;
    };

    // Send: press Enter with the POST held, every frame until the message is in and the mic is back
    await request("Page.navigate", { url: `${preview.previewUrl}?view=send&skin=grok&sendlag=${SEND_LAG}` });
    await expect.poll(() => evaluate(`Boolean(document.querySelector('textarea'))`), { timeout: 60_000, interval: 300 }).toBe(true);
    await evaluate(`document.fonts.ready`);
    await wait(500);
    await evaluate(`(() => { const f = document.querySelector('textarea'); f.focus(); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(f, 'Hello there'); f.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await wait(300);
    await evaluate(`window.__sendRun = new Promise((done) => {
      const rows = [];
      const start = performance.now();
      const tick = (now) => {
        const send = document.querySelector('[data-composer-send]');
        rows.push({
          t: Math.round(now - start), send: Boolean(send), disabled: Boolean(send?.disabled),
          ghost: Boolean(document.querySelector('[data-composer-glyph-ghost]')),
          mic: Boolean(document.querySelector('[data-voice-mic] .composer-glyph')),
          fill: (() => { const slot = document.querySelector('[data-voice-mic] .composer-glyph')?.closest('button') ?? document.querySelector('[data-composer-send]'); return slot ? getComputedStyle(slot).backgroundColor : null; })(),
          arrow: (() => { const out = document.querySelector('[data-composer-glyph-ghost] .composer-glyph-out'); return out ? +getComputedStyle(out).opacity : null; })(),
          userRows: document.querySelectorAll('[data-message-row]').length,
          posted: performance.getEntriesByType('resource').some((entry) => /\\/api\\/bots\\/[^/]+\\/messages$/.test(entry.name) && entry.startTime >= start - 50),
        });
        if (now - start < ${SEND_LAG + 1100}) requestAnimationFrame(tick); else done(rows);
      };
      requestAnimationFrame(tick);
    }); true`);
    const sendRows = await film(join(SHOTS, "send"), 0, async () => {
      await request("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
      await request("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      return evaluate(`window.__sendRun`);
    }) as SendRow[];
    writeFileSync(join(SHOTS, "send", "track.json"), JSON.stringify(sendRows, null, 1));
    const firstDisabled = sendRows.find((row) => row.disabled)?.t ?? null;
    const released = sendRows.find((row, index) => index > 0 && !row.send)?.t ?? null;
    const ghost = sendRows.find((row) => row.ghost)?.t ?? null;
    console.log(JSON.stringify({ firstDisabled, released, ghost }));
    expect(firstDisabled, "Send grays within a frame or two of the press").not.toBeNull();
    expect(firstDisabled!).toBeLessThanOrEqual(50);
    expect(released, "Send stays until the held POST answers").not.toBeNull();
    expect(released!).toBeGreaterThanOrEqual(SEND_LAG - 50);
    expect(sendRows.filter((row) => row.t < released!).every((row) => row.send && row.disabled || row.t < 50)).toBe(true);
    expect(ghost, "the arrow fades out over the mic").not.toBeNull();
    expect(ghost!).toBeGreaterThanOrEqual(released! - 20);

    // Connect an AI
    const connectDir = join(SHOTS, "connect");
    await request("Page.navigate", { url: `${preview.previewUrl}?view=connect&skin=grok` });
    await expect.poll(() => evaluate(`typeof window.__open === "function"`), { timeout: 60_000, interval: 300 }).toBe(true);
    await evaluate(`document.fonts.ready`);
    await wait(500);
    await film(join(connectDir, "01-dialog-open"), 450, () => evaluate(`window.__open(true), true`));
    await expect.poll(() => evaluate(`Boolean(document.querySelector('[data-connect-ai] button[data-funnel-ai]'))`), { timeout: 10_000 }).toBe(true);
    const opened = await evaluate(`({
      pressed: [...document.querySelectorAll('[data-connect-ai] button[data-funnel-ai]')].map((card) => card.getAttribute('aria-pressed')),
      panel: Boolean(document.querySelector('[data-connect-ai] [data-funnel-ai-connect]')),
      stage: document.querySelector('[data-connect-ai] [data-connect-stage]')?.getAttribute('data-connect-stage') ?? null,
    })`) as { pressed: string[]; panel: boolean; stage: string | null };
    expect(opened.pressed.every((value) => value === "false"), "no card pressed on open").toBe(true);
    expect(opened.panel, "no connect running on open").toBe(false);
    expect(opened.stage).toBeNull();
    await film(join(connectDir, "02-dialog-close"), 300, () => evaluate(`document.querySelector('[data-connect-ai] button[aria-label="Close"]').click(), true`));
    expect(await evaluate(`Boolean(document.querySelector('[data-connect-ai]'))`)).toBe(false);

    const steps: Array<[string, string | null]> = [
      ["03-panel-grow-preparing", "preparing"], ["04-stage-opening", "opening"], ["05-stage-code", "waiting"],
      ["06-stage-paste", "paste"], ["07-stage-connected", "connected"], ["08-stage-failed", "failed"], ["09-cancel-fold", null],
    ];
    const heights: Record<string, number[]> = {};
    const shown: Record<string, string[]> = {};
    for (const [name, stage] of steps) {
      // sampled from the stage change on, every frame: the panel's height and how far the inner box is from its content
      await film(join(connectDir, name), 450, () => evaluate(`window.__heights = []; window.__stage(${JSON.stringify(stage)}); (function tick() { window.__heights.push(document.querySelector('[data-panel-demo]').getBoundingClientRect().height); window.__shown = window.__shown || []; window.__shown.push([...document.querySelectorAll('[data-panel-demo] .connect-stage-out, [data-panel-demo] .connect-stage-in')].map((node) => (node.classList.contains('connect-stage-out') ? 'out' : 'in') + (+getComputedStyle(node).opacity).toFixed(2)).join(' ')); if (window.__heights.length < 30) requestAnimationFrame(tick); })(); true`));
      heights[name] = await evaluate(`window.__heights.map((h) => Math.round(h))`) as number[];
      shown[name] = await evaluate(`(window.__shown || []).splice(0)`) as string[];
    }
    writeFileSync(join(connectDir, "heights.json"), JSON.stringify(heights, null, 1));
    writeFileSync(join(connectDir, "stages.json"), JSON.stringify(shown, null, 1));
    // the box eases between heights: no frame-to-frame jump of more than half the change
    for (const [name, values] of Object.entries(heights)) {
      const change = Math.abs(values.at(-1)! - values[0]!);
      if (change < 8) continue;
      const biggest = Math.max(...values.slice(1).map((value, index) => Math.abs(value - values[index]!)));
      expect(biggest, `${name} eases its height`).toBeLessThan(change * 0.6);
    }
    // each swap is a crossfade: the old stage is fully there on its first frame and fades as the new one comes in
    for (const [name, frames] of Object.entries(shown)) {
      const first = frames.find((frame) => frame.includes("out"));
      if (first) {
        expect(first, `${name} keeps the old stage on screen as it starts to fade`).toMatch(/out1\.00/);
        expect(first, `${name}: nothing inside the old stage starts hidden`).not.toMatch(/out1\.00 in0/);
      }
    }
    expect(errors).toEqual([]);
  } finally {
    cdp?.close();
    if (chrome && chrome.exitCode === null) { chrome.kill(); await waitForExit(chrome).catch(() => undefined); }
    await preview?.close();
    await fixture?.close();
  }
}, 240_000);
