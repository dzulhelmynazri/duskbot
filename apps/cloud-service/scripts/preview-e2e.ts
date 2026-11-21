// @ts-nocheck: this live harness runs page.evaluate callbacks in the browser, and the server tsconfig has no DOM types
// A person's whole madani cloud journey on the deployed service, with both of their apps on screen: sign-up on the site,
// onboarding, a madani cloud plan, the cloud machine on InstaBox, the desktop app signing in and opening its cloud (the
// page its window loads, in headless Chromium), two bots, messages, a bot using its own computer's browser, a routine on
// schedule, the phone app (src/mobile web build) linked from the desktop and in sync with it, pause and resume, and
// everything deleted at the end. Every step is timed and written to --out.
//
//   INSTABOX_API_KEY=... MADANI_OPS_TOKEN=... PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs \
//     node apps/cloud-service/scripts/preview-e2e.ts --origin https://preview.madani.bot --out e2e.json [--state s.json] [--phase setup|run|teardown|all]
//
// Phases share --state (a 0600 file under the tmp dir) so the slow setup runs once while later steps are iterated on.
// Test-only parts, each listed in the results: a throwaway mail.tm inbox, the operator plan grant (checkout is closed on
// preview), a synthetic engine (no AI sign-in is available on a test cloud), and the desktop window's page driven in
// headless Chromium without the Electron shell around it.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CLOUD_HOME } from "../../../electron/legacy-names.mjs";
import { createCloudAccountClient } from "../../../electron/cloud-account.mjs";
import { cloudHomeConnectUrl } from "../../../electron/cloud-home.mjs";
import { openOwnerSession } from "../../../electron/cloud-send-main.mjs";
import type { CloudDesktopView } from "../../../shared/billing-api.ts";
import { createInstaboxProvider } from "../src/instabox.ts";

const args = process.argv.slice(2);
const option = (name: string) => { const at = args.indexOf(name); return at === -1 ? null : args[at + 1] ?? null; };
const origin = (option("--origin") ?? "https://preview.madani.bot").replace(/\/$/, "");
const out = resolve(option("--out") ?? "preview-e2e.json"), shots = resolve(option("--shots") ?? "preview-e2e-shots");
const statePath = resolve(option("--state") ?? join(tmpdir(), "madani-e2e-state.json"));
const phase = option("--phase") ?? "all";
const apiKey = process.env.INSTABOX_API_KEY, opsToken = process.env.MADANI_OPS_TOKEN;
if (!apiKey || !opsToken) { console.error("INSTABOX_API_KEY and MADANI_OPS_TOKEN are required."); process.exit(2); }
interface Cookie { name: string; value: string; httpOnly: boolean; secure: boolean; sameSite: string }
const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core") as { chromium: { launch(options: object): Promise<any> } };
const scope = process.env.MADANI_MANAGED_SCOPE ?? createHash("sha256").update(new URL(origin).origin).digest("hex").slice(0, 16);
const ibx = createInstaboxProvider({ apiKey, scope });
mkdirSync(shots, { recursive: true });

interface State { mail?: { address: string; password: string }; cloudId?: string; web?: unknown; app?: unknown; bots?: Array<{ id: string; threadId: string; name: string }> }
const state: State = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const keep = () => { writeFileSync(statePath, JSON.stringify(state)); chmodSync(statePath, 0o600); };

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const t0 = Date.now();
type Step = { name: string; ok: boolean; ms: number; at: number; error?: string; note?: string };
const results: Record<string, unknown> & { steps: Step[]; notes: string[] } = existsSync(out) && phase !== "setup" && phase !== "all"
  ? { ...JSON.parse(readFileSync(out, "utf8")) } : { origin, startedAt: new Date(t0).toISOString(), steps: [], notes: [] };
results.notes ??= [];
results.testOnly = ["throwaway mail.tm inbox", "operator plan grant (checkout closed on preview, nothing charged)",
  "synthetic engine answers the bots (no AI sign-in on a test cloud)", "the desktop window's page in headless Chromium, no Electron shell"];
