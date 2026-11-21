// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Action, AppState, Bot, InstanceInfo } from "@/state/store";

const fixture = vi.hoisted(() => ({
  container: "missing" as string,
  configured: true,
  imageMatches: true,
  desktop: "bot-desktop" as string,
  posts: [] as string[],
  actions: [] as Action[],
  shared: false,
  screenStopped: false,
  looks: 0,
  advanced: true,
  owner: true,
  instancesLoaded: true,
  /** Holds the wake open until the test lets it finish. */
  provisionGate: null as Promise<void> | null,
  outdated: false,
  updating: false,
  daemonUp: false,
  /** Holds the first picture back until the test lets it come. */
  screenshotGate: null as Promise<void> | null,
  /** The live screen cannot be reached. */
  unreachable: false,
}));
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useCaptionChrome: () => ({ padClass: undefined }),
  useDesktopCapabilities: () => ({
    ready: true,
    capabilities: {
      host: { platform: "darwin", label: "Host", session: "unknown", packaged: true, homeDir: "/Users/me" },
      windowChrome: "native",
      screenPreview: { available: false, interaction: "none" },
      dictation: { available: false, engine: "none", onDevice: false },
      localComputer: { available: false, support: "unsupported", enabled: false, status: "unavailable" },
    },
  }),
}));
// The owner: starting a cloud computer early is an Admin's shortcut.
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.owner }));
vi.mock("./CloudScreenPreview", () => ({
  CloudScreenPreview: () => createElement("div", { "data-live-screen": "" }),
}));
vi.mock("./BrowserPanel", () => ({ BrowserPanel: () => null }));
vi.mock("./LiveDesktop", async () => {
  const { useEffect } = await import("react");
  return { LiveDesktop: (props: { expanded: boolean; wake?: boolean; onUnreachable: () => void }) => {
    useEffect(() => { if (fixture.unreachable) props.onUnreachable(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
    return createElement("div", { "data-live-screen": "", "data-expanded": String(props.expanded), "data-wake": String(Boolean(props.wake)) });
  } };
});
vi.mock("./bot-settings/RoutinesSection", () => ({ RoutinesSection: () => null }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") fixture.posts.push(path.split("?")[0]!);
    if (path.startsWith("/api/bots/scout/computer/provision")) {
      await fixture.provisionGate;
      fixture.container = "running";
      fixture.screenStopped = false;
      return { surface: "cloud", backend: "vps", configured: true, ready: true, container: "running" };
    }
    if (path.startsWith("/api/bots/scout/computer/screenshot")) { await fixture.screenshotGate; return { png: "FRAME", format: "jpeg" }; }
    if (path.startsWith("/api/bots/scout/computer/control")) return { held: false, helpReason: null };
    if (path.startsWith("/api/bots/scout/computer?")) {
      fixture.looks++;
      return { surface: "cloud", backend: "vps", configured: fixture.configured, ready: fixture.container === "running" && fixture.imageMatches && !fixture.screenStopped,
        ...(fixture.screenStopped ? { state: "stopped", viewerKey: "unallocated" } : {}),
        ...(fixture.shared ? { teamComputer: { id: "shared", name: "Shared desktop" } } : {}),
        container: fixture.container, managed: fixture.container !== "missing", imageMatches: fixture.imageMatches, desktop: fixture.desktop, problem: "Fixture desktop is not running",
        ...(fixture.outdated ? { outdated: true } : {}), ...(fixture.updating ? { updating: true } : {}), ...(fixture.daemonUp ? { daemonUp: true } : {}) };
    }
    return {};
  },
}));

const { ComputerPanel } = await import("./ComputerPanel");
const { forgetComputerWakes } = await import("./bot-panel/computer-wake");
const { BotEditorStore, initialState } = await import("@/state/store");

const engine = {
  instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", access: "subscription",
  snapshot: { state: "available", version: "1", authenticated: true },
  models: { default: "m", options: [{ id: "m", label: "M" }] },
  capabilities: { computerMcp: true, browserMcp: true },
} as InstanceInfo;
const makeBot = (patch: Partial<Bot> = {}): Bot => ({
  id: "scout", threadId: "thread", name: "Scout", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [],
  modelSelection: { instanceId: "claude", model: "m" },
  tasks: [{ threadId: "thread", title: "Thread", createdAt: 1, approvalMode: "ask" }],
  ...patch,
}) as unknown as Bot;

let root: Root | null = null;
const value = (): Parameters<typeof BotEditorStore>[0]["value"] => ({
  state: { ...initialState, hydrated: fixture.instancesLoaded ? true : undefined, instances: fixture.instancesLoaded ? [engine] : [], config: { vps: { configured: true } } as AppState["config"] } as AppState,
  dispatch: (action) => { fixture.actions.push(action); },
  flushBotPatches: async () => null,
  refreshInstances: async () => {},
  refreshModels: async () => {},
});
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const open = async (bot: Bot, inline = false) => {
  if (!root) {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  flushSync(() => root!.render(createElement(BotEditorStore, { value: value(), children: createElement(ComputerPanel, { bot, inline }) })));
  await settle();
};
const text = () => document.body.textContent ?? "";
const spinning = () => document.querySelector(".animate-spin") !== null;

beforeAll(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
  vi.stubGlobal("madaniDesktop", undefined);
});
afterEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = "";
  fixture.posts.length = 0;
  fixture.actions.length = 0;
  fixture.shared = false;
  fixture.screenStopped = false;
  fixture.container = "missing";
  fixture.configured = true;
  fixture.imageMatches = true;
  fixture.desktop = "bot-desktop";
  fixture.looks = 0;
  fixture.instancesLoaded = true;
  fixture.owner = true;
  fixture.advanced = true;
  fixture.provisionGate = null;
  fixture.outdated = false;
  fixture.updating = false;
  fixture.daemonUp = false;
  fixture.screenshotGate = null;
  fixture.unreachable = false;
  forgetComputerWakes();
  vi.useRealTimers();
});

