// Dev-only page for the notch and dock setup step, served at /src/windows/previews/island-intro-preview.html; not in the packaged app.
// A fake island bridge stands in for the desktop app's, so it never touches a real one.
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { IslandIntro } from "@/components/onboarding/IslandIntro";
import { setLocale } from "@/lib/i18n";
import type { AmbientAppBridge, AmbientPrefs } from "@/ambient/types";
import "./font-faces.css";
import "./styles.css";

/** ?skin=daylight&reduced=1&fail=1&lang=de&w=1338&h=870 */
const params = new URLSearchParams(location.search);
const prefs: AmbientPrefs = { available: true, platform: "darwin", island: false, dock: true, size: "medium", display: "active", order: [], displays: [] };
const listeners = new Set<() => void>();
const bridge: Partial<AmbientAppBridge> = {
  prefs: async () => ({ ...prefs }),
  set: async (change) => {
    await new Promise((resolve) => setTimeout(resolve, 120));
    if (params.get("fail") === "1" && change.island === true && prefs.island) throw new Error("failed");
    Object.assign(prefs, change);
    listeners.forEach((listener) => listener());
    return { ...prefs };
  },
};
(window as unknown as { madaniDesktop: unknown }).madaniDesktop = { ambient: bridge };

function Preview() {
  const [run, setRun] = useState(0);
  const [, redraw] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    const listener = () => redraw((now) => now + 1);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  const width = Number(params.get("w")) || 1338;
  const height = Number(params.get("h")) || 870;
  return (
    <div className="min-h-screen bg-app p-6 text-ink">
      <header className="mb-4 flex items-center gap-4 text-[13px] text-ink-secondary">
        <span data-real-island={prefs.island ? "on" : "off"}>Real island: {prefs.island ? "on" : "off"} · dock: {prefs.dock ? "on" : "off"}{picked ? ` · picked ${picked}` : ""}</span>
        <button className="rounded-lg bg-raised px-3 py-1.5 text-ink" onClick={() => { prefs.island = false; setPicked(null); setRun((now) => now + 1); }}>Replay</button>
      </header>
      <div className="relative flex overflow-hidden rounded-xl border border-transparent bg-app" style={{ width, height }}>
        <IslandIntro key={run} onDone={(choice) => setPicked(choice)} />
      </div>
    </div>
  );
}

document.documentElement.dataset.skin = params.get("skin") ?? "daylight";
document.documentElement.dataset.reducedMotion = params.get("reduced") === "1" ? "true" : "false";
setLocale(params.get("lang") ?? "en");
createRoot(document.getElementById("root")!).render(<StrictMode><Preview /></StrictMode>);
