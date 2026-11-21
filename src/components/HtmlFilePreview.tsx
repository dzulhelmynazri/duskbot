import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Check, Code2, Download, ExternalLink, Eye, LoaderCircle, RotateCcw } from "../icons";
import { fileGone, requestMessageFile, useLocalFileSave, type MessageAttachmentContext } from "./AttachmentPreview";
import { TableDialog } from "./RichTable";
import { PdfFileContent } from "./PdfFilePreview";
import { readTableResponse, TableFileContent } from "./TableFilePreview";
import { tableDelimiter } from "@/lib/table-data";
import { t } from "@/lib/i18n";
import { friendlyError } from "@/lib/plain-error";

export const HTML_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

/** Security: the frame may draw what the file carries inline, and fetch nothing at all. */
export const HTML_PREVIEW_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:";

export function isHtmlFile(name: string): boolean {
  return /\.html?$/i.test(name);
}

export type FilePreviewKind = "html" | "markdown" | "text" | "pdf" | "table";

/** A file a bot sends that opens in a preview first, where it can still be saved; any other file saves at once. */
export function filePreviewKind(name: string): FilePreviewKind | null {
  if (isHtmlFile(name)) return "html";
  if (/\.(md|markdown)$/i.test(name)) return "markdown";
  if (/\.(txt|log|json|ya?ml)$/i.test(name)) return "text";
  if (/\.pdf$/i.test(name)) return "pdf";
  if (tableDelimiter(name)) return "table";
  return null;
}

const ChatMarkdown = lazy(() => import("./ChatMarkdown").then((module) => ({ default: module.ChatMarkdown })));

/** Security: `<base target="_blank">` turns every link into a popup, which the empty sandbox blocks, so the frame never navigates. */
export function htmlPreviewDocument(source: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}"><base target="_blank">${source}`;
}

/** The desktop app opens a copy of the page in this computer's default browser. Security: never on the web or in the
 * Cloud app, where a page would have to run on the app's own origin, nor while the window shows another computer. */
export function htmlBrowserBridge(): ((source: string, name: string) => Promise<unknown>) | undefined {
  const madaniDesktop = typeof window === "undefined" ? undefined : window.madaniDesktop;
  return madaniDesktop?.remoteClient?.active ? undefined : madaniDesktop?.openHtmlInBrowser;
}

/** The preview dialog for a page, Markdown or plain text file in a message, opened by the eye button or by the file's name. */
export function useFilePreview(path: string, name: string, message?: MessageAttachmentContext) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const kind = message === undefined ? null : filePreviewKind(name) ?? filePreviewKind(path);
  const key = message ? `${message.threadId}:${message.messageId}:${path}` : path;
  return {
    opens: kind !== null,
    label: t(kind === "html" ? "html.preview" : kind === "table" ? "table.preview" : "filePreview.open", { name }),
    show: (event: { currentTarget: HTMLElement }) => {
      opener.current = event.currentTarget;
      setOpen(true);
    },
    dialog: kind && open && message
      ? <TableDialog title={name} returnFocus={opener.current} onClose={() => setOpen(false)}>
        {kind === "html"
          ? <HtmlFileContent key={key} path={path} name={name} message={message} />
          : kind === "pdf" ? <PdfFileContent key={key} path={path} message={message} />
          : kind === "table" ? <TableFileContent key={key} path={path} name={name} message={message} delimiter={tableDelimiter(name) ?? tableDelimiter(path) ?? ","} />
          : <TextFileContent key={key} path={path} name={name} message={message} markdown={kind === "markdown"} />}
      </TableDialog>
      : null,
  };
}

export function HtmlFileButton({ path, name, message }: { path: string; name: string; message: MessageAttachmentContext }) {
  const preview = useFilePreview(path, name, message);
  return <>
    <button type="button" className="table-action" title={t("html.preview", { name })} aria-label={t("html.preview", { name })} onClick={preview.show}><Eye size={14} /></button>
    {preview.dialog}
  </>;
}

