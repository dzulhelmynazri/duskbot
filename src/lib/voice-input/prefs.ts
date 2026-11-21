// Settings > Voice, kept on this device: voice input runs where the person is, so a phone and a Mac can each hear
// differently. Keys are never here (keys.ts keeps them in the device's secret storage).
import { useSyncExternalStore } from "react";
import { isVoiceProvider, type VoiceProvider } from "../../../electron/voice-catalog.mjs";

export interface VoicePrefs {
  /** "system": the device's own recognizer. */
  engine: "system" | VoiceProvider;
  /** A BCP 47 tag such as "en-US"; "" follows the device's language. */
  language: string;
  /** A model per service; unset uses the service's default. */
  models: Partial<Record<VoiceProvider, string>>;
  /** ElevenLabs: stream words while talking (true) or send each piece when it ends. */
  realtime: boolean;
  /** An OpenAI-compatible service's address, such as https://example.com/v1. */
  compatBaseUrl: string;
  whisperCpp: { binary: string; model: string };
  /** Off by default: a quick model tidies punctuation and filler words after the words land. */
  cleanup: { on: boolean; instanceId: string; model: string };
  /** The first tap's sheet was seen. */
  firstRunSeen: boolean;
}

export const DEFAULT_VOICE_PREFS: VoicePrefs = {
  engine: "system",
  language: "",
  models: {},
  realtime: true,
  compatBaseUrl: "",
  whisperCpp: { binary: "", model: "" },
  cleanup: { on: false, instanceId: "", model: "" },
  firstRunSeen: false,
};

export const VOICE_PREFS_KEY = "madanibot.voice-input.v1";
const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

const text = (value: unknown, max = 500) => (typeof value === "string" ? value.trim().slice(0, max) : "");

/** A stored document read defensively: anything mistyped falls back to its default rather than breaking voice. */
export function parseVoicePrefs(raw: unknown): VoicePrefs {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const models: Partial<Record<VoiceProvider, string>> = {};
  if (value.models && typeof value.models === "object") {
    for (const [provider, model] of Object.entries(value.models as Record<string, unknown>)) {
      if (isVoiceProvider(provider) && text(model, 200)) models[provider] = text(model, 200);
    }
  }
  const whisper = (value.whisperCpp ?? {}) as Record<string, unknown>;
  const cleanup = (value.cleanup ?? {}) as Record<string, unknown>;
  const language = text(value.language, 35);
  return {
    engine: value.engine === "system" || isVoiceProvider(value.engine) ? value.engine : "system",
    language: LANGUAGE.test(language) ? language : "",
    models,
    realtime: value.realtime !== false,
    compatBaseUrl: text(value.compatBaseUrl, 2_000),
    whisperCpp: { binary: text(whisper.binary, 2_000), model: text(whisper.model, 2_000) },
    cleanup: { on: cleanup.on === true, instanceId: text(cleanup.instanceId, 200), model: text(cleanup.model, 500) },
    firstRunSeen: value.firstRunSeen === true,
  };
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

let cached: { raw: string | null; prefs: VoicePrefs } | null = null;
// where storage is missing or refuses writes, the choices still hold for this session
let memory: string | null = null;
const listeners = new Set<() => void>();

export function voicePrefs(): VoicePrefs {
  let raw = memory;
  try {
    raw = storage()?.getItem(VOICE_PREFS_KEY) ?? memory;
  } catch {
  }
  if (cached && cached.raw === raw) return cached.prefs;
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
  }
  cached = { raw, prefs: parseVoicePrefs(parsed) };
  return cached.prefs;
}

export function setVoicePrefs(change: Partial<VoicePrefs> | ((current: VoicePrefs) => Partial<VoicePrefs>)): VoicePrefs {
  const current = voicePrefs();
  const next = parseVoicePrefs({ ...current, ...(typeof change === "function" ? change(current) : change) });
  memory = JSON.stringify(next);
  try {
    storage()?.setItem(VOICE_PREFS_KEY, memory);
  } catch {
  }
  cached = null;
  for (const listener of listeners) listener();
  return next;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === VOICE_PREFS_KEY) listener();
  };
  globalThis.addEventListener?.("storage", onStorage);
  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener?.("storage", onStorage);
  };
}

export function useVoicePrefs(): VoicePrefs {
  return useSyncExternalStore(subscribe, voicePrefs, () => DEFAULT_VOICE_PREFS);
}
