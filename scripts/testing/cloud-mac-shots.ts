// Screenshots of "Let my cloud bots use this Mac": the Settings switch, the mac_exec approval card.
//   MADANI_CHROME=<chrome binary> node --experimental-strip-types scripts/testing/cloud-mac-shots.ts <out dir>
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "./chat-gallery/cdp.ts";
import { mountPreview } from "./preview-fixture.ts";

const out = process.argv[2] ?? "cloud-mac-shots";
const chromePath = process.env.MADANI_CHROME;
if (!chromePath) throw new Error("set MADANI_CHROME to a Chrome binary");
mkdirSync(out, { recursive: true });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const preview = await mountPreview({ info: { url: "http://127.0.0.1:9" } }, { entry: "/scripts/testing/cloud-mac-preview.tsx", route: "/__cloud-mac.html", title: "Cloud bots use this Mac", logLevel: "warn", hmr: false });
const profile = mkdtempSync(join(tmpdir(), "cloud-mac-chrome-"));
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
  const shot = async (name: string) =>
    writeFileSync(join(out, name), Buffer.from((await request("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 900, height: 420, scale: 1 } })).data, "base64"));
  await request("Page.enable");
  await request("Runtime.enable");
  await request("Emulation.setDeviceMetricsOverride", { width: 900, height: 420, deviceScaleFactor: 2, mobile: false });
  for (const [view, ready, name] of [
    ["settings", "[data-select-row]", "1-settings-switch.png"],
    ["restricted", "[data-settings-row=cloud-mac-folder]", "1b-settings-restricted.png"],
    ["approval", "[data-ask-card=approval]", "2-approval-card.png"],
  ] as const) {
    await request("Page.navigate", { url: `${preview.previewUrl}?view=${view}` });
    await until(`Boolean(document.querySelector(${JSON.stringify(ready)}))`);
    await wait(400);
    await shot(name);
  }
  cdp.close?.();
} finally {
  chrome.kill();
  await preview.close();
}
console.log(out);
