// Deepgram Aura voices; MADANI_DEEPGRAM_API overrides the base URL in tests.
import type { Audio, Voice } from "./elevenlabs.ts";
import { readAudio, verifyWith, voiceRefusal, type VerifyResult } from "./http-audio.ts";

const api = () => (process.env.MADANI_DEEPGRAM_API || "https://api.deepgram.com/v1").replace(/\/+$/, "");
const VOICES: ReadonlyArray<[name: string, description: string]> = [
  ["thalia", "Feminine"], ["andromeda", "Feminine"], ["apollo", "Masculine"], ["arcas", "Masculine"], ["aries", "Masculine"],
  ["amalthea", "Feminine, Filipino"], ["asteria", "Feminine"], ["athena", "Feminine"], ["atlas", "Masculine"], ["aurora", "Feminine"],
  ["callista", "Feminine"], ["cora", "Feminine"], ["cordelia", "Feminine"], ["delia", "Feminine"], ["draco", "Masculine, British"],
  ["electra", "Feminine"], ["harmonia", "Feminine"], ["helena", "Feminine"], ["hera", "Feminine"], ["hermes", "Masculine"],
  ["hyperion", "Masculine, Australian"], ["iris", "Feminine"], ["janus", "Feminine"], ["juno", "Feminine"], ["jupiter", "Masculine"],
  ["luna", "Feminine"], ["mars", "Masculine"], ["minerva", "Feminine"], ["neptune", "Masculine"], ["odysseus", "Masculine"],
  ["ophelia", "Feminine"], ["orion", "Masculine"], ["orpheus", "Masculine"], ["pandora", "Feminine, British"], ["phoebe", "Feminine"],
  ["pluto", "Masculine"], ["saturn", "Masculine"], ["selene", "Feminine"], ["theia", "Feminine, Australian"], ["vesta", "Feminine"],
  ["zeus", "Masculine"],
];
const VOICE_MODEL = /^aura-(?:2-)?[a-z]+-[a-z]{2}$/;

export function listVoices(): Voice[] {
  return VOICES.map(([name, description]) => ({ id: `aura-2-${name}-en`, label: name[0]!.toUpperCase() + name.slice(1), description }));
}

export function isSupportedVoice(voiceId: string | undefined): boolean {
  return voiceId !== undefined && VOICE_MODEL.test(voiceId);
}

/** Deepgram answers 403 for a genuine key whose role cannot read its own details, so only 401 means a wrong key. */
export function verifyKey(key: string): Promise<VerifyResult> {
  return verifyWith("Deepgram", `${api()}/auth/token`, { authorization: `Token ${key}` }, [401], [403]);
}

export async function synthesize(text: string, voiceId: string, key: string): Promise<Audio> {
  if (!isSupportedVoice(voiceId)) throw new Error("Pick a Deepgram voice from the voice list.");
  let response: Response;
  try {
    response = await fetch(`${api()}/speak?model=${encodeURIComponent(voiceId)}`, {
      method: "POST",
      redirect: "error",
      headers: { authorization: `Token ${key}`, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new Error("Couldn't reach Deepgram to generate speech: check your connection.");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(voiceRefusal("Deepgram", response.status, "Check the Deepgram key in Settings."));
  }
  return readAudio(response, "Deepgram");
}
