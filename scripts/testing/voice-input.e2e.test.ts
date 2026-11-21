// Voice input in the real composer, headless, with a simulated recognizer and audio levels (no microphone): the
// waveform and one-line preview while talking, the words landing on Done, the first-run sheet and the calm error.
// Screenshots go to MADANI_UI_EVIDENCE_DIR/voice-input (default .madani-scratch/verify-evidence/voice-input).
//
//   MADANI_UI_E2E=1 pnpm exec vitest run scripts/testing/voice-input.e2e.test.ts
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
if (!enabled) console.log("skipping voice input screenshots: set MADANI_UI_E2E=1 for isolated browser qualification");

(enabled ? it : it.skip)("shows the waveform and one line while talking, then lands the words", async () => {
  let fixture: VerificationServer | undefined;
  let preview: MountedPreview | undefined;
  let chrome: ChildProcess | undefined;
  let cdp: Awaited<ReturnType<typeof connect>> | undefined;
  const evidence = join(process.env.MADANI_UI_EVIDENCE_DIR || join(REPO_ROOT, ".madani-scratch", "verify-evidence"), "voice-input");
  mkdirSync(evidence, { recursive: true });
  try {
    const tools = await ensureUiBrowser();
    if (!tools.chrome) throw new Error("needs the pinned Chrome for Testing");
    fixture = await launchVerificationServer(process.env);
    const api = fixtureApi(fixture.info.url);
    await api("PATCH", "/api/config", { language: "en" });
    preview = await mountPreview(fixture, { entry: "/scripts/testing/voice-input-preview.tsx", route: "/__voice-input.html", title: "Voice input", logLevel: "warn", hmr: false });
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
    cdp.on((method, params) => {
      if (method === "Runtime.exceptionThrown") errors.push(params.exceptionDetails?.exception?.description?.split("\n")[0] ?? params.exceptionDetails?.text);
    });
    await request("Page.enable");
    await request("Runtime.enable");
    await request("Page.addScriptToEvaluateOnNewDocument", { source: `try { for (const notice of ${JSON.stringify(NOTICES)}) localStorage.setItem(notice, "1"); } catch {}` });
    const wait = (ms: number) => evaluate(`new Promise((done) => setTimeout(done, ${ms}))`);
    const click = (label: string) => evaluate(`(() => { const b = document.querySelector('button[aria-label=${JSON.stringify(label)}]'); if (!b) throw new Error('no button ${label}'); b.click(); return true; })()`);
    const shot = async (name: string) => {
      const { data } = await request("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(evidence, `${name}.png`), Buffer.from(data, "base64"));
    };
    const open = async (query: string, width: number, height: number, touch = false) => {
      await request("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: touch });
      await request("Page.navigate", { url: `${preview!.previewUrl}?${query}` });
      await expect.poll(() => evaluate(`Boolean(document.querySelector('button[aria-label="Start dictation"]'))`), { timeout: 60_000, interval: 300 }).toBe(true);
      await evaluate(`document.fonts.ready`);
      await wait(300);
    };
    // the waveform's pixels, so two moments can be compared: the simulated voice must move it
    const inked = `(() => { const c = document.querySelector('[data-voice-waveform]'); const g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; })()`;

    await open("skin=grok", 900, 360);
    await shot("01-idle-desktop");
    await click("Start dictation");
    await wait(500);
    await shot("02-listening-desktop");
    const first = await evaluate(inked);
    await wait(170);
    const second = await evaluate(inked);
    expect(first).toBeGreaterThan(0);
    expect(second).not.toBe(first);
    await evaluate(`voiceFixture.say("Can you check the deploy logs from this morning")`);
    await wait(250);
    await shot("03-words-desktop");
    await evaluate(`voiceFixture.say("Can you check the deploy logs from this morning and tell me why the build for the phone app failed twice before lunch, and whether the retry fixed it")`);
    await wait(250);
    await shot("04-long-line-desktop");
    const line = await evaluate(`(() => { const p = document.querySelector('[data-voice-preview]'); return { height: p.getBoundingClientRect().height, text: p.textContent }; })()`);
    expect(line.height).toBeLessThanOrEqual(24);
    expect(line.text.startsWith("…")).toBe(true);
    expect(await evaluate(`document.querySelector('textarea').value`)).toBe("");
    await click("Stop dictation");
    await wait(200);
    await shot("05-landed-desktop");
    expect(await evaluate(`document.querySelector('textarea').value`)).toContain("whether the retry fixed it");

    await open("skin=grok-dark", 900, 360);
    await click("Start dictation");
    await evaluate(`voiceFixture.say("Draft a reply to Sam saying the numbers look right")`);
    await wait(400);
    await shot("06-words-desktop-dark");

    await open("skin=grok", 900, 360);
    await click("Start dictation");
    await evaluate(`voiceFixture.end(1, "mic-failed")`);
    await wait(200);
    await shot("07-error-desktop");

    await open("skin=grok", 900, 360);
    await click("Start dictation");
    await evaluate(`voiceFixture.end(1, "mic-denied")`);
    await wait(200);
    await shot("07b-mic-denied-desktop");
    expect(await evaluate(`document.querySelector('[data-open-system-settings="mic"]')?.textContent ?? ""`)).toBe("Open System Settings");

    await open("skin=grok&platform=linux", 900, 360);
    await click("Start dictation");
    await wait(200);
    await shot("07c-nothing-can-listen-desktop");
    expect(await evaluate(`document.querySelector('[data-open-voice-settings]')?.textContent ?? ""`)).toBe("Choose a speech service");
    expect(await evaluate(`document.body.textContent.toLowerCase().includes("settings > voice")`)).toBe(false);

    await open("skin=grok&firstRun=1", 900, 520);
    await click("Start dictation");
    await wait(400);
    await shot("08-first-run-desktop");
    expect(await evaluate(`document.querySelector('[data-panel-modal="voice-first-run"]')?.textContent ?? ""`)).toContain("Using your Mac's built-in transcription for now");

    await request("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await open("skin=grok", 390, 400, true);
    await click("Start dictation");
    await evaluate(`voiceFixture.say("Remind me to call the bank at four and ask about the card")`);
    await wait(400);
    await shot("09-words-phone");
    const phoneLine = await evaluate(`document.querySelector('[data-voice-preview]').getBoundingClientRect().height`);
    expect(phoneLine).toBeLessThanOrEqual(24);
    expect(errors).toEqual([]);
  } finally {
    cdp?.close();
    if (chrome && chrome.exitCode === null) { chrome.kill(); await waitForExit(chrome).catch(() => undefined); }
    await preview?.close();
    await fixture?.close();
  }
}, 300_000);

(enabled ? it : it.skip)("shows the voice keys and Voice input settings", async () => {
  let fixture: VerificationServer | undefined;
  let preview: MountedPreview | undefined;
  let chrome: ChildProcess | undefined;
  let cdp: Awaited<ReturnType<typeof connect>> | undefined;
  const evidence = join(process.env.MADANI_UI_EVIDENCE_DIR || join(REPO_ROOT, ".madani-scratch", "verify-evidence"), "voice-settings");
  mkdirSync(evidence, { recursive: true });
  try {
    const tools = await ensureUiBrowser();
    if (!tools.chrome) throw new Error("needs the pinned Chrome for Testing");
    fixture = await launchVerificationServer(process.env);
    const api = fixtureApi(fixture.info.url);
    await api("PATCH", "/api/config", { language: "en" });
    preview = await mountPreview(fixture, { entry: "/scripts/testing/voice-settings-preview.tsx", route: "/__voice-settings.html", title: "Voice settings", logLevel: "warn", hmr: false });
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
    cdp.on((method, params) => {
      if (method === "Runtime.exceptionThrown") errors.push(params.exceptionDetails?.exception?.description?.split("\n")[0] ?? params.exceptionDetails?.text);
    });
    await request("Page.enable");
    await request("Runtime.enable");
    await request("Page.addScriptToEvaluateOnNewDocument", { source: `try { for (const notice of ${JSON.stringify(NOTICES)}) localStorage.setItem(notice, "1"); } catch {}` });
    const wait = (ms: number) => evaluate(`new Promise((done) => setTimeout(done, ${ms}))`);
    const shot = async (name: string) => {
      const { data } = await request("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(evidence, `${name}.png`), Buffer.from(data, "base64"));
    };
    const open = async (query: string, width: number, height: number, touch = false) => {
      await request("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: touch });
      await request("Page.navigate", { url: `${preview!.previewUrl}?${query}` });
      await expect.poll(() => evaluate(`Boolean(document.querySelector('[data-key-row="deepgram"]'))`), { timeout: 60_000, interval: 300 }).toBe(true);
      await evaluate(`document.fonts.ready`);
      await wait(300);
    };
    await open("skin=grok", 760, 1500);
    await wait(1200);
    await evaluate(`document.querySelector('[data-keys-section="voice"]').scrollIntoView()`);
    await wait(300);
    await shot("01-voice-and-calls-keys");
    const rows = await evaluate(`[...document.querySelectorAll('[data-keys-section="voice"] [data-key-row]')].map((row) => row.getAttribute('data-key-row'))`);
    expect(rows).toEqual(expect.arrayContaining(["openaiVoice", "groqWhisper", "deepgram", "assemblyAi", "cartesia", "elevenlabs", "fishAudio", "geminiTts"]));
    await open("skin=grok&input=1", 760, 2400);
    await wait(1200);
    await shot("02-voice-input-settings");
    await open("skin=grok-dark", 760, 1500);
    await wait(1200);
    await shot("03-voice-and-calls-keys-dark");
    expect(errors).toEqual([]);
  } finally {
    cdp?.close();
    if (chrome && chrome.exitCode === null) { chrome.kill(); await waitForExit(chrome).catch(() => undefined); }
    await preview?.close();
    await fixture?.close();
  }
}, 300_000);
