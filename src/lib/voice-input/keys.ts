// Speech service keys live in this device's secret storage: the desktop app's credential store (sealed by the OS
// keychain, read only by its main process) or the phone's Keychain/Keystore. Never localStorage, never the server.
import { useEffect, useState } from "react";
import { VOICE_PROVIDERS, VOICE_PROVIDER_INFO, type VoiceProvider } from "../../../electron/voice-catalog.mjs";
import { phoneVoice } from "./device";
import type { KeyState } from "./engines";

export interface VoiceKeyStore {
  status(): Promise<KeyState>;
  set(provider: VoiceProvider, key: string): Promise<void>;
  clear(provider: VoiceProvider): Promise<void>;
}

export const phoneKeyName = (provider: VoiceProvider) => `voice.${provider}`;
const keyed = VOICE_PROVIDERS.filter((provider) => VOICE_PROVIDER_INFO[provider].key !== "none");

export function voiceKeyStore(): VoiceKeyStore | null {
  const phone = phoneVoice();
  if (phone) {
    return {
      async status() {
        const found = await Promise.all(keyed.map(async (provider) => [provider, Boolean(await phone.secrets.get(phoneKeyName(provider)).catch(() => null))] as const));
        return Object.fromEntries(found);
      },
      set: (provider, key) => phone.secrets.set(phoneKeyName(provider), key.trim()),
      clear: (provider) => phone.secrets.remove(phoneKeyName(provider)),
    };
  }
  const desktop = typeof window === "undefined" ? undefined : window.madaniDesktop?.voiceInput;
  return desktop ? desktop.keys : null;
}

let known: KeyState = {};
const listeners = new Set<(state: KeyState) => void>();

export async function refreshVoiceKeys(): Promise<KeyState> {
  const store = voiceKeyStore();
  known = store ? await store.status().catch(() => known) : {};
  for (const listener of listeners) listener(known);
  return known;
}

export function voiceKeysNow(): KeyState {
  return known;
}

/** Which services have a key on this device, refreshed on mount and after every save. */
export function useVoiceKeys(): KeyState {
  const [state, setState] = useState<KeyState>(known);
  useEffect(() => {
    listeners.add(setState);
    void refreshVoiceKeys();
    return () => {
      listeners.delete(setState);
    };
  }, []);
  return state;
}

export async function saveVoiceKey(provider: VoiceProvider, key: string): Promise<void> {
  const store = voiceKeyStore();
  if (!store) throw new Error("no-secret-storage");
  if (key.trim()) await store.set(provider, key.trim());
  else await store.clear(provider);
  await refreshVoiceKeys();
}
