import openBlip from "../assets/sounds/open-blip.wav";
import tick from "../assets/sounds/tick.wav";
import doubleTick from "../assets/sounds/double-tick.wav";
import chimeA from "../assets/sounds/chime-a.wav";
import chimeB from "../assets/sounds/chime-b.wav";
import { notificationSoundsEnabled } from "./notification-preferences";

export const UI_SOUNDS = {
  "open-blip": openBlip,
  tick,
  "double-tick": doubleTick,
  "chime-a": chimeA,
  "chime-b": chimeB,
} as const;

export type UiSoundName = keyof typeof UI_SOUNDS;

export const UI_SOUND_NAMES = Object.keys(UI_SOUNDS) as UiSoundName[];
export const DEFAULT_UI_SOUND: UiSoundName = "chime-b";
/** pings play at half volume: a soft nudge, not an alarm */
export const DEFAULT_UI_VOLUME = 0.5;
export const UI_SOUND_KEY = "madani-notification-sound";

let audio: HTMLAudioElement | null = null;

function isSoundName(value: unknown): value is UiSoundName {
  return typeof value === "string" && value in UI_SOUNDS;
}

export function chosenSound(): UiSoundName {
  try {
    const saved = globalThis.localStorage?.getItem(UI_SOUND_KEY);
    return isSoundName(saved) ? saved : DEFAULT_UI_SOUND;
  } catch {
    return DEFAULT_UI_SOUND;
  }
}

export function chooseSound(name: UiSoundName): void {
  try {
    globalThis.localStorage?.setItem(UI_SOUND_KEY, name);
  } catch {
  }
}

export function play(name: UiSoundName = chosenSound(), { force = false, volume = DEFAULT_UI_VOLUME }: { force?: boolean; volume?: number } = {}): void {
  if (!force && !notificationSoundsEnabled()) return;
  if (typeof Audio === "undefined") return;
  audio ??= new Audio();
  audio.pause();
  audio.src = UI_SOUNDS[name];
  audio.volume = volume;
  audio.play().catch(() => {});
}
