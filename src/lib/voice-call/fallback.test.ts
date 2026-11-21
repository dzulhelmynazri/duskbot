// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";

import { bestSystemVoice, SystemListener } from "./fallback";

afterEach(() => { delete (window as { madaniDesktop?: unknown }).madaniDesktop; });

it("a bot's call language reaches the computer's recognizer, and Auto-detect sends none", () => {
  const speechStart = vi.fn(async () => {});
  (window as { madaniDesktop?: unknown }).madaniDesktop = { speechStart, speechStop: vi.fn(async () => {}), onSpeechTranscript: () => () => {}, onSpeechEnd: () => () => {} };
  new SystemListener(() => {}, "de").start();
  new SystemListener(() => {}).start();
  expect(speechStart.mock.calls).toEqual([[{ endpointMs: 700, locale: "de" }], [{ endpointMs: 700 }]]);
});

it("the computer's voice for a call speaks the bot's call language when one is installed", () => {
  const voice = (name: string, lang: string) => ({ name, lang, localService: true, default: false, voiceURI: name }) as SpeechSynthesisVoice;
  const voices = [voice("Samantha", "en-US"), voice("Anna", "de-DE")];
  expect(bestSystemVoice(voices, "de")?.name).toBe("Anna");
  expect(bestSystemVoice(voices, "en-US")?.name).toBe("Samantha");
});
