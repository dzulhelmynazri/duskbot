import { useSyncExternalStore } from "react";

/** Where the Connect Apps window opens: its home, one category, your connected apps and skills, or one app's page. */
export type ConnectAppsPage =
  | { kind: "home" }
  | { kind: "category"; category: string }
  | { kind: "yours" }
  | { kind: "detail"; id: string };

export interface ConnectAppsState {
  open: boolean;
  page: ConnectAppsPage;
  /** A new number for every open, so opening the same page again starts it fresh. */
  nonce: number;
}

const HOME: ConnectAppsPage = { kind: "home" };
export const MCP_SERVERS_ID = "mcp";

/** The page for an old Plugins surface: "mcp" is the MCP servers page, anything else the home. */
export function connectAppsPageFor(surface: "apps" | "mcp" | undefined): ConnectAppsPage {
  return surface === "mcp" ? { kind: "detail", id: MCP_SERVERS_ID } : HOME;
}
let current: ConnectAppsState = { open: false, page: HOME, nonce: 0 };
const watchers = new Set<() => void>();

function publish(next: ConnectAppsState) {
  current = next;
  for (const watch of Array.from(watchers)) watch();
}

const APP_LINK = /^madanibot:\/\/apps\/([a-z0-9][a-z0-9_.-]{0,79})\/?$/i;

/** The app a madanibot://apps/<id> link (the account website's connect) names, lowercased; null for any other link. */
export function connectAppLinkId(link: string): string | null {
  return APP_LINK.exec(link.trim())?.[1]?.toLowerCase() ?? null;
}

/** Opens the Connect Apps window, on its home or on `page`. */
export function openConnectApps(page: ConnectAppsPage = HOME): void {
  publish({ open: true, page, nonce: current.nonce + 1 });
}

export function closeConnectApps(): void {
  if (current.open) publish({ ...current, open: false });
}

export function connectAppsState(): ConnectAppsState {
  return current;
}

export function subscribeConnectApps(watch: () => void): () => void {
  watchers.add(watch);
  return () => { watchers.delete(watch); };
}

export function useConnectApps(): ConnectAppsState {
  return useSyncExternalStore(subscribeConnectApps, connectAppsState, connectAppsState);
}
