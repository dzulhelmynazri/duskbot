import { describe, expect, it } from "vitest";

import { OWN_APPS_SERVER } from "../../shared/own-apps.ts";
import { codexParallelMcpArgs } from "./codex-mcp-mount.ts";

describe("codexParallelMcpArgs", () => {
  it("lets independent built-in servers run one step's calls at once", () => {
    for (const name of ["agents", "data", "email", "device", "composio", OWN_APPS_SERVER]) {
      expect(codexParallelMcpArgs(name, `m_${name}`, "0.167.0")).toEqual(["-c", `mcp_servers.m_${name}.supports_parallel_tool_calls=true`]);
    }
  });

  it("keeps the screen-driving and unknown servers one call at a time", () => {
    for (const name of ["computer", "browser", "voluum", "madanibot_phone"]) expect(codexParallelMcpArgs(name, name, "0.170.2")).toEqual([]);
  });

  it("adds nothing on a Codex older than the field or one not probed yet", () => {
    expect(codexParallelMcpArgs("agents", "agents", "0.166.9")).toEqual([]);
    expect(codexParallelMcpArgs("agents", "agents", null)).toEqual([]);
  });
});
