// Connecting an AI in a real browser against a real server (temporary home). Cursor here is the fake login CLI
// (server/testing/fake-login-cli.ts): its own sign-in prints Cursor's link and never finishes, so the card must end on a
// timeout message with Try again instead of waiting for ever. The other cards' stages are drawn from answers the page is
// given, for the screenshots. Runs where a Chromium and playwright-core are named:
//   MADANI_UI_CHROMIUM=<chrome or headless shell> MADANI_UI_PLAYWRIGHT_CORE=<playwright-core dir> MADANI_UI_DIST=<vite build dir>
//   [MADANI_UI_SHOTS=<folder for screenshots>] vitest run server/connect-ai.ui.e2e.test.ts
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { WELCOME_VERSION } from "../electron/onboarding-record.mjs";
import { launchVerificationServer } from "../scripts/control-madani.ts";

const { MADANI_UI_CHROMIUM: chromiumPath, MADANI_UI_PLAYWRIGHT_CORE: playwrightPath, MADANI_UI_DIST: dist } = process.env;
const shots = process.env.MADANI_UI_SHOTS ?? join(tmpdir(), "madanibot-verification-evidence", "connect-ai");
const ready = Boolean(chromiumPath && playwrightPath && dist);

let fixture: Awaited<ReturnType<typeof launchVerificationServer>>;
let browser: any;

beforeAll(async () => {
  if (!ready) return;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, ["cursorLogin"], dist);
  const { chromium } = createRequire(join(playwrightPath!, "package.json"))("playwright-core");
  // A mock keychain keeps the test browser from asking the person's macOS keychain for anything.
  browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: ["--use-mock-keychain", "--password-store=basic"] });
  mkdirSync(shots, { recursive: true });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await fixture?.close();
  vi.restoreAllMocks();
});

async function openModels(page: any) {
  await fetch(`${fixture.info.url}/api/config`, { method: "PUT", headers: { "content-type": "application/json", origin: fixture.info.url },
    body: JSON.stringify({ onboarding: { completedAt: new Date().toISOString(), version: WELCOME_VERSION } }) });
  await page.goto(fixture.info.url);
  return toModels(page);
}

async function toModels(page: any) {
  await page.locator("[data-sidebar-account]").first().click({ timeout: 30_000 });
  await page.getByRole("menuitem", { name: /^Settings/ }).first().click();
  await page.locator("[data-settings-pane=models], [data-pane=models]").first().click().catch(() => page.getByText("Models", { exact: true }).first().click());
  const grid = page.locator("[data-settings-block=connect-ai]");
  await grid.waitFor({ timeout: 30_000 });
  return grid;
}

it.skipIf(!ready)("a sign-in nobody finishes ends on its timeout message with Try again, and another card cancels it", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
  // the page's own clock, so the 15 minute sign-in deadline can pass in a moment
  await page.clock.install();
  const opened: string[] = [];
  await page.exposeFunction("__openedLink", (link: string) => { opened.push(link); });
  await page.addInitScript(() => {
    const page = globalThis as unknown as { open: (url: string) => null; __openedLink: (link: string) => void };
    page.open = (url) => { page.__openedLink(String(url)); return null; };
  });
  const grid = await openModels(page);
  const shot = (name: string) => grid.screenshot({ path: join(shots, name) });

  await grid.locator("button[data-funnel-ai=cursor]").click();
  const panel = grid.locator("[data-funnel-ai-connect=cursor] [data-connect-stage]");
  await expect.poll(() => panel.getAttribute("data-connect-stage"), { timeout: 30_000 }).toBe("waiting");
  expect(await panel.textContent()).toContain("Waiting for you to sign in");
  await expect.poll(() => opened, { timeout: 5_000 }).toEqual([expect.stringMatching(/^https:\/\/cursor\.com\/loginDeepControl\?/)]);
  await shot("cursor-waiting.png");

  await page.clock.fastForward("16:00");
  await expect.poll(() => panel.getAttribute("data-connect-stage"), { timeout: 15_000 }).toBe("failed");
  expect(await panel.locator("[role=alert]").textContent()).toBe("Cursor sign-in timed out. Try again when you're ready.");
  expect(await panel.getByRole("button", { name: "Try again" }).isVisible()).toBe(true);
  expect(await grid.locator(".animate-spin").count(), "no spinner left behind").toBe(0);
  await shot("cursor-timed-out.png");

  await panel.getByRole("button", { name: "Try again" }).click();
  await expect.poll(() => panel.getAttribute("data-connect-stage"), { timeout: 30_000 }).toBe("waiting");
  await grid.locator("button[data-funnel-ai=cursor]").click();
  expect(await grid.locator("[data-funnel-ai-connect]").count(), "pressing the card again closes it").toBe(0);
  expect(await grid.locator(".animate-spin").count()).toBe(0);
  await page.close();
}, 180_000);

