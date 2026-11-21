import { createContext, memo, startTransition, use, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type RefObject } from "react";
import { usePhoneLayout } from "@/lib/use-media-query";
import { phoneApp } from "@/lib/store-app";
import { ThreadLinkContext } from "@/components/ThreadLinkMenu";
import { ChevronRight, Copy, Monitor, RefreshCw, Square, Webhook } from "../icons";
import { WorkingDots } from "@/components/WorkingIndicator";
import { ACTION_ICON, ChatBusyContext, MESSAGE_ROW, MessageActions, messageActionClass, ReplyAction, type MessageMenuItem } from "@/components/MessageActions";
import { copyMessage } from "@/lib/message-copy";
import { ReactAction, ReactionChips } from "@/components/Reactions";
import { useBotMessageMenu, userMessageMenu } from "@/components/message-menu";
import { useSpeech } from "@/lib/tts/useSpeech";
import { localSystemVoiceActive } from "@/lib/local-voice";
import { computerStartLine, useScreensWhile } from "@/lib/computer-start";
import { useCaptionChrome, useDesktopCapabilities } from "@/components/DesktopCapabilities";
import {
  currentTaskBot,
  shownTranscript,
  useStore,
  formatTime,
  openRoomThread,
  openThread,
  visibleMessages,
  type Action,
  type Bot,
  type ConfigStatus,
  type InstanceInfo,
  type Message,
  type AppState,
  awayFromMainThread,
  openBot,
} from "@/state/store";
import { EngineSetup } from "./EngineSetup";
import { CHATGPT_USAGE_URL, ManageUsageLink } from "./ChatGptPlanStatus";
import { CODEX_USAGE_URL, codexUsageLimitReached } from "../../shared/codex-usage-limit";
import { ClaudeUpdatePrompt } from "./ClaudeUpdatePrompt";
import { MacCuaRecoveryActions } from "./MacCuaRecoveryActions";
import { ScreenAccessNotice } from "./ScreenAccessNotice";
import { ComposerNoticeSlot } from "./ComposerNoticeSlot";
import { macCuaPermissionMessage, missingMacCuaPermissions } from "@/lib/mac-cua-permissions";
import { claudeUpdateTarget, failedTurnCause, signedOutEngine } from "@/lib/failed-turn";
import { plainErrorLine } from "@/lib/plain-error";
import { lowerFirst } from "@/lib/lower-first";
import { openPlaceAction, placeRowViewFor, usePlaceSeat, worksOnSimpleLabel } from "@/lib/place-view";
import type { PlaceRow } from "../../shared/place-view";
import { PartlyDoneRow } from "./PartlyDoneRow";
import { botTextForDisplay, isPureLeakedBotText } from "../../shared/system-message-guard.ts";
import { ConversationalReply, QuickModelNote, isConversational, useReplySegments, useThreadOpenedAt } from "./ConversationalReply";
import { isProviderSafetyBlock, PROVIDER_SAFETY_GUIDANCE, PROVIDER_SAFETY_HELP_URL } from "../../shared/provider-safety";
import { isCancelledTranscriptRow, isStoppedTurnName, PERSON_STOPPED_TURN_NAME } from "../../shared/client-cancel";
import { isThisComputerNotGranted, isThisComputerNotReady } from "../../shared/your-computer";
import { BotAvatar } from "./Avatar";
import type { MarkState } from "./mascot-engine";
import { poolWords } from "@/lib/friendly-activity";
import type { LiveStatus } from "@/state/turn-status";
import { STATUS_EXIT_MS, TurnPresence, TYPING_PHASE } from "./TurnPresence";
import { TranscriptCardSlot } from "./TranscriptCardSlot";
import { workingMood } from "@/lib/working-mood";
import { WorkingMascot } from "./WorkingMascot";
import { BrowserPartLine } from "./BrowserPartLine";
import { browserPartFor } from "@/lib/browser-part";
import { liveCallEnabled, voiceCallsEnabled, showToolCallsEnabled } from "@/lib/feature-flags";
import { normalizeState } from "@/lib/mascot";
import { peerLine, peerRequest, type PeerLine } from "@/lib/peer-message";
import { replyHidesLine, showWorkingDots } from "@/lib/turn-tail";
import { useLandedReply } from "@/hooks/use-landed-reply";
import { useNotesWork } from "@/lib/notes-arrival";
import { useTypingHold } from "@/hooks/use-typing-hold";
import { OWN_ENTRANCE } from "@/hooks/use-arrival-flow";
import { useChatSwitchMotion } from "@/hooks/use-chat-switch-motion";
import { usePrefersReducedMotion } from "@/components/mascot-clock";
import { enterFromComposer, growFromMascot, hasSendLaunch } from "./bubble-entrance";
import { STATUS_MOUNT_MS, useReached } from "@/hooks/use-reached";
import { lifeDraw } from "@/lib/reply-life";
import { lastNonReceipt } from "@/lib/receipts";
import { routineStartName } from "./RoutineStartLine"; import { useTurnLive } from "@/state/turn-status"; import { useLiveReplyActive } from "@/state/live-reply"; import { useTurnNow } from "./NowCard"; import { useThreadRoutineRun } from "@/state/older-routine-runs";
import { followSentTurn, sentTurn, useSentTurn } from "@/state/sent-turn";
import { waitsForNetwork } from "@/state/network-wait";
import { useOffline } from "@/mobile/network";
import { forgetLateRow, isLateRow, isSettledRow, noteLateRow, noteSettledRow, useStopPress, type StopPress } from "@/lib/stop-turn";
import { shownReplyText } from "@/state/live-reply";
import { ChatMarkdown } from "./ChatMarkdown";
import { TranscriptStaging } from "./transcript-staging";
import { LiveToolsContext, useLiveToolIds } from "@/hooks/use-live-tool-ids";
import { VoiceNoteBubble, type VoiceNoteAttachment } from "./VoiceNoteBubble";
import { ThreadChip } from "./ThreadChip";
import { HandoffChip } from "./HandoffReply"; import { TeammateChip } from "./TeammateChip"; import { useTeammates } from "@/state/team-people"; import type { MentionPeer } from "@/lib/mentions";
import { NewConversationInstead } from "./NewConversationInstead";
import { useColorUserBubbles } from "@/lib/user-bubble-preference";
import { grokAccentText, userBubbleStyle } from "@/lib/user-bubble-tone";
import { ToolActivity } from "./ToolActivity";
import { DataResultChip } from "./DataResultChip"; import { PublishedPageCard } from "./PublishedPageCard"; import { DocumentCard } from "./documents/DocumentCard";
import { ThreadRefText } from "./ThreadRefs";
import { optionsCardRow, settledCardGoes } from "./OptionsCardRow";
import { MessageBoundary } from "./MessageBoundary";
import { RichMessageRow, UserLineNote, richRowKind } from "./RichMessageRow"; import { SetupOffer } from "./SetupOffer";
import { Composer } from "./Composer"; import { ComposerSignInNotice } from "./ComposerSignInNotice"; import { FailedReplyCard, FoldedNoticesContext, foldedNoticeIds, useTrailingRows } from "./FailedReplyCard";
import { CARD_ACTION, ChatErrorBanner, ChatErrorCard, ChatNotice } from "./ChatErrorBanner";
import { ThreadContextWarning } from "./ContextWarning";
import { UsageAlert, useLimitResetContinue } from "./EngineUsage";
import { ChatFindBar } from "./ChatFindBar";
import { QuotedText, ReplyQuote } from "./ReplyQuote"; import { useQuotedMessage } from "@/lib/quoted-messages";
import { ConnectorCard } from "./ConnectorCard";
import { SecretRequestCard } from "./SecretRequestCard";
import { SignInRequestCard } from "./SignInRequestCard";
import { RoutineRunRow } from "./RoutineRunCard"; import { InboxAnswers, InboxCaption, RelayLabel } from "./InboxLine"; import { InboxCardSlot } from "./inbox/InboxCard";
import { CallRecordRow } from "./CallRecordRow";
import { AttachmentGallery, collectMessageFiles, replyAttachmentGroup, splitMessageAttachments } from "./AttachmentGallery";
import { ScreenFrame } from "./ScreenFrame";
import { noteMediaSizes } from "@/lib/image-cache";
import { DigestChip } from "./DigestChip";
import { WeeklyLimitLine } from "./usage/WeeklyLimitLine";
import { ChatHeadRole, chiefOfStaffBadge } from "./BotRole";
import { ChatHeadPill } from "./ChatHeadPill"; import { useStoreRef } from "@/state/store-ref";
import { ELEVATED_FLOAT, ELEVATED_HOVER } from "./elevated";
import { ModelPicker } from "./ModelPicker";
import { ChatHeaderMenu, ChatMoreMenu } from "./ChatMoreMenu"; import { TeamOwnHelperHeader, TeamPrivateFirstLine, TeamPrivateHeader, TeamSharedHeader } from "./TeamPrivateChatsLine";
import { useChatFindRequests } from "@/lib/chat-find";
import { SpeakButton } from "./SpeakButton";
import { CallOverlay } from "./CallView";
import { LiveCallBar } from "./LiveCallBar";
import { LiveCallChip } from "./LiveCallPill";
import { effectivePlace, toolPlace, type EffectivePlace } from "@/lib/place";
import { cn } from "@/lib/cn";
import { activeLocale, t } from "@/lib/i18n";
import { COMPACT_BUBBLE } from "@/lib/compact-chip";
import { groupTranscript, isStatusActivity, statusActivity, type TranscriptItem } from "@/lib/activity-runs";
import { StatusActivityRow } from "@/components/StatusActivityRow";
import { ActivityRun } from "./ActivityRun";
import { TurnNarrationRun } from "./TurnNarrationRun";
import { BubbleEditor } from "./BubbleEditor";
import { ReplyBlocks } from "./ReplyBlocks";
import { webhookMessageView } from "@/lib/webhook-message";
import { splitTranscriptAttachments } from "@/lib/composer-attachments";
import { useComposerDockPad } from "@/lib/composer-dock";
import { GlassBar, GlassScrollFrame } from "./GlassScrollFrame";
import { useTranscriptViewport } from "@/hooks/use-transcript-viewport";
import { tailWindowStart } from "@/lib/transcript-window";
import { useUnreadDivider } from "@/hooks/use-unread-divider";
import { NewMessagesDivider } from "./NewMessagesDivider";
import { PeerExchangeLine } from "./PeerExchangeLine";
import { useExchangeRows } from "@/hooks/use-exchange-runs";
import { unreadMessageIds } from "@/lib/unread-divider";
import { useReplyDraft } from "@/lib/drafts";
import { localDay, transcriptLookups, type TranscriptLookups } from "@/lib/transcript-derivations"; import { DaySeparator } from "./DaySeparator";
import { withoutCitationMarkers } from "@/lib/citations";
import { EmptyChat } from "./ChatEmptyState";
import { PinnedBanner } from "./ChatPinnedBanner";
import { useCanWriteIn, useReactor } from "@/lib/cloud-guest";
import { splitReplyBlocks } from "@/lib/formatted-reply";
import { otherSpeaker } from "@/lib/own-profile";
import { latestFailure, latestReply, type TranscriptSnapshot } from "@/lib/transcript-announcer";
import { pendingApprovals } from "./PendingApproval";
import { SettledChangeEvent, showsSettledChange } from "./ApprovalCard";
import { TranscriptAnnouncer } from "./TranscriptAnnouncer";
import { JumpToLatestButton } from "./JumpToLatestButton";
import { UsageBanner } from "./native/UsageMeter";
import { mayTakeOver, useRescueGrace } from "@/lib/rescue-grace";
import { answeringModel } from "@/lib/thread-backup";
import { openSettings } from "@/lib/open-settings";
import { useTimestampPeek } from "./chat-timestamp-peek";
import { emojiOnly, EMOJI_ONLY_TEXT, grokUserBubbleFill, isBotTextRow, joinedCorners, needsStamp, quietRow, simpleRowLayout, SIMPLE_BOT_BUBBLE, SIMPLE_BUBBLE_MAX, SIMPLE_BUBBLE_TEXT, SIMPLE_STACKED, SIMPLE_USER_BUBBLE, type BubbleJoin } from "./chat-bubble";

