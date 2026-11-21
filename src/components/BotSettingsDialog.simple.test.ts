import { MADANI_BODY_IDS } from "../../shared/body-migration";
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Routine } from "@/lib/routines";
import type { MemoryDoc } from "@/lib/memory";
import type { Bot, BotSettingsSection, InstanceInfo } from "@/state/store";
import type { ManagedSkill } from "./bot-settings/SkillsSection";
import type { BotApps } from "./bot-settings/useBotApps";

// Hook-by-call-order harness: component state survives between renders, effects never run, and handlers are read off
// the element tree.
const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", { confirm: () => true });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return {
    advanced: false,
    setAdvanced: (() => {}) as (enabled: boolean) => void,
    ownerOrAdmin: false as boolean | null,
    values: [] as unknown[],
    index: 0,
    own: 0,
    dispatch: (() => {}) as (...args: unknown[]) => void,
    api: (() => Promise.resolve({})) as (...args: unknown[]) => Promise<unknown>,
    storeState: {} as Record<string, unknown>,
    otherServer: null as string | null,
    cloudDesktop: undefined as unknown,
    capabilities: undefined as unknown,
    skills: {
      skills: [] as ManagedSkill[],
      loading: false,
      working: "",
      error: "",
      reviewing: null as null | { skill: ManagedSkill; text: string },
      toggle: (() => Promise.resolve()) as (skill: ManagedSkill) => Promise<void>,
      setWorking: (() => {}) as (name: string) => void,
      setError: (() => {}) as (error: string) => void,
      refresh: (() => Promise.resolve()) as () => Promise<void>,
      putAssignments: (() => Promise.resolve()) as (name: string, remove?: boolean) => Promise<void>,
    },
    memory: { docs: null as MemoryDoc[] | null, error: false, mine: false, setDoc: (() => {}) as (doc: MemoryDoc) => void, reload: () => Promise.resolve() },
    saveMemory: (() => Promise.resolve({ ok: true })) as (...args: unknown[]) => Promise<unknown>,
    openExternal: (() => Promise.resolve()) as (url: string) => Promise<void>,
    derived: {} as Record<string, unknown>,
    apps: { phase: "ready", apps: [], connectedSlugs: [] } as BotApps,
    places: {} as Record<string, [boolean, boolean, string]>,
  };
});
// the server renderer has no DOM for motion's projection: render the panel's views as plain swaps
vi.mock("motion/react", async (importOriginal) => ({ ...await importOriginal<typeof import("motion/react")>(), useReducedMotion: () => true }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = typeof initial === "function" ? initial() : initial;
    return [fixture.values[index], (next: unknown) => {
      fixture.values[index] = typeof next === "function" ? next(fixture.values[index]) : next;
    }];
  },
  useEffect: () => {},
}));
vi.mock("@/lib/other-server", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/other-server")>(),
  useOtherServerName: () => fixture.otherServer,
  desktopShowsOtherServer: () => fixture.otherServer !== null,
}));
vi.mock("./bot-panel/CloudDesktop", async (importOriginal) => {
  const original = await importOriginal<typeof import("./bot-panel/CloudDesktop")>();
  return { ...original, useCloudDesktop: () => (fixture.cloudDesktop === undefined ? original.useCloudDesktop() : fixture.cloudDesktop) as ReturnType<typeof original.useCloudDesktop> };
});
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.ownerOrAdmin }));
vi.mock("@/lib/app-links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-links")>()),
  openExternalLink: (url: string) => fixture.openExternal(url),
}));
vi.mock("@/lib/memory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/memory")>()),
  saveMemoryDoc: (...args: unknown[]) => fixture.saveMemory(...args),
}));
// The server renderer cannot portal; the dialog's props are what these tests read.
vi.mock("./ConfirmDialog", () => ({ ConfirmDialog: () => null }));
vi.mock("./bot-settings/useBotSettingsDerived", () => ({ useBotSettingsDerived: () => fixture.derived }));
vi.mock("./DesktopCapabilities", async (importOriginal) => {
  const original = await importOriginal<typeof import("./DesktopCapabilities")>();
  return {
    ...original,
    useCaptionChrome: () => ({ padClass: "" }),
    useDesktopCapabilities: () => (fixture.capabilities === undefined ? original.useDesktopCapabilities() : { capabilities: fixture.capabilities, ready: true }),
  };
});
vi.mock("./Avatar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./Avatar")>()),
  BotAvatar: () => null,
}));
vi.mock("./ModelPicker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ModelPicker")>()),
  ModelPicker: (props: Record<string, unknown>) => createElement("div", { "data-stub-model-picker": true, "data-thread": props.threadId, "data-contained": props.contained }),
  ModelVariantRow: () => createElement("div", { "data-stub-variants": true }),
}));
vi.mock("./bot-settings/SkillsSection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bot-settings/SkillsSection")>()),
  useManagedSkills: () => ({ ...fixture.skills, setReviewing: () => {}, enableReviewed: () => Promise.resolve() }),
}));
vi.mock("./bot-panel/use-memory-doc", () => ({ useMemoryDoc: () => fixture.memory }));
vi.mock("./PlaceChip", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./PlaceChip")>()),
  usePlaceViews: () => Object.fromEntries(Object.entries(fixture.places).map(([place, [policy, reachable, short]]) =>
    [place, { policy, reachable, view: { state: reachable ? "ready" : "blocked", params: {}, short, line: `${short}.`, action: null } }])),
}));
vi.mock("./bot-settings/useBotApps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bot-settings/useBotApps")>()),
  useBotApps: () => fixture.apps,
}));
vi.mock("@/state/store", async (importOriginal) => {
  const store = await importOriginal<typeof import("@/state/store")>();
  return {
    ...store,
    api: (...args: unknown[]) => fixture.api(...args),
    useStore: () => ({
      state: { ...store.initialState, ...fixture.storeState },
      dispatch: fixture.dispatch,
      flushBotPatches: () => Promise.resolve(),
    }),
  };
});

const { BotSettingsDialog } = await import("./BotSettingsDialog");
const { BotPanel, PanelPageBody, PanelDetailsTab, PanelAdvancedTab, PanelAvatarEditor } = await import("./bot-panel/PanelShell");
await Promise.all([PanelPageBody.preload(), PanelDetailsTab.preload(), PanelAdvancedTab.preload(), PanelAvatarEditor.preload()]);
const { PanelHero } = await import("./bot-panel/PanelHero");
const { AvatarEditorCard } = await import("./bot-panel/AvatarEditorCard");
const { DetailsTab } = await import("./bot-panel/DetailsTab");
const { AdvancedTab } = await import("./bot-panel/AdvancedTab");
const { SettingsPage } = await import("./bot-panel/SettingsPage");
const { LibraryPage, LibrarySection } = await import("./bot-panel/LibraryTab");
const { CloudCtaCard, ComputerTab, WherePage, cloudCtaStep, hasMadaniCloud } = await import("./bot-panel/ComputerTab");
const { PageBody, AppsPage, RoutinesPage, MemoryPage, SkillsPage, FolderPage, BrowserPage } = await import("./bot-panel/pages");
const { BrowserLogins } = await import("./bot-panel/browser-logins");
const { PAGES, sectionTarget } = await import("./bot-panel/page-registry");
const { isModalPage, pendingPanelModal, takePanelModalRequest } = await import("./bot-panel/modals/panel-modal");
const { openBotSettings } = await import("./bot-panel/panel-link");
const { SegmentedTabs } = await import("./ui/SegmentedTabs");
const { PanelShareMenu } = await import("./bot-panel/PanelShareMenu");
const { VOICE_LANGUAGES, VOICE_SPEEDS } = await import("./bot-panel/voice-prefs");
const { LocalComputerAutoWarning } = await import("./LocalComputerAutoWarning");
const { BotRoutines } = await import("./routines/BotRoutines");
const { SignedInSites } = await import("./SignedInSites");

afterAll(() => vi.unstubAllGlobals());

type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
type Rendered = { html: string; nodes: Node[] };
function nodes(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    return [node, ...nodes(node.props.children), ...nodes(node.props.action as ReactNode), ...nodes(node.props.extra as ReactNode), ...nodes(node.props.label as ReactNode), ...nodes(node.props.hint as ReactNode), ...nodes(node.props.more as ReactNode)];
  });
}

function makeBot(extra: Partial<Bot> = {}): Bot {
  return {
    id: "scout", threadId: "thread-scout", name: "Scout", title: "Researcher", description: "", soul: "Be brief.",
    notifications: true, color: "green", unread: false, messages: [],
    modelSelection: { instanceId: "claude", model: "claude-opus-5-5" },
    ...extra,
  };
}