it.skipIf(!ready)("each card's stage, for the record", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
  await page.addInitScript(() => { (globalThis as unknown as { open: () => null }).open = () => null; });
  const grid = await openModels(page);
  const shot = (name: string) => grid.screenshot({ path: join(shots, name) });
  const instances = async () => ((await (await fetch(`${fixture.info.url}/api/instances`, { headers: { origin: fixture.info.url } })).json()) as { instances: any[] }).instances;
  const base = await instances();
  const signedOut = (instanceId: string, driverKind: string, displayName: string, method: string) => ({
    instanceId, driverKind, displayName, access: "subscription", enabled: true, models: { default: "m", options: [] },
    snapshot: { state: "available", authenticated: false }, authentication: { method }, install: {},
  });
  const listed = [...base.filter((one) => !["chatgpt", "codex", "githubCopilot", "grok"].includes(one.instanceId)),
    signedOut("chatgpt", "codex", "ChatGPT plan", "device-code"), signedOut("githubCopilot", "copilotAgent", "GitHub Copilot", "device-code"),
    { ...signedOut("grok", "grokAgent", "Grok", "device-code"), snapshot: { state: "unavailable", reason: "grok CLI not found" }, install: { server: { standalone: { version: "1", downloadBytes: 48_000_000 } } } }];
  await page.route("**/api/instances?fresh=1", (route: any) => route.fulfill({ json: { instances: listed } }));
  await page.route("**/api/instances/chatgpt/auth/start", (route: any) => route.fulfill({ json: { auth: { phase: "waiting", flowId: "c1", authorizationUrl: "https://auth.openai.com/codex/device", userCode: "QX7P-4MZ2K" } } }));
  await page.route("**/api/instances/githubCopilot/auth/start", (route: any) => route.fulfill({ json: { auth: { phase: "waiting", flowId: "g1", authorizationUrl: "https://github.com/login/device", userCode: "7F3K-9QWD" } } }));
  await page.route("**/auth/status*", (route: any) => route.fulfill({ json: { auth: { phase: "waiting" } } }));
  await page.route("**/auth/cancel", (route: any) => route.fulfill({ json: { ok: true } }));
  await page.route("**/api/instances/grok/install", () => {});
  await page.reload();
  await toModels(page);

  for (const [tile, stage, name] of [["chatgpt", "waiting", "chatgpt-code.png"], ["copilot", "waiting", "copilot-code.png"], ["grok", "installing", "grok-installing.png"]] as const) {
    await grid.locator(`button[data-funnel-ai=${tile}]`).click();
    const panel = grid.locator(`[data-funnel-ai-connect=${tile}] [data-connect-stage]`);
    await expect.poll(() => panel.getAttribute("data-connect-stage"), { timeout: 15_000 }).toBe(stage);
    await shot(name);
  }
  expect(await grid.locator("[data-funnel-ai-connect]").count(), "one connect at a time").toBe(1);
  await page.close();
}, 180_000);