const save = () => writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
const note = (text: string) => { results.notes.push(`[${phase}] ${text}`); console.log(`         note: ${text}`); save(); };
async function step<T>(name: string, fn: () => Promise<T>, critical = false): Promise<T | null> {
  const started = Date.now();
  try {
    const value = await fn();
    results.steps.push({ name: `[${phase}] ${name}`, ok: true, ms: Date.now() - started, at: Math.round((Date.now() - t0) / 1000) });
    console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ok   ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    save(); return value;
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).split("\nCall log")[0]!.slice(0, 400);
    results.steps.push({ name: `[${phase}] ${name}`, ok: false, ms: Date.now() - started, at: Math.round((Date.now() - t0) / 1000), error: message });
    console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] FAIL ${name}: ${message}`);
    save();
    if (critical) throw error;
    return null;
  }
}
// the test Mac's own network drops a request now and then; repeatable calls are tried again, as the app's retries do
async function again<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  for (let n = 1; ; n++) {
    try { return await fn(); } catch (error) { if (n >= tries || !/fetch failed|ETIMEDOUT|ECONNRESET|socket|network/i.test(String((error as Error)?.message ?? error) + String((error as { cause?: unknown })?.cause ?? ""))) throw error; await sleep(2000 * n); }
  }
}
async function until(what: () => Promise<boolean>, ms: number, every = 500): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) { if (await what().catch(() => false)) return true; if (Date.now() > end) return false; await sleep(every); }
}

// the throwaway inbox (mail.tm), kept in the state file so later phases read the same one
const mailtm = "https://api.mail.tm";
async function mt(path: string, init: RequestInit = {}, tries = 0): Promise<any> {
  let r: Response;
  try { r = await fetch(mailtm + path, { ...init, headers: { "content-type": "application/json", ...init.headers }, signal: AbortSignal.timeout(20_000) }); }
  catch (error) { if (tries < 8) { await sleep(2000 * (tries + 1)); return mt(path, init, tries + 1); } throw error; }
  if (r.status === 429 && tries < 8) { await sleep(1500 * (tries + 1)); return mt(path, init, tries + 1); }
  const text = await r.text(); if (!r.ok) throw new Error(`mail.tm ${path} ${r.status}`);
  return text ? JSON.parse(text) : {};
}
async function inbox() {
  if (!state.mail) {
    const domain = (await mt("/domains"))["hydra:member"][0].domain;
    state.mail = { address: `madani-e2e-${Date.now().toString(36)}@${domain}`, password: randomUUID() };
    await mt("/accounts", { method: "POST", body: JSON.stringify(state.mail) });
    keep();
  }
  const { token } = await mt("/token", { method: "POST", body: JSON.stringify(state.mail) });
  const auth = { authorization: `Bearer ${token}` }, seen = new Set<string>();
  return {
    address: state.mail.address,
    async code(since: number) {
      for (let i = 0; i < 60; i++) {
        for (const m of (await mt("/messages", { headers: auth }))["hydra:member"]) {
          if (seen.has(m.id) || Date.parse(m.createdAt) < since - 5000) continue;
          seen.add(m.id);
          const full = await mt(`/messages/${m.id}`, { headers: auth });
          const code = String(full.text ?? "").match(/\b\d{8}\b/)?.[0];
          if (code) return { code, from: full.from?.address as string, subject: String(full.subject ?? ""), ms: Date.now() - since };
        }
        await sleep(3000);
      }
      throw new Error("no code mailed within 3 minutes");
    },
    async subjects() { return ((await mt("/messages", { headers: auth }))["hydra:member"] as Array<{ subject: string; from: { address: string } }>).map(m => `${m.from?.address}: ${m.subject}`); },
    remove: async () => { await fetch(`${mailtm}/accounts/${(await mt("/me", { headers: auth })).id}`, { method: "DELETE", headers: auth }).catch(() => {}); },
  };
}

const mail = await inbox();
results.email = mail.address.replace(/^[^@]+/, "madani-e2e-…");
const browser = await chromium.launch({ headless: true, args: ["--use-mock-keychain", "--password-store=basic"] });
const web = await browser.newContext({ viewport: { width: 1280, height: 860 }, ...(state.web ? { storageState: state.web } : {}) });
const page = await web.newPage();
const shot = (p: any, name: string) => p.screenshot({ path: join(shots, `${name}.png`) }).catch(() => {});
const csrf = async () => ((await web.cookies(origin)) as Cookie[]).find(c => c.name === "madani_csrf")?.value ?? "";
async function account(method: string, path: string, body?: unknown) {
  const r = await web.request.fetch(`${origin}${path}`, { timeout: 120_000, method, headers: { origin, "x-madani-csrf": await csrf(), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { data: JSON.stringify(body) }) });
  const text = await r.text(); let data: any = text; try { data = JSON.parse(text); } catch {}
  if (!r.ok()) throw new Error(`${method} ${path} ${r.status()} ${text.slice(0, 200)}`);
  return data;
}
const cloudView = async () => {
  const clouds = (await again(() => account("GET", "/v1/clouds"))).clouds as CloudDesktopView[];
  return clouds.find(c => c.id === state.cloudId) ?? clouds[0];
};
// the desktop app's own account client, its saved session kept in the state file as main keeps it on disk
const client = createCloudAccountClient({ origin, custom: true, platform: "darwin", deviceName: "E2E test Mac", appVersion: "0.1.e2e",
  store: { read: async () => state.app ?? null, write: async (value: unknown) => { state.app = value; keep(); } }, openBrowser: async () => {} });
const cleanups: Array<() => unknown> = [];

async function signInWeb() {
  await step("website: signs in again with an emailed code (resumed run)", async () => {
    await page.goto(`${origin}/app/signin`);
    await page.locator("input[type=email]").waitFor();
    await page.fill("input[type=email]", mail.address);
    const sent = Date.now(); await page.click("button[type=submit]");
    const got = await mail.code(sent);
    await page.locator("input:visible").first().fill(got.code);
    await page.waitForURL((u: URL) => !/signin/.test(String(u)), { timeout: 20_000 });
    state.web = await web.storageState(); keep();
  }, true);
}

async function setup() {
  if (state.cloudId) { if (!state.web) await signInWeb(); return waitForCloud(); }
  await step("site: madani preview home loads through Cloudflare", async () => {
    const r = await page.goto(`${origin}/`);
    if (r?.status() !== 200 || r.headers()["server"] !== "cloudflare") throw new Error(`home ${r?.status()} via ${r?.headers()["server"]}`);
    await shot(page, "01-site");
  }, true);
  await step("site: the pricing page's plus plan opens sign-up with the plan", async () => {
    await page.goto(`${origin}/pricing`);
    await page.locator('a[href="/dashboard/signup?plan=plus"]').first().click();
    await page.waitForURL(/\/app\/signup\?plan=plus/);
    await page.locator("input[type=email]").waitFor();
    await shot(page, "02-signup");
  }, true);
  await step("sign-up: an emailed code from account@madani.bot makes the account", async () => {
    await page.fill("input[type=email]", mail.address);
    const sent = Date.now(); await page.click("button[type=submit]");
    const got = await mail.code(sent);
    if (got.from !== "account@madani.bot") throw new Error(`code came from ${got.from}`);
    results.codeMail = { ms: got.ms, subject: got.subject };
    await page.locator("input:visible").first().fill(got.code);
    await page.waitForURL(/\/app\/welcome/, { timeout: 20_000 });
    state.web = await web.storageState(); keep();
    await shot(page, "03-welcome");
  }, true);
  await step("onboarding: a name, then checkout says paid plans open soon", async () => {
    await page.locator("input:visible").first().fill("E2E Tester");
    await page.click("button[type=submit]");
    await page.getByText("paid plans open soon").waitFor({ timeout: 15_000 });
    await shot(page, "04-checkout-soon");
  }, true);
  await step("plan: the operator grants plus (same checkout and webhook path, nothing charged)", async () => {
    const r = await fetch(`${origin}/v1/billing/ops/grant`, { method: "POST", headers: { authorization: `Bearer ${opsToken}`, "content-type": "application/json" }, body: JSON.stringify({ email: mail.address, bundle: "starter", name: "E2E Cloud" }) });
    const body = await r.json() as { subscriptions?: Array<{ status: string; cloudId: string | null }> };
    if (!r.ok || body.subscriptions?.[0]?.status !== "active") throw new Error(`grant ${r.status}`);
    state.cloudId = body.subscriptions[0].cloudId ?? undefined; keep();
  }, true);
  await waitForCloud();
}

async function waitForCloud() {
  const timeline: Array<{ s: number; status: string; step: string | null }> = [];
  await step("cloud: the dashboard shows madani cloud provisioning, then running", async () => {
    const started = Date.now();
    await page.goto(`${origin}/app/`);
    let shotTaken = false;
    while (Date.now() - started < 25 * 60_000) {
      const cloud = await cloudView().catch((e: Error) => { console.log(`         poll error ${e.message.split("\n")[0]}`); return undefined; });
      if (cloud) {
        state.cloudId = cloud.id;
        const last = timeline.at(-1), now = { s: Math.round((Date.now() - started) / 1000), status: cloud.status, step: (cloud as { setupStep?: string | null }).setupStep ?? null };
        if (!last || last.status !== now.status || last.step !== now.step) { timeline.push(now); console.log(`         ${now.s}s ${now.status} ${now.step ?? ""}`); }
        if (!shotTaken && cloud.status === "provisioning" && now.s > 20) { await page.reload(); await sleep(1500); await shot(page, "05a-dashboard-provisioning"); shotTaken = true; }
        if (cloud.status === "running") break;
        if (cloud.status === "error") throw new Error("cloud setup failed");
      }
      await sleep(4000);
    }
    results.setupTimeline = timeline;
    if (timeline.at(-1)?.status !== "running") throw new Error("not running in 25 minutes");
    await page.reload(); await sleep(2500); await shot(page, "05-dashboard-running");
  }, true);
  state.web = await web.storageState(); keep();
}

// a person's own words in the composer, as typed (React reads the native setter and the input event), then Enter
async function typeAndSend(p: any, text: string, within = "document"): Promise<boolean> {
  const typed = await p.evaluate(({ text, within }: { text: string; within: string }) => {
    const root = within === "document" ? document : document.querySelector(within);
    const field = [...(root?.querySelectorAll("textarea") ?? [])].filter((el: any) => el.offsetParent !== null && el.placeholder.startsWith("Message ")).pop() as HTMLTextAreaElement | undefined;
    if (!field) return false;
    field.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }, { text, within });
  if (!typed) return false;
  await sleep(250);
  await p.keyboard.press("Enter");
  return true;
}
const shows = (p: any, text: string, ms = 30_000) => until(() => p.evaluate((t: string) => document.body.innerText.includes(t), text), ms);
const gone = (p: any, text: string, ms = 30_000) => until(async () => !(await p.evaluate((t: string) => document.body.innerText.includes(t), text)), ms);
async function pressText(p: any, text: string): Promise<boolean> {
  const at = await p.evaluate((t: string) => {
    const hits = [...document.querySelectorAll("body *")].filter((el: any) => el.offsetParent !== null && el.innerText && el.innerText.trim() === t) as HTMLElement[];
    const hit = hits.sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length)[0];
    if (!hit) return null;
    hit.scrollIntoView({ block: "center" });
    const box = hit.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  }, text);
  if (!at) return false;
  await p.mouse.click(at.x, at.y);
  return true;
}
const clickButton = (p: any, text: string) => p.evaluate((t: string) => {
  const all = [...document.querySelectorAll("button, a, [role=button]")] as HTMLElement[];
  const hit = all.filter(el => el.offsetParent !== null && el.innerText && el.innerText.includes(t)).sort((a, b) => a.innerText.length - b.innerText.length)[0];
  if (!hit) return false; hit.click(); return true;
}, text);

async function run() {
  if (!state.cloudId) throw new Error("no cloud in the state file: run --phase setup first");
  const machine = async () => { const id = (await ibx.find(state.cloudId!))?.id; if (!id) throw new Error("no machine"); return id; };
  const onMachine = async (command: string, timeout = 120) => ibx.run(await machine(), command, timeout);

  // the desktop app: its account client signs in with an emailed code (or its saved session), then opens the cloud
  await step("app: the desktop app signs in and sees the cloud ready", async () => {
    await client.start();
    let current = client.state() as { status: string };
    if (current.status !== "connected") {
      let sent = Date.now();
      let started = await client.emailStart(mail.address) as { outcome: string; retryAfter?: number };
      if (started.outcome === "rate-limited") { note(`app email start rate-limited (${JSON.stringify(started)}), waiting out the resend gap`); await sleep(35_000); sent = Date.now(); started = await client.emailStart(mail.address) as { outcome: string }; }
      if (started.outcome !== "sent") throw new Error(`email start ${JSON.stringify(started)}`);
      const got = await mail.code(sent);
      const signed = await client.emailVerify(got.code) as { outcome: string };
      if (signed.outcome !== "signed-in") throw new Error(`app sign-in ${signed.outcome}`);
      current = client.state() as { status: string };
    }
    const view = client.state() as { status: string; clouds?: Array<{ id: string; status?: string; origin?: string }>; cloud?: unknown };
    results.appState = { status: view.status, clouds: view.clouds?.map(c => ({ status: c.status, origin: c.origin ? "set" : null })) ?? null };
  }, true);

  // what a real person would see for engines before any test tooling: is any AI signed in on the cloud?
  const engineCheck = await onMachine(`command -v claude codex opencode gemini qwen 2>/dev/null; ls ${CLOUD_HOME.data} 2>/dev/null | head -40; test -e /opt/madani-test/fake-claude.mjs && echo fake-installed || echo no-fake`);
  results.enginesOnCloud = engineCheck.stdout.trim().split("\n");

  let owner: any = null;
  const ownerSession = async () => {
    const grant = await again(() => client.pairHome()) as { origin: string; code: string; expiresAt: number };
    return { grant, session: await openOwnerSession({ origin: grant.origin, grant: async () => grant }, globalThis.fetch, { label: "E2E app", background: false }) };
  };
  let homeOrigin = "";
  await step("pair: the app pairs with the home at its public name", async () => {
    const { grant, session } = await ownerSession();
    homeOrigin = grant.origin;
    if (!/^https:\/\/d[0-9a-f]{20}\.madani\.bot$/.test(homeOrigin)) throw new Error(`home origin ${homeOrigin}`);
    owner = session;
    const engines = await owner.call("GET", "/api/health").catch(() => null);
    results.enginesSeenByHome = engines ? JSON.stringify(engines.body).slice(0, 600) : null;
  }, true);
  const api = (method: string, path: string, body?: unknown) => (method === "GET" ? again(() => owner.call(method, path, body)) : owner.call(method, path, body)) as Promise<{ status: number; body: any }>;

  // test tooling: the synthetic engine, with a tool-calls file the test rewrites per turn (missing: no tool calls)
  await step("engine: synthetic engine on the home (test tooling)", async () => {
    if (!process.argv.includes("--reinstall-engine") && (await onMachine("test -x /usr/local/bin/claude && test -e /opt/madani-test/fake-claude.mjs && echo yes")).stdout.includes("yes")) return;
    const dir = mkdtempSync(join(tmpdir(), "madani-engine-")), file = join(dir, "fake-claude.mjs");
    execFileSync(resolve("node_modules/.bin/esbuild"), ["server/testing/fake-claude-cli.ts", "--bundle", "--platform=node", "--format=esm", `--outfile=${file}`, "--log-level=error",
      "--banner:js=import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"], { stdio: "inherit" });
    const wrapper = `#!/bin/sh\nif [ "$1" = auth ]; then echo '{"loggedIn":true,"email":"person@example.test"}'; exit 0; fi\nexport FAKE_CLAUDE_VERSION=2.1.284\nexport FAKE_CLAUDE_TOOL_CALLS_FILE=/opt/madani-test/tools.json\nexport FAKE_CLAUDE_USES_CLOUD_COMPUTER=1\nexec ${CLOUD_HOME.root}/node/bin/node /opt/madani-test/fake-claude.mjs "$@"\n`;
    const id = await machine();
    await ibx.upload(id, "/data/home/fake-claude.mjs", readFileSync(file));
    await ibx.upload(id, "/data/home/claude-wrapper.sh", Buffer.from(wrapper));
    rmSync(dir, { recursive: true, force: true });
    const done = await onMachine("sudo install -d -m 0777 /opt/madani-test && sudo install -m 0755 /data/home/fake-claude.mjs /opt/madani-test/fake-claude.mjs && sudo install -m 0755 /data/home/claude-wrapper.sh /usr/local/bin/claude && sudo rm -f /opt/madani-test/tools.json && sudo systemctl restart omb-home && for i in $(seq 1 60); do curl -fsS -m 2 http://127.0.0.1:8799/api/health >/dev/null && break; sleep 1; done && echo ok", 180);
    if (!done.stdout.includes("ok")) throw new Error(`engine install: ${done.stdout.slice(-200)}`);
    const again = await ownerSession(); owner = again.session;
  });
  const setTools = async (calls: unknown[] | null) => {
    const id = await machine();
    if (!calls) { await onMachine("sudo rm -f /opt/madani-test/tools.json"); return; }
    await ibx.upload(id, "/data/home/tools.json", Buffer.from(JSON.stringify(calls)));
    await onMachine("sudo install -m 0644 /data/home/tools.json /opt/madani-test/tools.json");
  };
  await setTools(null);

  // the desktop window: main loads the cloud's own page with a one-time code in the hash
  const desktop = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const dpage = await desktop.newPage();
  const consoleErrors: string[] = [];
  dpage.on("console", (m: any) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
  dpage.on("pageerror", (e: Error) => consoleErrors.push(`pageerror ${e.message.slice(0, 200)}`));
  await step("desktop: the app opens its cloud (the window's page pairs with the one-time code)", async () => {
    const grant = await again(() => client.pairHome()) as { origin: string; code: string; expiresAt: number };
    const url = cloudHomeConnectUrl({ origin: grant.origin, grant }, Date.now());
    const started = Date.now();
    await dpage.goto(url, { waitUntil: "domcontentloaded" });
    // the Electron window pairs at once (its preload bridge is there); a plain page asks for one press of Connect
    await dpage.getByRole("button", { name: "Connect" }).click({ timeout: 30_000 });
    if (!(await until(async () => !(await dpage.url()).includes("/pair"), 30_000))) throw new Error(`still on the pair page: ${(await dpage.evaluate(() => document.body.innerText)).slice(0, 200)}`);
    await until(() => dpage.evaluate(() => document.body.innerText.trim().length > 40), 30_000);
    results.desktopOpenMs = Date.now() - started;
    await sleep(2000);
    await shot(dpage, "06-desktop-first-open");
    results.desktopFirstScreen = (await dpage.evaluate(() => document.body.innerText)).slice(0, 400);
  }, true);

  // the welcome flow, if the cloud shows one: walked through as a person would (Skip / Continue), else noted
  await step("desktop: the welcome flow, if any, gets out of the way", async () => {
    const text = await dpage.evaluate(() => document.body.innerText);
    if (/welcome|get started|let's/i.test(text)) {
      note(`desktop first screen looked like a welcome flow: ${text.slice(0, 160).replace(/\s+/g, " ")}`);
      for (let n = 0; n < 8; n++) {
        const clicked = await clickButton(dpage, "Skip") || await clickButton(dpage, "Not now") || await clickButton(dpage, "Continue") || await clickButton(dpage, "Get started");
        if (!clicked) break;
        await sleep(1200);
      }
    }
    await shot(dpage, "07-desktop-after-welcome");
  });

  // two bots, made from the desktop's own session (the same /api calls its New bot sheet makes)
  const bots: Array<{ id: string; threadId: string; name: string }> = state.bots?.length ? state.bots : [];
  await step("bots: two bots made, both listed on the desktop", async () => {
    if (!bots.length) {
      for (const name of ["Adalyn", "Borealis"]) {
        const made = await api("POST", "/api/bots", { name });
        if (made.status >= 300) throw new Error(`create ${name}: ${made.status} ${JSON.stringify(made.body).slice(0, 160)}`);
        bots.push({ id: made.body.bot.id, threadId: made.body.bot.threadId, name });
      }
      state.bots = bots; keep();
    }
    if (!(await shows(dpage, "Adalyn")) || !(await shows(dpage, "Borealis"))) throw new Error(`desktop does not list both: ${(await dpage.evaluate(() => document.body.innerText)).slice(0, 300)}`);
  });
  const [ada, bo] = bots as [typeof bots[0], typeof bots[0]];
  const threadRows = async (bot: { threadId: string }) => ((await api("GET", `/api/threads/${bot.threadId}/messages?limit=80`)).body?.messages ?? []) as Array<{ role?: string; kind?: string; text?: string; tool?: string; name?: string; output?: unknown }>;
  const botReplies = async (bot: { threadId: string }) => (await threadRows(bot)).filter(m => m.role === "bot" && m.kind === "text" && m.text?.trim());

  if (!args.includes("--sync-only")) {
  await step("chat: the desktop sends to Adalyn, her reply shows on the desktop", async () => {
    if (!(await pressText(dpage, "Adalyn"))) throw new Error("no Adalyn row");
    await until(() => dpage.evaluate(() => [...document.querySelectorAll("textarea")].some((el: any) => el.offsetParent !== null && el.placeholder.includes("Adalyn"))), 20_000);
    const before = (await botReplies(ada)).length, text = `hello Adalyn from the desktop ${randomUUID().slice(0, 6)}`;
    const sent = Date.now();
    if (!(await typeAndSend(dpage, text))) throw new Error("no composer");
    if (!(await until(async () => (await botReplies(ada)).length > before, 120_000, 1000))) throw new Error("no reply in 2 minutes");
    results.adaReplyMs = Date.now() - sent;
    const reply = (await botReplies(ada)).at(-1)!.text!.trim().split("\n")[0]!.slice(0, 40);
    if (!(await shows(dpage, text, 10_000))) throw new Error("sent text not on the desktop");
    if (!(await shows(dpage, reply, 15_000))) throw new Error(`reply not on the desktop: ${reply}`);
    await shot(dpage, "08-desktop-ada-chat");
  });
  await step("chat: the desktop sends to Borealis, his reply shows", async () => {
    if (!(await pressText(dpage, "Borealis"))) throw new Error("no Borealis row");
    await until(() => dpage.evaluate(() => [...document.querySelectorAll("textarea")].some((el: any) => el.offsetParent !== null && el.placeholder.includes("Borealis"))), 20_000);
    const before = (await botReplies(bo)).length, sent = Date.now();
    if (!(await typeAndSend(dpage, "hi Borealis"))) throw new Error("no composer");
    if (!(await until(async () => (await botReplies(bo)).length > before, 120_000, 1000))) throw new Error("no reply in 2 minutes");
    results.boReplyMs = Date.now() - sent;
  });

  // Borealis's own computer on the cloud: the turn takes the desktop and opens a page in its Chromium through vm_exec
  await step("computer: Borealis's cloud computer starts", async () => {
    await api("PATCH", `/api/bots/${bo.id}`, { computer: "cloud" });
    const started = Date.now();
    let woke = await api("POST", `/api/bots/${bo.id}/computer/provision`, {}).catch((e: Error) => ({ status: 0, body: { error: e.message } }));
    for (let n = 0; n < 60 && !(woke.status < 300 && woke.body?.ready === true); n++) {
      if (n === 0) note(`Borealis's computer not ready yet: ${woke.status} ${JSON.stringify(woke.body).slice(0, 160)}`);
      await sleep(10_000);
      woke = await api("POST", `/api/bots/${bo.id}/computer/provision`, {}).catch((e: Error) => ({ status: 0, body: { error: e.message } }));
    }
    results.computerStartMs = Date.now() - started;
    if (!(woke.status < 300 && woke.body?.ready === true)) throw new Error(`computer ${woke.status} ${JSON.stringify(woke.body).slice(0, 200)}`);
  });
  await step("browser: Borealis opens a web page in his computer's browser during a turn", async () => {
    const marker = `madani-${randomUUID().slice(0, 6)}`;
    const command = `curl -s -m 10 -X PUT "http://127.0.0.1:\${MADANI_CDP_PORT:-9222}/json/new?https://example.com/?${marker}" >/dev/null || (chromium "https://example.com/?${marker}" >/dev/null 2>&1 &); for i in $(seq 1 20); do sleep 1; curl -s -m 5 http://127.0.0.1:\${MADANI_CDP_PORT:-9222}/json/list | grep -q '"title": "Example Domain"' && break; done; curl -s -m 5 http://127.0.0.1:\${MADANI_CDP_PORT:-9222}/json/list | grep -E '"(title|url)"' | head -6`;
    await setTools([{ server: "computer", name: "vm_exec", input: { command, timeout_seconds: 60 } }]);
    const before = (await botReplies(bo)).length, sent = Date.now();
    await api("POST", `/api/bots/${bo.id}/messages`, { text: "open example.com in your browser and tell me its title", threadId: bo.threadId, sendId: randomUUID() });
    const ok = await until(async () => (await botReplies(bo)).length > before, 180_000, 1500);
    await setTools(null);
    if (!ok) throw new Error("no reply in 3 minutes");
    results.browseTurnMs = Date.now() - sent;
    const rows = (await threadRows(bo)).filter(m => ((m as { at?: number }).at ?? 0) >= sent - 2000);
    const toolText = JSON.stringify(rows);
    results.browseTool = toolText.slice(0, 3000);
    if (!toolText.includes("Example Domain")) throw new Error(`the browser did not show the page: ${toolText.slice(0, 300)}`);
    if (!toolText.includes(marker)) note("tool result has the title but not this run's marker url");
    await pressText(dpage, "Borealis"); await sleep(2500); await shot(dpage, "09-desktop-bo-browser-turn");
  });

  await step("apps: the website starts an app connect on the cloud and gets its sign-in link back (not completed)", async () => {
    const list = (await account("GET", "/v1/workspaces")).workspaces as Array<{ id: string; kind?: string }>;
    if (!list.length) throw new Error("the website lists no workspace for this account");
    const ws = list.find(w => w.kind === "vps") ?? list[0]!, asked = Date.now();
    const queued = (await account("POST", `/v1/workspaces/${ws.id}/commands`, { kind: "app.connect", target: "gmail" })).command as { id: string };
    let command: { status?: string; url?: string; message?: string | null } | undefined;
    await until(async () => {
      command = ((await account("GET", `/v1/workspaces/${ws.id}`)).commands as Array<{ id: string }>).find(c => c.id === queued.id) as typeof command;
      return command?.status === "done" || command?.status === "failed";
    }, 90_000, 1000);
    results.appConnect = { status: command?.status ?? null, ms: Date.now() - asked, host: command?.url ? new URL(command.url).host : null, message: command?.message ?? null };
    await page.goto(`${origin}/app/connectors`).catch(() => {}); await sleep(2500); await shot(page, "09b-website-apps");
    if (command?.status !== "done" || !command.url?.startsWith("https://")) throw new Error(`app connect: ${JSON.stringify(results.appConnect)}`);
  });

  await step("data: Borealis runs a DuckDB query with the data tools during a turn", async () => {
    const loaded = await onMachine(`cd ${CLOUD_HOME.root}/app && sudo -u maus ${CLOUD_HOME.root}/node/bin/node -e 'require("module").createRequire(process.cwd() + "/dist-server/index.js")("@duckdb/node-api"); console.log("duckdb ok")' 2>&1 | tail -2; uname -m`);
    results.duckdbOnBox = loaded.stdout.trim().slice(0, 200);
    if (!loaded.stdout.includes("duckdb ok")) throw new Error(`DuckDB does not load on the box: ${loaded.stdout.slice(-200)}`);
    const marker = Math.floor(1000 + Math.random() * 8000);
    await setTools([{ server: "data", name: "data_sql", input: { sql: `SELECT ${marker} * 2 AS doubled, 'duck' AS word` } }]);
    const before = (await botReplies(bo)).length, sent = Date.now();
    await api("POST", `/api/bots/${bo.id}/messages`, { text: "use the data tools to double a number", threadId: bo.threadId, sendId: randomUUID() });
    const ok = await until(async () => (await botReplies(bo)).length > before, 180_000, 1500);
    await setTools(null);
    if (!ok) throw new Error("no reply in 3 minutes");
    results.dataTurnMs = Date.now() - sent;
    const toolText = JSON.stringify((await threadRows(bo)).filter(m => ((m as { at?: number }).at ?? 0) >= sent - 2000));
    results.dataTool = toolText.slice(0, 2000);
    if (!toolText.includes(String(marker * 2))) throw new Error(`the data tool did not answer: ${toolText.slice(0, 400)}`);
  });

  // a routine on a schedule: due in about two minutes, runs on time, its result in Adalyn's chat on the desktop
  await step("routine: a routine runs on schedule and its result reaches the desktop", async () => {
    const due = Date.now() + 2 * 60_000;
    const made = await api("POST", "/api/routines", { name: "E2E check-in", prompt: "Say the time.", botId: ada.id, enabled: true, schedule: { type: "once", at: due } });
    if (made.status >= 300) throw new Error(`routine ${made.status} ${JSON.stringify(made.body).slice(0, 200)}`);
    const routineId = made.body.routine.id as string;
    let run: { status?: string; startedAt?: number; threadId?: string } | undefined;
    await until(async () => {
      run = ((await api("GET", "/api/routines")).body?.runs ?? []).find((r: { routineId?: string }) => r.routineId === routineId);
      return run?.status === "completed" || run?.status === "failed";
    }, 6 * 60_000, 5000);
    results.routine = run ? { status: run.status, lateMs: run.startedAt ? run.startedAt - due : null } : null;
    if (run?.status !== "completed") throw new Error(`routine run ${run?.status ?? "missing"}`);
    await sleep(3000); await shot(dpage, "10-desktop-after-routine");
    const routineShown = await shows(dpage, "E2E check-in", 15_000);
    if (!routineShown) note("the routine's name is not on the desktop page after its run");
  });

  }
  // the phone: the src/mobile production build, served to headless Chromium as the native app's origin (http://localhost,
  // one the home's mobile CORS names); CapacitorHttp sends its requests natively, so they are made here outside the page's
  // CORS, while its live stream stays the WebView's own fetch (CapacitorWebFetch) on the real CORS path
  const dist = mkdtempSync(join(tmpdir(), "madani-phone-"));
  cleanups.push(() => rmSync(dist, { recursive: true, force: true }));
  execFileSync(process.execPath, ["node_modules/vite/bin/vite.js", "build", "--config", "apps/mobile/vite.config.ts", "--outDir", dist, "--emptyOutDir", "--logLevel", "error"], { stdio: "inherit" });
  const types: Record<string, string> = { js: "text/javascript", css: "text/css", html: "text/html", svg: "image/svg+xml", png: "image/png", woff2: "font/woff2", json: "application/json", webp: "image/webp", wasm: "application/wasm", mp3: "audio/mpeg" };
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await phoneCtx.route(/^http:\/\/localhost\//, async (route: any) => {
    const u = new URL(route.request().url());
    if (/^\/(api|\.well-known)\//.test(u.pathname)) return route.abort("connectionrefused");
    let file = join(dist, decodeURIComponent(u.pathname));
    if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) file = join(dist, "index.html");
    await route.fulfill({ status: 200, body: readFileSync(file), headers: { "content-type": types[file.split(".").pop()!] ?? "application/octet-stream" } });
  });
  await phoneCtx.route(/^https:\/\/d[0-9a-f]{20}\.madani\.bot\//, async (route: any) => {
    const req = route.request(), cors = { "access-control-allow-origin": "http://localhost", "access-control-allow-headers": "*", "access-control-allow-methods": "*", "access-control-expose-headers": "*" };
    if (req.method() === "OPTIONS" && /authorization/i.test(req.headers()["access-control-request-headers"] ?? "") && /\/api\/events/.test(req.url())) return route.continue();
    if (/text\/event-stream/.test(req.headers()["accept"] ?? "")) return route.continue();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    try { const r = await route.fetch({ headers: { ...req.headers(), origin: "http://localhost" }, timeout: 60_000 }); await route.fulfill({ response: r, headers: { ...r.headers(), ...cors } }); }
    catch { await route.abort("failed").catch(() => {}); }
  });
  const phone = await phoneCtx.newPage();
  phone.on("pageerror", (e: Error) => consoleErrors.push(`phone pageerror ${e.message.slice(0, 200)}`));
  // CapacitorHttp sends the account requests natively: no page CORS and no Origin header
  await phoneCtx.route((url: URL) => url.origin === origin, async (route: any) => {
    const req = route.request(), cors = { "access-control-allow-origin": "http://localhost", "access-control-allow-headers": "*", "access-control-allow-methods": "*", "access-control-expose-headers": "*" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const { origin: _origin, referer: _referer, ...headers } = req.headers();
    try { const r = await route.fetch({ headers, timeout: 60_000 }); await route.fulfill({ response: r, headers: { ...r.headers(), ...cors } }); }
    catch { await route.abort("failed").catch(() => {}); }
  });
  await step("phone: signs in with the Madani account, picks the cloud, and lists the same chats", async () => {
    await phone.goto(`http://localhost/?account=1&accountOrigin=${encodeURIComponent(origin)}`);
    await sleep(3000); await shot(phone, "11-phone-first");
    const email = phone.locator('input[type="email"]');
    if (!(await until(() => email.isVisible().catch(() => false), 20_000))) throw new Error(`no account sign-in on the phone: ${(await phone.evaluate(() => document.body.innerText)).slice(0, 300)}`);
    let sent = Date.now();
    await email.fill(mail.address); await email.press("Enter");
    const boxes = phone.locator("input[inputmode=numeric], input[autocomplete=one-time-code]");
    if (!(await until(async () => (await boxes.count()) > 0, 15_000))) {
      if (!(await shows(phone, "Try again", 1000)) && !/wait|seconds|rate/i.test(await phone.evaluate(() => document.body.innerText))) throw new Error(`no code entry: ${(await phone.evaluate(() => document.body.innerText)).slice(0, 300)}`);
      note("phone sign-in hit the resend gap; waiting it out");
      await sleep(35_000); sent = Date.now(); await email.press("Enter");
      if (!(await until(async () => (await boxes.count()) > 0, 15_000))) throw new Error("no code entry after the resend gap");
    }
    const got = await mail.code(sent);
    await boxes.first().click(); await phone.keyboard.type(got.code);
    await sleep(800);
    if (await boxes.first().isVisible().catch(() => false)) await phone.keyboard.press("Enter").catch(() => {});
    const picker = phone.locator('[data-testid="mobile-cloud-connect"]');
    if (!(await until(async () => (await picker.count()) > 0, 30_000))) {
      if (await shows(phone, "Skip", 2000)) { await clickButton(phone, "Skip"); }
      if (!(await until(async () => (await picker.count()) > 0, 30_000))) throw new Error(`no cloud picker: ${(await phone.evaluate(() => document.body.innerText)).slice(0, 300)}`);
    }
    await shot(phone, "12-phone-clouds");
    const mine = phone.locator(`[data-testid="mobile-cloud-connect"][data-cloud-id="${state.cloudId}"]`);
    if (!(await mine.count())) throw new Error(`this cloud is not in the phone's list (${await picker.count()} listed)`);
    const linked = Date.now();
    await mine.first().click();
    if (await shows(phone, "Link this phone", 3000)) await clickButton(phone, "Link");
    if (!(await shows(phone, "Adalyn", 90_000)) || !(await shows(phone, "Borealis", 10_000))) throw new Error(`phone does not list the bots: ${(await phone.evaluate(() => document.body.innerText)).slice(0, 300)}`);
    results.phoneLinkMs = Date.now() - linked;
    await sleep(3000);
    results.phoneReconnecting = await phone.evaluate(() => document.body.innerText.includes("Reconnecting"));
    await shot(phone, "13-phone-home");
  });
  await step("phone: sees Adalyn's chat as on the desktop, sends, both show the message and the reply", async () => {
    await clickButton(phone, "Adalyn");
    if (!(await until(() => phone.evaluate(() => Boolean(document.querySelector("[data-mobile-chat] textarea"))), 20_000))) throw new Error("phone chat did not open");
    if (!(await shows(phone, "hello Adalyn from the desktop", 15_000))) throw new Error("the desktop's message is not on the phone");
    await pressText(dpage, "Adalyn");
    const before = (await botReplies(ada)).length, text = `from the phone ${randomUUID().slice(0, 6)}`, sent = Date.now();
    if (!(await typeAndSend(phone, text, "[data-mobile-chat]"))) throw new Error("no phone composer");
    if (!(await shows(phone, text, 5000))) throw new Error("not on the phone at once");
    if (!(await shows(dpage, text, 30_000))) throw new Error("not on the desktop");
    results.phoneToDesktopMs = Date.now() - sent;
    if (!(await until(async () => (await botReplies(ada)).length > before, 120_000, 1000))) throw new Error("no reply");
    const reply = (await botReplies(ada)).at(-1)!.text!.trim().split("\n")[0]!.slice(0, 40);
    if (!(await shows(phone, reply, 20_000))) throw new Error("reply not on the phone");
    if (!(await shows(dpage, reply, 20_000))) throw new Error("reply not on the desktop");
    const rows = (await threadRows(ada)).filter(m => m.role === "user" && m.text === text);
    if (rows.length !== 1) throw new Error(`stored ${rows.length} times`);
    await shot(phone, "14-phone-ada"); await shot(dpage, "15-desktop-ada-from-phone");
  });
  await step("unread: a reply nobody looks at is unread on both, reading it on the phone clears it on the desktop", async () => {
    await phone.evaluate(() => (document.querySelector("[data-mobile-chat] nav button") as HTMLElement | null)?.click());
    await pressText(dpage, "Borealis"); await sleep(1500);
    const unread = async () => ((await api("GET", "/api/bots")).body?.bots ?? []).find((b: { id: string }) => b.id === ada.id)?.unread;
    await api("POST", `/api/bots/${ada.id}/messages`, { text: `while nobody looks ${randomUUID().slice(0, 6)}`, threadId: ada.threadId, sendId: randomUUID() });
    if (!(await until(async () => (await unread()) === true, 90_000, 1000))) throw new Error("server never marked it unread");
    const phoneUnread = await until(() => phone.evaluate(() => Boolean([...document.querySelectorAll("[aria-label]")].find(el => (el.getAttribute("aria-label") ?? "").includes("Adalyn") && /unread/i.test(el.getAttribute("aria-label") ?? "")))), 20_000);
    const desktopUnread = await until(() => dpage.evaluate(() => Boolean([...document.querySelectorAll("[aria-label]")].find(el => (el.getAttribute("aria-label") ?? "").includes("Adalyn") && /unread/i.test(el.getAttribute("aria-label") ?? "")))), 20_000);
    await shot(phone, "16-phone-unread"); await shot(dpage, "17-desktop-unread");
    results.unread = { phoneUnread, desktopUnread };
    await clickButton(phone, "Adalyn");
    const cleared = await until(async () => (await unread()) === false, 20_000);
    const desktopCleared = await until(() => dpage.evaluate(() => !([...document.querySelectorAll("[aria-label]")].find(el => (el.getAttribute("aria-label") ?? "").includes("Adalyn") && /unread/i.test(el.getAttribute("aria-label") ?? "")))), 20_000);
    Object.assign(results.unread as object, { cleared, desktopCleared });
    if (!phoneUnread || !desktopUnread || !cleared || !desktopCleared) throw new Error(JSON.stringify(results.unread));
  });

  // the owner pauses the cloud from the website; both apps say so; typing on the desktop wakes it; both recover
  await step("pause: paused from the website, the desktop and the phone say it is asleep", async () => {
    const asked = Date.now();
    await account("POST", `/v1/clouds/${state.cloudId}/power`, { action: "off" });
    if (!(await until(async () => (await cloudView())?.status === "sleeping", 6 * 60_000, 2000))) throw new Error(`not asleep: ${(await cloudView())?.status}`);
    results.pauseMs = Date.now() - asked;
    const desk = await shows(dpage, "wakes when you type", 90_000), ph = await shows(phone, "Your cloud is asleep. Send a message to wake it.", 60_000);
    results.pausedText = { desktop: (await dpage.evaluate(() => document.body.innerText)).slice(0, 160), phone: (await phone.evaluate(() => document.body.innerText)).slice(0, 160) };
    results.pausedShown = { desktop: desk, phone: ph, homeHealth: await fetch(`${homeOrigin}/api/health`).then(r => r.status).catch(() => 0) };
    await shot(dpage, "18-desktop-asleep"); await shot(phone, "19-phone-asleep");
    if (!desk || !ph) throw new Error(`asleep shown ${JSON.stringify(results.pausedShown)}`);
  });
  await step("resume: a message sent from the desktop wakes it; both recover", async () => {
    const onAdalyn = () => dpage.evaluate(() => [...document.querySelectorAll("textarea")].some((el: any) => el.offsetParent !== null && el.placeholder === "Message Adalyn"));
    for (let n = 0; n < 5 && !(await onAdalyn()); n++) { await pressText(dpage, "Adalyn"); await sleep(1000); }
    if (!(await onAdalyn())) throw new Error("the desktop did not open Adalyn's chat while asleep");
    const before = (await botReplies(ada).catch(() => [])).length, text = `after the pause ${randomUUID().slice(0, 6)}`;
    const asked = Date.now();
    if (!(await typeAndSend(dpage, text))) throw new Error("no composer while asleep");
    if (!(await until(async () => (await cloudView())?.status === "running", 3 * 60_000, 1500))) {
      results.sendWokeIt = false;
      await shot(dpage, "19b-desktop-send-while-asleep");
      await account("POST", `/v1/clouds/${state.cloudId}/power`, { action: "on" });
      await until(async () => (await cloudView())?.status === "running", 6 * 60_000, 1500);
      throw new Error("a message sent from the paused desktop page did not wake the cloud in 3 minutes (resumed from the website so later steps can run)");
    }
    results.sendWokeIt = true;
    results.resumeMs = Date.now() - asked;
    const delivered = await until(async () => (await threadRows(ada)).some(m => m.role === "user" && m.text === text), 120_000, 2000);
    results.sendWhileAsleepDelivered = delivered;
    if (!delivered) { note("the message typed while asleep never reached the home; sending it again after the wake"); await typeAndSend(dpage, text); }
    if (!(await until(async () => (await botReplies(ada)).length > before, 180_000, 1500))) throw new Error("no reply after wake");
    results.desktopRecovered = await gone(dpage, "Reconnecting", 60_000);
    results.phoneRecovered = await shows(phone, text, 90_000);
    const phoneText = `phone after the pause ${randomUUID().slice(0, 6)}`;
    results.phoneSendAfterResume = await typeAndSend(phone, phoneText, "[data-mobile-chat]") && await shows(dpage, phoneText, 60_000);
    await shot(dpage, "20-desktop-resumed"); await shot(phone, "21-phone-resumed");
    if (!results.desktopRecovered || !results.phoneRecovered || !results.phoneSendAfterResume) throw new Error(JSON.stringify({ desktop: results.desktopRecovered, phone: results.phoneRecovered, phoneSend: results.phoneSendAfterResume }));
  });

  // delete the bots from the desktop's session; both apps drop them
  await step("cleanup: bots deleted, both apps drop them", async () => {
    for (const bot of bots) { const gone = await api("DELETE", `/api/bots/${bot.id}`); if (gone.status >= 300) throw new Error(`delete ${bot.name}: ${gone.status}`); }
    await phone.evaluate(() => (document.querySelector("[data-mobile-chat] nav button") as HTMLElement | null)?.click());
    const d = await gone(dpage, "Borealis", 30_000), p = await gone(phone, "Borealis", 30_000);
    state.bots = []; keep();
    if (!d || !p) throw new Error(`still listed: desktop ${!d}, phone ${!p}`);
  });
  results.consoleErrors = [...new Set(consoleErrors)].slice(0, 40);
  await desktop.close(); await phoneCtx.close();
}

