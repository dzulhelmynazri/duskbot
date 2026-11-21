// The whole first run as the person sees it, for proving it asks for an AI once: the real WelcomeFlow with a fake
// desktop bridge, signed in, ChatGPT, Claude and Grok connected on this computer (Claude's sign-in stays here).
// ?side=desktop|cloud: this computer's window, or the new cloud's own page; chat: the new cloud's first chat with Madani
// when nothing came along. ?beat=: the screen to open (a resumed run).
// ?cloud=1: the run picked madani cloud. Served by scripts/verify-ai-once.ts.
import { createRoot } from "react-dom/client";
import { WelcomeFlow } from "../../src/components/onboarding/WelcomeFlow";
import { SimpleHelperIntro } from "../../src/components/SimpleHelperIntro";
import { DesktopCapabilitiesProvider } from "../../src/components/DesktopCapabilities";
import { setEmailGateDone } from "../../src/lib/analytics";
import { initialDesktopCapabilities } from "../../src/lib/desktop";
import { setLocale } from "../../src/lib/i18n";
import { applySkinChoice } from "../../src/lib/skins";
import { saveWelcomeDraft } from "../../src/lib/welcome-draft";
import type { BeatId } from "../../src/lib/onboarding";
import { StoreProvider, useStore } from "../../src/state/store";
import "../../src/styles.css";
import "../../src/styles/overlays.css";
import "../../src/styles/motion.css";

setLocale("en");
setEmailGateDone("skipped");
applySkinChoice("system");
const params = new URLSearchParams(location.search);
const side = params.get("side") ?? "desktop";
saveWelcomeDraft({ beat: (params.get("beat") ?? "welcome") as BeatId, ...(params.get("cloud") === "1" ? { cloud: true as const } : {}) });

const account = { status: "connected", account: { id: "a", email: "sam@example.test", name: "Sam Rivera" },
  entitlement: { plan: params.get("cloud") === "1" ? "pro" : "free", status: params.get("cloud") === "1" ? "active" : "inactive", expiresAt: null, version: 1 },
  clouds: params.get("cloud") === "1" ? [{ id: "c1", primary: true, runsOn: "cloud", status: "setting_up", origin: null }] : [] };
if (side === "desktop") {
  window.madaniDesktop = {
    platform: "darwin",
    remoteClient: { active: false },
    getCapabilities: async () => ({ ...initialDesktopCapabilities(), windowChrome: "mac-inset" }),
    onCapabilitiesChanged: () => () => {},
    macPermissions: { status: async () => ({ accessibility: "denied", screen: "denied" }), request: async () => ({ accessibility: "denied", screen: "denied" }) },
    cloudAccount: { state: async () => account, onState: () => () => {}, refresh: async () => account, holdSignIns: async () => ({ outcome: "held" }),
      carriedAis: async () => ({ instanceIds: ["codex", "grok"] }), offer: async () => null, openDashboard: async () => {} },
  } as unknown as typeof window.madaniDesktop;
}

function FirstChat() {
  const { state } = useStore();
  const madani = state.bots.find((bot) => bot.defaultBot) ?? state.bots[0];
  if (!madani || !state.config) return null;
  return <div className="mx-auto flex min-h-[100dvh] max-w-[720px] flex-col justify-end px-6 py-10">
    <SimpleHelperIntro botId={madani.id} threadId="preview" message={{ id: "intro", role: "bot", kind: "text", text: "" } as never} answered={false} />
  </div>;
}

createRoot(document.getElementById("root")!).render(
  <StoreProvider><DesktopCapabilitiesProvider>
    {side === "chat" ? <FirstChat /> : <WelcomeFlow onDone={() => { document.body.dataset.firstRunDone = "1"; }} cloudHome={side === "cloud"} />}
  </DesktopCapabilitiesProvider></StoreProvider>,
);
