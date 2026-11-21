// The shorter first run in the real app, and the funnel's corner cards and dialogs, photographed light and dark on
// isolated fake-engine servers. Run: node --experimental-strip-types scripts/verify-funnel-preview.ts <dir>
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchVerificationServer } from "./control-madani.ts";
import { openHeadlessChrome, type HeadlessPage } from "./testing/headless-chrome.ts";
import { mountPreview } from "./testing/preview-fixture.ts";

const out = process.argv[2];
if (!out) throw new Error("usage: verify-funnel-preview.ts <dir>");
mkdirSync(out, { recursive: true });

const json = (res: ServerResponse, body: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
async function relay(url: string, req: IncomingMessage, res: ServerResponse, change: (body: Record<string, any>) => unknown) {
  const response = await fetch(`${url}${req.url}`, { headers: { accept: "application/json", cookie: req.headers.cookie ?? "" } });
  const body = await response.json() as Record<string, any>;
  res.statusCode = response.status;
  json(res, response.ok ? change(body) : body);
}

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function shoot(page: HeadlessPage, name: string) {
  for (const theme of ["light", "dark"] as const) {
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
    await pause(700);
    if (await page.evaluate("document.documentElement.scrollWidth > innerWidth")) console.error(`${name} ${theme}: the page scrolls sideways`);
    writeFileSync(join(out!, `${name}-${theme}.png`), await page.capture());
    console.log(join(out!, `${name}-${theme}.png`));
  }
  await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
}
const click = (page: HeadlessPage, label: string) => page.evaluate(`(() => {
  const button = [...document.querySelectorAll("button")].find((node) => node.textContent.trim() === ${JSON.stringify(label)});
  if (!button) throw new Error("no button " + ${JSON.stringify(label)});
  button.click();
})()`);

async function withPage<T>(run: (page: HeadlessPage) => Promise<T>): Promise<T> {
  const profile = mkdtempSync(join(tmpdir(), "madani-funnel-preview-"));
  const page = await openHeadlessChrome(profile);
  try {
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 2, mobile: false });
    return await run(page);
  } finally {
    page.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

/** One brand-new install: its own server, its engines signed in or not, its apps connected or not. */
async function firstRun(name: string, { signedIn, apps }: { signedIn: boolean; apps: string[] }) {
  const fixture = await launchVerificationServer();
  const ui = await mountPreview(fixture, {
    entry: "/scripts/testing/threads-preview.tsx", route: "/__threads.html", title: "First run", logLevel: "warn", hmr: false,
    extraRoutes: [
      { path: "/api/instances", method: "GET", handler: (req, res) => relay(fixture.info.url, req, res, (body) => ({ ...body,
        instances: (body.instances as Array<Record<string, any>>).map((instance) => ({ ...instance, snapshot: { ...instance.snapshot, authenticated: signedIn } })) })) },
      { path: "/api/connectors/connected", method: "GET", handler: (_req, res) => json(res, { configured: true, credentialStore: "ok", inventoryComplete: true,
        services: Object.fromEntries(apps.map((slug) => [slug, { connected: true }])) }) },
    ],
  });
  try {
    await withPage(async (page) => {
      await page.send("Page.navigate", { url: `${ui.previewUrl}?onboarding=1` });
      await page.until(`document.querySelector('[data-welcome="welcome"]') !== null`, 60_000);
      if (!signedIn) await shoot(page, `${name}-1-welcome`);
      await click(page, "Get started");
      await page.until(`document.querySelector('[data-welcome="ai"]') !== null || document.querySelector('[data-helper-intro]') !== null`, 30_000);
      if (!signedIn) {
        await page.until(`document.querySelectorAll('[data-funnel-ai]').length > 0`, 30_000);
        await shoot(page, `${name}-2-connect-ai`);
        return;
      }
      const settled = `document.querySelector('[data-helper-followup]') !== null && document.querySelectorAll('[data-helper-ask]').length === 3`;
      // the intro stages bubble by bubble, and replays once its transcript loads: it must hold still before the picture
      await page.until(settled, 90_000);
      await pause(4000);
      await page.until(settled, 90_000);
      await pause(1500);
      await shoot(page, `${name}-3-first-chat`);
      console.log(name, await page.evaluate(`[...document.querySelectorAll('[data-helper-ask]')].map((node) => node.textContent).join(" | ")`));
    });
  } finally {
    await ui.close();
    await fixture.close();
  }
}

const only = process.argv[3];
if (!only || only === "first-run") await firstRun("first-run", { signedIn: false, apps: [] });
if (!only || only === "chat") await firstRun("first-run-not-connected", { signedIn: true, apps: [] });
if (!only || only === "chat") await firstRun("first-run-connected", { signedIn: true, apps: ["gmail", "googlecalendar"] });
if (only && only !== "cards") process.exit(0);

const fixture = await launchVerificationServer();
const ui = await mountPreview(fixture, { entry: "/scripts/testing/funnel-preview.tsx", route: "/__funnel.html", title: "Funnel cards", logLevel: "warn", hmr: false });
try {
  await withPage(async (page) => {
    const views: Record<string, string> = {
      asleep: "[data-asleep-work-start]", late: "[data-late-routine-start]", "late-missed": "[data-late-routine-start]",
      plans: "[data-plan-terms]", "start-fresh": "input", settings: "[data-cloud-delete-account]",
    };
    for (const [view, ready] of Object.entries(views)) {
      await page.send("Page.navigate", { url: `${ui.previewUrl}?view=${view}` });
      await page.until(`document.querySelector(${JSON.stringify(ready)}) !== null`, 30_000);
      await shoot(page, view);
    }
  });
} finally {
  await ui.close();
  await fixture.close();
}
