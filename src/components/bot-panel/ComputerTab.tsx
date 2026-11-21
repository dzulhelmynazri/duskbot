import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { phoneApp, storeApp } from "@/lib/store-app";
import { macPermissionsBridge } from "@/lib/mac-permissions";


import { cloudMoveStage, openCloudMove, runsOnHost, type CloudMoveStage, type RunsOnHost } from "@/lib/cloud-move";
import { cloudPlanView } from "@/lib/cloud-plan";
import { cn } from "@/lib/cn";
import { writeComputerPanelView, type ComputerPanelView } from "@/lib/computer-panel-view";
import { t } from "@/lib/i18n";
import type { Place } from "@/lib/place";
import { desktopShowsOtherServer, useOtherServerName } from "@/lib/other-server";
import { placeHasIssue } from "@/lib/place-view";
import { useStore, type Bot } from "@/state/store";
import { useDesktopCapabilities } from "../DesktopCapabilities";
import { LocalComputerAutoWarning } from "../LocalComputerAutoWarning";
import { usePlaceViews } from "../PlaceChip";
import type { BotPatch, useBotSettingsDerived } from "../bot-settings/useBotSettingsDerived";
import type { SimplePageId } from "./page-registry";
import type { InlineReport } from "../ComputerPanel";
import { deviceWord } from "../vps-link/parts";
import { Card, NoteRow, RadioRow } from "./rows";
import { CloudHopScene } from "../CloudMoveScene";
import { mdPrimaryCls } from "../ui/GrokDialog";
import { CloudDesktopListRow, useCloudDesktop, type CloudDesktopRow } from "./CloudDesktop";
import { AsleepMascot, COMPUTER_FRAME_CLASS, COMPUTER_SCREEN_ASPECT, COMPUTER_WAKE_BUTTON_CLASS, ComputerWaking } from "./ComputerScreenMascot";
import { queueComputerWake } from "./computer-wake-queue";
import { LocalBrowserSection } from "./LocalBrowser";
import "./computer-tab.css";

const ComputerPanel = lazy(() => import("../ComputerPanel").then((module) => ({ default: module.ComputerPanel })));

type Derived = ReturnType<typeof useBotSettingsDerived>;
export type PlaceChoice = "auto" | Place | "off";

interface PlaceOption {
  value: PlaceChoice;
  label: string;
  hint?: string;
  disabled?: boolean;
}

const PANEL_PLACE_LABEL = { cloud: "botPanel.place.cloud", vm: "botPanel.place.vm", browser: "botPanel.place.browser" } as const;

const EXTRA_PLACE_LABEL: Record<Exclude<PlaceChoice, "auto" | "local" | "cloud" | "browser">, () => string> = {
  vm: () => t("botPanel.place.vm"),
  off: () => t("botPanel.place.off"),
};

export function useOpenComputer(bot: Pick<Bot, "id">) {
  const { dispatch } = useStore();
  return (view: ComputerPanelView = "computer") => {
    writeComputerPanelView(bot.id, view);
    dispatch({ type: "toggleComputer", open: true });
  };
}

export function usePlaceChoices(bot: Bot) {
  const { state } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const platform = capabilities.host?.platform ?? "other";
  const placeViews = usePlaceViews(bot);
  const current: PlaceChoice = bot.computer ?? "auto";
  const myChrome = state.config?.browserEngine?.myChrome === true
    && (state.config?.browserProfiles ?? []).some((profile) => profile.id === bot.browserProfile && profile.browser === "chrome");
  const placeLabel = (place: Place) => (place === "browser" && myChrome ? t("botPanel.ui.settingsProfilesMyChrome")
    : place === "local" ? t(platform === "darwin" ? "botPanel.place.thisMac" : platform === "win32" ? "botPanel.place.thisPc" : "botPanel.place.thisComputer") : t(PANEL_PLACE_LABEL[place]));
  const choice = (place: Place): PlaceOption => {
    const { view, reachable } = placeViews[place];
    return { value: place, label: placeLabel(place), disabled: !reachable, hint: !reachable || placeHasIssue(view) ? view.line : undefined };
  };
  const options: PlaceOption[] = [
    { value: "auto", label: t("botPanel.ui.computerSimpleDestLetItChoose") },
    ...(placeViews.local.policy ? [choice("local")] : []),
    ...(placeViews.browser.policy || current === "browser" ? [choice("browser")] : []),
    ...(placeViews.cloud.policy ? [choice("cloud")] : []),
    ...(current === "vm" || current === "off" ? [{ value: current, label: EXTRA_PLACE_LABEL[current](), disabled: true }] : []),
  ];
  const liveSurface = bot.tasks?.find((task) => task.threadId === bot.threadId)?.surface;
  const usingNow = liveSurface && liveSurface !== current ? placeLabel(liveSurface) : null;
  const currentLabel = options.find((option) => option.value === current)?.label
    ?? (current === "auto" || current === "vm" || current === "off" ? undefined : placeLabel(current));
  return { options, current, currentLabel, usingNow };
}

