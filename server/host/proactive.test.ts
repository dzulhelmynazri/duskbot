import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createWatchSuggestionRoutes } from "../routes/watch-suggestion.ts";
import { RoutineManager } from "../routines.ts";
import { Store } from "../store.ts";
import { watchAsMade, WATCH_SUGGESTION_TEXT } from "./default-watch.ts";
import { createProactive, WATCH_FILE, WATCH_INSTRUCTIONS, WATCH_NAME } from "./proactive.ts";

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(options: { team?: boolean; driver?: string; configured?: () => boolean; cloud?: boolean; busy?: () => boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "madani-proactive-"));
  dirs.push(dir);
  const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
  const chief = store.createBot({ name: "Chief" });
  store.setChiefOfStaff(chief.id);
  const reads: string[] = [];
  const relay = async (_cfg: AppConfig, payload: never) => {
    const frame = payload as { method: string; params?: { arguments?: { tools?: Array<{ tool_slug: string }> } } };
    if (frame.method === "tools/call") reads.push(frame.params!.arguments!.tools![0]!.tool_slug);
    return { status: 200, bytes: new TextEncoder().encode("{}"), transportSessionId: "s" };
  };
  let routines: RoutineManager | null = null;
  const make = () => createProactive({
    store, cfg: {} as AppConfig, dataDir: dir, team: options.team ?? false, routines: () => routines,
    composio: { configured: options.configured ?? (() => true), connectedServices: async () => ({ gmail: { connected: true }, googlecalendar: { connected: true } }), relayMcp: relay },
    registry: { get: () => ({ driverKind: options.driver ?? "claudeAgent", adapter: {} as never }) },
    mainThread: (botId) => store.bot(botId)?.threadId, threadBusy: options.busy ?? (() => false), notify: () => {}, engineName: () => "Claude", needsYou: () => [],
    hostTimeZone: () => "UTC", decide: () => {}, stale: () => false, release: () => {}, owned: () => {},
    ...(options.cloud !== undefined ? { cloud: options.cloud } : {}),
  });
  const proactive = make();
  routines = new RoutineManager({ file: join(dir, "routines.json"), botState: () => "ready", createTask: () => ({ threadId: "t" }), startTurn: async () => {}, checks: proactive.checks });
  return { dir, store, chief, proactive, make, reads, routines: () => routines! };
}

const owner: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const guest: RequestAuth = { kind: "loopback", scopes: ["client"], trust: "service" };
const cards = (s: ReturnType<typeof setup>) => s.store.messagesFor(s.store.bot(s.chief.id)!.threadId).filter((message) => message.setupSuggestion?.kind === "watch");
/** The card, then Turn it on: the routine the person said yes to. */
function turnOn(s: ReturnType<typeof setup>) {
  const card = s.proactive.ensureWatch()!;
  expect(s.proactive.answerWatch(s.chief.threadId, card, "on", owner)).toBe("kept");
  return s.routines().listRoutines().find((routine) => routine.name === WATCH_NAME)!;
}

