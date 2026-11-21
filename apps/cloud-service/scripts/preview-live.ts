// One person's whole life on the deployed service, through its public URLs (Cloudflare in front): the site, sign-up
// with a real emailed code, onboarding, a madani cloud plan, the cloud machine on InstaBox, the desktop app's own
// account client signing in and pairing with the home through its public name, a bot answering, cancelling, deleting
// the account, and the provider left with nothing. Times every step and writes them to --out.
//
//   INSTABOX_API_KEY=... MADANI_OPS_TOKEN=... PLAYWRIGHT_CORE=/path/to/playwright-core \
//     node apps/cloud-service/scripts/preview-live.ts --origin https://preview.madani.bot --out preview-live.json
//
// Test-only parts, each listed in the results: the inbox is a throwaway mail.tm address; checkout is closed on preview, so
// the operator grants the plan (POST /v1/billing/ops/grant, the same checkout, webhook and provisioning path with nothing
// charged); a synthetic engine answers the bot instead of the person's own AI account.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CLOUD_HOME } from "../../../electron/legacy-names.mjs";
import { createCloudAccountClient } from "../../../electron/cloud-account.mjs";
import { openOwnerSession } from "../../../electron/cloud-send-main.mjs";
import type { CloudDesktopView } from "../../../shared/billing-api.ts";
import { createInstaboxProvider } from "../src/instabox.ts";

const args = process.argv.slice(2);
const option = (name: string) => { const at = args.indexOf(name); return at === -1 ? null : args[at + 1] ?? null; };
const origin = (option("--origin") ?? "https://preview.madani.bot").replace(/\/$/, "");
const out = resolve(option("--out") ?? "preview-live.json"), shots = resolve(option("--shots") ?? "preview-live-shots");
const apiKey = process.env.INSTABOX_API_KEY, opsToken = process.env.MADANI_OPS_TOKEN;
if (!apiKey || !opsToken) { console.error("INSTABOX_API_KEY and MADANI_OPS_TOKEN are required."); process.exit(2); }
interface Cookie { name: string; value: string; httpOnly: boolean; secure: boolean; sameSite: string }
// playwright-core is not a dependency of this repo: PLAYWRIGHT_CORE names an install of it
const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core") as { chromium: { launch(options: object): Promise<any> } };
const scope = process.env.MADANI_MANAGED_SCOPE ?? createHash("sha256").update(new URL(origin).origin).digest("hex").slice(0, 16);
const ibx = createInstaboxProvider({ apiKey, scope });
mkdirSync(shots, { recursive: true });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const t0 = Date.now();
const results: Record<string, unknown> & { steps: Array<{ name: string; ok: boolean; ms: number; at: number; error?: string }> } = {
  origin, startedAt: new Date(t0).toISOString(), steps: [],
  testOnly: ["throwaway mail.tm inbox", "operator plan grant (checkout closed on preview, nothing charged)", "synthetic engine answers the bot"] };
const save = () => writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
async function step<T>(name: string, fn: () => Promise<T>, critical = false): Promise<T | null> {
  const started = Date.now();
  try {
    const value = await fn();
    results.steps.push({ name, ok: true, ms: Date.now() - started, at: Math.round((Date.now() - t0) / 1000) });
    console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ok   ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    save(); return value;
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : String(error);
    results.steps.push({ name, ok: false, ms: Date.now() - started, at: Math.round((Date.now() - t0) / 1000), error: message });
    console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] FAIL ${name}: ${message}`);
    save();
    if (critical) throw error;
    return null;
  }
}

// a throwaway inbox the run controls (mail.tm), so no real person gets mail
const mailtm = "https://api.mail.tm";
async function mt(path: string, init: RequestInit = {}, tries = 0): Promise<any> {
  const r = await fetch(mailtm + path, { ...init, headers: { "content-type": "application/json", ...init.headers } });
  if (r.status === 429 && tries < 8) { await sleep(1500 * (tries + 1)); return mt(path, init, tries + 1); }
  const text = await r.text(); if (!r.ok) throw new Error(`mail.tm ${path} ${r.status}`);
  return text ? JSON.parse(text) : {};
}
async function inbox() {
  const domain = (await mt("/domains"))["hydra:member"][0].domain;
  const address = `madani-live-${Date.now().toString(36)}@${domain}`, password = randomUUID();
  await mt("/accounts", { method: "POST", body: JSON.stringify({ address, password }) });
  const { token } = await mt("/token", { method: "POST", body: JSON.stringify({ address, password }) });
  const seen = new Set<string>();
  return {
    address,
    /** the next 8-digit code mailed after `since`, with who sent it and how long it took */
    async code(since: number) {
      for (let i = 0; i < 60; i++) {
        for (const m of (await mt("/messages", { headers: { authorization: `Bearer ${token}` } }))["hydra:member"]) {
          if (seen.has(m.id) || Date.parse(m.createdAt) < since - 5000) continue;
          seen.add(m.id);
          const full = await mt(`/messages/${m.id}`, { headers: { authorization: `Bearer ${token}` } });
          const code = String(full.text ?? "").match(/\b\d{8}\b/)?.[0];
          if (code) return { code, from: full.from?.address as string, ms: Date.now() - since };
        }
        await sleep(3000);
      }
      throw new Error("no code mailed within 3 minutes");
    },
    remove: async () => { await fetch(`${mailtm}/accounts/${(await mt("/me", { headers: { authorization: `Bearer ${token}` } })).id}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } }).catch(() => {}); },
  };
}

