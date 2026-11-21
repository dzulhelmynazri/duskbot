// EventSource hides SSE comment keepalives, so liveness comes from the server's visible `ping` frame.
import type { ServerFrame } from "../../shared/wire";
import { asleepAnswer, BACKGROUND_HEADERS, cloudAsleep, cloudGone, goneAnswer, markCloudAsleep, markCloudGone, noteCloudAwake, onCloudGone, onCloudPower, sleepingFrame } from "./cloud-power";
import { recordBotTextMessage, recordRuntimeEvent } from "./voice-latency-probe";
import { noteTurnEvent } from "@/state/turn-status";
import { noteReplyEvent, noteReplyLanded } from "@/state/live-reply";

export const LIVE_EVENTS_PATH = "/api/events";
export const LIVE_EVENTS_STALE_MS = 40_000;
export const LIVE_EVENTS_RETRY_MIN_MS = 500;
export const LIVE_EVENTS_RETRY_MAX_MS = 10_000;
/** the server pings every 15s: a page hidden this long that heard nothing meanwhile holds a socket the OS suspended */
export const LIVE_EVENTS_RESUME_SILENT_MS = 15_000;
/** The server writes its hello as the stream opens. A WKWebView fetch made just after a resume or a network change can
 * stay pending with no answer and no error, so a dial that has not heard its hello by then is dialed again, each wait
 * twice the one before, up to the stale limit. */
export const LIVE_EVENTS_OPEN_MS = 8_000;
/** a dial this old that has not heard its hello is dialed again when the place is seen answering other requests */
export const LIVE_EVENTS_KICK_AFTER_MS = 3_000;

export interface LiveFrame {
  kind: string;
  cursor?: string;
  resumed?: boolean;
  event?: unknown;
}

interface LiveMessageEvent {
  data: string;
  lastEventId?: string;
}

export interface LiveEventSourceLike {
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: LiveMessageEvent) => void) | null;
  close: () => void;
}

interface ListenerTarget {
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
}

export interface LiveEventsPlatform {
  createEventSource: (url: string) => LiveEventSourceLike;
  windowTarget?: ListenerTarget;
  documentTarget?: ListenerTarget;
  isVisible: () => boolean;
  isOnline: () => boolean;
  now: () => number;
  /** A background read that never wakes a sleeping Cloud: true when it answers, so it was woken elsewhere. */
  cloudAnswers?: () => Promise<boolean>;
  /** A read that tells a deleted madani cloud from one that is only unreachable: true when the edge says it is gone. */
  placeGone?: () => Promise<boolean>;
}

/** a stream that keeps failing asks at most this often whether its place was deleted */
export const GONE_CHECK_MS = 30_000;

/** How often a page that saw its Cloud go to sleep checks, while shown, whether something else woke it. */
export const CLOUD_AWAKE_CHECK_MS = 30_000;

export interface LiveEventsHandlers {
  onFrame: (frame: LiveFrame) => void;
  /** The transport commits the new cursor only after this resolves true. */
  onSnapshotRequired: () => Promise<boolean>;
  onOpen?: () => void;
  onError?: () => void;
  /** Resume from this cursor (a snapshot already drawn) instead of asking for a snapshot first. */
  since?: string | null;
  staleMs?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
}

/** `screens: false` asks the server to leave out live screen frames. */
export function liveEventsUrl(options?: { since?: string | null; screens?: boolean }): string {
  const params = new URLSearchParams();
  if (options?.since) params.set("since", options.since);
  if (options?.screens === false) params.set("screens", "off");
  const query = params.toString();
  return query ? `${LIVE_EVENTS_PATH}?${query}` : LIVE_EVENTS_PATH;
}

export interface LiveFrameListener {
  onFrame: (frame: ServerFrame) => void;
  onMissedFrames?: () => void;
  /** Draws live screens: while a listener with this is registered the stream carries screen frames; with none it does not. */
  screens?: boolean;
}

const liveFrameListeners = new Set<LiveFrameListener>();
const screenWishListeners = new Set<() => void>();
const retryListeners = new Set<(redial: boolean) => void>();
const openListeners = new Set<() => void>();
let lastLiveAt: number | null = null;

/** When any live stream last opened or carried a frame (a ping too), in this page's clock; null before the first. */
export function liveEventsHeardAt(): number | null {
  return lastLiveAt;
}

/** A live stream to the place opened: the place answers again, whatever an older request is still waiting on. */
export function onLiveEventsOpen(listener: () => void): () => void {
  openListeners.add(listener);
  return () => { openListeners.delete(listener); };
}

/** The person asked to try again: every open stream that is not connected tries now, from the shortest wait.
 * `redial`: the way to the place changed, so a stream still open on the old one dials again too. */
