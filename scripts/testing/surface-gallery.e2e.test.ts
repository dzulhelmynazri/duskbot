// The surfaces gallery's layout guard: every settings page, every bot panel tab, the dialogs and sheets the store opens,
// and the first-run steps a browser gets, in the real app on desktop and phone widths, checked by the chat gallery's
// layout audit (scoped to the open surface). Screenshots go to MADANI_GALLERY_DIR (default
// .madani-scratch/verify-evidence/chat-gallery), beside the chat cards'.
//
//   MADANI_UI_E2E=1 pnpm exec vitest run scripts/testing/surface-gallery.e2e.test.ts
//   MADANI_SURFACES_ONLY=settings:appearance,panel:soul  narrows the run.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlMadani, type VerificationServer } from "../control-madani.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { ensureUiBrowser } from "./control-madani-ui.ts";
import { fixtureApi, mountPreview, REPO_ROOT, type MountedPreview } from "./preview-fixture.ts";
import { connect } from "./chat-gallery/cdp.ts";
import type { LayoutIssue } from "./chat-gallery/layout-audit.ts";
import type { AppSettingsSection, BotSettingsSection } from "../../src/state/store.tsx";
import { NOTICES } from "../../src/lib/notices.ts";

const enabled = process.env.MADANI_UI_E2E === "1";
if (!enabled) console.log("skipping the surfaces gallery: set MADANI_UI_E2E=1 for isolated browser qualification");

const SETTINGS: AppSettingsSection[] = [
  "general", "appearance", "looks", "bots", "engines", "connections", "apps", "computer", "logins", "usage", "people", "botAccess",
  "activity", "backups", "skills", "import", "updates", "texting", "permissions", "advanced", "data", "builder", "about", "transfer",
  "experimental", "companion", "remote", "desktopWorkspaces", "organization", "cloudAccount",
];
const PANEL: BotSettingsSection[] = [
  "overview", "identity", "slack", "soul", "skills", "memory", "library", "routines", "access", "model", "permissions", "voice",
  "visibility", "history", "usage", "computer",
];
/** Store actions that open a dialog or sheet of their own. */
const DIALOGS: Record<string, string> = {
  shortcuts: `{ type: "toggleShortcuts", open: true }`,
  "connect-apps": `{ type: "togglePlugins", open: true, surface: "apps" }`,
  "mcp-servers": `{ type: "togglePlugins", open: true, surface: "mcp" }`,
  computer: `{ type: "toggleComputer", open: true }`,
  "cloud-add": `{ type: "openCloudAdd", source: "app_menu" }`,
  "cloud-how-to": `{ type: "cloudHowTo", open: true }`,
  "welcome-replay": `{ type: "toggleWelcome", open: true }`,
};
/** What a browser's first run shows (place, bring, phone and making need the desktop app's bridge). */
const ONBOARDING = ["welcome", "account", "ai"];
/** Typing into the composer the way a person does, so React sees the change. */
const TYPE = (text: string) => `(() => { const field = document.querySelector("textarea[aria-label]"); if (!field) return false; field.focus();
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, ${JSON.stringify(text)});
  field.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`;
/** Opens the model picker from the bot panel's Model row, the way a click does. */
const OPEN_PICKER = `(() => { const trigger = document.querySelector("[data-panel-row=model] [data-tour=model]"); if (!trigger) return false; trigger.click();
  return new Promise((done) => setTimeout(() => done(Boolean(document.querySelector("[data-model-picker-content]"))), 400)); })()`;
/** The picker with two models starred (pressing their stars, as a person does): a Starred section on top, the stars on in their groups. */
const PICKER_STARRED = `(async () => { if (!(await ${OPEN_PICKER})) return false; const stars = [...document.querySelectorAll("[data-simple-provider] [data-star-toggle]")];
  if (stars.length < 3) return false; stars[1].click(); await new Promise((done) => setTimeout(done, 100)); stars[2].click();
  return new Promise((done) => setTimeout(() => done(Boolean(document.querySelector("[data-picker-starred]"))), 300)); })()`;
