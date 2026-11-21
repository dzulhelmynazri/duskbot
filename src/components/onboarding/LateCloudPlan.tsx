import { useEffect, useRef, useState } from "react";
import type { CloudAccountState } from "../../../electron/cloud-account.mjs";
import { hintSeenPatch, useWelcomeOnScreen, type WelcomeViewer } from "@/lib/onboarding";
import { openedBySwitch } from "@/lib/place-switch";
import { api, useStore } from "@/state/store";
import { WindowDragStrip } from "../DesktopCapabilities";
import { CLOUD_OPENED_HERE, lateCloudDue, setLateCloudOnScreen } from "./late-cloud";
import { MakingStep } from "./MakingStep";
import { localDesktopPage } from "./WelcomeGate";
import "../../styles/onboarding.css";

/** The cloud being made, then opened onto its own first run, for a plan that came after this computer's first run. */
export function LateCloudPlan({ viewer }: { viewer: WelcomeViewer | null }) {
  const { state, dispatch } = useStore();
  const bridge = localDesktopPage() && window.madaniDesktop?.remoteClient?.active !== true ? window.madaniDesktop?.cloudAccount : undefined;
  const [account, setAccount] = useState<CloudAccountState | null>(null);
  const welcomeShown = useWelcomeOnScreen();
  const [open, setOpen] = useState(false);
  const marked = useRef(false);
  useEffect(() => {
    if (!bridge) return;
    let live = true;
    const seen = (next: CloudAccountState) => { if (live) setAccount(next); };
    void bridge.state().then(seen, () => {});
    const stop = bridge.onState(seen);
    return () => { live = false; stop(); };
  }, [bridge]);
  const due = lateCloudDue({ local: Boolean(bridge), canSave: viewer?.canSave === true, config: state.config, account, welcomeShown, switched: openedBySwitch() });
  useEffect(() => {
    if (!due || marked.current) return;
    marked.current = true;
    if (due === "making") setOpen(true);
    const patch = hintSeenPatch(state.config?.onboarding, CLOUD_OPENED_HERE);
    if (patch) void api("/api/config", { method: "PUT", body: JSON.stringify(patch), signal: AbortSignal.timeout(10_000) })
      .then((config) => dispatch({ type: "configStatus", config: config as never }), () => {});
  }, [due, state.config?.onboarding, dispatch]);
  useEffect(() => {
    setLateCloudOnScreen(open);
    return () => setLateCloudOnScreen(false);
  }, [open]);
  if (!open) return null;
  return (
    <div role="dialog" aria-modal aria-labelledby="welcome-title" data-late-cloud=""
      className="welcome-screen fixed inset-y-0 left-[var(--rail-beside,0px)] right-0 z-50 flex overflow-y-auto bg-app">
      <WindowDragStrip />
      <div className="place-step relative flex min-h-full w-full flex-col">
        <MakingStep onOpened={() => setOpen(false)} />
      </div>
    </div>
  );
}
