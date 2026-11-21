// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotEditorStore, initialState, reducer, type Action, type AppState, type Bot } from "@/state/store";
import { BotContextMenu } from "./Sidebar";
import { setLocale } from "@/lib/i18n";

vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));
const mode = vi.hoisted(() => ({ advanced: true }));

const bot: Bot = { id: "reviewer", threadId: "selected", name: "Reviewer", title: "", description: "", color: "green",
  notifications: true, unread: true, messages: [], modelSelection: { instanceId: "fake", model: "test" },
  tasks: [
    { threadId: "selected", title: "Selected", createdAt: 1, unread: false },
    { threadId: "background", title: "Report", createdAt: 2, unread: true },
    { threadId: "next", title: "Another report", createdAt: 3, unread: true },
  ],
};
let root: Root, container: HTMLDivElement, state: AppState;
let menu: { botId: string; x: number; y: number } | null;
const onClose = vi.fn();
const onRename = vi.fn();
const dispatch = (action: Action) => { state = reducer(state, action); draw(); };
const draw = () => flushSync(() => root.render(createElement(BotEditorStore, {
  value: { state, dispatch, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} },
  children: createElement(BotContextMenu, { menu, onClose, onArchive: vi.fn(), onDelete: vi.fn(), onRename }),
})));
// grok icons draw a private-use glyph, which is no part of a row's words
const text = (node: Node) => (node.textContent ?? "").replace(/[\uE000-\uF8FF\u{F0000}-\u{FFFFD}]/gu, "");
const button = (label = "Mark all conversations as read") => [...document.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')].find((node) => text(node) === label)!;
const response = (threadId: string) => {
  const current = state.bots[0]!;
  return new Response(JSON.stringify({ bot: { ...current, tasks: current.tasks!.map((task) => task.threadId === threadId ? { ...task, unread: false } : task) } }), { headers: { "content-type": "application/json" } });
};

beforeEach(() => {
  mode.advanced = true;
  setLocale("en"); document.documentElement.dataset.reducedMotion = "true";
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  state = { ...initialState, bots: [structuredClone(bot)], selectedId: "another-bot" };
  menu = { botId: bot.id, x: 50, y: 50 }; onClose.mockReset();
});
afterEach(() => { flushSync(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); delete window.madaniDesktop; setLocale("en"); });

describe("bot menu bulk reads", () => {

  it("does not expose bulk sibling reads to thread-pinned remote clients", () => {
    window.madaniDesktop = { remoteClient: { active: true } } as typeof window.madaniDesktop;
    draw(); expect(button()).toBeUndefined();
  });

  it("offers Simple mode one toggle: Mark as read while anything is unread, Mark as unread once nothing is", async () => {
    mode.advanced = false;
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => response(JSON.parse(String(init?.body)).threadId));
    vi.stubGlobal("fetch", fetch); draw();
    expect(button("Mark as unread")).toBeUndefined();
    flushSync(() => button("Mark as read").click());
    await expect.poll(() => onClose.mock.calls.length).toBe(1);
    expect(state.bots[0]!.tasks!.every((task) => !task.unread)).toBe(true);
    draw();
    expect(button("Mark as read")).toBeUndefined();
    flushSync(() => button("Mark as unread").click());
    expect(state.bots[0]!.unread).toBe(true);
  });
});

describe("Simple mode's bot menu", () => {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const sheet = () => document.querySelector<HTMLElement>('[data-bot-menu][aria-label="Actions for Reviewer"]')!;
  const move = () => document.querySelector<HTMLElement>("[data-bot-menu-move]")!;
  const flyout = () => document.querySelector('[role="menu"][aria-label="Move to"]');
  const point = (target: Element, y: number) => target.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, clientX: 60, clientY: y }));
  const words = () => [...sheet().children].map((node) => node.getAttribute("role") === "separator" ? "|" : text(node));
  beforeEach(() => { mode.advanced = false; });

  it("is grok's menu word for word: Pin and Mark as Read, Rename Bot, Copy conversation ID, Bot Settings, then Archive and Delete", () => {
    draw();
    expect(words()).toEqual(["Pin", "Mark as read", "|", "Rename bot", "|", "Copy conversation ID", "|", "Bot settings", "|", "Archive", "Delete"]);
    expect([...sheet().querySelectorAll("[data-icon-name]")].map((node) => node.getAttribute("data-icon-name"))).toEqual(["pin", "bell", "pencil-square", "copy", "gear", "eye-slash", "trash"]);
    flushSync(() => button("Rename bot").click());
    expect(onRename).toHaveBeenCalledWith(bot.id);
  });

  it("offers Move to new section while there are no sections, and Move to with each section, Unassigned and Create section once there are", () => {
    const onNewSection = vi.fn();
    const render = () => flushSync(() => root.render(createElement(BotEditorStore, {
      value: { state, dispatch, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} },
      children: createElement(BotContextMenu, { menu, onClose, onArchive: vi.fn(), onDelete: vi.fn(), onRename, onNewSection }),
    })));
    render();
    expect(words().slice(0, 3)).toEqual(["Pin", "Move to new section", "Mark as read"]);
    flushSync(() => button("Move to new section").click());
    expect(onNewSection).toHaveBeenCalledWith(bot.id);
    state = { ...state, sections: ["GOATS"], bots: [{ ...structuredClone(bot), section: "GOATS" }] };
    menu = { botId: bot.id, x: 50, y: 50 };
    render();
    flushSync(() => move().click());
    expect([...flyout()!.children].map((node) => node.getAttribute("role") === "separator" ? "|" : `${node.getAttribute("aria-checked") === "true" ? "✓" : ""}${text(node)}`)).toEqual(["✓GOATS", "Unassigned", "|", "Create section"]);
  });

  it("opens Move to only after the pointer rests on it, closes it when a sibling row takes the pointer, and opens it at once on a click", async () => {
    state = { ...state, sections: ["GOATS"] };
    draw();
    const pin = button("Pin");
    point(move(), 200);
    await wait(40);
    expect(flyout()).toBeNull();
    point(pin, 80);
    await wait(400);
    expect(flyout()).toBeNull();
    point(move(), 200);
    await wait(320);
    expect(flyout()).not.toBeNull();
    point(pin, 80);
    await wait(20);
    expect(flyout()).toBeNull();
    flushSync(() => move().click());
    await wait(20);
    expect(flyout()).not.toBeNull();
  });
});
