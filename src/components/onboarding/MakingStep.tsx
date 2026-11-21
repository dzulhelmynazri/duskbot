// The first run's last screen on madani cloud: the Cloud being made, step by step as the Admin reports it (the session's
// `clouds` entry, else its `machine`). This computer's AI sign-ins are handed to the Admin once, to be held for that Cloud
// until it runs. Ready opens its chat here; the app may be closed meanwhile and the run resumes on this screen.
import { useEffect, useRef, useState } from "react";
import type { CloudAccountState } from "../../../electron/cloud-account.mjs";
import type { CloudSetupStep } from "../../../electron/cloud-home.mjs";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { Checklist, ProgressBar } from "../cloud-buy/parts";
import { PRIMARY, QUIET, StepFrame } from "./FunnelSteps";
import { PlaceArt } from "../ui/PlaceArt";

const STEPS = [
  ["reserving", "cloudHome.step.reserving"], ["storage", "cloudHome.step.storage"],
  ["starting", "cloudHome.step.starting"], ["checking", "cloudHome.step.checking"],
] as const satisfies ReadonlyArray<readonly [CloudSetupStep, LocaleKey]>;

export type Making =
  | { kind: "waiting" }
  | { kind: "setting-up"; step: CloudSetupStep; progress: number; slow: boolean }
  | { kind: "ready"; origin?: string }
  | { kind: "failed" }
  | { kind: "payment" };

const PROGRESS: Record<CloudSetupStep, number> = { reserving: 0.15, storage: 0.4, starting: 0.65, checking: 0.9 };

/** Where the account's own Cloud is, as the Admin last said. */
export function makingFrom(account: CloudAccountState | null): Making {
  const own = account?.clouds?.find((entry) => entry.primary && entry.runsOn === "cloud");
  if (own) {
    if (own.status === "ready" && own.origin) return { kind: "ready", origin: own.origin };
    if (own.status === "setting_up") {
      const step = own.setup?.step ?? "reserving";
      return { kind: "setting-up", step, progress: own.setup?.progress ?? PROGRESS[step], slow: account?.machine?.setup?.slow === true };
    }
    if (own.status === "ended" || own.status === "payment_problem") return { kind: "payment" };
    return { kind: "waiting" };
  }
  const machine = account?.machine;
  if (machine?.status === "ready") return { kind: "ready", ...(machine.origin ? { origin: machine.origin } : {}) };
  if (machine?.status === "provisioning") {
    const step = machine.setup?.step ?? "reserving";
    return { kind: "setting-up", step, progress: PROGRESS[step], slow: machine.setup?.slow === true };
  }
  if (machine?.status === "payment-problem") return { kind: "payment" };
  if (machine?.status === "failed") return { kind: "failed" };
  return { kind: "waiting" };
}

/** How long each checklist step shows done before the next one ticks, when the Admin reports several at once. */
export const STEP_TICK_MS = 450;

/** The checklist position, one step at a time toward `target`: a jump in the Admin's word never skips a tick. */
export function useStepwise(target: number, tickMs = STEP_TICK_MS): number {
  const [shown, setShown] = useState(target);
  useEffect(() => {
    if (shown === target) return;
    if (target < shown) { setShown(target); return; }
    const timer = window.setTimeout(() => setShown((now) => Math.min(target, now + 1)), tickMs);
    return () => window.clearTimeout(timer);
  }, [shown, target, tickMs]);
  return shown;
}

export function MakingView({ making, opening, openFailed, onOpen, onPlan, onHere }: {
  making: Making; opening: boolean; openFailed: boolean; onOpen: () => void; onPlan?: () => void;
  /** after a failed open: on to this computer's own chat, the cloud still there to open later */
  onHere?: () => void;
}) {
  const target = making.kind === "ready" ? STEPS.length : making.kind === "setting-up" ? STEPS.findIndex(([key]) => key === making.step) : 0;
  const at = useStepwise(target);
  const ready = making.kind === "ready" && at === STEPS.length;
  const progress = ready ? 1 : making.kind === "setting-up" ? making.progress : 0.04;
  return (
    <StepFrame
      art={<PlaceArt name="cloud" size={60} className="place-mark" />}
      title={ready ? t("funnel.making.readyTitle") : t("funnel.making.title")}
      sub={ready ? t("funnel.making.readySub") : making.kind === "failed" ? t("funnel.making.failed") : making.kind === "payment" ? t("funnel.making.payment") : t("funnel.making.sub")}
      footer={ready && openFailed ? (
        // the cloud opens by itself once ready; a button only after that open failed
        <div className="flex flex-col items-center gap-1">
          <button type="button" data-primary="" data-funnel-open-cloud="" aria-busy={opening || undefined} onClick={onOpen} className={PRIMARY}>{t("funnel.making.retry")}</button>
          {onHere && <button type="button" data-funnel-use-here="" onClick={onHere} className={QUIET}>{t("funnel.making.here")}</button>}
        </div>
      ) : making.kind === "payment" && onPlan ? (
        <button type="button" data-primary="" data-funnel-plan-page="" onClick={onPlan} className={PRIMARY}>{t("funnel.making.planPage")}</button>
      ) : (making.kind === "waiting" || making.kind === "failed") && onHere ? (
        // never a dead end: a cloud that isn't coming yet still leaves this computer's chat one press away
        <button type="button" data-funnel-use-here="" onClick={onHere} className={QUIET}>{t("funnel.making.here")}</button>
      ) : undefined}
    >
      <div data-funnel-making={making.kind} className="flex w-full max-w-[360px] flex-col gap-3 text-start">
        <ProgressBar value={progress} label={t("funnel.making.progress")} />
        <Checklist label={t("funnel.making.progress")} items={STEPS.map(([key, label], index) => ({
          key, title: t(label, { name: t("funnel.place.cloud") }),
          state: index < at ? "done" as const : index === at && !ready && making.kind !== "payment" ? "now" as const : "next" as const,
        }))} />
        {making.kind === "setting-up" && making.slow && <p role="status" className="px-3 text-[13px] leading-[18px] text-ink-secondary">{t("cloudHome.slow")}</p>}
        {openFailed && <p role="alert" className="px-3 text-[13px] leading-[18px] text-danger">{t("funnel.making.openFailed")}</p>}
      </div>
    </StepFrame>
  );
}

