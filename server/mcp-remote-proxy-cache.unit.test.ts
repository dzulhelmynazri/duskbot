import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemoteMcpSpec } from "./contracts.ts";
import { McpRpcError } from "./mcp-http.ts";
import { RemoteMcpMetadataCache, remoteMcpCacheDirectory, remoteMcpCacheKey } from "./mcp-remote-proxy-cache.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await removeTempDir(home); });
const spec: RemoteMcpSpec = { type: "http", url: "https://fixture.invalid/mcp", headers: { Authorization: "Bearer fixture-one" } };
const initialize = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
const listed = (name: string) => ({ tools: [{ name, inputSchema: { type: "object" } }] });
const signal = new AbortController().signal;
const request = (cache: RemoteMcpMetadataCache, method: string, params: unknown = {}) => cache.request(method, params, signal);
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "madani-mcp-metadata-"));
  homes.push(directory);
  const file = join(directory, `${remoteMcpCacheKey(spec, {})}.json`);
  const upstream = { initialize: vi.fn(async () => initialize), request: vi.fn(async (_method: string, _params: unknown): Promise<unknown> => listed("old")) };
  const open = (target = spec, handshake = {}, identity?: string) => new RemoteMcpMetadataCache({ directory, spec: target, handshake, identity, closed: signal, ...upstream, changed: vi.fn() });
  const first = open();
  await request(first, "initialize");
  await request(first, "tools/list");
  return { open, upstream, file, directory };
}

describe("remote MCP disk metadata", () => {
  it("serves cached initialize and tools/list while a slow upstream handshake is still pending", async () => {
    const f = await fixture();
    const gate = deferred();
    f.upstream.initialize.mockImplementation(async () => { await gate.promise; return initialize; });
    f.upstream.request.mockResolvedValue(listed("fresh"));
    const turn = f.open();
    expect(await request(turn, "initialize")).toEqual(initialize);
    expect(await request(turn, "tools/list")).toEqual(listed("old"));
    expect(f.upstream.request).toHaveBeenCalledTimes(1);
    gate.resolve();
    await expect.poll(() => JSON.parse(readFileSync(f.file, "utf8")).pages.null).toEqual(listed("fresh"));
    expect(await request(turn, "tools/list")).toEqual(listed("fresh"));
    expect(readFileSync(f.file, "utf8")).not.toContain("fixture-one");
  });

  it.each(["url", "auth", "transport", "handshake"] as const)("misses on a changed %s config", async (change) => {
    const f = await fixture();
    f.upstream.request.mockResolvedValue(listed("changed"));
    const target = change === "url" ? { ...spec, url: spec.url + "/new" } : change === "auth" ? { ...spec, headers: { Authorization: "Bearer fixture-two" } }
      : change === "transport" ? { ...spec, type: "sse" as const } : spec;
    const turn = f.open(target, change === "handshake" ? { extensions: { ui: {} } } : {});
    expect(await request(turn, "initialize")).toEqual(initialize);
    expect(await request(turn, "tools/list")).toEqual(listed("changed"));
    expect(f.upstream.initialize).toHaveBeenCalledTimes(2);
  });

  it.each(["rpc", "result"] as const)("invalidates an unknown-tool %s failure and never caches call results", async (mode) => {
    const f = await fixture();
    const turn = f.open();
    await request(turn, "initialize");
    await expect.poll(() => f.upstream.request.mock.calls.length).toBe(2);
    await Promise.resolve();
    f.upstream.request.mockImplementation(async method => {
      if (method === "tools/list") return listed("new");
      if (mode === "rpc") throw new McpRpcError(-32602, "Unknown tool: old");
      return { isError: true, content: [{ type: "text", text: "Tool old not found" }] };
    });
    await request(turn, "tools/call", { name: "old" }).catch(() => {});
    expect(existsSync(f.file)).toBe(false);
    expect(await request(turn, "tools/list")).toEqual(listed("new"));
    f.upstream.request.mockResolvedValue({ content: [{ type: "text", text: "uncached-result" }] });
    await request(turn, "tools/call", { name: "new" });
    await request(turn, "tools/call", { name: "new" });
    expect(f.upstream.request.mock.calls.filter(([method]) => method === "tools/call")).toHaveLength(3);
    expect(readFileSync(f.file, "utf8")).not.toContain("uncached-result");
  });

  it("keeps a complete catalog when refresh fails and never saves a partial pagination", async () => {
    const f = await fixture();
    f.upstream.request.mockResolvedValueOnce({ ...listed("partial"), nextCursor: "page2" }).mockRejectedValueOnce(new Error("offline"));
    const turn = f.open();
    await request(turn, "initialize");
    await expect.poll(() => f.upstream.request.mock.calls.length).toBe(3);
    expect(await request(turn, "tools/list")).toEqual(listed("old"));
    expect(JSON.parse(readFileSync(f.file, "utf8")).pages.null).toEqual(listed("old"));
  });

  it("does not resurrect metadata invalidated during a refresh", async () => {
    const f = await fixture();
    const gate = deferred();
    f.upstream.request.mockImplementation(async () => { await gate.promise; return listed("obsolete"); });
    const turn = f.open();
    await request(turn, "initialize");
    turn.invalidate();
    gate.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(existsSync(f.file)).toBe(false);
  });

  it("keys brokered servers by original identity across token rotation", async () => {
    const f = await fixture();
    const identity = remoteMcpCacheKey(spec, {});
    const first = f.open({ ...spec, url: "http://127.0.0.1:1/b/token1/mcp", headers: {} }, {}, identity);
    await request(first, "initialize");
    await request(first, "tools/list");
    const gate = deferred();
    f.upstream.initialize.mockImplementation(async () => { await gate.promise; return initialize; });
    const next = f.open({ ...spec, url: "http://127.0.0.1:1/b/token2/mcp", headers: {} }, {}, identity);
    expect(await request(next, "initialize")).toEqual(initialize);
    expect(await request(next, "tools/list")).toEqual(listed("old"));
    gate.resolve();
    expect(readdirSync(f.directory)).toHaveLength(2);
  });

  it("stores boxed metadata in its existing private engine home under the data root", () => {
    expect(remoteMcpCacheDirectory("/data/remote-mcp-cache", "/data/engine-home")).toBe("/data/engine-home/remote-mcp-cache");
    expect(remoteMcpCacheDirectory("/data/remote-mcp-cache", "/data/engine-homes/member-a")).toBe("/data/engine-homes/member-a/remote-mcp-cache");
    expect(remoteMcpCacheDirectory("/data/remote-mcp-cache", "/home/person")).toBe("/data/remote-mcp-cache");
  });

  it.each([
    ["/tmp/madani-remote-cache-fixture", "/tmp/madani-test-home-fixture"],
    ["/tmp/custom-cache", "/tmp/engine-home"],
    ["/data/remote-mcp-cache", "/data/person-home"],
    ["/data/remote-mcp-cache", "/data/engine-homes-other/member-a"],
    ["/data/remote-mcp-cache", "/data/remote-mcp-cache"],
  ])("preserves the configured cache %s for home %s", (directory, home) => {
    expect(remoteMcpCacheDirectory(directory, home)).toBe(directory);
  });
});
