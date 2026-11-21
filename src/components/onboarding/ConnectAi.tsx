import { ModalLayer } from "../ui/ModalLayer";
import { useCallback, useEffect, useRef, useState } from "react";
import { Art } from "../ui/Art";
import { ArrowLeft, Check, LoaderCircle, RefreshCw, X } from "../../icons";
import { engineReady } from "@/components/EngineLibrary";
import { ModelDirectory } from "@/components/models/ModelDirectory";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { prefetchProviders } from "@/lib/model-providers";
import { aiWorks, organisationSignIn } from "@/lib/onboarding";
import { api, useStore } from "@/state/store";
import { freeFallback } from "../../../shared/ai-ranking";
import { AiCards } from "./AiCards";
import { StageSwap } from "./ConnectMotion";
import { OrganisationRow } from "./beats/OrganisationRow";
import type { WelcomeAiNow } from "./welcome-ai";
import type { AiTileId } from "./funnel";

/** Connecting an AI: the grid of AIs people already use (AiCards), the organization's sign-in where there is one, and a
 * link to every other provider (`onMore`). Until one has answered a test message (`tested`, from useWelcomeAi) it says
 * how that went: one that didn't answer says why, with Check again; OpenCode's free model is only ever a backup. */
export function ConnectAi({ tested, onMore, onConnected }: { tested: WelcomeAiNow | null; onMore?: () => void;
  onConnected?: (tile: AiTileId) => void }) {
  const { state, dispatch } = useStore();
  const organisation = organisationSignIn(window.madaniDesktop);
  const [failed, setFailed] = useState(false);
  const [checking, setChecking] = useState(false);
  const latestRequest = useRef(0);
  // the directory behind "More providers" loads now, so it opens on its list
  const offersMore = Boolean(onMore);
  useEffect(() => { if (offersMore) prefetchProviders(); }, [offersMore]);

  const refresh = useCallback(async (fresh = true) => {
    const request = ++latestRequest.current;
    setChecking(true);
    try {
      const d = await api(fresh ? "/api/instances?fresh=1" : "/api/instances", { signal: AbortSignal.timeout(10_000) });
      if (request !== latestRequest.current) return;
      dispatch({ type: "instances", instances: d.instances ?? [] });
      setFailed(false);
    } catch {
      if (request === latestRequest.current) setFailed(true);
    } finally {
      if (request === latestRequest.current) setChecking(false);
    }
  }, [dispatch]);

  useEffect(() => {
    void refresh(false);
    return () => {
      latestRequest.current++;
    };
  }, [refresh]);

  const connected = tested && aiWorks(tested) ? tested.instance : undefined;
  const backup = state.instances.find((instance) => engineReady(instance) && freeFallback(instance));

  return (
    <div className="flex w-full flex-col">
      {connected ? (
        <p role="status" data-ai-connected className="flex items-center gap-2 text-[14px] text-success">
          <Check size={15} strokeWidth={2.5} aria-hidden="true" />
          {/* An AI with no way to send a test message keeps the line it always had. */}
          {t(tested?.state === "passed" ? "onboarding.engines.answered" : "onboarding.engines.connected", { name: connected.displayName })}
        </p>
      ) : tested?.state === "testing" ? (
        <p role="status" data-ai-checking className="flex items-center gap-2 text-[14px] text-ink-secondary">
          <LoaderCircle size={15} aria-hidden="true" className="shrink-0 animate-spin" />
          {t("onboarding.engines.checkingAnswer", { name: tested.instance.displayName })}
        </p>
      ) : (
        <>
          {tested?.state === "failed" && (
            <div role="alert" data-ai-silent className="mb-3 w-full text-left text-[13px] leading-5 text-ink">
              {/* The check's own plain reason (signed out, a used-up limit…) when it gave one. */}
              <p data-ai-reason>{tested.error ?? t("onboarding.engines.noAnswer", { name: tested.instance.displayName })}</p>
              {tested.error && <p className="mt-1 text-ink-secondary">{t("onboarding.engines.orAnother")}</p>}
              <button
                type="button"
                onClick={tested.retry}
                className="ui-button ui-button-pill ui-button-sm mt-2"
              >
                <RefreshCw size={12} aria-hidden="true" />
                {t("common.checkAgain")}
              </button>
            </div>
          )}
          {!tested && backup && (
            <p data-ai-backup className="mb-3 text-[13px] text-ink-secondary">
              {t("onboarding.engines.freeBackup", { name: backup.displayName })}
            </p>
          )}
          {!tested && !backup && !failed && state.instances.length === 0 && (
            <p className="mb-3 text-[13px] text-ink-secondary" aria-live="polite">{t("common.checking")}</p>
          )}
        </>
      )}
      {failed && <p role="alert" className="mt-2 text-[13px] text-danger">{t("onboarding.engines.error")}</p>}

      <AiCards tested={tested} onMore={onMore} onConnected={onConnected} className={connected || tested ? "mt-4" : undefined} />

      {organisation && (
        <div className="mt-3 w-full overflow-hidden rounded-xl text-left">
          <OrganisationRow
            bridge={organisation}
            onOpenSettings={() => dispatch({ type: "toggleAppSettings", open: true, section: "organization" })}
            onConnected={() => void refresh()}
          />
        </div>
      )}
      {failed && <button
        type="button"
        onClick={() => void refresh()}
        disabled={checking}
        className="mx-auto mt-1 flex min-h-9 items-center gap-1.5 rounded-full px-3 text-[12px] text-ink-secondary hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-50"
      >
        <RefreshCw size={12} aria-hidden="true" className={checking ? "animate-spin motion-reduce:animate-none" : ""} />
        {checking ? t("common.checking") : t("common.checkAgain")}
      </button>}
    </div>
  );
}

