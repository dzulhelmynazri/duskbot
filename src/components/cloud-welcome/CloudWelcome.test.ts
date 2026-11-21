// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudSendNotice } from "../../../electron/cloud-send.mjs";
import { EMPTY_ONBOARDING } from "@/lib/onboarding";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({
  state: {} as any,
  dispatch: vi.fn(),
  api: vi.fn(),
  plan: null as any,
  imported: null as null | (() => void),
}));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch, refreshInstances: vi.fn() }),
  api: fixture.api,
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/components/Avatar", () => ({ MausAvatar: () => null }));
vi.mock("@/components/CloudTrialNotice", () => ({ useCloudPlanSnapshot: () => fixture.plan }));
// The team library has its own tests.
vi.mock("@/components/TeamLibraryPanel", async () => {
  const { createElement: h } = await import("react");
  return { TeamLibraryPanel: ({ onImported }: { onImported: () => void }) => { fixture.imported = onImported; return h("div", { "data-team-library": "" }); } };
});
import { CloudWelcome, sentHere } from "./CloudWelcome";
import { CLOUD_SETUP_MOVE_SKIPPED, CLOUD_WELCOME_DONE, CLOUD_WELCOME_SHOWN as SHOWN, welcomeStepHint } from "@/lib/cloud-setup";
import { resetCloudWelcome, returnToWelcome, useCloudWelcome } from "@/lib/cloud-welcome";

const CLOUD = { name: "Studio Cloud", origin: "https://madani-u-1a2b3c4d5e6f.fly.dev" };
const quiet: CloudSendNotice = { ready: true, bots: [], updatedBots: [], skills: 0, logins: 0, onePassword: false, settings: 0, signature: "", dismissed: false, running: false, last: null, whole: null };
const claude = { instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", access: "subscription", authentication: { method: "paste-code" }, snapshot: { state: "available", authenticated: false }, models: { default: "", options: [] } };
const codex = { ...claude, instanceId: "codex", driverKind: "codex", displayName: "Codex" };

let host: HTMLDivElement;
let root: Root;
const welcome = { current: null as ReturnType<typeof useCloudWelcome> | null };
function Probe() { welcome.current = useCloudWelcome(); return null; }
const render = () => flushSync(() => root.render([createElement(CloudWelcome, { key: "welcome" }), createElement(Probe, { key: "probe" })]));
const text = () => host.textContent ?? "";
const button = (label: string) => [...document.body.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);
const click = (label: string) => {
  const target = button(label);
  if (!target) throw new Error(`no button "${label}" in: ${text()}`);
  flushSync(() => target.click());
};
const hintsPut = () => fixture.api.mock.calls.filter(([path, init]) => path === "/api/config" && JSON.parse(String(init.body)).onboarding)
  .map(([, init]) => JSON.parse(String(init.body)).onboarding.hintsSeen as string[]);

beforeEach(() => {
  vi.clearAllMocks();
  setLocale("en");
  resetCloudWelcome();
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value); },
    removeItem: (key: string) => { stored.delete(key); },
  });
  fixture.plan = null;
  fixture.imported = null;
  fixture.state = {
    connected: true, selectedId: "b1", activeView: "chat", routines: [], groups: [],
    bots: [{ id: "b1", threadId: "t1", name: "Maus" }, { id: "b2", threadId: "t2", name: "Ada", chiefOfStaff: true }],
    instances: [claude, codex],
    config: { cloudHome: true, onboarding: { ...EMPTY_ONBOARDING }, profile: { name: "", email: "", aboutMe: "" } },
  };
  fixture.api.mockImplementation(async (path: string, init?: RequestInit) => {
    const patch = JSON.parse(String(init?.body ?? "{}"));
    if (patch.onboarding) return { ...fixture.state.config, onboarding: { ...fixture.state.config.onboarding, ...patch.onboarding } };
    throw new Error(`unexpected ${path}`);
  });
  window.madaniDesktop = {
    platform: "darwin", cloudPlan: { state: vi.fn() },
    cloudSendPage: { notice: vi.fn().mockResolvedValue(quiet), dismiss: vi.fn(), onNotice: vi.fn(() => () => {}) },
    workspaces: { state: vi.fn().mockResolvedValue({ local: false, name: "Studio Cloud", origin: CLOUD.origin }), menu: vi.fn() },
  } as unknown as typeof window.madaniDesktop;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  delete window.madaniDesktop;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const signedIn = { ...claude, snapshot: { state: "available", authenticated: true } };
