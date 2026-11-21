import type { SendKey } from "./send-key";

export interface ShortcutItem {
  id: string;
  description: string;
  macKeys: string[];
  winKeys: string[];
}

export interface ShortcutGroup {
  category: string;
  items: ShortcutItem[];
}

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    category: "Navigation",
    items: [
      {
        id: "command-palette",
        description: "Search bots and chats",
        macKeys: ["⌘", "K"],
        winKeys: ["Ctrl", "K"],
      },
      {
        id: "new-bot",
        description: "Create a new bot",
        macKeys: ["⌘", "N"],
        winKeys: ["Ctrl", "N"],
      },
      {
        id: "jump-bot",
        description: "Go to bot 1–9",
        macKeys: ["⌘", "1–9"],
        winKeys: ["Ctrl", "1–9"],
      },
      {
        id: "toggle-sidebar",
        description: "Show or hide the sidebar",
        macKeys: ["⌘", "\\"],
        winKeys: ["Ctrl", "\\"],
      },
      {
        id: "switch-bot",
        description: "Previous or next bot",
        macKeys: ["⌘", "⇧", "[ / ]"],
        winKeys: ["Ctrl", "Shift", "[ / ]"],
      },
      {
        id: "find-conversation",
        description: "Find in conversation",
        macKeys: ["⌘", "F"],
        winKeys: ["Ctrl", "F"],
      },
    ],
  },
  {
    category: "Chat & composer",
    items: [
      {
        id: "send-message",
        description: "Send message",
        macKeys: ["Return"],
        winKeys: ["Enter"],
      },
      {
        id: "new-line",
        description: "New line",
        macKeys: ["⇧", "Return"],
        winKeys: ["Shift", "Enter"],
      },
      {
        id: "send-follow-up",
        description: "Queue or steer while a bot works",
        macKeys: ["⌘", "Return"],
        winKeys: ["Ctrl", "Enter"],
      },
      {
        id: "voice-input",
        description: "Talk to type",
        macKeys: ["⌘", "⇧", "D"],
        winKeys: ["Ctrl", "Shift", "D"],
      },
      {
        id: "stop-bot",
        description: "Stop the open bot",
        macKeys: ["⌘", "."],
        winKeys: ["Ctrl", "."],
      },
      {
        id: "stop-all-bots",
        description: "Stop all bots",
        macKeys: ["⌥", "⌘", "."],
        winKeys: ["Ctrl", "Alt", "."],
      },
      {
        id: "ask-about-selection",
        description: "Ask about the selected text",
        macKeys: ["⌘", "L"],
        winKeys: ["Ctrl", "L"],
      },
      {
        id: "edit-last-message",
        description: "Edit your last message",
        macKeys: ["↑"],
        winKeys: ["↑"],
      },
      {
        id: "close-panel",
        description: "Close",
        macKeys: ["Esc"],
        winKeys: ["Esc"],
      },
      {
        id: "shortcuts-cheat-sheet",
        description: "Keyboard shortcuts",
        macKeys: ["⌘", "/"],
        winKeys: ["Ctrl", "/"],
      },
    ],
  },
  {
    category: "Calls",
    items: [
      {
        id: "live-call-mute",
        description: "Mute or unmute",
        macKeys: ["⌘", "⇧", "M"],
        winKeys: ["Ctrl", "Shift", "M"],
      },
      {
        id: "live-call-hang-up",
        description: "Hang up",
        macKeys: ["⌘", "⇧", "H"],
        winKeys: ["Ctrl", "Shift", "H"],
      },
    ],
  },
  {
    category: "Management & groups",
    items: [
      {
        id: "save-bulletin",
        description: "Save group instructions",
        macKeys: ["⌘", "Return"],
        winKeys: ["Ctrl", "Enter"],
      },
      {
        id: "reorder-section",
        description: "Move a sidebar section",
        macKeys: ["⌥", "↑ / ↓"],
        winKeys: ["Alt", "↑ / ↓"],
      },
    ],
  },
];

type Keys = Pick<ShortcutItem, "macKeys" | "winKeys">;
const ENTER: Keys = { macKeys: ["Return"], winKeys: ["Enter"] };
const SHIFT_ENTER: Keys = { macKeys: ["⇧", "Return"], winKeys: ["Shift", "Enter"] };
const MOD_ENTER: Keys = { macKeys: ["⌘", "Return"], winKeys: ["Ctrl", "Enter"] };
const SEND_ROWS: Record<Exclude<SendKey, "enter">, [Keys, Keys, Keys]> = {
  "shift-enter": [SHIFT_ENTER, ENTER, MOD_ENTER],
  "mod-enter": [MOD_ENTER, ENTER, { macKeys: ["⌘", "⇧", "Return"], winKeys: ["Ctrl", "Shift", "Enter"] }],
};

export function shortcutGroupsFor(sendKey: SendKey): readonly ShortcutGroup[] {
  if (sendKey === "enter") return SHORTCUT_GROUPS;
  const [send, newLine, followUp] = SEND_ROWS[sendKey];
  return SHORTCUT_GROUPS.map((group) => ({
    ...group,
    items: group.items.map((item) =>
      item.id === "send-message" ? { ...item, ...send }
        : item.id === "new-line" ? { ...item, ...newLine }
          : item.id === "send-follow-up" ? { ...item, ...followUp }
            : item),
  }));
}

export function isSidebarToggle(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "defaultPrevented">): boolean {
  return !event.defaultPrevented && event.key === "\\" && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey;
}

/**
 * The step of ⌘⇧] / ⌘⇧[ (Ctrl+Shift outside macOS) through the bots: 1, -1, or null for any other key. Outside
 * macOS, Shift turns the key into "}" / "{", so those count too. The physical key (`code`) is not used: on many
 * layouts BracketRight types another character.
 */
export function botCycleStep(event: Pick<KeyboardEvent, "key">): 1 | -1 | null {
  if (event.key === "]" || event.key === "}") return 1;
  if (event.key === "[" || event.key === "{") return -1;
  return null;
}

export function shouldOpenKeyboardShortcuts(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing || event.altKey) return false;
  const helpKey = event.key === "?" && !event.metaKey && !event.ctrlKey;
  const helpChord = event.key === "/" && (event.metaKey || event.ctrlKey) && !event.shiftKey;
  if (!helpKey && !helpChord) return false;
  const target = event.target;
  return !(target instanceof HTMLElement && (
    target.isContentEditable || target.closest("input, textarea, select, dialog, [role=dialog]")
  ));
}

export function isMacPlatform(): boolean {
  if (typeof window !== "undefined" && window.madaniDesktop?.platform) {
    return window.madaniDesktop.platform === "darwin";
  }
  if (typeof navigator !== "undefined" && navigator.userAgent) {
    return navigator.userAgent.includes("Mac");
  }
  return true;
}

export function shortcutKeysForPlatform(
  item: ShortcutItem,
  isMac: boolean = isMacPlatform(),
): string[] {
  return isMac ? item.macKeys : item.winKeys;
}