function capture(component: () => ReactNode): Rendered {
  fixture.values.length = Math.min(fixture.values.length, fixture.own);
  let tree: ReactNode = null;
  function Capture() {
    fixture.index = 0;
    tree = component();
    fixture.own = fixture.index;
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, nodes: nodes(tree) };
}

const fresh = () => {
  fixture.values = [];
  fixture.own = 0;
};
const patch = vi.fn();
const onOpen = vi.fn();
const onClose = vi.fn();
const derived = () => fixture.derived as never;
const panel = (bot: Bot, linkedSection: BotSettingsSection | null = null) =>
  capture(() => BotPanel({ bot, derived: derived(), linkedSection, onClose }));
const dialog = (bot: Bot) => capture(() => BotSettingsDialog({ bot }));
const botTab = (bot: Bot) => capture(() => DetailsTab({ bot, derived: derived(), onOpen }));
const settingsPage = (bot: Bot) =>
  capture(() => SettingsPage({ bot, derived: derived(), onOpen }));
/** The dialog a link asked the Advanced tab to open, cleared as it is read. */
const askedModal = () => {
  const request = pendingPanelModal();
  if (request) takePanelModalRequest(request);
  return request?.page;
};
const library = (bot: Bot) => capture(() => LibraryPage({ bot }));
const librarySection = (bot: Bot) => capture(() => LibrarySection({ bot, onOpen }));
const computer = (bot: Bot) => capture(() => ComputerTab({ bot, derived: derived(), onOpen }));
const find = (rendered: { nodes: Node[] }, attr: string, value: unknown = true) => {
  const found = rendered.nodes.find((node) => node.props[attr] === value);
  if (!found) throw new Error(`no node with ${attr}=${String(value)}`);
  return found;
};
const has = (rendered: { nodes: Node[] }, attr: string, value: unknown = true) => rendered.nodes.some((node) => node.props[attr] === value);
const panelWrappers = new Map<unknown, unknown>([[DetailsTab, PanelDetailsTab], [AdvancedTab, PanelAdvancedTab], [AvatarEditorCard, PanelAvatarEditor]]);
const ofType = (rendered: { nodes: Node[] }, type: unknown) => rendered.nodes.find((node) => node.type === type || node.type === panelWrappers.get(type));
const click = (node: Node, detail = 1) => (node.props.onClick as (event: { detail: number }) => void)({ detail });
const change = (node: Node, value: string) => (node.props.onChange as (event: unknown) => void)({ target: { value } });
const submit = (node: Node) => (node.props.onSubmit as (event: unknown) => void)({ preventDefault: () => {} });
const key = (node: Node, name: string) => {
  const event = { key: name, defaultPrevented: false, target: null, preventDefault: vi.fn(), stopPropagation: vi.fn() };
  (node.props.onKeyDown as (event: unknown) => void)(event);
  return event;
};
const shown = (rendered: Rendered) => ({
  tab: rendered.nodes.find((node) => node.type === SegmentedTabs)?.props.value as string | undefined,
  page: rendered.nodes.find((node) => node.type === PanelPageBody)?.props.page,
});
const selectTab = (rendered: Rendered, tab: string) => (ofType(rendered, SegmentedTabs)!.props.onChange as (tab: string) => void)(tab);
// Bot settings is an alias of the Advanced tab now, as Grok keeps only Share and Close on top.
const openSettings = (bot: Bot) => {
  selectTab(panel(bot), "details");
  (ofType(panel(bot), DetailsTab)!.props.onOpen as (page: string) => void)("settings");
};
const header = (rendered: Rendered) => ({
  back: find(rendered, "data-panel-back").props.title as string,
  title: find(rendered, "data-panel-page-title").props.children as string,
});
const goBack = (rendered: Rendered) => click(find(rendered, "data-panel-back"));
const skill = (name: string, enabled: boolean, origin?: ManagedSkill["origin"]): ManagedSkill =>
  ({ name, description: `${name} helper`, enabled, source: "github:x/y", warnings: [], ...(origin ? { origin } : {}) });
const routine = (extra: Partial<Routine> = {}): Routine => ({
  id: "r1", name: "Morning brief", prompt: "Brief me", target: "bot", botId: "scout", runOn: "maus", enabled: true,
  schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, durationMinutes: 15,
  nextRunAt: Date.UTC(2099, 0, 5, 9), createdAt: 1, updatedAt: 1, ...extra,
});
const app = (slug: string, scope: "read" | "write" | null) => ({
  slug, label: slug[0]!.toUpperCase() + slug.slice(1), blurb: `${slug} things`, card: { logo: null, domain: null, label: slug }, scope,
});
const engine = (extra: Partial<InstanceInfo> & { capabilities?: Record<string, unknown> } = {}) => ({
  instanceId: "claude", driverKind: "claudeAgent", snapshot: { state: "available", authenticated: true },
  capabilities: { effortLevels: ["low", "medium", "high", "max"] }, ...extra,
});
const memoryDoc = (text: string): MemoryDoc => ({ path: "MEMORY.md", text, hash: "h1", exists: true });
const switches = (html: string) => html.match(/role="switch"/g)?.length ?? 0;

beforeEach(() => {
  fixture.advanced = false;
  fixture.setAdvanced = vi.fn();
  fixture.ownerOrAdmin = false;
  fresh();
  fixture.index = 0;
  fixture.dispatch = vi.fn();
  fixture.api = vi.fn(() => Promise.resolve({}));
  fixture.saveMemory = vi.fn((_bot: unknown, path: unknown, text: unknown) => Promise.resolve({ ok: true, doc: { path, text, hash: "h2", exists: true } }));
  fixture.openExternal = vi.fn(() => Promise.resolve());
  fixture.storeState = { settingsOpen: true, botSettingsSection: "overview", botSettingsExpandAccordion: false };
  fixture.otherServer = null;
  fixture.skills = {
    skills: [], loading: false, working: "", error: "", reviewing: null, toggle: vi.fn(() => Promise.resolve()),
    setWorking: vi.fn(), setError: vi.fn(), refresh: vi.fn(() => Promise.resolve()), putAssignments: vi.fn(() => Promise.resolve()),
  };
  fixture.memory = { docs: null, error: false, mine: false, setDoc: vi.fn(), reload: vi.fn(() => Promise.resolve()) };
  patch.mockReset();
  onOpen.mockReset();
  onClose.mockReset();
  fixture.derived = {
    patch, approvalMode: "ask", engine: engine(), trustedModesAvailable: false, activeState: "idle",
    botRoutines: [], canCoordinate: true, sectionName: "general", mascotMotion: null,
    canUseConnectedApps: true, connectedAppsConfigured: true, connectedAppsEnabled: true, browserEnabled: true,
  };
  fixture.apps = { phase: "ready", apps: [], connectedSlugs: [] };
  fixture.places = {
    cloud: [true, true, "cloud desktop"], vm: [true, true, "private desktop"], local: [true, true, "your screen"], browser: [true, true, "web pages only"],
  };
  (window as unknown as { madaniDesktop?: unknown }).madaniDesktop = undefined;
});

