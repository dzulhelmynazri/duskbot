import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { motion, useReducedMotion } from "motion/react";
import { MausAvatar } from "@/components/Avatar";
import { WorkingDots } from "@/components/WorkingIndicator";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { PICKER_COLORS, colorSwatch, type MausColor } from "@/lib/mascot";
import { useStore } from "@/state/store";
import { DEFAULT_BOT_BODY, MADANI_BODY_IDS, MADANI_BODY_NAMES, type MadaniBodyId } from "../../../shared/body-migration";
import { Sheet } from "../Sheet";
import { haptic } from "../haptics";
import { spring } from "../motion";
import type { SheetPageProps } from "./registry";

const BODIES = MADANI_BODY_IDS;
const COLORS = PICKER_COLORS;

function moveRadio(event: KeyboardEvent<HTMLDivElement>) {
  const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
  if (!step && event.key !== "Home" && event.key !== "End") return;
  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='radio']"));
  const current = buttons.indexOf(event.target as HTMLButtonElement);
  if (current < 0) return;
  event.preventDefault();
  const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + step + buttons.length) % buttons.length;
  buttons[index]?.focus();
  buttons[index]?.click();
}

export function CreateBotSheet({ open, onClose, onOpenChat }: SheetPageProps<"create">) {
  const { state, dispatch } = useStore();
  const [name, setName] = useState("");
  const [body, setBody] = useState<MadaniBodyId>(DEFAULT_BOT_BODY);
  const [color, setColor] = useState<MausColor>("blue");
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState(false);
  const reduced = useReducedMotion();
  const nameId = useId();
  const pending = state.botCreationPending === true;
  useEffect(() => { if (open) { setName(""); setError(false); setRevision(0); } }, [open]);
  const create = () => {
    if (!name.trim() || pending) return;
    setError(false);
    dispatch({
      type: "newBot",
      look: { name: name.trim(), color, mascotBody: body },
      preserveSelection: true,
      onCreated: (bot) => { haptic("success"); onClose(); onOpenChat(bot.id); },
      onError: () => { setError(true); haptic("error"); },
    });
  };
  return (
    <Sheet open={open} onClose={onClose} title={t("mobile.create.title")} bodyClassName="flex flex-col">
      <form onSubmit={(event) => { event.preventDefault(); create(); }} className="flex flex-col gap-5 px-5 pt-1">
        <motion.div key={revision} initial={{ scale: revision && !reduced ? 0.94 : 1 }} animate={{ scale: 1 }} transition={spring.lively} className="self-center">
          <MausAvatar bodyId={body} color={color} size={96} animated={false} label={t("mobile.create.preview")} />
        </motion.div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={nameId} className="px-1 text-[14px] font-semibold text-ink-secondary">{t("mobile.create.name")}</label>
          <input id={nameId} name="botName" value={name} maxLength={80} autoComplete="off" enterKeyHint="done" onChange={(event) => setName(event.target.value)} placeholder={t("mobile.create.placeholder")} className="h-12 w-full rounded-[14px] border-0 bg-menu px-4 text-[17px] font-medium text-ink outline-none placeholder:text-ink-tertiary focus-visible:ring-2 focus-visible:ring-ink/30" />
        </div>
        <p id={`${nameId}-look`} className="-mb-2 px-1 text-[14px] font-semibold text-ink-secondary">{t("mobile.create.look")}</p>
        <div role="radiogroup" aria-label={t("mobile.create.body")} onKeyDown={moveRadio} className="grid grid-cols-5 justify-items-center gap-y-3">
          {BODIES.map((id) => (
            <button key={id} type="button" role="radio" aria-checked={id === body} aria-label={MADANI_BODY_NAMES[id]} tabIndex={id === body ? 0 : -1} onClick={() => { if (id !== body) { setBody(id); setRevision((value) => value + 1); haptic("pick"); } }} className="mobile-press flex size-12 items-center justify-center rounded-full">
              <span className={cn("flex size-10 items-center justify-center rounded-full", id === body && "ring-2 ring-ink ring-offset-[3px] ring-offset-(--m-sheet-page)")}><MausAvatar bodyId={id} color={color} size={40} animated={false} label="" /></span>
            </button>
          ))}
        </div>
        <div role="radiogroup" aria-label={t("mobile.create.colour")} onKeyDown={moveRadio} className="grid grid-cols-5 justify-items-center">
          {COLORS.map((value) => (
            <button key={value} type="button" role="radio" aria-label={t(`mobile.create.colour.${value}`)} aria-checked={value === color} tabIndex={value === color ? 0 : -1} onClick={() => { if (value !== color) { setColor(value); setRevision((count) => count + 1); haptic("pick"); } }} className="mobile-press flex size-11 items-center justify-center rounded-full">
              <span className={cn("size-[30px] rounded-full", value === color && "ring-2 ring-ink ring-offset-[3px] ring-offset-(--m-sheet-page)")} style={{ background: colorSwatch(value) }} />
            </button>
          ))}
        </div>
        <div className="sticky bottom-[calc(-1*max(var(--m-safe-bottom),16px))] -mb-[max(var(--m-safe-bottom),16px)] bg-(--m-sheet-page) pb-[calc(max(var(--m-safe-bottom),16px)+4px)] pt-2">
          <button type="submit" disabled={!name.trim() || pending} aria-busy={pending} aria-describedby={!name.trim() ? `${nameId}-hint` : undefined} className="mobile-press flex h-12 w-full items-center justify-center rounded-full bg-ink text-[16px] font-semibold text-app disabled:opacity-40">
            {pending ? <><WorkingDots size={4} /><span className="sr-only">{t("mobile.create.creating")}</span></> : t("mobile.create.submit")}
          </button>
          {!name.trim() && !pending && <p id={`${nameId}-hint`} className="mt-2 text-center text-[14px] font-medium text-ink-secondary">{t("mobile.create.needsName")}</p>}
          {error && <p role="alert" className="mt-3 text-center text-[15px] text-danger">{t("mobile.create.error")}</p>}
        </div>
      </form>
    </Sheet>
  );
}
