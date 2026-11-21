import { describe, expect, it } from "vitest";

import { catalogProfileFromEnv } from "./agents-catalog-profile.ts";
import { BRIDGE_HOT_TOOL_NAMES } from "./agents-bridge.ts";
import { AGENTS_DEFER_ENV, AGENTS_MCP_ENV } from "./agents-mcp-env.ts";
import { agentsToolList } from "./agents-mcp.ts";

describe("the agents server's settings", () => {
  it("carry every switch the catalog reads, so a turn reaching the server over HTTP is listed the same tools", () => {
    const read = new Set<string>();
    catalogProfileFromEnv(new Proxy({}, { get: (_target, key) => { if (typeof key === "string") read.add(key); return undefined; } }));
    expect(read.size).toBeGreaterThan(10);
    for (const key of read) expect(AGENTS_MCP_ENV, key).toContain(key);
  });

  it("defer: only the hot tools stay always loaded for Claude, the rest are marked for tool search", () => {
    const env = { MADANI_BOT_ID: "b", MADANI_THREAD_ID: "t", MADANI_MEMORY_ENABLED: "1" };
    const meta = (tool: object) => (tool as { _meta?: Record<string, unknown> })._meta?.["anthropic/alwaysLoad"];
    const plain = agentsToolList(env).listed;
    expect(plain.some((tool) => meta(tool) !== undefined), "other engines see the catalog unchanged").toBe(false);
    const deferred = agentsToolList({ ...env, [AGENTS_DEFER_ENV]: "1" }).listed;
    expect(deferred.map((tool) => tool.name)).toEqual(plain.map((tool) => tool.name));
    const up = deferred.filter((tool) => meta(tool) !== false).map((tool) => tool.name);
    expect(up).toEqual(expect.arrayContaining(["memory_update", "attach_file", "coordinate_bots"]));
    for (const name of up) expect(BRIDGE_HOT_TOOL_NAMES.has(name), name).toBe(true);
    expect(meta(deferred.find((tool) => tool.name === "trigger")!), "routines load through tool search").toBe(false);
  });
});