async function teardown() {
  await step("cancel: the app cancels the plan", async () => {
    await client.start();
    const r = await client.cancelPlan({ answer: "other", improve: "e2e test" }) as { outcome: string };
    if (r.outcome !== "cancelled") throw new Error(`cancel ${JSON.stringify(r).slice(0, 160)}`);
  });
  await step("delete: the account is deleted from the website, its cloud destroyed now", async () => {
    await page.goto(`${origin}/app/account`).catch(() => {});
    await account("POST", "/v1/account/delete", { email: mail.address, cancelBilling: true, destroyDesktopsNow: true });
    const r = await web.request.get(`${origin}/v1/account`);
    if (r.status() !== 401) throw new Error(`after delete /v1/account ${r.status()}`);
  });
  await step("teardown: the operator deletes the test cloud, the provider holds no machine of this deployment", async () => {
    if (state.cloudId) {
      const r = await fetch(`${origin}/v1/billing/ops/clouds/${state.cloudId}/delete`, { method: "POST", headers: { authorization: `Bearer ${opsToken}`, "content-type": "application/json" }, body: JSON.stringify({ reason: "test_account" }) });
      if (!r.ok) throw new Error(`operator delete ${r.status} ${(await r.text()).slice(0, 200)}`);
    }
    const started = Date.now();
    while (Date.now() - started < 15 * 60_000) {
      const left = await ibx.inventory();
      if (!left.length) { results.teardownMs = Date.now() - started; return; }
      await sleep(10_000);
    }
    throw new Error("machines left after 15 minutes");
  });
  results.mailSubjects = await mail.subjects().catch(() => null);
  await mail.remove();
  rmSync(statePath, { force: true });
}

let failed: unknown = null;
try {
  if (phase === "setup" || phase === "all") await setup();
  if (phase === "run" || phase === "all") await run();
} catch (error) { failed = error; }
finally {
  if (phase === "teardown" || phase === "all") await teardown().catch(e => console.log(`teardown ${e}`));
  for (const cleanup of cleanups.reverse()) { try { await cleanup(); } catch {} }
  client.close?.();
  await Promise.race([browser.close(), sleep(10_000)]);
  results.totalSeconds = Math.round((Date.now() - t0) / 1000);
  results.passed = results.steps.every(s => s.ok);
  save();
  console.log(`done in ${results.totalSeconds}s: ${failed ? `stopped: ${String(failed).split("\nCall log")[0]}` : results.passed ? "every step passed" : "failures above"}`);
}
process.exit(failed || !results.passed ? 1 : 0);