describe("the bot panel in Simple mode", () => {
  it("has Share and a close button on top, the hero, three tabs: Details, Computer and Advanced", () => {
    const bot = makeBot();
    const rendered = panel(bot);
    expect(ofType(rendered, PanelShareMenu)!.props.bot).toBe(bot);
    expect(has(rendered, "data-panel-gear")).toBe(false);
    click(find(rendered, "aria-label", "Close panel"));
    expect(onClose).toHaveBeenCalled();
    const hero = ofType(rendered, PanelHero)!;
    expect(hero.props.bot).toBe(bot);
    expect(hero.props.patch).toBe(patch);
    const tabs = [...rendered.html.matchAll(/data-panel-tab="(\w+)"[^>]*>([^<]+)<\/button>/g)].map((match) => [match[1], match[2]]);
    expect(tabs).toEqual([["details", "Details"], ["computer", "Computer"], ["advanced", "Advanced"]]);
    expect(shown(rendered)).toEqual({ tab: "details", page: undefined });
    expect(ofType(rendered, DetailsTab)!.props.bot).toBe(bot);
    expect(rendered.html).toContain('id="bot-settings-title"');
  });

  it("switches tabs", () => {
    const bot = makeBot();
    for (const [tab, type] of [["computer", ComputerTab], ["advanced", AdvancedTab], ["details", DetailsTab]] as const) {
      selectTab(panel(bot), tab);
      const rendered = panel(bot);
      expect(shown(rendered).tab).toBe(tab);
      expect(ofType(rendered, type)).toBeDefined();
    }
  });

  it("opens Bot settings on the Advanced tab, and its apps with Back to Advanced in Grok's sub-page header", () => {
    const bot = makeBot();
    selectTab(panel(bot), "computer");
    openSettings(bot);
    const settings = panel(bot);
    expect(shown(settings)).toEqual({ tab: "advanced", page: undefined });
    expect(ofType(settings, AdvancedTab)!.props.bot).toBe(bot);
    expect(ofType(settings, PanelShareMenu)).toBeDefined();
    (ofType(settings, AdvancedTab)!.props.onOpen as (page: string) => void)("apps");
    const apps = panel(bot);
    expect(header(apps)).toEqual({ back: "Advanced", title: "Apps it can use" });
    expect(apps.html).toContain("Switch on the apps Scout may use. Everything else stays off.");
    goBack(apps);
    expect(shown(panel(bot))).toEqual({ tab: "advanced", page: undefined });
  });

  it("draws the Advanced tab: Library, Voice chat, This bot, then every other section in the list, no Model and no app-wide link", () => {
    const bot = makeBot();
    const rendered = capture(() => AdvancedTab({ bot, derived: derived(), onOpen }));
    const order = ['data-panel-card="library"', 'data-panel-card="call"', 'data-panel-card="uses"', 'data-panel-card="access"', 'data-panel-card="actions"'].map((marker) => rendered.html.indexOf(marker));
    expect(order.every((at, index) => at > 0 && (index === 0 || at > order[index - 1]!))).toBe(true);
    expect(rendered.html).not.toContain('data-panel-card="model"');
    // nothing is folded away
    expect(rendered.html).not.toContain("<details");
    expect(rendered.html).not.toContain(">More settings<");
    for (const label of ["Voice chat", "This bot", "Actions"]) expect(rendered.html).toContain(`>${label}<`);
    // an empty library is grok's centred line, with no heading or card over it
    expect(rendered.html).not.toContain(">Library<");
    expect(rendered.html).not.toContain(">settings for the whole app<");
    expect(rendered.html).not.toContain("advanced-features");
    expect(rendered.html).not.toContain(">Advanced features<");
  });

  it("drills into a page and back, naming where Back goes", () => {
    const bot = makeBot();
    (ofType(panel(bot), DetailsTab)!.props.onOpen as (page: string) => void)("routines");
    const page = panel(bot);
    expect(shown(page)).toEqual({ tab: undefined, page: "routines" });
    expect(has(page, "role", "tablist")).toBe(false);
    expect(header(page)).toEqual({ back: "Details", title: "Routines" });
    expect(page.html).toContain('id="bot-settings-title"');
    goBack(page);
    expect(shown(panel(bot))).toEqual({ tab: "details", page: undefined });

    selectTab(panel(bot), "advanced");
    (ofType(panel(bot), AdvancedTab)!.props.onOpen as (page: string) => void)("memory");
    expect(header(panel(bot))).toEqual({ back: "Advanced", title: "What it remembers" });
    goBack(panel(bot));

    selectTab(panel(bot), "computer");
    (ofType(panel(bot), ComputerTab)!.props.onOpen as (page: string) => void)("browser");
    expect(header(panel(bot))).toEqual({ back: "Computer", title: "Signed-in sites" });
  });

  it("goes back on Escape from a page, and leaves Escape to the dialog on a tab", () => {
    const bot = makeBot();
    (ofType(panel(bot), DetailsTab)!.props.onOpen as (page: string) => void)("routines");
    const event = key(panel(bot).nodes[0]!, "Escape");
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(shown(panel(bot)).page).toBeUndefined();
    const onTab = key(panel(bot).nodes[0]!, "Escape");
    expect(onTab.stopPropagation).not.toHaveBeenCalled();
  });

  it("opens the avatar editor from the avatar and closes it with Escape", () => {
    const bot = makeBot();
    expect(ofType(panel(bot), AvatarEditorCard)).toBeUndefined();
    (ofType(panel(bot), PanelHero)!.props.onToggleEditor as () => void)();
    const open = panel(bot);
    const editor = ofType(open, AvatarEditorCard)!;
    expect(editor.props.onPatch).toBe(patch);
    expect(editor.props.bot).toBe(bot);
    key(open.nodes[0]!, "Escape");
    expect(ofType(panel(bot), AvatarEditorCard)).toBeUndefined();
  });

  it.each([
    ["overview", "details", undefined], ["identity", "advanced", undefined], ["slack", "advanced", undefined],
    ["soul", "details", "instructions"], ["skills", "advanced", "skills"], ["memory", "advanced", "memory"],
    ["routines", "details", "routines"], ["access", "computer", "where"], ["model", "details", undefined],
    ["permissions", "advanced", undefined], ["voice", "advanced", undefined], ["visibility", "details", undefined],
    ["history", "details", undefined], ["usage", "details", undefined], ["library", "advanced", undefined],
  ] as const)("lands a deep link to %s on %s › %s", (section, tab, page) => {
    expect([sectionTarget(section).tab, sectionTarget(section).page]).toEqual([tab, page]);
    askedModal();
    const rendered = panel(makeBot(), section);
    // a page that is a dialog now opens over the Advanced tab, which holds its row
    if (isModalPage(page)) {
      expect(shown(rendered)).toEqual({ tab: "advanced", page: undefined });
      expect(askedModal()).toBe(page);
    } else if (sectionTarget(section).sheet) {
      // the bot's identity, Slack and permissions open their page of the settings sheet over the Advanced tab
      expect(shown(rendered)).toEqual({ tab: "advanced", page: undefined });
      expect(askedModal()).toBe(sectionTarget(section).sheet);
    } else if (page) expect(shown(rendered).page).toBe(page);
    else expect(shown(rendered)).toEqual({ tab, page: undefined });
    if (page) expect(PAGES[page].home).toBe(tab);
  });

  it("opens the Instructions dialog for a soul link, lands model and usage links on Details' Model card, and library on Advanced's Library", () => {
    askedModal();
    const soul = panel(makeBot(), "soul");
    expect(ofType(soul, PageBody)).toBeUndefined();
    expect(askedModal()).toBe("instructions");
    expect(sectionTarget("model")).toEqual({ tab: "details", anchor: "model" });
    expect(sectionTarget("usage")).toEqual({ tab: "details", anchor: "model" });
    expect(sectionTarget("library")).toEqual({ tab: "advanced", anchor: "library" });
  });

  // App tool grants and the working folder (the files pane) name a Simple page; MCP and tool
  // selection name none, so they land where Access does.
  it.each([["apps", "apps"], ["folder", "folder"], ["mcp", "where"], ["tools", "where"]] as const)("lands an Access link naming %s on %s", (page, landing) => {
    askedModal();
    try {
      openBotSettings(fixture.dispatch, "access", { page });
      const rendered = shown(panel(makeBot(), "access"));
      if (isModalPage(landing)) {
        expect(rendered).toEqual({ tab: "advanced", page: undefined });
        expect(askedModal()).toBe(landing);
      } else expect(rendered).toEqual({ tab: undefined, page: landing });
    } finally {
      // A link without a page lands where the section does: later tests see no trace of this one.
      openBotSettings(vi.fn(), "access");
    }
    fresh();
    expect(shown(panel(makeBot(), "access"))).toEqual({ tab: "advanced", page: undefined });
    expect(askedModal()).toBe("where");
  });

  it("shows no switch on Details or Computer, and leaves Work until done and Hide out of Bot settings", () => {
    const bot = makeBot();
    for (const tab of ["details", "computer"]) {
      selectTab(panel(bot), tab);
      expect(switches(panel(bot).html), tab).toBe(0);
    }
    openSettings(bot);
    const settings = panel(bot).html;
    expect(settings).not.toContain('aria-label="work until done"');
    expect(settings).not.toContain('aria-label="hide from sidebar"');
  });

});

