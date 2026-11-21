import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AccountRow } from "../../electron/cloud-account.mjs";
import { newAvatarSeed, parseUserAvatarChoice, plainAvatarChoice, type UserAvatarChoice } from "../../shared/user-avatar";
import { RefreshCw } from "../icons";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { UserAvatarArt, UserFace } from "./UserAvatar";

const WIDTH = 316, GAP = 8, EDGE = 8, SUGGESTIONS = 5;
const SWATCH = "flex size-11 items-center justify-center rounded-full transition-[background-color,box-shadow] duration-150 ease-out hover:bg-ink/[0.06] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:opacity-50 motion-reduce:transition-none";

/** Where the photo comes from, by its address, for the button's words. */
export function photoSource(url: string | undefined): "google" | "x" | "other" | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    if (host.endsWith("googleusercontent.com")) return "google";
    if (host.endsWith("twimg.com")) return "x";
  } catch { return null; }
  return "other";
}

/** The avatar a choice shows, for the preview. `null` is the default: the sign-in photo, else the account id's drawing. */
function choiceAccount(account: AccountRow, choice: UserAvatarChoice | null) {
  return { id: account.id, ...(account.avatarUrl ? { avatarUrl: account.avatarUrl } : {}), ...(choice ? { avatar: choice } : {}) };
}

/** Pick the avatar that follows the person everywhere: shuffle a new drawing, take one of a few suggestions, or use the photo
 * of their sign-in. Saved to the account on Save; Escape or a click elsewhere leaves it as it was. */
