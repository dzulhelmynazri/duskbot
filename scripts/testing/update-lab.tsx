// The update lab: the real sidebar update pill (src/components/SidebarSpot.tsx) in every state, and a pretend release
// to click through each flow (a download that finishes, one that drops and resumes, one that fails, a copy that has to
// move to Applications, Windows and Linux). Nothing is downloaded or installed. Without ?skin= it shows the page twice,
// light and dark, side by side. Built by scripts/testing/update-lab.vite.config.ts.
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import { RailSpot, SpotView, spotFor, useSidebarSpot } from "../../src/components/SidebarSpot";
import { applySkin } from "../../src/lib/skins";
import type { AppUpdateBridge, AppUpdateState } from "../../electron/app-update.mjs";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const skin = params.get("skin");
const VERSION = "0.2.16";
const EXE = `https://madani.bot/releases/${VERSION}/MadaniBot-${VERSION}-setup.exe`;
const DEB = `https://madani.bot/releases/${VERSION}/MadaniBot-${VERSION}-amd64.deb`;

type Flow = "mac" | "mac-drop" | "mac-fail" | "mac-move" | "windows" | "linux";
const FLOWS: { id: Flow; label: string }[] = [
  { id: "mac", label: "Mac: downloads, then restart" },
  { id: "mac-drop", label: "Mac: connection drops, resumes" },
  { id: "mac-fail", label: "Mac: download fails" },
  { id: "mac-move", label: "Mac: running from Downloads" },
  { id: "windows", label: "Windows" },
  { id: "linux", label: "Linux" },
];

/** a pretend main process for one flow: the same bridge the preload gives the page, driven by timers */
function pretendBridge(flow: Flow, say: (line: string) => void): AppUpdateBridge {
  const self = flow.startsWith("mac");
  let state: AppUpdateState = { ready: null, available: null, progress: null, checking: false, failed: false, retrying: false, blocked: null, manual: null, mode: self ? "self" : "notice" };
  const listeners = new Set<(s: AppUpdateState) => void>();
  const set = (patch: Partial<AppUpdateState>) => { state = { ...state, ...patch }; for (const cb of listeners) cb(state); };
  const later = (ms: number, fn: () => void) => window.setTimeout(fn, ms);
  // the hourly check finds the release a moment after the page opens
  later(700, () => {
    if (flow === "mac-move") return set({ available: VERSION, blocked: "move" });
    if (flow === "windows") return set({ available: VERSION, manual: { version: VERSION, url: EXE } });
    if (flow === "linux") return set({ available: VERSION, manual: { version: VERSION, url: DEB } });
    set({ available: VERSION });
  });
  return {
    state: async () => state,
    onState: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    download: () => new Promise((resolve) => {
      set({ checking: true, failed: false });
      let progress = 0, dropped = false;
      const tick = () => {
        progress = Math.min(0.99, progress + 0.04);
        if (flow === "mac-drop" && !dropped && progress >= 0.4) {
          dropped = true;
          set({ progress: Math.floor(progress * 100) / 100, retrying: true });
          say("the connection dropped at 40%; the next try asks for the rest only (Range: bytes=...-)");
          return later(2200, () => { set({ retrying: false }); tick(); });
        }
        if (flow === "mac-fail" && progress >= 0.6) {
          set({ progress: null, checking: false, failed: true });
          say("every try failed (GitHub, then madani.bot); the pill offers the download page instead of trying again in silence");
          return resolve(null);
        }
        set({ progress: Math.floor(progress * 100) / 100 });
        if (progress >= 0.99) return later(400, () => { set({ progress: null, checking: false, ready: VERSION }); resolve(VERSION); });
        later(120, tick);
      };
      later(300, tick);
    }),
    restart: async () => {
      say(`restarting into ${VERSION}...`);
      later(1500, () => set({ ready: null, available: null, updated: VERSION }));
      return true;
    },
    seen: async () => set({ updated: null }),
    open: async () => { say(`opens ${state.manual?.url ?? "https://madani.bot/download"} in the browser`); return true; },
    move: async () => { say("moves the app to /Applications and relaunches it from there (Electron's app.moveToApplicationsFolder)"); return true; },
  };
}