/** From the picker, a Not connected row's Connect: the picker closes and Connect an AI opens on that provider. */
const PICKER_CONNECT = `(async () => { if (!(await ${OPEN_PICKER})) return false; const row = document.querySelector('[data-picker-connect="openrouter"]');
  if (!row) return false; row.click(); return new Promise((done) => setTimeout(() => done(Boolean(document.querySelector("[data-connect-ai]"))), 600)); })()`;
/** ...and that provider connecting: the store hears it ready, the dialog closes and the bot moves to its model. */
const PICKER_CONNECTED = `(async () => { if (!(await ${PICKER_CONNECT})) return false;
  const { instances } = await (await fetch("/api/instances")).json();
  const next = instances.map((one) => one.instanceId === "openrouter" ? { ...one, snapshot: { ...one.snapshot, state: "available", authenticated: true, reason: undefined } } : one);
  window.__surfaceGallery.dispatch({ type: "instances", instances: next });
  return new Promise((done) => setTimeout(() => done(true), 800)); })()`;
/** The chat window itself: empty, mid-typing, and with the app's error and note banners up. */
const CHAT: Record<string, { open: string | null; run?: string }> = {
  empty: { open: `{ type: "select", id: window.__surfaceGallery.botId }` },
  typing: { open: `{ type: "select", id: window.__surfaceGallery.botId }`, run: TYPE("Can you sort out the payouts report and book the call for Monday?") },
  error: { open: `{ type: "error", message: "Couldn't reach the server. Check your connection and try again." }` },
  notice: { open: `{ type: "notice", notice: { kind: "note", botName: null, text: "Pepper is set up. Say hi to get started." } }` },
};

// "min" is the desktop window's smallest size (electron/window-state.cjs MIN_BOUNDS)
const ALL_VIEWPORTS = [
  { id: "desktop", width: 1280, height: 860, touch: false },
  { id: "min", width: 768, height: 520, touch: false },
  { id: "phone", width: 390, height: 844, touch: true },
] as const;
const VIEWPORT_IDS = (process.env.MADANI_SURFACES_VIEWPORTS ?? "desktop,phone").split(",");
// touch emulation sticks once on, so phones run last
const VIEWPORTS = ALL_VIEWPORTS.filter((one) => VIEWPORT_IDS.includes(one.id));
const SKINS = (process.env.MADANI_SURFACES_SKINS ?? "grok").split(",");
const ONLY = process.env.MADANI_SURFACES_ONLY?.split(",");
const DIALOG_SCOPE = `[role=dialog], [role=alertdialog], [aria-modal=true]`;

/** Points across the window outside an open modal must hit its scrim or the modal itself (elementFromPoint). */
const COVER_CHECK = `(() => {
  const modal = [...document.querySelectorAll('[aria-modal="true"], [role="alertdialog"], dialog[open]')].filter((one) => one.getClientRects().length).at(-1);
  if (!modal) return [];
  const w = innerWidth, h = innerHeight, box = modal.getBoundingClientRect();
  const points = { "top left": [3, 3], "top right": [w - 4, 3], "bottom left": [3, h - 4], "bottom right": [w - 4, h - 4],
    "toolbar": [Math.min(240, w * 0.2), 28], "chat header": [w * 0.62, 30], "sidebar footer": [Math.min(120, w * 0.12), h - 30],
    "sidebar": [Math.min(120, w * 0.12), h * 0.4], "composer": [w * 0.62, h - 40], "chat": [w * 0.62, h * 0.5] };
  const issues = [];
  for (const [where, [x, y]] of Object.entries(points)) {
    if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) continue;
    const hit = document.elementFromPoint(x, y);
    if (!hit) continue;
    // the scrim is the modal's own backdrop: an element holding the modal, or a backdrop beside it in the same layer
    const scrim = hit === modal || modal.contains(hit) || hit.contains(modal) || /scrim|backdrop/.test(String(hit.className)) || hit.matches("dialog[open]");
    if (!scrim) issues.push({ kind: "overlap", hard: true, where, detail: "above the open dialog's scrim: " + (hit.closest("[data-sidebar-footer], [data-glass-bar], [data-chathead-row], aside, nav, button")?.tagName ?? hit.tagName).toLowerCase() + " " + String(hit.className).slice(0, 60) });
  }
  return issues;
})()`;

