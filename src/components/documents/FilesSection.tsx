import { useState, type KeyboardEvent } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { friendlyError } from "@/lib/plain-error";
import type { Bot } from "@/state/store";
import { Download, MoreHorizontal, Pencil, Trash2 } from "../../icons";
import { Card, LabelAction, NoteRow, PanelEmpty } from "../bot-panel/rows";
import { FileKindIcon } from "../bot-panel/FileKindIcon";
import { shortAge } from "../bot-panel/LibraryTab";
import type { SimplePageId } from "../bot-panel/page-registry";
import { SidebarPopoverMenu } from "../SidebarPopoverMenu";
import {
  documentApi, documentShapeLine, downloadDocument, glyphName, setOpenDocument, useBotDocuments, type DocumentMeta,
} from "./document-data";

const PREVIEW = 3;

const rowCls = "group relative flex min-h-11 w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] leading-[18px] tracking-[0.015em] text-ink";
const smallButton = "madani-press inline-flex h-7 shrink-0 items-center rounded-full px-2.5 text-[13px] leading-[18px] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus disabled:opacity-50";

/** One file: its name opens it; the menu renames, downloads or deletes it, each in place. */
function FileRow({ bot, doc, now, onOpen, onChanged }: {
  bot: Bot;
  doc: DocumentMeta;
  now: number;
  onOpen: (doc: DocumentMeta) => void;
  onChanged: (next: DocumentMeta | null) => void;
}) {
  const [mode, setMode] = useState<"idle" | "rename" | "delete">("idle");
  const [name, setName] = useState(doc.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try { await work(); setMode("idle"); }
    catch (reason) { setError(friendlyError(reason, t("documents.error.save"))); }
    finally { setBusy(false); }
  };
  const rename = () => act(async () => {
    const title = name.trim();
    if (!title || title === doc.title) return;
    const { content: _content, versions: _versions, ...meta } = await documentApi.save(bot.id, doc.id, { title });
    onChanged(meta);
  });
  const remove = () => act(async () => { await documentApi.remove(bot.id, doc.id); onChanged(null); });
  const download = () => act(async () => downloadDocument(await documentApi.get(bot.id, doc.id)));

  if (mode === "rename") {
    const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") void rename();
      if (event.key === "Escape") { event.preventDefault(); setMode("idle"); setName(doc.title); }
    };
    return (
      <div data-files-row="rename" className={cn(rowCls, "flex-wrap")}>
        <span className="flex size-6 shrink-0 items-center justify-center"><FileKindIcon name={glyphName(doc.kind)} /></span>
        <input
          autoFocus
          aria-label={t("documents.rename.label")}
          value={name}
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={onKey}
          className="h-7 min-w-0 flex-1 rounded-lg bg-ink/[0.05] px-2 text-[13px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-focus"
        />
        <button type="button" disabled={busy} onClick={() => { setMode("idle"); setName(doc.title); }} className={cn(smallButton, "text-ink-secondary hover:bg-ink/[0.06]")}>{t("common.cancel")}</button>
        <button type="button" disabled={busy || !name.trim()} onClick={() => void rename()} className={cn(smallButton, "bg-ink text-app hover:bg-ink/90")}>{t("common.save")}</button>
        {error && <p role="alert" className="w-full px-8 text-[12px] text-danger">{error}</p>}
      </div>
    );
  }

  if (mode === "delete") {
    return (
      <div data-files-row="delete" role="group" aria-label={t("documents.delete.ask", { title: doc.title })} className={cn(rowCls, "flex-wrap bg-ink/[0.035]")}>
        <span className="min-w-0 flex-1 text-pretty">{t("documents.delete.ask", { title: doc.title })}</span>
        <button type="button" disabled={busy} onClick={() => setMode("idle")} className={cn(smallButton, "text-ink-secondary hover:bg-ink/[0.06]")}>{t("common.cancel")}</button>
        <button type="button" disabled={busy} onClick={() => void remove()} className={cn(smallButton, "bg-danger text-white hover:brightness-110")}>{t("common.delete")}</button>
        {error && <p role="alert" className="w-full text-[12px] text-danger">{error}</p>}
      </div>
    );
  }

  return (
    <div data-files-row={doc.id} className="relative min-w-0">
      <button type="button" title={doc.title} onClick={() => onOpen(doc)} className={cn(rowCls, "cursor-pointer pe-10 hover:bg-ink/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus")}>
        <span className="flex size-6 shrink-0 items-center justify-center"><FileKindIcon name={glyphName(doc.kind)} /></span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span dir="auto" className="truncate">{doc.title}</span>
          <span className="truncate text-[12px] leading-4 text-ink-tertiary">{documentShapeLine(doc)} · {shortAge(doc.updatedAt, now)}</span>
        </span>
      </button>
      <span className="absolute end-1.5 top-1/2 -translate-y-1/2">
        <SidebarPopoverMenu
          grok
          placement="below"
          align="end"
          ariaLabel={t("documents.menu", { title: doc.title })}
          triggerClassName="flex size-7 cursor-pointer items-center justify-center rounded-full text-ink-secondary opacity-0 transition-opacity duration-100 hover:bg-ink/[0.08] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus aria-expanded:opacity-100 [[data-files-row]:hover_&]:opacity-100 touch:opacity-100"
          renderTrigger={() => <MoreHorizontal size={16} aria-hidden="true" />}
          items={[
            { key: "rename", label: t("documents.rename"), icon: <Pencil size={14} aria-hidden="true" />, onSelect: () => setMode("rename") },
            { key: "download", label: t("documents.download"), icon: <Download size={14} aria-hidden="true" />, onSelect: () => void download() },
            { key: "delete", label: t("common.delete"), icon: <Trash2 size={14} aria-hidden="true" />, separatorBefore: true, onSelect: () => setMode("delete") },
          ]}
        />
      </span>
      {error && <p role="alert" className="px-10 pb-1 text-[12px] text-danger">{error}</p>}
    </div>
  );
}

