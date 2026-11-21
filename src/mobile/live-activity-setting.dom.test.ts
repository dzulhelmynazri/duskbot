// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState, type AppState, type Bot } from "@/state/store";
import { installLiveActivitySetting, setLiveActivityEnabled } from "./live-activity-setting";
import type { MobilePlatform, TurnActivityBridge } from "./platform";
import { useTurnActivities } from "./use-turn-activities";

const bot = { id: "b1", threadId: "t1", name: "Nova", color: "blue", messages: [] } as unknown as Bot;

function bridge(): TurnActivityBridge & { ended: string[] } {
  const ended: string[] = [];
  return {
    ended,
    start: vi.fn(async () => "a1"),
    update: vi.fn(async () => {}),
    end: vi.fn(async (id: string) => { ended.push(id); }),
    list: vi.fn(async () => []),
    onToken: () => () => {},
    onStartToken: () => () => {},
    lineKey: async () => null,
  };
}

async function mount(turnActivity: TurnActivityBridge) {
  const prefs = new Map<string, string>();
  const platform = { turnActivity, prefs: { get: async (key: string) => prefs.get(key) ?? null, set: async (key: string, value: string) => { prefs.set(key, value); }, remove: async () => {} } } as unknown as MobilePlatform;
  await installLiveActivitySetting(platform);
  let start: (bot: Bot) => void = () => {};
  const state = { ...initialState, bots: [bot] } as AppState;
  const Probe = () => { start = useTurnActivities(platform, state); return null; };
  const root = createRoot(document.createElement("div"));
  flushSync(() => root.render(createElement(Probe)));
  return { start: (one: Bot) => start(one), prefs, unmount: () => flushSync(() => root.unmount()) };
}

describe("the Live Activity setting", () => {
  afterEach(() => { vi.unstubAllGlobals(); setLiveActivityEnabled(true); });

  it("starts no activity while off, and takes the running ones away the moment it goes off", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, method: init.method ?? "GET" }); return new Response("{}"); }));
    const activities = bridge();
    const app = await mount(activities);
    app.start(bot);
    await vi.waitFor(() => expect(activities.start).toHaveBeenCalledTimes(1));
    setLiveActivityEnabled(false);
    await vi.waitFor(() => expect(activities.ended).toEqual(["a1"]));
    expect(calls).toContainEqual({ url: "/api/mobile/activity-start", method: "DELETE" });
    expect(calls).toContainEqual({ url: "/api/mobile/activity", method: "DELETE" });
    expect(app.prefs.get("madani.mobile.liveActivity")).toBe("off");
    app.start({ ...bot, id: "b2", threadId: "t2" } as Bot);
    await Promise.resolve();
    expect(activities.start).toHaveBeenCalledTimes(1);
    app.unmount();
  });
});
