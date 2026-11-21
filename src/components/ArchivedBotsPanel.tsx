import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Trash2, X } from "../icons";

import { t } from "@/lib/i18n";
import { api, openBot, useStore, type Bot } from "@/state/store";

import { BotAvatar } from "./Avatar";
import { archivableChief } from "./bot-archive";
import { ConfirmDialog } from "./ConfirmDialog";
import { PixelIcon } from "./ui/PixelIcon";
import { cn } from "@/lib/cn";
import { footnoteCls, formBodyCls, formCloseCls, formHeaderCls, formSheetCls, formTitleCls, rowHintCls, smallButtonCls } from "./ui/GrokDialog";
import { friendlyError } from "@/lib/plain-error";

const dangerSmallCls = "madani-press inline-flex h-6 shrink-0 cursor-pointer items-center justify-center gap-1 whitespace-nowrap rounded-full px-2 text-[12px] leading-4 tracking-[0.01em] text-danger outline-none hover:bg-danger/10 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus disabled:cursor-default disabled:opacity-40";

export type BotConfirmKind = "archive" | "delete";

/** `chief`: deleting a Chief of Staff, whose chats hold the team's whole setup, which archiving it would keep. */
export function botConfirmCopy(kind: BotConfirmKind, name: string, chief = false) {
  return kind === "archive"
    ? {
        title: t("sidebar.confirm.archiveTitle", { name }),
        body: t("confirm.botArchive"),
        confirmLabel: t("sidebar.bot.archive"),
        tone: "neutral" as const,
        art: <PixelIcon name="parcel" size={28} />,
      }
    : {
        title: t("sidebar.confirm.deleteTitle", { name }),
        // a Chief's own line suggests archiving; it still says what deleting takes with it
        body: chief ? `${t("confirm.botDeleteChief")} ${t("confirm.botDelete")}` : t("confirm.botDelete"),
        confirmLabel: t("common.delete"),
        tone: "danger" as const,
        art: <PixelIcon name="alert" size={28} />,
      };
}

/** The dialog that asks before a bot is archived or deleted; deleting a Chief of Staff offers to archive it instead. */
export function botConfirmProps(confirm: { kind: BotConfirmKind; bot: Bot } | null, bots: readonly Bot[], act: {
  archive: (bot: Bot) => void;
  remove: (bot: Bot) => void;
  archiveInstead: (chief: Bot) => void;
}) {
  const chief = confirm?.kind === "delete" ? archivableChief(bots, confirm.bot.id) : undefined;
  return {
    open: confirm !== null,
    ...(confirm ? botConfirmCopy(confirm.kind, confirm.bot.name, Boolean(chief)) : botConfirmCopy("archive", "")),
    alternative: chief ? { label: t("sidebar.confirm.archiveInstead"), onClick: () => act.archiveInstead(chief) } : undefined,
    onConfirm: () => {
      if (!confirm) return;
      if (confirm.kind === "archive") act.archive(confirm.bot);
      else act.remove(confirm.bot);
    },
  };
}

export function archivedDeleteAllCopy() {
  return {
    title: t("sidebar.archived.deleteAllTitle"),
    body: t("confirm.archivedDeleteAll"),
    confirmLabel: t("sidebar.archived.deleteAll"),
    tone: "danger" as const,
  };
}

export function ArchivedBotRow({
  bot,
  restoring,
  deleting,
  disabled,
  onRestore,
  onDelete,
}: {
  bot: Bot;
  restoring: boolean;
  deleting: boolean;
  disabled: boolean;
  onRestore: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-[10px] px-2 py-2 hover:bg-ink/[0.035]">
      <BotAvatar bot={bot} state="happy" size={32} animated={false} />
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <div className="truncate text-[13px] font-medium leading-[18px] text-ink">{bot.name}</div>
        <div className="truncate text-[13px] leading-[18px] text-ink/68">{bot.title || t("sidebar.archived.botFallback")}</div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onRestore}
          disabled={disabled || deleting}
          className={smallButtonCls}
        >
          {restoring && <Loader2 size={12} className="animate-spin" />}
          {t("sidebar.archived.restore")}
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={disabled || deleting}
          aria-label={t("sidebar.archived.deleteAria", { name: bot.name })}
          className={dangerSmallCls}
        >
          {deleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
          {t("common.delete")}
        </button>
      </div>
    </div>
  );
}

