// Add your VPS, as Grok Bot's first run is drawn: the whole window, one idea per screen, the pills under the middle. The
// picture of this Mac, the server and the mascot between them stays put while the screens change under it. The window
// opens raw; only the change from one screen to the next eases.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/Icon";
import { t } from "@/lib/i18n";
import type { MausState } from "@/lib/mascot";
import { EASE, REDUCED } from "@/lib/motion-presets";
import { useVpsLink, vpsStage, type VpsLinkBridge, type VpsLinkView, type VpsMovePreview } from "@/lib/vps-link";
import { emptyHere } from "@/lib/bots-elsewhere";
import { useStore } from "@/state/store";
import { useDialogKeys } from "../ui/GrokDialog";
import { MotionDiv, useMotionReduced } from "../ui/SheetMotion";
import { CommandScreen, InstallScreen } from "./CommandStage";
import { moveProgress, movePhase, MoveScreen } from "./MoveStage";
import { deviceWord, Footer, Heading, Lead, message, PILL, SOFT_PILL, TITLE_ID } from "./parts";
import { Scene, type SceneBot, type SceneHandle, type SceneMode } from "./Scene";
import { SignInScreen } from "./SignInStage";

type Screen = "command" | "install" | "connected" | "signin" | "preview" | "moving" | "paused" | "moved";
const PREVIEW_MAX_AGE_MS = 5000;
type Journey = { serverKey: string | null; signedIn: boolean; cheered: boolean };
const journeys = new WeakMap<VpsLinkBridge, Journey>();

const SCENE: Record<Screen, { mode: SceneMode; mascot: MausState }> = {
  command: { mode: "waiting", mascot: "listening" },
  install: { mode: "working", mascot: "working" },
  connected: { mode: "linked", mascot: "celebrate" },
  signin: { mode: "linked", mascot: "excited" },
  preview: { mode: "linked", mascot: "happy" },
  moving: { mode: "moving", mascot: "working" },
  paused: { mode: "stuck", mascot: "surprised" },
  moved: { mode: "moved", mascot: "celebrate" },
};

/** `onOpen`: this computer has no bots to move, so the server can be opened straight away. */
function ConnectedScreen({ view, onNext, onOpen }: { view: VpsLinkView; onNext: () => void; onOpen?: () => void }) {
  const name = view.server?.name ?? t("vpsLink.yourServer");
  return (
    <>
      <Heading>{t("vpsLink.connected.title")}</Heading>
      <Lead className="top-[calc(50%-36px)]">{t("vpsLink.connected.hint", { name, device: deviceWord() })}</Lead>
      <Footer>
        <button type="button" data-primary="" data-autofocus="" className={PILL} onClick={onNext}>{t("vpsLink.signIn.title")}</button>
        {onOpen && <button type="button" data-vps-open="" className={SOFT_PILL} onClick={onOpen}>{t("vpsLink.move.open", { name })}</button>}
      </Footer>
    </>
  );
}

