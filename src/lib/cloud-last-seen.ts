// My Cloud's own page in the desktop window keeps its chats as last seen on this computer (electron/cloud-last-seen.mjs),
// so the window can show them, read-only, while My Cloud sleeps; and it sends, once, the message the person sent from that
// screen while it woke. Nothing happens on any other page: the bridge offers neither there.
import { useEffect, useRef } from "react";
import type { HeldSend, LastSeen } from "../../electron/home-window.mjs";
import type { Action, AppState, Bot } from "../state/store";

export const LAST_SEEN_BOTS = 12;
export const LAST_SEEN_MESSAGES = 40;
const SAVE_AFTER_MS = 3_000;

const newest = (bot: Bot) => bot.messages.at(-1)?.at ?? 0;

/** The open bot first, then the rest by their newest message; each with its open chat's last plain messages. */
export function lastSeenSnapshot(bots: readonly Bot[], selectedId: string | null): LastSeen {
  const ordered = [...bots].sort((a, b) => Number(b.id === selectedId) - Number(a.id === selectedId) || newest(b) - newest(a));
  return {
    bots: ordered.slice(0, LAST_SEEN_BOTS).map((bot) => ({
      id: bot.id, threadId: bot.threadId, name: bot.name, ...(typeof bot.color === "string" ? { color: bot.color } : {}),
      messages: bot.messages
        .filter((message) => message.kind === "text" && typeof message.text === "string" && message.text.trim() && (message.role === "user" || message.role === "bot"))
        .slice(-LAST_SEEN_MESSAGES)
        .map((message) => ({ id: message.id, role: message.role, text: message.text!, at: message.at })),
    })),
  };
}

type HomeSide = { saveLastSeen?(snapshot: LastSeen): Promise<boolean>; takeHeld?(): Promise<HeldSend | null> } | undefined;
const homeSide = (): HomeSide => (typeof window === "undefined" ? undefined : (window as { madaniDesktop?: { home?: HomeSide } }).madaniDesktop?.home);

/** Keeps the snapshot a few seconds after the chats settle, and only when it changed. */
export function useCloudLastSeen(state: Pick<AppState, "bots" | "selectedId" | "hydrated">, home: HomeSide = homeSide()): void {
  const sent = useRef("");
  useEffect(() => {
    if (!home?.saveLastSeen || state.hydrated !== true || !state.bots.length) return;
    const timer = setTimeout(() => {
      const snapshot = lastSeenSnapshot(state.bots, state.selectedId);
      const text = JSON.stringify(snapshot);
      if (text === sent.current) return;
      sent.current = text;
      void home.saveLastSeen!(snapshot).catch(() => { sent.current = ""; });
    }, SAVE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [home, state.bots, state.selectedId, state.hydrated]);
}

/** Once the chats are here: the message held from the asleep screen goes to its bot's chat, once (its sendId makes a
 *  repeat a no-op on the server). */
export function useHeldSend(state: Pick<AppState, "bots" | "hydrated">, dispatch: (action: Action) => void, home: HomeSide = homeSide()): void {
  const taken = useRef(false);
  useEffect(() => {
    if (taken.current || !home?.takeHeld || state.hydrated !== true) return;
    taken.current = true;
    void home.takeHeld().then((held) => {
      if (!held || !state.bots.some((bot) => bot.id === held.botId)) return;
      dispatch({ type: "select", id: held.botId });
      dispatch({ type: "send", botId: held.botId, threadId: held.threadId, text: held.text, sendId: held.sendId });
    }).catch(() => {});
  }, [home, state.bots, state.hydrated, dispatch]);
}
