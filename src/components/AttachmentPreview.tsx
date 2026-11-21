// Security: model text never turns an arbitrary local path into a browser request; transcript paths resolve through
// attachmentImageUrl.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ScrimMotion, SheetMotion } from "./ui/SheetMotion";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Eye,
  FileText,
  FolderOpen,
  ImageOff,
  LoaderCircle,
  RotateCcw,
} from "../icons";

import {
  attachmentBasename,
  attachmentImageUrl,
  type TranscriptFileAttachment,
  type TranscriptImageAttachment,
} from "@/lib/composer-attachments";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { FilePreviewButton } from "./FilePreviewButton";
import { chipNameAction, SaveIconButton, useFilePreview } from "./HtmlFilePreview";
import { ImageLoading } from "./ImageLoading";
import { Icon } from "./Icon";
import { imageReady, knownImageSize, noteImageLoaded, reservedAspect, type MediaSize } from "@/lib/image-cache";
import { canonicalDownloadFilename } from "@/lib/download-filename";
import { friendlyError } from "@/lib/plain-error";
import { phoneBridge } from "@/lib/phone-bridge";

export { canonicalDownloadFilename, contentDispositionFilename, safeDownloadFilename } from "@/lib/download-filename";

export interface PreviewImage {
  src: string;
  name: string;
  downloadUrl?: string;
  downloadName?: string;
  openUrl?: string;
  /** The picture's own size when known before it loads; its box is reserved from this. */
  size?: MediaSize;
}

export interface MessageAttachmentContext { threadId: string; messageId: string }

export function previewImage(path: string, name = attachmentBasename(path), media?: Readonly<Record<string, MediaSize>>): PreviewImage | null {
  const src = attachmentImageUrl(path);
  if (!src) return null;
  const size = knownImageSize(path, media);
  return {
    src,
    name,
    downloadUrl: src,
    downloadName: canonicalDownloadFilename({ fallback: name, source: path }),
    ...(size ? { size } : {}),
  };
}

export function wrappedImageIndex(index: number, step: -1 | 1, count: number): number {
  if (count <= 0) return 0;
  return (index + step + count) % count;
}

export type PreviewKeyAction = "close" | "previous" | "next" | null;

export function previewKeyAction(key: string, count: number): PreviewKeyAction {
  if (key === "Escape") return "close";
  if (count > 1 && key === "ArrowLeft") return "previous";
  if (count > 1 && key === "ArrowRight") return "next";
  return null;
}

export function imageGalleryLayout(count: number): string {
  if (count <= 1) return "w-[min(32rem,70vw)] grid-cols-1";
  if (count === 2) return "w-[min(36rem,70vw)] grid-cols-2";
  return "w-[min(38rem,70vw)] grid-cols-2 sm:grid-cols-3";
}

export function isExternalImageSource(src: string): boolean {
  const value = src.trim();
  // The URL parser drops embedded ASCII tab/LF/CR and treats backslashes as slashes for special schemes.
  const networkSpelling = value.replace(/[\t\n\r]/g, "").replace(/\\/g, "/");
  // Chromium canonicalizes special-scheme variants (`https:host/x`, `https:/host/x`, backslashes) into network
  // requests.
  return networkSpelling.startsWith("//") || /^https?:/i.test(networkSpelling);
}

/**
 * Security: the host path never enters the browser URL; the server proves this message rendered an image at this source
 * offset.
 */
export function messageImagePreviewUrl(
  message: MessageAttachmentContext,
  sourceOffset: number,
): string {
  return `/api/threads/${encodeURIComponent(message.threadId)}/messages/${encodeURIComponent(message.messageId)}/file?preview=1&ref=${sourceOffset}`;
}

export async function messageImageOutsideWorkspace(src: string): Promise<boolean> {
  try {
    const response = await fetch(src, { cache: "no-store" });
    if (response.ok) {
      await response.body?.cancel();
      return false;
    }
    const body = await response.json().catch(() => null) as { code?: unknown } | null;
    return body?.code === "outside_workspace";
  } catch {
    return false;
  }
}

function revokeObjectUrlLater(url: string): void {
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Security: never request a transcript path directly, even when it looks like a URL. */
export async function requestMessageFile(
  filePath: string,
  message: MessageAttachmentContext,
  signal: AbortSignal,
  folder?: { entry?: string; list?: boolean },
): Promise<Response> {
  const response = await fetch(`/api/threads/${encodeURIComponent(message.threadId)}/messages/${encodeURIComponent(message.messageId)}/file`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: filePath,
      ...(folder?.entry !== undefined ? { entry: folder.entry } : folder?.list ? { listFolder: true } : {}),
    }),
    signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string; code?: string } | null;
    if (response.status === 404 || response.status === 410) throw Object.assign(new Error(t("attach.gone")), { code: FILE_GONE });
    throw Object.assign(new Error(body?.error ?? t("attach.downloadFailed")), { code: body?.code });
  }
  return response;
}

/** The error code a message file request fails with when the file or its message is no longer there. */
export const FILE_GONE = "gone";
export const fileGone = (reason: unknown) => (reason as { code?: unknown } | null)?.code === FILE_GONE;

export interface MessageFolderListing {
  name: string;
  entries: { name: string; bytes: number; mime: string }[];
  truncated: boolean;
}

