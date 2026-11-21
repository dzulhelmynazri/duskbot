import { approvalCardOutcome } from "./ApprovalCard";
import type { Bot, Group, InstanceInfo, Message } from "@/state/store";
import type { RoutineRunCardData } from "../../shared/routine-run";
import { peerLine } from "@/lib/peer-message";
import { isReceipt } from "@/lib/receipts";
import { activityPreview, botEngine, failedTurnCause, STATUS_MARKER } from "@/lib/failed-turn";
import { t } from "@/lib/i18n";
import { sidebarConnectorPreview, sidebarGoalRunPreview } from "@/lib/sidebar-layout";
import { withoutCitationMarkers } from "@/lib/citations";
import { plainPreviewText } from "@/lib/plain-preview";
import { isClientCancellation, isStoppedTurnName } from "../../shared/client-cancel";
import { roomWorkingPreview } from "@/lib/room-threads";
import { openPersonWait } from "../../shared/person-wait";

/** The newest message a preview can show. A receipt or a screen frame says nothing about the conversation on its own. */
export function lastPreviewable<T extends { kind: string }>(messages: readonly T[] | undefined): T | undefined {
  return messages?.findLast((message) => !isReceipt(message) && message.kind !== "screen");
}

export function sidebarPreviewMessages(owner: { messages: Message[]; previewMessages?: Message[]; transcriptLoaded?: boolean; transcriptStale?: boolean }): Message[] {
  if (!owner.previewMessages?.length) return owner.messages;
  if (owner.transcriptStale) {
    // a held transcript may predate the snapshot's preview: the newer of the two, by time, is the row's last line
    const known = new Set(owner.messages.map((message) => message.id));
    const newer = owner.previewMessages.filter((message) => !known.has(message.id));
    return newer.length ? [...owner.messages, ...newer].sort((a, b) => a.at - b.at) : owner.messages;
  }
  if (owner.transcriptLoaded !== false) return owner.messages;
  const rows = new Map(owner.previewMessages.map((message) => [message.id, message]));
  for (const message of owner.messages) rows.set(message.id, message);
  return [...rows.values()];
}

export function botPreview(bot: Bot, visible: Message[], instances: InstanceInfo[]): string {
  if (bot.activity === "waiting-on-you") return t("sidebar.preview.waiting");
  if (bot.waitingForTeammates) return t("sidebar.preview.waitingOnTeammate");
  if (bot.busy) return t("sidebar.preview.working");
  return lastLine(bot, visible, instances);
}

function plainStep(message: Message): boolean {
  const tool = message.kind === "activity" ? message.tool : undefined;
  if (!tool || message.dataResult) return false;
  // a partly done turn whose reply says what failed shows no card, so the preview quotes that reply too
  if (tool.partial && tool.owned) return true;
  return failedTurnCause(tool.name) === null && !isStoppedTurnName(tool.name) && !STATUS_MARKER.test(tool.name);
}

/** A preview quotes the bot: a step that went fine gives way to the newest thing said since the person last wrote. */
function quotedLine(messages: readonly Message[], last: Message): Message {
  if (!plainStep(last)) return last;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "user") break;
    if (message.kind !== "activity" && !isReceipt(message) && message.kind !== "screen") return message;
  }
  return last;
}

/** What a waiting row quotes: the open question itself, not a line the bot said after it. */
export function waitingLine(bot: Bot, visible: Message[], instances: InstanceInfo[]): string {
  const wait = openPersonWait(visible);
  return wait?.kind === "question" && wait.label.trim() ? plainPreviewText(wait.label) : lastLine(bot, visible, instances);
}

/** The conversation's newest line as a preview shows it, whatever the bot is doing now. */
export function lastLine(bot: Bot, visible: Message[], instances: InstanceInfo[]): string {
  const newest = lastPreviewable(visible);
  if (!newest) return "";
  const last = quotedLine(visible, newest);
  if (last.kind === "options" && last.card) {
    // Madani's intro by its first line.
    if (last.helperIntro) return t(bot.chiefOfStaff ? "helperIntro.hello" : "helperIntro.hi.helper", { name: bot.name });
    return (last.card.requestId && last.card.tool && !last.card.questionRequest && approvalCardOutcome(last.card)) || last.card.title;
  }
  if (last.kind === "activity" && last.tool) return activityPreview(last.tool, botEngine(bot, instances), last.dataResult);
  if (last.kind === "connector" && last.connector) return sidebarConnectorPreview(last.connector, t);
  if (last.kind === "routine.run" && last.routineRun) return automationRunPreview(last.routineRun);
  const peer = peerLine(last);
  if (peer) return `${peer.name}: ${plainPreviewText(peer.body)}`;
  if (last.role !== "user" && isClientCancellation(last.text ?? "")) return t("chat.turnStopped");
  return plainPreviewText(withoutCitationMarkers(last.text ?? "")) || sentPreview(last.attachments);
}

