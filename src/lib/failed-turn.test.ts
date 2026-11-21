import { describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";

vi.hoisted(() => vi.stubGlobal("window", {}));
const { activityPreview, botEngine, failedTurnCause, signedOutEngine } = await import("./failed-turn");

const engine = (patch: Partial<InstanceInfo> = {}, snapshot: Partial<InstanceInfo["snapshot"]> = {}): InstanceInfo => ({
  instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude",
  install: { command: { darwin: "x", linux: "x", win32: "x" }, signInCommand: "claude /login", server: { package: "@anthropic-ai/claude-code" } },
  authentication: { method: "paste-code" },
  models: { default: "sonnet", options: [] },
  ...patch,
  snapshot: { state: "available", authenticated: false, ...snapshot },
} as InstanceInfo);
const loginRow = { name: "error: Not logged in · Please run /login", ok: false, setup: true };

describe("failed turn text", () => {
  it("reads the engine's words out of the row, and nothing out of any other row", () => {
    expect(failedTurnCause("error: Not logged in · Please run /login")).toBe("Not logged in · Please run /login");
    expect(failedTurnCause("Bash")).toBeNull();
    expect(failedTurnCause("notice: retrying")).toBeNull();
  });

  it("says a signed-out engine is signed out instead of the CLI's /login instruction", () => {
    const claude = engine();
    expect(signedOutEngine(loginRow, claude)).toBe(claude);
    // a list shows the failure card's own line (errors read as one plain sentence, the raw cause stays in the logs)
    expect(activityPreview(loginRow, engine())).toBe("Claude isn't signed in on this computer. Sign in to keep going.");
  });

  it("previews a turn the room stopped for making no progress in plain words", () => {
    expect(activityPreview({ name: "error: Rivet's room turn made no progress for 1 minute and was stopped", ok: false, reason: "timeout" }, engine()))
      .toBe("Your AI took too long to answer. Try again.");
  });

  it("says Grok Build is signed out through the same rule, now that its card is the in-app code", () => {
    const grokRow = { name: "error: Grok is not signed in to your grok.com account: choose Sign in to Grok in engine setup", ok: false, setup: true };
    const grok = engine({
      instanceId: "grok", driverKind: "grokAgent", displayName: "Grok", authentication: { method: "device-code" },
      install: { command: { darwin: "curl -fsSL https://x.ai/cli/install.sh | bash", linux: "curl -fsSL https://x.ai/cli/install.sh | bash" }, signInCommand: "grok login" },
    } as Partial<InstanceInfo>);
    expect(signedOutEngine(grokRow, grok)).toBe(grok);
    expect(activityPreview(grokRow, grok)).toBe("Grok isn't signed in on this computer. Sign in to keep going.");
    const missing = { ...grok, snapshot: { state: "unavailable" as const, reason: "`grok` CLI not found" } };
    expect(signedOutEngine(grokRow, missing)).toBeUndefined();
  });

  it("previews a failure with no sign-in to offer by its card's plain line, not the engine's words", () => {
    expect(activityPreview(loginRow, engine({}, { authenticated: true }))).toBe("Not logged in · Please run /login");
    const keyed = engine({ driverKind: "opencode", access: "api" } as Partial<InstanceInfo>, { version: "1" });
    expect(activityPreview({ ...loginRow, name: "error: Add your key in Settings → API keys" }, keyed)).toBe("Add your key in Settings → API keys");
    expect(signedOutEngine(loginRow, keyed)).toBeUndefined();
    expect(activityPreview({ name: "error: rate limited", ok: false }, engine())).toBe("Your AI is getting too many requests. Try again in a moment.");
    expect(activityPreview(loginRow, undefined)).toBe("Your AI isn't signed in on this computer. Sign in to keep going.");
    expect(activityPreview({ ...loginRow, name: "error: needs a newer Claude Code", claudeUpdate: true }, engine())).toBe("This model needs a newer Claude Code. I can update Claude for you.");
    expect(signedOutEngine({ ...loginRow, claudeUpdate: true }, engine({ readOnly: true }))).toBeUndefined();
  });

  it("previews a plan-limit refusal whole and leaves ordinary steps alone", () => {
    const limit = "Your Pro plan includes 2 cloud computers at once. Delete one to start another.";
    expect(activityPreview({ name: `error: ${limit}`, ok: false }, engine())).toBe(limit);
    expect(activityPreview({ name: "Bash", ok: true }, engine())).toBe("Run a command");
    expect(activityPreview({ name: "stopped: stopped", ok: true }, engine())).toBe("Stopped");
    expect(activityPreview({ name: "error: The request was cancelled by the client.", ok: false }, engine())).toBe("Stopped");
  });

  it("previews a tool step in plain words and a status row without its marker", () => {
    expect(activityPreview({ name: "mcp__madani__computer_batch", ok: true }, engine())).toBe("Use the screen");
    expect(activityPreview({ name: "GITHUB_GET_A_COMMIT", ok: true }, engine())).toBe("Get a commit");
    expect(activityPreview({ name: "notice: this thread now uses Sonnet.", ok: true }, engine())).toBe("this thread now uses Sonnet.");
    expect(activityPreview({ name: "recovery: automatic recovery: trying Codex once.", ok: true }, engine())).toBe("automatic recovery: trying Codex once.");
    expect(activityPreview({ name: "Messaged @Ada" }, engine())).toBe("Messaged @Ada");
  });

  it("previews a Data result by its title", () => {
    const tool = { name: "mcp__madani__computer_batch", ok: true };
    const dataResult = { botId: "bot", cardId: "result", title: "Revenue", kind: "chart" as const };
    expect(activityPreview(tool, engine(), dataResult)).toBe("Revenue");
  });

  it("previews a chat whose AI session is gone by the card's line, never the session id", () => {
    expect(activityPreview({ name: "error: No conversation found with session ID: e8b9f01e-97e3-4be6-a55c-be988595628a", ok: false }, engine()))
      .toBe("Your AI lost this chat's memory. Start a new chat to keep going.");
  });

  it("previews a technical cause as its plain line", () => {
    expect(activityPreview({ name: 'error: API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}', ok: false }, engine()))
      .toBe("Your AI is busy right now. Try again in a moment.");
  });

  it("finds the engine a bot's turns ran on", () => {
    const claude = engine();
    const bot = { modelSelection: { instanceId: "claude", model: "sonnet" } } as Bot;
    expect(botEngine(bot, [claude])).toBe(claude);
    expect(botEngine(undefined, [claude])).toBeUndefined();
  });
});
