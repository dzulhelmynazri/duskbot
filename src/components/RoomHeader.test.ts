// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, Group } from "@/state/store";

const fixture = vi.hoisted(() => ({ state: null as Partial<AppState> | null, dispatch: vi.fn(), chrome: undefined as unknown }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, ...fixture.state }, dispatch: fixture.dispatch }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => {
  const original = await importOriginal<typeof import("./DesktopCapabilities")>();
  return {
    ...original,
    useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { platform: "darwin" } }, ready: true }),
    useCaptionChrome: () => fixture.chrome ?? original.captionChrome("native"),
  };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { GroupView } = await import("./GroupView");
const { RoomHeader } = await import("./RoomHeader");
const { captionChrome } = await import("./DesktopCapabilities");
const { closeRoomPanel, useRoomPanel } = await import("@/lib/room-panel");

const NAMES = ["Desk Manager", "Vendor Bench", "Job Board Sourcer", "Paperwork", "Phone Screener", "Matcher", "Interview Coordinator", "Submission Writer", "Timesheets"];
const bots: Bot[] = NAMES.map((name, index) => ({
  id: `bot-${index}`, threadId: `thread-${index}`, name, title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [], modelSelection: { instanceId: "test", model: "m" },
}));
const room = (patch: Partial<Group> = {}): Group => ({
  id: "desk", threadId: "desk-thread", name: "Desk HQ", description: "The recruiting desk", memberIds: bots.map((bot) => bot.id),
  defaultResponder: { kind: "member", botId: "bot-0" }, bulletin: "Desk HQ: the recruiting desk's room.\nKeep it short.",
  unread: false, createdAt: 1, setupCompletedAt: 1, messages: [],
  usage: { input: 1200, output: 300, costUsd: 0.42, turns: 2 },
  tasks: [{ threadId: "desk-thread", title: "Desk HQ", createdAt: 1 }],
  ...patch,
});

const view = (group: Group, madaniDesktop?: unknown) => {
  vi.stubGlobal("window", { ...globalThis.window, madaniDesktop });
  try {
    return renderToStaticMarkup(createElement(GroupView, { group }));
  } finally {
    vi.unstubAllGlobals();
  }
};
const header = (markup: string) => /<div[^>]*data-roomhead-row[\s\S]*?(?=<div[^>]*role="log"|<form|$)/.exec(markup)?.[0] ?? "";

// Every control the header shows today, by what marks it in the markup.
const CONTROLS = {
  threads: 'aria-label="All threads"',
  find: 'aria-label="Find in conversation"',
  export: 'aria-label="Export conversation"',
  turnLimit: 'data-testid="conversation-turn-limit"',
  usage: 'data-testid="group-usage-chip"',
  folder: 'title="group working folder"',
  responder: 'aria-label="Default responder"',
  members: 'aria-label="Manage members: 9 bots in this group"',
};
const shown = (markup: string) => Object.entries(CONTROLS).filter(([, mark]) => markup.includes(mark)).map(([name]) => name);
const BULLETIN = "Desk HQ: the recruiting desk&#x27;s room.";

beforeEach(() => {
  fixture.state = { bots };
  fixture.chrome = undefined;
  fixture.dispatch.mockReset();
});
afterEach(() => closeRoomPanel());

describe("the room header", () => {
  it("is one centred pill: grok's group grid of up to four faces, then the room's name", () => {
    const markup = view(room());
    const head = header(markup);
    expect(shown(head)).toEqual([]);
    expect(head.match(/<button/g)).toHaveLength(1);
    expect(head).toContain("data-room-name=");
    expect(head).toContain("chat-head-pill");
    expect(head).toContain('aria-label="Open settings for Desk HQ"');
    expect(head).toMatch(/data-roomhead-row="true" class="[^"]*justify-center/);
    expect(head).toMatch(/data-group-avatar="" aria-hidden="true" class="[^"]*" style="width:24px;height:24px"/);
    expect(head.match(/data-group-avatar-cell=/g)).toHaveLength(4);
    expect(head).not.toMatch(/>\s*\+(?:<!-- -->)?\d/);
    expect(markup).not.toContain(BULLETIN);
  });

  it("fills the grid with what it has", () => {
    const head = header(view(room({ memberIds: ["bot-0", "bot-1", "bot-2"] })));
    expect(head.match(/data-group-avatar-cell=/g)).toHaveLength(3);
  });

  it("keeps today's header on a remote client, which cannot open the Room panel", () => {
    const markup = view(room(), { remoteClient: { active: true } });
    // A remote client never had the folder chip, the responder picker or Manage members.
    expect(shown(header(markup))).toEqual(["find", "export", "turnLimit", "usage"]);
    expect(header(markup)).not.toContain("data-room-name");
    expect(markup).toContain(BULLETIN);
  });

  it("leaves a DM's header as it is", () => {
    const markup = view(room({ dm: true, memberIds: ["bot-0"], name: "Desk Manager" }));
    expect(shown(header(markup))).toEqual(["find", "export", "turnLimit", "usage"]);
    expect(header(markup)).not.toContain("data-room-name");
  });

  it("leaves a room that is still being set up as it is", () => {
    const markup = view(room({ setupCompletedAt: null, setupSkippedAt: null }));
    expect(shown(header(markup))).toEqual(["find", "export", "usage", "members"]);
    expect(header(markup)).not.toContain("data-room-name");
  });
});

describe("the Simple header's buttons", () => {
  let host: HTMLDivElement;
  let root: Root;
  const opened = { id: null as string | null };
  function Probe() {
    opened.id = useRoomPanel();
    return null;
  }
  const onOpenMembers = vi.fn();
  const draw = () => flushSync(() => root.render([
    createElement(RoomHeader, {
      key: "header", group: room(), members: bots, simple: true, setupPending: false, remoteClient: false, findOpen: false,
      onToggleFind: vi.fn(), onToggleFolder: vi.fn(), onOpenMembers, membersTriggerRef: { current: null },
    }),
    createElement(Probe, { key: "probe" }),
  ]));
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    flushSync(() => root.unmount());
    host.remove();
  });

  it("opens the Room panel from the pill, and closes it again like the bot pill", () => {
    draw();
    const pill = () => host.querySelector<HTMLButtonElement>("[data-room-name] button[data-chathead-pill]")!;
    expect(pill().getAttribute("aria-expanded")).toBe("false");
    flushSync(() => pill().click());
    expect(opened.id).toBe("desk");
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleSettings", open: true });
    draw();
    expect(pill().getAttribute("aria-expanded")).toBe("true");
    flushSync(() => pill().click());
    expect(opened.id).toBeNull();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleSettings", open: false });
  });

  it("cuts the pill out of the window's drag region", () => {
    fixture.chrome = captionChrome("mac-inset");
    // Read off the markup: happy-dom's CSSStyleDeclaration drops the Electron-only property.
    const markup = renderToStaticMarkup(createElement(RoomHeader, {
      group: room(), members: bots, simple: true, setupPending: false, remoteClient: false, findOpen: false,
      onToggleFind: vi.fn(), onToggleFolder: vi.fn(), onOpenMembers, membersTriggerRef: { current: null },
    }));
    expect(markup).toMatch(/^<div data-window-drag="" style="-webkit-app-region:drag"/);
    expect(markup.match(/<button[^>]*>/g)).toHaveLength(1);
    expect(markup).toMatch(/<div data-roomhead-identity="true"[^>]*style="-webkit-app-region:no-drag"[^>]*>\s*<button/);
  });
});
