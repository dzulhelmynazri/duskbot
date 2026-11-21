// Ten everyday tasks through the real chat-completions driver, with a scripted model and fixture tools, so the numbers
// are the harness's own: steps, tool calls, approvals and wall time with no model latency. Every task must finish with
// the writes it asked for and an approval card wherever one is due. BENCH_ROOT runs another checkout's server code.
// Run: node --experimental-strip-types scripts/bench-everyday.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const ROOT = resolve(process.env.BENCH_ROOT ?? join(import.meta.dirname, ".."));
const { OpenAICompatDriver } = await import(join(ROOT, "server/drivers/openai-compat.ts"));
const { recordEvents } = await import(join(ROOT, "server/testing/events.ts"));
const { SPAWNED_PROXIES } = await import(join(ROOT, "server/proxy-paths.ts"));

type Call = [tool: string, args?: Record<string, unknown>];
type Task = { name: string; ask?: boolean; rounds: Call[][]; writes: string[]; approvals?: number };
const web = (count: number, tool = "web_search"): Call[] => Array.from({ length: count }, (_, index) => [tool, { q: `${tool} ${index}` }]);
const TASKS: Task[] = [
  { name: "research a topic", rounds: [web(3), web(2, "web_fetch")], writes: [] },
  { name: "summarise a PDF", rounds: [[["files_read_file", { path: "report.pdf" }]]], writes: [] },
  { name: "draft an email (Ask: approve)", ask: true, approvals: 1, rounds: [[["gmail_create_draft", { to: "test@example.com" }]]], writes: ["gmail_create_draft"] },
  { name: "schedule an event", rounds: [[["calendar_find_free", { day: "tue" }]], [["calendar_create_event", { title: "Dentist" }]]], writes: ["calendar_create_event"] },
  { name: "compare products", rounds: [web(6), web(2, "web_fetch")], writes: [] },
  { name: "small data analysis", rounds: [[["files_read_file", { path: "sales.csv" }]], [["data_query", { sql: "select region, sum(v)" }]]], writes: [] },
  { name: "rename files", rounds: [[["files_list", { path: "photos" }]], ["4402", "4407", "4410", "4415"].map((n, i): Call => ["files_rename", { from: `IMG_${n}.jpg`, to: `2026-11-07_0${i + 1}.jpg` }])],
    writes: ["files_rename", "files_rename", "files_rename", "files_rename"] },
  { name: "set a reminder", rounds: [[["agents_trigger", { action: "create", when: "schedule", name: "Stretch", instructions: "Say: time to stretch", schedule: { type: "once", at: "2099-11-07T13:34:00+00:00" } }]]], writes: [] },
  { name: "multi-step web lookup", rounds: [web(1), web(1, "web_fetch"), web(1, "web_fetch")], writes: [] },
  { name: "quick code fix", rounds: [[["files_read_file", { path: "stats.py" }], ["files_read_file", { path: "test_stats.py" }]], [["files_write_file", { path: "stats.py" }]], [["files_run", { cmd: "python3 test_stats.py" }]]],
    writes: ["files_write_file", "files_run"] },
];
const FIXTURE_TOOLS: Record<string, Array<{ name: string; read: boolean; ms: number }>> = {
  web: [{ name: "search", read: true, ms: 250 }, { name: "fetch", read: true, ms: 250 }],
  files: [{ name: "read_file", read: true, ms: 20 }, { name: "list", read: true, ms: 20 }, { name: "rename", read: false, ms: 20 }, { name: "write_file", read: false, ms: 20 }, { name: "run", read: false, ms: 300 }],
  gmail: [{ name: "create_draft", read: false, ms: 150 }],
  calendar: [{ name: "find_free", read: true, ms: 150 }, { name: "create_event", read: false, ms: 150 }],
  data: [{ name: "query", read: true, ms: 50 }],
};

const dir = mkdtempSync(join(tmpdir(), "madani-everyday-"));
const log = join(dir, "effects.jsonl");
const server = join(dir, "fixture-mcp.mjs");
writeFileSync(server, `import { appendFileSync } from "node:fs";
const tools = JSON.parse(process.env.TOOLS), log = process.env.LOG, server = process.env.NAME;
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) !== -1) {
    const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
    if (message.method === "initialize") reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} } });
    else if (message.method === "tools/list") reply({ tools: tools.map((tool) => ({ name: tool.name, description: tool.name, inputSchema: { type: "object" },
      ...(tool.read ? { annotations: { readOnlyHint: true } } : {}) })) });
    else if (message.method === "tools/call") {
      const tool = tools.find((entry) => entry.name === message.params.name);
      setTimeout(() => { if (!tool.read) appendFileSync(log, JSON.stringify({ tool: server + "_" + tool.name }) + "\\n"); reply({ content: [{ type: "text", text: "ok " + tool.name }] }); }, tool.ms);
    }
  }
});`);