export function useLocalFileSave(filePath: string, name?: string, message?: MessageAttachmentContext, entry?: string) {
  const [state, setState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [folder, setFolder] = useState<MessageFolderListing | null>(null);
  const [reason, setReason] = useState("");
  const [savedTo, setSavedTo] = useState("");
  const [outsideWorkspace, setOutsideWorkspace] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const request = useRef<AbortController | null>(null);
  const saving = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  useEffect(() => {
    request.current?.abort();
    request.current = null;
    saving.current = false;
    setReason("");
    setSavedTo("");
    setOutsideWorkspace(false);
    setFolder(null);
    setState("idle");
  }, [filePath, entry, message?.messageId, message?.threadId]);

  const save = useCallback(async () => {
    if (saving.current) return;
    if (!message) {
      setReason(t("attach.unavailableOld"));
      setState("failed");
      return;
    }
    saving.current = true;
    if (resetTimer.current) {
      clearTimeout(resetTimer.current);
      resetTimer.current = null;
    }
    setReason("");
    setOutsideWorkspace(false);
    setState("saving");
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      const response = await requestMessageFile(filePath, message, controller.signal, entry === undefined ? { list: true } : { entry });
      if (response.headers.get("x-madani-folder") === "1") {
        const listing = await response.json() as MessageFolderListing;
        if (!mounted.current || controller.signal.aborted) return;
        setFolder(listing);
        setState("idle");
        return;
      }
      const blob = await response.blob();
      if (!mounted.current || controller.signal.aborted) return;
      const saved = canonicalDownloadFilename({
        contentDisposition: response.headers.get("content-disposition"),
        fallback: name || entry || attachmentBasename(filePath),
        source: filePath,
        mime: blob.type || response.headers.get("content-type"),
      });
      const phone = phoneBridge();
      // a phone's web view drops a download link's click: the file goes to the share sheet (Save to Files) instead
      if (phone) {
        if (!phone.shareFile) throw new Error(t("mobile.file.cannotSave"));
        await phone.shareFile(new File([blob], saved, { type: blob.type || "application/octet-stream" }));
        if (!mounted.current || controller.signal.aborted) return;
        setState("idle");
        return;
      }
      const url = URL.createObjectURL(blob);
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = saved;
        link.style.display = "none";
        document.body.append(link);
        try {
          link.click();
        } finally {
          link.remove();
        }
      } finally {
        // Chromium may not consume a blob URL until after the click task ends.
        revokeObjectUrlLater(url);
      }
      if (!mounted.current || controller.signal.aborted) return;
      setSavedTo(saved);
      setState("saved");
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => {
        if (mounted.current) setState("idle");
      }, 4000);
    } catch (error) {
      if (!mounted.current || controller.signal.aborted) return;
      setReason(friendlyError(error, t("attach.saveFailed")));
      setOutsideWorkspace((error as { code?: unknown } | null)?.code === "outside_workspace");
      setState("failed");
    } finally {
      if (request.current === controller) {
        request.current = null;
        saving.current = false;
      }
    }
  }, [filePath, entry, message?.messageId, message?.threadId, name]);

  return { state, reason, savedTo, outsideWorkspace, folder, save };
}

export function saveFailureText(save: { reason: string; outsideWorkspace: boolean }): string {
  return save.outsideWorkspace ? t("attach.outsideWorkspace") : save.reason;
}

function folderFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / (1024 * 102.4)) / 10} MB`;
}

function MessageFolderFile({ folderPath, name, bytes, message }: {
  folderPath: string;
  name: string;
  bytes: number;
  message: MessageAttachmentContext;
}) {
  const save = useLocalFileSave(folderPath, name, message, name);
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-1.5">
      <button
        type="button"
        onClick={() => void save.save()}
        disabled={save.state === "saving"}
        aria-label={t("attach.saveAria", { name })}
        className="inline-flex min-h-8 min-w-0 items-center gap-1 break-all text-start text-accent underline decoration-accent/40 hover:decoration-accent disabled:cursor-wait"
      >
        {save.state === "saving" ? (
          <LoaderCircle size={12} className="shrink-0 animate-spin" aria-hidden="true" />
        ) : save.state === "saved" ? (
          <Check size={12} className="shrink-0 text-success" aria-hidden="true" />
        ) : (
          <FileText size={12} className="shrink-0" aria-hidden="true" />
        )}
        {name}
      </button>
      <span className="text-ink-secondary">{folderFileSize(bytes)}</span>
      {save.state === "failed" && <span role="alert" className="text-danger">{save.reason}</span>}
    </li>
  );
}

export function MessageFolderFiles({ folderPath, listing, message }: {
  folderPath: string;
  listing: MessageFolderListing;
  message: MessageAttachmentContext;
}) {
  return (
    <span dir="ltr" className="block w-full text-[12px] [unicode-bidi:isolate]">
      {listing.entries.length === 0 ? (
        <span className="text-ink-secondary">{t("attach.folderEmpty")}</span>
      ) : (
        <ul aria-label={t("attach.folderFilesAria", { name: listing.name })} className="flex flex-col gap-0.5 ps-1">
          {listing.entries.map((entry) => (
            <MessageFolderFile key={entry.name} folderPath={folderPath} name={entry.name} bytes={entry.bytes} message={message} />
          ))}
        </ul>
      )}
      {listing.truncated && <span className="text-ink-secondary">{t("attach.folderTruncated")}</span>}
    </span>
  );
}

const REVEALABLE_PATH = /^(?:\/(?!\/)|[a-zA-Z]:[\\/])/;
function revealBridge(): NonNullable<Window["madaniDesktop"]>["revealInFolder"] {
  const madaniDesktop = typeof window === "undefined" ? undefined : window.madaniDesktop;
  return madaniDesktop?.remoteClient?.active ? undefined : madaniDesktop?.revealInFolder;
}

export function OutsideWorkspaceFile({ filePath }: { filePath: string }) {
  const [problem, setProblem] = useState("");
  const reveal = revealBridge();
  if (!reveal || !REVEALABLE_PATH.test(filePath)) {
    return (
      <code title={t("attach.outsideWorkspacePath")} className="select-all break-all text-ink">
        {filePath}
      </code>
    );
  }
  const show = async () => {
    setProblem("");
    try {
      const result = await reveal(filePath);
      if (result === "missing") setProblem(t("attach.revealMissing"));
      else if (result !== "shown") setProblem(t("attach.revealFailed"));
    } catch {
      setProblem(t("attach.revealFailed"));
    }
  };
  return (
    <>
      <button
        type="button"
        onClick={() => void show()}
        title={filePath}
        className="inline-flex items-center gap-1 text-accent underline decoration-accent/40 hover:decoration-accent"
      >
        <FolderOpen size={12} className="shrink-0" aria-hidden="true" />
        {t("attach.showInFolder")}
      </button>
      {problem && <span role="alert" className="text-danger">{problem}</span>}
    </>
  );
}

const VIEWER_BUTTON = "flex size-8 items-center justify-center rounded-full border border-transparent bg-[rgb(245_245_245/0.04)] text-[rgb(245_245_245/0.66)] transition-colors duration-[120ms] ease-out hover:bg-[rgb(245_245_245/0.1)] hover:text-[rgb(245_245_245/0.9)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60";
const ZOOMED = 2.5;

/** grok's media viewer: the whole window fading in, the image rising into place, a caption and a filmstrip under it. */
interface PreviewDialogProps {
  image: PreviewImage;
  images?: PreviewImage[];
  initialIndex?: number;
  onClose: () => void;
}

/** Full screen pictures: the phone's own viewer in the phone app, this dialog elsewhere. */
export function AttachmentPreviewDialog(props: PreviewDialogProps) {
  const phone = phoneBridge();
  const opened = useRef(false);
  useEffect(() => {
    if (!phone || opened.current) return;
    opened.current = true;
    const items = props.images?.length ? props.images : [props.image];
    phone.view({ kind: "images", images: items.map(({ src, name, openUrl }) => ({ src, name, openUrl })), index: props.initialIndex ?? 0 }, props.onClose);
  }, []);
  return phone ? null : <PreviewDialog {...props} />;
}

function PreviewDialog({ image, images, initialIndex = 0, onClose }: PreviewDialogProps) {
  const items = images?.length ? images : [image];
  const [index, setIndex] = useState(() => Math.min(Math.max(initialIndex, 0), items.length - 1));
  const current = items[index] ?? image;
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const [loadedSources, setLoadedSources] = useState<Set<string>>(() => new Set());
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [zoom, setZoom] = useState<{ scale: number; x: number; y: number }>({ scale: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; from: { x: number; y: number } } | null>(null);
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  const navigate = useCallback((step: -1 | 1) => {
    setIndex((value) => wrappedImageIndex(value, step, items.length));
    setFailedSource(null);
    setZoom({ scale: 1, x: 0, y: 0 });
  }, [items.length]);

  const show = (next: number) => {
    setIndex(next);
    setFailedSource(null);
    setZoom({ scale: 1, x: 0, y: 0 });
  };

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      const action = previewKeyAction(event.key, items.length);
      if (action) {
        event.preventDefault();
        event.stopPropagation();
        if (action === "close") closeRef.current();
        else navigate(action === "previous" ? -1 : 1);
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )];
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === dialog || document.activeElement === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, [items.length, navigate]);

  const loaded = loadedSources.has(current.src);
  const failed = failedSource === current.src;
  const retry = () => {
    setFailedSource(null);
    setLoadedSources((sources) => {
      const next = new Set(sources);
      next.delete(current.src);
      return next;
    });
    setAttempt((value) => value + 1);
  };
  const toggleZoom = (event: React.MouseEvent<HTMLImageElement>) => {
    if (zoom.scale > 1) return setZoom({ scale: 1, x: 0, y: 0 });
    const box = event.currentTarget.getBoundingClientRect();
    const dx = event.clientX - (box.left + box.width / 2);
    const dy = event.clientY - (box.top + box.height / 2);
    setZoom({ scale: ZOOMED, x: -dx * (ZOOMED - 1), y: -dy * (ZOOMED - 1) });
  };
  const strip = items.length > 1;
  const caption = strip ? `${current.name} · ${index + 1} / ${items.length}` : current.name;

  return createPortal(
    <ScrimMotion
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t("attach.previewAria", { name: current.name })}
      tabIndex={-1}
      data-media-viewer
      className="fixed inset-0 z-[70] bg-black/95 outline-none"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div data-viewer-controls="" className="absolute end-[calc(var(--safe-area-inset-right,env(safe-area-inset-right,0px))+12px)] top-[calc(var(--safe-area-inset-top,env(safe-area-inset-top,0px))+12px)] z-[1] flex items-center gap-2">
        {current.downloadUrl && (
          <a
            href={current.downloadUrl}
            download={current.downloadName ?? canonicalDownloadFilename({ fallback: current.name, source: current.downloadUrl })}
            className={VIEWER_BUTTON}
            aria-label={t("attach.downloadAria", { name: current.name })}
            title={t("attach.download")}
          >
            <Download size={16} strokeWidth={1.75} />
          </a>
        )}
        {current.openUrl && (
          <a href={current.openUrl} target="_blank" rel="noreferrer" className={VIEWER_BUTTON}
            aria-label={t("attach.openOriginalAria", { name: current.name })} title={t("attach.openOriginal")}>
            <ExternalLink size={16} strokeWidth={1.75} />
          </a>
        )}
        <button type="button" onClick={onClose} className={VIEWER_BUTTON} aria-label={t("attach.close")}>
          <Icon name="close" size={18} />
        </button>
      </div>
      <SheetMotion
        className={cn("absolute inset-x-0 top-[calc(var(--safe-area-inset-top,env(safe-area-inset-top,0px))+44px)] flex items-center justify-center overflow-hidden px-[38px] pt-[38px]", strip ? "bottom-[calc(var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px))+132px)]" : "bottom-[calc(var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px))+68px)]")}
        onMouseDown={(event) => event.target === event.currentTarget && onClose()}
      >
        {!loaded && !failed && (
          <span className="absolute inset-0 flex items-center justify-center text-[rgb(245_245_245/0.54)]" role="status" aria-label={t("attach.loadingImage")}>
            <LoaderCircle size={18} className="animate-spin" aria-hidden="true" />
          </span>
        )}
        {failed ? (
          <div className="flex flex-col items-center gap-3 text-[rgb(245_245_245/0.66)]" role="alert">
            <ImageOff size={28} />
            <span className="text-[13px]">{t("attach.imageUnavailable")}</span>
            <button type="button" onClick={retry} className="flex h-7 items-center gap-1.5 rounded-full border border-transparent bg-[rgb(245_245_245/0.06)] px-3 text-[12px] text-[rgb(245_245_245/0.9)] hover:bg-[rgb(245_245_245/0.12)]">
              <RotateCcw size={13} /> {t("chat.retry")}
            </button>
          </div>
        ) : (
          <img
            key={`${current.src}:${attempt}`}
            src={current.src}
            alt={current.name}
            draggable={false}
            onLoad={() => setLoadedSources((sources) => new Set(sources).add(current.src))}
            onError={() => setFailedSource(current.src)}
            onDoubleClick={toggleZoom}
            onPointerDown={(event) => {
              if (zoom.scale === 1) return;
              drag.current = { x: event.clientX, y: event.clientY, from: { x: zoom.x, y: zoom.y } };
              event.currentTarget.setPointerCapture(event.pointerId);
              setDragging(true);
            }}
            onPointerMove={(event) => {
              const start = drag.current;
              if (start) setZoom({ scale: zoom.scale, x: start.from.x + event.clientX - start.x, y: start.from.y + event.clientY - start.y });
            }}
            onPointerUp={() => { drag.current = null; setDragging(false); }}
            style={{
              transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`,
              transition: dragging ? "none" : "transform 200ms cubic-bezier(0.23, 1, 0.32, 1)",
            }}
            className={cn(
              "block max-h-full max-w-full rounded-[8px] object-contain select-none motion-reduce:!transition-none",
              zoom.scale > 1 ? (dragging ? "cursor-grabbing" : "cursor-grab") : "cursor-zoom-in",
              loaded ? "opacity-100" : "opacity-0",
            )}
          />
        )}
      </SheetMotion>
      {strip && (
        <>
          <button type="button" onClick={() => navigate(-1)} className={cn(VIEWER_BUTTON, "absolute start-3 top-1/2 z-[1] size-10 -translate-y-1/2")}
            aria-label={t("attach.previous")} title={t("attach.previous")} data-viewer-step="previous">
            <ChevronLeft size={20} strokeWidth={1.75} />
          </button>
          <button type="button" onClick={() => navigate(1)} className={cn(VIEWER_BUTTON, "absolute end-3 top-1/2 z-[1] size-10 -translate-y-1/2")}
            aria-label={t("attach.next")} title={t("attach.next")} data-viewer-step="next">
            <ChevronRight size={20} strokeWidth={1.75} />
          </button>
        </>
      )}
      <div className="absolute inset-x-0 bottom-[calc(var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px))+20px)] flex flex-col items-center gap-4">
        <span className="flex h-8 max-w-[80vw] items-center truncate text-[12px] leading-4 text-[rgb(245_245_245/0.54)]">{caption}</span>
        {strip && (
          <div className="flex max-w-[90vw] gap-2 overflow-x-auto [scrollbar-width:none]">
            {items.map((item, itemIndex) => (
              <button
                key={`${itemIndex}:${item.src}`}
                type="button"
                onClick={() => show(itemIndex)}
                aria-label={t("attach.viewMedia", { index: itemIndex + 1, count: items.length })}
                aria-current={itemIndex === index || undefined}
                className={cn(
                  "size-12 shrink-0 overflow-hidden rounded-[8px] transition-opacity duration-150 ease-[ease] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60",
                  itemIndex === index ? "border-2 border-[rgb(245_245_245)] p-0.5" : "border border-transparent opacity-50 hover:opacity-80",
                )}
              >
                <img src={item.src} alt="" className={cn("size-full object-cover", itemIndex === index ? "rounded-[4px]" : "rounded-[7.5px]")} />
              </button>
            ))}
          </div>
        )}
      </div>
    </ScrimMotion>,
    document.body,
  );
}

