import { Children, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, Group } from "@/state/store";

const fixture = vi.hoisted(() => ({
  values: [] as unknown[], index: 0, effects: [] as EffectCallback[], advanced: false,
  state: {} as AppState, dispatch: vi.fn(), storage: new Map<string, string>(),
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [fixture.values[index], (next: unknown) => {
      fixture.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(fixture.values[index]) : next;
    }];
  },
  useRef: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = { current: initial };
    return fixture.values[index];
  },
  useCallback: (callback: unknown) => callback,
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  useEffect: (effect: EffectCallback) => { fixture.effects.push(effect); },
  useLayoutEffect: () => {},
}));
vi.mock("react-dom", () => ({ createPortal: (node: ReactNode) => node }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("./MenuMotion", () => ({
  useMenuMotion: (open: boolean) => ({ shown: open, closing: false, className: "", exitProps: {} }),
  useHeldMenuMotion: (value: unknown) => ({ shown: value !== null, value, closing: false, className: "", exitProps: {} }),
}));
vi.mock("./DesktopCapabilities", async () => {
  const { initialDesktopCapabilities } = await import("@/lib/desktop");
  return { useDesktopCapabilities: () => ({ capabilities: initialDesktopCapabilities() }), windowFramed: () => false };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }) };
});

import { initialState, reducer, type Message } from "@/state/store";
import { BOTS_SECTION_ID, CHANNELS_SECTION_ID, userSectionId } from "@/lib/sidebar-layout";
import { SIDEBAR_COLLAPSED_SECTIONS_KEY, SIDEBAR_DENSITY_KEY, SIDEBAR_SECTION_ORDER_KEY, SIMPLE_SIDEBAR_SECTION_ORDER_KEY, setSidebarDensity } from "@/lib/sidebar-preferences";
import { Sidebar } from "./Sidebar";
import { SidebarFooter } from "./SidebarFooter";
import { SidebarResizeHandle } from "./SidebarResizeHandle";
import { SidebarTileGrid } from "./SidebarTiles";
import { GlassBar, GlassScrollFrame, GlassScroller } from "./GlassScrollFrame";
import { SidebarSectionHeader } from "./SidebarSectionHeader";
import { SidebarSearchPill, SidebarSearchToggle } from "./SidebarSimpleTop";
import { SidebarRailSeparator, SimpleRailFooter } from "./SidebarSimpleRail";

const bot = (id: string, extra: Partial<Bot> = {}): Bot => ({
  id, threadId: `${id}-thread`, name: id, title: "", description: "", notifications: true,
  color: "green", unread: false, modelSelection: { instanceId: "fake", model: "m" }, messages: [], ...extra,
});
const room: Group = {
  id: "room", threadId: "room-thread", name: "Launch room", memberIds: ["atlas"], messages: [],
  defaultResponder: { kind: "mentions" }, bulletin: "", unread: false, createdAt: 1,
};

type Props = { children?: ReactNode; className?: string; style?: Record<string, string>; [key: string]: unknown };
function nodes(value: ReactNode): ReactElement<Props>[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement<Props>(child)) return [];
    return [child, ...nodes(child.props.children)];
  });
}
function render(collapseToIcons = false) {
  fixture.index = 0;
  fixture.effects = [];
  const root = Sidebar({ open: false, onClose: () => {}, collapseToIcons }) as ReactElement<Props>;
  return { root, tree: [root, ...nodes(root.props.children)] };
}
const sectionOrder = (tree: ReactElement<Props>[]) => tree.map((node) => node.props["data-sidebar-section-id"]).filter(Boolean);
const headers = (tree: ReactElement<Props>[]) => tree.filter((node) => node.type === SidebarSectionHeader) as ReactElement<Parameters<typeof SidebarSectionHeader>[0]>[];
const listedBots = (tree: ReactElement<Props>[]) => tree.map((node) => (node.props.bot as Bot | undefined)?.id).filter(Boolean);
const labelled = (tree: ReactElement<Props>[], label: string) => tree.some((node) => node.props["aria-label"] === label);

