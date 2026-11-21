// Draws the store screenshot set from the phone app itself, in a headless Chrome at each store size, against an
// isolated workspace: `pnpm demo`'s seeded test bots (scripts/demo/content.mjs) with finished conversations, in a temp
// data folder on this script's own ports. Nothing is sent to a bot, so no engine runs.
//
//   node --experimental-strip-types apps/mobile/scripts/store-shots.ts [out=docs/store/ios]
//
// These are the app's real screens at the stores' pixel sizes, but a browser draws no iOS status bar and no home
// indicator. For the listing, retake them in the simulator once a runtime is installed (docs/mobile-readiness.md).
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { openHeadlessChrome, type HeadlessPage } from "../../../scripts/testing/headless-chrome.ts";

const [out = "docs/store/ios"] = process.argv.slice(2);
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
/** clear of the dev app (5199/8799), `pnpm demo` (5299/8899) and the phone preview (5320) */
const PORTS = { harness: 8930, ui: 5330, phone: 5331 };
/** css points and scale per store size: 6.9 inch is 1320 x 2868, 6.5 inch is 1284 x 2778 */
const SIZES = [{ name: "6.9", width: 440, height: 956, scale: 3 }, { name: "6.5", width: 428, height: 926, scale: 3 }];

const scratch = mkdtempSync(join(tmpdir(), "madani-store-shots-"));
const workspaceEnv = {
  ...process.env,
  MADANI_DEMO_DIR: join(scratch, "store-demo"),
  MADANI_DEMO_PORT: String(PORTS.harness),
  MADANI_DEMO_UI_PORT: String(PORTS.ui),
};

const run = (args: string[]) => new Promise<void>((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: REPO, env: workspaceEnv, stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${args.join(" ")} exited ${code}`)));
});

async function startPhone(): Promise<ChildProcess> {
  const vite = spawn(join(REPO, "node_modules/.bin/vite"), ["--config", "apps/mobile/vite.config.ts"], {
    cwd: REPO, stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, MADANI_PORT: String(PORTS.harness), MADANI_MOBILE_PORT: String(PORTS.phone) },
  });
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("the phone preview did not start within 60 seconds")), 60_000);
    vite.stdout!.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes("ready in")) { clearTimeout(timer); resolve(); }
    });
    vite.once("exit", (code) => { clearTimeout(timer); reject(new Error(`the phone preview exited ${code}`)); });
  });
  return vite;
}

const click = (page: HeadlessPage, expression: string) => page.evaluate(`(() => { const el = ${expression}; if (!el) return false; el.click(); return true; })()`);
const row = (name: string) => `[...document.querySelectorAll("button")].find((button) => button.textContent.includes(${JSON.stringify(name)}))`;
const chatHas = (text: string) => `Boolean(document.querySelector("[data-mobile-chat]")?.textContent.includes(${JSON.stringify(text)}))`;
const back = (page: HeadlessPage) => click(page, `document.querySelector("[data-mobile-chat] nav button")`);

async function shoot(base: string) {
  for (const size of SIZES) {
    const profile = mkdtempSync(join(tmpdir(), "madani-store-chrome-"));
    const page = await openHeadlessChrome(profile);
    const dir = join(out, size.name);
    mkdirSync(dir, { recursive: true });
    const shot = async (name: string) => { await delay(900); writeFileSync(join(dir, `${name}.png`), await page.capture()); console.log(`${dir}/${name}.png`); };
    const open = async (scheme: "light" | "dark", query = "") => {
      await page.send("Page.navigate", { url: `${base}/?frame=1&scheme=${scheme}${query}` });
      await delay(1500);
      await page.evaluate(`localStorage.clear(); localStorage.setItem("madani.mobile.introSeen", "1"); location.reload()`);
      await delay(2500);
    };
    const chat = async (name: string, waitFor: string) => {
      await click(page, row(name));
      await page.until(chatHas(waitFor), 20_000);
      // the page mounts offscreen and then slides in
      await delay(1600);
    };
    try {
      await page.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: size.scale, mobile: true });
      await page.send("Emulation.setTouchEmulationEnabled", { enabled: true });
      await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      await page.send("Page.enable");

      await open("light");
      await page.until(`document.body.textContent.includes("Shop standup")`, 30_000);
      await shot("01-your-bots");

      await chat("Rivet", "the checkout button now works on phones");
      await shot("02-text-a-bot");
      await back(page);
      await delay(1000);

      await chat("Shop standup", "Shop standup");
      await shot("03-rooms");
      await back(page);
      await delay(1000);

      await chat("Quill", "Which subject line should go out?");
      await shot("04-bots-ask-first");
      await back(page);
      await delay(1000);

      await open("dark");
      await page.until(`document.body.textContent.includes("Shop standup")`, 30_000);
      await shot("05-dark");

      await open("dark", "&pair=1");
      await page.until(`document.body.textContent.includes("scan")`, 20_000);
      await shot("06-pair-with-your-computer");
    } finally {
      page.close();
      // chrome is still writing its profile for a moment after it is told to quit
      await delay(500);
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }
  }
}

let phone: ChildProcess | null = null;
try {
  await run(["scripts/demo/demo.mjs", "start", "--no-open"]);
  phone = await startPhone();
  await shoot(`http://127.0.0.1:${PORTS.phone}`);
} finally {
  phone?.kill("SIGTERM");
  await run(["scripts/demo/demo.mjs", "stop"]).catch((error: unknown) => console.error(error));
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
