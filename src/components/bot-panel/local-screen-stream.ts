import { useEffect, useSyncExternalStore } from "react";

/** frames per second this computer's live screen runs at in each place it shows */
export const LIVE_FPS = { preview: 15, full: 30 } as const;
/** how long the stream outlives its last viewer, so closing the full view or a quick tab switch does not restart it */
export const LIVE_LINGER_MS = 10_000;
const LIVE_MAX_WIDTH = 1920;
const LINGER_FPS = 1;

export type LiveStatus = "idle" | "starting" | "live" | "failed";

export interface LiveScreen {
  status: LiveStatus;
  stream: MediaStream | null;
}

let current: LiveScreen = { status: "idle", stream: null };
const listeners = new Set<() => void>();
const viewers = new Map<symbol, number>();
let lingerTimer: ReturnType<typeof setTimeout> | null = null;
let appliedFps = 0;
let attempt = 0;

function publish(next: LiveScreen) {
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const read = () => current;

function wantedFps() {
  return viewers.size ? Math.max(...viewers.values()) : LINGER_FPS;
}

function stopNow() {
  attempt += 1;
  if (lingerTimer) clearTimeout(lingerTimer);
  lingerTimer = null;
  appliedFps = 0;
  for (const track of current.stream?.getTracks() ?? []) track.stop();
  publish({ status: "idle", stream: null });
}

function retune() {
  const track = current.stream?.getVideoTracks()[0];
  if (viewers.size === 0) {
    if (current.status === "live" || current.status === "starting") {
      lingerTimer ??= setTimeout(stopNow, LIVE_LINGER_MS);
    }
  } else if (lingerTimer) {
    clearTimeout(lingerTimer);
    lingerTimer = null;
  }
  const fps = wantedFps();
  if (!track || fps === appliedFps) return;
  appliedFps = fps;
  void track.applyConstraints({ frameRate: { ideal: fps, max: fps } }).catch(() => {});
}

type Intent = () => boolean | Promise<boolean>;

/** The desktop app's one-shot permission for a capture that starts without a click (macOS). Async: an app whose main
 * process is older than its page rejects it, and that only means no live screen. */
function liveIntent(): Intent | null {
  const live = typeof window === "undefined" ? undefined : window.madaniDesktop?.screenLive;
  return typeof live?.begin === "function" ? () => live.begin() : null;
}

/** The click-bound permission every desktop app has; synchronous so the request stays inside the click. */
function gestureIntent(): Intent | null {
  const begin = typeof window === "undefined" ? undefined : window.madaniDesktop?.beginScreenPreviewIntent;
  return typeof begin === "function" ? () => begin() : null;
}

function canCapture() {
  return typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function";
}

function capture(id: number, fps: number) {
  navigator.mediaDevices
    .getDisplayMedia({ video: { frameRate: { ideal: fps, max: fps }, width: { max: LIVE_MAX_WIDTH } }, audio: false })
    .then((stream) => {
      const track = stream.getVideoTracks()[0];
      if (id !== attempt || !track) {
        for (const each of stream.getTracks()) each.stop();
        if (id === attempt) publish({ status: "failed", stream: null });
        return;
      }
      appliedFps = fps;
      track.addEventListener("ended", () => {
        if (current.stream !== stream) return;
        attempt += 1;
        if (lingerTimer) clearTimeout(lingerTimer);
        lingerTimer = null;
        appliedFps = 0;
        // stopped from outside (macOS's Stop sharing, a display change): never restart it unasked
        publish({ status: "failed", stream: null });
      });
      publish({ status: "live", stream });
      retune();
    })
    .catch(() => {
      if (id === attempt) publish({ status: "failed", stream: null });
    });
}

function start(beginIntent: Intent) {
  if (current.status === "starting" || current.status === "live" || !canCapture()) return;
  const id = ++attempt;
  const fps = wantedFps();
  publish({ status: "starting", stream: null });
  const proceed = (armed: unknown) => {
    if (id !== attempt) return;
    if (armed === true) capture(id, fps);
    else publish({ status: "failed", stream: null });
  };
  let armed: boolean | Promise<boolean>;
  try {
    armed = beginIntent();
  } catch {
    armed = false;
  }
  // a click-bound intent answers at once, and the request must follow in the same task
  if (typeof armed === "boolean") proceed(armed);
  else Promise.resolve(armed).then(proceed, () => proceed(false));
}

/** Whether this computer's screen can stream live without a click here. */
export function liveScreenPossible() {
  return canCapture() && liveIntent() !== null;
}

/** Starts the live screen from inside a click with the click-bound permission every desktop app has, so it works even
 * when the click-free one is missing or refused. Call it synchronously in the click handler, before any await. */
export function primeLiveScreen() {
  if (!canCapture() || current.status === "starting" || current.status === "live") return;
  const begin = gestureIntent() ?? liveIntent();
  if (begin) start(begin);
}

/** This computer's live screen while `enabled` (the surface shows and the window is visible), at `fps`. One capture is
 * shared by every surface; it slows to 1 fps and stops after `LIVE_LINGER_MS` once nothing shows it. */
export function useLiveScreen(enabled: boolean, fps: number): LiveScreen {
  const screen = useSyncExternalStore(subscribe, read, read);
  useEffect(() => {
    if (!enabled) return;
    const key = Symbol("viewer");
    viewers.set(key, fps);
    const begin = liveIntent();
    if (current.status === "idle" && begin) start(begin);
    retune();
    return () => {
      viewers.delete(key);
      retune();
    };
  }, [enabled, fps]);
  return screen;
}

/** Test seam: forget every stream and viewer. */
export function resetLiveScreen() {
  viewers.clear();
  stopNow();
}
