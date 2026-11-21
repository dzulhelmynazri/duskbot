import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { runControlMadani } from "../control-madani.ts";
import { agentBrowser, sessionEnv, UI_TOOLS_DIR, type UiHandle } from "./control-madani-ui.ts";
import { clickByName, openPanelMenu, settled as stillFrames } from "./grok-nav.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const enabled = process.env.MADANI_UI_E2E === "1" || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));
if (!enabled) console.log("skipping usage details UI: set MADANI_UI_E2E=1 to install the pinned browser");

(enabled ? it : it.skip)("renders separate cached input, uncached input and output after a real fixture turn", async () => {
  let child: ChildProcess | undefined;
  let info: { ui: string; url: string; botId: string; logPath: string } | undefined;
  try {
    let stdout = "", stderr = "";
    child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts/control-madani.ts"), "ui", "launch"], {
      cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", chunk => { stdout += String(chunk); });
    child.stderr!.on("data", chunk => { stderr += String(chunk); });
    await expect.poll(() => {
      if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`UI launcher exited: ${stderr}`);
      try { info = JSON.parse(stdout); return Boolean(info?.ui); } catch { return false; }
    }, { timeout: 600_000, interval: 250 }).toBe(true);
    const handle = info!;
    const ui = (verb: string, ...args: string[]) => runControlMadani(["ui", verb, "--ui", handle.ui, ...args]) as Promise<Record<string, any>>;
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
    const browser = JSON.parse(readFileSync(handle.ui, "utf8")) as UiHandle;
    const viewport = async (width: number) => {
      await agentBrowser(browser.binary, sessionEnv(browser), ["set", "viewport", String(width), "900"]);
      await expect.poll(() => evaluate("innerWidth")).toBe(width);
      // A phone's sidebar slides off the page; until it has, it covers the header.
      if (width < 768) await expect.poll(() => evaluate("document.querySelector('[data-sidebar]').getBoundingClientRect().right")).toBeLessThanOrEqual(0);
      // The composer resizes with a short motion; measure it at rest.
      await stillFrames(ui);
    };
    await ui("type", "--name", "Message Pepper", "--text", "Check the fixture usage");
    await ui("press", "--keys", "Enter");
    const settled = await ui("wait-settle", "--timeout", "60");
    await ui("type", "--name", "Message Pepper", "--text", "A draft that stays editable at every width");
    // The chat header is the pill alone on a desktop window; a phone's header keeps ⋯ with the conversation's usage
    // and export.
    await viewport(390);
    await ui("click", "--name", "More");
    const read = () => ui("eval", "--js", `(() => {
      const chip = document.querySelector('[data-testid="usage-chip"]');
      return { title: chip?.getAttribute('title'), text: chip?.textContent };
    })()`);
    await expect.poll(async () => (await read()).result?.title, { timeout: 15_000 }).toContain("Last message: 10 uncached input · 2 cached input · 5 output");
    const chip = (await read()).result;
    expect(chip.text).toContain("$0.01");
    expect(chip.title).not.toContain("17 read");
    expect(chip.title).not.toContain("15 new");
    // Header actions stay usable in the consolidated menu, including a
    // denied clipboard. Only this disposable browser's clipboard is stubbed.
    await evaluate(`Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async () => { throw new Error('fixture denial'); } }); true`);
    await ui("click", "--name", "Copy as Markdown");
    await expect.poll(() => evaluate("document.querySelector('[role=menu] [role=status]')?.textContent")).toBe("Couldn't copy. Use download instead.");
    await evaluate(`Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async text => { window.copiedTranscript = text; } }); true`);
    await evaluate(`document.querySelector('[role=menu] button:has([role=status])').click(); true`);
    await expect.poll(() => evaluate("document.querySelector('[role=menu] [role=status]')?.textContent")).toBe("Copied");
    expect(await evaluate("window.copiedTranscript")).toContain("Check the fixture usage");
    await ui("press", "--keys", "Escape");

    const geometry = [];
    for (const width of [390, 800, 1100, 1600]) {
      await viewport(width);
      const phone = width < 768;
      if (phone) {
        await ui("click", "--name", "More");
      } else {
        await expect.poll(() => evaluate("Boolean(document.querySelector('[data-testid=chat-more]'))")).toBe(false);
      }
      const layout = await evaluate(`(() => {
        const rect = selector => { const node = document.querySelector(selector); if (!node) return null; const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; };
        return { viewport: innerWidth, scroll: document.documentElement.scrollWidth,
          menu: rect('[role=menu][aria-label=More]'), editor: rect('.mention-editor'),
          row: rect('[data-composer-row]'), controls: rect('[data-composer-actions]'),
          wraps: getComputedStyle(document.querySelector('[data-composer-row]')).flexWrap === 'wrap' };
      })()`);
      expect(await evaluate("document.querySelectorAll('[data-chathead-controls] > div').length")).toBeLessThan(6);
      expect(layout.scroll).toBeLessThanOrEqual(width);
      expect(layout.viewport).toBe(width);
      if (phone) {
        expect(layout.menu.left).toBeGreaterThanOrEqual(0);
        expect(layout.menu.right).toBeLessThanOrEqual(width);
      }
      expect(layout.controls.width).toBeGreaterThan(0);
      // Simple mode keeps the editor and its controls on one row at every width.
      if (layout.wraps && layout.row.width < 480) {
        expect(layout.editor.width).toBeGreaterThanOrEqual(layout.row.width - 1);
        expect(layout.editor.bottom).toBeLessThanOrEqual(layout.controls.top);
      }
      geometry.push(layout);
      await ui("screenshot", "--out", `${handle.logPath}.header-${width}.png`);
      if (phone) await ui("press", "--keys", "Escape");
    }

    // Usage in that menu opens Settings at Usage & billing.
    await viewport(390);
    await ui("click", "--name", "More");
    const snapshot = await ui("snapshot", "--interactive");
    const usage = Object.entries(snapshot.refs as Record<string, { name: string; role: string }>).find(([, entry]) => entry.role === "menuitem" && entry.name.startsWith("Usage"))!;
    await ui("click", "--ref", `@${usage[0]}`);
    await expect.poll(async () => (await ui("snapshot")).snapshot as string, { timeout: 10_000 }).toContain('dialog "Settings"');
    expect(await evaluate("[...document.querySelectorAll('[role=dialog] h2')].some(heading => heading.textContent.trim() === 'Usage & billing')")).toBe(true);
    await ui("screenshot", "--out", `${handle.logPath}.settings-390.png`);
    await ui("press", "--keys", "Escape");
    await expect.poll(() => evaluate("Boolean(document.querySelector('[role=dialog]'))")).toBe(false);
    const consoleResult = await ui("console");
    expect((consoleResult.messages ?? []).filter((row: { type?: string }) => row.type === "error")).toEqual([]);
    const evidence = handle.logPath + ".usage-details.json";
    writeFileSync(evidence, JSON.stringify({ url: handle.url, botId: handle.botId, settled, chip, geometry, consoleResult }, null, 2));
    console.log(`Usage details renderer evidence: ${evidence}`);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 });
  }
}, 660_000);

