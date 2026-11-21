// The composer and a chat link's hover card, headless, frame by frame: typing (the mic gives the round button to Send),
// clearing, the @ and / menus, voice input's strip, the voice first-run sheet opening and closing, and a link's card
// opening, closing and coming back mid-close. Each flow records every animation frame's boxes and animated styles,
// a screencast of its frames and the page's layout shifts. Nothing in the chat or the composer may move or resize
// unless the flow itself asks it to, and the mic's swap lands at once.
// Evidence goes to MADANI_UI_EVIDENCE_DIR/smoothness (default .madani-scratch/verify-evidence/smoothness).
//
//   MADANI_UI_E2E=1 pnpm exec vitest run scripts/testing/smoothness.e2e.test.ts
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
if (!enabled) console.log("skipping the smoothness check: set MADANI_UI_E2E=1 for isolated browser qualification");

type Box = { laid: string; x: number; y: number; w: number; h: number; opacity: string; transform: string; bg: string } | null;
type Frame = { t: number } & Record<string, Box | number>;

// "chat" is the first link in the transcript: if anything above the composer is pushed, it moves
const COMPOSER = { pill: ".composer-pill", row: "[data-composer-row]", mic: "[data-voice-mic]", send: "[data-composer-send]", dock: "[data-grok-inset]", chat: "a.chat-link" };

