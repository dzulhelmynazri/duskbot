// Cartesia Sonic voices and Ink speech-to-text; MADANI_CARTESIA_API overrides the base URL in tests.
import { z } from "zod";
import type { Audio, Voice } from "./elevenlabs.ts";
import { readAudio, verifyWith, voiceRefusal, type VerifyResult } from "./http-audio.ts";

export const CARTESIA_TTS_MODEL = "sonic-3.6";
export const CARTESIA_STT_MODEL = "ink-whisper";
// Cartesia requires this header on every request; 2026-08-14 is the only version its API accepts.
const VERSION = "2026-08-14";
const api = () => (process.env.MADANI_CARTESIA_API || "https://api.cartesia.ai").replace(/\/+$/, "");
const VOICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const headers = (key: string) => ({ authorization: `Bearer ${key}`, "cartesia-version": VERSION });
const voicesSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1), name: z.string(), description: z.string().nullish() })),
});

export function verifyKey(key: string): Promise<VerifyResult> {
  return verifyWith("Cartesia", `${api()}/voices?limit=1`, headers(key));
}

export async function listVoices(key: string, { query }: { query?: string } = {}): Promise<Voice[]> {
  const params = new URLSearchParams({ limit: "100" });
  const trimmed = query?.trim();
  if (trimmed) params.set("q", trimmed);
  let response: Response;
  try {
    response = await fetch(`${api()}/voices?${params}`, { headers: headers(key), redirect: "error", signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new Error("Couldn't reach Cartesia to list voices: check your connection.");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(voiceRefusal("Cartesia", response.status, "Check the Cartesia key in Settings."));
  }
  const parsed = voicesSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error("Cartesia returned an invalid voice list. Try again later.");
  return parsed.data.data
    .filter((voice) => VOICE_ID.test(voice.id))
    .map((voice) => ({ id: voice.id, label: voice.name.trim() || "Voice", ...(voice.description?.trim() ? { description: voice.description.trim().slice(0, 240) } : {}) }));
}

export function isSupportedVoice(voiceId: string | undefined): boolean {
  return voiceId !== undefined && VOICE_ID.test(voiceId);
}

export async function synthesize(text: string, voiceId: string, key: string): Promise<Audio> {
  if (!isSupportedVoice(voiceId)) throw new Error("Pick a Cartesia voice from the voice list.");
  let response: Response;
  try {
    response = await fetch(`${api()}/tts/bytes`, {
      method: "POST",
      redirect: "error",
      headers: { ...headers(key), "content-type": "application/json" },
      body: JSON.stringify({
        model_id: CARTESIA_TTS_MODEL,
        transcript: text,
        voice: { id: voiceId },
        output_format: { container: "mp3", sample_rate: 44_100, bit_rate: 64_000 },
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new Error("Couldn't reach Cartesia to generate speech: check your connection.");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(voiceRefusal("Cartesia", response.status, "Check the Cartesia key in Settings."));
  }
  return readAudio(response, "Cartesia");
}

export async function transcribe(audio: Uint8Array, mime: string, key: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([audio as Uint8Array<ArrayBuffer>], { type: mime }), "speech.wav");
  form.append("model", CARTESIA_STT_MODEL);
  let response: Response;
  try {
    response = await fetch(`${api()}/stt`, { method: "POST", headers: headers(key), body: form, redirect: "error", signal: AbortSignal.timeout(60_000) });
  } catch {
    throw new Error("Couldn't reach Cartesia to hear you: check your connection.");
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) throw new Error("Cartesia rejected the key. Check the Cartesia key in Settings.");
    if (response.status === 429) throw new Error("Cartesia is rate-limiting this account: wait a moment and try again.");
    throw new Error(`Cartesia could not hear that (HTTP ${response.status}). Try again later.`);
  }
  const body = (await response.json().catch(() => null)) as { text?: unknown } | null;
  return typeof body?.text === "string" ? body.text.trim() : "";
}
