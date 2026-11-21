// Bringing bots here from a server of the person's own, and Google's paste-back sign-in, against a fake vpsLink bridge:
// ?view=idle | progress | refused | failed (Settings > Transfer), ?view=empty (the empty-computer dialog),
// ?view=google (the connect pill waiting for the pasted address). Served only by move-back-shots.ts.
import { createRoot } from "react-dom/client";
import { MacEmptyMain } from "../../src/components/MacEmptyMain";
import { ConnectPanel, type ConnectFlowHandle } from "../../src/components/onboarding/SignInPill";
import { TransferSettings } from "../../src/components/vps-link/TransferSettings";
import { SIMPLE_BUTTONS } from "../../src/components/SettingsPrimitives";
import { cn } from "../../src/lib/cn";
import { applySkin } from "../../src/lib/skins";
import { EMPTY_VIEW, type VpsLinkView, type VpsMoveBack, type VpsWhere } from "../../src/lib/vps-link";
import { StoreProvider } from "../../src/state/store";
import "../../src/styles.css";
import "../../src/styles/overlays.css";
import "../../src/styles/motion.css";
import "../../src/styles/settings.css";

const view = new URLSearchParams(location.search).get("view") ?? "idle";
applySkin("grok");

const SERVER = { id: "hetzner", name: "hetzner-box" };
const MB = 1024 * 1024;
const BACK: Record<string, VpsMoveBack | undefined> = {
  progress: { step: "copy", status: "running", name: SERVER.name, bytes: { done: 48 * MB, total: 212 * MB } },
  failed: { step: "copy", status: "failed", name: SERVER.name, error: "The backup could not be saved." },
};
const where: VpsWhere = { place: "mac", server: null, bring: [SERVER], ...(view === "refused" ? { blocked: "own-bots" as const } : {}) };
const linkView: VpsLinkView = { ...EMPTY_VIEW, ...(BACK[view] ? { back: BACK[view] } : {}) } as VpsLinkView;

window.madaniDesktop = {
  platform: "darwin",
  remoteClient: { active: false },
  getCapabilities: async () => ({}),
  onCapabilitiesChanged: () => () => {},
  cloudAccount: {},
  vpsLink: {
    state: async () => linkView,
    onChange: (listener: (next: VpsLinkView) => void) => { listener(linkView); return () => {}; },
    where: async () => where,
    backups: async () => [],
    moveBack: async () => ({ ok: true }),
  },
} as unknown as typeof window.madaniDesktop;

const now = Date.now();
const googleFlow = {
  state: { stage: "waiting", since: now - 14_000, kind: "redirect", flowId: "f1", link: "https://accounts.google.com/o/oauth2/auth", code: null, opened: true },
  submit: () => {}, cancel: () => {}, openAgain: async () => {},
} as unknown as ConnectFlowHandle;

function Settings() {
  return <div className={cn("settings-pane mx-auto w-full max-w-[640px] pt-8", SIMPLE_BUTTONS)}><TransferSettings /></div>;
}

function Google() {
  return (
    <div className="mx-auto flex w-full max-w-[420px] flex-col items-center gap-3 rounded-[24px] bg-ink/[0.035] px-6 py-8 text-center">
      <ConnectPanel flow={googleFlow} name="Google Gemini" driverKind="antigravityAgent" />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StoreProvider>
    <main data-preview={view} className="min-h-[100dvh] bg-app px-6 py-6 text-ink">
      {view === "google" ? <Google /> : view === "empty" ? <MacEmptyMain from={{ ...SERVER, why: "server" } as never} onClose={() => {}} /> : <Settings />}
    </main>
  </StoreProvider>,
);
