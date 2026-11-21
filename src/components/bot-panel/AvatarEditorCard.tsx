import { useEffect, useRef, type KeyboardEvent } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { upperFirst } from "@/lib/lower-first";
import { MAUS_COLOR_LABEL, PICKER_COLORS, colorSwatch, rowsOfFive, type MausState } from "@/lib/mascot";
import type { Bot } from "@/state/store";
import { DEFAULT_BOT_BODY, wearsBody, type BotBodyId } from "../../../shared/bot-body";
import { MADANI_BODY_IDS } from "../../../shared/body-migration";
import { MausAvatar } from "../Avatar";
import { BodyRing } from "../mascot-view";
import { useAvatarImage, type AvatarPatch } from "../avatar-editing";

export type AvatarEditorTab = "bot" | "generate" | "upload";

/** Our bodies, in two rows of five. */
const SHAPE_ROWS = rowsOfFive(MADANI_BODY_IDS);

export function AvatarEditorCard({ bot, onPatch, onClose }: {
  bot: Bot;
  activeState: MausState;
  onPatch: (patch: AvatarPatch) => void;
  onClose: () => void;
}) {
  const image = useAvatarImage(bot, onPatch);
  const { crop, busy, error } = image;
  const showsImage = crop !== "mascot" && Boolean(bot.avatarUrl);
  const cardRef = useRef<HTMLDivElement>(null);
  // The card is a dialog: focus moves into it, onto the chosen shape, so Escape and Tab work from the start.
  useEffect(() => {
    const card = cardRef.current;
    if (!card || typeof card.querySelector !== "function") return;
    (card.querySelector<HTMLElement>('[aria-pressed="true"]') ?? card.querySelector<HTMLElement>("button"))?.focus();
  }, []);
  const pickMascot = (patch: AvatarPatch) => onPatch(crop === "mascot" ? patch : { ...patch, avatarCrop: "mascot" });
  const body = bot.mascotBody ?? DEFAULT_BOT_BODY;
  const shapeButton = (id: BotBodyId) => {
    const chosen = !showsImage && wearsBody(body, id);
    return (
      <button
        key={id}
        type="button"
        disabled={busy}
        aria-pressed={chosen}
        aria-label={t("botPanel.avatar.shapeNamed", { name: upperFirst(id) })}
        title={id}
        onClick={() => pickMascot({ mascotBody: id })}
        className="group/shape relative flex size-12 cursor-pointer items-center justify-center disabled:opacity-50"
      >
        <span className="relative flex">
          <MausAvatar color={bot.color} faceColor={bot.mascotFaceColor} bodyId={id} size={36} animated={false} trackPointer={false} />
          <BodyRing body={id} size={36} className={cn("pointer-events-none absolute inset-0 text-ink", chosen ? "opacity-24" : "opacity-0 group-hover/shape:opacity-12")} />
        </span>
      </button>
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-label={t("botPanel.avatar.edit")}
      ref={cardRef}
      data-panel-avatar-editor
      onKeyDown={onKeyDown}
      className="popover-surface absolute inset-x-[-5px] top-[78px] z-30 overflow-hidden rounded-[16px] border border-ink/[0.08] bg-menu text-left shadow-(--shadow-popover)"
    >
      <div className="p-3">
        {(
          <div className="flex flex-col gap-3">
            <div aria-label={t("botPanel.avatar.shapes")} className="flex flex-col gap-2 py-1.5">
              {SHAPE_ROWS.map((row, index) => (
                <div key={index} className="flex justify-center gap-2">{row.map(shapeButton)}</div>
              ))}
            </div>
            <div aria-label={t("botPanel.avatar.colors")} className="mx-auto flex w-[232px] flex-wrap justify-center gap-2 py-2">
              {PICKER_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  disabled={busy}
                  aria-pressed={bot.color === color}
                  aria-label={t("botPanel.avatar.colorNamed", { color: t(MAUS_COLOR_LABEL[color]) })}
                  title={t(MAUS_COLOR_LABEL[color])}
                  onClick={() => pickMascot({ color })}
                  className="flex size-8 cursor-pointer items-center justify-center rounded-full border border-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50"
                >
                  <span
                    className={cn("size-6 rounded-full", bot.color === color && "shadow-[0_0_0_3px_var(--color-menu),0_0_0_4px_rgb(28_28_28/0.24)]")}
                    style={{ background: colorSwatch(color) }}
                  />
                </button>
              ))}
            </div>
          </div>
        )}


        {error && <div role="alert" className="mt-3 text-[12px] text-danger">{error}</div>}
      </div>
    </div>
  );
}
