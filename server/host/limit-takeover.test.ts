import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEvent } from "../../shared/runtime-events.ts";
import type { ModelSelection } from "../../shared/wire.ts";
import type { InstanceConfigMap } from "../contracts.ts";
import { PROVIDER_FAILURE_HOLD_MS } from "../drivers/provider-failover.ts";
import { LimitResetClock, UNNAMED_LIMIT_MS } from "../limit-resets.ts";
import { MODEL_HOLD_MS, SIGNED_OUT_RECHECK_MS, createLimitTakeover, signedOutStop, type LimitTakeoverDeps, type TakeoverEngine } from "./limit-takeover.ts";

const NOW = Date.parse("2026-10-27T10:00:00Z");
const HOUR = 3_600_000;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const TOOLS = { agentsMcp: true, customMcp: true, composioMcp: true } as unknown as TakeoverEngine["capabilities"];

function engine(instanceId: string, driverKind: string, models: string[], extra: Partial<TakeoverEngine> = {}): TakeoverEngine {
  return {
    instanceId, driverKind,
    snapshot: { state: "available", authenticated: true },
    models: { default: models[0]!, options: models.map((id) => ({ id, label: id })) },
    capabilities: TOOLS,
    ...extra,
  };
}

const CLAUDE = engine("claude", "claudeAgent", ["claude-opus-5-5", "claude-sonnet-5"]);
const CODEX = engine("codex", "codex", ["gpt-6", "gpt-6-mini"]);
const GO = engine("opencode", "opencode", ["go-default"]);
const NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode Go" };
const on = (instanceId: string, model: string): ModelSelection => ({ instanceId, model });
const KAI = { id: "kai", name: "Kai" };

const freshDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "madani-limit-takeover-"));
  dirs.push(dir);
  return dir;
};

/** `dir`: the data folder, the same one again for a restart. */
function takeover(overrides: Partial<LimitTakeoverDeps> = {}, dir = freshDir()) {
  const now = { at: NOW };
  const told: Array<{ bot: string; text: string }> = [];
  const record = vi.fn();
  const instance = createLimitTakeover({
    file: join(dir, "limit-notices.json"),
    holdsFile: join(dir, "limit-takeover-holds.json"),
    engines: () => [CLAUDE, CODEX, GO],
    configs: () => ({}),
    context: {},
    blockedUntil: () => null,
    chosen: () => [],
    engineName: (id) => NAMES[id] ?? id,
    tell: (bot, text) => { told.push({ bot: bot.name, text }); },
    record,
    now: () => now.at,
    ...overrides,
  });
  return { instance, told, record, now };
}

