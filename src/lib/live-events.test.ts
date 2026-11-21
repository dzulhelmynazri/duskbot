import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GONE_CHECK_MS,
  LIVE_EVENTS_KICK_AFTER_MS,
  LIVE_EVENTS_OPEN_MS,
  LIVE_EVENTS_RESUME_SILENT_MS,
  LIVE_EVENTS_STALE_MS,
  isLivePing,
  listenLiveFrames,
  liveEventsUrl,
  openLiveEvents,
  retryLiveEventsNow,
  shouldReconnectLiveEvents,
  CLOUD_AWAKE_CHECK_MS,
  type LiveEventSourceLike,
  type LiveEventsPlatform,
} from "./live-events";
import { cloudAsleep, cloudGone, markCloudAwake, markCloudGone, resetCloudPowerForTests } from "./cloud-power";
import { resetTurnLive, turnLive } from "@/state/turn-status";

class FakeTarget {
  private readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  count(type: string) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

class FakeEventSource implements LiveEventSourceLike {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  close = vi.fn();

  constructor(readonly url: string) {}

  open() {
    this.onopen?.();
  }

  error() {
    this.onerror?.();
  }

  message<T extends { kind: string }>(frame: T, lastEventId = "") {
    this.onmessage?.({ data: JSON.stringify(frame), lastEventId });
  }
}

function harness(options?: { online?: boolean; visible?: boolean; now?: number }) {
  const sources: FakeEventSource[] = [];
  const windowTarget = new FakeTarget();
  const documentTarget = new FakeTarget();
  let online = options?.online ?? true;
  let visible = options?.visible ?? true;
  let now = options?.now ?? 0;
  const platform: LiveEventsPlatform = {
    createEventSource: (url) => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source;
    },
    windowTarget,
    documentTarget,
    isOnline: () => online,
    isVisible: () => visible,
    now: () => now,
  };
  return {
    sources,
    platform,
    windowTarget,
    documentTarget,
    setOnline(value: boolean) {
      online = value;
    },
    setVisible(value: boolean) {
      visible = value;
    },
    setNow(value: number) {
      now = value;
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); resetCloudPowerForTests(); });

describe("live events URL", () => {
  it("builds cold and resumable stream URLs", () => {
    expect(liveEventsUrl()).toBe("/api/events");
    expect(liveEventsUrl({ since: "ab12cd34:9" })).toBe("/api/events?since=ab12cd34%3A9");
    expect(liveEventsUrl({ since: "ab12cd34:9", screens: false })).toBe("/api/events?since=ab12cd34%3A9&screens=off");
    expect(liveEventsUrl({ screens: true })).toBe("/api/events");
  });
});

describe("the chat's status line", () => {
  it("reads each live runtime frame before the app does", () => {
    resetTurnLive();
    const test = harness();
    const onFrame = vi.fn();
    const stop = openLiveEvents({ onFrame, onSnapshotRequired: async () => true }, test.platform);
    test.sources[0].open();
    const event = { eventId: "e1", provider: "claudeAgent", threadId: "t1", createdAt: "2026-10-23T12:00:00.000Z", turnId: "u1" };
    test.sources[0].message({ kind: "runtime", event: { ...event, type: "turn.progress", activity: "write", itemId: "w", file: "index.html", bytes: 14_336 } }, "run00000:1");
    expect(turnLive("t1").status).toEqual({ activity: "write", itemId: "w", file: "index.html", bytes: 14_336 });
    test.sources[0].message({ kind: "runtime", event: { ...event, eventId: "e2", type: "turn.completed", ok: true } }, "run00000:2");
    expect(turnLive("t1")).toMatchObject({ ended: true, status: null });
    expect(onFrame).toHaveBeenCalledTimes(2);
    stop();
    resetTurnLive();
  });
});

