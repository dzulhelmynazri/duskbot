import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { setEmailGateDone } from "../../src/lib/analytics";
import { GROK_MOVE_NOTICE } from "../../src/lib/notices";
import { applySkinChoice, readSkinChoice } from "../../src/lib/skins";
import { applyChatWidth, readChatWidth } from "../../src/lib/chat-width";
import { applyFont, readFont } from "../../src/lib/fonts";
import "../../src/styles.css";
import "../../src/styles/overlays.css";
import "../../src/styles/motion.css";

// This entry point is served only by the disposable verification launcher.
// The voice-latency harness opts in with ?madaniVoiceProbe=1; the recorder in
// src/lib/voice-latency-probe stays inert without this sink.
if (new URLSearchParams(location.search).has("madaniVoiceProbe")) {
  (window as typeof window & { __madaniVoiceProbe?: unknown[] }).__madaniVoiceProbe = [];
}
// ?onboarding=1 plays a brand-new install, and a new install opens in Simple mode.
else if (!new URLSearchParams(location.search).has("onboarding")) setEmailGateDone("skipped");
// Every launch is a new browser, so the once-per-browser Simple mode popup shows only with ?simpleModePrompt=1.
// The same for the once-per-person Move from Grok Bot popup, with ?grokMovePopup=1.
if (!new URLSearchParams(location.search).has("grokMovePopup")) localStorage.setItem(GROK_MOVE_NOTICE, "1");
applySkinChoice(readSkinChoice());
applyFont(readFont());
applyChatWidth(readChatWidth());
createRoot(document.getElementById("root")!).render(<App />);
