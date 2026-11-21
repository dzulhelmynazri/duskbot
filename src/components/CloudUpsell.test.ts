import { createElement, type EffectCallback } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { EMPTY_ONBOARDING } from "@/lib/onboarding";
import { dayKey, NUDGE_KEY } from "@/lib/cloud-nudge";

const f = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[], refs: [] as { current: unknown }[], ref: 0, state: {} as any, dispatch: null as any }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = f.index++; if (!(index in f.values)) f.values[index] = typeof initial === "function" ? initial() : initial;
    return [f.values[index], (next: unknown) => { f.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(f.values[index]) : next; }]; },
  useRef: (initial: unknown) => { const index = f.ref++; f.refs[index] ??= { current: initial }; return f.refs[index]; },
  useEffect: (effect: EffectCallback) => { f.effects.push(effect); },
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
}));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: f.state, dispatch: f.dispatch }), api: vi.fn() }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("./mascot-view", () => ({ MadaniMark: () => null }));
vi.mock("./ProIntroduction", () => ({ useCloudPlan: () => ({ view: { kind: "signed-out" }, account: null }) }));
vi.mock("./onboarding/WelcomeGate", () => ({ localDesktopPage: () => true }));
vi.mock("./vps-link/parts", () => ({ deviceWord: () => "Mac" }));
import { track } from "@/lib/analytics";
import { api } from "@/state/store";

const bots = (count: number, turns = 1) => Array.from({ length: count }, (_, i) => ({ tasks: [{ threadId: `t${i}`, usage: { turns } }] }));
let storage: Map<string, string>;
let Card: typeof import("./CloudUpsell").SidebarCloudCard;

const render = () => { f.index = 0; f.ref = 0; f.effects = []; return renderToStaticMarkup(createElement(Card)); };
async function settle() { for (let i = 0; i < 3; i++) { render(); f.effects.forEach(effect => effect()); await Promise.resolve(); } return render(); }
/** a new launch: a fresh module, so nothing held from the last one */
async function launch() { vi.resetModules(); Card = (await import("./CloudUpsell")).SidebarCloudCard; f.values = []; f.refs = []; return settle(); }

/** today on this computer: messages sent, and the last showing's time */
const today = (messages = 1, over: { shown?: number; lastShownAt?: number } = {}) =>
  storage.set(NUDGE_KEY, JSON.stringify({ day: dayKey(Date.now()), sessions: 1, messages, shown: 0, lastShownAt: 0, ...over }));

beforeEach(() => {
  vi.clearAllMocks(); setLocale("en"); storage = new Map(); f.dispatch = vi.fn(); today();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: () => {} });
  vi.stubGlobal("window", { madaniDesktop: {} });
  f.state = { hydrated: true, bots: bots(1), groups: [], routines: [], config: { onboarding: { ...EMPTY_ONBOARDING, completedAt: "2026-09-01", version: 1, hintsSeen: [] } } };
  vi.mocked(api).mockImplementation(async (_path, init) => {
    f.state.config.onboarding.hintsSeen = JSON.parse(String((init as RequestInit).body)).onboarding.hintsSeen;
    return f.state.config;
  });
});

