// The chat as the app draws it, for scripts/testing/smoothness.e2e.test.ts: the real ChatView with a few lines and two
// links over its composer, a simulated recognizer (no microphone is ever opened) and a
// layout-shift log on window.__shifts. ?firstRun shows the voice first-run sheet on the first mic press.
import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { ChatView } from "../../src/components/ChatView";
import { DesktopCapabilitiesProvider } from "../../src/components/DesktopCapabilities";
import { initialDesktopCapabilities } from "../../src/lib/desktop";
import { setLocale } from "../../src/lib/i18n";
import { applySkin, SKINS } from "../../src/lib/skins";
import { setEmailGateDone } from "../../src/lib/analytics";
import { DEFAULT_VOICE_PREFS, setVoicePrefs } from "../../src/lib/voice-input/prefs";
import { StoreProvider, useStore, type Message } from "../../src/state/store";
import "../../src/styles.css";
import "../../src/styles/overlays.css";
import "../../src/styles/motion.css";

setLocale("en");
setEmailGateDone("skipped");
const params = new URLSearchParams(location.search);
applySkin(SKINS.find((one) => one.id === params.get("skin"))?.id ?? "grok");
setVoicePrefs({ ...DEFAULT_VOICE_PREFS, firstRunSeen: !params.has("firstRun") });

const shifts: Array<{ value: number; input: boolean; at: number; sources: string[] }> = [];
new PerformanceObserver((list) => {
  for (const entry of list.getEntries() as Array<PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: Array<{ node?: Node | null }> }>) {
    shifts.push({
      value: entry.value,
      input: entry.hadRecentInput,
      at: Math.round(entry.startTime),
      sources: (entry.sources ?? []).map((source) => {
        const node = source.node instanceof Text ? source.node.parentElement : source.node;
        const what = node instanceof Element ? node.outerHTML.slice(0, 140) : String(source.node?.nodeName);
        const box = (rect: DOMRectReadOnly) => `${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)}`;
        return `${source.node instanceof Text ? "text in " : ""}${what} ${box((source as unknown as { previousRect: DOMRectReadOnly }).previousRect)} -> ${box((source as unknown as { currentRect: DOMRectReadOnly }).currentRect)}`;
      }),
    });
  }
}).observe({ type: "layout-shift", buffered: true });

let timer: ReturnType<typeof setInterval> | null = null;
const levels = new Set<(level: number) => void>();
window.madaniDesktop = {
  platform: "darwin",
  getCapabilities: async () => initialDesktopCapabilities(),
  speechStart: async () => { timer ??= setInterval(() => levels.forEach((cb) => cb(0.4 + Math.random() * 0.4)), 40); },
  speechStop: async () => { if (timer) clearInterval(timer); timer = null; },
  speechFinish: async () => { if (timer) clearInterval(timer); timer = null; },
  onSpeechTranscript: () => () => undefined,
  onSpeechEnd: () => () => undefined,
  onSpeechLevel: (cb: (level: number) => void) => { levels.add(cb); return () => levels.delete(cb); },
} as unknown as typeof window.madaniDesktop;

/** Every animation frame for `ms`: each selector's box and the styles that animate. */
function track(spec: Record<string, string>, ms: number) {
  return new Promise((resolve) => {
    const rows: unknown[] = [];
    const start = performance.now();
    const tick = (now: number) => {
      const row: Record<string, unknown> = { t: Math.round(now - start) };
      for (const [key, selector] of Object.entries(spec)) {
        const node = document.querySelector(selector);
        if (!node) { row[key] = null; continue; }
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        const laid = node instanceof HTMLElement ? `${node.offsetLeft},${node.offsetTop}` : "";
        row[key] = { laid, x: +box.x.toFixed(2), y: +box.y.toFixed(2), w: +box.width.toFixed(2), h: +box.height.toFixed(2), opacity: style.opacity, transform: style.transform, bg: style.backgroundColor };
      }
      rows.push(row);
      if (now - start < ms) requestAnimationFrame(tick); else resolve(rows);
    };
    requestAnimationFrame(tick);
  });
}
Object.assign(window, { __shifts: shifts, __track: track });

const SITE = "https://example.com/guide/getting-started";
const OTHER = "https://docs.example.org/reference";
const at = Date.UTC(2026, 10, 14, 9, 0, 0);
const LINES: Array<Pick<Message, "role" | "text">> = [
  { role: "user", text: "Where do I start with the setup?" },
  { role: "bot", text: `Here is the [getting started guide](${SITE}) you asked for. It walks through installing, signing in and sending a first message.` },
  { role: "user", text: "And the rest of the options?" },
  { role: "bot", text: `The [reference](${OTHER}) covers the rest, one page per setting.` },
];

function Fixture() {
  const { state } = useStore();
  const base = state.bots.find((candidate) => !candidate.hidden);
  const messages = useMemo(() => base ? LINES.map((line, index): Message => ({
    id: `m-${index}`, kind: "text", at: at + index * 30_000, parentId: index ? `m-${index - 1}` : null, ...(line.role === "bot" ? { turnTerminal: true } : {}), ...line,
  })) : [], [base?.id]);
  const bot = useMemo(() => base && { ...base, messages, hasMore: false, transcriptLoaded: true, busy: false }, [base, messages]);
  if (!bot) return null;
  return <div className="flex h-dvh flex-col bg-app text-ink"><div className="min-h-0 flex-1"><ChatView bot={bot} /></div></div>;
}
createRoot(document.getElementById("root")!).render(<DesktopCapabilitiesProvider><StoreProvider><Fixture /></StoreProvider></DesktopCapabilitiesProvider>);
