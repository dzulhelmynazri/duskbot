/** The app's own preferences that follow the person to every place of theirs (server/settings-sync.ts), by the name the
 * page keeps each under. Window sizes, drafts, pins of one place's bots and hints already seen stay with the page. */
export const SYNCED_UI_PREFS = [
  "madani-skin", "madani-font", "madani-chat-width", "madani-send-key", "madani-follow-up", "madani-show-run-card", "madani-color-user-bubbles",
  "madani-halloween-dress", "madani-language", "madani-notification-sounds", "madani-finished-notifications", "madani-notification-sound",
  "madanibot.callMode.v1", "madanibot.sidebarDensity", "madanibot.sidebarCollapsedSections.v1", "madanibot.sidebarSectionOrder.v1",
  "madanibot.sidebarSectionOrder.simple.v1", "madanibot.starredModels.v1",
] as const;
export type SyncedUiPref = (typeof SYNCED_UI_PREFS)[number];
