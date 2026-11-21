import { Children, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Action, AppState, Bot, Group, Message, Task } from "@/state/store";

const fixture = vi.hoisted(() => ({
  values: [] as unknown[], index: 0, advanced: false, phone: false, admin: null as boolean | null,
  state: {} as AppState, dispatch: vi.fn(), storage: new Map<string, string>(),
  requests: [] as Array<{ path: string; method: string; body: unknown }>,
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
  useEffect: (_effect: EffectCallback) => {},
  useLayoutEffect: () => {},
}));
vi.mock("react-dom", () => ({ createPortal: (node: ReactNode) => node }));
vi.mock("./MenuMotion", () => ({
  useMenuMotion: (open: boolean) => ({ shown: open, closing: false, className: "", exitProps: {} }),
  useHeldMenuMotion: (value: unknown) => ({ shown: value !== null, value, closing: false, className: "", exitProps: {} }),
}));
vi.mock("./DesktopCapabilities", async () => {
  const { initialDesktopCapabilities } = await import("@/lib/desktop");
  return { useDesktopCapabilities: () => ({ capabilities: initialDesktopCapabilities() }), windowFramed: () => false };
});
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.admin }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }) };
});

import { initialState } from "@/state/store";
import { BOTS_SECTION_ID, CHANNELS_SECTION_ID, userSectionId } from "@/lib/sidebar-layout";
import { PHONE_LAYOUT } from "@/lib/use-media-query";
import { BotContextMenu, BotListItem, Sidebar } from "./Sidebar";
import { SidebarSectionHeader } from "./SidebarSectionHeader";
import { ConfirmDialog } from "./ConfirmDialog";

const bot = (id: string, extra: Partial<Bot> = {}): Bot => ({
  id, threadId: `${id}-thread`, name: id, title: "", description: "", notifications: true,
  color: "green", unread: false, modelSelection: { instanceId: "fake", model: "m" }, messages: [], ...extra,
});
const room: Group = {
  id: "room", threadId: "room-thread", name: "Launch room", memberIds: ["atlas"], messages: [],
  defaultResponder: { kind: "mentions" }, bulletin: "", unread: false, createdAt: 1,
};

type Props = { children?: ReactNode; [key: string]: unknown };
type RowProps = Parameters<typeof BotListItem>[0];
type HeaderProps = Parameters<typeof SidebarSectionHeader>[0];
function nodes(value: ReactNode): ReactElement<Props>[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement<Props>(child)) return [];
    return [child, ...nodes(child.props.children)];
  });
}
function render() {
  fixture.index = 0;
  const root = Sidebar({ open: false, onClose: () => {} }) as ReactElement<Props>;
  return [root, ...nodes(root.props.children)];
}
const rows = () => render().filter((node) => node.type === BotListItem).map((node) => node.props as unknown as RowProps);
const row = (id: string) => rows().find((props) => props.bot.id === id)!;
const listed = () => rows().map((props) => props.bot.id);
const sections = () => render().map((node) => node.props["data-sidebar-section-id"]).filter(Boolean);
const section = (id: string) => render().find((node) => node.props["data-sidebar-section-id"] === id)!.props as unknown as {
  "data-bot-drop-list"?: string; children: ReactNode;
};
const headers = () => render().filter((node) => node.type === SidebarSectionHeader).map((node) => node.props as unknown as HeaderProps);
const header = (name: string) => headers().find((props) => props.name === name)!;
const actions = () => fixture.dispatch.mock.calls.map(([action]) => action as Action);

/** A press on a row, as the pointer would give it. */
const press = (extra: Record<string, unknown> = {}) => ({
  button: 0, ctrlKey: false, metaKey: false, pointerId: 1, pointerType: "mouse", clientX: 100, clientY: 27,
  target: { closest: () => null }, currentTarget: {}, ...extra,
});
const listened = () => (window.addEventListener as unknown as { mock: { calls: Array<[string]> } }).mock.calls.map(([type]) => type);

