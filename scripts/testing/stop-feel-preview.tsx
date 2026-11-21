// The chat as the app draws it, live against the fixture server, for scripts/testing/stop-feel.e2e.test.ts: the real
// ChatView of the first bot, its transcript and turns coming from the server's own frames, so a reply streams and a Stop
// travels the real path. window.__track records boxes and styles every animation frame; window.__marks timestamps.
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { ChatView } from "../../src/components/ChatView";
import { DesktopCapabilitiesProvider } from "../../src/components/DesktopCapabilities";
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
// ?lag=400 holds each Stop that long on its way out, as the owner's app answered its calls (about 400 ms in its trail)
const lag = Number(params.get("lag")) || 0;
if (lag) {
  const send = window.fetch.bind(window);
  window.fetch = (input, init) => String(input instanceof Request ? input.url : input).endsWith("/interrupt")
    ? new Promise((done) => setTimeout(done, lag)).then(() => send(input, init)) : send(input, init);
}
window.madaniDesktop = {
  platform: "darwin",
  getCapabilities: async () => initialDesktopCapabilities(),
} as unknown as typeof window.madaniDesktop;

/** Every animation frame for `ms`: each selector's presence, box, opacity and the text of `text` selectors. */
function track(spec: Record<string, string>, ms: number) {
  return new Promise((resolve) => {
    const rows: unknown[] = [];
    const start = performance.now();
    const tick = (now: number) => {
      const row: Record<string, unknown> = { t: Math.round(now - start) };
      for (const [key, selector] of Object.entries(spec)) {
        const nodes = document.querySelectorAll(selector);
        const node = nodes[nodes.length - 1];
        if (!node) { row[key] = null; continue; }
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        row[key] = { n: nodes.length, y: +box.y.toFixed(1), h: +box.height.toFixed(1), opacity: style.opacity, transform: style.transform, text: (node.textContent ?? "").length };
      }
      rows.push(row);
      if (now - start < ms) requestAnimationFrame(tick); else resolve(rows);
    };
    requestAnimationFrame(tick);
  });
}
Object.assign(window, { __track: track });

function Fixture() {
  const { state, dispatch } = useStore();
  const bot = state.bots.find((candidate) => !candidate.hidden);
  useEffect(() => { if (bot && state.selectedId !== bot.id) dispatch({ type: "select", id: bot.id }); }, [bot?.id, state.selectedId]);
  if (!bot) return null;
  return <div className="flex h-dvh flex-col bg-app text-ink"><div className="min-h-0 flex-1"><ChatView bot={bot} /></div></div>;
}
createRoot(document.getElementById("root")!).render(<DesktopCapabilitiesProvider><StoreProvider><Fixture /></StoreProvider></DesktopCapabilitiesProvider>);
