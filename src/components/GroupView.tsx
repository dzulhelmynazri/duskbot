import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import { usePhoneLayout } from "@/lib/use-media-query";
import { waitsForNetwork } from "@/state/network-wait";
import { useOffline } from "@/mobile/network";
import { splitReplyBlocks } from "@/lib/formatted-reply";
import { activeLocale, t } from "@/lib/i18n";
import { useReactor } from "@/lib/cloud-guest";
import { otherSpeaker } from "@/lib/own-profile";
import { Check, ChevronDown, FolderOpen, Loader2, Pin, X } from "../icons";
import {
  api,
  useStore,
  formatTime,
  openRoomThread,
  openThread,
  shownTranscript,
  type Bot,
  type Group,
  type GroupDefaultResponder,
  type Message,
} from "@/state/store";
import { BotAvatar } from "./Avatar";
import { ScreenFrame } from "./ScreenFrame";
import { noteMediaSizes } from "@/lib/image-cache";
import { RoomHoldsBanner } from "./RoomHoldsBanner";
import { ThreadChip } from "./ThreadChip";
import { ToolActivity } from "./ToolActivity";
import { ThreadRefText } from "./ThreadRefs";
import { handoffWorkIds, RoomWorkingLines, roomWorkingIds } from "./RoomWorkingLines";
import { roomRetryRequest, roomRetryText } from "@/lib/room-retry";
import { showToolCallsEnabled } from "@/lib/feature-flags";
import { DigestChip } from "./DigestChip";
import { roomActivityVisible } from "@/lib/room-activity";
import { StatusActivityRow } from "@/components/StatusActivityRow"; import { BugReportNote } from "@/components/BugReportNote";
import { normalizeState } from "@/lib/mascot";
import { groupResponseHint, jevRoomRoutingOn } from "@/lib/group-routing";
import { ChatMarkdown } from "./ChatMarkdown";
import { FailedTurnRow, MessageBoundary, SIMPLE_STATUS_SLOT, SIMPLE_TRAILING_GAP, statusMarkFor } from "./ChatView";
import { presenceKind, turnWorked, useHeldPresence, workingMark } from "@/lib/presence-mark";
import { emojiOnly, EMOJI_ONLY_TEXT, joinedCorners, needsStamp, SIMPLE_BOT_BUBBLE, SIMPLE_BUBBLE_MAX, SIMPLE_BUBBLE_TEXT, SIMPLE_STACKED, SIMPLE_USER_BUBBLE, type BubbleJoin } from "./chat-bubble";
import { roomRowLayout, type RoomSlot } from "./room-row-layout";
import { DaySeparator } from "./DaySeparator";
import { useThreadOpenedAt } from "./ConversationalReply";
import { useTimestampPeek } from "./chat-timestamp-peek";
import { useTurnNow } from "./NowCard";
import { useLiveReplyActive } from "@/state/live-reply";
import { ReplyBlocks } from "./ReplyBlocks";
import { CopyButton, MESSAGE_ROW, MessageActions, messageActionClass, ReplyAction } from "./MessageActions";
import { ReactAction, ReactionChips, useCanReact } from "./Reactions";
import { ClusterLabel } from "./RoomClusterLabel";
import { roomPin, useBotMessageMenu, userMessageMenu } from "./message-menu";
import { SpeakButton } from "./SpeakButton";
import { useSpeech } from "@/lib/tts/useSpeech";
import { localSystemVoiceActive } from "@/lib/local-voice";
import { isCancelledTranscriptRow } from "../../shared/client-cancel";
import { botEngine, failedTurnCause } from "@/lib/failed-turn";
import { RoomComposer } from "./bot-access/RoomComposer";
import { ChatErrorBanner, ChatNotice } from "./ChatErrorBanner"; import { ComposerNoticeSlot } from "./ComposerNoticeSlot";
import { FailedReplyCard, FoldedNoticesContext, foldedNoticeIds, useTrailingRows } from "./FailedReplyCard";
import { TranscriptCardSlot } from "./TranscriptCardSlot";
import { RoomContextWarnings } from "./ContextWarning";
import { ChatFindBar } from "./ChatFindBar";
import { botTextForDisplay, isPureLeakedBotText } from "../../shared/system-message-guard.ts";
import { QuotedText, ThreadReplyQuote } from "./ReplyQuote";
import { ConnectorCard } from "./ConnectorCard";
import { SecretRequestCard } from "./SecretRequestCard";
import { SignInRequestCard } from "./SignInRequestCard";
import { hasRoutineExecutionTask, RoutineRunCard } from "./RoutineRunCard";
import { GoalRunCard } from "./GoalRunCard";
import { AttachmentGallery, MessageAttachmentGallery, replyAttachmentGroup } from "./AttachmentGallery";
import { VoiceNoteBubble, type VoiceNoteAttachment } from "./VoiceNoteBubble";
import { OptionCard } from "./OptionCard";

import { ApprovalCard, SettledChangeEvent, showsSettledChange } from "./ApprovalCard";
import { settledCardStays } from "./OptionsCardRow";
import { isQuestionCard, QuestionCard } from "./QuestionCard";
import { ManageMembersPanel } from "./ManageMembersPanel";
import { groupActivityRuns, isStatusActivity } from "@/lib/activity-runs";
import { ActivityRun } from "./ActivityRun";
import { cn } from "@/lib/cn";
import { useMenuMotion } from "./MenuMotion";
import { useLiveToolIds } from "@/hooks/use-live-tool-ids";
import { roomNeedsSetup } from "@/lib/room-setup";
import { useComposerDockPad } from "@/lib/composer-dock";
import { GlassBar, GlassScrollFrame } from "./GlassScrollFrame";
import { awaitedMemberId, replyHidesLine, showWorkingDots } from "@/lib/turn-tail";
import { useLandedReply } from "@/hooks/use-landed-reply";
import { useTurnLive } from "@/state/turn-status";
import { splitTranscriptAttachments } from "@/lib/composer-attachments";
import { useTranscriptViewport } from "@/hooks/use-transcript-viewport";
import { useUnreadDivider } from "@/hooks/use-unread-divider";
import { unreadMessageIds } from "@/lib/unread-divider";
import { NewMessagesDivider } from "./NewMessagesDivider";
import { PeerExchangeLine } from "./PeerExchangeLine";
import { useExchangeRows } from "@/hooks/use-exchange-runs";
import { useReplyDraft } from "@/lib/drafts";
import { withoutCitationMarkers } from "@/lib/citations";
import { latestFailure, latestReply, type TranscriptSnapshot } from "@/lib/transcript-announcer";
import { pendingApprovals } from "./PendingApproval";
import { DataResultChip } from "./DataResultChip"; import { PublishedPageCard } from "./PublishedPageCard"; import { DocumentCard } from "./documents/DocumentCard";
import { TranscriptAnnouncer } from "./TranscriptAnnouncer";
import { localDay } from "@/lib/transcript-derivations";
import { roomThreadWorking } from "@/lib/room-threads";
import { JumpToLatestButton } from "./JumpToLatestButton";
import { HandoffChip } from "./HandoffReply"; import { HandoffRow } from "./HandoffRow"; import { TeammateChip } from "./TeammateChip"; import { useTeammates } from "@/state/team-people";
import { RoomWorkingFolder } from "./RoomWorkingFolder";
import { RoomBulletin } from "./RoomBulletin";
import { RoomHeader } from "./RoomHeader";
import { mdPrimaryCls, mdSecondaryCls, textAreaCls, textFieldCls } from "./ui/GrokDialog";
import { useChatFindRequests } from "@/lib/chat-find";
import { simpleRoomHeader } from "@/lib/room-panel";
import { friendlyError } from "@/lib/plain-error";

