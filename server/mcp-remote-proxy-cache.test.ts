import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import type { RemoteMcpSpec } from "./contracts.ts";
import { mcpStdioServer } from "./mcp-gate-config.ts";
import { REMOTE_MCP_CACHE_ENV, remoteMcpCacheKey } from "./mcp-remote-proxy-cache.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const tool = (name: string) => ({ name, inputSchema: { type: "object" } });

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "madani-remote-cache-"));
  cleanup.push(() => removeTempDir(directory));
  let blocked = false, release = () => {};
  let gate = Promise.resolve();
  let tools = [tool("old")], initializes = 0, lists = 0, calls = 0;
  let unknown: "rpc" | "result" | undefined;
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method === "DELETE") { res.writeHead(204).end(); return; }
      let body = "";
      for await (const chunk of req) body += chunk;
      const frame = JSON.parse(body);
      if (frame.id === undefined) { res.writeHead(202).end(); return; }
      if (frame.method === "initialize") { initializes++; if (blocked) await gate; }
      if (frame.method === "tools/list") { lists++; if (blocked) await gate; }
      if (frame.method === "tools/call") calls++;
      const result = frame.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "cache-fixture", version: "1" } }
        : frame.method === "tools/list" ? { tools }
        : { content: [{ type: "text", text: unknown ? "Unknown tool: old" : `call ${calls}` }], ...(unknown ? { isError: true } : {}) };
      const error = frame.method === "tools/call" && unknown === "rpc" ? { code: -32602, message: "Unknown tool: old" } : undefined;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: frame.id, ...(error ? { error } : { result }) }));
    })().catch(() => res.destroy());
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  cleanup.push(async () => { release(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const spec = { type: "http" as const, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, headers: { Authorization: "Bearer fixture-one" } };
  const file = join(directory, `${remoteMcpCacheKey(spec, {})}.json`);
  function start(target: RemoteMcpSpec = spec, privateEnv = false) {
    const configEnvName = privateEnv ? `MADANI_REMOTE_MCP_CONFIG_${"a".repeat(64)}` : undefined;
    const descriptor = mcpStdioServer(target, { configEnvName })!;
    const env = { ...descriptor.env };
    if (configEnvName) env[configEnvName] = JSON.stringify({ ...JSON.parse(env[configEnvName]!), [REMOTE_MCP_CACHE_ENV]: directory });
    else env[REMOTE_MCP_CACHE_ENV] = directory;
    const child: ChildProcessWithoutNullStreams = spawn(descriptor.command, ["--experimental-strip-types", "--no-warnings", ...descriptor.args!], { stdio: "pipe", env: { ...process.env, ...env } });
    child.stderr.resume();
    let id = 0;
    const pending = new Map<number, (frame: any) => void>();
    createInterface({ input: child.stdout }).on("line", line => { const frame = JSON.parse(line); pending.get(frame.id)?.(frame); pending.delete(frame.id); });
    const stop = async () => { if (child.exitCode !== null || child.signalCode !== null) return; const stopped = once(child, "close"); child.kill(); await stopped; };
    cleanup.push(stop);
    return {
      stop,
      request: (method: string, params?: unknown) => new Promise<any>((resolve, reject) => {
        const key = ++id;
        const timer = setTimeout(() => reject(new Error(`no ${method} reply`)), 3_000);
        pending.set(key, frame => { clearTimeout(timer); resolve(frame); });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: key, method, params }) + "\n");
      }),
    };
  }
  return { start, file, directory, spec, get initializes() { return initializes; }, get lists() { return lists; }, get calls() { return calls; },
    block: () => { blocked = true; gate = new Promise<void>(resolve => { release = resolve; }); },
    release: () => { blocked = false; release(); },
    tools: (names: string[]) => { tools = names.map(tool); },
    unknown: (mode: "rpc" | "result") => { unknown = mode; },
  };
}

async function warm(f: Awaited<ReturnType<typeof fixture>>) {
  const turn = f.start();
  await turn.request("initialize");
  expect((await turn.request("tools/list")).result.tools).toEqual([tool("old")]);
  await turn.stop();
}

describe("remote MCP metadata across turns", () => {
  it("answers initialize and tools/list from disk while upstream is blocked, then refreshes in the background", async () => {
    const f = await fixture();
    await warm(f);
    f.tools(["new"]);
    f.block();
    const turn = f.start(f.spec, true);
    expect((await turn.request("initialize")).result.serverInfo.name).toBe("cache-fixture");
    expect((await turn.request("tools/list")).result.tools).toEqual([tool("old")]);
    await expect.poll(() => f.initializes).toBe(2);
    expect(f.lists).toBe(1);
    f.release();
    await expect.poll(() => JSON.parse(readFileSync(f.file, "utf8")).pages.null.tools).toEqual([tool("new")]);
    expect((await turn.request("tools/list")).result.tools).toEqual([tool("new")]);
    expect((await turn.request("tools/call", { name: "new" })).result.content[0].text).toBe("call 1");
    expect((await turn.request("tools/call", { name: "new" })).result.content[0].text).toBe("call 2");
    expect(readFileSync(f.file, "utf8")).not.toContain("Bearer fixture-one");
  });

  it.each(["auth", "url", "transport"] as const)("invalidates on a %s config change", async (change) => {
    const f = await fixture();
    await warm(f);
    const changed = change === "auth" ? { ...f.spec, headers: { Authorization: "Bearer fixture-two" } }
      : change === "url" ? { ...f.spec, url: f.spec.url + "?updated=1" } : { ...f.spec, type: "sse" as const };
    expect(remoteMcpCacheKey(changed, {})).not.toBe(remoteMcpCacheKey(f.spec, {}));
    if (change === "transport") return;
    f.tools(["changed"]);
    const turn = f.start(changed);
    await turn.request("initialize");
    expect((await turn.request("tools/list")).result.tools).toEqual([tool("changed")]);
    expect(f.initializes).toBe(2);
  });

  it.each(["rpc", "result"] as const)("invalidates an unknown-tool %s error and reads fresh tools", async (mode) => {
    const f = await fixture();
    await warm(f);
    const turn = f.start();
    await turn.request("initialize");
    await expect.poll(() => f.lists).toBe(2);
    f.unknown(mode);
    await turn.request("tools/call", { name: "old" });
    expect(existsSync(f.file)).toBe(false);
    f.tools(["replacement"]);
    expect((await turn.request("tools/list")).result.tools).toEqual([tool("replacement")]);
  });
});
