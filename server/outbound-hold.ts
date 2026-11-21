import { randomUUID } from "node:crypto";

import { draftSent, editedEmailArguments, editedEmailReview, emailReviewOf, type EmailEdits, type EmailReview } from "../shared/email-review.ts";
import type { ConnectorCall, OutboundPolicy } from "../shared/outbound.ts";
import { DEFAULT_OUTBOUND_POLICY, OUTBOUND_DEFAULT_CAP } from "../shared/outbound.ts";
import type { Notification } from "../shared/notification.ts";
import { isPurchaseTool, type PurchaseSummary } from "../shared/purchase.ts";
import type { OptionCardData } from "../shared/wire.ts";
import { HELD_NOTE } from "./auto-approve.ts";
import { appendDecision } from "./decision-log.ts";
import { buildNotification } from "./notify.ts";
import { serverLine } from "./server-lines.ts";
import type { OutboundCounts } from "./outbound-counts.ts";
import type { OutboundRequestService } from "./outbound-requests.ts";
import { outboundCard } from "./outbound-requests.ts";
import type { BotRecord, GroupRecord, Store } from "./store.ts";
import { turnWaitedOnPerson } from "./waiting-on-person.ts";

/** How long a "Send on your behalf?" card waits on the person before it times out. */
export const OUTBOUND_HOLD_MS = 9 * 60_000;

/** The bot fields the hold reads. */
export type OutboundHoldBot = Pick<BotRecord, "id" | "name" | "color" | "outbound" | "avatarUrl" | "notifications">;

export interface OutboundHoldDeps {
  store: Pick<Store, "appendMessage" | "bot" | "messagesFor" | "patchMessage" | "setActivity" | "setTaskActivity" | "taskByThread">;
  dataDir: string;
  outboundRequests: OutboundRequestService;
  outboundCounts: OutboundCounts;
  /** How long a "Send on your behalf?" card waits before it times out. */
  holdMs: number;
  connectorThread: (botId: string, threadId: string) => { group?: GroupRecord } | null;
  activeGroupTurnForBot: (botId: string) => { threadId: string } | null;
  notify: (notification: Notification | null) => void;
}

export type OutboundHoldAnswer = { ok: true; approved: boolean } | { ok: false; text: string };

export const CONFIRM_PURCHASE_TOOL = "confirm_purchase";
const PURCHASE_TITLE = serverLine(undefined, "server.purchase.title");
const PURCHASE_OPTIONS = ["Confirm purchase", "Cancel"];
const EMAIL_TITLE = serverLine(undefined, "server.emailReview.title");
const EMAIL_OPTIONS = ["Send email", "Don't send"];
const SEND_TITLE = "Send on your behalf?";

/** What the card asks: a purchase to confirm, an email to review, or any other send. */
type CardAsk = { kind: "purchase" } | { kind: "email"; email: EmailReview } | { kind: "draft"; draftId: string } | { kind: "send" };

function cardAsk(calls: ConnectorCall[]): CardAsk {
  if (calls.some((call) => isPurchaseTool(call.slug))) return { kind: "purchase" };
  const email = emailReviewOf(calls);
  if (email) return { kind: "email", email };
  const draftId = draftSent(calls);
  return draftId ? { kind: "draft", draftId } : { kind: "send" };
}

/** How many sends a day go out on their own, or null when each waits on the card. At Full access a bot with no sending
 * rule of its own sends without asking, up to the default cap, except an email, which the person reviews first; a stored
 * rule is kept exactly as set. A purchase always waits on the card. */
function outboundDailyCap(rule: OutboundPolicy | undefined, fullAccess: boolean, opaque: boolean, ask: CardAsk): { cap: number; fullAccess: boolean } | null {
  if (ask.kind === "purchase") return null;
  if (fullAccess && rule === undefined) return ask.kind === "email" || ask.kind === "draft" ? null : { cap: OUTBOUND_DEFAULT_CAP, fullAccess: true };
  const policy = rule ?? DEFAULT_OUTBOUND_POLICY;
  return policy.policy === "allow" && !opaque ? { cap: policy.dailyCap, fullAccess: false } : null;
}