export function RoomToolChip({ message, roomId, threadId, live = false }: { message: Message; roomId?: string; threadId?: string; live?: boolean }) {
  const { state, dispatch } = useStore();
  const tool = message.tool;
  if (!tool) return null;
  if (message.threadRef) return <ThreadChip message={message} />; if (message.relay) return <TeammateChip message={message} />;
  if (failedTurnCause(tool.name) !== null) {
    // a reply that never came is said once, in the card above the composer
    if (!tool.partial) return null;
    return <FailedTurnRow tool={tool} engine={botEngine(state.bots.find((b) => b.id === message.from?.botId), state.instances)} botId={message.from?.botId} />;
  }
  const comm = message.comm;
  if (comm && message.handoff && (tool.ok !== false || message.handoff.phase === "result")) {
    return <HandoffRow message={message} />;
  }
  if (comm && comm.groupId !== roomId) {
    return <HandoffChip message={message} bots={state.bots} title={t("room.openBot", { name: comm.withName })} onClick={() => openRoomThread(dispatch, comm, state.groups)} />;
  }
  if (!comm) return <ToolActivity tool={tool} live={live} source={threadId ? { threadId, messageId: message.id } : undefined} />;
  return (
    <div className="flex justify-start">
      <div
        className={cn(
          "ui-pill",
          tool.ok === false && "text-danger",
        )}
      >
        {comm && <BotAvatar bot={state.bots.find(b => b.id === comm.withBotId) ?? { name: comm.withName, color: comm.withColor }} state="happy" size={16} animated={false} />}
        <span className={cn("max-w-[480px] truncate", !comm && "font-mono")}>{tool.name}</span>
      </div>
    </div>
  );
}

const USER_COLLAPSE_CHARS = 600;
const USER_COLLAPSE_LINES = 8;