describe("the madani cloud offer in the sidebar's spot", () => {
  it("is the website sidebar's card: madani cloud keeps your bots working, and Keep them working, with no nap in it", async () => {
    const html = await launch();
    expect(html).toContain('data-spot-card=""');
    expect(html).toContain("madani cloud keeps your bots working, even when your Mac is off.");
    expect(html).toContain(">Keep them working<");
    expect(html).not.toMatch(/\bnap/i);
    expect(track).toHaveBeenCalledWith("upsell_shown", { source: "app_sidebar" });
  });

  it("switches to their own numbers once someone is invested, counted as app_invested, once per account", async () => {
    f.state.bots = bots(3);
    const html = await launch();
    expect(html).toContain('data-spot-cta="cloud-invested"');
    expect(html).toContain("good crew of bots");
    expect(html).toContain("madani cloud keeps them working, even when your Mac is off.");
    expect(track).toHaveBeenCalledWith("upsell_shown", { source: "app_invested" });
    expect(track).not.toHaveBeenCalledWith("upsell_shown", { source: "app_sidebar" });
    expect(f.state.config.onboarding.hintsSeen).toContain("cloud-invested-v1");
    expect(await settle(), "holds for the rest of the launch").toContain("good crew of bots");
    today(1);
    expect(await launch(), "the next launch is back to the plain card").toContain('data-spot-cta="cloud"');
  });

  it("quotes messages and routines too", async () => {
    f.state.bots = [...bots(1, 25), ...bots(1, 25)];
    expect(await launch()).toContain("heavy workload");
    f.state.bots = bots(1); f.state.config.onboarding.hintsSeen = []; storage.clear(); today(); f.state.routines = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(await launch()).toContain("routines are doing real work");
  });

  it("Get madani cloud opens Add a Cloud as app_invested, and that showing is over", async () => {
    f.state.bots = bots(3);
    await launch();
    f.index = 0; f.ref = 0;
    const element = (Card as () => unknown)() as any;
    const buttons: any[] = [];
    const walk = (node: any) => { if (!node || typeof node !== "object") return; if (node.type === "button") buttons.push(node); [node.props?.children].flat().forEach(walk); };
    walk(element.type(element.props));
    buttons.find(button => button.props["data-spot-cta-start"] === "").props.onClick();
    expect(f.dispatch).toHaveBeenCalledWith({ type: "openCloudAdd", source: "app_invested", signIn: true });
    expect(track).toHaveBeenCalledWith("upsell_click", { source: "app_invested", ms: expect.any(Number) });
    expect(await settle(), "clicked: this showing is over").toBe("");
  });

  it("the x ends the showing for this launch and is counted as a dismiss", async () => {
    await launch();
    f.index = 0; f.ref = 0;
    const element = (Card as () => unknown)() as any;
    const buttons: any[] = [];
    const walk = (node: any) => { if (!node || typeof node !== "object") return; if (node.type === "button") buttons.push(node); [node.props?.children].flat().forEach(walk); };
    walk(typeof element.type === "function" ? element.type(element.props) : element);
    buttons.find(button => button.props["aria-label"] === "Hide").props.onClick();
    expect(track).toHaveBeenCalledWith("upsell_dismiss", { source: "app_sidebar", ms: expect.any(Number) });
    expect(await settle()).toBe("");
    expect(storage.has("madani-cloud-sidebar-card-until")).toBe(false);
  });

  it("twice a day at most while the app is in use, never again within three hours", async () => {
    today(0);
    expect(await launch(), "the app in use today").toContain("data-spot-cta");
    today(0, { shown: 1, lastShownAt: Date.now() - 3600_000 });
    expect(await launch()).toBe("");
    today(0, { shown: 1, lastShownAt: Date.now() - 3 * 3600_000 - 1 });
    expect(await launch(), "the second, three hours on").toContain("data-spot-cta");
    today(30, { shown: 2, lastShownAt: Date.now() - 5 * 3600_000 });
    expect(await launch(), "two at most, however busy the day").toBe("");
  });

  it("never in a store build, nor before the first reply", async () => {
    vi.stubGlobal("document", { documentElement: { dataset: { mobileApp: "ios" } } });
    expect(await launch()).toBe("");
    vi.unstubAllGlobals();
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: () => {} });
    vi.stubGlobal("window", { madaniDesktop: {} });
    f.state.bots = [{ tasks: [] }];
    expect(await launch(), "first run").toBe("");
    expect(track).not.toHaveBeenCalledWith("upsell_shown", expect.anything());
  });

  it("steps aside when the corner madani cloud card has this launch, so only one cloud offer is on screen", async () => {
    vi.stubGlobal("sessionStorage", { getItem: () => "cloud-trial-intro-v1", setItem: () => {} });
    expect(await launch()).toBe("");
    expect(track).not.toHaveBeenCalledWith("upsell_shown", expect.anything());
  });

  it("waits below every threshold", async () => {
    f.state.bots = [...bots(1, 25), ...bots(1, 24)];
    expect(await launch()).not.toContain("cloud-invested");
  });
});
