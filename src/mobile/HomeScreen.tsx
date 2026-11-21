import { memo, useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { motion, useTransform, type MotionValue } from "motion/react";
import { BellDot, Check, ChevronDown, MonitorSmartphone, Pin, PinOff, Plus, RotateCcw, Search, Star, UserRound } from "../icons";
import { api, retryLoad, useStore, type Bot, type Group } from "@/state/store";
import { BotAvatar, MausAvatar } from "@/components/Avatar";
import { MascotLoader } from "@/components/MascotLoader";
import { GroupAvatar, useGroupYou } from "@/components/GroupAvatar";
import { UserFace } from "@/components/UserAvatar";
import { useMobileAccount } from "./account/AccountGate";
import { botPreview, groupPreview, lastPreviewable, sidebarPreviewMessages } from "@/components/sidebar-preview";
import { SidebarWorkingWord } from "@/components/SidebarWorkingStep";
import { partitionSidebarBots, withPrimaryTile } from "@/lib/sidebar-layout";
import { botShowsUnread } from "@/lib/bot-unread";
import { botUnreadThreadIds, markBotRead } from "@/lib/folder-read";
import { stateForBot } from "@/lib/mascot";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { threadRefUrl } from "@/lib/thread-refs";
import { RoundButton } from "./RoundButton";
import { ContextMenu, useLongPress, type ContextAction, type NativePress } from "./ContextMenu";
import { useNativeHold, type HeldMenu } from "./native-menu";
import { PullToRefresh } from "./PullToRefresh";
import { revealOnce, useListFlip } from "./list-motion";
import { refreshSnapshot } from "./refresh";
import { usePlatform } from "./platform";
import { ConnectionPill, ConnectionProblemCard, useLiveConnection } from "./connection/ConnectionProblem";
import { listTime } from "./time";
import { EmptyState } from "./Illustration";
import { useOffline } from "./network";
import type { OpenSheet } from "./sheets";
import { homeFolders, useCollapsedFolders } from "./home-folders";

/** The row stays pressed while its chat builds offscreen, so the hand sees the tap land; cleared when the chat arrives. */
function holdPressed(el: HTMLElement) {
  for (const held of document.querySelectorAll("[data-opening]")) delete (held as HTMLElement).dataset.opening;
  el.dataset.opening = "";
}

export function releasePressed() {
  for (const held of document.querySelectorAll("[data-opening]")) delete (held as HTMLElement).dataset.opening;
}

type Entry =
  | { kind: "bot"; id: string; bot: Bot; at: number; preview: string; unread: boolean }
  | { kind: "group"; id: string; group: Group; members: Bot[]; at: number; preview: string; unread: boolean };
type BotEntry = Extract<Entry, { kind: "bot" }>;

/** Nothing the row shows differs: its memoised row can keep last render's output (a reply streaming into one chat
 * rebuilds the store's lists, and every row with them). */
function sameEntry(a: Entry, b: Entry): boolean {
  if (a.kind !== b.kind || a.id !== b.id || a.at !== b.at || a.preview !== b.preview || a.unread !== b.unread) return false;
  if (a.kind === "bot") return a.bot === (b as BotEntry).bot;
  const other = b as Extract<Entry, { kind: "group" }>;
  return a.group === other.group && a.members.length === other.members.length && a.members.every((member, i) => member === other.members[i]);
}

const BAR_TOP = "var(--m-safe-top)";
const LIST_TOP = "calc(var(--m-safe-top) + 58px)";

function lastAt(owner: Bot | Group): number {
  return lastPreviewable(sidebarPreviewMessages(owner))?.at ?? owner.tasks?.reduce((max, task) => Math.max(max, task.createdAt ?? 0), 0) ?? 0;
}

/** Grok's home: a few round buttons floating over the top, the pinned bots big, then every chat as a plain row. */
export function HomeScreen({ onOpenChat, onOpenSheet }: { onOpenChat: (id: string) => void; onOpenSheet: OpenSheet }) {
  const { state, dispatch } = useStore();
  const platform = usePlatform();
  const offline = useOffline();
  const live = useLiveConnection();
  const you = useGroupYou();
  const phone = useMobileAccount()?.account ?? null;
  // the phone's own account first: its photo, else its drawn head; the desktop's profile otherwise
  const face = phone ?? you?.face ?? null;
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  const [menu, setMenu] = useState<{ entry: Entry; rect: DOMRect; pinnedTile: boolean; source: HTMLElement | null } | null>(null);

  const kept = useRef(new Map<string, Entry>());
  const { pinned, pinnedEntries, entries, alwaysFirstTileId } = useMemo(() => {
    const previous = kept.current;
    const next = new Map<string, Entry>();
    const keep = <T extends Entry>(entry: T): T => {
      const key = `${entry.kind}:${entry.id}`;
      const old = previous.get(key);
      const use = old && sameEntry(old, entry) ? old as T : entry;
      next.set(key, use);
      return use;
    };
    const parts = partitionSidebarBots(state.bots);
    const { primary } = withPrimaryTile(parts, state.bots.find((bot) => bot.defaultBot && !bot.hidden)?.id);
    const top = [...(primary ? [primary] : []), ...parts.pinnedBots.filter((bot) => bot.id !== primary?.id)];
    const topIds = new Set(top.map((bot) => bot.id));
    const visible = state.bots.filter((bot) => !bot.hidden && !topIds.has(bot.id) && (parts.unsectionedBots.includes(bot) || parts.sectionedBots.includes(bot) || parts.sectionChiefs.includes(bot)));
    const rows: Entry[] = [
      ...visible.map((bot): Entry => ({ kind: "bot", id: bot.id, bot, at: lastAt(bot), preview: botPreview(bot, sidebarPreviewMessages(bot), state.instances), unread: botShowsUnread(bot) })),
      ...state.groups.map((group): Entry => {
        const members = state.bots.filter((bot) => group.memberIds.includes(bot.id));
        return { kind: "group", id: group.id, group, members, at: lastAt(group), preview: groupPreview(group, state.bots, state.instances), unread: Boolean(group.unread) };
      }),
    ];
    rows.sort((a, b) => b.at - a.at);
    const tiles = top.map((bot) => keep(botEntry(bot, state.instances)));
    const listed = rows.map(keep);
    kept.current = next;
    return { pinned: top, pinnedEntries: tiles, entries: listed, alwaysFirstTileId: primary?.id ?? null };
  }, [state.bots, state.groups, state.instances]);

  const { folders, loose } = useMemo(() => homeFolders(entries, (entry) => entry.kind === "bot" ? entry.bot.section : entry.group.section), [entries]);
  const folding = useCollapsedFolders();
  useListFlip(listRef, `${pinned.length}|${folders.map((folder) => `${folder.name}:${folding.collapsed(folder.name) ? "-" : folder.entries.map((entry) => entry.id).join(",")}`).join("|")}|${loose.map((entry) => entry.id).join(",")}`);
  // the loader hops away as the chats arrive under it; it never comes back once gone
  const [listIn, setListIn] = useState(state.hydrated === true);
  const [loaderGone, setLoaderGone] = useState(state.hydrated === true);
  const sawLoader = useRef(!state.hydrated);
  const reveal = useCallback((el: HTMLDivElement | null) => {
    if (el && sawLoader.current) { sawLoader.current = false; revealOnce(el); }
  }, []);

  const primary = pinned[0];

  const actionsFor = useCallback((entry: Entry): ContextAction[] => {
    // the desktop app already opens these links (electron/chat-link.mjs), so the phone hands it the same ones
    const desktopLink = entry.kind === "bot" ? threadRefUrl({ botId: entry.id, threadId: entry.bot.threadId }) : `madanibot://thread/${encodeURIComponent(entry.group.threadId)}`;
    const list: ContextAction[] = [];
    if (entry.kind === "bot") {
      const bot = entry.bot;
      if (bot.id !== alwaysFirstTileId) list.push({ key: "pin", label: bot.pinned ? t("sidebar.bot.unpin") : t("sidebar.bot.pin"), icon: bot.pinned ? <PinOff size={18} /> : <Pin size={18} />, onSelect: () => dispatch({ type: "updateBot", botId: bot.id, patch: { pinned: !bot.pinned } }) });
      list.push(botUnreadThreadIds(bot).length > 0
        ? { key: "read", label: t("sidebar.grok.markRead"), icon: <Check size={18} />, onSelect: () => { void markBotRead(bot, api, (updated) => dispatch({ type: "botPatched", bot: updated })).catch(() => {}); } }
        : { key: "unread", label: t("sidebar.grok.markUnread"), icon: <BellDot size={18} />, onSelect: () => dispatch({ type: "markUnread", botId: bot.id }) });
    }
    list.push({ key: "profile", label: t("mobile.home.openProfile"), icon: <UserRound size={18} />, onSelect: () => onOpenSheet({ kind: "profile", id: entry.id }) });
    if (platform.share) {
      list.push({ key: "desktop", label: t("mobile.home.openOnDesktop"), icon: <MonitorSmartphone size={18} />, onSelect: () => { void platform.share?.({ title: entry.kind === "bot" ? entry.bot.name : entry.group.name, url: desktopLink }); } });
    }
    return list;
  }, [dispatch, onOpenSheet, platform, alwaysFirstTileId]);

  const hold = useNativeHold(platform.menu, "chat");
  const latestActions = useRef(actionsFor);
  latestActions.current = actionsFor;
  const native = useMemo(() => hold && ((entry: Entry): NativePress => ({
    press: (el, opened) => hold.press(el, () => heldChatMenu(entry, latestActions.current(entry)), { onOpen: opened }),
    cancel: () => hold.cancel(),
  })), [hold]);

  const openMenu = useCallback((entry: Entry, rect: DOMRect, source: HTMLElement | null, pinnedTile = false) => setMenu({ entry, rect, pinnedTile, source }), []);

  return (
    <div className="relative h-full bg-app">
      <div
        ref={scrollRef}
        className="h-full overflow-y-auto overflow-x-hidden overscroll-y-contain"
        onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 2)}
      >
        <PullToRefresh
          scrollRef={scrollRef}
          onRefresh={() => refreshSnapshot(state, dispatch)}
          top={LIST_TOP}
          indicator={(progress, refreshing) => <RefreshMark bot={primary} progress={progress} refreshing={refreshing} />}
        >
          <div ref={listRef} style={{ paddingTop: LIST_TOP }} className="pb-[calc(var(--m-safe-bottom)+24px)]">
            {state.hydrated && <ConnectionProblemCard notice={live.notice} place={live.place} trying={live.trying} onRetry={live.retry} />}
            {!state.hydrated || !listIn ? (state.loadFailed ? (
              <EmptyState tone="error" art="signpost" className="pt-16" title={t("mobile.home.loadFailedTitle")} body={t(offline ? "mobile.home.loadFailedOffline" : "mobile.home.loadFailedBody")}
                action={{ label: t("mobile.home.retry"), icon: <RotateCcw size={17} aria-hidden />, onClick: retryLoad }} />
            ) : null) : pinned.length + entries.length === 0 ? (
              <EmptyState mascot="blue" className="pt-20" title={t("mobile.home.emptyTitle")} body={t("mobile.home.emptyBody")}
                action={{ label: t("mobile.home.emptyAction"), icon: <Plus size={18} aria-hidden />, onClick: () => onOpenSheet({ kind: "create" }) }} />
            ) : (
              <div ref={reveal}>
                {pinned.length > 0 && (
                  <section aria-labelledby="home-pinned" data-no-swipe>
                  <h2 id="home-pinned" className="px-5 pb-1 text-[15px] text-ink-secondary">{t("sidebar.section.pinned")}</h2>
                  <div className="no-scrollbar flex gap-3 overflow-x-auto px-3 pb-2 pt-1">
                    {pinnedEntries.map((entry) => (
                      <PinnedTile key={entry.id} entry={entry} onOpen={onOpenChat} onMenu={openMenu} native={native} />
                    ))}
                  </div>
                  </section>
                )}
                {entries.length > 0 ? (
                  <>
                  {folders.map((folder) => {
                    const open = !folding.collapsed(folder.name);
                    return (
                      <section key={`folder:${folder.name}`} data-home-folder={folder.name}>
                        <button type="button" aria-expanded={open} onClick={() => folding.toggle(folder.name)}
                          className="flex min-h-11 w-full items-center gap-1.5 px-5 pt-2 text-left text-[15px] text-ink-secondary">
                          <span className="min-w-0 truncate">{folder.name}</span>
                          <ChevronDown aria-hidden size={14} className={cn("shrink-0 transition-transform duration-150 ease-[ease] motion-reduce:transition-none", !open && "-rotate-90")} />
                          {!open && folder.unread > 0 && <span className="ms-auto rounded-full bg-ink px-2 text-[12px] leading-5 text-app">{t("mobile.home.folderUnread", { count: folder.unread })}</span>}
                        </button>
                        {open && (
                          <ul role="list" aria-label={folder.name} className="px-2">
                            {folder.entries.map((entry) => (
                              <li key={entry.id} data-flip-key={entry.id}>
                                <HomeRow entry={entry} onOpen={onOpenChat} onMenu={openMenu} native={native} />
                              </li>
                            ))}
                          </ul>
                        )}
                      </section>
                    );
                  })}
                  {loose.length > 0 && (pinned.length > 0 || folders.length > 0) && <h2 className="px-5 pb-1 pt-3 text-[15px] text-ink-secondary">{t("mobile.home.chats")}</h2>}
                  {loose.length > 0 && (
                    <ul role="list" aria-label={t("mobile.home.chats")} className="px-2">
                      {loose.map((entry) => (
                        <li key={entry.id} data-flip-key={entry.id}>
                          <HomeRow entry={entry} onOpen={onOpenChat} onMenu={openMenu} native={native} />
                        </li>
                      ))}
                    </ul>
                  )}
                  </>
                ) : (
                  <div className="mx-4 mt-4 flex flex-col items-start gap-3 rounded-[20px] bg-ink/[0.04] px-5 py-5">
                    <p className="text-[16px] font-semibold text-ink">{t("mobile.home.onlyPinnedTitle")}</p>
                    <p className="text-[15px] leading-[22px] text-ink-secondary">{t("mobile.home.onlyPinnedBody")}</p>
                    <button type="button" onClick={() => onOpenSheet({ kind: "create" })} className="mobile-press mt-1 flex h-11 items-center gap-2 rounded-full bg-ink px-5 text-[15px] font-medium text-app"><Plus size={18} />{t("mobile.home.emptyAction")}</button>
                  </div>
                )}
              </div>
            )}
          </div>
        </PullToRefresh>
      </div>

      {!loaderGone && !state.loadFailed && (
        <div data-home-loader="" className="pointer-events-none absolute inset-0 z-[4] flex items-center justify-center">
          <MascotLoader naps={false} leaving={state.hydrated === true} waking={state.loadWaking === true} onExit={() => setListIn(true)} onGone={() => setLoaderGone(true)} />
        </div>
      )}
      <div aria-hidden className={cn("pointer-events-none absolute inset-x-0 top-0 z-[5] h-[calc(var(--m-safe-top)+72px)] bg-gradient-to-b from-app from-60% to-transparent transition-opacity duration-150", scrolled ? "opacity-100" : "opacity-0")} />
      <header data-home-bar="" className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center gap-2 px-4" style={{ paddingTop: BAR_TOP }}>
        <RoundButton floating label={t("mobile.home.you")} onClick={() => onOpenSheet({ kind: "settings" })} className="pointer-events-auto overflow-visible">
          {face
            ? <UserFace account={face} size={40} className="size-full" />
            : <span className="text-[14px] font-semibold">{you?.initials ?? <UserRound size={19} />}</span>}
        </RoundButton>
        <div className="flex-1" />
        <ConnectionPill notice={live.notice} trying={live.trying} onRetry={live.retry} testId="mobile-connection-status" />
        <RoundButton floating glass data-home-glass="search" label={t("mobile.home.search")} onClick={() => onOpenSheet({ kind: "search" })} className="pointer-events-auto"><Search size={19} strokeWidth={1.9} /></RoundButton>
        <RoundButton floating glass data-home-glass="newBot" label={t("mobile.home.newBot")} onClick={() => onOpenSheet({ kind: "create" })} className="pointer-events-auto"><Plus size={21} strokeWidth={1.9} /></RoundButton>
      </header>

      <ContextMenu
        open={Boolean(menu)}
        anchor={menu?.rect ?? null}
        label={menu ? t("sidebar.bot.actions", { name: menu.entry.kind === "bot" ? menu.entry.bot.name : menu.entry.group.name }) : ""}
        preview={menu ? (menu.pinnedTile && menu.entry.kind === "bot" ? <PinnedTileFace bot={menu.entry.bot} /> : <RowFace entry={menu.entry} />) : null}
        actions={menu ? actionsFor(menu.entry) : []}
        source={menu?.source}
        onClose={() => setMenu(null)}
      />
    </div>
  );
}

