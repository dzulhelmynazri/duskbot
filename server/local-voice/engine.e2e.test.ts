// Runs the real models where they are already downloaded: MADANI_VOICE_MODELS_DIR=... pnpm exec vitest run server/local-voice/engine.e2e.test.ts
import { describe, expect, it } from "vitest";
import { decodeTokens, KOKORO_RATE, LocalVoiceEngine, MOONSHINE_RATE, trimSilence } from "./engine.ts";
import { ModelStore } from "./models.ts";
import { resample } from "./wav.ts";

const store = process.env.MADANI_VOICE_MODELS_DIR ? new ModelStore() : null;
const ready = store?.status().phase === "ready";

describe("decodeTokens and trimSilence", () => {
  it("joins word pieces and byte tokens", () => {
    const tokenizer = { idToToken: ["<unk>", "<s>", "</s>", "▁Hello", ",", "▁w", "orld", "<0xE2>", "<0x9C>", "<0x93>"] };
    expect(decodeTokens(tokenizer, [1, 3, 4, 5, 6, 7, 8, 9, 2])).toBe("Hello, world✓");
  });

  it("keeps a short pad of silence around the voice", () => {
    const samples = new Float32Array(1000);
    samples.fill(0.5, 400, 600);
    expect(trimSilence(samples, 1000, 50)).toHaveLength(300);
  });
});

describe.skipIf(!ready)("the built-in voice, end to end", () => {
  it("says a reply that its own ears hear back word for word", async () => {
    const engine = new LocalVoiceEngine(store!);
    const line = "Sure, you have two meetings tomorrow, the first one at ten thirty.";
    const started = performance.now();
    const audio = await engine.speak(line, "af_heart", 1);
    const spokeIn = performance.now() - started;
    expect(audio.length / KOKORO_RATE).toBeGreaterThan(2);
    const heard = await engine.transcribe(resample(audio, KOKORO_RATE, MOONSHINE_RATE));
    expect(heard.toLowerCase().replace(/[^a-z ]/g, "")).toContain("two meetings tomorrow");
    expect(spokeIn).toBeLessThan(5_000);
  }, 60_000);
});