describe("which AI carries on while one is limited", () => {
  it("never picks an AI that bills each use by itself, only as a backup the person chose", () => {
    const apiClaude = engine("claude-api", "claudeAgent", ["claude-opus-5-5"], { access: "api" });
    const keyedClaude = engine("claude-key", "claudeAgent", ["claude-opus-5-5"]);
    const keyed = { "claude-key": { environment: { ANTHROPIC_API_KEY: "sk-ant-fixture" } } } as unknown as InstanceConfigMap;
    expect(takeover({ engines: () => [CODEX, apiClaude] }).instance.backups("kai", on("codex", "gpt-6"))).toEqual([]);
    expect(takeover({ engines: () => [CODEX, keyedClaude], configs: () => keyed }).instance.backups("kai", on("codex", "gpt-6"))).toEqual([]);
    expect(takeover({ engines: () => [CODEX, apiClaude, GO], chosen: () => [on("opencode", "go-default")] }).instance.backups("kai", on("codex", "gpt-6"))).toEqual([on("opencode", "go-default")]);
    expect(takeover({ engines: () => [CODEX, apiClaude], chosen: () => [on("claude-api", "claude-opus-5-5")] }).instance.backups("kai", on("codex", "gpt-6")))
      .toEqual([on("claude-api", "claude-opus-5-5")]);
  });

  it("takes only the backups the person chose, in their order, and never the limited AI", () => {
    const { instance } = takeover({ chosen: () => [on("opencode", "go-default"), on("codex", "gpt-6-mini"), on("claude", "claude-opus-5-5")] });
    expect(instance.backups("kai", on("codex", "gpt-6"))).toEqual([on("opencode", "go-default"), on("claude", "claude-opus-5-5")]);
  });

  it("moves no conversation to an AI the person did not choose, so with no backup chosen the turn waits for its own AI", () => {
    const { instance } = takeover();
    expect(instance.backups("kai", on("codex", "gpt-6"))).toEqual([]);
    expect(instance.backups("kai", on("claude", "claude-opus-5-5"), "engine", "full")).toEqual([]);
    expect(instance.heldAtStart(KAI, on("codex", "gpt-6")), "a new turn is tried on its own AI").toBeNull();
  });

  it("leaves an API key's rate limit with its own AI, whatever other AIs are signed in, unless the person chose a backup", () => {
    const keyed = engine("or", "openai-compat", ["deepseek/deepseek-chat"], { access: "api" });
    const other = engine("groq", "openai-compat", ["llama-4"], { access: "api" });
    const engines = () => [keyed, other, CLAUDE, CODEX, GO];
    expect(takeover({ engines }).instance.backups("kai", on("or", "deepseek/deepseek-chat"), "engine")).toEqual([]);
    expect(takeover({ engines, chosen: () => [on("groq", "llama-4")] }).instance.backups("kai", on("or", "deepseek/deepseek-chat"), "engine")).toEqual([on("groq", "llama-4")]);
  });

  it("for one model's own limit tries that AI's default model first, and never the limited model", () => {
    const { instance } = takeover({ chosen: () => [on("codex", "gpt-6")] });
    expect(instance.backups("kai", on("claude", "claude-sonnet-5"), "model")).toEqual([on("claude", "claude-opus-5-5"), on("codex", "gpt-6")]);
    expect(instance.backups("kai", on("claude", "claude-opus-5-5"), "credits")).toEqual([on("codex", "gpt-6")]);
    expect(takeover().instance.backups("kai", on("claude", "claude-sonnet-5"), "model"), "the same AI keeps its own session").toEqual([on("claude", "claude-opus-5-5")]);
  });

  it("leaves out an AI that is signed out, held by its own limit, short of this AI's tools, or another sign-in to the same plan", () => {
    const signedOut = engine("claude", "claudeAgent", ["claude-opus-5-5"], { snapshot: { state: "available", authenticated: false } });
    const both = () => [on("claude", "claude-opus-5-5"), on("opencode", "go-default")];
    expect(takeover({ engines: () => [signedOut, CODEX], chosen: both }).instance.backups("kai", on("codex", "gpt-6"))).toEqual([]);
    expect(takeover({ blockedUntil: (id) => (id === "claude" ? NOW + HOUR : null), chosen: both }).instance.backups("kai", on("codex", "gpt-6")))
      .toEqual([on("opencode", "go-default")]);
    const fewerTools = engine("claude", "claudeAgent", ["claude-opus-5-5"], { capabilities: { agentsMcp: true } as unknown as TakeoverEngine["capabilities"] });
    expect(takeover({ engines: () => [fewerTools, CODEX], chosen: both }).instance.backups("kai", on("codex", "gpt-6"))).toEqual([]);
    const secondCodex = engine("codex-2", "codex", ["gpt-6"]);
    expect(takeover({ engines: () => [CODEX, secondCodex], chosen: () => [on("codex-2", "gpt-6")] }).instance.backups("kai", on("codex", "gpt-6")),
      "never another sign-in to the same plan").toEqual([]);
    const keyed = { "codex-2": { environment: { OPENAI_API_KEY: "sk-test" } } } as unknown as InstanceConfigMap;
    expect(takeover({ engines: () => [CODEX, secondCodex], configs: () => keyed, chosen: () => [on("codex-2", "gpt-6")] }).instance.backups("kai", on("codex", "gpt-6")),
      "a pay-per-use key on the same AI is fine as a backup the person chose").toEqual([on("codex-2", "gpt-6")]);
  });

  it("has none for an AI it doesn't know", () => {
    expect(takeover().instance.backups("kai", on("gone", "m"))).toEqual([]);
  });
});

