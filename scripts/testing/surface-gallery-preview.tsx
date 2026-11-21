// The surfaces gallery: the real app against the disposable fixture server, with its store's dispatch handed to the
// run (window.__surfaceGallery), so each settings page, bot panel tab, dialog and sheet can be opened in turn and
// checked by chat-gallery/layout-audit.ts. ?onboarding=<step> opens the first-run flow at that step instead.
// Served only by scripts/testing/surface-gallery.e2e.test.ts.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ConnectAiDialog } from "../../src/components/onboarding/ConnectAi";
import { Toast } from "../../src/components/ui/Toast";
import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { setEmailGateDone } from "../../src/lib/analytics";
import { GROK_MOVE_NOTICE } from "../../src/lib/notices";
import { applySkin, SKINS } from "../../src/lib/skins";
import { saveWelcomeDraft } from "../../src/lib/welcome-draft";
import { BEAT_ORDER, type BeatId } from "../../src/lib/onboarding";
import { useStore } from "../../src/state/store";
import { CloudReady } from "../../src/components/CloudSetup";
import { SidebarSpot, SpotCloudCard } from "../../src/components/SidebarSpot";
import type { CloudOffer } from "../../electron/cloud-home.mjs";
import { useSidebarFooterSlot } from "../../src/lib/sidebar-footer-slot";
import { auditLayout } from "./chat-gallery/layout-audit";
import { setLocalBrowserFixture } from "../../src/lib/local-browser";
import "../../src/styles.css";
import "../../src/styles/overlays.css";
import "../../src/styles/motion.css";

const params = new URLSearchParams(location.search);
const step = params.get("onboarding");
if (step && (BEAT_ORDER as readonly string[]).includes(step)) saveWelcomeDraft({ beat: step as BeatId });
else setEmailGateDone("skipped");
localStorage.setItem(GROK_MOVE_NOTICE, "1");
applySkin(SKINS.find((one) => one.id === params.get("skin"))?.id ?? "grok");

function Probe() {
  const { state, dispatch } = useStore();
  useEffect(() => {
    Object.assign(window, { __surfaceGallery: { dispatch, botId: state.bots.find((bot) => bot.name === "Pepper")?.id ?? state.bots[0]?.id, ready: state.bots.length > 0 } });
  }, [dispatch, state.bots]);
  return null;
}

// ?card=cloud-ready: the cloud-ready card in the sidebar footer, as a new madani cloud shows it.
// ?card=connect-ai: Connect an AI opened from inside the chat's composer dock, where the no-AI card opens it, so the
// gallery's cover check sees whether its scrim escapes the dock's stacking context and covers the whole window
const heldUpdate = (state: { ready: string | null; available: string; progress: number | null }) =>
  ({ state: async () => state, restart: async () => false, download: async () => null, onState: () => () => undefined });
const APP_UPDATE: Record<string, ReturnType<typeof heldUpdate>> = {
  "app-update-available": heldUpdate({ ready: null, available: "0.2.7", progress: null }),
  "app-update-downloading": heldUpdate({ ready: null, available: "0.2.7", progress: 0.4 }),
  "app-update-ready": heldUpdate({ ready: "0.2.7", available: "0.2.7", progress: null }),
};

// the plans as the Admin sells them now: Plus sleeps when idle, Pro has priority wake and a work license, Team two seats
const machine = (cpus: number, memoryGb: number, diskGb: number) => ({ cpus, memoryMb: memoryGb * 1024, diskGb, maxDiskGb: diskGb, computers: 1, computerHours: 0, voiceCharacters: 0, snapshotDays: 7 });
const GALLERY_OFFER: CloudOffer = { recommended: "pro", refundDays: 14, plans: [
  { tier: "starter", label: "Plus", amount: 2000, allowances: { ...machine(2, 4, 20), sleeps: true } },
  { tier: "pro", label: "Pro", amount: 5000, allowances: machine(4, 8, 60) },
  { tier: "team", label: "Team", amount: 11900, allowances: { ...machine(4, 8, 60), seats: 2 } },
] };
// ?card=cloud-stale-checkout: a free account whose Pro checkout was left open hours ago (main found it after a restart),
// then Get madani cloud: the plans show, with Finish your Pro checkout, never the payment screen
if (params.get("card") === "cloud-stale-checkout") {
  const account = { status: "connected", entitlement: { plan: "free" }, account: { email: "sam@example.test" }, checkout: { plan: "pro", startedAt: Date.now() - 5 * 3600_000, found: true } };
  const offer = { ...GALLERY_OFFER, checkout: { plan: "pro", openUntil: Date.now() + 20 * 60_000 } };
  Object.assign(window, { madaniDesktop: { ...(window as { madaniDesktop?: object }).madaniDesktop, cloudAccount: {
    state: async () => account, onState: () => () => undefined, offer: async () => offer, sheet: async () => undefined,
  } } });
}