/** Clicks the first visible match, the way a pointer does (pointerdown, mousedown, click), and reports whether it found one. */
const CLICK = (selector: string, nth = 0) => `(() => { const all = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((one) => one.getClientRects().length);
  const el = all[${nth}]; if (!el) return false; el.scrollIntoView({ block: "nearest" });
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) el.dispatchEvent(new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type, { bubbles: true, button: 0 }));
  el.click(); return true; })()`;
const CONTEXT = (selector: string, nth = 0) => `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((one) => one.getClientRects().length)[${nth}];
  if (!el) return false; const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 12, button: 2 })); return true; })()`;
const SELECT = `{ type: "select", id: window.__surfaceGallery.botId }`;
const POPOVER = `[role=menu], [role=listbox], [role=dialog]:not([aria-modal=true]), .popover-surface, .menu-surface, [data-mention-menu], [data-slash-menu]`;
/** The small surfaces: every popover, menu, picker, tooltip, toast, panel tab and inline state a person meets. */
const SMALL: Record<string, { open: string | null; run?: string; hover?: string; query?: string; scope?: string }> = {
  "bot-actions": { open: SELECT, run: CLICK("[data-bot-actions]", 1), scope: POPOVER },
  "bot-context": { open: SELECT, run: CONTEXT("[data-sidebar-bot-row]", 1), scope: POPOVER },
  "plus-menu": { open: SELECT, run: CLICK("[data-composer-plus]"), scope: POPOVER },
  "mention-menu": { open: SELECT, run: TYPE("@"), scope: POPOVER },
  "slash-menu": { open: SELECT, run: TYPE("/"), scope: POPOVER },
  "reaction-picker": { open: SELECT, run: CLICK('[aria-label="Add reaction"]'), scope: POPOVER },
  "message-actions": { open: SELECT, run: CLICK('[aria-label="Message actions"]'), scope: POPOVER },
  "account-menu": { open: SELECT, run: CLICK('[data-sidebar-footer] button'), scope: POPOVER },
  "sidebar-search": { open: SELECT, run: CLICK("[data-sidebar-search-toggle]"), scope: "#root" },
  "panel-share": { open: `{ type: "toggleSettings", open: true, section: "overview", botId: window.__surfaceGallery.botId }`, run: CLICK("[data-panel-share]"), scope: POPOVER },
  "panel-computer": { open: `{ type: "toggleSettings", open: true, section: "overview", botId: window.__surfaceGallery.botId }`, run: CLICK('[data-panel-tab]', 1), scope: "#root" },
  "panel-advanced": { open: `{ type: "toggleSettings", open: true, section: "overview", botId: window.__surfaceGallery.botId }`, run: CLICK('[data-panel-tab]', 2), scope: "#root" },
  "panel-rename": { open: `{ type: "toggleSettings", open: true, section: "overview", botId: window.__surfaceGallery.botId }`, run: CLICK("[data-panel-rename]"), scope: "#root" },
  "panel-avatar": { open: `{ type: "toggleSettings", open: true, section: "overview", botId: window.__surfaceGallery.botId }`, run: CLICK("[data-panel-avatar]"), scope: "#root" },
  "settings-select": { open: `{ type: "toggleAppSettings", open: true, section: "general" }`, run: CLICK('[data-settings-select="theme"]'), scope: POPOVER },
  "settings-sending": { open: `{ type: "toggleAppSettings", open: true, section: "general" }`, run: CLICK('[data-settings-select][aria-label="Sending while a bot works"]'), scope: POPOVER },
  "place-add": { open: `{ type: "toggleAppSettings", open: true, section: "computer" }`, run: CLICK('[data-settings-dialog] button, .settings-dialog button:not([data-settings-page])', 2), scope: "[role=dialog]" },
  "tooltip-mic": { open: SELECT, hover: "[data-voice-mic]", scope: ".ui-tooltip" },
  "toast-done": { open: SELECT, query: "card=toast-done", scope: ".ui-toast" },
  "toast-error": { open: SELECT, query: "card=toast-error", scope: ".ui-toast" },
};