describe("a model's own limit", () => {
  const error = (limit: "model" | "credits" | "engine", limitResetsAt?: number) => ({
    eventId: "e", provider: "claudeAgent", createdAt: new Date(NOW).toISOString(), threadId: "t1",
    type: "runtime.error", message: "limit", limit, ...(limitResetsAt ? { limitResetsAt } : {}),
  }) as RuntimeEvent;

  it("holds that model alone until the reset it named, at most six hours, an hour when it named none, and not once it works", () => {
    const { instance, now } = takeover({ chosen: () => [on("claude", "claude-opus-5-5"), on("opencode", "go-default")] });
    instance.noteRuntimeEvent("kai", on("claude", "claude-opus-5-5"), error("model", NOW + 2 * HOUR));
    expect(instance.modelHeld(on("claude", "claude-opus-5-5"))).toEqual({ until: NOW + 2 * HOUR, resetsAt: NOW + 2 * HOUR, scope: "model" });
    expect(instance.modelHeld(on("claude", "claude-sonnet-5")), "the AI's other models still work").toBeNull();
    instance.noteRuntimeEvent("kai", on("claude", "claude-opus-5-5"), error("model", NOW + 50 * HOUR));
    expect(instance.modelHeld(on("claude", "claude-opus-5-5")), "tried again after six hours, the named reset kept")
      .toEqual({ until: NOW + MODEL_HOLD_MS, resetsAt: NOW + 50 * HOUR, scope: "model" });
    instance.holdModel(on("claude", "claude-sonnet-5"), "credits");
    expect(instance.modelHeld(on("claude", "claude-sonnet-5"))).toEqual({ until: NOW + UNNAMED_LIMIT_MS, scope: "credits" });
    instance.noteRuntimeEvent("kai", on("codex", "gpt-6"), error("engine"));
    expect(instance.modelHeld(on("codex", "gpt-6")), "an engine's own limit is the reset clock's to hold").toBeNull();
    expect(instance.backups("kai", on("codex", "gpt-6")), "a held model carries on nothing").toEqual([on("opencode", "go-default")]);

    instance.worked("kai", on("claude", "claude-opus-5-5"));
    expect(instance.modelHeld(on("claude", "claude-opus-5-5"))).toBeNull();
    now.at = NOW + UNNAMED_LIMIT_MS + 1;
    expect(instance.modelHeld(on("claude", "claude-sonnet-5"))).toBeNull();
  });
});

