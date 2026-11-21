// A speech service the person set up in Settings > Voice, heard through the page's own microphone. In the desktop app
// the main process holds the key and talks to the service; on the phone the page does, with the key from the Keychain.
import { createPieceSession, transcribeClip, type PieceSession } from "../../../electron/voice-providers.mjs";
import { voiceProviderModel, type VoiceProvider } from "../../../electron/voice-catalog.mjs";
import { createVoiceEvents, levelOf, type VoiceBridge, type VoiceEnd } from "./bridge";
import { phoneVoice } from "./device";
import { phoneKeyName } from "./keys";
import { MicError, openMic, toPcm16, type MicCapture } from "./mic-capture";
import type { VoicePrefs } from "./prefs";

export function failureReason(error: unknown): string {
  if (error instanceof MicError) return error.reason;
  const reason = (error as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" ? `service-${reason}` : "service-failed";
}

/** Desktop: audio over IPC to electron/voice-input-main.mjs. */
function desktopProvider(bridge: VoiceInputBridge, provider: VoiceProvider, prefs: VoicePrefs): VoiceBridge {
  const events = createVoiceEvents();
  let generation = 0;
  let sessionId: string | null = null;
  let mic: MicCapture | null = null;
  let offs: Array<() => void> = [];

  const teardown = () => {
    generation += 1;
    mic?.close();
    mic = null;
    offs.forEach((off) => off());
    offs = [];
    const id = sessionId;
    sessionId = null;
    return id;
  };
  const ended = (info: VoiceEnd) => {
    teardown();
    events.end(info);
  };

  return {
    async speechStart(options) {
      const old = teardown();
      if (old) void bridge.stop(old).catch(() => {});
      const gen = generation;
      // audio heard before the session answers waits here, so the first word is never lost
      const early: ArrayBuffer[] = [];
      offs.push(bridge.onTranscript((event) => {
        if (gen === generation && event.id === sessionId) events.transcript({ partial: event.partial, text: event.text });
      }));
      offs.push(bridge.onEnd((event) => {
        if (gen === generation && event.id === sessionId) ended({ code: event.code, reason: event.reason, message: event.message });
      }));
      const opening = openMic((frame) => {
        if (gen !== generation) return;
        events.level(levelOf(frame));
        const pcm = toPcm16(frame).buffer as ArrayBuffer;
        if (sessionId) bridge.audio(sessionId, pcm);
        else early.push(pcm);
      });
      const starting = bridge.start({
        provider,
        language: options?.locale || prefs.language || undefined,
        model: voiceProviderModel(provider, prefs.models[provider]),
        realtime: prefs.realtime,
        baseUrl: prefs.compatBaseUrl || undefined,
        whisperCpp: provider === "whisper-cpp" ? prefs.whisperCpp : undefined,
      });
      const [micResult, sessionResult] = await Promise.allSettled([opening, starting]);
      if (gen !== generation) {
        if (micResult.status === "fulfilled") micResult.value.close();
        if (sessionResult.status === "fulfilled") void bridge.stop(sessionResult.value.id).catch(() => {});
        return;
      }
      if (micResult.status === "fulfilled") mic = micResult.value;
      if (sessionResult.status === "fulfilled") sessionId = sessionResult.value.id;
      if (micResult.status === "rejected" || sessionResult.status === "rejected") {
        const id = sessionId;
        if (id) void bridge.stop(id).catch(() => {});
        if (micResult.status === "rejected") return ended({ code: 1, reason: failureReason(micResult.reason) });
        // Electron hands back only the text of a refused start: it is always a setup step still to do, worded by main
        const said = String(((sessionResult as PromiseRejectedResult).reason as Error)?.message ?? "")
          .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
        return ended({ code: 1, reason: "service-not-set-up", message: said || undefined });
      }
      for (const pcm of early.splice(0)) bridge.audio(sessionId!, pcm);
    },
    async speechStop() {
      const id = teardown();
      if (id) await bridge.stop(id).catch(() => {});
    },
    async speechFinish() {
      mic?.close();
      mic = null;
      if (sessionId) await bridge.finish(sessionId).catch(() => ended({ code: 1, reason: "service-failed" }));
    },
    onSpeechTranscript: events.onSpeechTranscript,
    onSpeechEnd: events.onSpeechEnd,
    onSpeechLevel: events.onSpeechLevel,
  };
}

/** Phone: the page sends each piece itself through the native HTTP stack (no CORS), the key read from the Keychain. */
function phoneProvider(provider: VoiceProvider, prefs: VoicePrefs, secrets: NonNullable<ReturnType<typeof phoneVoice>>["secrets"]): VoiceBridge {
  const events = createVoiceEvents();
  let generation = 0;
  let mic: MicCapture | null = null;
  let session: PieceSession | null = null;

  const teardown = () => {
    generation += 1;
    mic?.close();
    mic = null;
    session?.stop();
    session = null;
  };
  const ended = (info: VoiceEnd) => {
    teardown();
    events.end(info);
  };

  return {
    async speechStart(options) {
      teardown();
      const gen = generation;
      const key = await secrets.get(phoneKeyName(provider)).catch(() => null);
      if (gen !== generation) return;
      const piece = createPieceSession({
        transcribe: (wav, signal) => transcribeClip({
          provider, wav, key: key ?? undefined, signal,
          model: voiceProviderModel(provider, prefs.models[provider]),
          language: options?.locale || prefs.language || undefined,
          baseUrl: prefs.compatBaseUrl || undefined,
        }),
        onText: (text, partial) => {
          if (gen === generation) events.transcript({ partial, text });
        },
        onError: (error) => {
          if (gen === generation) ended({ code: 1, reason: failureReason(error), message: (error as Error)?.message });
        },
      });
      session = piece;
      try {
        const opened = await openMic((frame) => {
          if (gen !== generation) return;
          events.level(levelOf(frame));
          piece.push(toPcm16(frame));
        });
        if (gen === generation) mic = opened;
        else opened.close();
      } catch (error) {
        if (gen === generation) ended({ code: 1, reason: failureReason(error) });
      }
    },
    async speechStop() {
      teardown();
    },
    async speechFinish() {
      const gen = generation;
      mic?.close();
      mic = null;
      const piece = session;
      if (!piece) return;
      await piece.finish().catch(() => {});
      if (gen === generation) ended({ code: 0, reason: "completed" });
    },
    onSpeechTranscript: events.onSpeechTranscript,
    onSpeechEnd: events.onSpeechEnd,
    onSpeechLevel: events.onSpeechLevel,
  };
}

const bridges = new Map<string, VoiceBridge>();

/** One bridge per service and settings, so listeners and a running session survive re-renders. */
export function providerBridge(provider: VoiceProvider, prefs: VoicePrefs): VoiceBridge | null {
  const phone = phoneVoice();
  const desktop = typeof window === "undefined" ? undefined : window.madaniDesktop?.voiceInput;
  if (!phone && !desktop) return null;
  const cacheKey = JSON.stringify([phone ? "phone" : "desktop", provider, prefs.language, prefs.models[provider] ?? "", prefs.realtime, prefs.compatBaseUrl, prefs.whisperCpp]);
  let bridge = bridges.get(cacheKey);
  if (!bridge) {
    bridge = phone ? phoneProvider(provider, prefs, phone.secrets) : desktopProvider(desktop!, provider, prefs);
    bridges.set(cacheKey, bridge);
  }
  return bridge;
}
