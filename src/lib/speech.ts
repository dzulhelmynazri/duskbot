import { keyEntry, savedState } from "@/components/keys/key-catalog";
import type { ConfigStatus } from "@/state/store";
import { desktopCapabilitiesNow } from "./desktop";
import { fishSpeech, type SpeechBridge } from "./fish-speech";

/** The speech bridge this computer listens through: the page's own Fish Audio listener, or the desktop app's helper. */
export function speechBridge(): SpeechBridge | Window["madaniDesktop"] {
  return desktopCapabilitiesNow().dictation.engine === "fish-audio" ? fishSpeech : globalThis.window?.madaniDesktop;
}

/** Whether the bot's server can turn a clip into text: a Fish Audio key, or any other listening key it reports. */
export function serverListeningReady(config: ConfigStatus | null | undefined): boolean {
  return savedState(keyEntry("fishAudio"), config).configured || config?.tts?.listen?.ready === true;
}

/** Whether speech can be heard here: the engine is there and, through the server, so is a listening key. */
export function listensHere(capabilities: DesktopCapabilities, config: ConfigStatus | null | undefined): boolean {
  return capabilities.dictation.available && (capabilities.dictation.engine !== "fish-audio" || serverListeningReady(config));
}
