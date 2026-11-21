import { readHeader, withLegacyHeaders } from "../../electron/legacy-names.mjs";
// A Cloud home on a plan that sleeps tells its pages it is going to sleep (a `power` frame on the event stream, or an
// "asleep" answer). Nobody is ever shown that: a page someone is using wakes it at once (one POST the home counts as
// someone using it, which through the public edge also starts a stopped machine) and only says it is connecting. A page
// left untouched stays quiet so the home can sleep, and wakes on the person's next touch, key press or return to it.
// On every other Cloud, and on a computer's own server, nothing here ever changes state.

/** Background requests (polls nobody asked for just now) carry this header, so the home doesn't count them as someone
 * using it (server/cloud-power.ts `countsAsActivity`). */
export const BACKGROUND_HEADER = "x-madani-background";
/** the same hint under every name a Cloud home may still know it by */
export const BACKGROUND_HEADERS: Record<string, string> = withLegacyHeaders({ [BACKGROUND_HEADER]: "1" });
export const CLOUD_POWER_HEADER = "x-madani-cloud-power";
const WAKE_PATH = "/api/cloud/wake";
export type PageWakeIntent = "type" | "click";
/** A page with no touch, key press or return to it for this long is left alone, so its home can sleep. */
export const IDLE_PAGE_MS = 10 * 60_000;

type Listener = (asleep: boolean) => void;
const listeners = new Set<Listener>();
let asleep = false, waking = false, sendsHeld = 0, paused = false;
let detach: (() => void) | null = null;
let lastActive = Date.now();
const now = () => Date.now();

/** The person did something on this page (a touch, a key press, the page showing again). */
export function noteCloudPageActivity(at = now()): void {
  lastActive = at;
}

if (typeof globalThis.window?.addEventListener === "function" && typeof globalThis.document?.addEventListener === "function") {
  for (const name of ["keydown", "pointerdown", "touchstart"]) window.addEventListener(name, () => noteCloudPageActivity(), { capture: true, passive: true });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") noteCloudPageActivity(); });
}
const wakingListeners = new Set<Listener>();

export function cloudAsleep(): boolean {
  return asleep;
}

/** Asleep because its owner paused it. A sleep we chose to save cost is never shown: the Cloud reads as live and the
 * person's next action wakes it. */
export function cloudPaused(): boolean {
  return asleep && paused;
}

export function onCloudPower(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The person acted and the home hasn't answered yet, or a send waits for it to wake: the page says it is waking. */
export function cloudWaking(): boolean {
  return waking || sendsHeld > 0;
}

/** A send is waiting for the Cloud to wake. */
export function cloudSendWaiting(): boolean {
  return sendsHeld > 0;
}

/** Keeps the page saying the Cloud is waking while a send waits for it; the returned function ends this hold. */
export function holdCloudWaking(): () => void {
  sendsHeld++;
  notifyWaking();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    sendsHeld--;
    notifyWaking();
  };
}

function notifyWaking() {
  for (const listener of wakingListeners) listener(cloudWaking());
}

export function onCloudWaking(listener: Listener): () => void {
  wakingListeners.add(listener);
  return () => { wakingListeners.delete(listener); };
}

function setWaking(next: boolean) {
  if (waking === next) return;
  waking = next;
  notifyWaking();
}

function set(next: boolean) {
  if (asleep === next) return;
  asleep = next;
  if (!next) paused = false;
  for (const listener of listeners) listener(next);
}

/** The person is back: wake the Cloud by using it. One request the home counts as someone using it (the event stream
 * reconnecting is not one) also ends a sleep it agreed to but has not carried out, so its held polls stop answering
 * "asleep". */
export function markCloudAwake(intent: PageWakeIntent = "click"): void {
  if (!asleep) return;
  setWaking(true);
  void fetch(WAKE_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ intent }) })
    .catch(() => {}).finally(() => setWaking(false));
  detach?.();
  detach = null;
  set(false);
}

