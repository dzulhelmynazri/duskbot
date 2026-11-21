import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot, InstanceInfo, Task } from "@/state/store";
import type { FeatureFlagConfig } from "@/lib/feature-flags";

// Hook-by-call-order harness: state survives between renders, effects never run, handlers are read off the element
// tree. `seed` presets what the resolve effect would have reached.
const fixture = vi.hoisted(() => {
  const view = { current: "computer" as string };
  const madaniDesktop: Record<string, unknown> = {};
  vi.stubGlobal("window", { madaniDesktop });
  vi.stubGlobal("document", { visibilityState: "visible" });
  vi.stubGlobal("localStorage", { getItem: (key: string) => key.startsWith("madani-computer-panel-view") ? view.current : null, setItem: () => {} });
  return {
    advanced: false,
    view,
    madaniDesktop,
    platform: "darwin" as "darwin" | "win32" | "linux",
    localComputer: {} as Record<string, unknown>,
    values: [] as unknown[],
    index: 0,
    own: 0,
    seed: {} as Record<string, unknown>,
    config: {} as FeatureFlagConfig & { cloudHome?: boolean; vps?: { configured: boolean } },
    instances: [] as InstanceInfo[],
    dispatch: (() => {}) as (...args: unknown[]) => void,
    api: (() => Promise.resolve({})) as (...args: unknown[]) => Promise<unknown>,
    ownerOrAdmin: null as boolean | null,
  };
});

// The panel's useState calls in source order, counted from `phase`; keep in step with ComputerPanel.tsx.
const PHASE_OFFSETS = { phase: 0, resolved: 2, vmStatus: 10, vpsStatus: 11, error: 16 } as const;
let phaseIndex = -1;

vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) {
      let value = typeof initial === "function" ? initial() : initial;
      if (value === "checking" && phaseIndex < 0) phaseIndex = index;
      for (const [name, offset] of Object.entries(PHASE_OFFSETS)) {
        if (phaseIndex >= 0 && index === phaseIndex + offset && name in fixture.seed) value = fixture.seed[name];
      }
      fixture.values[index] = value;
    }
    return [fixture.values[index], (next: unknown) => {
      fixture.values[index] = typeof next === "function" ? next(fixture.values[index]) : next;
    }];
  },
  useEffect: () => {},
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.ownerOrAdmin }));
vi.mock("./DesktopCapabilities", () => ({
  useCaptionChrome: () => ({ padClass: undefined }),
  useDesktopCapabilities: () => ({
    ready: true,
    capabilities: {
      host: { platform: fixture.platform, label: "Host", session: "unknown", packaged: true, homeDir: "/Users/me" },
      windowChrome: "native",
      screenPreview: { available: false, interaction: "none" },
      dictation: { available: false, engine: "none", onDevice: false },
      localComputer: fixture.localComputer,
    },
  }),
}));
vi.mock("./BrowserPanel", () => ({ BrowserPanel: () => createElement("div", null, "BROWSER-PANEL") }));
vi.mock("./CloudScreenPreview", () => ({ CloudScreenPreview: () => null }));
vi.mock("./LocalScreenPreview", () => ({ LocalScreenPreview: () => null }));
vi.mock("./LinuxLocalControl", () => ({ LinuxLocalControl: () => null }));
vi.mock("./MacLocalControl", () => ({ MacLocalControl: () => null }));
vi.mock("./LocalComputerAutoWarning", () => ({ LocalComputerAutoWarning: () => null }));
vi.mock("./bot-settings/RoutinesSection", () => ({ RoutinesSection: () => null }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: (...args: unknown[]) => fixture.api(...args),
  useStore: () => ({
    state: {
      config: { vps: { configured: true }, ...fixture.config },
      instances: fixture.instances,
      computerControl: {},
      routines: [],
      routineRuns: [],
    },
    dispatch: fixture.dispatch,
    flushBotPatches: () => Promise.resolve(null),
  }),
}));

const { ComputerPanel } = await import("./ComputerPanel");

afterAll(() => vi.unstubAllGlobals());

type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
function nodes(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    return [node, ...nodes(node.props.children)];
  });
}
function text(value: ReactNode): string {
  return Children.toArray(value).map((child) => {
    if (typeof child === "string" || typeof child === "number") return String(child);
    return isValidElement(child) ? text((child as Node).props.children) : "";
  }).join("").trim();
}

