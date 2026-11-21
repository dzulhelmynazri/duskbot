// Settings for voice: the keys page opened at Voice and calls, and Voice input under it, against a fixture server.
// Served only by scripts/testing/voice-settings.e2e.test.ts.
import { createRoot } from "react-dom/client";
import { DesktopCapabilitiesProvider } from "../../src/components/DesktopCapabilities";
import { KeysPage } from "../../src/components/keys/KeysPage";
import { openKeySettings } from "../../src/components/keys/key-focus";
import { VoiceInputSettings } from "../../src/components/VoiceInputSettings";
import { setEmailGateDone } from "../../src/lib/analytics";
import { initialDesktopCapabilities } from "../../src/lib/desktop";
import { setLocale } from "../../src/lib/i18n";
import { applySkin, SKINS } from "../../src/lib/skins";
import { StoreProvider } from "../../src/state/store";
import "../../src/styles.css";
import "../../src/styles/overlays.css";
import "../../src/styles/motion.css";

setLocale("en");
setEmailGateDone("skipped");
const params = new URLSearchParams(location.search);
applySkin(SKINS.find((one) => one.id === params.get("skin"))?.id ?? "grok");
window.madaniDesktop = {
  platform: "darwin",
  getCapabilities: async () => initialDesktopCapabilities(),
  permOpenSettings: async () => {},
} as unknown as typeof window.madaniDesktop;
openKeySettings("deepgram" as never);

const root = createRoot(document.getElementById("root")!);
root.render(
  <StoreProvider><DesktopCapabilitiesProvider>
    <main className="mx-auto flex min-h-[100dvh] max-w-[720px] flex-col gap-6 bg-app p-6">
      <KeysPage />
      {params.has("input") && <VoiceInputSettings />}
    </main>
  </DesktopCapabilitiesProvider></StoreProvider>,
);
