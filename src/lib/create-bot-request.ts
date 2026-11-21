/** Asks for Create New Bot (components/CreateBotDialog.tsx), from anywhere: the sidebar's +, ⌘N, search's New Bot, a
 * plain `newBot` action. `section`: the sidebar section the bot is made in. */
export const CREATE_BOT_EVENT = "madani:open-create-bot";

let pendingSection: string | undefined;

export function openCreateBot(section?: string): void {
  pendingSection = section;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CREATE_BOT_EVENT));
}

export function takeCreateBotSection(): string | undefined {
  const section = pendingSection;
  pendingSection = undefined;
  return section;
}
