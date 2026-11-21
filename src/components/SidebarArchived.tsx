import { useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { friendlyError } from "@/lib/plain-error";
import { api, openBot, useStore, visibleMessages, type Bot } from "@/state/store";

import { BotAvatar } from "./Avatar";
import { navigateThreadMenu } from "./BotProjects";
import { Icon } from "./Icon";
import { useHeldMenuMotion } from "./MenuMotion";
import { MENU_SHEET } from "./menu-recipe";
import { botPreview } from "./sidebar-preview";
import { GROK_LABEL, GROK_MENU_ITEM, GROK_ROW_FILL, GrokMenuIcon } from "./SidebarBotMenu";
import { rowSurface } from "./SidebarRowMarkers";
import { SidebarSectionHeader } from "./SidebarSectionHeader";
import { SIMPLE_ROW_FOCUS } from "./SidebarSimpleTop";

export const ARCHIVED_OPEN_KEY = "madanibot.sidebarArchivedOpen";

function loadOpen(): boolean {
  try {
    return globalThis.localStorage?.getItem(ARCHIVED_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function saveOpen(open: boolean) {
  try {
    globalThis.localStorage?.setItem(ARCHIVED_OPEN_KEY, open ? "1" : "0");
  } catch {
  }
}

export function archivedSidebarBots(bots: readonly Bot[]): Bot[] {
  return bots.filter((bot) => bot.hidden && !bot.movedTo);
}

export function useUnarchiveBot() {
  const { dispatch } = useStore();
  return async (bot: Pick<Bot, "id">) => {
    try {
      const response = await api(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ hidden: false }) });
      dispatch({ type: "botPatched", bot: response.bot });
    } catch (cause) {
      dispatch({ type: "error", message: friendlyError(cause) });
    }
  };
}

function ArchivedRow({ bot, selected, onMenu, onUnarchive }: {
  bot: Bot;
  selected: boolean;
  onMenu: (menu: { botId: string; x: number; y: number }) => void;
  onUnarchive: () => void;
}) {
  const { state, dispatch } = useStore();
  const preview = botPreview(bot, visibleMessages(bot), state.instances);
  const unarchiveLabel = t("sidebar.archived.unarchiveBot", { name: bot.name });
  return (
    <div className="group relative" data-sidebar-archived-row={bot.id}>
      <div
        role="button"
        tabIndex={0}
        aria-label={t("sidebar.archived.rowAria", { name: bot.name })}
        aria-description={preview || undefined}
        aria-current={selected ? "page" : undefined}
        onClick={() => openBot(dispatch, bot)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openBot(dispatch, bot);
          } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            onMenu({ botId: bot.id, x: rect.left + 40, y: rect.top + rect.height / 2 });
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          onMenu({ botId: bot.id, x: event.clientX, y: event.clientY + 4 });
        }}
        className={cn("flex w-full items-center gap-2.5 rounded-[12px] p-2 text-left md:h-[58px]", SIMPLE_ROW_FOCUS, rowSurface(selected))}
      >
        <span className="flex shrink-0 opacity-60 transition-opacity duration-150 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100">
          <BotAvatar bot={bot} size={40} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-px pr-7 opacity-60 transition-opacity duration-150 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100">
          <span className="truncate text-[14px] font-medium leading-5 tracking-[0.01em] text-ink">{bot.name}</span>
          {preview && <span dir="auto" className="truncate text-[13px] leading-[18px] tracking-[0.015em] text-ink-secondary">{preview}</span>}
        </div>
      </div>
      <button
        type="button"
        data-sidebar-unarchive={bot.id}
        aria-label={unarchiveLabel}
        title={unarchiveLabel}
        onClick={onUnarchive}
        className="pointer-events-none absolute right-2 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-lg text-ink-secondary opacity-0 transition-[opacity,background-color,color] duration-[180ms] ease-out hover:bg-ink/[0.06] hover:text-ink focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus group-hover:pointer-events-auto group-hover:opacity-100 group-has-[:focus-visible]:pointer-events-auto group-has-[:focus-visible]:opacity-100 touch:pointer-events-auto touch:opacity-70"
      >
        <Icon name="arrow-u-up-left" size={15} />
      </button>
    </div>
  );
}

/** Archived bots, folded at the foot of the open sidebar; each opens its chat, and Unarchive puts it back in the list. */
export function SidebarArchivedSection({ bots }: { bots: readonly Bot[] }) {
  const { state } = useStore();
  const [open, setOpen] = useState(loadOpen);
  const [menu, setMenu] = useState<{ botId: string; x: number; y: number } | null>(null);
  const motion = useHeldMenuMotion(menu);
  const unarchive = useUnarchiveBot();
  const archived = archivedSidebarBots(bots);
  if (archived.length === 0) return null;
  const toggle = () => setOpen((was) => { saveOpen(!was); return !was; });
  const shown = motion.value;
  const close = () => setMenu(null);
  return (
    <div data-sidebar-section-id="builtin:archived" className="flex flex-col gap-1">
      <SidebarSectionHeader name={t("sidebar.archived.section")} line count={archived.length} collapsed={!open} onToggle={toggle} reorderable={false} dragging={false} />
      {open && archived.map((bot) => (
        <ArchivedRow key={bot.id} bot={bot} selected={state.activeView === "chat" && state.selectedId === bot.id}
          onMenu={setMenu} onUnarchive={() => void unarchive(bot)} />
      ))}
      {motion.shown && shown && createPortal(
        <div className={cn("fixed inset-0 z-40", motion.closing && "pointer-events-none")} onMouseDown={close} onContextMenu={(event) => { event.preventDefault(); close(); }}>
          <div role="menu" aria-label={archived.find((bot) => bot.id === shown.botId)?.name ?? t("sidebar.archived.section")}
            style={{ left: Math.max(8, Math.min(shown.x, window.innerWidth - 188)), top: Math.max(8, Math.min(shown.y, window.innerHeight - 60)) }}
            className={cn("absolute w-[180px] text-ink", MENU_SHEET, motion.className)} {...motion.exitProps}
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); event.stopPropagation(); close(); return; }
              navigateThreadMenu(event);
            }}>
            <button type="button" role="menuitem" autoFocus data-sidebar-unarchive-item=""
              onClick={() => { close(); void unarchive({ id: shown.botId }); }}
              className={cn(GROK_MENU_ITEM, GROK_ROW_FILL, "text-ink")}>
              <GrokMenuIcon name="arrow-u-up-left" /><span className={GROK_LABEL}>{t("sidebar.archived.unarchive")}</span>
            </button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
