import { describe, expect, it } from "vitest";
import { connectionNotice, isCloudOrigin, placeKind, RECONNECTING_AFTER_MS, STUCK_AFTER_MS, WAKE_SLOW_AFTER_MS, type NoticeInput } from "./connection-notice";

const base: NoticeInput = { hydrated: true, connected: false, offline: false, waking: false, resuming: false, downSince: 0, wakingSince: null, now: 0 };

describe("what the phone says about its live connection", () => {
  it("says nothing before the chats load, while connected, or in the quiet moment after a resume", () => {
    expect(connectionNotice({ ...base, hydrated: false })).toBeNull();
    expect(connectionNotice({ ...base, connected: true, downSince: null })).toBeNull();
    expect(connectionNotice({ ...base, resuming: true, now: STUCK_AFTER_MS * 10 })).toBeNull();
  });

  it("says nothing while a live stream is still opening or comes back within moments", () => {
    expect(connectionNotice({ ...base, now: RECONNECTING_AFTER_MS - 1 })).toBeNull();
    expect(connectionNotice({ ...base, answeredAt: 0, now: RECONNECTING_AFTER_MS - 1 })).toBeNull();
    expect(connectionNotice({ ...base, now: RECONNECTING_AFTER_MS })).toBe("reconnecting");
  });

  it("never reconnects forever: after the time box it is a problem with an action", () => {
    expect(connectionNotice({ ...base, now: STUCK_AFTER_MS - 1 })).toBe("reconnecting");
    expect(connectionNotice({ ...base, now: STUCK_AFTER_MS })).toBe("stuck");
  });

  it("never says it can't reach a place that answered a request just now: only the live stream is catching up", () => {
    expect(connectionNotice({ ...base, answeredAt: STUCK_AFTER_MS * 3, now: STUCK_AFTER_MS * 3 + 100 })).toBe("reconnecting");
    expect(connectionNotice({ ...base, answeredAt: 0, now: STUCK_AFTER_MS })).toBe("stuck");
    expect(connectionNotice({ ...base, connected: true, downSince: null, answeredAt: 0, now: 1 })).toBeNull();
  });

  it("says nothing for a madani cloud that agreed to sleep: the next action wakes it", () => {
    expect(connectionNotice({ ...base, asleep: true, now: STUCK_AFTER_MS * 10 })).toBeNull();
    expect(connectionNotice({ ...base, asleep: true, waking: true, downSince: null, wakingSince: 0, now: 1 })).toBe("waking");
  });

  it("says offline first, and a slow wake once a cloud has taken too long", () => {
    expect(connectionNotice({ ...base, offline: true, now: STUCK_AFTER_MS })).toBe("offline");
    expect(connectionNotice({ ...base, waking: true, downSince: null, wakingSince: 0, now: WAKE_SLOW_AFTER_MS - 1 })).toBe("waking");
    expect(connectionNotice({ ...base, waking: true, downSince: null, wakingSince: 0, now: WAKE_SLOW_AFTER_MS })).toBe("wake-slow");
  });
});

describe("which kind of place a link is", () => {
  it("names a managed madani cloud by its address, everything else a computer", () => {
    expect(isCloudOrigin("https://db8dd36a8c78f9624d31d.madani.bot")).toBe(true);
    expect(isCloudOrigin("https://madani.bot")).toBe(false);
    expect(isCloudOrigin("https://db8dd36a8c78f9624d31d.madani.bot.evil.example")).toBe(false);
    expect(placeKind({ origin: undefined, via: [{ kind: "https", url: "https://dbe8ba878381340a6f57a.madani.bot" }] })).toBe("cloud");
    expect(placeKind({ origin: "https://192.168.1.4:5331" })).toBe("computer");
    expect(placeKind(undefined)).toBe("computer");
  });
});
