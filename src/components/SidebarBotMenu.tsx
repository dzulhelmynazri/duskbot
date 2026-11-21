import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, useStore, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { Icon, type IconName } from "./Icon";
import { useHeldMenuMotion } from "./MenuMotion";
import { t } from "@/lib/i18n";
import { copyText } from "@/lib/copy-text";
import { BotDeleteMenuItem } from "./BotMenuDelete";
import { HideDefaultBotItem } from "./DefaultBotControls";
import { navigateThreadMenu } from "./BotProjects";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { botUnreadThreadIds, markBotRead } from "@/lib/folder-read";
import { GROK_DANGER, GROK_DANGER_ICON, GROK_LABEL, GROK_ROW_FILL, MENU_ITEM, MENU_ITEM_SEPARATOR, MENU_SHEET } from "./menu-recipe";
export { GROK_LABEL, GROK_ROW_FILL };
import { submenuPosition } from "./SidebarPopoverMenu";
import { submenuIntent, type SubmenuIntent } from "@/lib/submenu-intent";
import { openBotSettingsPage } from "./bot-panel/panel-link";
import type { MenuState } from "./Sidebar";
import { departmentNames, moveBotsToSection, useMayMoveBots } from "./bot-sections";

type Flyout = "more" | "move";

/** Grok's menu row: an 18px slot holding a 14px glyph, 6px before the label. */
// the recipe's own focus and press fills would stack on GROK_ROW_FILL's
export const GROK_MENU_ITEM = cn(MENU_ITEM.replace("focus-visible:bg-menu-hover ", "").replace("active:bg-menu-active ", ""), "gap-1.5");



export function GrokMenuIcon({ name, danger = false }: { name: IconName; danger?: boolean }) {
  return (
    <span aria-hidden="true" className={cn("flex size-[18px] shrink-0 items-center justify-center", danger ? GROK_DANGER_ICON : "text-ink/[0.66]")}>
      <Icon name={name} size={14} />
    </span>
  );
}