/** Leaving, the sheet fades out over this long (overlays.css runs it at 120ms). */
export const DIALOG_LEAVE_MS = 120;

/** "Connect an AI" over the first screen, the chat or settings: the grid of AIs, and behind its link the model directory
 * for every other provider and API keys (`directory`: open on that). `start` is the AI it was opened for: its
 * card takes the focus, and nothing runs until the person presses it. `onConnected` hears when it is connected (the
 * model picker's Connect). */
export function ConnectAiDialog({ tested, directory = false, onClose, start, onConnected }: { tested: WelcomeAiNow | null; directory?: boolean;
  onClose: () => void; start?: AiTileId; onConnected?: (tile: AiTileId) => void }) {
  const [more, setMore] = useState(directory);
  const box = useRef<HTMLDivElement>(null);
  const [leaving, setLeaving] = useState(false);
  const close = () => {
    if (leaving) return;
    setLeaving(true);
    setTimeout(onClose, DIALOG_LEAVE_MS);
  };
  // focus starts on the AI it was opened for, else on the sheet itself, so Close does not open with its tooltip already showing
  useEffect(() => {
    const card = start ? box.current?.querySelector<HTMLElement>(`button[data-funnel-ai="${start}"]`) : null;
    (card ?? box.current)?.focus({ preventScroll: true });
  }, []);
  return (
    <ModalLayer><div
      className="ui-scrim fixed inset-0 z-[60] flex items-center justify-center p-4"
      data-leaving={leaving ? "" : undefined}
      inert={leaving || undefined}
      // a click outside never closes it: a sign-in may be under way; Close or Escape does
    >
      <div
        ref={box}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="connect-ai-title"
        data-connect-ai=""
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          close();
        }}
        className={cn(leaving && "animate-pop-out", "ui-modal flex max-h-[min(680px,calc(100vh-32px))] w-[520px] max-w-full flex-col overflow-hidden text-left outline-none")}
      >
        <div className="flex h-[52px] shrink-0 items-center gap-1 pl-4 pr-3">
          {more && (
            <button type="button" data-connect-ai-back="" onClick={() => setMore(false)} aria-label={t("common.back")} title={t("common.back")}
              className="ui-icon-button -ml-2">
              <ArrowLeft size={16} />
            </button>
          )}
          <h2 id="connect-ai-title" className="min-w-0 flex-1 truncate text-[14px] font-semibold leading-[22px] text-ink">
            {more ? t("connectAi.more") : t("onboarding.meet.connectAi")}
          </h2>
          <button type="button" onClick={close} aria-label={t("common.close")} title={t("common.close")}
            className="ui-icon-button">
            <X size={16} />
          </button>
        </div>
        <div data-art-hover="" className="min-h-0 overflow-y-auto p-4 [scrollbar-width:thin]">
          <StageSwap stage={more ? "directory" : "grid"}>
            {more
              ? <div data-connect-ai-directory=""><ModelDirectory /></div>
              : <>
                  <Art name="plug" size="lg" className="mx-auto mb-4 block" />
                  <ConnectAi tested={tested} onMore={() => setMore(true)} onConnected={onConnected} />
                </>}
          </StageSwap>
        </div>
      </div>
    </div></ModalLayer>
  );
}
