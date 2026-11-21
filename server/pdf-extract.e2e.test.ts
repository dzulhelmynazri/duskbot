import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { verificationServerEnvironment } from "../scripts/control-madani.ts";
import { callHelperTool } from "./drivers/agents-helper-tools.ts";
import { createHarnessClient } from "./drivers/agents-client.ts";
import { pdfFixture } from "./testing/pdf-fixture.ts";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

it("extracts an uploaded multi-page PDF through the supported bot tool and isolates other conversations", async () => {
  const home = mkdtempSync(join(tmpdir(), "madani-pdf-http-"));
  mkdirSync(join(home, "tmp"));
  const port = await freePortBlock([0, 1]);
  const base = `http://127.0.0.1:${port}`;
  const dump = join(home, "fake-claude-dump.json");
  const serverRoot = fileURLToPath(new URL("..", import.meta.url));
  const env = verificationServerEnvironment({ FAKE_CLAUDE_MODE: "hang" }, home, port);
  const inputs: string[] = [];
  const model = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const input = JSON.parse(body.messages[1].content).input;
    inputs.push(input);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ values: { invoice: input.includes("INV-2291") ? "INV-2291" : null } }) } }] }));
  });
  await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
  const address = model.address();
  if (!address || typeof address === "string") throw new Error("Fixture model did not bind");
  writeFileSync(join(home, "config.json"), JSON.stringify({ instances: {
    claude: { driver: "claudeAgent", config: { cli: join(serverRoot, "server/testing/fake-claude-cli.ts") } },
  }, decider: { enabled: true, provider: "openrouter", openrouterKey: "fixture-only", openrouterBaseUrl: `http://127.0.0.1:${address.port}` } }));
  const child = spawn(process.execPath, [join(serverRoot, "server/index.ts")], { cwd: serverRoot, env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr!.on("data", chunk => { stderr += chunk; });
  const api = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    await expect.poll(async () => {
      if (child.exitCode !== null) throw new Error(stderr);
      try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
    }, { timeout: 30_000 }).toBe(true);
    const bot = (await api("POST", "/api/bots", { name: "PDF reader" })).body.bot;
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false });
    const bytes = pdfFixture(["Invoice for café München €1080", "Second page: INV-2291"]);
    const uploaded = await fetch(base + "/api/files?name=invoice.pdf", { method: "POST", headers: { "content-type": "application/pdf" }, body: bytes });
    expect(uploaded.status).toBe(201);
    const file = await uploaded.json() as { path: string; name: string };
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: `Read the invoice.\n\n<attached-file path="${file.path}" name="invoice.pdf" />` })).status).toBe(202);
    await expect.poll(() => existsSync(dump), { timeout: 15_000 }).toBe(true);
    const mounted = JSON.parse(readFileSync(dump, "utf8"));
    const agentEnv = mounted.mcpConfig.mcpServers.agents.env;
    const client = createHarnessClient(base, agentEnv.MADANI_COMMS_TOKEN);
    const context = { client, botId: bot.id, threadId: bot.threadId, depth: 0, externalRuntime: false };
    const fields = { invoice: { type: "string" } };
    const tool = await callHelperTool("extract", { fields, file: file.path }, context);
    expect(tool, JSON.stringify(tool)).not.toHaveProperty("isError", true);
    expect(tool.text).toContain('"invoice":"INV-2291"');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toContain("café München €1080");
    expect(inputs[0]).toContain("Second page: INV-2291");
    const foreign = await fetch(base + "/api/files?name=foreign.pdf", { method: "POST", headers: { "content-type": "application/pdf" }, body: bytes });
    const other = await foreign.json() as { path: string };
    const otherBot = (await api("POST", "/api/bots", { name: "Other conversation" })).body.bot;
    await api("PATCH", `/api/bots/${otherBot.id}`, { computer: "off", browser: false });
    await api("POST", `/api/bots/${otherBot.id}/messages`, { text: `<attached-file path="${other.path}" name="foreign.pdf" />` });
    const refused = await callHelperTool("extract", { fields, file: other.path }, context);
    expect(refused.isError).toBe(true);
    expect(inputs).toHaveLength(1);
    const traversal = await callHelperTool("extract", { fields, file: join(home, "config.json") }, context);
    expect(traversal.isError).toBe(true);
    await api("POST", `/api/bots/${bot.id}/interrupt`, {});
    expect((await api("POST", "/api/internal/helpers/extract", { fields, file: file.path }, agentEnv.MADANI_COMMS_TOKEN)).status).toBe(401);
  } finally {
    await waitForExit(child, { signal: "SIGTERM" });
    await new Promise<void>((resolve, reject) => model.close(error => error ? reject(error) : resolve()));
    await removeTempDir(home);
  }
}, 60_000);
