// Stop, headless, frame by frame, against the real server and the fake Claude streaming a reply: how long from the
// press to the button giving way, the working line leaving and the chat holding still, and whether any word of the
// stopped turn lands after the press. ?lag holds the Stop on its way out as the owner's app answered (about 400 ms).
// Evidence (frames, track.json, report.json) goes to MADANI_UI_EVIDENCE_DIR/stop-feel.
//
//   MADANI_UI_E2E=1 pnpm exec vitest run scripts/testing/stop-feel.e2e.test.ts
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../control-madani.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { ensureUiBrowser } from "./control-madani-ui.ts";
import { fixtureApi, mountPreview, REPO_ROOT, type MountedPreview } from "./preview-fixture.ts";
import { connect } from "./chat-gallery/cdp.ts";
import { NOTICES } from "../../src/lib/notices.ts";

const enabled = process.env.MADANI_UI_E2E === "1";
if (!enabled) console.log("skipping the stop check: set MADANI_UI_E2E=1 for isolated browser qualification");

const PARTS = [
  "Cheese begins as milk, warm from the morning, and a little culture to wake it up.",
  "Then rennet sets it, the curd is cut, and the whey runs off like a quiet river through the cloth while the cheesemaker waits.",
  "Pressed into moulds, salted and turned each day, it rests in a cool cave for months while the rind grows and the flavour deepens slowly.",
  "By winter the wheel is ready, sharp and nutty, and it was worth every one of those long patient days.",
];
const STOP = 'button[aria-label="Stop this turn"]';

type Row = { t: number; stop: boolean; ghost: boolean; presence: number | null; leaving: boolean; botRows: number; botText: number; marker: boolean };
type Run = { rows: Row[]; serverIdle: number | null; interruptMs: number | null };

