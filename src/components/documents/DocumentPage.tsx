import { lazy, Suspense, useEffect, useState, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { panelWide, setPanelWide } from "@/lib/panel-wide";
import { friendlyError } from "@/lib/plain-error";
import { phoneApp } from "@/lib/store-app";
import { ApiError } from "@/state/api";
import type { Bot } from "@/state/store";
import { Download, History, MoreHorizontal, Pencil, Trash2 } from "../../icons";
import { FileKindIcon } from "../bot-panel/FileKindIcon";
import { shortAge } from "../bot-panel/LibraryTab";
import { htmlPreviewDocument } from "../HtmlFilePreview";
import { SidebarPopoverMenu } from "../SidebarPopoverMenu";
import { parseSheet, sheetCsv } from "../../../shared/documents";
import { documentApi, documentShapeLine, downloadDocument, glyphName, useOpenDocument, type DocumentWithContent } from "./document-data";
import { SheetGrid } from "./SheetGrid";

const ChatMarkdown = lazy(() => import("../ChatMarkdown").then((module) => ({ default: module.ChatMarkdown })));

type Draft = { text: string } | { grid: string[][] };

const pill = "madani-press inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-full px-3 text-[13px] font-medium leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:h-11";
const quietPill = cn(pill, "bg-ink/[0.06] text-ink hover:bg-ink/[0.1]");
const primaryPill = cn(pill, "bg-ink text-app hover:bg-ink/90");

function draftOf(doc: DocumentWithContent): Draft {
  return doc.kind === "sheet" ? { grid: parseSheet(doc.content) } : { text: doc.content };
}

function draftText(draft: Draft): string {
  return "grid" in draft ? sheetCsv(draft.grid) : draft.text;
}

/** The panel is a reading width while a file is open on a computer; it goes back when the file closes. */
function useWidePanel() {
  useEffect(() => {
    if (phoneApp() || !window.matchMedia?.("(min-width: 768px)").matches) return;
    setPanelWide(true);
    return () => { if (panelWide()) setPanelWide(false); };
  }, []);
}

/** A field's Escape ends nothing but the field: the panel would otherwise go back and lose the edit. */
const keepEscape = (event: KeyboardEvent<HTMLElement>) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  (event.target as HTMLElement).blur?.();
};

function Body({ doc, draft, onDraft }: { doc: DocumentWithContent; draft: Draft | null; onDraft: (next: Draft) => void }) {
  if (doc.kind === "sheet") {
    const grid = draft && "grid" in draft ? draft.grid : parseSheet(doc.content);
    return <SheetGrid grid={grid} editing={draft !== null} title={doc.title} onChange={(next) => onDraft({ grid: next })} />;
  }
  if (draft && "text" in draft) {
    return (
      <textarea
        data-document-editor={doc.kind}
        aria-label={t("documents.editor", { title: doc.title })}
        value={draft.text}
        spellCheck={doc.kind === "markdown"}
        onChange={(event) => onDraft({ text: event.target.value })}
        onKeyDown={keepEscape}
        className="min-h-[calc(100dvh-220px)] w-full resize-none rounded-[12px] bg-(--chat-card) px-4 py-3 font-mono text-[13px] leading-[1.65] text-ink outline-none focus-visible:ring-2 focus-visible:ring-focus"
      />
    );
  }
  if (doc.kind === "html") {
    return (
      <iframe
        data-document-frame=""
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={htmlPreviewDocument(doc.content)}
        title={t("html.frameTitle", { name: doc.title })}
        className="h-[calc(100dvh-200px)] min-h-80 w-full rounded-[12px] bg-white"
      />
    );
  }
  return (
    <article data-document-view="markdown" className="mx-auto w-full max-w-[72ch] px-1 pb-6 text-[15px] leading-[1.65] text-ink">
      <Suspense fallback={<Loading />}><ChatMarkdown text={doc.content} /></Suspense>
    </article>
  );
}