type SentKind = "pdf" | "spreadsheet" | "video" | "image" | "audio" | "document" | "file";

const SENT = {
  pdf: ["sidebar.preview.sent.pdf.one", "sidebar.preview.sent.pdf.many"],
  spreadsheet: ["sidebar.preview.sent.spreadsheet.one", "sidebar.preview.sent.spreadsheet.many"],
  video: ["sidebar.preview.sent.video.one", "sidebar.preview.sent.video.many"],
  image: ["sidebar.preview.sent.image.one", "sidebar.preview.sent.image.many"],
  audio: ["sidebar.preview.sent.audio.one", "sidebar.preview.sent.audio.many"],
  document: ["sidebar.preview.sent.document.one", "sidebar.preview.sent.document.many"],
  file: ["sidebar.preview.sent.file.one", "sidebar.preview.sent.file.many"],
} as const satisfies Record<SentKind, readonly [string, string]>;

function sentKind(attachment: NonNullable<Message["attachments"]>[number]): SentKind {
  const mime = attachment.mime.toLowerCase();
  const name = ("name" in attachment ? attachment.name ?? "" : "").toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  if (attachment.kind === "image" || mime.startsWith("image/")) return "image";
  if (attachment.kind === "audio" || mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (/spreadsheet|excel|csv|tab-separated/.test(mime) || ["csv", "tsv", "xls", "xlsx", "ods", "numbers"].includes(ext)) return "spreadsheet";
  if (/wordprocessing|msword|opendocument\.text|rtf/.test(mime) || ["doc", "docx", "odt", "rtf", "pages"].includes(ext)) return "document";
  return "file";
}

/** grok's line for a message that is only files: "Sent 1 PDF", "Sent 2 images", and "Sent 3 files" for a mix. */
export function sentPreview(attachments: Message["attachments"]): string {
  if (!attachments?.length) return "";
  const kinds = new Set(attachments.map(sentKind));
  const kind = kinds.size === 1 ? [...kinds][0]! : "file";
  const count = attachments.length;
  return t(SENT[kind][count === 1 ? 0 : 1], { count });
}

const RUN_PREVIEW = {
  completed: "automations.preview.finished", failed: "automations.preview.failed", waiting: "automations.preview.needsYou",
  cancelled: "automations.preview.stopped", missed: "automations.preview.missed", running: "automations.preview.running", queued: "automations.preview.running",
} as const satisfies Record<RoutineRunCardData["status"], string>;

/** "“Morning summary” finished": an automation's run, in the page's words. */
export function automationRunPreview(run: Pick<RoutineRunCardData, "routineName" | "status">): string {
  return t(RUN_PREVIEW[run.status], { name: run.routineName });
}

export function groupPreview(group: Group, bots: Bot[], instances: InstanceInfo[]): string {
  const working = roomWorkingPreview(group, (botId) => bots.find((b) => b.id === botId)?.name);
  if (working) return working;
  if (group.working) return t("sidebar.preview.teamWorking");
  const messages = sidebarPreviewMessages(group);
  const newest = lastPreviewable(messages);
  if (!newest) return t("sidebar.preview.noMessages");
  const last = quotedLine(messages, newest);
  if (last.kind === "text" && last.role !== "user" && isClientCancellation(last.text ?? "")) {
    const stopped = t("chat.turnStopped");
    return last.from ? `${last.from.name}: ${stopped}` : stopped;
  }
  const text = last.kind === "activity" && last.tool
    ? activityPreview(last.tool, botEngine(bots.find((bot) => bot.id === last.from?.botId), instances), last.dataResult)
    : last.kind === "goal.run" && last.goalRun
      ? sidebarGoalRunPreview(last.goalRun)
      : last.kind === "connector" && last.connector
        ? sidebarConnectorPreview(last.connector, t)
        : (last.text ?? "");
  const readable = plainPreviewText(withoutCitationMarkers(text)) || sentPreview(last.attachments);
  if (last.role === "user") return t("sidebar.preview.you", { text: readable });
  return last.from ? `${last.from.name}: ${readable}` : readable;
}
