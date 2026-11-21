// Screenshots of bringing bots here from a server of the person's own and of Google's paste-back sign-in, then one
// labelled contact sheet of them all.
//   MADANI_CHROME=<chrome binary> node --experimental-strip-types scripts/testing/move-back-shots.ts <out dir>
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "./chat-gallery/cdp.ts";
import { mountPreview } from "./preview-fixture.ts";

const out = process.argv[2] ?? "move-back-shots";
const chromePath = process.env.MADANI_CHROME;
if (!chromePath) throw new Error("set MADANI_CHROME to a Chrome binary");
mkdirSync(out, { recursive: true });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const SHOTS = [
  ["idle", "[data-bring-from]", "Settings > Transfer: Bring bots here (idle)"],
  ["confirm", "[role=dialog], [role=alertdialog]", "Settings > Transfer: the ask before bringing"],
  ["progress", "[data-bring-from]", "Settings > Transfer: in progress (step line)"],
  ["refused", "[data-bring-from]", "Settings > Transfer: refused, this Mac has bots"],
  ["failed", "[data-bring-from]", "Settings > Transfer: failed"],
  ["empty", "[data-mac-empty-back]", "Empty-computer dialog: Bring them back here"],
  ["google", "[data-sign-in=redirect]", "Google sign-in on a server: paste the address back"],
] as const;
const preview = await mountPreview({ info: { url: "http://127.0.0.1:9" } }, { entry: "/scripts/testing/move-back-preview.tsx", route: "/__move-back.html", title: "Bring bots here", logLevel: "warn", hmr: false });
const profile = mkdtempSync(join(tmpdir(), "move-back-chrome-"));
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
  await request("Page.enable");
  await request("Runtime.enable");
  await request("Emulation.setDeviceMetricsOverride", { width: 860, height: 560, deviceScaleFactor: 2, mobile: false });
  const shots: Array<{ label: string; data: string }> = [];
  for (const [view, ready, label] of SHOTS) {
    await request("Page.navigate", { url: `${preview.previewUrl}?view=${view === "confirm" ? "idle" : view}` });
    await until(`Boolean(document.querySelector("[data-bring-from], [data-mac-empty-back], [data-sign-in]"))`);
    if (view === "confirm") await evaluate(`document.querySelector("[data-bring-from]").click()`);
    await until(`Boolean(document.querySelector(${JSON.stringify(ready)}))`);
    await wait(700);
    const data = (await request("Page.captureScreenshot", { format: "png" })).data as string;
    writeFileSync(join(out, `vps-${view}.png`), Buffer.from(data, "base64"));
    shots.push({ label, data });
  }
  const cells = shots.map(({ label, data }) => `<figure><figcaption>${label}</figcaption><img src="data:image/png;base64,${data}"></figure>`).join("");
  await request("Emulation.setDeviceMetricsOverride", { width: 1800, height: 1000, deviceScaleFactor: 1, mobile: false });
  await request("Page.navigate", { url: "about:blank" });
  await evaluate(`document.write(${JSON.stringify(`<style>body{margin:0;padding:24px;background:#e9e9ec;font:600 15px system-ui;display:grid;grid-template-columns:repeat(3,1fr);gap:20px}figure{margin:0}figcaption{margin:0 0 8px}img{width:100%;border-radius:10px;display:block}</style>${cells}`)}); document.close(); true`);
  await wait(500);
  const height = await evaluate("document.documentElement.scrollHeight");
  await request("Emulation.setDeviceMetricsOverride", { width: 1800, height, deviceScaleFactor: 1, mobile: false });
  writeFileSync(join(out, "vps-google-contact-sheet.png"), Buffer.from((await request("Page.captureScreenshot", { format: "png" })).data, "base64"));
  cdp.close?.();
} finally {
  chrome.kill();
  await preview.close();
}
console.log(out);
