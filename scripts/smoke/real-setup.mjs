// The real-setup smoke: this checkout's desktop app, isolated and invisible (scripts/smoke/app.mjs), against the real
// backends the owner uses: the preview account service, the owner's own server (paired as its own device over an ssh
// tunnel, read-mostly) and its bots, Composio's real connect flow. Every step passes or fails with a screenshot; the
// run writes report.md and report.json.
//
//   node scripts/smoke/real-setup.mjs [--root DIR] [--out DIR] [--profile DIR] [--fresh-sign-in] [--only a,b]
//
// Writes to the owner's server: one paired session labelled "madani smoke" (first run only), one short message to the
// smoke bot (MADANI_SMOKE_BOT, a test bot) per run, and take control / hand back on that bot's screen. Nothing is deleted.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchSmokeApp, OWNER_PORTS, until } from "./app.mjs";
import { envValue, smokeAccount } from "./account.mjs";
import { compare as compareOwner, snapshot as snapshotOwner } from "./owner-guard.mjs";

const args = process.argv.slice(2);
const option = (name, fallback = null) => { const at = args.indexOf(name); return at === -1 ? fallback : args[at + 1] ?? fallback; };
const flag = (name) => args.includes(name);
const root = resolve(option("--root", join(dirname(fileURLToPath(import.meta.url)), "..", "..")));
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = resolve(option("--out", join(root, ".madani-scratch", "smoke", stamp)));
// kept between runs (the paired server session, today's account session): outside any checkout
const profile = resolve(option("--profile", process.env.MADANI_SMOKE_PROFILE || join(homedir(), ".cache", "madani-smoke", "profile")));
const only = option("--only")?.split(",") ?? null;
const SSH_HOST = process.env.MADANI_SMOKE_SSH_HOST || "oracle";
const SERVER_USER = process.env.MADANI_SMOKE_SERVER_USER || "maus";
const SERVER_PORT = Number(process.env.MADANI_SMOKE_SERVER_PORT || 8799);
const TUNNEL_PORT = Number(process.env.MADANI_SMOKE_TUNNEL_PORT || 7462);
const BOT = process.env.MADANI_SMOKE_BOT || "Nova";
const EMAIL = process.env.MADANI_SMOKE_EMAIL || "qa-smoke@qa.madani.test";
const SERVER_ORIGIN = `http://127.0.0.1:${TUNNEL_PORT}`;
const PROVIDER_HOSTS = ["connect.composio.dev", "backend.composio.dev", "accounts.google.com", "app.composio.dev"];
const RAW_ERROR = /\bundefined\b|\bNaN\b|\[object Object\]|TypeError|ReferenceError|SyntaxError|Unexpected token|Something went wrong|Cannot read prop|is not a function|ECONNREFUSED|Internal Server Error/;
if (OWNER_PORTS.has(TUNNEL_PORT)) throw new Error(`the tunnel port ${TUNNEL_PORT} is the owner's`);
mkdirSync(out, { recursive: true });
mkdirSync(profile, { recursive: true });

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const t0 = Date.now();
const results = [];
const facts = {};
let app = null, tunnel = null, shotCount = 0, accountState = null, accountClient = null;
const log = (line) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${line}`);

async function shot(name) {
  if (!app) return null;
  const file = join(out, `${String(++shotCount).padStart(2, "0")}-${name}.png`);
  try { await app.screenshot(file); return file; } catch { return null; }
}

/** one step: pass, fail or skip, its note and screenshot; `critical` stops the run on failure */
async function step(id, title, fn, { critical = false } = {}) {
  if (only && !only.includes(id)) return;
  const started = Date.now();
  const entry = { id, title, status: "pass", note: "", ms: 0, shot: null, issues: [] };
  try {
    const result = await fn(entry);
    if (typeof result === "string") entry.note = result;
  } catch (error) {
    entry.status = error?.skip ? "skip" : "fail";
    entry.note = String(error?.message ?? error).split("\n")[0].slice(0, 400);
  }
  if (app && entry.status !== "skip") {
    const hidden = app.onScreen();
    if (hidden.length) { entry.status = "fail"; entry.note = `a smoke window was on a display (${hidden[0].title}); ${entry.note}`; }
  }
  entry.ms = Date.now() - started;
  entry.shot ??= await shot(id);
  results.push(entry);
  log(`${entry.status.toUpperCase().padEnd(4)} ${title}${entry.note ? `: ${entry.note}` : ""}`);
  if (critical && entry.status === "fail") throw Object.assign(new Error(`stopped: ${title} failed`), { stopped: true });
}
const skip = (why) => Object.assign(new Error(why), { skip: true });

// page helpers, run inside the app's main window
const js = (value) => JSON.stringify(value);
const evaluate = (expression) => app.evaluate(expression);
const visibleText = (scope = "body") => evaluate(`(document.querySelector(${js(scope)})?.innerText ?? "")`);
async function click(text, { contains = false, scope = "body", timeout = 15_000 } = {}) {
  return until(() => evaluate(`(() => {
    const want = ${js(text.toLowerCase())}, scope = document.querySelector(${js(scope)}) ?? document;
    const match = (s) => { s = (s || "").trim().replace(/\\s+/g, " ").toLowerCase(); return ${contains ? "s.includes(want)" : "s === want"}; };
    const el = [...scope.querySelectorAll("button,a,[role=button],[role=menuitem],[role=tab],[role=option],[role=radio],[role=switch]")]
      .filter((e) => e.getClientRects().length && !e.disabled).find((e) => match(e.getAttribute("aria-label")) || match(e.innerText));
    if (!el) return false;
    el.click();
    return true;
  })()`), { timeout, what: `"${text}" to click` });
}
const clickSelector = (selector, timeout = 15_000) => until(() => evaluate(`(() => { const el = document.querySelector(${js(selector)}); if (!el || !el.getClientRects().length) return false; el.click(); return true; })()`), { timeout, what: selector });
const waitFor = (expression, what, timeout = 20_000) => until(() => evaluate(expression), { timeout, what });
const press = async (key, code = key, keyCode = 0) => {
  await app.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode });
  await app.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
};
const escape = () => press("Escape", "Escape", 27);
const viewport = (width, height = 800) => app.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });

let auditSource = null;
/** the chat gallery's layout check (overlap, clipping, offscreen, contrast) in the scope given: hard issues fail the step */
async function audit(entry, scopeSelector) {
  if (!auditSource) {
    const { auditLayout } = await import("../testing/chat-gallery/layout-audit.ts");
    auditSource = auditLayout.toString();
  }
  const issues = await evaluate(`((__name) => (${auditSource}))((f) => f)({ touch: false, scopeSelector: ${js(scopeSelector)} })`);
  entry.issues.push(...issues.map((issue) => ({ ...issue, scope: scopeSelector })));
  // an emoji's "contrast" is its own artwork, not text on a background
  for (const issue of issues) if (issue.kind === "contrast" && !/"[^"]*\p{L}[^"]*"/u.test(`${issue.where} ${issue.detail}`)) issue.hard = false;
  const hard = issues.filter((issue) => issue.hard);
  if (hard.length) throw new Error(`layout: ${hard.slice(0, 3).map((issue) => `${issue.kind} ${issue.where}: ${issue.detail}`).join("; ")}`);
}
async function noRawErrors(scope = "body") {
  const text = await visibleText(scope);
  const found = RAW_ERROR.exec(text);
  if (found) throw new Error(`raw error text on screen: "${text.slice(Math.max(0, found.index - 60), found.index + 60).replace(/\s+/g, " ")}"`);
}

function ssh(command, timeout = 60_000) {
  return new Promise((done, fail) => {
    const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", SSH_HOST, command], { stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    child.stdout.on("data", (chunk) => { text += chunk; });
    child.stderr.on("data", (chunk) => { text += chunk; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); fail(new Error(`ssh ${SSH_HOST} timed out`)); }, timeout);
    child.once("exit", (code) => { clearTimeout(timer); if (code === 0) done(text); else fail(new Error(`ssh ${SSH_HOST} exited ${code}: ${text.slice(0, 200)}`)); });
  });
}
const asServer = (command) => `sudo -n -u ${SERVER_USER} sh -c ${js(`cd ~ && ${command}`)}`;
/** a single-use pairing code minted on the owner's server for this device; the code itself is never printed */
async function pairingCode() {
  const text = await ssh(asServer(`~/.local/bin/madanibot pair --label "madani smoke" 2>&1`));
  const code = /\b([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(text)?.[1];
  if (!code) throw new Error("the server did not print a pairing code");
  return code;
}
async function openTunnel() {
  const busy = await new Promise((done) => { const socket = connect(TUNNEL_PORT, "127.0.0.1"); socket.once("connect", () => { socket.destroy(); done(true); }); socket.once("error", () => done(false)); });
  if (busy) throw new Error(`port ${TUNNEL_PORT} is taken; stop what holds it or set MADANI_SMOKE_TUNNEL_PORT`);
  tunnel = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-N", "-L", `${TUNNEL_PORT}:127.0.0.1:${SERVER_PORT}`, SSH_HOST], { stdio: "ignore" });
  await until(() => fetch(`${SERVER_ORIGIN}/api/health`).then((response) => response.ok, () => false), { timeout: 30_000, what: "the tunnel to the owner's server" });
}

function readJson(file) { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } }
/** the smoke app opens on This computer: the server it paired with stays saved, but is not where it starts */
function startOnThisComputer() {
  for (const name of ["environments.json", "environments-staging.json"]) {
    const file = join(profile, "electron", name);
    const saved = readJson(file);
    if (saved?.activeId) { saved.activeId = null; writeFileSync(file, JSON.stringify(saved, null, 2)); }
  }
}

async function cleanup() {
  await app?.close().catch(() => {});
  app = null;
  if (tunnel && tunnel.exitCode === null) tunnel.kill("SIGTERM");
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => { void cleanup().finally(() => process.exit(130)); });

function report() {
  const counts = { pass: 0, fail: 0, skip: 0 };
  for (const entry of results) counts[entry.status]++;
  const ok = counts.fail === 0 && results.length > 0;
  const json = { ok, root, commit: facts.commit, startedAt: new Date(t0).toISOString(), seconds: Math.round((Date.now() - t0) / 1000), counts, facts, steps: results };
  writeFileSync(join(out, "report.json"), `${JSON.stringify(json, null, 2)}\n`);
  const lines = [
    `# real-setup smoke: ${ok ? "pass" : "FAIL"}`, "",
    `commit ${facts.commit ?? "?"}, ${json.seconds}s, ${counts.pass} passed, ${counts.fail} failed, ${counts.skip} skipped`, "",
    "| step | result | note | screenshot |", "| --- | --- | --- | --- |",
    ...results.map((entry) => `| ${entry.title} | ${entry.status} | ${entry.note.replace(/\|/g, "/")} | ${entry.shot ? entry.shot.split("/").pop() : ""} |`),
    "", "## facts", "", ...Object.entries(facts).map(([key, value]) => `- ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`),
  ];
  const soft = results.flatMap((entry) => entry.issues.filter((issue) => !issue.hard).map((issue) => `- ${entry.id}: ${issue.kind} ${issue.where}: ${issue.detail}`));
  if (soft.length) lines.push("", "## layout notes (soft)", "", ...soft.slice(0, 40));
  writeFileSync(join(out, "report.md"), `${lines.join("\n")}\n`);
  return ok;
}