describe("VPS computer preparation", () => {
  it("does not create a missing computer just because an Auto screen panel opens", async () => {
    await open(makeBot());
    expect(fixture.posts).toEqual([]);
    expect(text()).toContain("Fixture desktop is not running");
  });

  it("offers only Wake for a bot with no computer yet, and Wake creates it", async () => {
    fixture.daemonUp = true;
    let report: { detail: string | null } | null = null;
    if (!root) { const container = document.createElement("div"); document.body.append(container); root = createRoot(container); }
    flushSync(() => root!.render(createElement(BotEditorStore, { value: value(), children: createElement(ComputerPanel, { bot: makeBot({ computer: "cloud" }), inline: true, onReport: (next: { detail: string | null }) => { report = next; } }) })));
    await settle();
    expect(text()).not.toContain("Fixture desktop is not running");
    expect(text()).not.toMatch(/start VPS automatically/i);
    expect(report!.detail).toBeNull();
    const wake = document.querySelector<HTMLButtonElement>("[data-panel-screen] button");
    expect(wake?.getAttribute("aria-label")).toBe("Wake computer");
    flushSync(() => wake!.click());
    await settle();
    expect(fixture.posts).toEqual(["/api/bots/scout/computer/provision"]);
  });

  it("leaves a stopped Auto computer asleep without a spinner or repeated polling", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    fixture.container = "stopped";
    await open(makeBot());
    const looks = fixture.looks;
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(fixture.looks).toBe(looks);
    expect(spinning()).toBe(false);
    expect(fixture.posts).toEqual([]);
  });

  it("shows a closed shared bot screen asleep while its container is running and wakes only on click", async () => {
    fixture.container = "running";
    fixture.shared = true;
    fixture.screenStopped = true;
    await open(makeBot(), true);
    expect(document.querySelector("[data-inline-computer]")?.getAttribute("data-stage")).toBe("asleep");
    const wake = document.querySelector<HTMLButtonElement>("[data-panel-screen] button");
    expect(wake?.getAttribute("aria-label")).toBe("Wake computer");
    expect(wake?.disabled).toBe(false);
    expect(spinning()).toBe(false);
    expect(document.querySelector("[data-live-screen]")).toBeNull();
    expect(fixture.looks).toBe(1);
    expect(fixture.posts).toEqual([]);
    flushSync(() => wake!.click());
    await settle();
    await expect.poll(() => document.querySelector("[data-live-screen]")).not.toBeNull();
    expect(document.querySelector("[data-live-screen]")?.getAttribute("data-expanded")).toBe("false");
    expect(fixture.posts).toEqual(["/api/bots/scout/computer/provision"]);
  });

  it("is the wake button while the engine inventory loads, and asks nothing of the server unclicked", async () => {
    fixture.instancesLoaded = false;
    await open(makeBot({ computer: "cloud" }), true);
    expect(document.querySelector("[data-inline-computer]")?.getAttribute("data-stage")).toBe("asleep");
    expect(document.querySelector<HTMLButtonElement>("[data-panel-screen] button")?.disabled).toBe(false);
    expect(fixture.posts).toEqual([]);
    fixture.instancesLoaded = true;
    await open(makeBot({ computer: "cloud" }), true);
    expect(document.querySelector<HTMLButtonElement>("[data-panel-screen] button")?.disabled).toBe(false);
    expect(fixture.posts).toEqual([]);
  });

  it("shows admin guidance instead of a false wake action for a member", async () => {
    fixture.owner = false;
    fixture.container = "stopped";
    await open(makeBot({ computer: "cloud" }), true);
    const wake = document.querySelector<HTMLButtonElement>("[data-panel-screen] button");
    expect(wake?.disabled).toBe(true);
    expect(wake?.textContent).toContain("Ask an admin");
    expect(fixture.posts).toEqual([]);
  });

  it("resolves a running Auto target with one status request", async () => {
    fixture.container = "running";
    await open(makeBot(), true);
    await expect.poll(() => document.querySelector("[data-live-screen]")).not.toBeNull();
    expect(fixture.looks).toBe(1);
    expect(fixture.posts).toEqual([]);
  });

  it("waits for an explicit inline click before preparing the selected VPS", async () => {
    await open(makeBot({ computer: "cloud" }), true);
    expect(fixture.posts).toEqual([]);
    const wake = document.querySelector<HTMLButtonElement>("[data-panel-screen] button");
    expect(wake?.disabled).toBe(false);
    flushSync(() => wake!.click());
    await settle();
    expect(fixture.posts.filter((path) => path.endsWith("/provision"))).toHaveLength(1);
    await expect.poll(() => document.querySelector("[data-live-screen]")).not.toBeNull();
    expect(fixture.posts.filter((path) => path.endsWith("/control"))).toEqual([]);
  });

  it("asks for the live screen beside the wake, and keeps one waking picture until it paints", async () => {
    let finish!: () => void;
    fixture.provisionGate = new Promise((resolve) => { finish = resolve; });
    await open(makeBot({ computer: "cloud" }), true);
    flushSync(() => document.querySelector<HTMLButtonElement>("[data-panel-screen] button")!.click());
    await settle();
    // the viewer is already connecting while the wake is still running
    await expect.poll(() => document.querySelector("[data-live-screen]")?.getAttribute("data-wake")).toBe("true");
    const waking = document.querySelector("[data-computer-waking]");
    expect(waking).not.toBeNull();
    finish();
    await expect.poll(() => fixture.container).toBe("running");
    await settle();
    expect(document.querySelectorAll("[data-live-screen]")).toHaveLength(1);
    // the same element throughout: its animation never restarts
    expect(document.querySelector("[data-computer-waking]")).toBe(waking);
  });

  it("a wake shows the bot waking up in a screen-shaped frame, never a connecting line", async () => {
    let finish!: () => void;
    fixture.provisionGate = new Promise((resolve) => { finish = resolve; });
    await open(makeBot({ computer: "cloud" }), true);
    const frame = document.querySelector<HTMLElement>("[data-panel-screen]")!;
    expect(frame.style.aspectRatio).toMatch(/^1\.6\b/);
    flushSync(() => frame.querySelector<HTMLButtonElement>("button")!.click());
    await settle();
    const waking = document.querySelector("[data-computer-waking]");
    expect(waking?.getAttribute("role")).toBe("status");
    expect(waking?.querySelector("[data-waking-mascot]")).not.toBeNull();
    expect(waking?.textContent).toBe("Scout is waking up");
    expect(document.querySelector("[data-asleep-mascot]")).toBeNull();
    expect(text()).not.toMatch(/connecting/i);
    finish();
    await expect.poll(() => document.querySelector("[data-live-screen]")).not.toBeNull();
  });

  it("wakes a stopped Auto computer inline without selecting a different destination", async () => {
    fixture.container = "stopped";
    await open(makeBot(), true);
    expect(fixture.posts).toEqual([]);
    flushSync(() => document.querySelector<HTMLButtonElement>("[data-panel-screen] button")!.click());
    await settle();
    expect(fixture.posts.filter((path) => path.endsWith("/provision"))).toHaveLength(1);
    expect(document.querySelector("[data-live-screen]")).not.toBeNull();
    expect(text()).not.toMatch(/\x42oat|paid service|credits/);
  });

  it("does not provision before the VPS is configured", async () => {
    fixture.configured = false;
    await open(makeBot({ computer: "cloud" }));
    expect(fixture.posts).toEqual([]);
    expect(document.querySelector("[data-live-screen]")).toBeNull();
  });

  it("never replaces an incompatible existing computer on its own", async () => {
    fixture.container = "running";
    fixture.imageMatches = false;
    await open(makeBot({ computer: "cloud" }));
    expect(fixture.posts).toEqual([]);
    expect(document.querySelector("[data-live-screen]")).toBeNull();
  });

  it("an older computer that updates itself just looks asleep, and its wake simply wakes it", async () => {
    fixture.container = "stopped";
    fixture.imageMatches = false;
    fixture.outdated = true;
    let release!: () => void;
    fixture.provisionGate = new Promise<void>((resolve) => { release = resolve; });
    const reports: Array<{ detail: string | null }> = [];
    if (!root) { const container = document.createElement("div"); document.body.append(container); root = createRoot(container); }
    flushSync(() => root!.render(createElement(BotEditorStore, { value: value(), children: createElement(ComputerPanel, { bot: makeBot({ computer: "cloud" }), inline: true, onReport: (report: { detail: string | null }) => reports.push(report) }) })));
    await settle();
    expect(text()).not.toMatch(/Update ready|Fixture desktop|version|managed/);
    expect(document.querySelector("[data-panel-problem]")).toBeNull();
    expect(reports.at(-1)?.detail ?? null).toBeNull();
    flushSync(() => document.querySelector<HTMLButtonElement>("[data-panel-screen] button")!.click());
    await settle();
    // the wake starts it as it is unless its update is already on the host: never "updating" for a download
    expect(text()).not.toContain("Updating Scout's computer…");
    expect(text()).toContain("Scout is waking up");
    // one wake: the server updates it on its home volume, nothing is removed from here
    expect(fixture.posts).toEqual(["/api/bots/scout/computer/provision"]);
    release();
    await settle();
  });

  it("shows a background update as one short line with no button or detail", async () => {
    fixture.container = "missing";
    fixture.imageMatches = false;
    fixture.updating = true;
    await open(makeBot({ computer: "cloud" }), true);
    expect(text()).toContain("Updating Scout's computer…");
    expect(document.querySelector("[data-panel-problem]")).toBeNull();
    expect(fixture.posts).toEqual([]);
  });

  it("replaces an incompatible inline desktop on its home volume with one small update button, in plain words", async () => {
    fixture.container = "running";
    fixture.imageMatches = false;
    const reports: Array<{ detail: string | null }> = [];
    if (!root) { const container = document.createElement("div"); document.body.append(container); root = createRoot(container); }
    flushSync(() => root!.render(createElement(BotEditorStore, { value: value(), children: createElement(ComputerPanel, { bot: makeBot({ computer: "cloud" }), inline: true, onReport: (report: { detail: string | null }) => reports.push(report) }) })));
    await settle();
    expect(text()).not.toContain("Fixture desktop");
    expect(reports.at(-1)?.detail ?? null).toBeNull();
    const frame = document.querySelector<HTMLButtonElement>("[data-panel-screen] button");
    expect(frame?.textContent).toContain("Update ready");
    expect(document.querySelector("[data-panel-problem]")?.textContent).toBe("Update");
    const fix = document.querySelector<HTMLButtonElement>('[data-panel-action="fix"]');
    expect(fix?.textContent).toBe("Update");
    flushSync(() => fix!.click());
    await settle();
    expect(fixture.posts).toEqual(["/api/bots/scout/computer/remove", "/api/bots/scout/computer/provision"]);
    expect(fixture.actions.some((action) => action.type === "toggleAppSettings")).toBe(false);
  });

  it("asks before a Fix that would lose an older desktop's files, and changes nothing on No", async () => {
    fixture.container = "running";
    fixture.imageMatches = false;
    fixture.desktop = "cua";
    const confirm = vi.fn(() => false);
    const before = window.confirm;
    window.confirm = confirm;
    try {
      await open(makeBot({ computer: "cloud" }), true);
      expect(document.querySelector("[data-panel-problem]")?.textContent).toContain("Files saved inside it are removed.");
      flushSync(() => document.querySelector<HTMLButtonElement>('[data-panel-action="fix"]')!.click());
      await settle();
      expect(confirm).toHaveBeenCalledOnce();
      expect(fixture.posts).toEqual([]);
    } finally { window.confirm = before; }
  });

  it("opens settings for a shared incompatible desktop without changing it", async () => {
    fixture.container = "running";
    fixture.imageMatches = false;
    fixture.shared = true;
    const external = vi.spyOn(window, "open").mockImplementation(() => null);
    try {
      await open(makeBot({ computer: "cloud" }), true);
      const settings = document.querySelector<HTMLButtonElement>("[data-panel-screen] button");
      expect(settings?.textContent).toContain("Update ready");
      expect(document.querySelector('[data-panel-action="fix"]')?.textContent).toBe("Open settings");
      flushSync(() => settings!.click());
      await settle();
      expect(fixture.actions).toContainEqual({ type: "toggleAppSettings", open: true, section: "computer" });
      expect(fixture.posts).toEqual([]);
      expect(external).not.toHaveBeenCalled();
    } finally { external.mockRestore(); }
  });

  it("keeps a conversation-only cloud pin read-only while the bot chats", async () => {
    fixture.container = "stopped";
    await open(makeBot({ busy: true, tasks: [{ threadId: "thread", title: "Thread", createdAt: 1, approvalMode: "ask", surface: "cloud", surfaceAuto: true }] } as Partial<Bot>));
    expect(fixture.posts).toEqual([]);
    expect(spinning()).toBe(false);
  });

  it("watches an already running VPS computer without creating or waking it", async () => {
    fixture.container = "running";
    await open(makeBot({ tasks: [{ threadId: "thread", title: "Thread", createdAt: 1, approvalMode: "ask", surface: "cloud", surfaceAuto: true }] } as Partial<Bot>));
    expect(document.querySelector("[data-live-screen]")).not.toBeNull();
    expect(fixture.posts.filter((path) => !path.endsWith("/screenshot"))).toEqual([]);
  });

  it("leaves Simple mode asleep until explicitly woken", async () => {
    fixture.advanced = false;
    await open(makeBot({ computer: "cloud" }));
    expect(fixture.posts).toEqual([]);
    expect(document.querySelector("[data-live-screen]")).toBeNull();
  });

  it("keeps waking while the panel is away, and shows the wake again when it comes back", async () => {
    let finish!: () => void;
    fixture.provisionGate = new Promise((resolve) => { finish = resolve; });
    await open(makeBot({ computer: "cloud" }), true);
    flushSync(() => document.querySelector<HTMLButtonElement>("[data-panel-screen] button")!.click());
    await settle();
    expect(document.querySelector("[data-computer-waking]")).not.toBeNull();
    // another tab: the computer view goes away mid-wake
    root!.unmount();
    root = null;
    document.body.innerHTML = "";
    await settle();
    await open(makeBot({ computer: "cloud" }), true);
    expect(document.querySelector("[data-inline-computer]")?.getAttribute("data-stage")).toBe("loading");
    expect(document.querySelector("[data-computer-waking]")).not.toBeNull();
    expect(document.querySelector("[data-asleep-mascot]")).toBeNull();
    finish();
    await expect.poll(() => document.querySelector("[data-live-screen]")).not.toBeNull();
    // one wake, never a second one for coming back
    expect(fixture.posts.filter((path) => path.endsWith("/provision"))).toHaveLength(1);
  });

  it("an awake computer whose live screen dropped shows its picture coming, never asleep", async () => {
    fixture.container = "running";
    fixture.unreachable = true;
    let picture!: () => void;
    fixture.screenshotGate = new Promise((resolve) => { picture = resolve; });
    await open(makeBot({ computer: "cloud" }), true);
    await expect.poll(() => document.querySelector("[data-live-screen]")).toBeNull();
    expect(document.querySelector("[data-inline-computer]")?.getAttribute("data-stage")).toBe("loading");
    expect(document.querySelector("[data-asleep-mascot]")).toBeNull();
    picture();
    await expect.poll(() => document.querySelector("[data-inline-computer]")?.getAttribute("data-stage")).toBe("screen");
  });

  it("on the phone, a computer view that comes back starts on its last picture while the next one is on its way", async () => {
    document.documentElement.dataset.mobileApp = "ios";
    try {
      fixture.container = "running";
      fixture.unreachable = true;
      await open(makeBot({ computer: "cloud" }), true);
      await expect.poll(() => document.querySelector("[data-inline-computer] img")?.getAttribute("src")).toBe("data:image/jpeg;base64,FRAME");
      root!.unmount();
      root = null;
      document.body.innerHTML = "";
      // the next picture holds back: the view must not wait on it, or blink empty, to show the screen
      fixture.screenshotGate = new Promise(() => {});
      await open(makeBot({ computer: "cloud" }), true);
      await expect.poll(() => document.querySelector("[data-inline-computer]")?.getAttribute("data-stage")).toBe("screen");
      expect(document.querySelector("[data-inline-computer] img")?.getAttribute("src")).toBe("data:image/jpeg;base64,FRAME");
      expect(document.querySelector("[data-computer-waking]")).toBeNull();
    } finally {
      delete document.documentElement.dataset.mobileApp;
    }
  });
});