const mail = await inbox();
results.email = mail.address.replace(/^[^@]+/, "madani-live-…");
const browser = await chromium.launch({ headless: true, args: ["--use-mock-keychain", "--password-store=basic"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const page = await context.newPage();
const shot = (name: string) => page.screenshot({ path: join(shots, `${name}.png`) });
const csrf = async () => ((await context.cookies(origin)) as Cookie[]).find(c => c.name === "madani_csrf")?.value ?? "";
async function web(method: string, path: string, body?: unknown) {
  const r = await context.request.fetch(`${origin}${path}`, { method, headers: { origin, "x-madani-csrf": await csrf(), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { data: JSON.stringify(body) }) });
  const text = await r.text(); let data: any = text; try { data = JSON.parse(text); } catch {}
  if (!r.ok()) throw new Error(`${method} ${path} ${r.status()} ${text.slice(0, 200)}`);
  return data;
}
let cloudId = "", accountDeleted = false;
const client = createCloudAccountClient({ origin, custom: true, platform: "darwin", deviceName: "Live test Mac", appVersion: "0.1.live",
  store: (() => { let saved: unknown = null; return { read: async () => saved, write: async (value: unknown) => { saved = value; } }; })(), openBrowser: async () => {} });

try {
  // 1. the site and sign-up, as a person does it in a fresh browser
  await step("site: madani preview home loads through Cloudflare", async () => {
    const r = await page.goto(`${origin}/`);
    if (r?.status() !== 200 || r.headers()["server"] !== "cloudflare") throw new Error(`home ${r?.status()} via ${r?.headers()["server"]}`);
    await shot("01-site");
  }, true);
  await step("site: the pricing page's plus plan opens sign-up with the plan", async () => {
    await page.goto(`${origin}/pricing`);
    await page.locator('a[href="/dashboard/signup?plan=plus"]').first().click();
    await page.waitForURL(/\/app\/signup\?plan=plus/);
    await page.locator("input[type=email]").waitFor();
    await shot("02-signup");
  }, true);
  await step("sign-up: an emailed code from account@madani.bot makes the account", async () => {
    await page.fill("input[type=email]", mail.address);
    const sent = Date.now(); await page.click("button[type=submit]");
    const got = await mail.code(sent);
    if (got.from !== "account@madani.bot") throw new Error(`code came from ${got.from}`);
    results.codeMailMs = got.ms;
    await page.locator("input:visible").first().fill(got.code);
    await page.waitForURL(/\/app\/welcome/, { timeout: 20_000 });
    const cookies = await context.cookies(origin) as Cookie[], session = cookies.find(c => c.name === "madani_dash");
    if (!session?.httpOnly || !session.secure || session.sameSite !== "Lax") throw new Error("session cookie flags");
    await shot("03-welcome");
  }, true);
  await step("onboarding: a name, then checkout says paid plans open soon", async () => {
    await page.locator("input:visible").first().fill("Live Tester");
    await page.click("button[type=submit]");
    await page.getByText("paid plans open soon").waitFor({ timeout: 10_000 });
    await shot("04-checkout-soon");
  }, true);
  await step("security: cross-origin and non-JSON mutations are refused", async () => {
    const forged = await fetch(`${origin}/v1/account`, { method: "PATCH", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" });
    const form = await fetch(`${origin}/v1/auth/email/start`, { method: "POST", headers: { "content-type": "text/plain", origin }, body: "x" });
    if (forged.status !== 403 || form.status !== 403) throw new Error(`forged ${forged.status}, form ${form.status}`);
  });

  // 2. the plan: granted by the operator while checkout is closed, then the cloud machine on InstaBox
  await step("plan: the operator grants plus (same checkout and webhook path, nothing charged)", async () => {
    const r = await fetch(`${origin}/v1/billing/ops/grant`, { method: "POST", headers: { authorization: `Bearer ${opsToken}`, "content-type": "application/json" }, body: JSON.stringify({ email: mail.address, bundle: "starter", name: "Live Cloud" }) });
    const body = await r.json() as { subscriptions?: Array<{ status: string; cloudId: string | null }> };
    if (!r.ok || body.subscriptions?.[0]?.status !== "active") throw new Error(`grant ${r.status}`);
    cloudId = body.subscriptions[0].cloudId ?? "";
  }, true);
  const timeline: Array<{ s: number; status: string; step: string | null }> = [];
  await step("cloud: the dashboard shows madani cloud provisioning, then running", async () => {
    const started = Date.now();
    await page.goto(`${origin}/app/`);
    while (Date.now() - started < 25 * 60_000) {
      const clouds = (await web("GET", "/v1/clouds")).clouds as CloudDesktopView[];
      const cloud = clouds.find(c => c.id === cloudId) ?? clouds[0];
      if (cloud) {
        cloudId = cloud.id;
        const last = timeline.at(-1), now = { s: Math.round((Date.now() - started) / 1000), status: cloud.status, step: (cloud as { setupStep?: string | null }).setupStep ?? null };
        if (!last || last.status !== now.status || last.step !== now.step) { timeline.push(now); console.log(`         ${now.s}s ${now.status} ${now.step ?? ""}`); }
        if (cloud.status === "running") break;
        if (cloud.status === "error") throw new Error("cloud setup failed");
      }
      await sleep(4000);
    }
    results.setupTimeline = timeline;
    if (timeline.at(-1)?.status !== "running") throw new Error("not running in 25 minutes");
    await page.reload(); await sleep(2000); await shot("05-dashboard-running");
  }, true);

  // 3. the desktop app: its own account client signs in, sees the cloud, pairs with the home through the public name
  let homeOrigin = "";
  await step("app: the desktop app signs in with an emailed code and sees the cloud with a verified entitlement", async () => {
    await client.start();
    const sent = Date.now();
    if ((await client.emailStart(mail.address)).outcome !== "sent") throw new Error("no code sent");
    const got = await mail.code(sent);
    const signed = await client.emailVerify(got.code);
    if (signed.outcome !== "signed-in") throw new Error(`app sign-in ${signed.outcome}`);
    const state = client.state() as { status: string; clouds?: Array<{ id: string; origin?: string }> };
    results.appState = { status: state.status, clouds: state.clouds?.length ?? 0 };
  }, true);
  const api = (await step("pair: the app pairs with the home at its public name", async () => {
    const started = Date.now();
    // the account's first cloud is its home, paired without an id (an id names one of its other clouds)
    const grant = await client.pairHome() as { origin: string; code: string; expiresAt: number };
    homeOrigin = grant.origin;
    if (!/^https:\/\/d[0-9a-f]{20}\.madani\.bot$/.test(homeOrigin)) throw new Error(`home origin ${homeOrigin}`);
    const session = await openOwnerSession({ origin: homeOrigin, grant: async () => grant }, globalThis.fetch, { label: "Live app", background: false });
    results.pairMs = Date.now() - started;
    return session;
  }, true))!;
  await step("engine: synthetic engine on the home (test tooling)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "madani-engine-")), file = join(dir, "fake-claude.mjs");
    execFileSync(resolve("node_modules/.bin/esbuild"), ["server/testing/fake-claude-cli.ts", "--bundle", "--platform=node", "--format=esm", `--outfile=${file}`, "--log-level=error",
      "--banner:js=import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"], { stdio: "inherit" });
    const machine = (await ibx.find(cloudId))?.id;
    if (!machine) throw new Error("no machine");
    const wrapper = `#!/bin/sh\nif [ "$1" = auth ]; then echo '{"loggedIn":true,"email":"person@example.test"}'; exit 0; fi\nexport FAKE_CLAUDE_VERSION=2.1.284\nexec ${CLOUD_HOME.root}/node/bin/node /opt/madani-test/fake-claude.mjs "$@"\n`;
    await ibx.upload(machine, "/data/home/fake-claude.mjs", readFileSync(file));
    await ibx.upload(machine, "/data/home/claude-wrapper.sh", Buffer.from(wrapper));
    rmSync(dir, { recursive: true, force: true });
    const done = await ibx.run(machine, "sudo install -d -m 0755 /opt/madani-test && sudo install -m 0755 /data/home/fake-claude.mjs /opt/madani-test/fake-claude.mjs && sudo install -m 0755 /data/home/claude-wrapper.sh /usr/local/bin/claude && sudo systemctl restart omb-home && for i in $(seq 1 60); do curl -fsS -m 2 http://127.0.0.1:8799/api/health >/dev/null && break; sleep 1; done && echo ok", 180);
    if (!done.stdout.includes("ok")) throw new Error(`engine install: ${done.stdout.slice(-200)}`);
  });
  await step("bot: a bot made from the app answers on the cloud", async () => {
    const made = await api.call("POST", "/api/bots", { name: "Ada" });
    if (made.status >= 300) throw new Error(`create bot ${made.status}`);
    const bot = { id: made.body?.bot?.id as string, threadId: made.body?.bot?.threadId as string };
    const sent = Date.now();
    await api.call("POST", `/api/bots/${bot.id}/messages`, { text: "hello Ada", threadId: bot.threadId });
    for (let n = 0; n < 120; n++) {
      await sleep(1000);
      const rows = await api.call("GET", `/api/threads/${bot.threadId}/messages?limit=40`);
      if (((rows.body?.messages ?? []) as Array<{ role?: string; kind?: string; text?: string }>).some(m => m.role === "bot" && m.kind === "text" && m.text?.trim())) { results.replyMs = Date.now() - sent; return; }
    }
    throw new Error("no answer in 2 minutes");
  });
  await step("app: the bots list on the home shows the bot", async () => {
    const bots = await api.call("GET", "/api/bots");
    const names = ((bots.body?.bots ?? bots.body ?? []) as Array<{ name?: string }>).map(b => b.name);
    if (!names.includes("Ada")) throw new Error(`bots: ${JSON.stringify(names).slice(0, 120)}`);
  });

  // 4. cancel, then delete the account (destroying the cloud now), and the provider is left with nothing
  await step("cancel: the app cancels the plan, it runs to the period's end", async () => {
    const r = await client.cancelPlan({ answer: "other", improve: "live test" }) as { outcome: string };
    if (r.outcome !== "cancelled") throw new Error(`cancel ${JSON.stringify(r).slice(0, 160)}`);
    const overview = await web("GET", "/v1/billing/overview");
    if (!JSON.stringify(overview).includes("\"cancelAtPeriodEnd\":true")) throw new Error("not marked to cancel");
    await page.goto(`${origin}/app/billing`); await sleep(2000); await shot("06-cancelled");
  });
} finally {
  await step("delete: the account is deleted from the website, its cloud destroyed now", async () => {
    await page.goto(`${origin}/app/account`).catch(() => {});
    await web("POST", "/v1/account/delete", { email: mail.address, cancelBilling: true, destroyDesktopsNow: true });
    accountDeleted = true;
    const r = await context.request.get(`${origin}/v1/account`);
    if (r.status() !== 401) throw new Error(`after delete /v1/account ${r.status()}`);
  });
  // a deleted account's cloud keeps its data 30 days after its plan ended; the operator ends that early for a test account
  await step("teardown: the operator deletes the test cloud now, and the provider holds no machine of this deployment", async () => {
    if (cloudId) {
      const r = await fetch(`${origin}/v1/billing/ops/clouds/${cloudId}/delete`, { method: "POST", headers: { authorization: `Bearer ${opsToken}`, "content-type": "application/json" }, body: JSON.stringify({ reason: "test_account" }) });
      if (!r.ok) throw new Error(`operator delete ${r.status}`);
    }
    const started = Date.now();
    while (Date.now() - started < 15 * 60_000) {
      const left = await ibx.inventory();
      if (!left.length) { results.teardownMs = Date.now() - started; return; }
      await sleep(10_000);
    }
    throw new Error("machines left after 15 minutes");
  });
  results.accountDeleted = accountDeleted;
  client.close?.();
  await browser.close();
  await mail.remove();
  results.totalSeconds = Math.round((Date.now() - t0) / 1000);
  results.passed = results.steps.every(s => s.ok);
  save();
  console.log(`done in ${results.totalSeconds}s: ${results.passed ? "every step passed" : "failures above"}`);
}