const CHAT_SYMBOLS: Record<string, string> = { read: "checkmark.message", unread: "message.badge", profile: "person.crop.circle", desktop: "desktopcomputer" };

/** A chat's actions for the system menu, each running the same action the page's own menu does. */
function heldChatMenu(entry: Entry, actions: ContextAction[]): HeldMenu {
  const pinned = entry.kind === "bot" && entry.bot.pinned;
  return {
    content: { items: actions.map((action) => ({ key: action.key, title: action.label, icon: action.key === "pin" ? (pinned ? "pin.slash" : "pin") : CHAT_SYMBOLS[action.key], danger: action.danger, disabled: action.disabled })) },
    select: (key) => actions.find((action) => action.key === key)?.onSelect(),
  };
}

function botEntry(bot: Bot, instances: ReturnType<typeof useStore>["state"]["instances"]): BotEntry {
  return { kind: "bot", id: bot.id, bot, at: lastAt(bot), preview: botPreview(bot, sidebarPreviewMessages(bot), instances), unread: botShowsUnread(bot) };
}

function RefreshMark({ bot, progress, refreshing }: { bot?: Bot; progress: MotionValue<number>; refreshing: boolean }) {
  const scale = useTransform(progress, [0, 1, 1.6], [0.55, 1, 1.08]);
  const y = useTransform(progress, [0, 1], [-10, 0]);
  return (
    <motion.div style={{ scale, y }} className="pt-1">
      {bot
        ? <BotAvatar bot={bot} size={30} state={refreshing ? "working" : "idle"} animated={refreshing} label={t("mobile.home.refreshing")} />
        : <MausAvatar color="blue" size={30} state={refreshing ? "working" : "idle"} label={t("mobile.home.refreshing")} />}
    </motion.div>
  );
}

