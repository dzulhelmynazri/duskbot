// The summary the app's page publishes for the notch island and the bot dock, as electron/ambient-state.mjs checks it.
import type { MausColor } from "../../shared/wire";

export type AmbientStatus = "idle" | "thinking" | "working" | "talking" | "needs-you" | "done" | "error";
/** What a bot waits on the person for: one of shared/person-wait's kinds, or a wait it reports without a card. */
export type AmbientWait = "question" | "approval" | "sign-in" | "password" | "connect" | "review" | "other";
/** The step a running turn reports (shared/turn-progress), or its thinking and its reply. */
export type AmbientStep = "thinking" | "reply" | "read" | "fetch" | "web" | "search" | "command" | "write" | "edit" | "tool";

export interface AmbientBot {
  id: string;
  threadId: string;
  name: string;
  color: MausColor;
  body: string | null;
  face: "white" | "black" | null;
  avatar: string | null;
  status: AmbientStatus;
  /** What a running turn is doing ("Reading index.ts"), or what it waits on. */
  detail: string;
  /** The newest line in its chat, plain text. */
  line: string;
  /** When that line landed, or the turn started. */
  at: number;
  unread: boolean;
  /** Questions and approvals waiting on the person. */
  asks: number;
  /** The one approval the island can answer in place. */
  approval: { requestId: string; threadId: string; title: string } | null;
  /** What it waits on the person for, the most urgent first: a question, then an approval, then anything else. */
  waits: AmbientWait | null;
  /** A question the surfaces answer in place: with one of its choices, or typed when `custom`. */
  question: { requestId: string; threadId: string; title: string; choices: string[]; custom?: boolean } | null;
  /** What a running turn is doing now, for the mascot's pose. */
  step?: AmbientStep | null;
  /** The person watched this turn or this news in the app's own focused window: nothing here to catch their eye. */
  quiet?: boolean;
  /** When the running turn began (epoch ms), while it runs. */
  since?: number;
  /** Its newest news came from a routine run, not a message the person sent. */
  scheduled?: boolean;
  /** How long the turn that ended in its current reply or failure ran, in ms; stamped by main (electron/ambient-wake.mjs)
   * only for a turn it saw start. */
  ran?: number;
  /** The newest messages of its chat, plain text, for the surfaces' chat: a few for every bot, a long stretch for the one
   * a surface is showing (AmbientViewing). */
  chat?: AmbientMessage[];
  /** The reply it is writing right now, as far as it has got. */
  streaming?: string;
  /** Older messages wait to be loaded for it. */
  hasMore?: boolean;
}

/** The bot a surface is showing a chat for, and how many of its messages it wants. */
export interface AmbientViewing {
  botId: string;
  limit: number;
}

export interface AmbientMessage {
  id: string;
  from: "you" | "bot";
  text: string;
  at: number;
}

export interface AmbientSnapshot {
  bots: AmbientBot[];
  /** The surfaces' words in the person's language (labels.ts). */
  labels: import("./say").AmbientLabels;
  lang: string;
  /** The app's window shows the first run or the places hub, no place's bots: the surfaces stay closed. */
  away?: true;
}

export type AmbientAct =
  | { kind: "reply"; botId: string; threadId: string; text: string }
  | { kind: "allow" | "deny"; botId: string; threadId: string; requestId: string }
  | { kind: "answer"; botId: string; threadId: string; requestId: string; text: string }
  | { kind: "stop"; botId: string; threadId: string }
  | { kind: "new-bot" };

export interface IslandLayout {
  surface: "island";
  width: number;
  height: number;
  collapsed: { kind: "notch" | "pill"; width: number; height: number; top: number; notch: number; notchHeight: number };
  tile: number;
  size: "small" | "medium" | "large";
}

export interface DockLayout {
  surface: "dock";
  width: number;
  height: number;
  body: number;
  top: number;
  dock: { cell: number; tile: number; column: number; open: number; pad: number; ear: number; sliver: number; margin: number; overhang?: number };
  order: string[];
}

export interface AmbientPrefs {
  available: boolean;
  platform: string;
  island: boolean;
  dock: boolean;
  size: "small" | "medium" | "large";
  display: "active" | "built-in" | "main";
  order: string[];
  displays: Array<{ id: number; internal: boolean; label: string }>;
}

export interface AmbientBridge {
  surface: "island" | "dock" | "";
  onState(cb: (snapshot: AmbientSnapshot) => void): () => void;
  onLayout(cb: (layout: IslandLayout | DockLayout) => void): () => void;
  /** True while the person is in another app or away (electron/ambient-still.mjs); absent on an older app. */
  onStill?(cb: (still: boolean) => void): () => void;
  pointer(on: boolean): void;
  /** A text field here has focus (absent on an older app). */
  typing?(on: boolean): void;
  /** The surface has finished closing (absent on an older app). */
  settled?(): void;
  /** The chat this surface shows now (null when none), so that bot's summary carries a long stretch of it. */
  viewing?(viewing: AmbientViewing | null): void;
  /** Present only while main traces the surfaces (MADANI_AMBIENT_TRACE): one event of this page's side of the timeline. */
  trace?(event: string, detail?: string): void;
  open(botId: string, threadId: string): void;
  act(act: AmbientAct): void;
  order(ids: string[]): void;
  ready(): void;
  /** The finished replies and failures the person has seen (src/ambient/seen.ts), kept by main across restarts. */
  onSeen?(cb: (keys: string[]) => void): () => void;
  seen?(keys: string[]): void;
}

/** The app page's side of it (electron/preload.cjs). */
export interface AmbientAppBridge {
  prefs(): Promise<AmbientPrefs>;
  set(change: Partial<Pick<AmbientPrefs, "island" | "dock" | "size" | "display">>): Promise<AmbientPrefs>;
  wanted(): Promise<boolean>;
  onWanted(cb: (wanted: boolean) => void): () => void;
  publish(snapshot: AmbientSnapshot): void;
  onAct(cb: (act: AmbientAct) => void): () => void;
  /** Which bot's chat a surface is showing (absent on an older app). */
  onViewing?(cb: (viewing: AmbientViewing | null) => void): () => void;
}

/** The app page's side of electron/desktop-bots.mjs: its working bots for ⌘Q, the pill a single ⌘Q shows, and Stop. */
export interface DesktopBotsBridge {
  busy(names: string[]): void;
  onQuitHint(cb: (names: string[]) => void): () => void;
  /** The menu's Stop Bot (⌘.) and Stop All Bots (⌥⌘.). */
  onStop(cb: (command: { all: boolean }) => void): () => void;
}

declare global {
  interface Window {
    /** The island's and the dock's own bridge (electron/ambient-preload.cjs); absent anywhere else. */
    ambient?: AmbientBridge;
  }
}
