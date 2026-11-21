// The chat gallery's layout guard: every scenario in chat-gallery/fixtures.ts drawn by the real ChatView, on the
// desktop and phone widths and the skins that differ most, then checked by chat-gallery/layout-audit.ts. A row that
// paints over its neighbour, text cut off or run out of the window, a field that does not look like the others, a
// native checkbox or a control with no focus look fails the run. Contrast and small touch targets are listed for a
// person to judge. Screenshots go to MADANI_GALLERY_DIR (default .madani-scratch/verify-evidence/chat-gallery).
//
//   MADANI_UI_E2E=1 pnpm exec vitest run scripts/testing/chat-gallery.e2e.test.ts
//   MADANI_GALLERY_ONLY=cards-pending MADANI_GALLERY_SKINS=grok  narrows the run.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlMadani, type VerificationServer } from "../control-madani.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { ensureUiBrowser } from "./control-madani-ui.ts";
import { encodePng } from "./png.ts";
import { fixtureApi, mountPreview, REPO_ROOT, type MountedPreview } from "./preview-fixture.ts";
import { GALLERY_IMAGE, GALLERY_WIDE_IMAGE, SCENARIOS } from "./chat-gallery/fixtures.ts";
import type { LayoutIssue } from "./chat-gallery/layout-audit.ts";
import { connect } from "./chat-gallery/cdp.ts";
import { NOTICES } from "../../src/lib/notices.ts";

const enabled = process.env.MADANI_UI_E2E === "1";
if (!enabled) console.log("skipping the chat gallery: set MADANI_UI_E2E=1 for isolated browser qualification");

// "min" is the desktop window's smallest size (electron/window-state.cjs MIN_BOUNDS)
const ALL_VIEWPORTS = [
  { id: "desktop", width: 1100, height: 900, touch: false },
  { id: "min", width: 768, height: 520, touch: false },
  { id: "phone", width: 390, height: 844, touch: true },
] as const;
const VIEWPORT_IDS = (process.env.MADANI_GALLERY_VIEWPORTS ?? "desktop,phone").split(",");
const VIEWPORTS = ALL_VIEWPORTS.filter((one) => VIEWPORT_IDS.includes(one.id));
const SKINS = (process.env.MADANI_GALLERY_SKINS ?? "grok,grok-dark,midnight,atelier,pop").split(",");
const ONLY = process.env.MADANI_GALLERY_ONLY?.split(",");
// "still": the transcript as a reopened chat shows it; "arrive": its rows landing one by one while the chat follows;
// "churn": the same rows handed over again under new ids, so every row mounts afresh at once
const MODES = (process.env.MADANI_GALLERY_MODES ?? "still,arrive,churn").split(",");

const photo = encodePng(240, 160, (x, y) => [80 + (x % 120), 120 + (y % 80), 200]);
const wide = encodePng(480, 120, (x, y) => [200, 100 + (x % 100), 80 + (y % 40)]);