const USER_COLLAPSE_CHARS = 600;
const USER_COLLAPSE_LINES = 8;

interface ChatRows {
  botId: string; threadId: string; botName: string; botColor: Bot["color"]; voiceId?: string;
  tts: ConfigStatus["tts"]; localVoice: boolean;
  hasMore: boolean; bots: readonly Bot[];
  mentionPeers: readonly MentionPeer[]; mentionPerson: { profileName?: string };
  /** On a Team Cloud, the viewer's person key: another person's line carries their name. */
  speakerViewer?: string | null;
  focus: AppState["focusMessage"];
  showToolCalls: boolean;
  locale: string;
  bubbleStyle?: ReturnType<typeof userBubbleStyle>;
  dispatch: Dispatch<Action>;
  conversational: boolean; simple?: boolean; canReact: boolean;
  openedAt: number;
}

const ChatRowsContext = createContext<ChatRows | null>(null);

function useChatRows(): ChatRows {
  const rows = useContext(ChatRowsContext);
  if (!rows) throw new Error("a chat row outside ChatView");
  return rows;
}

const drawnBot = (bot: Bot) =>
  [bot.id, bot.name, bot.hidden, bot.color, bot.mascotBody, bot.mascotExpression, bot.mascotFaceColor, bot.avatarUrl, bot.avatarCrop, bot.avatarZoom, bot.avatarFocusX, bot.avatarFocusY].join("\u0001");

function useDrawnBots(bots: readonly Bot[]): readonly Bot[] {
  const signature = bots.map(drawnBot).join("\u0002");
  const cache = useRef({ signature, bots });
  if (cache.current.signature !== signature) cache.current = { signature, bots };
  return cache.current.bots;
}

export function ErrorRow({
  message,
  headline: plainHeadline,
  onRetry,
  action,
  setupInstance,
  claudeUpdateInstance,
}: {
  message: string;
  headline?: string;
  onRetry?: () => void;
  action?: { label: string; onClick: () => void } | null;
  setupInstance?: InstanceInfo;
  claudeUpdateInstance?: InstanceInfo;
}) {
  const { capabilities, ready } = useDesktopCapabilities();
  const failedPermissions = missingMacCuaPermissions(message);
  const currentPermissions = missingMacCuaPermissions(capabilities.localComputer.message);
  const macCuaReason = ready && capabilities.host.platform === "darwin" &&
    capabilities.localComputer.available === false && capabilities.localComputer.reasonCode !== "remote-server" &&
    isThisComputerNotReady(message) &&
    failedPermissions.length > 0 && failedPermissions.join(",") === currentPermissions.join(",")
    ? macCuaPermissionMessage(currentPermissions, capabilities.localComputer.message)
    : null;
  const notGranted = isThisComputerNotGranted(message);
  const headline = macCuaReason ?? (notGranted ? t(capabilities.host.platform === "darwin" ? "chat.error.cantUseThisMac" : "chat.error.cantUseThisComputer") : null) ?? plainHeadline ?? message;
  // the desktop app's own page is on a server it did not start (a copy run from source): the app has nothing to open
  const details = notGranted && ready && capabilities.localComputer.available ? t("chat.error.notTheAppsServer") : message;
  const usageUrl = action ? null : message.includes("subscription_sharing_usage_limit_exceeded") ? CHATGPT_USAGE_URL : codexUsageLimitReached(message) ? CODEX_USAGE_URL : null;
  const setup = setupInstance && !(setupInstance.snapshot.state === "available" && setupInstance.snapshot.authenticated !== false);
  const safety = !usageUrl && !claudeUpdateInstance && isProviderSafetyBlock(message);
  const button = usageUrl ? (
    <ManageUsageLink href={usageUrl} className="ui-button ui-button-pill border-transparent bg-ink text-app hover:brightness-110" />
  ) : claudeUpdateInstance || safety || setup ? null : action !== undefined ? (
    action && <button type="button" onClick={action.onClick} className={CARD_ACTION}>{action.label}</button>
  ) : onRetry ? (
    <button type="button" onClick={onRetry} className={CARD_ACTION}><RefreshCw size={14} aria-hidden="true" /> {t("chat.retry")}</button>
  ) : null;
  return (
    <div className="flex justify-start">
      <ChatErrorCard
        className="w-fit max-w-[min(var(--chat-bubble-max),var(--chat-bubble-pct))]"
        title={headline}
        details={headline !== message ? details : null}
        actions={button}
      >
        {macCuaReason && <MacCuaRecoveryActions reason={message} />}
        {!usageUrl && claudeUpdateInstance ? (
          <ClaudeUpdatePrompt instance={claudeUpdateInstance} onRetry={onRetry} />
        ) : safety ? (
          <p className="mt-1 text-ink-secondary">
            {PROVIDER_SAFETY_GUIDANCE}{" "}
            <a href={PROVIDER_SAFETY_HELP_URL} target="_blank" rel="noreferrer" className="underline">{t("chat.error.providerSafetyLink")}</a>
          </p>
        ) : !usageUrl && setup ? (
          <EngineSetup instance={setupInstance} className="mt-2 text-ink-secondary" />
        ) : null}
      </ChatErrorCard>
    </div>
  );
}

function PlaceFailedRow({ place, botId, threadId, onRetry }: {
  place: PlaceRow;
  botId: string;
  threadId?: string;
  onRetry?: () => void;
}) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const seat = usePlaceSeat(state.config, capabilities.host.platform);
  const bot = state.bots.find((candidate) => candidate.id === botId);
  const view = placeRowViewFor(place, seat, lowerFirst(worksOnSimpleLabel(bot?.computer, capabilities.host.platform)));
  const id = view.action?.id;
  const onClick = !id ? undefined
    : id === "try-again" ? onRetry
    : () => { openPlaceAction(id, { botId, threadId }, dispatch); };
  const label = id === "open-computer-panel" ? t("chat.error.openScreen") : view.action?.label;
  return <ErrorRow message={view.line} action={label && onClick ? { label, onClick } : null} />;
}

export function FailedTurnRow({ tool, engine, onRetry, botId, threadId }: {
  tool: NonNullable<Message["tool"]>;
  engine: InstanceInfo | undefined;
  onRetry?: () => void;
  botId?: string;
  threadId?: string;
}) {
  const resume = useLimitResetContinue(botId, threadId, tool.limitResetsAt);
  if (tool.place && botId) return <PlaceFailedRow place={tool.place} botId={botId} threadId={threadId} onRetry={onRetry} />;
  const cause = failedTurnCause(tool.name) ?? tool.name;
  if (tool.partial) return tool.owned ? null : <PartlyDoneRow cause={cause} onRetry={onRetry} />;
  const signedOut = signedOutEngine(tool, engine);
  return (
    <ErrorRow
      message={cause}
      headline={signedOut ? t("chat.error.signedOut", { name: signedOut.displayName }) : plainErrorLine(cause)}
      onRetry={onRetry}
      action={resume}
      setupInstance={tool.setup ? engine : undefined}
      claudeUpdateInstance={tool.claudeUpdate ? claudeUpdateTarget(engine) : undefined}
    />
  );
}

export { MessageBoundary };

/** A message keeps its Copy in its "…" menu, after the reaction and Reply buttons. */
function copyItem(text: string): MessageMenuItem[] {
  return text.trim() ? [{ key: "copy", icon: <Copy {...ACTION_ICON} />, label: t("chat.copyMessage"), onSelect: () => { void copyMessage(text); } }] : [];
}