/** Choosing where a bot works, as the panel and its dialog both do: a place it cannot use, or Off, is never chosen; this
 * computer for a bot that decides alone asks first, through `warning`. `cloudDesktop`: the cloud desktop row beside the choices, in
 * the desktop app only; choosing it runs its own step and never changes the bot's place (its confirm is in `warning`). */
export function usePlacePicker(bot: Bot, derived: Derived) {
  const { dispatch } = useStore();
  const choices = usePlaceChoices(bot);
  const { current } = choices;
  const [localAutoWarning, setLocalAutoWarning] = useState<{ botId: string; patch: BotPatch } | null>(null);
  const cloudDesktop = useCloudDesktop();
  const { patch, approvalMode } = derived;
  const choosePlace = (value: PlaceChoice) => {
    if (value === current || value === "vm" || value === "off") return;
    if (value === "local" && approvalMode === "auto") {
      setLocalAutoWarning({ botId: bot.id, patch: { computer: "local", acknowledgeLocalAuto: true } });
      return;
    }
    patch(value === "browser" ? { computer: "browser", browser: true } : { computer: value === "auto" ? null : value });
  };
  const warning = (
    <>
    <LocalComputerAutoWarning
      open={localAutoWarning !== null}
      onCancel={() => setLocalAutoWarning(null)}
      onConfirm={() => {
        const target = localAutoWarning;
        setLocalAutoWarning(null);
        if (!target) return;
        dispatch({ type: "updateBot", botId: target.botId, patch: target.patch });
      }}
    />
    {cloudDesktop?.dialog}
    </>
  );
  return { ...choices, choosePlace, warning, cloudDesktop };
}

export function WherePage({ bot, derived }: { bot: Bot; derived: Derived }) {
  const { options, current, usingNow, choosePlace, warning, cloudDesktop } = usePlacePicker(bot, derived);

  return (
    <>
      <Card>
        <div role="radiogroup" aria-label={t("botPanel.ui.computerSimpleWhereWorks", { name: bot.name })} className="flex flex-col divide-y divide-ink/[0.05]">
          {options.map((option) => (
            <RadioRow
              key={option.value}
              data-panel-choice={option.value}
              title={option.label}
              hint={option.hint}
              checked={current === option.value}
              disabled={option.disabled}
              onClick={() => choosePlace(option.value)}
            />
          ))}
        </div>
      </Card>
      {cloudDesktop && <Card><CloudDesktopListRow cloudDesktop={cloudDesktop} /></Card>}
      {usingNow && <p data-panel-using-now className="mx-1 text-[13px] text-ink-secondary">{t("botPanel.ui.computerSimpleUsingNow", { place: usingNow })}</p>}
      {warning}
    </>
  );
}

/** Whether the element is in view; the live screen pauses while the panel is scrolled away or covered by layout. `leaveMs`:
 * how long it must stay out of view before it counts as gone, so a sheet's spring or a tab's slide that carries it past
 * the edge for a moment never drops and reconnects the stream. */
export function useOnScreen(element: HTMLElement | null, leaveMs = 0) {
  const [onScreen, setOnScreen] = useState(true);
  const last = useRef(true);
  useEffect(() => {
    if (!element || typeof IntersectionObserver === "undefined") return;
    let leaving: ReturnType<typeof setTimeout> | undefined;
    const observer = new IntersectionObserver(([entry]) => {
      const next = Boolean(entry?.isIntersecting);
      clearTimeout(leaving);
      if (next === last.current) return;
      if (next || leaveMs === 0) setOnScreen((last.current = next));
      else leaving = setTimeout(() => setOnScreen((last.current = false)), leaveMs);
    });
    observer.observe(element);
    return () => { clearTimeout(leaving); observer.disconnect(); };
  }, [element, leaveMs]);
  return onScreen;
}
const PHONE_LEAVE_MS = 1_000;

/** The screen while the panel's code loads: already the wake button, and a click is kept for the panel to act on. */
export function AsleepScreen({ bot, off }: { bot: Bot; off: boolean }) {
  const [queued, setQueued] = useState(false);
  const label = t(off ? "botPanel.ui.placeViewOffShort" : "botPanel.screen.resting");
  return (
    <div data-panel-screen="" data-stage={off ? "off" : queued ? "loading" : "asleep"} aria-busy={queued || undefined} className={COMPUTER_FRAME_CLASS} style={{ aspectRatio: String(COMPUTER_SCREEN_ASPECT) }}>
      {queued ? <ComputerWaking bot={bot} /> : (
        <button type="button" data-panel-action="open-computer" disabled={off} aria-label={off ? label : t("botPanel.screen.wake")}
          onClick={() => { queueComputerWake(bot.id); setQueued(true); }} className={COMPUTER_WAKE_BUTTON_CLASS}>
          <AsleepMascot bot={bot} />
          <span className="max-w-[80%] font-medium text-ink">{label}</span>
        </button>
      )}
    </div>
  );
}