describe("the hero", () => {
  const hero = (bot: Bot, editorOpen = false) =>
    capture(() => PanelHero({ bot, activeState: "idle", patch, editorOpen, onToggleEditor: vi.fn() }));

  it("names the avatar Edit Bot avatar, tips it Edit Avatar, and shows whether the editor is open", () => {
    const rendered = hero(makeBot(), true);
    expect(find(rendered, "data-panel-avatar").props["aria-label"]).toBe("Edit bot avatar");
    expect(find(rendered, "data-panel-avatar").props.title).toBe("Edit avatar");
    expect(find(rendered, "data-panel-avatar").props["aria-expanded"]).toBe(true);
    expect(rendered.html).toContain("brightness-[0.3]");
  });

  it("renames inline: Enter saves the trimmed name, a blank name saves nothing", () => {
    const bot = makeBot();
    click(find(hero(bot), "data-panel-rename"));
    const editing = hero(bot);
    const input = find(editing, "data-panel-rename-input");
    expect(input.props.value).toBe("Scout");
    change(input, "  Nova ");
    key(find(hero(bot), "data-panel-rename-input"), "Enter");
    expect(patch).toHaveBeenLastCalledWith({ name: "Nova" });
    expect(has(hero(bot), "data-panel-rename-input")).toBe(false);

    patch.mockReset();
    click(find(hero(bot), "data-panel-rename"));
    change(find(hero(bot), "data-panel-rename-input"), "   ");
    (find(hero(bot), "data-panel-rename-input").props.onBlur as () => void)();
    expect(patch).not.toHaveBeenCalled();
  });

  it("saves a rename on blur and puts the old name back on Escape", () => {
    const bot = makeBot();
    click(find(hero(bot), "data-panel-rename"));
    change(find(hero(bot), "data-panel-rename-input"), "Atlas");
    (find(hero(bot), "data-panel-rename-input").props.onBlur as () => void)();
    expect(patch).toHaveBeenLastCalledWith({ name: "Atlas" });

    patch.mockReset();
    click(find(hero(bot), "data-panel-rename"));
    change(find(hero(bot), "data-panel-rename-input"), "Atlas");
    const input = find(hero(bot), "data-panel-rename-input");
    const event = key(input, "Escape");
    expect(event.stopPropagation).toHaveBeenCalled();
    (input.props.onBlur as () => void)();
    expect(patch).not.toHaveBeenCalled();
    expect(has(hero(bot), "data-panel-rename")).toBe(true);
  });

  it("sets the name at 17px, with no label line under it", () => {
    expect(find(hero(makeBot()), "data-panel-rename").props.className).toContain("text-[17px]");
    expect(has(hero(makeBot({ title: "Researcher" })), "data-panel-label")).toBe(false);
    expect(hero(makeBot()).html).not.toContain("Add a label");
  });

});

describe("the avatar editor", () => {
  const editor = (bot: Bot) => capture(() => AvatarEditorCard({ bot, activeState: "idle", onPatch: patch, onClose }));

  it("shows the twenty pixel bodies and the electric colours by name", () => {
    const bot = makeBot();
    const rendered = editor(bot);
    expect([...rendered.html.matchAll(/aria-label="(\w+) character shape"/g)].map((match) => match[1]))
      .toEqual(MADANI_BODY_IDS.map((id) => id[0]!.toUpperCase() + id.slice(1)));
    expect([...rendered.html.matchAll(/aria-label="(\w+) character color"/g)].map((match) => match[1]))
      .toEqual(["Blue", "Cyan", "Teal", "Green", "Yellow", "Orange", "Coral", "Red", "Pink", "Purple"]);
    expect(rendered.html.toLowerCase()).not.toContain("more looks");
    expect(find(rendered, "aria-label", "Kit character shape").props["aria-pressed"]).toBe(true);
    expect(find(editor(makeBot({ mascotBody: "teardrop" as Bot["mascotBody"] })), "aria-label", "Drip character shape").props["aria-pressed"]).toBe(true);
    click(find(rendered, "aria-label", "Pip character shape"));
    expect(patch).toHaveBeenLastCalledWith({ mascotBody: "pip" });
    click(find(rendered, "aria-label", "Blue character color"));
    expect(patch).toHaveBeenLastCalledWith({ color: "blue" });
    expect(rendered.html).not.toContain("Silver character color");
  });

  it("switches back to the mascot when a body is picked over a picture", () => {
    const bot = makeBot({ avatarUrl: "/api/attachments/cat.webp", avatarCrop: "circle" });
    click(find(editor(bot), "aria-label", "Starry character shape"));
    expect(patch).toHaveBeenLastCalledWith({ mascotBody: "starry", avatarCrop: "mascot" });
  });

  it("shows only the character shapes and colors: no tabs, generator, upload or reset", () => {
    const rendered = editor(makeBot());
    expect(rendered.html).not.toContain("data-avatar-tab");
    expect(rendered.html).not.toContain("data-avatar-reset");
    expect(rendered.html).not.toContain("data-avatar-drop");
  });

  it("closes on Escape without letting the dialog close settings", () => {
    const event = key(editor(makeBot()).nodes[0]!, "Escape");
    expect(onClose).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });
});


