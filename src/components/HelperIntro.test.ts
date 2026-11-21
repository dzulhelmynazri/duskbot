// @vitest-environment happy-dom
// Madani's first messages: three short bubbles, a follow-up once it has looked around (written once by the server, as
// a real message) and chips for only what is still missing.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setWelcomingBot, stageIntro } from "@/lib/default-bot";
import { setLocale, t } from "@/lib/i18n";
import type { Bot, InstanceInfo, Message } from "@/state/store";
import type { HelperFollowupFacts } from "../../shared/helper-followup";
import { rememberConnectorStatus } from "@/lib/connected-apps";

const f = vi.hoisted(() => ({
  state: {} as Record<string, unknown>, dispatch: vi.fn(), local: false, reduced: false,
  services: {} as Record<string, { connected: boolean }>, phones: [] as unknown[], found: null as unknown, detect: vi.fn(),
  followups: [] as unknown[], saves: true, bots: 0, routines: 0, improve: true as boolean | undefined, improveSaves: [] as unknown[],
}));
vi.mock("@/state/store", () => ({
  useStore: () => ({ state: f.state, dispatch: f.dispatch }),
  api: async (path: string, init?: { body?: string }) => {
    if (path === "/api/phones") return { phones: f.phones };
    if (path.endsWith("/helper-followup")) {
      const body = JSON.parse(init?.body ?? "{}");
      f.followups.push(body);
      if (!f.saves) throw new Error("older server");
      return { message: { id: "f", role: "bot", kind: "text", at: 2, text: "", helperFollowup: { ai: body.ai, apps: body.apps, bots: f.bots, routines: f.routines } } };
    }
    return {};
  },
}));
// the help-improve switch reads and saves through the plain api
vi.mock("@/state/api", () => ({
  api: async (path: string, init?: { body?: string }) => {
    if (path !== "/api/dashboard/usage-signals") return {};
    if (init?.body) f.improveSaves.push(JSON.parse(init.body));
    return init?.body ? JSON.parse(init.body) : f.improve === undefined ? {} : { enabled: f.improve };
  },
}));
vi.mock("./bot-settings/useBotApps", () => ({ loadAppCards: async () => new Map([["gmail", { label: "Gmail" }], ["github", { label: "GitHub" }]]) }));
vi.mock("./Avatar", () => ({ BotAvatar: () => null }));
vi.mock("./mascot-clock", () => ({ usePrefersReducedMotion: () => f.reduced }));
vi.mock("./onboarding/ConnectAi", async () => {
  const { createElement: h } = await import("react");
  return { ConnectAiDialog: ({ onClose }: { onClose: () => void }) => h("div", { "data-connect-ai": "", onClick: onClose }) };
});
vi.mock("./onboarding/welcome-ai", () => ({ useWelcomeAi: () => null }));
const analytics = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("@/lib/analytics", () => analytics);
vi.mock("@/lib/setup-import", () => ({
  localSetupImport: () => f.local,
  setupImportApi: {},
  detectSetupWithin: () => { f.detect(); return { found: Promise.resolve(f.found), cancel: () => {} }; },
}));
const { HelperIntro } = await import("./HelperIntro");
const { followupLine, INTRO_TIMING, introLines, whoConnectsAi } = await import("./SimpleHelperIntro");
const { setTeamPeople } = await import("@/state/team-people");
const { chipAction } = await import("./HelperSetup");
const { SIMPLE_BOT_BUBBLE } = await import("./chat-bubble");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const claude = (ready: boolean): InstanceInfo => ({ instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude",
  snapshot: { state: ready ? "available" : "unavailable", authenticated: ready }, models: { default: "m", options: [] } });
const maus = (extra: Partial<Bot> = {}): Bot => ({ id: "maus", threadId: "t", name: "Madani", title: "", description: "", notifications: true,
  color: "chrome", unread: false, modelSelection: { instanceId: "claude", model: "m" }, messages: [], defaultBot: {}, chiefOfStaff: true, ...extra });
const intro: Message = { id: "intro", role: "bot", kind: "options", at: 1, helperIntro: true, text: "Hey! I'm Madani. I'm new here.",
  card: { title: "Hey! I'm Madani. I'm new here.", subtitle: "", options: ["What are my bots up to?"] } };
