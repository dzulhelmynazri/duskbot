// Two real clients on one workspace: the desktop renderer and the phone app, each in its own headless Chrome, against an
// isolated fixture with the fake engine. What one does, the other must show.
//
//   node --experimental-strip-types scripts/mobile-two-client-e2e.ts
//
// It starts its own fixture and its own two dev servers on free ports and never touches a running app. The phone page
// reaches the fixture as a same-origin client; the bearer, relay and companion routes are covered by
// scripts/mobile-sync-e2e.ts and the unit tests beside src/mobile/transport.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WELCOME_VERSION } from "../electron/onboarding-record.mjs";
import { openHeadlessChrome, type HeadlessPage } from "./testing/headless-chrome.ts";

const results: Array<{ step: string; ok: boolean }> = [];
function check(step: string, ok: boolean, detail = "") {
  results.push({ step, ok });
  console.log(`${ok ? "ok  " : "FAIL"} ${step}${detail ? `: ${detail}` : ""}`);
}
const children: ChildProcess[] = [];
const cleanups: Array<() => unknown> = [];

const freePort = () => new Promise<number>((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => resolve(port)); });
});

function start(args: string[], env: Record<string, string> = {}): ChildProcess {
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  children.push(child);
  return child;
}

function printed(child: ChildProcess, pattern: RegExp, what: string, ms = 120_000): Promise<RegExpExecArray> {
  return new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error(`${what} did not start within ${ms / 1000} s: ${text.slice(-300)}`)), ms);
    const read = (chunk: Buffer) => {
      text += chunk.toString();
      const match = pattern.exec(text);
      if (match) { clearTimeout(timer); resolve(match); }
    };
    child.stdout!.on("data", read);
    child.stderr!.on("data", read);
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`${what} exited ${code}: ${text.slice(-300)}`)); });
  });
}

async function waitFor(what: () => Promise<boolean>, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    if (await what().catch(() => false)) return true;
    if (Date.now() > until) return false;
    await delay(200);
  }
}

const shows = (page: HeadlessPage, text: string, ms = 20_000) => waitFor(() => page.evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`), ms);
const gone = (page: HeadlessPage, text: string, ms = 20_000) => waitFor(async () => !(await page.evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`)), ms);
const clickText = (page: HeadlessPage, text: string, within = "document") => page.evaluate(`(() => {
  const all = [...${within}.querySelectorAll("button, a, [role=button], [role=option], [role=treeitem]")];
  const hit = all.filter((el) => el.innerText && el.innerText.includes(${JSON.stringify(text)})).sort((a, b) => a.innerText.length - b.innerText.length)[0];
  if (!hit) return false;
  hit.click();
  return true;
})()`);

/** A real pointer press on the smallest thing showing `text`: the desktop's rows answer the pointer, not a synthetic click. */
async function press(page: HeadlessPage, text: string): Promise<boolean> {
  const at = await page.evaluate(`(() => {
    const hits = [...document.querySelectorAll("body *")].filter((el) => el.offsetParent !== null && el.innerText && el.innerText.trim() === ${JSON.stringify(text)});
    const hit = hits.sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length)[0];
    if (!hit) return null;
    hit.scrollIntoView({ block: "center" });
    const box = hit.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  })()`);
  if (!at) return false;
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: type === "mouseMoved" ? "none" : "left", clickCount: type === "mouseMoved" ? 0 : 1 });
  return true;
}
const composerFor = (page: HeadlessPage, name: string) => waitFor(() => page.evaluate(`[...document.querySelectorAll("textarea")].some((el) => el.offsetParent !== null && el.placeholder.includes(${JSON.stringify(name)}))`), 20_000);

