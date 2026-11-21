import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { moveFrom } from "../shared/bot-move.ts";
import { grokMovePlan } from "../shared/grok-import.ts";
import { lookForBots } from "./bot-move-local.ts";
import { thisMachine } from "./setup-import.ts";
import { plantAgentTools, plantHermes, plantOpenClawList, plantOpenMausBot, SENTINEL } from "./testing/agent-app-fixtures.ts";

let home: string;

/** The real package path over a throwaway home, with a bot of the person's own already there. */
async function installation() {
  home = mkdtempSync(join(tmpdir(), "madani-bot-move-install-"));
  vi.resetModules();
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  const { Store } = await import("./store.ts");
  const { RoutineManager } = await import("./routines.ts");
  const skills = await import("./skills.ts");
  const workspace = await import("./workspace.ts");
  const importer = await import("./package-import.ts");
  const store = new Store(() => ({ instanceId: "claude", model: "default-model" }));
  const routines = new RoutineManager({
    file: join(home, "routines.json"),
    botState: (id) => (store.bot(id) && !store.bot(id)!.hidden ? "ready" : "missing"),
    goalState: () => "missing",
    createTask: () => null,
    startTurn: async () => {},
  });
  const mcp = { servers: {} as Record<string, unknown> };
  const deps = {
    store, routines,
    skills: { install: skills.installSkill, setEnabled: skills.setSkillEnabled },
    memory: { writeIndex: workspace.writeMemoryFile, writeTopic: workspace.writeMemoryTopic },
    mcp: { servers: () => mcp.servers, refusal: () => undefined, persist: (next: Record<string, unknown>) => { mcp.servers = next; } },
    sections: { writeBrief: () => {} },
    images: { save: () => "" },
    defaultSelection: () => ({ instanceId: "claude", model: "default-model" }),
  };
  /** Every bot found, moved unless a bot here already carries its package id: the check the app makes before moving. */
  const moveAll = (fixtureHome: string) => {
    const look = lookForBots({ ...thisMachine(), home: fixtureHome, platform: "darwin", env: {} }, { dataDir: join(home, ".madanibot") });
    const added: string[] = [];
    const facts: string[] = [];
    for (const app of look.apps) {
      for (const bot of app.bots) {
        const plan = grokMovePlan(bot, { timeZone: "UTC", from: moveFrom(app) });
        facts.push(...plan.facts);
        if (store.bots.some((here) => here.installedPackage?.id === plan.packageId)) continue;
        const result = importer.importPackageDocument(plan.document, { trust: "file", mode: "add" }, deps);
        if (result.alreadyAdded) throw new Error("unexpected");
        added.push(...result.bots.map((one) => one.id));
      }
    }
    return { look, added, facts };
  };
  return { store, routines, skills, workspace, moveAll };
}

afterEach(async () => {
  const { closeMessageDb } = await import("./message-db.ts");
  closeMessageDb();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("bots from other apps, through the real package path", () => {
  it("come over with their persona, memory, skills off and routines paused, beside a bot already here, once", async () => {
    const app = await installation();
    const mine = app.store.createBot({ name: "Molty", soul: "my own Molty" } as never, { seedMessages: false });
    const source = mkdtempSync(join(tmpdir(), "madani-bot-move-source-"));
    try {
      plantOpenClawList(source);
      plantHermes(source);
      plantOpenMausBot(source);
      plantAgentTools(source);

      const first = app.moveAll(source);
      const moved = first.added.map((id) => app.store.bot(id)!);
      expect(moved.map((bot) => bot.name)).toEqual(["Molty 2", "Scout", "Hermes", "Coder", "Code Reviewer", "Researcher", "Ledger"]);
      expect(app.store.bot(mine.id)).toMatchObject({ name: "Molty", soul: "my own Molty" });

      const molty = moved[0]!;
      expect(molty.soul).toContain("Have opinions.");
      expect(molty.installedPackage).toMatchObject({ source: "file", name: "Molty" });
      expect(app.workspace.readMemoryFile(molty.id).text).toContain("Sam's sister is called Ana.");
      expect(app.workspace.readMemoryTopic(molty.id, "about-you.md"), "facts about the person go to About me").toBeNull();
      expect(first.facts).toContain("Timezone: Europe/Lisbon");
      // instructions in the working shape, with the source's words whole and where its notes went
      expect(molty.soul).toContain("## Your instructions from OpenClaw\n# SOUL.md - Who You Are");
      expect(molty.soul).toContain("memory/openclaw-tools.md");
      expect(molty.avatarCrop, "its picture came along").toBe("circle");
      const reviewer = moved[4]!;
      expect(reviewer).toMatchObject({ color: "blue", description: "Expert code review specialist. Use right after writing or changing code." });
      expect(reviewer.soul).toContain("You are a senior code reviewer.");
      // daily logs never land as they are: they wait for the bot's engine to condense them
      expect(app.workspace.readMemoryTopic(molty.id, "openclaw-daily-notes.md")).toBeNull();
      expect(app.skills.listSkills(molty.id).filter((skill) => ["groceries", "weather"].includes(skill.name)).map((skill) => [skill.name, skill.enabled]))
        .toEqual([["groceries", false], ["weather", false]]);

      const hermes = moved[2]!;
      expect(app.workspace.readMemoryFile(hermes.id).text).toContain("- Deploys go through a script called deploy.");
      expect(app.workspace.readMemoryFile(hermes.id).text).not.toContain("Works nights");
      expect(first.facts).toContain("Works nights; never message before noon.");
      expect(app.workspace.readMemoryTopic(hermes.id, "hermes-agent-setup.md")).toContain("Answered on: Telegram, Discord, WhatsApp.");

      const routines = app.routines.listRoutines();
      expect(routines.every((routine) => !routine.enabled)).toBe(true);
      expect(routines.map((routine) => [routine.name, routine.schedule.type]).sort()).toEqual([
        ["Hermes: Ping", "interval"], ["Hermes: Standup", "cron"], ["Ledger: Month end", "daily"],
        ["Molty: Heartbeat", "interval"], ["Molty: Morning brief", "cron"], ["Molty: Wake", "cron"], ["Scout: News sweep", "interval"],
      ]);
      expect(routines.find((routine) => routine.name === "Hermes: Standup")!.schedule).toMatchObject({ expression: "30 13 * * 1-5", timeZone: "Asia/Kolkata" });
      expect(routines.find((routine) => routine.name === "Hermes: Standup")!.prompt).toContain("Use these skills: standup.");
      expect(JSON.stringify([app.store.bots, routines])).not.toContain(SENTINEL);

      const count = app.store.bots.length;
      expect(app.moveAll(source).added).toEqual([]);
      expect(app.store.bots).toHaveLength(count);
      expect(app.routines.listRoutines()).toHaveLength(routines.length);
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });
});