(enabled ? it : it.skip)("stops at once and lets nothing of the stopped turn in after", async () => {
  let fixture: VerificationServer | undefined;
  let preview: MountedPreview | undefined;
  let chrome: ChildProcess | undefined;
  let cdp: Awaited<ReturnType<typeof connect>> | undefined;
  const label = process.env.MADANI_STOP_LABEL ?? "run";
  const evidence = join(process.env.MADANI_UI_EVIDENCE_DIR || join(REPO_ROOT, ".madani-scratch", "verify-evidence"), "stop-feel", label);
  mkdirSync(evidence, { recursive: true });
  const report: Record<string, unknown> = {};
  try {
    const tools = await ensureUiBrowser();
    if (!tools.chrome) throw new Error("needs the pinned Chrome for Testing");
    fixture = await launchVerificationServer({
      ...process.env,
      FAKE_CLAUDE_REPLIES: JSON.stringify([PARTS, PARTS, PARTS]),
      FAKE_CLAUDE_STREAM_CADENCE: "3:30",
    });
    const api = fixtureApi(fixture.info.url);
    await api("PATCH", "/api/config", { language: "en" });
    const { bots } = await api("GET", "/api/bots");
    for (const bot of bots.filter((bot: { defaultBot?: unknown }) => bot.defaultBot)) await api("PATCH", `/api/bots/${bot.id}`, { welcomed: true });
    preview = await mountPreview(fixture, { entry: "/scripts/testing/stop-feel-preview.tsx", route: "/__stop-feel.html", title: "Stop", logLevel: "warn", hmr: false });
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

    const center = (selector: string) => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    const click = async (point: { x: number; y: number }) => {
      await request("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
      await request("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
      await request("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
    };
    const send = async (text: string) => {
      await evaluate(`(() => { const f = document.querySelector('textarea'); f.focus(); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(f, ${JSON.stringify(text)}); f.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      await wait(150);
      await request("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
      await request("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    };
    // every frame from the press: the Stop button, Send, the working line and the bot's rows
    // and, beside it, when the server says the bot is idle and how long the Stop call itself took
    const probe = `window.__stopRun = new Promise((done) => {
      const rows = [];
      let serverIdle = null;
      document.addEventListener("pointerdown", (event) => {
        if (!event.target.closest(${JSON.stringify(STOP)})) return;
        const start = performance.now();
        const poll = async () => {
          const { bots } = await (await fetch("/api/bots?messages=0")).json();
          if (!bots.some((bot) => bot.busy)) serverIdle = Math.round(performance.now() - start);
          else if (performance.now() - start < 2500) setTimeout(poll, 20);
        };
        void poll();
        const tick = (now) => {
          const presence = document.querySelector(".turn-presence > div");
          const bots = [...document.querySelectorAll("[data-message-row].items-start")];
          rows.push({
            t: Math.round(now - start),
            stop: Boolean(document.querySelector(${JSON.stringify(STOP)})),
            ghost: Boolean(document.querySelector("[data-composer-glyph-ghost]")),
            presence: presence ? +getComputedStyle(presence).opacity : null,
            leaving: Boolean(presence?.classList.contains("turn-status-out")),
            botRows: bots.length,
            botText: bots.reduce((sum, row) => sum + (row.textContent ?? "").length, 0),
            marker: Boolean(document.querySelector("[data-turn-stopped]")),
          });
          if (now - start < 2500) requestAnimationFrame(tick);
          else done({ rows, serverIdle, interruptMs: Math.round(performance.getEntriesByType("resource").findLast((entry) => entry.name.endsWith("/interrupt"))?.duration ?? -1) });
        };
        tick(start);
      }, { capture: true, once: true });
    }); true`;

    const run = async (name: string, lag: number) => {
      await request("Page.navigate", { url: `${preview!.previewUrl}?skin=grok&lag=${lag}` });
      await expect.poll(() => evaluate(`Boolean(document.querySelector('textarea'))`), { timeout: 60_000, interval: 300 }).toBe(true);
      await evaluate(`document.fonts.ready`);
      await wait(500);
      const before = await evaluate(`document.querySelectorAll("[data-message-row].items-start").length`) as number;
      await send(`Tell me how cheese is made (${name})`);
      // this turn's second bubble is streaming: one landed, the next one is on its way
      await expect.poll(() => evaluate(`document.querySelectorAll("[data-message-row].items-start").length`), { timeout: 30_000, interval: 50 }).toBeGreaterThanOrEqual(before + 2);
      await expect.poll(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(STOP)}))`), { timeout: 10_000, interval: 50 }).toBe(true);
      await wait(700);
      await evaluate(probe);
      frames = [];
      await request("Page.startScreencast", { format: "png", everyNthFrame: 1 });
      const started = Date.now() / 1000;
      await click(await center(STOP));
      const { rows: track, serverIdle, interruptMs } = (await evaluate(`window.__stopRun`)) as Run;
      await request("Page.stopScreencast");
      const dir = join(evidence, name);
      mkdirSync(dir, { recursive: true });
      for (const frame of frames) writeFileSync(join(dir, `${String(Math.max(0, Math.round((frame.at - started) * 1000))).padStart(5, "0")}.png`), Buffer.from(frame.data, "base64"));
      frames = null;
      writeFileSync(join(dir, "track.json"), JSON.stringify(track, null, 1));
      const first = (test: (row: Row) => boolean) => track.find(test)?.t ?? null;
      const atPress = track[0]!;
      const textAfter = Math.max(...track.map((row) => row.botText));
      const summary = {
        buttonGone: first((row) => !row.stop),
        crossfade: first((row) => row.ghost),
        lineLeaving: first((row) => row.leaving || row.presence === null),
        lineGone: first((row) => row.presence === null),
        rowsAtPress: atPress.botRows,
        rowsAfter: Math.max(...track.map((row) => row.botRows)),
        textAtPress: atPress.botText,
        textAfter,
        // the words streamed by the press settle once, at the press; nothing may grow after that
        settled: track.find((row) => row.botText !== atPress.botText)?.t ?? null,
        lateText: (() => {
          const settle = track.find((row) => row.botText !== atPress.botText);
          if (!settle) return null;
          return track.find((row) => row.t > settle.t && row.botText !== settle.botText)?.t ?? (settle.t > 50 ? settle.t : null);
        })(),
        marker: first((row) => row.marker),
        serverIdle,
        interruptMs,
      };
      // what the server kept is what the chat shows: the words before the press and the half answer that settled
      const { bots: after } = await api("GET", "/api/bots?messages=200");
      const kept = after.find((bot: { hidden?: boolean }) => !bot.hidden).messages.filter((message: { role: string; kind: string; text?: string }) => message.role === "bot" && message.kind === "text" && message.text?.trim()).length;
      const texts = after.find((bot: { hidden?: boolean }) => !bot.hidden).messages.filter((message: { role: string; kind: string; text?: string }) => message.role === "bot" && message.kind === "text" && message.text?.trim());
      const shownLast = await evaluate(`[...document.querySelectorAll("[data-message-row].items-start")].at(-1)?.textContent ?? ""`) as string;
      const domRows = await evaluate(`[...document.querySelectorAll("[data-message-row].items-start")].map((row) => row.textContent)`) as string[];
      writeFileSync(join(dir, "rows.json"), JSON.stringify({ server: after.find((bot: { hidden?: boolean }) => !bot.hidden).messages.map((m: { role: string; kind: string; text?: string; tool?: { name: string }; turnId?: string }) => [m.role, m.kind, m.turnId, m.text ?? m.tool?.name]), shown: domRows }, null, 1));
      const full = { ...summary, serverRows: kept, sameLastWords: shownLast.replace(/\s+/g, " ").includes(String(texts.at(-1)?.text ?? "").replace(/\s+/g, " ").trim()) };
      report[name] = full;
      return full;
    };

    const local = await run("01-stop-local", 0);
    const lagged = await run("02-stop-400ms", 400);
    report.errors = errors;
    writeFileSync(join(evidence, "report.json"), JSON.stringify(report, null, 1));
    console.log(JSON.stringify(report, null, 1));
    for (const summary of [local, lagged]) {
      expect(summary.buttonGone, "the Stop button gives way within a frame or two").not.toBeNull();
      expect(summary.buttonGone!).toBeLessThanOrEqual(50);
      expect(summary.lineLeaving).not.toBeNull();
      expect(summary.lineLeaving!).toBeLessThanOrEqual(50);
      expect(summary.lateText, "no word of the stopped turn lands after the press").toBeNull();
    }
    for (const summary of [local, lagged]) {
      expect(summary.serverRows, "the server kept what the chat shows, nothing later").toBe(summary.rowsAfter);
      expect(summary.sameLastWords, "the kept half answer is the one the chat settled").toBe(true);
    }
    expect(errors).toEqual([]);
  } finally {
    cdp?.close();
    if (chrome && chrome.exitCode === null) { chrome.kill(); await waitForExit(chrome).catch(() => undefined); }
    await preview?.close();
    await fixture?.close();
  }
}, 240_000);
