import { createContext, useContext, useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { Icon, type IconName } from "../Icon";
import { useIsPresent } from "motion/react";
import { dialogMotion } from "@/lib/motion-presets";
import { ScrimMotion, SheetMotion, useMotionReduced } from "./SheetMotion";

const buttonBase = "madani-press inline-flex shrink-0 cursor-pointer items-center justify-center gap-1 whitespace-nowrap rounded-[9999px] font-normal outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus disabled:cursor-default";
const sizeLg = "h-9 px-4 text-[14px] leading-5 tracking-[0.01em]";
const sizeMd = "h-8 px-3 text-[14px] leading-5 tracking-[0.01em]";
const sizeRow = "h-[30px] px-3 text-[13px] leading-[18px] tracking-[0.195px]";
const sizeSm = "h-6 px-2 text-[12px] leading-4 tracking-[0.01em]";
const primaryTone = "bg-ink text-app enabled:hover:bg-[color-mix(in_srgb,var(--color-ink)_88.5%,var(--color-menu))] disabled:bg-ink/15 disabled:text-ink/30";
const secondaryTone = "bg-ink/6 text-ink shadow-none enabled:hover:bg-ink/10 disabled:text-ink/30";

/** Grok's kit danger: #e72e3b (sand-bg-danger, brighter than the danger text) under a 0.5px white/15 inset, #c82532 on hover. */
const dangerTone = "bg-danger text-danger-ink shadow-none enabled:hover:bg-[color-mix(in_srgb,var(--color-danger)_88%,black)] in-data-[skin=grok]:bg-[#e72e3b] in-data-[skin=grok]:enabled:hover:bg-[#c82532] disabled:opacity-50";
/** A kit dialog's secondary (a confirm's Cancel): the same ink/6 fill on a firmer 0.5px ink/15 inset. */
const kitSecondaryTone = "bg-ink/6 text-ink shadow-none enabled:hover:bg-ink/10 disabled:text-ink/30";

export const dialogPrimaryCls = cn(buttonBase, sizeLg, primaryTone);
/** Grok's 32px kit buttons: a confirm's Cancel and Delete, a pane's Save. */
export const mdPrimaryCls = cn(buttonBase, sizeMd, primaryTone);
export const mdSecondaryCls = cn(buttonBase, sizeMd, secondaryTone);
export const mdDangerCls = cn(buttonBase, sizeMd, dangerTone);
export const confirmCancelCls = cn(buttonBase, sizeMd, kitSecondaryTone);
export const rowButtonCls = cn(buttonBase, sizeRow, secondaryTone);
export const smallButtonCls = cn(buttonBase, sizeSm, secondaryTone);

export const rowTitleCls = "text-[13px] leading-[18px] tracking-[-0.08px] text-ink";
export const rowHintCls = "text-[13px] leading-[18px] tracking-[-0.08px] text-ink/68";
export const footnoteCls = "m-0 pl-2 text-[12px] leading-4 tracking-[0.01em] text-ink/56";
export const listCardCls = "flex flex-col rounded-[14px] bg-menu py-2 outline-1 -outline-offset-1 outline-transparent [outline-style:solid]";
/** A text field: Grok's 32px box at 10px corners, borderless like the composer, a soft ink/4 fill that deepens to ink/7
 * on focus (with the caret, the focus cue), no ring. */
export const textFieldCls = "block h-8 w-full min-w-0 rounded-[10px] border border-transparent bg-transparent px-[9px] text-[13px] leading-[18px] tracking-[0.195px] text-ink outline-none placeholder:text-ink/40 disabled:opacity-50";
/** The same field grown into a few lines. */
export const textAreaCls = "block w-full resize-none rounded-[10px] border border-transparent bg-transparent px-[9px] py-[7px] text-[13px] leading-[18px] tracking-[0.195px] text-ink outline-none [scrollbar-width:thin] placeholder:text-ink/40 disabled:opacity-50";
/** A field's label, 4px over it; an "(Optional)" beside it reads ink/40. */
export const fieldLabelCls = "text-[11px] leading-4 tracking-[0.01em] text-ink/68";

/** Grok's form dialog (New login), for a dialog that does not use GrokDialog itself: a white sheet on a 1px ink/12
 * edge at 14px corners, a 14/20 600 title beside a 24px close, a 16px-wide body and a borderless footer. */
export const formSheetCls = "relative flex max-h-[calc(100dvh-32px)] w-full flex-col overflow-hidden rounded-[14px] border border-transparent bg-menu text-[13px] font-[425] leading-[18px] text-ink outline-none focus-visible:outline-none!";
export const formHeaderCls = "flex shrink-0 items-start gap-2 py-3 pl-4 pr-3";
export const formTitleCls = "m-0 min-w-0 flex-1 truncate text-[14px] font-semibold leading-5 tracking-[0.01em] text-ink";
export const formCloseCls = "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-[6px] text-ink/68 transition-[color,background-color] duration-[120ms] ease-[ease] hover:bg-ink/6 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus";
export const formBodyCls = "min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-1.5 pt-1 [scrollbar-width:thin]";
export const formFooterCls = "flex shrink-0 items-center justify-end gap-2 px-4 pb-4 pt-2.5";

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])";

/** Set by a sheet with a rail (the bot's settings): a dialog inside it draws as that sheet's pane instead of its own sheet. */
export const DialogPane = createContext(false);

/** Focus into the dialog on open and back to the opener on close, Escape to close, Tab kept inside. A nested dialog
 * handles its own keys. */
