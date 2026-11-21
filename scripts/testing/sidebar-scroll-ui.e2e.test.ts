// A click on a row far down a scrolled sidebar, with the bot panel open, leaves the list where it is: the panel swapped
// for the clicked bot's used to hand focus back to the row that had it when the panel mounted, scrolling the sidebar up
// to that row. Scrolling is only provable in a browser.
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { runControlMadani } from "../control-madani.ts";
import { UI_TOOLS_DIR } from "./control-madani-ui.ts";
import { clickByName, settled } from "./grok-nav.ts";
import { fixtureApi } from "./preview-fixture.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const binary = resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env });
const enabled = process.env.MADANI_UI_E2E === "1" || Boolean(binary);
if (!enabled) console.info("skipping sidebar scroll UI e2e: set MADANI_UI_E2E=1 to install the pinned browser");

type WireBot = { id: string; name: string; threadId: string; mainThreadId?: string; tasks?: Array<{ threadId: string; unread?: boolean }> };

(enabled ? it : it.skip)("keeps a scrolled sidebar still when a far-down row opens, through a task switch and an unread clear", async () => {
  let child: ChildProcess | undefined;
  let info: { ui: string; url: string } | undefined;
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
    const api = fixtureApi(info!.url);

    // the user's shape: two dozen bots in sections, every other one away from its main conversation, the rest unread
    const sections = ["Test bots", "W10 Vault", "W10 Parallel"];
    for (let i = 0; i < 24; i++) {
      const { bot } = await api("POST", "/api/bots", { name: `Scroll ${String(i + 1).padStart(2, "0")}`, section: sections[i % 3] }) as { bot: WireBot };
      if (i % 2 === 0) {
        await api("POST", `/api/bots/${bot.id}/tasks`, { title: `Side job ${i + 1}`, select: true });
        await api("PATCH", `/api/bots/${bot.id}`, { mainThreadChoice: bot.threadId });
      } else {
        await api("PATCH", `/api/bots/${bot.id}`, { unread: true });
      }
    }
    const wire = async () => (await api("GET", "/api/bots?messages=0") as { bots: WireBot[] }).bots;
    expect((await wire()).filter((bot) => bot.name.startsWith("Scroll ") && bot.mainThreadId && bot.mainThreadId !== bot.threadId)).toHaveLength(12);

    // the panel is open from a reload, so it mounts with nothing focused; the first row clicked after that is the one it
    // used to hand focus back to on every later switch
    await clickByName(ui, /^Open Pepper's profile/, "button");
    await expect.poll(() => evaluate("Boolean(document.getElementById('bot-panel'))"), { timeout: 15_000 }).toBe(true);
    // the person's own order keeps these rows far down; by recent activity the unread ones would rise to the top
    await evaluate(`localStorage.setItem("madanibot.sidebarBotOrder", "custom"); true`);
    await evaluate("location.reload(); true");
    await expect.poll(() => evaluate("document.querySelectorAll('[data-sidebar-bot-row]').length"), { timeout: 30_000 }).toBeGreaterThanOrEqual(25);
    await expect.poll(() => evaluate("Boolean(document.getElementById('bot-panel'))"), { timeout: 15_000 }).toBe(true);
    const top = await evaluate("(() => { const row = [...document.querySelectorAll('[data-sidebar-bot-row]')].find((row) => !row.hasAttribute('aria-current')); return { id: row.dataset.sidebarBotRow, name: row.getAttribute('aria-label') }; })()") as { id: string; name: string };
    await clickByName(ui, top.name, "button");
    await expect.poll(() => evaluate(`document.querySelector('[data-sidebar-bot-row="${top.id}"]').getAttribute('aria-current')`), { timeout: 10_000 }).toBe("page");

    const list = "document.querySelector('aside[data-sidebar] [data-scroll-fade-frame] > div')";
    const scrollToEnd = async () => {
      const at = await evaluate(`(() => { const list = ${list}; list.scrollTop = list.scrollHeight; return list.scrollTop; })()`) as number;
      expect(at, "the sidebar must be long enough to scroll").toBeGreaterThan(200);
      await settled(ui);
      return at;
    };
    const scrollTop = () => evaluate(`${list}.scrollTop`) as Promise<number>;

    const bots = await wire();
    const opened = new Set<string>();
    for (const kind of ["switch", "unread"] as const) {
      const at = await scrollToEnd();
      // the lowest row of this kind not opened yet
      const rows = await evaluate("[...document.querySelectorAll('[data-sidebar-bot-row]')].map((row) => ({ id: row.dataset.sidebarBotRow, name: row.getAttribute('aria-label') }))") as Array<{ id: string; name: string }>;
      const target = rows.reverse().find((row) => {
        const bot = bots.find((candidate) => candidate.id === row.id);
        if (!bot?.name.startsWith("Scroll ") || opened.has(bot.id)) return false;
        return kind === "switch" ? bot.mainThreadId !== bot.threadId : bot.tasks?.some((task) => task.unread);
      });
      expect(target, `a ${kind} row`).toBeTruthy();
      opened.add(target!.id);
      await clickByName(ui, target!.name, "button");
      await expect.poll(() => evaluate(`document.querySelector('[data-sidebar-bot-row="${target!.id}"]').getAttribute('aria-current')`), { timeout: 10_000 }).toBe("page");
      if (kind === "switch") {
        // the click posts the switch back to the main conversation, and its snapshot redraws the row
        await expect.poll(async () => { const bot = (await wire()).find((candidate) => candidate.id === target!.id)!; return bot.threadId === bot.mainThreadId; }, { timeout: 10_000 }).toBe(true);
      } else {
        await expect.poll(() => evaluate(`document.querySelector('[data-sidebar-bot-row="${target!.id}"]').hasAttribute('data-row-unread')`), { timeout: 10_000 }).toBe(false);
      }
      await settled(ui);
      expect(Math.abs(await scrollTop() - at), `opening a far-down ${kind} row keeps the sidebar scrolled`).toBeLessThanOrEqual(1);
    }
  } finally {
    await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 });
  }
}, binary ? 300_000 : 720_000);