/** A file chip's name button: a file that opens in a preview opens it, any other file's name saves it. */
export function chipNameAction(preview: ReturnType<typeof useFilePreview>, save: ReturnType<typeof useLocalFileSave>, name: string, retryable: boolean) {
  if (preview.opens) return { onClick: preview.show, disabled: false, "aria-label": preview.label };
  return { onClick: () => void save.save(), disabled: save.state === "saving", "aria-label": retryable ? t("attach.retrySaveAria", { name }) : t("attach.saveAria", { name }) };
}

/** Saves a file whose name opens its preview instead. */
export function SaveIconButton({ name, save, retryable }: { name: string; save: ReturnType<typeof useLocalFileSave>; retryable: boolean }) {
  const label = retryable ? t("attach.retrySaveAria", { name }) : t("attach.saveAria", { name });
  return (
    <button type="button" className="table-action" aria-label={label} title={label} disabled={save.state === "saving"} onClick={() => void save.save()}>
      {save.state === "saving" ? (
        <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
      ) : save.state === "saved" ? (
        <Check size={14} className="text-success" aria-hidden="true" />
      ) : retryable ? (
        <RotateCcw size={14} className="text-danger" aria-hidden="true" />
      ) : (
        <Download size={14} aria-hidden="true" />
      )}
    </button>
  );
}

export function OpenInBrowserButton({ source, name, onError }: { source: string; name: string; onError: (reason: string) => void }) {
  const open = htmlBrowserBridge();
  if (!open) return null;
  const label = t("html.openInBrowser", { name });
  return <button type="button" className="table-action" aria-label={label} title={label} onClick={() => {
    onError("");
    open(source, name).catch((reason: unknown) => onError(friendlyError(reason, t("html.openFailed"))));
  }}><ExternalLink size={14} /></button>;
}

function useFileText(path: string, message: MessageAttachmentContext) {
  const [attempt, setAttempt] = useState(0);
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<PreviewError | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    setSource(null);
    void (async () => {
      try {
        const response = await requestMessageFile(path, message, controller.signal);
        const text = await readTableResponse(response, controller.signal, HTML_PREVIEW_MAX_BYTES);
        if (!controller.signal.aborted) setSource(text);
      } catch (reason) {
        if (!controller.signal.aborted) setError(fileGone(reason) ? "gone" : reason instanceof Error && reason.message === "size" ? "size" : "load");
      }
    })();
    return () => controller.abort();
  }, [path, message.threadId, message.messageId, attempt]);
  return { source, error, reload: () => setAttempt(attempt + 1) };
}

type PreviewError = "size" | "load" | "gone";

function PreviewTrouble({ error, page, reload }: { error: PreviewError; page: boolean; reload: () => void }) {
  const line = error === "gone" ? "attach.gone" : page ? (error === "size" ? "html.tooLarge" : "html.loadFailed") : error === "size" ? "filePreview.tooLarge" : "filePreview.loadFailed";
  return <div className="p-8 text-center text-sm"><p role="alert" className="mb-3 text-ink-secondary">{t(line)}</p>{error !== "gone" && <button type="button" className="rounded-lg border border-transparent px-3 py-2 hover:bg-raised" onClick={reload}>{t("chat.retry")}</button>}</div>;
}

function PreviewLoading({ page }: { page: boolean }) {
  return <div role="status" className="flex items-center justify-center gap-2 p-12 text-sm text-ink-secondary"><LoaderCircle size={16} className="animate-spin" />{t(page ? "html.loading" : "filePreview.loading")}</div>;
}

const SOURCE_CLASS = "h-[72dvh] overflow-auto rounded-lg border border-transparent bg-inset p-3 text-[12px] leading-5 whitespace-pre-wrap break-words text-ink";