const STEPS = [welcomeStepHint("bring"), welcomeStepHint("engine"), welcomeStepHint("files")];
const notice = (extra: Partial<CloudSendNotice> = {}): CloudSendNotice => ({ ...quiet, ...extra });
const sentLast = { at: 1, reason: "move", failed: 0, seen: false, sent: { bots: 4, updatedBots: 0, skills: 2, logins: 0, onePassword: false, settings: 0, chats: null } } as NonNullable<CloudSendNotice["last"]>;
let pushNotice: (value: CloudSendNotice) => void = () => {};
const withSend = (value: CloudSendNotice | null, more: Record<string, unknown> = {}) => {
  const page = { notice: vi.fn().mockResolvedValue(value), dismiss: vi.fn(), onNotice: vi.fn((listener: (next: CloudSendNotice) => void) => { pushNotice = listener; return () => {}; }), ...more };
  window.madaniDesktop = { ...window.madaniDesktop!, cloudSendPage: page } as unknown as typeof window.madaniDesktop;
  return page;
};

describe("CloudWelcome", () => {
  it("is one screen: the bots landing on the cloud, what is different now, and one thing to do, with no steps to go through", () => {
    vi.stubEnv("VITE_MADANI_PHONE_APP", "0");
    render();
    expect(host.querySelector("[data-cloud-move-scene]")).not.toBeNull();
    expect(host.querySelector("h1")?.textContent).toBe("Welcome to madani cloud");
    expect([...host.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
      "Your bots keep working, even while your computer sleeps", "Routines run on time, every time"]);
    expect(host.querySelector("[data-welcome-rail]")).toBeNull();
    expect(host.querySelector('[data-welcome-step="files"]')).toBeNull();
    expect([...host.querySelectorAll("[data-welcome-action]")].map((node) => node.textContent)).toEqual(["Connect your AI", "Not now"]);
    expect(hintsPut()).toEqual([[SHOWN]]);
    render();
    expect(hintsPut(), "noted once").toEqual([[SHOWN]]);
  });

  it("on a Team Cloud says the team's name, and lists the person's bots to bring in only in the desktop app", async () => {
    const bring = async (team: boolean, desktop: boolean) => {
      flushSync(() => root.unmount());
      root = createRoot(host);
      fixture.state.config = { ...fixture.state.config, ...(team ? { team: { id: "team-acme", name: "Acme" } } : { team: undefined }) };
      if (desktop) withSend(quiet, { teamBring: vi.fn(async () => ({ team: { id: "team-acme", name: "Acme", ready: true }, bots: [{ id: "atlas", name: "Atlas" }] })), teamBringMove: vi.fn() });
      else window.madaniDesktop = { ...window.madaniDesktop!, cloudSendPage: undefined } as unknown as typeof window.madaniDesktop;
      render();
      await vi.waitFor(() => expect(host.querySelector("h1")).not.toBeNull());
      await new Promise((resolve) => setTimeout(resolve, 0));
      return Boolean(host.querySelector("[data-bring-my-cloud]"));
    };
    expect(await bring(true, true)).toBe(true);
    await vi.waitFor(() => expect(host.querySelector("h1")?.textContent).toBe("Welcome to Studio Cloud"));
    expect(await bring(false, true), "on My Cloud itself").toBe(false);
    expect(await bring(true, false), "in a browser").toBe(false);
  });

  it("with no AI working, Connect your AI shows the same Connect an AI grid as this computer, and Skip comes back", () => {
    render();
    click("Connect your AI");
    expect(host.querySelector('[data-welcome-step="engine"] [data-ai-cards]')).not.toBeNull();
    expect(host.querySelector('[data-funnel-ai="claude"]')).not.toBeNull();
    expect(host.querySelector('[data-funnel-ai="chatgpt"]')).not.toBeNull();
    expect(host.querySelector("[data-cloud-choice], [data-engine-setup]"), "no cloud-only tiles or sign-in cards").toBeNull();
    click("Skip for now");
    expect(host.querySelector('[data-welcome-step="engine"]')).toBeNull();
    expect(hintsPut().at(-1)).toEqual(expect.arrayContaining([welcomeStepHint("engine")]));
    expect(button("Connect your AI"), "still the one thing to do").toBeDefined();
  });

  it("right after an AI is connected here, checks it with one tiny real message and says it works", async () => {
    const checks: string[] = [];
    const config = fixture.api.getMockImplementation()!;
    fixture.api.mockImplementation(async (path: string, init?: RequestInit) => {
      const check = /^\/api\/instances\/([\w.-]+)\/check$/.exec(path);
      if (!check) return config(path, init);
      checks.push(check[1]!);
      return { ok: true };
    });
    render();
    click("Connect your AI");
    expect(checks).toEqual([]);
    fixture.state = { ...fixture.state, instances: [signedIn, codex] };
    render();
    await vi.waitFor(() => expect(text()).toContain("Claude is working"));
    expect(checks).toEqual(["claude"]);
  });

  it("opened at the AI (the Set up card's Connect) with one already working, goes straight back to the welcome", async () => {
    fixture.state.instances = [signedIn, codex];
    returnToWelcome("engine");
    render();
    await vi.waitFor(() => expect(host.querySelector('[data-welcome-step="engine"]')).toBeNull());
    expect(hintsPut().at(-1)).toEqual(expect.arrayContaining([welcomeStepHint("engine")]));
    expect(button("Start chatting")).toBeDefined();
  });

  it("with an AI working, Start chatting ends it and opens the Chief of Staff, every step handled for the Set up card", () => {
    fixture.state.instances = [signedIn, codex];
    render();
    click("Start chatting");
    expect(hintsPut().at(-1)).toEqual(expect.arrayContaining([SHOWN, CLOUD_WELCOME_DONE, ...STEPS, CLOUD_SETUP_MOVE_SKIPPED]));
    expect(fixture.dispatch.mock.calls.map(([action]) => action.type)).toEqual(expect.arrayContaining(["showChat"]));
    expect(fixture.dispatch.mock.calls.some(([action]) => action.id === "b2" || action.botId === "b2"), "the chief of staff").toBe(true);
    expect(welcome.current!.ended).toBe(true);
  });

  it("Not now ends it for good, and picking a bot in the sidebar only steps it aside", () => {
    render();
    fixture.state = { ...fixture.state, selectedId: "b2" };
    render();
    expect(welcome.current!.aside).toBe(true);
    expect(hintsPut()).toEqual([[SHOWN]]);
    click("Not now");
    expect(hintsPut().at(-1)).toEqual(expect.arrayContaining([CLOUD_WELCOME_DONE, ...STEPS]));
    expect(welcome.current!.ended).toBe(true);
  });

  it("while this computer's bots come over says so in one line, then that they are here, and never calls that skipped", async () => {
    withSend(notice({ running: true, runningReason: "move" }));
    render();
    await vi.waitFor(() => expect(host.querySelector('[data-welcome-arrived="sending"]')?.textContent).toBe("Your bots are on their way here…"));
    flushSync(() => pushNotice(notice({ last: sentLast })));
    await vi.waitFor(() => expect(host.querySelector('[data-welcome-arrived="sent"]')?.textContent).toBe("Your bots are here"));
    click("Not now");
    expect(hintsPut().at(-1)).not.toContain(CLOUD_SETUP_MOVE_SKIPPED);
  });

  it("says what came over only after a whole send went through", () => {
    const state = (value: CloudSendNotice | null) => sentHere(value)?.state ?? null;
    const last = (extra: Record<string, unknown> = {}) => ({ ...sentLast, ...extra }) as NonNullable<CloudSendNotice["last"]>;
    expect(state(null)).toBeNull();
    expect(state({ ...notice(), whole: undefined } as unknown as CloudSendNotice), "a desktop too old to say").toBeNull();
    expect(state(notice()), "nothing sent and nothing on its way").toBeNull();
    expect(state(notice({ running: true, runningReason: "move" }))).toBe("sending");
    expect(state(notice({ last: last() }))).toBe("sent");
    expect(state(notice({ last: last({ error: "this app could not sign in to My Cloud. Try again." }) })), "a send that failed as a whole").toBeNull();
    expect(state(notice({ last: last({ reason: "logins" }) })), "one login sent by hand").toBeNull();
    for (const older of ["first", "auto"]) expect(state(notice({ last: last({ reason: older }) })), older).toBe("sent");
    expect(state({ ...notice(), auto: true }), "an older desktop's switch on, nothing gone yet").toBe("sending");
  });
});
