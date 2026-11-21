import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ClipboardPaste, MessageSquareText, RotateCcw, X } from "../icons";
import { Icon } from "./Icon";
import { cn } from "@/lib/cn";
import {
  attachmentImageUrl,
  intakeFiles,
  formatSize,
  imageBytesLeft,
  imageSlotsLeft,
  pasteSummary,
  type Attachment,
  type FileAttachment,
  type PasteAttachment,
} from "@/lib/composer-attachments";
import { AttachmentPreviewDialog, FileGlyph, previewImage, type PreviewImage } from "./AttachmentPreview";
import { movesLess } from "./composer-wrap";
import { rememberImageSize } from "@/lib/image-cache";
import { t } from "@/lib/i18n";
import { notesInFiles } from "@/lib/assistant-notes";
import { UploadRing } from "./UploadRing";

/** Electron 32 removed File.path, so only the preload can name a file. */
export function pathForFile(file: File): string {
  return window.madaniDesktop?.getPathForFile?.(file) ?? "";
}

/** Drag and drop onto the window: grok's drop overlay over the chat pane, and the files go to the composer. */
export function ComposerAttachments({
  items,
  onAdd,
  allowImages = true,
  onNotice,
  onNotes,
  onPendingChange,
  onDraggingChange,
  uploadImage,
  uploadFile,
}: {
  items: Attachment[];
  onAdd: (attachments: Attachment[]) => void;
  allowImages?: boolean;
  onNotice: (notice: string | null) => void;
  /** A dropped file of notes another AI wrote: brought in, not attached. */
  onNotes?: (text: string) => void;
  onPendingChange?: (pending: boolean) => void;
  onDraggingChange?: (dragging: boolean) => void;
  uploadImage: (file: File) => Promise<Attachment | null>;
  uploadFile?: (file: File) => Promise<FileAttachment | "placed" | null>;
}) {
  const [dragging, setDragging] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const [pane, setPane] = useState<DOMRect | null>(null);
  // dragenter/dragleave fire once per element crossed, so the overlay tracks depth.
  const depth = useRef(0);
  // A drop past the images the message can still take is left out with a notice.
  const imageSlots = imageSlotsLeft(items);
  const imageBytes = imageBytesLeft(items);
  const callbacks = useRef({ onAdd, onNotice, onNotes, onPendingChange, allowImages, imageSlots, imageBytes, uploadImage, uploadFile });
  callbacks.current = { onAdd, onNotice, onNotes, onPendingChange, allowImages, imageSlots, imageBytes, uploadImage, uploadFile };
  const pendingDrops = useRef(new Set<symbol>());
  const draggingChanged = useRef(onDraggingChange);
  draggingChanged.current = onDraggingChange;
  useEffect(() => draggingChanged.current?.(dragging), [dragging]);

  useEffect(() => {
    const carriesFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

    const onEnter = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      depth.current += 1;
      setPane(anchor.current?.closest("main")?.getBoundingClientRect() ?? null);
      setDragging(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    // Without preventDefault the window navigates to the dropped file.
    const onOver = (e: DragEvent) => {
      if (carriesFiles(e)) e.preventDefault();
    };
    const onDrop = async (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      let files = Array.from(e.dataTransfer?.files ?? []);
      const notes = callbacks.current.onNotes ? await notesInFiles(files) : null;
      if (notes) {
        callbacks.current.onNotes?.(notes.text);
        files = files.filter((file) => !notes.names.includes(file.name));
        if (!files.length) return;
      }
      const operation = Symbol("attachment-drop");
      pendingDrops.current.add(operation);
      callbacks.current.onPendingChange?.(true);
      try {
        const { attachments, notice: message } = await intakeFiles(files, {
          allowImages: callbacks.current.allowImages,
          getPath: pathForFile,
          uploadImage: callbacks.current.uploadImage,
          uploadFile: callbacks.current.uploadFile,
          imageSlots: callbacks.current.imageSlots,
          imageBytes: callbacks.current.imageBytes,
        });
        if (attachments.length) callbacks.current.onAdd(attachments);
        if (message) callbacks.current.onNotice(message);
      } finally {
        if (pendingDrops.current.delete(operation)) callbacks.current.onPendingChange?.(false);
      }
    };

    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  return (
    <>
      <span ref={anchor} hidden />
      {dragging && createPortal(
        <div
          style={pane ? { top: pane.top + 8, left: pane.left + 8, width: pane.width - 16, height: pane.height - 16 } : undefined}
          className={cn("composer-drop pointer-events-none fixed z-[60] flex flex-col items-center justify-center gap-1.5 rounded-lg border-[1.5px] border-dashed border-ink/25 bg-[color-mix(in_srgb,var(--color-app)_88%,transparent)] backdrop-blur-md", !pane && "inset-2")}
        >
          <span className="relative flex rounded-xl bg-composer p-2.5 text-ink shadow-[inset_0_0_0_0.5px_rgb(28_28_28/0.08)]" aria-hidden="true">
            <span className="flex size-[22px] items-center justify-center"><Icon name="camera" size={18} /></span>
          </span>
          <span className="relative text-[14px] leading-5 font-semibold text-ink">{t("composer.dropToAttach")}</span>
        </div>,
        document.body,
      )}
    </>
  );
}

const TILE_REMOVE = "opacity-0 transition-[opacity,background-color] duration-[120ms] ease-[ease] group-hover/tile:opacity-100 focus-visible:opacity-100 touch:opacity-100";
const CARD = "group/tile relative flex h-14 w-[calc(50%-4px)] min-w-[220px] max-w-[354px] shrink-0 items-center gap-2 rounded-[10px] bg-composer p-2 shadow-[0_0_0_0.5px_rgb(28_28_28/0.08),0_1px_4px_rgb(28_28_28/0.07),0_6px_12px_rgb(28_28_28/0.035)]";

/**
 * grok's attachments inside the composer: 56px tiles 8px apart in one scrolling row above the field, files as
 * cards, and a one-line notice above them. The row rides the pill's top edge while the pill opens.
 */
export function ComposerAttachmentStrip({ items, onRemove, onRetry, onDisplayInChatBox, notice, onNotice }: {
  items: Attachment[];
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
  onDisplayInChatBox: (attachment: PasteAttachment) => void;
  notice: string | null;
  onNotice: (notice: string | null) => void;
}) {
  const [preview, setPreview] = useState<{ images: PreviewImage[]; index: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const shown = items.length > 0 || Boolean(notice);
  useEffect(() => { if (!items.length) onNotice(null); }, [items.length, onNotice]);
  useLayoutEffect(() => {
    const strip = ref.current;
    const content = strip?.parentElement;
    const shell = content?.parentElement;
    if (!shown || !strip || !content || !shell || shell.dataset.snap !== undefined || movesLess() || typeof strip.animate !== "function") return;
    const style = getComputedStyle(shell);
    const grow = content.offsetHeight + (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0) - shell.offsetHeight;
    if (grow <= 0) return;
    const easing = getComputedStyle(document.documentElement).getPropertyValue("--composer-spring").trim() || "ease-out";
    strip.animate([{ transform: `translateY(${grow}px)` }, { transform: "none" }], { duration: 300, easing });
  }, [shown]);
  if (!shown) return null;
  const images = items.flatMap((a) => {
    if (a.kind !== "image") return [];
    const image = previewImage(a.path, a.name);
    const src = image?.src ?? a.previewUrl;
    return src ? [{ id: a.id, image: image ?? { src, name: a.name } }] : [];
  });
  const remove = (id: string) => { onNotice(null); onRemove(id); };
  const retry = (id: string) => { onNotice(null); onRetry(id); };
  return (
    <div ref={ref} data-composer-strip className="mt-0.5 mb-0.5 flex min-w-0 flex-col gap-1">
      {notice && <p role="status" className="px-0.5 text-[11px] leading-[14px] text-ink/56">{notice}</p>}
      {items.length > 0 && (
        <div data-composer-attachments role="list" aria-label={t("attach.gallery")} className="pointer-events-none -mx-[9px] -mt-1.5 -mb-[18px] flex min-w-0 flex-nowrap gap-2 overflow-x-auto px-[9px] pt-1.5 pb-[18px] [scrollbar-width:none] *:pointer-events-auto">
          {items.map((a) => a.kind === "image" ? (
            <div key={a.id} role="listitem" aria-label={a.failed ? `${a.name}, ${t("attach.uploadFailed")}` : a.name} data-composer-attachment aria-busy={a.uploading || undefined}
              className="group/tile relative size-14 shrink-0 overflow-hidden rounded-[10px] border-[0.5px] border-ink/12 bg-composer">
              <button
                type="button"
                onClick={() => {
                  const index = images.findIndex((entry) => entry.id === a.id);
                  if (index >= 0) setPreview({ images: images.map((entry) => entry.image), index });
                }}
                aria-label={t("attach.openFullScreen")}
                className="block size-full rounded-[inherit] transition-[filter] duration-[160ms] ease-[ease] hover:brightness-[1.04] focus-visible:outline-none focus-visible:inset-ring-2 focus-visible:inset-ring-focus"
              >
                <img src={attachmentImageUrl(a.path) ?? a.previewUrl} alt="" loading="eager" fetchPriority="high"
                  onLoad={(event) => rememberImageSize(event.currentTarget.getAttribute("src") ?? "", { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
                  className={cn("block size-full object-cover transition-opacity duration-[180ms] ease-[ease]", (a.uploading || a.failed) && "opacity-60")} />
              </button>
              <UploadRing id={a.id} name={a.name} uploading={Boolean(a.uploading)} failed={Boolean(a.failed)} radius={9.5}
                percentClassName="end-1 bottom-1 rounded-[5px] bg-[rgb(28_28_28/0.62)] px-1 text-[10px] leading-[14px] font-medium text-white" />
              {a.failed && (
                <button type="button" onClick={() => retry(a.id)} aria-label={t("attach.retryNamed", { name: a.name })} title={t("attach.uploadFailed")}
                  className="absolute inset-0 m-auto flex size-7 items-center justify-center rounded-full bg-ink text-app transition-colors duration-[120ms] ease-[ease] hover:bg-[color-mix(in_srgb,var(--color-ink),white_12%)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                  <RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
                </button>
              )}
              <button type="button" onClick={() => remove(a.id)} aria-label={t("attach.removeNamed", { name: a.name })}
                className={cn("absolute end-0.5 top-0.5 flex size-5 items-center justify-center rounded-full bg-ink text-app hover:bg-[color-mix(in_srgb,var(--color-ink),white_12%)]", !a.failed && TILE_REMOVE)}>
                <Icon name="close" size={12} />
              </button>
            </div>
          ) : (
            <div key={a.id} role="listitem" aria-label={a.kind === "paste" ? t("composer.pastedText") : a.name} title={a.kind === "paste" ? a.text.slice(0, 4000) : a.path || undefined}
              data-composer-attachment aria-busy={(a.kind === "file" && a.uploading) || undefined} className={CARD}>
              <span className="flex size-10 shrink-0 items-center justify-center">
                {a.kind === "paste" ? (
                  <span className="chat-file-glyph flex h-10 w-8 items-center justify-center rounded-[6px] bg-composer text-ink/40" aria-hidden="true"><ClipboardPaste size={14} strokeWidth={1.75} /></span>
                ) : <FileGlyph name={a.name} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] leading-5 font-medium text-ink">{a.kind === "paste" ? t("composer.pastedText") : a.name}</span>
                <span className="block truncate text-[13px] leading-[18px] text-ink/68">{a.kind === "paste" ? pasteSummary(a) : a.failed ? t("attach.uploadFailed") : formatSize(a.size)}</span>
              </span>
              {a.kind === "file" && (
                <UploadRing id={a.id} name={a.name} uploading={Boolean(a.uploading)} failed={Boolean(a.failed)} radius={10}
                  percentClassName="end-2.5 bottom-1.5 text-[11px] leading-[14px] font-medium text-ink/56" />
              )}
              <span className={cn("flex shrink-0 items-center", !(a.kind === "file" && a.failed) && TILE_REMOVE)}>
                {a.kind === "file" && a.failed && (
                  <button type="button" onClick={() => retry(a.id)} aria-label={t("attach.retryNamed", { name: a.name })} title={t("attach.retryNamed", { name: a.name })}
                    className="flex size-8 items-center justify-center rounded-full text-ink/66 transition-colors duration-[120ms] ease-out hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                    <RotateCcw size={16} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                )}
                {a.kind === "paste" && (
                  <button type="button" onClick={() => onDisplayInChatBox(a)} aria-label={t("composer.displayPasted")} title={t("composer.displayPasted")}
                    className="flex size-8 items-center justify-center rounded-full text-ink/66 transition-colors duration-[120ms] ease-out hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                    <MessageSquareText size={16} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                )}
                <button type="button" onClick={() => remove(a.id)} aria-label={t("attach.removeNamed", { name: a.kind === "paste" ? t("composer.pastedText") : a.name })}
                  className="flex size-8 items-center justify-center rounded-full text-ink/66 transition-colors duration-[120ms] ease-out hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                  <X size={16} strokeWidth={1.75} aria-hidden="true" />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
      {preview && <AttachmentPreviewDialog image={preview.images[preview.index]!} images={preview.images} initialIndex={preview.index} onClose={() => setPreview(null)} />}
    </div>
  );
}