function HtmlFileContent({ path, name, message }: { path: string; name: string; message: MessageAttachmentContext }) {
  const { source, error, reload } = useFileText(path, message);
  const [showSource, setShowSource] = useState(false);
  const [openFailed, setOpenFailed] = useState("");
  const save = useLocalFileSave(path, name, message);
  if (error) return <PreviewTrouble error={error} page reload={reload} />;
  if (source === null) return <PreviewLoading page />;
  return <div className="flex flex-col gap-2">
    <div className="flex items-center justify-end gap-1">
      <button type="button" className="table-action" aria-pressed={showSource} aria-label={t(showSource ? "html.rendered" : "html.source")} title={t(showSource ? "html.rendered" : "html.source")} onClick={() => setShowSource(!showSource)}>{showSource ? <Eye size={14} /> : <Code2 size={14} />}</button>
      <button type="button" className="table-action" aria-label={t("html.reload")} title={t("html.reload")} onClick={reload}><RotateCcw size={14} /></button>
      <OpenInBrowserButton source={source} name={name} onError={setOpenFailed} />
      <button type="button" className="table-action" aria-label={t("attach.saveAria", { name })} title={t("attach.saveAria", { name })} disabled={save.state === "saving"} onClick={() => void save.save()}><Download size={14} /></button>
    </div>
    {save.state === "failed" && <p role="alert" className="text-end text-[12px] text-danger">{save.reason}</p>}
    {openFailed && <p role="alert" className="text-end text-[12px] text-danger">{openFailed}</p>}
    {showSource
      ? <pre data-selectable="" className={SOURCE_CLASS}>{source}</pre>
      : <HtmlPreviewFrame source={source} name={name} />}
  </div>;
}

/** A Markdown file reads as the chat's own Markdown, with its source a press away; any other text file is shown as it is. */
export function TextFileContent({ path, name, message, markdown }: { path: string; name: string; message: MessageAttachmentContext; markdown: boolean }) {
  const { source, error, reload } = useFileText(path, message);
  const [showSource, setShowSource] = useState(false);
  const save = useLocalFileSave(path, name, message);
  if (error) return <div className="flex flex-col gap-2">
    <PreviewTrouble error={error} page={false} reload={reload} />
    {error === "size" && <div className="flex justify-center"><SaveIconButton name={name} save={save} retryable={save.state === "failed" && !save.outsideWorkspace} /></div>}
  </div>;
  if (source === null) return <PreviewLoading page={false} />;
  const formatted = markdown && !showSource;
  return <div className="flex flex-col gap-2">
    <div className="flex items-center justify-end gap-1">
      {markdown && <button type="button" className="table-action" aria-pressed={showSource} aria-label={t(showSource ? "filePreview.formatted" : "html.source")} title={t(showSource ? "filePreview.formatted" : "html.source")} onClick={() => setShowSource(!showSource)}>{showSource ? <Eye size={14} /> : <Code2 size={14} />}</button>}
      <SaveIconButton name={name} save={save} retryable={save.state === "failed" && !save.outsideWorkspace} />
    </div>
    {save.state === "failed" && <p role="alert" className="text-end text-[12px] text-danger">{save.reason}</p>}
    {formatted
      ? <div data-file-preview="markdown" data-selectable="" className="h-[72dvh] overflow-auto rounded-lg bg-inset px-4 py-3 text-[15px] leading-6 text-ink">
        <Suspense fallback={<PreviewLoading page={false} />}><ChatMarkdown text={source} /></Suspense>
      </div>
      : <pre data-file-preview="text" data-selectable="" className={`${SOURCE_CLASS} font-mono`}>{source}</pre>}
  </div>;
}

export function HtmlPreviewFrame({ source, name }: { source: string; name: string }) {
  return <iframe sandbox="" referrerPolicy="no-referrer" srcDoc={htmlPreviewDocument(source)} title={t("html.frameTitle", { name })} className="h-[72dvh] w-full rounded-lg border border-transparent bg-white" />;
}
