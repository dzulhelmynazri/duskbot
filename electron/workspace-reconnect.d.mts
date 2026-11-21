/** A chat list as last seen on a server: bot names and chat titles only (no message text). */
export interface WorkspaceFrame {
  at: number;
  bots: Array<{ id: string; name: string; chats: Array<{ id: string; title: string }> }>;
  groups: Array<{ id: string; name: string }>;
}

/** What the reconnect page shows while the chosen server isn't answering. `nextAt`: when it is looked at again (this
 * computer's clock), null while a look is under way (`checking`). `places`: the other workspaces the person may open. */
export interface ReconnectView {
  name: string;
  /** The server's address, for a person checking they typed it right. */
  host: string;
  /** Added by hand and never opened: it can't be reached yet, and there is nothing it showed before. */
  neverConnected?: boolean;
  /** A madani cloud that was deleted: nothing is looked at again; the person removes it or opens another place. */
  gone?: true;
  attempt: number;
  nextAt: number | null;
  checking: boolean;
  frame?: WorkspaceFrame;
  places: Array<{ id: string; name: string; local?: boolean }>;
}

/** The reconnect page's bridge (preload `reconnect`): this app's own page at RECONNECT_PATH only. */
export interface ReconnectBridge {
  state(): Promise<ReconnectView | null>;
  onState(callback: (view: ReconnectView | null) => void): () => void;
  retry(): Promise<ReconnectView | null>;
  open(id: string): Promise<unknown>;
  remove(): Promise<unknown>;
}

export declare const RECONNECT_PATH: "/reconnect";
export declare const RETRY_MS: readonly number[];
export declare const FRAME_MAX_AGE_MS: number;
export declare const FRAME_EVERY_MS: number;
export declare function proxyAnswersForDownServer(code: number): boolean;
export declare function frameOf(body: unknown, at: number): WorkspaceFrame | null;
export declare function createWorkspaceReconnect(deps: Record<string, unknown>): {
  lost(entry: { id: string; name: string; origin: string; gone?: boolean }): void;
  loaded(url: string): void;
  retry(): ReconnectView | null;
  stop(): void;
  view(): ReconnectView | null;
  page(event: unknown): boolean;
  choose(id: string): unknown;
  remove(): unknown;
  forget(id: string): void;
};
export declare function installWorkspaceReconnectIpc(input: { ipcMain: unknown; reconnect: ReturnType<typeof createWorkspaceReconnect> }): void;