export function AttachmentThumbnail({
  image,
  onPreview,
  className,
  eager = false,
  explainRefusal = false,
  label,
  onSize,
  fit,
  style,
}: {
  image: PreviewImage;
  onPreview: () => void;
  className?: string;
  eager?: boolean;
  explainRefusal?: boolean;
  label?: string;
  onSize?: (size: { width: number; height: number }) => void;
  /** A caller that sized the box itself says how the picture fills it; otherwise unknown sizes letterbox. */
  fit?: "cover" | "contain";
  /** A box the caller reserved itself (it wins over the thumbnail's own). */
  style?: React.CSSProperties;
}) {
  // Callers key this by src: resetting in an effect races a cached image's onLoad, which can fire before the effect
  // runs.
  const [warm] = useState(() => imageReady(image.src));
  const [state, setState] = useState<"loading" | "ready" | "failed">(warm ? "ready" : "loading");
  const [attempt, setAttempt] = useState(0);
  const [outsideWorkspace, setOutsideWorkspace] = useState(false);
  // decided once, before any byte: a size learned on load never reshapes a box already on screen
  const [box] = useState(() => reservedAspect(image.size ?? knownImageSize(image.src)));

  return (
    <span
      style={{ aspectRatio: String(box.ratio), ...style }}
      data-reserved={box.known ? "size" : "default"}
      className={cn("group/image relative block min-w-0 overflow-hidden rounded-xl border border-transparent bg-inset", className)}
    >
      {state === "loading" && <ImageLoading name={image.name} className="absolute inset-0 bg-raised/65" />}
      {state === "failed" ? (
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-3 text-center text-ink-secondary" role="alert">
          <ImageOff size={22} />
          {outsideWorkspace ? (
            <span className="max-w-full text-[12px]">{t("attach.imageOutsideWorkspace")}</span>
          ) : (
            <span className="max-w-full truncate text-[12px]">{t("attach.imageUnavailable")}</span>
          )}
          {!outsideWorkspace && <span
            role="button"
            tabIndex={0}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setState("loading");
              setAttempt((value) => value + 1);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              event.stopPropagation();
              setState("loading");
              setAttempt((value) => value + 1);
            }}
            className="flex h-6 items-center gap-1 rounded-full bg-ink/[0.06] px-2.5 text-[12px] leading-4 text-ink transition-colors hover:bg-ink/[0.1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            aria-label={t("attach.retryAria", { name: image.name })}
          >
            <RotateCcw size={12} aria-hidden="true" /> {t("chat.retry")}
          </span>}
        </span>
      ) : (
        <span
          role="button"
          tabIndex={state === "ready" ? 0 : -1}
          aria-disabled={state !== "ready"}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (state === "ready") onPreview();
          }}
          onKeyDown={(event) => {
            if (state === "ready" && (event.key === "Enter" || event.key === " ")) {
              event.preventDefault();
              onPreview();
            }
          }}
          className="absolute inset-0 block size-full cursor-pointer text-left transition-[filter] duration-[160ms] ease-[ease] hover:brightness-[1.04] focus-visible:outline-none focus-visible:inset-ring-2 focus-visible:inset-ring-accent/60 aria-disabled:cursor-default"
          aria-label={label ?? t("attach.previewImageAria", { name: image.name })}
          title={t("attach.previewAria", { name: image.name })}
        >
          <img
            key={`${image.src}:${attempt}`}
            src={image.src}
            alt={image.name}
            loading={eager || warm ? "eager" : "lazy"}
            decoding={warm ? "sync" : "async"}
            fetchPriority={eager ? "high" : undefined}
            onLoad={(event) => {
              const { naturalWidth, naturalHeight } = event.currentTarget;
              if (naturalWidth > 0 && naturalHeight > 0) onSize?.({ width: naturalWidth, height: naturalHeight });
              noteImageLoaded(image.src, event.currentTarget);
              setState("ready");
            }}
            onError={() => {
              setState("failed");
              if (explainRefusal) void messageImageOutsideWorkspace(image.src).then(setOutsideWorkspace);
            }}
            className={cn(
              "block size-full transition-opacity duration-[180ms] ease-[ease]",
              (fit ?? (box.known ? "cover" : "contain")) === "cover" ? "object-cover" : "object-contain",
              state === "ready" ? "opacity-100" : "opacity-0",
            )}
          />
        </span>
      )}
    </span>
  );
}

