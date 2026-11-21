import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ api: vi.fn(), runBotMove: vi.fn() }));
vi.mock("@/state/store", () => ({ api: f.api }));
vi.mock("./bot-move", () => ({
  movable: (plan: { apps: Array<{ preview: { plans: unknown[] } }> }) => plan.apps.reduce((n, app) => n + app.preview.plans.length, 0),
  runBotMove: f.runBotMove,
  planCounts: (app: { preview: { plans: Array<{ counts?: object }> } }) => ({ bots: app.preview.plans.length, skills: 0, routines: 0, memories: 0, facts: 0, ...app.preview.plans[0]?.counts }),
}));
import { setLocale } from "@/lib/i18n";
import type { SetupDetection } from "../../shared/setup-import";
import type { AppMove, BotMovePlan } from "./bot-move";
import { bringChosen, bringRunNow, knowsLine, localFinds, memorySource, resetBringRunForTests, sourceScore } from "./first-run-import";

const NOW = Date.parse("2026-11-15T12:00:00Z");
const DAY = 86_400_000;
const app = (name: string, bots: string[], where = "~/.openclaw"): AppMove => ({
  app: name, where, from: { name, key: name.toLowerCase() }, channels: [], unreadable: [],
  preview: { plans: bots.map((addedAs) => ({ addedAs })) as never, moved: [], unreadable: [] },
});
const plan = (...apps: AppMove[]): BotMovePlan => ({ apps, grokWaiting: [] });
const DETECTION: SetupDetection = {
  skills: [{ name: "pdf", source: "claudeCode" }, { name: "review", source: "claudeCode" }, { name: "lint", source: "codex" }],
  tools: [{ name: "notion", source: "cursor" }, { name: "github", source: "claudeCode" }],
  memory: [{ source: "claudeCode", files: 3, notes: 12 }],
  activity: { claudeCode: NOW - 2 * 3_600_000, codex: NOW - 3 * DAY, cursor: NOW - 90 * DAY, openclaw: NOW - 5 * DAY, hermes: NOW - DAY },
};