/** The Cloud answered a background read, so something else woke it: back to normal without counting as use. */
export function noteCloudAwake(): void {
  if (!asleep) return;
  detach?.();
  detach = null;
  set(false);
}

/** The home agreed to sleep. A page in use wakes it straight back; an untouched one waits for the person's next action. */
export function markCloudAsleep(
  target: Pick<Window, "addEventListener" | "removeEventListener"> | undefined = globalThis.window,
  visibility: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState"> | undefined = globalThis.document,
  { byOwner = false }: { byOwner?: boolean } = {},
): void {
  if (asleep) return;
  paused = byOwner;
  set(true);
  if (visibility?.visibilityState !== "hidden" && now() - lastActive < IDLE_PAGE_MS) {
    markCloudAwake("click");
    return;
  }
  const typed = () => markCloudAwake("type"), clicked = () => markCloudAwake("click");
  const shown = () => { if (visibility?.visibilityState !== "hidden") markCloudAwake("click"); };
  const events = [["keydown", typed], ["pointerdown", clicked], ["touchstart", clicked]] as const;
  for (const [name, wake] of events) target?.addEventListener(name, wake, { capture: true });
  visibility?.addEventListener("visibilitychange", shown);
  detach = () => {
    for (const [name, wake] of events) target?.removeEventListener(name, wake, { capture: true });
    visibility?.removeEventListener("visibilitychange", shown);
  };
}

/** The page is out of sight: a background tab, a minimized or hidden window. */
export function pageHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/** Resolves once the page shows again (at once when it isn't hidden); rejects if `signal` aborts first. */
export function pageShown(signal?: AbortSignal): Promise<void> {
  if (!pageHidden()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => { document.removeEventListener("visibilitychange", check); signal?.removeEventListener("abort", abort); };
    const check = () => { if (!pageHidden()) { done(); resolve(); } };
    const abort = () => { done(); reject(signal?.reason ?? new DOMException("The request was aborted.", "AbortError")); };
    if (signal?.aborted) { abort(); return; }
    document.addEventListener("visibilitychange", check);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** The Cloud's edge answers this way while it starts a stopped machine: the request never reached the home. */
export function wakingAnswer(response: Pick<Response, "status" | "headers">): boolean {
  return response.status === 503 && (readHeader(response.headers, CLOUD_POWER_HEADER) === "waking" || response.headers.has("retry-after"));
}

/** An "asleep" answer from the home (held polls and refused background requests carry it). */
export function asleepAnswer(response: Pick<Response, "status" | "headers">): boolean {
  return response.status === 503 && readHeader(response.headers, CLOUD_POWER_HEADER) === "asleep";
}

/** The edge's answer for a madani cloud that was deleted: nothing will ever answer at this address again. */
export function goneAnswer(response: Pick<Response, "status" | "headers">): boolean {
  return response.status === 410 && readHeader(response.headers, CLOUD_POWER_HEADER) === "gone";
}

const goneListeners = new Set<() => void>();
let gone = false;

/** The place this page talks to was deleted: the live stream stops dialing and the page says so. */
export function cloudGone(): boolean {
  return gone;
}

export function markCloudGone(): void {
  if (gone) return;
  gone = true;
  for (const listener of goneListeners) listener();
}

/** another place is linked now: what the last one said is not about it */
export function forgetCloudGone(): void {
  gone = false;
}

export function onCloudGone(listener: () => void): () => void {
  goneListeners.add(listener);
  return () => { goneListeners.delete(listener); };
}

/** The event stream's frame for it. */
export function sleepingFrame(frame: { kind: string; state?: unknown }): boolean {
  return frame.kind === "power" && frame.state === "sleeping";
}

/** Tests only. */
export function resetCloudPowerForTests(): void {
  detach?.();
  detach = null;
  asleep = false;
  paused = false;
  gone = false;
  waking = false;
  lastActive = 0;
  sendsHeld = 0;
  listeners.clear();
  wakingListeners.clear();
}