function RoomTextMessage({
  group,
  message: m,
  members,
  transcript,
  emerging,
  eager,
  onReply,
  canReact,
  join = NO_JOIN,
  fresh = false,
}: {
  group: Group;
  message: Message;
  members: Bot[];
  transcript: Message[];
  emerging: boolean;
  eager: boolean;
  onReply: (message: Message) => void;
  canReact: boolean;
  /** Simple mode: this bubble meets the one above (or below) from the same sender. */
  join?: BubbleJoin;
  /** The row arrived while the room was open, so it rises into place. */
  fresh?: boolean;
}) {
  const { state, dispatch } = useStore();
  const user = m.role === "user";
  const reactor = useReactor();
  const speaker = otherSpeaker(m, state.config?.team && reactor !== "user" ? reactor : null);
  const rawText = user ? (m.text ?? "") : botTextForDisplay(m.text ?? "");
  const attachments = user && m.text ? splitTranscriptAttachments(withoutCitationMarkers(m.text)) : null;
  const display = attachments?.display ?? rawText;
  const [expanded, setExpanded] = useState(false);
  const speech = useSpeech();
  const speaking = speech.messageId === m.id && speech.status !== "idle";
  const focus = state.focusMessage;
  const focusedSearch = focus?.messageId === m.id && Boolean(focus.matchText) && focus.threadId === group.threadId;
  const collapsible = user && !expanded && (display.length > USER_COLLAPSE_CHARS || display.split("\n").length > USER_COLLAPSE_LINES);
  useEffect(() => { if (focusedSearch && collapsible) setExpanded(true); }, [focusedSearch, collapsible, focus?.nonce]);
  const mediaRow = Boolean(attachments && (attachments.images.length || attachments.files.length));
  const bigEmoji = !m.replyToId && !mediaRow && !m.attachments?.length && emojiOnly(display);
  const speakerBot = members.find((member) => member.id === m.from?.botId);
  const botText = rawText; const teammates = useTeammates(); const peers = useMemo(() => [...members, ...teammates.peers], [members, teammates]);
  const pin = roomPin(group, m, dispatch);
  const botMenu = useBotMessageMenu({
    text: botText,
    botId: speakerBot?.id,
    messageId: m.id,
    voiceId: speakerBot?.voice,
    tts: state.config?.tts,
    localVoice: localSystemVoiceActive(),
    canSpeak: true,
    pin,
  });
  noteMediaSizes(m.media);
  const replyGroup = useMemo(() => !user && botText.trim() ? replyAttachmentGroup(botText, m.attachments) : null, [user, botText, m.attachments]);
  const blocks = useMemo(() => !user && botText.trim() ? splitReplyBlocks(botText) : null, [user, botText]);
  const tabled = Boolean(blocks?.some((block) => block.kind === "table"));
  const bubbleGroup = Boolean(tabled || (!user && !m.text?.trim() && !m.replyToId && m.attachments?.length) || (mediaRow && !display.trim() && !m.replyToId));
  const botActions = !user && (
    <MessageActions side="bot" forceOpen={speaking} menu={botMenu}>
      <ReplyAction onReply={() => onReply(m)} />
      {canReact && m.from && <ReactAction threadId={group.threadId} message={m} />}
      {botText && <CopyButton text={botText} className={messageActionClass} />}
      {botText && speaking && <SpeakButton text={botText} botId={speakerBot?.id} messageId={m.id} voiceId={speakerBot?.voice} tts={state.config?.tts} localVoice={localSystemVoiceActive()} className={cn(messageActionClass, "text-accent")} />}
    </MessageActions>
  );
  return (
    <div {...{ [MESSAGE_ROW]: "" }} data-sent-at={m.at || undefined} data-arrival={fresh ? (user ? "end" : "start") : undefined} className={cn("group relative flex w-full flex-col", user ? "items-end" : "items-start", join.above && SIMPLE_STACKED)}>
      {speaker && <div className="mb-0.5 px-1 text-[12px] font-medium text-ink-secondary">{speaker}</div>}
      {mediaRow && attachments && <AttachmentGallery media={m.media} images={attachments.images} files={attachments.files} message={{ threadId: group.threadId, messageId: m.id }} eager={eager} align="end" className={display.trim() ? "mb-1" : undefined} />}
      <div data-own-row={user ? "" : undefined} className={cn("flex w-full items-center gap-1.5", user ? "justify-end" : "justify-start")}>
        {user && (
          <MessageActions side="user" menu={userMessageMenu({ pin })}>
            <ReplyAction onReply={() => onReply(m)} />
            {Boolean(display.trim()) && <CopyButton text={display} className={messageActionClass} />}
          </MessageActions>
        )}
        <div
          data-chat-bubble="simple"
          className={cn(
            tabled ? "w-full" : "w-fit",
            !tabled && SIMPLE_BUBBLE_MAX, SIMPLE_BUBBLE_TEXT,
            !user && emerging && "turn-answer",
            !tabled && joinedCorners(user ? "end" : "start", join),
            bigEmoji && !tabled
              ? EMOJI_ONLY_TEXT
              : bubbleGroup
              ? "text-ink"
              : user
                ? cn("chat-text whitespace-pre-wrap [overflow-wrap:anywhere] text-ink", SIMPLE_USER_BUBBLE)
                : SIMPLE_BOT_BUBBLE,
          )}
          data-emoji-only={bigEmoji && !tabled ? "" : undefined}
          data-bubble-group={bubbleGroup ? "" : undefined}
          data-quotable={user ? undefined : ""}
          data-sending={user && m.id.startsWith("optimistic-") ? t("chat.sending") : undefined}
        >
          {m.replyToId && (
            <ThreadReplyQuote
              threadId={group.threadId}
              replyToId={m.replyToId}
              loaded={transcript.find((candidate) => candidate.id === m.replyToId)}
              fallbackName={t("room.fallbackBot")}
              onJump={(target) => dispatch({ type: "focusMessage", threadId: group.threadId, messageId: target.id })}
            />
          )}
          {user ? (
            <>
              {attachments && !mediaRow && <AttachmentGallery media={m.media} images={attachments.images} files={attachments.files} message={{ threadId: group.threadId, messageId: m.id }} eager={eager} className={!attachments.display ? "mb-0" : undefined} />}
              <div className={cn(collapsible && "max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]")}>
                <QuotedText text={display} render={(rest) => <ThreadRefText text={rest} peers={peers} everyone={!group.dm} />} />
              </div>{m.bugReport && <BugReportNote report={m.bugReport} />}
              {m.via === "api" && (
                <div className="mt-1 text-[11px] text-ink-tertiary">{t("chat.viaBotApi")}</div>
              )}
              {collapsible && (
                <button type="button" onClick={() => setExpanded(true)} className="mt-1 text-[13px] text-ink-secondary hover:text-ink pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center">
                  {t("chat.showFull")}
                </button>
              )}
              {expanded && (
                <button type="button" onClick={() => setExpanded(false)} className="mt-1 text-[13px] text-ink-secondary hover:text-ink pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center">
                  {t("chat.showLess")}
                </button>
              )}
            </>
          ) : (
            <MessageBoundary fallbackText={botText || t("chat.generatedImage")}>
              {(m.attachments ?? []).some((attachment) => attachment.kind === "audio") && (
                <div className={cn("flex flex-col", (m.text || (m.attachments ?? []).some((attachment) => attachment.kind === "image")) && "mb-2")}>
                  {m.attachments!.filter((attachment): attachment is VoiceNoteAttachment => attachment.kind === "audio").map((note) => (
                    <VoiceNoteBubble key={note.path} attachment={note} />
                  ))}
                </div>
              )}
              {!botText.trim() && <MessageAttachmentGallery media={m.media} text={botText} attachments={m.attachments} message={{ threadId: group.threadId, messageId: m.id }} className={m.text ? undefined : "mb-0"} eager={eager} />}
              {tabled && blocks ? (
                <ReplyBlocks blocks={blocks} tray={botActions}
                  render={(block) => <ChatMarkdown text={block} mentionPeers={peers} everyone={!group.dm} mentionPerson={{ profileName: state.config?.profile?.name }} message={{ threadId: group.threadId, messageId: m.id }} delivered={replyGroup?.delivered} />} />
              ) : botText ? (
                <ChatMarkdown text={botText} mentionPeers={peers} everyone={!group.dm} mentionPerson={{ profileName: state.config?.profile?.name }} message={{ threadId: group.threadId, messageId: m.id }} delivered={replyGroup?.delivered} />
              ) : null}
              {replyGroup && <AttachmentGallery media={m.media} images={replyGroup.pictures} files={replyGroup.files} message={{ threadId: group.threadId, messageId: m.id }} eager={eager} beneath />}
            </MessageBoundary>
          )}
        </div>
        {!tabled && botActions}
      </div>
      <time dateTime={new Date(m.at).toISOString()} className="chat-row-ts" aria-label={new Date(m.at).toLocaleTimeString()}>{formatTime(m.at)}</time>
      <ReactionChips threadId={group.threadId} message={m} bots={members} align={user ? "end" : "start"} canReact={canReact} />
    </div>
  );
}

const NO_JOIN: BubbleJoin = { above: false, below: false };

type RoomItem = { kind: "message"; message: Message } | { kind: "run"; messages: Message[] };
const roomItemRows = (item: RoomItem): readonly Message[] => item.kind === "run" ? item.messages : [item.message];
const noneTransparent = () => false;
const hiddenRuns = (item: RoomItem) => item.kind === "run";