/** How long a ready Cloud's page gets to answer before the chat is opened anyway (the window then says it is starting). */
export const ANSWER_WAIT_MS = 4 * 60_000;
const ANSWER_EVERY_MS = 3_000;

/** Whether the page at `origin` answers at all: an opaque answer is enough, only a page that can't be reached throws. */
export async function cloudAnswers(origin: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    await fetchImpl(`${origin}/api/health`, { mode: "no-cors", cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(5_000) });
    return true;
  } catch { return false; }
}

/** The Admin says ready a little before a brand-new Cloud's address answers: until it does, the step stays on its last
 * check, so the chat opens straight onto the Cloud rather than onto a second setup screen. */
function useAnswering(making: Making): Making {
  const origin = making.kind === "ready" ? making.origin ?? null : null;
  const [answered, setAnswered] = useState<string | null>(null);
  useEffect(() => {
    if (!origin || answered === origin) return;
    let live = true, timer = 0;
    const since = Date.now();
    const look = async () => {
      const yes = await cloudAnswers(origin);
      if (!live) return;
      if (yes || Date.now() - since >= ANSWER_WAIT_MS) setAnswered(origin);
      else timer = window.setTimeout(() => void look(), ANSWER_EVERY_MS);
    };
    void look();
    return () => { live = false; window.clearTimeout(timer); };
  }, [origin, answered]);
  if (!origin || answered === origin) return making;
  return { kind: "setting-up", step: "checking", progress: 0.95, slow: false };
}

const OPEN_TRIED = "madani.making.openTried";
/** How long after an automatic open this page coming back means that open didn't take. */
export const OPEN_RETURN_MS = 2 * 60_000;
function openTriedRecently(now = Date.now()): boolean {
  try { return now - Number(sessionStorage.getItem(OPEN_TRIED) ?? 0) < OPEN_RETURN_MS; } catch { return false; }
}
function markOpenTried(now = Date.now()): void {
  try { sessionStorage.setItem(OPEN_TRIED, String(now)); } catch {}
}

/** Follows the Admin's word on the Cloud, holds this computer's AI sign-ins for it once, and opens its chat when it is ready. */
export function MakingStep({ onOpened }: { onOpened: () => void }) {
  const bridge = window.madaniDesktop?.cloudAccount;
  const [account, setAccount] = useState<CloudAccountState | null>(null);
  const [opening, setOpening] = useState(false);
  // this page back right after an automatic open: the cloud didn't show, so Try again and this computer are offered
  const [openFailed, setOpenFailed] = useState(openTriedRecently);
  useEffect(() => {
    if (!bridge) return;
    let live = true;
    const stop = bridge.onState((next) => { if (live) setAccount(next); });
    void bridge.state().then((next) => { if (live) setAccount((now) => now ?? next); }, () => {});
    void bridge.refresh().catch(() => {});
    return () => { live = false; stop(); };
  }, [bridge]);

  const held = useRef(false);
  useEffect(() => {
    if (held.current || !bridge?.holdSignIns || account?.status !== "connected") return;
    held.current = true;
    void bridge.holdSignIns().catch(() => {});
  }, [bridge, account?.status]);

  const making = useAnswering(makingFrom(account));
  const open = () => {
    if (!bridge || opening) return;
    setOpening(true);
    setOpenFailed(false);
    markOpenTried();
    void bridge.connectHome().then(() => onOpened(), () => setOpenFailed(true)).finally(() => setOpening(false));
  };
  const autoOpened = useRef(false);
  useEffect(() => {
    if (making.kind !== "ready" || autoOpened.current) return;
    autoOpened.current = true;
    if (!openFailed) open();
  });
  return <MakingView making={making} opening={opening} openFailed={openFailed} onOpen={open} onHere={onOpened}
    onPlan={bridge ? () => void bridge.openDashboard().catch(() => {}) : undefined} />;
}