/** This computer, where a bot stops while it sleeps and has no screen of its own to choose or show. */
const isLocalHost = (host: RunsOnHost) => host.kind === "mac" || host.kind === "pc";



/** The one move to the cloud, as a calm card on a soft blue tint: the bots on this computer and the cloud beside it, a short
 * title and one line, and the primary button. Pointing at the button (a mouse, or keyboard focus) hops them over to the cloud;
 * a tap on touch would leave them stuck there, so only a mouse previews. */
function cloudCta({ bots, anchor, step, there, asleep, title, body, action, label, disabled, hopping, setHopping }: {
  bots: readonly Bot[]; anchor: string; step: string; there: boolean; asleep: boolean; title: string; body: string;
  action: () => void; label: string; disabled: boolean; hopping: boolean; setHopping: (on: boolean) => void;
}) {
  const preview = (on: boolean) => (event: { pointerType: string }) => { if (event.pointerType === "mouse") setHopping(on); };
  return (
    <section data-panel-card={anchor} data-cloud-cta={step} data-cloud-group={bots.length > 1 ? "" : undefined}
      className="mt-3 overflow-hidden rounded-[16px] first:mt-0 bg-[color-mix(in_srgb,#9fdcf5_24%,transparent)]">
      <CloudHopScene bots={bots} on={there || hopping ? "cloud" : "laptop"} asleep={asleep} sky={false} className="pt-2" />
      <div className="flex flex-col gap-3 px-4 pb-4 pt-1">
        <div className="min-w-0">
          <p className="m-0 text-pretty text-[14px] font-medium leading-5 tracking-[-0.01em] text-ink">{title}</p>
          <p className="m-0 mt-1 text-pretty text-[12px] leading-4 text-ink-secondary">{body}</p>
        </div>
        <button type="button" data-panel-action="move-cloud" className={cn(mdPrimaryCls, "w-full")} disabled={disabled} onClick={action}
          onPointerEnter={preview(true)} onPointerLeave={preview(false)} onFocus={() => setHopping(true)} onBlur={() => setHopping(false)}>{label}</button>
      </div>
    </section>
  );
}

/** Moving a bot from a server to madani cloud; in a group chat, one card for all of its bots. A server is always on, so the
 * offer is no upkeep, never "it never sleeps". */
function CloudDesktopCta({ bots, stage, label }: { bots: readonly Bot[]; stage: CloudMoveStage | null; label: string }) {
  const there = stage === "moved" || stage === "open";
  const moving = stage === "preparing" || stage === "moving" || stage === "coming-back";
  const [hopping, setHopping] = useState(false);
  const group = bots.length > 1;
  const name = bots[0]?.name ?? "";
  return cloudCta({
    bots, anchor: "cloud-desktop", step: there ? "open" : moving ? "moving" : "move", there: there || moving, asleep: false, hopping, setHopping,
    title: t(group ? (there ? "runsOn.ctaDesktop.groupTitleThere" : "runsOn.ctaDesktop.groupTitle") : there ? "runsOn.ctaDesktop.titleThere" : "runsOn.ctaDesktop.title", { name }),
    body: t(group ? (there ? "runsOn.ctaDesktop.groupBodyThere" : "runsOn.ctaDesktop.groupBody") : there ? "runsOn.ctaDesktop.bodyThere" : "runsOn.ctaDesktop.body", { name }),
    action: () => openCloudMove("cloud"), label, disabled: moving,
  });
}

export type CloudCtaStep = "get" | "move" | "moving" | "switch";

/** Where a bot on this computer stands with madani cloud: no cloud yet, a cloud to move to, on its way, or already there. */
export function cloudCtaStep(stage: CloudMoveStage | null): CloudCtaStep {
  if (stage === null || stage === "buy" || stage === "elsewhere") return "get";
  if (stage === "moved" || stage === "open") return "switch";
  if (stage === "preparing" || stage === "moving" || stage === "coming-back") return "moving";
  return "move";
}