// A desktop window's header is the pill alone; the conversation's usage, copy and download live in the bot panel's
// Share menu, Grok's one menu of rich items. Activity and the Inspector left it on purpose (65902595e, 71de7f59b).
(enabled ? it : it.skip)("keeps a desktop window's chat usage, copy and download in the bot panel's Share menu", async () => {
  let child: ChildProcess | undefined;
  let info: { ui: string; url: string; botId: string; logPath: string } | undefined;
  try {
    let stdout = "", stderr = "";
    child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts/control-madani.ts"), "ui", "launch"], {
      cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", chunk => { stdout += String(chunk); });
    child.stderr!.on("data", chunk => { stderr += String(chunk); });
    await expect.poll(() => {
      if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`UI launcher exited: ${stderr}`);
      try { info = JSON.parse(stdout); return Boolean(info?.ui); } catch { return false; }
    }, { timeout: 600_000, interval: 250 }).toBe(true);
    const handle = info!;
    const ui = (verb: string, ...args: string[]) => runControlMadani(["ui", verb, "--ui", handle.ui, ...args]) as Promise<Record<string, any>>;
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
    const menuOpen = () => evaluate("Boolean(document.querySelector('[data-panel-share-menu]'))");
    await ui("type", "--name", "Message Pepper", "--text", "Check the fixture usage");
    await ui("press", "--keys", "Enter");
    await ui("wait-settle", "--timeout", "60");
    const browser = JSON.parse(readFileSync(handle.ui, "utf8")) as UiHandle;
    const geometry = [];
    for (const width of [800, 1100, 1600]) {
      await agentBrowser(browser.binary, sessionEnv(browser), ["set", "viewport", String(width), "900"]);
      await expect.poll(() => evaluate("innerWidth")).toBe(width);
      await stillFrames(ui);
      await openPanelMenu(ui, "Pepper");
      const layout = await evaluate(`(() => {
        const r = document.querySelector('[data-panel-share-menu]').getBoundingClientRect();
        return { viewport: innerWidth, scroll: document.documentElement.scrollWidth, menu: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
          items: [...document.querySelectorAll('[data-panel-share-menu] [role=menuitem]')].map(item => item.dataset.panelShareItem),
          usage: document.querySelector('[data-panel-share-item=usage] [data-testid=usage-chip]')?.textContent ?? null };
      })()`);
      expect(layout.scroll).toBeLessThanOrEqual(width);
      expect(layout.menu.left).toBeGreaterThanOrEqual(0);
      expect(layout.menu.right).toBeLessThanOrEqual(width);
      expect(layout.menu.bottom).toBeLessThanOrEqual(900);
      expect(layout.items).toEqual(["duplicate", "copy", "download", "usage"]);
      expect(layout.usage).toContain("$0.01");
      geometry.push(layout);
      await ui("screenshot", "--out", `${handle.logPath}.panel-menu-${width}.png`);
      await ui("press", "--keys", "Escape");
      await expect.poll(menuOpen).toBe(false);
    }
    await agentBrowser(browser.binary, sessionEnv(browser), ["set", "viewport", "1100", "900"]);
    await expect.poll(() => evaluate("innerWidth")).toBe(1100);
    await stillFrames(ui);

    // Copy chat keeps the menu open and says what happened, a denied clipboard included.
    await evaluate(`Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async () => { throw new Error('fixture denial'); } }); true`);
    await openPanelMenu(ui, "Pepper");
    await clickByName(ui, /^Copy chat/, "menuitem");
    await expect.poll(() => evaluate("document.querySelector('[data-panel-share-menu] [role=status]')?.textContent")).toBe("Couldn't copy. Use download instead.");
    await evaluate(`Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async text => { window.copiedTranscript = text; } }); true`);
    await evaluate("document.querySelector('[data-panel-share-item=copy]').click(); true");
    await expect.poll(() => evaluate("document.querySelector('[data-panel-share-menu] [role=status]')?.textContent")).toBe("Copied");
    expect(await evaluate("window.copiedTranscript")).toContain("Check the fixture usage");
    await ui("press", "--keys", "Escape");
    await expect.poll(menuOpen).toBe(false);

    // Usage opens Settings at Usage & billing.
    await openPanelMenu(ui, "Pepper");
    await clickByName(ui, /^Usage/, "menuitem");
    await expect.poll(async () => (await ui("snapshot")).snapshot as string, { timeout: 10_000 }).toContain('dialog "Settings"');
    expect(await evaluate("[...document.querySelectorAll('[role=dialog] h2')].some(heading => heading.textContent.trim() === 'Usage & billing')")).toBe(true);
    await ui("screenshot", "--out", `${handle.logPath}.settings-1100.png`);
    await ui("press", "--keys", "Escape");
    await expect.poll(() => evaluate("[...document.querySelectorAll('[role=dialog] h2')].some(heading => heading.textContent.trim() === 'Usage & billing')")).toBe(false);

    const consoleResult = await ui("console");
    expect((consoleResult.messages ?? []).filter((row: { type?: string }) => row.type === "error")).toEqual([]);
    writeFileSync(handle.logPath + ".panel-menu.json", JSON.stringify({ geometry }, null, 2));
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 });
  }
}, 660_000);
