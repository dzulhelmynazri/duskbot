import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, Hand, Loader2, RefreshCw } from "../icons";

import type { ComputerHelpRef } from "../../shared/wire";
import { signInOutcome } from "../../shared/sign-in-request";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { cardSaveTarget, saveLoginFromCard } from "@/lib/logins";
import { answerSignIn, signInHostIsHere } from "@/lib/sign-in";
import { useStore, type Bot, type Message } from "@/state/store";
import { ASK_QUIET_BUTTON, AskCard, CardSettledRow, cardPrimary, cardSecondary, cardTertiary, returnFocusToComposer } from "./AskCard";
import { Icon } from "./Icon";
import { SignInScreen, signInScreenPath } from "./SignInScreen";
import { LoginForm } from "./LoginForm";
import { friendlyError } from "@/lib/plain-error";
import { reducedMotion } from "@/lib/onboarding";
import { SCREEN_GROW_MS } from "./ComputerFullscreen";
import { useSignInTakeover } from "./SignInTakeover";

// Security: a saved login is encrypted on the server and filled by fill_login; neither the bot nor any screen ever gets
// it back.

/** Grok's titlebar names where the step happens. */
const SOURCE = {
  browser: "signIn.source.browser",
  vm: "botPanel.tab.computer",
  cloud: "botPanel.tab.computer",
  local: "signIn.source.local",
  host: "botPanel.tab.computer",
} as const;

const WHERE = {
  browser: "signIn.where.browser",
  vm: "signIn.where.vm",
  cloud: "signIn.where.cloud",
  local: "signIn.where.local",
  host: "signIn.where.host",
} as const;

type CardProps = {
  botId: string;
  botName: string;
  color?: Bot["color"];
  threadId: string;
  message: Message;
};

/** The card settling (answered, skipped, superseded) eases from its full height to its one-line row instead of jumping;
 * reduced motion fades the row in. */
function useSettleMotion(settled: boolean) {
  const box = useRef<HTMLDivElement>(null);
  const height = useRef(0);
  const was = useRef(settled);
  useLayoutEffect(() => {
    const node = box.current;
    if (!node || typeof ResizeObserver !== "function") return;
    height.current = node.getBoundingClientRect().height;
    const watch = new ResizeObserver(([entry]) => { if (entry) height.current = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height; });
    watch.observe(node);
    return () => watch.disconnect();
  }, []);
  useLayoutEffect(() => {
    const node = box.current;
    if (!node || was.current === settled) return;
    was.current = settled;
    const from = height.current;
    const to = node.getBoundingClientRect().height;
    if (typeof node.animate !== "function" || !from || Math.abs(from - to) < 1) return;
    const timing = { duration: SCREEN_GROW_MS, easing: "cubic-bezier(0.22, 1, 0.36, 1)" };
    const motion = reducedMotion()
      ? node.animate([{ opacity: 0 }, { opacity: 1 }], timing)
      : node.animate([{ height: `${from}px`, opacity: 0.5, overflow: "clip" }, { height: `${to}px`, opacity: 1, overflow: "clip" }], timing);
    return () => motion.cancel();
  }, [settled]);
  return box;
}

