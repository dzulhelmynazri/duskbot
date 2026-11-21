// The engine this device listens through right now, and the bridge that speaks for it.
import { fishSpeech } from "../fish-speech";
import type { VoiceBridge } from "./bridge";
import { currentVoiceDevice, phoneVoice } from "./device";
import { resolveEngine, type KeyState, type ResolvedEngine } from "./engines";
import type { VoicePrefs } from "./prefs";
import { providerBridge } from "./provider-bridge";
import { createWebSpeech } from "./web-speech";

let webSpeech: VoiceBridge | null = null;

export function currentEngine(prefs: VoicePrefs, keys: KeyState, serverListens = false): ResolvedEngine {
  return resolveEngine(prefs, currentVoiceDevice(), keys, serverListens);
}

export function voiceBridgeFor(engine: ResolvedEngine, prefs: VoicePrefs): VoiceBridge | null {
  if (engine.kind === "provider") return providerBridge(engine.provider, prefs);
  if (engine.kind === "none") return null;
  switch (engine.engine) {
    case "apple-speech":
    case "windows-speech":
      return (globalThis.window?.madaniDesktop as VoiceBridge | undefined) ?? null;
    case "fish-audio":
      return fishSpeech;
    case "phone-native":
      return phoneVoice()?.speech ?? null;
    case "web-speech":
      return (webSpeech ??= createWebSpeech());
  }
}
