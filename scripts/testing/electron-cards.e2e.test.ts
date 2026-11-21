// The desktop app itself, hidden: real Electron with its own data folder, user data and free ports (never the
// developer's 5199/8799), every window offscreen (electron-hidden.cjs). The fake engine calls the real card tools
// (FAKE_CLAUDE_MCP_TOOLS), so the server posts real secret, login, sign-in and widget cards; the chat-gallery layout
// check then runs in the app's own window. Screenshots go beside the gallery's.
//
//   MADANI_ELECTRON_E2E=1 pnpm exec vitest run scripts/testing/electron-cards.e2e.test.ts
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { launchVerificationServer, runControlMadani, type VerificationServer } from "../control-madani.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { REPO_ROOT } from "./preview-fixture.ts";
import { auditLayout, type LayoutIssue } from "./chat-gallery/layout-audit.ts";
import { WIDGET_SAMPLES } from "../../shared/widget-samples.ts";
import { NOTICES } from "../../src/lib/notices.ts";

const enabled = process.env.MADANI_ELECTRON_E2E === "1";
if (!enabled) console.log("skipping the hidden desktop run: set MADANI_ELECTRON_E2E=1");
const OWNER_PORTS = new Set([5199, 8799, 8800, 5299, 8899, 8900, 9335]);

async function freePort(): Promise<number> {
  for (;;) {
    const server = createNetServer();
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as { port: number }).port;
    await new Promise((done) => server.close(done));
    if (!OWNER_PORTS.has(port) && !OWNER_PORTS.has(port + 1)) return port;
  }
}

const CARD_TOOLS = [
  { tool: "request_credential", arguments: { credential_id: "login", site: "dashboard.example.com", label: "Example dashboard", reason: "Log in so I can download the payout CSV." } },
  { tool: "request_credential", arguments: { label: "Stripe secret key", reason: "To read this month's payouts.", placeholder: "sk_live_...", delivery: "ref" } },
  { tool: "request_sign_in", arguments: { site: "bank.example.com", reason: "The bank asks for a code only you get." } },
  { tool: "show_widget", arguments: { widget: WIDGET_SAMPLES.routineForm } },
];

