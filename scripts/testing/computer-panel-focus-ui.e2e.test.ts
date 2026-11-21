// The bot panel's Computer tab, the real computer panel, and real key presses:
// the renderer's focus hand-off is only provable in a browser.
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { runControlMadani } from "../control-madani.ts";
import { UI_TOOLS_DIR } from "./control-madani-ui.ts";
import { clickByName } from "./grok-nav.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const binary = resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env });
const enabled = process.env.MADANI_UI_E2E === "1" || Boolean(binary);
if (!enabled) console.info("skipping computer panel focus UI e2e: set MADANI_UI_E2E=1 to install the pinned browser");

(enabled ? it : it.skip)("hands the keyboard's open to the panel's tab, and the close back to the bot's row", async () => {
  let child: ChildProcess | undefined;
  let info: { ui: string } | undefined;
  try {
    let stdout = "", stderr = "";
    child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts/control-madani.ts"), "ui", "launch"], {
      cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    child.on("error", error => { stderr += error.message; });
    await expect.poll(() => {
      if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`UI launcher exited: ${stderr}`);
      try { info = JSON.parse(stdout); return Boolean(info?.ui); } catch { return false; }
    }, { timeout: binary ? 180_000 : 600_000, interval: 250 }).toBe(true);
    const ui = (verb: string, ...args: string[]) => runControlMadani(["ui", verb, "--ui", info!.ui, ...args]) as Promise<Record<string, any>>;
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
    const visible = (selector: string) => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
    const entryFocus = () => evaluate(`(() => {
      const active = document.activeElement;
      const tabs = document.querySelector('[data-testid="computer-tabs"]');
      return {
        tab: Boolean(active && tabs && tabs.contains(active) && active.getAttribute('aria-selected') === 'true'),
        close: Boolean(active && active.hasAttribute('data-computer-panel-close')),
        ring: Boolean(active && active.matches(':focus-visible')),
      };
    })()`);
    const panelOpen = () => visible('[data-computer-panel-close]');

    // The chat header is the pill alone; the bot's screen opens from its panel's Computer tab, which closes as the
    // computer panel opens, so the close hands focus to the bot's sidebar row.
    const screen = '[data-panel-action="open-computer"]';
    const botRow = `[data-sidebar-bot-row="${info!.botId}"]`;
    const openComputerTab = async () => {
      await clickByName(ui, /^Open Pepper's profile/, "button");
      await clickByName(ui, "Computer", "tab");
      await expect.poll(() => visible(screen), { timeout: 15_000 }).toBe(true);
    };
    await openComputerTab();
    await evaluate(`(() => { document.querySelector(${JSON.stringify(screen)}).focus(); return true; })()`);
    expect(await evaluate("document.activeElement.dataset.panelAction")).toBe("open-computer");
    await ui("press", "--keys", "Enter");
    await expect.poll(panelOpen, { timeout: 15_000 }).toBe(true);
    await expect.poll(entryFocus, { timeout: 5_000 }).toMatchObject({ tab: true, close: false, ring: true });

    // Enter on the panel's own close button hands focus back to the bot's row.
    await evaluate("document.querySelector('[data-computer-panel-close]').focus(); true");
    await ui("press", "--keys", "Enter");
    await expect.poll(panelOpen, { timeout: 5_000 }).toBe(false);
    await expect.poll(() => evaluate(`document.activeElement === document.querySelector(${JSON.stringify(botRow)})`), { timeout: 5_000 }).toBe(true);

    // A pointer click carries no keyboard intent: the panel must not take focus.
    await openComputerTab();
    const name = await evaluate(`document.querySelector(${JSON.stringify(screen)}).getAttribute('aria-label')`) as string;
    await clickByName(ui, name, "button");
    await expect.poll(panelOpen, { timeout: 15_000 }).toBe(true);
    await new Promise((done) => setTimeout(done, 500));
    expect(await entryFocus()).toMatchObject({ tab: false, close: false });
  } finally {
    await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 });
  }
}, binary ? 300_000 : 720_000);
