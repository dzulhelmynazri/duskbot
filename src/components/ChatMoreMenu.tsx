import { useMemo, useState, type JSX } from "react";
import { Copy, Cpu, Download, Gauge, Monitor, MoreHorizontal, Search, Share, UserRound } from "../icons";
import { currentTaskBot, useStore, visibleMessages, type Bot } from "@/state/store";
import { requestChatFind, useChatFindOpen } from "@/lib/chat-find";
import { usageSummary } from "@/lib/chat-usage-summary";
import {
  copyTranscriptToClipboard,
  downloadMarkdownTranscript,
  formatTranscriptMarkdown,
  slugifyTranscriptFilename,
} from "@/lib/export-transcript";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { answeringModelName } from "@/lib/simple-model-menu";
import { answeringModel } from "@/lib/thread-backup";
import { ELEVATED_CONTROL, ELEVATED_HOVER, ELEVATED_OPEN } from "./elevated";
import { ShortcutHint } from "./ShortcutHint";
import { SidebarPopoverMenu, type SidebarMenuItem } from "./SidebarPopoverMenu";
import { openBotSettings } from "./bot-panel/panel-link";
import { ShareBotButton, useTeamName } from "./bot-access/ShareBotButton";
import { UsageBars } from "./EngineUsage";

/** One item list for the chat's ⋯ menu wherever it sits. The Simple bot panel draws the same items as rows, and its
 * Share button holds the two that export. */
export function useChatMoreItems(profile: Bot, phoneHeader = false): { items: SidebarMenuItem[]; on: boolean } {
  const bot = useMemo(() => currentTaskBot(profile), [profile]);
  const messages = useMemo(() => visibleMessages(bot), [bot]);
  const { state, dispatch } = useStore();
  const findOpen = useChatFindOpen(bot.threadId);
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed" | null>(null);
  const remoteClient = window.madaniDesktop?.remoteClient?.active === true;
  const usage = usageSummary(bot, state.instances);
  const hasMessages = messages.length > 0;
  const transcript = () => formatTranscriptMarkdown({ title: bot.name, messages, botName: bot.name, isGroup: false });
  const selection = profile.modelSelection;
  const modelName = phoneHeader && selection ? answeringModelName(state.instances, answeringModel(profile, bot.threadId, selection)) : "";
  // On a phone the header drops the profile pill's click target, the model chip and the Bot's screen button; they live here.
  const phoneItems: SidebarMenuItem[] = phoneHeader ? [
    {
      key: "profile",
      label: t("chat.openProfile"),
      icon: <UserRound size={16} />,
      onSelect: () => dispatch({ type: "toggleSettings", open: true }),
    },
  ] : [];
  const phoneScreen: SidebarMenuItem[] = phoneHeader ? [
    ...(remoteClient ? [] : [{
      key: "model",
      label: t("chat.model"),
      icon: <Cpu size={16} />,
      value: modelName,
      trailing: <UsageBars engine={selection?.instanceId} hover={false} />,
      onSelect: () => openBotSettings(dispatch, "model"),
    } satisfies SidebarMenuItem]),
    {
      key: "computer",
      label: t("chat.computer"),
      icon: <Monitor size={16} />,
      active: state.settingsOpen && state.botSettingsSection === "computer",
      onSelect: () => dispatch({ type: "toggleComputer", open: true }),
    },
  ] : [];
  const items: SidebarMenuItem[] = [
    ...phoneItems,
    {
      key: "find",
      label: t("chat.find"),
      icon: <Search size={16} />,
      active: findOpen,
      trailing: <ShortcutHint id="find-conversation" />,
      onSelect: () => requestChatFind(bot.threadId),
    },
    ...phoneScreen,
    {
      key: "copy",
      heading: t("chat.export.heading"),
      separatorBefore: true,
      label: t("chat.export.copy"),
      icon: <Copy size={16} />,
      disabled: !hasMessages,
      keepOpen: true,
      trailing: copyStatus && <span role="status" className="text-[11px] text-ink-secondary">{t(copyStatus === "copied" ? "chat.export.copied" : "chat.export.copyFailed")}</span>,
      onSelect: () => { void copyTranscriptToClipboard(transcript()).then((ok) => setCopyStatus(ok ? "copied" : "failed")); },
    },
    {
      key: "download",
      label: t("chat.export.download"),
      icon: <Download size={16} />,
      disabled: !hasMessages,
      onSelect: () => downloadMarkdownTranscript(slugifyTranscriptFilename(bot.name), transcript()),
    },
    ...(usage ? [{
      key: "usage",
      label: t("chat.usage.menu"),
      icon: <Gauge size={16} />,
      separatorBefore: true,
      trailing: <span title={usage.detail} data-testid="usage-chip" className={cn("tabular-nums text-[12px]", usage.tone === "danger" ? "text-danger" : usage.tone === "warning" ? "text-warning" : "text-ink-secondary")}>{usage.short}</span>,
      onSelect: () => dispatch({ type: "toggleAppSettings", open: true, section: "usage" }),
    } satisfies SidebarMenuItem] : []),
  ];
  return { items, on: findOpen };
}

