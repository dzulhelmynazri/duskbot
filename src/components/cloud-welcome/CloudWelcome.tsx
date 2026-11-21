import { useEffect, useRef, useState } from "react";
import { Check, Clock, Loader2, Moon, Smartphone, type GlyphIcon } from "../../icons";
import { useCloudSendNotice } from "@/components/CloudSendStrip";
import { CloudMoveScene } from "@/components/CloudMoveScene";
import { WindowDragStrip } from "@/components/DesktopCapabilities";
import { engineReady } from "@/components/EngineLibrary";
import { track } from "@/lib/analytics";
import { CLOUD_SETUP_MOVE_SKIPPED, CLOUD_WELCOME_DONE, CLOUD_WELCOME_SHOWN, WELCOME_STEPS, welcomeStepHint } from "@/lib/cloud-setup";
import { endWelcomeHere, markWelcomeSeen, saveWelcomeHints, stepAsideWelcome, takeWelcomeRequest, useCloudWelcome, withEarlyHints } from "@/lib/cloud-welcome";
import { t } from "@/lib/i18n";
import { phoneAppEnabled } from "@/lib/feature-flags";
import { hintSeen } from "@/lib/onboarding";
import type { CloudSendNotice } from "../../../electron/cloud-send.mjs";
import { openBot, useStore } from "@/state/store";
import { BringMyCloud } from "./BringMyCloud";
import { QUIET_BUTTON } from "@/components/CloudMoveOffer";
import { PRIMARY, useCloudName } from "./parts";
import { WelcomeEngine } from "./WelcomeSteps";

/** Sends that carry everything (bots, skills, logins, settings and chats); one login or one item is not one. "first"
 * and "auto": an older desktop's sends by itself. */
const WHOLE_SENDS = new Set(["button", "my-cloud", "menu", "move", "first", "auto"]);

/** What came over from this computer: "sent" once a whole send went through (`last` says what arrived); "sending" while
 * one runs, or while an older desktop that sends by itself has not sent yet; null otherwise. */
export function sentHere(notice: CloudSendNotice | null | undefined): { state: "sending" | "sent"; last: CloudSendNotice["last"] } | null {
  if (!notice || notice.whole === undefined) return null;
  const last = notice.last;
  const whole = Boolean(last && WHOLE_SENDS.has(last.reason));
  if (notice.running && WHOLE_SENDS.has(notice.runningReason ?? "")) return { state: "sending", last };
  if (whole && !last!.error) return { state: "sent", last };
  if (notice.auto === true && !whole) return { state: "sending", last };
  return null;
}

const ALL_LINES: Array<{ icon: GlyphIcon; key: "cloudWelcome.v2.always" | "cloudWelcome.v2.phone" | "cloudWelcome.v2.routines" }> = [
  { icon: Moon, key: "cloudWelcome.v2.always" },
  { icon: Smartphone, key: "cloudWelcome.v2.phone" },
  { icon: Clock, key: "cloudWelcome.v2.routines" },
];

/** A fresh madani cloud, or one this computer's bots just moved to, in one screen: the bots landing on the cloud, what is
 * different now, and one thing to do: connect an AI when none works yet, else start chatting. */