export function SignInRequestCard({ botId, botName, threadId, message }: CardProps) {
  const { dispatch } = useStore();
  const card = message.signIn!;
  const [pending, setPending] = useState<"done" | "cancel" | null>(null);
  const [explained, setExplained] = useState(false);
  const [saving, setSaving] = useState(false);
  const [target, setTarget] = useState<{ site: string; signInHost?: string } | null>(null);
  const [alsoThere, setAlsoThere] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const error = localError ?? card.error;
  const outcome = signInOutcome(card);
  const ref = { botId, threadId, messageId: message.id, place: card.place };
  const here = signInHostIsHere();

  // A sign-in page on another site is added only when the person ticks it, seeing its host named.
  const startSaving = () => {
    setSaving(true);
    setAlsoThere(false);
    setTarget(null);
    cardSaveTarget(ref).then(setTarget, () => setTarget(null));
  };

  const answer = async (choice: "done" | "cancel") => {
    if (pending) return;
    setPending(choice);
    setLocalError(null);
    try {
      await answerSignIn(ref, choice);
      returnFocusToComposer();
    } catch (cause) {
      setLocalError(friendlyError(cause));
    } finally {
      setPending(null);
    }
  };

  const [frame, setFrame] = useState<string | null>(null);
  const control = useSignInTakeover({ botId, threadId, name: botName, place: card.place, poster: frame, onDone: () => answer("done") });

  const stopped = card.stopped === true;
  const box = useSettleMotion(Boolean(card.answeredInChat || card.superseded || stopped || outcome));
  const wrap = (node: ReactNode) => <div ref={box} data-sign-in-card="">{node}</div>;
  const source = { icon: <Icon name={card.place === "browser" ? "browser" : "laptop"} size={12} />, label: t(SOURCE[card.place === "local" && !here ? "host" : card.place]) };
  const instruction = t(card.check ? "signIn.humanCheck" : "signIn.instruction", { site: card.site });
  const settledLabel = card.check ? t("signIn.checkLabel", { site: card.site }) : instruction;
  const settled = (status: string, more: { tone?: "done" | "closed" | "stopped" | "failed"; detail?: ReactNode; action?: ReactNode } = {}) => (
    <CardSettledRow ariaLabel={t(card.check ? "signIn.cardLabelCheck" : "signIn.cardLabel", { name: botName, site: card.site })} icon={source.icon} label={source.label}
      summary={`${status} · ${settledLabel}`} title={status} detail={more.detail ?? settledLabel} tone={more.tone} action={more.action} />
  );

  if (card.answeredInChat) return wrap(settled(t("signIn.answeredInChat")));
  if (card.superseded || (stopped && !outcome)) {
    return wrap(settled(t(card.superseded ? "signIn.superseded" : "chat.turnStopped"), { tone: card.superseded ? "closed" : "stopped" }));
  }

  if (outcome) {
    const retry = !card.resumed && !stopped && error ? (
      <button type="button" onClick={() => void answer(outcome === "done" ? "done" : "cancel")} disabled={pending !== null}
        className={cn(ASK_QUIET_BUTTON, "text-accent-text")}>
        {pending ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        {t("signIn.retry")}
      </button>
    ) : undefined;
    const status = card.savedLogin ? t("signIn.status.saved") : t(outcome === "done" ? "signIn.status.done" : "signIn.skipped");
    const what = card.savedLogin
      ? t("signIn.settled.saved", { site: card.savedLogin })
      : card.check ? t(outcome === "done" ? "signIn.settled.checkCleared" : "signIn.settled.checkSkipped", { site: card.site })
        : t(outcome === "done" ? "signIn.settled.done" : "signIn.settled.cancelled", { site: card.site });
    const after = card.resumed ? t("signIn.settled.resumed", { name: botName }) : stopped ? t("chat.turnStopped") : error ? t("signIn.settled.failed") : t("signIn.settled.waiting");
    return wrap(settled(status, {
      tone: error && !card.resumed && !stopped ? "failed" : outcome === "cancelled" ? "closed" : "done",
      action: retry,
      detail: <>
        <span>{what} · {after}</span>
        {error && <span role="alert" className="mt-1 block text-[13px] leading-[18px] text-danger">{error}</span>}
      </>,
    }));
  }

  const where = WHERE[card.place === "local" && !here ? "host" : card.place];
  const open = () => {
    if (card.place === "local") setExplained(true);
    else if (card.place === "cloud" || card.place === "vm") void control.open();
    else dispatch({ type: "openSignIn", botId, messageId: message.id, url: card.url, site: card.site, place: card.place });
  };
  // fill_login reaches only the built-in browser (and My Chrome); a desktop paired to another host relays no passwords.
  const canSave = card.place === "browser" && window.madaniDesktop?.remoteClient?.active !== true;
  let pageHost = card.site;
  try { pageHost = new URL(card.url).hostname; } catch {}
  const takeOver = cardPrimary();
  const screen = saving ? null : signInScreenPath(card.place, botId, threadId);
  const inControl = control.here;
  const shownError = control.error ?? error;
  return wrap(
    <AskCard
      ariaLabel={t(card.check ? "signIn.cardLabelCheck" : "signIn.cardLabel", { name: botName, site: card.site })}
      source={source}
      media={saving ? null : control.media ?? (screen && <SignInScreen path={screen} name={botName} onOpen={open} onFrame={setFrame} disabled={pending !== null || control.taking} busy={control.taking} waking={control.waking} />)}
      title={t("signIn.actionNeeded")}
      explanation={<>
        <span dir="ltr" className="break-all" data-testid="sign-in-site">{instruction}</span>
        {card.reason && <span className="block"><bdi dir="auto">{card.reason}</bdi></span>}
        {explained && <span role="note" className="mt-1 block text-ink">{t(here ? "signIn.local.explain" : "signIn.local.explainHost", { name: botName })}</span>}
        {shownError && <span role="alert" className="mt-1 block text-[13px] leading-[18px] text-danger">{shownError}</span>}
      </>}
      footer={saving ? undefined : inControl ? <>
        <button type="button" onClick={() => void answer("cancel")} disabled={pending !== null || control.finishing} title={t("signIn.skipHint", { name: botName })} className={cardSecondary()}>
          {pending === "cancel" && <Loader2 size={14} className="animate-spin" />}
          {t("signIn.skip")}
        </button>
        {!control.expanded && (
          <button type="button" onClick={control.expand} disabled={pending !== null || control.finishing} className={cardSecondary()}>
            {t("computer.open")}
          </button>
        )}
        <button type="button" data-sign-in-done="" onClick={() => void control.done()} disabled={pending !== null || control.finishing} className={takeOver.className} style={takeOver.style}>
          {(pending === "done" || control.finishing) && <Loader2 size={14} className="animate-spin" />}
          {t("computer.done")}
        </button>
      </> : <>
        {canSave && (
          <button type="button" onClick={startSaving} disabled={pending !== null} className={cn(cardTertiary(), "me-auto -ms-2")}>
            {t("signIn.saveLogin")}
          </button>
        )}
        <button type="button" onClick={() => void answer("cancel")} disabled={pending !== null} title={t("signIn.skipHint", { name: botName })} className={cardSecondary()}>
          {pending === "cancel" && <Loader2 size={14} className="animate-spin" />}
          {t("signIn.skip")}
        </button>
        <button type="button" onClick={() => void answer("done")} disabled={pending !== null} className={cardSecondary()}>
          {pending === "done" && <Loader2 size={14} className="animate-spin" />}
          {t("computer.done")}
        </button>
        <button type="button" data-sign-in-take-over="" onClick={open} disabled={pending !== null || control.taking} title={t(where, { name: botName })} className={takeOver.className} style={takeOver.style}>
          {control.taking && <Loader2 size={14} className="animate-spin" />}
          {card.place === "local" ? t("signIn.open") : t("signIn.takeOver")}
        </button>
      </>}
    >
      {saving && (
        <div data-testid="sign-in-save">
          <p className="mb-2 text-[13px] leading-snug text-ink-secondary">{t("signIn.save.note", { name: botName, site: target?.site ?? pageHost })}</p>
          <LoginForm submitLabel={t("signIn.save.submit")} autoFocus onCancel={() => setSaving(false)}
            onSubmit={async (fields) => {
              await saveLoginFromCard({ botId, threadId, messageId: message.id }, fields, alsoThere ? target?.signInHost : undefined);
              setSaving(false);
              returnFocusToComposer();
            }}>
            {target?.signInHost && (
              <label className="flex items-start gap-2 text-[13px] leading-snug text-ink" data-testid="sign-in-save-elsewhere">
                <input type="checkbox" name="signInHost" className="mt-[2px]" checked={alsoThere} onChange={(event) => setAlsoThere(event.target.checked)} />
                <span dir="auto">{t("signIn.save.elsewhere", { host: target.signInHost })}</span>
              </label>
            )}
          </LoginForm>
        </div>
      )}
    </AskCard>
  );
}

export function SignInBanner({
  help,
  askerName,
  takeControl,
  onError,
}: {
  help: ComputerHelpRef;
  askerName: string;
  takeControl?: { onClick: () => void; disabled?: boolean; pending?: boolean };
  onError?: (message: string | null) => void;
}) {
  const [pending, setPending] = useState<"done" | "cancel" | null>(null);
  const answer = async (choice: "done" | "cancel") => {
    if (pending) return;
    setPending(choice);
    onError?.(null);
    try { await answerSignIn(help, choice); }
    catch (cause) { onError?.(friendlyError(cause)); }
    finally { setPending(null); }
  };
  return (
    <div className="mt-3 text-start" data-testid="sign-in-banner">
      <div className="text-[13px] leading-relaxed text-warning">
        <b>{askerName}</b> {t(help.check ? "signIn.bannerCheck" : "signIn.banner", { site: help.site })}
      </div>
      {help.place === "local" && (
        <div className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
          {t(signInHostIsHere() ? "signIn.where.local" : "signIn.where.host", { name: askerName })}
        </div>
      )}
      <div className="mt-2 flex gap-2">
        {takeControl && (
          <button
            type="button"
            onClick={takeControl.onClick}
            disabled={takeControl.disabled}
            className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-accent py-2 text-[13px] font-medium text-accent-ink hover:brightness-110 disabled:opacity-50"
          >
            {takeControl.pending ? <Loader2 size={14} className="animate-spin" /> : <Hand size={14} />}
            {t("computer.takeControl")}
          </button>
        )}
        <button
          type="button"
          onClick={() => void answer("done")}
          disabled={pending !== null}
          className={cn("flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-[13px] font-medium disabled:opacity-50",
            takeControl ? "bg-control text-ink hover:bg-raised-hover" : "flex-1 bg-accent text-accent-ink hover:brightness-110")}
        >
          {pending === "done" ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
          {t("signIn.done")}
        </button>
        <button
          type="button"
          onClick={() => void answer("cancel")}
          disabled={pending !== null}
          className="rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
        >
          {t("signIn.cancel")}
        </button>
      </div>
    </div>
  );
}
