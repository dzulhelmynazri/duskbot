import { TOOL_BRIDGE_ENV } from "./agents-bridge.ts";
import { TOOL_LIMIT_ENV } from "../tool-count-limit.ts";

/** "1" from the Claude driver: only the hot tools load up front, the rest wait behind Claude Code's tool search. */
export const AGENTS_DEFER_ENV = "MADANI_AGENTS_DEFER";

/** The settings the harness gives the agents MCP server, and the only ones a request may carry over HTTP. */
export const AGENTS_MCP_ENV = ["MADANI_BOT_ID", "MADANI_THREAD_ID", "MADANI_TURN_DEPTH", "MADANI_EXTERNAL_RUNTIME", "MADANI_CHIEF_OF_STAFF",
  "MADANI_SKILL_AUTHORING_ENABLED", "MADANI_MEMORY_ENABLED", "MADANI_CLOUD_HOME", "MADANI_VOICE_NOTES",
  "MADANI_X_RESEARCH", "MADANI_RESEARCH", "MADANI_SLACK", "MADANI_TEAM_PEOPLE", "MADANI_DEFAULT_BOT", "MADANI_COMPUTER_SELECTION", "MADANI_SCREEN_ACCESS", "MADANI_ROOM", "MADANI_NATIVE_WEB", "MADANI_PAGE_READER", AGENTS_DEFER_ENV, TOOL_BRIDGE_ENV, TOOL_LIMIT_ENV] as const;
