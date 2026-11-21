// One contract for every recognizer, the same five methods window.madaniDesktop's speech helper always spoke, plus the
// input level the waveform draws. `text` is the whole session so far; `partial: false` ends the session's words.

export type VoiceLine = {
  partial?: boolean;
  text?: string;
  error?: string;
  utteranceFinal?: boolean;
  speechStart?: number;
  speechDuration?: number;
};
export type VoiceEnd = { code: number | null; reason?: string; message?: string };

export interface VoiceStartOptions {
  /** Call mode: quiet this long after speech ends the turn. Unset: the person stops it. */
  endpointMs?: number;
  /** A BCP 47 tag; unset follows the device. */
  locale?: string;
}

export interface VoiceBridge {
  speechStart(options?: VoiceStartOptions): Promise<void>;
  speechStop(): Promise<void>;
  /** End capture and deliver the final words. */
  speechFinish?(): Promise<void>;
  onSpeechTranscript(cb: (line: VoiceLine) => void): () => void;
  onSpeechEnd(cb: (info: VoiceEnd) => void): () => void;
  /** Input loudness from 0 to 1, about twenty times a second while listening. Absent where the engine cannot tell. */
  onSpeechLevel?(cb: (level: number) => void): () => void;
}

/** A tiny event hub for bridges written in the page. */
export function createVoiceEvents() {
  const transcripts = new Set<(line: VoiceLine) => void>();
  const ends = new Set<(info: VoiceEnd) => void>();
  const levels = new Set<(level: number) => void>();
  const add = <T,>(set: Set<T>, cb: T) => {
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  };
  return {
    transcript: (line: VoiceLine) => [...transcripts].forEach((cb) => cb(line)),
    end: (info: VoiceEnd) => [...ends].forEach((cb) => cb(info)),
    level: (value: number) => [...levels].forEach((cb) => cb(value)),
    onSpeechTranscript: (cb: (line: VoiceLine) => void) => add(transcripts, cb),
    onSpeechEnd: (cb: (info: VoiceEnd) => void) => add(ends, cb),
    onSpeechLevel: (cb: (level: number) => void) => add(levels, cb),
  };
}

/** Root mean square of a frame, scaled so normal speech fills most of the waveform's height. */
export function levelOf(frame: Float32Array): number {
  let sum = 0;
  for (const sample of frame) sum += sample * sample;
  const rms = Math.sqrt(sum / (frame.length || 1));
  // speech sits around 0.02 to 0.2 rms; a square root lifts the quiet end so a soft voice still moves the bars
  return Math.min(1, Math.sqrt(rms * 6));
}