const engine = (): InstanceInfo => ({
  instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", access: "subscription",
  snapshot: { state: "available", version: "1", authenticated: true },
  models: { default: "m", options: [{ id: "m", label: "M" }] },
  capabilities: { computerMcp: true, browserMcp: true },
} as InstanceInfo);

function makeBot(patch: Partial<Bot> = {}): Bot {
  return {
    id: "scout", threadId: "thread-scout", name: "Scout", title: "", description: "", notifications: true,
    color: "green", unread: false, messages: [],
    modelSelection: { instanceId: "claude", model: "m" },
    ...patch,
  } as Bot;
}

function render(forBot: Bot) {
  fixture.values.length = Math.min(fixture.values.length, fixture.own);
  let tree: ReactNode = null;
  function Capture() {
    fixture.index = 0;
    tree = ComputerPanel({ bot: forBot });
    fixture.own = fixture.index;
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Capture));
  const all = nodes(tree);
  const buttons = all.filter((node) => node.type === "button");
  const button = (label: string) => buttons.find((node) => text(node.props.children) === label);
  return { html, nodes: all, buttons, button };
}

const tabs = (rendered: ReturnType<typeof render>) => {
  const bar = rendered.nodes.find((node) => node.props["data-testid"] === "computer-tabs")!;
  return nodes(bar.props.children).filter((node) => node.type === "button").map((node) => text(node.props.children));
};
beforeEach(() => {
  fixture.advanced = false;
  fixture.view.current = "computer";
  fixture.platform = "darwin";
  fixture.localComputer = { available: true, support: "supported", enabled: true, status: "ready" };
  fixture.values = [];
  fixture.index = 0;
  fixture.own = 0;
  fixture.seed = {};
  phaseIndex = -1;
  fixture.config = { features: { browser: true }, browserEngine: { kind: "engine" } };
  fixture.instances = [engine()];
  fixture.dispatch = vi.fn();
  fixture.api = vi.fn(() => Promise.resolve({ features: { browser: true } }));
  fixture.ownerOrAdmin = null;
  for (const key of Object.keys(fixture.madaniDesktop)) delete fixture.madaniDesktop[key];
});

describe("Computer panel tabs", () => {
  it("centres the tabs as a pill with close pinned right, in both modes", () => {
    for (const advanced of [false, true]) {
      fixture.advanced = advanced;
      fixture.values = [];
      const rendered = render(makeBot());
      const bar = rendered.nodes.find((node) => node.props["data-testid"] === "computer-tabs")!;
      expect(String(bar.props.className).split(" ")).toEqual(expect.arrayContaining(["rounded-full", "mx-9"]));
      expect(String(bar.props.className).split(" ")).not.toContain("flex-wrap");
      const firstTab = Children.toArray(bar.props.children).find(isValidElement) as Node;
      expect(String(firstTab.props.className).split(" ")).toEqual(expect.arrayContaining(["shrink-0", "@max-[28rem]/paneltabs:[&>svg]:hidden"]));
      expect(rendered.nodes.some((node) => String(node.props.className ?? "").split(" ").includes("@container/paneltabs"))).toBe(true);
      const row = rendered.nodes.find((node) => Children.toArray(node.props.children)
        .some((child) => isValidElement(child) && (child as Node).props["data-testid"] === "computer-tabs"))!;
      expect(String(row.props.className).split(" ")).toEqual(expect.arrayContaining(["relative", "flex", "justify-center"]));
      const close = rendered.nodes.find((node) => node.props["aria-label"] === "Close the screen panel")!;
      expect(String(close.props.className).split(" ")).toEqual(expect.arrayContaining(["absolute", "right-0"]));
    }
  });

  it("shows Screen in Simple mode, and Browser only for a bot that works in its browser", () => {
    expect(tabs(render(makeBot()))).toEqual(["Screen"]);
    fixture.values = [];
    phaseIndex = -1;
    expect(tabs(render(makeBot({ computer: "browser" })))).toEqual(["Screen", "Browser"]);
  });

  it("reads a Routines view stored by Advanced as the Computer tab in Simple", () => {
    fixture.view.current = "routines";
    const rendered = render(makeBot());
    expect(rendered.nodes.find((node) => node.props.id === "computer-panel-tabs-panel-computer")).toBeDefined();
    expect(rendered.nodes.some((node) => node.props["data-testid"] === "where-works")).toBe(false);
  });

});