/** Types into the page's chat composer (never another field, such as the desktop's new-job box) as a person would (React reads the native setter and the input event) and presses Enter. */
async function send(page: HeadlessPage, text: string, scope = "document"): Promise<boolean> {
  const typed = await page.evaluate(`(() => {
    const field = [...${scope}.querySelectorAll("textarea")].filter((el) => el.offsetParent !== null && el.placeholder.startsWith("Message ")).pop();
    if (!field) return false;
    field.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, ${JSON.stringify(text)});
    field.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  if (!typed) return false;
  await delay(250);
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  return true;
}

async function main() {
  const fixture = start(["--experimental-strip-types", "scripts/control-madani.ts", "launch"], { FAKE_CLAUDE_REPLIES: JSON.stringify(["hello from the fixture bot"]) });
  const harness = (await printed(fixture, /"url":\s*"(http:\/\/127\.0\.0\.1:(\d+))"/, "the fixture"))[1]!;
  const harnessPort = new URL(harness).port;
  console.log(`fixture ${harness}`);
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${harness}${path}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  };
  const threadTexts = async (botId: string) => {
    const { body } = await api("GET", "/api/bots?messages=50");
    const bot = body.bots.find((one: { id: string }) => one.id === botId);
    return { bot, texts: (bot?.messages ?? []).filter((message: { role: string; kind: string }) => message.role === "user" && message.kind === "text").map((message: { text: string }) => message.text) as string[] };
  };

  // a workspace someone already set up: the desktop's welcome flow would otherwise sit over its chats
  await api("PATCH", "/api/config", { onboarding: { completedAt: new Date().toISOString(), version: WELCOME_VERSION, hintsSeen: [] }, language: "en" });
  const created = await api("POST", "/api/bots", { name: "Sync Bot", color: "teal" });
  check("create a bot in the fixture", created.status === 201, `${created.status}`);
  const botId: string = created.body.bot.id;

  const desktopPort = await freePort(), phonePort = await freePort();
  const desktopServer = start(["node_modules/vite/bin/vite.js"], { MADANI_PORT: harnessPort, MADANI_UI_PORT: String(desktopPort) });
  const phoneServer = start(["node_modules/vite/bin/vite.js", "--config", "apps/mobile/vite.config.ts"], { MADANI_PORT: harnessPort, MADANI_MOBILE_PORT: String(phonePort) });
  await Promise.all([printed(desktopServer, /ready in/, "the desktop page server"), printed(phoneServer, /ready in/, "the phone page server")]);

  const profiles = [mkdtempSync(join(tmpdir(), "madani-two-desktop-")), mkdtempSync(join(tmpdir(), "madani-two-phone-"))];
  cleanups.push(() => { for (const dir of profiles) rmSync(dir, { recursive: true, force: true }); });
  const desktop = await openHeadlessChrome(profiles[0]!);
  const phone = await openHeadlessChrome(profiles[1]!);
  cleanups.push(() => desktop.close(), () => phone.close());
  await desktop.send("Emulation.setDeviceMetricsOverride", { width: 1360, height: 860, deviceScaleFactor: 1, mobile: false });
  await phone.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await phone.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  // a page that is not in front reads no chat, on either client: both stay focused, as two people each at their own screen
  for (const page of [desktop, phone]) await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await desktop.send("Page.navigate", { url: `http://127.0.0.1:${desktopPort}/` });
  await phone.send("Page.navigate", { url: `http://127.0.0.1:${phonePort}/` });

  check("desktop lists the bot", await shows(desktop, "Sync Bot", 90_000));
  check("phone lists the bot", await shows(phone, "Sync Bot", 90_000));

  check("desktop opens the chat", await press(desktop, "Sync Bot") && await composerFor(desktop, "Sync Bot"));
  check("phone opens the chat", await clickText(phone, "Sync Bot") && await waitFor(() => phone.evaluate(`Boolean(document.querySelector("[data-mobile-chat] textarea"))`), 20_000));
  await delay(1200);

  const fromPhone = `from the phone ${randomUUID().slice(0, 8)}`;
  check("phone sends a message", await send(phone, fromPhone, `document.querySelector("[data-mobile-chat]")`));
  check("it shows on the phone at once", await shows(phone, fromPhone, 5000));
  check("it shows on the desktop", await shows(desktop, fromPhone));
  check("the bot's reply shows on the phone", await shows(phone, "hello from the fixture bot"));
  check("the bot's reply shows on the desktop", await shows(desktop, "hello from the fixture bot"));

  const fromDesktop = `from the desktop ${randomUUID().slice(0, 8)}`;
  check("desktop sends a message", await send(desktop, fromDesktop));
  const reachedServer = await waitFor(async () => (await threadTexts(botId)).texts.includes(fromDesktop), 15_000);
  check("it reaches the server", reachedServer);
  check("it shows on the phone", await shows(phone, fromDesktop));
  check("each message is stored once", await waitFor(async () => {
    const { texts } = await threadTexts(botId);
    return texts.filter((text) => text === fromPhone).length === 1 && texts.filter((text) => text === fromDesktop).length === 1;
  }, 10_000));

  // read state: with the chat open on the phone nothing stays unread; closed, a reply marks it; opening it reads it everywhere
  check("a reply read in the open phone chat is not left unread", await waitFor(async () => (await threadTexts(botId)).bot.unread === false, 15_000));
  await phone.evaluate(`document.querySelector("[data-mobile-chat] nav button").click()`);
  await delay(1500);
  const second = await api("POST", "/api/bots", { name: "Other Bot", color: "pink" });
  await shows(desktop, "Other Bot");
  check("desktop moves to another chat", await press(desktop, "Other Bot") && await composerFor(desktop, "Other Bot"));
  const nudge = `while both look elsewhere ${randomUUID().slice(0, 8)}`;
  await api("POST", `/api/bots/${botId}/messages`, { text: nudge, sendId: randomUUID() });
  check("a reply nobody is looking at is unread on the server", await waitFor(async () => (await threadTexts(botId)).bot.unread === true, 20_000));
  check("the phone's list marks the chat unread", await waitFor(() => phone.evaluate(`Boolean([...document.querySelectorAll("button[aria-label]")].find((el) => el.getAttribute("aria-label").includes("Sync Bot") && /unread/i.test(el.getAttribute("aria-label"))))`), 15_000));
  check("the phone's preview is the newest reply", await waitFor(() => phone.evaluate(`[...document.querySelectorAll("button")].some((el) => el.innerText.includes("Sync Bot") && el.innerText.includes("hello from the fixture bot"))`), 15_000));
  await clickText(phone, "Sync Bot");
  check("opening it on the phone reads it for every client", await waitFor(async () => (await threadTexts(botId)).bot.unread === false, 15_000));
  check("the desktop got the message sent while it looked elsewhere", await press(desktop, "Sync Bot") && await composerFor(desktop, "Sync Bot") && await shows(desktop, nudge));

  // bots changed on one side
  await api("PATCH", `/api/bots/${second.body.bot.id}`, { name: "Renamed Bot" });
  await phone.evaluate(`document.querySelector("[data-mobile-chat] nav button")?.click()`);
  check("a rename shows on the phone", await shows(phone, "Renamed Bot"));
  check("a rename shows on the desktop", await shows(desktop, "Renamed Bot"));
  await api("DELETE", `/api/bots/${second.body.bot.id}`);
  check("a deleted bot leaves the phone", await gone(phone, "Renamed Bot"));
  check("a deleted bot leaves the desktop", await gone(desktop, "Renamed Bot"));

  // the outbox: written with no connection, sent once when it returns
  await clickText(phone, "Sync Bot");
  await waitFor(() => phone.evaluate(`Boolean(document.querySelector("[data-mobile-chat] textarea"))`), 15_000);
  await delay(1000);
  await phone.send("Network.enable");
  await phone.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await delay(1500);
  const offline = `written offline ${randomUUID().slice(0, 8)}`;
  check("phone writes a message with no connection", await send(phone, offline, `document.querySelector("[data-mobile-chat]")`));
  check("it stays on the phone's screen", await shows(phone, offline, 5000));
  await delay(3000);
  check("and has not reached the server", !(await threadTexts(botId)).texts.includes(offline));
  check("it is still on screen while offline", await phone.evaluate(`document.body.innerText.includes(${JSON.stringify(offline)})`));
  await phone.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  check("back online, it reaches the server", await waitFor(async () => (await threadTexts(botId)).texts.includes(offline), 45_000));
  check("and the desktop", await shows(desktop, offline));
  await delay(6000);
  check("exactly once", (await threadTexts(botId)).texts.filter((text) => text === offline).length === 1);

  // back from the background: what happened meanwhile is there
  await phone.send("Page.setWebLifecycleState", { state: "frozen" });
  const meanwhile = `sent while the phone slept ${randomUUID().slice(0, 8)}`;
  await api("POST", `/api/bots/${botId}/messages`, { text: meanwhile, sendId: randomUUID() });
  await delay(4000);
  await phone.send("Page.setWebLifecycleState", { state: "active" });
  check("a phone back from the background shows what it missed", await shows(phone, meanwhile, 45_000));
}

try {
  await main();
} catch (error) {
  check("the run finished", false, error instanceof Error ? error.message : String(error));
} finally {
  for (const cleanup of cleanups.reverse()) { try { cleanup(); } catch {} }
  for (const child of children.reverse()) child.kill("SIGINT");
}
const failed = results.filter((one) => !one.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