function RoundChatMoreMenu({ bot, phoneHeader }: { bot: Bot; phoneHeader: boolean }) {
  const { items, on } = useChatMoreItems(bot, phoneHeader);
  return (
    <SidebarPopoverMenu
      items={items}
      ariaLabel={t("chat.more")}
      triggerClassName="rounded-full"
      triggerTitle={t("chat.more")}
      renderTrigger={({ open }) => (
        <span
          data-testid="chat-more"
          className={cn(
            "flex size-8 items-center justify-center rounded-full",
            ELEVATED_CONTROL, ELEVATED_HOVER, open && ELEVATED_OPEN,
            "max-md:size-10 max-md:border max-md:border-transparent max-md:bg-card",
            open || on ? "text-accent" : "text-ink",
          )}
        >
          <MoreHorizontal size={16} />
        </span>
      )}
    />
  );
}

/**
 * The chat's ⋯ menu as a round button, for a spot outside the chat such as the bot panel's top bar: find in
 * conversation (opens the chat's find bar), threads the sidebar hides, share, usage and activity.
 */
export function ChatMoreMenu({ bot, phoneHeader = false }: { bot: Bot; phoneHeader?: boolean }): JSX.Element {
  // Keyed by thread so a "Copied" note never follows the panel into another conversation.
  return <RoundChatMoreMenu key={bot.threadId} bot={bot} phoneHeader={phoneHeader} />;
}

export const EXPORT_ITEMS = ["copy", "download"];

/** The bot panel's round Share button: on a team who has access, with copying or downloading this conversation under
 * the ⋯ of its header; anywhere else a menu of those two. */
export function ChatShareMenu({ bot, className }: { bot: Bot; className: string }): JSX.Element {
  return useTeamName() ? <ShareBotButton bot={bot} className={className} headerMenu={<ExportMore key={bot.threadId} bot={bot} />} />
    : <ShareMenu key={bot.threadId} bot={bot} className={className} />;
}

const exportItems = (items: SidebarMenuItem[]): SidebarMenuItem[] => items.filter((item) => EXPORT_ITEMS.includes(item.key)).map((item) => ({
  ...item, heading: undefined, separatorBefore: false, label: t(item.key === "copy" ? "chat.export.copyConversation" : "chat.export.downloadConversation"),
}));

function ExportMore({ bot }: { bot: Bot }) {
  const { items } = useChatMoreItems(bot);
  return (
    <SidebarPopoverMenu items={exportItems(items)} ariaLabel={t("chat.more")} align="end" triggerTitle={t("chat.more")}
      triggerClassName="flex shrink-0 rounded-md p-1.5 text-ink-secondary hover:bg-ink/[0.06] hover:text-ink aria-expanded:bg-ink/[0.06]"
      renderTrigger={() => <MoreHorizontal size={16} aria-hidden="true" />} />
  );
}

function ShareMenu({ bot, className }: { bot: Bot; className: string }) {
  const { items } = useChatMoreItems(bot);
  return (
    <SidebarPopoverMenu
      items={exportItems(items)}
      ariaLabel={t("chat.export.heading")}
      triggerClassName="rounded-full"
      triggerTitle={t("chat.export.heading")}
      renderTrigger={({ open }) => (
        <span data-panel-share className={cn(className, open && ELEVATED_OPEN)}>
          <Share size={16} aria-hidden="true" />
        </span>
      )}
    />
  );
}

/** The same menu as the remote client chat header's plain ⋯, opening on hover below the header. */
export function ChatHeaderMenu({ bot }: { bot: Bot }): JSX.Element {
  const { items, on } = useChatMoreItems(bot);
  return (
    <SidebarPopoverMenu
      items={items}
      ariaLabel={t("chat.more")}
      openOnHover
      placement="below"
      renderTrigger={({ open }) => (
        <span
          data-testid="chat-more"
          className={cn(
            "flex size-8 items-center justify-center rounded-full transition-colors hover:bg-ink/[0.06]",
            open || on ? "text-accent" : "text-ink-secondary hover:text-ink",
          )}
          title={t("chat.more")}
        >
          <MoreHorizontal size={18} />
        </span>
      )}
    />
  );
}