export function CloudWelcome() {
  const { state, dispatch } = useStore();
  const welcome = useCloudWelcome();
  const record = withEarlyHints(state.config?.onboarding, welcome.early);
  const name = useCloudName();
  const team = Boolean(state.config?.team);
  const [connecting, setConnecting] = useState(() => takeWelcomeRequest() === "engine");
  const [landed, setLanded] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const visible = state.bots.filter((bot) => !bot.hidden);
  const bot = visible.find((candidate) => candidate.chiefOfStaff) ?? visible[0] ?? null;
  const sendBridge = window.madaniDesktop?.remoteClient?.active ? undefined : window.madaniDesktop?.cloudSendPage;
  const [notice] = useCloudSendNotice(sendBridge);
  const sent = sentHere(notice);
  const aiReady = state.instances.some(engineReady);

  useEffect(() => {
    markWelcomeSeen();
    if (!hintSeen(record, CLOUD_WELCOME_SHOWN)) remember([CLOUD_WELCOME_SHOWN]);
    track("cloud_welcome_step", { step: "welcome" });
    const timer = setTimeout(() => setLanded(true), 450);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (connecting) track("cloud_welcome_step", { step: "engine" }); }, [connecting]);

  const anchor = useRef<string | null>(null);
  useEffect(() => {
    if (!state.selectedId) return;
    if (anchor.current === null) anchor.current = state.selectedId;
    else if (state.selectedId !== anchor.current) stepAsideWelcome();
  }, [state.selectedId]);

  const remember = (ids: string[]) => { void saveWelcomeHints(state.config?.onboarding, ids, dispatch); };
  // The sidebar's Set up card reads each step as handled once the welcome ends here, the AI as connected or skipped.
  const end = (reason: "done" | "skipped") => {
    track("cloud_welcome_ended", { reason, at: connecting ? "engine" : "welcome" });
    remember([CLOUD_WELCOME_DONE, ...WELCOME_STEPS.map(welcomeStepHint), ...(sent ? [] : [CLOUD_SETUP_MOVE_SKIPPED])]);
    endWelcomeHere();
  };
  const start = () => {
    end("done");
    dispatch({ type: "showChat" });
    if (bot) openBot(dispatch, bot);
  };

  const headline = team ? t("cloudWelcome.v2.titleNamed", { name }) : t("cloudWelcome.v2.title");
  return <main data-cloud-welcome={connecting ? "engine" : "welcome"} className="@container/welcome relative flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-app">
    <WindowDragStrip />
    <div className="mx-auto flex w-full max-w-[520px] flex-col items-center px-6 pb-12 pt-14 text-center">
      <CloudMoveScene progress={landed ? 1 : 0} done={landed} className="rounded-[18px] pt-3" />
      <h1 ref={heading} tabIndex={-1} className="mt-7 text-[24px] font-semibold tracking-[-0.02em] text-ink outline-none [text-wrap:balance]">{headline}</h1>
      {sent && <p role="status" data-welcome-arrived={sent.state} className="mt-2 inline-flex items-center gap-1.5 text-[14px] font-medium text-ink-secondary">
        {sent.state === "sending"
          ? <Loader2 size={14} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
          : <Check size={14} strokeWidth={2.5} aria-hidden="true" className="text-success" />}
        {t(sent.state === "sending" ? "cloudWelcome.v2.arriving" : "cloudWelcome.v2.arrived")}
      </p>}
      <ul className="mt-6 flex w-full flex-col gap-3 text-left">
        {ALL_LINES.filter(({ key }) => key !== "cloudWelcome.v2.phone" || phoneAppEnabled()).map(({ icon: Icon, key }) => <li key={key} className="flex items-center gap-3 text-[15px] font-medium leading-6 text-ink">
          <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-accent/12 text-accent-text"><Icon size={16} /></span>
          {t(key)}
        </li>)}
      </ul>
      {team && sendBridge && <div className="mt-6 w-full text-left"><BringMyCloud /></div>}
      {connecting
        ? <div className="mt-8 w-full text-left">
            <WelcomeEngine name={name} headingRef={heading} onFinish={() => { remember([welcomeStepHint("engine")]); setConnecting(false); }} />
          </div>
        : <div className="mt-8 flex flex-col items-center gap-2">
            {aiReady
              ? <button type="button" data-welcome-action="start" className={PRIMARY} onClick={start}>{t("cloudWelcome.v2.start")}</button>
              : <button type="button" data-welcome-action="connect" className={PRIMARY} onClick={() => setConnecting(true)}>{t("cloudWelcome.v2.connect")}</button>}
            <button type="button" data-welcome-action="later" className={QUIET_BUTTON} onClick={() => end("skipped")}>{t("cloudWelcome.v2.later")}</button>
          </div>}
    </div>
  </main>;
}