export function useFiles(bot: Bot, onOpenPage: (page: SimplePageId) => void) {
  const files = useBotDocuments(bot);
  const open = (doc: DocumentMeta) => {
    setOpenDocument({ botId: bot.id, id: doc.id });
    onOpenPage("document");
  };
  const changed = (id: string) => (next: DocumentMeta | null) => files.setDocuments((list) => {
    const rest = (list ?? []).filter((doc) => doc.id !== id);
    return next ? [next, ...rest].sort((a, b) => b.updatedAt - a.updatedAt) : rest;
  });
  return { ...files, open, changed };
}

/** The Advanced tab's Files: the documents the bot keeps, newest first, and View all. Nothing until there is one. */
export function FilesSection({ bot, files, onOpen }: { bot: Bot; files: ReturnType<typeof useFiles>; onOpen: (page: SimplePageId) => void }) {
  const { documents, open, changed } = files;
  if (!documents?.length) return null;
  const now = Date.now();
  return (
    <Card
      label={t("documents.files")}
      anchor="files"
      action={documents.length > PREVIEW ? <LabelAction data-panel-page="files" onClick={() => onOpen("files")}>{t("botPanel.library.viewAll")}</LabelAction> : undefined}
    >
      {documents.slice(0, PREVIEW).map((doc) => <FileRow key={doc.id} bot={bot} doc={doc} now={now} onOpen={open} onChanged={changed(doc.id)} />)}
    </Card>
  );
}

/** Every document the bot keeps. */
export function FilesPage({ bot, onOpen }: { bot: Bot; onOpen: (page: SimplePageId) => void }) {
  const { documents, failed, reload, open, changed } = useFiles(bot, onOpen);
  const now = Date.now();
  if (failed) {
    return (
      <Card>
        <NoteRow tone="danger">{t("documents.error.list")}</NoteRow>
        <button type="button" onClick={reload} className={cn(smallButton, "mx-2 mb-1 self-start bg-ink/[0.06] hover:bg-ink/[0.1]")}>{t("chat.retry")}</button>
      </Card>
    );
  }
  if (documents === null) return <div role="status" aria-label={t("documents.loading")} className="h-32 animate-pulse rounded-[12px] bg-ink/[0.04]" />;
  if (!documents.length) return <PanelEmpty data-panel-empty="files">{t("documents.empty", { name: bot.name })}</PanelEmpty>;
  return (
    <Card>
      {documents.map((doc) => <FileRow key={doc.id} bot={bot} doc={doc} now={now} onOpen={open} onChanged={changed(doc.id)} />)}
    </Card>
  );
}