describe("the Details tab", () => {
  it("holds routines (or what they are), then the Model card, and no Voice chat", () => {
    const rendered = botTab(makeBot());
    const order = ['data-panel-empty="routines"', 'data-panel-card="model"', 'data-panel-row="model"'].map((marker) => rendered.html.indexOf(marker));
    expect(order.every((index) => index > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(rendered.html).toContain('data-panel-sections=""');
    for (const gone of ['data-panel-card="call"', 'data-panel-row="voice"', 'data-panel-gear', 'data-conversations-new', 'data-panel-row="goal"', 'data-panel-row="approval"', 'data-panel-row="call-mode"']) {
      expect(rendered.html, gone).not.toContain(gone);
    }
    expect(rendered.html).not.toContain(">routines<");
    expect(switches(rendered.html)).toBe(0);
  });

  it("says what routines are while the bot has none, in Grok's words, and lists them once it has some", () => {
    const empty = botTab(makeBot());
    expect(empty.html).toContain(">Routines are recurring tasks this bot runs on a schedule. Ask it in chat to set one up.<");
    // just the line, no pixel art or title
    expect(empty.html).not.toContain("data-art-state");
    expect(empty.html).not.toContain("No routines yet");
    // routines are set up in chat, so the panel offers no button of its own
    expect(empty.html).not.toContain('data-panel-action="new-routine"');
    fixture.storeState = { ...fixture.storeState, routines: [routine()] };
    const some = botTab(makeBot());
    expect(some.html).not.toContain('data-panel-empty="routines"');
    expect(some.html).toContain(">Routines<");
  });

  it("lists each routine in the order it was made, with its switch and its schedule in plain words, each opening a sheet", () => {
    fixture.storeState = { ...fixture.storeState, routines: [routine({ id: "r2", name: "Paused one", enabled: false, createdAt: 2 }), routine(), routine({ id: "r3", name: "Another", botId: "other", createdAt: 3 })] };
    const rendered = botTab(makeBot());
    expect([...rendered.html.matchAll(/data-panel-routine="([^"]+)"/g)].map((match) => match[1])).toEqual(["r1", "r2"]);
    expect(switches(rendered.html)).toBe(2);
    expect(rendered.html).toContain(">Paused<");
    expect(rendered.html).toContain(">Every weekday at 9 AM<");
    expect(rendered.html).toContain('aria-haspopup="dialog"');
    expect(rendered.html).not.toContain("aria-expanded=\"false\"");
    expect(rendered.html).not.toContain('data-panel-action="new-routine"');
  });

  it("offers Grok's speeds and languages on the Advanced tab, kept per bot", () => {
    const html = capture(() => AdvancedTab({ bot: makeBot(), derived: derived(), onOpen })).html;
    expect(html).toMatch(/data-panel-select="speed"[^>]*>.*?>1x</);
    expect(html).toMatch(/data-panel-select="language"[^>]*>.*?>Auto-detect</);
    expect(VOICE_SPEEDS).toEqual(["0.5", "0.75", "1", "1.25", "1.5", "2"]);
    expect(VOICE_LANGUAGES).toHaveLength(29);
  });

});

describe("the Bot settings page", () => {
  it("leads with what the bot knows, then the rest and the actions in the list, and leaves where it works to the Computer tab", () => {
    const rendered = settingsPage(makeBot());
    expect(rendered.html).not.toContain('data-panel-card="model"');
    const order = ['data-panel-card="uses"', 'data-panel-card="access"', 'data-panel-card="actions"'].map((marker) => rendered.html.indexOf(marker));
    expect(order.every((index) => index > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const pages = [...rendered.html.matchAll(/data-panel-page="(\w+)"/g)].map((match) => match[1]);
    expect(pages).toEqual(["identity", "instructions", "memory", "skills", "tools", "permissions", "folder", "backups"]);
    expect(rendered.html).not.toContain('data-panel-advanced="settings"');
    for (const page of pages) {
      click(find(rendered, "data-panel-page", page));
      expect(onOpen).toHaveBeenLastCalledWith(page);
    }
    for (const gone of ['data-panel-row="approval"', "before Scout acts", "data-panel-done"]) expect(rendered.html).not.toContain(gone);
  });

  it("draws every row on one line with its value on the right, as Grok's Voice row, and no helper lines", () => {
    const rendered = settingsPage(makeBot({ memoryEnabled: false }));
    const row = (page: string) => find(rendered, "data-panel-page", page).props;
    expect(row("memory").value).toBe("Off");
    expect(row("skills").value).toBe("None");
    expect(row("backups").value).toBe("None");
    for (const page of ["instructions", "memory", "skills", "folder", "backups"]) expect(row(page).hint, page).toBeUndefined();
    // instructions already written need no value; an empty one says None
    expect(row("instructions").value).toBeUndefined();
    expect(find(settingsPage(makeBot({ soul: "" })), "data-panel-page", "instructions").props.value).toBe("None");
  });

  it("has no rows for apps, signed-in sites, the API, conversations, Work until done, Hide, Call mode or the label", () => {
    const rendered = settingsPage(makeBot());
    for (const page of ["apps", "browser", "api", "threads"]) expect(rendered.html, page).not.toContain(`data-panel-page="${page}"`);
    for (const row of ["goal", "call-mode", "job", "hide"]) expect(rendered.html, row).not.toContain(`data-panel-row="${row}"`);
  });

  it("duplicates the bot and asks before deleting all its conversations", () => {
    const rendered = settingsPage(makeBot());
    click(find(rendered, "data-panel-row", "duplicate"));
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "duplicateBot", botId: "scout" });
    expect(find(rendered, "data-panel-row", "delete-all").props.danger).toBe(true);
  });
});

describe("the Library", () => {
  it("says what it will hold while the bot has made nothing, in Grok's words, and nothing else", () => {
    const rendered = library(makeBot());
    expect(rendered.html).toContain('data-panel-empty="library"');
    expect(rendered.html).toContain(">Pages, files, and apps this bot makes show up here<");
    expect(rendered.html).not.toContain("data-art-state");
    expect(rendered.html).not.toContain("Nothing made yet");
    for (const gone of ["memory", "skills", "folder"]) expect(has(rendered, "data-panel-page", gone), gone).toBe(false);
  });

  it("sits on top of the Advanced tab as a Library section, Grok's centred empty line until the bot makes something, with no View all", () => {
    const rendered = librarySection(makeBot());
    expect(rendered.html).toContain('data-panel-card="library"');
    expect(rendered.html).not.toContain(">library<");
    expect(rendered.html).not.toContain("data-panel-card-surface");
    expect(rendered.html).toContain(">Pages, files, and apps this bot makes show up here<");
    expect(has(rendered, "data-panel-page", "library")).toBe(false);
  });
});

describe("the Computer tab", () => {
  // a screen belongs to a bot whose computer is a VPS or the cloud; one on this computer has none to show
  beforeEach(() => { fixture.otherServer = "Studio VPS"; });
  const cloudBot = (extra: Partial<Bot> = {}) => makeBot({ computer: "cloud", ...extra });
  const cta = (bot: Bot, stage: Parameters<typeof CloudCtaCard>[0]["stage"], cloudDesktop: Parameters<typeof CloudCtaCard>[0]["cloudDesktop"] = null) =>
    capture(() => CloudCtaCard({ bot, stage, cloudDesktop }));

  it("renders the original grey sleeping mascot and caption before the live panel module or status resolves", () => {
    const rendered = computer(cloudBot());
    expect(rendered.html).toContain('data-asleep-mascot=""');
    expect(rendered.html).toContain('computer-asleep-breathe');
    expect(rendered.html).toContain('var(--color-ink) 56%');
    expect(rendered.html).toContain(">Computer is asleep<");
    expect(rendered.html).toContain("Scout&#x27;s screen");
    expect(rendered.html).not.toContain('animate-spin');
    for (const gone of ["where", "browser"]) expect(has(rendered, "data-panel-page", gone), gone).toBe(false);
    expect(switches(rendered.html)).toBe(0);
  });

  it("delegates live pixels and explicit viewer control to the inline computer panel", () => {
    const rendered = computer(cloudBot({ messages: [{ id: "m1", role: "assistant", kind: "screen", hasImage: true, mime: "image/png", text: "", at: 0 }] as unknown as Bot["messages"] }));
    const live = rendered.nodes.find((node) => node.props.inline === true);
    expect(live?.props.bot).toMatchObject({ id: "scout" });
    expect(rendered.html).not.toContain("<img");
    expect(rendered.html).not.toContain(">take control<");
  });

  it("keeps Off truthful and shows the old asleep placeholder while Auto resolves", () => {
    const off = computer(makeBot({ computer: "off" }));
    expect(has(off, "data-panel-action", "open-computer")).toBe(false);
    expect(off.html).toContain(">No screen<");
    const auto = computer(makeBot());
    expect(auto.html).toContain('data-asleep-mascot=""');
    expect(auto.html).toContain(">Computer is asleep<");
  });

  it("keeps the panel and dropdown in place while its inline viewer owns opening and control", () => {
    const rendered = computer(cloudBot());
    expect(rendered.nodes.find((node) => node.props.inline === true)).toBeDefined();
    expect(has(rendered, "data-panel-select", "place")).toBe(false);
    expect(rendered.nodes.some((node) => node.props.fullscreen !== undefined)).toBe(false);
    expect(fixture.dispatch).not.toHaveBeenCalledWith({ type: "toggleComputer", open: true });
    expect(fixture.dispatch).not.toHaveBeenCalledWith({ type: "toggleSettings", open: false });
  });

  it("on a server leads with the screen, then the move to madani cloud, with no screen picker, Advanced fold or move back", () => {
    const rendered = computer(cloudBot());
    const screen = rendered.html.indexOf('data-asleep-mascot=""'), card = rendered.html.indexOf('data-panel-card="cloud-desktop"');
    expect(screen).toBeGreaterThan(-1);
    expect(card).toBeGreaterThan(screen);
    expect(rendered.html).toContain(">Scout&#x27;s screen<");
    expect(rendered.html, "no server name under the screen").not.toContain("Studio VPS");
    expect(rendered.html).toContain(">Move to madani cloud<");
    expect(rendered.html).toContain(">Keep Scout working<");
    expect(rendered.html, "a server is always on: no sleep pitch").not.toMatch(/never sleeps|asleep or off/);
    for (const gone of ['data-panel-card="runs-on"', 'data-panel-select="place"', 'data-panel-advanced="computer"', 'data-panel-action="move-home"', 'data-panel-action="move-vps"']) {
      expect(rendered.html, gone).not.toContain(gone);
    }
  });

  it("on this computer drops the screen choice and preview, and offers madani cloud through checkout", () => {
    fixture.otherServer = null;
    const rendered = computer(cloudBot());
    expect(rendered.html).not.toContain('data-asleep-mascot=""');
    expect(rendered.html).not.toContain('data-panel-screen-of=""');
    expect(rendered.nodes.some((node) => node.props.inline === true)).toBe(false);
    // the card follows the bot's browser section once its first answer is in (5f1035a31), so it is handed over, not drawn yet
    const after = rendered.nodes.map((node) => node.props.after).find(isValidElement) as Node | undefined;
    expect(after?.type).toBe(CloudCtaCard);
    expect(rendered.html).not.toContain('data-panel-card="runs-on"');
    const card = cta(cloudBot(), null);
    expect(card.html).toContain('data-panel-card="madani-cloud"');
    expect(card.html).toContain('data-cloud-cta="get"');
    expect(card.html).toContain('data-cloud-hop="laptop"');
    expect(card.html).toContain(">Keep Scout working<");
    expect(card.html).toContain(">Get madani cloud<");
    click(find(card, "data-panel-action", "move-cloud"));
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "openCloudAdd", source: "app_bot_panel" });
  });

  it("in the store phone app shows this computer's bot its browser, never a blank tab or the madani cloud offer", () => {
    fixture.otherServer = null;
    const before = globalThis.document;
    vi.stubGlobal("document", { documentElement: { dataset: { mobileApp: "android" } } });
    try {
      const rendered = computer(cloudBot());
      const section = rendered.nodes.find((node) => "askFirst" in node.props);
      expect(section?.props.bot).toMatchObject({ id: "scout" });
      expect(section?.props.after).toBe(false);
      expect(rendered.html).not.toContain('data-panel-card="madani-cloud"');
    } finally {
      vi.stubGlobal("document", before);
    }
  });

  it("on this computer still shows a Private desktop bot's own screen, with the madani cloud offer under it", () => {
    fixture.otherServer = null;
    const rendered = computer(makeBot({ computer: "vm" }));
    expect(rendered.nodes.find((node) => node.props.inline === true)?.props.bot).toMatchObject({ id: "scout" });
    expect(rendered.html).toContain('data-asleep-mascot=""');
    expect(rendered.html).toContain(">Scout&#x27;s screen<");
    const screen = rendered.html.indexOf('data-asleep-mascot=""'), card = rendered.html.indexOf('data-panel-card="madani-cloud"');
    expect(card).toBeGreaterThan(screen);
    expect(has(rendered, "data-local-browser-first")).toBe(false);
  });

  it("in a group chat is one card for all of its bots, in the group's words", () => {
    fixture.otherServer = null;
    const group = [cloudBot(), { ...cloudBot(), id: "nova", name: "Nova" }];
    const card = capture(() => CloudCtaCard({ bot: group[0]!, group, stage: null, cloudDesktop: null }));
    expect(card.html).toContain('data-cloud-group=""');
    expect(card.html).toContain(">Keep this group working<");
    expect(card.html).not.toContain("Scout");
    expect(card.html.match(/data-bot-at=/g)).toHaveLength(2);
  });

  it("on this computer with a madani cloud offers the move, then the switch once the bots live there, never the checkout", () => {
    fixture.otherServer = null;
    const openHome = vi.fn(() => Promise.resolve());
    const desktop = { openHome } as unknown as Parameters<typeof CloudCtaCard>[0]["cloudDesktop"];
    const ready = cta(cloudBot(), "ready", desktop);
    expect(ready.html).toContain(">Move to madani cloud<");
    expect(ready.html).toContain('data-cloud-hop="laptop"');
    const moved = cta(cloudBot(), "moved", desktop);
    expect(moved.html).toContain(">Switch to madani cloud<");
    expect(moved.html).toContain(">Keep Scout working<");
    expect(moved.html).toContain("On madani cloud, Scout keeps replying even when this");
    expect(moved.html).not.toContain("is on madani cloud");
    expect(moved.html).not.toContain("keeps working while");
    click(find(moved, "data-panel-action", "move-cloud"));
    expect(openHome).toHaveBeenCalledTimes(1);
    expect(fixture.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "openCloudAdd" }));
    expect(cloudCtaStep("moving")).toBe("moving");
    expect(cloudCtaStep("buy")).toBe("get");
  });
});

