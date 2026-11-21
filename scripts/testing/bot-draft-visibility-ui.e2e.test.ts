import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { runControlMadani } from "../control-madani.ts";
import { UI_TOOLS_DIR } from "./control-madani-ui.ts";
import { openTemplatesWhenFree } from "./grok-templates.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const binary = resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env });
const enabled = Boolean(binary) || process.env.MADANI_UI_E2E === "1";
if (!enabled) console.log("skipping draft visibility UI: set MADANI_UI_E2E=1 to install the pinned browser");

(enabled ? it : it.skip)("adds a ready-made bot from Templates in one press, as exactly one bot, with no review step", async () => {
  let child: ChildProcess | undefined;
  try {
    let stdout = "", stderr = "";
    let info: { ui: string; url: string };
    child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts/control-madani.ts"), "ui", "launch"], {
      cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", chunk => { stdout += String(chunk); });
    child.stderr!.on("data", chunk => { stderr += String(chunk); });
    await expect.poll(() => {
      if (child!.exitCode !== null) throw new Error(stderr);
      try { info = JSON.parse(stdout); return Boolean(info.ui); } catch { return false; }
    }, { timeout: binary ? 180_000 : 600_000, interval: 250 }).toBe(true);
    const ui = (verb: string, ...args: string[]) => runControlMadani(["ui", verb, "--ui", info.ui, ...args]) as Promise<Record<string, any>>;
    const snapshot = async () => (await ui("snapshot")).snapshot as string;
    const bots = async () => (await fetch(`${info.url}/api/bots?messages=0`).then(response => response.json())).bots as Array<{ id: string; name: string; visibility?: string }>;
    const before = await bots();
    await openTemplatesWhenFree(ui);
    await expect.poll(snapshot, { timeout: 20_000 }).toContain("Add Quinn, Researcher");
    // since the one create flow (89d92585f) Add makes the bot at once: there is no review, and so no audience to pick
    await ui("click", "--name", "Add Quinn, Researcher");
    await expect.poll(async () => (await bots()).length, { timeout: 15_000 }).toBe(before.length + 1);
    const created = (await bots()).filter(bot => !before.some(old => old.id === bot.id));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ name: "Quinn" });
    expect(await snapshot()).not.toContain("Who can see it");
  } finally { await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 }); }
}, 720_000);