beforeEach(() => {
  setLocale("en");
  resetBringRunForTests();
  f.api.mockReset();
  f.runBotMove.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("the first run's list of what this Mac holds", () => {
  it("puts what is used lately and holds enough first, best first, and leaves thin or idle sources for Show more", () => {
    const finds = localFinds(plan(app("OpenClaw", ["Atlas", "Juno"])), DETECTION, { now: NOW });
    // nothing passes the bar here: all by score, the bots first (2 bots outweigh 12 notes, 2 skills and a tool)
    expect(finds.map((find) => [find.id, find.summary, find.strong])).toEqual([
      ["bots:openclaw", "2 bots", false],
      ["setup:claudeCode", "12 notes about you, 2 skills, and 1 tool", false],
      ["setup:codex", "1 skill", false],
      ["setup:cursor", "1 tool", false],
    ]);
    const busy = localFinds(plan(app("OpenClaw", ["Atlas", "Juno", "Mo"])), {
      ...DETECTION, skills: [...DETECTION.skills, ...Array.from({ length: 9 }, (_, i) => ({ name: `s${i}`, source: "codex" as const }))],
    }, { now: NOW });
    expect(busy.map((find) => [find.id, find.strong])).toEqual([["setup:codex", true], ["bots:openclaw", true], ["setup:claudeCode", false], ["setup:cursor", false]]);
  });

  it("counts a source as in use only within a month, and as worth it only above a little", () => {
    expect(sourceScore({ skills: 9 }, NOW - 10 * DAY, NOW).strong).toBe(true);
    expect(sourceScore({ skills: 9 }, NOW - 40 * DAY, NOW).strong).toBe(false);
    expect(sourceScore({ skills: 2, tools: 3 }, NOW, NOW).strong).toBe(false);
    expect(sourceScore({ skills: 9 }, null, NOW).strong).toBe(false);
    expect(sourceScore({ notes: 100 }, NOW, NOW).score).toBeGreaterThan(sourceScore({ notes: 100 }, NOW - 20 * DAY, NOW).score);
  });

  it("keeps a tool whose agents became bots to one find, dated by its own files, and leaves Grok Bot to its prompt", () => {
    const hermes = app("Hermes Agent", ["Hermes", "Coder"], "~/.hermes");
    (hermes.preview.plans[0] as unknown as { counts: object }).counts = { skills: 3, routines: 2, memories: 4, facts: 2 };
    const claude = app("Claude Code", ["Code Reviewer"], "~/.claude/agents");
    const grok = { ...app("Grok Bot", ["Desk"], "~/Downloads"), from: { name: "Grok Bot", key: "grok-bot" } };
    const finds = localFinds(plan(hermes, claude, grok), { ...DETECTION, memory: [{ source: "claudeCode", files: 3, notes: 40 }] }, { now: NOW });
    const claudeFind = finds.find((find) => find.id === "bots:claude code")!;
    expect(claudeFind).toMatchObject({ source: "claudeCode", summary: "40 notes about you, 1 bot, 2 skills, and 1 tool", lastUsed: NOW - 2 * 3_600_000, strong: true });
    expect(finds.find((find) => find.id === "bots:hermes agent")).toMatchObject({ summary: "6 notes about you, 2 bots, 3 skills, and 2 paused routines", lastUsed: NOW - DAY, strong: true });
    expect(finds.map((find) => find.id)).not.toContain("bots:grok-bot");
    expect(localFinds(plan(grok), DETECTION, { grokExports: true, now: NOW }).map((find) => find.id), "Settings, which may read Downloads, lists Grok bot's saved files")
      .toContain("bots:grok-bot");
  });

  it("offers one memory source: the app really used on 5 or more of the last 30 days that knows the person, most used first", () => {
    const topics = { preferences: true, aboutYou: true, workStyle: false, projects: 4 };
    const detection = {
      skills: [], tools: [],
      memory: [{ source: "claudeCode" as const, files: 9, notes: 40, topics }, { source: "codex" as const, files: 1, notes: 6 }, { source: "gemini" as const, files: 1, notes: 30 }],
      // Gemini knows a lot but was barely used; Hermes's files were touched today but it hasn't been talked to
      usage: { claudeCode: 31, codex: 22, gemini: 2 }, activity: { hermes: NOW, gemini: NOW },
    };
    const hermes = app("Hermes Agent", ["Hermes"], "~/.hermes");
    (hermes.preview.plans[0] as unknown as { counts: object }).counts = { memories: 25 };
    const finds = localFinds(plan(hermes), detection, { now: NOW });
    const source = memorySource(finds)!;
    expect(source.id).toBe("setup:claudeCode");
    expect(knowsLine(source)).toBe("It's learned your preferences, who you are, and 4 of your projects.");
    expect(memorySource(finds.filter((find) => find !== source))?.id, "Codex next: used, with a few notes").toBe("setup:codex");
    expect(memorySource(finds.filter((find) => find.id !== "setup:claudeCode" && find.id !== "setup:codex")), "nothing else is really used").toBeNull();
    expect(knowsLine(finds.find((find) => find.id === "bots:hermes agent")!)).toBe("It remembers 25 things about you.");
  });

  it("is empty when nothing is here, and leaves out an app whose bots are all here already", () => {
    expect(localFinds(plan(app("Hermes Agent", [])), { skills: [], tools: [] })).toEqual([]);
    expect(localFinds(null, null)).toEqual([]);
  });
});

describe("bringing the chosen in", () => {
  it("asks for only the chosen tools' things and their memory for the first bot, moves the bots, and says so in one line", async () => {
    const apply = vi.fn(async () => ({
      skills: { added: ["pdf", "review"], present: [], skipped: [], filesLeftOut: 0, review: [] },
      tools: { added: ["github"], present: [], skipped: [] },
      memory: { added: 12, sources: ["claudeCode" as const], failed: false },
    }));
    f.api.mockResolvedValue({ ok: true });
    f.runBotMove.mockResolvedValue([{ app: {}, report: { bots: [{ id: "a", memories: 0, notes: 0 }, { id: "b", memories: 0, notes: 0 }], moved: [], unreadable: [], failed: [] } }]);
    const finds = localFinds(plan(app("OpenClaw", ["Atlas", "Juno"])), DETECTION, { now: NOW }).filter((find) => find.id !== "setup:cursor" && find.id !== "setup:codex");
    const run = bringChosen(finds, { dispatch: vi.fn(), firstBotId: "madani", client: { detect: vi.fn(), apply }, memory: true });
    expect(bringRunNow()).toEqual({ kind: "working", ids: finds.map((find) => find.id), brought: [] });
    await run;
    expect(apply).toHaveBeenCalledExactlyOnceWith({ skills: true, tools: true, sources: ["claudeCode"], memory: true, memoryBot: "madani" });
    expect(f.runBotMove).toHaveBeenCalledOnce();
    expect(bringRunNow()).toEqual({ kind: "done", failed: false, line: "Your bots now know 12 things about you. Also brought in 2 bots, 2 skills, and 1 tool.", brought: finds.map((find) => find.id), known: 12 });
    await vi.waitFor(() => expect(f.api).toHaveBeenCalledWith("/api/bots/madani/import-note", expect.anything()));
    const note = JSON.parse(f.api.mock.calls.find(([path]) => path === "/api/bots/madani/import-note")![1].body);
    expect(note).toMatchObject({ from: ["OpenClaw", "Claude Code"], skills: 2, tools: 1, memories: 12, instructions: ["Claude Code"], failed: false });
  });

  it("records the bring card as seen once something came in, keeping the hints already saved", async () => {
    const apply = vi.fn(async () => ({
      skills: { added: [], present: [], skipped: [], filesLeftOut: 0, review: [] },
      tools: { added: [], present: [], skipped: [] },
      memory: { added: 50, sources: ["claudeCode" as const], failed: false },
    }));
    f.api.mockImplementation(async (path: string, init?: { method?: string; body?: string }) =>
      path === "/api/config" && !init ? { onboarding: { hintsSeen: ["met-chief"] } } : { ok: true });
    const dispatch = vi.fn();
    const claude = localFinds(null, DETECTION, { now: NOW }).find((find) => find.id === "setup:claudeCode")!;
    await bringChosen([claude], { dispatch, firstBotId: "madani", client: { detect: vi.fn(), apply } });
    await vi.waitFor(() => expect(f.api).toHaveBeenCalledWith("/api/config", expect.objectContaining({ method: "PUT" })));
    const put = f.api.mock.calls.find(([path, init]) => path === "/api/config" && init?.method === "PUT")!;
    expect(JSON.parse(put[1].body)).toEqual({ onboarding: { hintsSeen: ["met-chief", "bring-tools-v1"] } });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: "configStatus", config: { ok: true } }));
  });

  it("leaves the bring card due when nothing came in", async () => {
    const apply = vi.fn(async () => { throw new Error("offline"); });
    f.api.mockResolvedValue({ ok: true });
    const claude = localFinds(null, DETECTION, { now: NOW }).find((find) => find.id === "setup:claudeCode")!;
    await bringChosen([claude], { dispatch: vi.fn(), firstBotId: "madani", client: { detect: vi.fn(), apply } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.api.mock.calls.some(([path]) => path === "/api/config")).toBe(false);
  });

  it("names a failure and keeps what did come in", async () => {
    const apply = vi.fn(async () => { throw new Error("offline"); });
    f.runBotMove.mockResolvedValue([{ app: {}, report: { bots: [{ id: "a" }], moved: [], unreadable: [], failed: [] } }]);
    await bringChosen(localFinds(plan(app("OpenClaw", ["Atlas"])), DETECTION, { now: NOW }), { dispatch: vi.fn(), firstBotId: null, client: { detect: vi.fn(), apply } });
    expect(bringRunNow()).toMatchObject({ kind: "done", failed: true, line: "Brought in 1 bot. Some of it couldn't come in. Try again from settings → general → import." });
    expect(bringRunNow(), "a failed find stays one to import again").toMatchObject({ brought: [] });
  });

  it("brings one app in on its own Import, and remembers it alongside the next", async () => {
    const apply = vi.fn(async () => ({ skills: { added: ["pdf"], present: [], skipped: [], filesLeftOut: 0, review: [] }, tools: { added: [], present: [], skipped: [] } }));
    f.api.mockResolvedValue({ ok: true });
    f.runBotMove.mockResolvedValue([{ app: {}, report: { bots: [{ id: "a" }], moved: [], unreadable: [], failed: [] } }]);
    const finds = localFinds(plan(app("OpenClaw", ["Atlas"])), DETECTION, { now: NOW });
    const openclaw = finds.find((find) => find.id === "bots:openclaw")!;
    await bringChosen([openclaw], { dispatch: vi.fn(), firstBotId: null, client: { detect: vi.fn(), apply } });
    expect(apply, "only that app").not.toHaveBeenCalled();
    expect(bringRunNow()).toMatchObject({ kind: "done", brought: ["bots:openclaw"] });
    await bringChosen([finds[0]!], { dispatch: vi.fn(), firstBotId: null, client: { detect: vi.fn(), apply } });
    expect(bringRunNow()).toMatchObject({ kind: "done", brought: ["bots:openclaw", finds[0]!.id] });
  });
});

