import { ModalLayer } from "./ui/ModalLayer";
import { ScrimMotion, SheetMotion, useDialogMotion } from "./ui/SheetMotion";
import { AnimatePresence } from "motion/react";
import { useEffect, useId, useRef, useState, type FocusEvent as ReactFocusEvent, type PointerEvent as ReactPointerEvent } from "react";
import { MADANI_BODY_IDS, type MadaniBodyId } from "../../shared/body-migration";
import { takeImportName } from "../../shared/import-name";
import { MAUS_COLOR_LABEL, PICKER_COLORS, colorSwatch, rowsOfFive, type MausColor } from "@/lib/mascot";
import { useStore } from "@/state/store";
import { prefetchBotDefaults } from "@/lib/bot-defaults-prefetch";
import { stoppedAtBotLimit } from "@/lib/bot-limit";
import { CREATE_BOT_EVENT, openCreateBot, takeCreateBotSection } from "@/lib/create-bot-request";
import { openNewGroup } from "@/lib/new-group-request";
import { t } from "@/lib/i18n";
import { upperFirst } from "@/lib/lower-first";
import { cn } from "@/lib/cn";
import { MausAvatar, type MausAvatarHandle } from "./Avatar";
import { Icon } from "./Icon";
import { hoverGaze } from "./mascot-engine";
import { BodyRing } from "./mascot-view";

/** Our bodies, in two rows of five. */
const SHAPES: MadaniBodyId[][] = rowsOfFive(MADANI_BODY_IDS);


export { openCreateBot };

const pick = <T,>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)]!;

function useOpenRequests(onOpen: () => void) {
  const latest = useRef(onOpen);
  latest.current = onOpen;
  useEffect(() => {
    const open = () => latest.current();
    window.addEventListener(CREATE_BOT_EVENT, open);
    return () => window.removeEventListener(CREATE_BOT_EVENT, open);
  }, []);
}

export function CreateBotDialog() {
  const [session, setSession] = useState<{ key: number; section?: string } | null>(null);
  useOpenRequests(() => { const section = takeCreateBotSection(); setSession((open) => open ?? { key: Date.now(), section }); });
  return <AnimatePresence>{session && <CreateBotForm key={session.key} section={session.section} onClose={() => setSession(null)} />}</AnimatePresence>;
}

