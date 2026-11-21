// Real renderer, disposable fake engine and browser profile only.
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { runControlMadani } from "../control-madani.ts";
import { UI_TOOLS_DIR } from "./control-madani-ui.ts";
import { clickByName, openBotSheet, sheetPage } from "./grok-nav.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const enabled = process.env.MADANI_UI_E2E === "1" || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));
interface FixtureInfo { ui: string; url: string; logPath: string }
interface SavedBot { id: string; name: string; modelSelection: { instanceId: string; model: string }; outbound?: unknown; connectorScopes?: unknown; fallback?: unknown }

describe("trust controls in the real renderer", () => {
  let child: ChildProcess | undefined;
  afterAll(async () => {
    if (child?.connected) child.send("stop");
    await waitForExit(child, { graceMs: 30_000 });
  });

  (enabled ? it : it.skip)("saves outbound limits, app limits and backup AIs from the bot's settings pages", async () => {
    let output = "", errors = "";
    let info!: FixtureInfo;
    const launcher = new URL("./control-madani-ui.ts", import.meta.url).href;
    const bootstrap = `import { launchUi } from ${JSON.stringify(launcher)};
      process.on('message', message => { if (message === 'stop') process.emit('SIGINT'); });
      try { await launchUi(['--tool-calls', '[{"name":"Bash","input":{"command":"echo fixture"},"ok":true}]']); } finally { process.disconnect(); }`;
    child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", bootstrap], {
      cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child.stdout!.on("data", (chunk: Buffer) => { output += String(chunk); });
    child.stderr!.on("data", (chunk: Buffer) => { errors += String(chunk); });
    child.on("error", error => { errors += error.message; });
    await expect.poll(() => {
      if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`UI launcher exited: ${errors}`);
      try { info = JSON.parse(output); return Boolean(info.ui); } catch { return false; }
    }, { timeout: 300_000, interval: 250 }).toBe(true);

    const ui = (verb: string, ...args: string[]) => runControlMadani(["ui", verb, "--ui", info.ui, ...args]) as Promise<Record<string, any>>;
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
    const click = (name: string) => ui("click", "--name", name);
    const type = async (name: string, text: string) => {
      // The mapped browser "type" appends and refocuses the field. Clear
      // through the native input setter first, including React's input event.
      await evaluate(`(() => {
        const input = [...document.querySelectorAll('input')].find(el => el.getAttribute('aria-label') === ${JSON.stringify(name)});
        if (!input) throw new Error('No input to clear');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await ui("type", "--name", name, "--text", text);
    };
    const snapshot = async () => (await ui("snapshot")).snapshot as string;
    const bots = async (): Promise<SavedBot[]> => (await fetch(`${info.url}/api/bots`).then(response => response.json())).bots;
    const bot = (await bots()).find(candidate => candidate.name === "Pepper")!;
    expect(bot).toBeDefined();
    const saved = async () => (await bots()).find(candidate => candidate.id === bot.id)!;

    // the bot runs a harmless fixture tool first. Its Activity panel, which showed that run, left the Share menu on
    // purpose in 65902595e, so the run is not read back on screen here.
    await runControlMadani(["send", "--bot", bot.id, "--text", "Run the harmless fixture tool.", "--url", info.url]);
    await runControlMadani(["wait", "--bot", bot.id, "--timeout", "20", "--url", info.url]);

    await openBotSheet(ui, "Pepper", "permissions");
    // Sending on your behalf is a menu on its row
    await clickByName(ui, "Sending on your behalf", "combobox");
    await clickByName(ui, "Allow a daily amount", "option");
    // the daily amount is a row that opens a small form
    await ui("eval", "--js", "document.querySelector('[data-settings-sheet] [data-sheet-row=per-day]').click(); true");
    await type("Daily outbound limit", "7");
    await clickByName(ui, "Save", "button");
    await expect.poll(async () => (await saved()).outbound, { timeout: 10_000 }).toEqual({ policy: "allow", dailyCap: 7 });
    await clickByName(ui, "Sending on your behalf", "combobox");
    await clickByName(ui, "Ask every time", "option");
    await expect.poll(async () => (await saved()).outbound, { timeout: 10_000 }).toEqual({ policy: "ask", dailyCap: 7 });

    // Only this page's inventory reads are synthetic; policy writes still
    // pass through the real bot queue and server validation.
    await evaluate(`(async () => {
      const original = window.fetch.bind(window);
      window.fetch = (input, init) => String(input) === '/api/connectors/connected'
        ? Promise.resolve(new Response(JSON.stringify({ services: { gmail: { connected: true } } }), { headers: {'content-type':'application/json'} }))
        : String(input) === '/api/connectors/tools'
          ? Promise.resolve(new Response(JSON.stringify({ configured: true, services: { gmail: [] } }), { headers: {'content-type':'application/json'} }))
          : original(input, init);
      await (await import('/src/lib/connected-apps.ts')).preloadConnectedApps(true);
      return true;
    })()`);
    await sheetPage(ui, "tools");
    // Which apps opens the app limits as a page of the sheet; each app's access is a menu on its row
    await expect.poll(() => evaluate("Boolean(document.querySelector('[data-settings-sheet] [data-sheet-row=app-limits]'))"), { timeout: 10_000 }).toBe(true);
    await evaluate("document.querySelector('[data-settings-sheet] [data-sheet-row=app-limits]').click(); true");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Limit this bot to specific apps");
    await click("Limit this bot to specific apps");
    await expect.poll(async () => (await saved()).connectorScopes, { timeout: 10_000 }).toEqual({ apps: {} });
    await clickByName(ui, /access$/, "combobox");
    await clickByName(ui, "Read", "option");
    await expect.poll(async () => (await saved()).connectorScopes, { timeout: 10_000 }).toEqual({ apps: { gmail: "read" } });
    expect(await snapshot()).toContain("Per-app tools");
    await clickByName(ui, /access$/, "combobox");
    await clickByName(ui, "Read & write", "option");
    await expect.poll(async () => (await saved()).connectorScopes, { timeout: 10_000 }).toEqual({ apps: { gmail: "write" } });
    await click("Limit this bot to specific apps");
    await expect.poll(async () => (await saved()).connectorScopes, { timeout: 10_000 }).toBeUndefined();
    // Seed a saved chain without any real account/auth or execution. The
    // bot's Backup AIs page must remove it via the existing bot patch queue.
    const seeded = await fetch(`${info.url}/api/bots/${bot.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ fallback: [{ instanceId: bot.modelSelection.instanceId, model: bot.modelSelection.model }] }),
    });
    expect(seeded.ok).toBe(true);
    await sheetPage(ui, "backups");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Used in order when the main AI fails.");
    expect(await snapshot()).toContain('list "Backup AIs"');
    await clickByName(ui, /^Remove .+ from backups$/, "button");
    await expect.poll(async () => (await saved()).fallback, { timeout: 10_000 }).toEqual([]);
    expect((await saved()).modelSelection).toEqual(bot.modelSelection);
    await ui("press", "--keys", "Escape");

    // Department memory was edited from the team map, which 4c3c20c48 removed on purpose with departments; nothing in
    // the app edits it now, so this run ends with the bot's own controls.
  }, 420_000);
});