describe("what the person hears", () => {
  it("says once per bot for each stretch of a limit what carries on, and again once a turn on that AI worked", () => {
    const { instance, told } = takeover();
    const resetsAt = NOW + 4 * HOUR;
    instance.tell(KAI, on("codex", "gpt-6"), { resetsAt, scope: "engine", backup: on("claude", "claude-opus-5-5") });
    instance.tell(KAI, on("codex", "gpt-6"), { resetsAt, scope: "engine", backup: on("claude", "claude-opus-5-5") });
    instance.tell({ id: "rosa", name: "Rosa" }, on("codex", "gpt-6"), { resetsAt });
    expect(told.map((entry) => entry.bot)).toEqual(["Kai", "Rosa"]);
    expect(told[0]!.text).toMatch(/^Codex reached its limit until .+, so Kai is using Claude meanwhile\.$/);
    expect(told[1]!.text).toMatch(/^Codex reached its limit until .+, so Rosa waits until then: no other AI you have set up can take over\.$/);
    instance.worked("kai", on("codex", "gpt-6"));
    instance.tell(KAI, on("codex", "gpt-6"), { resetsAt, backup: on("claude", "claude-opus-5-5") });
    expect(told).toHaveLength(3);
  });

  it("names the model for a model's own limit, and the same AI's other model when that carries on", () => {
    const { instance, told } = takeover();
    instance.tell(KAI, on("claude", "claude-sonnet-5"), { scope: "credits", backup: on("claude", "claude-opus-5-5") });
    instance.tell(KAI, on("claude", "claude-opus-5-5"), { scope: "model", backup: on("codex", "gpt-6") });
    expect(told.map((entry) => entry.text)).toEqual([
      "Claude claude-sonnet-5's extra usage credits are used up, so Kai is using Claude claude-opus-5-5 meanwhile.",
      "Claude claude-opus-5-5 reached its limit, so Kai is using Codex meanwhile.",
    ]);
  });

  it("files one incident per bot for each stretch of a limit, apart from the person's notice", () => {
    const { instance, told } = takeover();
    const resetsAt = NOW + 4 * HOUR;
    instance.tell(KAI, on("codex", "gpt-6"), { resetsAt });
    expect(instance.firstIncident("kai", on("codex", "gpt-6"), "engine", resetsAt), "the notice is not the incident").toBe(true);
    expect(instance.firstIncident("kai", on("codex", "gpt-6"), "engine", resetsAt)).toBe(false);
    expect(instance.firstIncident("rosa", on("codex", "gpt-6"), "engine", resetsAt)).toBe(true);
    expect(instance.firstIncident("kai", on("claude", "claude-opus-5-5"), "model"), "another limit is another stretch").toBe(true);
    instance.worked("kai", on("codex", "gpt-6"));
    expect(instance.firstIncident("kai", on("codex", "gpt-6"), "engine", resetsAt), "a new stretch once it worked").toBe(true);
    expect(told).toHaveLength(1);
  });

  it("records a conversation that moved, so it goes back once the limit resets", () => {
    const { instance, record } = takeover();
    instance.moved("kai", "t1", on("codex", "gpt-6"), on("claude", "claude-opus-5-5"), NOW + HOUR);
    instance.moved("kai", "t2", on("codex", "gpt-6"), on("claude", "claude-opus-5-5"));
    expect(record.mock.calls.map(([failover]) => failover)).toEqual([
      { botId: "kai", threadId: "t1", from: on("codex", "gpt-6"), to: on("claude", "claude-opus-5-5"), resetsAt: NOW + HOUR, at: NOW },
      { botId: "kai", threadId: "t2", from: on("codex", "gpt-6"), to: on("claude", "claude-opus-5-5"), resetsAt: null, at: NOW },
    ]);
  });
});

