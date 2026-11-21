import { useSyncExternalStore } from "react";

export const CALL_VOICES = [
  { id: "af_heart", label: "Heart" },
  { id: "af_bella", label: "Bella" },
  { id: "af_sarah", label: "Sarah" },
  { id: "am_michael", label: "Michael" },
  { id: "am_fenrir", label: "Fenrir" },
  { id: "am_puck", label: "Puck" },
  { id: "bf_emma", label: "Emma" },
  { id: "bm_george", label: "George" },
] as const;
/** "account": the voice set up in Settings (ElevenLabs, Fish Audio, OpenAI…), with the bot's own voice there. */
export const ACCOUNT_VOICE = "account";
export type CallVoiceId = (typeof CALL_VOICES)[number]["id"] | typeof ACCOUNT_VOICE;

export const CALL_SPEEDS = [
  { value: 0.9, label: "call.voice.speed.slower" },
  { value: 1, label: "call.voice.speed.normal" },
  { value: 1.15, label: "call.voice.speed.faster" },
] as const;

export interface CallPrefs {
  /** Per bot, so each bot keeps its own voice. */
  voices: Record<string, CallVoiceId>;
  speed: number;
  transcript: boolean;
}

const KEY = "madanibot.voiceCall.v1";
const DEFAULTS: CallPrefs = { voices: {}, speed: 1, transcript: true };

function read(): CallPrefs {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? "null") as Partial<CallPrefs> | null;
    if (!parsed || typeof parsed !== "object") return DEFAULTS;
    const voices = Object.fromEntries(Object.entries(parsed.voices ?? {}).filter(([, id]) => id === ACCOUNT_VOICE || CALL_VOICES.some((voice) => voice.id === id))) as CallPrefs["voices"];
    const speed = CALL_SPEEDS.some((entry) => entry.value === parsed.speed) ? parsed.speed! : 1;
    return { voices, speed, transcript: parsed.transcript !== false };
  } catch {
    return DEFAULTS;
  }
}

let current = read();
const watchers = new Set<() => void>();

export function callPrefs(): CallPrefs {
  return current;
}

export function setCallPrefs(patch: Partial<CallPrefs>): void {
  current = { ...current, ...patch };
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(current));
  } catch {
  }
  for (const fn of Array.from(watchers)) fn();
}

export function voiceForBot(botId: string, prefs: CallPrefs = current): CallVoiceId {
  return prefs.voices[botId] ?? "af_heart";
}

export function useCallPrefs(): CallPrefs {
  return useSyncExternalStore(
    (fn) => {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    () => current,
    () => current,
  );
}