export function AttachedImageGallery({
  paths,
  className,
  eager = false,
}: {
  paths: Array<string | TranscriptImageAttachment>;
  className?: string;
  eager?: boolean;
}) {
  const images = useMemo(() => paths.flatMap((reference) => {
    if (typeof reference !== "string" && !reference.private) return [];
    const path = typeof reference === "string" ? reference : reference.path;
    const name = typeof reference === "string" ? undefined : reference.name;
    const image = previewImage(path, name);
    return image ? [image] : [];
  }), [paths]);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  if (images.length === 0) return null;
  return (
    <>
      <div className={cn("mb-2 grid max-w-full gap-2", imageGalleryLayout(images.length), className)}>
        {images.map((image, index) => (
          <AttachmentThumbnail key={`${image.src}:${index}`} image={image} onPreview={() => setSelectedIndex(index)} eager={eager} />
        ))}
      </div>
      {selectedIndex !== null && images[selectedIndex] && (
        <AttachmentPreviewDialog
          image={images[selectedIndex]}
          images={images}
          initialIndex={selectedIndex}
          onClose={() => setSelectedIndex(null)}
        />
      )}
    </>
  );
}

/** grok's single inline image: as wide as the picture up to 560px, never taller than 200px. */
export const MARKDOWN_IMAGE = { maxWidth: 560, maxHeight: 200 } as const;

