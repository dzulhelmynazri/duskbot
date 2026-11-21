// The first run's Mac permissions step, the real component in the welcome's own frame, with a fake bridge.
// ?state=none|one|all|asked picks what macOS has granted; the rows' buttons move it on the way the app's would.
// ?skin= picks the skin (grok, grok-dark). Served by scripts/verify-permissions-step.ts.
import { createRoot } from "react-dom/client";
import { DesktopCapabilitiesProvider } from "../../src/components/DesktopCapabilities";
import { FunnelBar } from "../../src/components/onboarding/FunnelSteps";
import { PermissionsStep } from "../../src/components/onboarding/PermissionsStep";
import { setEmailGateDone } from "../../src/lib/analytics";
import { initialDesktopCapabilities } from "../../src/lib/desktop";
import { setLocale } from "../../src/lib/i18n";
import type { MacPermission, MacPermissionState, MacPermissionStatus, MacPermissionsBridge } from "../../src/lib/mac-permissions";
import { applySkin, SKINS } from "../../src/lib/skins";
import { StoreProvider } from "../../src/state/store";
import "../../src/styles.css";
import "../../src/styles/overlays.css";
import "../../src/styles/motion.css";
import "../../src/styles/onboarding.css";
import "../../src/styles/place-setup.css";

setLocale("en");
setEmailGateDone("skipped");
const params = new URLSearchParams(location.search);
applySkin(SKINS.find((one) => one.id === params.get("skin"))?.id ?? "grok");
window.madaniDesktop = {
  platform: "darwin",
  getCapabilities: async () => ({ ...initialDesktopCapabilities(), windowChrome: "mac-inset" }),
} as unknown as typeof window.madaniDesktop;

const START: Record<string, Record<MacPermission, MacPermissionState>> = {
  none: { accessibility: "missing", screen: "missing", notifications: "missing" },
  one: { accessibility: "granted", screen: "missing", notifications: "missing" },
  asked: { accessibility: "granted", screen: "asked", notifications: "granted" },
  all: { accessibility: "granted", screen: "granted", notifications: "granted" },
};
const grants = { ...(START[params.get("state") ?? "none"] ?? START.none!) };
const status = (): MacPermissionStatus => ({ supported: true, ...grants });
const bridge: MacPermissionsBridge = {
  status: async () => status(),
  request: async (kind) => {
    // the first press shows macOS's prompt, which the preview takes as a yes for all but Screen Recording
    grants[kind] = kind === "screen" && grants[kind] === "missing" ? "asked" : "granted";
    return status();
  },
};
Object.assign(window, { __permissions: { grants } });

createRoot(document.getElementById("root")!).render(
  <StoreProvider><DesktopCapabilitiesProvider>
    <div role="dialog" aria-modal aria-labelledby="welcome-title" data-welcome="permissions" className="welcome-screen fixed inset-0 flex overflow-y-auto bg-app">
      <FunnelBar at={5} count={6} onBack={() => {}} />
      <div data-from="next" className="place-step relative flex min-h-full w-full flex-col">
        <PermissionsStep bridge={bridge} relaunch={() => {}} onNext={(how, granted) => Object.assign(window, { __left: { how, granted } })} />
      </div>
    </div>
  </DesktopCapabilitiesProvider></StoreProvider>,
);
