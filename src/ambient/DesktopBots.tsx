// The app window's side of electron/desktop-bots.mjs: it tells main which bots are working, so one ⌘Q waits for a
// hold while they do, shows the pill that press brings up, and carries out the menu's Stop Bot and Stop All Bots. It
// also tells main which bots wait on the person, so an ask's banner closes once it is answered anywhere.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore, type AppState, type Bot, type Group } from "@/state/store";
import { workingThreadId } from "@/components/SidebarWorkingStep";
import { activeLocale, t } from "@/lib/i18n";
import { isMacPlatform } from "@/lib/keyboard-shortcuts";
import { waitsOnPerson } from "./summary";

/** The pill stays up this long after the last press. */
export const QUIT_HINT_MS = 2_400;
const NAMED = 3;

export function busyBotNames(bots: readonly Pick<Bot, "name" | "busy" | "hidden" | "movedTo">[]): string[] {
  return bots.filter((bot) => bot.busy && !bot.hidden && !bot.movedTo).map((bot) => bot.name);
}

export function quitHintText(names: readonly string[], mac: boolean, locale = activeLocale()): string {
  const key = mac ? "⌘Q" : "Ctrl+Q";
  if (names.length === 1) return t("ambient.quitHint.one", { name: names[0]!, key });
  if (names.length > NAMED) return t("ambient.quitHint.many", { count: names.length, key });
  let list = names.join(", ");
  try { list = new Intl.ListFormat(locale || undefined, { type: "conjunction" }).format(names); } catch { /* the plain list */ }
  return t("ambient.quitHint.some", { names: list, key });
}

type StopAction = { type: "interrupt"; botId: string; threadId: string } | { type: "interruptGroup"; groupId: string; threadId: string };

const groupWorking = (group: Pick<Group, "working" | "busyBotId">) => Boolean(group.working || group.busyBotId);
const busyThreads = (bot: Bot) => {
  const tasks = (bot.tasks ?? []).filter((task) => task.busy).map((task) => task.threadId);
  return tasks.length ? tasks : bot.busy ? [workingThreadId(bot)] : [];
};

/** ⌘. stops the open chat's turn, ⌥⌘. every turn running here: nothing for a chat with none. */
export function stopActions(state: Pick<AppState, "bots" | "groups" | "selectedId">, all: boolean): StopAction[] {
  if (all) {
    return [
      ...state.bots.flatMap((bot) => busyThreads(bot).map((threadId): StopAction => ({ type: "interrupt", botId: bot.id, threadId }))),
      ...state.groups.filter(groupWorking).map((group): StopAction => ({ type: "interruptGroup", groupId: group.id, threadId: group.threadId })),
    ];
  }
  const group = state.groups.find((entry) => entry.id === state.selectedId);
  if (group) return groupWorking(group) ? [{ type: "interruptGroup", groupId: group.id, threadId: group.threadId }] : [];
  const bot = state.bots.find((entry) => entry.id === state.selectedId);
  return bot?.busy ? [{ type: "interrupt", botId: bot.id, threadId: workingThreadId(bot) }] : [];
}

// the store keeps an unchanged bot's object, so each is read once per change of its own
const waitsOf = new WeakMap<Bot, boolean>();
const waits = (bot: Bot) => {
  let known = waitsOf.get(bot);
  if (known === undefined) waitsOf.set(bot, (known = waitsOnPerson(bot)));
  return known;
};

/** Every loaded bot, waiting on the person or not. */
export function askReport(bots: readonly Bot[]): { waiting: string[]; settled: string[] } {
  const waiting: string[] = [], settled: string[] = [];
  for (const bot of bots) (waits(bot) ? waiting : settled).push(bot.id);
  return { waiting, settled };
}

export function DesktopBots() {
  const { state, dispatch } = useStore();
  const bridge = typeof window === "undefined" ? undefined : window.madaniDesktop?.desktopBots;
  const busy = busyBotNames(state.bots).join("\n");
  useEffect(() => { bridge?.busy(busy ? busy.split("\n") : []); }, [bridge, busy]);
  const latest = useRef(state);
  latest.current = state;
  useEffect(() => bridge?.onStop(({ all }) => { for (const action of stopActions(latest.current, all)) dispatch(action); }), [bridge, dispatch]);

  const notifications = typeof window === "undefined" ? undefined : window.madaniDesktop?.desktopNotifications;
  const asks = JSON.stringify(askReport(state.bots));
  useEffect(() => { notifications?.asks?.(JSON.parse(asks)); }, [notifications, asks]);

  const [hint, setHint] = useState<{ names: string[]; at: number } | null>(null);
  useEffect(() => bridge?.onQuitHint((names) => setHint(names.length ? { names, at: Date.now() } : null)), [bridge]);
  useEffect(() => {
    if (!hint) return;
    const timer = window.setTimeout(() => setHint(null), QUIT_HINT_MS);
    return () => window.clearTimeout(timer);
  }, [hint]);

  if (!hint || typeof document === "undefined") return null;
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      data-quit-hint=""
      className="pointer-events-none fixed bottom-[88px] left-1/2 z-[70] max-w-[calc(100vw-32px)] -translate-x-1/2 truncate rounded-full bg-menu px-3.5 py-1.5 text-[13px] leading-[18px] text-ink shadow-[var(--shadow-popover)]"
    >
      {quitHintText(hint.names, isMacPlatform())}
    </div>,
    document.body,
  );
}
