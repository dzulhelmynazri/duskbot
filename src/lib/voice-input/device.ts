// Where voice input runs: the desktop app, the phone app, or a browser tab. The phone registers itself when it boots
// (src/mobile/MobileApp.tsx), so shared code never imports the native plugins.
import { desktopCapabilitiesNow } from "../desktop";
import type { VoiceBridge } from "./bridge";
import type { SystemEngine, VoiceDevice } from "./engines";

export interface PhoneSecrets {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface PhoneVoice {
  os: "ios" | "android";
  /** The phone's own recognizer through the app's native plugin; absent in a build without it. */
  speech?: VoiceBridge;
  /** Keychain or Keystore. */
  secrets: PhoneSecrets;
  /** Opens the app's page in the phone's Settings, for a refused microphone. */
  openSettings?(): Promise<void>;
}

let phone: PhoneVoice | null = null;
const phoneListeners = new Set<() => void>();

export function registerPhoneVoice(next: PhoneVoice | null): void {
  phone = next;
  for (const listener of phoneListeners) listener();
}

export function phoneVoice(): PhoneVoice | null {
  return phone;
}

export function onPhoneVoice(listener: () => void): () => void {
  phoneListeners.add(listener);
  return () => {
    phoneListeners.delete(listener);
  };
}

type RecognitionConstructor = new () => SpeechRecognitionLike;
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export function webRecognition(): RecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const found = (window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor });
  return found.SpeechRecognition ?? found.webkitSpeechRecognition ?? null;
}

const DESKTOP_SYSTEM: Record<string, SystemEngine | undefined> = {
  "apple-speech": "apple-speech",
  "windows-speech": "windows-speech",
  "fish-audio": "fish-audio",
};

export function currentVoiceDevice(): VoiceDevice {
  if (phone) return { kind: "phone", os: phone.os, system: phone.speech ? "phone-native" : null, providers: true };
  const desktop = typeof window === "undefined" ? undefined : window.madaniDesktop;
  if (desktop?.platform) {
    const capabilities = desktopCapabilitiesNow();
    const os = desktop.platform === "darwin" ? "mac" : desktop.platform === "win32" ? "windows" : "linux";
    const system = capabilities.dictation.available ? DESKTOP_SYSTEM[capabilities.dictation.engine] ?? null : null;
    return { kind: "desktop", os, system, providers: Boolean(desktop.voiceInput) && !capabilities.remote };
  }
  // Electron's own Web Speech needs Google keys it does not ship, so only a real browser offers it
  return { kind: "browser", system: webRecognition() ? "web-speech" : null, providers: false };
}