export function AvatarPicker({ account, anchor, onClose }: { account: AccountRow; anchor: HTMLElement | null; onClose: () => void }) {
  const bridge = window.madaniDesktop?.accounts;
  const saved = parseUserAvatarChoice(account.avatar);
  const hasPhoto = Boolean(account.avatarUrl);
  const start = plainAvatarChoice(saved, hasPhoto);
  const [choice, setChoice] = useState<UserAvatarChoice | null>(start);
  const [suggested] = useState(() => Array.from({ length: SUGGESTIONS }, () => newAvatarSeed()));
  const [rolled, setRolled] = useState<string | null>(saved?.startsWith("g:") && !suggested.includes(saved.slice(2)) ? saved.slice(2) : null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const [place, setPlace] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLButtonElement>(null);
  const source = photoSource(account.avatarUrl);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const measure = () => {
      const box = anchor?.getBoundingClientRect() ?? { left: (window.innerWidth - WIDTH) / 2, top: window.innerHeight / 3, bottom: window.innerHeight / 3 };
      const height = panel.offsetHeight;
      const above = box.bottom + GAP + height > window.innerHeight - EDGE && box.top - GAP - height >= EDGE;
      setPlace({
        left: Math.min(Math.max(EDGE, box.left), window.innerWidth - WIDTH - EDGE),
        top: above ? box.top - GAP - height : Math.max(EDGE, Math.min(box.bottom + GAP, window.innerHeight - height - EDGE)),
        above,
      });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [anchor]);

  useEffect(() => { firstRef.current?.focus(); }, []);
  const close = () => { onClose(); anchor?.focus(); };
  useEffect(() => {
    const down = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !anchor?.contains(target)) onClose();
    };
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  }, [anchor, onClose]);

  const pick = (next: UserAvatarChoice | null) => { setChoice(next); setError(false); };
  const shuffle = () => { const seed = newAvatarSeed(); setRolled(seed); pick(`g:${seed}`); };
  const save = () => {
    if (!bridge?.setAvatar || saving) return;
    setSaving(true);
    setError(false);
    void bridge.setAvatar(choice).then((result) => {
      if (result.outcome === "saved") onClose();
      else setError(true);
    }, () => setError(true)).finally(() => setSaving(false));
  };
  const swatches: { key: string; choice: UserAvatarChoice | null; seed: string; label: string }[] = [
    // with a photo, the account id's drawing is a choice of its own; without one it is the default
    { key: "default", choice: hasPhoto ? "drawn" : null, seed: account.id, label: t("accounts.avatar.default") },
    ...(rolled ? [{ key: `g:${rolled}`, choice: `g:${rolled}` as const, seed: rolled, label: t("accounts.avatar.rolled") }] : []),
    ...suggested.slice(0, rolled ? SUGGESTIONS - 1 : SUGGESTIONS).map((seed, index) => ({ key: `g:${seed}`, choice: `g:${seed}` as const, seed, label: t("accounts.avatar.suggestion", { n: index + 1 }) })),
  ];

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-labelledby="avatar-picker-title"
      data-avatar-picker=""
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); close(); } }}
      style={{ position: "fixed", left: place?.left ?? 0, top: place?.top ?? 0, width: WIDTH, maxWidth: `calc(100vw - ${EDGE * 2}px)`, visibility: place ? undefined : "hidden",
        transformOrigin: place?.above ? "bottom left" : "top left" }}
      className="popover-surface z-[75] flex flex-col gap-4 rounded-[var(--radius-menu)] border-[0.5px] border-transparent bg-menu p-4 text-ink shadow-(--shadow-popover) animate-pop-in [:root[data-skin=daylight]_&]:border-0 [:root[data-skin=grok]_&]:border-0"
    >
      <div className="flex items-center gap-4">
        <UserFace account={choiceAccount(account, choice)} size={80} className="inset-ring inset-ring-ink/[0.08]" />
        <div className="flex min-w-0 flex-col items-start gap-2">
          <h2 id="avatar-picker-title" className="text-[15px] font-semibold leading-5">{t("accounts.avatar.title")}</h2>
          <button ref={firstRef} type="button" data-avatar-shuffle="" className="ui-button ui-button-pill gap-1.5" onClick={shuffle} disabled={saving}>
            <RefreshCw size={14} aria-hidden />
            {t("accounts.avatar.shuffle")}
          </button>
        </div>
      </div>
      <div role="group" aria-label={t("accounts.avatar.suggestions")} className="grid grid-cols-6 gap-1">
        {swatches.map((swatch) => {
          const on = choice === swatch.choice;
          return <button key={swatch.key} type="button" aria-label={swatch.label} aria-pressed={on} data-avatar-swatch={swatch.key} disabled={saving}
            className={cn(SWATCH, on && "bg-ink/[0.08] inset-ring-2 inset-ring-ink/30")} onClick={() => pick(swatch.choice)}>
            <UserAvatarArt seed={swatch.seed} size={32} />
          </button>;
        })}
      </div>
      {account.avatarUrl && <button type="button" data-avatar-photo="" aria-pressed={choice === null} disabled={saving}
        className={cn("flex min-h-11 items-center gap-3 rounded-xl px-2 text-start text-[14px] leading-5 transition-colors duration-150 ease-out hover:bg-ink/[0.06] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:opacity-50 motion-reduce:transition-none", choice === null && "bg-ink/[0.08]")}
        onClick={() => pick(null)}>
        <img src={account.avatarUrl} alt="" className="size-7 shrink-0 rounded-full object-cover" />
        <span className="min-w-0 flex-1 truncate">{t(source === "google" ? "accounts.avatar.photoGoogle" : source === "x" ? "accounts.avatar.photoX" : "accounts.avatar.photo")}</span>
      </button>}
      {error && <p role="alert" data-avatar-error="" className="text-[13px] leading-5 text-danger">{t("accounts.avatar.failed")}</p>}
      <div className="flex items-center justify-end gap-2">
        <button type="button" className="ui-button ui-button-pill" onClick={close}>{t("common.cancel")}</button>
        <button type="button" data-avatar-save="" className="ui-button ui-button-primary ui-button-pill" disabled={saving || choice === start} onClick={save}>
          {t(saving ? "accounts.avatar.saving" : "accounts.avatar.save")}
        </button>
      </div>
    </div>,
    document.body,
  );
}