const STILLS: { label: string; state: AppUpdateState; asked?: boolean }[] = [
  { label: "checking", state: { ready: null, checking: true }, asked: true },
  { label: "available", state: { ready: null, available: VERSION } },
  { label: "downloading", state: { ready: null, available: VERSION, progress: 0.37, checking: true } },
  { label: "paused, retrying", state: { ready: null, available: VERSION, progress: 0.42, retrying: true, checking: true } },
  { label: "ready", state: { ready: VERSION, available: VERSION } },
  { label: "failed", state: { ready: null, available: VERSION, failed: true } },
  { label: "move to Applications", state: { ready: null, available: VERSION, blocked: "move" } },
  { label: "Windows / Linux", state: { ready: null, available: VERSION, manual: { version: VERSION, url: EXE } } },
];

const Column = ({ children }: { children: React.ReactNode }) => <div className="w-[260px] rounded-2xl bg-panel p-3">{children}</div>;

function Live({ flow }: { flow: Flow }) {
  const [lines, setLines] = useState<string[]>([]);
  const bridge = useMemo(() => pretendBridge(flow, (line) => setLines((all) => [...all.slice(-3), line])), [flow]);
  const state = useSidebarSpot(bridge);
  return (
    <div className="flex flex-wrap items-start gap-4">
      <Column><SpotView state={state} /></Column>
      <Column><div className="flex justify-center"><RailSpot bridge={bridge} /></div></Column>
      <div className="min-w-[260px] flex-1 space-y-1 text-[13px] text-ink-secondary" data-lab-log="">
        <div>pill: <code data-lab-state="">{state.spot.kind}</code></div>
        {lines.map((line, i) => <div key={i}>{line}</div>)}
      </div>
    </div>
  );
}

function Lab() {
  const [flow, setFlow] = useState<Flow>((params.get("flow") as Flow) || "mac");
  const [run, setRun] = useState(0);
  useEffect(() => { document.title = "update pill lab"; }, []);
  return (
    <div className="min-h-screen bg-app p-6 text-ink">
      <h1 className="mb-1 text-[18px] font-semibold">Update pill lab ({skin === "grok-dark" ? "dark" : "light"})</h1>
      <p className="mb-4 text-[13px] text-ink-secondary">The real sidebar pill. Pick a flow, then click the pill to step through it. Nothing is downloaded.</p>
      <div className="mb-4 flex flex-wrap gap-2">
        {FLOWS.map((f) => (
          <button key={f.id} type="button" data-lab-flow={f.id} onClick={() => { setFlow(f.id); setRun((n) => n + 1); }}
            className={`rounded-full px-3 py-1.5 text-[13px] ${f.id === flow ? "bg-ink text-app" : "bg-composer text-ink"}`}>{f.label}</button>
        ))}
      </div>
      <Live key={`${flow}-${run}`} flow={flow} />
      <h2 className="mb-2 mt-8 text-[15px] font-semibold">Every state</h2>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
        {STILLS.map(({ label, state, asked }) => (
          <div key={label} data-lab-still={label}>
            <div className="mb-1 text-[12px] text-ink-secondary">{label}</div>
            <Column><SpotView state={{ spot: spotFor(state, asked ?? false, false), act: () => undefined, updated: null, seen: () => undefined, bridge: undefined }} /></Column>
          </div>
        ))}
        <div data-lab-still="updated">
          <div className="mb-1 text-[12px] text-ink-secondary">after the restart</div>
          <Column><SpotView state={{ spot: { kind: "feedback" }, act: () => undefined, updated: VERSION, seen: () => undefined, bridge: undefined }} /></Column>
        </div>
      </div>
    </div>
  );
}

function Both() {
  const frame = (s: string) => <iframe title={s} src={`?skin=${s}`} className="h-[1100px] min-w-[560px] flex-1 border-0" />;
  return <div className="flex min-h-screen flex-wrap bg-black/5">{frame("grok")}{frame("grok-dark")}</div>;
}

if (skin) applySkin(skin === "grok-dark" ? "grok-dark" : "grok");
createRoot(document.getElementById("root")!).render(skin ? <Lab /> : <Both />);