const Bubble = memo(function Bubble({
  message,
  emerging = false,
  eagerAttachments = false,
  joinAbove = false,
  joinBelow = false,
  editing,
  pinned,
  versions,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onRegenerate,
  replyTarget: loadedReplyTarget,
  onReply,
  underExchangeLine = false,
}: {
  message: Message;
  /** An exchange line above already names the bot that sent it. */
  underExchangeLine?: boolean;
  emerging?: boolean;
  eagerAttachments?: boolean;
  /** This bubble meets the one above (or below) in its sender's group. */
  joinAbove?: boolean;
  joinBelow?: boolean;
  editing: boolean;
  pinned: boolean;
  versions?: readonly Message[];
  onStartEdit: (messageId: string) => void;
  onCancelEdit: () => void;
  onSubmitEdit: (messageId: string, text: string) => void;
  onRegenerate?: () => void;
  replyTarget?: Message;
  onReply: (message: Message) => void;
}) {
  const { botId, threadId, botName, voiceId, tts, localVoice, bots, mentionPeers, mentionPerson, focus, dispatch, bubbleStyle, conversational, canReact, openedAt, speakerViewer } = useChatRows(), busy = onRegenerate || versions ? use(ChatBusyContext) : false;
  const remoteClient = window.madaniDesktop?.remoteClient?.active === true, replyTarget = useQuotedMessage(threadId, message.replyToId, loadedReplyTarget);
  const peer = peerLine(message) ?? peerRequest(message, botId);
  const user = message.role === "user" && !peer;
  const speaker = user ? otherSpeaker(message, speakerViewer ?? null) : null;
  const ownBubbleStyle = speaker ? undefined : bubbleStyle;
  const [expanded, setExpanded] = useState(false);
  const focusedSearch = focus?.messageId === message.id && Boolean(focus.matchText);
  const speech = useSpeech();
  const speaking = speech.messageId === message.id && speech.status !== "idle";
  const rawText = peer ? peer.body : (message.text ?? "");
  const text = user ? rawText : botTextForDisplay(rawText);
  const botMenu = useBotMessageMenu({
    text,
    botId,
    messageId: message.id,
    voiceId,
    tts,
    localVoice,
    canSpeak: message.kind === "text" && !peer,
    onRegenerate: !busy ? onRegenerate : undefined,
    pin: remoteClient ? undefined : {
      pinned,
      onToggle: () => dispatch({ type: "updateTask", botId, threadId, patch: { pinnedMessageId: pinned ? "" : message.id } }),
    },
  });
  noteMediaSizes(message.media);
  const attached = useMemo(() => splitMessageAttachments(message.attachments), [message.attachments]);
  const generatedPaths = attached.images;
  const linkedFiles = useMemo(
    () => user ? [] : [...attached.files, ...collectMessageFiles(text, [...attached.images, ...attached.files.map((file) => file.path)])],
    [user, text, attached],
  );
  const group = useMemo(
    () => !user && text.trim() ? replyAttachmentGroup(text, message.attachments) : null,
    [user, text, message.attachments],
  );
  const voiceNotes = useMemo(
    () => message.attachments?.filter((attachment): attachment is VoiceNoteAttachment => attachment.kind === "audio") ?? [],
    [message.attachments],
  );
  const join: BubbleJoin = { above: joinAbove, below: joinBelow };
  // only rows that arrive while the conversation is open slide in; a reply that streamed in is already in place
  const fresh = !emerging && message.at > openedAt && !isSettledRow(message.id);
  const reply = useReplySegments(conversational && !user && !peer && !replyTarget && message.kind === "text", text);
  const split = reply.segments.length > 1;
  // each table of a reply draws as its own card between the reply's prose bubbles
  const blocks = useMemo(() => !user && !peer && !split && text ? splitReplyBlocks(text) : null, [user, peer, split, text]);
  const tabled = Boolean(blocks?.some((block) => block.kind === "table"));
  const webhookView = user ? webhookMessageView(text) : null;
  const cited = user && !webhookView ? withoutCitationMarkers(text) : text;
  const attachments = user && !webhookView ? splitTranscriptAttachments(cited) : null;
  const visibleText = webhookView?.task ?? attachments?.display ?? text;
  const hasAttachments = Boolean(cited !== text || (attachments && (attachments.images.length || attachments.files.length)));
  const imagesAbove = attachments && (attachments.images.length > 0 || attachments.files.length > 0) && visibleText.trim() ? attachments : null;
  const attachmentsOnly = !webhookView && !replyTarget && !visibleText.trim() &&
    (user ? hasAttachments : generatedPaths.length + linkedFiles.length > 0);
  const collapsible =
    user && !webhookView && !expanded && (visibleText.length > USER_COLLAPSE_CHARS || visibleText.split("\n").length > USER_COLLAPSE_LINES);
  useEffect(() => {
    if (focusedSearch && collapsible) setExpanded(true);
  }, [focusedSearch, collapsible, focus?.nonce]);
  const reduced = usePrefersReducedMotion();
  const own = useRef<{ bubble: HTMLDivElement | null; entered: boolean }>({ bubble: null, entered: false });
  // a send scales up out of the composer as the column follows; a reply grows out of the mascot; anything else rises
  // with its row
  const [entrance] = useState<"send" | "grow" | null>(() => {
    if (!fresh) return null;
    if (!user) return message.kind === "text" ? "grow" : null;
    const plain = !webhookView && !hasAttachments && Boolean(visibleText.trim()) && !emojiOnly(visibleText);
    return plain && hasSendLaunch(message.sendId) ? "send" : null;
  });
  useLayoutEffect(() => {
    const parts = own.current;
    if (parts.entered || !entrance || !parts.bubble) return;
    parts.entered = true;
    if (entrance === "grow") growFromMascot(parts.bubble, reduced);
    else enterFromComposer(parts.bubble, message.sendId, reduced);
  }, [entrance, reduced, message.sendId]);

  if (user && editing && !webhookView && !hasAttachments) {
    return (
      <div className="flex w-full justify-end">
        <BubbleEditor initial={text} bubbleStyle={bubbleStyle} onCancel={onCancelEdit} onSubmit={(edited) => onSubmitEdit(message.id, edited)} />
      </div>
    );
  }

  // grok's tapbacks ride the bubble's top corner; a split or tabled reply keeps them in a row underneath
  // grok draws a bot's images, files and voice notes as rows of their own beside its words, never inside the bubble
  const mediaSplit = Boolean(!user && !split && !tabled && text.trim() && (voiceNotes.length > 0 || generatedPaths.length + linkedFiles.length > 0 || (group && group.images.length + group.files.length > 0)));
  const bigEmoji = !webhookView && !replyTarget && !hasAttachments && !split && !tabled && !mediaSplit && !collapsible && emojiOnly(visibleText);
  const floatReactions = Boolean(message.reactions?.length && !split && !attachmentsOnly && !webhookView);
  // with media beside the words, grok's tapbacks ride the media row instead of the bubble
  const mediaReactions = floatReactions && mediaSplit;
  const reactionsOnBubble = floatReactions && !mediaSplit && !tabled;
  const mediaChips = mediaReactions && <ReactionChips float threadId={threadId} message={message} bots={bots} align="start" canReact={canReact} />;
  const togglePin = () =>
    dispatch({ type: "updateTask", botId, threadId, patch: { pinnedMessageId: pinned ? "" : message.id } });
  const botActions = !user && (
    <MessageActions side="bot" forceOpen={speaking} menu={[...copyItem(text), ...botMenu]}>
      {canReact && !peer && <ReactAction threadId={threadId} message={message} />}
      <ReplyAction onReply={() => onReply(message)} />
      {text && speaking && <SpeakButton text={text} botId={botId} messageId={message.id} voiceId={voiceId} tts={tts} localVoice={localVoice} className={cn(messageActionClass, "text-accent")} />}
    </MessageActions>
  );

  return (
    <div {...{ [MESSAGE_ROW]: "", ...(entrance ? { [OWN_ENTRANCE]: "" } : {}) }} data-sent-at={message.at || undefined} data-arrival={fresh ? (user ? "end" : "start") : undefined} className={cn("group relative flex w-full flex-col", (reactionsOnBubble || (mediaReactions && !group)) && "pt-[26px]", user ? "items-end" : "items-start", join?.above && SIMPLE_STACKED)}>
      {message.relay ? <RelayLabel message={message} /> : peer && !underExchangeLine && <PeerLabel peer={peer} />}
      {speaker && <div className="mb-0.5 px-1 text-[12px] font-medium text-ink-secondary">{speaker}</div>}
      {imagesAbove && <AttachmentGallery media={message.media} images={imagesAbove.images} files={imagesAbove.files} message={{ threadId, messageId: message.id }} eager={eagerAttachments} align="end" className="mb-1" />}
      <div data-own-row={user ? "" : undefined} className={cn("flex w-full items-center gap-1.5", user ? "justify-end" : "justify-start")}>
        {user && (
          <MessageActions
            side="user"
            menu={[
              ...copyItem(visibleText),
              ...userMessageMenu({
                onEdit: !speaker && message.kind === "text" && !webhookView && !hasAttachments && !message.id.startsWith("optimistic-")
                  ? () => onStartEdit(message.id) : undefined,
                pin: remoteClient ? undefined : { pinned, onToggle: togglePin },
              }),
            ]}
          >
            <ReplyAction own onReply={() => onReply(message)} />
          </MessageActions>
        )}
        <div
          ref={(el) => { own.current.bubble = el; }}
          data-chat-bubble="simple"
          className={cn(
            tabled ? "w-full" : "w-fit",
            !tabled && SIMPLE_BUBBLE_MAX,
            emerging && "turn-answer",
            bigEmoji
              ? EMOJI_ONLY_TEXT
              : user && webhookView
              ? cn("overflow-hidden rounded-[18px] border border-accent/25 bg-card text-ink", SIMPLE_BUBBLE_TEXT)
              : attachmentsOnly || split || tabled || mediaSplit
                ? cn("text-ink", SIMPLE_BUBBLE_TEXT, mediaSplit && "flex flex-col items-start gap-1")
                : user
                  ? cn("whitespace-pre-wrap [overflow-wrap:anywhere] text-ink", SIMPLE_USER_BUBBLE, ownBubbleStyle && "user-bubble-colored antialiased")
                  : SIMPLE_BOT_BUBBLE,
            join && !split && !attachmentsOnly && !tabled && !mediaSplit && joinedCorners(user ? "end" : "start", join),
          )}
          data-emoji-only={bigEmoji ? "" : undefined}
          data-bubble-group={attachmentsOnly || split || tabled || mediaSplit ? "" : undefined}
          data-quotable={user ? undefined : ""}
          data-sending={user && message.id.startsWith("optimistic-") ? t("chat.sending") : undefined}
          style={user && !webhookView && !attachmentsOnly && !bigEmoji ? ownBubbleStyle : undefined}
          data-reacted={reactionsOnBubble ? "" : undefined}
        >
          {replyTarget && (
            <div className="mb-2">
              <ReplyQuote
                message={replyTarget}
                fallbackName={botName}
                compact
                onJump={() =>
                  dispatch({ type: "focusMessage", threadId, messageId: replyTarget.id })
                }
              />
            </div>
          )}
          {user && webhookView ? (
            <div className="min-w-[300px] max-w-[520px]">
              <div className="flex items-center gap-2 border-b border-transparent px-4 py-2.5 text-[12px] font-medium text-ink-secondary">
                <Webhook size={13} />
                <span>{t("chat.webhookTask")}</span>
              </div>
              <div className="chat-text px-4 py-3 whitespace-pre-wrap">{webhookView.task}</div>
              {webhookView.payload && (
                <details className="border-t border-transparent bg-inset/25 px-4 py-2.5 text-[12px] text-ink-secondary">
                  <summary className="cursor-pointer select-none hover:text-ink">{t("chat.viewPayload")}</summary>
                  <pre className="mt-2 max-h-48 overflow-auto rounded-lg border border-transparent bg-black/25 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-ink-secondary">{webhookView.payload}</pre>
                </details>
              )}
            </div>
          ) : user ? (
            <>
              {attachments && !imagesAbove && <AttachmentGallery media={message.media} images={attachments.images} files={attachments.files} message={{ threadId, messageId: message.id }} eager={eagerAttachments} align="end" className={!visibleText ? "mb-0" : undefined} />}
              {visibleText && (
                <div className={cn("chat-text", collapsible && "max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]")}>
                  <QuotedText text={visibleText} render={(rest) => <ThreadRefText text={rest} peers={mentionPeers} />} />
                </div>
              )}
              {message.quickModel && <QuickModelNote model={message.quickModel} />}
              <UserLineNote message={message} />
              {collapsible && (
                <button onClick={() => setExpanded(true)} className="mt-1 text-[13px] text-ink-secondary hover:text-ink pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center">
                  {t("chat.showFull")}
                </button>
              )}
              {expanded && (
                <button onClick={() => setExpanded(false)} className="mt-1 text-[13px] text-ink-secondary hover:text-ink pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center">
                  {t("chat.showLess")}
                </button>
              )}
            </>
          ) : (
            <MessageBoundary fallbackText={text || t("chat.generatedImage")}>
              {voiceNotes.length > 0 && (
                <div className="flex flex-col gap-1">
                  {voiceNotes.map((note) => (
                    <VoiceNoteBubble key={note.path} attachment={note} />
                  ))}
                </div>
              )}
              {!group && (mediaChips && (generatedPaths.length + linkedFiles.length > 0)
                ? <div className="relative">{mediaChips}<AttachmentGallery media={message.media} images={attached.pictures} files={linkedFiles} message={{ threadId, messageId: message.id }} eager={eagerAttachments} /></div>
                : <AttachmentGallery media={message.media} images={attached.pictures} files={linkedFiles} message={{ threadId, messageId: message.id }} eager={eagerAttachments} />)}
              {split ? (
                <ConversationalReply join={join} segments={reply.segments} firstNew={reply.firstNew}
                  renderSegment={(segment) => <ChatMarkdown text={segment} mentionPeers={mentionPeers} mentionPerson={mentionPerson} message={{ threadId, messageId: message.id }} delivered={group?.delivered} />} />
              ) : tabled && blocks ? (
                <ReplyBlocks blocks={blocks} join={join} tray={botActions}
                  chips={floatReactions && <ReactionChips float threadId={threadId} message={message} bots={bots} align="start" canReact={canReact} />}
                  render={(block) => <ChatMarkdown text={block} mentionPeers={mentionPeers} mentionPerson={mentionPerson} message={{ threadId, messageId: message.id }} delivered={group?.delivered} />} />
              ) : text && mediaSplit ? (
                <div data-chat-bubble="simple" className={cn("w-fit max-w-full", SIMPLE_BOT_BUBBLE, join && joinedCorners("start", join))}><ChatMarkdown text={text} mentionPeers={mentionPeers} mentionPerson={mentionPerson} message={{ threadId, messageId: message.id }} delivered={group?.delivered} /></div>
              ) : text ? (
                <ChatMarkdown text={text} mentionPeers={mentionPeers} mentionPerson={mentionPerson} message={{ threadId, messageId: message.id }} delivered={group?.delivered} />
              ) : null}
              {group && (mediaChips
                ? <div className="relative mt-[26px]">{mediaChips}<AttachmentGallery media={message.media} images={group.pictures} files={group.files} message={{ threadId, messageId: message.id }} eager={eagerAttachments} /></div>
                : <AttachmentGallery media={message.media} images={group.pictures} files={group.files} message={{ threadId, messageId: message.id }} eager={eagerAttachments} />)}
            </MessageBoundary>
          )}
          {reactionsOnBubble && <ReactionChips float threadId={threadId} message={message} bots={bots} align={user ? "end" : "start"} canReact={canReact} />}
        </div>
        {!tabled && botActions}
      </div>
      <time dateTime={new Date(message.at).toISOString()} className="chat-row-ts" aria-label={new Date(message.at).toLocaleTimeString()}>{formatTime(message.at)}</time>
      {!floatReactions && <ReactionChips threadId={threadId} message={message} bots={bots} align={user ? "end" : "start"} canReact={canReact} />}
    </div>
  );
});