export function retryLiveEventsNow(options: { redial?: boolean } = {}): void {
  for (const retry of retryListeners) retry(options.redial === true);
}
const screensWanted = () => [...liveFrameListeners].some((listener) => listener.screens);

export function listenLiveFrames(listener: LiveFrameListener): () => void {
  const before = screensWanted();
  liveFrameListeners.add(listener);
  if (screensWanted() !== before) for (const changed of screenWishListeners) changed();
  return () => {
    const wanted = screensWanted();
    liveFrameListeners.delete(listener);
    if (screensWanted() !== wanted) for (const changed of screenWishListeners) changed();
  };
}

/** A frame kept for later (before the first snapshot is drawn) needs no pixels: viewers saw them as it arrived. */
export function withoutScreenPixels(frame: ServerFrame): ServerFrame {
  if (frame.kind !== "screen") return frame;
  const { png: _png, ...rest } = frame;
  return { ...rest, png: "" };
}

export function publishLiveFrame(frame: ServerFrame): void {
  for (const listener of liveFrameListeners) listener.onFrame(frame);
}

export function publishMissedFrames(): void {
  for (const listener of liveFrameListeners) listener.onMissedFrames?.();
}

export function isLivePing(frame: Pick<LiveFrame, "kind">): boolean {
  return frame.kind === "ping";
}

/** A clock set back since the stream was last heard counts as stale: the gap since then is unknown. */
export function shouldReconnectLiveEvents(
  lastHeardAt: number,
  now: number,
  staleMs = LIVE_EVENTS_STALE_MS,
): boolean {
  return now < lastHeardAt || now - lastHeardAt >= staleMs;
}

function parseLiveFrame(data: string): LiveFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!value || Array.isArray(value) || Object(value) !== value) return null;
  const candidate = value as {
    kind?: unknown;
    cursor?: unknown;
    resumed?: unknown;
    event?: unknown;
  };
  if (candidate.kind !== String(candidate.kind)) return null;
  if (candidate.cursor !== undefined && candidate.cursor !== String(candidate.cursor)) return null;
  if (candidate.resumed !== undefined && candidate.resumed !== Boolean(candidate.resumed)) return null;
  return candidate as LiveFrame;
}

function tapLiveFrame(frame: ServerFrame): void {
  if (frame.kind === "runtime") {
    // The chat's status line reads every live runtime frame; none of them is stored.
    noteTurnEvent(frame.event);
    noteReplyEvent(frame.event);
    recordRuntimeEvent(frame.event);
  } else if (frame.kind === "message" && frame.message?.role === "bot" && frame.message?.kind === "text") {
    noteReplyLanded(frame.threadId, frame.message.id);
    recordBotTextMessage(frame.message, frame.threadId);
  }
}

function browserPlatform(overrides: Partial<LiveEventsPlatform>): LiveEventsPlatform | null {
  const NativeEventSource = globalThis.EventSource;
  const createEventSource =
    overrides.createEventSource ??
    (!NativeEventSource
      ? undefined
      : (url: string) => {
          const native = new NativeEventSource(url);
          const adapter: LiveEventSourceLike = {
            onopen: null,
            onerror: null,
            onmessage: null,
            close: () => native.close(),
          };
          native.onopen = () => adapter.onopen?.();
          native.onerror = () => adapter.onerror?.();
          native.onmessage = (event) => adapter.onmessage?.(event);
          return adapter;
        });
  if (!createEventSource) return null;

  const browserWindow = globalThis.window;
  const browserDocument = globalThis.document;
  return {
    createEventSource,
    windowTarget:
      overrides.windowTarget ??
      (browserWindow
        ? {
            addEventListener: (type, listener) => browserWindow.addEventListener(type, listener),
            removeEventListener: (type, listener) => browserWindow.removeEventListener(type, listener),
          }
        : undefined),
    documentTarget:
      overrides.documentTarget ??
      (browserDocument
        ? {
            addEventListener: (type, listener) => browserDocument.addEventListener(type, listener),
            removeEventListener: (type, listener) => browserDocument.removeEventListener(type, listener),
          }
        : undefined),
    isVisible:
      overrides.isVisible ?? (() => !browserDocument || browserDocument.visibilityState === "visible"),
    isOnline: overrides.isOnline ?? (() => globalThis.navigator?.onLine !== false),
    now: overrides.now ?? Date.now,
    cloudAnswers: overrides.cloudAnswers ?? (() => fetch("/api/health", { cache: "no-store", headers: BACKGROUND_HEADERS })
      .then((response) => { void response.body?.cancel().catch(() => {}); return response.ok && !asleepAnswer(response); }, () => false)),
    placeGone: overrides.placeGone ?? (() => fetch("/api/health", { cache: "no-store", headers: BACKGROUND_HEADERS })
      .then((response) => { void response.body?.cancel().catch(() => {}); return goneAnswer(response); }, () => false)),
  };
}

