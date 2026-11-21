import type { EffectCallback } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState, type Action, type AppState, type Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({ effects: [] as EffectCallback[], link: null as string | null }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: () => [fixture.link, (next: string | null) => { fixture.link = next; }],
  useEffect: (effect: EffectCallback) => { fixture.effects.push(effect); },
}));

import { useDesktopNotificationOpens, useExternalChatLinks } from "./use-external-chat-links";
import { connectAppLinkId, connectAppsState } from "@/components/connect-apps/open";

const scout: Bot = {
  id: "scout", threadId: "scout-main", name: "Scout", title: "", description: "", notifications: true,
  color: "green", unread: false, messages: [], modelSelection: { instanceId: "fake", model: "test" },
  tasks: [{ threadId: "scout-main", title: "Main", createdAt: 1 }],
};
const loading: AppState = { ...initialState, bots: [], selectedId: "" };
const loaded: AppState = { ...initialState, bots: [scout], selectedId: "scout", hydrated: true };

/** One render: run its effects in order, as React would after commit. */
function render(state: AppState, dispatch: (action: Action) => void) {
  fixture.effects = [];
  useExternalChatLinks(state, dispatch);
  return fixture.effects.map((effect) => effect());
}

afterEach(() => { vi.unstubAllGlobals(); fixture.effects = []; fixture.link = null; });

describe("useExternalChatLinks", () => {
  it("holds a link that arrives at launch until the bots have loaded, then opens it once", () => {
    let deliver: ((link: string) => void) | undefined;
    const unsubscribe = vi.fn();
    vi.stubGlobal("window", { madaniDesktop: { onChatLink: (cb: (link: string) => void) => { deliver = cb; return unsubscribe; } } });
    const dispatch = vi.fn();

    const [cleanup] = render(loading, dispatch);
    expect(cleanup).toBe(unsubscribe);
    deliver!("madanibot://bot/scout");
    render(loading, dispatch);
    expect(dispatch).not.toHaveBeenCalled();

    render(loaded, dispatch);
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "select", id: "scout" },
      { type: "revealThread", threadId: "scout-main" },
    ]);
    expect(fixture.link).toBeNull();

    dispatch.mockClear();
    render(loaded, dispatch);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("closes Settings and the shortcuts list so the linked chat is not left behind them", () => {
    vi.stubGlobal("window", {});
    fixture.link = "madanibot://bot/scout";
    const dispatch = vi.fn();
    render({ ...loaded, appSettingsOpen: true, shortcutsOpen: true }, dispatch);
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "toggleAppSettings", open: false },
      { type: "toggleShortcuts", open: false },
      { type: "select", id: "scout" },
      { type: "revealThread", threadId: "scout-main" },
    ]);
  });

  it("opens the website's connect link on that app's page in Connect Apps, and nothing else", () => {
    vi.stubGlobal("window", {});
    fixture.link = "madanibot://apps/GoogleCalendar";
    const dispatch = vi.fn();
    render(loaded, dispatch);
    expect(connectAppsState()).toMatchObject({ open: true, page: { kind: "detail", id: "googlecalendar" } });
    expect(dispatch).not.toHaveBeenCalled();
    expect(connectAppLinkId("madanibot://apps/../bot/scout")).toBeNull();
    expect(connectAppLinkId("madanibot://bot/scout")).toBeNull();
  });

  it("opens a bot's link as its row would: at its main thread while threads are hidden", () => {
    vi.stubGlobal("window", {});
    fixture.link = "madanibot://bot/scout";
    const dispatch = vi.fn();
    const left = { ...scout, threadId: "scout-report", mainThreadId: "scout-main",
      tasks: [...scout.tasks!, { threadId: "scout-report", title: "Report", createdAt: 2, unread: true }] };
    render({ ...loaded, bots: [left] }, dispatch);
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "switchTask", botId: "scout", threadId: "scout-main" },
      { type: "revealThread", threadId: "scout-main" },
    ]);
  });

  it("does nothing without the desktop bridge", () => {
    vi.stubGlobal("window", {});
    const dispatch = vi.fn();
    expect(render(loaded, dispatch)).toEqual([undefined, undefined]);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("useDesktopNotificationOpens", () => {
  const work = { ...scout, tasks: [...scout.tasks!, { threadId: "scout-work", title: "@CoS · work", createdAt: 2 }] };
  const ready: AppState = { ...initialState, bots: [work], selectedId: "scout", hydrated: true };
  const opens = (state: AppState, dispatch: (action: Action) => void) => {
    fixture.effects = [];
    useDesktopNotificationOpens(state, dispatch);
    return fixture.effects.map((effect) => effect());
  };

  it("holds a click until a page just loaded for it has its bots, then opens that thread once", () => {
    let deliver: ((target: unknown) => void) | undefined;
    const unsubscribe = vi.fn();
    vi.stubGlobal("window", { madaniDesktop: { desktopNotifications: { onOpen: (cb: (target: unknown) => void) => { deliver = cb; return unsubscribe; } } } });
    const dispatch = vi.fn();
    const [cleanup] = opens(loading, dispatch);
    expect(cleanup).toBe(unsubscribe);
    deliver!({ botId: "scout", threadId: "scout-work" });
    opens(loading, dispatch);
    expect(dispatch).not.toHaveBeenCalled();
    opens(ready, dispatch);
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "switchTask", botId: "scout", threadId: "scout-work" },
      { type: "revealThread", threadId: "scout-work" },
    ]);
    expect(fixture.link).toBeNull();
  });

  it("subscribes to nothing on a browser or an older app", () => {
    vi.stubGlobal("window", {});
    const dispatch = vi.fn();
    expect(opens(ready, dispatch)[0]).toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