describe("Simple Browser tab with the browser off", () => {
  it("explains and turns on the same installation setting as Settings", async () => {
    fixture.view.current = "browser";
    fixture.config = { features: { browser: false }, browserEngine: { kind: "engine" } };
    const rendered = render(makeBot());
    expect(rendered.html).toContain("The browser is off");
    expect(rendered.html).not.toContain("BROWSER-PANEL");
    (browserSwitch(rendered).props.onClick as () => void)();
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: { features: { browser: true } } }));
    expect(fixture.api).toHaveBeenCalledWith("/api/config", {
      method: "PATCH",
      body: JSON.stringify({ features: { browser: true } }),
    });
  });

  it("turns on this bot's own browser switch when only that is off", async () => {
    fixture.view.current = "browser";
    const rendered = render(makeBot({ browser: false }));
    expect(browserSwitch(rendered).props.checked).toBe(false);
    (browserSwitch(rendered).props.onClick as () => void)();
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith({ type: "updateBot", botId: "scout", patch: { browser: true } }));
    expect(fixture.api).not.toHaveBeenCalled();
  });

  it("says why when this server cannot have a browser", () => {
    fixture.view.current = "browser";
    fixture.config = { features: { browser: false }, browserEngine: { kind: "unavailable", reason: "No engine here." } };
    const rendered = render(makeBot());
    expect(rendered.html).toContain("No engine here.");
    expect(browserSwitch(rendered).props.disabled).toBe(true);
  });

  it("shows the real browser once it is on, under a switch that turns it off for this bot only", () => {
    fixture.view.current = "browser";
    const rendered = render(makeBot());
    expect(rendered.html).toContain("BROWSER-PANEL");
    expect(browserSwitch(rendered).props.checked).toBe(true);
    (browserSwitch(rendered).props.onClick as () => void)();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "updateBot", botId: "scout", patch: { browser: false } });
    expect(fixture.api).not.toHaveBeenCalled();
  });

  it("keeps the Browser tab and its switch in Advanced mode when the browser is off", () => {
    fixture.advanced = true;
    fixture.view.current = "browser";
    fixture.config = { features: { browser: false }, browserEngine: { kind: "engine" } };
    const rendered = render(makeBot());
    expect(rendered.html).toContain("The browser is off");
    expect(browserSwitch(rendered).props.checked).toBe(false);
  });
});

function browserSwitch(rendered: ReturnType<typeof render>) {
  return rendered.nodes.find((node) => node.props["aria-label"] === "Let Scout use a browser")!;
}

describe("Choosing a place in the panel", () => {
  it("keeps unconfigured VPS setup in Computer settings without an inline provider key", () => {
    fixture.config = { ...fixture.config, vps: { configured: false } };
    fixture.seed = { phase: "vps-unconfigured", resolved: { botId: "scout", threadId: "thread-scout", computer: "cloud", cloudBackend: "vps" } };
    const admin = render(makeBot({ computer: "cloud" }));
    expect(admin.html).toContain("Connect your own machine in settings to give bots their own private desktops.");
    expect(admin.html).not.toMatch(/\x42oat|API key|paid service/);
    const action = admin.button("Add your own server")!;
    (action.props.onClick as () => void)();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "computer" });

    fixture.ownerOrAdmin = false;
    fixture.values = [];
    phaseIndex = -1;
    const user = render(makeBot({ computer: "cloud" }));
    expect(user.html).toContain("Ask an admin to change it.");
    expect(user.button("Add your own server")).toBeUndefined();
  });

});

