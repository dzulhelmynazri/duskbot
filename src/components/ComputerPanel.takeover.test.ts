// @vitest-environment happy-dom
// Take control where the person watches: the real panel, its real control requests, a stand-in for the live desktop.
import { createElement, useEffect, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishLiveFrame } from "@/lib/live-events";
import type { Action, AppState, Bot, InstanceInfo } from "@/state/store";

const fixture = vi.hoisted(() => ({
  held: false,
  /** Whether a take with a lease gets it: false plays a hold someone else already has. */
  owned: true,
  controls: [] as Array<{ action?: string; controlLeaseId?: string }>,
  posts: [] as string[],
  beacons: [] as Array<{ url: string; body: Record<string, unknown>; keepalive: boolean }>,
  ready: true,
  connections: 0,
  inline: false,
  cloudState: "running" as "running" | "stopped",
  statusReads: 0,
  /** holds the status reply back, as a slow first status does */
  statusGate: null as null | Promise<void>,
  surface: "cloud" as "cloud" | "browser",
  live: null as null | { target: string; expanded: boolean; onUnreachable: () => void; viewOnly?: boolean; onReadyChange?: (ready: boolean) => void; onTakeControl?: () => void; onOpenPreview?: () => void; originalViewer?: boolean },
}));
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useCaptionChrome: () => ({ padClass: undefined }),
  useDesktopCapabilities: () => ({
    ready: true,
  connections: 0,
  inline: false,
  cloudState: "running" as "running" | "stopped",
  statusReads: 0,
    capabilities: {
      host: { platform: "darwin", label: "Host", session: "unknown", packaged: true, homeDir: "/Users/me" },
      windowChrome: "native",
      screenPreview: { available: false, interaction: "none" },
      dictation: { available: false, engine: "none", onDevice: false },
      localComputer: { available: false, support: "unsupported", enabled: false, status: "unavailable" },
    },
  }),
}));
vi.mock("./CloudScreenPreview", () => ({
  CloudScreenPreview: ({ onOpen, onRetry }: { onOpen: () => void; onRetry: (discard: boolean) => void }) => createElement("div", null,
    createElement("button", { "data-preview": "", onClick: onOpen }, "preview"),
    createElement("button", { onClick: () => onRetry(false) }, "retry live screen")),
}));
vi.mock("./LiveDesktop", () => ({
  LiveDesktop: (props: { target: string; expanded: boolean; onUnreachable: () => void; viewOnly?: boolean; onReadyChange?: (ready: boolean) => void; onTakeControl?: () => void; onOpenPreview?: () => void; originalViewer?: boolean; waking?: (expanded: boolean) => ReactNode }) => {
    // like the real one, it shows the panel's waking view until its first frame
    const [ready, setReady] = useState(fixture.ready);
    const report = (value: boolean) => { setReady(value); props.onReadyChange?.(value); };
    fixture.live = { ...props, onReadyChange: report };
    useEffect(() => { fixture.connections++; report(fixture.ready); }, [props.target]);
    return createElement("div", { "data-live-desktop": "", "data-target": props.target, "data-expanded": String(props.expanded), "data-view-only": String(props.viewOnly) }, ready ? null : props.waking?.(props.expanded), props.originalViewer && props.expanded && props.viewOnly ? createElement("button", { onClick: props.onTakeControl }, "Take control") : null);
  },
}));
vi.mock("./BrowserPanel", () => ({ BrowserPanel: () => null }));
vi.mock("./bot-settings/RoutinesSection", () => ({ RoutinesSection: () => null }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: async (path: string, init?: RequestInit) => {
    const route = path.split("?")[0]!;
    if (init?.method === "POST") fixture.posts.push(route);
    if (route === "/api/bots/scout/computer/control") {
      if (init?.method !== "POST") return { held: fixture.held, helpReason: null };
      const body = JSON.parse(String(init.body));
      fixture.controls.push(body);
      if (body.action === "take") {
        const owned = !fixture.held || fixture.owned;
        fixture.held = true;
        return { held: true, helpReason: null, ...(body.controlLeaseId ? { owned: owned && fixture.owned, acquired: owned } : {}) };
      }
      fixture.held = false;
      return { held: false, helpReason: null };
    }
    if (route === "/api/bots/scout/local-computer") {
      return {
        mode: "per-bot", max_instances: 2, image: true, create_supported: true, container: "running", imageMatches: true,
        managed: true, network: "loopback", security: "hardened", persistence: "durable", desktopReady: true, ready: true,
        problem: null, viewer_url: "http://127.0.0.1:49152/vnc.html#password=fixture", target_key: `bot:${"a".repeat(64)}`,
      };
    }
    if (route === "/api/bots/scout/local-computer/screenshot") return { image: "data:image/png;base64,FRAME" };
    if (route === "/api/bots/scout/computer") {
      fixture.statusReads++;
      if (fixture.statusGate) await fixture.statusGate;
      if (fixture.surface !== "cloud") return { surface: fixture.surface, configured: false, backend: "vps" };
      return { surface: "cloud", configured: true, ready: fixture.cloudState === "running", managed: true, imageMatches: true, container: fixture.cloudState, problem: null };
    }
    if (route === "/api/bots/scout/computer/provision") {
      fixture.cloudState = "running";
      return { surface: "cloud", configured: true, ready: true, managed: true, imageMatches: true, container: "running", problem: null };
    }
    if (route === "/api/bots/scout/computer/screenshot") return { png: "FRAME", format: "png" };
    if (route === "/api/bots/scout/computer/join") return { joinUrl: "https://desktop.invalid/scout" };
    return {};
  },
}));

