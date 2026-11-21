import { useComputerAnalytics } from "@/lib/product-analytics-app";
import { trailHeaders } from "@/lib/trail";
import { computerCapableEngine, cloudEngineOf } from "@/lib/remote-desktop";
import { canWorkOnCloud } from "../../shared/cloud-computer";
import { viewerTargetId } from "../../shared/desktop-viewer";
import { Switch } from "./SettingsPrimitives";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveDesktop } from "./live-desktop-module";
import { lastScreen, rememberScreen, SteadyImage } from "./bot-panel/last-screen";
import { phoneApp } from "@/lib/store-app";
import { z } from "zod";
import { waitForLocalVmReady } from "@/lib/local-vm-readiness";
import { Globe, Hand, Loader2, Maximize2, Monitor, Moon, Power, X } from "../icons";
import { api, ApiError, currentTaskBot, useStore, type Bot, type ConfigStatus } from "@/state/store";
import { ComputerFullscreen, ComputerFullscreenNote, fullscreenActionCls, type ScreenControl } from "./ComputerFullscreen";
import { MausAvatar } from "./Avatar";
import { AsleepMascot, COMPUTER_FRAME_CLASS, COMPUTER_SCREEN_ASPECT, COMPUTER_WAKE_BUTTON_CLASS, ComputerWaking } from "./bot-panel/ComputerScreenMascot";
import { takeQueuedComputerWake } from "./bot-panel/computer-wake-queue";
import { startComputerWake, useComputerWake } from "./bot-panel/computer-wake";
import { effectivePlace, isComputerPlace, personPin, placeLabelKey, placeOffered } from "@/lib/place";
import type { CloudBackend } from "../../shared/wire";

import { cn } from "@/lib/cn";
import { useCaptionChrome } from "@/components/DesktopCapabilities";
import { usePageVisible } from "@/lib/page-visible";
import { listenLiveFrames } from "@/lib/live-events";
import { CloudScreenPreview } from "./CloudScreenPreview";
import { isRemoteScreenshotContention } from "@/lib/remote-desktop";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { BotRoutines } from "./routines/BotRoutines";
import { BrowserPanel } from "./BrowserPanel";
import { usePanelPage, type PanelPage } from "@/lib/page-open";
import { browserAvailable, browserUnavailableReason, builtInBrowserEnabled } from "@/lib/feature-flags";
import { parseComputerHelp, transitionComputerControlLease, type ComputerControlAction } from "@/lib/computer-control";
import { useComputerTakeover } from "./computer-takeover";
import { SignInBanner } from "./SignInRequestCard";
import { LocalScreenPreview } from "./LocalScreenPreview";
import { LinuxLocalControl } from "./LinuxLocalControl";
import { MacLocalControl } from "./MacLocalControl"; import { WindowsLocalControl } from "./WindowsLocalControl";
import {
  instanceSupportsLocalComputer,
  localComputerDisabledReason,
  localComputerSelectable,
  persistedComputerSelectionMatches,
  shouldPollCloudPreview,
} from "@/lib/local-computer";
import { moveBetweenTabs, PANEL_TABS, panelTabProps, scrollTabsWithWheel, TAB_PANEL_FOCUS, tabPanelProps } from "./computer-panel-tabs";
import { releaseComputerPanelFocus, useComputerPanelEntry } from "@/lib/computer-panel-focus";
import { PANEL_MAX_WIDTH, PANEL_MIN_WIDTH, useComputerPanelResize } from "./computer-panel-resize";
import {
  computerPanelTabs,
  readComputerPanelView,
  resolveComputerPanelView,
  writeComputerPanelView,
  type ComputerPanelView,
} from "@/lib/computer-panel-view";
import { lowerFirst } from "@/lib/lower-first";
import { openPlaceAction, placeBlocked, placeFacts, placeViewFor, usePlaceSeat, worksOnSimpleLabel } from "@/lib/place-view";
import { type PlaceActionId, type PlaceFacts, type PlaceView } from "../../shared/place-view";
import { t } from "@/lib/i18n";
import { LocalizedPanelError, panelErrorText } from "@/lib/computer-messages";
import { computerProblem, type ComputerFix } from "@/lib/computer-problem";
import type { LocaleKey } from "@/locales";
import { LiveScreenVideo } from "./bot-panel/LiveScreenVideo";
import { smallButtonCls } from "./ui/GrokDialog";
import { LIVE_FPS, useLiveScreen } from "./bot-panel/local-screen-stream";
import { friendlyError } from "@/lib/plain-error";

interface VpsComputerStatus {
  configured: boolean;
  daemonUp?: boolean;
  desktop?: "cua" | "bot-desktop";
  imageMatches: boolean;
  managed: boolean;
  container: "running" | "stopped" | "missing";
  ready: boolean;
  problem: string | null;
  resourceKey?: string;
  viewerKey?: string;
  state?: "starting" | "ready" | "stopped";
  teamComputer?: { id: string; name: string; section?: string; scope?: "workspace" };
  /** an older desktop: it runs as it is until its update is ready, then updates itself in the background */
  outdated?: boolean;
  updating?: boolean;
}

type Phase =
  | "checking"
  | "starting"
  | "ready"
  | "vm"
  | "vm-unavailable"
  | "vps-unconfigured"
  | "vps-incompatible"
  | "vps-stopped"
  | "local"
  | "local-unavailable"
  | "auto-unavailable"
  | "browser"
  | "off"
  | "error";

interface LocalVmStatus {
  resumable?: boolean;
  stop_reason?: "idle" | null;
  mode: "shared" | "per-bot" | "pool";
  max_instances: number;
  image: boolean;
  create_supported: boolean;
  container: "running" | "stopped" | "missing";
  imageMatches: boolean;
  managed: boolean;
  network: "loopback" | "unsafe" | "unknown";
  security: "hardened" | "unsafe" | "unknown";
  persistence: "durable" | "unsafe" | "unknown";
  desktopReady: boolean;
  ready: boolean;
  problem: string | null;
  viewer_url: string;
  target_key: string;
}

const FULLSCREEN_MARK = "rgb(255 255 255 / 0.88)";
/** Readiness checks while a cloud computer starts: twenty quick ones, then every two seconds, about half a minute. */
const STARTING_POLLS = 33;
const LIVE_RETRY_MS = [1500, 4000, 10_000, 30_000];

const computerControlSnapshotSchema = z.object({
  held: z.boolean().optional().default(false),
  helpReason: z.string().nullable().optional().default(null),
  help: z.unknown().optional().transform(parseComputerHelp),
  owned: z.boolean().optional(),
}).passthrough();