const PinnedTile = memo(function PinnedTile({ entry, onOpen, onMenu, native }: { entry: BotEntry; onOpen: (id: string) => void; onMenu: (entry: Entry, rect: DOMRect, source: HTMLElement | null, pinnedTile: boolean) => void; native?: (entry: Entry) => NativePress }) {
  const ref = useRef<HTMLButtonElement>(null);
  const bot = entry.bot;
  useLongPress(ref, (rect) => onMenu(entry, rect, ref.current, true), true, native?.(entry));
  return (
    <button ref={ref} type="button" onClick={(event) => { holdPressed(event.currentTarget); onOpen(bot.id); }} className="mobile-press flex w-[84px] shrink-0 flex-col items-center gap-1.5 rounded-[20px] py-1" aria-label={botShowsUnread(bot) ? t("mobile.home.unreadChat", { name: bot.name }) : bot.name}>
      <PinnedTileFace bot={bot} />
    </button>
  );
});

function PinnedTileFace({ bot }: { bot: Bot }) {
  const unread = botShowsUnread(bot);
  return (
    <span className="flex w-[84px] flex-col items-center gap-1.5 py-1">
      <span className="relative">
        <BotAvatar bot={bot} size={76} state={bot.busy ? "working" : "idle"} animated={bot.busy} label="" />
        {bot.chiefOfStaff && (
          <span aria-hidden className="absolute -bottom-0.5 -right-0.5 flex size-6 items-center justify-center rounded-full bg-[var(--identity-orange)] text-white ring-[3px] ring-app">
            <Star size={12} fill="currentColor" strokeWidth={0} />
          </span>
        )}
        {unread && <span aria-hidden className="absolute right-0.5 top-0.5 size-3 rounded-full bg-ink ring-[3px] ring-app" />}
      </span>
      <span className={cn("line-clamp-2 w-full break-words text-center text-[13px] leading-4", unread ? "font-semibold text-ink" : "font-medium text-ink-secondary")}>{bot.name}</span>
    </span>
  );
}