const { ComputerPanel } = await import("./ComputerPanel");
const { BotEditorStore, initialState } = await import("@/state/store");

const engine = {
  instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", access: "subscription",
  snapshot: { state: "available", version: "1", authenticated: true },
  models: { default: "m", options: [{ id: "m", label: "M" }] },
  capabilities: { computerMcp: true, browserMcp: true },
} as InstanceInfo;
const makeBot = (patch: Partial<Bot> = {}): Bot => ({
  id: "scout", threadId: "thread", name: "Scout", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: true, messages: [],
  modelSelection: { instanceId: "claude", model: "m" },
  tasks: [{ threadId: "thread", title: "Thread", createdAt: 1, approvalMode: "ask" }],
  ...patch,
}) as unknown as Bot;

let root: Root | null = null;
let state: AppState;
let shown: Bot;
const draw = () => flushSync(() => root!.render(createElement(BotEditorStore, {
  value: {
    state,
    dispatch: (action: Action) => {
      if (action.type !== "computerControl") return;
      state = { ...state, computerControl: { ...state.computerControl, [action.botId]: { held: action.held, helpReason: action.helpReason, help: action.help } } };
      queueMicrotask(draw);
    },
    flushBotPatches: async () => null,
    refreshInstances: async () => {},
    refreshModels: async () => {},
  },
  children: createElement(ComputerPanel, { bot: shown, inline: fixture.inline }),
})));
const settle = async () => {
  for (let i = 0; i < 25; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const open = async (bot: Bot) => {
  shown = bot;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  draw();
  await settle();
};
const button = (label: string) => [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
const press = async (label: string) => {
  const target = button(label);
  expect(target, `no "${label}" button in: ${document.body.textContent}`).toBeDefined();
  flushSync(() => target!.click());
  await settle();
};
const liveDesktop = () => document.querySelector<HTMLElement>("[data-live-desktop]");
const shownLive = () => vi.waitFor(() => expect(liveDesktop(), "the live desktop must replace the picture, here").not.toBeNull());
/** What the server's broadcast does to every open view. */
const heldElsewhere = (held: boolean) => {
  state = { ...state, computerControl: { ...state.computerControl, scout: { held, helpReason: null } } };
  if (root) draw();
};
const releases = () => fixture.beacons.filter((beacon) => beacon.url === "/api/bots/scout/computer/control" && beacon.body.action === "release");

beforeEach(() => {
  // The panel remembers each conversation's tab (computer-panel-view.ts), so one test's tab must not open the next test on it.
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => void saved.set(key, value),
    removeItem: (key: string) => void saved.delete(key),
  });
  fixture.held = false;
  fixture.owned = true;
  fixture.controls = [];
  fixture.posts = [];
  fixture.beacons = [];
  fixture.live = null;
  fixture.ready = true;
  fixture.connections = 0;
  fixture.inline = false;
  fixture.cloudState = "running";
  fixture.statusReads = 0;
  fixture.statusGate = null;
  fixture.surface = "cloud";
  state = { ...initialState, instances: [engine], config: { box: { configured: true } } as AppState["config"], computerControl: {} } as AppState;
  vi.stubGlobal("madaniDesktop", {
    desktopViewer: { open: vi.fn(async () => true), close: vi.fn(async () => true), onState: () => () => {}, currentState: async () => ({ open: false, contextId: null }) },
  });
  vi.spyOn(window, "open").mockImplementation(() => null);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    fixture.beacons.push({ url, body, keepalive: init?.keepalive === true });
    if (url === "/api/bots/scout/computer/control" && body.action === "release") {
      fixture.held = false;
      setTimeout(() => heldElsewhere(false), 0);
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }));
});
afterEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("taking control of a Local VM", () => {
  it("watches a ready desktop live without capturing screenshots or taking control", async () => {
    await open(makeBot({ computer: "vm" }));
    await shownLive();
    expect(liveDesktop()?.dataset.viewOnly).toBe("true");
    expect(fixture.controls).toEqual([]);
    expect(fixture.posts.some((path) => path.endsWith("/screenshot"))).toBe(false);
  });

  it("preserves the decoded live connection across same-target status events", async () => {
    await open(makeBot({ computer: "cloud" }));
    await shownLive();
    expect(fixture.connections).toBe(1);
    flushSync(() => publishLiveFrame({ kind: "computer-state", botId: "scout", resourceKey: "computer:vps:main:scout", state: "ready" }));
    await settle();
    expect(fixture.connections).toBe(1);
    expect(button("Take control")?.disabled).toBe(false);
  });

  it("does not take control before the first decoded frame", async () => {
    fixture.ready = false;
    await open(makeBot({ computer: "vm" }));
    expect(button("Take control")?.disabled).toBe(true);
    expect(fixture.controls).toEqual([]);
    flushSync(() => fixture.live!.onReadyChange?.(true));
    await press("Take control");
    expect(fixture.controls[0]?.action).toBe("take");
  });

  it("turns the panel's own picture into the live desktop at once; no window or tab opens", async () => {
    await open(makeBot({ computer: "vm" }));
    await press("Take control");
    await shownLive();
    expect(liveDesktop()!.dataset.target).toBe(`local/bot-${"a".repeat(64)}`);
    expect(window.madaniDesktop!.desktopViewer!.open, "nothing may open in another window").not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
    expect(fixture.controls).toEqual([{ action: "take", controlLeaseId: expect.stringMatching(/^[0-9a-f]{36}$/) }]);
    expect(document.body.textContent).toContain("You're in control");
    expect(button("Hand control back")).toBeDefined();
  });

  it("hands back at once and returns to watching", async () => {
    await open(makeBot({ computer: "vm" }));
    await press("Take control");
    await press("Hand control back");
    expect(fixture.controls.at(-1)).toEqual({ action: "release" });
    expect(liveDesktop()?.dataset.viewOnly).toBe("true");
    expect(button("Take control")).toBeDefined();
  });

  it("Full screen expands the watch without taking control", async () => {
    await open(makeBot({ computer: "vm" }));
    await press("Full screen");
    expect(fixture.controls).toEqual([]);
    await shownLive();
    expect(liveDesktop()!.dataset.expanded).toBe("true");
  });

  it("closing the panel, leaving its Screen view or closing the page gives back the hold it took", async () => {
    await open(makeBot({ computer: "vm" }));
    await press("Take control");
    const lease = fixture.controls[0]!.controlLeaseId;
    root!.unmount();
    root = null;
    expect(releases(), "closing the panel left the bot waiting").toEqual([
      { url: "/api/bots/scout/computer/control", body: { action: "release", controlLeaseId: lease }, keepalive: true },
    ]);

    fixture.beacons = [];
    await open(makeBot({ computer: "vm" }));

    fixture.beacons = [];
    await press("Take control");
    window.dispatchEvent(new Event("pagehide"));
    await settle();
    expect(releases(), "closing the page left the bot waiting").toHaveLength(1);
    expect(liveDesktop()?.dataset.viewOnly).toBe("true");
  });

  it("never gives back a hold another device has", async () => {
    fixture.held = true;
    fixture.owned = false;
    heldElsewhere(true);
    await open(makeBot({ computer: "vm" }));
    await press("Full screen");
    await shownLive();
    root!.unmount();
    root = null;
    expect(releases()).toEqual([]);
  });

  it("a hand-back from elsewhere ends the live view once it lasts, and a flicker does not", async () => {
    await open(makeBot({ computer: "vm" }));
    await press("Take control");
    await shownLive();
    heldElsewhere(false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    heldElsewhere(true);
    await new Promise((resolve) => setTimeout(resolve, 1_700));
    expect(liveDesktop(), "an out-of-order event ended the session").not.toBeNull();
    heldElsewhere(false);
    await new Promise((resolve) => setTimeout(resolve, 1_700));
    await settle();
    expect(liveDesktop()?.dataset.viewOnly).toBe("true");
    expect(releases(), "it was not this panel's to give back").toEqual([]);
  });

  it("a desktop that never comes up gives the computer back and says so", async () => {
    await open(makeBot({ computer: "vm" }));
    await press("Take control");
    await shownLive();
    flushSync(() => fixture.live!.onUnreachable());
    await settle();
    expect(releases()).toHaveLength(1);
    expect(liveDesktop()).toBeNull();
    expect(document.body.textContent).toContain("Couldn't open the live screen. Try again.");
    expect(fixture.posts).toContain("/api/bots/scout/local-computer/screenshot");
  });
});

describe("taking control of other computers", () => {
  it("falls back after a failed watch and retries the live connection on request", async () => {
    await open(makeBot({ computer: "cloud", cloudBackend: "vps" }));
    await shownLive();
    flushSync(() => fixture.live!.onUnreachable());
    await settle();
    expect(liveDesktop()).toBeNull();
    expect(fixture.posts).toContain("/api/bots/scout/computer/screenshot");
    expect(fixture.controls).toEqual([]);
    await press("retry live screen");
    await shownLive();
    expect(liveDesktop()?.dataset.viewOnly).toBe("true");
    expect(fixture.controls).toEqual([]);
  });

  it("refreshes a desktop that stopped after its ready status when the live watch fails", async () => {
    fixture.inline = true;
    await open(makeBot({ computer: "cloud" }));
    await shownLive();
    const reads = fixture.statusReads;
    fixture.cloudState = "stopped";
    flushSync(() => fixture.live!.onUnreachable());
    await settle();
    expect(document.querySelector("button[aria-label='Wake computer']"), document.body.textContent).not.toBeNull();
    expect(document.querySelector("[data-inline-computer]")?.getAttribute("data-stage")).toBe("asleep");
    expect(fixture.statusReads).toBe(reads + 1);
    expect(fixture.connections).toBe(1);
    expect(fixture.controls).toEqual([]);
    expect(fixture.posts.filter(path => !path.endsWith("/screenshot"))).toEqual([]);
    await settle();
    expect(fixture.statusReads).toBe(reads + 1);
  });

  it("shows the bot waking up inline, opens the viewer read-only, then takes explicit control", async () => {
    fixture.inline = true;
    fixture.ready = false;
    await open(makeBot({ computer: "cloud" }));
    await shownLive();
    const waking = document.querySelector("[data-computer-waking]");
    expect(waking?.querySelector("[data-waking-mascot]")).not.toBeNull();
    expect(waking?.textContent).toBe("Scout is waking up");
    expect(document.body.textContent).not.toMatch(/connecting/i);
    expect(liveDesktop()?.dataset.expanded).toBe("false");
    expect(fixture.controls).toEqual([]);
    flushSync(() => fixture.live!.onReadyChange?.(true));
    await settle();
    expect(document.querySelector("[data-computer-waking]")).toBeNull();
    flushSync(() => fixture.live!.onOpenPreview?.());
    await settle();
    expect(liveDesktop()?.dataset.expanded).toBe("true");
    expect(liveDesktop()?.dataset.viewOnly).toBe("true");
    expect(fixture.controls).toEqual([]);
    await press("Take control");
    expect(liveDesktop()?.dataset.viewOnly).toBe("false");
    expect(fixture.connections).toBe(1);
    expect(fixture.controls[0]?.action).toBe("take");
    expect(window.madaniDesktop!.desktopViewer!.open).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  });

  it("is a wake button from its first frame and keeps a click made before the status lands", async () => {
    fixture.inline = true;
    fixture.cloudState = "stopped";
    let release!: () => void;
    fixture.statusGate = new Promise((resolve) => { release = resolve; });
    // Auto, the place the server resolves to the bot's own cloud computer
    await open(makeBot({ busy: false }));
    expect(fixture.statusReads).toBe(1);
    const card = document.querySelector<HTMLButtonElement>("[data-inline-computer] button[aria-label='Wake computer']");
    expect(card, document.body.innerHTML).not.toBeNull();
    expect(card!.disabled).toBe(false);
    expect(document.body.textContent).not.toMatch(/browser only|Checking/);
    flushSync(() => card!.click());
    await settle();
    // the waking mascot shows at once, and nothing is asked of the server before it knows the place
    expect(document.querySelector("[data-computer-waking]")).not.toBeNull();
    expect(fixture.posts).toEqual([]);
    release();
    await settle();
    expect(fixture.posts).toContain("/api/bots/scout/computer/provision");
    await shownLive();
    expect(fixture.controls).toEqual([]);
  });

  it("never shows a browser-only card: with no computer here it offers to add one", async () => {
    fixture.inline = true;
    fixture.surface = "browser";
    await open(makeBot({ busy: false }));
    const card = document.querySelector<HTMLButtonElement>("[data-inline-computer] button[data-panel-action='open-computer']");
    expect(card?.textContent).toBe("Add cloud desktop…");
    expect(card?.disabled).toBe(false);
    expect(document.body.textContent).not.toMatch(/browser only/);
  });

  it("takes a wake clicked while the panel's code was still loading", async () => {
    const { queueComputerWake } = await import("./bot-panel/computer-wake-queue");
    fixture.inline = true;
    fixture.cloudState = "stopped";
    queueComputerWake("scout");
    await open(makeBot({ busy: false }));
    expect(fixture.posts).toContain("/api/bots/scout/computer/provision");
  });

  it("retries the inline live watch after a connection failure without taking control", async () => {
    fixture.inline = true;
    await open(makeBot({ computer: "cloud" }));
    await shownLive();
    const reads = fixture.statusReads;
    flushSync(() => fixture.live!.onUnreachable());
    await settle();
    expect(liveDesktop()).toBeNull();
    expect(fixture.statusReads).toBe(reads + 1);
    expect(fixture.connections).toBe(1);
    expect(button("Take control")).toBeUndefined();
    expect(button("Retry preview"), "no button to press: it comes back by itself").toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 1600));
    await shownLive();
    expect(fixture.controls).toEqual([]);
    expect(liveDesktop()?.dataset.viewOnly).toBe("true");
  });

  it("a VPS is driven in place and handing back keeps its live watch connected", async () => {
    await open(makeBot({ computer: "cloud", cloudBackend: "vps" }));
    await press("Take control");
    await shownLive();
    expect(liveDesktop()!.dataset.target).toBe("vps/scout");
    expect(window.madaniDesktop!.desktopViewer!.open).not.toHaveBeenCalled();
    await press("Hand control back");
    expect(fixture.beacons.some((beacon) => beacon.url.startsWith("/api/bots/scout/computer/viewer-close"))).toBe(false);
    expect(liveDesktop()?.dataset.viewOnly).toBe("true");
  });

  it("a saved legacy backend opens the VPS live viewer without an external provider window", async () => {
    await open(makeBot({ computer: "cloud", cloudBackend: "box" }));
    expect(fixture.live?.target).toBe("vps/scout");
    expect(fixture.live?.viewOnly).toBe(true);
    flushSync(() => button("Take control")!.click());
    await settle();
    expect(fixture.live?.viewOnly).toBe(false);
    expect(fixture.posts).not.toContain("/api/bots/scout/computer/join");
  });
});
