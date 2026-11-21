// OpenAI speech with the key under API keys; MADANI_OPENAI_TTS_API overrides the base URL in tests.
import type { Audio, Voice } from "./elevenlabs.ts";
import { readAudio, voiceRefusal } from "./http-audio.ts";

export const OPENAI_TTS_MODEL = "gpt-4o-mini-tts";
const api = () => (process.env.MADANI_OPENAI_TTS_API || "https://api.openai.com/v1").replace(/\/+$/, "");
const VOICES = ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"];

export function listVoices(): Voice[] {
  return VOICES.map((id) => ({ id, label: id[0]!.toUpperCase() + id.slice(1) }));
}

export function isSupportedVoice(voiceId: string | undefined): boolean {
  return voiceId !== undefined && VOICES.includes(voiceId);
}

export async function synthesize(text: string, voiceId: string, key: string): Promise<Audio> {
  if (!isSupportedVoice(voiceId)) throw new Error("Pick an OpenAI voice from the voice list.");
  let response: Response;
  try {
    response = await fetch(`${api()}/audio/speech`, {
      method: "POST",
      redirect: "error",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: OPENAI_TTS_MODEL, input: text, voice: voiceId, response_format: "mp3" }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new Error("Couldn't reach OpenAI to generate speech: check your connection.");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(voiceRefusal("OpenAI", response.status, "Check the OpenAI key in Settings."));
  }
  return readAudio(response, "OpenAI");
}