export function purchaseText(summary: PurchaseSummary): string {
  const items = summary.items.map((item) => `${item.quantity} × ${item.name}${item.price ? ` (${item.price})` : ""}`);
  return [summary.merchant, ...items, `Total ${summary.total}${summary.shipping ? `, shipping ${summary.shipping}` : ""}`,
    summary.paymentMethod ? `Paid with ${summary.paymentMethod}` : "", summary.address ? `Deliver to ${summary.address}` : "",
    summary.delivery ? `Arrives ${summary.delivery}` : ""].filter(Boolean).join("\n");
}

function emailText(email: EmailReview): string {
  const head = [`To ${email.to.join(", ")}`, email.cc?.length ? `Cc ${email.cc.join(", ")}` : "", email.subject ? `Subject ${email.subject}` : ""];
  return `${head.filter(Boolean).join("\n")}\n\n${email.body}`;
}

type CardInput = Pick<OptionCardData, "title" | "subtitle" | "options" | "email" | "purchase"> & { outboundRequest: NonNullable<OptionCardData["outboundRequest"]> };
type Asked = { ok: true; messageId: string; edits: EmailEdits | null } | { ok: false; text: string };

export interface OutboundHold {
  /** A send spends the day's allowance (Full access with no rule of its own, or "allow") or waits on the "Send on your behalf?" card. `fullAccess`: the turn runs at Full access.
   * An email the person edited on its card before Send goes out as edited: its call's arguments are rewritten in place. */
  hold(input: { bot: OutboundHoldBot; threadId: string; tool: string; calls: ConnectorCall[]; opaque: boolean; fullAccess: boolean; active: () => boolean;
    /** Reads a Gmail draft sent by id, so its card shows the text that goes out; null when it cannot be read. */
    readDraft?: (draftId: string) => Promise<EmailReview | null> }): Promise<OutboundHoldAnswer>;
  /** At dispatch time: a send with an allowance reserves against its cap; otherwise the hold must have been approved. Throws the refusal text. */
  reserve(input: { bot: OutboundHoldBot; threadId: string; tool: string; calls: ConnectorCall[]; opaque: boolean; fullAccess: boolean; approved: boolean }): void;
  /** The "Confirm purchase" card for a purchase the bot makes in its browser. `recorded`: the person said to buy without
   * asking, so the card is posted as the receipt and nothing waits. */
  confirmPurchase(input: { bot: OutboundHoldBot; threadId: string; summary: PurchaseSummary; recorded: boolean; active: () => boolean }): Promise<OutboundHoldAnswer>;
}

