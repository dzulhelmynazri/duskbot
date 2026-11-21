import type { MobilePlatform } from "./platform";

/** the system body size at the default Larger Text setting, in css px */
const DEFAULT_BODY_PX = 17;
/** the largest and smallest the app's text follows the setting to: its rows grow with their text, its bars do not */
export const TEXT_SCALE_MIN = 0.9;
export const TEXT_SCALE_MAX = 1.35;

/** The phone's text size: the phone's own setting, or one picked in the app. */
export type TextSize = "system" | "small" | "default" | "large" | "larger";
export const TEXT_SIZES: readonly TextSize[] = ["system", "small", "default", "large", "larger"];
const FIXED: Record<Exclude<TextSize, "system">, number> = { small: 0.88, default: 1, large: 1.12, larger: 1.25 };
const KEY = "madani.mobile.textSize";
const listeners = new Set<() => void>();

/** The app's text zoom for a measured system body size. */
export function textScaleFor(bodyPx: number): number {
  if (!Number.isFinite(bodyPx) || bodyPx <= 0) return 1;
  return Math.min(TEXT_SCALE_MAX, Math.max(TEXT_SCALE_MIN, Math.round((bodyPx / DEFAULT_BODY_PX) * 100) / 100));
}

/** The zoom a choice gives: a picked size is fixed; the phone's own setting is read on iOS, where a web view's text does
 * not follow it, and left alone on Android, whose web view scales its text itself. */
export function textScale(size: TextSize, kind: MobilePlatform["kind"], measure: () => number): number {
  if (size !== "system") return FIXED[size];
  return kind === "ios" ? textScaleFor(measure()) : 1;
}

export function readTextSize(): TextSize {
  try {
    const value = localStorage.getItem(KEY);
    return TEXT_SIZES.includes(value as TextSize) ? value as TextSize : "system";
  } catch {
    return "system";
  }
}

export function setTextSize(size: TextSize): void {
  try { localStorage.setItem(KEY, size); } catch {}
  for (const listener of listeners) listener();
}

export function subscribeTextSize(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

let current = 1;
/** the zoom in effect, for the native composer to draw its text at the same size */
export const appliedTextScale = () => current;

/** WebKit resolves the `-apple-system-body` font to the size the Larger Text setting asks for. */
function systemBodyPx(): number {
  const probe = document.createElement("span");
  probe.style.cssText = "font:-apple-system-body;position:absolute;visibility:hidden;pointer-events:none";
  probe.textContent = "M";
  document.body.append(probe);
  const size = Number.parseFloat(getComputedStyle(probe).fontSize);
  probe.remove();
  return size;
}

function zoomPage(percent: number): void {
  document.documentElement.style.setProperty("-webkit-text-size-adjust", `${percent}%`);
}

/** iOS Larger Text (Dynamic Type) does not reach a web view's own font sizes, so the system body size, or the size
 * picked in Settings, sets the page's text zoom. Read again each time the app comes back, since the system setting is
 * changed outside it, and whenever the picked size changes. Returns the stop. */
export function followSystemTextSize(platform: Pick<MobilePlatform, "kind" | "onResume">, measure: () => number = systemBodyPx, zoom: (percent: number) => void = zoomPage): () => void {
  const apply = () => {
    current = textScale(readTextSize(), platform.kind, measure);
    zoom(Math.round(current * 100));
    window.dispatchEvent(new Event("madani:text-scale"));
  };
  apply();
  const stopResume = platform.onResume?.(apply);
  const stopChoice = subscribeTextSize(apply);
  return () => { stopResume?.(); stopChoice(); };
}