beforeEach(() => {
  fixture.values = [];
  fixture.advanced = false;
  fixture.storage = new Map();
  fixture.dispatch.mockClear();
  fixture.state = {
    ...initialState,
    bots: [bot("atlas"), bot("bea"), bot("dodo", { section: "Work" })],
    groups: [room],
    sections: ["Work"],
  };
  vi.stubGlobal("window", Object.assign(new EventTarget(), { innerWidth: 1280, innerHeight: 800, madaniDesktop: undefined, setTimeout, clearTimeout }));
  vi.stubGlobal("document", { body: {} });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => fixture.storage.get(key) ?? null,
    setItem: (key: string, value: string) => { fixture.storage.set(key, value); },
    removeItem: (key: string) => { fixture.storage.delete(key); },
  });
});
afterEach(() => {
  setSidebarDensity("comfortable");
  vi.unstubAllGlobals();
});

describe("Simple-mode sidebar layout", () => {
  it("lists a person's own departments first, then Unassigned and group chats, each under a quiet heading with a count, as grok does", () => {
    const { tree } = render();
    expect(sectionOrder(tree)).toEqual([userSectionId("Work"), BOTS_SECTION_ID, CHANNELS_SECTION_ID]);
    expect(listedBots(tree)).toEqual(["dodo", "atlas", "bea"]);
    const lines = headers(tree);
    expect(lines.map((header) => [header.props.name, header.props.line, header.props.count])).toEqual([["Work", true, 1], ["Unassigned", true, 2], ["Group chats", true, 1]]);
    expect(lines[0]!.props.onMenu).toBeTypeOf("function");
    expect(lines[1]!.props.onMenu).toBeTypeOf("function");
    expect(lines[2]!.props.onMenu).toBeUndefined();
    expect(labelled(tree, "Add or remove bots in Work")).toBe(false);
    expect(tree.some((node) => node.type === SidebarTileGrid)).toBe(false);
  });

  it("in the person's own order, keeps the order they dragged the bots into, as Discord's channels do: a turn starting or a message arriving moves no row", () => {
    fixture.storage.set("madanibot.sidebarBotOrder", "custom");
    const at = Date.now() - 60_000;
    const said = (id: string, when: number): Message => ({ id, at: when, role: "bot", kind: "text", text: id });
    fixture.state = { ...fixture.state, sections: [], groups: [], bots: [
      bot("atlas", { messages: [said("a1", at + 3)] }),
      bot("bea", { messages: [said("b1", at + 2)] }),
      bot("cora", { messages: [said("c1", at + 1)], tasks: [{ threadId: "cora-thread", title: "Chat", createdAt: at, updatedAt: at + 1 }] }),
    ] };
    expect(listedBots(render().tree)).toEqual(["atlas", "bea", "cora"]);
    fixture.state = reducer(fixture.state, { type: "send", botId: "cora", text: "plan my week", sendId: "s1" });
    expect(listedBots(render().tree)).toEqual(["atlas", "bea", "cora"]);
    const cora = fixture.state.bots.find((candidate) => candidate.id === "cora")!;
    fixture.state = reducer(fixture.state, { type: "botPatched", bot: { ...cora, busy: true, turnStartedAt: Date.now() + 1 } });
    expect(listedBots(render().tree)).toEqual(["atlas", "bea", "cora"]);
    fixture.state = reducer(fixture.state, { type: "messageAdded", threadId: "bea-thread", message: said("b2", Date.now() + 2) });
    expect(listedBots(render().tree)).toEqual(["atlas", "bea", "cora"]);
  });

  it("by recent activity, puts the bot with a new message first and the latest chats next, pinned ones still above", () => {
    const at = Date.now() - 60_000;
    const thread = (id: string, when: number) => [{ threadId: `${id}-thread`, title: "Chat", createdAt: at, updatedAt: when, lastThreadOrderAt: when }];
    fixture.state = { ...fixture.state, sections: [], groups: [], bots: [
      bot("atlas", { tasks: thread("atlas", at + 1) }),
      bot("bea", { tasks: thread("bea", at + 3) }),
      bot("cora", { tasks: thread("cora", at + 2) }),
      bot("dodo", { tasks: thread("dodo", at), pinned: true }),
    ] };
    expect(listedBots(render().tree)).toEqual(["bea", "cora", "atlas"]);
    fixture.state = { ...fixture.state, bots: fixture.state.bots.map((one) => one.id === "atlas" ? { ...one, unread: true, tasks: one.tasks?.map((task) => ({ ...task, unread: true })) } : one) };
    expect(listedBots(render().tree)).toEqual(["atlas", "bea", "cora"]);
  });

  it("leads with the main bot, headless, when it is the only bot outside every department", () => {
    fixture.state = { ...fixture.state, bots: [bot("chief", { chiefOfStaff: true }), bot("dodo", { section: "Work" })] };
    const { tree } = render();
    expect(sectionOrder(tree)).toEqual([BOTS_SECTION_ID, userSectionId("Work"), CHANNELS_SECTION_ID]);
    expect(listedBots(tree)[0]).toBe("chief");
    expect(headers(tree).map((header) => header.props.name)).toEqual(["Work", "Group chats"]);
  });

  it("shows the pinned bots as tiles above the rows and the unpinned Chief as the first row, with no Pinned or Bots heading", () => {
    fixture.state = { ...fixture.state, bots: [bot("chief", { chiefOfStaff: true }), bot("atlas", { pinned: true }), bot("bea"), bot("dodo", { section: "Work", pinned: true })] };
    const { tree } = render();
    const grid = tree.find((node) => node.type === SidebarTileGrid)!.props as Parameters<typeof SidebarTileGrid>[0];
    expect(grid.primary).toBeNull();
    expect(grid.pinned.map((candidate) => candidate.id)).toEqual(["atlas", "dodo"]);
    expect(sectionOrder(tree)).toEqual([userSectionId("Work"), BOTS_SECTION_ID, CHANNELS_SECTION_ID]);
    expect(listedBots(tree)).toEqual(["chief", "bea"]);
    expect(headers(tree).map((header) => header.props.name)).toEqual(["Work", "Unassigned", "Group chats"]);
  });

  it("lifts a pinned unassigned Chief into the tiles with the other pinned bots", () => {
    fixture.state = { ...fixture.state, bots: [bot("chief", { chiefOfStaff: true, pinned: true }), bot("atlas", { pinned: true }), bot("bea")] };
    const { tree } = render();
    const grid = tree.find((node) => node.type === SidebarTileGrid)!.props as Parameters<typeof SidebarTileGrid>[0];
    expect(grid.pinned.map((candidate) => candidate.id)).toEqual(["chief", "atlas"]);
    expect(listedBots(tree)).toEqual(["bea"]);
  });

  it("fades the list's edges in both modes, with the top buttons and the tiles fixed above it", () => {
    fixture.state = { ...fixture.state, bots: [bot("chief", { chiefOfStaff: true, pinned: true }), bot("atlas", { pinned: true }), bot("bea")] };
    const simple = render();
    expect(simple.tree.find((node) => node.type === GlassScrollFrame)!.props.fade).toBe(true);
    const head = simple.tree.find((node) => node.type === GlassBar && node.props.edge === "top")!;
    expect(nodes(head.props.children).some((node) => node.type === SidebarTileGrid)).toBe(true);
    const list = simple.tree.find((node) => node.type === GlassScroller)!;
    expect(nodes(list.props.children).some((node) => node.type === SidebarTileGrid)).toBe(false);
    expect(simple.root.props.className).toContain("max-md:[--scroll-fade-surface:var(--color-app)]");
    fixture.advanced = true;
    const advanced = render();
    expect(advanced.tree.find((node) => node.type === GlassScrollFrame)!.props.fade).toBe(true);
    expect(advanced.root.props.className).toContain("max-md:[--scroll-fade-surface:var(--color-app)]");
  });

  it("draws no edge line and the Simple footer", () => {
    const simple = render();
    expect(simple.root.props.className).toContain("border-r-[0.5px] border-transparent");
    expect(simple.root.props.className).not.toContain("border-hairline");
    expect(simple.tree.some((node) => node.type === SidebarFooter)).toBe(true);
  });

  it("shows an empty section with no Add bots button", () => {
    fixture.state = { ...fixture.state, sections: ["Work", "Empty"] };
    const { tree } = render();
    expect(headers(tree).map((header) => header.props.name)).toEqual(["Work", "Empty", "Unassigned", "Group chats"]);
    expect(labelled(tree, "Add bots to Empty")).toBe(false);
    expect(labelled(tree, "Add or remove bots in Work")).toBe(false);
  });

  it("opens grok's section menu from the line's ⋯ button, under it: Rename, Move up, Move down, Delete", () => {
    const work = () => headers(render().tree).find((header) => header.props.name === "Work")!;
    const button = { getBoundingClientRect: () => ({ left: 20, right: 280, bottom: 300 }), focus: vi.fn(), isConnected: true } as unknown as HTMLButtonElement;
    expect(work().props.menuOpen).toBe(false);
    work().props.onMenu!(button);
    const { tree } = render();
    expect(work().props.menuOpen).toBe(true);
    const menu = tree.find((node) => node.props.role === "menu")!;
    expect(menu.props["aria-label"]).toBe("Work");
    expect(menu.props.style).toEqual({ left: 20, top: 304 });
    const words = (node: ReactElement<Props>): string => Children.toArray(node.props.children).map((part) => typeof part === "string" ? part : isValidElement<Props>(part) && part.props["aria-hidden"] !== "true" ? words(part) : "").join("");
    expect(nodes(menu.props.children).filter((node) => node.props.role === "menuitem").map(words)).toEqual(["Rename", "Move up", "Move down", "Delete"]);
  });

  it("starts from the shared order for the departments, and a Simple move is saved for Simple only", () => {
    fixture.state = { ...fixture.state, sections: ["Work", "Home"] };
    const saved = [userSectionId("Home"), CHANNELS_SECTION_ID, BOTS_SECTION_ID, userSectionId("Work")];
    fixture.storage.set(SIDEBAR_SECTION_ORDER_KEY, JSON.stringify(saved));
    expect(sectionOrder(render().tree)).toEqual([userSectionId("Home"), userSectionId("Work"), BOTS_SECTION_ID, CHANNELS_SECTION_ID]);
    const work = () => headers(render().tree).find((header) => header.props.name === "Work")!;
    expect(work().props.reorderable).toBe(true);
    work().props.onMove!(-1);
    const moved = [userSectionId("Work"), userSectionId("Home"), BOTS_SECTION_ID, CHANNELS_SECTION_ID];
    expect(JSON.parse(fixture.storage.get(SIMPLE_SIDEBAR_SECTION_ORDER_KEY)!)).toEqual(moved);
    expect(JSON.parse(fixture.storage.get(SIDEBAR_SECTION_ORDER_KEY)!)).toEqual(saved);
    expect(sectionOrder(render().tree)).toEqual(moved);
  });

  it("moves group chats above the unassigned bots, and leaves Advanced's order alone", () => {
    const chats = () => headers(render().tree).find((header) => header.props.name === "Group chats")!;
    expect(chats().props.reorderable).toBe(true);
    chats().props.onMove!(-1);
    const { tree } = render();
    expect(sectionOrder(tree)).toEqual([userSectionId("Work"), CHANNELS_SECTION_ID, BOTS_SECTION_ID]);
    expect(headers(tree).map((header) => header.props.name)).toEqual(["Work", "Group chats", "Unassigned"]);
    expect(listedBots(tree)).toEqual(["dodo", "atlas", "bea"]);
    expect(fixture.storage.get(SIDEBAR_SECTION_ORDER_KEY)).toBeUndefined();
  });

  it("never hides the heading-less bots behind a collapse saved in Advanced, while they lead the list", () => {
    fixture.state = { ...fixture.state, sections: [], groups: [], bots: fixture.state.bots.map((candidate) => ({ ...candidate, section: undefined })) };
    fixture.storage.set(SIDEBAR_COLLAPSED_SECTIONS_KEY, JSON.stringify([BOTS_SECTION_ID]));
    const { tree } = render();
    expect(listedBots(tree)).toEqual(["atlas", "bea", "dodo"]);
    expect(headers(tree)).toEqual([]);
  });

  it("opens the search palette from the round search button, as grok's Search does, with no pill in the sidebar", () => {
    const toggle = () => render().tree.find((node) => node.type === SidebarSearchToggle)!.props as Parameters<typeof SidebarSearchToggle>[0];
    const opened = vi.fn();
    window.addEventListener("madani:open-command-palette", opened);
    toggle().onToggle();
    expect(opened).toHaveBeenCalledOnce();
    expect(render().tree.some((node) => node.type === SidebarSearchPill)).toBe(false);
    expect(listedBots(render().tree)).toHaveLength(3);
  });

  it("opens at 288px in Simple and 320px in Advanced, each remembering its own resized width", () => {
    const width = () => render().root.props.style!["--sidebar-width"];
    expect(width()).toBe("288px");
    expect(render().root.props.className).toContain("w-[288px]");
    fixture.values = [];
  });
  const edge = (tree: ReactElement<Props>[]) => tree.find((node) => node.type === SidebarResizeHandle)?.props as Parameters<typeof SidebarResizeHandle>[0] | undefined;

  it("becomes a rail when its edge is dragged narrow, keeping the Simple order with a hairline between sections", () => {
    const handle = edge(render().tree)!;
    expect(handle.avatars).toBe(false);
    handle.onAvatars(true);
    expect(fixture.storage.get(SIDEBAR_DENSITY_KEY)).toBe("avatars");
    const { root, tree } = render();
    expect(root.props.className).toContain("w-[80px]");
    expect(sectionOrder(tree)).toEqual([userSectionId("Work"), BOTS_SECTION_ID, CHANNELS_SECTION_ID]);
    expect(listedBots(tree)).toEqual(["dodo", "atlas", "bea"]);
    expect(headers(tree)).toEqual([]);
    expect(tree.filter((node) => node.type === SidebarRailSeparator)).toHaveLength(2);
    expect(tree.some((node) => node.type === SidebarSearchToggle)).toBe(false);
    expect(edge(tree)?.avatars, "the rail keeps its edge, to drag it open again").toBe(true);
    expect(edge(tree)?.avatarsWidth).toBe(80);
    expect(tree.some((node) => node.props["data-sidebar-top-buttons"] !== undefined)).toBe(false);
  });

  it("puts the same + menu at the foot of the rail, opening upward, and dragging its edge out opens it again", () => {
    setSidebarDensity("icons");
    const plusSlot = () => render().tree.find((node) => node.type === SimpleRailFooter)!.props.plus as ReactElement<Props>;
    const top = () => nodes(plusSlot());
    const plus = () => top().find((node) => node.type === "button" && node.props["aria-label"] === "New or share")!;
    expect(plus().props.className).toEqual(expect.stringContaining("size-10"));
    (plus().props.onClick as () => void)();
    const menu = top().find((node) => /\bmin-w-\[200px\]/.test(node.props.className ?? ""))!;
    expect(menu.props.className).toEqual(expect.stringContaining("left-full bottom-0"));
    expect(menu.props.className).toEqual(expect.stringContaining("rounded-[var(--radius-menu)]"));
    const item = (label: string) => top().find((node) => node.type === "button" && nodes(node.props.children).concat(node).some((part) => Children.toArray(part.props.children).includes(label)));
    expect(item("Create department"), "Simple makes a department from its bots, by dragging one onto another or from a bot's menu").toBeUndefined();
    expect(item("New chat"), "a new conversation starts from the bot panel").toBeUndefined();
    expect(item("New bot")).toBeDefined();
    expect(item("New group chat")).toBeDefined();
    expect(item("Templates")).toBeDefined();
    edge(render().tree)!.onAvatars(false);
    expect(fixture.storage.get(SIDEBAR_DENSITY_KEY)).toBe("comfortable");
    expect(render().tree.some((node) => node.type === SimpleRailFooter)).toBe(false);
  });

  it("New Bot makes a bot at once in both modes, Chief of Staff or not: Simple's + is grok's New Bot, Advanced keeps its menu", () => {
    fixture.state = { ...fixture.state, bots: [bot("atlas", { chiefOfStaff: true }), bot("bea")] };
    const plus = render().tree.find((node) => node.type === "button" && node.props["aria-label"] === "New bot")!;
    expect(plus.props.title).toBe("New bot");
    (plus.props.onClick as () => void)();
    expect(fixture.dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "newBot" }]);
    fixture.dispatch.mockClear();
    fixture.values = [];
  });

  it("keeps no search button on the rail, collapsed by hand or by a side panel", () => {
    setSidebarDensity("icons");
    const searchButton = (tree: ReactElement<Props>[]) => tree.some((node) => node.type === "button" && node.props["aria-label"] === "Search bots and messages");
    expect(searchButton(render().tree)).toBe(false);
    expect(searchButton(render(true).tree)).toBe(false);
    expect(render(true).tree.some((node) => node.type === SimpleRailFooter)).toBe(true);
  });
});