describe("a new conversation once an AI is known to be at its limit", () => {
  const event = (threadId: string, type: string, extra: Record<string, unknown> = {}) =>
    ({ eventId: "e", provider: "claudeAgent", createdAt: new Date(NOW).toISOString(), threadId, type, ...extra }) as RuntimeEvent;
  /** The reset clock and the takeover as the server wires them, on one data folder: `boot` again is a restart. */
  function server() {
    const dir = freshDir();
    const at = { now: NOW };
    const boot = () => {
      const clock = new LimitResetClock({ accounts: () => [], now: () => at.now, file: join(dir, "limit-holds.json") });
      const { instance, told } = takeover({ blockedUntil: (id) => clock.blockedUntil(id), resetAt: (id) => clock.resetAt(id), now: () => at.now, chosen: () => [on("codex", "gpt-6")] }, dir);
      return { clock, instance, told };
    };
    return { at, boot };
  }
  /** A turn on Claude that its usage limit refused. */
  const refused = (clock: LimitResetClock, threadId: string, limitResetsAt?: number) => {
    clock.noteRuntimeEvent("claude", event(threadId, "turn.started"));
    clock.noteRuntimeEvent(undefined, event(threadId, "runtime.error", { message: "limit", limit: "engine", ...(limitResetsAt ? { limitResetsAt } : {}) }));
    clock.noteRuntimeEvent(undefined, event(threadId, "turn.completed", { ok: false, stopReason: "quota" }));
  };
  const ROSA = { id: "rosa", name: "Rosa" };

  it("starts every bot's next conversation on the AI that carries on, a restart included, until the limit resets", () => {
    const { at, boot } = server();
    const first = boot();
    refused(first.clock, "t1", NOW + 5 * HOUR);
    expect(first.instance.heldAtStart(KAI, on("claude", "claude-opus-5-5"))).toEqual({ scope: "engine", resetsAt: NOW + 5 * HOUR });
    expect(first.instance.heldAtStart(ROSA, on("claude", "claude-sonnet-5")), "every bot that uses it").toEqual({ scope: "engine", resetsAt: NOW + 5 * HOUR });

    at.now = NOW + 20 * 60_000;
    const restarted = boot();
    expect(restarted.clock.blockedUntil("claude"), "a restart, or a sleep the Cloud was stopped for, still knows the limit").toBe(NOW + 5 * HOUR);
    expect(restarted.instance.heldAtStart(KAI, on("claude", "claude-opus-5-5"))).toEqual({ scope: "engine", resetsAt: NOW + 5 * HOUR });
    expect(restarted.instance.backups("kai", on("claude", "claude-opus-5-5"))).toEqual([on("codex", "gpt-6")]);

    at.now = NOW + 5 * HOUR + 1;
    expect(restarted.instance.heldAtStart(KAI, on("claude", "claude-opus-5-5")), "back on its own AI once the limit resets").toBeNull();
  });

  it("with no reset named, or one already past, holds the AI until it is checked again an hour after its last refusal", () => {
    const { at, boot } = server();
    const { clock, instance } = boot();
    refused(clock, "t1", NOW - 60_000);
    expect(instance.heldAtStart(KAI, on("claude", "claude-opus-5-5"))).toEqual({ scope: "engine" });
    at.now = NOW + UNNAMED_LIMIT_MS - 1;
    expect(boot().instance.heldAtStart(KAI, on("claude", "claude-opus-5-5"))).toEqual({ scope: "engine" });
    at.now = NOW + UNNAMED_LIMIT_MS + 1;
    expect(boot().instance.heldAtStart(KAI, on("claude", "claude-opus-5-5")), "the next turn checks it again").toBeNull();
  });

  it("goes to no AI the thread's approval level can't move to by itself, and then tries its own AI as usual", () => {
    const { boot } = server();
    const { clock, instance } = boot();
    refused(clock, "t1", NOW + 5 * HOUR);
    expect(instance.backups("kai", on("claude", "claude-opus-5-5"), "engine", "edits")).toEqual([]);
    expect(instance.heldAtStart({ ...KAI, approvalMode: "edits" }, on("claude", "claude-opus-5-5"))).toBeNull();
    expect(instance.heldAtStart({ ...KAI, approvalMode: "full" }, on("claude", "claude-opus-5-5"))).toEqual({ scope: "engine", resetsAt: NOW + 5 * HOUR });
  });

  it("is off with the quota switch, unless Automatic recovery has backups of its own for a limit", () => {
    const { boot } = server();
    const { clock } = boot();
    refused(clock, "t1", NOW + 5 * HOUR);
    const off = takeover({ blockedUntil: (id) => clock.blockedUntil(id), enabled: () => false }).instance;
    expect(off.heldAtStart(KAI, on("claude", "claude-opus-5-5"))).toBeNull();
    expect(off.heldAtStart(KAI, on("claude", "claude-opus-5-5"), true)).toEqual({ scope: "engine" });
  });

  it("keeps one model's own limit through a restart, and a turn that works on another model leaves it held", () => {
    const dir = freshDir();
    const { instance } = takeover({}, dir);
    instance.noteRuntimeEvent("kai", on("claude", "claude-opus-5-5"), event("t1", "runtime.error", { message: "limit", limit: "model", limitResetsAt: NOW + 2 * HOUR }));
    instance.noteRuntimeEvent("kai", on("claude", "claude-sonnet-5"), event("t2", "turn.completed", { ok: true }));
    const restarted = takeover({ engines: () => [engine("claude", "claudeAgent", ["claude-sonnet-5", "claude-opus-5-5"]), CODEX] }, dir).instance;
    expect(restarted.modelHeld(on("claude", "claude-opus-5-5"))).toEqual({ until: NOW + 2 * HOUR, resetsAt: NOW + 2 * HOUR, scope: "model" });
    expect(restarted.heldAtStart(KAI, on("claude", "claude-opus-5-5"))).toEqual({ scope: "model", resetsAt: NOW + 2 * HOUR });
  });

  it("says once per bot what carries on in a conversation that moved at its start, and records it to go back", () => {
    const { instance, told, record } = takeover({ chosen: () => [on("codex", "gpt-6")] });
    expect(instance.carriedOn(KAI, "t1", on("claude", "claude-opus-5-5"), on("codex", "gpt-6"), { scope: "engine", resetsAt: NOW + HOUR }))
      .toEqual([{ name: expect.stringMatching(/^recovery: Claude hit its limit \(resets .+\), so Codex took over\.$/), ok: true }]);
    expect(instance.carriedOn(KAI, "t2", on("claude", "claude-opus-5-5"), on("codex", "gpt-6"), { scope: "engine", resetsAt: NOW + HOUR })).toHaveLength(1);
    expect(told).toHaveLength(1);
    expect(record.mock.calls.map(([failover]) => failover.threadId)).toEqual(["t1", "t2"]);
  });
});

