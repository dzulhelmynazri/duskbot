export type ComputerPanelView = "computer" | "browser" | "routines" | "files";

/** `browser`: the bot works in its browser, or something asked for its browser view; Simple shows that tab only then. */
type PanelTabsContext = { browser?: boolean };

export function computerPanelTabs({ browser = false }: PanelTabsContext): ComputerPanelView[] {
  return ["computer", ...(browser ? (["browser"] as const) : [])];
}

export function resolveComputerPanelView(view: ComputerPanelView, context: PanelTabsContext): ComputerPanelView {
  return computerPanelTabs(context).includes(view) ? view : "computer";
}

const STORAGE_PREFIX = "madani-computer-panel-view";

function storageKey(botId: string): string {
  return `${STORAGE_PREFIX}:${botId}`;
}

export function readComputerPanelView(
  botId: string,
  storage: Pick<Storage, "getItem"> = localStorage,
): ComputerPanelView {
  try {
    const value = storage.getItem(storageKey(botId));
    // a stored "data" or "android" tab from before those tabs were removed reads as computer
    if (value === "browser" || value === "routines" || value === "files") return value;
  } catch {
  }
  return "computer";
}

export function writeComputerPanelView(
  botId: string,
  view: ComputerPanelView,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  try {
    storage.setItem(storageKey(botId), view);
  } catch {
  }
}