const saved = (facts: HelperFollowupFacts): Message => ({ id: "f", role: "bot", kind: "text", at: 2, text: "English", helperFollowup: facts });

let host: HTMLDivElement, root: Root;
const lines = () => [...host.querySelectorAll("[data-helper-line]")].map((node) => node.textContent);
const chips = () => [...host.querySelectorAll<HTMLElement>("[data-helper-step]")].map((node) => node.dataset.helperStep);
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => {}); };
const show = async (answered = false, followup?: Message) => {
  await act(async () => { root.render(createElement(HelperIntro, { botId: "maus", threadId: "t", message: intro, answered, followup })); });
  await settle();
};
const tick = async (ms: number) => {
  await act(async () => { vi.advanceTimersByTime(ms); });
  await settle();
};

beforeEach(() => {
  // these runs offer the phone app; the hidden phone has its own case below
  vi.stubEnv("VITE_MADANI_PHONE_APP", "1");
  setLocale("en");
  f.dispatch.mockReset();
  f.detect.mockReset();
  analytics.track.mockReset();
  f.local = false;
  f.reduced = false;
  f.services = {};
  f.phones = [];
  f.found = null;
  f.followups = [];
  f.saves = true;
  f.bots = 0;
  f.routines = 0;
  f.improve = true;
  f.improveSaves = [];
  f.state = { connected: true, bots: [maus()], instances: [claude(true)], config: { profile: { name: "" } } };
  stageIntro(null);
  setWelcomingBot(null);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("what Madani says first", () => {
  it("as the Chief: who it is, what it does here, and that it is looking around, never by the person's name", () => {
    const said = [
      "Hey! I'm Madani. I'm new here.",
      "I'm here to be your chief of staff. I can manage your other bots. Task me with anything. I'll make sure it gets to the right bot.",
      "I'm taking a look around to see if there's anything I can pick up for you. I'll follow up in a moment.",
    ];
    expect(introLines({ name: "Madani", chief: true })).toEqual(said);
    expect(introLines({ name: "Madani", chief: true, person: "Ada" })).toEqual(said);
    expect(introLines({ name: "Madani", chief: true, team: "Acme" })[1]).toBe(`${said[1]} On Acme, I'm here for you and look after your own bots.`);
  });

  it("on a cloud set up from the computer: the Chief greets the person by name and says what came along", () => {
    const lines = introLines({ name: "Madani", chief: true, person: "Ada", fromComputer: true, carried: true });
    expect(lines[0]).toBe("Hey Ada! I'm Madani. I'm new here.");
    expect(lines[1]).toMatch(/I brought over what you told me about yourself on your computer\.$/);
    expect(introLines({ name: "Madani", chief: true, fromComputer: true })[0]).toBe("Hey! I'm Madani. I'm new here.");
  });

  it("keeps a helper's lines for a Madani that is not the Chief", () => {
    expect(introLines({ name: "Madani", chief: false })[0]).toBe("Hi! I'm Madani, your helper for everything here.");
    expect(introLines({ name: "Madani", chief: false, person: "Ada" })[0]).toBe("Hi Ada! I'm Madani, your helper for everything here.");
    const member = introLines({ name: "Madani", chief: false, team: "Acme" });
    expect(member[1]).toBe("Ask me how to do anything here. I can set up bots, apps and routines with you. On Acme, I'm here for you and look after your own bots.");
  });

  it("follows up on what it found, never naming the AI it thinks with", () => {
    const none = { apps: [], bots: 0, routines: 0 };
    expect(followupLine({ ai: "own", ...none })).toBe("I looked around and nothing's waiting on you yet. There's no unfinished work, no other bots or routines, and no apps are connected so far. If you'd like me to keep an eye on your day, I can connect your email and calendar so I can flag what matters each morning. Just say the word, or hand me whatever's on your plate today.");
    expect(followupLine({ ai: "own", apps: [], bots: 1, routines: 3 })).toContain("You have 1 other bot and 3 routines, and no apps are connected so far.");
    expect(followupLine({ ai: "own", apps: [], bots: 2, routines: 0 })).toContain("You have 2 other bots and no routines,");
    expect(followupLine({ ai: "own", apps: ["Gmail", "GitHub"], bots: 0, routines: 0 })).toBe("I looked around and nothing's waiting on you yet. I can already use Gmail and GitHub. Hand me whatever's on your plate today, or ask me to set up a bot for something you do every week.");
    expect(followupLine({ ai: "own", apps: ["Gmail", "GitHub", "Slack", "Notion", "Linear"], bots: 0, routines: 0 })).toContain("Gmail, GitHub, Slack, and 2 more");
    expect(followupLine({ ai: "none", ...none })).toBe(t("helperIntro.followup.noAi"));
    expect(followupLine({ ai: "backup", ...none })).toContain("free backup model");
    expect(whoConnectsAi(null), "off a team").toBeUndefined();
    expect(followupLine({ ai: "backup", ...none, connects: "" })).toBe(t("helperIntro.followup.backupTeamOwner"));
    expect(followupLine({ ai: "own", ...none, connects: "Olive" }), "with an AI there is nothing to connect").toContain("nothing's waiting");
  });
});

describe("in the chat (Simple mode)", () => {
  it("draws its lines and follow-up as the chat's own bubbles, with chips for only what is missing", async () => {
    f.services = { gmail: { connected: false } };
    await show(false, saved({ ai: "own", apps: [], bots: 0, routines: 0 }));
    expect(lines()).toHaveLength(4);
    expect(host.querySelector("[data-helper-followup]")?.textContent).toContain("nothing's waiting on you yet");
    const first = host.querySelector<HTMLElement>('[data-helper-line="0"]')!;
    expect(first.dataset.chatBubble, "the chat's own Simple bubble").toBe("simple");
    expect(first.className).toContain(SIMPLE_BOT_BUBBLE);
    expect(chips()).toEqual(["apps", "phone", "cloud"]);
    expect([...host.querySelectorAll("[data-helper-step]")].map((node) => node.textContent)).toEqual(["Connect email & calendar", "Connect your phone", "Try cloud"]);
    expect(f.followups, "only a first run asks for a follow-up").toEqual([]);
  });

  it("shows no chips or asks while the app connects or reconnects, or the transcript is still loading", async () => {
    f.services = { gmail: { connected: false } };
    const followup = saved({ ai: "own", apps: [], bots: 0, routines: 0 });
    f.state = { ...f.state, connected: false };
    await show(false, followup);
    expect(chips()).toEqual([]);
    expect(host.querySelector("[data-helper-setup]")).toBeNull();
    f.state = { ...f.state, connected: true, bots: [maus({ transcriptLoaded: false })] };
    await show(false, followup);
    expect(host.querySelector("[data-helper-setup]")).toBeNull();
    f.state = { ...f.state, bots: [maus()] };
    await show(false, followup);
    expect(chips(), "back under the message once the chat is shown").toEqual(["apps", "phone", "cloud"]);
  });

  it("offers no phone while the phone app is hidden", async () => {
    vi.stubEnv("VITE_MADANI_PHONE_APP", "0");
    f.services = { gmail: { connected: false } };
    await show(false, saved({ ai: "own", apps: [], bots: 0, routines: 0 }));
    expect(chips()).toEqual(["apps", "cloud"]);
  });

  it("tells a User the team's owner connects the AI, even under a follow-up written before it knew to", async () => {
    const dana = { email: "dana@acme.test", name: "Dana", role: "member", you: true as const };
    const olive = { email: "olive@acme.test", name: "Olive", role: "owner" };
    f.state = { ...f.state, instances: [] };
    setTeamPeople({ people: [dana, olive], me: dana, admin: false, needsYou: [] });
    await show(false, saved({ ai: "none", apps: [], bots: 0, routines: 0 }));
    expect(lines()[3]).toBe(t("helperIntro.followup.noAiOwner", { name: "Olive" }));
    expect(lines()[3]).not.toMatch(/sign in/i);
    setTeamPeople({ people: [dana], me: dana, admin: false, needsYou: [] });
    await show(false, saved({ ai: "none", apps: [], bots: 0, routines: 0 }));
    expect(lines()[3]).toBe(t("helperIntro.followup.noAiTeamOwner"));
    setTeamPeople({ people: [{ ...dana, role: "admin" }, olive], me: dana, admin: true, needsYou: [] });
    await show(false, saved({ ai: "none", apps: [], bots: 0, routines: 0 }));
    expect(lines()[3], "an admin can connect one").toBe(t("helperIntro.followup.noAi"));
    setTeamPeople(null);
  });

  it("shows three chips at most, AI first, and a tapped one stays to be tapped again", async () => {
    f.state = { ...f.state, instances: [claude(false)] };
    await show();
    expect(lines()[3]).toBe(t("helperIntro.followup.noAi"));
    expect(chips()).toEqual(["ai", "apps", "phone"]);
    await act(async () => { host.querySelector<HTMLElement>('[data-helper-step="phone"]')!.click(); });
    expect(f.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "toggleAppSettings", section: "companion", phonePairing: true }));
    expect(chips()).toEqual(["ai", "apps", "phone"]);
  });

  it("opens the madani cloud sheet from its chip and keeps the chip", async () => {
    f.state = { ...f.state, instances: [claude(true)] };
    await show();
    await act(async () => { host.querySelector<HTMLElement>('[data-helper-step="cloud"]')!.click(); });
    expect(f.dispatch).toHaveBeenCalledWith({ type: "openCloudAdd", source: "app_onboarding" });
    expect(chips()).toContain("cloud");
  });

  it("opens the Connect an AI dialog in place from its chip, not Settings", async () => {
    f.state = { ...f.state, instances: [claude(false)] };
    await show();
    await act(async () => { host.querySelector<HTMLElement>('[data-helper-step="ai"]')!.click(); });
    expect(host.querySelector("[data-connect-ai]")).not.toBeNull();
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("never counts OpenCode's free model as the person's own AI", async () => {
    f.state = { ...f.state, instances: [{ instanceId: "opencodeGo", driverKind: "opencodeGo", displayName: "OpenCode",
      snapshot: { state: "available", authenticated: true, freeFallback: true }, models: { default: "m", options: [] } }] };
    await show();
    expect(lines()[3]).toContain("free backup model");
    expect(chips()[0]).toBe("ai");
  });

  it("offers to bring in skills this computer has, looking only from its own window", async () => {
    f.local = true;
    f.found = { skills: [{ name: "pdf", source: "claudeCode" }], tools: [] };
    await show();
    expect(chips()).toEqual(["apps", "import", "phone"]);
    expect(chipAction("import")).toEqual({ type: "toggleAppSettings", open: true, section: "import" });
  });

  it("offers first jobs to tap, each sent as the person's first message, and the message box takes the focus", async () => {
    const box = document.createElement("div");
    box.dataset.tour = "composer";
    const field = document.createElement("textarea");
    box.append(field);
    document.body.append(box);
    await show(false, saved({ ai: "own", apps: [], bots: 0, routines: 0 }));
    const asks = [...host.querySelectorAll<HTMLElement>("[data-helper-ask]")];
    expect(asks.map((node) => node.textContent)).toEqual(["Keep an eye on my day", "Set up a bot for my inbox", "Help me plan my week"]);
    expect(asks[0]!.closest("[data-helper-setup]"), "in the chips' own row, before them").toBe(host.querySelector("[data-helper-setup]"));
    await act(async () => { asks[0]!.click(); });
    await act(async () => { await new Promise((done) => requestAnimationFrame(() => done(null))); });
    expect(f.dispatch).toHaveBeenCalledWith({ type: "answerCard", botId: "maus", threadId: "t", messageId: "intro", answer: "Keep an eye on my day" });
    expect(document.activeElement).toBe(field);
    box.remove();
  });

  it("fits the first jobs to a connected inbox", async () => {
    rememberConnectorStatus({ gmail: { connected: true } } as Parameters<typeof rememberConnectorStatus>[0], true);
    await show(false, saved({ ai: "own", apps: ["Gmail"], bots: 0, routines: 0 }));
    rememberConnectorStatus({}, true);
    expect([...host.querySelectorAll<HTMLElement>("[data-helper-ask]")].map((node) => node.textContent))
      .toEqual(["Keep an eye on my day", "What needs a reply in my inbox?", "Help me plan my week"]);
  });

  it("offers no jobs to tap before there is an AI to do them, or once the person has written", async () => {
    f.state = { ...f.state, instances: [claude(false)] };
    await show();
    expect(host.querySelector("[data-helper-ask]")).toBeNull();
    expect(chips()[0]).toBe("ai");
    f.state = { ...f.state, instances: [claude(true)] };
    await show(true, saved({ ai: "own", apps: [], bots: 0, routines: 0 }));
    expect(host.querySelector("[data-helper-ask]")).toBeNull();
  });

  it("drops the chips once the person has written, and no longer looks for skills", async () => {
    f.local = true;
    await show(true, saved({ ai: "own", apps: [], bots: 0, routines: 0 }));
    expect(lines()).toHaveLength(4);
    expect(chips()).toEqual([]);
    expect(host.querySelector("[data-help-improve]")).toBeNull();
    expect(f.detect).not.toHaveBeenCalled();
  });

  it("counts Try Cloud as the first run's Cloud moment, then opens Add a Cloud", async () => {
    await show();
    await act(async () => { host.querySelector<HTMLElement>('[data-helper-step="cloud"]')!.click(); });
    expect(analytics.track).toHaveBeenCalledWith("onboarding_cloud", { action: "start_trial" });
    expect(f.dispatch).toHaveBeenCalledWith({ type: "openCloudAdd", source: "app_onboarding" });
  });

  it("opens the app's own flow for each chip", () => {
    expect(chipAction("apps")).toEqual({ type: "togglePlugins", open: true, surface: "apps" });
    expect(chipAction("phone")).toMatchObject({ type: "toggleAppSettings", section: "companion", phonePairing: true });
    expect(chipAction("cloud")).toEqual({ type: "openCloudAdd", source: "app_onboarding" });
  });

  it("says nothing while the Chief step still introduces Madani", async () => {
    setWelcomingBot("maus");
    await show();
    expect(host.querySelector("[data-helper-intro]")).toBeNull();
  });
});

describe("as a first run lands in the chat", () => {
  it("arrives part by part: three lines, the bot typing, its follow-up (written once by the server), then the chips", async () => {
    vi.useFakeTimers();
    f.bots = 2;
    stageIntro("maus");
    await show();
    expect(lines()).toEqual([]);
    expect(f.followups, "asked for once its look around settles").toEqual([{ threadId: "t", ai: "own", apps: [] }]);
    await tick(INTRO_TIMING.first);
    expect(lines()).toHaveLength(1);
    await tick(INTRO_TIMING.line);
    expect(lines()).toHaveLength(2);
    await tick(INTRO_TIMING.line);
    expect(lines()).toHaveLength(3);
    expect(host.querySelector("[data-helper-typing]")).toBeNull();
    await tick(INTRO_TIMING.typing);
    expect(host.querySelector("[data-helper-typing]")?.textContent).toContain("Typing…");
    await tick(INTRO_TIMING.followup - 1);
    expect(lines()).toHaveLength(3);
    await tick(1);
    expect(lines()[3], "the server's counts").toContain("You have 2 other bots and no routines");
    expect(host.querySelector("[data-helper-typing]")).toBeNull();
    expect(chips()).toEqual([]);
    await tick(INTRO_TIMING.chips);
    expect(chips()).toEqual(["apps", "phone", "cloud"]);
    await show();
    expect(f.followups, "never asked twice").toHaveLength(1);
  });

  it("with no AI shows no typing row, and follows up soon after the last line", async () => {
    vi.useFakeTimers();
    f.state = { ...f.state, instances: [claude(false)] };
    stageIntro("maus");
    await show();
    await tick(INTRO_TIMING.first);
    await tick(INTRO_TIMING.line);
    await tick(INTRO_TIMING.line);
    expect(lines()).toHaveLength(3);
    await tick(INTRO_TIMING.noAi);
    expect(host.querySelector("[data-helper-typing]")).toBeNull();
    expect(lines()[3]).toBe(t("helperIntro.followup.noAi"));
  });

  it("shows everything at once with reduced motion, and says what it saw itself when the server can't save it", async () => {
    f.reduced = true;
    f.saves = false;
    stageIntro("maus");
    await show();
    expect(f.followups).toHaveLength(1);
    expect(lines()).toHaveLength(4);
    expect(chips()).toEqual(["apps", "phone", "cloud"]);
  });
});
