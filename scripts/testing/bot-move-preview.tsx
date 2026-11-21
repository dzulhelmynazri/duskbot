// The whole app's first run as the desktop app's own window shows it: the bridge says this is the computer's own
// server, so the welcome looks for other agent apps' bots in the fixture's home.
import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { initialDesktopCapabilities } from "../../src/lib/desktop";
import { applySkinChoice, readSkinChoice } from "../../src/lib/skins";
import "../../src/styles.css";
import "../../src/styles/overlays.css";
import "../../src/styles/motion.css";

window.madaniDesktop = {
  platform: "darwin",
  remoteClient: { active: false },
  getCapabilities: async () => initialDesktopCapabilities(),
  onCapabilitiesChanged: () => () => {},
} as unknown as typeof window.madaniDesktop;
applySkinChoice(readSkinChoice());
createRoot(document.getElementById("root")!).render(<App />);