export function BotContextMenu({
  menu,
  onClose,
  onArchive,
  onDelete,
  onRename,
  onNewSection,
}: {
  menu: MenuState | null;
  onClose: () => void;
  onArchive: (bot: Bot) => void;
  onDelete: (bot: Bot) => void;
  onRename?: (botId: string) => void;
  /** Simple: "New department…" names a department in the sidebar, with this bot in it. */
  onNewSection?: (botId: string) => void;
}) {
  const motion = useHeldMenuMotion(menu);
  const moreRef = useRef<HTMLButtonElement>(null);
  const moveRef = useRef<HTMLButtonElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const hoveredRow = useRef<Element | null>(null);
  const [flyout, setFlyout] = useState<Flyout | null>(null);
  const [, setMoreEngaged] = useState(false);
  const moreIntent = useRef<SubmenuIntent | null>(null);
  moreIntent.current ??= submenuIntent({
    open: (key) => setFlyout(key as Flyout),
    close: () => { setFlyout(null); setMoreEngaged(false); },
    submenuBox: () => flyoutRef.current?.getBoundingClientRect() ?? null,
  });
  const flyoutRow = (key: Flyout | null) => (key === "more" ? moreRef.current : key === "move" ? moveRef.current : null);
  const rowFlyout = (row: Element | null): Flyout | null => (row && row === moreRef.current ? "more" : row && row === moveRef.current ? "move" : null);
  const more = moreIntent.current;
  const shown = motion.value;
  const { state, dispatch } = useStore();
  const admin = useOwnerOrAdmin();
  const member = admin === false;
  const mayMove = useMayMoveBots();
  const remoteClient = window.madaniDesktop?.remoteClient?.active === true;
  const bot = shown ? state.bots.find((b) => b.id === shown.botId) : undefined;
  const menuRef = useRef<HTMLDivElement>(null);
  const latestMenu = useRef(menu);
  useLayoutEffect(() => { latestMenu.current = menu; }, [menu]);
  const readInFlight = useRef(false);
  const [readingBotId, setReadingBotId] = useState<string | null>(null);
  const [readError, setReadError] = useState<{ botId: string; message: string } | null>(null);
  useEffect(() => { setReadError(null); }, [menu?.botId]);
  const readAll = async (owner: Bot) => {
    if (readInFlight.current) return;
    readInFlight.current = true;
    setReadingBotId(owner.id);
    setReadError(null);
    const openedMenu = menu;
    try {
      await markBotRead(owner, api, (updated) => dispatch({ type: "botPatched", bot: updated }));
      if (latestMenu.current === openedMenu) onClose();
    } catch (error) {
      console.warn("[mark read]", error);
      setReadError({ botId: owner.id, message: t("sidebar.bot.markAllReadFailed") });
    } finally {
      readInFlight.current = false;
      setReadingBotId(null);
    }
  };
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element || !shown) return;
    const place = () => {
      const { width, height } = element.getBoundingClientRect();
      element.style.top = `${Math.max(8, Math.min(shown.y, window.innerHeight - height - 8))}px`;
      element.style.left = `${Math.max(8, Math.min(shown.x, window.innerWidth - width - 8))}px`;
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  });
  // Kept apart from the listeners: onClose is fresh every render, and re-running this would pull focus back to the
  // first item.
  useEffect(() => {
    if (!menu) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    menuRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-bot-menu]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [menu, onClose]);
  useEffect(() => {
    moreIntent.current?.reset();
    hoveredRow.current = null;
    setFlyout(null);
    setMoreEngaged(false);
  }, [menu]);
  useEffect(() => () => moreIntent.current?.reset(), []);
  useLayoutEffect(() => {
    const sheetOut = flyoutRef.current, row = flyoutRow(flyout), sheet = menuRef.current;
    if (!sheetOut || !row || !sheet) return;
    const place = submenuPosition(sheet.getBoundingClientRect(), row.getBoundingClientRect(), { width: sheetOut.offsetWidth, height: sheetOut.offsetHeight }, { width: window.innerWidth, height: window.innerHeight });
    sheetOut.style.left = `${place.left}px`;
    sheetOut.style.top = `${place.top}px`;
  });

  if (!motion.shown || !bot || !shown) return null;
  const deleting = state.deletingBots[bot.id] === true;
  const visibleBotCount = state.bots.filter((candidate) => !candidate.hidden).length;
  const archiveBlocked = Boolean(bot.chiefOfStaff) || visibleBotCount <= 1;
  const archiveHint = bot.chiefOfStaff
    ? t("sidebar.bot.archiveBlockedChief")
    : visibleBotCount <= 1
      ? t("sidebar.bot.archiveBlockedLast")
      : undefined;
  const divider = (key: string) => <div key={key} role="separator" className={MENU_ITEM_SEPARATOR} />;

  const showFlyout = (key: Flyout, focus: boolean) => {
    more.openNow(key);
    if (focus) requestAnimationFrame(() => flyoutRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus());
  };
  const grokItem = (icon: IconName, label: string, onClick?: () => void, opts?: { danger?: boolean; disabled?: boolean; hint?: string; keepOpen?: boolean; checked?: boolean }) => (
    <button
      key={label}
      type="button"
      tabIndex={-1}
      onMouseDown={(event) => event.preventDefault()}
      role={opts?.checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={opts?.checked}
      disabled={opts?.disabled}
      onClick={() => {
        onClick?.();
        if (!opts?.keepOpen) onClose();
      }}
      title={opts?.hint}
      className={cn(GROK_MENU_ITEM, GROK_ROW_FILL, "text-ink", opts?.disabled && "cursor-default opacity-40 hover:before:bg-transparent")}
    >
      <GrokMenuIcon name={icon} danger={opts?.danger} />
      <span className={cn(GROK_LABEL, opts?.danger && GROK_DANGER)}>{label}</span>
    </button>
  );
  const current = bot.section?.trim() ?? "";
  const departments = departmentNames(state);
  const moveItems = [
    ...departments.map((name) => grokItem(name === current ? "check" : "folder", name, () => moveBotsToSection(dispatch, [bot.id], name), { checked: name === current })),
    grokItem(current === "" ? "check" : "folder", t("sidebar.grok.unassigned"), () => moveBotsToSection(dispatch, [bot.id], ""), { checked: current === "" }),
    ...(onNewSection ? [divider("move-new"), grokItem("folder-plus", t("sidebar.grok.createSection"), () => onNewSection(bot.id))] : []),
  ];
  const flyoutButton = (key: Flyout, ref: React.RefObject<HTMLButtonElement | null>, icon: IconName, label: string) => (
    <button
      key={key}
      ref={ref}
      type="button"
      role="menuitem"
      tabIndex={-1}
      onMouseDown={(event) => event.preventDefault()}
      data-bot-menu-move={key === "move" ? "" : undefined}
      aria-haspopup="menu"
      aria-expanded={flyout === key}
      onClick={(event) => (flyout === key ? more.closeNow() : showFlyout(key, event.detail === 0))}
      onKeyDown={(event) => {
        if (event.key !== "ArrowRight") return;
        event.preventDefault();
        showFlyout(key, true);
      }}
      className={cn(GROK_MENU_ITEM, GROK_ROW_FILL, "text-ink", flyout === key && "before:bg-menu-hover")}
    >
      <GrokMenuIcon name={icon} />
      <span className={cn("flex-1", GROK_LABEL)}>{label}</span>
      <Icon name="chevron-right" size={14} className="ms-2 text-ink/[0.52] rtl:-scale-x-100" />
    </button>
  );
  const moveTo = !mayMove ? null : departments.length || current
    ? flyoutButton("move", moveRef, "folder", t("sidebar.grok.moveTo"))
    : onNewSection ? grokItem("folder-plus", t("sidebar.grok.moveToNewSection"), () => onNewSection(bot.id)) : null;
  const rename = onRename && grokItem("pencil-square", t("sidebar.grok.renameBot"), () => onRename(bot.id));
  const copyId = grokItem("copy", t("sidebar.copyConversationId"), () => { void copyText(bot.threadId); });
  const settings = grokItem("gear", t("sidebar.grok.botSettings"), () => openBotSettingsPage(dispatch, bot.id));
  const readState = readingBotId === bot.id || botUnreadThreadIds(bot).length > 0
    ? grokItem("bell", t("sidebar.grok.markRead"), () => { void readAll(bot); }, { disabled: readingBotId !== null, keepOpen: true })
    : grokItem("bell-dot", t("sidebar.grok.markUnread"), () => dispatch({ type: "markUnread", botId: bot.id }));
  const hide = bot.defaultBot
    ? <HideDefaultBotItem key="hide" bot={bot} onDone={onClose} className={cn(GROK_MENU_ITEM, GROK_ROW_FILL, "hover:bg-transparent")} labelClassName={GROK_LABEL} icon={<GrokMenuIcon name="eye-slash" />} />
    : member ? null : grokItem("eye-slash", t("sidebar.grok.hide"), () => onArchive(bot), { disabled: archiveBlocked, hint: archiveHint });
  const remove = member ? null : <BotDeleteMenuItem key="delete" deleting={deleting} className={cn(GROK_MENU_ITEM, GROK_ROW_FILL, "text-ink hover:bg-transparent")} labelClassName={cn(GROK_LABEL, GROK_DANGER)} icon={deleting ? undefined : <GrokMenuIcon name="trash" danger />} label={t("sidebar.grok.delete")} onClick={() => { onClose(); onDelete(bot); }} />;
  const groups = [
    [remoteClient ? null : grokItem(bot.pinned ? "pin-slash" : "pin", bot.pinned ? t("sidebar.bot.unpin") : t("sidebar.bot.pin"), () => dispatch({ type: "updateBot", botId: bot.id, patch: { pinned: !bot.pinned } })), moveTo, readState],
    [rename],
    [copyId],
    [settings],
    [hide, remove],
  ].map((group) => group.filter(Boolean)).filter((group) => group.length > 0);
  return <>{createPortal(
    <div
      ref={menuRef}
      data-bot-menu
      data-sidebar
      role="menu"
      aria-label={t("sidebar.bot.actions", { name: bot.name })}
      onKeyDown={navigateThreadMenu}
      onPointerOver={(event) => {
        const row = event.target instanceof Element ? event.target.closest('[role="menuitem"]') : null;
        if (!row || row === hoveredRow.current) return;
        const left = rowFlyout(hoveredRow.current);
        if (left) more.leaveRow(left);
        hoveredRow.current = row;
        const key = rowFlyout(row);
        more.enterRow(key ?? "row", key !== null, { x: event.clientX, y: event.clientY });
      }}
      onPointerMove={(event) => more.move({ x: event.clientX, y: event.clientY }, flyoutRow(flyout)?.contains(event.target as Node) === true)}
      onPointerLeave={() => {
        const left = rowFlyout(hoveredRow.current);
        if (left) more.leaveRow(left);
        hoveredRow.current = null;
        more.leaveMenu();
      }}
      style={{ top: shown.y, left: shown.x }}
      className={cn("fixed z-40 origin-top-left rtl:origin-top-right max-h-[calc(100dvh-16px)] w-max min-w-[200px] max-w-[min(320px,calc(100vw-16px))] overflow-y-auto overscroll-contain", MENU_SHEET, motion.className)} {...motion.exitProps}
    >
      {groups.flatMap((group, index) => (index > 0 ? [divider(`group-${index}`), ...group] : group))}
      {readError?.botId === bot.id && <p role="alert" className="px-2 py-1.5 text-[12px] text-danger">{readError.message}</p>}
    </div>,
    document.body,
  )}{flyout === "move" && createPortal(
    <div
      ref={flyoutRef}
      data-bot-menu
      data-bot-menu-flyout={flyout}
      data-sidebar
      role="menu"
      aria-label={t("sidebar.grok.moveTo")}
      onPointerEnter={() => { more.enterSubmenu(); setMoreEngaged(true); }}
      onPointerLeave={() => setMoreEngaged(false)}
      onFocus={() => setMoreEngaged(true)}
      onBlur={(event) => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setMoreEngaged(false); }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          const row = flyoutRow(flyout);
          more.closeNow();
          row?.focus();
          return;
        }
        navigateThreadMenu(event);
      }}
      style={{ top: shown.y, left: shown.x }}
      className={cn("fixed z-40 max-h-[calc(100dvh-16px)] w-max min-w-[180px] max-w-[min(320px,calc(100vw-16px))] overflow-y-auto overscroll-contain", MENU_SHEET)}
    >
      {moveItems}
    </div>,
    document.body,
  )}</>;

}
