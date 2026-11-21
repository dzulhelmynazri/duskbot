import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { api, openBot, useStore, visibleMessages, type Action, type AppSettingsSection, type Bot, type Group } from "@/state/store";
import { cn } from "@/lib/cn";
import type { SearchHit } from "@/lib/search-hit";
import { landOnSearchHit } from "@/lib/focus-message";
import { imeComposing } from "@/lib/send-key";
import { botUnreadCount } from "@/lib/bot-unread";
import { shortcutBots, shownBotIds } from "@/lib/sidebar-shortcut-order";
import { applySkinChoice, THEME_SKINS } from "@/lib/skins";
import { openNewGroup } from "@/lib/new-group-request";
import { t } from "@/lib/i18n";
import { withoutCitationTraces } from "@/lib/citations";
import { BotAvatar } from "./Avatar";
import { GroupAvatar, useGroupYou } from "./GroupAvatar";
import { openCreateBot } from "./CreateBotDialog";
import { Icon, type IconName } from "./Icon";
import { botPreview, groupPreview } from "./sidebar-preview";
import { openBotSettingsPage } from "./bot-panel/panel-link";
import { switchPlaceCommand } from "./SidebarPlaceButton";
import { friendlyError } from "@/lib/plain-error";
import { desktopMotion } from "@/lib/desktop-motion";
import { usePaletteExits } from "./palette-exits";
import { pacedMs } from "@/lib/motion-speed";

/** A row's 49px and the 2px gap under it. */
const ROW_STEP = 51;

/** What a row does once picked: what it opens, or what it changes. */
type Command = { id: string; name: string; detail?: string; also?: string; icon: IconName; run: () => void };

type PaletteEntry =
  | { kind: "bot"; bot: Bot }
  | { kind: "archived"; bot: Bot }
  | { kind: "room"; group: Group }
  | { kind: "message"; hit: SearchHit }
  | { kind: "command"; command: Command };

const OPEN_EVENT = "madani:open-command-palette";

const IDLE_COMMANDS = new Set(["new-bot", "new-group", "shortcuts", "settings-general", "settings-texting", "settings-computer", "settings-permissions"]);

export function openCommandPalette() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

/** Grok Bot's search ranking, roughly: a name that starts with the query, then one with a word that does, then the query
 * anywhere in it, then its letters in order. Nothing that lacks them shows. */
function matchRank(name: string, query: string): number {
  if (!query) return 0;
  const text = name.toLowerCase();
  if (text.startsWith(query)) return 0;
  if (text.split(/[\s:._-]+/).some((word) => word.startsWith(query))) return 1;
  if (text.includes(query)) return 2;
  let at = 0;
  for (const letter of text) if (letter === query[at]) at++;
  return at === query.length ? 3 : -1;
}

