import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { removeTempDir, waitForExit } from "../../server/testing/cleanup.ts";
import { runControlMadani } from "../control-madani.ts";
import { UI_TOOLS_DIR } from "./control-madani-ui.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const enabled = process.env.MADANI_UI_E2E === "1" || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));

(enabled ? it : it.skip)("coordinates from the real composer and opens the exact child task from its existing inline receipt", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "madani-direct-ui-plan-"));
  const planPath = join(temporary, "plan.json");
  writeFileSync(planPath, "{}");
  const child = spawn(process.execPath, ["--experimental-strip-types", "scripts/control-madani.ts", "ui", "launch"], {
    cwd: ROOT, env: { ...process.env, FAKE_CLAUDE_ROOM_PLAN: planPath }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let error = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.on("data", chunk => { error += String(chunk); });
  child.on("error", caught => { error += caught.message; });
  let info: { ui: string; url: string; botId: string; logPath: string };
  try {
    await expect.poll(() => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(error);
      try { info = JSON.parse(output); return Boolean(info.ui); } catch { return false; }
    }, { timeout: 180_000, interval: 250 }).toBe(true);
    const api = async (path: string, body?: unknown, method = "POST") => {
      const response = await fetch(info.url + path, body === undefined ? {} : {
        method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(JSON.stringify(result));
      return result;
    };
    const ui = (verb: string, ...args: string[]) => runControlMadani(["ui", verb, "--ui", info.ui, ...args]) as Promise<any>;
    const snapshot = async () => (await ui("snapshot")).snapshot as string;
    const click = async (name: string, role = "button") => {
      const refs = (await ui("snapshot")).refs as Record<string, { role: string; name: string }>;
      const match = Object.entries(refs).find(([, entry]) => entry.role === role && entry.name.endsWith(name));
      expect(match).toBeDefined();
      return ui("click", "--ref", "@" + match![0]);
    };
    const lead = (await api("/api/bots", { name: "Engineer", title: "Implementation", section: "" })).bot;
    const gateFile = join(temporary, "finish-teammate");
    writeFileSync(planPath, JSON.stringify({
      [info.botId]: { steps: [{ arguments: { bot_ids: [lead.id], request_key: "review", message: "Check the fixture CSV export" } }], reply: "Assigned", resumeReply: "Engineer checked the fixture CSV export" },
      [lead.id]: { gateFile, reply: "CSV export checked in my separate task" },
    }));
    await ui("flag", "--set", "features.showToolCalls=false");
    await ui("type", "--name", "Message Pepper", "--text", "Please have Engineer check the CSV export and report back");
    await ui("press", "--keys", "Enter");
    await expect.poll(snapshot, { timeout: 15_000 }).toContain("Teammates working");
    const waiting = (await api("/api/bots?messages=0")).bots.find((bot: any) => bot.id === info.botId);
    expect(waiting).toMatchObject({ busy: false, waitingForTeammates: true });
    const controls = (await ui("snapshot")).refs as Record<string, { role: string; name: string }>;
    expect(Object.values(controls).some(control => control.role === "textbox" && control.name === "Message Pepper")).toBe(true);
    await ui("screenshot", "--out", info.logPath + ".teammates-working.png");
    writeFileSync(gateFile, "complete fixture work");
    await ui("wait-settle", "--timeout", "60");
    await expect.poll(snapshot, { timeout: 15_000 }).toContain("Engineer checked the fixture CSV export");
    // One chat per bot: the asker's own question draws no line; the answer shows inline under "Engineer replied".
    const final = await snapshot();
    expect(final).not.toContain("Pepper Pepper Engineer Check the fixture CSV export");
    expect(final).toContain("replied");
    expect(final).toContain("CSV export checked in my separate task");
    const state = await api("/api/bots");
    const parent = state.bots.find((bot: any) => bot.id === info.botId);
    const receipt = parent.messages.find((message: any) => message.tool?.name === "Sent to Engineer");
    expect(receipt.threadRef).toMatchObject({ botId: lead.id, threadId: lead.threadId });
    const screenshot = info.logPath + ".direct-coordination.png";
    await ui("screenshot", "--out", screenshot);
    // In the teammate's one chat the question draws no line, and its answer reads "Responded to Pepper".
    await click("Engineer");
    await expect.poll(snapshot, { timeout: 15_000 }).toContain("Responded to");
    expect(await snapshot()).not.toContain("Check the fixture CSV export");
    const selected = (await api("/api/bots")).bots.find((bot: any) => bot.id === lead.id);
    expect(selected.tasks).toHaveLength(1);
    const evidence = { source: parent.messages, receipt, selectedThread: selected.threadId, final: await snapshot(), screenshot };
    writeFileSync(info.logPath + ".direct-coordination.json", JSON.stringify(evidence, null, 2));
    console.log("Direct coordination UI evidence:", info.logPath + ".direct-coordination.json");
  } finally {
    await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 });
    await removeTempDir(temporary);
  }
}, 240_000);
