import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ExternalLink, LoaderCircle } from "../../icons";
import { openExternalLink } from "@/lib/app-links";
import { cloudAsleep, cloudWaking } from "@/lib/cloud-power";
import { useCopyFeedback } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { engineSignedIn, tileSignInEngine } from "@/lib/product-events";
import { trail } from "@/lib/trail";
import { api, useStore, type InstanceInfo } from "@/state/store";
import { StageSwap } from "./ConnectMotion";
import { ConnectFlow, measured, type ConnectInstance, type ConnectState, type ConnectTarget, type InstallProgress } from "./connect-flow";

const QUIET = "min-h-8 rounded-full px-3 text-[13px] leading-[18px] text-ink-secondary transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none";
const SECONDARY = "inline-flex min-h-8 items-center gap-1.5 rounded-full bg-ink/[0.06] px-3 text-[13px] leading-[18px] text-ink transition-colors hover:bg-ink/[0.1] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none";

/** The page a sign-in finishes on, by what people call it. */
export function siteName(driverKind: string): string {
  switch (driverKind) {
    case "codex": return "ChatGPT";
    case "claudeAgent": return "Claude";
    case "grokAgent": return "Grok";
    case "copilotAgent": return "GitHub";
    case "cursorAgent": return "Cursor";
    case "kimiAgent": return "Kimi";
    case "antigravityAgent": case "geminiAgent": return "Google";
    default: return "";
  }
}

/** One connect at a time for a whole grid: a new one cancels the running one, and leaving the grid cancels it too. */
export function useConnectFlow() {
  const { dispatch, refreshModels } = useStore();
  const flow = useMemo(() => new ConnectFlow({
    api: (path, init) => api(path, init),
    refresh: async () => {
      const { instances } = await api<{ instances: InstanceInfo[] }>("/api/instances?fresh=1", { timeoutMs: 120_000 });
      if (Array.isArray(instances)) dispatch({ type: "instances", instances });
      return (instances ?? []) as unknown as ConnectInstance[];
    },
    open: (link) => openExternalLink(link).then(() => true, () => false),
    ...(window.madaniDesktop?.authRelay ? { relay: window.madaniDesktop.authRelay } : {}),
    trail: (ev, fields) => trail(ev, fields),
    waking: () => cloudAsleep() || cloudWaking(),
  }), [dispatch]);
  const [state, setState] = useState<ConnectState>(flow.state);
  const models = useRef(refreshModels);
  models.current = refreshModels;
  useEffect(() => flow.subscribe((next) => {
    setState(next);
    if (next.stage === "connected" && !next.reused) {
      engineSignedIn(tileSignInEngine(flow.target?.tile), "browser");
      void models.current(flow.instance).catch(() => {});
    }
  }), [flow]);
  useEffect(() => () => flow.cancel(), [flow]);
  return {
    state,
    target: flow.target,
    start: (target: ConnectTarget) => flow.start(target),
    cancel: () => flow.cancel(),
    retry: () => flow.retry(),
    openAgain: () => flow.openAgain(),
    submit: (code: string) => flow.submit(code),
  };
}

export type ConnectFlowHandle = ReturnType<typeof useConnectFlow>;

function useSeconds(since: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [since]);
  return since === null ? 0 : Math.max(0, Math.floor((now - since) / 1_000));
}

export function PasteSlot({ name, onSubmit, address = false, problem = null }: { name: string; onSubmit: (code: string) => void; address?: boolean; problem?: string | null }) {
  const [code, setCode] = useState("");
  const label = address ? t("connect.redirect.paste") : t("onboarding.meet.paste", { name });
  return (
    <form data-sign-in={address ? "redirect" : "paste"} className="flex w-[288px] max-w-full flex-col items-center gap-2" onSubmit={(event) => { event.preventDefault(); onSubmit(code); }}>
      <input autoFocus value={code} onChange={(event) => setCode(event.target.value)} aria-label={label} placeholder={label} aria-invalid={problem ? true : undefined}
        className="h-9 w-full rounded-[18px] border-0 bg-ink/[0.06] px-4 text-[14px] leading-5 text-ink outline-none placeholder:text-ink-tertiary focus-visible:bg-ink/[0.08]" spellCheck={false} autoCorrect="off" autoCapitalize="off" />
      {problem && <p role="alert" data-paste-problem="" className="m-0 max-w-[400px] text-center text-[13px] leading-[18px] text-danger">{problem}</p>}
      <button type="submit" disabled={!code.trim()} className={SECONDARY}>{t(address ? "connect.redirect.submit" : "onboarding.meet.pasteSubmit")}</button>
    </form>
  );
}

