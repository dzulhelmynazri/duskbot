import type { BotRoutineTemplate } from "../../shared/new-bot-defaults.ts";
import type { MadaniBodyId } from "../../shared/body-migration.ts";
import type { MausColor } from "../../shared/wire.ts";

export type ReadyBotCategory = "everyday" | "work" | "writing" | "design" | "sales" | "personal";

export const READY_BOT_CATEGORIES: readonly ReadyBotCategory[] = ["everyday", "work", "writing", "design", "sales", "personal"];

export interface ReadyBot {
  id: string;
  category: ReadyBotCategory;
  name: string;
  title: string;
  description: string;
  soul: string;
  look: { color: MausColor; mascotBody: MadaniBodyId };
  tryAsking: string[];
  /** Connected apps the bot works best with; suggested, never connected for the person. */
  apps: string[];
  notes?: Record<string, string>;
  routines?: BotRoutineTemplate[];
}

export const WEEKDAYS = [1, 2, 3, 4, 5];

export const paused = (name: string, prompt: string, time: string, weekdays: number[]): BotRoutineTemplate =>
  ({ name, prompt, schedule: { type: "daily", time, weekdays }, enabled: false, overlap: "skip" });

/** Standing instructions read best as plain markdown; trim the template literal's edges. */
export const soul = (text: string): string => text.trim();

export const memoryNote = (title: string, aliases: string, lines: string[]): string =>
  `---\ntitle: ${title}\naliases: [${aliases}]\n---\n\n${lines.map((line) => `- ${line}`).join("\n")}\n`;
