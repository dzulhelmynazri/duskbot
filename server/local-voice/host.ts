import { createLocalVoiceRoutes } from "../routes/local-voice.ts";
import type { RouteHandler } from "../routes/table.ts";
import { isBuiltInVoice, ortInstalled, DEFAULT_VOICE } from "./engine.ts";
import { ModelStore } from "./models.ts";
import { onBattery, startPrefetch } from "./prefetch.ts";
import { createVoiceProcess, type VoiceProcess } from "./voice-process.ts";

export function localVoiceRoutes({ busy, prefetch, models = new ModelStore(), engine = createVoiceProcess({ modelDir: models.dir, log: (line) => console.warn(line) }), installed = ortInstalled() }: {
  busy: () => boolean;
  /** Fetch the models in the background while nothing is going on (the desktop app's own harness, a Cloud). */
  prefetch: boolean;
  models?: ModelStore;
  engine?: VoiceProcess;
  installed?: boolean;
}): RouteHandler {
  const halves = () => ({ hear: models.ready("hear"), speak: models.ready("speak") });
  if (installed && engine.usable() && prefetch && process.env.MADANI_VOICE_PREFETCH !== "0" && !process.env.VITEST) {
    startPrefetch({ models, busy, onBattery: () => onBattery(), warm: () => engine.warm(halves()) });
  }
  return createLocalVoiceRoutes({
    available: async () => installed && engine.usable(),
    status: () => models.status(),
    prepare: async () => {
      await engine.warm(halves());
      await models.ensure();
      await engine.warm({ hear: true, speak: true });
    },
    speak: (text, voice, speed) => engine.speak(text, isBuiltInVoice(voice) ? voice : DEFAULT_VOICE, speed),
    transcribe: (samples) => engine.transcribe(samples),
  });
}