/** madani cloud for a bot on this computer, and the one next step. `group`: a group chat's bots, one card for all of them. */
export function CloudCtaCard({ bot, group, stage, cloudDesktop }: { bot: Bot; group?: readonly Bot[]; stage: CloudMoveStage | null; cloudDesktop: CloudDesktopRow | null }) {
  const { dispatch } = useStore();
  const [hopping, setHopping] = useState(false);
  const step = cloudCtaStep(stage);
  const device = deviceWord();
  const bots = group && group.length > 0 ? group : [bot];
  const many = bots.length > 1;
  const signedOut = cloudDesktop?.account ? cloudPlanView(cloudDesktop.account).kind === "signed-out" : false;
  const act = () => {
    if (step === "get") dispatch({ type: "openCloudAdd", source: "app_bot_panel", ...(signedOut ? { signIn: true as const } : {}) });
    else if (step === "switch" && cloudDesktop?.openHome) void cloudDesktop.openHome();
    else openCloudMove("cloud");
  };
  const label = t(step === "get" ? "runsOn.getCloud" : step === "switch" ? "runsOn.switchCloud" : step === "moving" ? "runsOn.movingCloud" : "runsOn.moveMadaniCloud");
  // these bots work on this computer, so the card is always the offer, with the switch once the account has a cloud
  const vars = { name: bot.name, device };
  return cloudCta({
    bots, anchor: "madani-cloud", step, there: step === "moving", asleep: step === "get", hopping, setHopping,
    title: t(many ? "runsOn.cta.groupTitle" : "runsOn.cta.title", vars),
    body: t(many ? "runsOn.cta.groupBody" : "runsOn.cta.body", vars),
    action: act, label, disabled: step === "moving",
  });
}

export { hasMadaniCloud } from "@/lib/cloud-move";

/** One small disclosure for what a person rarely needs: the computer's own words for a problem, and its settings. */
export function ComputerTab({ bot, derived, cloudFor }: {
  bot: Bot; derived: Derived; onOpen: (page: SimplePageId) => void;
  /** the bots the cloud card speaks for: this bot alone by default, a group chat's bots on one member, none on the rest */
  cloudFor?: readonly Bot[];
}) {
  const { state } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const picker = usePlacePicker(bot, derived);
  const { current, warning, cloudDesktop } = picker;
  const otherServer = useOtherServerName();
  const [screenBox, setScreenBox] = useState<HTMLElement | null>(null);
  const onScreen = useOnScreen(screenBox, phoneApp() ? PHONE_LEAVE_MS : 0);
  const [report, setReport] = useState<InlineReport | null>(null);
  const host = runsOnHost({ cloudHome: state.config?.cloudHome === true, otherServer, platform: capabilities.host?.platform ?? "other" });
  const screenOf = t(host.kind === "cloud" ? "computer.screenOfCloud" : "computer.screenOf", { name: bot.name });
  const stage = cloudDesktop ? cloudMoveStage(cloudDesktop.view, cloudDesktop.keep) : desktopShowsOtherServer() ? "elsewhere" : null;
  const cloudBots = (cloudFor ?? [bot]).filter((one) => one.yourAccess !== "view");
  const local = isLocalHost(host);
  // a bot on a server moves to cloud desktop; one on madani cloud that came from this computer can go back
  const toCloud = cloudBots.length > 0 && !local && host.kind !== "cloud" && stage !== null;
  const cloudLabel = stage === "preparing" || stage === "moving" ? t("runsOn.movingCloud")
    : stage === "moved" || stage === "open" ? t("runsOn.openCloud")
    : stage === "coming-back" ? t("runsOn.movingBack") : t("runsOn.moveMadaniCloud");
  const detail = report?.detail ?? null;
  // this computer's bot leads with its browser; the madani cloud card follows it, whatever step the account is at
  const cloudOffer = local && cloudBots.length > 0 && !storeApp() && <CloudCtaCard bot={cloudBots[0]!} group={cloudBots} stage={stage} cloudDesktop={cloudDesktop} />;
  const ownScreen = !local || current === "vm";
  // a bot set to use this Mac asks for the Mac's permissions it lacks when the person starts its browser, never before
  const askFirst = local && current === "local" ? macPermissionsBridge() : null;

  return (
    <div data-panel-tabpanel="computer">
      {!ownScreen ? <LocalBrowserSection bot={bot} askFirst={askFirst} after={cloudOffer} /> : <>
        <div ref={setScreenBox}>
          <Suspense fallback={<AsleepScreen bot={bot} off={current === "off"} />}>
            <ComputerPanel bot={bot} inline visible={onScreen} onReport={setReport} />
          </Suspense>
        </div>
        <div className="mt-[5px] flex min-h-6 items-center justify-center">
          <span data-panel-screen-of="" className="min-w-0 truncate text-[12px] leading-4 tracking-normal text-ink/[0.56]">{screenOf}</span>
        </div>
        {detail && <Card><NoteRow data-sheet-row="problem-detail">{detail}</NoteRow></Card>}
        {toCloud && <CloudDesktopCta bots={cloudBots} stage={stage} label={cloudLabel} />}
        {cloudOffer}
      </>}
      {cloudDesktop && stage === "manage" && <Card><CloudDesktopListRow cloudDesktop={cloudDesktop} /></Card>}
      {warning}
    </div>
  );
}
