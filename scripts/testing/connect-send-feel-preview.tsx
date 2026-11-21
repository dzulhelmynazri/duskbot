// For scripts/testing/connect-send-feel.e2e.test.ts. ?view=send: the real ChatView against the fixture server, each
// message POST held ?sendlag ms, so Send's hold and its crossfade to the mic show. ?view=connect: Connect an AI
// (window.__open) and, beside it, the connect panel under a grid stepped through its stages by window.__stage.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatView } from "../../src/components/ChatView";
import { DesktopCapabilitiesProvider } from "../../src/components/DesktopCapabilities";
import { ConnectAiDialog } from "../../src/components/onboarding/ConnectAi";
import { Reveal, StageSwap } from "../../src/components/onboarding/ConnectMotion";
import type { ConnectState } from "../../src/components/onboarding/connect-flow";
import { ConnectPanel, type ConnectFlowHandle } from "../../src/components/onboarding/SignInPill";
import { initialDesktopCapabilities } from "../../src/lib/desktop";
import { setLocale } from "../../src/lib/i18n";
import { applySkin, SKINS } from "../../src/lib/skins";
import { setEmailGateDone } from "../../src/lib/analytics";
import { StoreProvider, useStore } from "../../src/state/store";
import "../../src/styles.css";
import "../../src/styles/overlays.css";
import "../../src/styles/motion.css";

setLocale("en");
setEmailGateDone("skipped");
const params = new URLSearchParams(location.search);
applySkin(SKINS.find((one) => one.id === params.get("skin"))?.id ?? "grok");
const sendLag = Number(params.get("sendlag")) || 0;
if (sendLag) {
  const send = window.fetch.bind(window);
  window.fetch = (input, init) => (init?.method === "POST" && /\/api\/bots\/[^/]+\/messages$/.test(String(input instanceof Request ? input.url : input)))
    ? new Promise((done) => setTimeout(done, sendLag)).then(() => send(input, init)) : send(input, init);
}
window.madaniDesktop = {
  platform: "darwin",
  getCapabilities: async () => initialDesktopCapabilities(),
} as unknown as typeof window.madaniDesktop;

function SendView() {
  const { state, dispatch } = useStore();
  const bot = state.bots.find((candidate) => !candidate.hidden);
  useEffect(() => { if (bot && state.selectedId !== bot.id) dispatch({ type: "select", id: bot.id }); }, [bot?.id, state.selectedId]);
  if (!bot) return null;
  return <div className="flex h-dvh flex-col bg-app text-ink"><div className="min-h-0 flex-1"><ChatView bot={bot} /></div></div>;
}

const STAGES: Record<string, ConnectState> = {
  idle: { stage: "idle" },
  preparing: { stage: "preparing", since: Date.now() },
  opening: { stage: "opening", since: Date.now() },
  waiting: { stage: "waiting", since: Date.now(), kind: "device", flowId: "f", link: "https://example.com/device", code: "QX7P-3KDM", opened: true },
  paste: { stage: "waiting", since: Date.now(), kind: "paste", flowId: "f", link: "https://example.com", code: null, opened: true },
  connected: { stage: "connected", reused: false },
  failed: { stage: "failed", at: "opening", reason: "timeout", message: null, link: null },
};

function ConnectView() {
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  useEffect(() => { Object.assign(window, { __open: setOpen, __stage: setStage }); }, []);
  const flow = { state: STAGES[stage ?? "idle"]!, target: null, start: () => {}, cancel: () => setStage(null), retry: () => {}, openAgain: async () => {}, submit: () => {} } as unknown as ConnectFlowHandle;
  return (
    <div className="flex h-dvh flex-col items-center bg-app p-8 text-ink">
      <div data-panel-demo="" className="flex w-[488px] flex-col items-center rounded-2xl bg-ink/[0.02] p-4">
        <div className="grid h-[96px] w-full place-items-center rounded-2xl bg-ink/[0.035] text-[13px]">Grok</div>
        <Reveal className="pt-5">
          {stage && <StageSwap stage="grok"><ConnectPanel flow={flow} name="Grok" driverKind="grokAgent" onTrouble={() => {}} /></StageSwap>}
        </Reveal>
        <p className="mt-3 text-[13px] text-ink-secondary">More providers or use an API key</p>
      </div>
      {open && <ConnectAiDialog tested={null} start="grok" onClose={() => setOpen(false)} />}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <DesktopCapabilitiesProvider><StoreProvider>{params.get("view") === "connect" ? <ConnectView /> : <SendView />}</StoreProvider></DesktopCapabilitiesProvider>,
);