/** The box an inline image keeps from first paint to load: its own shape when known, else 560 by at most 200, letterboxed. */
export function markdownImageBox(size: MediaSize | undefined): { width: string; aspectRatio: string; maxHeight: number; known: boolean } {
  const { ratio, known } = reservedAspect(size, 4 / 3, [0.2, 5]);
  const width = known ? Math.min(size!.w, MARKDOWN_IMAGE.maxWidth, Math.round(MARKDOWN_IMAGE.maxHeight * ratio)) : MARKDOWN_IMAGE.maxWidth;
  return { width: `min(100%, ${width}px)`, aspectRatio: String(ratio), maxHeight: MARKDOWN_IMAGE.maxHeight, known };
}

export function MarkdownImagePreview({
  src,
  name,
  openUrl,
  message,
  filePath,
  sourceOffset,
  size,
}: {
  src: string;
  name: string;
  openUrl?: string;
  message?: MessageAttachmentContext;
  filePath?: string;
  sourceOffset?: number;
  size?: MediaSize;
}) {
  const [open, setOpen] = useState(false);
  const [box] = useState(() => markdownImageBox(size ?? knownImageSize(filePath ?? src)));
  const frame = { aspectRatio: box.aspectRatio, maxHeight: box.maxHeight };
  const containerRef = useRef<HTMLSpanElement>(null);
  const threadId = message?.threadId;
  const messageId = message?.messageId;
  const localSourceOffset = typeof sourceOffset === "number" && Number.isSafeInteger(sourceOffset) && sourceOffset >= 0
    ? sourceOffset
    : null;
  const localMessageImage = Boolean(
    filePath && threadId && messageId && localSourceOffset !== null,
  );
  const localImageKey = localMessageImage ? `${threadId}\u0000${messageId}\u0000${localSourceOffset}` : null;
  const [visibleLocalImageKey, setVisibleLocalImageKey] = useState<string | null>(null);
  const external = !filePath && isExternalImageSource(src);
  const [approvedExternalSource, setApprovedExternalSource] = useState<string | null>(null);

  useEffect(() => {
    if (!localImageKey) return;
    const element = containerRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setVisibleLocalImageKey(localImageKey);
      return;
    }
    setVisibleLocalImageKey(null);
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      setVisibleLocalImageKey(localImageKey);
      observer.disconnect();
    }, { rootMargin: "320px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [localImageKey]);

  const shouldLoadLocalImage = localMessageImage && (visibleLocalImageKey === localImageKey || open);
  const externalAllowed = !external || approvedExternalSource === src;
  const visibleSource = externalAllowed
    ? localMessageImage
      ? shouldLoadLocalImage && filePath && threadId && messageId && localSourceOffset !== null
        ? messageImagePreviewUrl({ threadId, messageId }, localSourceOffset)
        : null
      : src
    : null;
  const image: PreviewImage = {
    src: visibleSource ?? "",
    name,
    openUrl,
    downloadUrl: localMessageImage ? visibleSource ?? undefined : undefined,
    downloadName: localMessageImage
      ? canonicalDownloadFilename({ fallback: name, source: filePath })
      : undefined,
    ...(size ? { size } : {}),
  };
  return (
    <>
      <span ref={containerRef} data-markdown-image={box.known ? "size" : "default"} className="my-2 block max-w-full" style={{ width: box.width }}>
        {external && !externalAllowed ? (
          <span style={frame} className="flex flex-col items-center justify-center gap-2 overflow-hidden rounded-xl border border-transparent bg-inset px-4 text-center text-[12px] text-ink-secondary">
            <ImageOff size={20} />
            <span>{t("attach.externalHidden")}</span>
            <button type="button" className="rounded-md border border-transparent bg-panel px-2.5 py-1 text-ink hover:bg-raised" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setApprovedExternalSource(src); }}>{t("attach.loadImage")}</button>
          </span>
        ) : filePath && (!threadId || !messageId || localSourceOffset === null) ? (
          <span style={frame} className="flex items-center justify-center gap-2 rounded-xl border border-transparent bg-inset text-[12px] text-ink-secondary" role="alert">
            <ImageOff size={17} /> {t("attach.oldImage")}
          </span>
        ) : visibleSource ? (
          <AttachmentThumbnail key={image.src} image={image} onPreview={() => setOpen(true)} style={frame} fit="contain" className="w-full" label={t("attach.openFullScreen")} eager explainRefusal={localMessageImage} />
        ) : (
          <ImageLoading name={name} style={frame} className="w-full rounded-xl border border-transparent bg-inset" />
        )}
        {openUrl && (
          <a href={openUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex text-[11px] text-accent hover:underline">
            Open original
          </a>
        )}
      </span>
      {open && visibleSource && <AttachmentPreviewDialog image={image} onClose={() => setOpen(false)} />}
    </>
  );
}