beforeEach(() => {
  fixture.values = [];
  fixture.advanced = false;
  fixture.phone = false;
  fixture.admin = null;
  fixture.storage = new Map();
  fixture.requests = [];
  fixture.dispatch.mockClear();
  fixture.state = {
    ...initialState,
    bots: [bot("atlas"), bot("bea"), bot("cleo"), bot("dodo", { section: "Work" }), bot("echo", { section: "Work" })],
    groups: [room],
    sections: ["Work"],
  };
  vi.stubGlobal("window", Object.assign(new EventTarget(), {
    innerWidth: 1280, innerHeight: 800, madaniDesktop: undefined, setTimeout, clearTimeout, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    matchMedia: (query: string) => ({ matches: fixture.phone && query === PHONE_LAYOUT, addEventListener() {}, removeEventListener() {} }),
  }));
  vi.stubGlobal("document", { body: {}, querySelector: () => null });
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("Image", class { src = ""; });
  vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
    fixture.requests.push({ path, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ sections: ["Clients"], botIds: [] }), { status: 200 });
  });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => fixture.storage.get(key) ?? null,
    setItem: (key: string, value: string) => { fixture.storage.set(key, value); },
    removeItem: (key: string) => { fixture.storage.delete(key); },
  });
  // dragging is the person's own order; by recent activity the lists order themselves
  fixture.storage.set("madanibot.sidebarBotOrder", "custom");
});
afterEach(() => vi.unstubAllGlobals());

describe("Simple's sidebar before anyone drags", () => {
  it("looks as it did: the same sections and rows, nothing lifted, each row ready to drag", () => {
    expect(sections()).toEqual([userSectionId("Work"), BOTS_SECTION_ID, CHANNELS_SECTION_ID]);
    expect(headers().map((props) => props.name)).toEqual(["Work", "Unassigned", "Group chats"]);
    expect(listed()).toEqual(["dodo", "echo", "atlas", "bea", "cleo"]);
    for (const props of rows()) {
      expect(props.botDragging).toBe(false);
      expect(typeof props.botDrag!.row(props.bot.id).onPointerDown).toBe("function");
    }
    expect(headers().every((props) => !props.dropInto && !props.naming)).toBe(true);
  });

  it("tells the drag which list each section's rows belong to, and none for group chats", () => {
    expect(section(userSectionId("Work"))["data-bot-drop-list"]).toBe("Work");
    expect(section(BOTS_SECTION_ID)["data-bot-drop-list"]).toBe("");
    expect(section(CHANNELS_SECTION_ID)["data-bot-drop-list"]).toBeUndefined();
  });

  it("leaves rows still on a phone, where the menu moves them", () => {
    fixture.phone = true;
    expect(rows().every((props) => props.botDrag === undefined)).toBe(true);
  });
});

describe("pressing a row", () => {
  it("waits for the pointer to move before anything lifts, so a click still opens the chat", () => {
    row("atlas").botDrag!.row("atlas").onPointerDown(press() as never);
    expect(listened()).toEqual(["pointermove", "pointerup", "pointercancel"]);
    expect(rows().every((props) => !props.botDragging)).toBe(true);
    expect(actions()).toEqual([]);
  });

  it("leaves a right-click, a modified click and the row's own buttons alone", () => {
    row("atlas").botDrag!.row("atlas").onPointerDown(press({ button: 2 }) as never);
    row("atlas").botDrag!.row("atlas").onPointerDown(press({ metaKey: true }) as never);
    row("atlas").botDrag!.row("atlas").onPointerDown(press({ target: { closest: () => ({}) } }) as never);
    expect(listened()).toEqual([]);
  });
});

describe("Alt+Up/Down", () => {
  it("moves a bot within its list and says where it went", () => {
    row("bea").botDrag!.step("bea", 1);
    expect(actions()).toEqual([{ type: "botsOrdered", botIds: ["atlas", "cleo", "bea"] }]);
    const live = render().find((node) => node.props["aria-live"] === "polite")!;
    expect(live.props.children).toBe("bea moved to position 3 of 3");
    fixture.dispatch.mockClear();
    row("atlas").botDrag!.step("atlas", -1);
    expect(actions()).toEqual([]);
  });
});

