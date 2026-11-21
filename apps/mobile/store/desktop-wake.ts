// The desktop app's bot panel waking a sleeping cloud computer while the person switches to Details and back, in headless
// Chrome on the stage fixture. Only the cloud computer's own routes are played in the page (asleep, a wake held until
// released, a screenshot); everything else is the fixture's real server.
//
//   node --experimental-strip-types apps/mobile/store/desktop-wake.ts --out dir
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { startStage } from "./stage.ts";

const { values: args } = parseArgs({ options: { out: { type: "string" } } });
if (!args.out) throw new Error("--out <dir>");
mkdirSync(args.out, { recursive: true });

const COMPUTER = `(() => {
  window.__errors = [];
  addEventListener("error", (event) => window.__errors.push(String(event.message)));
  addEventListener("unhandledrejection", (event) => window.__errors.push(String(event.reason)));
  const canvas = document.createElement("canvas");
  canvas.width = 1280; canvas.height = 800;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#1f3b5a"; ctx.fillRect(0, 0, 1280, 800);
  ctx.fillStyle = "#e8eef5"; ctx.font = "56px sans-serif"; ctx.fillText("Nova's cloud desktop", 120, 420);
  const frame = canvas.toDataURL("image/png").split(",")[1];
  const wake = window.__wake = { awake: false, provisions: 0, release: () => {} };
  const real = window.fetch.bind(window);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const status = () => ({ surface: "cloud", backend: "vps", configured: true, daemonUp: true, managed: true, imageMatches: true,
    ready: wake.awake, container: wake.awake ? "running" : "stopped", state: wake.awake ? "running" : "stopped", problem: null });
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const path = url.replace(location.origin, "").split("?")[0];
    if (/^\\/api\\/bots\\/[\\w-]+\\/computer$/.test(path)) return json(status());
    if (path.endsWith("/computer/provision")) {
      wake.provisions++;
      await new Promise((resolve) => { wake.release = resolve; });
      wake.awake = true;
      return json(status());
    }
    if (path.endsWith("/computer/screenshot")) return wake.awake ? json({ png: frame, format: "png" }) : json({ error: "asleep" }, 409);
    if (path.endsWith("/computer/join") || path.startsWith("/api/desktop-viewer/")) return json({ error: "screenshots only here" }, 409);
    if (path.endsWith("/computer/control")) return json({ held: false, helpReason: null });
    const answer = await real(input, init);
    if (path === "/api/config" || path === "/api/instances" || path === "/api/bots") {
      const data = await answer.clone().json().catch(() => null);
      if (!data) return answer;
      if (path === "/api/config") {
        data.vps = { ...(data.vps ?? {}), configured: true, mode: "shared", sshAlias: "fixture" };
        data.onboarding = { ...(data.onboarding ?? {}), completedAt: Date.now(), version: 999 };
        // the owner's case: the app is a madani cloud's, so the bot's computer is the cloud's own desktop
        data.cloudHome = true;
      }
      const instances = Array.isArray(data) ? data : Array.isArray(data.instances) ? data.instances : [];
      if (path === "/api/instances") for (const one of instances) one.capabilities = { ...(one.capabilities ?? {}), computerMcp: true, browserMcp: true };
      if (path === "/api/bots") for (const bot of Array.isArray(data.bots) ? data.bots : []) if (bot.name === "Nova") bot.computer = "cloud";
      return json(data, answer.status);
    }
    return answer;
  };
})()`;

const stage = await startStage({ args: ["--config", "vite.config.ts"], ready: "ready in" });
try {
  const page = stage.page;
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
  await page.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: COMPUTER });
  const ui = Number(process.env.MADANI_UI_PORT) || 5199;
  await page.send("Page.navigate", { url: `http://127.0.0.1:${ui}/` });
  await page.until(`[...document.querySelectorAll("*")].some((el) => el.children.length === 0 && el.textContent.trim() === "Nova")`, 60_000).catch(async (error) => {
    const { data } = await page.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(args.out!, "failed.png"), Buffer.from(data, "base64"));
    console.log(await page.evaluate("location.href + ' ' + document.body.innerText.slice(0, 400) + ' ' + JSON.stringify(window.__errors ?? [])"));
    throw error;
  });
  await delay(1500);
  const shot = async (name: string) => {
    const { data } = await page.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(args.out!, name), Buffer.from(data, "base64"));
  };
  const clickText = (text: string) => page.evaluate(`(() => {
    const leaf = [...document.querySelectorAll("*")].find((el) => el.children.length === 0 && el.textContent.trim() === ${JSON.stringify(text)});
    const el = leaf?.closest("button, a, [role=button], [role=link], [role=option], [tabindex]") ?? leaf;
    el?.click();
    return Boolean(el);
  })()`);
  const stage_ = () => page.evaluate(`document.querySelector("[data-inline-computer]")?.getAttribute("data-stage") ?? (document.querySelector("[data-panel-screen]") ? "asleep" : "none")`);
  await clickText("Nova");
  await delay(1500);
  await page.evaluate(`(document.querySelector("[data-chathead-pill], [data-tour=bot-pill]") ?? [...document.querySelectorAll("main button")].find((el) => el.textContent.trim() === "Nova"))?.click()`);
  await page.until(`Boolean(document.querySelector("[data-panel-tab=computer]"))`, 15_000);
  await delay(800);
  await page.evaluate(`document.querySelector("[data-panel-tab=computer]")?.click()`);
  await delay(1500);
  const log: Array<Record<string, unknown>> = [];
  const step = async (name: string) => { log.push({ step: name, stage: await stage_(), provisions: await page.evaluate("window.__wake.provisions") }); await shot(`${String(log.length).padStart(2, "0")}-${name}.png`); };
  await step("asleep");
  await page.evaluate(`document.querySelector("[data-panel-screen] button")?.click()`);
  await delay(900);
  await step("waking");
  await page.evaluate(`document.querySelector("[data-panel-tab=details]")?.click()`);
  await delay(1500);
  await step("details-mid-wake");
  await page.evaluate(`document.querySelector("[data-panel-tab=computer]")?.click()`);
  await delay(900);
  await step("back-still-waking");
  await page.evaluate(`window.__wake.release()`);
  await delay(2500);
  await step("awake");
  writeFileSync(join(args.out, "steps.json"), JSON.stringify(log, null, 2));
  console.log(JSON.stringify(log));
} finally {
  await stage.stop();
}
process.exit(0);
