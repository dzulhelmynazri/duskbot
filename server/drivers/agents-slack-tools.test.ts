import { describe, expect, it, vi } from "vitest";
import { agentsServerEnv, type AgentsConversation } from "../agents-turn.ts";
import { bridgedCallName } from "../agents-bridge-names.ts";
import { callTool, type ToolCallContext } from "./agents-call.ts";
import { availableTools, catalogProfileFromEnv } from "./agents-catalog.ts";
import { AGENTS_MCP_ENV } from "./agents-mcp-env.ts";
import { callSlackTool, SLACK_TOOL_DEFINITIONS, SLACK_TOOL_NAMES } from "./agents-slack-tools.ts";

const NAMES = ["slack_channels", "slack_post", "slack_reply", "slack_react", "slack_upload", "slack_read", "slack_dm"];

describe("the bot's own Slack tools on the agents server", () => {
  it("lists exactly seven tools only when this bot is linked to Slack", () => {
    const profile = catalogProfileFromEnv({});
    const without = availableTools(profile).map((tool) => tool.name);
    expect([...SLACK_TOOL_NAMES]).toEqual(NAMES);
    expect(SLACK_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual(NAMES);
    for (const slack of [undefined, false, true]) {
      const names = availableTools({ ...profile, slack }).map((tool) => tool.name);
      expect(names.filter((name) => name.startsWith("slack_"))).toEqual(slack === true ? NAMES : []);
      expect(names.filter((name) => !name.startsWith("slack_"))).toEqual(without);
    }
    for (const name of NAMES) expect(bridgedCallName("mcp__agents__use_tool", { name, arguments: {} })).toBe(`mcp__agents__${name}`);
  });

  it("reads MADANI_SLACK only as 1 and carries it over the MCP bridge", () => {
    for (const value of [undefined, "", "0", "true", "1"]) expect(catalogProfileFromEnv({ MADANI_SLACK: value }).slack).toBe(value === "1");
    expect(AGENTS_MCP_ENV).toContain("MADANI_SLACK");
  });

  it("writes MADANI_SLACK on each turn from the host's per-bot flag", () => {
    const conversation: AgentsConversation = {
      threadId: "thread", bot: { id: "bot" }, room: false, teamComputer: false,
      host: { skillAuthoring: false, cloudHome: false, team: false, voiceNotes: false, x: false, research: false },
    };
    for (const slack of [undefined, false, true]) {
      const env = agentsServerEnv({ ...conversation, host: { ...conversation.host, slack } },
        { generation: "turn", depth: 0, skillAuthoring: false }, () => "fixture-capability", "http://127.0.0.1:9");
      expect(env.MADANI_SLACK).toBe(slack === true ? "1" : "0");
    }
  });

  it.each(NAMES)("POSTs %s through the internal harness client", async (name) => {
    const apiResponse = vi.fn(async () => ({ ok: true, status: 200, body: { text: "Slack result" } }));
    const context: ToolCallContext = { botId: "bot", threadId: "thread", depth: 0, externalRuntime: false, client: { api: vi.fn(), apiResponse } };
    const args = { channel: "C0123", text: "hello" };
    expect(await callSlackTool(name, args, context)).toEqual({ text: "Slack result" });
    expect(apiResponse).toHaveBeenCalledWith(`/api/internal/slack/${name}`, { method: "POST", body: JSON.stringify(args) });
    apiResponse.mockResolvedValue({ ok: false, status: 400, body: { text: "", error: "Slack refused that." } } as never);
    expect(await callSlackTool(name, args, context)).toEqual({ text: "Slack refused that.", isError: true });
  });

  it("dispatches a Slack tool beside the page tools", async () => {
    const apiResponse = vi.fn(async () => ({ ok: true, status: 200, body: { text: "[]" } }));
    const context: ToolCallContext = { botId: "bot", threadId: "thread", depth: 0, externalRuntime: false, client: { api: vi.fn(), apiResponse } };
    expect(await callTool("slack_channels", {}, context)).toEqual({ text: "[]" });
    expect(apiResponse).toHaveBeenCalledWith("/api/internal/slack/slack_channels", { method: "POST", body: "{}" });
  });
});
