// Turns content.mjs's conversation scripts into stored messages (the shape server/message-db.ts keeps) and into the
// text-only projection a madani.backup carries. Both are built from the same `now`, so their timestamps agree.
import { join } from "node:path";

const EXT = { "text/markdown": ".md", "text/csv": ".csv", "text/plain": ".txt" };

/** @returns {{ messages: object[], files: Array<{ path: string, body: string }>, createdAt: number, updatedAt: number, leafId: string, lastReadMessageId: string | null }} */
export function buildThread(botKey, thread, { now, attachmentsDir, botId = "", threadId = "" }) {
  const messages = [];
  const files = [];
  const prefix = `demo-${botKey}-${thread.key}`;
  let at = now - thread.ago;
  let n = 0;
  let turn = null;
  const id = () => `${prefix}-${++n}`;
  const push = (message) => {
    message.parentId = messages.at(-1)?.id ?? null;
    messages.push(message);
    return message;
  };
  const inTurn = () => (turn ? { turnId: turn.turnId, requestMessageId: turn.requestId } : {});
  for (const step of thread.script) {
    if ("u" in step) {
      const message = push({ id: id(), role: "user", kind: "text", text: step.u, at });
      turn = { turnId: `${message.id}-turn`, requestId: message.id };
      at += 8e3;
      continue;
    }
    if ("tool" in step) {
      push({
        id: id(), role: "bot", kind: "activity", text: "", at, ...inTurn(),
        tool: { name: step.tool, input: JSON.stringify(step.input), ok: step.ok ?? true, ...(step.output ? { output: step.output } : {}) },
      });
      at += 6e3;
      continue;
    }
    if ("card" in step) {
      push({ id: id(), role: "bot", kind: "options", text: "", at, ...inTurn(), card: { ...step.card } });
      at += 6e3;
      continue;
    }
    if ("digest" in step) {
      const d = step.digest;
      push({
        id: id(), role: "bot", kind: "digest", text: "", at, ...inTurn(), turnSucceeded: true,
        digest: {
          turnId: turn?.turnId ?? `${prefix}-turn`, botId, threadId, at, durationMs: 94_000,
          tools: d.tools.map(([name, count]) => ({ name, count, failed: 0 })),
          toolCalls: d.tools.reduce((sum, [, count]) => sum + count, 0),
          files: { changed: d.changed ?? [], added: d.added ?? [], deleted: [] },
          memory: [], reply: d.reply, hookCoverage: "full",
        },
      });
      at += 4e3;
      continue;
    }
    if ("b" in step) {
      const message = { id: id(), role: "bot", kind: "text", text: step.b, at, ...inTurn() };
      if (step.file) {
        const path = join(attachmentsDir, `${message.id}${EXT[step.file.mime] ?? ".txt"}`);
        files.push({ path, body: step.file.body });
        message.attachments = [{ kind: "file", path, mime: step.file.mime, name: step.file.name }];
      }
      if (step.reactions) message.reactions = step.reactions.map((emoji) => ({ emoji, by: "user", at: at + 60e3 }));
      if (!step.more) Object.assign(message, { turnTerminal: true, turnSucceeded: true, turnCompletedAt: at });
      push(message);
      if (!step.more) turn = null;
      at += thread.gap;
      continue;
    }
    throw new Error(`unknown script step in ${prefix}`);
  }
  const unread = thread.unread ?? 0;
  const botRows = messages.filter((message) => message.role === "bot" && (message.kind === "text" || message.kind === "options"));
  const firstUnread = unread > 0 ? botRows.at(-unread) : null;
  const lastRead = firstUnread ? messages[messages.indexOf(firstUnread) - 1] : null;
  return {
    messages, files,
    createdAt: messages[0].at - 60e3,
    updatedAt: messages.at(-1).at,
    leafId: messages.at(-1).id,
    lastReadMessageId: lastRead?.id ?? null,
    unread: unread > 0,
  };
}

/** A question card as the one line a madani.backup can carry: the question, why, and the answers it offered. */
const questionText = (card) => [card.title, card.subtitle, card.options.map((option, i) => `${i + 1}. ${option}`).join("\n")].filter(Boolean).join("\n\n");

/** What a madani.backup keeps of a conversation: readable text only, chained in order. A team backup carries no cards, so a
 * question reads as its text with its answers (and the lead-in line that only repeats it goes), and an answered
 * approval, which a chat keeps no line for, is left out. */
export function backupProjection(built) {
  const kept = built.messages.filter((message, i) => {
    if (message.kind === "options") return message.card.requestType !== "permission";
    if (message.kind !== "text" || !message.text) return false;
    const next = built.messages[i + 1];
    return !(message.role === "bot" && next?.kind === "options" && next.card.title.trim() === message.text.trim());
  });
  return kept.map((message, i) => ({
    id: message.id,
    role: message.role,
    text: message.kind === "options" ? questionText(message.card) : message.text,
    at: message.at,
    parentId: i === 0 ? null : kept[i - 1].id,
  }));
}