function PeerLabel({ peer }: { peer: PeerLine }) {
  const { bots } = useChatRows();
  const author =
    bots.find((b) => b.id === peer.botId) ?? bots.find((b) => b.name === peer.name);
  const how =
    peer.delivery === "delegate_bot"
      ? t("chat.peer.handedTask")
      : peer.delivery === "start_thread"
        ? t("chat.peer.openedThread")
        : peer.delivery === "coordinate_bots"
          ? t("chat.peer.requested")
          : t("chat.peer.asked");
  return (
    <div className="mb-1 flex items-center gap-1.5 pl-0.5" data-testid="peer-label">
      <BotAvatar
        bot={author ?? { name: peer.name, color: "blue" }}
        state={normalizeState(author?.mascotExpression) ?? "happy"}
        size={16}
        motion="none"
        motionKey={0}
        animated={false}
      />
      <span className="text-[11px] font-medium text-ink-secondary">{peer.name}</span>
      <span className="text-[11px] text-ink-tertiary">· {how}</span>
    </div>
  );
}

const ActivityChip = memo(function ActivityChip({ message, place = "auto" }: { message: Message; place?: EffectivePlace }) {
  const { bots, dispatch, threadId } = useChatRows(), liveTools = use(LiveToolsContext);
  const tool = message.tool;
  if (!tool) return null;
  if (message.threadRef) return <ThreadChip message={message} />; if (message.relay) return <TeammateChip message={message} />;
  const comm = message.comm;
  if (comm) return <RoomHandoffChip message={message} comm={comm} bots={bots} dispatch={dispatch} />;
  return <ToolActivity tool={tool} live={liveTools.has(message.id)} place={toolPlace(tool.name, place)} source={{ threadId, messageId: message.id }} />;
});

const RoomHandoffChip = ({ message, comm, bots, dispatch }: { message: Message; comm: NonNullable<Message["comm"]>; bots: readonly Bot[]; dispatch: Dispatch<Action> }) => { const store = useStoreRef(); return <HandoffChip message={message} bots={bots} title={t("chat.openConversationWith", { name: comm.withName })} onClick={() => openRoomThread(dispatch, comm, store.state().groups)} />; };

/** What grok's status-line mark plays: the live step while the turn runs, its outcome once it ends. */
export function statusMarkFor({ busy, waitingOnYou, answering, live, failed }: { busy: boolean; waitingOnYou: boolean; answering: boolean; live: LiveStatus["activity"] | undefined; failed: boolean }): MarkState {
  if (waitingOnYou) return "blocked";
  if (answering || live === "reply") return "streaming";
  if (!busy) return failed ? "failed" : "finished";
  switch (live) {
    case "thinking": return "thinking";
    case "read": case "fetch": return "reading";
    case "command": return "running";
    case "write": case "edit": return "coding";
    case "search": case "web": return "searching";
    default: return "working";
  }
}

/** True while `on`, and for `ms` after it goes false: what is still on screen while it leaves. */
/** The turn the person stopped, as the chat shows it from the press: what the bot had said stays, the words that had
 * streamed by then settle at once as its last bubble (the server's own copy takes that bubble's place when it lands), and
 * anything else of that turn that lands after the press is kept out, then and later. */
export function withoutLateRows(messages: Message[], press: StopPress | undefined, onScreen: ReadonlySet<string> | undefined): Message[] {
  const flat = (text: string) => text.replace(/\s+/g, " ").trim();
  const said = press?.said ? flat(press.said) : "";
  let settled = false;
  const late = (message: Message) => {
    // the server's copy of the words the Stop settled (trimmed to them if their item finished on the way) takes the place
    // of the bubble the Stop drew; a row of more than that waits, hidden, until it is trimmed
    const words = message.role === "bot" && message.kind === "text" ? flat(message.text ?? "") : "";
    if (said && words && said.includes(words) && (isLateRow(message.id) || (onScreen && !onScreen.has(message.id)))) {
      forgetLateRow(message.id);
      noteSettledRow(message.id);
      settled = true;
      return false;
    }
    if (isLateRow(message.id)) return true;
    if (!press || !onScreen || onScreen.has(message.id) || message.role !== "bot") return false;
    if (press.turnId && message.turnId && message.turnId !== press.turnId) return false;
    // the server's own stopped row is how the Stop is remembered: it stays
    if (message.kind === "activity" && isStoppedTurnName(message.tool?.name ?? "")) return false;
    noteLateRow(message.id);
    return true;
  };
  const kept = messages.some(late) ? messages.filter((message) => !late(message)) : messages;
  if (!press?.said || settled || !onScreen) return kept;
  return [...kept, { id: `stop-said:${press.at}`, role: "bot", kind: "text", text: shownReplyText(press.said), at: press.at,
    ...(press.turnId ? { turnId: press.turnId } : {}) } as Message];
}

/** The person stopped the newest turn: the chat's last word since their message is that Stop. */
export function personStoppedLast(messages: readonly Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role === "user") return false;
    if (message.kind === "activity" && message.tool?.name === PERSON_STOPPED_TURN_NAME) return true;
  }
  return false;
}

export function useLingering(on: boolean, ms: number): boolean {
  const [lingering, setLingering] = useState(on);
  if (on && !lingering) setLingering(true);
  useEffect(() => {
    if (on || !lingering) return;
    const timer = setTimeout(() => setLingering(false), ms);
    return () => clearTimeout(timer);
  }, [on, lingering, ms]);
  return on || lingering;
}

/** Simple mode's room under the last row, above the composer's own clearance: the last bubble ends 64px over the composer,
 * 10px more than grok's 54 so the mascot's line is not crowded against the message box. */
export const SIMPLE_TRAILING_GAP = 44;
/** The part of that room the status line's slot takes: its 36px row and the 4px it sits under a bubble, so an idle chat's
 * last bubble still ends 64px over the composer and the line itself 24px over it. */
export const SIMPLE_STATUS_SLOT = 40;

/** How many of a window's newest rows an opened chat paints in its first frame, and how many older ones each later step adds. */
export const FIRST_PAINT_ROWS = 16;
export const MOUNT_STEP_ROWS = 24;
/** A phone's screen holds far fewer rows, and its slower CPU pays for each one before the chat can start sliding in. */
export const PHONE_FIRST_PAINT_ROWS = 8;
const firstPaintRows = () => phoneApp() ? PHONE_FIRST_PAINT_ROWS : FIRST_PAINT_ROWS;

/** A chat opened on a long window paints its newest rows first, then mounts the older ones above them a step at a time in
 * interruptible renders, so switching into it never blocks a frame. A search jump or a window off the latest rows
 * (`hold`) mounts whole, since it scrolls to a row that may sit above the tail. */
export function useFirstPaintRows(key: string, rows: Message[], hold: boolean, scrollRef?: RefObject<HTMLElement | null>, pinned = false): Message[] {
  const first = firstPaintRows();
  const [shown, setShown] = useState({ key, count: first });
  if (shown.key !== key) setShown({ key, count: first });
  // a chat whose rows all showed once keeps showing all of them as it grows, without another render to say so
  const whole = useRef<string | null>(null);
  const count = hold || whole.current === key ? Infinity : shown.key === key ? shown.count : first;
  const total = rows.length;
  // Sixteen messages can fold into a few rows (a turn's tool steps are one): a first paint shorter than the viewport sits at
  // the top, then the chat jumps down as the older rows land. Such a paint grows before the browser shows it.
  // once a paint fills the view, a bigger one does too: the check reads the transcript's height, which forces its whole
  // style and layout, so it stops there instead of running again at each step the rows grow by
  const filled = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef?.current;
    if (!el || count >= total || filled.current === key) return;
    if (el.scrollHeight > el.clientHeight + 1) { filled.current = key; return; }
    setShown({ key, count: count + first >= total ? Infinity : count + first });
  }, [key, count, total, scrollRef, first]);
  // older rows mount above the ones on screen: a chat held at its newest row stays there in the same frame, rather than
  // a frame later when the transcript's resize is noticed, which would show the rows jumping down and back
  useLayoutEffect(() => {
    const el = scrollRef?.current;
    if (el && pinned) el.scrollTop = el.scrollHeight;
  }, [count, pinned, scrollRef]);
  const staging = useContext(TranscriptStaging);
  useEffect(() => {
    if (count >= total) {
      whole.current = key;
      return;
    }
    const step = () => startTransition(() => setShown({ key, count: count + MOUNT_STEP_ROWS >= total ? Infinity : count + MOUNT_STEP_ROWS }));
    if (staging.afterSlide) return staging.afterSlide(step);
    step();
  }, [key, count, total, hold, staging]);
  return useMemo(() => (count >= rows.length ? rows : rows.slice(-count)), [count, rows]);
}

