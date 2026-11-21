// A headless Chrome for the flow smokes: its own throwaway profile, mock keychain, never a window. Driven over the
// DevTools protocol like the smoke app. Used where the app hands the person to the browser (the account website).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { until } from "../app.mjs";
import { BROWSER_SIZE, typedWords, walkthrough } from "./recorder.mjs";

const CANDIDATES = [
  process.env.MADANI_SMOKE_CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
].filter(Boolean);

export function chromeBinary() {
  const found = CANDIDATES.find((file) => existsSync(file));
  if (!found) throw new Error("no Chrome or Chromium found (set MADANI_SMOKE_CHROME)");
  return found;
}

function connect(url) {
  const socket = new WebSocket(url);
  let next = 0;
  const waiting = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id) { waiting.get(message.id)?.(message); waiting.delete(message.id); }
  };
  const ready = new Promise((done, fail) => { socket.onopen = done; socket.onerror = () => fail(new Error("browser devtools socket failed")); });
  const send = (method, params = {}) => new Promise((done, fail) => {
    const id = ++next;
    const timer = setTimeout(() => { waiting.delete(id); fail(new Error(`${method} timed out`)); }, 60_000);
    waiting.set(id, (message) => { clearTimeout(timer); if (message.error) fail(new Error(`${method}: ${message.error.message}`)); else done(message.result); });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return { ready, send, close: () => socket.close() };
}

/** dir: where the profile lives (kept between runs only when given). Returns { goto, evaluate, text, click, screenshot, url, close }. */
export async function launchBrowser({ dir = null, width = BROWSER_SIZE.width, height = BROWSER_SIZE.height } = {}) {
  const profile = dir ?? mkdtempSync(join(process.env.TMPDIR || "/tmp", "madani-flow-chrome-"));
  mkdirSync(profile, { recursive: true });
  const child = spawn(chromeBinary(), [
    "--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--use-mock-keychain", "--password-store=basic",
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync", `--window-size=${width},${height}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"], detached: true });
  let output = "";
  child.stderr.on("data", (chunk) => { output += chunk; });
  const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch {} };
  process.once("exit", kill);
  const port = await until(() => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(output)?.[1], { timeout: 30_000, what: "headless Chrome" });
  const page = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page"), { what: "a Chrome page" });
  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  const evaluate = async (expression) => {
    const reply = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description?.split("\n")[0] ?? reply.exceptionDetails.text);
    return reply.result?.value;
  };
  // what the person does in the page: the walkthrough's caption for the next shot of it
  const send = (method, params = {}) => {
    if (method === "Input.insertText") walkthrough.did(typedWords(params.text ?? ""), "browser");
    return cdp.send(method, params);
  };
  const browser = {
    profile,
    wsUrl: page.webSocketDebuggerUrl,
    send,
    evaluate,
    url: () => evaluate("location.href"),
    text: () => evaluate("document.body?.innerText ?? ''"),
    async goto(url) { await cdp.send("Page.navigate", { url }); await until(() => evaluate("document.readyState === 'complete'"), { what: `${new URL(url).origin} to load` }); },
    /** clicks the first visible button or link whose text starts with `label` (case-insensitive) */
    click: (label, timeout = 20_000) => until(() => evaluate(`(() => {
      const want = ${JSON.stringify(label.toLowerCase())};
      const el = [...document.querySelectorAll("button,a,[role=button]")].filter((e) => e.getClientRects().length && !e.disabled)
        .find((e) => (e.innerText || e.getAttribute("aria-label") || "").trim().toLowerCase().replace(/\\s+/g, " ").startsWith(want));
      if (!el) return false; el.click(); return (el.innerText || el.getAttribute("aria-label") || "").trim().replace(/\\s+/g, " ").slice(0, 60) || true;
    })()`), { timeout, what: `"${label}" in the browser` }).then((said) => { walkthrough.did(`clicks "${typeof said === "string" ? said : label}"`, "browser"); return true; }),
    /** a child frame whose host contains `part` (same-site frames share the page's process), driven in an isolated
     *  world: { evaluate, send }; keyboard input goes to whatever the frame focused */
    async frame(part, timeout = 30_000) {
      const find = (node) => { if (node.frame.parentId && new URL(node.frame.url).host.includes(part)) return node.frame; for (const child of node.childFrames ?? []) { const hit = find(child); if (hit) return hit; } return null; };
      const frame = await until(async () => find((await cdp.send("Page.getFrameTree")).frameTree), { timeout, what: `a frame from ${part}` });
      const { executionContextId } = await cdp.send("Page.createIsolatedWorld", { frameId: frame.id, worldName: "madani-smoke" });
      return {
        send: cdp.send, close: () => {},
        async evaluate(expression) {
          const reply = await cdp.send("Runtime.evaluate", { expression, contextId: executionContextId, awaitPromise: true, returnByValue: true });
          if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description?.split("\n")[0] ?? reply.exceptionDetails.text);
          return reply.result?.value;
        },
      };
    },
    async screenshot(file) { const shot = await cdp.send("Page.captureScreenshot", { format: "png" }); writeFileSync(file, Buffer.from(shot.data, "base64")); return file; },
    async close() { await walkthrough.detachBrowser().catch(() => {}); cdp.close(); kill(); if (!dir) rmSync(profile, { recursive: true, force: true }); },
  };
  walkthrough.attachBrowser(browser);
  return browser;
}

/** the system-browser links the smoke app asked to open (the shim records them, never opens them) */
export function openedLinks(app, since = 0) {
  try {
    return readFileSync(app.eventsFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
      .filter((event) => event.kind === "open-external" && event.at >= since).map((event) => event.url);
  } catch { return []; }
}