type Surface = { id: string; open: string | null; onboarding?: string; scope: string; run?: string; query?: string; hover?: string };
const SURFACES: Surface[] = [
  ...SETTINGS.map((section) => ({ id: `settings:${section}`, open: `{ type: "toggleAppSettings", open: true, section: "${section}" }`, scope: DIALOG_SCOPE })),
  ...PANEL.map((section) => ({ id: `panel:${section}`, open: `{ type: "toggleSettings", open: true, section: "${section}", botId: window.__surfaceGallery.botId }`, scope: DIALOG_SCOPE })),
  ...Object.entries(DIALOGS).map(([id, action]) => ({ id: `dialog:${id}`, open: action, scope: id === "computer" ? "#root" : DIALOG_SCOPE })),
  ...ONBOARDING.map((step) => ({ id: `onboarding:${step}`, open: null, onboarding: step, scope: "[data-welcome]" })),
  ...Object.entries(CHAT).map(([id, chat]) => ({ id: `chat:${id}`, open: chat.open, run: chat.run, scope: "#root" })),
  ...Object.entries(SMALL).map(([id, small]) => ({ id: `small:${id}`, open: small.open, run: small.run, hover: small.hover, query: small.query, scope: small.scope ?? "#root" })),
  { id: "card:cloud-ready", open: null, query: "card=cloud-ready", scope: "[data-cloud-setup-ready]" },
  ...["available", "downloading", "ready"].map((state) => ({ id: `card:app-update-${state}`, open: null, query: `card=app-update-${state}`, scope: "[data-sidebar-footer]" })),
  { id: "dialog:connect-ai-from-chat", open: `{ type: "select", id: window.__surfaceGallery.botId }`, query: "card=connect-ai", scope: "[data-connect-ai]" },
  // the model picker, opened from the bot panel's Model row
  { id: "picker:model", open: `{ type: "toggleSettings", open: true, section: "overview", botId: window.__surfaceGallery.botId }`, run: OPEN_PICKER, scope: "[data-model-picker-content]" },
  { id: "picker:model-starred", open: `{ type: "toggleSettings", open: true, section: "overview", botId: window.__surfaceGallery.botId }`, run: PICKER_STARRED, hover: "[data-simple-provider] [data-model-row]", scope: "[data-model-picker-content]" },
  // Connect from the picker: the handoff to Connect an AI, and the bot on the new provider's model once it connects
  { id: "picker:connect", open: `{ type: "toggleSettings", open: true, section: "overview", botId: window.__surfaceGallery.botId }`, run: PICKER_CONNECT, scope: "[data-connect-ai]" },
  { id: "picker:connected", open: `{ type: "toggleSettings", open: true, section: "overview", botId: window.__surfaceGallery.botId }`, run: PICKER_CONNECTED, scope: "#root" },
  // a bot's browser on this computer, in its Computer tab: browsing, open and idle, a tab the person holds, its close
  // confirm, closed (the Start browser pill alone), and no browser at all
  { id: "panel:local-browser-working", open: `{ type: "toggleSettings", open: true, section: "computer", botId: window.__surfaceGallery.botId }`, query: "card=local-browser-working", scope: "[data-local-browser]" },
  { id: "panel:local-browser-open", open: `{ type: "toggleSettings", open: true, section: "computer", botId: window.__surfaceGallery.botId }`, query: "card=local-browser-open", scope: "[data-local-browser]" },
  { id: "panel:local-browser-held", open: `{ type: "toggleSettings", open: true, section: "computer", botId: window.__surfaceGallery.botId }`, query: "card=local-browser-held", scope: "[data-local-browser]" },
  { id: "panel:local-browser-confirm", open: `{ type: "toggleSettings", open: true, section: "computer", botId: window.__surfaceGallery.botId }`, query: "card=local-browser-open", run: CLICK("[data-local-browser-action=close]"), scope: "[data-local-browser]" },
  { id: "panel:local-browser-closed", open: `{ type: "toggleSettings", open: true, section: "computer", botId: window.__surfaceGallery.botId }`, query: "card=local-browser-closed", scope: "[data-local-browser]" },
  { id: "card:cloud-nudge", open: SELECT, query: "card=cloud-nudge", scope: "[data-spot-cta]" },
  { id: "card:cloud-stale-checkout", open: `{ type: "openCloudAdd", source: "app_bot_panel" }`, query: "card=cloud-stale-checkout", scope: "[data-cloud-add-dialog] [data-plan-buy]" },
  { id: "panel:local-browser-offer", open: `{ type: "toggleSettings", open: true, section: "computer", botId: window.__surfaceGallery.botId }`, query: "card=local-browser-offer", scope: "[data-cloud-cta]" },
].filter((surface) => !ONLY || ONLY.includes(surface.id));