describe("the Chief's watch, suggested", () => {
  it("is never made without a yes: one card in the Chief's chat, posted once, and no routine", () => {
    const s = setup();
    const card = s.proactive.ensureWatch();
    expect(card).toBeTruthy();
    expect(cards(s)).toMatchObject([{ id: card, text: WATCH_SUGGESTION_TEXT, setupSuggestion: { kind: "watch" } }]);
    expect(s.proactive.ensureWatch()).toBeNull();
    expect(s.make().ensureWatch()).toBeNull();
    expect(cards(s)).toHaveLength(1);
    expect(s.routines().listRoutines()).toEqual([]);
  });

  it("Turn it on makes the watch once, daily at 08:00, and as the server made it", () => {
    const s = setup();
    const watch = turnOn(s);
    expect(watch).toMatchObject({ name: WATCH_NAME, botId: s.chief.id, checks: ["calendar", "mail", "runs"], access: "read-and-draft", deliver: "brief", enabled: true,
      schedule: { type: "daily", time: "08:00", weekdays: [0, 1, 2, 3, 4, 5, 6] } });
    expect(watchAsMade(watch)).toBe(true);
    expect(cards(s)[0]!.setupSuggestion).toEqual({ kind: "watch", answer: "on" });
    expect(s.proactive.answerWatch(s.chief.threadId, cards(s)[0]!.id, "on", owner)).toBe("kept");
    expect(s.routines().listRoutines()).toHaveLength(1);
    s.routines().remove(watch.id);
    expect(s.make().ensureWatch()).toBeNull();
    expect(s.routines().listRoutines()).toEqual([]);
    expect(cards(s)).toHaveLength(1);
  });

  it("Not now is kept: no routine, and never asked again, after a restart too", () => {
    const s = setup();
    const card = s.proactive.ensureWatch()!;
    expect(s.proactive.answerWatch(s.chief.threadId, card, "notNow", owner)).toBe("kept");
    expect(cards(s)[0]!.setupSuggestion).toEqual({ kind: "watch", answer: "notNow" });
    expect(s.proactive.answerWatch(s.chief.threadId, card, "on", owner)).toBe("kept");
    expect(s.make().ensureWatch()).toBeNull();
    expect(cards(s)).toHaveLength(1);
    expect(s.routines().listRoutines()).toEqual([]);
  });

  it("only the owner answers, and only the card it posted", async () => {
    const s = setup();
    const card = s.proactive.ensureWatch()!;
    expect(s.proactive.answerWatch(s.chief.threadId, card, "on", guest)).toBe("refused");
    const other = s.store.appendMessage(s.chief.threadId, { role: "bot", kind: "text", text: "hello" });
    expect(s.proactive.answerWatch(s.chief.threadId, other.id, "on", owner)).toBe("unknown");
    const route = createWatchSuggestionRoutes({ answer: s.proactive.answerWatch });
    const answer = async (auth: RequestAuth, body: unknown) => {
      let status = 0;
      await route({ req: {} as never, res: {} as never, url: new URL("http://x/"), path: "/api/watch/suggestion", method: "POST", auth, json: (_res: unknown, code: number) => { status = code; }, readBody: async () => body } as never);
      return status;
    };
    expect(await answer(owner, { threadId: s.chief.threadId, messageId: card })).toBe(400);
    expect(await answer(guest, { threadId: s.chief.threadId, messageId: card, answer: "on" })).toBe(403);
    expect(await answer(owner, { threadId: s.chief.threadId, messageId: "nope", answer: "on" })).toBe(404);
    expect(s.routines().listRoutines()).toEqual([]);
    expect(await answer(owner, { threadId: s.chief.threadId, messageId: card, answer: "on" })).toBe(200);
    expect(s.routines().listRoutines().map((routine) => routine.name)).toEqual([WATCH_NAME]);
  });

  it("waits for connected apps and a quiet chat, then is suggested within a minute", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let configured = false;
    let busy = true;
    const s = setup({ configured: () => configured, busy: () => busy });
    expect(s.proactive.ensureWatch()).toBeNull();
    s.proactive.start();
    vi.advanceTimersByTime(60_000);
    configured = true;
    vi.advanceTimersByTime(60_000);
    expect(cards(s)).toEqual([]);
    busy = false;
    vi.advanceTimersByTime(60_000);
    s.proactive.stop();
    expect(cards(s)).toHaveLength(1);
    expect(s.routines().listRoutines()).toEqual([]);
  });

  it("is never suggested on a hosted team workspace or a Team Cloud", () => {
    const s = setup({ team: true });
    expect(s.proactive.ensureWatch()).toBeNull();
    expect(cards(s)).toEqual([]);
    expect(s.routines().listRoutines()).toEqual([]);
  });

  it("is not suggested when one arrived with the Chief, nor on an install that already made it", () => {
    const s = setup();
    s.routines().create({ name: "Moved watch", prompt: "Watch.", botId: s.chief.id, schedule: { type: "interval", everyMinutes: 15, anchorAt: Date.now() + 60_000 },
      checks: ["mail"], access: "read-and-draft", deliver: "brief" });
    expect(s.proactive.ensureWatch()).toBeNull();
    expect(cards(s)).toEqual([]);
    expect(s.routines().listRoutines()).toHaveLength(1);

    const made = setup();
    writeFileSync(join(made.dir, WATCH_FILE), JSON.stringify({ version: 1, routineId: "gone", createdAt: 1 }));
    expect(made.make().ensureWatch()).toBeNull();
    expect(cards(made)).toEqual([]);
    expect(made.routines().listRoutines()).toEqual([]);
  });

  it("leaves a 15-minute watch the server made earlier as it is, and still counts it as made", () => {
    const s = setup();
    const earlier = s.routines().create({ name: WATCH_NAME, prompt: WATCH_INSTRUCTIONS, botId: s.chief.id, enabled: true, timeoutMinutes: 15,
      schedule: { type: "interval", everyMinutes: 15, anchorAt: Date.now() + 60_000 }, checks: ["calendar", "mail", "runs"], access: "read-and-draft", deliver: "brief" });
    writeFileSync(join(s.dir, WATCH_FILE), JSON.stringify({ version: 1, routineId: earlier.id, createdAt: 1, handed: { [earlier.id]: s.chief.id } }));
    expect(s.make().ensureWatch()).toBeNull();
    expect(s.routines().listRoutines()).toEqual([earlier]);
    expect(watchAsMade(earlier)).toBe(true);
    expect(cards(s)).toEqual([]);
  });
});