describe("an AI that is signed out", () => {
  const event = (type: string, extra: Record<string, unknown> = {}) =>
    ({ eventId: "e", provider: "claudeAgent", createdAt: new Date(NOW).toISOString(), threadId: "t1", type, ...extra }) as RuntimeEvent;
  const CLAUDE_ON = on("claude", "claude-opus-5-5");
  /** A turn on Claude that stopped because Claude is signed out, as Claude Code says it. */
  const signedOut = (instance: ReturnType<typeof takeover>["instance"], said = "Invalid API key · Please run /login") => {
    instance.noteRuntimeEvent("kai", CLAUDE_ON, event("runtime.error", { message: said, setup: true }));
    instance.noteRuntimeEvent("kai", CLAUDE_ON, event("turn.completed", { ok: false, stopReason: "auth_required" }));
  };

  it("sends new turns to a backup the person chose, says it once with the way to sign in, and goes back once signed in", () => {
    const { instance, told, record } = takeover({ chosen: () => [on("codex", "gpt-6")], where: "on the Cloud" });
    signedOut(instance);
    expect(instance.heldAtStart(KAI, CLAUDE_ON)).toEqual({ scope: "signed-out" });
    expect(instance.backups("kai", CLAUDE_ON, "signed-out")).toEqual([on("codex", "gpt-6")]);
    expect(instance.tell(KAI, CLAUDE_ON, { scope: "signed-out" })).toBe("Claude is signed out on the Cloud. Sign in again in Settings → AI to keep using it.");
    expect(instance.tell(KAI, CLAUDE_ON, { scope: "signed-out", backup: on("codex", "gpt-6") }), "once, not once a turn").toBeNull();
    signedOut(instance);
    expect(instance.carriedOn(KAI, "t2", CLAUDE_ON, on("codex", "gpt-6"), { scope: "signed-out" }))
      .toEqual([{ name: "recovery: Claude is signed out, so Codex took over.", ok: true }]);
    expect(told.map((entry) => entry.text)).toEqual(["Claude is signed out on the Cloud. Sign in again in Settings → AI to keep using it."]);
    expect(record.mock.calls.at(-1)![0]).toMatchObject({ threadId: "t2", why: "signed-out", resetsAt: null });

    instance.signedIn("claude");
    expect(instance.heldAtStart(KAI, CLAUDE_ON)).toBeNull();
    expect(instance.stillSignedOut("claude")).toBe(false);
    signedOut(instance);
    expect(instance.carriedOn(KAI, "t3", CLAUDE_ON, on("codex", "gpt-6"), { scope: "signed-out" }), "a new sign-out is told again").toEqual([
      { name: "recovery: Claude is signed out, so Codex took over.", ok: true },
      { name: "notice: Claude is signed out on the Cloud, so Kai is using Codex meanwhile. Sign in again in Settings → AI to keep using Claude.", ok: true, setup: true },
    ]);
  });

  it("picks no AI by itself for it, so with no backup chosen the AI is tried as usual", () => {
    const { instance } = takeover();
    signedOut(instance);
    expect(instance.backups("kai", CLAUDE_ON, "signed-out")).toEqual([]);
    expect(instance.heldAtStart(KAI, CLAUDE_ON)).toBeNull();
  });

  it("lets another sign-in to the same AI stand in when the person chose it, never a signed-out one", () => {
    const work = engine("claude-work", "claudeAgent", ["claude-opus-5-5"]);
    const { instance } = takeover({ engines: () => [CLAUDE, work, CODEX], chosen: () => [on("claude-work", "claude-opus-5-5"), on("codex", "gpt-6")] });
    signedOut(instance);
    expect(instance.backups("kai", CLAUDE_ON, "signed-out")).toEqual([on("claude-work", "claude-opus-5-5"), on("codex", "gpt-6")]);
    expect(instance.backups("kai", on("codex", "gpt-6")), "and no limit's backup is an AI known to be signed out").not.toContainEqual(on("claude", "claude-opus-5-5"));
  });

  it("is tried again by a new turn an hour on, unless its status still says signed out; a turn that works ends it", () => {
    let status = false;
    const { instance, now } = takeover({ chosen: () => [on("codex", "gpt-6")], signedOutNow: () => status });
    signedOut(instance);
    now.at = NOW + SIGNED_OUT_RECHECK_MS + 1;
    expect(instance.heldAtStart(KAI, CLAUDE_ON)).toBeNull();
    expect(instance.stillSignedOut("claude"), "a conversation that moved still waits for it").toBe(true);
    status = true;
    expect(instance.heldAtStart(KAI, CLAUDE_ON)).toEqual({ scope: "signed-out" });
    instance.noteRuntimeEvent("rosa", CLAUDE_ON, event("turn.completed", { ok: true }));
    expect(instance.stillSignedOut("claude")).toBe(false);
  });

  it("remembers a sign-out through a restart", () => {
    const dir = freshDir();
    signedOut(takeover({}, dir).instance);
    expect(takeover({ chosen: () => [on("codex", "gpt-6")] }, dir).instance.heldAtStart(KAI, CLAUDE_ON)).toEqual({ scope: "signed-out" });
  });

  it("an account out of credit is no sign-out, even when its AI stops the turn as one", () => {
    const { instance } = takeover({ chosen: () => [on("codex", "gpt-6")] });
    signedOut(instance, "Your Grok account is out of credits. Add credits with Grok, then run it again.");
    expect(instance.stillSignedOut("claude")).toBe(false);
    expect(signedOutStop("auth_required", "Grok is not signed in to your grok.com account")).toBe(true);
    expect(signedOutStop("auth_required", undefined)).toBe(true);
    expect(signedOutStop("auth_required", "Your xAI subscription is inactive")).toBe(false);
    expect(signedOutStop("quota", "Not logged in · Please run /login")).toBe(false);
  });

  it("files one incident a sign-out, and another once it was signed in again", () => {
    const { instance } = takeover();
    signedOut(instance);
    expect(instance.firstIncident("kai", CLAUDE_ON, "signed-out")).toBe(true);
    expect(instance.firstIncident("kai", CLAUDE_ON, "signed-out")).toBe(false);
    instance.signedIn("claude");
    expect(instance.firstIncident("kai", CLAUDE_ON, "signed-out")).toBe(true);
  });
});