describe("the Computer tab with a madani cloud already", () => {
  it("never offers to buy madani cloud again: only an account with no cloud, or one still at checkout, sees the offer", () => {
    for (const stage of ["ready", "preparing", "moving", "moved", "open", "manage", "coming-back"] as const) expect(hasMadaniCloud(stage), stage).toBe(true);
    for (const stage of [null, "buy", "resume", "elsewhere"] as const) expect(hasMadaniCloud(stage), String(stage)).toBe(false);
  });

  const SCREEN_OFF = { host: { platform: "darwin", label: "This Mac", session: "unknown", packaged: true }, windowChrome: "mac-inset",
    screenPreview: { available: false, interaction: "none" }, dictation: { available: false, engine: "none", onDevice: false },
    localComputer: { available: false, support: "supported", enabled: true, status: "unavailable", reasonCode: "permission-denied" } };
  const macPermissions = { status: () => Promise.resolve({ supported: true, screen: "missing", accessibility: "missing" }), request: () => Promise.resolve({ supported: false }) };
  const tab = (bot: Bot) => {
    fixture.otherServer = null;
    fixture.cloudDesktop = { view: { step: "open" }, keep: { shown: false, moved: false }, openHome: () => Promise.resolve(), dialog: null };
    fixture.capabilities = SCREEN_OFF;
    const shell = window as unknown as { madaniDesktop?: unknown };
    shell.madaniDesktop = { platform: "darwin", macPermissions };
    try {
      const rendered = computer(bot);
      const section = rendered.nodes.find((node) => isValidElement(node.props.after));
      return { rendered, section, after: section?.props.after as { type: unknown } | undefined };
    } finally {
      fixture.cloudDesktop = undefined;
      fixture.capabilities = undefined;
      delete shell.madaniDesktop;
    }
  };

  it("leads with the browser on This Mac without screen permission, with no screen or permission words, then the madani cloud card", () => {
    const { rendered, section, after } = tab(makeBot({ computer: "local" }));
    expect(rendered.nodes.some((node) => node.props.inline === true), "never this Mac's screen").toBe(false);
    for (const gone of ['data-asleep-mascot=""', "Bots can&#x27;t use this Mac yet", "Your madani cloud has its own computer", "Screen control", 'data-panel-screen-off']) {
      expect(rendered.html, gone).not.toContain(gone);
    }
    expect(after?.type).toBe(CloudCtaCard);
    // the Start browser pill asks for this Mac's permissions first, only for a bot set to use this Mac
    expect(section?.props.askFirst).toBe(macPermissions);
    expect(tab(makeBot()).section?.props.askFirst).toBeNull();
  });

  it("offers the switch to the cloud for a bot still on This Mac, in the offer's words, never that it is there", () => {
    const openHome = vi.fn(() => Promise.resolve());
    const desktop = { openHome } as unknown as Parameters<typeof CloudCtaCard>[0]["cloudDesktop"];
    const card = capture(() => CloudCtaCard({ bot: makeBot(), stage: "open", cloudDesktop: desktop }));
    expect(card.html).toContain(">Keep Scout working<");
    expect(card.html).toContain(">Switch to madani cloud<");
    expect(card.html).not.toContain("is on madani cloud");
    click(find(card, "data-panel-action", "move-cloud"));
    expect(openHome).toHaveBeenCalledTimes(1);
  });
});

describe("the Where it works page", () => {
  const where = (bot: Bot) => capture(() => WherePage({ bot, derived: derived() }));
  const choices = (rendered: Rendered) => rendered.nodes.filter((node) => node.props["data-panel-choice"] !== undefined)
    .map((node) => [node.props["data-panel-choice"], node.props.title, Boolean(node.props.disabled), node.props.checked]);
  const choose = (rendered: Rendered, value: string) => click(find(rendered, "data-panel-choice", value));

  it("offers Let it choose, this computer, the bot's browser and the Cloud desktop, with the chosen one checked", () => {
    // The tests run on no platform in particular, so it reads This computer; a Mac says This Mac and Windows This PC.
    expect(choices(where(makeBot()))).toEqual([
      ["auto", "Let it choose", false, true], ["local", "This computer", false, false], ["browser", "Browser", false, false], ["cloud", "Cloud desktop", false, false],
    ]);
    expect(where(makeBot()).html).toContain('role="radiogroup"');
  });

  it("saves each place through the bot patch, and sends nothing for the place already chosen", () => {
    const rendered = where(makeBot());
    choose(rendered, "cloud");
    expect(patch).toHaveBeenLastCalledWith({ computer: "cloud" });
    choose(rendered, "local");
    expect(patch).toHaveBeenLastCalledWith({ computer: "local" });
    choose(rendered, "browser");
    expect(patch).toHaveBeenLastCalledWith({ computer: "browser", browser: true });
    choose(where(makeBot({ computer: "cloud" })), "auto");
    expect(patch).toHaveBeenLastCalledWith({ computer: null });
    patch.mockReset();
    choose(where(makeBot({ computer: "cloud" })), "cloud");
    expect(patch).not.toHaveBeenCalled();
  });

  it.each([["vm", "Private desktop"], ["off", "Off"]] as const)("shows a bot kept on %s as a last, checked choice it cannot pick again", (place, label) => {
    const rendered = where(makeBot({ computer: place }));
    expect(choices(rendered).at(-1)).toEqual([place, label, true, true]);
    choose(rendered, place);
    expect(patch).not.toHaveBeenCalled();
    choose(rendered, "auto");
    expect(patch).toHaveBeenLastCalledWith({ computer: null });
  });

  it("holds a place the bot cannot use with the reason as its hint, and leaves out the Cloud desktop when none is offered", () => {
    fixture.places.cloud = [true, false, "not ready"];
    expect(find(where(makeBot()), "data-panel-choice", "cloud").props).toMatchObject({ disabled: true, hint: "not ready." });
    fixture.places.cloud = [false, false, "Not offered"];
    expect(choices(where(makeBot())).map(([value]) => value)).toEqual(["auto", "local", "browser"]);
    fixture.places.local = [false, false, "Not offered"];
    fixture.places.browser = [false, false, "Not offered"];
    expect(choices(where(makeBot())).map(([value]) => value)).toEqual(["auto"]);
    expect(choices(where(makeBot({ computer: "browser" }))).map(([value, , disabled]) => [value, disabled])).toEqual([["auto", false], ["browser", true]]);
  });

  it("names the browser My Chrome when the bot's profile is the person's own Chrome", () => {
    fixture.storeState = { ...fixture.storeState, config: { browserEngine: { myChrome: true }, browserProfiles: [{ id: "bank", name: "Bank", browser: "chrome" }] } };
    expect(find(where(makeBot({ browserProfile: "bank" })), "data-panel-choice", "browser").props.title).toBe("My Chrome");
    expect(find(where(makeBot()), "data-panel-choice", "browser").props.title).toBe("Browser");
  });

  it("says where the bot works right now when that is not the place chosen", () => {
    const html = where(makeBot({ computer: "cloud", tasks: [{ threadId: "thread-scout", title: "Main", surface: "local" }] as Bot["tasks"] })).html;
    expect(html).toContain("Right now: This computer");
  });

  it("warns before this computer for a bot that decides alone", () => {
    fixture.derived.approvalMode = "auto";
    const bot = makeBot();
    choose(where(bot), "local");
    expect(patch).not.toHaveBeenCalled();
    const warning = ofType(where(bot), LocalComputerAutoWarning)!;
    expect(warning.props.open).toBe(true);
    (warning.props.onConfirm as () => void)();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "updateBot", botId: "scout", patch: { computer: "local", acknowledgeLocalAuto: true } });
  });
});