/** The coloured band at the foot of grok's file glyph, by the kind of document. */
function fileBand(name: string): string {
  const ext = name.split(".").at(-1)?.toLowerCase() ?? "";
  if (ext === "pdf") return "#fb2b3e";
  if (["xls", "xlsx", "csv", "tsv", "numbers"].includes(ext)) return "#14c16f";
  if (["doc", "docx", "pages", "rtf", "txt", "md"].includes(ext)) return "#1e86fc";
  if (["ppt", "pptx", "key"].includes(ext)) return "#fd690f";
  if (["zip", "tar", "gz", "rar", "7z"].includes(ext)) return "#a06b39";
  return "rgb(28 28 28 / 0.24)";
}

export function FileGlyph({ name }: { name: string }) {
  return (
    <span aria-hidden="true" className="chat-file-glyph pointer-events-none relative flex h-10 w-8 shrink-0 flex-col overflow-hidden rounded-[6px] bg-composer">
      <span className="mx-1 mt-1 h-1 rounded-[2px] bg-ink/[0.18]" />
      <span className="mx-1 mt-[3px] h-1 w-[11px] rounded-[2px] bg-ink/[0.18]" />
      <span className="mx-1 mt-[3px] h-1 w-[11px] rounded-[2px] bg-ink/[0.18]" />
      <span className="mt-auto h-3 w-full" style={{ backgroundColor: fileBand(name) }} />
    </span>
  );
}

/** Grok's file card: a white 72px card with a small paper glyph, the name with its extension kept, and a round action. */
function FileCard({ file, message, save, preview, retryable, className }: {
  file: TranscriptFileAttachment;
  message: MessageAttachmentContext;
  save: ReturnType<typeof useLocalFileSave>;
  preview: ReturnType<typeof useFilePreview>;
  retryable: boolean;
  className?: string;
}) {
  const failed = save.state === "failed";
  const dot = file.name.lastIndexOf(".");
  const base = dot > 0 ? file.name.slice(0, dot) : file.name;
  const ext = dot > 0 ? file.name.slice(dot) : "";
  const kind = ext.slice(1).toUpperCase() || t("attach.file");
  const meta = save.state === "saving" ? t("attach.downloading") : save.state === "saved" ? t("attach.downloaded") : failed ? saveFailureText(save) : file.bytes ? `${kind} · ${folderFileSize(file.bytes)}` : kind;
  return (
    <section data-file-card="" className={cn("chat-file-card relative flex h-[72px] w-[354px] max-w-full items-center gap-[14px] rounded-[22px] bg-composer ps-5 pe-5", className)}
      title={save.state === "saved" && save.savedTo ? t("attach.savedTo", { path: save.savedTo }) : file.name}>
      <button type="button" {...chipNameAction(preview, save, file.name, retryable)}
        className="absolute inset-0 rounded-[22px] focus-visible:outline-none focus-visible:inset-ring-2 focus-visible:inset-ring-focus disabled:cursor-wait" />
      <FileGlyph name={file.name} />
      <span className="pointer-events-none flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 text-[14px] font-medium leading-5 text-ink"><span className="min-w-0 truncate">{base}</span><span className="shrink-0">{ext}</span></span>
        <span role={failed ? "alert" : save.state === "idle" ? undefined : "status"} className={cn("truncate text-[13px] leading-[18px]", failed ? "text-danger" : "text-ink-secondary")}>{meta}</span>
      </span>
      <span className="relative flex shrink-0">
        {preview.opens ? <SaveIconButton name={file.name} save={save} retryable={retryable} /> : <FilePreviewButton path={file.path} name={file.name} message={message} />}
      </span>
      {preview.dialog}
    </section>
  );
}