it("sends a signed-out AI's turns only to the backups a turn its AI never started would get", () => {
  const event = (type: string, extra: Record<string, unknown> = {}) =>
    ({ eventId: "e", provider: "claudeAgent", createdAt: new Date(NOW).toISOString(), threadId: "t1", type, ...extra }) as RuntimeEvent;
  let startup: ModelSelection[] = [];
  const { instance } = takeover({ chosen: () => [on("codex", "gpt-6"), on("opencode", "go-default")], signedOutChosen: () => startup });
  instance.noteRuntimeEvent("kai", on("claude", "claude-opus-5-5"), event("turn.completed", { ok: false, stopReason: "auth_required" }));
  expect(instance.backups("kai", on("claude", "claude-opus-5-5"), "signed-out"), "Automatic recovery off and no list of the bot's own").toEqual([]);
  expect(instance.heldAtStart(KAI, on("claude", "claude-opus-5-5"))).toBeNull();
  expect(instance.backups("kai", on("codex", "gpt-6")), "a usage limit's backups stay its own").toEqual([on("opencode", "go-default")]);
  startup = [on("codex", "gpt-6")];
  expect(instance.heldAtStart(KAI, on("claude", "claude-opus-5-5"))).toEqual({ scope: "signed-out" });
});

describe("a model whose provider failed a turn before it did anything", () => {
  const OPUS = on("claude", "claude-opus-5-5");

  it("is skipped by every new turn for ten minutes, and only for a backup the person chose", () => {
    const { instance, now } = takeover({ chosen: () => [on("codex", "gpt-6"), on("claude", "claude-opus-5-5"), on("opencode", "go-default")] });
    expect(instance.holdProvider(OPUS)).toBe(NOW + PROVIDER_FAILURE_HOLD_MS);
    expect(instance.heldAtStart(KAI, OPUS)).toEqual({ scope: "provider", resetsAt: NOW + PROVIDER_FAILURE_HOLD_MS });
    expect(instance.heldAtStart(KAI, on("claude", "claude-sonnet-5")), "only that model").toBeNull();
    expect(instance.backups("kai", OPUS, "provider")).toEqual([on("codex", "gpt-6"), on("opencode", "go-default")]);
    expect(instance.backups("kai", on("codex", "gpt-6"), "engine"), "nor does a limit move to it").toEqual([on("opencode", "go-default")]);
    now.at += PROVIDER_FAILURE_HOLD_MS;
    expect(instance.heldAtStart(KAI, OPUS)).toBeNull();
  });

  it("never reaches the installation backup while Automatic recovery is off", () => {
    // chosen still lists the saved installation backup; the startup list leaves it out while recovery is off
    let startup: ModelSelection[] = [];
    const { instance } = takeover({ chosen: () => [on("codex", "gpt-6")], signedOutChosen: () => startup });
    instance.holdProvider(OPUS);
    expect(instance.backups("kai", OPUS, "provider")).toEqual([]);
    startup = [on("codex", "gpt-6")];
    expect(instance.backups("kai", OPUS, "provider")).toEqual([on("codex", "gpt-6")]);
  });

  it("carries no turn when the person chose no backup", () => {
    const { instance } = takeover();
    instance.holdProvider(OPUS);
    expect(instance.backups("kai", OPUS, "provider")).toEqual([]);
    expect(instance.heldAtStart(KAI, OPUS)).toBeNull();
  });

  it("is told only in the conversation, and a turn on it that works ends the hold", () => {
    const { instance, told, record } = takeover({ chosen: () => [on("codex", "gpt-6")] });
    const until = instance.holdProvider(OPUS);
    expect(instance.carriedOn(KAI, "t1", OPUS, on("codex", "gpt-6"), { scope: "provider", resetsAt: until }))
      .toEqual([{ name: "recovery: Claude claude-opus-5-5 did not answer, so Codex took over.", ok: true }]);
    expect(told).toEqual([]);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ why: "provider", resetsAt: until }));
    instance.worked("kai", OPUS);
    expect(instance.heldAtStart(KAI, OPUS)).toBeNull();
  });
});