function Loading() {
  return (
    <div role="status" aria-label={t("documents.loading")} className="flex flex-col gap-2.5 pt-2">
      <div className="h-5 w-2/5 animate-pulse rounded-md bg-ink/[0.06]" />
      <div className="h-3.5 w-1/4 animate-pulse rounded-md bg-ink/[0.05]" />
      <div className="mt-3 h-48 animate-pulse rounded-[12px] bg-ink/[0.04]" />
    </div>
  );
}

function Trouble({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
      <p role="alert" className="text-pretty text-[13px] leading-[18px] text-ink-secondary">{children}</p>
      {action}
    </div>
  );
}

/** The file the person opened from a chat card or Files: Markdown read as the chat reads it, a sheet as a grid, a page in
 * a sealed frame. Edit turns it into fields; Save keeps it as a new version, refused if the bot changed it meanwhile. */
export function DocumentPage({ bot }: { bot: Bot }) {
  useWidePanel();
  const opened = useOpenDocument();
  const id = opened?.botId === bot.id ? opened.id : null;
  const [doc, setDoc] = useState<DocumentWithContent | null>(null);
  const [trouble, setTrouble] = useState<"gone" | "load" | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [mode, setMode] = useState<"view" | "rename" | "delete">("view");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; stale?: boolean } | null>(null);
  const [deleted, setDeleted] = useState(false);

  useEffect(() => {
    if (!id) return;
    let live = true;
    setTrouble(null);
    documentApi.get(bot.id, id)
      .then((next) => { if (live) { setDoc(next); setDraft(null); setError(null); } })
      .catch((reason) => { if (live) setTrouble(reason instanceof ApiError && reason.status === 404 ? "gone" : "load"); });
    return () => { live = false; };
  }, [bot.id, id, attempt]);

  if (!id || deleted) return <Trouble>{t(deleted ? "documents.deleted" : "documents.none")}</Trouble>;
  if (trouble === "gone") return <Trouble>{t("documents.gone")}</Trouble>;
  if (trouble === "load") return <Trouble action={<button type="button" className={quietPill} onClick={() => setAttempt((n) => n + 1)}>{t("chat.retry")}</button>}>{t("documents.error.load")}</Trouble>;
  if (!doc || doc.id !== id) return <Loading />;

  const dirty = draft !== null && draftText(draft) !== draftText(draftOf(doc));
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await work(); }
    catch (reason) {
      const stale = reason instanceof ApiError && reason.status === 409;
      setError({ text: stale ? t("documents.error.stale", { name: bot.name }) : friendlyError(reason, t("documents.error.save")), stale });
    } finally { setBusy(false); }
  };
  const save = () => run(async () => {
    if (!draft) return;
    if (dirty) setDoc(await documentApi.save(bot.id, doc.id, { content: draftText(draft), expectedVersion: doc.version }));
    setDraft(null);
  });
  const rename = () => run(async () => {
    const title = name.trim();
    if (title && title !== doc.title) setDoc(await documentApi.save(bot.id, doc.id, { title }));
    setMode("view");
  });
  const restore = () => run(async () => {
    const previous = doc.versions[0];
    if (previous) setDoc(await documentApi.restore(bot.id, doc.id, previous.version));
  });
  const remove = () => run(async () => {
    await documentApi.remove(bot.id, doc.id);
    setDeleted(true);
  });

  const editing = draft !== null;
  const author = doc.by === "person" ? t("documents.byYou") : t("documents.byBot", { name: bot.name });
  const menu = [
    { key: "rename", label: t("documents.rename"), icon: <Pencil size={14} aria-hidden="true" />, onSelect: () => { setName(doc.title); setMode("rename"); } },
    { key: "download", label: t("documents.download"), icon: <Download size={14} aria-hidden="true" />, onSelect: () => downloadDocument(doc) },
    ...(doc.versions.length
      ? [{ key: "restore", label: t("documents.restore"), icon: <History size={14} aria-hidden="true" />, onSelect: () => void restore() }]
      : []),
    { key: "delete", label: t("common.delete"), icon: <Trash2 size={14} aria-hidden="true" />, separatorBefore: true, onSelect: () => setMode("delete") },
  ];

  return (
    <div data-document-page={doc.kind} className="flex min-w-0 flex-col gap-3">
      <header className="flex min-w-0 items-start gap-3 px-1">
        <span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-[12px] bg-ink/[0.05]"><FileKindIcon name={glyphName(doc.kind)} /></span>
        <div className="min-w-0 flex-1">
          {mode === "rename" ? (
            <input
              autoFocus
              aria-label={t("documents.rename.label")}
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void rename();
                if (event.key === "Escape") { event.preventDefault(); setMode("view"); }
              }}
              onBlur={() => { if (!busy) void rename(); }}
              className="h-8 w-full rounded-lg bg-ink/[0.05] px-2 text-[17px] font-semibold leading-6 text-ink outline-none focus-visible:ring-2 focus-visible:ring-focus"
            />
          ) : (
            <h2 dir="auto" className="text-pretty break-words text-[17px] font-semibold leading-6 text-ink">{doc.title}</h2>
          )}
          <p className="mt-0.5 truncate text-[12px] leading-[18px] text-ink-tertiary">
            {documentShapeLine(doc)} · {author} · {shortAge(doc.updatedAt, Date.now())}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {editing ? (
            <>
              <button type="button" disabled={busy} onClick={() => { setDraft(null); setError(null); }} className={cn(pill, "text-ink-secondary hover:bg-ink/[0.06]")}>{t("common.cancel")}</button>
              <button type="button" data-document-save="" disabled={busy || !dirty} onClick={() => void save()} className={primaryPill}>{t("common.save")}</button>
            </>
          ) : (
            <>
              <button type="button" data-document-edit="" onClick={() => setDraft(draftOf(doc))} className={quietPill}>
                <Pencil size={14} aria-hidden="true" />{t("documents.edit")}
              </button>
              <SidebarPopoverMenu
                grok
                placement="below"
                align="end"
                ariaLabel={t("documents.menu", { title: doc.title })}
                triggerClassName="flex size-8 cursor-pointer items-center justify-center rounded-full bg-ink/[0.06] text-ink hover:bg-ink/[0.1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus pointer-coarse:size-11"
                renderTrigger={() => <MoreHorizontal size={16} aria-hidden="true" />}
                items={menu}
              />
            </>
          )}
        </div>
      </header>

      {mode === "delete" && (
        <div role="group" aria-label={t("documents.delete.ask", { title: doc.title })} className="flex flex-wrap items-center gap-2 rounded-[12px] bg-ink/[0.04] px-3 py-2">
          <p className="min-w-0 flex-1 text-[13px] leading-[18px] text-ink">{t("documents.delete.ask", { title: doc.title })}</p>
          <button type="button" disabled={busy} onClick={() => setMode("view")} className={cn(pill, "text-ink-secondary hover:bg-ink/[0.06]")}>{t("common.cancel")}</button>
          <button type="button" disabled={busy} onClick={() => void remove()} className={cn(pill, "bg-danger text-white hover:brightness-110")}>{t("common.delete")}</button>
        </div>
      )}

      {error && (
        <div className="flex flex-wrap items-center gap-2 rounded-[12px] bg-danger/[0.08] px-3 py-2">
          <p role="alert" className="min-w-0 flex-1 text-[13px] leading-[18px] text-ink">{error.text}</p>
          {error.stale && <button type="button" className={quietPill} onClick={() => setAttempt((n) => n + 1)}>{t("documents.reload")}</button>}
        </div>
      )}

      <Body doc={doc} draft={draft} onDraft={setDraft} />
    </div>
  );
}