describe("the order bots show in", () => {
  const busy = (id: string, extra: Partial<Bot>) => {
    fixture.state = { ...fixture.state, bots: fixture.state.bots.map((item) => (item.id === id ? { ...item, ...extra } : item)) };
  };
  const said = (at: number) => [{ id: `m${at}`, at, role: "bot", kind: "text", text: "Done." } as Message];

  it("is the order the person gave them, as Discord's channels: a working or chatty bot stays where it was put", () => {
    busy("cleo", { busy: true, turnStartedAt: 300 });
    busy("echo", { busy: true, turnStartedAt: 200 });
    expect(listed()).toEqual(["dodo", "echo", "atlas", "bea", "cleo"]);
    busy("cleo", { busy: false, messages: said(400) });
    busy("bea", { activity: "waiting-on-you", messages: said(500) });
    busy("atlas", { tasks: [{ threadId: "a1", title: "Run", createdAt: 1, busy: true, turnStartedAt: 100 } as Task] });
    expect(listed()).toEqual(["dodo", "echo", "atlas", "bea", "cleo"]);
  });
});

describe("who may drag a bot: whoever the bot menu offers Move to department", () => {
  it("gives a Team Cloud member without the admin scope no row to drag and no Alt+Up/Down, and starts no drag", () => {
    const drawnEarlier = row("atlas").botDrag!;
    fixture.admin = false;
    expect(listed()).toEqual(["dodo", "echo", "atlas", "bea", "cleo"]);
    expect(rows().map((props) => props.botDrag)).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(section(userSectionId("Work"))["data-bot-drop-list"]).toBeUndefined();
    drawnEarlier.row("atlas").onPointerDown(press() as never);
    drawnEarlier.step("atlas", 1);
    expect(listened()).toEqual([]);
    expect(actions()).toEqual([]);
    expect(fixture.requests).toEqual([]);
  });

  it("lets an admin drag", () => {
    fixture.admin = true;
    for (const props of rows()) expect(typeof props.botDrag!.row(props.bot.id).onPointerDown).toBe("function");
    row("atlas").botDrag!.step("atlas", 1);
    expect(actions()).toEqual([{ type: "botsOrdered", botIds: ["bea", "atlas", "cleo"] }]);
  });
});

describe("a section's menu", () => {
  const words = (node: ReactElement<Props>): string => Children.toArray(node.props.children).map((part) => typeof part === "string" ? part : isValidElement<Props>(part) ? words(part) : "").join("");
  const openMenu = (name: string) => {
    const button = { getBoundingClientRect: () => ({ left: 20, right: 280, bottom: 300 }), focus: vi.fn(), isConnected: true } as unknown as HTMLButtonElement;
    header(name).onMenu!(button);
    const items = render().filter((node) => node.props.role === "menuitem");
    return Object.fromEntries(items.map((node) => [words(node), node.props as { onClick: () => void; disabled?: boolean }]));
  };

  it("is grok's: Rename, Move up, Move down and Delete; Unassigned only moves", () => {
    expect(Object.keys(openMenu("Work"))).toEqual(["Rename", "Move up", "Move down", "Delete"]);
    expect(openMenu("Work")["Move up"]!.disabled).toBe(true);
    fixture.values = [];
    expect(Object.keys(openMenu("Unassigned"))).toEqual(["Move up", "Move down"]);
  });

  it("renames it in place", async () => {
    openMenu("Work")["Rename"]!.onClick();
    const naming = header("Work").naming!;
    expect([naming.value, naming.label]).toEqual(["Work", "Rename section"]);
    naming.onCommit("Clients");
    await vi.waitFor(() => expect(actions()).toEqual([{ type: "sections", sections: ["Clients"] }]));
    expect(fixture.requests).toEqual([{ path: "/api/sidebar-sections?section=Work", method: "PATCH", body: { name: "Clients" } }]);
  });

  it("deletes it saying the bots stay, out of any department", () => {
    openMenu("Work")["Delete"]!.onClick();
    const dialog = render().find((node) => node.type === ConfirmDialog && node.props.open === true)!;
    expect([dialog.props.title, dialog.props.body, dialog.props.confirmLabel]).toEqual(["Delete \u201cWork\u201d", "Its bots move to unassigned. No bots are deleted.", "Delete"]);
  });

  it("is the same menu in Advanced, from a right-click on its name", () => {
    fixture.advanced = true;
    const button = { getBoundingClientRect: () => ({ right: 280, bottom: 300 }), focus: vi.fn(), isConnected: true } as unknown as HTMLButtonElement;
    header("Work").onContextMenu!({ preventDefault: () => {}, clientX: 10, clientY: 10, currentTarget: { querySelector: () => button } } as never);
    expect(render().filter((node) => node.props.role === "menuitem").map(words)).toEqual(["Rename", "Move up", "Move down", "Delete"]);
  });
});

