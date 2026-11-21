import type { ReactNode } from "react";
import type { Bot, Message } from "@/state/store";
import { ApprovalCard, showsSettledChange } from "./ApprovalCard";
import { HelperIntro } from "./HelperIntro";
import { MessageBoundary } from "./MessageBoundary";
import { OptionCard, shouldHideOnboardingCard } from "./OptionCard";
import { QuestionCard } from "./QuestionCard";
import { isQuestionCard } from "@/lib/question-card";
import type { Asker } from "./AskCard";
import { AskingLine } from "./TeamOwner";

/**
 * A settled card that grok keeps in the chat: an answered or dismissed question (its title greys, the answer stays) and
 * a decided permission (one centred grey line). A stopped one, a quiz and an applied change leave no row of their own.
 */
export function settledCardStays(card: NonNullable<Message["card"]>): boolean {
  const applied: boolean = showsSettledChange(card);
  if (card.stopped || applied) return false;
  if (isQuestionCard(card)) return !card.expired && (card.answered === "answer" || card.dismissed === true || Boolean(card.answeredText));
  return Boolean(card.requestId && card.tool) && !card.dismissed;
}

/** A settled card the chat drops. Madani's intro is a card only for its asks: a typed message dismisses it
 * (dismissOnboardingCard), and its bubbles and follow-up stay while only the chips go. */
export function settledCardGoes(m: Message): boolean {
  return Boolean(m.card && !m.helperIntro && (m.card.answered || m.card.dismissed) && !settledCardStays(m.card));
}

/**
 * Called, not mounted: a quiz that dropped out must come back as null so the transcript draws no row and no day
 * separator.
 */
function typedPast(card: Message, transcript: Message[]): boolean {
  const index = transcript.findIndex((entry) => entry.id === card.id);
  return index >= 0 && transcript.slice(index + 1).some((later) => later.role === "user" && later.kind === "text");
}

export function optionsCardRow({ message: m, transcript, botId, botName, botColor, threadId, asker }: {
  message: Message;
  transcript: Message[];
  botId: string;
  botName: string;
  botColor?: Bot["color"];
  threadId: string;
  /** The bot that asks: this conversation's, or for an inbox's copy the one that asked where it came from. */
  asker?: Asker;
}): ReactNode {
  // Madani's follow-up is drawn under its intro (HelperIntro), never as a row of its own.
  if (m.helperFollowup) return null;
  const card = m.helperIntro ? (
    <HelperIntro botId={botId} threadId={threadId} message={m} answered={shouldHideOnboardingCard(m, transcript)}
      followup={transcript.find((entry) => entry.helperFollowup)} />
  ) : isQuestionCard(m.card) ? (
    <QuestionCard threadId={threadId} asker={asker ?? (botColor ? { name: botName, color: botColor } : undefined)} message={m} typedPast={typedPast(m, transcript)} />
  ) : m.card?.requestId && m.card.tool ? (
    <ApprovalCard bot={{ name: botName }} message={m} threadId={threadId} />
  ) : shouldHideOnboardingCard(m, transcript) ? null : (
    <OptionCard botId={botId} threadId={threadId} message={m} />
  );
  if (!card) return null;
  const waiting = Boolean(m.card?.requestId && (isQuestionCard(m.card) || m.card.tool) && !m.card.answered && !m.card.dismissed && !m.inbox);
  return (
    <MessageBoundary fallbackText={m.card?.subtitle || m.card?.title || ""}>
      {waiting && <AskingLine botId={botId} threadId={threadId} />}
      {card}
    </MessageBoundary>
  );
}
