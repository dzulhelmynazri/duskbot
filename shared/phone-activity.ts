// The iPhone's turn Live Activity and its notification actions: the wire shapes the bot host, the push relay and the
// app's native layer all read. Security: everything pushed is content-free except `sealed`, which only the phone that
// registered the key can open; `line` never leaves the phone.
import type { TurnProgressActivity } from "./turn-progress.ts";

/** UNNotificationCategory identifiers the app registers at launch. */
export const PHONE_CATEGORY = {
  /** Approve and Deny, both behind Face ID. */
  approval: "madani.approval",
  /** Answer: opens the question. */
  question: "madani.question",
  /** Reply, a text field. */
  message: "madani.message",
} as const;
export type PhoneCategory = (typeof PHONE_CATEGORY)[keyof typeof PHONE_CATEGORY];

/** UNNotificationAction identifiers; the Live Activity's buttons use the same ones. */
export const PHONE_ACTION = { approve: "madani.approve", deny: "madani.deny", reply: "madani.reply", answer: "madani.answer" } as const;
export type PhoneActionId = (typeof PHONE_ACTION)[keyof typeof PHONE_ACTION];

const REPLY_KINDS: ReadonlySet<string> = new Set(["done", "mention", "brief", "wait", "delegation-settled"]);

/** The actions a push offers: an approval with its ask id gets Approve and Deny, a question Answer, a bot's direct
 * message Reply. A room's message offers none: a reply there goes to the whole room. */
export function pushCategory(push: { kind: string; requestId?: string; groupId?: string }): PhoneCategory | undefined {
  if (push.kind === "approval") return push.requestId ? PHONE_CATEGORY.approval : undefined;
  if (push.kind === "question") return PHONE_CATEGORY.question;
  if (REPLY_KINDS.has(push.kind) && !push.groupId) return PHONE_CATEGORY.message;
  return undefined;
}

/** ActivityKit's attributes-type: the Swift struct's name. */
export const TURN_ACTIVITY_TYPE = "MadaniTurnAttributes";
/** How long a finished activity stays on the lock screen. */
export const TURN_ACTIVITY_DISMISS_S = 20;

/** Fixed for the activity's life. */
export interface TurnActivityAttributes {
  botId: string;
  botName: string;
  threadId: string;
  groupId?: string;
  /** a MausColor name; the widget holds the palette */
  color: string;
  /** one of MADANI_BODY_IDS; the widget holds each body's still frame */
  body: string;
}

export type TurnActivityPhase = "working" | "needs-you" | "done" | "stopped";

/** ActivityKit's content-state. Dates are epoch seconds: ActivityKit decodes a pushed Date from 2001, not 1970. */
export interface TurnActivityState {
  phase: TurnActivityPhase;
  /** what the running step does; absent while the bot thinks */
  step?: TurnProgressActivity;
  /** tool steps this turn has taken */
  steps: number;
  startedAt: number;
  ask?: { kind: "approve" | "answer"; requestId: string };
  /** done: the reply's first line, sealed to the activity's key (seal below); readable only on that phone */
  sealed?: string;
  /** done, set by the app itself while it is open: the reply's first line; never pushed */
  line?: string;
}

export type TurnActivityEvent =
  | { type: "step"; activity: TurnProgressActivity }
  | { type: "thinking" }
  | { type: "ask"; kind: "approve" | "answer"; requestId: string }
  | { type: "resolved"; requestId?: string }
  | { type: "done"; sealed?: string; line?: string }
  | { type: "stopped" };

export function turnActivityStart(startedAt: number): TurnActivityState {
  return { phase: "working", steps: 0, startedAt: Math.floor(startedAt) };
}

export const turnActivityEnded = (state: TurnActivityState) => state.phase === "done" || state.phase === "stopped";

/** The next state, or the same object when the event changes nothing; a finished activity takes no more events. */
export function nextTurnActivity(state: TurnActivityState, event: TurnActivityEvent): TurnActivityState {
  if (turnActivityEnded(state)) return state;
  switch (event.type) {
    case "step": {
      if (state.phase === "needs-you") return state;
      return { ...state, phase: "working", step: event.activity, steps: state.steps + 1 };
    }
    case "thinking": {
      if (state.phase !== "working" || state.step === undefined) return state;
      const { step: _step, ...rest } = state;
      return rest;
    }
    case "ask":
      if (state.phase === "needs-you" && state.ask?.requestId === event.requestId && state.ask.kind === event.kind) return state;
      return { ...state, phase: "needs-you", ask: { kind: event.kind, requestId: event.requestId } };
    case "resolved": {
      if (state.phase !== "needs-you" || (event.requestId && state.ask?.requestId !== event.requestId)) return state;
      const { ask: _ask, ...rest } = state;
      return { ...rest, phase: "working" };
    }
    case "done": {
      const { ask: _ask, step: _step, ...rest } = state;
      return { ...rest, phase: "done", ...(event.sealed ? { sealed: event.sealed } : {}), ...(event.line ? { line: event.line } : {}) };
    }
    case "stopped": {
      const { ask: _ask, step: _step, ...rest } = state;
      return { ...rest, phase: "stopped" };
    }
  }
}

/** The reply's first line as the lock screen shows it: markdown marks dropped, at most 120 characters. */
export function replyFirstLine(text: string): string {
  const line = text.split("\n").map((one) => one.replace(/^[#>*\-\s]+/, "").replace(/[*_`~]/g, "").trim()).find(Boolean) ?? "";
  const chars = [...line];
  return chars.length > 120 ? `${chars.slice(0, 119).join("").trimEnd()}…` : line;
}

/** HKDF salt and info of the done line's seal: X25519 between a one-time key and the activity key, then AES-256-GCM.
 * The sealed value is base64url of ephemeral public key (32) | iv (12) | ciphertext | tag (16). */
export const TURN_LINE_SEAL = { salt: "madani-turn-line-v1", info: "seal" } as const;

/** PUT /api/mobile/activity: this phone's Live Activity for a thread. */
export interface TurnActivityRegistration {
  threadId: string;
  /** the activity's own APNs push token, hex */
  token: string;
  /** X25519 public key, base64url, the done line is sealed to; absent when the phone shows no previews */
  key?: string;
  environment?: "sandbox" | "production";
}

/** PUT /api/mobile/activity-start: the push-to-start token (iOS 17.2+), so an ask can open an activity. */
export interface TurnActivityStartRegistration {
  token: string;
  environment?: "sandbox" | "production";
}
