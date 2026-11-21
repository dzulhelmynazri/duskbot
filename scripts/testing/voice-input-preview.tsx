// Voice input in the real composer with a simulated recognizer: no microphone is ever opened. Levels follow a
// speech-like envelope so the waveform moves as it would while someone talks; words arrive through
// window.voiceFixture. Served only by scripts/testing/voice-input.e2e.test.ts.
import { createRoot } from "react-dom/client";
import { Composer } from "../../src/components/Composer";
import { DesktopCapabilitiesProvider } from "../../src/components/DesktopCapabilities";
import { initialDesktopCapabilities } from "../../src/lib/desktop";
import { setLocale } from "../../src/lib/i18n";
import { applySkin, SKINS } from "../../src/lib/skins";
import { setEmailGateDone } from "../../src/lib/analytics";
import { DEFAULT_VOICE_PREFS, setVoicePrefs } from "../../src/lib/voice-input/prefs";
import { StoreProvider, useStore } from "../../src/state/store";
import "../../src/styles.css";
import "../../src/styles/overlays.css";
import "../../src/styles/motion.css";

setLocale("en");
setEmailGateDone("skipped");
const params = new URLSearchParams(location.search);
applySkin(SKINS.find((one) => one.id === params.get("skin"))?.id ?? "grok");
setVoicePrefs({ ...DEFAULT_VOICE_PREFS, firstRunSeen: !params.has("firstRun") });

type Line = { text?: string; partial?: boolean };
const lines = new Set<(line: Line) => void>();
const ends = new Set<(info: { code: number; reason?: string }) => void>();
const levels = new Set<(level: number) => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let starts = 0;
let stops = 0;
let finishes = 0;

// syllables at about 4 a second inside slower phrases, with a little noise: what a voice's loudness looks like
const level = (ms: number) => {
  const s = ms / 1000;
  const phrase = Math.max(0, Math.sin(s * 1.1) * 0.6 + 0.5);
  const syllable = Math.abs(Math.sin(s * Math.PI * 4.2));
  return Math.min(1, 0.06 + phrase * syllable * 0.85 + Math.random() * 0.06);
};
const listen = () => {
  const begun = performance.now();
  timer ??= setInterval(() => levels.forEach((cb) => cb(level(performance.now() - begun))), 40);
};
const quiet = () => {
  if (timer) clearInterval(timer);
  timer = null;
};

window.madaniDesktop = {
  // ?platform=linux: no recognizer of its own and, with no listening key on the fixture's server, nothing can listen
  platform: params.get("platform") === "linux" ? "linux" : "darwin",
  permOpenSettings: async () => {},
  getCapabilities: async () => initialDesktopCapabilities(),
  speechStart: async () => { starts++; listen(); },
  speechStop: async () => { stops++; quiet(); },
  speechFinish: async () => { finishes++; quiet(); },
  onSpeechTranscript: (cb: (line: Line) => void) => { lines.add(cb); return () => lines.delete(cb); },
  onSpeechEnd: (cb: (info: { code: number }) => void) => { ends.add(cb); return () => ends.delete(cb); },
  onSpeechLevel: (cb: (level: number) => void) => { levels.add(cb); return () => levels.delete(cb); },
} as unknown as typeof window.madaniDesktop;

Object.assign(window, { voiceFixture: {
  say: (text: string, partial = true) => lines.forEach((cb) => cb({ text, partial })),
  end: (code = 0, reason = "completed") => { quiet(); ends.forEach((cb) => cb({ code, reason })); },
  stats: () => ({ starts, stops, finishes, listening: timer !== null }),
} });

function Fixture() {
  const { state } = useStore();
  const bot = state.bots.find((candidate) => !candidate.hidden);
  return (
    <main className="flex min-h-[100dvh] flex-col justify-end bg-app">
      <div className="mx-auto w-full max-w-[760px]">{bot && <Composer bot={bot} />}</div>
    </main>
  );
}
const root = createRoot(document.getElementById("root")!);
root.render(<StoreProvider><DesktopCapabilitiesProvider><Fixture /></DesktopCapabilitiesProvider></StoreProvider>);
