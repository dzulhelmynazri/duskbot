import { useEffect, useRef, useState } from "react";

import type { StartFreshStep, StartFreshView } from "../../../electron/start-fresh.mjs";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { openExternalLink } from "@/lib/app-links";
import { DEFAULT_ADMIN_ORIGIN } from "@/lib/onboarding";
import { friendlyError } from "@/lib/plain-error";
import { Icon } from "../Icon";
import { Loader2 } from "../../icons";
import { ModalLayer } from "../ui/ModalLayer";
import { confirmCancelCls, formBodyCls, formFooterCls, formHeaderCls, formSheetCls, formTitleCls, mdDangerCls, mdPrimaryCls, rowHintCls, textFieldCls, useDialogKeys } from "../ui/GrokDialog";

/** the words the person types; main checks them again (electron/start-fresh.mjs CONFIRM_PHRASE) */
export const START_FRESH_PHRASE = "start fresh";
export const startFreshTyped = (typed: string) => typed.trim().toLowerCase() === START_FRESH_PHRASE;

type Bridge = NonNullable<NonNullable<Window["madaniDesktop"]>["startFresh"]>;
const bridge = (): Bridge | null => (typeof window === "undefined" ? null : window.madaniDesktop?.startFresh ?? null);

const OPEN_EVENT = "madani:start-fresh";
/** Support's dev row opens the reset; the host lives in the sidebar so it opens from any page */
export const openStartFresh = () => window.dispatchEvent(new Event(OPEN_EVENT));

export function StartFreshHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, show);
    return () => window.removeEventListener(OPEN_EVENT, show);
  }, []);
  const startFresh = bridge();
  if (!open || !startFresh) return null;
  return <StartFreshDialog bridge={startFresh} onClose={() => setOpen(false)} />;
}

function stepTitle(step: StartFreshStep) {
  if (step.kind === "signout") return t("startFresh.step.signOut", { email: step.label });
  if (step.kind === "ai") return t("startFresh.step.ai");
  return t("startFresh.step.local");
}

function stepHint(step: StartFreshStep) {
  if (step.status === "failed") return step.error ?? t("startFresh.status.failed");
  if (step.kind === "local") return t("startFresh.step.localHint");
  return null;
}

/** Deleting the account is its own action on the website's account page, which says it cancels the plan first. */
export function openAccountDeletion(): void {
  const account = typeof window === "undefined" ? undefined : window.madaniDesktop?.cloudAccount;
  if (account?.openPage) { void account.openPage("account").catch(() => {}); return; }
  void openExternalLink(`${DEFAULT_ADMIN_ORIGIN}/account`).catch(() => {});
}

function StepMark({ status }: { status: StartFreshStep["status"] }) {
  const label = t(`startFresh.status.${status}`);
  if (status === "running") return <Loader2 size={16} aria-label={label} className="shrink-0 animate-spin text-ink/68" />;
  if (status === "done") return <span role="img" aria-label={label} className="flex shrink-0 text-ink/68"><Icon name="check" size={16} /></span>;
  if (status === "failed") return <span role="img" aria-label={label} className="flex shrink-0 text-danger"><Icon name="exclamation-circle" size={16} /></span>;
  return <span role="img" aria-label={label} className="m-[4px] size-2 shrink-0 rounded-full bg-ink/20" />;
}