const transcriptRows = (item: TranscriptItem): readonly Message[] => item.kind === "message" ? [item.message] : item.messages;
const noneTransparent = () => false;
const hiddenSteps = (item: TranscriptItem) => item.kind !== "message";

function hiddenChatRow(message: Message, botId: string, showToolCalls: boolean): boolean {
  if (message.reaction || isCancelledTranscriptRow(message)) return true;
  switch (richRowKind(message)) {
    case "activity":
      return Boolean(message.peerResume) || (!message.dataResult && !isStatusActivity(message) && quietRow(message, showToolCalls));
    case "compaction":
      return true;
    case "digest":
    case "screen":
      return !showToolCalls;
    case "secret":
      return !message.secret;
    case "signin":
      return !message.signIn;
    case "connector":
      return !message.connector;
    case "call":
      return !message.call;
    case "options":
      return Boolean(message.helperFollowup || (settledCardGoes(message) && !showsSettledChange(message.card)));
    case "widget":
    case "app":
    case "routine.run":
      return false;
    default:
      if (message.publishedPage || message.document) return false;
      if (message.role === "user" && !peerLine(message) && !peerRequest(message, botId)) return routineStartName(message) !== null;
      return !message.attachments?.length && isPureLeakedBotText(message.text);
  }
}

const MessagesList = memo(function MessagesList({
  messages,
  transcript,
  lookups,
  place,
  pinnedMessageId,
  today,
  editingId,
  lastBotTextId,
  emergingId,
  canRetryLast,
  engine,
  unreadDividerId,
  unreadDividerFading,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onRegenerate,
  onReply,
  seamId = null,
}: {
  messages: Message[];
  transcript: Message[];
  lookups: TranscriptLookups;
  place: EffectivePlace;
  pinnedMessageId?: string;
  today: number;
  editingId: string | null;
  lastBotTextId: string | undefined;
  emergingId?: string | null;
  canRetryLast: boolean;
  engine: InstanceInfo | undefined;
  unreadDividerId: string | null;
  unreadDividerFading: boolean;
  onStartEdit: (id: string) => void;
  onCancelEdit: () => void;
  onSubmitEdit: (id: string, text: string) => void;
  onRegenerate: () => void;
  onReply: (message: Message) => void;
  /** The bubble the working line hangs under: its bottom corner pinches as if another bubble followed, as grok's does. */
  seamId?: string | null;
}) {
  const { botId, threadId, botName, botColor, bots, hasMore, focus, showToolCalls, locale, bubbleStyle } = useChatRows(), busy = use(ChatBusyContext);
  // A finished turn keeps the bot's progress lines and folds only its tool steps under "Worked for", in both modes.
  const items = useMemo(() => groupTranscript(messages), [messages, locale]);
  const newestMessageId = messages.at(-1)?.id;
  let newestUserMessageId: string | undefined;
  for (let i = messages.length - 1; i >= 0 && !newestUserMessageId; i--) {
    if (messages[i]!.role === "user") newestUserMessageId = messages[i]!.id;
  }
  const focusedId = focus && !focus.consumed ? focus.messageId : null;
  const unreadIds = useMemo(() => unreadMessageIds(messages, unreadDividerId), [messages, unreadDividerId]);
  // the "sign in on the connection page" footnote says the same thing under every app card: only the newest one keeps it
  const lastConnectorId = useMemo(() => messages.findLast((one) => one.connector)?.id, [messages]);
  let dividerPlaced = false;
  const layout = useMemo(() => simpleRowLayout(items, { botId, showToolCalls, unreadIds }), [items, unreadIds, showToolCalls, botId]);
  const joins = useMemo(() => {
    if (!seamId) return layout.joins;
    const at = items.findIndex((item) => item.kind === "message" && item.message.id === seamId);
    return at < 0 ? layout.joins : layout.joins.map((join, index) => index === at ? { ...join, below: true } : join);
  }, [layout, items, seamId]);
  const exchanges = useExchangeRows(messages, items, transcriptRows, showToolCalls ? noneTransparent : hiddenSteps, botId);
  const rowJoins = useMemo(() => joins.map((join, index) => exchanges.closedBelow(index) || exchanges.closedAbove(index)
    ? { ...join, ...(exchanges.closedBelow(index) ? { below: false } : {}), ...(exchanges.closedAbove(index) ? { above: false } : {}) } : join), [joins, exchanges]);
  const dividerAbove = (rows: readonly Message[]) => {
    if (!unreadIds || dividerPlaced || !rows.some((row) => unreadIds.has(row.id))) return null;
    dividerPlaced = true;
    return <NewMessagesDivider fading={unreadDividerFading} tint={bubbleStyle ? `var(--identity-${botColor})` : undefined} grokTint={botColor ? grokAccentText(botColor) : undefined} />;
  };
  return (
    <>
      {items.map((item, i) => {
        const previous = items[i - 1];
        const prev = previous && (previous.kind === "message" ? previous.message : previous.messages.at(-1));
        const first = item.kind === "message" ? item.message : item.messages[0];
        const run = exchanges.runAt.get(i);
        const collapsed = run !== undefined && !exchanges.isOpen(run);
        if (run && i !== run.start && collapsed) return null;
        const leads = run !== undefined && i === run.start;
        const newDay = needsStamp(prev, first);
        const divider = dividerAbove(leads ? run.items.flatMap(transcriptRows) : transcriptRows(item));
        const lead = leads && (
          <>
            {divider}
            {newDay && <DaySeparator at={first.at} today={today} prev={prev} next={first} />}
            <PeerExchangeLine summary={run.summary} bots={bots} expanded={!collapsed} onToggle={() => exchanges.toggle(run)} />
          </>
        );
        if (lead && collapsed) return <div key={run.id} className="contents" data-mid={first.id}>{lead}</div>;
        const stamp = !lead && newDay && <DaySeparator at={first.at} today={today} prev={prev} next={first} />;
        const dividerRow = lead ? null : divider;
        if (item.kind === "turn" || item.kind === "run") {
          if (!showToolCalls) return (lead || dividerRow) && <div key={item.id} className="contents">{lead}{dividerRow}</div>;
          const forceOpen = item.messages.some((step) => step.id === focusedId);
          const steps = item.messages.map((step) => <div key={step.id} className="contents" data-mid={step.id}><ActivityChip message={step} place={place} /></div>);
          return (
            <div key={item.id} className="contents">
              {lead}
              {dividerRow}
              {stamp}
              {item.kind === "turn"
                ? <TurnNarrationRun label={item.label} title={t("chat.run.showSteps")} forceOpen={forceOpen}>{steps}</TurnNarrationRun>
                : <ActivityRun messages={item.messages} forceOpen={forceOpen}>{steps}</ActivityRun>}
            </div>
          );
        }
        const m = item.message;
        const row = (() => {
          // the chat talks in bubbles: stops, finished steps and settled cards leave no technical rows behind
          if (hiddenChatRow(m, botId, showToolCalls)) return null;
          switch (richRowKind(m)) {
            case "secret":
              return m.secret ? <SecretRequestCard botId={botId} color={botColor} threadId={threadId} message={m} /> : null;
            case "signin":
              return m.signIn ? <SignInRequestCard botId={botId} botName={botName} color={botColor} threadId={threadId} message={m} /> : null;
            case "connector":
              return m.connector ? <ConnectorCard botId={botId} color={botColor} threadId={threadId} message={m} hideNote={m.id !== lastConnectorId} /> : null;
            case "options":
              // grok keeps an answered question in place and folds a decided permission to one grey line; the rest leave no row
              if (m.card && settledCardGoes(m)) return showsSettledChange(m.card) ? <SettledChangeEvent bot={{ name: botName }} message={m} threadId={threadId} /> : null;
              return optionsCardRow({ message: m, transcript, botId, botName, botColor: bots.find((one) => one.id === m.inbox?.from.botId)?.color ?? botColor, threadId, asker: bots.find((one) => one.id === (m.inbox?.from.botId ?? botId)) });
            case "widget":
            case "app":
              return <RichMessageRow botId={botId} botName={botName} threadId={threadId} message={m} />;
            case "routine.run":
              return <RoutineRunRow message={m} botId={botId} />;
            case "call":
              return m.call ? <CallRecordRow message={m} transcript={transcript} botName={botName} threadId={threadId} busy={busy} hasMore={hasMore} /> : null;
            case "activity": {
              if (m.dataResult) return <DataResultChip message={m} />;
              if (isStatusActivity(m)) return <StatusActivityRow message={m} />;
              if (m.tool && failedTurnCause(m.tool.name) !== null) {
                // a reply that never came is said once, in the card above the composer
                return (
                  <FailedTurnRow
                    tool={m.tool}
                    engine={engine}
                    botId={botId}
                    threadId={threadId}
                    onRetry={m.id === lookups.retryableId && canRetryLast ? onRegenerate : undefined}
                  />
                );
              }
              return <ActivityChip message={m} place={place} />;
            }
            case "digest":
              return <DigestChip message={m} />;
            case "compaction":
              return null;
            case "screen":
              return <ScreenFrame threadId={threadId} message={m} />;
            default: {
              if (m.publishedPage) return <PublishedPageCard message={m} />;
              if (m.document) return <DocumentCard message={m} />;
              return (
                <Bubble
                  message={m}
                  emerging={m.id === emergingId}
                  eagerAttachments={m.id === newestMessageId || m.id === newestUserMessageId}
                  joinAbove={rowJoins[i]?.above}
                  joinBelow={rowJoins[i]?.below}
                  editing={editingId === m.id}
                  pinned={m.id === pinnedMessageId}
                  versions={lookups.editVersions(m)}
                  onStartEdit={onStartEdit}
                  onCancelEdit={onCancelEdit}
                  onSubmitEdit={onSubmitEdit}
                  onRegenerate={m.id === lastBotTextId && !m.automation ? onRegenerate : undefined}
                  replyTarget={lookups.replyTarget(m)}
                  onReply={onReply}
                  underExchangeLine={run !== undefined}
                />
              );
            }
          }
        })();
        if (!row) return (lead || dividerRow) && <div key={m.id} className="contents">{lead}{dividerRow}</div>;
        const tucked = layout.tucks[i] && !exchanges.closedAbove(i);
        return (
          // a send keeps its row when the server's copy replaces the optimistic one, so it never mounts or rises twice
          <div key={m.sendId ? `send:${m.sendId}` : m.id} className="contents" data-mid={m.id} data-tuck={tucked ? "" : undefined}>
            {lead}
            {dividerRow}
            {stamp}
            {m.inbox && <InboxCaption message={m} />}
            {row}{m.inbox?.answers && <InboxAnswers message={m} />}{m.inbox && <InboxCardSlot threadId={threadId} messageId={m.id} />}{m.setupOffer && <SetupOffer botId={botId} threadId={threadId} message={m} transcript={transcript} />}
          </div>
        );
      })}
    </>
  );
});