(enabled ? it : it.skip)("keeps the composer and the chat still and the overlays smooth", async () => {
  let fixture: VerificationServer | undefined;
  let preview: MountedPreview | undefined;
  let chrome: ChildProcess | undefined;
  let cdp: Awaited<ReturnType<typeof connect>> | undefined;
  const evidence = join(process.env.MADANI_UI_EVIDENCE_DIR || join(REPO_ROOT, ".madani-scratch", "verify-evidence"), "smoothness", process.env.MADANI_SMOOTH_LABEL ?? "run");
  mkdirSync(evidence, { recursive: true });
  const report: Record<string, unknown> = {};
  try {
    const tools = await ensureUiBrowser();
    if (!tools.chrome) throw new Error("needs the pinned Chrome for Testing");
    fixture = await launchVerificationServer(process.env);
    const api = fixtureApi(fixture.info.url);
    await api("PATCH", "/api/config", { language: "en" });
    const { bots } = await api("GET", "/api/bots");
    for (const bot of bots.filter((bot: { defaultBot?: unknown }) => bot.defaultBot)) await api("PATCH", `/api/bots/${bot.id}`, { welcomed: true });
    // the page a link points at answers from another host after a redirect
    const answer = (url: string) => JSON.stringify({ preview: {
      url: url.includes("example.com") ? "https://tracker.example.net/landing?from=chat" : url,
      title: "Getting started", description: "Install it, sign in, and send your first message.", siteName: null, image: null, video: false,
    } });
    preview = await mountPreview(fixture, {
      entry: "/scripts/testing/smoothness-preview.tsx", route: "/__smoothness.html", title: "Smoothness", logLevel: "warn", hmr: false,
      extraRoutes: [{ path: "/api/link-preview", method: "GET", handler: (req, res) => {
        const url = new URL(req.url ?? "", "http://x").searchParams.get("url") ?? "";
        res.setHeader("content-type", "application/json");
        setTimeout(() => res.end(answer(url)), 60);
      } }],
    });
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
    const open = async (query: string, width = 900, height = 560) => {
      await request("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await request("Page.navigate", { url: `${preview!.previewUrl}?${query}` });
      await expect.poll(() => evaluate(`Boolean(document.querySelector('button[aria-label="Start dictation"]'))`), { timeout: 60_000, interval: 300 }).toBe(true);
      await evaluate(`document.fonts.ready`);
      await wait(400);
    };
    const center = (selector: string) => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    const moveTo = (point: { x: number; y: number }) => request("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    /** Track `spec` on every frame and screencast the page while `act` runs, for `ms`. */
    const flow = async (name: string, spec: Record<string, string>, ms: number, act: () => Promise<unknown>) => {
      await evaluate(`window.__shifts.length = 0`);
      frames = [];
      await request("Page.startScreencast", { format: "png", everyNthFrame: 1 });
      await evaluate(`window.__run = window.__track(${JSON.stringify(spec)}, ${ms}); true`);
      const started = Date.now() / 1000;
      await act();
      const track = (await evaluate(`window.__run`)) as Frame[];
      await wait(120);
      await request("Page.stopScreencast");
      const dir = join(evidence, name);
      mkdirSync(dir, { recursive: true });
      for (const frame of frames) writeFileSync(join(dir, `${String(Math.max(0, Math.round((frame.at - started) * 1000))).padStart(5, "0")}.png`), Buffer.from(frame.data, "base64"));
      frames = null;
      const shifts = await evaluate(`window.__shifts.slice()`);
      report[name] = { track, shifts };
      writeFileSync(join(dir, "track.json"), JSON.stringify({ track, shifts }, null, 1));
      return { track, shifts: shifts as Array<{ value: number; input: boolean; sources: string[] }> };
    };
    /** Every frame's box for `key`, as the set of distinct (x, y, w, h). */
    const boxes = (track: Frame[], key: string) => [...new Set(track.map((row) => { const box = row[key] as Box; return box ? `${box.x},${box.y},${box.w},${box.h}` : "none"; }))];
    /** A keystroke as a person makes it, so the page counts it as input. */
    const press = async (key: string, text?: string, code = key) => {
      await request("Input.dispatchKeyEvent", { type: "keyDown", key, code, ...(text ? { text, unmodifiedText: text } : { windowsVirtualKeyCode: key === "Backspace" ? 8 : 0 }) });
      await request("Input.dispatchKeyEvent", { type: "keyUp", key, code });
    };
    const focusField = () => evaluate(`document.querySelector('textarea').focus(); true`);

    // typing: the round button becomes Send, the mic steps aside at once, nothing grows
    await open("skin=grok");
    await focusField();
    const typing = await flow("01-typing", COMPOSER, 500, () => press("h", "h", "KeyH"));
    const clearing = await flow("02-clearing", COMPOSER, 500, () => press("Backspace"));
    const mention = await flow("03-mention-menu", COMPOSER, 400, () => press("@", "@", "Digit2"));
    await evaluate(`(() => { const f = document.querySelector('textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(f, ''); f.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await wait(400);
    const slash = await flow("04-slash-menu", COMPOSER, 400, () => press("/", "/", "Slash"));
    await evaluate(`(() => { const f = document.querySelector('textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(f, ''); f.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await wait(400);
    const voice = await flow("05-voice-strip", COMPOSER, 500, () => evaluate(`document.querySelector('[data-voice-mic]').click(); true`));
    const voiceStop = await flow("06-voice-strip-done", COMPOSER, 500, () => evaluate(`document.querySelector('[data-voice-mic]').click(); true`));

    // the voice first-run sheet: in and out with the dialog motion, the chat behind it still
    await open("skin=grok&firstRun=1");
    const SHEET = { ...COMPOSER, sheet: '[data-panel-modal="voice-first-run"]', scrim: "[data-modal-scrim]" };
    const sheetOpen = await flow("07-first-run-open", SHEET, 450, () => evaluate(`document.querySelector('[data-voice-mic]').click(); true`));
    const sheetGeometry = await evaluate(`(() => {
      const sheet = document.querySelector('[data-panel-modal="voice-first-run"]');
      const box = (n) => n.getBoundingClientRect();
      const title = sheet.querySelector('h2'), body = sheet.querySelector('p'), close = sheet.querySelector('header button');
      const setUp = sheet.querySelector('[data-voice-setup]'), go = sheet.querySelector('[data-autofocus]');
      return { sheet: box(sheet).toJSON(), title: box(title).toJSON(), close: box(close).toJSON(), body: box(body).toJSON(), setUp: box(setUp).toJSON(), go: box(go).toJSON() };
    })()`);
    report.sheetGeometry = sheetGeometry;
    const { data: sheetShot } = await request("Page.captureScreenshot", { format: "png", clip: { x: sheetGeometry.sheet.x - 16, y: sheetGeometry.sheet.y - 16, width: sheetGeometry.sheet.width + 32, height: sheetGeometry.sheet.height + 32, scale: 2 } });
    writeFileSync(join(evidence, "voice-first-run-sheet.png"), Buffer.from(sheetShot, "base64"));
    const sheetClose = await flow("08-first-run-close", SHEET, 450, () => evaluate(`document.querySelector('[data-voice-setup]').closest('[role=dialog]').querySelector('[data-autofocus]').click(); true`));
    await evaluate(`document.querySelector('[data-voice-mic]').click(); true`);
    await wait(300);

    // a link's card: open, close, and back while it closes
    await open("skin=grok");
    const CARD = { card: "[data-link-preview]", inner: "[data-link-preview] > div", chat: COMPOSER.chat, pill: COMPOSER.pill };
    const link = await center("a.chat-link");
    const away = { x: 880, y: 20 };
    await moveTo(away);
    const cardOpen = await flow("09-link-card-open", CARD, 750, () => moveTo(link));
    const cardText = await evaluate(`document.querySelector('[data-link-preview]')?.textContent ?? ""`);
    report.cardText = cardText;
    const cardClose = await flow("10-link-card-close", CARD, 450, () => moveTo(away));
    await moveTo(link);
    await wait(800);
    const cardBack = await flow("11-link-card-back", CARD, 600, async () => { await moveTo(away); await wait(HOVER_BACK_MS); await moveTo(link); });

    // the phone's bar: the same swap at its width, and the resting bar keeps its one line even for a long name
    await open("skin=grok", 390, 700);
    const shortPill = await evaluate(`document.querySelector('[data-composer-row]').getBoundingClientRect().height`);
    const starter = bots.find((bot: { defaultBot?: unknown; hidden?: boolean }) => bot.defaultBot && !bot.hidden) ?? bots[0];
    await api("PATCH", `/api/bots/${starter.id}`, { name: "Research Assistant Extraordinaire" });
    await open("skin=grok", 390, 700);
    const longPill = await evaluate(`document.querySelector('[data-composer-row]').getBoundingClientRect().height`);
    report.phonePill = { shortPill, longPill };
    const { data: phoneRest } = await request("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 560, width: 390, height: 140, scale: 2 } });
    writeFileSync(join(evidence, "phone-bar-at-rest.png"), Buffer.from(phoneRest, "base64"));
    await focusField();
    const phoneTyping = await flow("12-typing-phone", COMPOSER, 500, () => press("h", "h", "KeyH"));
    const phoneClearing = await flow("13-clearing-phone", COMPOSER, 500, () => press("Backspace"));

    writeFileSync(join(evidence, "report.json"), JSON.stringify(report, null, 1));

    // nothing in the chat or the composer moves: no layout shift the page did on its own (the typed letters themselves
    // move the field's text, which the browser files under the keystroke, as it does for any typing)
    for (const [name, { shifts }] of Object.entries({ typing, clearing, mention, slash, voice, voiceStop, sheetOpen, sheetClose, cardOpen, cardClose, cardBack, phoneTyping, phoneClearing })) {
      expect(shifts.filter((shift) => !shift.input).reduce((sum, shift) => sum + shift.value, 0), `${name}: layout shift`).toBe(0);
    }
    for (const [name, run] of Object.entries({ typing, clearing, mention, slash, voice, voiceStop, sheetOpen, sheetClose, phoneTyping, phoneClearing })) {
      expect(boxes(run.track, "pill"), `${name}: the composer pill`).toHaveLength(1);
      expect(boxes(run.track, "dock"), `${name}: the composer dock`).toHaveLength(1);
      expect(boxes(run.track, "chat"), `${name}: the chat above it`).toHaveLength(1);
    }
    for (const run of [cardOpen, cardClose, cardBack]) expect(boxes(run.track, "chat")).toHaveLength(1);
    expect(longPill).toBe(shortPill);
    // the mic's swap: from one colour straight to the other on the next frame, nothing in between
    const micColours = (track: Frame[]) => new Set(track.map((row) => (row.mic as Box)?.bg));
    expect(micColours(typing.track).size).toBeLessThanOrEqual(2);
    expect(micColours(clearing.track).size).toBeLessThanOrEqual(2);
    // the card stays where it opened, and says where the link itself points
    const cardSpots = (track: Frame[]) => new Set(track.map((row) => row.card as Box).filter((box) => box && box.opacity !== "0").map((box) => box!.laid));
    expect(cardText).toContain("example.com");
    expect(cardText).not.toContain("tracker.example.net/landing");
    for (const run of [cardOpen, cardBack]) expect(cardSpots(run.track).size).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  } finally {
    writeFileSync(join(evidence, "report.json"), JSON.stringify(report, null, 1));
    cdp?.close();
    if (chrome && chrome.exitCode === null) { chrome.kill(); await waitForExit(chrome).catch(() => undefined); }
    await preview?.close();
    await fixture?.close();
  }
}, 300_000);

/** Back over the link after the close grace, while the card is on its way out. */
const HOVER_BACK_MS = 190;
