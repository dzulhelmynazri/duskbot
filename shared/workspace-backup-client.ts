// Exact app-owned browser state that belongs in an encrypted full backup.
// Never include cookies, authentication tokens, connection caches or unknown keys.
export const WORKSPACE_BACKUP_CLIENT_KEYS = [
  "madani-drafts",
  "madani-draft-attachments",
  "madani-draft-send-ids",
  "madani-draft-channel-modes",
  "madani-skin",
  "madani-show-threads",
  "madani-show-run-card",
  "madani-send-key",
  "madani-color-user-bubbles",
  "madani-chat-width",
  "madanibot.sidebarDensity",
  "madanibot.sidebarToolsLayout",
  "madanibot.sidebarCollapsedSections.v1",
  "madanibot.sidebarSectionOrder.v1",
  "madani-analytics-opt-out",
  "madanibot.remote-voice.v1",
] as const;

export type WorkspaceBackupClientState = Partial<Record<(typeof WORKSPACE_BACKUP_CLIENT_KEYS)[number], string>>;