(enabled ? it : it.skip)("draws every chat card without overlap, clipping or a stray field look", async () => {
  let fixture: VerificationServer | undefined;
  let preview: MountedPreview | undefined;
  let chrome: ChildProcess | undefined;
  let cdp: Awaited<ReturnType<typeof connect>> | undefined;
  const evidence = process.env.MADANI_GALLERY_DIR || join(process.env.MADANI_UI_EVIDENCE_DIR || join(REPO_ROOT, ".madani-scratch", "verify-evidence"), "chat-gallery");
  mkdirSync(evidence, { recursive: true });
  const report: Array<{ shot: string; probe?: unknown; caught?: unknown[]; issues: LayoutIssue[] }> = [];
  try {
    const tools = await ensureUiBrowser();
    if (!tools.chrome) throw new Error("the gallery needs the pinned Chrome for Testing");
    fixture = await launchVerificationServer(process.env);
    const api = fixtureApi(fixture.info.url);
    await api("PATCH", "/api/config", { language: "en" });
    const { bots } = await api("GET", "/api/bots");
    for (const bot of bots.filter((bot: { defaultBot?: unknown }) => bot.defaultBot)) await api("PATCH", `/api/bots/${bot.id}`, { welcomed: true });
    await runControlMadani(["new-bot", "--name", "Pepper", "--url", fixture.info.url]);
    // one colour every run, so screenshots compare (scripts/testing/visual-baseline.ts); a new bot's colour is picked at random
    for (const one of (await api("GET", "/api/bots")).bots) await api("PATCH", `/api/bots/${one.id}`, { color: one.name === "Pepper" ? "orange" : "silver" });
    preview = await mountPreview(fixture, {
      entry: "/scripts/testing/chat-gallery-preview.tsx", route: "/__chat-gallery.html", title: "Chat gallery", logLevel: "warn", hmr: false,
      extraRoutes: [{ path: /^\/api\/attachments\/([^/?]+)/, method: "GET", handler: (_req, res, match) => {
        const name = decodeURIComponent(match![1]!);
        if (name !== GALLERY_IMAGE && name !== GALLERY_WIDE_IMAGE) { res.statusCode = 404; res.end(); return; }
        res.setHeader("content-type", "image/png");
        res.end(name === GALLERY_IMAGE ? photo : wide);
      } }],
    });
    const profile = join(fixture.info.dataDir, "chrome");
    mkdirSync(profile, { recursive: true });
    const mouse = "--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2";
    chrome = spawn(tools.chrome, ["--headless=new", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--password-store=basic", "--use-mock-keychain", "--hide-scrollbars", mouse, "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], {
      env: { PATH: process.env.PATH, HOME: fixture.info.dataDir, USERPROFILE: fixture.info.dataDir, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }, stdio: "ignore",
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
    await request("Page.enable");
    await request("Runtime.enable");
    await request("Page.addScriptToEvaluateOnNewDocument", { source: `try { for (const notice of ${JSON.stringify(NOTICES)}) localStorage.setItem(notice, "1"); } catch {}` });
    await request("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    // MADANI_GALLERY_STEADY=1 (the visual baseline): code blocks settle their highlighting and scroll at different moments
    // run to run, so their text is left out of the picture; the block itself still shows
    if (process.env.MADANI_GALLERY_STEADY === "1") await request("Page.addScriptToEvaluateOnNewDocument", { source: `addEventListener("DOMContentLoaded", () => { const style = document.createElement("style"); style.textContent = "pre, pre * { color: transparent !important; }"; document.head.append(style); });` });
    const errors: string[] = [];
    let current = "";
    // a card that throws falls back to plain text inside MessageBoundary: React's error log is how the run sees it
    cdp.on((method, params) => {
      if (method === "Runtime.exceptionThrown") errors.push(`${current}: ${params.exceptionDetails?.exception?.description?.split("\n")[0] ?? params.exceptionDetails?.text}`);
      if (method === "Runtime.consoleAPICalled" && params.type === "error") {
        const text = params.args?.map((arg: any) => arg.value ?? arg.description ?? "").join(" ") ?? "";
        if (/error occurred in|Maximum update depth|Each child in a list|Encountered two children/.test(text)) errors.push(`${current}: ${text.split("\n")[0]}`);
      }
    });

    for (const viewport of VIEWPORTS) {
      // a phone is touched: pointer-coarse sizes apply. Touch emulation swaps the pointer for good, so phones run last.
      if (viewport.touch) await request("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      for (const scenario of SCENARIOS.filter((one) => !ONLY || ONLY.includes(one.id))) {
        for (const skin of SKINS) for (const mode of MODES) {
          // arrivals are about motion and order, not colour: one skin is enough
          if (mode !== "still" && skin !== SKINS[0]) continue;
          const shot = `${scenario.id}-${viewport.id}-${skin}${mode === "still" ? "" : `-${mode}`}`;
          current = shot;
          await request("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.touch });
          await request("Page.navigate", { url: `${preview.previewUrl}?scenario=${scenario.id}&skin=${skin}${mode === "arrive" ? "&arrive=1" : mode === "churn" ? "&churn=1" : ""}` });
          // arrivals are checked while they land too: each step's rows must already sit clear of one another
          const during: LayoutIssue[] = [];
          const caught: unknown[] = [];
          await expect.poll(async () => {
            if (mode === "arrive") {
              const found = await evaluate(`window.__galleryAudit({ touch: false, scopeSelector: "[data-none]" })`) as LayoutIssue[];
              during.push(...found);
              // MADANI_GALLERY_CATCH=1: a picture of the first frame an arrival check flags
              if (found.length && process.env.MADANI_GALLERY_CATCH === "1" && !caught.length) writeFileSync(join(evidence, `${shot}-caught.png`), Buffer.from((await request("Page.captureScreenshot", { format: "png" })).data, "base64"));
              if (found.length && process.env.MADANI_GALLERY_PROBE) caught.push(await evaluate(process.env.MADANI_GALLERY_PROBE));
            }
            return evaluate(`Boolean(document.querySelector('[data-gallery-ready="${scenario.id}"] [data-simple-rows]'))`);
          }, { timeout: 120_000, interval: 300 }).toBe(true);
          await evaluate(`document.fonts.ready.then(() => new Promise((done) => setTimeout(done, 600)))`);
          // the whole transcript in one frame: the window grows to the transcript's height
          const tall = await evaluate(`(() => { const s = document.querySelector('.glass-scroller'); return s ? Math.ceil(s.scrollHeight + (innerHeight - s.clientHeight)) : innerHeight; })()`);
          await request("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: Math.min(Math.max(viewport.height, tall), 12_000), deviceScaleFactor: 1, mobile: viewport.touch });
          await evaluate(`new Promise((done) => setTimeout(done, 400))`);
          const issues: LayoutIssue[] = await evaluate(`window.__galleryAudit({ touch: ${viewport.touch}, focus: ${skin === SKINS[0]} })`);
          const { data } = await request("Page.captureScreenshot", { format: "png" });
          writeFileSync(join(evidence, `${shot}.png`), Buffer.from(data, "base64"));
          // a link's hover card, on a pointer: the first link in the transcript, hovered until its preview is up
          if (!viewport.touch && mode === "still") {
            const spot = await evaluate(`(() => { const link = document.querySelector('.glass-scroller a[href^="http"]'); if (!link) return null; link.scrollIntoView({ block: "center" }); const r = link.getBoundingClientRect(); return { x: r.left + Math.min(12, r.width / 2), y: r.top + r.height / 2 }; })()`);
            if (spot) {
              await request("Input.dispatchMouseEvent", { type: "mouseMoved", x: spot.x, y: spot.y });
              await evaluate(`new Promise((done) => setTimeout(done, 1200))`);
              if (await evaluate(`Boolean(document.querySelector(".link-preview"))`)) writeFileSync(join(evidence, `${shot}-link-hover.png`), Buffer.from((await request("Page.captureScreenshot", { format: "png" })).data, "base64"));
              await request("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 });
            }
          }
          // MADANI_GALLERY_PROBE: an expression to read in each shot while chasing a finding (saved beside its issues)
          const probe = process.env.MADANI_GALLERY_PROBE ? await evaluate(process.env.MADANI_GALLERY_PROBE) : undefined;
          report.push({ shot, ...(probe === undefined ? {} : { probe }), ...(caught.length ? { caught } : {}), issues: [...issues, ...during.map((issue) => ({ ...issue, detail: `while arriving: ${issue.detail}` }))] });
        }
      }
    }
    writeFileSync(join(evidence, "report.json"), JSON.stringify(report, null, 2));
    const hard = report.flatMap(({ shot, issues }) => issues.filter((issue) => issue.hard).map((issue) => `${shot}: ${issue.kind} ${issue.where}: ${issue.detail}`));
    expect(errors).toEqual([]);
    expect(hard).toEqual([]);
  } finally {
    cdp?.close();
    if (chrome && chrome.exitCode === null) { chrome.kill(); await waitForExit(chrome).catch(() => undefined); }
    await preview?.close();
    await fixture?.close();
  }
}, 900_000);