describe("a stream that starts from a snapshot already drawn", () => {
  it("resumes from the snapshot's cursor and asks for no snapshot when the server replays", () => {
    const test = harness();
    const onFrame = vi.fn();
    const onSnapshotRequired = vi.fn(async () => true);
    const stop = openLiveEvents({ since: "ab12cd34:9", onFrame, onSnapshotRequired }, test.platform);
    expect(test.sources[0].url).toMatch(/^\/api\/events\?since=ab12cd34%3A9(&|$)/);
    test.sources[0].message({ kind: "hello", cursor: "ab12cd34:10", resumed: true });
    test.sources[0].message({ kind: "message" }, "ab12cd34:10");
    expect(onSnapshotRequired).not.toHaveBeenCalled();
    expect(onFrame).toHaveBeenCalledTimes(1);
    stop();
  });

  it("asks for a snapshot when the server cannot replay that far", () => {
    const test = harness();
    const onSnapshotRequired = vi.fn(async () => true);
    const stop = openLiveEvents({ since: "old00000:3", onFrame: vi.fn(), onSnapshotRequired }, test.platform);
    test.sources[0].message({ kind: "hello", cursor: "new00000:1", resumed: false });
    expect(onSnapshotRequired).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe("live events supervisor", () => {
  it("uses data pings as liveness without forwarding them", () => {
    const test = harness();
    const onFrame = vi.fn();
    const stop = openLiveEvents(
      { onFrame, onSnapshotRequired: async () => true, staleMs: 1_000 },
      test.platform,
    );

    expect(test.sources).toHaveLength(1);
    test.sources[0].open();
    test.sources[0].message({ kind: "message" }, "run00000:4");
    test.setNow(900);
    test.sources[0].message({ kind: "ping" }, "run00000:999");
    vi.advanceTimersByTime(1_500);
    test.setNow(1_899);
    expect(test.sources).toHaveLength(1);
    expect(onFrame).toHaveBeenCalledOnce();

    test.setNow(1_900);
    vi.advanceTimersByTime(500);
    expect(test.sources).toHaveLength(2);
    expect(test.sources[1].url).toBe("/api/events?since=run00000%3A4&screens=off");
    expect(test.sources[0].close).toHaveBeenCalledOnce();
    stop();
  });

  it("ignores frames from a stream generation after replacing it", () => {
    const test = harness();
    const onFrame = vi.fn();
    const stop = openLiveEvents(
      { onFrame, onSnapshotRequired: async () => true, retryMinMs: 100, retryMaxMs: 100 },
      test.platform,
    );
    const staleHandler = test.sources[0].onmessage;

    test.sources[0].error();
    vi.advanceTimersByTime(100);
    staleHandler?.({ data: JSON.stringify({ kind: "message", value: "stale" }), lastEventId: "old:9" });
    test.sources[1].message({ kind: "message", value: "current" }, "new:1");

    expect(onFrame).toHaveBeenCalledOnce();
    expect(onFrame).toHaveBeenCalledWith({ kind: "message", value: "current" });
    stop();
  });

  it("commits a refused-resume boundary only after its replacement snapshot succeeds", async () => {
    const test = harness();
    const frames: unknown[] = [];
    const snapshotResolutions: Array<(loaded: boolean) => void> = [];
    const stop = openLiveEvents(
      {
        onFrame: (frame) => frames.push(frame),
        onSnapshotRequired: () =>
          new Promise<boolean>((resolve) => snapshotResolutions.push(resolve)),
        retryMinMs: 100,
        retryMaxMs: 100,
      },
      test.platform,
    );

    test.sources[0].message({ kind: "message" }, "oldrun00:10");
    test.sources[0].error();
    vi.advanceTimersByTime(100);
    expect(test.sources[1].url).toBe("/api/events?since=oldrun00%3A10&screens=off");

    test.sources[1].message({ kind: "hello", resumed: true, cursor: "oldrun00:13" });
    test.sources[1].error();
    vi.advanceTimersByTime(100);
    expect(test.sources[2].url).toBe("/api/events?since=oldrun00%3A10&screens=off");

    test.sources[2].message({ kind: "hello", resumed: false, cursor: "newrun00:7" });
    test.sources[2].message({ kind: "message", value: "behind failed snapshot" }, "newrun00:8");
    snapshotResolutions.shift()?.(false);
    await Promise.resolve();
    vi.advanceTimersByTime(100);
    expect(test.sources[3].url).toBe("/api/events?since=oldrun00%3A10&screens=off");

    test.sources[3].message({ kind: "hello", resumed: false, cursor: "newrun00:8" });
    test.sources[3].message({ kind: "message", value: "after snapshot" }, "newrun00:9");
    snapshotResolutions.shift()?.(true);
    await Promise.resolve();
    test.sources[3].error();
    vi.advanceTimersByTime(100);
    expect(test.sources[4].url).toBe("/api/events?since=newrun00%3A9&screens=off");
    expect(frames).toEqual([
      { kind: "message" },
      { kind: "message", value: "behind failed snapshot" },
      { kind: "message", value: "after snapshot" },
    ]);
    stop();
  });

  it("caps retry backoff when opening the stream keeps failing", () => {
    const attempts: number[] = [];
    const onError = vi.fn();
    const platform: LiveEventsPlatform = {
      createEventSource: () => {
        attempts.push(Date.now());
        throw new Error("offline");
      },
      isOnline: () => true,
      isVisible: () => true,
      now: Date.now,
    };

    vi.setSystemTime(0);
    const stop = openLiveEvents(
      {
        onFrame: vi.fn(),
        onSnapshotRequired: async () => true,
        onError,
        retryMinMs: 100,
        retryMaxMs: 400,
        staleMs: 10_000,
      },
      platform,
    );
    vi.advanceTimersByTime(1_100);

    expect(attempts).toEqual([0, 100, 300, 700, 1_100]);
    expect(onError).toHaveBeenCalledTimes(5);
    stop();
  });

  it("tries again at once when the person asks, from the shortest wait, and leaves a working stream alone", () => {
    const { sources, platform } = harness();
    const stop = openLiveEvents({ onFrame: vi.fn(), onSnapshotRequired: async () => true, retryMinMs: 1_000, retryMaxMs: 60_000, staleMs: 120_000 }, platform);
    for (let failed = 0; failed < 5; failed++) { sources.at(-1)!.error(); vi.advanceTimersByTime(2 ** failed * 1_000); }
    sources.at(-1)!.error();
    const before = sources.length;
    retryLiveEventsNow();
    expect(sources).toHaveLength(before + 1);
    sources.at(-1)!.error();
    vi.advanceTimersByTime(1_000);
    expect(sources).toHaveLength(before + 2);
    sources.at(-1)!.open();
    retryLiveEventsNow();
    expect(sources).toHaveLength(before + 2);
    stop();
    retryLiveEventsNow();
    expect(sources).toHaveLength(before + 2);
  });

  it("backs off an open/error flap until the stream survives a heartbeat", () => {
    const test = harness();
    const stop = openLiveEvents(
      {
        onFrame: vi.fn(),
        onSnapshotRequired: async () => true,
        retryMinMs: 100,
        retryMaxMs: 400,
        staleMs: 10_000,
      },
      test.platform,
    );

    test.sources[0].open();
    test.sources[0].error();
    vi.advanceTimersByTime(99);
    expect(test.sources).toHaveLength(1);
    vi.advanceTimersByTime(1);
    test.sources[1].open();
    test.sources[1].error();
    vi.advanceTimersByTime(199);
    expect(test.sources).toHaveLength(2);
    vi.advanceTimersByTime(1);
    test.sources[2].open();
    test.sources[2].message({ kind: "ping" });
    test.sources[2].error();
    vi.advanceTimersByTime(99);
    expect(test.sources).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(test.sources).toHaveLength(4);
    stop();
  });

  it("does not churn a suspended hidden stream and recovers once visible", () => {
    const test = harness({ visible: false });
    const stop = openLiveEvents(
      {
        onFrame: vi.fn(),
        onSnapshotRequired: async () => true,
        staleMs: 1_000,
        retryMinMs: 100,
        retryMaxMs: 100,
      },
      test.platform,
    );

    test.setNow(10_000);
    vi.advanceTimersByTime(10_000);
    expect(test.sources).toHaveLength(1);

    test.sources[0].error();
    vi.advanceTimersByTime(1_000);
    expect(test.sources).toHaveLength(1);

    test.setVisible(true);
    test.documentTarget.emit("visibilitychange");
    expect(test.sources).toHaveLength(2);
    expect(test.sources[0].close).toHaveBeenCalledOnce();
    stop();
  });

  it("recovers immediately on online/focus/visible and removes every owner on cleanup", () => {
    const test = harness({ online: false });
    const stop = openLiveEvents(
      { onFrame: vi.fn(), onSnapshotRequired: async () => true, staleMs: 1_000 },
      test.platform,
    );
    expect(test.sources).toHaveLength(0);

    test.setOnline(true);
    test.windowTarget.emit("online");
    expect(test.sources).toHaveLength(1);

    test.setNow(1_001);
    test.windowTarget.emit("focus");
    expect(test.sources).toHaveLength(2);
    expect(test.sources[0].close).toHaveBeenCalledOnce();

    test.setVisible(false);
    test.setNow(2_002);
    test.documentTarget.emit("visibilitychange");
    expect(test.sources).toHaveLength(2);
    test.setVisible(true);
    test.documentTarget.emit("visibilitychange");
    expect(test.sources).toHaveLength(3);

    stop();
    stop();
    expect(test.sources[2].close).toHaveBeenCalledOnce();
    expect(test.windowTarget.count("online")).toBe(0);
    expect(test.windowTarget.count("focus")).toBe(0);
    expect(test.documentTarget.count("visibilitychange")).toBe(0);
  });
});

describe("a phone that moved to another route", () => {
  it("dials its open stream again over the new route without reporting a lost connection", () => {
    const test = harness();
    const onError = vi.fn();
    const stop = openLiveEvents({ onFrame: vi.fn(), onError, onSnapshotRequired: async () => true }, test.platform);
    test.sources[0].open();
    retryLiveEventsNow();
    expect(test.sources).toHaveLength(1);
    retryLiveEventsNow({ redial: true });
    expect(test.sources).toHaveLength(2);
    expect(test.sources[0].close).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    stop();
  });
});

describe("a phone app back from the background", () => {
  it("dials again at once when the stream heard nothing while hidden long enough to have been suspended", () => {
    const test = harness();
    const stop = openLiveEvents({ onFrame: vi.fn(), onSnapshotRequired: async () => true }, test.platform);
    test.sources[0].open();
    test.setVisible(false);
    test.documentTarget.emit("visibilitychange");
    test.setNow(LIVE_EVENTS_RESUME_SILENT_MS);
    test.setVisible(true);
    test.documentTarget.emit("visibilitychange");
    expect(test.sources).toHaveLength(2);
    expect(test.sources[0].close).toHaveBeenCalledOnce();
    stop();
  });

  it("keeps a stream that went on pinging while hidden, and one hidden only briefly", () => {
    const test = harness();
    const stop = openLiveEvents({ onFrame: vi.fn(), onSnapshotRequired: async () => true }, test.platform);
    test.sources[0].open();
    test.setVisible(false);
    test.documentTarget.emit("visibilitychange");
    test.setNow(LIVE_EVENTS_RESUME_SILENT_MS - 1);
    test.setVisible(true);
    test.documentTarget.emit("visibilitychange");
    expect(test.sources).toHaveLength(1);
    test.setVisible(false);
    test.documentTarget.emit("visibilitychange");
    test.setNow(LIVE_EVENTS_RESUME_SILENT_MS + 5_000);
    test.sources[0].message({ kind: "ping" });
    test.setNow(3 * LIVE_EVENTS_RESUME_SILENT_MS);
    test.setVisible(true);
    test.documentTarget.emit("visibilitychange");
    expect(test.sources).toHaveLength(1);
    stop();
  });
});

describe("a dial left pending with no answer, as an iOS web view does after a resume or a network change", () => {
  it("is dialed again when its hello does not come, each wait twice as long, and the hello ends it", () => {
    const test = harness();
    const onError = vi.fn();
    const stop = openLiveEvents({ onFrame: vi.fn(), onError, onSnapshotRequired: async () => true, retryMinMs: 100, retryMaxMs: 100 }, test.platform);
    vi.advanceTimersByTime(LIVE_EVENTS_OPEN_MS - 1);
    expect(test.sources).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(test.sources[0].close).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(test.sources).toHaveLength(2);
    vi.advanceTimersByTime(2 * LIVE_EVENTS_OPEN_MS - 1);
    expect(test.sources).toHaveLength(2);
    vi.advanceTimersByTime(1 + 100);
    expect(test.sources).toHaveLength(3);
    test.sources[2].open();
    test.sources[2].message({ kind: "hello", cursor: "c:1", resumed: true });
    vi.advanceTimersByTime(LIVE_EVENTS_STALE_MS - 1);
    expect(test.sources).toHaveLength(3);
    stop();
  });

  it("is dialed again at once when the place answers something else, once the dial has had a moment", () => {
    const test = harness();
    const onError = vi.fn();
    const stop = openLiveEvents({ onFrame: vi.fn(), onError, onSnapshotRequired: async () => true }, test.platform);
    test.sources[0].open();
    test.sources[0].message({ kind: "hello", cursor: "c:1", resumed: true });
    retryLiveEventsNow({ redial: true });
    expect(test.sources).toHaveLength(2);
    test.setNow(LIVE_EVENTS_KICK_AFTER_MS - 1);
    retryLiveEventsNow();
    expect(test.sources).toHaveLength(2);
    test.setNow(LIVE_EVENTS_KICK_AFTER_MS);
    retryLiveEventsNow();
    expect(test.sources).toHaveLength(3);
    expect(test.sources[1].close).toHaveBeenCalledOnce();
    test.sources[2].message({ kind: "hello", cursor: "c:1", resumed: true });
    test.setNow(10 * LIVE_EVENTS_KICK_AFTER_MS);
    retryLiveEventsNow();
    expect(test.sources).toHaveLength(3);
    stop();
  });
});

describe("a madani cloud that was deleted", () => {
  it("asks once per check window whether the place is gone, and stops dialing for good once it is", async () => {
    const test = harness();
    const onError = vi.fn();
    let gone = false;
    const placeGone = vi.fn(async () => gone);
    const stop = openLiveEvents({ onFrame: vi.fn(), onError, onSnapshotRequired: async () => true, retryMinMs: 100, retryMaxMs: 100 }, { ...test.platform, placeGone });
    test.sources[0].error();
    expect(placeGone).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    test.sources[1].error();
    expect(placeGone).toHaveBeenCalledTimes(1);
    gone = true;
    test.setNow(GONE_CHECK_MS);
    vi.advanceTimersByTime(100);
    test.sources[2].error();
    expect(placeGone).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(cloudGone()).toBe(true));
    const dialed = test.sources.length;
    vi.advanceTimersByTime(10 * LIVE_EVENTS_STALE_MS);
    retryLiveEventsNow({ redial: true });
    test.windowTarget.emit("online");
    test.windowTarget.emit("focus");
    expect(test.sources).toHaveLength(dialed);
    stop();
  });

  it("closes an open stream the moment the place is known to be gone", () => {
    const test = harness();
    const onError = vi.fn();
    const stop = openLiveEvents({ onFrame: vi.fn(), onError, onSnapshotRequired: async () => true }, test.platform);
    test.sources[0].open();
    markCloudGone();
    expect(test.sources[0].close).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(10 * LIVE_EVENTS_STALE_MS);
    expect(test.sources).toHaveLength(1);
    stop();
  });
});

describe("live event liveness predicates", () => {
  it("recognizes only ping frames and reconnects at the stale boundary", () => {
    expect(isLivePing({ kind: "ping" })).toBe(true);
    expect(isLivePing({ kind: "message" })).toBe(false);
    expect(shouldReconnectLiveEvents(0, LIVE_EVENTS_STALE_MS - 1)).toBe(false);
    expect(shouldReconnectLiveEvents(0, LIVE_EVENTS_STALE_MS)).toBe(true);
    expect(shouldReconnectLiveEvents(10_000, 9_999)).toBe(true);
  });
});

describe("a computer clock set back", () => {
  it("still notices a stream that went silent, instead of waiting until the clock catches up", () => {
    const test = harness({ now: 3_600_000 });
    const stop = openLiveEvents({ onFrame: vi.fn(), onSnapshotRequired: async () => true, staleMs: 1_000 }, test.platform);
    test.sources[0].open();
    test.sources[0].message({ kind: "hello", cursor: "c:1", resumed: true });
    test.setNow(0);
    vi.advanceTimersByTime(600);
    expect(test.sources).toHaveLength(2);
    stop();
  });
});

describe("a Cloud home that goes to sleep", () => {
  it("closes the stream on its sleeping frame and stays closed, whatever the timers, until the person is back", () => {
    const test = harness();
    const onFrame = vi.fn(), onError = vi.fn();
    const stop = openLiveEvents({ onFrame, onError, onSnapshotRequired: async () => true, staleMs: 1_000, retryMinMs: 100, retryMaxMs: 100 }, test.platform);
    test.sources[0].open();
    test.sources[0].message({ kind: "message" }, "run00000:4");
    test.sources[0].message({ kind: "power", state: "sleeping" } as { kind: string });
    expect(cloudAsleep()).toBe(true);
    expect(test.sources[0].close).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(onFrame).toHaveBeenCalledOnce();
    test.setNow(60_000);
    vi.advanceTimersByTime(60_000);
    test.windowTarget.emit("focus");
    test.windowTarget.emit("online");
    test.documentTarget.emit("visibilitychange");
    expect(test.sources).toHaveLength(1);
    markCloudAwake();
    expect(test.sources).toHaveLength(2);
    expect(test.sources[1].url).toBe("/api/events?since=run00000%3A4&screens=off");
    stop();
  });

  it("wakes after its sleeping frame, so a Cloud that replays what follows a cursor never sends it back to sleep", async () => {
    // Such a Cloud: a resuming stream gets every frame after its cursor, the sleeping one included.
    const sent: { kind: string }[] = [];
    const serve = (source: FakeEventSource) => {
      const since = new URLSearchParams(source.url.split("?")[1]).get("since");
      const from = since === null ? null : Number(since.split(":")[1]);
      source.message({ kind: "hello", cursor: `run00000:${sent.length}`, resumed: from !== null });
      if (from !== null) sent.slice(from).forEach((frame, index) => source.message(frame, `run00000:${from + index + 1}`));
    };
    const send = (sources: FakeEventSource[], frame: { kind: string }) => {
      sent.push(frame);
      sources.at(-1)!.message(frame, `run00000:${sent.length}`);
    };
    const sleeping = { kind: "power", state: "sleeping" } as { kind: string };

    const test = harness();
    const onFrame = vi.fn();
    const stop = openLiveEvents({ onFrame, onSnapshotRequired: async () => true }, test.platform);
    serve(test.sources[0]);
    await Promise.resolve();
    send(test.sources, { kind: "message" });
    send(test.sources, sleeping);
    expect(cloudAsleep()).toBe(true);
    markCloudAwake();
    serve(test.sources[1]);
    expect(cloudAsleep()).toBe(false);
    send(test.sources, { kind: "message", reply: "Here." } as { kind: string });
    expect(onFrame).toHaveBeenLastCalledWith({ kind: "message", reply: "Here." });
    stop();

    // A sleeping frame before the snapshot loaded: waking starts over with a new snapshot, never past the one it missed.
    const loading = harness();
    const stopLoading = openLiveEvents({ onFrame: vi.fn(), onSnapshotRequired: () => new Promise<boolean>(() => {}) }, loading.platform);
    loading.sources[0].message({ kind: "hello", cursor: "run00000:3", resumed: false });
    loading.sources[0].message({ kind: "message" }, "run00000:4");
    loading.sources[0].message(sleeping, "run00000:5");
    expect(cloudAsleep()).toBe(true);
    markCloudAwake();
    expect(loading.sources[1].url).toBe("/api/events?screens=off");
    stopLoading();
  });

  it("reconnects without a wake once a background read finds the Cloud awake, woken from elsewhere", async () => {
    const test = harness();
    let up = false;
    const answers = vi.fn(async () => up);
    const posted = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", posted);
    const stop = openLiveEvents({ onFrame: vi.fn(), onSnapshotRequired: async () => true }, { ...test.platform, cloudAnswers: answers });
    test.sources[0].message({ kind: "power", state: "sleeping" } as { kind: string });
    await vi.advanceTimersByTimeAsync(CLOUD_AWAKE_CHECK_MS);
    expect(answers).toHaveBeenCalledOnce();
    expect(cloudAsleep()).toBe(true);
    expect(test.sources).toHaveLength(1);
    test.setVisible(false);
    await vi.advanceTimersByTimeAsync(CLOUD_AWAKE_CHECK_MS);
    expect(answers).toHaveBeenCalledOnce();
    test.setVisible(true);
    up = true;
    await vi.advanceTimersByTimeAsync(CLOUD_AWAKE_CHECK_MS);
    expect(cloudAsleep()).toBe(false);
    expect(test.sources).toHaveLength(2);
    expect(posted).not.toHaveBeenCalled();
    stop();
    vi.unstubAllGlobals();
  });

  it("ignores any other power frame", () => {
    const test = harness();
    const stop = openLiveEvents({ onFrame: vi.fn(), onSnapshotRequired: async () => true }, test.platform);
    test.sources[0].message({ kind: "power", state: "awake" } as { kind: string });
    expect(cloudAsleep()).toBe(false);
    expect(test.sources[0].close).not.toHaveBeenCalled();
    stop();
  });
});

describe("live screens", () => {
  it("leave screens out until a view that draws them listens, then reopen from the cursor both ways", async () => {
    const test = harness();
    const stop = openLiveEvents({ onFrame: vi.fn(), onSnapshotRequired: async () => true }, test.platform);
    expect(test.sources[0].url).toBe("/api/events?screens=off");
    test.sources[0].open();
    test.sources[0].message({ kind: "hello", resumed: true, cursor: "run00000:3" });
    test.sources[0].message({ kind: "message" }, "run00000:4");

    const quiet = listenLiveFrames({ onFrame: () => {} });
    await Promise.resolve();
    expect(test.sources).toHaveLength(1);
    const viewer = listenLiveFrames({ screens: true, onFrame: () => {} });
    const second = listenLiveFrames({ screens: true, onFrame: () => {} });
    await Promise.resolve();
    expect(test.sources.map((source) => source.url)).toEqual(["/api/events?screens=off", "/api/events?since=run00000%3A4"]);
    expect(test.sources[0].close).toHaveBeenCalledOnce();

    viewer();
    await Promise.resolve();
    expect(test.sources).toHaveLength(2);
    second();
    await Promise.resolve();
    expect(test.sources[2].url).toBe("/api/events?since=run00000%3A4&screens=off");
    quiet();
    stop();
  });
});