function Busy({ label, hint, seconds }: { label: string; hint?: string | null; seconds: number }) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col items-center gap-1 text-center">
      <p className="m-0 flex items-center gap-2 text-[14px] leading-5 text-ink">
        <LoaderCircle size={14} aria-hidden="true" className="shrink-0 animate-spin motion-reduce:animate-none" />
        {label}
        {seconds >= 5 && <span className="tabular-nums text-ink-tertiary">{t("connect.elapsed", { seconds })}</span>}
      </p>
      {hint && <p className="m-0 max-w-[360px] text-[12px] leading-4 text-ink-secondary">{hint}</p>}
    </div>
  );
}

const MB = 1024 * 1024;

/** A measured install: the calm line with a percent, one thin bar that glides between readings, and the megabytes or
 * setup under it. */
export function InstallBusy({ label, progress, align = "center" }: { label: string; progress: InstallProgress & { total: number }; align?: "center" | "start" }) {
  const setup = progress.phase === "setup";
  const fraction = setup ? 1 : progress.received / progress.total;
  const percent = Math.min(99, Math.floor(fraction * 100));
  const totalMb = Math.max(1, Math.round(progress.total / MB));
  const detail = setup ? t("connect.stage.settingUp") : t("connect.stage.downloaded", { received: Math.min(totalMb, Math.floor(progress.received / MB)), total: totalMb });
  return (
    <div role="status" aria-live="polite" className={align === "start" ? "flex flex-col items-start gap-1 text-left" : "flex flex-col items-center gap-1 text-center"}>
      <p className="m-0 flex items-center gap-2 text-[14px] leading-5 text-ink">
        <LoaderCircle size={14} aria-hidden="true" className="shrink-0 animate-spin motion-reduce:animate-none" />
        {label}
        {!setup && <span className="tabular-nums text-ink-tertiary">{t("connect.stage.percent", { percent })}</span>}
      </p>
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={setup ? 100 : percent} aria-valuetext={detail}
        data-connect-progress="" className="my-1 h-1 w-[200px] max-w-full overflow-hidden rounded-full bg-ink/8">
        <div className="connect-bar h-full w-full rounded-full bg-ink" style={{ transform: `scaleX(${fraction})` }} />
      </div>
      <p className="m-0 text-[12px] leading-4 tabular-nums text-ink-secondary">{detail}</p>
    </div>
  );
}

/** a sign-in that waits on the person's browser: what to do there, then a calm elapsed line once it has been a while */
const STILL_WAITING_AFTER = 20;
const OTHER_WAY_AFTER = 45;
function WaitHelp({ guide, seconds }: { guide: string; seconds: number }) {
  return (
    <div className="flex max-w-[380px] flex-col items-center gap-1 text-center">
      {guide && <p data-connect-guide="" className="m-0 text-[12px] leading-4 text-ink-secondary">{guide}</p>}
      {seconds >= STILL_WAITING_AFTER && <p data-connect-still="" className="m-0 text-[12px] leading-4 text-ink-tertiary tabular-nums">{t("connect.stillWaiting", { seconds })}</p>}
    </div>
  );
}
function OtherWay({ seconds, onTrouble }: { seconds: number; onTrouble?: () => void }) {
  if (!onTrouble || seconds < OTHER_WAY_AFTER) return null;
  return <button type="button" onClick={onTrouble} className={QUIET} data-connect-other="">{t("connect.trouble")}</button>;
}