describe("A chat pinned to a place", () => {
  const pinned = () => makeBot({ tasks: [{ threadId: "thread-scout", title: "", createdAt: 1, surface: "cloud" }] } as Partial<Bot>);
  const note = (rendered: ReturnType<typeof render>) =>
    text(rendered.nodes.find((node) => node.props["data-testid"] === "place-pinned-note")!.props.children);

  it("names the place in the grid's words, without pointing Simple at a composer chip it no longer has", () => {
    expect(note(render(pinned()))).toBe("This chat is pinned to “Cloud desktop”.");

  });

  const pinnedOn = (computer: Bot["computer"], task: Partial<Task> = {}) =>
    makeBot({ computer, tasks: [{ threadId: "thread-scout", title: "", createdAt: 1, surface: "cloud", ...task }] } as Partial<Bot>);
  const unpin = (rendered: ReturnType<typeof render>) => rendered.nodes.find((node) => node.props["data-testid"] === "place-unpin");
  const fresh = () => { fixture.values = []; phaseIndex = -1; };

  it("leads a person's pin back to the grid's choice, which Simple has no composer chip for", () => {
    const button = unpin(render(pinned()))!;
    expect(text(button.props.children)).toBe("Use auto");
    expect(button.props.disabled).toBe(false);
    (button.props.onClick as () => void)();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "updateTask", botId: "scout", threadId: "thread-scout", patch: { surface: null } });

    fresh();
    expect(text(unpin(render(pinnedOn("local")))!.props.children)).toBe("Use this Mac");

  });

  it("waits out a running turn, as the server refuses a busy chat's place change", () => {
    const button = unpin(render(pinnedOn(undefined, { busy: true })))!;
    expect(button.props.disabled).toBe(true);
    expect(button.props.title).toBe("Wait for the current turn to finish");
  });

  it("says nothing of a pin Auto recorded, one matching Works on, or one Off overrides", () => {
    for (const bot of [pinnedOn(undefined, { surface: "browser", surfaceAuto: true }), pinnedOn("cloud"), pinnedOn("off")]) {
      fresh();
      const rendered = render(bot);
      expect(rendered.nodes.some((node) => node.props["data-testid"] === "place-pinned-note"), JSON.stringify([bot.computer, bot.tasks])).toBe(false);
      expect(unpin(rendered)).toBeUndefined();
    }
  });

});

describe("Technical controls", () => {
  const cloud = () => makeBot({ computer: "cloud" });

  it("hides technical controls", () => {
    const simple = render(cloud());
    expect(simple.nodes.some((node) => node.props.title === "Bot settings")).toBe(false);
    expect(simple.html).not.toContain("Works on");
    expect(simple.buttons.some((node) => text(node.props.children).startsWith("Routines"))).toBe(false);

  });

  it("hides the VM settings link in Simple", () => {
    expect(render(makeBot({ computer: "vm" })).html).not.toContain("Private desktop settings");
  });

  it("shows Take control, Full screen and Sleep under a ready cloud screen", () => {
    fixture.seed = { phase: "ready", resolved: { botId: "scout", threadId: "thread-scout", computer: "cloud", cloudBackend: "vps" } };
    const simple = render(cloud());
    const row = simple.nodes.find((node) => node.props["data-testid"] === "computer-actions")!;
    expect(nodes(row.props.children).filter((node) => node.type === "button").map((node) => text(node.props.children)))
      .toEqual(["Take control", "Full screen", "Sleep"]);

  });

  it("hides two desktops and Delete VM", () => {
    fixture.madaniDesktop.desktopWorkspace = {};
    fixture.seed = {
      phase: "vm",
      resolved: { botId: "scout", threadId: "thread-scout", computer: "vm", cloudBackend: "vps" },
      vmStatus: { mode: "per-bot", container: "running", ready: true, viewer_url: "http://127.0.0.1/viewer", target_key: `bot:${"a".repeat(64)}` },
    };
    const vm = () => makeBot({ computer: "vm" });
    const simple = render(vm());
    expect(simple.html).not.toContain("open two desktops");
    expect(simple.html).not.toContain("delete this bot");
    const row = simple.nodes.find((node) => node.props["data-testid"] === "computer-actions")!;
    expect(nodes(row.props.children).filter((node) => node.type === "button").map((node) => text(node.props.children)))
      .toEqual(["Take control", "Full screen"]);

  });

  it("turns VPS setup into one friendly line and a way to its settings", () => {
    fixture.seed = { phase: "vps-stopped", resolved: { botId: "scout", threadId: "thread-scout", computer: "cloud", cloudBackend: "vps" }, vpsStatus: { configured: true, container: "stopped" } };
    const vps = () => makeBot({ computer: "cloud", cloudBackend: "vps" });
    const simple = render(vps());
    expect(simple.html).toContain("Scout&#x27;s desktop needs a setup step first.");
    expect(simple.button("Open VPS settings")).toBeDefined();
    (simple.button("Open VPS settings")!.props.onClick as () => void)();
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "toggleAppSettings", open: true }));

  });
});
