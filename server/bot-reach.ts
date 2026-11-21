import { supportsWorkspaceFiles } from "./workspace.ts";

/** Whether a bot can run code, tests or shell commands anywhere: an engine with its own shell, or a computer it was
 * given. A bot on an API key with no computer can write code and text but runs none of it. */
export function runsCommands(bot: { computer?: string | null }, driverKind: string | undefined): boolean {
  return (driverKind !== undefined && supportsWorkspaceFiles(driverKind)) || (typeof bot.computer === "string" && bot.computer !== "off" && bot.computer !== "");
}

/** What a bot that runs nothing is told about a teammate or a bot it made, so it never promises that bot's tests or runs. */
export const RUNS_NOTHING_NOTE = "It has no computer here, so it can write code and text but cannot run code, tests or commands until the person connects a computer to it (their Mac, a VPS or madani cloud, in its settings). Say that in one line when you describe it, never say it will run or test anything, and do not hand it work that needs running.";