function Steps({ steps }: { steps: StartFreshStep[] }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-0.5 rounded-[14px] bg-ink/4 p-1.5" aria-live="polite">
      {steps.map((step) => {
        const hint = stepHint(step);
        return (
          <li key={step.id} data-start-fresh-step={step.id} data-status={step.status} className="flex items-start gap-2.5 rounded-[10px] px-2 py-1.5">
            <span className="mt-px flex"><StepMark status={step.status} /></span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[13px] leading-[18px] text-ink">{stepTitle(step)}</span>
              {hint && <span className={cn("text-[12px] leading-4", step.status === "failed" ? "text-danger" : "text-ink/56")}>{hint}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Start fresh's confirm, then its progress: one row per thing being removed, what failed listed with a retry. */
export function StartFreshDialog({ bridge, onClose }: { bridge: Bridge; onClose: () => void }) {
  const [view, setView] = useState<StartFreshView | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");
  const [asking, setAsking] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);
  const phase = view?.phase ?? "idle";
  // once anything is deleted the dialog stays until the app restarts: a half-done reset is never just closed
  const closable = phase === "idle" && !asking;
  useDialogKeys(sheet, () => { if (closable) onClose(); });

  useEffect(() => {
    let live = true;
    void bridge.preview().then((next) => { if (live) setView(next); }, () => {});
    const stop = bridge.onChanged((next) => { if (live) setView(next); });
    return () => { live = false; stop(); };
  }, [bridge]);

  const act = async (work: () => Promise<StartFreshView>) => {
    setAsking(true);
    setError("");
    try { setView(await work()); }
    catch (cause) { setError(t("startFresh.failed", { error: friendlyError(cause) })); }
    finally { setAsking(false); }
  };
  const ready = startFreshTyped(typed);

  const title = phase === "idle" ? t("startFresh.title")
    : phase === "running" ? t("startFresh.progressTitle")
    : phase === "partial" ? t("startFresh.partialTitle")
    : t("startFresh.doneTitle");

  return (
    <ModalLayer>
      <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
        <div aria-hidden="true" data-modal-scrim className="ui-dialog-scrim absolute inset-0" onMouseDown={() => { if (closable) onClose(); }} />
        <div ref={sheet} role="alertdialog" aria-modal="true" aria-labelledby="start-fresh-title" aria-describedby="start-fresh-warning" tabIndex={-1}
          data-start-fresh-dialog={phase} style={{ maxWidth: "min(440px, calc(100vw - 32px))" }} className={formSheetCls}>
          <header className={formHeaderCls}>
            <h2 id="start-fresh-title" className={formTitleCls}>{title}</h2>
            {closable && (
              <button type="button" aria-label={t("common.close")} onClick={onClose} className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-[6px] text-ink/68 transition-[color,background-color] duration-[120ms] ease-[ease] hover:bg-ink/6 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus">
                <Icon name="close" size={16} />
              </button>
            )}
          </header>
          <div className={cn(formBodyCls, "flex flex-col gap-3", phase === "running" ? "pb-4" : "pb-1")}>
            {phase === "idle" ? (
              <>
                <p id="start-fresh-warning" className="m-0 flex items-start gap-2 rounded-[10px] bg-danger/10 px-3 py-2.5 text-[14px] font-medium leading-5 text-danger">
                  <span className="mt-0.5 flex shrink-0"><Icon name="exclamation-circle" size={16} /></span>
                  {t("startFresh.warning")}
                </p>
                <div>
                  <p className={cn(rowHintCls, "m-0 mb-1.5")}>{t("startFresh.lead")}</p>
                  <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[13px] leading-[18px] text-ink marker:text-ink/40">
                    <li>{t("startFresh.list.bots")}</li>
                    <li>{t("startFresh.list.local")}</li>
                    <li>{t("startFresh.list.signOut")}</li>
                  </ul>
                </div>
                <p data-start-fresh-keeps="" className={cn(rowHintCls, "m-0")}>
                  {t("startFresh.keeps")}{" "}{t("startFresh.deleteAccountLead")}{" "}
                  <button type="button" data-start-fresh-delete-account="" onClick={openAccountDeletion}
                    className="cursor-pointer rounded-[4px] font-medium text-ink underline underline-offset-2 hover:text-ink/80 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus">{t("startFresh.deleteAccount")}</button>
                </p>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[13px] leading-[18px] text-ink/68">{t("startFresh.typeLabel", { phrase: START_FRESH_PHRASE })}</span>
                  <input data-autofocus data-start-fresh-input value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" spellCheck={false}
                    placeholder={START_FRESH_PHRASE} aria-label={t("startFresh.typeLabel", { phrase: START_FRESH_PHRASE })}
                    onKeyDown={(event) => { if (event.key === "Enter" && ready && !asking) void act(() => bridge.run(typed)); }}
                    className={cn(textFieldCls, "bg-ink/6 focus:bg-ink/8")} />
                </label>
              </>
            ) : (
              <>
                {phase === "partial" && <p id="start-fresh-warning" className={cn(rowHintCls, "m-0")}>{t("startFresh.partialBody")}</p>}
                {(phase === "done" || phase === "restarting") && <p id="start-fresh-warning" className={cn(rowHintCls, "m-0")}>{t("startFresh.doneBody")}</p>}
                {view && <Steps steps={view.steps} />}
              </>
            )}
            {error && <p role="alert" className="m-0 text-[12px] leading-4 text-danger">{error}</p>}
          </div>
          {phase !== "running" && <div className={formFooterCls}>
            {phase === "idle" && (
              <>
                <button type="button" onClick={onClose} disabled={asking} className={confirmCancelCls}>{t("startFresh.cancel")}</button>
                <button type="button" data-start-fresh-confirm disabled={!ready || asking} onClick={() => void act(() => bridge.run(typed))} className={cn(mdDangerCls, "gap-1.5")}>
                  {asking && <Loader2 size={14} className="animate-spin" />}{t("startFresh.confirm")}
                </button>
              </>
            )}
            {phase === "partial" && (
              <>
                <button type="button" data-start-fresh-finish disabled={asking} onClick={() => void act(() => bridge.finish())} className={confirmCancelCls}>{t("startFresh.finishAnyway")}</button>
                <button type="button" data-start-fresh-retry disabled={asking} onClick={() => void act(() => bridge.retry())} className={cn(mdPrimaryCls, "gap-1.5")}>
                  {asking && <Loader2 size={14} className="animate-spin" />}{t("startFresh.retry")}
                </button>
              </>
            )}
            {(phase === "done" || phase === "restarting") && (
              <button type="button" data-start-fresh-restart data-autofocus disabled={asking || phase === "restarting"} onClick={() => void act(() => bridge.finish())} className={cn(mdPrimaryCls, "gap-1.5")}>
                {phase === "restarting" && <Loader2 size={14} className="animate-spin" />}{phase === "restarting" ? t("startFresh.restarting") : t("startFresh.restart")}
              </button>
            )}
          </div>}
        </div>
      </div>
    </ModalLayer>
  );
}