export function openLiveEvents(
  handlers: LiveEventsHandlers,
  platformOverrides: Partial<LiveEventsPlatform> = {},
): () => void {
  const platform = browserPlatform(platformOverrides);
  if (!platform) {
    handlers.onError?.();
    return () => {};
  }

  const staleMs = handlers.staleMs ?? LIVE_EVENTS_STALE_MS;
  const retryMinMs = Math.max(1, handlers.retryMinMs ?? LIVE_EVENTS_RETRY_MIN_MS);
  const retryMaxMs = Math.max(retryMinMs, handlers.retryMaxMs ?? LIVE_EVENTS_RETRY_MAX_MS);
  const staleCheckMs = Math.min(10_000, Math.max(250, staleMs / 2));

  let stopped = false;
  let source: LiveEventSourceLike | null = null;
  let sourceScreens = screensWanted();
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryAttempt = 0;
  let helloTimer: ReturnType<typeof setTimeout> | null = null;
  let unansweredDials = 0;
  let dialedAt = 0;
  let heardHello = false;
  let cursor: string | null = handlers.since ?? null;
  let lastHeardAt = platform.now();
  let hiddenAt: number | null = platform.isVisible() ? null : platform.now();
  let snapshotGeneration = 0;
  let pendingSnapshot: {
    generation: number;
    source: LiveEventSourceLike;
    boundaryCursor: string | null;
    newestFrameCursor: string | null;
  } | null = null;

  const clearRetry = () => {
    if (retryTimer === null) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  };

  const clearHelloWait = () => {
    if (helloTimer === null) return;
    clearTimeout(helloTimer);
    helloTimer = null;
  };

  const closeSource = () => {
    const current = source;
    source = null;
    clearHelloWait();
    if (!current) return;
    if (pendingSnapshot?.source === current) {
      snapshotGeneration += 1;
      pendingSnapshot = null;
    }
    current.onopen = null;
    current.onerror = null;
    current.onmessage = null;
    current.close();
  };

  let connect: () => void;
  const scheduleReconnect = () => {
    // A Cloud home that went to sleep: reconnecting would wake it. The person's next action does (src/lib/cloud-power.ts).
    if (stopped || retryTimer !== null || !platform.isOnline() || !platform.isVisible() || cloudAsleep() || cloudGone()) return;
    const exponent = Math.min(retryAttempt, 20);
    const delay = Math.min(retryMaxMs, retryMinMs * 2 ** exponent);
    retryAttempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!platform.isVisible()) return;
      connect();
    }, delay);
  };

  let goneCheckedAt = -Infinity;
  const checkGone = () => {
    const at = platform.now();
    if (!platform.placeGone || at - goneCheckedAt < GONE_CHECK_MS) return;
    goneCheckedAt = at;
    void platform.placeGone().then((gone) => { if (gone) markCloudGone(); }, () => {});
  };

  const connectionLost = (current: LiveEventSourceLike) => {
    if (stopped || source !== current) return;
    closeSource();
    handlers.onError?.();
    checkGone();
    scheduleReconnect();
  };

  connect = () => {
    if (stopped || source || !platform.isOnline() || cloudAsleep() || cloudGone()) return;
    let current: LiveEventSourceLike;
    try {
      sourceScreens = screensWanted();
      current = platform.createEventSource(liveEventsUrl({ since: cursor, screens: sourceScreens }));
    } catch {
      handlers.onError?.();
      scheduleReconnect();
      return;
    }

    source = current;
    lastHeardAt = dialedAt = platform.now();
    heardHello = false;
    helloTimer = setTimeout(() => {
      helloTimer = null;
      unansweredDials += 1;
      connectionLost(current);
    }, Math.min(staleMs, LIVE_EVENTS_OPEN_MS * 2 ** Math.min(unansweredDials, 4)));
    current.onopen = () => {
      if (stopped || source !== current) return;
      lastHeardAt = platform.now();
      handlers.onOpen?.();
      lastLiveAt = Date.now();
      for (const listener of openListeners) listener();
    };
    current.onerror = () => connectionLost(current);
    current.onmessage = (event) => {
      if (stopped || source !== current) return;
      lastHeardAt = platform.now();
      lastLiveAt = Date.now();
      if (!heardHello) {
        heardHello = true;
        unansweredDials = 0;
        clearHelloWait();
      }

      const frame = parseLiveFrame(event.data);
      if (!frame) return;

      if (isLivePing(frame)) {
        // An open event only proves a handshake; a ping proves the stream stayed usable.
        retryAttempt = 0;
        return;
      }

      if (frame.kind === "hello") {
        // Replay frames follow `resumed:true`: advancing to hello's cursor now could skip one if the socket dies mid-replay.
        if (frame.resumed === false) {
          const generation = ++snapshotGeneration;
          pendingSnapshot = {
            generation,
            source: current,
            boundaryCursor: frame.cursor || null,
            newestFrameCursor: null,
          };
          void (async () => {
            let loaded = false;
            try {
              loaded = await handlers.onSnapshotRequired();
            } catch {
              loaded = false;
            }
            const pending = pendingSnapshot;
            if (
              stopped ||
              source !== current ||
              !pending ||
              pending.generation !== generation
            ) {
              return;
            }
            if (!loaded) {
              pendingSnapshot = null;
              connectionLost(current);
              return;
            }
            cursor = pending.newestFrameCursor ?? pending.boundaryCursor;
            pendingSnapshot = null;
            onScreenWish();
          })();
        }
      } else if (event.lastEventId) {
        if (pendingSnapshot?.source === current) {
          pendingSnapshot.newestFrameCursor = event.lastEventId;
        } else {
          cursor = event.lastEventId;
        }
      }

      if (sleepingFrame(frame as LiveFrame & { state?: unknown })) {
        // The home agreed to sleep: close quietly (not a lost connection) and stay closed until the person is back. The
        // cursor is past this frame by now, so waking never resumes before it: a Cloud that replays it would close us again.
        clearRetry();
        closeSource();
        markCloudAsleep(undefined, undefined, { byOwner: (frame as { by?: unknown }).by === "owner" });
        return;
      }

      if (frame.kind !== "hello") {
        tapLiveFrame(frame as ServerFrame);
        handlers.onFrame(frame);
      }
    };
  };

  const reconnectNow = (reportDisconnect: boolean) => {
    if (stopped || !platform.isOnline() || cloudGone()) return;
    clearRetry();
    if (source) {
      closeSource();
      if (reportDisconnect) handlers.onError?.();
    }
    connect();
  };

  const recover = () => {
    // Background tabs suspend timers and network delivery: recover once on wake.
    if (stopped || !platform.isOnline() || !platform.isVisible() || cloudAsleep()) return;
    if (!source || shouldReconnectLiveEvents(lastHeardAt, platform.now(), staleMs)) {
      reconnectNow(source !== null);
    }
  };
  const onOnline = () => recover();
  const onFocus = () => {
    if (platform.isVisible()) recover();
  };
  const onVisibilityChange = () => {
    if (!platform.isVisible()) { hiddenAt ??= platform.now(); return; }
    const silentSince = hiddenAt;
    hiddenAt = null;
    if (source && silentSince !== null && lastHeardAt <= silentSince && platform.now() - silentSince >= LIVE_EVENTS_RESUME_SILENT_MS
      && platform.isOnline() && !cloudAsleep()) reconnectNow(true);
    else recover();
  };

  const onScreenWish = () => queueMicrotask(() => {
    if (source && cursor && !pendingSnapshot && screensWanted() !== sourceScreens) reconnectNow(false);
  });
  screenWishListeners.add(onScreenWish);
  const onRetryNow = (redial: boolean) => {
    if (stopped || !platform.isOnline() || cloudAsleep()) return;
    retryAttempt = 0;
    if (redial) reconnectNow(false);
    else if (!source || shouldReconnectLiveEvents(lastHeardAt, platform.now(), staleMs)
      || (!heardHello && platform.now() - dialedAt >= LIVE_EVENTS_KICK_AFTER_MS)) reconnectNow(source !== null);
  };
  retryListeners.add(onRetryNow);
  connect();
  const staleTimer = setInterval(recover, staleCheckMs);
  // The person is back after the Cloud slept: reconnect at once, which wakes it.
  const stopPower = onCloudPower((asleep) => { if (!asleep) reconnectNow(false); });
  const stopGone = onCloudGone(() => {
    clearRetry();
    if (source) { closeSource(); handlers.onError?.(); }
  });
  let checking = false;
  const awakeCheck = setInterval(() => {
    if (stopped || checking || !cloudAsleep() || !platform.isVisible() || !platform.isOnline() || !platform.cloudAnswers) return;
    checking = true;
    void platform.cloudAnswers().then((up) => { if (up && !stopped) noteCloudAwake(); }, () => {}).finally(() => { checking = false; });
  }, CLOUD_AWAKE_CHECK_MS);
  platform.windowTarget?.addEventListener("online", onOnline);
  platform.windowTarget?.addEventListener("focus", onFocus);
  platform.documentTarget?.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    if (stopped) return;
    stopped = true;
    screenWishListeners.delete(onScreenWish);
    retryListeners.delete(onRetryNow);
    stopPower();
    stopGone();
    clearInterval(staleTimer);
    clearInterval(awakeCheck);
    clearRetry();
    closeSource();
    platform.windowTarget?.removeEventListener("online", onOnline);
    platform.windowTarget?.removeEventListener("focus", onFocus);
    platform.documentTarget?.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