(enabled ? it : it.skip)("draws the real cards in the desktop app without overlap or clipping", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "madanibot-electron-cards-"));
  const evidence = process.env.MADANI_GALLERY_DIR || join(REPO_ROOT, ".madani-scratch", "verify-evidence", "chat-gallery");
  mkdirSync(evidence, { recursive: true });
  let vite: ViteDevServer | undefined;
  let electron: ChildProcess | undefined;
  let socket: WebSocket | undefined;
  let fixture: VerificationServer | undefined;
  let log = "";
  try {
    fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_MCP_TOOLS: JSON.stringify(CARD_TOOLS), FAKE_CLAUDE_REPLIES: JSON.stringify(["I asked for what I need above."]) });
    const port = Number(new URL(fixture.info.url).port);
    if (OWNER_PORTS.has(port)) throw new Error(`the fixture landed on the developer's port ${port}`);
    const uiPort = await freePort();
    // vite.config.ts reads MADANI_PORT for its /api proxy when it loads
    process.env.MADANI_PORT = String(port);
    vite = await createServer({ root: REPO_ROOT, logLevel: "warn", cacheDir: join(REPO_ROOT, ".madani-scratch", "vite-electron-cards"), server: { host: "127.0.0.1", port: uiPort, strictPort: true, hmr: false, fs: { allow: [REPO_ROOT, realpathSync(join(REPO_ROOT, "node_modules"))] } } });
    await vite.listen();
    const home = join(dataDir, "home");
    mkdirSync(home, { recursive: true });
    const env = {
      PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: dataDir,
      MADANI_PORT: String(port),
      ELECTRON_START_URL: `http://127.0.0.1:${uiPort}`,
      NODE_OPTIONS: `--require ${join(REPO_ROOT, "scripts", "testing", "electron-hidden.cjs")}`,
      MADANI_ERROR_REPORTS: "0",
      MADANI_ANALYTICS: "0",
    };
    const userData = join(dataDir, "electron");
    const binary = createRequire(join(REPO_ROOT, "package.json"))("electron") as unknown as string;
    electron = spawn(binary, [REPO_ROOT, `--user-data-dir=${userData}`, "--remote-debugging-port=0", "--use-mock-keychain", "--password-store=basic"], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    electron.stdout!.on("data", (chunk) => { log += chunk; });
    electron.stderr!.on("data", (chunk) => { log += chunk; });
    const portFile = join(userData, "DevToolsActivePort");
    await expect.poll(() => existsSync(portFile), { timeout: 60_000 }).toBe(true);
    const cdpPort = readFileSync(portFile, "utf8").split("\n")[0]!.trim();
    let page: { webSocketDebuggerUrl: string } | undefined;
    await expect.poll(async () => {
      const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json() as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
      page = targets.find((target) => target.type === "page" && target.url.startsWith(`http://127.0.0.1:${uiPort}`));
      return Boolean(page);
    }, { timeout: 120_000, message: () => log.slice(-3000) }).toBe(true);
    socket = new WebSocket(page!.webSocketDebuggerUrl);
    await new Promise((done, fail) => { socket!.onopen = done; socket!.onerror = fail; });
    let next = 0;
    const waiting = new Map<number, (value: any) => void>();
    socket.onmessage = (event) => { const message = JSON.parse(String(event.data)); waiting.get(message.id)?.(message); waiting.delete(message.id); };
    const send = (method: string, params: object = {}) => new Promise<any>((done) => { const id = ++next; waiting.set(id, done); socket!.send(JSON.stringify({ id, method, params })); });
    const evaluate = async (expression: string) => {
      const reply = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (reply.result?.exceptionDetails) throw new Error(reply.result.exceptionDetails.exception?.description ?? reply.result.exceptionDetails.text);
      return reply.result?.result?.value;
    };
    // a returning person: no email gate or one-time notices between the run and its chat
    await runControlMadani(["new-bot", "--name", "Pepper", "--url", fixture.info.url]).catch(() => undefined);
    await evaluate(`localStorage.setItem("madani-email-gate", "skipped"); for (const notice of ${JSON.stringify(NOTICES)}) localStorage.setItem(notice, "1"); location.reload(); true`).catch(() => undefined);
    await expect.poll(() => evaluate(`Boolean(document.querySelector('textarea[aria-label^="Message"]'))`).catch(() => false), { timeout: 120_000 }).toBe(true);
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate(`(() => { const box = document.querySelector('textarea[aria-label^="Message"]'); box.focus(); return true; })()`);
    await send("Input.insertText", { text: "Please get the payouts report." });
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    // the turn's card tools post their cards, then the reply lands: wait for the reply, so every card is in
    await expect.poll(() => evaluate(`document.querySelector('[data-simple-rows]')?.textContent?.includes("I asked for what I need above.") ?? false`), { timeout: 90_000 }).toBe(true);
    const cards = await evaluate(`Array.from(document.querySelectorAll('[data-simple-rows] [data-ask-card], [data-simple-rows] [data-widget]')).map((card) => card.getAttribute("aria-label"))`);
    writeFileSync(join(evidence, "electron-cards.json"), JSON.stringify(cards, null, 2));
    expect(cards.length).toBeGreaterThanOrEqual(CARD_TOOLS.length);
    await evaluate(`new Promise((done) => setTimeout(done, 2500))`);
    const report: Record<string, LayoutIssue[]> = {};
    for (const [name, width] of [["desktop", 1280], ["narrow", 760], ["phone", 390]] as const) {
      await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
      await evaluate(`new Promise((done) => setTimeout(done, 600))`);
      const tall = await evaluate(`(() => { const s = document.querySelector('[data-simple-rows]')?.closest('.glass-scroller'); return s ? Math.ceil(s.scrollHeight + (innerHeight - s.clientHeight)) : innerHeight; })()`);
      await send("Emulation.setDeviceMetricsOverride", { width, height: Math.min(Math.max(900, tall), 8000), deviceScaleFactor: 1, mobile: width < 500 });
      await evaluate(`new Promise((done) => setTimeout(done, 600))`);
      // a desktop window is used with a mouse at any width: touch targets are the phone gallery's to check
      report[name] = await evaluate(`((__name) => (${auditLayout.toString()}))((f) => f)({ touch: false, scopeSelector: "[data-simple-rows], [data-composer-dock]" })`);
      const shot = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(evidence, `electron-cards-${name}.png`), Buffer.from(shot.result.data, "base64"));
    }
    writeFileSync(join(evidence, "electron-report.json"), JSON.stringify(report, null, 2));
    const hard = Object.entries(report).flatMap(([name, issues]) => issues.filter((issue) => issue.hard).map((issue) => `${name}: ${issue.kind} ${issue.where}: ${issue.detail}`));
    expect(hard).toEqual([]);
  } finally {
    writeFileSync(join(evidence, "electron-log.txt"), log);
    socket?.close();
    if (electron && electron.exitCode === null) { electron.kill("SIGTERM"); await waitForExit(electron).catch(() => undefined); }
    await vite?.close();
    await fixture?.close();
  }
}, 600_000);
