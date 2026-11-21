// A provider the app only found on this computer: a bot never ends up with an empty AI and a bare 409, a person's Use it
// turns it on, and a bot an earlier version already ran on it keeps answering without Use it.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { launchRestartableServer, type RestartableServer } from "./testing/restartable-server.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const FAKE_CLI = join(import.meta.dirname, "testing", "fake-claude-cli.ts");
const FOUND_CLAUDE = { claude: { driver: "claudeAgent", displayName: "Claude" } };

let server: RestartableServer | undefined;
let shims: string | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  if (shims) await removeTempDir(shims);
  shims = undefined;
});

/** `claude` on the PATH, as a person's own install would be: no CLI path in config. */
function claudeOnPath(): string {
  shims = mkdtempSync(join(tmpdir(), "madani-found-cli-"));
  const shim = join(shims, "claude");
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" --experimental-strip-types "${FAKE_CLI}" "$@"\n`);
  chmodSync(shim, 0o755);
  return shims;
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${server!.url}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function replied(threadId: string): Promise<boolean> {
  for (const deadline = Date.now() + 30_000; Date.now() < deadline;) {
    const { body } = await call("GET", `/api/threads/${threadId}/messages`);
    if ((body.messages ?? []).some((message: { role: string; text?: string }) => message.role === "bot" && /fake claude/i.test(message.text ?? ""))) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

const send = (bot: { id: string; threadId: string }, text: string) =>
  call("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.threadId, sendId: crypto.randomUUID() });

describe.skipIf(process.platform === "win32")("a provider found on this computer", () => {
  it("is offered in the refusal, never an empty AI, and answers once the person says Use it", async () => {
    server = await launchRestartableServer({ instances: FOUND_CLAUDE, pathFirst: claudeOnPath() });
    const listed = (await call("GET", "/api/instances?fresh=1")).body.instances as Array<{ instanceId: string; found?: true; snapshot: { state: string } }>;
    expect(listed.find((instance) => instance.instanceId === "claude")).toMatchObject({ found: true, snapshot: { state: "available" } });
    const bot = (await call("POST", "/api/bots", { name: "Wren" })).body.bot as { id: string; threadId: string; modelSelection: { instanceId: string } };
    expect(bot.modelSelection.instanceId).toBe("");

    const refused = await send(bot, "hello");
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "no_ai", found: { instanceId: "claude", name: "Claude" } });
    expect(refused.body.error).not.toMatch(/provider instance ""/);

    await call("PATCH", "/api/instances/claude", { chosen: true });
    expect((await send(bot, "hello again")).status).toBeLessThan(300);
    expect(await replied(bot.threadId)).toBe(true);
  }, 120_000);

  it("keeps a bot an earlier version ran on it answering after the update, with no Use it", async () => {
    server = await launchRestartableServer({ instances: { claude: { ...FOUND_CLAUDE.claude, chosen: true } }, pathFirst: claudeOnPath() });
    const bot = (await call("POST", "/api/bots", { name: "Moss" })).body.bot as { id: string; threadId: string; modelSelection: { instanceId: string } };
    expect(bot.modelSelection.instanceId).toBe("claude");
    // the update: config as an earlier version wrote it, with no choice recorded
    await server.stop();
    const configPath = join(server.dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    delete config.instances.claude.chosen;
    writeFileSync(configPath, JSON.stringify(config));
    await server.start();

    const listed = (await call("GET", "/api/instances?fresh=1")).body.instances as Array<{ instanceId: string; found?: true }>;
    expect(listed.find((instance) => instance.instanceId === "claude")?.found).toBeUndefined();
    expect((await send(bot, "still there?")).status).toBeLessThan(300);
    expect(await replied(bot.threadId)).toBe(true);
  }, 120_000);
});