/** A link by its site and, for a code page, its path ("github.com/login/device"); a sign-in link by its site alone. */
const linkText = (link: string, withPath: boolean) => {
  try {
    const url = new URL(link);
    return withPath ? `${url.host}${url.pathname === "/" ? "" : url.pathname}` : url.host;
  } catch { return link; }
};

/** The one sign-in step every machine shows: where to finish (a blue link), the device code when there is one, one
 * button that copies the code (or the link) and opens the site, and a quiet waiting line. A browser that opened by
 * itself and needs no code shows the same step, so a cloud and this computer only differ by the code. */
function CodeStep({ code, site, link, onOpen, cancel, guide, seconds, onTrouble }: { code: string | null; site: string; link: string | null; onOpen: (() => void) | null; cancel: React.ReactNode;
  guide: string; seconds: number; onTrouble?: () => void }) {
  const { state, copy } = useCopyFeedback(code ?? "");
  const copied = state === "copied";
  const waiting = <div role="status" aria-live="polite" className="flex items-center gap-2 text-[13px] leading-[18px] text-ink-secondary">
    <LoaderCircle size={13} aria-hidden="true" className="shrink-0 animate-spin motion-reduce:animate-none" />
    {code ? t("connect.stage.waiting") : t("connect.stage.finishInBrowser", { site })}
  </div>;
  // no code: the browser already opened, so one line on what to do there, a way back to it and out
  if (!code) return <>
    {waiting}
    <WaitHelp guide={guide} seconds={seconds} />
    <div className="flex items-center gap-1.5">
      {link && onOpen && <button type="button" onClick={onOpen} className={SECONDARY}><ExternalLink size={13} aria-hidden="true" />{t("connect.openAgain")}</button>}
      {cancel}
    </div>
    <OtherWay seconds={seconds} onTrouble={onTrouble} />
  </>;
  const [before, after = ""] = t("connect.stage.enterCode", { site: "\u0000" }).split("\u0000");
  return <>
    <button type="button" onClick={copy} data-sign-in="code" aria-label={t("connect.copyCode")}
      className="rounded-xl bg-composer px-4 py-1.5 font-mono text-[20px] font-medium tracking-[0.12em] text-ink transition-colors hover:bg-ink/[0.08] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none">{code}</button>
    <p className="m-0 text-center text-[13px] leading-[18px] text-ink-secondary">
      {before}{link && onOpen
        ? <button type="button" onClick={onOpen} className="text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">{linkText(link, true)}</button>
        : site}{after}
    </p>
    <div className="flex items-center gap-1.5">
      <button type="button" data-connect-copy="" onClick={() => { void copy(); onOpen?.(); }} className="ui-button ui-button-pill ui-button-primary min-h-9 gap-1.5 px-4 text-[14px]">
        {copied ? <Check size={14} aria-hidden="true" /> : <ExternalLink size={14} aria-hidden="true" />}
        {copied ? t("connect.codeCopiedPaste", { site }) : onOpen ? t("connect.copyAndOpen", { site }) : t("connect.copyCode")}
      </button>
      {cancel}
    </div>
    {waiting}
    <WaitHelp guide={guide} seconds={seconds} />
    <OtherWay seconds={seconds} onTrouble={onTrouble} />
  </>;
}