async function main() {
  facts.commit = await new Promise((done) => { const git = spawn("git", ["rev-parse", "--short", "HEAD"], { cwd: root }); let text = ""; git.stdout.on("data", (c) => { text += c; }); git.once("exit", () => done(text.trim() || null)); });
  facts.appVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  log(`checkout ${root} (${facts.commit}), evidence in ${out}`);

  await step("app-starts", "the app starts, isolated and offscreen", async () => {
    startOnThisComputer();
    app = await launchSmokeApp({ root, profile, log });
    await viewport(1280, 820);
    // a first run walks the welcome; a returning profile lands in a chat
    const first = await waitFor(`document.querySelector('textarea[aria-label^="Message"]') ? "chat" : /get started|where should your bots live/i.test(document.body.innerText) ? "welcome" : false`, "the welcome or a chat", 120_000);
    if (first === "welcome") {
      for (const [text, contains] of [["get started", false], ["this mac", true], ["set up later", false], ["continue", false], ["skip", false]]) {
        await click(text, { contains, timeout: 20_000 }).catch(() => {});
        await sleep(1200);
      }
    }
    await waitFor(`Boolean(document.querySelector('textarea[aria-label^="Message"]'))`, "the chat composer", 60_000);
    await noRawErrors();
    return first === "welcome" ? "first run: walked the welcome" : "returning profile";
  }, { critical: true });

  await step("sign-in", "signs in to the preview account service", async () => {
    const { client, state, how } = await smokeAccount({ root, profile, email: EMAIL, force: flag("--fresh-sign-in"), appVersion: facts.appVersion });
    accountClient = client;
    facts.account = { email: EMAIL, status: state.status, clouds: state.clouds?.length ?? 0 };
    accountState = state;
    return `${how} (the dev app shows no account sign-in; the packaged app's client signed in)`;
  });

  await step("my-cloud", "the account's My Cloud answers (read-only)", async () => {
    const state = accountState;
    if (!state) throw skip("not signed in");
    if (!state.clouds?.length) throw skip(`${EMAIL} has no cloud on preview`);
    const cloud = state.clouds[0];
    const origin = cloud.origin ?? cloud.machine?.origin;
    if (!origin) throw new Error(`the cloud is listed without an address (${cloud.status ?? "no status"})`);
    // a read never wakes a home: one asleep (x-madani-cloud-power: asleep) is woken the way the app does on a click, through
    // the account service, then read until it answers; a wake under way is waited out. Up to 3 minutes either way.
    const started = Date.now();
    let health, waited = false, woke = null;
    for (;;) {
      health = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(30_000) });
      const power = health.status === 503 ? health.headers.get("x-madani-cloud-power") : null;
      if (!power || Date.now() - started > 180_000) break;
      if (power === "asleep" && woke === null) woke = await accountClient?.wakeHome("click").catch(() => null) ?? "no client";
      waited = true;
      await sleep(3_000);
    }
    facts.myCloud = { origin, health: health.status, wake: woke, wokeInSeconds: waited ? Math.round((Date.now() - started) / 1000) : 0 };
    if (!health.ok) throw new Error(`${origin} answered ${health.status}${waited ? ` after ${facts.myCloud.wokeInSeconds} s (wake asked: ${woke ?? "no"})` : ""}`);
    return `${origin} healthy${waited ? ` (woke in ${facts.myCloud.wokeInSeconds} s)` : ""}`;
  });

  await step("settings", "every settings page opens without raw errors or overlaps", async (entry) => {
    await viewport(1280, 820);
    await openSettings();
    const sections = await evaluate(`[...document.querySelector("[role=dialog]").querySelectorAll("nav button, [role=tablist] button, aside button")].map((b) => b.innerText.trim()).filter(Boolean)`);
    if (sections.length < 3) throw new Error(`settings lists ${sections.length} pages`);
    const failed = [];
    for (const section of sections) {
      try {
        await click(section, { scope: "[role=dialog]" });
        await sleep(900);
        await noRawErrors("[role=dialog]");
        await audit(entry, "[role=dialog]");
      } catch (error) { failed.push(`${section}: ${error.message}`); await shot(`settings-${section.replace(/\W+/g, "-")}`); }
    }
    await escape();
    if (failed.length) throw new Error(failed.join(" | "));
    return `${sections.length} pages: ${sections.join(", ")}`;
  });

  await step("settings-fit", "the settings dialog fits and stays centred at 1000 and 760 wide", async () => {
    const checked = [];
    await viewport(1280, 820);
    await openSettings();
    for (const width of [1000, 760]) {
      await viewport(width, 700);
      await sleep(700);
      const box = await evaluate(`(() => {
        const d = [...document.querySelectorAll("[role=dialog]")].filter((e) => e.getClientRects().length).pop();
        if (!d) return null;
        const r = d.getBoundingClientRect();
        const outside = [...d.querySelectorAll("button,[role=switch],input,select")].filter((e) => { const b = e.getBoundingClientRect(); return b.width && (b.right > Math.min(innerWidth, r.right) + 1 || b.left < Math.max(0, r.left) - 1); }).map((e) => (e.innerText || e.getAttribute("aria-label") || "").trim().slice(0, 24));
        return { left: Math.round(r.left), right: Math.round(innerWidth - r.right), top: Math.round(r.top), bottom: Math.round(innerHeight - r.bottom), outside };
      })()`);
      await shot(`settings-${width}`);
      if (!box) throw new Error(`at ${width} wide the settings dialog closed`);
      if (box.left < 0 || box.right < 0 || box.top < 0 || box.bottom < 0) throw new Error(`at ${width} wide the dialog leaves the window (${JSON.stringify(box)})`);
      if (Math.abs(box.left - box.right) > 2) throw new Error(`at ${width} wide the dialog is off centre (${box.left}px left, ${box.right}px right)`);
      if (box.outside.length) throw new Error(`at ${width} wide controls sit outside the dialog: ${box.outside.join(", ")}`);
      checked.push(`${width}: ${box.left}px each side`);
    }
    await escape();
    await viewport(1280, 820);
    return checked.join(", ");
  });

  await step("add-server", "the add-a-server sheet renders", async (entry) => {
    await openSettings();
    await click("computer", { scope: "[role=dialog]" });
    await clickSelector('[data-settings-open="add-workspace"]');
    await waitFor(`Boolean(document.querySelector('[data-settings-block="add-place"]'))`, "the add-a-place page");
    await clickSelector('[data-settings-open="add-own-server"]');
    await waitFor(`Boolean(document.querySelector('[data-settings-block="add-place-server"]'))`, "the add-a-server sheet");
    // the page slides in: judge it once it has settled
    await sleep(1500);
    await noRawErrors("[role=dialog]");
    entry.shot = await shot("add-server");
    await audit(entry, "[role=dialog]");
    await escape();
  });

  let serverOpen = false;
  await step("server", "pairs with the owner's server and opens its bots", async () => {
    await openTunnel();
    facts.serverVersion = (await fetch(`${SERVER_ORIGIN}/api/version`).then((r) => (r.ok ? r.json() : null), () => null))?.version
      ?? (await ssh(asServer("node -p \"require(process.env.HOME + '/.local/lib/node_modules/madanibot/package.json').version\""))).trim();
    const environments = await evaluate(`window.madaniDesktop.environments.state()`);
    const saved = environments?.environments?.find((e) => e.origin === SERVER_ORIGIN);
    // the window navigates away while these answer: fire them, then follow the window
    if (saved) await evaluate(`void window.madaniDesktop.environments.switch(${js(saved.id)}); true`);
    else await evaluate(`void window.madaniDesktop.environments.addFromLink(${js(`${SERVER_ORIGIN}/pair#code=${await pairingCode()}`)}, "owner server (smoke)"); true`);
    await app.reattach(SERVER_ORIGIN);
    await viewport(1280, 820);
    let how = saved ? "kept its paired session" : "paired as its own device";
    const view = await waitFor(`document.querySelector('textarea[aria-label^="Message"]') ? "app" : /pairing code/i.test(document.body.innerText) ? "pair" : false`, "the server's app or its pairing page", 60_000);
    if (view === "pair") {
      // the saved session ended (revoked or expired): pair again
      await evaluate(`location.href = ${js(`${SERVER_ORIGIN}/pair#code=${await pairingCode()}`)}; true`);
      await sleep(3000);
      await app.reattach(SERVER_ORIGIN);
      await viewport(1280, 820);
      how = "paired again (its session had ended)";
    }
    await waitFor(`Boolean(document.querySelector('textarea[aria-label^="Message"]'))`, "the server's chat", 60_000);
    serverOpen = true;
    return `${how}; server ${facts.serverVersion}`;
  }, { critical: false });

  const needServer = () => { if (!serverOpen) throw skip("the owner's server did not open"); };

  await step("chat", `a real bot (${BOT}) answers`, async (entry) => {
    needServer();
    await click(BOT, { contains: false, scope: "nav, aside, [data-sidebar], body" }).catch(() => click(BOT, { contains: true }));
    await waitFor(`document.querySelector('textarea[aria-label^="Message"]')?.getAttribute("aria-label") === ${js(`Message ${BOT}`)}`, `${BOT}'s chat`);
    const marker = `smoke ${stamp.slice(11)}`;
    const message = `Reply with just the word ok. (${marker})`;
    await evaluate(`document.querySelector('textarea[aria-label^="Message"]').focus(); true`);
    await app.send("Input.insertText", { text: message });
    await press("Enter", "Enter", 13);
    const outcome = await waitFor(`(() => {
      const rows = document.querySelector("[data-simple-rows]")?.innerText ?? "";
      const at = rows.lastIndexOf(${js(marker)});
      if (at < 0) return false;
      const after = rows.slice(at + ${marker.length + 1}).replace(/\\b\\d{1,2}:\\d{2}\\b/g, "").trim();
      if (/connect an ai|sign in with|needs an ai|no ai|add an ai/i.test(after)) return "needs-ai";
      if (/failed|error|went wrong|couldn.t/i.test(after)) return "error:" + after.slice(0, 160);
      return /\\bok\\b/i.test(after) ? "reply:" + after.slice(0, 80) : false;
    })()`, `${BOT}'s reply`, 180_000);
    entry.shot = await shot("chat");
    await noRawErrors("[data-simple-rows]");
    await audit(entry, "[data-simple-rows], [data-composer-dock]");
    if (outcome.startsWith("error:")) throw new Error(`the bot answered with an error: ${outcome.slice(6)}`);
    return outcome === "needs-ai" ? "the bot asks for an AI account (accepted)" : `replied "${outcome.slice(6).replace(/\s+/g, " ")}"`;
  });

  await step("computer", `${BOT}'s computer: take control and hand back`, async (entry) => {
    needServer();
    await click("computer", { scope: "body" });
    await sleep(1200);
    if (/computer is asleep/i.test(await visibleText())) { await click("computer is asleep", { contains: true }); }
    await click("open", { timeout: 90_000 });
    await click("take control", { timeout: 60_000 });
    await waitFor(`/you.re in control/i.test(document.body.innerText)`, "control of the screen", 30_000);
    entry.shot = await shot("computer-control");
    await click("stop");
    await waitFor(`/take control/i.test(document.body.innerText) && !/you.re in control/i.test(document.body.innerText)`, "the screen handed back", 30_000);
    await click("exit fullscreen").catch(() => {});
    await noRawErrors();
  });

  await step("routines", `${BOT}'s routine list loads`, async (entry) => {
    needServer();
    await click("details");
    await waitFor(`Boolean(document.querySelector('[data-panel-card="routines"], [data-panel-empty="routines"]'))`, "the routine list", 20_000);
    entry.shot = await shot("routines");
    await noRawErrors();
    const count = await evaluate(`document.querySelector('[data-panel-card="routines"]')?.querySelectorAll("button").length ?? 0`);
    return count ? "listed" : "no routines (empty state shown)";
  });

  await step("connect-apps", "connect apps opens and Gmail's connect reaches the provider page", async (entry) => {
    needServer();
    const before = app.events().length;
    await click("connect apps");
    await waitFor(`[...document.querySelectorAll("[role=dialog]")].some((d) => d.getClientRects().length && /connect apps/i.test(d.innerText))`, "the connect apps window");
    await sleep(800);
    await audit(entry, "[role=dialog]");
    await click("connect gmail");
    const opened = await until(() => app.events().slice(before).find((event) => event.kind === "open-external"), { timeout: 45_000, what: "Gmail's connect page" });
    entry.shot = await shot("connect-apps");
    const url = new URL(opened.url);
    if (!PROVIDER_HOSTS.includes(url.hostname)) throw new Error(`connect opened ${url.hostname}, not a provider page`);
    const page = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
    if (page.status >= 400) throw new Error(`${url.hostname} answered ${page.status}`);
    await escape();
    return `${url.hostname} answered ${page.status}`;
  });

  await step("relay", "the owner's server is reached directly or through Cloudflare", async () => {
    const paths = [];
    // the owner's own app record: which way its link takes (read-only, no keys)
    const ownerLink = readJson(join(homedir(), "Library", "Application Support", "madanibot", "vps-link.json"));
    const link = ownerLink?.links?.find((entry) => entry.id === ownerLink.current) ?? ownerLink?.links?.[0];
    if (link) {
      facts.ownerLink = { mode: link.mode, base: link.base, direct: link.direct ? `${link.direct.user}@${link.direct.host}:${link.direct.port}` : null };
      if (!link.direct && link.mode !== "cloudflare") throw new Error(`the owner's link is ${link.mode} only: no direct or Cloudflare path`);
      if (link.direct) {
        const reachable = await new Promise((done) => { const socket = connect(link.direct.port, link.direct.host); socket.setTimeout(8000, () => { socket.destroy(); done(false); }); socket.once("connect", () => { socket.destroy(); done(true); }); socket.once("error", () => done(false)); });
        if (!reachable) throw new Error(`the direct path ${link.direct.host}:${link.direct.port} does not answer`);
        paths.push(`direct ssh ${link.direct.host}:${link.direct.port}`);
      }
      if (link.base) {
        const health = await fetch(`${link.base}/health`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
        paths.push(`link service ${new URL(link.base).host} ${health?.status ?? "unreachable"}`);
      }
    } else paths.push("no owner link on this Mac");
    const relay = envValue("MADANI_CF_RELAY_URL");
    if (relay) {
      const health = await fetch(new URL("/health", relay), { signal: AbortSignal.timeout(10_000) }).catch(() => null);
      paths.push(`Cloudflare relay ${health ? health.status : "unreachable"}`);
      if (!health || health.status >= 500) throw new Error(`the Cloudflare relay ${health ? `answered ${health.status}` : "does not answer"}`);
    }
    paths.push(`this smoke: direct (ssh tunnel to ${SSH_HOST})`);
    return paths.join("; ");
  });
}

async function openSettings() {
  await escape().catch(() => {});
  await sleep(300);
  const open = await evaluate(`Boolean([...document.querySelectorAll("[role=dialog]")].find((d) => d.getClientRects().length && /general/i.test(d.innerText)))`);
  if (open) return;
  // the account button sits beside Connect apps at the sidebar's foot; its label is an initial or empty
  await until(() => evaluate(`(() => {
    const shown = [...document.querySelectorAll("button")].filter((b) => b.getClientRects().length);
    const apps = shown.find((b) => /^connect apps/i.test(b.innerText.trim()));
    if (!apps) return false;
    const row = apps.getBoundingClientRect();
    const you = shown.find((b) => b !== apps && Math.abs(b.getBoundingClientRect().top - row.top) < 24 && b.getBoundingClientRect().right <= row.left + 4);
    you?.click();
    return Boolean(you);
  })()`), { timeout: 15_000, what: "the account button" });
  await click("settings", { timeout: 10_000, scope: "[role=menu]" }).catch(() => click("settings", { timeout: 5_000 }));
  await waitFor(`Boolean([...document.querySelectorAll("[role=dialog]")].find((d) => d.getClientRects().length))`, "the settings dialog");
}

let failedHard = false;
const ownerBefore = snapshotOwner();
try {
  await main();
} catch (error) {
  if (!error?.stopped) { failedHard = true; console.error(error); }
} finally {
  if (app) writeFileSync(join(out, "app-output.txt"), app.output().slice(-200_000));
  await cleanup();
}
// after the app is gone: the owner's app, config and logs are as they were
await sleep(1500);
const ownerProblems = compareOwner(ownerBefore, ["oracle smoke", "owner server (smoke)", "madani smoke", `127.0.0.1:${TUNNEL_PORT}`, "madani-smoke", profile]);
results.push({ id: "owner-untouched", title: "the owner's app, config and logs are untouched", status: ownerProblems.length ? "fail" : "pass",
  note: ownerProblems.join("; ").slice(0, 600), ms: 0, shot: null, issues: [] });
log(`${ownerProblems.length ? "FAIL" : "PASS"} the owner's app, config and logs are untouched${ownerProblems.length ? `: ${ownerProblems.join("; ")}` : ""}`);
const ok = report() && !failedHard;
log(`${ok ? "PASS" : "FAIL"}: ${join(out, "report.md")}`);
process.exit(ok ? 0 : 1);