/** An unread chat's row says so to a screen reader, and still reads its time and newest line as a read row does. */
export function unreadRowLabel(name: string, entry: Pick<Entry, "unread" | "at" | "preview">): string | undefined {
  if (!entry.unread) return undefined;
  return [t("mobile.home.unreadChat", { name }), entry.at > 0 ? listTime(entry.at) : "", entry.preview.trim()].filter(Boolean).join(", ");
}

const HomeRow = memo(function HomeRow({ entry, onOpen, onMenu, native }: { entry: Entry; onOpen: (id: string) => void; onMenu: (entry: Entry, rect: DOMRect, source: HTMLElement | null) => void; native?: (entry: Entry) => NativePress }) {
  const ref = useRef<HTMLButtonElement>(null);
  useLongPress(ref, (rect) => onMenu(entry, rect, ref.current), true, native?.(entry));
  const name = entry.kind === "bot" ? entry.bot.name : entry.group.name;
  return (
    <button
      ref={ref}
      type="button"
      onClick={(event) => { holdPressed(event.currentTarget); onOpen(entry.id); }}
      aria-label={unreadRowLabel(name, entry)}
      className="mobile-row block w-full rounded-[18px] text-left"
    >
      <RowFace entry={entry} />
    </button>
  );
});

function RowFace({ entry }: { entry: Entry }) {
  const name = entry.kind === "bot" ? entry.bot.name : entry.group.name;
  const working = entry.kind === "bot" ? Boolean(entry.bot.busy) : Boolean(entry.group.working);
  const avatar: ReactNode = entry.kind === "bot"
    ? <BotAvatar bot={entry.bot} size={48} state={working ? "working" : stateForBot(entry.bot) === "failed" ? "failed" : "idle"} animated={working} label="" />
    : <GroupAvatar members={entry.members} size={48} />;
  return (
    <span className="flex min-h-[80px] items-center gap-3.5 px-3 py-3">
      <span className="shrink-0">{avatar}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={cn("min-w-0 flex-1 truncate text-[17px] leading-[22px] text-ink", entry.unread ? "font-semibold" : "font-normal")}>{name}</span>
          {entry.at > 0 && <span className={cn("shrink-0 text-[13px] tabular-nums leading-[22px]", entry.unread ? "font-semibold text-ink" : "text-ink-tertiary")}>{listTime(entry.at)}</span>}
          {entry.unread && <span aria-hidden className="size-2.5 shrink-0 self-center rounded-full bg-ink" />}
        </span>
        <span className="mt-0.5 flex items-center gap-2">
          <span className={cn("min-w-0 flex-1 truncate text-[15px] leading-5", entry.unread ? "text-ink" : "text-ink-secondary")}>
            {entry.kind === "bot" && working && !entry.bot.waitingForTeammates && entry.bot.activity !== "waiting-on-you"
              ? <SidebarWorkingWord bot={entry.bot} last={lastPreviewable(sidebarPreviewMessages(entry.bot))} />
              : entry.preview || " "}
          </span>
        </span>
      </span>
    </span>
  );
}