describe("the drill-in pages", () => {
  const PAGE = {
    settings: SettingsPage, apps: AppsPage, routines: RoutinesPage, memory: MemoryPage, skills: SkillsPage, folder: FolderPage, browser: BrowserPage, where: WherePage,
  } as const;
  // The walker reads only what a component returns, so each page is called as the function PageBody picks.
  const body = (page: keyof typeof PAGE, bot = makeBot()) => capture(() => PAGE[page]({ bot, derived: derived() }) as ReactNode);

  it("draws one component per Simple page", () => {
    for (const page of Object.keys(PAGE) as Array<keyof typeof PAGE>) {
      const picked = ofType(capture(() => PageBody({ page, bot: makeBot(), derived: derived() }) as ReactNode), PAGE[page])!;
      expect(picked.props.bot, page).toMatchObject({ id: "scout" });
    }
  });
  const row = (rendered: { nodes: Node[] }, id: string) => find(rendered, "data-panel-row", id);

  it("gives each connected app one switch that writes the same scopes as Access, with no scopes or tool grants", () => {
    fixture.apps = { phase: "ready", connectedSlugs: ["github", "gmail", "slack"], apps: [app("github", "write"), app("gmail", "write"), app("slack", "write")] };
    const rendered = body("apps");
    expect(switches(rendered.html)).toBe(3);
    expect(rendered.html).not.toContain("Let Scout use apps");
    expect(rendered.html).not.toContain("read only");
    expect(rendered.html).not.toContain("github things");
    click(find(rendered, "aria-label", "Scout can use Github"));
    expect(patch).toHaveBeenLastCalledWith({ connectorScopes: { apps: { gmail: "write", slack: "write" } } });

    fixture.apps = { phase: "ready", connectedSlugs: ["github", "gmail", "slack"], apps: [app("github", null), app("gmail", "read"), app("slack", "write")] };
    const scoped = body("apps", makeBot({ connectorScopes: { apps: { gmail: "read", slack: "write" } } }));
    expect(find(scoped, "aria-label", "Scout can use Github").props.checked).toBe(false);
    click(find(scoped, "aria-label", "Scout can use Github"));
    expect(patch).toHaveBeenLastCalledWith({ connectorScopes: { apps: { gmail: "read", slack: "write", github: "write" } } });
  });

  it("switching an app on while apps are off for the bot turns them on with only that app", () => {
    fixture.derived.connectedAppsEnabled = false;
    fixture.apps = { phase: "ready", connectedSlugs: ["gmail", "slack"], apps: [app("gmail", null), app("slack", null)] };
    click(find(body("apps", makeBot({ composio: false })), "aria-label", "Scout can use Gmail"));
    expect(patch).toHaveBeenLastCalledWith({ connectorScopes: { apps: { gmail: "write" } }, composio: true });
    patch.mockReset();
    click(find(body("apps", makeBot({ composio: false, connectorScopes: { apps: { slack: "write" } } })), "aria-label", "Scout can use Gmail"));
    expect(patch).toHaveBeenLastCalledWith({ connectorScopes: { apps: { slack: "write", gmail: "write" } }, composio: true });
  });

  it("says what it knows about the apps: checking, unreadable, empty or unusable, and leads to the catalog", () => {
    fixture.apps = { phase: "loading", apps: [], connectedSlugs: [] };
    expect(body("apps").html).toContain("Checking…");
    fixture.apps = { phase: "unknown", apps: [], connectedSlugs: [] };
    expect(body("apps").html).toContain("Couldn&#x27;t check your apps just now.");
    fixture.apps = { phase: "ready", apps: [], connectedSlugs: [] };
    const empty = body("apps");
    expect(empty.html).toContain("No apps connected yet");
    expect(empty.html).toContain('data-art-state="apps"');
    click(find(empty, "data-panel-link", "add-app"));
    expect((fixture.dispatch as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      [{ type: "togglePlugins", open: true, surface: "apps" }],
    ]);
    fixture.derived.canUseConnectedApps = false;
    fixture.apps = { phase: "ready", connectedSlugs: ["gmail"], apps: [app("gmail", "write")] };
    const cannot = body("apps");
    expect(cannot.html).toContain("The model Scout runs on can&#x27;t use apps.");
    expect(switches(cannot.html)).toBe(0);
  });

  it("draws the same routines list as the Details tab, with no logs page and no schedules link", () => {
    fixture.storeState = { ...fixture.storeState, routines: [routine()] };
    const rendered = body("routines");
    expect(ofType(rendered, BotRoutines)!.props).toMatchObject({ label: false });
    expect(rendered.html).toMatch(/aria-label="Pause Morning brief, every weekday at 9 AM"[^>]*role="switch" aria-checked="true"/);
    expect(rendered.html).not.toContain("open schedules");
    expect(has(rendered, "data-panel-action", "routine-logs")).toBe(false);
    expect(rendered.html).not.toContain('data-panel-action="new-routine"');
  });

  it("lists what MEMORY.md remembers, forgets one line through the memory file route, and adds one", async () => {
    fixture.memory.docs = [memoryDoc("# Notes\n- Likes short replies\n\n- Uses Resolve Studio\n")];
    const rendered = body("memory");
    expect(rendered.html).toContain("Likes short replies");
    expect(rendered.html).toContain("Uses Resolve Studio");
    expect(rendered.html).not.toContain("# Notes");
    expect(switches(rendered.html)).toBe(0);
    for (const text of ["Tidy now", "Upkeep", "Obsidian", "daily logs", "Journal"]) expect(rendered.html).not.toContain(text);
    click(rendered.nodes.filter((node) => node.props.label === "Forget")[0]!);
    await Promise.resolve();
    expect(fixture.saveMemory).toHaveBeenLastCalledWith("scout", "MEMORY.md", "# Notes\n\n- Uses Resolve Studio\n", "h1", false);
    await Promise.resolve();
    expect(fixture.memory.setDoc).toHaveBeenLastCalledWith(expect.objectContaining({ text: "# Notes\n\n- Uses Resolve Studio\n", hash: "h2" }));

    (find(body("memory"), "data-panel-form", "memory-add").props.onChange as (value: string) => void)("  Prefers the free version ");
    (find(body("memory"), "data-panel-form", "memory-add").props.onSubmit as () => void)();
    await Promise.resolve();
    expect(fixture.saveMemory).toHaveBeenLastCalledWith("scout", "MEMORY.md", "# Notes\n- Likes short replies\n\n- Uses Resolve Studio\n- Prefers the free version\n", "h1", false);
  });

  it("says when memory is off, empty or unreadable, and re-reads on a conflict", async () => {
    expect(body("memory", makeBot({ memoryEnabled: false })).html).toContain("Memory is off for Scout.");
    expect(has(body("memory", makeBot({ memoryEnabled: false })), "data-panel-form", "memory-add")).toBe(false);
    fixture.memory.docs = [memoryDoc("")];
    expect(body("memory").html).toContain("Nothing remembered yet");
    fixture.memory = { ...fixture.memory, docs: null, error: true };
    expect(body("memory").html).toContain("Couldn&#x27;t read the memory file just now.");

    fixture.memory = { ...fixture.memory, docs: [memoryDoc("- Old\n")], error: false };
    fixture.saveMemory = vi.fn(() => Promise.resolve({ ok: false, conflict: true, current: "- New\n", currentHash: "h3" }));
    click(find(body("memory"), "label", "Forget"));
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.memory.reload).toHaveBeenCalled();
    expect(body("memory").html).toContain("Scout changed this file while you were editing.");
  });

  it("switches skills, removes one, adds one from a link and browses the library or skills.sh", async () => {
    const off = skill("summarise", false);
    const shared = skill("triage", true, "library");
    fixture.skills.skills = [shared, off];
    const rendered = body("skills");
    expect(row(rendered, "skill:summarise").props).toMatchObject({ checked: false, label: "Use summarise", hint: "summarise helper", disabled: false });
    (row(rendered, "skill:summarise").props.onChange as () => void)();
    expect(fixture.skills.toggle).toHaveBeenCalledWith(off);
    expect(rendered.html).not.toContain("Write a command");

    click(find(rendered, "data-panel-action", "remove-skill:summarise"));
    await Promise.resolve();
    expect(fixture.api).toHaveBeenCalledWith("/api/bots/scout/skills/summarise", { method: "DELETE" });
    await Promise.resolve();
    expect(fixture.skills.refresh).toHaveBeenCalled();
    click(find(rendered, "data-panel-action", "remove-skill:triage"));
    expect(fixture.skills.putAssignments).toHaveBeenCalledWith("triage", true);

    (find(rendered, "data-panel-form", "skill-import").props.onChange as (value: string) => void)("owner/repo");
    (find(body("skills"), "data-panel-form", "skill-import").props.onSubmit as () => void)();
    await Promise.resolve();
    expect(fixture.api).toHaveBeenCalledWith("/api/bots/scout/skills", { method: "POST", body: JSON.stringify({ source: "owner/repo" }) });

    click(find(rendered, "data-panel-link", "browse-skills"));
    expect(fixture.openExternal).toHaveBeenCalledWith("https://skills.sh");
    fixture.storeState = { ...fixture.storeState, config: { features: { skillsLibrary: true } } };
    click(find(body("skills"), "data-panel-link", "browse-skills"));
    expect((fixture.dispatch as ReturnType<typeof vi.fn>).mock.calls.slice(-1)).toEqual([
      [{ type: "toggleAppSettings", open: true, section: "skills" }],
    ]);
    fixture.skills.working = "triage";
    expect(row(body("skills"), "skill:summarise").props.disabled).toBe(true);
    fixture.skills.skills = [];
    expect(body("skills").html).toContain('data-art-state="skills"');
  });

  it("keeps the bot's own private folder, or a folder chosen with the native picker, saved through the bot route", async () => {
    const pickFolder = vi.fn(() => Promise.resolve("/Users/omkar/Projects/site"));
    (window as unknown as { madaniDesktop: unknown }).madaniDesktop = { pickFolder };
    const rendered = body("folder");
    expect(find(rendered, "data-panel-choice", "private").props.checked).toBe(true);
    expect(find(rendered, "data-panel-choice", "pick").props.checked).toBe(false);
    expect(has(rendered, "data-panel-action", "pick-folder")).toBe(false);
    expect(rendered.html).not.toContain("Changed in this chat");
    click(find(rendered, "data-panel-choice", "pick"));
    await Promise.resolve();
    expect(pickFolder).toHaveBeenCalledWith(undefined);
    await Promise.resolve();
    expect(fixture.api).toHaveBeenCalledWith("/api/bots/scout", { method: "PATCH", body: JSON.stringify({ cwd: "/Users/omkar/Projects/site" }) });

    fresh();
    const chosen = body("folder", makeBot({ cwd: "/Users/omkar/Projects/site" }));
    expect(find(chosen, "data-panel-choice", "pick").props.checked).toBe(true);
    expect(chosen.html).toContain("/Users/omkar/Projects/site");
    click(find(chosen, "data-panel-action", "pick-folder"));
    expect(pickFolder).toHaveBeenLastCalledWith("/Users/omkar/Projects/site");
    click(find(chosen, "data-panel-choice", "private"));
    expect(fixture.api).toHaveBeenLastCalledWith("/api/bots/scout", { method: "PATCH", body: JSON.stringify({ cwd: null }) });
  });

  it("takes a typed path where there is no native picker", () => {
    const rendered = body("folder");
    click(find(rendered, "data-panel-choice", "pick"));
    const typed = body("folder");
    expect(find(typed, "data-panel-choice", "pick").props.checked).toBe(true);
    const form = find(typed, "data-panel-form", "folder-path");
    change(nodes(form.props.children).find((node) => node.type === "input")!, "/tmp/work");
    submit(find(body("folder"), "data-panel-form", "folder-path"));
    expect(fixture.api).toHaveBeenLastCalledWith("/api/bots/scout", { method: "PATCH", body: JSON.stringify({ cwd: "/tmp/work" }) });
  });

  it("shows only the signed-in sites on the browser page, with no browser or record-steps switch", () => {
    fixture.ownerOrAdmin = true;
    const page = body("browser");
    expect(ofType(page, BrowserLogins)!.props).toMatchObject({ bot: expect.objectContaining({ id: "scout" }), browserEnabled: true });
    const rendered = capture(() => BrowserLogins({ bot: makeBot(), browserEnabled: true, onOpenBrowser: vi.fn() }));
    expect(ofType(rendered, SignedInSites)!.props).toMatchObject({ bare: true, target: { bot: "scout" }, sharedBy: ["Scout"], disabled: false });
    expect(switches(rendered.html)).toBe(0);
    expect(rendered.html).not.toContain("Record");
    expect(rendered.html).not.toContain(">logins<");
    const onOpenBrowser = vi.fn();
    click(find(capture(() => BrowserLogins({ bot: makeBot(), browserEnabled: true, onOpenBrowser })), "data-panel-action", "add-login"));
    expect(onOpenBrowser).toHaveBeenCalled();
    fixture.derived.browserEnabled = false;
    expect(ofType(body("browser"), BrowserLogins)!.props.browserEnabled).toBe(false);
    expect(capture(() => BrowserLogins({ bot: makeBot(), browserEnabled: false, onOpenBrowser: vi.fn() })).html).toContain("Scout&#x27;s browser is off.");
  });
});

