// Tool-calling overhead with no model in the loop: how long a chat-runtime turn spends mounting its MCP servers, what
// one agents tool call costs end to end through the stdio proxy and a stub harness, how a provider batch of reads is
// scheduled, and how large the agents tool list is. Run: node --experimental-strip-types scripts/bench-tool-calls.ts
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { mountChatTools } from "../server/drivers/chat-mcp-tools.ts";
import { chatToolBatches } from "../server/drivers/chat-tool-batches.ts";
import { agentsToolList } from "../server/drivers/agents-mcp.ts";
import { SPAWNED_PROXIES } from "../server/proxy-paths.ts";
import type { ChatToolCall } from "../server/drivers/openai-chat-protocol.ts";

const RUNS = Number(process.env.BENCH_RUNS ?? 10);
const READ_MS = Number(process.env.BENCH_READ_MS ?? 300);

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const p90 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * 0.9))]!;
const line = (label: string, values: number[]) => console.log(`${label.padEnd(54)} median ${median(values).toFixed(1).padStart(7)} ms  p90 ${p90(values).toFixed(1).padStart(7)} ms  (n=${values.length})`);

async function stubHarness(): Promise<{ url: string; requests: () => number; close(): Promise<void> }> {
  let count = 0;
  const server = createServer((request, response) => {
    count += 1;
    request.resume();
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, bots: [{ id: "b1", name: "Nova", model: "fake" }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return { url: `http://127.0.0.1:${address.port}`, requests: () => count, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

async function main() {
  const harness = await stubHarness();
  const folder = await mkdtemp(join(tmpdir(), "madani-bench-tools-"));
  const toolsFile = join(folder, "tools.json");
  await writeFile(toolsFile, JSON.stringify([
    { name: "lookup", description: "Read one record", inputSchema: { type: "object", properties: { id: { type: "string" } } }, annotations: { readOnlyHint: true } },
  ]));
  const agents = {
    command: process.execPath,
    args: [process.env.BENCH_AGENTS_PROXY ?? SPAWNED_PROXIES.agents],
    env: { MADANI_HARNESS_URL: harness.url, MADANI_BOT_ID: "bench", MADANI_THREAD_ID: "bench-thread", MADANI_COMMS_TOKEN: "bench-token", MADANI_TURN_DEPTH: "0" },
  };
  const fake = { command: process.execPath, args: [join(import.meta.dirname, "../server/testing/fake-mcp-server.ts")], env: { FAKE_MCP_TOOLS_FILE: toolsFile } };
  console.log(`agents proxy: ${agents.args[0]}`);

  const { listed } = agentsToolList(agents.env);
  const bridged = agentsToolList({ ...agents.env, MADANI_AGENTS_TOOL_BRIDGE: "1" }).listed;
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  console.log(`agents tools/list: ${listed.length} tools, ${bytes(listed)} bytes (~${Math.round(bytes(listed) / 4)} tokens); bridged ${bridged.length} tools, ${bytes(bridged)} bytes`);

  for (const [label, integrations] of [
    ["mount: agents only", { agents }],
    ["mount: agents + 2 configured stdio servers", { agents, custom: { one: fake, two: fake } }],
  ] as const) {
    const times: number[] = [];
    for (let run = 0; run < RUNS; run += 1) {
      const started = performance.now();
      const session = await mountChatTools(integrations as never, new AbortController().signal);
      times.push(performance.now() - started);
      await session.close();
    }
    line(label, times);
  }

  const session = await mountChatTools({ agents } as never, new AbortController().signal);
  const calls: number[] = [];
  for (let run = 0; run < RUNS * 3; run += 1) {
    const started = performance.now();
    const result = await session.execute("agents_list_bots", {}, new AbortController().signal);
    calls.push(performance.now() - started);
    if (!result.ok) throw new Error(`list_bots failed: ${result.text}`);
  }
  line("agents tool call round trip (list_bots, stub harness)", calls);
  await session.close();

  const view = () => ({ title: "t", input: {}, ask: false });
  const reads = (count: number): ChatToolCall[] => Array.from({ length: count }, (_, index) => ({ id: `c${index}`, type: "function", function: { name: "read", arguments: "{}" } }));
  for (const count of [1, 4, 8]) {
    const started = performance.now();
    for await (const _batch of chatToolBatches(reads(count), {
      session: { parallel: () => true, view }, signal: new AbortController().signal, full: () => false, covered: () => false,
      execute: () => new Promise((resolve) => setTimeout(resolve, READ_MS)),
    })) { /* drain */ }
    console.log(`${`batch of ${count} independent reads at ${READ_MS} ms each`.padEnd(54)} wall ${(performance.now() - started).toFixed(0).padStart(7)} ms`);
  }
  console.log(`stub harness requests: ${harness.requests()}`);
  await harness.close();
  await rm(folder, { recursive: true, force: true });
}

await main();