const harness = createServer((request, response) => {
  request.resume();
  request.on("end", () => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ resultId: "t-1", summary: "Once at 13:34 UTC: Say: time to stretch." })); });
});
await new Promise<void>((done) => harness.listen(0, "127.0.0.1", done));
const harnessUrl = `http://127.0.0.1:${(harness.address() as { port: number }).port}`;

let task: Task = TASKS[0]!;
let round = 0;
const sse = (response: ServerResponse, delta: unknown, finish: string) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  response.end("data: [DONE]\n\n");
};
const provider = createServer(async (request, response) => {
  if (request.method !== "POST") { response.writeHead(404); response.end(); return; }
  for await (const _ of request) { /* drain */ }
  const calls = task.rounds[round++];
  if (!calls) return sse(response, { content: `Done: ${task.name}.` }, "stop");
  sse(response, { content: null, tool_calls: calls.map(([name, args], index) => ({ index, id: `c${round}-${index}`, type: "function", function: { name, arguments: JSON.stringify(args ?? {}) } })) }, "tool_calls");
});
await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));

const instance = await OpenAICompatDriver.create({
  instanceId: "everyday", displayName: "Everyday fixture", enabled: true,
  config: { url: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`, apiKeyEnv: "EVERYDAY_KEY" }, environment: { EVERYDAY_KEY: "fixture" },
});
const recorder = recordEvents(instance.adapter);
const custom = Object.fromEntries(Object.entries(FIXTURE_TOOLS).map(([name, tools]) => [name, { command: process.execPath, args: [server], env: { TOOLS: JSON.stringify(tools), LOG: log, NAME: name } }]));
const agents = { command: process.execPath, args: [SPAWNED_PROXIES.agents], env: { MADANI_HARNESS_URL: harnessUrl, MADANI_BOT_ID: "everyday", MADANI_THREAD_ID: "everyday", MADANI_COMMS_TOKEN: "fixture", MADANI_TURN_DEPTH: "0" } };

const rows: string[] = [];
let passed = 0, total = 0;
for (const entry of TASKS) {
  task = entry; round = 0; writeFileSync(log, "");
  const threadId = `everyday-${TASKS.indexOf(entry)}`;
  const seen = recorder.events.length;
  const started = performance.now();
  const { turnId } = await instance.adapter.sendTurn({ threadId, text: entry.name, model: "fixture-model", approvalMode: entry.ask ? "ask" : "full", integrations: { agents, custom } });
  const answered = new Set<string>();
  for (;;) {
    const event = await recorder.until((candidate: { type: string; turnId?: string; requestId?: string }) => recorder.events.indexOf(candidate) >= seen
      && ((candidate.type === "request.opened" && !answered.has(candidate.requestId!)) || (candidate.type === "turn.completed" && candidate.turnId === turnId)), 30_000);
    if (event.type === "turn.completed") break;
    answered.add(event.requestId);
    await instance.adapter.respondToRequest(threadId, event.requestId, { behavior: "allow" });
  }
  const approvals = answered.size;
  const ms = performance.now() - started;
  const events = recorder.events.slice(seen);
  const completed = events.find((event: { type: string }) => event.type === "turn.completed");
  const tools = events.filter((event: { type: string; itemType?: string }) => event.type === "item.completed" && event.itemType === "tool");
  const writes = readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).tool);
  const ok = completed?.ok === true && tools.every((tool: { ok: boolean }) => tool.ok) && JSON.stringify(writes) === JSON.stringify(entry.writes) && approvals === (entry.approvals ?? 0);
  total += ms; if (ok) passed += 1;
  rows.push(`${entry.name.padEnd(30)} ${ok ? "pass" : "FAIL"}  steps ${String(entry.rounds.length + 1).padStart(2)}  tools ${String(tools.length).padStart(2)}  approvals ${approvals}  ${ms.toFixed(0).padStart(5)} ms`);
}
console.log(`root: ${ROOT}`);
for (const row of rows) console.log(row);
console.log(`${passed}/${TASKS.length} passed, ${total.toFixed(0)} ms in all`);
recorder.stop();
await instance.dispose();
provider.closeAllConnections(); provider.close(); harness.closeAllConnections(); harness.close();
rmSync(dir, { recursive: true, force: true });