describe("a bot's menu in Simple", () => {
  type MenuProps = Parameters<typeof BotContextMenu>[0];
  const menuProps = (botId: string, extra: Partial<MenuProps> = {}): MenuProps => ({
    menu: { botId, x: 0, y: 0 }, onClose: vi.fn(), onArchive: vi.fn(), onDelete: vi.fn(),
    onNewSection: vi.fn(), ...extra,
  });
  const open = (props: MenuProps) => {
    fixture.index = 0;
    const tree = nodes(BotContextMenu(props));
    const move = tree.find((node) => node.props["data-bot-menu-move"] !== undefined)!;
    (move.props.onClick as (event: { detail: number }) => void)({ detail: 1 });
    fixture.index = 0;
    const flyout = nodes(BotContextMenu(props)).find((node) => node.props["data-bot-menu-flyout"] === "move")!;
    return nodes(flyout.props.children).filter((node) => String(node.props.role).startsWith("menuitem"));
  };
  const label = (node: ReactElement<Props>): string => Children.toArray(node.props.children).map((part) => typeof part === "string" ? part : isValidElement<Props>(part) && part.props["aria-hidden"] !== "true" ? label(part) : "").join("");

  it("moves it to a section, out to Unassigned, or into a new one, from grok's Move to", () => {
    fixture.state = { ...fixture.state, sections: ["Work", "Home"] };
    const props = menuProps("dodo");
    const items = open(props);
    expect(items.map(label)).toEqual(["Work", "Home", "Unassigned", "Create section"]);
    expect(items.map((item) => item.props["aria-checked"])).toEqual([true, false, false, undefined]);
    (items[1]!.props.onClick as () => void)();
    (items[2]!.props.onClick as () => void)();
    expect(actions()).toEqual([
      { type: "updateBot", botId: "dodo", patch: { section: "Home" } },
      { type: "updateBot", botId: "dodo", patch: { section: "" } },
    ]);
    (items[3]!.props.onClick as () => void)();
    expect(props.onNewSection).toHaveBeenCalledWith("dodo");
  });

  it("offers Move to new section, with no flyout, while there are no sections", () => {
    fixture.state = { ...fixture.state, sections: [], bots: [bot("atlas"), bot("bea")] };
    const props = menuProps("atlas");
    fixture.index = 0;
    const item = nodes(BotContextMenu(props)).find((node) => node.props.role === "menuitem" && label(node) === "Move to new section")!;
    (item.props.onClick as () => void)();
    expect(props.onNewSection).toHaveBeenCalledWith("atlas");
  });
});

describe("deleting a Chief of Staff", () => {
  type MenuProps = Parameters<typeof BotContextMenu>[0];
  const askToDelete = (target: Bot) => (render().find((node) => node.type === BotContextMenu)!.props as unknown as MenuProps).onDelete(target);
  const openDialog = () => render().find((node) => node.type === ConfirmDialog && node.props.open === true);

  it("offers Archive first, which keeps its chats, and archives it as an ordinary bot", async () => {
    const chief = bot("atlas", { chiefOfStaff: true });
    fixture.state = { ...fixture.state, bots: [chief, bot("bea")] };
    askToDelete(chief);
    const dialog = openDialog()!;
    expect(dialog.props.body).toBe("It's your chief of staff. Archive it instead to keep its chats. Its chats, memory, files and private desktop go too. This can't be undone.");
    const alternative = dialog.props.alternative as { label: string; onClick: () => void };
    expect(alternative.label).toBe("Archive instead");
    alternative.onClick();
    await vi.waitFor(() => expect(fixture.requests).toContainEqual({ path: "/api/bots/atlas", method: "PATCH", body: { hidden: true, chiefOfStaff: false } }));
    expect(openDialog()).toBeUndefined();
  });

  it("offers nothing else for any other bot, or for the last bot there is", () => {
    askToDelete(bot("bea"));
    expect(openDialog()!.props.alternative).toBeUndefined();
    const chief = bot("atlas", { chiefOfStaff: true });
    fixture.values = [];
    fixture.state = { ...fixture.state, bots: [chief] };
    askToDelete(chief);
    expect(openDialog()!.props.alternative).toBeUndefined();
  });
});
