// Screenshots of the person's avatar, light and dark: the account card, the picker open, and the sidebar's person row.
//   MADANI_CHROME=<chrome binary> node --experimental-strip-types scripts/testing/user-avatar-shots.ts <out dir>
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "./chat-gallery/cdp.ts";
import { mountPreview } from "./preview-fixture.ts";

const out = process.argv[2] ?? "user-avatar-shots";
const chromePath = process.env.MADANI_CHROME;
if (!chromePath) throw new Error("set MADANI_CHROME to a Chrome binary");
mkdirSync(out, { recursive: true });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const preview = await mountPreview({ info: { url: "http://127.0.0.1:9" } }, { entry: "/scripts/testing/user-avatar-preview.tsx", route: "/__user-avatar.html", title: "User avatar", logLevel: "warn", hmr: false });
const profile = mkdtempSync(join(tmpdir(), "user-avatar-chrome-"));
const chrome = spawn(chromePath, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--password-store=basic", "--use-mock-keychain", "--hide-scrollbars", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
try {
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 300 && !existsSync(portFile); i++) await wait(100);
  const [port, endpoint] = readFileSync(portFile, "utf8").trim().split("\n");
  const cdp = await connect(`ws://127.0.0.1:${port}${endpoint}`);
  const target = await cdp.request("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.request("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const request = (method: string, params: unknown = {}) => cdp.request(method, params, sessionId);
  const evaluate = async (expression: string) => (await request("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
  const until = async (expression: string) => { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await wait(100); } throw new Error(`timed out: ${expression}`); };
  const shot = async (name: string, clip?: { x: number; y: number; width: number; height: number }) =>
    writeFileSync(join(out, name), Buffer.from((await request("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) })).data, "base64"));
  await request("Page.enable");
  await request("Runtime.enable");
  await request("Emulation.setDeviceMetricsOverride", { width: 1100, height: 720, deviceScaleFactor: 2, mobile: false });
  for (const [theme, skin] of [["light", "grok"], ["dark", "grok-dark"]] as const) {
    await request("Page.navigate", { url: `${preview.previewUrl}?skin=${skin}` });
    await until(`Boolean(document.querySelector("[data-accounts-active] [data-user-avatar]"))`);
    await wait(500);
    await shot(`account-card-${theme}.png`);
    await evaluate(`document.querySelector("[data-accounts-avatar]").click()`);
    await until(`Boolean(document.querySelector("[data-avatar-picker]"))`);
    await wait(500);
    await shot(`picker-open-${theme}.png`);
    // the sidebar on its own, with no sheet over it
    await request("Page.navigate", { url: `${preview.previewUrl}?skin=${skin}&sheet=0` });
    await until(`Boolean(document.querySelector("aside [data-user-avatar]"))`);
    await wait(400);
    const box = await evaluate(`(() => { const r = document.querySelector("aside").getBoundingClientRect(); return { x: r.x, y: r.bottom - 120, width: r.width, height: 120 }; })()`);
    await shot(`sidebar-${theme}.png`, box);
  }
  cdp.close?.();
} finally {
  chrome.kill();
  await preview.close();
}
console.log(out);