describe("the watch's checks", () => {
  it("read nothing from an app the Chief may not use", async () => {
    const s = setup();
    const watch = turnOn(s);
    s.store.patchBot(s.chief.id, { connectorScopes: { apps: { googlecalendar: "read" } } });
    await s.proactive.checks.check(watch, { manual: true });
    expect(s.reads.some((slug) => slug.startsWith("GMAIL_"))).toBe(false);
    s.store.patchBot(s.chief.id, { composio: false, connectorScopes: undefined });
    s.reads.length = 0;
    await s.proactive.checks.check(watch, { manual: true });
    expect(s.reads).toEqual([]);
  });

  it("belong to the main agent only: a briefing routine of another bot reads nothing", async () => {
    const s = setup();
    const other = s.store.createBot({ name: "Scout" });
    const routine = s.routines().create({ name: "Scout brief", prompt: "Watch.", botId: other.id, schedule: { type: "interval", everyMinutes: 15, anchorAt: Date.now() + 60_000 },
      checks: ["mail"], deliver: "brief" });
    expect(await s.proactive.checks.check(routine, { manual: true })).toEqual({});
    expect(s.reads).toEqual([]);
  });
});

describe("the suggestion to add a helper-model key", () => {
  const suggested = async (options: { cloud?: boolean; team?: boolean }) => {
    const s = setup(options);
    const card = s.proactive.ensureWatch();
    if (card) s.proactive.answerWatch(s.chief.threadId, card, "on", owner);
    const watch = s.routines().listRoutines()[0] ?? { id: "none", botId: s.chief.id, deliver: "brief", checks: ["mail"] } as never;
    await s.proactive.checks.check(watch, { manual: true });
    return s.store.messagesFor(s.store.bot(s.chief.id)!.threadId).filter((message) => message.setupSuggestion?.kind === "helperKey");
  };

  it("is posted once on a desktop with Gmail connected and no helper model", async () => {
    expect(await suggested({ cloud: false })).toHaveLength(1);
  });

  it("is never posted on Cloud, nor on a hosted team workspace or a Team Cloud", async () => {
    expect(await suggested({ cloud: true })).toEqual([]);
    expect(await suggested({ cloud: false, team: true })).toEqual([]);
    expect(await suggested({})).toEqual([]);
  });
});