export function AttachedFileChip({ file, message, linked = false, compact = false, card = false, className }: {
  file: TranscriptFileAttachment;
  message?: MessageAttachmentContext;
  linked?: boolean;
  compact?: boolean;
  /** Simple mode's transcript: grok's white file card. */
  card?: boolean;
  className?: string;
}) {
  const save = useLocalFileSave(file.path, file.name, message);
  const preview = useFilePreview(file.path, file.name, message);
  const failed = save.state === "failed";
  const retryable = failed && !save.outsideWorkspace;
  if (compact) return <CompactFileChip file={file} message={message} linked={linked} save={save} preview={preview} className={className} />;
  if (card && message && (file.private || linked)) return <FileCard file={file} message={message} save={save} preview={preview} retryable={retryable} className={className} />;
  if (!message || (!file.private && !linked)) {
    return (
      <div title={t("attach.legacyFile", { name: file.name })} className={cn("flex max-w-[280px] items-center gap-2 overflow-hidden rounded-lg border border-transparent bg-inset/70 px-2.5 py-2 text-[12px] text-ink-secondary", className)}>
        <FileText size={14} className="shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-ink">{file.name}</span>
        <span className="text-[11px]">{t("attach.unavailable")}</span>
      </div>
    );
  }
  return (
    <div
      title={save.state === "saved" && save.savedTo ? t("attach.savedTo", { path: save.savedTo }) : file.name}
      className={cn("max-w-[280px] overflow-hidden rounded-lg border border-transparent bg-inset/70 text-[12px] text-ink-secondary", className)}
    >
      <div className="flex items-center pe-1">
        <button
          type="button"
          {...chipNameAction(preview, save, file.name, retryable)}
          className="flex min-h-10 min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-raised/70 focus-visible:outline-none focus-visible:inset-ring-2 focus-visible:inset-ring-accent/60 disabled:cursor-wait disabled:hover:bg-transparent"
        >
          <FileText size={14} className="shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-ink">{file.name}</span>
          {preview.opens ? <Eye size={13} className="shrink-0" /> : save.state === "saving" ? (
            <LoaderCircle size={13} className="shrink-0 animate-spin" />
          ) : save.state === "saved" ? (
            <Check size={13} className="shrink-0 text-success" />
          ) : failed ? (
            retryable && <RotateCcw size={13} className="shrink-0 text-danger" />
          ) : (
            <Download size={13} className="shrink-0" />
          )}
        </button>
        {preview.opens ? <SaveIconButton name={file.name} save={save} retryable={retryable} /> : <FilePreviewButton path={file.path} name={file.name} message={message} />}
        {preview.dialog}
      </div>
      {save.state !== "idle" && (
        <div
          role={failed ? "alert" : "status"}
          className={cn(
            "border-t border-transparent px-2.5 py-1.5 text-[11px]",
            failed ? "text-danger" : save.state === "saved" ? "text-success" : "text-ink-secondary",
          )}
        >
          {save.state === "saving"
            ? t("attach.downloading")
            : save.state === "saved"
              ? t("attach.downloaded")
              : saveFailureText(save)}
          {failed && save.outsideWorkspace && (
            <div className="mt-1 flex flex-wrap items-center gap-x-1.5">
              <OutsideWorkspaceFile filePath={file.path} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const FILE_CHIP = "inline-flex h-7 max-w-[16rem] items-center rounded-full bg-ink/[0.06] text-[13px] leading-none text-ink-secondary";

function CompactFileChip({ file, message, linked, save, preview, className }: {
  file: TranscriptFileAttachment;
  message?: MessageAttachmentContext;
  linked: boolean;
  save: ReturnType<typeof useLocalFileSave>;
  preview: ReturnType<typeof useFilePreview>;
  className?: string;
}) {
  const failed = save.state === "failed";
  const retryable = failed && !save.outsideWorkspace;
  const name = <span dir="auto" className="min-w-0 truncate text-ink [unicode-bidi:isolate]">{file.name}</span>;
  if (!message || (!file.private && !linked)) {
    return (
      <span title={t("attach.legacyFile", { name: file.name })} className={cn(FILE_CHIP, "gap-1.5 px-2.5", className)}>
        <FileText size={14} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
        {name}
        <span className="shrink-0 text-[12px]">{t("attach.unavailable")}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex max-w-full flex-col items-start gap-1">
      <span
        title={save.state === "saved" && save.savedTo ? t("attach.savedTo", { path: save.savedTo }) : file.name}
        className={cn(FILE_CHIP, "file-chip pe-0.5", className)}
      >
        <button
          type="button"
          {...chipNameAction(preview, save, file.name, retryable)}
          className="inline-flex h-7 min-w-0 items-center gap-1.5 rounded-full ps-2.5 pe-2 transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-wait"
        >
          <FileText size={14} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
          {name}
          {preview.opens ? <Eye size={13} strokeWidth={1.75} className="shrink-0" aria-hidden="true" /> : save.state === "saving" ? (
            <LoaderCircle size={13} className="shrink-0 animate-spin" aria-hidden="true" />
          ) : save.state === "saved" ? (
            <Check size={13} className="shrink-0 text-success" aria-hidden="true" />
          ) : failed ? (
            retryable && <RotateCcw size={13} className="shrink-0 text-danger" aria-hidden="true" />
          ) : (
            <Download size={13} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
          )}
        </button>
        {preview.opens ? <SaveIconButton name={file.name} save={save} retryable={retryable} /> : <FilePreviewButton path={file.path} name={file.name} message={message} />}
        {preview.dialog}
      </span>
      {save.state !== "idle" && save.state !== "saved" && (
        <span role={failed ? "alert" : "status"} className={cn("px-2.5 text-[12px]", failed ? "text-danger" : "text-ink-secondary")}>
          {save.state === "saving" ? t("attach.downloading") : saveFailureText(save)}
          {failed && save.outsideWorkspace && (
            <span className="ms-1.5 inline-flex flex-wrap items-center gap-x-1.5"><OutsideWorkspaceFile filePath={file.path} /></span>
          )}
        </span>
      )}
      {save.state === "saved" && <span role="status" className="sr-only">{t("attach.downloaded")}</span>}
    </span>
  );
}

/** Security: transcript paths stay inert until the person asks the desktop shell to validate and save a copy. */
export function AttachedFileChips({ files, className, message }: { files: TranscriptFileAttachment[]; className?: string; message?: MessageAttachmentContext }) {
  if (files.length === 0) return null;
  return (
    <div className={cn("mb-2 flex max-w-full flex-wrap justify-end gap-1.5", className)}>
      {files.map((file, index) => (
        <AttachedFileChip key={`${file.path}:${index}`} file={file} message={message} />
      ))}
    </div>
  );
}
