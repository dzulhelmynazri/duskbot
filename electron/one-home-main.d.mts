import type { installCloudSend } from "./cloud-send-main.mjs";
import type { OneHomeCloud, OneHomeView, createOneHome } from "./one-home.mjs";
import type { installTeamMove } from "./team-move-main.mjs";

export function oneHomeCloud(state: unknown): OneHomeCloud | null;
/** This computer's server's answer to the move's freeze: frozen, or what still holds the move. */
export function freezeAnswer(got: { ok: boolean; status: number; body: any }): { frozen: true } | { busy: string; what?: string };
export type KeepHereState = import("./cloud-send.mjs").KeepHereState;
export function installationOf(environmentId: string): string;
export declare const GONE_ASK_MS: number;
export declare const OPEN_WAIT_MS: number;
export function createOpenWhenAsked(deps: { open(): void; waitMs: number }): { done(): void; now(): void; close(): void };
/** One home's `gone(origin)`, from the Admin's word (`ask`), kept per account. */
export function createGoneCheck(deps: { ask(origin: string): Promise<string | null>; account(): string | null; now?(): number }): (origin: string) => Promise<"deleted" | "ended" | null>;

type SendDeps = Parameters<typeof installCloudSend>[0];

export function installOneHome(deps: Omit<SendDeps, "local" | "move" | "moveSession" | "offer"> & {
  /** This computer's server, as its owner. */
  localRequest(route: string, init?: RequestInit & { duplex?: "half" }): Promise<Response>;
  /** The madani cloud sign-in (cloud-account.mjs). */
  account(): { state(): any; pairHome(): Promise<{ origin: string; code: string; expiresAt?: number }>; exportHome(options?: { installation?: string }): Promise<any>;
    reportMove?(options: { installation: string }): Promise<boolean>; reportKept?(options: { installation: string }): Promise<boolean>;
    movedTo?(origin: string): Promise<"deleted" | "ended" | "live" | "unknown" | null>;
    reportMoveStatus?(report: import("./move-status.mjs").MoveStatusReport): Promise<boolean>;
    pairTeam(teamId: string): Promise<{ origin: string; code: string; expiresAt?: number }> } | null;
  journalFile(): string;
  tempRoot(): string;
  lend?(projects: string[]): Promise<unknown>;
  phone?: { paired(): boolean; stop(): Promise<void>; start(): Promise<void> };
  openHome?(): void;
  openLocal?(): void;
  restart?(): void;
  version?: string;
  log?(line: string): void;
  journal?: { read(): unknown; write(value: unknown): void };
  /** The person's choice to keep this computer's bots here, one-home-keep.json beside journalFile by default. */
  keep?: { read(): unknown; write(value: unknown): void };
  /** Shows a team's page: where a bot moved there from My Cloud now lives. */
  openTeam?(team: { id: string; name: string }): void;
  /** The team moves' journal, team-moves.json beside journalFile by default. */
  teamJournal?: { read(): unknown; write(value: unknown): void };
  /** The waits of the move's report to the Admin (move-status.mjs), setTimeout's by default. */
  reportTimers?: { set(work: () => void, ms: number): unknown; clear(timer: unknown): void };
  /** The move to a server of the person's own: while it is chosen no move to My Cloud starts, and its line is this computer's page's. */
  other?(): null | { view(): unknown; seen(): unknown; retry(): Promise<unknown>; active(): boolean };
  accountsHere?(): number;
  /** The first move waits for the person's yes (cloud-move-offer.mjs); without it the first move starts by itself. */
  offer?: { store: { read(): unknown; write(value: unknown): void }; track?(name: string, props: Record<string, string | number | boolean>): void };
}): ReturnType<typeof installCloudSend> & {
  keep: { state(): KeepHereState; set(on: boolean): Promise<void> };
  /** Why the account signed in can't be left now, else null. */
  holding(): "moving" | null;
  kick(): Promise<void>;
  away(): boolean;
  view(): OneHomeView | null;
  close(): void;
  oneHome: ReturnType<typeof createOneHome>;
  offer(): import("./cloud-move-offer.mjs").CloudMoveOffer | null;
  journal(): unknown;
  moveStatus: { read(): import("./move-status.mjs").MoveStatusReport; flush(): Promise<void> };
  marker(): Promise<{ frozen: boolean; cloud?: string; busy?: string }>;
  lastInput(): number;
  teamMove: ReturnType<typeof installTeamMove>;
};
