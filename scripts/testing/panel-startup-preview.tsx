import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { setEmailGateDone } from "../../src/lib/analytics";
import { GROK_MOVE_NOTICE } from "../../src/lib/notices";
import "../../src/styles.css";
import "../../src/styles/overlays.css";
import "../../src/styles/motion.css";

setEmailGateDone("skipped");
localStorage.setItem(GROK_MOVE_NOTICE, "1");
localStorage.setItem("madanibot.botPanelOpen.v1", "1");
// the desktop app showing the person's own server: since e0cf9eed2 a bot on this computer has no screen to show, and
// this preview checks the screen's first paint (as vps-cloud-move-preview.tsx does)
window.madaniDesktop = { app: { version: "preview", ownPage: false } } as unknown as typeof window.madaniDesktop;
const probe = { firstChatAt: null as number | null, mascotAtFirstChat: false, panelAtFirstChat: false };
Object.assign(window, { __panelStartupProbe: probe });
const observer = new MutationObserver(() => {
  if (probe.firstChatAt !== null || !document.querySelector('textarea[aria-label="Message Pepper"]')) return;
  probe.firstChatAt = performance.now();
  probe.panelAtFirstChat = Boolean(document.querySelector('[data-panel-slot="open"]'));
  probe.mascotAtFirstChat = Boolean(document.querySelector('[data-panel-slot="open"] [data-panel-avatar]'));
});
observer.observe(document.getElementById("root")!, { childList: true, subtree: true });
createRoot(document.getElementById("root")!).render(<App />);
