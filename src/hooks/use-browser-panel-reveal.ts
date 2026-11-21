import { useEffect, useRef } from "react";
import { writeComputerPanelView } from "@/lib/computer-panel-view";
import { listenLiveFrames } from "@/lib/live-events";
import type { Action, Bot } from "@/state/store";
import { toolSurfaceKind } from "../../shared/tool-surface";

type BrowserStart = { kind: string; event?: { type?: string; itemType?: string; title?: string; threadId?: string; turnId?: string } };

/** The turn's first browser call starting, from the live turn stream; null for any other frame. */
export function browserCallStart(frame: BrowserStart): { threadId: string; turnId: string } | null {
  const event = frame.kind === "runtime" ? frame.event : undefined;
  if (event?.type !== "item.started" || event.itemType !== "tool" || !event.threadId || !event.title) return null;
  return toolSurfaceKind(event.title) === "browser" ? { threadId: event.threadId, turnId: event.turnId ?? "" } : null;
}

/** The bot starting to browse in a turn opens the panel's Computer tab on its browser, once per turn, so the person sees
 * it without looking for it. Another panel tab the person has open is left as it is. Desktop app only: it shows that
 * browser. */
export function useBrowserPanelReveal({ bot, active, panel, dispatch }: {
  bot: Pick<Bot, "id" | "threadId" | "browser"> | undefined;
  active: boolean;
  /** the bot panel's open tab, or null while it is closed */
  panel: string | null;
  dispatch: (action: Action) => void;
}) {
  const current = useRef({ bot, active, panel });
  current.current = { bot, active, panel };
  const revealed = useRef(new Set<string>());
  useEffect(() => listenLiveFrames({
    onFrame: (frame) => {
      const start = browserCallStart(frame as BrowserStart);
      if (!start) return;
      const { bot: selected, active: chatShown, panel: tab } = current.current;
      const desktop = Boolean(window.madaniDesktop) && window.madaniDesktop?.remoteClient?.active !== true;
      if (!desktop || !chatShown || !selected || selected.browser === false || selected.threadId !== start.threadId) return;
      const turn = `${start.threadId}\n${start.turnId}`;
      if (revealed.current.has(turn)) return;
      revealed.current.add(turn);
      if (revealed.current.size > 200) revealed.current.delete(revealed.current.values().next().value!);
      if (tab !== null && tab !== "computer") return;
      writeComputerPanelView(selected.id, "browser");
      dispatch({ type: "toggleComputer", open: true });
    },
  }), [dispatch]);
}