export function ComputerPanel({
  bot: profileBot,
  fullscreen,
  inline = false,
  visible = true,
  onReport,
}: {
  bot: Bot;
  inline?: boolean;
  visible?: boolean;
  /** Inline: the screen's stage and the server's own words for a problem, for the tab's status and its Advanced. */
  onReport?: (report: InlineReport) => void;
  /** Grok's full view of the screen over the whole window, opened from the bot panel; `wake` wakes a sleeping desktop. */
  fullscreen?: { wake: boolean; onExit: () => void };
}) {
  useComputerAnalytics(profileBot.id, visible);
  const { dragProps } = useCaptionChrome();
  const { panelWidth, separatorRef, separatorWidth, onSeparatorKeyDown, onResizeStart, onResizeMove, onResizeEnd } = useComputerPanelResize();
  const { state, dispatch, flushBotPatches } = useStore();
  const liveTask = profileBot.tasks?.find((task) => task.threadId === profileBot.threadId);
  const livePin = personPin(liveTask);
  // a place Auto picked for an earlier turn is not a pin: the panel still shows what Auto would use now
  const livePlace = effectivePlace(profileBot, livePin ? liveTask : null);
  const threadBot = currentTaskBot(profileBot);
  const connectionKey = `${profileBot.id}:${profileBot.threadId}:${livePlace}:vps:${threadBot.modelSelection.instanceId}:${profileBot.vpsAlias ?? ""}:${profileBot.section ?? ""}:${state.config?.vps?.sshAlias ?? ""}:${state.config?.vps?.mode ?? "shared"}:${state.config?.vps?.independentScreens ?? true}`;
  const [autoSurface, setAutoSurface] = useState<{ key: string; surface: Bot["computer"]; revision: number; status?: VpsComputerStatus } | null>(null);
  const autoSurfaceCurrent = autoSurface?.key === connectionKey;
  const surfaceReady = livePlace !== "auto" || autoSurfaceCurrent;
  const bot = { ...threadBot, computer: livePlace === "auto"
    ? autoSurfaceCurrent ? autoSurface.surface : undefined : livePlace };
  const placeLive = Boolean(bot.busy);
  const threadPath = useCallback((suffix: string) =>
    `/api/bots/${profileBot.id}/${suffix}?threadId=${encodeURIComponent(profileBot.threadId)}`,
  [profileBot.id, profileBot.threadId]);
  const { capabilities, ready: capabilitiesReady } = useDesktopCapabilities();
  const localAvailable = capabilities.localComputer.available;
  const isLinux = capabilities.host.platform === "linux";
  const providerSupportsLocal = instanceSupportsLocalComputer(state.instances, bot);
  const localSelectable = placeOffered("local", state.config) && localComputerSelectable({ capabilities, providerSupportsLocal });
  const localDisabledReason = localComputerDisabledReason({ capabilities, providerSupportsLocal });
  const placeSeat = usePlaceSeat(state.config, capabilities.host.platform);
  const canManageCloud = placeSeat.role === "admin" && (livePlace === "cloud" || livePlace === "auto");
  const canManageVm = placeSeat.role === "admin" && profileBot.computer === "vm" && livePlace === "vm";
  const [phase, setPhase] = useState<Phase>("checking");
  const [persistedComputerSelection, setPersistedComputerSelection] = useState<{
    botId: string;
    computer: Bot["computer"];
    cloudBackend: CloudBackend;
    section: string;
  } | null>(null);
  const [resolvedComputerSelection, setResolvedComputerSelection] = useState<{
    botId: string;
    threadId: string;
    computer: Bot["computer"];
    cloudBackend: CloudBackend;
  } | null>(null);
  const [teamComputer, setTeamComputer] = useState<{
    id: string; name: string; botId: string; section: string;
  } | null>(null);
  const cloudBackend: CloudBackend = "vps";
  const computerSelectionPersisted = Boolean(
    persistedComputerSelection
      && persistedComputerSelection.botId === bot.id
      && persistedComputerSelection.computer === profileBot.computer
      && persistedComputerSelection.cloudBackend === cloudBackend
      && persistedComputerSelection.section === (bot.section?.trim() ?? ""),
  );
  const computerStatusCurrent = Boolean(
    resolvedComputerSelection
      && resolvedComputerSelection.botId === bot.id
      && resolvedComputerSelection.threadId === bot.threadId
      && resolvedComputerSelection.computer === bot.computer
      && resolvedComputerSelection.cloudBackend === cloudBackend,
  );
  const currentTeamComputer = computerStatusCurrent && livePlace === "auto"
    && teamComputer?.botId === bot.id && teamComputer.section === (bot.section?.trim() ?? "")
    ? teamComputer : null;
  const cloudPreviewReady = computerStatusCurrent && shouldPollCloudPreview({
    computer: bot.computer,
    cloudBackend,
    phase,
    botId: bot.id,
    resolvedBotId: resolvedComputerSelection?.botId ?? null,
    resolvedComputer: resolvedComputerSelection?.computer ?? null,
    resolvedCloudBackend: resolvedComputerSelection?.cloudBackend ?? null,
  });
  const updateComputerSelection = useCallback((patch: {
    computer?: Bot["computer"] | null;
    cloudBackend?: CloudBackend;
    browser?: boolean;
    acknowledgeLocalAuto?: boolean;
  }) => {
    // Clear in the same render as the optimistic profile change; the resolving effect waits for its PATCH.
    setResolvedComputerSelection(null);
    setTeamComputer(null);
    setPhase("checking");
    dispatch({ type: "updateBot", botId: bot.id, patch });
  }, [bot.id, dispatch]);
  useEffect(() => {
    let alive = true;
    setPersistedComputerSelection(null);
    void flushBotPatches(bot.id).then((persistedBot) => {
      if (!alive) return;
      if (persistedBot && !persistedComputerSelectionMatches({
        computer: profileBot.computer,
        cloudBackend,
        persistedBot,
      })) return;
      if (persistedBot && (persistedBot.section?.trim() ?? "") !== (bot.section?.trim() ?? "")) return;
      setPersistedComputerSelection({
        botId: bot.id,
        computer: profileBot.computer,
        cloudBackend,
        section: bot.section?.trim() ?? "",
      });
    });
    return () => {
      alive = false;
    };
  }, [bot.id, profileBot.computer, bot.section, cloudBackend, flushBotPatches]);
  const [containerState, setContainerState] = useState<string | null>(null);
  const [polledFrame, setPolledFrame] = useState<{ png: string; mime: string } | null>(null);
  const [previewError, setPreviewError] = useState<Error | string | null>(null);
  const [previewRefreshing, setPreviewRefreshing] = useState(false);
  const [previewRetry, setPreviewRetry] = useState(0);
  const [vmFrame, setVmFrame] = useState<string | null>(null);
  const [vmStatus, setVmStatus] = useState<LocalVmStatus | null>(null);
  const [vpsStatus, setVpsStatus] = useState<VpsComputerStatus | null>(null);
  const viewerConnectionKey = `${bot.id}:${bot.threadId}:${bot.computer}:vps:${vpsStatus?.resourceKey ?? ""}:${vpsStatus?.viewerKey ?? ""}`;
  const [localFrame, setLocalFrame] = useState<string | null>(null);
  const [pending, setPending] = useState<
    "join" | "sleep" | "provision" | "replace" | "vm-start" | "vm-create" | "vm-recreate" | null
  >(null);
  const [controlPending, setControlPending] = useState(false);
  // the person woke this computer: its picture is asked for beside the wake, keyed to the conversation it began in
  const [wakeViewer, setWakeViewer] = useState<string | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [error, setError] = useState<Error | string | null>(null);
  const errorText = panelErrorText(error);
  // the card wakes from its first frame: a click before the status (or this code) arrived waits here for it
  const wakeKey = `${profileBot.id}:${profileBot.threadId}`;
  const [queuedWake, setQueuedWake] = useState<string | null>(() => inline && takeQueuedComputerWake(profileBot.id) ? wakeKey : null);
  const [storedPanelView, setPanelView] = useState<ComputerPanelView>(() => readComputerPanelView(bot.id));
  const tabsContext = { browser: storedPanelView === "browser" || profileBot.computer === "browser" };
  const panelTabs = computerPanelTabs(tabsContext);
  const panelView = fullscreen || inline ? "computer" : resolveComputerPanelView(storedPanelView, tabsContext);
  const panelRef = useComputerPanelEntry(profileBot.id, panelView);
  const browserAvailableHere = browserAvailable(state.config);
  const browserEnabled = builtInBrowserEnabled(state.config) && bot.browser !== false
    && (browserAvailableHere || state.config?.browserEngine?.installable === true);
  const [retry, setRetry] = useState(0);
  const [livePreviewFailed, setLivePreviewFailed] = useState<string | null>(null);
  const [decodedDesktop, setDecodedDesktop] = useState<{ key: string; ready: boolean } | null>(null);
  const [screenAspect, setScreenAspect] = useState(COMPUTER_SCREEN_ASPECT);
  const desktopDecoded = decodedDesktop?.key === viewerConnectionKey && decodedDesktop.ready;
  // a dropped live watch comes back by itself, sooner after a blip and less often while it stays down
  const liveRetries = useRef(0);
  useEffect(() => { if (desktopDecoded) liveRetries.current = 0; }, [desktopDecoded]);
  useEffect(() => {
    if (livePreviewFailed === null || livePreviewFailed !== viewerConnectionKey) return;
    const wait = LIVE_RETRY_MS[Math.min(liveRetries.current, LIVE_RETRY_MS.length - 1)];
    liveRetries.current += 1;
    const timer = setTimeout(() => setLivePreviewFailed(null), wait);
    return () => clearTimeout(timer);
  }, [livePreviewFailed, viewerConnectionKey]);
  const lastStatusTarget = useRef<string | null>(null);
  const vpsReadinessAttempts = useRef(0);
  const computerAction = useRef<AbortController | null>(null);
  useEffect(() => () => computerAction.current?.abort(), [connectionKey, profileBot.vpsAlias, profileBot.section]);
  // Auto is the server's decision: never guess host-vs-cloud from desktop capabilities.
  useEffect(() => {
    if (livePlace !== "auto" || !computerSelectionPersisted) return;
    const controller = new AbortController();
    void api(threadPath("computer"), { signal: controller.signal }).then((status) => {
      if (controller.signal.aborted) return;
      const surface = status.surface;
      setAutoSurface({ key: connectionKey, revision: retry, surface:
        surface === "cloud" || surface === "vm" || surface === "local" || surface === "browser" || surface === "off"
          ? surface : undefined, ...(surface === "cloud" && typeof status.ready === "boolean" ? { status } : {}) });
    }).catch((cause) => {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? cause : String(cause));
      setPhase("error");
    });
    return () => controller.abort();
  }, [connectionKey, livePlace, computerSelectionPersisted, threadPath, retry]);
  const vmResumable = phase === "vm-unavailable" && vmStatus?.resumable === true;
  const vmReadinessAttempts = useRef(0);
  const vmActionController = useRef<AbortController | null>(null);
  useEffect(() => {
    if (vmActionController.current?.signal.aborted) {
      vmActionController.current = null;
      setPending(null);
    }
    return () => { vmActionController.current?.abort(); };
  }, [bot.id, bot.threadId, bot.computer, panelView]);
  const selectedInstance = state.instances.find(
    (instance) => instance.instanceId === bot.modelSelection.instanceId,
  );
  const explicitPanelView = useRef(false);
  const selectPanelView = (view: ComputerPanelView) => {
    explicitPanelView.current = true;
    setPanelView(view);
    writeComputerPanelView(bot.id, view);
  };

  const previousPanelTarget = useRef<string | null>(null);
  // Excludes the model and Auto's resolved surface: neither may move the tab.
  const panelTargetKey = `${profileBot.id}:${profileBot.threadId}:${livePlace}:vps`;
  useEffect(() => {
    const previous = previousPanelTarget.current;
    if (previous === panelTargetKey && (explicitPanelView.current || !(bot.computer === "browser" && browserEnabled))) return;
    if (previous !== panelTargetKey) explicitPanelView.current = false;
    previousPanelTarget.current = panelTargetKey;
    setPanelView(bot.computer === "browser" && browserEnabled ? "browser"
      : previous === null ? readComputerPanelView(bot.id) : "computer");
  }, [panelTargetKey, bot.id, bot.computer, browserEnabled]);

  const requestedSignIn = state.signInFocus?.botId === bot.id ? state.signInFocus : undefined;
  const [signInRequest, setSignInRequest] = useState<{ url: string; site: string; nonce: number }>();
  // A published page's Open (usePageOpener): this bot's browser shows, with the page in a new tab.
  const [pageRequest, setPageRequest] = useState<PanelPage>();
  usePanelPage(fullscreen ? "" : bot.id, (page) => { selectPanelView("browser"); setPageRequest(page); });
  useEffect(() => {
    if (fullscreen || !requestedSignIn || requestedSignIn.consumed) return;
    const view = requestedSignIn.place === "browser" ? "browser" : "computer";
    explicitPanelView.current = true;
    setPanelView(view);
    writeComputerPanelView(bot.id, view);
    if (view === "browser") setSignInRequest({ url: requestedSignIn.url, site: requestedSignIn.site, nonce: requestedSignIn.requestId });
    dispatch({ type: "signInFocusConsumed", requestId: requestedSignIn.requestId });
  }, [bot.id, dispatch, requestedSignIn, fullscreen]);

  useEffect(() => {
    let alive = true;
    const dv = window.madaniDesktop?.desktopViewer;
    if (dv?.currentState) {
      void dv
        .currentState()
        .then((s) => {
          if (alive) setViewerOpen(s.open && s.contextId === bot.id);
        })
        .catch(() => {});
    }
    const off = dv?.onState((viewer) => {
      if (viewer.contextId === bot.id) setViewerOpen(viewer.open);
    });
    return () => {
      alive = false;
      off?.();
    };
  }, [bot.id]);

  useEffect(() => {
    vmReadinessAttempts.current = 0;
  }, [bot.id, bot.computer]);
  const vmSupported = Boolean(
    selectedInstance?.snapshot.state === "available" &&
      selectedInstance.capabilities?.computerMcp,
  );
  const cloudSupported = canWorkOnCloud(cloudEngineOf(selectedInstance));
  const cloudRoutineReady = Boolean(
    state.config?.vps?.configured &&
      computerCapableEngine(state.instances, bot.modelSelection.instanceId)?.snapshot.state === "available",
  );
  useEffect(() => {
    if (panelView !== "computer") return;
    let alive = true;
    const target = `${connectionKey}:${bot.vpsAlias ?? ""}:${bot.section ?? ""}:${state.config?.vps?.sshAlias ?? ""}`;
    if (lastStatusTarget.current !== target) {
      lastStatusTarget.current = target;
      vpsReadinessAttempts.current = 0;
      setResolvedComputerSelection(null);
      setTeamComputer(null);
      setPhase("checking");
      setPolledFrame(null);
      setPreviewError(null);
      setVmFrame(null);
      setVmStatus(null);
      setVpsStatus(null);
      setLocalFrame(null);
      setError(null);
    }
    // The selection may be optimistic: never let it choose a provider until the PATCH confirms server state.
    if (!computerSelectionPersisted || !surfaceReady) return;
    if (livePlace === "auto" && autoSurfaceCurrent && autoSurface.revision !== retry) return;
    if (bot.computer === undefined) {
      setPhase("auto-unavailable");
      return;
    }

    if (bot.computer === "off") {
      setPhase("off");
      return;
    }
    if (bot.computer === "browser") {
      setPhase("browser");
      return;
    }
    if (bot.computer === "local") {
      if (!providerSupportsLocal) {
        setError(new LocalizedPanelError("computer.err.localEngine"));
      }
      setPhase(capabilitiesReady && localAvailable && providerSupportsLocal ? "local" : "local-unavailable");
      setResolvedComputerSelection({ botId: bot.id, threadId: bot.threadId, computer: bot.computer, cloudBackend });
      return;
    }
    if (!selectedInstance && !state.hydrated) { setPhase("checking"); return; }
    if (bot.computer === "vm") {
      if (!vmSupported) {
        setError(new LocalizedPanelError("computer.err.vmEngine"));
        setPhase("vm-unavailable");
        return;
      }
      let retryTimer: number | undefined;
      api(threadPath("local-computer"))
        .then((rawStatus) => {
          if (!alive) return;
          const status: LocalVmStatus = rawStatus;
          setResolvedComputerSelection({ botId: bot.id, threadId: bot.threadId, computer: bot.computer, cloudBackend });
          setVmStatus(status);
          if (status.ready) {
            vmReadinessAttempts.current = 0;
            setPhase("vm");
          } else if (
            status.container === "running" &&
            status.imageMatches &&
            status.managed &&
            status.network === "loopback" &&
            status.security === "hardened" &&
            status.persistence === "durable" &&
            !status.desktopReady &&
            vmReadinessAttempts.current < 15
          ) {
            vmReadinessAttempts.current += 1;
            setError(null);
            setPhase("checking");
            retryTimer = window.setTimeout(() => setRetry((n) => n + 1), 2000);
          }
          else {
            const canCreateHere =
              status.mode === "per-bot" &&
              status.container === "missing" &&
              status.image &&
              status.create_supported;
            setError(canCreateHere || status.resumable ? null : new LocalizedPanelError(
              "computer.err.vmOpenSettings", status.problem, "computer.err.vmNotReady",
            ));
            setPhase("vm-unavailable");
          }
        })
        .catch((e) => {
          if (!alive) return;
          setError(e.message);
          setPhase("vm-unavailable");
        });
      return () => {
        alive = false;
        if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      };
    }
    if (bot.computer === "cloud" && !cloudSupported) {
      setPhase("error");
      return;
    }
    if (bot.computer !== "cloud" && !capabilitiesReady) return;
    let readinessTimer: number | undefined;
    const status = livePlace === "auto" && autoSurfaceCurrent && autoSurface.status
      ? Promise.resolve(autoSurface.status) : api(threadPath("computer"));
    status.then((rawStatus) => {
        if (!alive) return;
        const status: VpsComputerStatus = rawStatus;
        setVpsStatus(status);
        setTeamComputer(status.teamComputer ? { ...status.teamComputer, botId: bot.id, section: bot.section?.trim() ?? "" } : null);
        setResolvedComputerSelection({
          botId: bot.id,
          threadId: bot.threadId,
          computer: bot.computer,
          cloudBackend,
        });
        if (!status.configured) {
          setError(null);
          setPhase("vps-unconfigured");
          return;
        }
        if (status.ready) {
          vpsReadinessAttempts.current = 0;
          setContainerState(status.container ?? null);
          setError(null);
          setPhase("ready");
          return;
        }
        // an older computer updates itself in the background; until then it wakes and runs as it is
        if (status.updating) {
          setError(null);
          setPhase("starting");
          readinessTimer = window.setTimeout(() => setRetry(value => value + 1), 3000);
          return;
        }
        if (status.outdated && status.container !== "running") {
          setContainerState("stopped");
          setError(null);
          setPhase("vps-stopped");
          return;
        }
        if (status.managed && status.container !== "missing" && !status.imageMatches && !status.outdated) {
          setError(status.problem);
          setPhase("vps-incompatible");
          return;
        }
        if (computerAction.current) return;
        if (status.state === "stopped") {
          vpsReadinessAttempts.current = 0;
          setContainerState(status.container ?? null);
          setError(null);
          setPhase("vps-stopped");
          return;
        }
        if ((status.state === "starting" || (status.container === "running" && status.managed && (status.imageMatches || status.outdated))) && vpsReadinessAttempts.current < STARTING_POLLS) {
          vpsReadinessAttempts.current++;
          setError(null);
          setPhase("starting");
          // computer-state frames usually say ready first; this only covers a missed one, briefly at first
          readinessTimer = window.setTimeout(() => setRetry(value => value + 1), vpsReadinessAttempts.current <= 20 ? 250 : 2000);
          return;
        }
        setContainerState(status.container ?? null);
        // no computer yet, or one asleep: Wake makes or starts it, so the card says nothing more
        const wakeable = status.daemonUp && (status.container === "missing" || status.container === "stopped");
        setError(wakeable ? null : new LocalizedPanelError("computer.err.vpsProblem", status.problem, "computer.err.vpsNoContainer"));
        setPhase(status.container === "stopped" ? "vps-stopped" : "vps-unconfigured");
      })
      .catch((e) => {
        if (!alive) return;
        setError(e.message);
        setPhase("error");
      });
    return () => {
      alive = false;
      if (readinessTimer !== undefined) window.clearTimeout(readinessTimer);
    };
  }, [
    bot.id,
    bot.threadId,
    bot.computer,
    bot.section,
    bot.autoStartVps, bot.vpsAlias,
    cloudBackend,
    retry,
    capabilitiesReady,
    localSelectable,
    isLinux,
    providerSupportsLocal,
    selectedInstance?.driverKind,
    state.hydrated,
    vmSupported,
    cloudSupported,
    state.config?.vps?.sshAlias,
    panelView,
    computerSelectionPersisted,
    surfaceReady,
    canManageCloud,
    livePlace,
    threadPath,
    connectionKey,
    autoSurfaceCurrent,
    autoSurface,
  ]);

  useEffect(() => listenLiveFrames({
    onFrame: (frame) => {
      if (frame.kind === "computer" && frame.botId === profileBot.id) setRetry(value => value + 1);
      if (frame.kind === "computer-state" && frame.botId === profileBot.id) {
        setRetry(value => value + 1);
        if (vpsStatus?.resourceKey && frame.resourceKey !== vpsStatus.resourceKey) return;
        if (frame.state === "starting") setPhase("starting");
        if (frame.state === "stopped") { setPhase("vps-stopped"); setDecodedDesktop(null); }
        if (frame.state === "failed") { setPhase("error"); setError(frame.problem ?? null); }
      }
    },
    onMissedFrames: () => setRetry(value => value + 1),
  }), [profileBot.id, vpsStatus?.resourceKey]);

  const control = state.computerControl[bot.id] ?? { held: false, helpReason: null };
  const requestControl = useCallback(async (action: ComputerControlAction, controlLeaseId?: string, cid?: string) => {
    const snap = computerControlSnapshotSchema.parse(await api(`/api/bots/${bot.id}/computer/control`, {
      method: "POST",
      headers: { "content-type": "application/json", ...trailHeaders(cid) },
      body: JSON.stringify({ action, ...(controlLeaseId ? { controlLeaseId } : {}) }),
    }));
    dispatch({
      type: "computerControl",
      botId: bot.id,
      held: snap.held === true,
      helpReason: snap.helpReason,
      help: snap.help,
    });
    return snap;
  }, [bot.id, dispatch]);
  const wakingHere = wakeViewer === viewerConnectionKey && pending === "provision" && bot.computer === "cloud" && !vpsStatus?.teamComputer;
  const liveTarget = !computerStatusCurrent ? null
    : phase === "vm" && vmStatus?.viewer_url && vmStatus.target_key ? viewerTargetId({ key: vmStatus.target_key })
      : cloudPreviewReady || wakingHere ? `vps/${bot.id}` : null;
  const windowVisible = usePageVisible();
  const pageVisible = windowVisible && visible;
  // the viewer's code is fetched while the computer sleeps, so waking it never waits on a download; without it (a
  // failed download) the screen is shown in pictures instead
  const viewerCode = useLiveDesktop(Boolean(liveTarget) || bot.computer === "cloud" || bot.computer === "vm");
  const viewerLoads = viewerCode.kind !== "failed";
  const livePreview = Boolean(liveTarget) && viewerLoads && livePreviewFailed !== viewerConnectionKey && pageVisible;
  const takeover = useComputerTakeover({
    botId: bot.id, session: `${viewerConnectionKey}:${panelView}`, held: control.held, request: requestControl,
    viewerClose: null,
  });
  const liveHere = takeover.here && Boolean(liveTarget) && viewerLoads;

  const liveLocal = useLiveScreen((Boolean(fullscreen) || inline) && phase === "local" && !isLinux && computerStatusCurrent && pageVisible, inline && !takeover.expanded ? LIVE_FPS.preview : LIVE_FPS.full);
  const localStreaming = (Boolean(fullscreen) || inline) && (liveLocal.status === "live" || liveLocal.status === "starting");
  const lastLiveAt = useRef(0);
  const previewBusy = useRef(bot.busy);
  useEffect(() => { previewBusy.current = bot.busy; }, [bot.busy]);
  useEffect(() => {
    lastLiveAt.current = 0;
    if (!cloudPreviewReady) return;
    return listenLiveFrames({ screens: true,
      onFrame: (frame) => {
        if (frame.kind !== "screen" || frame.botId !== bot.id || frame.threadId !== bot.threadId) return;
        lastLiveAt.current = Date.now();
        setPolledFrame({ png: frame.png, mime: frame.mime ?? "image/png" });
        setPreviewError(null);
        setPreviewRefreshing(false);
      },
    });
  }, [cloudPreviewReady, bot.id, bot.threadId]);

  useEffect(() => {
    if (panelView !== "computer" || !cloudPreviewReady || viewerOpen || liveHere || livePreview || !pageVisible || pending || controlPending) return;
    let inFlight = false;
    let lastAttemptAt = -Infinity;
    let retryDelay: number | null = null;
    let contentionSince: number | null = null;
    const controller = new AbortController();
    setPreviewError(null);
    setPreviewRefreshing(true);
    const shoot = async () => {
      if (inFlight || controller.signal.aborted) return;
      if (Date.now() - lastAttemptAt < (retryDelay ?? (previewBusy.current ? 4000 : 30_000))) return;
      if (previewBusy.current && Date.now() - lastLiveAt.current < 10_000) return;
      inFlight = true;
      retryDelay = null;
      const startedAt = Date.now();
      try {
        const { png, format } = await api(threadPath("computer/screenshot"), {
          method: "POST",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]),
        });
        if (!controller.signal.aborted && lastLiveAt.current <= startedAt) {
          if (typeof png !== "string" || !png.trim()) throw new LocalizedPanelError("computer.err.emptyFrame");
          setPolledFrame({ png, mime: format === "jpeg" ? "image/jpeg" : "image/png" });
          setPreviewError(null);
          setPreviewRefreshing(false);
          contentionSince = null;
        }
      } catch (e) {
        if (!controller.signal.aborted && lastLiveAt.current <= startedAt) {
          if (e instanceof ApiError && isRemoteScreenshotContention(e)) {
            retryDelay = 1000;
            contentionSince ??= Date.now();
            const prolonged = Date.now() - contentionSince >= 10_000;
            setPreviewError(prolonged ? e : null);
            setPreviewRefreshing(!prolonged);
          } else {
            contentionSince = null;
            setPreviewRefreshing(false);
            setPreviewError(e instanceof Error && e.name === "TimeoutError"
              ? new LocalizedPanelError("computer.err.frameTimeout")
              : e instanceof Error ? e : new LocalizedPanelError("computer.err.screenUnavailable"));
          }
        }
      } finally {
        inFlight = false;
        lastAttemptAt = Date.now();
      }
    };
    void shoot();
    const timer = setInterval(shoot, 1000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [panelView, cloudPreviewReady, threadPath, cloudBackend, viewerOpen, liveHere, livePreview, pageVisible, pending, controlPending, previewRetry]);

  useEffect(() => {
    if (panelView !== "computer" || phase !== "vm" || !computerStatusCurrent || viewerOpen || liveHere || livePreview || !pageVisible) return;
    const controller = new AbortController();
    let inFlight = false;
    let lastAttemptAt = -Infinity;
    let retryDelay: number | null = null;
    let initialAttempt = true;
    const shoot = async () => {
      if (inFlight || controller.signal.aborted) return;
      if (Date.now() - lastAttemptAt < (retryDelay ?? (bot.busy ? 3000 : 30_000))) return;
      inFlight = true;
      retryDelay = null;
      try {
        const { image } = await api(threadPath("local-computer/screenshot"), { method: "POST", signal: controller.signal });
        if (!controller.signal.aborted && typeof image === "string") {
          setVmFrame(image);
          setPreviewError(null);
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          retryDelay = 5000;
          if (initialAttempt) setError(friendlyError(e));
          else setPreviewError(e instanceof Error ? e : new LocalizedPanelError("computer.err.screenUnavailable"));
        }
      } finally {
        inFlight = false;
        initialAttempt = false;
        lastAttemptAt = Date.now();
      }
    };
    void shoot();
    const timer = window.setInterval(() => void shoot(), bot.busy ? 3000 : 30_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [panelView, phase, computerStatusCurrent, threadPath, viewerOpen, liveHere, livePreview, pageVisible, bot.busy, setError, setPreviewError, setVmFrame]);

  // The first capture attempt is what makes macOS show the Screen Recording prompt (no reliable pre-grant on macOS
  // 15+), so repeated empty frames mean denied.
  const [localMisses, setLocalMisses] = useState(0);
  useEffect(() => {
    if (panelView !== "computer" || phase !== "local" || !computerStatusCurrent || !window.madaniDesktop || isLinux || !pageVisible || localStreaming) return;
    let alive = true;
    setLocalMisses(0);
    const shoot = async () => {
      try {
        const url = await window.madaniDesktop!.screenFrame();
        if (alive && url) setLocalFrame(url);
        else if (alive) setLocalMisses((n) => n + 1);
      } catch {
        if (alive) setLocalMisses((n) => n + 1);
      }
    };
    void shoot();
    const timer = setInterval(shoot, fullscreen ? 1000 : bot.busy ? 3000 : 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [panelView, phase, computerStatusCurrent, isLinux, pageVisible, bot.busy, bot.id, bot.threadId, localStreaming, fullscreen]);

  const frameSrc = !computerStatusCurrent ? null :
    phase === "vm"
      ? vmFrame
      : phase === "local" && !isLinux
      ? localFrame
      : cloudPreviewReady || (bot.computer === "cloud" && phase === "starting")
        ? polledFrame && `data:${polledFrame.mime};base64,${polledFrame.png}`
        : null;
  const previewOpensDesktop = Boolean(frameSrc && (liveTarget || cloudPreviewReady));
  // the phone shows an awake computer's last picture while its view comes back, and each new one only once it is decoded
  const phone = phoneApp();
  useEffect(() => { if (phone) rememberScreen(bot.id, bot.threadId, frameSrc); }, [phone, bot.id, bot.threadId, frameSrc]);
  const picture = frameSrc ?? (phone && computerStatusCurrent && (cloudPreviewReady || phase === "vm") ? lastScreen(bot.id, bot.threadId) : null);

  const signInHelp = control.help ?? null;
  const signInAsker = signInHelp ? state.bots.find((candidate) => candidate.id === signInHelp.botId)?.name ?? bot.name : bot.name;
  useEffect(() => {
    let alive = true;
    api(`/api/bots/${bot.id}/computer/control`)
      .then((raw) => {
        if (!alive) return;
        const snap = computerControlSnapshotSchema.parse(raw);
        dispatch({
          type: "computerControl",
          botId: bot.id,
          held: snap.held === true,
          helpReason: snap.helpReason,
          help: snap.help,
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id]);

  const setNativeBrowserControl = useCallback(async (): Promise<boolean> => true, []);

  const transitionControl = useCallback(async (action: ComputerControlAction) => {
    // Security: every computer surface must gate Electron's direct browser host; the server hold is bot-wide, and a
    // shell-capable agent could otherwise bypass the server proxy while the person drives.
    return transitionComputerControlLease({
      action,
      syncNativeBrowser: panelView !== "browser",
      requestControl,
      setNativeBrowserControl,
    });
  }, [panelView, requestControl, setNativeBrowserControl]);

  const controlAction = useCallback(async (action: ComputerControlAction): Promise<boolean> => {
    setControlPending(true);
    setError(null);
    try {
      await transitionControl(action);
      return true;
    } catch (cause) {
      setError(friendlyError(cause));
      return false;
    } finally {
      setControlPending(false);
    }
  }, [transitionControl]);

  const bannerTakesControl = Boolean(signInHelp && signInHelp.place !== "browser" && signInHelp.place !== "local" &&
    (cloudPreviewReady || phase === "vm" || currentTeamComputer));
  const signInBanner = (take?: () => void) => signInHelp && (
    <SignInBanner
      help={signInHelp}
      askerName={signInAsker}
      takeControl={take && { onClick: take, disabled: controlPending || pending === "join", pending: pending === "join" }}
      onError={setError}
    />
  );

  // this computer: the person drives with their own mouse, so taking control only makes the bot's hands wait
  const takeLocal = async () => {
    setControlPending(true);
    setError(null);
    try {
      await takeover.take();
    } catch (cause) {
      setError(cause instanceof Error ? cause : String(cause));
    } finally {
      setControlPending(false);
    }
  };

  const takeControl = async (expand = false) => {
    if (phase === "local" && !liveTarget) return takeLocal();
    if (!liveTarget) return;
    if (!desktopDecoded) { setLivePreviewFailed(null); return; }
    if (takeover.here) return takeover.setExpanded(expand || takeover.expanded);
    setLivePreviewFailed(null);
    setControlPending(true);
    setError(null);
    try {
      await takeover.take(expand);
    } catch (cause) {
      setError(cause instanceof Error ? cause : String(cause));
    } finally {
      setControlPending(false);
    }
  };

  const desktopUnreachable = () => {
    setDecodedDesktop(null);
    setLivePreviewFailed(viewerConnectionKey);
    setRetry(value => value + 1);
    if (takeover.here) {
      takeover.leave();
      setError(new LocalizedPanelError("computer.err.openDesktop"));
    }
  };

  const handBack = async (keepExpanded = false) => {
    setError(null);
    await takeover.handBack(keepExpanded).catch((cause) => setError(cause instanceof Error ? cause : String(cause)));
  };

  const run = (kind: "sleep" | "provision") => {
    if (computerAction.current) return;
    const controller = new AbortController();
    if (kind === "sleep") return follow(kind, api(threadPath("computer/sleep"), { method: "POST", signal: controller.signal }), controller);
    const path = threadPath("computer/provision");
    return follow(kind, startComputerWake(wakeKey, "provision", viewerConnectionKey, () => api(path, { method: "POST" })), controller, viewerConnectionKey);
  };

  /** Shows an action through to its answer. A wake is not this view's to cancel: leaving only stops the following. */
  const follow = (kind: "sleep" | "provision", request: Promise<VpsComputerStatus>, controller: AbortController, viewer?: string) => {
    computerAction.current = controller;
    if (kind === "provision") { setPhase("starting"); setWakeViewer(viewer ?? viewerConnectionKey); setLivePreviewFailed(null); }
    setPending(kind);
    setError(null);
    return request
      .then((result) => {
        if (controller.signal.aborted) return;
        setVpsStatus(result);
        setTeamComputer(result.teamComputer ? { ...result.teamComputer, botId: bot.id, section: bot.section?.trim() ?? "" } : null);
        if (kind === "provision") {
          setContainerState(result.container ?? null);
          if (result.ready) {
            if (bot.computer === "cloud") {
              setResolvedComputerSelection({ botId: bot.id, threadId: bot.threadId, computer: bot.computer, cloudBackend });
            }
            setPhase("ready");
          }
          else {
            setError(result.problem ?? new LocalizedPanelError("computer.err.vpsNotReady"));
            setPhase("error");
          }
        }
        if (kind === "sleep") {
          setResolvedComputerSelection(null);
          setContainerState("stopped");
          setPhase("vps-stopped");
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) { setError(e.message); setPhase("error"); }
      })
      .finally(() => {
        if (computerAction.current === controller) { computerAction.current = null; setPending(null); }
      });
  };

  const startCloudComputer = () => run("provision");

  // a new computer from the current version: the old one goes, then provision makes it again on the bot's home volume
  const replaceComputer = async (keepsFiles: boolean) => {
    if (computerAction.current) return;
    if (!keepsFiles && !window.confirm(t("computer.problem.replaceLoses", { name: bot.name }))) return;
    const controller = new AbortController();
    computerAction.current = controller;
    setPending("replace");
    setError(null);
    try {
      await api(threadPath("computer/remove"), { method: "POST", signal: controller.signal });
    } catch (e) {
      if (!controller.signal.aborted) { setError(friendlyError(e)); setPhase("error"); }
      return;
    } finally {
      if (computerAction.current === controller) { computerAction.current = null; setPending(null); }
    }
    if (!controller.signal.aborted) void run("provision");
  };

  const runVmAction = async (action: "vm-start" | "vm-create" | "vm-recreate") => {
    if (
      action === "vm-recreate" &&
      !window.confirm(
        t("computer.confirm.replaceVm", { name: bot.name }),
      )
    ) return;
    if (vmActionController.current) return;
    const lifecyclePath = action === "vm-start" && vmStatus?.mode !== "per-bot"
      ? "/api/local-computer/start"
      : `/api/bots/${bot.id}/local-computer/${action === "vm-start" ? "start" : "run"}`;
    const statusPath = threadPath("local-computer");
    const startAndWait = async (signal: AbortSignal): Promise<LocalVmStatus> => {
      if (action === "vm-recreate") {
        await api(`/api/bots/${bot.id}/local-computer/remove`, { method: "POST", body: "{}", signal });
      }
      const started: LocalVmStatus = await api(lifecyclePath, { method: "POST", body: "{}", signal });
      return waitForLocalVmReady(started, () => api(statusPath, { signal }), signal);
    };
    const controller = new AbortController();
    return followVm(action, action === "vm-start"
      ? startComputerWake(wakeKey, "vm-start", viewerConnectionKey, () => startAndWait(new AbortController().signal))
      : startAndWait(controller.signal), controller);
  };

  const followVm = async (action: "vm-start" | "vm-create" | "vm-recreate", request: Promise<LocalVmStatus>, controller: AbortController) => {
    vmActionController.current = controller;
    setPending(action);
    setError(null);
    vmReadinessAttempts.current = 0;
    try {
      const status = await request;
      if (controller.signal.aborted) return;
      if (!status.ready) throw new Error(status.problem ?? t("computer.err.vmNotReady"));
      setVmStatus(status);
      setPhase("vm");
    } catch (e) {
      if (controller.signal.aborted) return;
      setError(friendlyError(e));
      setPhase("vm-unavailable");
    } finally {
      if (vmActionController.current === controller && !controller.signal.aborted) {
        vmActionController.current = null;
        setPending(null);
        setRetry((n) => n + 1);
      }
    }
  };

  const openVmSettings = () => {
    window.sessionStorage.setItem("madanibot.settings.section", "computer");
    dispatch({ type: "toggleAppSettings", open: true });
  };

  const openConnectionSettings = () => dispatch({ type: "toggleAppSettings", open: true, section: "computer" });

  const browserCanTurnOn = browserAvailableHere || state.config?.browserEngine?.installable === true;
  const [browserTurningOn, setBrowserTurningOn] = useState(false);
  const turnOnBrowser = async () => {
    if (browserTurningOn) return;
    setBrowserTurningOn(true);
    setError(null);
    try {
      if (!builtInBrowserEnabled(state.config)) {
        const config: ConfigStatus = await api("/api/config", {
          method: "PATCH",
          body: JSON.stringify({ features: { browser: true } }),
        });
        dispatch({ type: "configStatus", config });
      }
      if (profileBot.browser === false) dispatch({ type: "updateBot", botId: profileBot.id, patch: { browser: true } });
    } catch (cause) {
      setError(friendlyError(cause, t("settings.experimental.error")));
    } finally {
      setBrowserTurningOn(false);
    }
  };

  const turnOffBrowser = () => {
    setError(null);
    dispatch({ type: "updateBot", botId: profileBot.id, patch: { browser: false } });
  };
  const browserSwitchRow = (
    <div data-testid="browser-switch-row" className="mb-3 flex items-center gap-3 rounded-xl bg-card px-3 py-2.5">
      <Globe size={15} className="shrink-0 text-ink-secondary" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-ink">{t("computer.browserSwitch.title", { name: bot.name })}</div>
        {!browserCanTurnOn && <div className="text-[12px] text-ink-secondary">{browserUnavailableReason(state.config)}</div>}
      </div>
      <Switch
        checked={browserEnabled}
        disabled={browserTurningOn || (!browserEnabled && !browserCanTurnOn)}
        aria-label={t("computer.browserSwitch.title", { name: bot.name })}
        onClick={() => (browserEnabled ? turnOffBrowser() : void turnOnBrowser())}
      />
    </div>
  );

  const cloudComputer: PlaceFacts["computer"] = !computerStatusCurrent ? undefined
    : phase === "starting" ? "starting" : phase === "ready" ? "on"
      : phase === "vps-stopped" ? "asleep" : containerState === "missing" ? "none" : undefined;
  const viewOf = (place: PlaceFacts["place"]): PlaceView => placeViewFor({
    ...placeFacts({
      bot, place, seat: placeSeat, config: state.config, instances: state.instances,
      local: { ready: localSelectable, reason: localDisabledReason ?? t("computer.unavailableLocal") },
      ...(place === "cloud" ? { computer: cloudComputer } : {}),
      ...(place === "auto" && currentTeamComputer ? { teamComputer: currentTeamComputer.name } : {}),
    }),
    ...(place === "cloud" && vpsStatus ? { vpsConfigured: vpsStatus.configured } : {}),
  });
  const cloudView = viewOf("cloud");
  const autoView = viewOf("auto");
  const placeOptions = ([null, "cloud", "vm", "local", "browser", "off"] as const)
    .filter((mode) => mode === null || mode === "off" || (placeOffered(mode, state.config) && !(mode === "local" && capabilities.localComputer.reasonCode === "remote-server")))
    .map((mode) => ({
      mode,
      simpleLabel: worksOnSimpleLabel(mode ?? undefined, capabilities.host.platform),
      selected: mode === null ? !profileBot.computer : profileBot.computer === mode,
      view: mode === null ? autoView : mode === "cloud" ? cloudView : viewOf(mode),
    }));
  const worksOnView = placeOptions.find(({ selected }) => selected)?.view ?? autoView;
  const runPlaceAction = (id: PlaceActionId) => {
    if (id === "start" || id === "wake") return startCloudComputer();
    if (id === "try-again") return setRetry((n) => n + 1);
    if (id === "turn-on-browser") return void turnOnBrowser();
    if (id === "open-vm-settings") return openVmSettings();
    openPlaceAction(id, { botId: profileBot.id, threadId: profileBot.threadId }, dispatch);
  };
  const panelOffers = (id: PlaceActionId | undefined): id is PlaceActionId => Boolean(id) && id !== "watch" && id !== "open-computer-panel"
    && ((id !== "start" && id !== "wake") || (canManageCloud && !profileBot.busy));
  const placeActionButton = (view: PlaceView, className = "mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover") =>
    view.action && panelOffers(view.action.id) ? (
      <button type="button" data-testid="place-action" onClick={() => runPlaceAction(view.action!.id)} className={className}>
        {view.action.label}
      </button>
    ) : null;
  const heldPin = livePin && profileBot.computer !== "off" && livePin !== profileBot.computer ? livePin : undefined;

  const tabClass = (active: boolean) => cn(
    "flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-[13px] transition-colors @max-[28rem]/paneltabs:[&>svg]:hidden @max-[22rem]/paneltabs:px-2",
    active ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
  );

  const chooseTab = (view: ComputerPanelView) => {
    if (view === "browser") setError(null);
    selectPanelView(view);
  };

  const emptyState = {
    checking: t("computer.phase.checking"),
    starting: t("computer.phase.starting"),
    "auto-unavailable": autoView.line,
    "vps-unconfigured": cloudView.line,
    "vps-incompatible": t("computer.phase.vpsIncompatible"),
    "vps-stopped": t("computer.phase.vpsStopped"),
    "local-unavailable": localDisabledReason ?? t("computer.phase.localUnavailable"),
    "vm-unavailable": t("computer.phase.vmUnavailable"),
    browser: viewOf("browser").line,
    off: viewOf("off").line,
    error: bot.computer === "cloud" && placeBlocked(cloudView) ? cloudView.line : t("computer.phase.error"),
  } satisfies Record<Exclude<Phase, "ready" | "local" | "vm">, string>;

  const screenLine = currentTeamComputer
    ? autoView.line
    : cloudPreviewReady
    ? t("computer.waitingFrame")
    : phase === "ready"
      ? t("computer.autoChooseCloudOpen")
    : phase === "vm"
      ? t("computer.capturingVm")
    : phase === "local"
      ? isLinux
        ? t("computer.linuxReady")
        : localMisses >= 3
        ? t("computer.needsScreenPerm")
        : t("computer.capturingLocal")
      : vmResumable
        ? t(pending === "vm-start" ? "vm.setup.starting" : "computer.phase.vmStopped")
        : emptyState[phase];

  // a wake still on its way from before this view (another tab, the panel closed and opened): it shows here again
  const wakeOnWay = useComputerWake(wakeKey);
  useEffect(() => {
    if (!wakeOnWay || wakeOnWay.settled) return;
    const following = wakeOnWay.kind === "provision" ? computerAction.current : vmActionController.current;
    if (following && !following.signal.aborted) return;
    const controller = new AbortController();
    if (wakeOnWay.kind === "provision") void follow("provision", wakeOnWay.promise as Promise<VpsComputerStatus>, controller, wakeOnWay.viewer);
    else void followVm("vm-start", wakeOnWay.promise as Promise<LocalVmStatus>, controller);
  }, [wakeOnWay, pending]); // eslint-disable-line react-hooks/exhaustive-deps

  const wakeCloud = canManageCloud && vpsStatus?.configured && (phase === "vps-stopped" || phase === "vps-unconfigured" || phase === "error");
  const wakeVm = canManageVm && vmResumable && vmStatus.mode !== "pool";
  useEffect(() => {
    if (queuedWake === null) return;
    if (queuedWake !== wakeKey) return setQueuedWake(null);
    if (phase === "checking" || pending !== null) return;
    setQueuedWake(null);
    if (wakeCloud) void run("provision");
    else if (wakeVm) void runVmAction("vm-start");
  });

  const wokeOnOpen = useRef(false);
  useEffect(() => {
    if (!fullscreen?.wake || wokeOnOpen.current || pending !== null) return;
    const id = cloudView.action?.id;
    if ((phase === "vps-stopped" || phase === "vps-unconfigured") && vpsStatus?.configured && panelOffers(id)) {
      wokeOnOpen.current = true;
      runPlaceAction(id);
    } else if (vmResumable && canManageVm && vmStatus.mode !== "pool") {
      wokeOnOpen.current = true;
      void runVmAction("vm-start");
    }
  });

  // a wake that updates the computer says so, rather than "waking up" for minutes
  const updatingComputer = Boolean(vpsStatus?.updating);
  const wakingView = (cover = false) => <ComputerWaking bot={bot} cover={cover} updating={updatingComputer} />;
  const LiveDesktop = viewerCode.kind === "ready" ? viewerCode.LiveDesktop : null;
  // inline, the panel itself holds the waking picture, so it plays once through the whole wake
  const remoteFrame = (liveHere || livePreview) && liveTarget ? !LiveDesktop ? <span data-live-desktop-loading="" /> : (
        <LiveDesktop key={viewerConnectionKey} waking={(expanded) => (inline && !expanded ? null : wakingView(expanded || Boolean(fullscreen)))} onScreenSize={(width, height) => setScreenAspect(width / height)}
          target={liveTarget} threadId={bot.threadId} botId={bot.id} name={bot.name} poster={picture} viewOnly={!liveHere} wake={wakingHere} taking={controlPending} asked={Boolean(control.helpReason)}
          expanded={takeover.expanded} onExpandedChange={(expanded) => {
            if (!expanded && inline && takeover.here) void handBack(); else takeover.setExpanded(expanded);
          }}
          originalViewer={inline} onOpenPreview={() => takeover.setExpanded(true)}
          onHandBack={() => void handBack(inline)} handingBack={takeover.handingBack}
          onUnreachable={desktopUnreachable}
          onReadyChange={(ready) => setDecodedDesktop({ key: viewerConnectionKey, ready })}
          onTakeControl={() => void takeControl(inline || takeover.expanded)}
        />
  ) : null;

  if (inline) {
    const localPicture = phase === "local" && !isLinux && Boolean(liveLocal.stream || localFrame);
    const wakeQueued = queuedWake === wakeKey;
    // still checking looks and acts asleep: a click queues the wake instead of waiting out the status
    const checking = phase === "checking" && pending === null;
    const waking = pending === "provision" || pending === "replace" || pending === "vm-start" || phase === "starting" || wakeQueued;
    // a problem in plain words with one way out; the server's own words go to the tab's Advanced
    const problem = phase === "vps-stopped" || phase === "vps-unconfigured" || waking ? null
      : computerProblem({ phase, failed: Boolean(errorText), vps: vpsStatus })
        ?? (errorText ? { line: "computer.problem.failed" as const, fix: "retry" as const, keepsFiles: true } : null);
    const fix = (kind: ComputerFix, keepsFiles: boolean) => {
      if (kind === "replace") void replaceComputer(keepsFiles);
      else if (kind === "settings") openConnectionSettings();
      else if (wakeCloud) void run("provision");
      else if (wakeVm) void runVmAction("vm-start");
      else { setError(null); setRetry(value => value + 1); }
    };
    // no computer to show: the bot gets its own (from the browser it was set to), or one is added; never a browser-only card
    const noComputer = phase === "browser" || phase === "auto-unavailable" || (phase === "off" && profileBot.computer !== "off");
    const ownComputer = noComputer && profileBot.computer === "browser" && Boolean(state.config?.vps?.configured);
    const needsAdmin = placeSeat.role !== "admin" && (noComputer || phase === "vps-stopped" || phase === "vps-unconfigured" || phase === "vps-incompatible");
    const wake = () => {
      if (checking) setQueuedWake(wakeKey);
      else if (wakeCloud) void run("provision");
      else if (wakeVm) void runVmAction("vm-start");
      else if (ownComputer) { updateComputerSelection({ computer: null }); setQueuedWake(wakeKey); }
      else if (phase === "vps-incompatible" && problem) fix(problem.fix, problem.keepsFiles);
      else if (noComputer || phase === "vps-unconfigured") openConnectionSettings();
      else setRetry(value => value + 1);
    };
    const frameActionLabel = waking ? t("computer.wakingUp") : checking || wakeCloud || wakeVm || ownComputer ? t("botPanel.screen.wake")
      : needsAdmin ? t("place.askAdmin") : noComputer ? t("computer.simple.addCloud")
      : phase === "vps-incompatible" && problem ? t(problem.line, { name: bot.name }) : screenLine;
    const frame = remoteFrame ?? (localPicture && liveLocal.stream
      ? <LiveScreenVideo stream={liveLocal.stream} playing={pageVisible} className="absolute inset-0 size-full object-contain" />
      : !waking && picture ? phone
        ? <SteadyImage src={picture} alt={t("computer.screenOf", { name: bot.name })} className="absolute inset-0 size-full object-contain" />
        : <img src={picture} alt={t("computer.screenOf", { name: bot.name })} className="absolute inset-0 size-full object-contain" /> : null);
    // awake, with its picture still on the way (the live screen dropped, a first picture not back yet): never the asleep card
    const pictureOnWay = !frame && !waking && (cloudPreviewReady || phase === "vm") && !previewError;
    const stage = remoteFrame ? desktopDecoded ? "screen" : "loading" : frame ? "screen" : waking || pictureOnWay ? "loading" : phase === "off" && !noComputer ? "off" : "asleep";
    // a wake the person asked for shows the bot waking up until the live screen paints itself over it; one element in
    // one place for the whole wake, so its animation never starts over
    const wakeRequested = !frame && (waking || pictureOnWay);
    // on the phone a reconnecting screen keeps its last picture under it rather than the waking card over it
    const wakingShown = wakeRequested || Boolean(remoteFrame && !desktopDecoded && !takeover.expanded && !(phone && picture));
    return (
      <div data-inline-computer="" data-stage={stage}>
        <div data-panel-screen="" aria-busy={stage === "loading" || undefined} className={COMPUTER_FRAME_CLASS} style={{ aspectRatio: String(screenAspect) }}>
          {wakeRequested ? null : frame ?? (
            <button type="button" data-panel-action="open-computer" data-stage={stage} onClick={wake} disabled={waking || (phase === "off" && !noComputer) || needsAdmin || (phase === "error" && !vpsStatus?.configured)}
              aria-label={frameActionLabel}
              className={COMPUTER_WAKE_BUTTON_CLASS}>
              <AsleepMascot bot={bot} />
              <span className="max-w-[80%] font-medium text-ink">{needsAdmin || noComputer && !ownComputer ? frameActionLabel : checking || ownComputer || phase === "vps-stopped" ? t("botPanel.screen.resting") : frameActionLabel}</span>
            </button>
          )}
          {wakingShown ? wakingView() : null}
        </div>
        {problem && <ProblemLine problem={problem} name={bot.name} lineShown={phase === "vps-incompatible" && !frame} disabled={needsAdmin} onFix={() => fix(problem.fix, problem.keepsFiles)} />}
        {/* an update needs no explanation: the server's own words stay out of the panel */}
        {onReport && <InlineReporter stage={stage} detail={phase === "vps-incompatible" ? null : errorText || null} onReport={onReport} />}
      </div>
    );
  }

  if (fullscreen) {
    const held = liveHere || control.held;
    const waking = pending === "provision" || pending === "vm-start" || phase === "checking" || phase === "starting";
    const localScreen = phase === "local" && !isLinux;
    const screenControl: ScreenControl = held
      ? { held: true, onDone: () => void handBack(), asked: Boolean(control.helpReason), busy: controlPending || takeover.handingBack }
      : { held: false, onTake: liveTarget || cloudPreviewReady || localScreen ? () => void takeControl() : undefined, busy: controlPending || pending === "join" || Boolean(liveTarget && !desktopDecoded), pending: controlPending };
    const frame = remoteFrame ?? (localScreen && liveLocal.stream ? (
      <LiveScreenVideo stream={liveLocal.stream} label={t("computer.screenOf", { name: bot.name })} className="absolute inset-0 size-full object-contain" />
    ) : frameSrc ? <img src={frameSrc} alt={t("computer.screenOf", { name: bot.name })} draggable={false} className="absolute inset-0 size-full object-contain" /> : null);
    const busy = waking || cloudPreviewReady || phase === "vm" || (localScreen && (localMisses < 3 || liveLocal.status === "starting"));
    const nextStep = currentTeamComputer ? autoView : bot.computer === "cloud" ? cloudView : worksOnView;
    return (
      <ComputerFullscreen
        label={t("computer.screenOf", { name: bot.name })}
        onExit={fullscreen.onExit}
        frame={frame}
        control={frame ? screenControl : null}
        alert={frame ? errorText : null}
        note={(
          <ComputerFullscreenNote
            busy={busy}
            text={waking ? t("computer.wakingUp") : screenLine}
            mark={<MausAvatar color={bot.color} bodyId={bot.mascotBody ?? undefined} gradient={[FULLSCREEN_MARK, FULLSCREEN_MARK, FULLSCREEN_MARK]} size={56} state={busy ? "thinking" : "idle"} label={bot.name} />}
          >
            {!busy && placeActionButton(nextStep, fullscreenActionCls)}
            {phase === "local" && !isLinux && localMisses >= 3 && (
              <button type="button" onClick={() => window.madaniDesktop?.permOpenSettings?.("screen")} className={fullscreenActionCls}>{t("computer.openSettings")}</button>
            )}
          </ComputerFullscreenNote>
        )}
      />
    );
  }

  return (
    <>
    <aside
      className={cn(
        "relative flex h-full shrink-0 flex-col border-l border-transparent bg-panel",
        "max-md:absolute max-md:inset-0 max-md:z-40 max-md:w-full!",
      )}
      ref={panelRef}
      data-computer-panel
      style={{ width: panelWidth }}
    >
      <div
        ref={separatorRef}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("computer.resizeAria")}
        aria-valuemin={PANEL_MIN_WIDTH}
        aria-valuemax={PANEL_MAX_WIDTH}
        aria-valuenow={separatorWidth ?? undefined}
        tabIndex={0}
        onKeyDown={onSeparatorKeyDown}
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-md:hidden"
      />
      {/* ml-1.5 keeps the drag region clear of the resize handle: a later drag region in the DOM wins. */}
      <div {...dragProps} className="@container/paneltabs ml-1.5 py-3 pl-2.5 pr-4">
        <div className="relative flex min-h-7 items-center justify-center">
          <div className="mx-9 flex min-w-0 touch-pan-x gap-0.5 overflow-x-auto whitespace-nowrap rounded-full bg-inset p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" data-tour="computer-tabs" data-testid="computer-tabs" role="tablist" aria-label={t("computer.tabsAria")} onWheel={scrollTabsWithWheel} onKeyDown={(event) => moveBetweenTabs(event, panelTabs, chooseTab)}>
            {panelTabs.map((view) => {
              const { Icon, label, tour } = PANEL_TABS[view];
              const live = !placeLive ? undefined
                : view === "computer" && isComputerPlace(livePlace) ? "computer-tab-live"
                : view === "browser" && livePlace === "browser" ? "browser-tab-live" : undefined;
              return (
                <button key={view} type="button" data-tour={tour} {...panelTabProps(view, view === panelView)} title={t(label)} onClick={() => chooseTab(view)} className={tabClass(view === panelView)}>
                  <Icon size={13} /> {t(label)}
                  {live && <span className="size-1.5 animate-pulse rounded-full bg-success" role="img" aria-label={t("place.live")} data-testid={live} />}
                </button>
              );
            })}
          </div>
          <button
            data-computer-panel-close
            onClick={() => {
              releaseComputerPanelFocus(panelRef.current, bot.id);
              dispatch({ type: "toggleComputer", open: false });
            }}
            className="absolute right-0 top-1/2 -translate-y-1/2 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
            aria-label={t("computer.close")}
            title={t("computer.close")}
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {panelView === "routines" ? (
        <div {...tabPanelProps("routines")} className={cn("min-h-0 flex-1 overflow-y-auto px-4 pb-4", TAB_PANEL_FOCUS)}>
          <BotRoutines key={bot.id} bot={bot} defaultRunOn={cloudRoutineReady ? "cloud" : "maus"} />
        </div>
      ) : panelView === "browser" && browserEnabled ? (
        <div {...tabPanelProps("browser")} className={cn("flex min-h-0 flex-1 flex-col px-4 pb-4", TAB_PANEL_FOCUS)}>
          {browserSwitchRow}
          {signInHelp?.place === "browser" && <div className="-mt-1 mb-3">{signInBanner()}</div>}
          <BrowserPanel bot={bot} signIn={signInRequest} page={pageRequest} />
          {errorText && (
            <div role="alert" className="mt-2 text-[12px] text-danger">
              {errorText}
            </div>
          )}
        </div>
      ) : panelView === "browser" ? (
        <div {...tabPanelProps("browser")} className={cn("flex-1 overflow-y-auto px-5 pb-5", TAB_PANEL_FOCUS)} data-testid="browser-off">
          {browserSwitchRow}
          <div className="mt-2 flex flex-col items-center gap-3 px-6 py-8 text-center">
            <Globe size={22} className="text-ink-secondary" aria-hidden="true" />
            <div className="text-[14px] font-medium text-ink">{t("computer.browserOff.title")}</div>
            <p className="text-[12px] leading-5 text-ink-secondary">
              {browserCanTurnOn ? t("computer.browserOff.body", { name: bot.name }) : browserUnavailableReason(state.config)}
            </p>
            {errorText && (
              <div role="alert" className="w-full text-[12px] text-danger">
                {errorText}
              </div>
            )}
          </div>
        </div>
      ) : (
      <div {...tabPanelProps("computer")} className={cn("flex-1 overflow-y-auto px-5 pb-5", TAB_PANEL_FOCUS)}>
          <div className="mb-1.5 mt-2 flex items-center justify-between text-[13px] text-ink-secondary">
            <span>{t("computer.screenOf", { name: bot.name })}</span>
            {currentTeamComputer && <span className="text-[11px]">{autoView.short}</span>}
            {phase === "local" && <span className="text-[11px]">{t("computer.badge.local")}</span>}
            {liveHere && <span className="flex items-center gap-1.5 text-[11px] font-medium text-ink"><span className="size-1.5 rounded-full bg-success" />{t("computer.inControl")}</span>}
            {phase === "vm" && !liveHere && <span className="text-[11px]">{t("vm.dest.vm")}</span>}
            {computerStatusCurrent && bot.computer === "cloud" && (phase === "ready" || phase === "starting") && !liveHere && <span className="text-[11px]">{t("computer.badge.vps")}</span>}
        </div>
        <div className={cn("relative flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-xl bg-card")}>
          {remoteFrame ?? (cloudPreviewReady || (bot.computer === "cloud" && phase === "starting") ? (
            <CloudScreenPreview
              key={`${bot.id}:${bot.threadId}:${bot.computer}:${cloudBackend}`}
              src={frameSrc}
              name={bot.name}
              error={panelErrorText(previewError)}
              refreshing={previewRefreshing}
              retry={previewRetry}
              starting={phase === "starting"}
              opening={pending === "join"}
              disabled={controlPending}
              onOpen={() => void takeControl()}
              onRetry={(discardFrame) => {
                setLivePreviewFailed(null);
                lastLiveAt.current = 0;
                if (discardFrame) setPolledFrame(null);
                setPreviewError(null);
                setPreviewRefreshing(true);
                setPreviewRetry((n) => n + 1);
              }}
            />
          ) : frameSrc && previewOpensDesktop ? (
            <button
              type="button"
              onClick={() => void takeControl()}
              disabled={controlPending || pending === "join"}
              className="group relative flex h-full w-full cursor-pointer items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-wait"
              aria-label={t("computer.openLiveDesktopAria", { name: bot.name })}
              title={t("computer.openLiveDesktop")}
            >
              <img
                src={frameSrc}
                alt={t("computer.screenOf", { name: bot.name })}
                className="h-full w-full object-contain transition group-hover:brightness-75 group-focus-visible:brightness-75"
              />
              <span className="pointer-events-none absolute right-2 top-2 flex items-center gap-1 rounded-md bg-black/70 px-2 py-1 text-[11px] font-medium text-white opacity-80 shadow-sm transition group-hover:opacity-100 group-focus-visible:opacity-100">
                {pending === "join" ? <Loader2 size={12} className="animate-spin" /> : <Maximize2 size={12} />}
                {t("computer.open")}
              </span>
            </button>
          ) : frameSrc ? (
            <img
              src={frameSrc}
              alt={t("computer.screenOf", { name: bot.name })}
              className="h-full w-full object-contain"
              title={phase === "vm" ? t("computer.watchOnly") : undefined}
            />
          ) : (
            <div className="flex flex-col items-center gap-2 px-6 text-center text-ink-secondary">
              {phase === "checking" || phase === "starting" || phase === "vm" || (phase === "local" && !isLinux) ? (
                <Loader2 size={18} className="animate-spin" />
              ) : phase === "off" ? (
                <Power size={22} />
              ) : (
                <Monitor size={22} />
              )}
              <span className="text-[12px]">{screenLine}</span>
              {currentTeamComputer && placeActionButton(autoView)}
              {bot.computer === "cloud" && phase === "error" && placeActionButton(cloudView)}
              {phase === "local" && !isLinux && localMisses >= 3 && (
                <button
                  onClick={() => window.madaniDesktop?.permOpenSettings?.("screen")}
                  className="mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover"
                >
                  {t("computer.openSettings")}
                </button>
              )}
              {phase === "browser" && browserEnabled && (
                <button
                  onClick={() => selectPanelView("browser")}
                  className="mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover"
                >
                  {t("computer.openBrowserTab")}
                </button>
              )}
              {vmResumable && pending !== "vm-start" && (
                <p className="text-[12px]">{t(vmStatus?.stop_reason === "idle" ? "vm.stopped.idle" : "vm.stopped.detail")}</p>
              )}
              {phase === "vm-unavailable" && (
                canManageVm && vmResumable && vmStatus.mode !== "pool" ? (
                  <button
                    onClick={() => void runVmAction("vm-start")}
                    disabled={pending !== null}
                    aria-busy={pending === "vm-start"}
                    className="mt-1 flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-50"
                  >
                    {pending === "vm-start" && <Loader2 size={13} className="animate-spin" />}
                    {t(pending === "vm-start" ? "vm.setup.starting" : "vm.setup.start")}
                  </button>
                ) : canManageVm && vmStatus?.mode === "per-bot" && vmStatus.image && vmStatus.create_supported ? (
                  <button
                    onClick={() => void runVmAction(vmStatus.container === "missing" ? "vm-create" : "vm-recreate")}
                    disabled={pending !== null}
                    className="mt-1 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-50"
                  >
                    {(pending === "vm-create" || pending === "vm-recreate") && (
                      <Loader2 size={13} className="mr-1.5 inline animate-spin" />
                    )}
                    {vmStatus.container === "missing"
                      ? t("computer.createVm", { name: bot.name })
                      : t("computer.replaceVm", { name: bot.name })}
                  </button>
                ) : (
                  <button
                    onClick={openVmSettings}
                    className="mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover"
                  >
                    {t("computer.openVmSetup")}
                  </button>
                )
              )}
              {computerStatusCurrent && (phase === "vps-unconfigured" || phase === "vps-stopped" || phase === "vps-incompatible") && (
                <>
                  {vpsStatus?.configured && <p className="text-[12px]">{t("computer.simple.needsSetup", { name: bot.name })}{placeSeat.role !== "admin" && ` ${t("place.askAdmin")}`}</p>}
                  {placeSeat.role === "admin" && <button
                    type="button"
                    onClick={openConnectionSettings}
                    className="mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover"
                  >
                    {t(vpsStatus?.configured ? "computer.openVpsSettings" : "vpsLink.add")}
                  </button>}
                </>
              )}
            </div>
          ))}
        </div>

        {errorText && (
          <div className="mt-2 text-[12px] text-danger">
            {errorText}
          </div>
        )}

        {signInHelp && signInHelp.place !== "browser" && signInBanner(bannerTakesControl && !control.held
          ? () => phase === "vm" || cloudPreviewReady ? void takeControl() : void controlAction("take")
          : undefined)}
        {(cloudPreviewReady || phase === "vm" || currentTeamComputer) && control.held && (
          <div className="mt-3 rounded-xl border border-accent/25 bg-accent/10 p-4">
            <div className="text-[13px] leading-relaxed text-ink">
              {t("computer.youHaveWheel")}
              {cloudPreviewReady && !liveTarget && ` ${t("computer.simple.useFullScreen")}`}
            </div>
            <button
              onClick={() => void handBack()}
              disabled={controlPending || takeover.handingBack}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50"
            >
              <Hand size={14} />
              {t("computer.handBack")}
            </button>
          </div>
        )}

        {(cloudPreviewReady || phase === "vm") && (
          <div className="mt-3 flex gap-2" data-testid="computer-actions">
            {!control.held && !bannerTakesControl && (
              <button
                type="button"
                onClick={() => void takeControl()}
                disabled={controlPending || pending === "join" || !desktopDecoded}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-accent py-2 text-[13px] font-medium text-accent-ink hover:brightness-110 disabled:opacity-50"
                title={t("computer.takeControlTitle")}
              >
                {pending === "join" ? <Loader2 size={14} className="animate-spin" /> : <Hand size={14} />}
                {t("computer.takeControl")}
              </button>
            )}
            <button
              type="button"
              onClick={() => takeover.setExpanded(true)}
              disabled={pending === "join" || (!control.held && controlPending) || (phase === "vm" && !liveTarget)}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
              title={t("computer.openLiveDesktop")}
            >
              <Maximize2 size={14} />
              {t("computer.fullScreen")}
            </button>
            {cloudPreviewReady && canManageCloud && (
              <button
                type="button"
                onClick={() => run("sleep")}
                disabled={pending === "sleep" || profileBot.busy}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
                title={t("computer.sleepTitle")}
              >
                {pending === "sleep" ? <Loader2 size={14} className="animate-spin" /> : <Moon size={14} />}
                {t("vm.cloud.sleep")}
              </button>
            )}
          </div>
        )}

        {(bot.computer !== undefined || computerStatusCurrent) && <>
          <LocalScreenPreview />
          <LinuxLocalControl />
          <MacLocalControl /><WindowsLocalControl />
        </>}

        {heldPin && (
          <div className="mt-3 flex items-center gap-2 px-1">
            <p className="min-w-0 flex-1 text-[12px] leading-5 text-ink-secondary" data-testid="place-pinned-note">
              {t("place.pinnedNoteSimple", {
                place: placeOptions.find(({ mode }) => mode === heldPin)?.simpleLabel ?? t(placeLabelKey(heldPin)),
              })}
            </p>
            <button
              type="button"
              disabled={Boolean(bot.busy)}
              title={bot.busy ? t("place.busy") : undefined}
              onClick={() => dispatch({ type: "updateTask", botId: profileBot.id, threadId: profileBot.threadId, patch: { surface: null } })}
              className="shrink-0 rounded-md px-2 py-0.5 text-[12px] font-medium leading-5 text-accent-text transition-colors hover:bg-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
              data-testid="place-unpin"
            >
              {t("place.unpinSimple", {
                place: lowerFirst(placeOptions.find(({ selected }) => selected)?.simpleLabel ?? t(placeLabelKey(profileBot.computer ?? "auto"))),
              })}
            </button>
          </div>
        )}
      </div>
      )}

    </aside>
    </>
  );
}

export interface InlineReport { stage: "screen" | "loading" | "asleep" | "off"; detail: string | null }

function InlineReporter({ stage, detail, onReport }: InlineReport & { onReport: (report: InlineReport) => void }) {
  useEffect(() => { onReport({ stage, detail }); }, [stage, detail, onReport]);
  return null;
}

const FIX_LABEL: Record<ComputerFix, LocaleKey> = { replace: "computer.problem.update", retry: "botPanel.ui.commonTryAgain", settings: "computer.problem.openSettings" };

/** Under the screen: what is wrong in plain words (unless the screen already says it), and the one button that fixes it. */
function ProblemLine({ problem, name, lineShown, disabled, onFix }: {
  problem: NonNullable<ReturnType<typeof computerProblem>>; name: string; lineShown: boolean; disabled: boolean; onFix: () => void;
}) {
  return (
    <div role="alert" data-panel-problem={problem.fix} className="mt-1.5 flex min-h-7 items-center gap-2 px-1">
      <span className="min-w-0 flex-1 text-[12px] leading-4 text-ink/[0.68]">
        {lineShown ? problem.fix === "replace" && !problem.keepsFiles && t("computer.problem.losesFiles") : t(problem.line, { name })}
      </span>
      <button type="button" data-panel-action="fix" disabled={disabled} onClick={onFix} className={smallButtonCls}>{t(FIX_LABEL[problem.fix])}</button>
    </div>
  );
}