export function useDialogKeys(sheet: RefObject<HTMLElement | null>, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = sheet.current;
    (root?.querySelector<HTMLElement>("[data-autofocus]") ?? root)?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      const box = sheet.current;
      if (!box || (event.key !== "Escape" && event.key !== "Tab")) return;
      const target = event.target instanceof Element ? event.target : null;
      const nested = target?.closest('[role="dialog"], [role="alertdialog"]');
      if (nested && nested !== box) return;
      if (event.key === "Escape") {
        if (event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        close.current();
        return;
      }
      const controls = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.getClientRects().length > 0);
      const head = controls[0];
      const tail = controls.at(-1);
      if (!head || !tail) { event.preventDefault(); box.focus(); return; }
      if (!box.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? tail : head).focus(); return; }
      if (event.shiftKey && (document.activeElement === head || document.activeElement === box)) { event.preventDefault(); tail.focus(); }
      else if (!event.shiftKey && document.activeElement === tail) { event.preventDefault(); head.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [sheet]);

  return close;
}

/** On its own, Grok's form dialog (New login), easing in as bencho's modal does; inside a railed sheet, that sheet's pane. */
export function GrokDialog(props: DialogProps) {
  return useContext(DialogPane) ? <PaneView {...props} /> : <SheetView {...props} />;
}

interface DialogProps {
  title: ReactNode;
  description?: ReactNode;
  /** a small picture over the title, sheet only */
  art?: ReactNode;
  width?: number;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
  "data-panel-modal"?: string;
  /** Eases in, and out when the parent keeps it in an AnimatePresence; false opens and closes it raw. Sheet only. */
  animated?: boolean;
  /** A short notice, a line or two under the title: the title sits centred on its close and the words follow close
   * under it, as a confirm's do, sheet only. */
  notice?: boolean;
}

const headerCls = "flex shrink-0 flex-col gap-1 pb-1.5 pl-8 pr-[54px] pt-8";
const titleCls = "m-0 min-w-0 truncate pl-2 text-[17px] font-medium leading-6 tracking-[0.01em]";

/** The same dialog as one pane of a railed sheet: Settings' header and scrolling body, the footer right under its content.
 * Grok's panes carry a title and nothing under it, so a description is left to the dialog on its own. */
function PaneView({ title, description: _description, art: _art, footer, children, onClose: _onClose, width: _width, animated: _animated, notice: _notice, ...rest }: DialogProps) {
  const titleId = useId();
  return (
    <section {...rest} aria-labelledby={titleId} className="flex min-h-0 flex-1 flex-col">
      <header className={headerCls}>
        <h2 id={titleId} className={titleCls}>{title}</h2>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-8 pb-7 pt-[22px] [scrollbar-width:none]">
        {children}
        {footer && <div className="mt-3 flex shrink-0 items-center justify-end gap-2">{footer}</div>}
      </div>
    </section>
  );
}

function SheetView({ title, description, art, width = 440, onClose, footer, children, animated = true, notice = false, ...rest }: DialogProps) {
  const sheet = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const close = useDialogKeys(sheet, onClose);
  const reduced = useMotionReduced();
  const motion = animated ? dialogMotion(reduced) : null;
  // motion animates it, so the css keyframe on [aria-modal] and the scrim's fade stand down
  const raw = motion ? "" : undefined;
  // on its way out (inside its parent's AnimatePresence) it takes no more presses or focus
  const leaving = !useIsPresent();

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" inert={leaving || undefined} data-leaving={leaving ? "" : undefined}>
      <ScrimMotion aria-hidden="true" data-modal-scrim data-raw-dialog={raw} className="ui-dialog-scrim absolute inset-0" onMouseDown={() => close.current()} {...motion?.scrim} />
      <SheetMotion
        ref={sheet}
        {...rest}
        {...motion?.sheet}
        data-raw-dialog={raw}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        style={{ maxWidth: `min(${width}px, calc(100vw - 32px))` }}
        className={formSheetCls}
      >
        <header className={cn(formHeaderCls, notice && "items-center pb-1")}>
          {art
            ? <div className="flex min-w-0 flex-1 flex-col items-start gap-3 pt-1">{art}<h2 id={titleId} className={cn(formTitleCls, "w-full")}>{title}</h2></div>
            : <h2 id={titleId} className={formTitleCls}>{title}</h2>}
          <button type="button" aria-label={t("common.close")} onClick={() => close.current()} className={formCloseCls}>
            <Icon name="close" size={16} />
          </button>
        </header>
        <div className={cn(formBodyCls, "flex flex-col", notice && "pt-0", !footer && "pb-4")}>
          {description && <p id={descriptionId} className={cn(rowHintCls, "m-0 mb-3 text-pretty")}>{description}</p>}
          {children}
        </div>
        {footer && <div className={formFooterCls}>{footer}</div>}
      </SheetMotion>
    </div>,
    document.body,
  );
}

/** A small action on a row, shown on hover, on touch and whenever the row holds focus. */
export function RowIconButton({ icon, label, onClick, disabled, reveal = false, ...rest }: {
  icon: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  reveal?: boolean;
  "data-modal-action"?: string;
}) {
  return (
    <button
      type="button"
      {...rest}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-[6px] text-ink/66 transition-[background-color,color,opacity] duration-[120ms] ease-[ease] enabled:hover:bg-ink/6 enabled:hover:text-ink focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus disabled:cursor-default disabled:text-ink/24",
        reveal && "opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 touch:opacity-100",
      )}
    >
      <Icon name={icon} size={14} />
    </button>
  );
}