describe("the bot's choice at a limit", () => {
  const FREE = engine("zen", "opencodeGo", ["big-pickle"], { snapshot: { state: "available", authenticated: true, freeFallback: true } as TakeoverEngine["snapshot"] });

  it("waits by default: the free model never carries on by itself, while a backup the person chose still does", () => {
    expect(takeover({ engines: () => [CLAUDE, FREE] }).instance.backups("kai", on("claude", "claude-opus-5-5"))).toEqual([]);
    expect(takeover({ engines: () => [CLAUDE, FREE], limitMode: () => "ask" }).instance.backups("kai", on("claude", "claude-opus-5-5"))).toEqual([]);
    expect(takeover({ engines: () => [CLAUDE, FREE], chosen: () => [on("zen", "big-pickle")] }).instance.backups("kai", on("claude", "claude-opus-5-5")))
      .toEqual([on("zen", "big-pickle")]);
  });

  it("set to the free model: it comes right after the chosen backups, and no other AI comes by itself", () => {
    const { instance } = takeover({ engines: () => [CLAUDE, CODEX, FREE], limitMode: () => "free" });
    expect(instance.backups("kai", on("claude", "claude-opus-5-5"))).toEqual([on("zen", "big-pickle")]);
    expect(instance.freeSelection(on("claude", "claude-opus-5-5"))).toEqual(on("zen", "big-pickle"));
    expect(takeover({ engines: () => [CLAUDE, CODEX] }).instance.freeSelection(on("claude", "claude-opus-5-5"))).toBeNull();
  });
});