export function ArchivedBotsPanel({
  bots,
  onClose,
  onRestored,
}: {
  bots: Bot[];
  onClose: () => void;
  onRestored: (message: string) => void;
}) {
  const { state, dispatch } = useStore();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [restoringAll, setRestoringAll] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Bot | "all" | null>(null);
  const [error, setError] = useState("");
  const deleting = bots.some((bot) => Boolean(state.deletingBots[bot.id]));
  const locked = restoringAll || Boolean(busyId) || deleting || Boolean(pendingDelete);

  useEffect(() => {
    if (bots.length === 0) onClose();
  }, [bots.length, onClose]);

  useEffect(() => {
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !locked) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [locked, onClose]);

  const restore = async (bot: Bot) => {
    setBusyId(bot.id);
    setError("");
    try {
      const response = await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ hidden: false }),
      });
      dispatch({ type: "botPatched", bot: response.bot });
      openBot(dispatch, response.bot);
      onRestored(t("sidebar.archived.restored", { name: bot.name }));
      if (bots.length === 1) onClose();
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusyId(null);
    }
  };

  const restoreAll = async () => {
    setRestoringAll(true);
    setError("");
    try {
      const responses = await Promise.all(
        bots.map((bot) =>
          api(`/api/bots/${bot.id}`, {
            method: "PATCH",
            body: JSON.stringify({ hidden: false }),
          }),
        ),
      );
      for (const response of responses) dispatch({ type: "botPatched", bot: response.bot });
      const first = responses[0]?.bot;
      if (first) openBot(dispatch, first);
      onRestored(
        bots.length === 1
          ? t("sidebar.archived.restoredOne")
          : t("sidebar.archived.restoredMany", { count: bots.length }),
      );
      onClose();
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setRestoringAll(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onMouseDown={(event) => event.target === event.currentTarget && !locked && onClose()}
    >
      <div aria-hidden="true" className="ui-dialog-scrim pointer-events-none absolute inset-0" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="archived-bots-title"
        tabIndex={-1}
        className={cn(formSheetCls, "max-h-[min(640px,calc(100dvh-32px))] max-w-[560px]")}
      >
        <header className={formHeaderCls}>
          <div className="min-w-0 flex-1">
            <h2 id="archived-bots-title" className={formTitleCls}>{t("sidebar.archived.title")}</h2>
            <p className={cn(rowHintCls, "m-0")}>{t("sidebar.archived.subtitle")}</p>
          </div>
          <div className="flex items-center gap-1">
            {bots.length > 1 && (
              <button
                type="button"
                onClick={() => void restoreAll()}
                disabled={locked}
                className={smallButtonCls}
              >
                {restoringAll && <Loader2 size={12} className="animate-spin" />}
                {t("sidebar.archived.restoreAll")}
              </button>
            )}
            {bots.length > 0 && (
              <button
                type="button"
                onClick={() => setPendingDelete("all")}
                disabled={locked}
                className={dangerSmallCls}
              >
                <Trash2 size={12} />
                {t("sidebar.archived.deleteAll")}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              disabled={locked}
              className={cn(formCloseCls, "disabled:opacity-40")}
              aria-label={t("sidebar.archived.close")}
            >
              <X size={16} />
            </button>
          </div>
        </header>
        <div className={cn(formBodyCls, "px-2 pb-3")}>
          <div className={cn(footnoteCls, "pb-1")}>{t("sidebar.archived.count", { count: bots.length })}</div>
          <div className="flex flex-col">
            {bots.map((bot) => (
              <ArchivedBotRow
                key={bot.id}
                bot={bot}
                restoring={busyId === bot.id}
                deleting={Boolean(state.deletingBots[bot.id])}
                disabled={locked}
                onRestore={() => void restore(bot)}
                onDelete={() => setPendingDelete(bot)}
              />
            ))}
          </div>
          {error && <p role="alert" className="m-0 px-2 pt-2 text-[12px] leading-4 text-danger">{error}</p>}
        </div>
      </div>
      <ConfirmDialog
        open={pendingDelete !== null}
        {...(pendingDelete === "all"
          ? archivedDeleteAllCopy()
          : botConfirmCopy("delete", pendingDelete?.name ?? ""))}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (!pendingDelete) return;
          const target = pendingDelete;
          setPendingDelete(null);
          if (target === "all") {
            for (const bot of bots) dispatch({ type: "deleteBot", botId: bot.id });
            return;
          }
          dispatch({ type: "deleteBot", botId: target.id });
        }}
      />
    </div>,
    document.body,
  );
}
