import { useSyncExternalStore } from "react";

/** Grok's voice-chat speeds, in its order. */
export const VOICE_SPEEDS = ["0.5", "0.75", "1", "1.25", "1.5", "2"] as const;
export type VoiceSpeed = (typeof VOICE_SPEEDS)[number];
/** Grok's speeds and the call bar's Slower and Faster, which also set a bot's own speed. */
const KNOWN_SPEEDS: readonly string[] = [...VOICE_SPEEDS, "0.9", "1.15"];

/** Grok's voice-chat languages, in its order; "auto" is Auto-detect. */
export const VOICE_LANGUAGES = [
  ["auto", "Auto-detect"], ["en", "English"], ["ar-EG", "Arabic (Egypt)"], ["ar-SA", "Arabic (Saudi Arabia)"], ["ar-AE", "Arabic (United Arab Emirates)"],
  ["bn", "Bengali"], ["ca", "Catalan"], ["zh-CN", "Chinese (Simplified)"], ["da", "Danish"], ["nl", "Dutch"], ["fi", "Finnish"], ["fr", "French"],
  ["de", "German"], ["hi", "Hindi"], ["hu", "Hungarian"], ["id", "Indonesian"], ["it", "Italian"], ["ja", "Japanese"], ["ko", "Korean"], ["pl", "Polish"],
  ["pt-BR", "Portuguese (Brazil)"], ["pt-PT", "Portuguese (Portugal)"], ["ru", "Russian"], ["es-MX", "Spanish (Mexico)"], ["es-ES", "Spanish (Spain)"],
  ["sv", "Swedish"], ["th", "Thai"], ["tr", "Turkish"], ["vi", "Vietnamese"],
] as const;

/** A bot's own call speed and language; a field the person never set is missing, so the call keeps its global one. */
export interface VoicePrefs { speed?: string; language?: string }

const key = (botId: string) => `madanibot.voicePrefs.v1:${botId}`;
const watchers = new Set<() => void>();
const cache = new Map<string, VoicePrefs>();

function read(botId: string): VoicePrefs {
  const cached = cache.get(botId);
  if (cached) return cached;
  let prefs: VoicePrefs = {};
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(key(botId)) ?? "null") as Partial<VoicePrefs> | null;
    if (raw) {
      prefs = {
        ...(KNOWN_SPEEDS.includes(raw.speed ?? "") ? { speed: raw.speed } : {}),
        ...(VOICE_LANGUAGES.some(([code]) => code === raw.language) ? { language: raw.language } : {}),
      };
    }
  } catch {
    prefs = {};
  }
  cache.set(botId, prefs);
  return prefs;
}

export function setVoicePrefs(botId: string, patch: VoicePrefs): void {
  const next = { ...read(botId), ...patch };
  cache.set(botId, next);
  try { globalThis.localStorage?.setItem(key(botId), JSON.stringify(next)); } catch { /* private mode keeps it in memory */ }
  for (const watch of Array.from(watchers)) watch();
}

export function voicePrefs(botId: string): VoicePrefs {
  return read(botId);
}

/** The speed a call with this bot speaks at: its own when set, else `fallback` (the call's global speed). */
export function callSpeedFor(prefs: VoicePrefs, fallback: number): number {
  const own = Number(prefs.speed);
  return prefs.speed && Number.isFinite(own) && own > 0 ? own : fallback;
}

/** The language a call with this bot listens and speaks in; undefined for Auto-detect. */
export function callLanguageFor(prefs: VoicePrefs): string | undefined {
  return prefs.language && prefs.language !== "auto" ? prefs.language : undefined;
}

const NONE: VoicePrefs = {};

export function useVoicePrefs(botId: string): VoicePrefs {
  return useSyncExternalStore(
    (watch) => { watchers.add(watch); return () => { watchers.delete(watch); }; },
    () => read(botId),
    () => NONE,
  );
}