/** The pressed AI's connect, stage by stage: honest progress, a deadline on each step, and a way out of every one. */
export function ConnectPanel({ flow, name, driverKind, onTrouble }: {
  flow: ConnectFlowHandle;
  name: string;
  driverKind: string;
  onTrouble?: () => void;
}) {
  const { state } = flow;
  const since = "since" in state ? state.since : null;
  const seconds = useSeconds(since);
  const site = siteName(driverKind) || name;
  const cancel = <button type="button" onClick={flow.cancel} className={SECONDARY} data-connect-cancel="">{t("common.cancel")}</button>;

  let body: React.ReactNode;
  switch (state.stage) {
    case "idle":
      body = null;
      break;
    case "waking":
      body = <><Busy label={t("connect.stage.waking")} hint={t("connect.stage.wakingHint")} seconds={seconds} />{cancel}</>;
      break;
    case "preparing":
      body = <><Busy label={t("connect.stage.preparing", { name })} seconds={seconds} />{cancel}</>;
      break;
    case "installing": {
      const hint = state.downloadBytes
        ? t("connect.stage.downloadSize", { name, mb: Math.max(1, Math.round(state.downloadBytes / 1024 / 1024)) })
        : t("connect.stage.download", { name });
      const progress = measured(state.progress);
      body = <>{progress
        ? <InstallBusy label={t("connect.stage.installing", { name })} progress={progress} />
        : <Busy label={t("connect.stage.installing", { name })} hint={hint} seconds={seconds} />}{cancel}</>;
      break;
    }
    case "opening":
      body = <><Busy label={t("connect.stage.opening", { name })} seconds={seconds} />{cancel}</>;
      break;
    case "confirming":
      body = <Busy label={t("connect.stage.confirming", { name })} seconds={seconds} />;
      break;
    case "connected":
      body = (
        <p role="status" className="m-0 flex items-center gap-1.5 text-[14px] leading-5 text-success">
          <Check size={14} strokeWidth={2.5} aria-hidden="true" className="connect-check-in" />{t("connect.stage.connected")}
        </p>
      );
      break;
    case "waiting":
      if (state.kind === "paste" || state.kind === "redirect") {
        body = <>
          <PasteSlot name={name} onSubmit={flow.submit} address={state.kind === "redirect"} problem={state.problem ?? null} />
          <WaitHelp guide={t(state.kind === "redirect" ? "connect.guide.redirect" : "connect.guide.paste", { site })} seconds={seconds} />
          <div className="flex items-center gap-1">
            {state.link && <button type="button" onClick={() => void flow.openAgain()} className={QUIET}>{t("connect.openAgain")}</button>}
            {cancel}
          </div>
          <OtherWay seconds={seconds} onTrouble={onTrouble} />
        </>;
      } else {
        body = <CodeStep code={state.code} site={site} link={state.link} onOpen={state.link ? () => void flow.openAgain() : null} cancel={cancel}
          // a shown code already says where to enter it above, so it gets no second line
          guide={state.code ? "" : t("connect.guide.browser", { site })} seconds={seconds} onTrouble={onTrouble} />;
      }
      break;
    case "failed": {
      const installing = state.at === "installing";
      const plain = state.reason === "timeout" ? t(`connect.timeout.${state.at}`, { name })
        : state.reason === "lost" ? t("connect.lost")
          : installing ? t("connect.installFailed", { name })
            : state.message ?? (state.reason === "unavailable" ? t("connect.unavailable", { name }) : t("connect.failed", { name }));
      body = <>
        <p role="alert" className="m-0 max-w-[400px] text-center text-[13px] leading-[18px] text-danger">{plain}</p>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={flow.retry} className={SECONDARY}>{t("common.tryAgain")}</button>
          {state.at === "waiting" && state.link && <button type="button" onClick={() => void flow.openAgain()} className={QUIET} data-connect-reopen="">{t("connect.openAgain")}</button>}
        </div>
        {onTrouble && !installing && <button type="button" onClick={onTrouble} className={QUIET} data-connect-trouble="">{t("connect.trouble")}</button>}
      </>;
      break;
    }
  }
  const stageKey = state.stage === "waiting" ? `waiting-${state.kind}` : state.stage;
  const stageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (stageKey.startsWith("waiting") || stageKey === "failed") revealIfCovered(stageRef.current);
  }, [stageKey]);
  return (
    <StageSwap stage={stageKey} className="w-full">
      <div ref={stageRef} data-connect-stage={state.stage} className="flex w-full flex-col items-center gap-2.5">{body}</div>
    </StageSwap>
  );
}

export function revealIfCovered(element: HTMLElement | null): void {
  if (!element) return;
  const box = element.getBoundingClientRect();
  const bottom = box.bottom - 4;
  const hit = bottom > 0 && bottom < window.innerHeight ? document.elementFromPoint(box.left + box.width / 2, bottom) : null;
  if (hit && element.contains(hit)) return;
  element.scrollIntoView?.({ block: "center" });
}