export const Transcript = memo(function Transcript({
  group,
  members,
  locale,
  messages,
  transcript,
  emergingId,
  unreadDividerId = null,
  unreadDividerFading = false,
  onReply,
  seamId = null,
}: {
  group: Group;
  members: Bot[];
  locale: string;
  messages: Message[];
  transcript: Message[];
  emergingId?: string | null;
  unreadDividerId?: string | null;
  unreadDividerFading?: boolean;
  onReply: (message: Message) => void;
  /** The bubble the working line hangs under: its bottom corner pinches as if another bubble followed. */
  seamId?: string | null;
}) {
  const { state, dispatch } = useStore();
  const showToolCalls = showToolCallsEnabled(state.config);
  const openedAt = useThreadOpenedAt(group.threadId);
  const today = localDay(Date.now());
  const canReact = useCanReact(group.threadId);
  const memberOf = (id?: string) => members.find((b) => b.id === id);
  // a turn's progress lines stay bubbles, as a 1:1 chat's do
  const items = useMemo(() => groupActivityRuns(messages.filter(message =>
    message.kind !== "activity" || roomActivityVisible(message, showToolCalls))), [messages, showToolCalls, locale]);
  const newestMessageId = messages.at(-1)?.id;
  const newestUserMessageId = [...messages].reverse().find((message) => message.role === "user")?.id;
  const roomBusy = roomThreadWorking(group, group.threadId);
  const liveTools = useLiveToolIds(transcript, { busy: roomBusy, turnStartedAt: group.turnStartedAt });
  const focus = state.focusMessage;
  const focusedId = focus && !focus.consumed && focus.threadId === group.threadId ? focus.messageId : null;
  const unreadIds = useMemo(() => unreadMessageIds(messages, unreadDividerId), [messages, unreadDividerId]);
  const exchanges = useExchangeRows(messages, items, roomItemRows, showToolCalls ? noneTransparent : hiddenRuns);
  let dividerPlaced = false;
  const dividerAbove = (rows: readonly Message[]) => {
    if (!unreadIds || dividerPlaced || !rows.some((row) => unreadIds.has(row.id))) return null;
    dividerPlaced = true;
    return <NewMessagesDivider fading={unreadDividerFading} />;
  };

  const messageRow = (m: Message, join: BubbleJoin): ReactNode => {
    const user = m.role === "user";
    const routineOwner = m.kind === "routine.run" ? memberOf(m.from?.botId) : undefined;
    const routineExecutionThreadId = m.routineRun?.executionThreadId;
    const routineTarget = routineOwner && hasRoutineExecutionTask(routineOwner.tasks, routineExecutionThreadId)
      ? { botId: routineOwner.id, threadId: routineExecutionThreadId }
      : undefined;
    // the room talks in bubbles: stops and settled cards leave no technical rows behind
    if (isCancelledTranscriptRow(m)) return null;
    if (m.kind === "options" && m.card && (m.card.answered || m.card.dismissed) && !settledCardStays(m.card)) {
      return showsSettledChange(m.card) ? <SettledChangeEvent bot={memberOf(m.from?.botId)} message={m} threadId={group.threadId} /> : null;
    }
    return m.kind === "secret" && m.secret && m.from?.botId ? (
      <SecretRequestCard botId={m.from.botId} color={m.from.color} threadId={group.threadId} message={m} />
    ) : m.kind === "signin" && m.signIn && m.from?.botId ? (
      <SignInRequestCard botId={m.from.botId} botName={m.from.name} color={m.from.color} threadId={group.threadId} message={m} />
    ) : m.kind === "connector" && m.connector && m.from?.botId ? (
      <ConnectorCard botId={m.from.botId} color={m.from.color} threadId={group.threadId} message={m} />
    ) : m.kind === "options" && isQuestionCard(m.card) ? (
      <div className="flex justify-start">
        <MessageBoundary fallbackText={m.card?.subtitle || m.card?.title || ""}>
          <QuestionCard threadId={group.threadId} asker={memberOf(m.from?.botId)} message={m} />
        </MessageBoundary>
      </div>
    ) : m.kind === "options" && m.card?.requestId && m.card.tool ? (
      <div className="flex justify-start">
        <MessageBoundary fallbackText={m.card.subtitle || m.card.title || ""}>
          <ApprovalCard bot={memberOf(m.from?.botId)} message={m} threadId={group.threadId} />
        </MessageBoundary>
      </div>
    ) : m.kind === "options" && m.card && m.from?.botId ? (
      <div className="flex justify-start">
        <MessageBoundary fallbackText={m.card.subtitle || m.card.title || ""}>
          <OptionCard botId={m.from.botId} threadId={group.threadId} groupId={group.id} message={m} />
        </MessageBoundary>
      </div>
    ) : m.kind === "goal.run" ? (
      <div className="flex justify-start">
        <GoalRunCard message={m} />
      </div>
    ) : m.kind === "routine.run" ? (
      <div className="flex justify-start">
        <RoutineRunCard
          message={m}
          onOpen={routineTarget
            ? () => openThread(dispatch, routineTarget, state)
            : undefined}
        />
      </div>
    ) : m.kind === "activity" && m.tool ? (
      roomActivityVisible(m, showToolCalls) ? (
        m.dataResult ? <DataResultChip message={m} /> : isStatusActivity(m) ? <StatusActivityRow message={m} /> : <RoomToolChip message={m} roomId={group.id} threadId={group.threadId} live={liveTools.has(m.id)} />
      ) : null
    ) : m.kind === "screen" ? (
      showToolCalls ? <ScreenFrame threadId={group.threadId} message={m} /> : null
    ) : m.kind === "compaction" ? (
      null
    ) : m.kind === "digest" ? (
      showToolCalls ? <DigestChip message={m} /> : null
    ) : m.publishedPage ? <PublishedPageCard message={m} /> : m.document ? <DocumentCard message={m} /> : m.kind === "text" && (m.text || m.attachments?.length) ? (
      !user && isPureLeakedBotText(m.text) && !m.attachments?.length ? null : (
        <RoomTextMessage
          group={group}
          message={m}
          members={members}
          transcript={transcript}
          emerging={m.id === emergingId}
          eager={m.id === newestMessageId || m.id === newestUserMessageId}
          onReply={onReply}
          canReact={canReact}
          join={join}
          fresh={m.id !== emergingId && m.at > openedAt}
        />
      )
    ) : null;
  };

  // each item once: what stands above it, whether it draws, and which bubble group and speaker it belongs to
  const rows = items.map((item, i) => {
    const previous = items[i - 1];
    const prev = previous && (previous.kind === "run" ? previous.messages.at(-1) : previous.message);
    const first = item.kind === "run" ? item.messages[0]! : item.message;
    const newDay = needsStamp(prev, first);
    const divider = dividerAbove(item.kind === "run" ? item.messages : [item.message]);
    const drawn = item.kind === "run" ? showToolCalls : messageRow(item.message, NO_JOIN) !== null;
    const m = item.kind === "message" ? item.message : null;
    const bubble = m && m.kind === "text" && !m.publishedPage && !m.document;
    const slot: RoomSlot | null = drawn ? {
      group: bubble ? (m.role === "user" ? `user:${m.from?.name ?? ""}` : `bot:${m.from?.botId ?? ""}`) : null,
      // a hand-off row names both bots itself, so it carries no speaker line
      sender: first.role === "bot" && first.from?.botId && !(first.kind === "activity" && (first.comm || first.handoff)) ? first.from.botId : null,
      stamped: newDay || divider !== null,
    } : null;
    return { item, prev, first, newDay, divider, slot };
  });
  const places = roomRowLayout(rows.map((row) => row.slot));
  // hand-off rows one after another read as one short list
  const handoffRun = new Set<number>();
  rows.forEach((row, i) => {
    if (!row.slot || row.slot.stamped || row.divider || row.item.kind !== "message" || !row.item.message.handoff) return;
    const before = rows.slice(0, i).findLast((other) => other.slot);
    if (before?.item.kind === "message" && before.item.message.handoff) handoffRun.add(i);
  });
  if (seamId) {
    const at = rows.findIndex((row) => row.item.kind === "message" && row.item.message.id === seamId);
    if (at >= 0) places[at] = { ...places[at]!, join: { ...places[at]!.join, below: true } };
  }

  return (
    <>
      {rows.map(({ item, prev, first, newDay, divider: own, slot }, i) => {
        const place = places[i]!;
        const run = exchanges.runAt.get(i);
        const collapsed = run !== undefined && !exchanges.isOpen(run);
        if (run && i !== run.start && collapsed) return null;
        let lead: ReactNode = null;
        if (run && i === run.start) {
          lead = (
            <>
              {run.items.map((_, offset) => rows[run.start + offset]!.divider).find(Boolean)}
              {newDay && <DaySeparator at={first.at} today={today} prev={prev} next={first} />}
              <PeerExchangeLine summary={run.summary} bots={state.bots} expanded={!collapsed} onToggle={() => exchanges.toggle(run)} />
            </>
          );
          if (collapsed) return <div key={run.id} className="contents" data-mid={first.id}>{lead}</div>;
        }
        const divider = run ? null : own;
        const stamp = lead ?? (newDay && <DaySeparator at={first.at} today={today} prev={prev} next={first} />);
        const label = place.label && first.from && <ClusterLabel bot={memberOf(first.from.botId)} name={first.from.name} color={first.from.color} />;
        const labelled = (row: ReactNode) => label ? <div className="flex w-full flex-col gap-1">{label}{row}</div> : row;
        if (item.kind === "run") {
          if (!slot) return (stamp || divider) && <div key={item.id} className="contents">{lead}{divider}</div>;
          return (
            <div key={item.id} className="contents" data-tuck={place.tuck ? "" : undefined}>
              {divider}
              {stamp}
              {labelled(
                <ActivityRun messages={item.messages} forceOpen={item.messages.some((step) => step.id === focusedId)}>
                  {item.messages.map((step) => (
                    <div key={step.id} className="contents" data-mid={step.id}>
                      <RoomToolChip message={step} threadId={group.threadId} live={liveTools.has(step.id)} />
                    </div>
                  ))}
                </ActivityRun>,
              )}
            </div>
          );
        }
        const m = item.message;
        const row = slot ? messageRow(m, place.join) : null;
        if (!row) return (lead || divider) && <div key={m.id} className="contents">{lead}{divider}</div>;
        return (
          // a send keeps its row when the server's copy replaces the optimistic one, so it never mounts or rises twice
          <div key={m.sendId ? `send:${m.sendId}` : m.id} className="contents" data-mid={m.id} data-tuck={place.tuck ? "" : undefined} data-handoff-next={handoffRun.has(i) ? "" : undefined}>
            {divider}
            {stamp}
            {labelled(row)}
          </div>
        );
      })}
    </>
  );
});

