// Full-app regression through the existing disposable browser harness. No
// real provider, OAuth account, MCP package, or user data is used.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { BOT_ROLES } from "../../src/lib/bot-roles.ts";
import { runControlMadani } from "../control-madani.ts";
import { UI_TOOLS_DIR } from "./control-madani-ui.ts";
import { closeBotPanel, openBotSheet, openPanelMenu, openTemplates } from "./grok-nav.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const binary = resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env });
const forced = process.env.MADANI_UI_E2E === "1";
const enabled = forced || Boolean(binary);
if (!enabled) console.log("skipping bot tools UI e2e: no agent-browser; set MADANI_UI_E2E=1 to install the pinned release");
const LAUNCH_TIMEOUT_MS = forced && !binary ? 600_000 : 180_000;

interface FixtureInfo { ui: string; url: string; dataDir: string; logPath: string }
interface SavedBot { id: string; name: string; soul?: string; mcpServers?: string[]; computer?: string; browser?: boolean }

describe("bot setup and tools in the real renderer", () => {
  let child: ChildProcess | undefined;
  let info: FixtureInfo;
  afterAll(async () => {
    if (child?.connected) child.send("stop");
    await waitForExit(child, { graceMs: 30_000 });
  });

  (enabled ? it : it.skip)("makes bots at once, configures per-bot MCP access, and recovers a rejected ready-made bot", async () => {
    let stdout = "";
    let stderr = "";
    // Windows kill("SIGINT") terminates immediately instead of delivering a
    // catchable signal. Ask the disposable launcher to run its normal cleanup.
    const launcher = new URL("./control-madani-ui.ts", import.meta.url).href;
    const bootstrap = `import { launchUi } from ${JSON.stringify(launcher)};
      process.on('message', message => { if (message === 'stop') process.emit('SIGINT'); });
      try { await launchUi([]); } finally { process.disconnect(); }`;
    child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", bootstrap], {
      cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child.stdout!.on("data", (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    child.on("error", (error) => { stderr += error.message; });
    await expect.poll(() => {
      if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`UI launcher exited: ${stderr}`);
      try { info = JSON.parse(stdout); return Boolean(info.ui); } catch { return false; }
    }, { timeout: LAUNCH_TIMEOUT_MS + 120_000, interval: 250 }).toBe(true);
    const ui = (verb: string, ...args: string[]) => runControlMadani(["ui", verb, "--ui", info.ui, ...args]) as Promise<Record<string, any>>;
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
    const click = (name: string) => ui("click", "--name", name);
    const press = (keys: string) => ui("press", "--keys", keys);
    const bots = async (): Promise<SavedBot[]> => (await fetch(`${info.url}/api/bots`).then((response) => response.json())).bots;
    const snapshot = async () => (await ui("snapshot")).snapshot as string;
    // Panel > Advanced > Tools: Settings' Bots pane at its tools (apps, MCP servers, tool selection).
    const openTools = async () => openBotSheet(ui, created[0].name, "tools");
    // its MCP servers row opens their page of the sheet: each server's switch and Add
    const openServers = async () => {
      await openTools();
      await evaluate("document.querySelector('[data-settings-sheet] [data-sheet-row=servers]').click(); true");
    };
    const dialogCount = () => evaluate("document.querySelectorAll('[role=dialog]').length");
    const original = await bots();

    // Hold creation in this disposable browser: New bot again while the first
    // is in flight must not make a second bot. New bot asks for a name first.
    await evaluate(`(() => {
      const fetch = window.fetch.bind(window);
      window.botCreateRequests = 0;
      window.fetch = (input, init) => {
        if (String(input) === '/api/bots' && init?.method === 'POST') {
          window.botCreateRequests++;
          return new Promise(resolve => {
            window.releaseBotCreation = () => { window.fetch = fetch; resolve(fetch(input, init)); };
          });
        }
        return fetch(input, init);
      };
      return true;
    })()`);
    const creatingDisabled = () => evaluate("[...document.querySelectorAll('[data-create-bot-dialog] button')].find(button => button.textContent.trim() === 'Creating…')?.disabled ?? null");
    await press("Control+n");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain('dialog "Create new bot"');
    await ui("type", "--name", "Bot name", "--text", "Fixture helper");
    await press("Enter");
    await expect.poll(() => evaluate("window.botCreateRequests"), { timeout: 10_000 }).toBe(1);
    // the dialog stays open, saying it is creating, until the bot exists (4a70e281f); Enter again makes no second bot
    expect(await dialogCount()).toBe(1);
    expect(await creatingDisabled()).toBe(true);
    await press("Enter");
    expect(await evaluate("window.botCreateRequests")).toBe(1);
    await press("Escape");
    expect(await dialogCount()).toBe(0);
    await evaluate("window.releaseBotCreation(); true");
    await expect.poll(async () => (await bots()).length, { timeout: 10_000 }).toBe(original.length + 1);
    expect(await evaluate("window.botCreateRequests")).toBe(1);
    const created = (await bots()).filter((bot) => !original.some((old) => old.id === bot.id));
    expect(created).toHaveLength(1);
    expect(original.map((bot) => bot.name)).not.toContain(created[0].name);
    expect(created[0].name).toBe("Fixture helper");
    expect(created[0].computer).toBe(original[0].computer);
    expect(created[0].browser).toBe(original[0].browser);
    // Its chat is open, ready for the first message.
    await expect.poll(() => evaluate("document.activeElement?.getAttribute('aria-label')"), { timeout: 10_000 }).toBe(`Message ${created[0].name}`);
    expect(await dialogCount()).toBe(0);

    // Give the selected disposable bot real usage so its header shortcut
    // exercises the same external open action as the shipped chat header.
    await runControlMadani(["send", "--bot", created[0].id, "--text", "Reply briefly for the sidebar test.", "--url", info.url]);
    expect((await runControlMadani(["wait", "--bot", created[0].id, "--timeout", "20", "--url", info.url]) as { status: string }).status).toBe("settled");
    await openTools();
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("No servers");
    await press("Escape");
    await expect.poll(() => evaluate("Boolean(document.querySelector('[data-settings-sheet]'))"), { timeout: 10_000 }).toBe(false);
    // The panel's Share menu shows this chat's cost; its Usage opens Settings at Usage & billing.
    await openPanelMenu(ui, created[0].name);
    const state = await ui("snapshot", "--interactive");
    const cost = Object.entries(state.refs as Record<string, { role: string; name: string }>)
      .filter(([, entry]) => entry.role === "menuitem" && /^Usage \$0\.0[1-9]/.test(entry.name));
    expect(cost).toHaveLength(1);
    await ui("click", "--ref", `@${cost[0][0]}`);
    await expect.poll(snapshot, { timeout: 10_000 }).toContain('dialog "Settings"');
    await expect.poll(() => evaluate("[...document.querySelectorAll('[role=dialog] h2')].some(heading => heading.textContent.trim() === 'Usage & billing')"), { timeout: 10_000 }).toBe(true);
    await ui("screenshot", "--out", `${info.logPath}.settings.png`);
    await press("Escape");
    await expect.poll(() => evaluate("[...document.querySelectorAll('[role=dialog] h2')].some(heading => heading.textContent.trim() === 'Usage & billing')"), { timeout: 10_000 }).toBe(false);
    await openServers();
    await click("Add an MCP server…");
    // The registry loads on mount; Add MCP server is disabled until it finishes.
    await expect.poll(() => evaluate("[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add MCP server')?.disabled"), { timeout: 10_000 }).toBe(false);
    await click("Add MCP server");
    await expect.poll(() => evaluate("Boolean(document.querySelector('textarea[aria-label=\"Server link or setup command\"]'))"), { timeout: 10_000 }).toBe(true);
    const pasted = await ui("snapshot", "--interactive");
    const textarea = Object.entries(pasted.refs as Record<string, { role: string; name: string }>)
      .find(([, entry]) => entry.role === "textbox" && entry.name === "Server link or setup command");
    expect(textarea).toBeDefined();
    await ui("type", "--ref", `@${textarea![0]}`, "--text", JSON.stringify({ mcpServers: {
      fixture: { command: process.execPath, args: ["-e", "process.exit(0)"] },
    } }));
    // the chat's composer has an Add of its own beside the form's
    const add = Object.entries(pasted.refs as Record<string, { role: string; name: string }>)
      .filter(([, entry]) => entry.role === "button" && entry.name === "Add").map(([ref]) => ref);
    const formAdd = (await evaluate(`(() => { const form = document.querySelector('textarea[aria-label="Server link or setup command"]').closest('form, [role=dialog]'); return [...form.querySelectorAll('button')].some(button => button.textContent.trim() === 'Add'); })()`)) as boolean;
    expect(formAdd).toBe(true);
    expect(add.length).toBeGreaterThan(0);
    await evaluate(`[...document.querySelector('textarea[aria-label="Server link or setup command"]').closest('form, [role=dialog]').querySelectorAll('button')].find(button => button.textContent.trim() === 'Add').click(); true`);
    const registry = async () => (await fetch(`${info.url}/api/mcp/servers`).then((response) => response.json())).servers;
    // It exits before answering, so it is saved but stays off, with the reason on its row.
    await expect.poll(registry, { timeout: 10_000 }).toMatchObject([{ name: "fixture", enabled: false }]);
    await expect.poll(() => evaluate("document.body.textContent.includes(\"Saved, but off: the test failed.\")"), { timeout: 20_000 }).toBe(true);
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Turn fixture on");
    await click("Turn fixture on");
    await expect.poll(registry, { timeout: 10_000 }).toMatchObject([{ name: "fixture", enabled: true }]);
    // Escape leaves Connect Apps, which the link opened in place of the sheet; the switch it turned on let focus go
    const connectApps = () => evaluate("Boolean(document.querySelector('.ca-scrim'))");
    for (let round = 0; round < 3 && await connectApps(); round++) {
      await evaluate("(document.querySelector('[data-connect-apps] [role=dialog]') ?? document.querySelector('[data-connect-apps] [tabindex]'))?.focus(); true");
      await press("Escape");
      await expect.poll(connectApps, { timeout: 2_000 }).toBe(false).catch(() => {});
    }
    expect(await connectApps()).toBe(false);
    await openServers();
    await expect.poll(() => evaluate("document.querySelector('[aria-label=\"Let this bot use fixture\"]')?.getAttribute('aria-checked')"), { timeout: 10_000 }).toBe("true");
    await click("Let this bot use fixture");
    await expect.poll(async () => (await bots()).find((bot) => bot.id === created[0].id)?.mcpServers, { timeout: 10_000 }).toEqual([]);
    await press("Escape");
    await openServers();
    await expect.poll(() => evaluate("document.querySelector('[aria-label=\"Let this bot use fixture\"]')?.getAttribute('aria-checked')"), { timeout: 10_000 }).toBe("false");

    // New bot from above settings puts the new bot's chat in front: no
    // modal is left behind to hold the focus.
    const beforeShortcut = await bots();
    await press("Control+n");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain('dialog "Create new bot"');
    await ui("type", "--name", "Bot name", "--text", "Third helper");
    await press("Enter");
    await expect.poll(async () => (await bots()).length, { timeout: 10_000 }).toBe(beforeShortcut.length + 1);
    // the docked panel stays beside the new bot's chat, as Grok's does; the sheet over it is gone
    await expect.poll(() => evaluate("document.querySelectorAll('[aria-modal=true]').length"), { timeout: 10_000 }).toBe(0);
    await closeBotPanel(ui);
    await expect.poll(dialogCount, { timeout: 10_000 }).toBe(0);

    // A failed profile step must roll back the incomplete ready-made bot and
    // leave Templates open for a single successful retry. Add makes the bot at
    // once, with no review step, since the one create flow (89d92585f).
    const beforeFailure = await bots();
    await evaluate(`(() => {
      const fetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const path = input instanceof Request ? input.url : String(input);
        if (init?.method === 'PATCH' && /\\/api\\/bots\\/[^/]+$/.test(path) && typeof init.body === 'string' && JSON.parse(init.body).soul) {
          window.fetch = fetch;
          return Promise.resolve(new Response(JSON.stringify({error:'Fixture preset rejected'}), {status:409, headers:{'content-type':'application/json'}}));
        }
        return fetch(input, init);
      };
      return true;
    })()`);
    const ops = BOT_ROLES.find((role) => role.id === "ops")!;
    const addOps = `Add ${ops.name}, ${ops.title}`;
    await openTemplates(ui);
    await expect.poll(snapshot, { timeout: 20_000 }).toContain(addOps);
    await click(addOps);
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Fixture preset rejected");
    expect((await bots()).map(bot => bot.id)).toEqual(beforeFailure.map(bot => bot.id));
    expect(await snapshot()).toContain('dialog "Templates"');
    await click(addOps);
    await expect.poll(async () => (await bots()).length, { timeout: 10_000 }).toBe(beforeFailure.length + 1);
    await expect.poll(dialogCount, { timeout: 10_000 }).toBe(0);
    expect((await bots()).filter(bot => !beforeFailure.some(old => old.id === bot.id))).toMatchObject([{ name: ops.name, soul: ops.soul }]);
    const logs = await ui("console");
    expect((logs.messages as Array<{ type: string; text: string }>).filter((entry) => entry.type === "error")).toEqual([]);
    if (child?.connected) child.send("stop");
    await waitForExit(child, { graceMs: 30_000 });
    expect(child.exitCode).toBe(0);
    expect(existsSync(info.dataDir)).toBe(false);
    expect(existsSync(info.logPath)).toBe(true);
  }, LAUNCH_TIMEOUT_MS + 300_000);
});