export function createOutboundHold(deps: OutboundHoldDeps): OutboundHold {
  const { store, outboundRequests, outboundCounts, connectorThread, activeGroupTurnForBot, notify } = deps;
  const DATA_DIR = deps.dataDir;
  const { holdMs } = deps;
  const from = (bot: OutboundHoldBot, threadId: string) =>
    connectorThread(bot.id, threadId)?.group ? { from: { botId: bot.id, name: bot.name, color: bot.color } } : {};

  async function askOnCard(bot: OutboundHoldBot, threadId: string, tool: string, summary: string, active: () => boolean, input: CardInput): Promise<Asked> {
    const owner = connectorThread(bot.id, threadId);
    const held = outboundRequests.open({ botId: bot.id, threadId, tool, timeoutMs: holdMs });
    const card = store.appendMessage(threadId, {
      role: "bot",
      kind: "options",
      ...from(bot, threadId),
      card: { ...input, requestId: held.requestId, tool, held: HELD_NOTE["approval.held.outbound"], heldCode: "approval.held.outbound" },
    });
    appendDecision(DATA_DIR, {
      threadId, requestId: held.requestId, botId: bot.id, botName: bot.name,
      tool, summary, decision: "card-shown", source: "outbound",
    });
    if (owner?.group) {
      if (activeGroupTurnForBot(bot.id)?.threadId === threadId) store.setActivity(bot.id, "waiting-on-you");
    } else if (store.taskByThread(bot.id, threadId)?.busy) {
      store.setTaskActivity(bot.id, threadId, "waiting-on-you");
    }
    notify(buildNotification("approval", bot, threadId, input.title === SEND_TITLE ? summary : `${input.title}\n${input.subtitle}`, { avatarUrl: bot.avatarUrl }));
    const answer = await held.answer;
    const edits = outboundRequests.edits(held.requestId);
    outboundRequests.forget(held.requestId);
    if (active()) {
      const waiting = store.bot(bot.id);
      if (owner?.group) {
        if (activeGroupTurnForBot(bot.id)?.threadId === threadId && turnWaitedOnPerson(waiting)) store.setActivity(waiting.id, "working");
      } else if (turnWaitedOnPerson(store.taskByThread(bot.id, threadId))) {
        store.setTaskActivity(bot.id, threadId, "working");
      }
    }
    if (answer === "allow") return { ok: true, messageId: card.id, edits };
    if (answer === "timeout") {
      const stale = store.messagesFor(threadId).find((message) => message.id === card.id);
      if (stale?.card && !stale.card.answered) {
        store.patchMessage(threadId, stale.id, { card: { ...stale.card, answered: "unavailable", dismissed: true } });
      }
    }
    const what = input.title === PURCHASE_TITLE ? "buy this" : "send this";
    return {
      ok: false,
      text: answer === "timeout"
        ? `madani bot did not ${what}: nobody answered the approval in time. Ask the user before trying again.`
        : `madani bot did not ${what}: the user declined. Do not retry it; ask the user what they would like instead.`,
    };
  }

  /** The person's edits, written into the call that goes out and onto the card that stays in the chat. */
  function applyEdits(threadId: string, messageId: string, call: ConnectorCall, email: EmailReview, edits: EmailEdits): void {
    const edited = editedEmailArguments(call, edits);
    if (!edited) return;
    const args = call.arguments as Record<string, unknown>;
    for (const key of Object.keys(args)) if (!(key in edited)) delete args[key];
    Object.assign(args, edited);
    const shown = editedEmailReview(email, edits);
    const card = store.messagesFor(threadId).find((message) => message.id === messageId)?.card;
    if (card) store.patchMessage(threadId, messageId, { card: { ...card, email: shown, subtitle: emailText(shown) } });
  }

  return {
    async hold({ bot: currentSender, threadId, tool: outboundTool, calls: outboundCalls, opaque, fullAccess, active, readDraft }) {
      const refuseOutbound = (text: string): OutboundHoldAnswer => ({ ok: false, text });
      const ask = cardAsk(outboundCalls);
      const allowance = outboundDailyCap(currentSender.outbound, fullAccess, opaque, ask);
      const { app, calls, summary } = outboundCard(outboundCalls);
      const capNote = (count: number, full: boolean) =>
        `madani bot did not send this. ${currentSender.name} has reached its daily limit of ${count} outbound action${count === 1 ? "" : "s"}${full ? " at Full access" : ""}. Tell the user it was not sent, and ask them to ${full ? "set a sending rule" : "raise the limit"} under the bot's Permissions before trying again.`;
      if (allowance) {
        let today: number;
        try { today = outboundCounts.today(currentSender.id); }
        catch { return refuseOutbound("madani bot did not send this: the daily allowance could not be read. Nothing was sent."); }
        if (today + outboundCalls.length > allowance.cap) {
          appendDecision(DATA_DIR, {
            threadId, botId: currentSender.id, botName: currentSender.name,
            tool: outboundTool, summary, decision: "auto-denied", source: "outbound", rule: `${allowance.fullAccess ? "full-access-cap" : "daily-cap"}:${allowance.cap}`,
          });
          return refuseOutbound(capNote(allowance.cap, allowance.fullAccess));
        }
        return { ok: true, approved: false };
      }
      const outboundRequest = { tool: outboundTool, app, calls, ...(ask.kind === "purchase" ? { purchase: true as const } : {}) };
      const draft = ask.kind === "draft" ? await readDraft?.(ask.draftId).catch(() => null) ?? null : null;
      const email = ask.kind === "email" ? ask.email : draft ? { ...draft, draft: true as const } : null;
      const card: CardInput = ask.kind === "purchase"
        ? { title: PURCHASE_TITLE, subtitle: summary, options: PURCHASE_OPTIONS, outboundRequest }
        : email
          ? { title: EMAIL_TITLE, subtitle: emailText(email), options: EMAIL_OPTIONS, email, outboundRequest }
          : { title: SEND_TITLE, subtitle: summary, options: ["Allow", "Deny"], outboundRequest };
      const asked = await askOnCard(currentSender, threadId, outboundTool, summary, active, card);
      if (!asked.ok) return refuseOutbound(asked.text);
      if (ask.kind === "draft" && asked.edits) return refuseOutbound("madani bot did not send this: a saved draft goes out as saved, and the person changed it on the card. Update the draft with their changes first, then send it again.");
      if (ask.kind === "email" && asked.edits) applyEdits(threadId, asked.messageId, outboundCalls[0]!, ask.email, asked.edits);
      return { ok: true, approved: true };
    },
    reserve({ bot: fresh, threadId, tool: outboundTool, calls: outboundCalls, opaque, fullAccess, approved: outboundApproved }) {
      const refuseDispatch: (text: string) => never = (text) => {
        throw new Error(text);
      };
      const allowance = outboundDailyCap(fresh.outbound, fullAccess, opaque, cardAsk(outboundCalls));
      if (allowance) {
        let reserved: number | null;
        try { reserved = outboundCounts.reserve(fresh.id, outboundCalls.length, allowance.cap); }
        catch { refuseDispatch("The daily allowance could not be saved. Nothing was sent."); }
        if (reserved === null) refuseDispatch("This bot has reached its daily outbound limit. Nothing was sent.");
        appendDecision(DATA_DIR, { threadId, botId: fresh.id, botName: fresh.name,
          tool: outboundTool, decision: "auto-approved", source: "outbound", rule: `${allowance.fullAccess ? "full-access" : "daily-allowance"}:${reserved}/${allowance.cap}` });
      } else if (!outboundApproved) {
        refuseDispatch("The outbound policy changed. Ask for approval again before sending.");
      }
    },
    async confirmPurchase({ bot, threadId, summary, recorded, active }) {
      const text = purchaseText(summary);
      if (recorded) {
        store.appendMessage(threadId, {
          role: "bot",
          kind: "options",
          ...from(bot, threadId),
          card: { title: "Purchase", subtitle: text, options: [], requestId: randomUUID(), tool: CONFIRM_PURCHASE_TOOL, purchase: { ...summary, recorded: true }, answered: "allow" },
        });
        appendDecision(DATA_DIR, { threadId, botId: bot.id, botName: bot.name, tool: CONFIRM_PURCHASE_TOOL, summary: text.slice(0, 240),
          decision: "auto-approved", source: "outbound", rule: "person-said-no-confirmation" });
        return { ok: true, approved: true };
      }
      const asked = await askOnCard(bot, threadId, CONFIRM_PURCHASE_TOOL, text, active, {
        title: PURCHASE_TITLE, subtitle: text, options: PURCHASE_OPTIONS, purchase: summary, outboundRequest: { tool: CONFIRM_PURCHASE_TOOL, app: null, purchase: true },
      });
      return asked.ok ? { ok: true, approved: true } : { ok: false, text: asked.text };
    },
  };
}