function ranked<T>(items: readonly T[], name: (item: T) => string, query: string): T[] {
  return items
    .map((item, index) => ({ item, index, rank: matchRank(name(item), query) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.item);
}

/** The query's letters where they run together in the name, in the weight Grok Bot marks them with. */
function Marked({ text, query }: { text: string; query: string }) {
  const at = query ? text.toLowerCase().indexOf(query) : -1;
  if (at < 0) return <>{text}</>;
  return <>{text.slice(0, at)}<span className="font-semibold">{text.slice(at, at + query.length)}</span>{text.slice(at + query.length)}</>;
}

export function CommandPalette({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
  const { state, dispatch } = useStore();
  const you = useGroupYou();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [messageHits, setMessageHits] = useState<SearchHit[]>([]);
  const [searchFailed, setSearchFailed] = useState(false);
  const [searchAttempt, setSearchAttempt] = useState(0);
  const [cursor, setCursor] = useState(0);
  const selectedRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const listId = useId();
  const exits = usePaletteExits(open);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery("");
    setMessageHits([]);
    setCursor(0);
    return () => { if (openerRef.current?.isConnected) openerRef.current.focus(); };
  }, [open]);

  useEffect(() => {
    onOpenChange?.(open);
  }, [onOpenChange, open]);

  // Tab keeps to the search field, as Grok Bot's does: the page behind is out of reach while it is up.
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    const onTab = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onTab, true);
    return () => window.removeEventListener("keydown", onTab, true);
  }, [open]);

  const q = query.trim().toLowerCase();

  useEffect(() => {
    if (!open || !q) {
      setMessageHits([]);
      return;
    }
    setMessageHits([]);
    setSearchFailed(false);
    let alive = true;
    const timer = setTimeout(() => {
      api(`/api/search?q=${encodeURIComponent(q)}&limit=12`)
        .then((result: { hits?: SearchHit[] }) => alive && setMessageHits(result.hits ?? []))
        .catch(() => { if (alive) { setMessageHits([]); setSearchFailed(true); } });
    }, 150);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [open, q, searchAttempt]);

  useEffect(() => setCursor(0), [q]);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [cursor, messageHits]);

  if (!open) return null;
  const { glideMs, rowsMs } = desktopMotion().palette;

  const settings = (section: AppSettingsSection): Action => ({ type: "toggleAppSettings", open: true, section });
  // Settings stays its own lazy chunk: its pane map is read once the command is picked.
  const settingsPane = (pane: "models" | "usage" | "advanced") => () =>
    void import("./SettingsModal").then(({ openSettings }) => dispatch(openSettings(pane))).catch(() => dispatch(settings("general")));
  const currentBot = state.bots.find((entry) => entry.id === state.selectedId);
  const switchPlace = switchPlaceCommand();
  const commands: Command[] = [
    { id: "new-bot", name: "New bot", icon: "plus", run: () => openCreateBot() },
    { id: "new-group", name: t("sidebar.newChannel.title"), icon: "people", run: () => openNewGroup() },
    ...(switchPlace ? [{ id: "switch-place", name: "Switch place", detail: "This computer, clouds, servers", also: "workspace server cloud", icon: "chevrons-up-down" as const, run: switchPlace }] : []),
    { id: "shortcuts", name: "Keyboard shortcuts", detail: "Help", icon: "keyboard", run: () => dispatch({ type: "toggleShortcuts", open: true }) },
    { id: "settings-general", name: "Settings: General", detail: "Settings", icon: "settings-gear", run: () => dispatch(settings("general")) },
    { id: "settings-texting", name: "Settings: Texting", detail: "Settings", icon: "chat-bubbles", run: () => dispatch(settings("texting")) },
    { id: "settings-computer", name: "Settings: Computer", detail: "Settings", icon: "display", run: () => dispatch(settings("computer")) },
    { id: "settings-updates", name: "Settings: Updates", detail: "Settings", icon: "refresh", run: () => dispatch(settings("updates")) },
    { id: "settings-permissions", name: "Settings: Permissions", detail: "Settings", icon: "lock", run: () => dispatch(settings("permissions")) },
    { id: "settings-models", name: "Settings: Models", detail: "Settings", icon: "sparkle", run: settingsPane("models") },
    { id: "settings-usage", name: "Settings: Usage & billing", detail: "Settings", icon: "chart-bars", run: settingsPane("usage") },
    { id: "settings-advanced", name: "Settings: Advanced features", detail: "Settings", icon: "sliders", run: settingsPane("advanced") },
    ...(currentBot ? [{ id: "bot-settings", name: "Bot settings", detail: currentBot.name, icon: "settings-gear" as const, run: () => openBotSettingsPage(dispatch, currentBot.id) }] : []),
    { id: "connect-apps", name: "Connect apps", detail: "Search across apps and skills", icon: "storefront", run: () => dispatch(settings("apps")) },
    { id: "theme-system", name: "Theme: System", detail: "Settings · Appearance", icon: "display", run: () => applySkinChoice("system") },
    { id: "theme-dark", name: "Theme: Dark", detail: "Settings · Appearance", icon: "moon", run: () => applySkinChoice(THEME_SKINS.dark) },
    { id: "theme-light", name: "Theme: Light", detail: "Settings · Appearance", icon: "sun", run: () => applySkinChoice(THEME_SKINS.light) },
  ];
  // With nothing typed: the bots, those with news first, then grok's short list; the rest wait for a query.
  const shownCommands = q ? ranked(commands, (command) => (command.also ? `${command.name} ${command.also}` : command.name), q) : commands.filter((command) => IDLE_COMMANDS.has(command.id));
  // The sidebar's order, as ⌘1 to ⌘9 count it, so each row names the shortcut that opens it from anywhere.
  const liveBots = shortcutBots(state.bots.filter((b) => !b.hidden), shownBotIds(document.querySelector("[data-sidebar-root]")));
  const slot = new Map(liveBots.slice(0, 9).map((bot, index) => [bot.id, index + 1]));
  const bots = q ? ranked(liveBots, (bot) => bot.name, q) : liveBots;
  const rooms = ranked(state.groups, (group) => group.name, q);
  const archived = q ? ranked(state.bots.filter((b) => b.hidden), (bot) => bot.name, q) : [];
  const entries: PaletteEntry[] = [
    ...bots.map((bot): PaletteEntry => ({ kind: "bot", bot })),
    ...archived.map((bot): PaletteEntry => ({ kind: "archived", bot })),
    ...rooms.map((group): PaletteEntry => ({ kind: "room", group })),
    ...(q ? messageHits.map((hit): PaletteEntry => ({ kind: "message", hit })) : []),
    ...shownCommands.map((command): PaletteEntry => ({ kind: "command", command })),
  ];
  const selected = entries.length ? Math.min(cursor, entries.length - 1) : 0;
  const optionId = (index: number) => `${listId}-row-${index}`;

  const activate = async (entry: PaletteEntry) => {
    setOpen(false);
    if (entry.kind === "message") {
      try {
        await landOnSearchHit(entry.hit, state, dispatch);
      } catch (error) {
        dispatch({ type: "error", message: friendlyError(error) });
      }
    } else if (entry.kind === "bot") {
      openBot(dispatch, entry.bot);
    } else if (entry.kind === "archived") {
      try {
        const response = await api(`/api/bots/${entry.bot.id}`, { method: "PATCH", body: JSON.stringify({ hidden: false }) });
        dispatch({ type: "botPatched", bot: response.bot });
        openBot(dispatch, response.bot);
      } catch (error) {
        dispatch({ type: "error", message: friendlyError(error) });
      }
    } else if (entry.kind === "room") {
      dispatch({ type: "select", id: entry.group.id });
    } else {
      entry.command.run();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (imeComposing(e.nativeEvent)) { e.stopPropagation(); return; }
    // ⌘1 to ⌘9 open that bot from here too (the app's own shortcut); search steps aside for it.
    if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) { setOpen(false); return; }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor(entries.length ? (selected + 1) % entries.length : 0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor(entries.length ? (selected - 1 + entries.length) % entries.length : 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const entry = entries[selected];
      if (entry) void activate(entry);
    }
  };

  const row = (key: string, index: number, entry: PaletteEntry, leading: ReactNode, name: ReactNode, detail: ReactNode, kind: string, trailing?: ReactNode) => (
    <button
      key={key}
      id={optionId(index)}
      type="button"
      role="option"
      tabIndex={-1}
      aria-selected={index === selected}
      ref={index === selected ? selectedRef : undefined}
      onClick={() => void activate(entry)}
      // mousemove, not mouseenter: rows shifting under a resting pointer must not steal the keyboard selection.
      onMouseMove={() => setCursor(index)}
      className={cn(
        "m-0 flex h-[49px] w-full shrink-0 cursor-pointer appearance-none items-center gap-2.5 rounded-[10px] border-0 py-1.5 pl-2 pr-2.5 text-left text-[13px] leading-[18px] tracking-[0.195px] text-ink outline-none",
        index === selected && !glideMs ? "bg-ink/8" : "bg-transparent",
      )}
      data-palette-row={key}
    >
      <span className="flex size-6 shrink-0 items-center justify-center">{leading}</span>
      <span className="flex min-w-0 flex-1 flex-col justify-center gap-px tracking-[-0.08px]">
        <span className="flex min-w-0 items-center gap-1.5"><span className="truncate">{name}</span></span>
        {detail ? <span className="truncate text-ink-secondary">{detail}</span> : null}
      </span>
      {trailing}
      <span className="sr-only">{kind}</span>
    </button>
  );
  const tile = (icon: IconName) => (
    <span className="flex size-6 items-center justify-center overflow-hidden rounded-[8px] bg-ink/6 text-ink-secondary"><Icon name={icon} size={12} /></span>
  );

  return (
    <div ref={exits.wrap} className="fixed inset-0 z-50" onKeyDown={onKeyDown}>
      <div aria-hidden className="palette-scrim absolute inset-0 bg-black/50" onMouseDown={() => setOpen(false)} />
      {/* opened often, so it opens and closes raw, as grok's does */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div
        data-raw-dialog=""
        // its list scrolls inside it; the masked list's paint reach is not cut-off content
        data-gallery-allow-clip=""
        role="dialog"
        aria-modal="true"
        aria-label={t("sidebar.search")}
        data-command-palette
        className="pointer-events-auto relative flex h-[455px] max-h-[calc(100vh-32px)] w-[min(560px,calc(100vw-32px))] flex-col overflow-hidden rounded-[18px] border border-transparent bg-menu text-[13px] text-ink"
      >
        <div className="flex shrink-0 items-center gap-2.5 border-b-[0.5px] border-transparent py-3.5 pl-4 pr-2.5">
          <span className="flex h-5 w-6 shrink-0 items-center justify-center text-ink/52"><Icon name="search" size={16} /></span>
          <input
            ref={inputRef}
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls={listId}
            aria-activedescendant={entries.length ? optionId(selected) : undefined}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t("sidebar.search")}
            placeholder="Search"
            className="min-w-0 flex-1 appearance-none border-0 bg-transparent p-0 text-[14px] leading-[22px] tracking-[-0.15px] text-ink outline-none placeholder:text-ink/56"
          />
        </div>
        {entries.length === 0 ? (
          <div role="status" className="flex min-h-0 flex-1 items-center justify-center gap-2 px-4 text-center">
            <span className="text-[13px] leading-[18px] tracking-[-0.08px] text-ink-secondary">{searchFailed ? t("search.unavailable") : "No results"}</span>
            {searchFailed && <button type="button" className="ui-button" onClick={() => setSearchAttempt((n) => n + 1)}>{t("common.tryAgain")}</button>}
          </div>
        ) : (
          <div
            id={listId}
            role="listbox"
            aria-label="Results"
            className="min-h-0 flex-1 overflow-y-auto [mask-image:linear-gradient(transparent_0px,black_0px,black_calc(100%-24px),transparent_100%)]"
          >
            <div ref={exits.list} className={cn("flex flex-col gap-0.5 p-2", (glideMs > 0 || rowsMs > 0) && "relative isolate")}>
              {entries.map((entry, index) => {
                if (entry.kind === "bot") {
                  const { bot } = entry;
                  const unread = botUnreadCount(bot) > 0;
                  const key = slot.get(bot.id);
                  return row(`bot:${bot.id}`, index, entry, <BotAvatar bot={bot} size={24} animated={false} trackPointer={false} />,
                    <Marked text={bot.name} query={q} />, botPreview(bot, visibleMessages(bot), state.instances), "Bot",
                    <>
                      {unread && <span role="img" aria-label={t("sidebar.grok.unreadActivity")} className="flex size-2 shrink-0 items-center"><span className="size-2 rounded-full bg-accent-text" /></span>}
                      {/* grok's rows carry no keycap; the shortcut stays, read out only */}
                      {key && <span className="sr-only">Command {key}</span>}
                    </>);
                }
                if (entry.kind === "archived") {
                  const { bot } = entry;
                  return row(`archived:${bot.id}`, index, entry, <BotAvatar bot={bot} size={24} animated={false} trackPointer={false} />,
                    <Marked text={bot.name} query={q} />, t("search.archivedBot"), t("sidebar.archived.restore"),
                    <span className="shrink-0 rounded-full bg-ink/6 px-2 py-0.5 text-[12px] text-ink-secondary">{t("sidebar.archived.restore")}</span>);
                }
                if (entry.kind === "room") {
                  const { group } = entry;
                  const members = group.memberIds.map((id) => state.bots.find((bot) => bot.id === id)).filter((bot): bot is Bot => Boolean(bot));
                  return row(`room:${group.id}`, index, entry, <GroupAvatar members={members} you={you} size={24} />, <Marked text={group.name} query={q} />,
                    group.description || groupPreview(group, state.bots, state.instances), "Group chat",
                    group.unread ? <span role="img" aria-label={t("sidebar.grok.unreadActivity")} className="flex size-2 shrink-0 items-center"><span className="size-2 rounded-full bg-accent-text" /></span> : undefined);
                }
                if (entry.kind === "message") {
                  const { hit } = entry;
                  const before = withoutCitationTraces(hit.snippet.slice(0, hit.matchStart));
                  const match = hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength);
                  const after = withoutCitationTraces(hit.snippet.slice(hit.matchStart + hit.matchLength));
                  return row(`msg:${hit.threadId}:${hit.messageId}`, index, entry, tile("chat-bubbles"),
                    hit.name, <>{before}<span className="font-semibold text-ink">{match}</span>{after}</>, "Message");
                }
                const { command } = entry;
                return row(`cmd:${command.id}`, index, entry, tile(command.icon), command.name, command.detail, "Action");
              })}
              {glideMs > 0 && <span aria-hidden data-palette-glide="" className="pointer-events-none absolute inset-x-2 top-2 -z-10 h-[49px] rounded-[10px] bg-ink/8"
                style={{ transform: `translateY(${selected * ROW_STEP}px)`, transition: `transform ${pacedMs(glideMs)}ms var(--motion-ease-out, ease-out)` }} />}
            </div>
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