export function AddVpsFlow({ onClose }: { onClose: () => void }) {
  const { view, bridge, ready, update } = useVpsLink();
  const { state } = useStore();
  const serverKey = view.server ? `${view.server.id}:${view.server.origin}` : null;
  const [, journeyChanged] = useState(0);
  const savedJourney = bridge ? journeys.get(bridge) : undefined;
  const journey = savedJourney?.serverKey === serverKey ? savedJourney : { serverKey, signedIn: false, cheered: false };
  const { signedIn, cheered } = journey;
  const setJourney = (change: Partial<Omit<Journey, "serverKey">>) => {
    if (!bridge) return;
    const saved = journeys.get(bridge);
    journeys.set(bridge, { ...(saved?.serverKey === serverKey ? saved : { serverKey, signedIn: false, cheered: false }), ...change });
    journeyChanged((value) => value + 1);
  };
  const setSignedIn = (signedIn: boolean) => setJourney({ signedIn });
  const setCheered = (cheered: boolean) => setJourney({ cheered });
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<VpsMovePreview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const reduced = useMotionReduced();
  const asked = useRef(false);
  const previewPending = useRef(false);
  const previewGeneration = useRef(0);
  const previewAt = useRef(0);
  const alive = useRef(true);
  const root = useRef<HTMLDivElement>(null);
  const mascot = useRef<SceneHandle>(null);
  // the screen the window opened on draws raw, like the window itself
  const first = useRef<Screen | null>(null);
  // the cheer only plays for a link made while watching; a window reopened on a linked server goes to the sign-in
  const sawSetup = useRef(false);
  // a window opened once every AI is signed in skips the sign-in, once
  const autoSkip = useRef(true);
  useDialogKeys(root, onClose);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    previewGeneration.current++;
    previewPending.current = false;
    previewAt.current = 0;
    setPreview(null);
    setPreviewError("");
    autoSkip.current = true;
  }, [bridge, serverKey]);

  const run = useCallback(async (work: () => Promise<VpsLinkView>) => {
    setError("");
    try { await update(work); }
    catch (cause) { if (alive.current) setError(message(cause)); }
  }, [update]);
  // a fresh window asks for a command once; one already under way is picked up where it is
  useEffect(() => {
    if (!bridge || !ready || asked.current) return;
    asked.current = true;
    if (view.stage !== "idle" || view.error) return;
    setStarting(true);
    void run(() => bridge.start()).finally(() => { if (alive.current) setStarting(false); });
  }, [bridge, ready, view, run]);

  const shown: VpsLinkView = error ? { ...view, error } : view;
  const at = bridge ? vpsStage(shown, signedIn) : 1;
  if (ready && at < 3) sawSetup.current = true;
  const screen: Screen = at === 1 ? "command" : at === 2 ? "install"
    : at === 3 ? (sawSetup.current && !cheered ? "connected" : "signin")
      : movePhase(shown);
  if (ready) first.current ??= screen;

  // what moves is counted once the move screen is near, and kept for the move itself, so its bots can travel
  const loadPreview = useCallback(() => {
    if (!bridge || previewPending.current) return;
    previewPending.current = true;
    const generation = ++previewGeneration.current;
    setPreview(null);
    setPreviewError("");
    void bridge.preview().then((next) => {
      if (!alive.current || generation !== previewGeneration.current) return;
      previewAt.current = Date.now();
      setPreview(next);
    }, (cause) => {
      if (alive.current && generation === previewGeneration.current) setPreviewError(message(cause));
    }).finally(() => { if (generation === previewGeneration.current) previewPending.current = false; });
  }, [bridge, serverKey]);
  const wantPreview = ready && at >= 3 && !shown.move && !previewError && (!preview || (at === 4 && Date.now() - previewAt.current >= PREVIEW_MAX_AGE_MS));
  useEffect(() => { if (wantPreview) loadPreview(); }, [wantPreview, loadPreview]);

  // the mascot cheers as the server links and again when everything has moved
  useEffect(() => {
    if (screen === "connected" || screen === "moved") mascot.current?.react("cheer");
  }, [screen]);
  const copied = useCallback(() => mascot.current?.react("cheer"), []);
  // each screen starts keyboard focus on its one action, else on the window, so Tab never starts from a screen that left
  useEffect(() => {
    if (!ready) return;
    const box = root.current;
    (box?.querySelector<HTMLElement>("[data-autofocus]:not([disabled])") ?? box)?.focus({ preventScroll: true });
  }, [ready, screen]);

  if (!bridge) return null;
  const retry = () => {
    setStarting(true);
    void run(async () => { await bridge.reset(); return bridge.start(); }).finally(() => setStarting(false));
  };
  const move = () => void run(() => bridge.move());

  const bots: SceneBot[] = preview?.bots ?? state.bots?.map((bot) => ({ id: bot.id, name: bot.name })) ?? [];
  const { arrived } = moveProgress(shown.move, bots.length);
  const stuck = screen === "install" && (shown.steps.some((step) => step.status === "failed") || Boolean(shown.error));
  const scene = stuck ? SCENE.paused : SCENE[screen];
  // the next screen rises a few pixels into place as the old one goes at once; under reduced motion it only fades
  const motion = reduced
    ? { initial: { opacity: 0 }, animate: { opacity: 1, transition: REDUCED } }
    : { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0, transition: { duration: 0.24, ease: EASE.out } } };

  return createPortal(
    <div ref={root} role="dialog" aria-modal="true" aria-labelledby={TITLE_ID} tabIndex={-1} data-panel-modal="add-vps" data-vps-stage={at} data-vps-screen={screen}
      className="fixed inset-0 z-[61] overflow-y-auto bg-app text-ink outline-none">
      <button type="button" onClick={onClose} aria-label={t("common.close")}
        className="madani-press fixed end-4 top-4 z-10 flex size-8 items-center justify-center rounded-full text-ink-secondary outline-none hover:bg-ink/6 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus [-webkit-app-region:no-drag]">
        <Icon name="close" size={14} />
      </button>
      <div className="relative h-full min-h-[700px] w-full">
        <Scene ref={mascot} mode={scene.mode} mascot={scene.mascot} bots={bots}
          arrived={screen === "moved" ? bots.length : arrived} className="absolute left-1/2 top-[calc(50%-214px)] -translate-x-1/2" />
        {ready && <MotionDiv key={screen} {...(screen === first.current ? {} : motion)} className="pointer-events-none absolute inset-0 [&>*]:pointer-events-auto">
          {screen === "command" && <CommandScreen view={shown} starting={starting} onRetry={retry} onCopied={copied} />}
          {screen === "install" && <InstallScreen view={shown} onRetry={retry} />}
          {screen === "connected" && <ConnectedScreen view={shown} onNext={() => setCheered(true)}
            onOpen={emptyHere(state.bots) ? () => void bridge.open().then(onClose, (cause) => setError(message(cause))) : undefined} />}
          {screen === "signin" && <SignInScreen bridge={bridge} server={shown.server} autoSkip={first.current === "signin" && autoSkip.current}
            onDone={() => { autoSkip.current = false; setSignedIn(true); }} />}
          {at === 4 && <MoveScreen view={shown} preview={preview} previewError={previewError} onReload={loadPreview} bridge={bridge} onMove={move}
            onBack={() => { setSignedIn(false); setCheered(true); }} />}
        </MotionDiv>}
      </div>
    </div>,
    document.body,
  );
}