function CreateBotForm({ section, onClose }: { section?: string; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const [name, setName] = useState("");
  const sameName = state.bots.find((bot) => bot.name.trim().toLowerCase() === name.trim().toLowerCase() && name.trim())?.name;
  // the dialog opens on a shape and colour of its own choosing, a new one each time
  const [body, setBody] = useState<MadaniBodyId>(() => pick(MADANI_BODY_IDS));
  const [color, setColor] = useState<MausColor>(() => pick(PICKER_COLORS));
  const dialog = useRef<HTMLDivElement>(null);
  const played = useDialogMotion();
  const mascot = useRef<MausAvatarHandle>(null);
  const preview = useRef<HTMLSpanElement>(null);
  // the preview watches whichever shape or colour the pointer or focus is on
  const [look, setLook] = useState<{ x: number; y: number }>(FACING);
  const titleId = useId();
  const pending = state.botCreationPending === true;
  // the dialog stays until the bot exists, and keeps the draft when it could not be made
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  // the defaults the bot is made from are read while the name is typed, so Create goes straight to making it
  useEffect(() => { if (!window.madaniDesktop?.remoteClient?.active) prefetchBotDefaults(); }, []);
  const canCreate = name.trim().length > 0 && !pending && !creating;
  useEffect(() => {
    if (pending) started.current = true;
    // settled with neither answer: a plan's bot limit refused it and its popup took over
    else if (creating && started.current) onClose();
  }, [pending, creating, onClose]);

  const lookAt = (target: HTMLElement) => {
    const mark = preview.current?.getBoundingClientRect();
    if (!mark) return;
    const tile = target.getBoundingClientRect();
    setLook(hoverGaze(mark, tile.left + tile.width / 2, tile.top + tile.height / 2));
  };
  const watch = {
    onPointerEnter: (event: ReactPointerEvent<HTMLElement>) => lookAt(event.currentTarget),
    onFocus: (event: ReactFocusEvent<HTMLElement>) => { if (event.currentTarget.matches(":focus-visible")) lookAt(event.currentTarget); },
  };
  const rest = () => setLook(FACING);
  const pickBody = (id: MadaniBodyId) => { if (id !== body) { setBody(id); mascot.current?.react?.("hop"); } };
  const pickColor = (next: MausColor) => { if (next !== color) { setColor(next); mascot.current?.react?.("wiggle"); } };
  const rename = (next: string) => {
    if (!name.trim() && next.trim()) mascot.current?.react?.("greet");
    setName(next);
  };

  const create = () => {
    if (!canCreate) return;
    if (stoppedAtBotLimit(state)) { onClose(); return; }
    started.current = false;
    setError(null);
    setCreating(true);
    dispatch({ type: "newBot", section, look: { name: name.trim(), color, mascotBody: body },
      onCreated: () => onClose(), onError: (message) => { setCreating(false); setError(message); } });
  };

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (event: KeyboardEvent) => {
      const root = dialog.current;
      if (!root) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
      if (event.key !== "Tab") return;
      const controls = [...root.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])")];
      const first = controls[0], last = controls.at(-1);
      if (!first || !last) return;
      // The page behind is out of reach while the dialog is up.
      if (!root.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (opener?.isConnected) opener.focus();
    };
  }, [onClose]);

  return (
    <ModalLayer><div {...played.layer} className="fixed inset-0 z-[60]">
      <ScrimMotion {...played.scrim} aria-hidden className="absolute inset-0 bg-black/50" onMouseDown={onClose} />
      <SheetMotion
        {...played.sheet}
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-create-bot-dialog
        className="absolute left-1/2 top-1/2 flex max-h-[calc(100vh-32px)] w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[14px] border border-transparent bg-menu text-[13px] text-ink"
      >
        <button
          type="button"
          aria-label={t("common.close")}
          onClick={onClose}
          className="absolute right-2.5 top-2.5 z-[1] flex size-8 items-center justify-center rounded-[9999px] text-ink-secondary hover:bg-ink/6 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
        >
          <Icon name="close" size={14} />
        </button>
        <div className="flex shrink-0 flex-col items-start gap-1 border-b border-transparent p-4">
          <h2 id={titleId} className="m-0 text-[14px] font-semibold leading-[22px] tracking-[-0.15px]">Create new bot</h2>
        </div>
        <div className="min-h-0 w-full overflow-auto p-4 leading-[18px] tracking-[-0.08px]">
          <div className="flex flex-col gap-3">
            <span ref={preview} className="flex self-center" data-create-bot-preview>
              <MausAvatar ref={mascot} bodyId={body} color={color} size={96} gaze={look} />
            </span>
            <input
              autoFocus
              type="text"
              aria-label={t("botPanel.nameField")}
              placeholder="Name your bot"
              value={name}
              maxLength={80}
              onChange={(event) => rename(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); create(); } }}
              className="my-1 h-9 w-full rounded-[10px] border border-transparent bg-transparent px-2.5 py-2 text-center text-[13px] tracking-[0.195px] text-ink outline-none placeholder:text-ink/56 focus:border-transparent!"
            />
            {sameName && <p role="status" data-create-bot-same-name className="-mt-2 mb-0 text-center text-[12px] leading-4 text-ink-secondary">{t("createBot.sameName", { name: sameName, next: takeImportName(name, new Set(state.bots.map((bot) => bot.name.toLowerCase())), 80) })}</p>}
            <div className="flex flex-col gap-3">
              <div role="group" aria-label={t("botPanel.avatar.shapes")} className="flex flex-col gap-2 py-1.5" onPointerLeave={rest} onBlur={rest}>
                {SHAPES.map((row) => (
                  <div key={row[0]} className="flex justify-center gap-x-[clamp(0px,calc((100%-240px)/4),8px)]">
                    {row.map((id) => (
                      <ShapeTile key={id} id={id} color={color} selected={id === body} onPick={() => pickBody(id)} {...watch} />
                    ))}
                  </div>
                ))}
              </div>
              <div role="group" aria-label={t("botPanel.avatar.colors")} className="flex max-w-[232px] flex-wrap items-center justify-center gap-2 self-center py-2" onPointerLeave={rest} onBlur={rest}>
                {PICKER_COLORS.map((swatch) => (
                  <button
                    key={swatch}
                    type="button"
                    aria-label={t("botPanel.avatar.colorNamed", { color: t(MAUS_COLOR_LABEL[swatch]) })}
                    aria-pressed={swatch === color}
                    onClick={() => pickColor(swatch)}
                    {...watch}
                    className="flex size-8 cursor-pointer items-center justify-center rounded-[50%] border border-transparent p-0 text-black outline-none hover:border-transparent focus-visible:shadow-[0_0_0_2px_var(--color-focus)] focus-visible:outline-none!"
                  >
                    <span
                      className="block size-6 rounded-[50%]"
                      style={{ background: colorSwatch(swatch), boxShadow: swatch === color ? "0 0 0 3px var(--color-menu), 0 0 0 4px color-mix(in srgb, var(--color-ink) 24%, transparent)" : undefined }}
                    />
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
        {error && <p role="alert" data-create-bot-error="" className="m-0 shrink-0 px-4 pb-3 text-[13px] leading-[18px] text-danger">{error}</p>}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-transparent py-3 pl-4 pr-3">
          <button
            type="button"
            data-group-instead=""
            onClick={() => { onClose(); openNewGroup(); }}
            className="mr-auto cursor-pointer rounded-[6px] border-0 bg-transparent p-0 text-[13px] leading-[18px] tracking-[0.195px] text-ink-secondary transition-colors duration-[120ms] ease-[ease-out] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {t("createBot.groupInstead")}
          </button>
          <button type="button" onClick={onClose} className={cn(KIT_BUTTON, "bg-ink/6 text-ink hover:bg-ink/10")}><span>Cancel</span></button>
          <button
            type="button"
            disabled={!canCreate}
            aria-busy={creating}
            onClick={create}
            className={cn(KIT_BUTTON, "bg-ink text-app hover:bg-[color-mix(in_srgb,var(--color-ink)_88%,var(--color-app))] disabled:bg-ink/15 disabled:text-ink/30")}
          >
            <span>{creating ? t("createBot.creating") : "Create"}</span>
          </button>
        </div>
      </SheetMotion>
    </div></ModalLayer>
  );
}

/** A 32px pill, 14px words at regular weight, a hairline drawn in its own ink. */
const KIT_BUTTON = "inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1 whitespace-nowrap rounded-[9999px] px-3 py-1.5 text-[14px] font-normal leading-5 tracking-[0.01em] shadow-none outline-none transition-[background-color,color] duration-[120ms] ease-[ease-out] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus disabled:cursor-default";

const MARK = 36;

/** The preview faces the viewer at rest, turning only toward the shape or colour the pointer or focus is on. */
const FACING = { x: 0, y: 0 } as const;

/** A shape to pick, in the chosen colour. Hovered, focused or chosen, a 1px ring follows its outline 3px out: faint on
 * hover, darker once chosen. */
function ShapeTile({ id, color, selected, onPick, onPointerEnter, onFocus }: {
  id: MadaniBodyId; color: MausColor; selected: boolean; onPick: () => void;
  onPointerEnter: (event: ReactPointerEvent<HTMLElement>) => void; onFocus: (event: ReactFocusEvent<HTMLElement>) => void;
}) {
  return (
    <button
      type="button"
      aria-label={t("botPanel.avatar.shapeNamed", { name: upperFirst(id) })}
      aria-pressed={selected}
      onClick={onPick}
      onPointerEnter={onPointerEnter}
      onFocus={onFocus}
      className="group/shape relative inline-flex size-12 cursor-pointer appearance-none items-center justify-center border-0 bg-transparent p-0 text-black outline-none focus-visible:outline-none!"
    >
      <MausAvatar bodyId={id} color={color} size={MARK} animated={false} trackPointer={false} />
      <BodyRing
        body={id}
        size={MARK}
        className={cn(
          "pointer-events-none absolute text-ink opacity-0",
          selected ? "opacity-24" : "group-hover/shape:opacity-12 group-focus-visible/shape:opacity-24",
        )}
      />
    </button>
  );
}
