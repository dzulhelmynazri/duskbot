import { ImagePlus, Loader2, Trash2 } from "../icons";

import type { Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import {
  PICKABLE_STATES,
  MAUS_COLOR_LABEL,
  colorSwatch,
  PICKER_COLORS,
  type MausMotion,
  type MausState,
} from "@/lib/mascot";
import { BOT_AVATAR_CROPS } from "../../shared/bot-avatar";
import { MADANI_BODY_IDS, MADANI_BODY_NAMES } from "../../shared/body-migration";
import { DEFAULT_BOT_BODY, wearsBody, type BotBodyId } from "../../shared/bot-body";
import { BotAvatar, MausAvatar } from "./Avatar";
import { AvatarImageGenerator } from "./AvatarImageGenerator";
import { AvatarFraming, OrganizationAvatarIcons, RESET_MASCOT_PATCH, useAvatarImage, type AvatarPatch } from "./avatar-editing";
import { t } from "@/lib/i18n";
import { MascotFaceColorPicker } from "./MascotFaceColorPicker";
import { rowButtonCls, smallButtonCls } from "./ui/GrokDialog";

const LABEL = "mb-2 mt-5 pl-0.5 text-[12px] leading-4 tracking-[0.01em] text-ink/68";
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus";

export function BotProfileAvatarCard({
  bot,
  activeState,
  mascotMotion,
  onPatch,
}: {
  bot: Bot;
  activeState: MausState;
  mascotMotion: { kind: Exclude<MausMotion, "none">; nonce: number } | null;
  onPatch: (patch: AvatarPatch) => void;
}) {
  const { fileRef, crop, uploading, generating, setSavingConnection, busy, error, upload, removeImage, generate } = useAvatarImage(bot, onPatch);

  return (
    <div className="overflow-hidden rounded-[14px] border border-transparent bg-menu">
      <div className="flex items-center justify-between gap-3 pl-3.5 pr-2.5 pt-2.5">
        <span className="text-[13px] leading-[18px] tracking-[-0.08px] text-ink">{t("botIdentity.avatar")}</span>
        <button
          type="button"
          disabled={busy}
          onClick={() => onPatch(RESET_MASCOT_PATCH)}
          className={smallButtonCls}
        >
          {t("botIdentity.resetMascot")}
        </button>
      </div>

      <div className="px-3.5 pb-3.5 pt-1">
        <OrganizationAvatarIcons busy={busy} onUpload={(file) => void upload(file)} />
        {crop !== "mascot" && bot.avatarUrl ? (
          <AvatarFraming bot={bot} disabled={busy} onPatch={onPatch} />
        ) : (
          <div className="flex justify-center py-2">
            <BotAvatar
              bot={bot}
              state={activeState}
              size={96}
              motion={mascotMotion?.kind ?? "none"}
              motionKey={mascotMotion?.nonce ?? 0}
            />
          </div>
        )}

        <div className="mt-2 flex gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            className="sr-only"
            onChange={(event) => void upload(event.target.files?.[0])}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className={cn(rowButtonCls, "flex-1")}
          >
            {uploading ? <Loader2 size={14} className="animate-spin" /> : <ImagePlus size={14} />}
            {t("botIdentity.uploadImage")}
          </button>
          {bot.avatarUrl && (
            <button
              type="button"
              onClick={removeImage}
              disabled={busy}
              aria-label={t("botIdentity.removeAvatar")}
              title={t("botIdentity.removeImage")}
              className={cn("flex size-[30px] shrink-0 cursor-pointer items-center justify-center rounded-full text-ink/68 transition-colors duration-[120ms] ease-[ease] hover:bg-ink/6 hover:text-danger disabled:opacity-50", FOCUS)}
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
        <div className="mt-1.5 pl-0.5 text-[12px] leading-4 text-ink/56">{t("botIdentity.imageTypes")}</div>

        <div className={LABEL}>
          {t("botIdentity.shape")}
        </div>
        <div className="grid grid-cols-4 gap-0.5 rounded-full bg-ink/4 p-0.5">
          {BOT_AVATAR_CROPS.map((candidate) => (
            <button
              key={candidate}
              type="button"
              disabled={busy}
              aria-pressed={crop === candidate}
              onClick={() => onPatch({ avatarCrop: candidate })}
              className={cn(
                "h-6 cursor-pointer rounded-full text-[12px] leading-4 transition-colors duration-[120ms] ease-[ease] disabled:opacity-50",
                FOCUS,
                crop === candidate ? "bg-menu text-ink shadow-none" : "text-ink/68 hover:text-ink",
              )}
            >
              {t(`botIdentity.crop.${candidate}` as never)}
            </button>
          ))}
        </div>

        {crop === "mascot" && (
          <>
            <MascotFaceColorPicker bot={bot} disabled={busy} onPatch={onPatch} />
            <div className={LABEL}>
              {t("botIdentity.expression")}
            </div>
            <div className="grid grid-cols-5 gap-1">
              {PICKABLE_STATES.map((expression) => (
                <button
                  key={expression}
                  type="button"
                  disabled={busy}
                  aria-pressed={activeState === expression}
                  onClick={() => onPatch({ mascotExpression: expression })}
                  className={cn(
                    "flex h-12 cursor-pointer items-center justify-center rounded-[10px] transition-colors duration-[120ms] ease-[ease] hover:bg-ink/5 disabled:opacity-50",
                    FOCUS,
                    activeState === expression && "bg-ink/8 hover:bg-ink/8",
                  )}
                  title={expression}
                  aria-label={`Use ${expression} expression`}
                >
                  <MausAvatar color={bot.color} faceColor={bot.mascotFaceColor} bodyId={bot.mascotBody ?? undefined} state={expression} size={32} animated={false} />
                </button>
              ))}
            </div>

            <div className={LABEL}>
              {t("botIdentity.color")}
            </div>
            <div className="flex flex-wrap gap-2">
              {PICKER_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  disabled={busy}
                  aria-pressed={bot.color === color}
                  onClick={() => onPatch({ color })}
                  className={cn("flex size-8 cursor-pointer items-center justify-center rounded-full border border-transparent hover:border-transparent disabled:opacity-50", FOCUS)}
                  title={t(MAUS_COLOR_LABEL[color])}
                  aria-label={`Use ${color} mascot color`}
                >
                  <span
                    className="block size-6 rounded-full"
                    style={{ background: colorSwatch(color), boxShadow: bot.color === color ? "0 0 0 3px var(--color-menu), 0 0 0 4px color-mix(in srgb, var(--color-ink) 24%, transparent)" : undefined }}
                  />
                </button>
              ))}
            </div>

            <div className={LABEL}>
              {t("botIdentity.body")}
            </div>
            <div className="grid grid-cols-5 gap-1">
              {MADANI_BODY_IDS.map((id) => (
                <BodyButton key={id} id={id} name={MADANI_BODY_NAMES[id]} bot={bot} busy={busy} onPatch={onPatch} />
              ))}
            </div>
          </>
        )}

        <div className={LABEL}>{t("botIdentity.ai.generateWith")}</div>
        <AvatarImageGenerator
          botLabel={bot.title || bot.name}
          disabled={uploading}
          generating={generating}
          onGenerate={generate}
          onSavingChange={setSavingConnection}
        />

        {error && <div role="alert" className="mt-3 text-[12px] leading-4 text-danger">{error}</div>}
      </div>
    </div>
  );
}

function BodyButton({ id, name, bot, busy, onPatch }: {
  id: BotBodyId;
  name: string;
  bot: Bot;
  busy: boolean;
  onPatch: (patch: AvatarPatch) => void;
}) {
  const selected = wearsBody(bot.mascotBody ?? DEFAULT_BOT_BODY, id);
  return (
    <button
      type="button"
      disabled={busy}
      aria-pressed={selected}
      aria-label={`Use the ${name} body`}
      onClick={() => onPatch({ mascotBody: id })}
      className={cn(
        "flex h-12 cursor-pointer items-center justify-center rounded-[10px] transition-colors duration-[120ms] ease-[ease] disabled:opacity-50",
        FOCUS,
        selected ? "bg-ink/8 text-ink" : "text-ink/68 hover:bg-ink/5",
      )}
    >
      <MausAvatar color={bot.color} faceColor={bot.mascotFaceColor} bodyId={id} size={32} animated={false} trackPointer={false} />
    </button>
  );
}