describe("the bot settings dialog", () => {
  it("opens on the Simple panel without the accordion, and hands it the deep-linked section", () => {
    const bot = makeBot();
    const simple = dialog(bot);
    expect(simple.html).toContain('id="bot-panel"');
    const shell = ofType(simple, BotPanel)!;
    expect(shell.props.bot).toBe(bot);
    expect(shell.props.linkedSection).toBeNull();
    expect(simple.html).not.toContain("data-bot-settings-section");

    fresh();
    fixture.storeState = { settingsOpen: true, botSettingsSection: "model", botSettingsExpandAccordion: true };
    expect(ofType(dialog(bot), BotPanel)!.props.linkedSection).toBe("model");
  });

  it("a stored section never moves the Simple panel", () => {
    fixture.storeState = {
      settingsOpen: true, botSettingsSection: "model", botSettingsExpandAccordion: true,
      botSettingsSectionStored: true, botSettingsExpandRemembered: true,
    };
    expect(ofType(dialog(makeBot()), BotPanel)!.props.linkedSection).toBeNull();
  });

});

describe("the panel's switches", () => {
  it("are the shared Grok toggle, in the switch blue rather than the bot's own color", () => {
    fixture.apps = { phase: "ready", connectedSlugs: ["gmail"], apps: [app("gmail", "write")] };
    const html = capture(() => PageBody({ page: "apps", bot: makeBot({ color: "blue" }), derived: derived() }) as ReactNode).html;
    expect(html.match(/role="switch"/g)).toHaveLength(1);
    expect(html).toContain("data-ui-toggle");
    expect(html).not.toContain("background-color:#377FE6");
  });
});