(enabled ? it : it.skip)("draws every settings page, panel tab, dialog and first-run step without overlap or clipping", async () => {
  let fixture: VerificationServer | undefined;
  let preview: MountedPreview | undefined;
  // a brand-new install for the first-run steps: nothing welcomed, no bot made
  let fresh: VerificationServer | undefined;
  let freshPreview: MountedPreview | undefined;
  let chrome: ChildProcess | undefined;
  let cdp: Awaited<ReturnType<typeof connect>> | undefined;
  const evidence = process.env.MADANI_GALLERY_DIR || join(process.env.MADANI_UI_EVIDENCE_DIR || join(REPO_ROOT, ".madani-scratch", "verify-evidence"), "chat-gallery");
  mkdirSync(evidence, { recursive: true });
  const report: Array<{ shot: string; opened: boolean; issues: LayoutIssue[]; probe?: unknown }> = [];
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
    preview = await mountPreview(fixture, { entry: "/scripts/testing/surface-gallery-preview.tsx", route: "/__surface-gallery.html", title: "Surfaces gallery", logLevel: "warn", hmr: false });
    if (SURFACES.some((surface) => surface.onboarding)) {
      fresh = await launchVerificationServer(process.env);
      await fixtureApi(fresh.info.url)("PATCH", "/api/config", { language: "en" });
      freshPreview = await mountPreview(fresh, { entry: "/scripts/testing/surface-gallery-preview.tsx", route: "/__surface-gallery-fresh.html", title: "Surfaces gallery, first run", logLevel: "warn", hmr: false });
    }
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
    const errors: string[] = [];
    let current = "";
    cdp.on((method, params) => {
      if (method === "Runtime.exceptionThrown") errors.push(`${current}: ${params.exceptionDetails?.exception?.description?.split("\n")[0] ?? params.exceptionDetails?.text}`);
      if (method === "Runtime.consoleAPICalled" && params.type === "error") {
        const text = params.args?.map((arg: any) => arg.value ?? arg.description ?? "").join(" ") ?? "";
        if (/error occurred in|Maximum update depth|Each child in a list|Encountered two children/.test(text)) errors.push(`${current}: ${text.split("\n")[0]}`);
      }
    });

    for (const viewport of VIEWPORTS) {
      if (viewport.touch) await request("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      for (const skin of SKINS) for (const surface of SURFACES) {
        const shot = `surface-${surface.id.replace(":", "-")}-${viewport.id}${skin === "grok" ? "" : `-${skin}`}`;
        current = shot;
        await request("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.touch });
        // each surface from a clean start: an open panel or a settings page must not carry over to the next
        await evaluate(`try { localStorage.clear(); sessionStorage.clear(); } catch {} true`).catch(() => undefined);
        await request("Page.navigate", { url: surface.onboarding ? `${freshPreview!.previewUrl}?onboarding=${surface.onboarding}&skin=${skin}` : `${preview.previewUrl}?skin=${skin}${surface.query ? `&${surface.query}` : ""}` });
        await expect.poll(() => evaluate(`Boolean(window.__surfaceGallery?.ready)`).catch(() => false), { timeout: 120_000 }).toBe(true);
        let opened = true;
        if (surface.onboarding) opened = await expect.poll(() => evaluate(`document.querySelector("[data-welcome]")?.getAttribute("data-welcome")`), { timeout: 15_000 }).toBe(surface.onboarding).then(() => true, () => false);
        if (surface.open) {
          await evaluate(`window.__surfaceGallery.dispatch(${surface.open}); true`);
          opened = await expect.poll(() => evaluate(`document.querySelectorAll(${JSON.stringify(surface.scope)}).length > 0`), { timeout: 15_000 }).toBe(true).then(() => true, () => false);
        }
        if (surface.run) {
          await evaluate(`new Promise((done) => setTimeout(done, 300))`);
          opened = Boolean(await evaluate(surface.run));
          if (opened && surface.scope !== "#root") opened = await expect.poll(() => evaluate(`[...document.querySelectorAll(${JSON.stringify(surface.scope)})].some((one) => one.getClientRects().length)`), { timeout: 5_000 }).toBe(true).then(() => true, () => false);
        }
        if (surface.hover) {
          await evaluate(`new Promise((done) => setTimeout(done, 300))`);
          const spot = await evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(surface.hover)})].find((one) => one.getClientRects().length); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
          opened = Boolean(spot);
          if (spot) {
            for (const step of [40, 20, 8, 0]) await request("Input.dispatchMouseEvent", { type: "mouseMoved", x: spot.x - step, y: spot.y, pointerType: "mouse" });
            opened = await expect.poll(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(surface.scope)}))`), { timeout: 4_000 }).toBe(true).then(() => true, () => false);
            await evaluate(`new Promise((done) => setTimeout(done, 300))`);
          }
        }
        await evaluate(`document.fonts.ready.then(() => new Promise((done) => setTimeout(done, 700)))`);
        // the starter question card lands after the transcript does; wait for it, so every capture shows the same chat
        if (surface.id.startsWith("chat:")) await expect.poll(() => evaluate(`Boolean(document.querySelector("[data-ask-card]"))`), { timeout: 10_000 }).toBe(true).catch(() => undefined);
        // the chat states from its end, as a person sees them: a banner that lands late may leave the transcript where it was
        if (surface.id.startsWith("chat:")) await evaluate(`(() => { const s = document.querySelector(".glass-scroller"); if (s) s.scrollTop = s.scrollHeight; return new Promise((done) => setTimeout(done, 300)); })()`);
        const issues: LayoutIssue[] = opened ? await evaluate(`window.__galleryAudit({ touch: ${viewport.touch}, focus: ${viewport.id === "desktop"}, scopeSelector: ${JSON.stringify(surface.scope)} })`) : [];
        // a modal's scrim covers the whole window: across the window outside the dialog (corners, the toolbar and the
        // chat's header, the sidebar footer, the composer), the topmost thing is the scrim or the dialog, never the app
        if (opened) issues.push(...await evaluate(COVER_CHECK) as LayoutIssue[]);
        const { data } = await request("Page.captureScreenshot", { format: "png" });
        writeFileSync(join(evidence, `${shot}.png`), Buffer.from(data, "base64"));
        // MADANI_SURFACES_ENDS=1: a long pane's end as well, scrolled in its own scroller, for a person reading the run
        if (process.env.MADANI_SURFACES_ENDS === "1" && opened) {
          const scrolled = await evaluate(`(() => { const scope = document.querySelector(${JSON.stringify(surface.scope)}); if (!scope) return false;
            const all = [scope, ...scope.querySelectorAll("*")].filter((one) => one.scrollHeight - one.clientHeight > 40 && /auto|scroll/.test(getComputedStyle(one).overflowY));
            const longest = all.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0];
            if (!longest) return false; longest.scrollTop = longest.scrollHeight; return true; })()`);
          if (scrolled) {
            await evaluate(`new Promise((done) => setTimeout(done, 300))`);
            writeFileSync(join(evidence, `${shot}-end.png`), Buffer.from((await request("Page.captureScreenshot", { format: "png" })).data, "base64"));
          }
        }
        const probe = process.env.MADANI_GALLERY_PROBE ? await evaluate(process.env.MADANI_GALLERY_PROBE) : undefined;
        report.push({ shot, opened, issues, ...(probe === undefined ? {} : { probe }) });
      }
    }
    writeFileSync(join(evidence, "surfaces-report.json"), JSON.stringify(report, null, 2));
    const hard = report.flatMap(({ shot, issues }) => issues.filter((issue) => issue.hard).map((issue) => `${shot}: ${issue.kind} ${issue.where}: ${issue.detail}`));
    expect(errors).toEqual([]);
    expect(hard).toEqual([]);
  } finally {
    cdp?.close();
    if (chrome && chrome.exitCode === null) { chrome.kill(); await waitForExit(chrome).catch(() => undefined); }
    await preview?.close();
    await freshPreview?.close();
    await fixture?.close();
    await fresh?.close();
  }
}, 1_800_000);
