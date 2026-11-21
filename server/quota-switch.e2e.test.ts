// The fake CLI plays the frames Claude Code 2.1.295 sent past its weekly limit.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runControlMadani, verificationServerArgs, verificationServerEnvironment } from "../scripts/control-madani.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";
import { freePortBlock } from "./testing/ports.ts";

const LIMITED = "Limited Claude";
const OTHER_SIGN_IN = "Second Claude sign-in";
const FAKE_CLI = fileURLToPath(new URL("./testing/fake-claude-cli.ts", import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL("./testing/fake-codex-app-server.ts", import.meta.url));
const jsonLines = (path: string): any[] => existsSync(path)
  ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

async function withQuotaFixture(
  options: { env?: Record<string, string>; otherSignInOnly?: boolean },
  check: (fixture: {
    api: (method: string, path: string, body?: unknown) => Promise<any>;
    control: (...args: string[]) => Promise<any>;
    respond: (threadId: string, body: unknown) => Promise<{ status: number; body: any }>;
    backupPrompts: () => any[];
    dataDir: string;
  }) => Promise<void>,
) {
  const port = await freePortBlock([0, 1]);
  const url = `http://127.0.0.1:${port}`;
  const dataDir = mkdtempSync(join(tmpdir(), "madanibot-quota-switch-"));
  mkdirSync(join(dataDir, "tmp"), { recursive: true });
  const evidenceDir = join(tmpdir(), "madanibot-verification-evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const logPath = join(evidenceDir, `quota-switch-${Date.now()}-${process.pid}.log`);
  const backupFile = join(dataDir, "backup-prompts.jsonl");
  const engine = (displayName: string, environment: Record<string, string>) =>
    ({ driver: "claudeAgent", displayName, config: { cli: FAKE_CLI }, environment });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    instances: {
      claude: engine(LIMITED, { FAKE_CLAUDE_MODE: "usage-limit" }),
      ...(options.otherSignInOnly
        ? { backup: engine(OTHER_SIGN_IN, { FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_PROMPTS: backupFile, FAKE_CLAUDE_TOOL_CALLS: "[]" }) }
        : { codex: { driver: "codex", config: { cli: FAKE_CODEX }, environment: { FAKE_CODEX_DUMP: backupFile } } }),
    },
  }));
  const evidence: unknown[] = [{ url, options }];
  let server: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json();
    expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
    return result;
  };
  const control = async (...args: string[]) => {
    const result = await runControlMadani([...args, "--url", url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  /** A card answer as a client posts it, with the status it got. */
  const respond = async (threadId: string, body: unknown) => {
    const response = await fetch(`${url}/api/threads/${threadId}/respond`, {
      method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    });
    const answer = { status: response.status, body: await response.json() };
    evidence.push({ respond: body, answer });
    return answer;
  };
  try {
    const env = { ...verificationServerEnvironment({}, dataDir, port), ...options.env };
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, verificationServerArgs(env), {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env, stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 90_000 }).toBe(true);
    if (!options.otherSignInOnly) {
      await expect.poll(async () => {
        const { instances } = await api("GET", "/api/instances") as { instances: any[] };
        return instances.find((instance) => instance.instanceId === "codex")?.models.options.length > 0;
      }, { timeout: 30_000 }).toBe(true);
    }
    // What the other AI was sent: the fake Claude logs each prompt; the fake Codex keeps its calls in one dump.
    const sent = () => {
      if (options.otherSignInOnly) return jsonLines(backupFile);
      try { return (JSON.parse(readFileSync(backupFile, "utf8")).calls as any[]).filter((call) => call.method === "turn/start"); } catch { return []; }
    };
    await check({ api, control, respond, backupPrompts: sent, dataDir });
  } finally {
    evidence.push({ backupPrompts: existsSync(backupFile) ? readFileSync(backupFile, "utf8").slice(0, 20_000) : null, roots: readHandoffs(dataDir) });
    const evidencePath = `${logPath}.quota-switch.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    await waitForExit(server, { signal: "SIGTERM" });
    await removeTempDir(dataDir);
    console.info(JSON.stringify({ logPath, evidencePath, fixtureRemoved: !existsSync(dataDir) }));
  }
}

/** A bot whose conversation runs on the limited engine, and the turn that meets the limit. */
async function meetTheLimit(api: (method: string, path: string, body?: unknown) => Promise<any>, control: (...args: string[]) => Promise<any>, text: string) {
  const { bot } = await control("new-bot", "--name", "Out of quota");
  const threadId = bot.activeTaskId as string;
  const limited = (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id).modelSelection;
  await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: { ...limited, instanceId: "claude" }, updateBotDefault: true });
  await control("send", "--bot", bot.id, "--task", threadId, "--text", text);
  expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("failed");
  const messages = async () => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
  const state = async () => (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id);
  return { bot, threadId, messages, state };
}

it("never carries the request on with an AI the person did not choose: the turn waits for its own AI and nothing is sent again", async () => {
  await withQuotaFixture({}, async ({ api, control, backupPrompts }) => {
    const { bot, threadId, messages, state } = await meetTheLimit(api, control, "SUMMARISE_THE_QUARTER_4K");
    const mine = async () => (await api("GET", "/api/notifications")).notifications.filter((entry: any) => entry.kind === "notice" && entry.botId === bot.id);
    await expect.poll(async () => (await mine()).length, { timeout: 20_000 }).toBe(1);
    expect((await mine())[0].body).toMatch(/, so Out of quota waits.*: no other AI you have set up can take over\.$/);
    const after = await messages();
    expect(after.filter((message) => message.role === "user")).toHaveLength(1);
    expect(after.find((message) => message.tool?.name?.startsWith("error:")).tool.limitHold).toBeDefined();
    expect((await state()).tasks.find((task: any) => task.threadId === threadId).modelSelection?.instanceId ?? "claude").toBe("claude");
    expect(backupPrompts()).toHaveLength(0);
  });
}, 240_000);

it("never moves to another sign-in of the same AI: it says once that the bot waits, and sends nothing again", async () => {
  await withQuotaFixture({ otherSignInOnly: true }, async ({ api, control, backupPrompts }) => {
    const { bot, threadId, messages, state } = await meetTheLimit(api, control, "LEAVE_THIS_WHERE_IT_IS_7M");
    const mine = async () => (await api("GET", "/api/notifications")).notifications.filter((entry: any) => entry.kind === "notice" && entry.botId === bot.id);
    await expect.poll(async () => (await mine()).length, { timeout: 20_000 }).toBe(1);
    const [notice] = await mine();
    expect(notice.body).toMatch(/^Limited Claude reached its limit.*, so Out of quota waits.*: no other AI you have set up can take over\.$/);
    expect((await messages()).filter((entry) => entry.role === "user")).toHaveLength(1);
    expect((await state()).tasks.find((task: any) => task.threadId === threadId).modelSelection?.instanceId ?? "claude").toBe("claude");
    expect(backupPrompts()).toHaveLength(0);
  });
}, 240_000);

it("moves nothing when MADANI_QUOTA_SWITCH=0 switches it off", async () => {
  await withQuotaFixture({ env: { MADANI_QUOTA_SWITCH: "0" } }, async ({ api, control, backupPrompts }) => {
    const { bot, threadId, messages, state } = await meetTheLimit(api, control, "NO_MOVE_WHEN_OFF_2B");
    const mine = async () => (await api("GET", "/api/notifications")).notifications.filter((entry: any) => entry.kind === "notice" && entry.botId === bot.id);
    await expect.poll(async () => (await mine()).length, { timeout: 20_000 }).toBe(1);
    expect((await mine())[0].body).toMatch(/, so Out of quota waits.*: no other AI you have set up can take over\.$/);
    expect((await messages()).filter((message) => message.role === "user")).toHaveLength(1);
    expect((await state()).tasks.find((task: any) => task.threadId === threadId).modelSelection?.instanceId ?? "claude").toBe("claude");
    expect(backupPrompts()).toHaveLength(0);
  });
}, 240_000);
