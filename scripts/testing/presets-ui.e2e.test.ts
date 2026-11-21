import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { runControlMadani } from "../control-madani.ts";
import { request } from "../mcp-server.ts";
import { UI_TOOLS_DIR } from "./control-madani-ui.ts";
import { openTemplatesWhenFree } from "./grok-templates.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const binary = resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env });
const forced = process.env.MADANI_UI_E2E === "1";
const enabled = forced || Boolean(binary);
const launchTimeout = forced && !binary ? 600_000 : 180_000;
if (!enabled) console.log("skipping presets UI e2e: set MADANI_UI_E2E=1 to install the pinned browser");
const evidence = (name: string) => join(ROOT, ".madani-scratch", "verify-evidence", `presets-${name}.png`);

describe("Preset bots in the real renderer", () => {
  let child: ChildProcess | undefined;
  afterAll(async () => { await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 }); });

  (enabled ? it : it.skip)("imports a preset file made from New bot defaults, with its skills and notes and none of its approvals or apps", async () => {
    let stdout = "";
    let stderr = "";
    let info: { ui: string; url: string; botId: string; dataDir: string; logPath: string };
    child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts/control-madani.ts"), "ui", "launch"], {
      cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    child.on("error", (error) => { stderr += error.message; });
    await expect.poll(() => {
      if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`UI launcher exited: ${stderr}`);
      try { info = JSON.parse(stdout); return Boolean(info.ui); } catch { return false; }
    }, { timeout: launchTimeout, interval: 250 }).toBe(true);
    const ui = (verb: string, ...args: string[]) => runControlMadani(["ui", verb, "--ui", info.ui, ...args]) as Promise<Record<string, any>>;
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
    const click = (name: string) => ui("click", "--name", name).catch((error: Error) => { throw new Error(`clicking "${name}": ${error.message}`); });
    const snapshot = async () => (await ui("snapshot")).snapshot as string;
    const api = (path: string, method = "GET", body?: unknown) => request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, info.url);

    // My New bot defaults: a name, words, a colour, a skill that is on, notes,
    // and things a preset must never carry (approval, connected apps).
    await api("/api/config", "PATCH", { newBotDefaults: {
      profile: { name: "Sky", title: "Support", soul: "Be kind and precise.\n", color: "blue", approvalMode: "auto", composio: true },
      memory: { "MEMORY.md": "- Customers first.\n" },
      skills: [{ name: "follow-up", description: "Write a short follow-up.", source: "fixture", enabled: true, warnings: [],
        text: "---\nname: follow-up\ndescription: Write a short follow-up.\n---\n\n# Follow-up\n" }],
      routines: [],
    } });
    // Sharing a preset from the app left with the Bots pane on purpose (faa8efdbb), and making a bot from a preset left
    // with the ready-made bot's review (89d92585f). The file is made by the server's own export, the call the share
    // dialog made, and the app still imports it from Templates.
    const exported = await api("/api/teams/export", "POST", { format: "package", version: 2, kind: "library", name: "Sky", presetName: "Sky", includeMemory: true }) as { filename: string; document: Record<string, any> };
    const saved = exported.document;
    expect(exported.filename).toBe("sky-1.0.0.madani.json");
    expect(saved.package).toMatchObject({ id: "sky", agents: [], presets: [{ key: "new-bot-defaults", name: "Sky", skills: ["follow-up"], seed: { memory: { "MEMORY.md": "- Customers first.\n" } } }] });
    expect(JSON.stringify(saved)).not.toMatch(/"approvalMode"|"composio"|"modelSelection"|"enabled"/);
    const presetText = `${JSON.stringify(saved, null, 2)}\n`;

    await expect.poll(snapshot, { timeout: 10_000 }).toContain('button "You"');
    await openTemplatesWhenFree(ui);
    await click("Import");
    await evaluate(`(() => { const input = document.querySelector('[role=dialog] input[type=file]'); const transfer = new DataTransfer(); transfer.items.add(new File([${JSON.stringify(presetText)}], 'sky-1.0.0.madani.json', { type: 'application/json' })); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Preset bots and skills · no section");
    const preview = await snapshot();
    expect(preview).toContain("Preset bots: 1 · appear in new bot");
    expect(preview).not.toContain("Team members");
    expect(preview).toContain("Preset bots (added to new bot)");
    await ui("screenshot", "--out", evidence("import-preview"));
    await click("Add presets");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Preset bots added to new bot: 1");
    const presets = (await api("/api/bot-presets")).presets as Array<{ id: string; name: string; source?: string }>;
    expect(presets).toEqual([expect.objectContaining({ name: "Sky" })]);
    process.stdout.write(`${JSON.stringify({ fixture: info!, imported: presets.length })}\n`);
  }, launchTimeout + 180_000);
});