// ?card=cloud-mac: this Mac's desktop app with a ready madani cloud on the account, the bots kept here, and Screen Recording and
// Accessibility not allowed yet; Allow turns each on, as macOS would
if (params.get("card") === "cloud-mac") {
  const account = { status: "connected", entitlement: { plan: "pro" }, account: { email: "sam@example.test" },
    clouds: [{ id: "c1", name: "My Cloud", primary: true, role: "owner", teamId: null, managed: true, provider: "managed", status: "ready" }] };
  const grants = { screen: "missing", accessibility: "missing" } as Record<"screen" | "accessibility", string>;
  const capabilities = { host: { platform: "darwin", label: "This Mac", session: "unknown", packaged: true }, windowChrome: "native",
    screenPreview: { available: false, interaction: "none" }, dictation: { available: false, engine: "none", onDevice: false },
    localComputer: { available: false, support: "supported", enabled: true, status: "unavailable", reasonCode: "permission-denied" } };
  Object.assign(window, { madaniDesktop: { ...(window as { madaniDesktop?: object }).madaniDesktop, platform: "darwin",
    getCapabilities: async () => capabilities,
    cloudAccount: { state: async () => account, onState: () => () => undefined, offer: async () => GALLERY_OFFER, sheet: async () => undefined,
      connectHome: async () => undefined, openDashboard: async () => undefined },
    cloudSendPage: { keepHere: async () => ({ shown: false, moved: false }), setKeepHere: async () => ({ shown: false, moved: false }), notice: async () => null, onNotice: () => () => undefined },
    macPermissions: { status: async () => ({ supported: true, ...grants }), request: async (kind: "screen" | "accessibility") => { grants[kind] = "granted"; return { supported: true, ...grants }; } },
  } });
}

function Cards() {
  const slot = useSidebarFooterSlot();
  const [dock, setDock] = useState<Element | null>(null);
  useEffect(() => {
    if (params.get("card") !== "connect-ai") return;
    const timer = setInterval(() => { const found = document.querySelector("[data-grok-inset]"); if (found) { setDock(found); clearInterval(timer); } }, 100);
    return () => clearInterval(timer);
  }, []);
  // ?card=app-update-available / -downloading / -ready: the sidebar's update pill, where it sits above the account row
  const update = APP_UPDATE[params.get("card") ?? ""];
  if (update && slot) return createPortal(<SidebarSpot bridge={update} />, slot);
  if (params.get("card") === "cloud-ready") return <CloudReady slot={slot} onDone={() => undefined} />;
  // ?card=cloud-nudge: the madani cloud offer as a scheduled showing puts it in the spot above the account row
  if (params.get("card") === "cloud-nudge" && slot) return createPortal(<SpotCloudCard cta={{ id: "cloud", title: "Keep your bots working", art: "clock", closeLabel: "Hide", onStart: () => undefined, onClose: () => undefined }} card={{ body: "madani cloud keeps your bots working, even when your Mac is off.", action: "Keep them working", invested: false }} />, slot);
  // ?card=toast-done / toast-error: a passing toast, held on screen
  if (params.get("card") === "toast-done") return <Toast text="Pepper is ready to use" action={{ label: "Undo", onClick: () => undefined }} timeoutMs={600_000} onDone={() => undefined} />;
  if (params.get("card") === "toast-error") return <Toast tone="error" text="Couldn't save Pepper's name. Try again." timeoutMs={600_000} onDone={() => undefined} />;
  if (params.get("card") === "connect-ai" && dock) return createPortal(<ConnectAiDialog tested={null} onClose={() => undefined} />, dock);
  return null;
}

/** A still web page for the gallery's browser tabs: a header bar, a heading and a few lines, as an SVG address. */
const page = (accent: string, heading: string, lines: number) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800">
<rect width="1280" height="800" fill="#f6f6f4"/><rect width="1280" height="72" fill="${accent}"/><rect x="48" y="24" width="140" height="24" rx="4" fill="#fafafa" opacity="0.85"/>
<text x="96" y="200" font-family="Helvetica, Arial, sans-serif" font-size="48" font-weight="700" fill="#1b1b1b">${heading}</text>
${Array.from({ length: lines }, (_, at) => `<rect x="96" y="${250 + at * 44}" width="${900 - (at % 3) * 160}" height="18" rx="9" fill="#d9d9d6"/>`).join("")}
<rect x="96" y="${280 + lines * 44}" width="220" height="56" rx="28" fill="${accent}"/></svg>`)}`;
const GALLERY_TABS = [
  { title: "Create an invoice", url: "https://www.paypal.com/invoice/create", image: page("#1f3d8a", "New invoice", 5) },
  { title: "Log in", url: "https://wise.com/login", image: page("#2f6b3a", "Log in to Wise", 3) },
  { title: "Example Domain", url: "https://example.com/", image: page("#555a63", "Example Domain", 4) },
  { title: "Example domains", url: "https://www.iana.org/help/example-domains", image: page("#8a5a1f", "Example domains", 6) },
];
// ?card=local-browser-working / -open / -held / -closed / -offer: a local bot's browser with tabs open as the
// bot browses, open and idle, with a tab the person holds, closed four minutes ago, or never opened
const localBrowser = params.get("card");
if (localBrowser === "local-browser-working") setLocalBrowserFixture({ open: true, closed: null, tabs: GALLERY_TABS, working: true });
if (localBrowser === "local-browser-open") setLocalBrowserFixture({ open: true, closed: null, tabs: GALLERY_TABS });
if (localBrowser === "local-browser-held") setLocalBrowserFixture({ open: true, closed: null, tabs: GALLERY_TABS, held: 0 });
if (localBrowser === "local-browser-closed") setLocalBrowserFixture({ open: false, closed: { at: Date.now() - 4 * 60_000, tabs: GALLERY_TABS.slice(0, 3) }, tabs: GALLERY_TABS });
if (localBrowser === "local-browser-offer") setLocalBrowserFixture({ open: false, closed: null });

Object.assign(window, { __galleryAudit: auditLayout });
createRoot(document.getElementById("root")!).render(<App><Probe /><Cards /></App>);