export type RoomResponderMode = "lead" | "everyone" | "mentions" | "auto";

function setupResponderMode(responder: GroupDefaultResponder): RoomResponderMode {
  return responder.kind === "member" ? "lead" : responder.kind;
}

/** One Default responder choice: a ring on every row, filled on the chosen one, its title over one plain line. */
export function SetupResponderRow({ choice, checked, title, hint, disabled, onClick, className }: {
  choice: RoomResponderMode;
  checked: boolean;
  title: string;
  hint: string;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      data-setup-choice={choice}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-left outline-none transition-[background-color] duration-[120ms] ease-[ease] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-ink/[0.045]" : "enabled:hover:bg-ink/[0.035]",
        className,
      )}
    >
      <span
        aria-hidden="true"
        data-radio={checked ? "on" : "off"}
        className={cn("flex size-4 shrink-0 items-center justify-center rounded-full", checked ? "bg-ink" : "border-[1.5px] border-ink/24")}
      >
        {checked && <span className="size-1.5 rounded-full bg-app" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] leading-[18px] tracking-[0.015em] text-ink">{title}</span>
        <span className="block text-[12px] leading-4 text-ink/56">{hint}</span>
      </span>
    </button>
  );
}

function RoomSetup({ group, members }: { group: Group; members: Bot[] }) {
  const { state, dispatch } = useStore();
  const jevOn = jevRoomRoutingOn(state.config);
  const [folder, setFolder] = useState(group.cwd ?? "");
  const [behavior, setBehavior] = useState<RoomResponderMode>(setupResponderMode(group.defaultResponder));
  const [leadId, setLeadId] = useState(
    group.defaultResponder.kind === "member" ? group.defaultResponder.botId
      : group.defaultResponder.kind === "auto" && group.defaultResponder.fallbackBotId ? group.defaultResponder.fallbackBotId
        : members[0]?.id ?? "",
  );
  const [instructions, setInstructions] = useState(group.bulletin);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leadPickerOpen, setLeadPickerOpen] = useState(false);
  const leadMotion = useMenuMotion(behavior === "lead" && leadPickerOpen);
  const leadPickerRef = useRef<HTMLDivElement>(null);
  const selectedLead = members.find((member) => member.id === leadId) ?? members[0];

  useEffect(() => {
    if (!leadPickerOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!leadPickerRef.current?.contains(event.target as Node)) setLeadPickerOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLeadPickerOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [leadPickerOpen]);

  const responder = (): GroupDefaultResponder => {
    if (behavior === "everyone") return { kind: "everyone" };
    if (behavior === "mentions") return { kind: "mentions" };
    if (behavior === "auto") return members.some((member) => member.id === leadId) ? { kind: "auto", fallbackBotId: leadId } : { kind: "auto" };
    return members.some((member) => member.id === leadId)
      ? { kind: "member", botId: leadId, leader: true }
      : group.defaultResponder;
  };

  const finish = async (action: "complete" | "skip") => {
    setLeadPickerOpen(false);
    setSaving(true);
    setError(null);
    try {
      const payload =
        action === "skip"
          ? { action }
          : {
              action,
              cwd: folder.trim() || null,
              defaultResponder: responder(),
              bulletin: instructions,
            };
      const result = await api(`/api/groups/${group.id}/setup`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      const now = Date.now();
      const nextGroup = {
        ...(result.group ?? group),
        id: group.id,
        setupPending: false,
        ...(action === "skip" ? { setupSkippedAt: now } : { setupCompletedAt: now }),
      };
      dispatch({ type: "groupPatched", group: nextGroup });
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setSaving(false);
    }
  };

  const pickFolder = async () => {
    const chosen = await window.madaniDesktop?.pickFolder?.(folder || group.cwd);
    if (chosen) setFolder(chosen);
  };

  return (
    <section
      data-testid="room-setup"
      aria-labelledby="room-setup-title"
      className="relative z-20 w-full overflow-visible rounded-[14px] border border-transparent bg-menu"
    >
      <div className="px-4 pb-1 pt-3">
        <h1 id="room-setup-title" className="m-0 text-[14px] font-semibold leading-5 tracking-[0.01em] text-ink">{t("room.setup.title", { name: group.name })}</h1>
        <p className="m-0 mt-0.5 text-[13px] leading-[18px] text-ink/68">{t("room.setup.detailChat")}</p>
      </div>
      <form
        className="space-y-4 px-4 pb-4 pt-3"
        onSubmit={(event) => {
          event.preventDefault();
          void finish("complete");
        }}
      >
        <label className="block">
          <span className="text-[13px] font-medium leading-[18px] text-ink">{t("room.folder.title")}</span>
          <span className="mt-0.5 block text-[12px] leading-4 text-ink/56">{t("room.setup.folderDetail")}</span>
          <div className="mt-2 flex gap-2">
            <input
              value={folder}
              onChange={(event) => setFolder(event.target.value)}
              placeholder={t("room.folder.own")}
              className={cn(textFieldCls, "flex-1")}
            />
            {window.madaniDesktop?.pickFolder && (
              <button
                type="button"
                onClick={() => void pickFolder()}
                disabled={saving}
                className={cn(mdSecondaryCls, "gap-1.5")}
              >
                <FolderOpen size={14} /> Choose
              </button>
            )}
          </div>
        </label>

        <fieldset className="block">
          <legend className="text-[13px] font-medium leading-[18px] text-ink">{t("room.responder.aria")}</legend>
          <p className="mt-0.5 text-[12px] leading-4 text-ink/56">{t("room.setup.responderDetail")}</p>
          <div role="radiogroup" aria-label={t("room.responder.aria")} data-setup-responder="" className="mt-2 flex flex-col rounded-[12px] border-[0.5px] border-edge bg-composer p-1">
            <SetupResponderRow
              choice="auto"
              checked={behavior === "auto"}
              title={t("room.responder.autoOptionOff")}
              hint={jevOn ? t("room.setup.autoDetail") : t("room.setup.autoDetailOff")}
              disabled={saving}
              onClick={() => {
                setBehavior("auto");
                setLeadPickerOpen(false);
              }}
            />

            <div ref={leadPickerRef} className={cn("relative flex min-w-0 items-center rounded-lg pe-2 transition-[background-color] duration-[120ms] ease-[ease]", behavior === "lead" ? "bg-ink/[0.045]" : "hover:bg-ink/[0.035]")}>
              <SetupResponderRow
                choice="lead"
                checked={behavior === "lead"}
                title={t("room.behavior.lead")}
                hint={t("room.setup.leadDetail")}
                disabled={saving}
                onClick={() => {
                  setBehavior("lead");
                  setLeadPickerOpen((open) => !open);
                }}
                className="min-w-0 flex-1 bg-transparent enabled:hover:bg-transparent"
              />
              <button
                type="button"
                data-setup-lead-picker=""
                aria-haspopup="listbox"
                aria-expanded={behavior === "lead" && leadPickerOpen}
                disabled={saving || members.length === 0}
                onClick={() => {
                  setBehavior("lead");
                  setLeadPickerOpen((open) => !open);
                }}
                className="inline-flex h-8 max-w-[160px] shrink-0 items-center gap-1.5 rounded-full bg-ink/[0.06] ps-1 pe-2 text-[13px] font-medium leading-[18px] text-ink outline-none transition-[background-color] duration-[120ms] ease-[ease] enabled:hover:bg-ink/[0.09] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50"
              >
                {selectedLead && (
                  <BotAvatar bot={selectedLead} state={normalizeState(selectedLead.mascotExpression) ?? "happy"} size={22} animated={false} />
                )}
                <span className={cn("min-w-0 truncate", !selectedLead && "ps-1.5")}>{selectedLead?.name ?? t("room.behavior.chooseTeammate")}</span>
                <ChevronDown
                  size={14}
                  aria-hidden="true"
                  className={cn("shrink-0 text-ink-secondary transition-transform duration-[120ms] ease-[ease] motion-reduce:transition-none", leadPickerOpen && "rotate-180")}
                />
              </button>
              {leadMotion.shown && (
                <div
                  role="listbox"
                  aria-label={t("room.behavior.chooseLead")}
                  className={cn("absolute right-2 top-full z-30 mt-1 w-72 max-w-[calc(100vw-3rem)] origin-top-right overflow-hidden rounded-[12px] border border-transparent bg-menu shadow-[0_8px_24px_rgb(0_0_0/0.12)]", leadMotion.className)} {...leadMotion.exitProps}
                >
                  <div className="border-b border-transparent px-3 py-2.5">
                    <div className="text-[13px] font-semibold text-ink">{t("room.behavior.chooseLead")}</div>
                    <div className="mt-0.5 text-[12px] text-ink-secondary">{t("room.behavior.chooseLeadDetail")}</div>
                  </div>
                  <div className="max-h-48 overflow-y-auto p-1.5">
                    {members.map((member) => {
                      const selected = member.id === leadId;
                      return (
                        <button
                          key={member.id}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          onClick={() => {
                            setLeadId(member.id);
                            setLeadPickerOpen(false);
                          }}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left transition",
                            selected ? "bg-ink/6" : "hover:bg-ink/5",
                          )}
                        >
                          <BotAvatar
                            bot={member}
                            state={normalizeState(member.mascotExpression) ?? "happy"}
                            size={24}
                            animated={false}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] font-medium text-ink">{member.name}</span>
                            <span className="block truncate text-[11px] text-ink-secondary">{member.title}</span>
                          </span>
                          {selected && <Check size={14} className="shrink-0 text-ink" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            <SetupResponderRow
              choice="everyone"
              checked={behavior === "everyone"}
              title={t("room.responder.everyoneOption")}
              hint={t("room.setup.allMembers")}
              disabled={saving}
              onClick={() => {
                setBehavior("everyone");
                setLeadPickerOpen(false);
              }}
            />

            <SetupResponderRow
              choice="mentions"
              checked={behavior === "mentions"}
              title={t("room.responder.mentionsOption")}
              hint={t("room.setup.onlyMentioned")}
              disabled={saving}
              onClick={() => {
                setBehavior("mentions");
                setLeadPickerOpen(false);
              }}
            />
          </div>
        </fieldset>

        <label className="block">
          <span className="text-[13px] font-medium leading-[18px] text-ink">{t("room.setup.instructions")}</span>
          <span className="mt-0.5 block text-[12px] leading-4 text-ink/56">{t("room.setup.instructionsDetail")}</span>
          <textarea
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            rows={5}
            placeholder={t("room.setup.instructionsPlaceholder")}
            className={cn(textAreaCls, "mt-2 resize-y")}
          />
        </label>

        {error && <p role="alert" className="m-0 text-[12px] leading-4 text-danger">{error}</p>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
          <button
            type="button"
            onClick={() => void finish("skip")}
            disabled={saving}
            className={mdSecondaryCls}
          >
            {t("room.setup.skip")}
          </button>
          <button
            type="submit"
            disabled={saving}
            className={cn(mdPrimaryCls, "gap-1.5")}
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            {t("room.setup.save")}
          </button>
        </div>
      </form>
    </section>
  );
}
/** A 1:1 chat's dock always holds its usage row, 8px tall when empty; a room has none, so it adds those 8px, and 12px
 * more because grok's room ends its last bubble 66px over the composer, not 54. */
const USAGE_ROW_GAP = 8 + 12;


export function GroupView({ group: room }: { group: Group }) {
  const group = useMemo(() => shownTranscript(room), [room]);
  const { state, dispatch } = useStore();
  const remoteClient = window.madaniDesktop?.remoteClient?.active === true;
  const composerDockRef = useRef<HTMLDivElement>(null);
  const composerDock = useComposerDockPad(composerDockRef, () => scrollRef.current);
  const [folderOpen, setFolderOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const { replyTo, selectReply, clearReply, consumeReply, restoreReply } = useReplyDraft(
    group.threadId,
    `group:${group.id}:${group.threadId}`,
    group.messages,
  );
  const membersTriggerRef = useRef<HTMLButtonElement>(null);
  const closeMembers = useCallback(() => setMembersOpen(false), []);
  useEffect(() => setFindOpen(false), [group.threadId]);
  useChatFindRequests(group.threadId, findOpen, setFindOpen);
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

  const members = useMemo(
    () => group.memberIds.map((id) => state.bots.find((b) => b.id === id)).filter((b): b is Bot => Boolean(b)),
    [group.memberIds, state.bots],
  );
  const speaker = members.find((b) => b.id === group.busyBotId);
  const threadWorking = roomThreadWorking(group, group.threadId);
  const setupPending = !remoteClient && roomNeedsSetup(group);
  // on a phone the setup form is the whole screen until it is saved or skipped: a locked field below it reads as part of it
  const phone = usePhoneLayout();
  const simpleHeader = simpleRoomHeader({ remoteClient, group, setupPending });

  const lastGroupMessage = group.messages.at(-1);
  const live = useTurnLive(group.threadId);
  const awaited = members.find(
    (b) => b.id === awaitedMemberId(threadWorking, group.busyBotId, lastGroupMessage),
  );
  const announcement = useMemo((): TranscriptSnapshot => {
    const approval = pendingApprovals(group.messages)[0];
    return {
      busy: threadWorking,
      reply: latestReply(group.messages, (m) => m.from?.name ?? group.name),
      failure: latestFailure(group.messages, (m) => m.from?.name ?? group.name),
      approval: approval
        ? { id: approval.requestId, name: approval.message.from?.name ?? speaker?.name ?? group.name }
        : undefined,
    };
  }, [group.messages, threadWorking, group.name, speaker?.name]);
  const presenceSpeaker = speaker ?? awaited ?? members[0];
  const networkWait = waitsForNetwork(group.messages, useOffline());
  // a member's wait for its first reply is no phrase for the line: the line already says it is at work
  const lastForLine = useMemo(() => group.messages.findLast((m) => !m.tool?.rescue), [group.messages]);
  const now = useTurnNow(
    { id: presenceSpeaker?.id ?? group.id, name: presenceSpeaker?.name ?? group.name, threadId: group.threadId },
    group.messages, lastForLine, live,
  );
  const streamingReply = useLiveReplyActive(group.threadId);
  const landed = useLandedReply(`${group.id}:${group.threadId}:${speaker?.id ?? ""}`, group.messages, speaker?.id);
  // the speaker's mark and its status line stay for the turn; its end, or its reply landing, hides them
  const presenceVisible =
    Boolean(speaker && showWorkingDots(true, group.messages.at(-1), speaker.id, live.ended) && !replyHidesLine(landed.sinceMs, now.phase)) || awaited !== undefined;
  const baseMarkState = statusMarkFor({ busy: threadWorking, waitingOnYou: false, answering: streamingReply, live: live.status?.activity, failed: lastGroupMessage?.kind === "activity" && lastGroupMessage.tool?.ok === false });
  // the speaker's typing dots only while its reply is being written; at work it shows its own mascot (the room's lines
  // read "streaming" as typing and play the dots)
  const worked = useMemo(() => turnWorked(group.messages), [group.messages]);
  const presence = useHeldPresence(threadWorking ? presenceKind({ writing: streamingReply, activity: live.status?.activity, worked }) : null);
  const statusMarkState = presence === "typing" ? "streaming" : presence === "working" ? workingMark(live.status?.activity) : baseMarkState;
  const handoffIds = useMemo(() => handoffWorkIds(group.messages), [group.messages]);
  const workingIds = threadWorking ? [...new Set([...roomWorkingIds(group, lastGroupMessage), ...handoffIds])] : roomWorkingIds(group, lastGroupMessage);
  const trailing = useTrailingRows(group.messages);
  const folded = useMemo(() => foldedNoticeIds(trailing), [trailing]);
  const retry = useMemo(() => {
    const failures = trailing?.failures ?? [];
    const ids = [...new Set(failures.flatMap((m) => m.from?.botId ? [m.from.botId] : []))];
    const at = failures[0] ? group.messages.indexOf(failures[0]) : -1;
    const request = ids.length > 0 && at >= 0 ? roomRetryRequest(group.messages, at) : null;
    if (!request) return undefined;
    return () => dispatch({
      type: "sendGroup", groupId: group.id, threadId: group.threadId, mode: request.mode,
      text: roomRetryText(request.text, members, ids), ...(request.replyToId ? { replyToId: request.replyToId } : {}),
    });
  }, [trailing, group.messages, group.id, group.threadId, members, dispatch]);

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
    ownerId: group.id,
    threadId: group.threadId,
    messages: group.messages,
    pinOn: [group.busyBotId, group.working, composerDock.pad],
    transcriptShown: !setupPending,
    hasMore: group.hasMore,
  });
  useTimestampPeek(scrollRef);
  // the status line keeps its slot at the end of the room whether it shows or not, so it never moves a row
  const statusSlot = windowedMessages.length > 0 || threadWorking;
  const unreadDivider = useUnreadDivider({ threadId: group.threadId, messages: group.messages, following });

  useEffect(() => setFolderOpen(false), [group.id]);
  useEffect(() => setMembersOpen(false), [group.id]);

  return (
    <main className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      <AnimatePresence>{membersOpen && !remoteClient && !group.dm && (
        <ManageMembersPanel key="manage-members-panel" group={group} onClose={closeMembers} triggerRef={membersTriggerRef} />
      )}</AnimatePresence>
      <GlassScrollFrame className="flex-1 [--glass-tint:var(--color-app)]">
      {/* z-[25]: above the room set-up card (z-20). */}
      <GlassBar edge="top" fade={!remoteClient} className="z-[25]">
      <RoomHeader
        group={group}
        members={members}
        simple={simpleHeader}
        setupPending={setupPending}
        remoteClient={remoteClient}
        findOpen={findOpen}
        onToggleFind={() => setFindOpen((open) => !open)}
        onToggleFolder={() => setFolderOpen((open) => !open)}
        onOpenMembers={() => setMembersOpen(true)}
        membersTriggerRef={membersTriggerRef}
      />

      {findOpen && <ChatFindBar threadId={group.threadId} onClose={() => setFindOpen(false)} />}
      <ChatNotice notice={state.notice} />
      {!setupPending && <RoomContextWarnings group={group} members={members} />}


      {!setupPending && !simpleHeader && <RoomBulletin group={group} remoteClient={remoteClient} />}

      {!setupPending && folderOpen && !group.dm && (
        <div className="w-full px-5">
          <div className="mb-1">
            <RoomWorkingFolder group={group} />
          </div>
        </div>
      )}

      {(() => {
        const pinned = group.messages.find((m) => m.id === group.pinnedMessageId && m.kind === "text");
        const text = pinned ? withoutCitationMarkers(pinned.text ?? "").replace(/\s+/g, " ").trim() : "";
        if (!pinned || !text) return null;
        const sender = pinned.role === "user" ? t("chat.you") : (pinned.from?.name ?? t("room.aBot"));
        return (
          <div className="w-full px-5">
            <div className="mb-2 flex items-center gap-2 rounded-lg bg-ink/[0.04] px-3 py-1.5">
              <Pin size={12} className="shrink-0 text-ink-tertiary" />
              <button
                onClick={() => dispatch({ type: "focusMessage", threadId: group.threadId, messageId: pinned.id })}
                className="flex min-w-0 flex-1 items-baseline gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                title={t("chat.pinnedJump")}
              >
                <span className="shrink-0 text-[12px] font-medium text-ink">{sender}</span>
                <span dir="auto" className="truncate text-[13px] text-ink-secondary">{text}</span>
              </button>
              <button
                onClick={() => dispatch({ type: "patchGroup", groupId: group.id, patch: { pinnedMessageId: "" } })}
                aria-label={t("chat.unpinMessage")}
                title={t("chat.unpin")}
                className={cn("shrink-0 rounded p-0.5 text-ink-secondary hover:bg-raised hover:text-ink", remoteClient && "hidden")}
              >
                <X size={13} />
              </button>
            </div>
          </div>
        );
      })()}
      </GlassBar>

      <div
        ref={scrollRef}
        className="glass-scroller h-full overflow-x-hidden overflow-y-auto overscroll-y-contain px-4 [overflow-anchor:none]"
        style={{ scrollPaddingBottom: composerDock.pad }}
        {...scrollHandlers}
      >
        {setupPending ? (
          <div className="flex min-h-full w-full items-center pb-8" style={{ paddingTop: "calc(var(--glass-top, 0px) + 2rem)" }}>
            <RoomSetup group={group} members={members} />
          </div>
        ) : (
        <div ref={clipRef}>
        <div
          ref={transcriptRef}
          data-simple-rows=""
          className="glass-scroller-content chat-column relative flex w-full flex-col gap-4 rounded-[18px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          data-dock-pad=""
          style={{ paddingBottom: `calc(${composerDock.pad} + ${SIMPLE_TRAILING_GAP + USAGE_ROW_GAP - (statusSlot ? SIMPLE_STATUS_SLOT : 0)}px)` }}
          tabIndex={0}
          role="log"
          aria-live="off"
          aria-label={t("room.aria", { name: group.name })}
        >
          {group.messages.length === 0 && room.transcriptLoaded !== false && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 py-24 text-center">
              <div className="flex -space-x-2">
                {members.slice(0, 3).map((b) => (
                  <BotAvatar
                    key={b.id}
                    bot={b}
                    state="happy"
                    size={44}
                    motion="none"
                    motionKey={0}
                    animated={false}
                  />
                ))}
              </div>
              <div className="text-[17px] font-semibold text-ink">{group.name}</div>
              <div className="max-w-[380px] text-[14px] text-ink-secondary">
                {groupResponseHint(group, members, { jevOn: jevRoomRoutingOn(state.config) })}
              </div>
            </div>
          )}
          {olderPending ? (
            <div className="flex items-center justify-center gap-2 py-3 text-xs text-ink-secondary">
              <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
              <span>{t("chat.loadingEarlier")}</span>
            </div>
          ) : hiddenCount > 0 || group.hasMore ? (
            <div ref={topSentinelRef} className="h-2 w-full pointer-events-none" aria-hidden="true" />
          ) : null}
          <FoldedNoticesContext value={folded}><Transcript
            group={group}
            members={members}
            locale={activeLocale()}
            messages={windowedMessages}
            transcript={group.messages}
            unreadDividerId={unreadDivider.messageId}
            unreadDividerFading={unreadDivider.fading}
            onReply={selectReply}
          /></FoldedNoticesContext>
          {laterCount > 0 && (
            <div className="flex justify-center">
              <button
                onClick={showLater}
                className="rounded-full border border-transparent bg-panel px-3 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
              >
                {t("chat.showLater", { count: laterCount })}
              </button>
            </div>
          )}
          <RoomWorkingLines
            key={`working:${group.threadId}`}
            group={group}
            members={members}
            workingIds={workingIds}
            typingIds={[]}
            speaker={{ bot: presenceSpeaker, visible: presenceVisible, markState: statusMarkState, phrases: now.phrases, phase: now.phase, since: speaker ? group.turnStartedAt ?? null : null }}
            slot={statusSlot}
            landed={Boolean(landed.reply)}
            networkWait={networkWait}
          />
          <TranscriptCardSlot key={`card:${group.threadId}`}>{Boolean(trailing?.failures.length || trailing?.notices.length || setupPending || group.dm) && <FailedReplyCard rows={trailing} group threadId={group.threadId} onRetry={retry} />}</TranscriptCardSlot>
        </div>
        </div>
        )}
      </div>

      <TranscriptAnnouncer threadKey={transcriptKey} snapshot={announcement} />

      <div ref={composerDockRef} data-grok-inset="" className="pointer-events-none absolute inset-x-0 bottom-0 z-[2] chat-column-dock">
      {!following && (
        <div className="relative">
          <JumpToLatestButton onClick={jumpToLatest} className="pointer-events-auto bottom-2" />
        </div>
      )}
      <ComposerNoticeSlot>
        <div className="pointer-events-auto"><ChatErrorBanner message={state.error} onDismiss={() => dispatch({ type: "error", message: null })} /></div>
        {/* what went wrong sits in the transcript; above the composer only who the person stopped */}
        <div className="pointer-events-auto">{!(trailing?.failures.length || trailing?.notices.length || setupPending || group.dm) && <RoomHoldsBanner group={group} members={members} />}</div>
      </ComposerNoticeSlot>
      {!(phone && setupPending) && <RoomComposer
        key={group.threadId}
        group={group}
        members={members}
        replyTo={replyTo}
        onClearReply={clearReply}
        onConsumeReply={consumeReply}
        onRestoreReply={restoreReply}
      />}
      </div>
      </GlassScrollFrame>
    </main>
  );
}