export function ChatView({ bot: profile }: { bot: Bot }) {
  const bot = useMemo(() => shownTranscript(currentTaskBot(profile)), [profile]);
  const transcriptPending = profile.transcriptLoaded === false;
  const { state, dispatch } = useStore();
  const remoteClient = window.madaniDesktop?.remoteClient?.active === true;
  const { dragProps: headerDragProps, noDragStyle: headerNoDragStyle } = useCaptionChrome();
  const composerDockRef = useRef<HTMLDivElement>(null);
  const composerDock = useComposerDockPad(composerDockRef, () => scrollRef.current);
  const phone = usePhoneLayout();
  const phoneMenu = phone && !remoteClient;
  const simpleHead = !remoteClient;
  const canWrite = useCanWriteIn(bot.threadId, bot.yourAccess);

  const browserPart = browserPartFor(state.browserPart, bot.id);
  const computerStarting = computerStartLine(state.computerStarts[bot.id], bot.name); useScreensWhile(Boolean(computerStarting));
  const mascotMotion = state.mascotMotion?.botId === bot.id ? state.mascotMotion : null;
  const [findOpen, setFindOpen] = useState(false);
  const { replyTo, selectReply, clearReply, consumeReply, restoreReply } = useReplyDraft(
    bot.threadId,
    `bot:${bot.id}:${bot.threadId}`,
    bot.messages,
  );
  useEffect(() => setFindOpen(false), [bot.threadId]);
  useChatFindRequests(bot.threadId, findOpen, setFindOpen);
  useEffect(() => {
    const onFind = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener("keydown", onFind);
    return () => window.removeEventListener("keydown", onFind);
  }, []);

  const { messages: allMessages, activeLeafId } = bot;
  const visible = useMemo(() => visibleMessages({ messages: allMessages, activeLeafId }), [allMessages, activeLeafId]);
  // Stop shows the turn over at the press: what the bot had said stays, what its turn says after never lands
  const press = useStopPress(bot.threadId);
  const stopCut = Boolean(press) && !((sentTurn(bot.threadId)?.at ?? 0) > press!.at);
  const pressedOn = useRef<{ at: number; ids: ReadonlySet<string> } | null>(null);
  if (!press) pressedOn.current = null;
  else if (pressedOn.current?.at !== press.at) pressedOn.current = { at: press.at, ids: new Set(visible.map((message) => message.id)) };
  const shownMessages = useMemo(() => withoutLateRows(visible, press, pressedOn.current?.ids), [visible, press]);
  // each new bot bubble waits for its "Typing…" beat on the status line before it lands; a Stop lets what was said land now
  const hold = useTypingHold(`${bot.id}:${bot.threadId ?? ""}`, shownMessages, bot.id, Boolean(bot.busy));
  const messages = stopCut ? shownMessages : hold.rows;
  const lookups = useMemo(() => transcriptLookups(allMessages, messages), [allMessages, messages]);
  const liveTools = useLiveToolIds(messages, bot);
  const showToolCalls = showToolCallsEnabled(state.config);
  const latestVisibleIndex = useMemo(() => messages.findLastIndex((message) => !hiddenChatRow(message, bot.id, showToolCalls)), [messages, bot.id, showToolCalls]);
  const focus = state.focusMessage?.threadId === bot.threadId ? state.focusMessage : null;

  const {
    scrollRef,
    clipRef,
    transcriptRef,
    topSentinelRef,
    transcriptKey,
    following,
    windowedMessages,
    hiddenCount,
    laterCount,
    olderPending,
    showLater,
    jumpToLatest,
    scrollHandlers,
  } = useTranscriptViewport({
    ownerId: bot.id,
    threadId: bot.threadId,
    messages,
    pinOn: [bot.busy, composerDock.pad],
    hasMore: bot.hasMore,
    latestVisibleIndex: latestVisibleIndex >= 0 ? latestVisibleIndex : undefined,
  });
  useTimestampPeek(scrollRef);

  const oldestId = allMessages[0]?.id;
  const historyKey = `${transcriptKey}:${state.transcriptGeneration[bot.threadId] ?? 0}:${oldestId}`;
  const attemptedEarlier = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!following || (focus && !focus.consumed) || transcriptPending || bot.transcriptStale || olderPending ||
        latestVisibleIndex >= 0 || !bot.hasMore || !oldestId || attemptedEarlier.current === historyKey) return;
    attemptedEarlier.current = historyKey;
    dispatch({ type: "loadOlderMessages", threadId: bot.threadId });
  }, [following, focus, transcriptPending, bot.transcriptStale, olderPending, latestVisibleIndex, bot.hasMore, oldestId, historyKey, bot.threadId, dispatch]);

  const lastBotTextId = useMemo(
    () => [...messages].reverse().find((m) => m.role === "bot" && m.kind === "text")?.id,
    [messages],
  );
  const unreadDivider = useUnreadDivider({ threadId: bot.threadId, messages, following });

  const bots = useDrawnBots(state.bots);
  const teammates = useTeammates(); const mentionPeers = useMemo(() => [...bots.filter((peer) => peer.id !== bot.id), ...teammates.peers], [bots, bot.id, teammates]);
  const tts = state.config?.tts;
  const localVoice = localSystemVoiceActive();
  const locale = activeLocale();
  const busy = Boolean(bot.busy);
  const openedAt = useThreadOpenedAt(bot.threadId);
  const colorMine = useColorUserBubbles();
  // your bubble takes one flat tone of the bot's colour
  const bubbleStyle = useMemo(() => {
    if (!colorMine) return undefined;
    const style = userBubbleStyle(bot.color, { flat: true });
    // chat.css lays grok's gloss over the fill, and the grok skins swap in grok's own fill for the colour
    const { backgroundImage: _flat, ...rest } = style;
    const grok = grokUserBubbleFill(bot.color);
    return grok ? { ...rest, backgroundColor: `var(--grok-bubble, ${String(style.backgroundColor)})`, "--grok-bubble-fill": grok } as typeof style : rest;
  }, [colorMine, bot.color]);
  const hasMore = Boolean(bot.hasMore);
  const reactor = useReactor();
  const speakerViewer = state.config?.team && reactor !== "user" ? reactor : null;
  const rows = useMemo<ChatRows>(
    () => ({ botId: bot.id, threadId: bot.threadId, botName: bot.name, botColor: bot.color, voiceId: bot.voice, tts, localVoice, hasMore, bots, mentionPeers, mentionPerson: { profileName: state.config?.profile?.name }, focus, showToolCalls, locale, dispatch, bubbleStyle, conversational: isConversational(bot.replyStyle), canReact: canWrite !== false, openedAt, speakerViewer }),
    [bot.id, bot.threadId, bot.name, bot.color, bot.voice, tts, localVoice, hasMore, bots, mentionPeers, state.config?.profile?.name, focus, showToolCalls, locale, dispatch, bubbleStyle, bot.replyStyle, canWrite, openedAt, speakerViewer],
  );
  const currentTask = bot.tasks?.find((task) => task.threadId === bot.threadId), place = effectivePlace(bot, currentTask), team = state.config?.team, privateChat = Boolean(team) && currentTask?.private === true, ownHelper = Boolean(team) && !privateChat && Boolean(bot.defaultBot?.person), sharedChat = Boolean(team) && !privateChat && !ownHelper;

  const [editingId, setEditingId] = useState<string | null>(null);
  useEffect(() => setEditingId(null), [bot.id, bot.threadId]);
  const startEdit = useCallback((id: string) => setEditingId(id), []);
  const cancelEdit = useCallback(() => setEditingId(null), []);
  const submitEdit = useCallback(
    (messageId: string, text: string) => {
      setEditingId(null); // closes the editor first, so a double Enter can't fork twice
      dispatch({ type: "editMessage", botId: bot.id, threadId: bot.threadId, messageId, text });
    },
    [bot.id, bot.threadId, dispatch],
  );
  const [lastUserMessage, lastTypedMessage] = useMemo(() => {
    const said = messages.filter((m) => m.role === "user" && m.kind === "text" && !peerLine(m));
    return [said.at(-1), said.findLast((m) => !m.reaction)];
  }, [messages]);
  const lastTypedMessageHasAttachments = useMemo(() => {
    if (!lastTypedMessage?.text) return false;
    const cited = withoutCitationMarkers(lastTypedMessage.text);
    const attached = splitTranscriptAttachments(cited);
    return cited !== lastTypedMessage.text || attached.images.length > 0 || attached.files.length > 0;
  }, [lastTypedMessage]);

  const lastMessage = lastNonReceipt(messages);
  // a first reply's wait is no phrase for the line: the line already says the bot is at work
  const lastForLine = useMemo(() => lastMessage?.tool?.rescue ? lastNonReceipt(messages.filter((m) => !m.tool?.rescue)) : lastMessage, [messages, lastMessage]);
  const live = useTurnLive(bot.threadId), now = useTurnNow(bot, messages, lastForLine, live);
  // a send from this window is the turn's start here: its row shows with the bubble, before the server answers the send
  const sent = useSentTurn(bot.threadId);
  useEffect(() => { if (bot.threadId) followSentTurn(bot.threadId, Boolean(bot.busy)); }, [bot.threadId, bot.busy]);
  const networkWait = waitsForNetwork(messages, useOffline());
  const turnBusy = Boolean(bot.busy) || sent?.phase === "sending";
  const turnStartedAt = sent?.at ?? bot.turnStartedAt;
  const landed = useLandedReply(`${bot.id}:${bot.threadId ?? ""}`, messages);
  // a reply takes the line's place in the frame it lands, even before the turn's end reaches this client; the line comes
  // back under it for a named step or once the turn has gone on a while
  const waiting = Boolean(turnBusy && bot.activity !== "waiting-on-you" && showWorkingDots(turnBusy, lastMessage, undefined, sent?.phase === "sending" ? false : live.ended))
    && !replyHidesLine(landed.sinceMs, now.phase);
  const teammatesWorking = !bot.busy && Boolean(bot.waitingForTeammates);
  // the reply is written whole; while the engine types it the mark only looks like it is answering
  const streamingReply = useLiveReplyActive(bot.threadId);
  const chatKey = `${bot.id}:${bot.threadId ?? ""}`;
  useChatSwitchMotion(scrollRef, chatKey);
  const [busyMark, setBusyMark] = useState<{ chat: string; at: number } | null>(null);
  useEffect(() => {
    setBusyMark(turnBusy ? { chat: chatKey, at: turnStartedAt ?? Date.now() } : null);
  }, [turnBusy, chatKey, turnStartedAt]);
  const busySince = busyMark?.chat === chatKey ? busyMark.at : null;
  const presenceSeed = `${chatKey}:${busySince ?? ""}`;
  // grok's line comes 0.55 to 1.2 s after a send, wordless; a bubble waiting on its typing beat brings it at once
  // a turn whose start this client does not know (a chat opened mid-turn from an older server) shows its line at once,
  // and so does a new bot's hello in a chat with nothing in it yet: there is no send for the wait to follow
  // a send from this window shows it at once: the person pressed Enter and is looking for the bot to pick it up
  const mountDelay = sent ? 0 : lifeDraw(presenceSeed, "mount", STATUS_MOUNT_MS);
  const mountDue = useReached(!turnBusy ? null : turnStartedAt && messages.length > 0 ? turnStartedAt + mountDelay : 0);
  // notes from another AI being brought in: the import's own steps are this bot's working row until its summary lands
  const importing = useNotesWork(bot.id);
  const presenceVisible = !stopCut && (hold.typing || (waiting && mountDue) || teammatesWorking || Boolean(importing) || networkWait);
  // while the turn runs its notices are the working row's to say, not the chat's too; once it ends, what it left is one
  // card above the composer
  const trailing = useTrailingRows(messages, !bot.busy);
  // the bubble the line hangs under keeps its pinched corner until the line has finished leaving, as grok's does
  const presenceLingers = useLingering(presenceVisible, STATUS_EXIT_MS);
  const expandedTail = following && latestVisibleIndex >= 0 && latestVisibleIndex < tailWindowStart(messages.length);
  const paintedMessages = useFirstPaintRows(transcriptKey, windowedMessages, expandedTail || Boolean(focus && !focus.consumed) || laterCount > 0, scrollRef, following);
  const lastShownRow = windowedMessages.findLast((message) => !quietRow(message, showToolCalls));
  const lastRowIsBubble = Boolean(lastShownRow && isBotTextRow(lastShownRow, bot.id));
  const presenceUnderBubble = lastRowIsBubble;
  const lastRowUnderLine = useRef<string | undefined>(undefined);
  if (presenceVisible) lastRowUnderLine.current = lastShownRow?.id;
  const replyTookLine = lastRowIsBubble && lastShownRow?.id !== lastRowUnderLine.current;
  // a reply landing as the line leaves takes its place in the same frame: the line fading on under it, pushed below the
  // new bubble, read as a flicker
  const presenceShown = presenceLingers && (presenceVisible || !replyTookLine);
  // grok keeps the status line's slot at the end of the conversation whether it shows or not, so it never moves a row
  const statusSlot = windowedMessages.length > 0 || busy;
  const announcement = useMemo((): TranscriptSnapshot => {
    const approval = pendingApprovals(messages)[0];
    return {
      busy: Boolean(bot.busy),
      reply: latestReply(messages, () => bot.name),
      failure: latestFailure(messages, () => bot.name),
      approval: approval ? { id: approval.requestId, name: bot.name } : undefined,
    };
  }, [messages, bot.busy, bot.name]);
  const writing = !stopCut && (streamingReply || live.status?.activity === "reply" || hold.typing);
  // the person's Stop, said once and quietly where the working line was, until the next turn
  const stoppedShown = (stopCut || personStoppedLast(messages)) && !(turnBusy && !stopCut) && !presenceVisible;
  const typingPhrases = useMemo(() => poolWords("typing"), [locale]);
  // the bot's own label stays on the line while it leaves, after the turn's end has cleared it
  const shownLabel = useRef<{ chat: string; seed: string; label?: string }>({ chat: chatKey, seed: presenceSeed });
  // a new turn starts clean; the end of this one (busySince gone) keeps it
  if (shownLabel.current.chat !== chatKey || (busySince !== null && shownLabel.current.seed !== presenceSeed)) shownLabel.current = { chat: chatKey, seed: presenceSeed };
  if (live.label) shownLabel.current.label = live.label;
  const turnLabel = live.label ?? shownLabel.current.label;
  const waitingOnSomeone = teammatesWorking || pendingApprovals(messages).length > 0;
  const stepFailed = lastForLine?.kind === "activity" && lastForLine.tool?.ok === false;
  const moodOfShownWords = (shown: string | null) => workingMood({ phase: shown && !shown.startsWith("label:") ? shown : writing ? TYPING_PHASE : now.phase, waiting: waitingOnSomeone, failed: stepFailed });
  const rescuing = useRescueGrace(Boolean(bot.busy), mayTakeOver(bot, state.instances), `${bot.id}:${bot.threadId}`);
  const answering = answeringModel(profile, bot.threadId, bot.modelSelection);
  const folded = useMemo(() => {
    const ids = new Set(foldedNoticeIds(trailing));
    if (!turnBusy) return ids;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i]!;
      if (message.role === "user") break;
      if (statusActivity(message)?.kind === "notice" && !message.tool?.rescue) ids.add(message.id);
    }
    return ids;
  }, [trailing, turnBusy, messages]);
  const clearLimitError = useCallback(() => dispatch({ type: "error", message: null }), [dispatch]);
  const regenerate = useCallback(() => {
    if (lastUserMessage?.text && !bot.busy && !lastUserMessage.id.startsWith("optimistic-")) {
      dispatch({ type: "editMessage", botId: bot.id, threadId: bot.threadId, messageId: lastUserMessage.id, text: lastUserMessage.text });
    }
  }, [lastUserMessage, bot.busy, bot.id, bot.threadId, dispatch]);

  const currentLink = profile.tasks?.find((task) => task.threadId === bot.threadId)?.link;
  const threadLink = useMemo(() => canWrite !== false
    ? { link: currentLink, assign: (link: string | null) => dispatch({ type: "updateTask", botId: bot.id, threadId: bot.threadId, patch: { link } }) }
    : null, [canWrite, currentLink, bot.id, bot.threadId, dispatch]);

  const routineRun = useThreadRoutineRun(bot.id, bot.threadId);
  // A run inside its own results conversation (a wait finishing in this chat) is no execution thread: no banner.
  const routineExecution = routineRun && (routineRun.resultsThreadId ?? routineRun.sourceThreadId) !== bot.threadId ? routineRun : undefined;
  const resultsThreadId = routineExecution?.resultsThreadId ?? routineExecution?.sourceThreadId;
  const canOpenResults = resultsThreadId && [...state.bots, ...state.groups].some((owner) => owner.threadId === resultsThreadId || owner.tasks?.some((task) => task.threadId === resultsThreadId));

  return (
    <ThreadLinkContext value={threadLink}>
    <main className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      {(liveCallEnabled() || voiceCallsEnabled()) && <CallOverlay bot={bot} />}
      <GlassScrollFrame className="flex-1 [--glass-tint:var(--color-app)]">
      {/* z-[25]: above the room set-up card (z-20), below the CallOverlay (z-30). */}
      <GlassBar edge="top" fade={!remoteClient} className="z-[25]">
      <div
        {...headerDragProps}
        className={cn(
          // A container query never matches the container itself, so the row that wraps is the child below.
          "@container/chathead",
          simpleHead ? "px-5 pt-2.5 pb-2.5 max-md:pl-14 max-md:pr-3" : "px-5 py-3 pl-11 md:pl-5 max-md:pl-14 max-md:pr-3",
        )}
      >
        <div data-chathead-row className={cn("flex items-center justify-between", phone ? "gap-2" : "@max-[30rem]/chathead:flex-wrap @max-[30rem]/chathead:gap-y-1 @min-[30rem]/chathead:grid @min-[30rem]/chathead:grid-cols-[minmax(0,1fr)_minmax(0,auto)_minmax(max-content,1fr)]")}>
        <div data-chathead-identity className={cn("flex min-w-0 items-center gap-2", phone ? "flex-1" : "@max-[30rem]/chathead:basis-full @min-[30rem]/chathead:col-start-2 @min-[30rem]/chathead:justify-self-center", simpleHead && phone && "justify-center")} style={headerNoDragStyle}>
          {simpleHead ? (
            <ChatHeadPill
              bot={bot}
              // grok's header mark is a still image
              avatar={{ state: "idle", motion: mascotMotion?.kind ?? "none", motionKey: mascotMotion?.nonce ?? 0, animated: false }}
              privacy={privateChat ? { kind: "private" } : ownHelper ? { kind: "ownHelper" } : sharedChat && team ? { kind: "shared", team: team.name, onlyPeopleAdded: bot.onlyPeopleAdded } : null}
              onToggle={() => dispatch({ type: "toggleSettings", open: !state.settingsOpen })}
            />
          ) : (
            <button
              type="button"
              data-chathead-pill data-tour="bot-pill"
              aria-expanded={state.settingsOpen} aria-controls={state.settingsOpen ? "bot-panel" : undefined}
              onClick={() => dispatch({ type: "toggleSettings" })}
              title={t("chat.openProfile")}
              aria-label={t("chat.openProfileAria", { name: bot.name })}
              className={cn("group flex h-9 min-w-0 items-center gap-2.5 rounded-full py-0.5 pl-2 pr-3.5 text-ink", ELEVATED_FLOAT, ELEVATED_HOVER)}
            >
              <BotAvatar bot={bot} state="idle" size={24}
                motion={mascotMotion?.kind ?? "none"} motionKey={mascotMotion?.nonce ?? 0} animated={false} />
              <span className="min-w-0 truncate text-[14px] font-medium text-ink">{bot.name}</span>
              {chiefOfStaffBadge(bot)}
              <ChevronRight size={14} aria-hidden="true" className="-ml-2.5 w-0 shrink-0 text-ink-secondary opacity-0 transition-[width,margin,opacity] duration-150 group-hover:ml-0 group-hover:w-3.5 group-hover:opacity-100 group-focus-visible:ml-0 group-focus-visible:w-3.5 group-focus-visible:opacity-100" />
            </button>
          )}
          {!phone && !simpleHead && <ChatHeadRole bot={bot} />}<span role="status" className="sr-only" data-chathead-status>{bot.busy ? t("sidebar.preview.working") : ""}</span>{!simpleHead && privateChat && <TeamPrivateHeader />}{!simpleHead && ownHelper && <TeamOwnHelperHeader />}{!simpleHead && sharedChat && team && <TeamSharedHeader team={team} onlyPeopleAdded={bot.onlyPeopleAdded} />}
          {!simpleHead && !bot.busy && bot.waitingForTeammates && <span className="truncate text-[12px] text-ink-secondary" role="status">{t("chat.teammatesWorking")}</span>}
          {remoteClient && awayFromMainThread(profile) && (
            <button
              type="button"
              data-chathead-back
              onClick={() => openBot(dispatch, profile)}
              className="shrink-0 whitespace-nowrap rounded-full bg-raised px-2.5 py-0.5 text-[12px] font-medium text-ink-secondary hover:bg-raised-hover hover:text-ink"
            >
              {t("chat.backToMainThread")}
            </button>
          )}
        </div>
        <div
          data-chathead-controls
          className={cn("flex shrink-0 items-center gap-2", !phone && "@max-[30rem]/chathead:ml-auto @max-[30rem]/chathead:flex-wrap @max-[30rem]/chathead:justify-end @min-[30rem]/chathead:col-start-3 @min-[30rem]/chathead:justify-self-end")}
        >
          {!simpleHead && (bot.busy || bot.waitingForTeammates) && !stopCut && (
            <button
              onClick={() => dispatch({ type: "interrupt", botId: bot.id, threadId: bot.threadId })}
              className={cn(
                "flex items-center gap-1.5 rounded-full border border-transparent bg-raised/60 px-2.5 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink",
                COMPACT_BUBBLE,
              )}
              title={t("chat.stopTurn")}
            >
              <Square size={12} className="fill-current" />
              <span className="@max-4xl/chathead:hidden">{t("chat.stop")}</span>
            </button>
          )}
          <ThreadContextWarning bot={bot} messages={messages} />
          {phone && <UsageAlert engine={bot.modelSelection?.instanceId} />}
          {/* Simple mode chooses the model in the bot panel's Details, as its header is the bot's pill alone. */}
          {!phone && !simpleHead && <ModelPicker key={bot.threadId} bot={bot} threadId={bot.threadId} />}
          {liveCallEnabled() && <LiveCallChip currentBotId={bot.id} onOpen={(botId, threadId) => openThread(dispatch, { botId, threadId }, state)} />}
          {/* Grok's header is the bot's pill alone: the pill opens the panel, whose Computer tab shows the bot's screen. */}
          {!phoneMenu && !simpleHead && <button
            data-tour="computer"
            onClick={() => dispatch({ type: "toggleComputer", open: true })}
            className={cn(
              "relative",
              "flex size-8 items-center justify-center rounded-full transition-colors hover:bg-ink/[0.06]",
              "text-ink-secondary hover:text-ink",
            )}
            title={t("chat.computer")} aria-label={busy && place === "browser" ? `${t("chat.computer")}, ${lowerFirst(t("place.live"))}` : t("chat.computer")}
          >
            <Monitor size={18} />{busy && place === "browser" && <span aria-hidden="true" className="absolute right-1 top-1 size-1.5 animate-pulse rounded-full bg-success" data-testid="computer-button-live" />}
          </button>}
          {phoneMenu ? <ChatMoreMenu bot={bot} phoneHeader /> : remoteClient && <ChatHeaderMenu key={`menu:${bot.threadId}`} bot={bot} />}
        </div>
        </div>
      </div>

      {privateChat && team && <TeamPrivateFirstLine key={team.id} team={team} />}
      {routineExecution && <div className="mx-5 mb-2 flex min-h-8 flex-wrap items-center gap-1 rounded-[14px] bg-composer py-1 pe-1 ps-3 text-[12px] leading-4 text-ink-secondary ring-[0.5px] ring-transparent">
        <span className="min-w-0 flex-1 truncate">{t("routines.executionDetails", { name: routineExecution.routineName })}</span>
        {canOpenResults && resultsThreadId && <button type="button" onClick={() => openThread(dispatch, { botId: bot.id, threadId: resultsThreadId }, state)} className="h-6 rounded-full px-2 text-ink transition-colors hover:bg-ink/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">{t("routines.results.back")}</button>}
        <button type="button" onClick={() => dispatch({ type: "openRoutine", routineId: routineExecution.routineId, botId: bot.id })} className="h-6 rounded-full px-2 transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">{t("routines.inline.open")}</button>
      </div>}
      {findOpen && <ChatFindBar threadId={bot.threadId} onClose={() => setFindOpen(false)} />}

      <PinnedBanner
        bot={bot}
        pinnedId={bot.pinnedMessageId}
        messages={messages}
        onJump={(messageId) =>
          dispatch({ type: "focusMessage", threadId: bot.threadId, messageId })
        }
        onUnpin={remoteClient ? undefined : () =>
          dispatch({ type: "updateTask", botId: bot.id, threadId: bot.threadId, patch: { pinnedMessageId: "" } })
        }
      />


      </GlassBar>

      <div
        ref={scrollRef}
        // grok insets its transcript and composer 16px from the pane's edges
        className="glass-scroller h-full overflow-x-hidden overflow-y-auto overscroll-y-contain px-4 [overflow-anchor:none]"
        // the composer sits on plain canvas, so a row scrolled into view stops clear of it
        style={{ scrollPaddingBottom: composerDock.pad }}
        {...scrollHandlers}
      >
        <div ref={clipRef}>
        <div
          ref={transcriptRef}
          // groups sit 16px apart
          data-simple-rows=""
          className="glass-scroller-content chat-column relative flex w-full flex-col gap-4 rounded-[18px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          data-dock-pad=""
          // 64px between the last row and the composer (grok leaves 54), so the working line has room above the message box
          style={{ paddingBottom: `calc(${composerDock.pad} + ${SIMPLE_TRAILING_GAP - (statusSlot ? SIMPLE_STATUS_SLOT : 0)}px)` }}
          role="log"
          aria-busy={transcriptPending || undefined}
          // focusable like grok's transcript, so the keyboard can scroll it
          tabIndex={0}
          // off: a polite log re-reads every tick and chip while the bot works; TranscriptAnnouncer speaks once when
          // done.
          aria-live="off"
          aria-label={t("chat.conversationWith", { name: bot.name })}
        >
          {olderPending ? (
            <div className="flex items-center justify-center gap-2 py-3 text-xs text-ink-tertiary">
              <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
              <span>{t("chat.loadingEarlier")}</span>
            </div>
          ) : hiddenCount > 0 || bot.hasMore ? (
            <div ref={topSentinelRef} className="h-2 w-full pointer-events-none" aria-hidden="true" />
          ) : null}
          {windowedMessages.length === 0 && !bot.busy && !transcriptPending && <EmptyChat bot={bot} />}
          <ChatRowsContext.Provider value={rows}><LiveToolsContext value={liveTools}><ChatBusyContext value={busy}><FoldedNoticesContext value={folded}>
            <MessagesList
              messages={paintedMessages}
              transcript={messages}
              lookups={lookups}
              place={place}
              pinnedMessageId={bot.pinnedMessageId}
              today={localDay(Date.now())}
              editingId={editingId}
              lastBotTextId={lastBotTextId}
              emergingId={null}
              canRetryLast={!bot.busy && Boolean(lastUserMessage)}
              engine={state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId)}
              unreadDividerId={unreadDivider.messageId}
              unreadDividerFading={unreadDivider.fading}
              onStartEdit={startEdit}
              onCancelEdit={cancelEdit}
              onSubmitEdit={submitEdit}
              onRegenerate={regenerate}
              onReply={selectReply}
              seamId={lastRowIsBubble && presenceShown ? lastShownRow?.id ?? null : null}
            />
          </FoldedNoticesContext></ChatBusyContext></LiveToolsContext></ChatRowsContext.Provider>
          {laterCount > 0 && (
            // clear of the jump-to-latest button, which floats over the transcript's last 40px while this shows
            <div className="mb-10 flex justify-center">
              <button
                onClick={showLater}
                className="ui-pill"
              >
                {t("chat.showLater", { count: laterCount })}
              </button>
            </div>
          )}
          {browserPart && (
            <div className="flex justify-start">
              <BrowserPartLine part={browserPart} />
            </div>
          )}
          {computerStarting && (
            <div className="flex justify-start">
              <div className="ui-pill">
                <WorkingDots size={3.5} />
                {computerStarting}
              </div>
            </div>
          )}
          <TranscriptCardSlot key={transcriptKey}><FailedReplyCard rows={rescuing ? null : trailing} botId={bot.id} threadId={bot.threadId} onRetry={lastUserMessage ? regenerate : undefined} /></TranscriptCardSlot>
          <div className={statusSlot ? cn("turn-status-slot h-9 shrink-0", presenceUnderBubble && SIMPLE_STACKED) : "contents"}>
          {(presenceVisible || presenceShown) && <TurnPresence
            key={chatKey}
            avatar={(shown) => <WorkingMascot bot={bot} size={phoneApp() ? 24 : 26} seed={presenceSeed} mood={moodOfShownWords(shown)} />}
            wordsAtOnce
            simple
            className={cn(!statusSlot && presenceUnderBubble && SIMPLE_STACKED)}
            label={networkWait ? t("mobile.chat.waitingForConnection") : teammatesWorking ? t("chat.teammatesWorking") : importing && !turnBusy ? importing : undefined}
            visible={presenceVisible}
            {...now}
            // grok shows no steps in the chat: the list under the line only with tool calls shown
            card={showToolCalls ? now.card : undefined}
            phrases={networkWait || teammatesWorking || (importing && !turnBusy) ? undefined : writing ? typingPhrases : turnLabel ? [turnLabel] : now.phrases}
            phase={writing ? TYPING_PHASE : turnLabel ? `label:${turnLabel}` : now.phase}
            seed={presenceSeed}
            since={busySince ?? (turnBusy ? turnStartedAt ?? null : null)}
          />}
          {stoppedShown && !presenceShown && (
            <div data-turn-stopped role="status" className={cn("turn-stopped flex h-9 items-center ps-3 text-[13px] text-ink-tertiary", !statusSlot && presenceUnderBubble && SIMPLE_STACKED)}>
              {t("chat.turnStopped")}
            </div>
          )}
          </div>
        </div>
        </div>
      </div>

      <TranscriptAnnouncer threadKey={transcriptKey} snapshot={announcement} />

      <div ref={composerDockRef} data-grok-inset="" className="pointer-events-none absolute inset-x-0 bottom-0 z-[2] chat-column-dock">
      {!following && (
        <div className="relative">
          <JumpToLatestButton onClick={jumpToLatest} className="pointer-events-auto bottom-2" />
        </div>
      )}
      {/* every card above the composer comes and goes through one slot, so the composer and the chat never jump; each row
          stays mounted and its card decides whether it shows */}
      <ComposerNoticeSlot>
        {/* grok's usage warning rides just above the composer, near or at a limit; a failed reply's card already says so, so it wins */}
        {canWrite !== false && !rescuing && !trailing?.failures.length && !(lastShownRow && codexUsageLimitReached(`${lastShownRow.text ?? ""} ${lastShownRow.tool?.name ?? ""}`)) && (
          // empty, it takes no room: its padding coming and going with a turn moved the whole chat 8px
          <div className="pointer-events-auto px-5 pb-2 empty:hidden">
            <WeeklyLimitLine onSeeUsage={() => dispatch(openSettings("usage"))} error={state.error} clearError={clearLimitError} />
            <UsageBanner engine={answering.instanceId} onSeeUsage={() => dispatch(openSettings("usage"))} />
          </div>
        )}
        {/* grok says what went wrong, or a passing note, in one quiet line just above the message box; at the top it ran
            into the transcript's first time stamp */}
        <div className="pointer-events-auto"><ChatNotice notice={state.notice} /></div>
        <div className="pointer-events-auto"><ChatErrorBanner message={state.error} onDismiss={() => dispatch({ type: "error", message: null })} /></div>
        <div className="pointer-events-auto">{canWrite !== false && !trailing?.failures.length && !trailing?.notices.length && <ComposerSignInNotice bot={bot} />}</div>
        <div className="pointer-events-auto">{!trailing?.failures.length && <ScreenAccessNotice bot={bot} />}</div>
      </ComposerNoticeSlot>
      {liveCallEnabled() && <LiveCallBar bot={bot} />}
      {canWrite === false ? (
        <NewConversationInstead bot={bot} onNew={() => dispatch({ type: "newTask", botId: bot.id })} />
      ) : (
      <Composer
        key={bot.threadId}
        bot={profile}
        replyTo={replyTo}
        onClearReply={clearReply}
        onConsumeReply={consumeReply}
        onRestoreReply={restoreReply}
        onEditLast={lastTypedMessage && !lastTypedMessageHasAttachments && !bot.busy && !lastTypedMessage.id.startsWith("optimistic-")
          ? () => setEditingId(lastTypedMessage.id)
          : undefined}
      />
      )}
      </div>
      </GlassScrollFrame>

    </main>
    </ThreadLinkContext>
  );
}
