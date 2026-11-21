// Mounted once in the app: while the island or the dock is on, it sums up the bots for them (from the store and the
// live stream this page already reads, never a request of its own) and carries out what they ask. It also keeps main's
// view of the working bots for ⌘Q (DesktopBots).
import { useCallback, useEffect, useRef, useState } from "react";
import { useStore, type AppState } from "@/state/store";
import { onAnyTurnLive, turnLive } from "@/state/turn-status";
import { activeLocale } from "@/lib/i18n";
import { openCreateBot } from "@/lib/create-bot-request";
import { pendingApprovals } from "@/components/PendingApproval";
import { sidebarPreviewMessages } from "@/components/sidebar-preview";
import { workingThreadId } from "@/components/SidebarWorkingStep";
import { cardQuestions } from "@/components/QuestionCard";
import { formatQuestionAnswers } from "../../shared/ask-question";
import { VIEWED_MAX, ambientSnapshot, answerableInPlace, questionOf } from "./summary";
import { onAnyLiveReply } from "@/state/live-reply";
import { DesktopBots } from "./DesktopBots";
import { useAmbientAwayValue } from "./away";
import type { AmbientAct, AmbientViewing } from "./types";

/** Summaries go out at most this often: a streaming reply changes a bot's status line many times a second. */
export const PUBLISH_MS = 160;

type Dispatch = ReturnType<typeof useStore>["dispatch"];

/** Checked again here: the surfaces may only answer a plain approval, or a question with one of its own choices (or typed,
 * where it takes that), that the page itself still shows as open, and stop only a bot that is working. */
export function runAmbientAct(act: AmbientAct, state: AppState, dispatch: Dispatch): void {
  if (act.kind === "new-bot") return openCreateBot();
  const bot = state.bots.find((entry) => entry.id === act.botId);
  if (!bot) return;
  if (act.kind === "reply") {
    if (act.text.trim()) dispatch({ type: "send", botId: bot.id, threadId: act.threadId, text: act.text.trim() });
    return;
  }
  if (act.kind === "stop") {
    if (bot.busy) dispatch({ type: "interrupt", botId: bot.id, threadId: workingThreadId(bot) });
    return;
  }
  if (act.kind === "answer") {
    const open = questionOf(sidebarPreviewMessages(bot));
    if (!open || open.card.requestId !== act.requestId || act.threadId !== bot.threadId) return;
    if (!open.choices?.includes(act.text) && !open.custom) return;
    const message = open.card.questionRequest ? formatQuestionAnswers(cardQuestions(open.card), [[act.text]]) : act.text;
    dispatch({ type: "decideRequest", threadId: act.threadId, requestId: act.requestId, behavior: "answer", message });
    return;
  }
  const pending = pendingApprovals(sidebarPreviewMessages(bot)).find((entry) => entry.requestId === act.requestId);
  if (!pending || !answerableInPlace(pending) || act.threadId !== bot.threadId) return;
  dispatch({ type: "decideRequest", threadId: act.threadId, requestId: act.requestId, behavior: act.kind, message: act.kind === "deny" ? "Denied by the user." : undefined });
}

export function AmbientPublisher() {
  const { state, dispatch } = useStore();
  const bridge = typeof window === "undefined" ? undefined : window.madaniDesktop?.ambient;
  const [wanted, setWanted] = useState(false);
  const away = useAmbientAwayValue();
  const awayNow = useRef(away);
  awayNow.current = away;
  const latest = useRef(state);
  latest.current = state;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sent = useRef("");
  // what the person watched in this window: those bots stay quiet on the surfaces (summary.ts Watch)
  const watched = useRef(new Map<string, string>());
  // the chat a surface is showing: that bot's summary carries a long stretch of it, loaded further back on request
  const viewing = useRef<AmbientViewing | null>(null);

  useEffect(() => {
    if (!bridge) return;
    let live = true;
    void bridge.wanted().then((next) => { if (live) setWanted(next); }, () => {});
    const off = bridge.onWanted(setWanted);
    return () => { live = false; off(); };
  }, [bridge]);

  const schedule = useCallback(() => {
    if (timer.current || !bridge) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      const { bots, instances, selectedId, hydrated } = latest.current;
      if (!hydrated) return;
      const focused = document.hasFocus() && document.visibilityState === "visible";
      const snapshot = awayNow.current
        ? { bots: [], labels: {}, lang: activeLocale(), away: true as const }
        : ambientSnapshot(bots, instances, turnLive, activeLocale(), { selectedId, focused, watched: watched.current }, viewing.current);
      const key = JSON.stringify(snapshot);
      if (key === sent.current) return;
      sent.current = key;
      bridge.publish(snapshot);
    }, PUBLISH_MS);
  }, [bridge]);

  // nothing until the app has loaded its bots: an empty list at start-up would show an empty dock
  useEffect(() => {
    if (!wanted) { sent.current = ""; return; }
    if (!state.hydrated) return;
    schedule();
  }, [wanted, away, state.hydrated, state.bots, state.instances, state.selectedId, schedule]);
  useEffect(() => (wanted ? onAnyTurnLive(schedule) : undefined), [wanted, schedule]);
  // a reply as it streams, word by word, not only once it has landed
  useEffect(() => (wanted ? onAnyLiveReply(schedule) : undefined), [wanted, schedule]);
  const asked = useRef("");
  useEffect(() => bridge?.onViewing?.((next) => {
    viewing.current = next && typeof next.botId === "string" ? { botId: next.botId, limit: Math.max(1, Math.min(VIEWED_MAX, Math.floor(next.limit) || 0)) } : null;
    const bot = viewing.current && latest.current.bots.find((entry) => entry.id === viewing.current!.botId);
    // more than the page holds: the next older page, once per stretch asked for
    const key = bot ? `${bot.threadId}:${viewing.current!.limit}` : "";
    if (bot && bot.hasMore && viewing.current!.limit > sidebarPreviewMessages(bot).length && asked.current !== key) {
      asked.current = key;
      dispatch({ type: "loadOlderMessages", threadId: bot.threadId });
    }
    schedule();
  }), [bridge, dispatch, schedule]);
  useEffect(() => {
    if (!wanted) return;
    window.addEventListener("focus", schedule);
    window.addEventListener("blur", schedule);
    document.addEventListener("visibilitychange", schedule);
    return () => { window.removeEventListener("focus", schedule); window.removeEventListener("blur", schedule); document.removeEventListener("visibilitychange", schedule); };
  }, [wanted, schedule]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => bridge?.onAct((act) => runAmbientAct(act, latest.current, dispatch)), [bridge, dispatch]);
  return <DesktopBots />;
}
