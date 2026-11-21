import { DOCKER_NAMES } from "../electron/legacy-names.mjs";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import WebSocket from "ws";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-madani.ts";
import { launchCloudSendFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { createTeamVpsFixture } from "../scripts/testing/team-vps-fixture.ts";
import { openSse } from "./testing/sse.ts";
import { vpsContainerName } from "./vps-computer.ts";

async function harness(options: Parameters<typeof createTeamVpsFixture>[0] & { host?: boolean } = {}) {
  const { host, ...vpsOptions } = options;
  const vps = await createTeamVpsFixture(vpsOptions);
  const hostDescriptor = join(dirname(vps.records), "host-descriptor.json");
  if (host) writeFileSync(hostDescriptor, JSON.stringify({ mode: "embedded", status: "ready", socketPath: join(dirname(vps.records), "host.sock"),
    mcpCommand: process.execPath, mcpArgs: ["mcp"], mcpEnv: {} }));
  let fixture: VerificationServer;
  // the fixture host is not measured; these checks are about screen sharing, not the memory cap
  try { fixture = await launchVerificationServer({ MADANI_VPS_MAX_DESKTOPS: "20", ...(host ? { MADANI_TEST_DESKTOP_CUA_CONNECTION: hostDescriptor } : {}) }, undefined, vps.localVm); }
  catch (error) { await vps.close(); throw error; }
  const evidence: Array<Record<string, unknown>> = [];
  const pids = new Set<number>();
  const dockerPids = new Set<number>();
  const sshPids = new Set<number>();
  const api = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(fixture.info.url + path, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url,
        ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
    });
    const result = { status: response.status, body: await response.json() as any };
    if (method !== "GET") evidence.push({ method, path, status: response.status });
    return result;
  };
  const wrapper = join(fixture.info.dataDir, "thread-gated.mjs");
  writeFileSync(wrapper, [
    "#!/usr/bin/env node",
    'import { readFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'const at = process.argv.indexOf("--mcp-config");',
    'let thread = "background";',
    'if (at >= 0) { const servers = JSON.parse(readFileSync(process.argv[at + 1], "utf8")).mcpServers ?? {};',
    '  thread = Object.values(servers).find(server => server.env?.MADANI_THREAD_ID)?.env.MADANI_THREAD_ID ?? thread; }',
    'process.env.FAKE_CLAUDE_MODE = "slow";',
    `process.env.FAKE_CLAUDE_DUMP = join(${JSON.stringify(fixture.info.dataDir)}, thread + ".dump.json");`,
    `process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = join(${JSON.stringify(fixture.info.dataDir)}, process.pid + ".finish");`,
    `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-claude-cli.ts")).href)});`,
  ].join("\n"), { mode: 0o700 });
  try { expect((await api("PATCH", "/api/instances/claude", { cli: wrapper })).status).toBe(200); }
  catch (error) { await fixture.close(); await vps.close(); throw error; }
  const dump = (threadId: string): any => {
    try {
      const value = JSON.parse(readFileSync(join(fixture.info.dataDir, `${threadId}.dump.json`), "utf8"));
      if (Number.isSafeInteger(value.pid) && value.pid > 0) pids.add(value.pid);
      return value;
    } catch { return null; }
  };
  const launched = async (threadId: string, accept: (value: any) => boolean = () => true) => {
    await expect.poll(() => { const value = dump(threadId); return value && accept(value); }, { timeout: 15_000, interval: 30 }).toBeTruthy();
    return dump(threadId);
  };
  const release = (pid: number) => writeFileSync(join(fixture.info.dataDir, `${pid}.finish`), "finish");
  const tasks = async (botId: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === botId)?.tasks as any[];
  const idle = async (botId: string, threadId: string) => {
    await expect.poll(async () => (await tasks(botId))?.find(task => task.threadId === threadId)?.busy, { timeout: 15_000, interval: 30 }).toBe(false);
  };
  const stop = async (botId: string, threadId: string) => {
    expect((await api("POST", `/api/bots/${botId}/interrupt`, { threadId })).status).toBe(200);
    await idle(botId, threadId);
  };
  return { fixture, vps, api, dump, launched, release, tasks, idle, stop, evidence,
    async close() {
      if (existsSync(`${vps.hold}.started`)) dockerPids.add(Number(readFileSync(`${vps.hold}.started`, "utf8")));
      for (const line of readFileSync(vps.sshCalls, "utf8").trim().split("\n").filter(Boolean)) sshPids.add(JSON.parse(line).pid);
      rmSync(vps.hold, { force: true });
      for (const name of readdirSync(fixture.info.dataDir).filter(name => name.endsWith(".dump.json"))) dump(name.slice(0, -10));
      const evidencePath = `${fixture.info.logPath}.concurrency.json`;
      try {
        await fixture.close();
        for (const pid of [...pids, ...dockerPids, ...sshPids]) {
          await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }, { timeout: 6_000, interval: 50 }).toBe(false);
        }
        expect(existsSync(fixture.info.dataDir)).toBe(false);
        writeFileSync(evidencePath, JSON.stringify({ passedCleanup: true, actions: evidence, observedEngineProcesses: pids.size, observedBlockedDockerProcesses: dockerPids.size, observedSshProcesses: sshPids.size }, null, 2));
      } finally {
        await vps.close();
        console.info(JSON.stringify({ fixture: fixture.info.url, evidencePath, serverLog: fixture.info.logPath }));
      }
    },
  };
}

it.skipIf(process.platform === "win32")("keeps sends, cancellation and stale capability bodies pinned through rapid task switches and event reconnects", async () => {
  const h = await harness();
  let stream: Awaited<ReturnType<typeof openSse>> | undefined;
  let pendingBody: ReturnType<typeof httpRequest> | undefined;
  try {
    stream = await openSse(h.fixture.info.url + "/api/events");
    const bot = (await h.api("POST", "/api/bots", { name: "Switch race" })).body.bot;
    expect((await h.api("PATCH", `/api/bots/${bot.id}`, { computer: "off" })).status).toBe(200);
    const first = bot.threadId;
    const second = (await h.api("POST", `/api/bots/${bot.id}/tasks`, { title: "Second", select: false })).body.task.threadId;
    expect((await h.api("POST", `/api/bots/${bot.id}/messages`, { text: "FIRST_THREAD_ONLY", threadId: first })).status).toBe(202);
    const old = await h.launched(first);
    expect((await h.api("POST", `/api/bots/${bot.id}/messages`, { text: "SECOND_THREAD_ONLY", threadId: second })).status).toBe(202);
    const other = await h.launched(second);
    const token = old.mcpConfig.mcpServers.agents.env.MADANI_COMMS_TOKEN;
    pendingBody = httpRequest(h.fixture.info.url + "/api/internal/memory", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
    const answered = new Promise<{ status: number; body: any }>((resolve, reject) => {
      pendingBody!.on("error", reject);
      pendingBody!.on("response", response => {
        let text = ""; response.on("data", chunk => { text += chunk; });
        response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(text) }));
      });
    });
    void answered.catch(() => {});
    pendingBody.write('{"action":"append","text":"STALE_MEMORY_MUST_NOT_LAND');
    for (const threadId of [second, first, second, first]) {
      expect((await h.api("POST", `/api/bots/${bot.id}/tasks/${threadId}?messages=0`, {})).status).toBe(200);
    }
    stream.close(); stream = await openSse(h.fixture.info.url + "/api/events");
    await stream.until(frame => frame.kind === "hello");
    await h.stop(bot.id, first);
    await stream.until(frame => frame.kind === "bot" && frame.bot?.id === bot.id &&
      frame.bot.tasks?.some((task: any) => task.threadId === first && task.busy === false) &&
      frame.bot.tasks?.some((task: any) => task.threadId === second && task.busy === true));
    pendingBody.end('"}');
    expect((await answered).status).toBe(401);
    expect((await h.api("GET", `/api/bots/${bot.id}/memory`)).body.text).not.toContain("STALE_MEMORY_MUST_NOT_LAND");
    expect((await h.tasks(bot.id)).find(task => task.threadId === second)?.busy).toBe(true);
    expect((await h.api("GET", "/api/internal/agents", undefined, token)).status).toBe(401);
    h.release(other.pid);
    await h.idle(bot.id, second);
    const messages = async (threadId: string) => (await h.api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[];
    expect(JSON.stringify(await messages(first))).not.toContain("SECOND_THREAD_ONLY");
    expect(JSON.stringify(await messages(second))).not.toContain("FIRST_THREAD_ONLY");
    expect((await h.api("GET", "/api/health")).status).toBe(200);
  } finally { pendingBody?.destroy(); stream?.close(); await h.close(); }
}, 60_000);

it.skipIf(process.platform === "win32")("leaves ordinary Auto chats off Docker, then shares the selected VPS without mixing caller capabilities", async () => {
  const h = await harness();
  try {
    expect((await h.api("PUT", "/api/config", { vps: { sshAlias: "fixture-vps", mode: "shared", independentScreens: false } })).status).toBe(200);
    const before = 0;
    const first = (await h.api("POST", "/api/bots", { name: "Shared first" })).body.bot;
    const second = (await h.api("POST", "/api/bots", { name: "Shared second" })).body.bot;
    const third = (await h.api("POST", "/api/bots", { name: "Shared third" })).body.bot;
    const bots = [first, second, third];
    for (const bot of bots) expect((await h.api("POST", `/api/bots/${bot.id}/messages`, { text: `Ordinary greeting for ${bot.name}` })).status).toBe(202);
    const initial = await Promise.all(bots.map(bot => h.launched(bot.threadId)));
    expect(readFileSync(h.vps.calls, "utf8").slice(before)).toBe("");
    for (const turn of initial) {
      expect(turn.mcpConfig.mcpServers.computer).toBeUndefined();
      expect(turn.mcpConfig.mcpServers.browser).toBeUndefined();
    }
    for (let i = 0; i < bots.length; i++) {
      const selected = await h.api("POST", "/api/internal/computer/select", { surface: "cloud" }, initial[i].mcpConfig.mcpServers.agents.env.MADANI_COMMS_TOKEN);
      expect(selected, JSON.stringify(selected.body)).toMatchObject({ status: 200, body: { status: "pending", surface: "cloud" } });
      h.release(initial[i].pid);
    }
    const mounted = await Promise.all(bots.map(bot => h.launched(bot.threadId, turn => Boolean(turn.mcpConfig.mcpServers.computer))));
    const computers = mounted.map(turn => turn.mcpConfig.mcpServers.computer);
    expect(computers[0].args).toEqual(computers[1].args);
    expect(computers[0].args).toEqual(computers[2].args);
    expect(new Set(computers.map(computer => computer.env.MADANI_CONTROL_TOKEN)).size).toBe(3);
    for (let i = 0; i < bots.length; i++) {
      expect(new URL(computers[i].env.MADANI_CONTROL_URL).searchParams.get("botId")).toBe(bots[i].id);
    }
    const control = async (computer: any, botId?: string) => {
      const url = new URL(computer.env.MADANI_CONTROL_URL);
      if (botId) url.searchParams.set("botId", botId);
      const response = await fetch(url, { headers: { authorization: `Bearer ${computer.env.MADANI_CONTROL_TOKEN}` }, signal: AbortSignal.timeout(15_000) });
      return { status: response.status, body: await response.json() as any };
    };
    expect((await control(computers[0])).body).toMatchObject({ held: false });
    expect((await control(computers[0], second.id)).status).toBe(403);
    const waiting: Array<Promise<Awaited<ReturnType<typeof control>>>> = [];
    for (const i of [1, 2]) {
      waiting.push(control(computers[i]));
      void waiting.at(-1)!.catch(() => {});
      await expect.poll(async () => {
        const rows = (await h.api("GET", `/api/threads/${bots[i].threadId}/messages?limit=100`)).body.messages as any[];
        return rows.some(row => row.tool?.name?.startsWith("Waiting for its turn on this computer") && row.tool.name.includes(`${i}${i === 1 ? "st" : "nd"} in queue`));
      }, { timeout: 10_000, interval: 30 }).toBe(true);
    }
    expect((await h.api("PATCH", "/api/config", { vps: { mode: "per-bot" } })).status).toBe(409);
    await h.stop(second.id, second.threadId);
    const cancelled = await waiting[0];
    expect(cancelled.status === 401 || cancelled.body.held === true).toBe(true);
    await h.stop(first.id, first.threadId);
    expect((await waiting[1]).body).toMatchObject({ held: false });
    expect((await control(computers[0])).status).toBe(401);
    expect((await control(computers[1])).status).toBe(401);
    await h.stop(third.id, third.threadId);
    const preferences = await h.api("PATCH", "/api/config", { vps: { autoStart: false } });
    expect(preferences, JSON.stringify(preferences.body)).toMatchObject({ status: 200 });
    expect(JSON.parse(readFileSync(join(h.fixture.info.dataDir, "config.json"), "utf8")).vps).toMatchObject({ sshAlias: "fixture-vps", mode: "shared", autoStart: false });
    expect((await h.api("PATCH", "/api/config", { vps: { mode: "per-bot" } })).status).toBe(200);
    const own = await Promise.all(bots.map(bot => h.api("GET", `/api/bots/${bot.id}/computer`)));
    expect(own[0].body.container_name).not.toBe(own[1].body.container_name);
  } finally { await h.close(); }
}, 60_000);

it.skipIf(process.platform === "win32")("withdraws a cancelled shared setup before a held Docker probe can wake it and releases the lifecycle guard", async () => {
  const h = await harness();
  try {
    expect((await h.api("PUT", "/api/config", { vps: { sshAlias: "fixture-vps", mode: "shared" } })).status).toBe(200);
    const bot = (await h.api("POST", "/api/bots", { name: "Cancelled shared setup" })).body.bot;
    expect((await h.api("PATCH", `/api/bots/${bot.id}`, { computer: "cloud" })).status).toBe(200);
    writeFileSync(h.vps.hold, "hold");
    const before = readFileSync(h.vps.calls, "utf8").length;
    expect((await h.api("POST", `/api/bots/${bot.id}/messages`, { text: "Start work, then stop while the VPS is being inspected" })).status).toBe(202);
    await expect.poll(() => existsSync(`${h.vps.hold}.started`), { timeout: 10_000, interval: 30 }).toBe(true);
    expect((await h.api("PATCH", "/api/config", { vps: { mode: "per-bot" } })).status).toBe(409);
    expect((await h.api("PATCH", `/api/bots/${bot.id}`, { computer: "off" })).status).toBe(409);
    expect((await h.api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })).status).toBe(200);
    rmSync(h.vps.hold, { force: true });
    await h.idle(bot.id, bot.threadId);
    const calls = readFileSync(h.vps.calls, "utf8").slice(before).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]);
    expect(calls.some(args => args.includes("start") || args.includes("run"))).toBe(false);
    expect(h.dump(bot.threadId)).toBe(null);
    expect((await h.api("PATCH", "/api/config", { vps: { mode: "per-bot" } })).status).toBe(200);
    expect((await h.api("DELETE", `/api/bots/${bot.id}`)).status).toBe(200);
  } finally { await h.close(); }
}, 60_000);

it.skipIf(process.platform === "win32")("provisions a missing shared VPS only after a live tool selection and releases its preparation after Stop", async () => {
  const h = await harness({ missingInitially: true, screens: true });
  try {
    expect((await h.api("PUT", "/api/config", { vps: { sshAlias: "fixture-vps", mode: "shared", autoStart: true } })).status).toBe(200);
    const before = readFileSync(h.vps.calls, "utf8").length;
    const bot = (await h.api("POST", "/api/bots", { name: "Create only when selected" })).body.bot;
    expect((await h.api("POST", `/api/bots/${bot.id}/messages`, { text: "Say hello before choosing a computer" })).status).toBe(202);
    const first = await h.launched(bot.threadId);
    expect(readFileSync(h.vps.calls, "utf8").slice(before)).toBe("");
    const token = first.mcpConfig.mcpServers.agents.env.MADANI_COMMS_TOKEN;
    const inspect = await h.api("GET", "/api/internal/computer/select", undefined, token);
    expect(inspect.body.options.find((option: any) => option.surface === "cloud")).toMatchObject({ ready: false, canCreate: true });
    expect(readFileSync(h.vps.calls, "utf8").slice(before)).not.toMatch(/"run"/);
    expect((await h.api("POST", "/api/internal/computer/select", { surface: "cloud" }, token)).body).toMatchObject({ status: "pending" });
    h.release(first.pid);
    await h.launched(bot.threadId, turn => Boolean(turn.mcpConfig.mcpServers.computer));
    const calls = readFileSync(h.vps.calls, "utf8").slice(before).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]);
    expect(calls.filter(args => args.includes("run"))).toHaveLength(1);
    await h.stop(bot.id, bot.threadId);
    expect((await h.api("PATCH", "/api/config", { vps: { mode: "per-bot" } })).status).toBe(200);
  } finally { await h.close(); }
}, 60_000);

it.skipIf(process.platform === "win32")("never wakes a bot's own VPS computer for a plain reply, only after the bot selects it", async () => {
  const h = await harness({ missingInitially: true });
  try {
    expect((await h.api("PUT", "/api/config", { vps: { sshAlias: "fixture-vps", mode: "per-bot", autoStart: true } })).status).toBe(200);
    for (const name of ["Lazy own desktop one", "Lazy own desktop two"]) {
      const before = readFileSync(h.vps.calls, "utf8").length;
      const bot = (await h.api("POST", "/api/bots", { name })).body.bot;
      expect((await h.api("POST", `/api/bots/${bot.id}/messages`, { text: "Just say hello" })).status).toBe(202);
      const first = await h.launched(bot.threadId);
      expect(first.mcpConfig.mcpServers.computer).toBeUndefined();
      expect(readFileSync(h.vps.calls, "utf8").slice(before)).not.toMatch(/"(?:run|start)"/);
      const token = first.mcpConfig.mcpServers.agents.env.MADANI_COMMS_TOKEN;
      expect((await h.api("POST", "/api/internal/computer/select", { surface: "cloud" }, token)).body).toMatchObject({ status: "pending" });
      // it starts while this turn is still ending, not after: the continuation joins that same start
      await expect.poll(() => readFileSync(h.vps.calls, "utf8").slice(before).includes('"run"'), { timeout: 10_000 }).toBe(true);
      h.release(first.pid);
      const second = await h.launched(bot.threadId, turn => Boolean(turn.mcpConfig.mcpServers.computer));
      const calls = readFileSync(h.vps.calls, "utf8").slice(before).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]);
      expect(calls.filter(args => args.includes("run"))).toHaveLength(1);
      h.release(second.pid); await h.idle(bot.id, bot.threadId);
    }
  } finally { await h.close(); }
}, 90_000);

it.skipIf(process.platform !== "darwin")("never moves an unavailable cloud destination onto a synthetic host connection that is available", async () => {
  const h = await harness({ host: true, missingInitially: true });
  try {
    expect((await h.api("PUT", "/api/config", { vps: { sshAlias: "fixture-vps", mode: "shared", autoStart: false } })).status).toBe(200);
    const local = (await h.api("POST", "/api/bots", { name: "Synthetic local control" })).body.bot;
    expect((await h.api("PATCH", `/api/bots/${local.id}`, { computer: "local" })).status).toBe(200);
    expect((await h.api("POST", `/api/bots/${local.id}/messages`, { text: "Hold with the synthetic local connection" })).status).toBe(202);
    const host = await h.launched(local.threadId);
    expect(host.mcpConfig.mcpServers.computer.env.MADANI_CUA_COMMAND).toBe(process.execPath);
    h.release(host.pid); await h.idle(local.id, local.threadId);
    const cloud = (await h.api("POST", "/api/bots", { name: "Cloud must stay cloud" })).body.bot;
    expect((await h.api("PATCH", `/api/bots/${cloud.id}`, { computer: "cloud" })).status).toBe(200);
    const before = readFileSync(h.vps.calls, "utf8").length;
    expect((await h.api("POST", `/api/bots/${cloud.id}/messages`, { text: "Work only on the cloud computer" })).status).toBe(202);
    // a Works on Cloud turn whose VPS can't be prepared goes on with no computer (6c14850881), never this Mac's
    const sent = await h.launched(cloud.threadId);
    expect(sent.mcpConfig.mcpServers.computer).toBeUndefined();
    h.release(sent.pid); await h.idle(cloud.id, cloud.threadId);
    expect(readFileSync(h.vps.calls, "utf8").slice(before)).not.toMatch(/"(?:run|start)"/);
  } finally { await h.close(); }
}, 60_000);

it.skipIf(process.platform !== "darwin")("keeps fresh native Auto chat on its synthetic local connection without probing Docker when no VPS is configured", async () => {
  const h = await harness({ host: true });
  try {
    const before = 0;
    const bot = (await h.api("POST", "/api/bots", { name: "Fresh native Auto" })).body.bot;
    expect((await h.api("POST", `/api/bots/${bot.id}/messages`, { text: "Hello, what can you help with?" })).status).toBe(202);
    const turn = await h.launched(bot.threadId);
    expect(turn.mcpConfig.mcpServers.computer.env.MADANI_CUA_COMMAND).toBe(process.execPath);
    expect(readFileSync(h.vps.calls, "utf8").slice(before)).toBe("");
    h.release(turn.pid); await h.idle(bot.id, bot.threadId);
  } finally { await h.close(); }
}, 60_000);

it.skipIf(process.platform === "win32")("withdraws implicit workspace sharing when sign-in admits another person without deleting its retained computer", async () => {
  const h = await harness();
  try {
    expect((await h.api("PUT", "/api/config", { vps: { sshAlias: "fixture-vps", mode: "shared" } })).status).toBe(200);
    const bots = await Promise.all(["First private person", "Second private person"].map(async name => (await h.api("POST", "/api/bots", { name })).body.bot));
    const before = await Promise.all(bots.map(bot => h.api("GET", `/api/bots/${bot.id}/computer`)));
    expect(before[0].body.teamComputer.id).toBe(before[1].body.teamComputer.id);
    const shared = before[0].body.container_name;
    expect((await h.api("PATCH", "/api/config", { signIn: { members: ["member@fixture.test"] } })).status).toBe(200);
    const after = await Promise.all(bots.map(bot => h.api("GET", `/api/bots/${bot.id}/computer`)));
    for (const target of after) {
      expect(target.body.teamComputer).toBeUndefined();
      expect(target.body.container_name).not.toBe(shared);
    }
    expect(after[0].body.container_name).not.toBe(after[1].body.container_name);
    const retained = JSON.parse(readFileSync(join(h.fixture.info.dataDir, "team-computers.json"), "utf8"));
    expect(retained.computers.some((computer: any) => computer.id === before[0].body.teamComputer.id)).toBe(true);
  } finally { await h.close(); }
}, 60_000);

it.skipIf(process.platform === "win32")("keeps the private default bots of two authenticated Team Cloud people on distinct VPS targets", async () => {
  const vps = await createTeamVpsFixture();
  let fixture: Awaited<ReturnType<typeof launchCloudSendFixture>> | undefined;
  try {
    fixture = await launchCloudSendFixture({ onePasswordToken: "synthetic-vps-concurrency-token",
      team: { id: "team-vps-privacy", name: "VPS privacy", env: { MADANI_EXTRA_PATH: vps.localVm.binDir } } });
    const team = fixture.team!;
    const owner = await team.pair({ email: "owner@privacy.test", role: "owner" });
    const member = await team.pair({ email: "member@privacy.test", role: "member" });
    expect(owner.status).toBe(200); expect(member.status).toBe(200);
    expect((await team.as(owner.token!, "PUT", "/api/config", { vps: { sshAlias: "fixture-vps", mode: "shared" } })).status).toBe(200);
    const ownerBots = (await team.as(owner.token!, "GET", "/api/bots?messages=0")).body.bots;
    const memberBots = (await team.as(member.token!, "GET", "/api/bots?messages=0")).body.bots;
    const own = ownerBots.find((bot: any) => bot.defaultBot?.person === "owner@privacy.test");
    const other = memberBots.find((bot: any) => bot.defaultBot?.person === "member@privacy.test");
    expect(own).toBeTruthy(); expect(other).toBeTruthy(); expect(own.id).not.toBe(other.id);
    for (const bot of [own, other]) expect((await team.as(member.token!, "GET", `/api/bots/${bot.id}/computer`)).status).toBe(403);
    const before = readFileSync(vps.calls, "utf8").length;
    for (const bot of [own, other]) {
      const capability = await team.capability(bot.id, bot.threadId);
      const response = await fetch(team.base + "/api/internal/computer/select", { headers: { authorization: `Bearer ${capability}` }, signal: AbortSignal.timeout(15_000) });
      const options = { status: response.status, body: await response.json() as any };
      expect(options.status, JSON.stringify(options.body)).toBe(200);
      expect(options.body.options.some((option: any) => option.surface === "cloud" && option.available)).toBe(true);
    }
    const calls = readFileSync(vps.calls, "utf8").slice(before).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]);
    const inspected = calls.filter(args => args.includes("inspect")).map(args => args.at(-1));
    expect(inspected).toContain(vpsContainerName(own.id));
    expect(inspected).toContain(vpsContainerName(other.id));
    expect(inspected.some(name => name?.startsWith(`${DOCKER_NAMES.vpsPrefix}-computer-`))).toBe(false);
  } finally { await fixture?.close(); await vps.close(); }
}, 60_000);

it.skipIf(process.platform === "win32")("rejects malformed internal computer and memory payloads without server errors or losing a live turn", async () => {
  const h = await harness();
  try {
    const bot = (await h.api("POST", "/api/bots", { name: "Payload stress" })).body.bot;
    expect((await h.api("PATCH", `/api/bots/${bot.id}`, { computer: "off" })).status).toBe(200);
    expect((await h.api("POST", `/api/bots/${bot.id}/messages`, { text: "Hold while malformed payloads are rejected" })).status).toBe(202);
    const turn = await h.launched(bot.threadId);
    const token = turn.mcpConfig.mcpServers.agents.env.MADANI_COMMS_TOKEN;
    const cases = [
      ...[null, [], true, 42, "cloud"].flatMap(body => ["/api/internal/computer/select", "/api/internal/memory", "/api/internal/memory/log"].map(path => [path, body] as const)),
      ["/api/internal/computer/select", { surface: { toString: "cloud" } }],
      [`/api/bots/${bot.id}/tasks`, null], [`/api/bots/${bot.id}/messages`, null],
    ] as const;
    const results = await Promise.all(cases.map(async ([path, body]) => {
      const response = await h.api("POST", path, body, path.startsWith("/api/internal/") ? token : undefined);
      return { path, body, status: response.status };
    }));
    expect(results.filter(result => result.status >= 500), JSON.stringify(results)).toEqual([]);
    expect(results.every(result => result.status >= 400), JSON.stringify(results)).toBe(true);
    expect((await h.api("GET", "/api/health")).status).toBe(200);
    expect((await h.tasks(bot.id)).find(task => task.threadId === bot.threadId)?.busy).toBe(true);
    h.release(turn.pid); await h.idle(bot.id, bot.threadId);
  } finally { await h.close(); }
}, 60_000);

it.skipIf(process.platform === "win32")("keeps independent bot screens parallel, serializes one bot, cancels the fifth waiter and revokes a reclaimed viewer", async () => {
  const h = await harness({ screens: true });
  let viewer: WebSocket | undefined;
  const calls = () => readFileSync(h.vps.calls, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]);
  const control = async (computer: any) => {
    const response = await fetch(computer.env.MADANI_CONTROL_URL, {
      headers: { authorization: `Bearer ${computer.env.MADANI_CONTROL_TOKEN}` }, signal: AbortSignal.timeout(20_000),
    });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    expect((await h.api("PUT", "/api/config", { vps: { sshAlias: "fixture-vps", mode: "shared", independentScreens: true, maxScreens: 4, idleTimeoutMinutes: 0 } })).status).toBe(200);
    const bots: any[] = [];
    const mounted: any[] = [];
    const screens: any[] = [];
    for (let i = 0; i < 4; i++) {
      const bot = (await h.api("POST", "/api/bots", { name: `Independent ${i + 1}` })).body.bot;
      bots.push(bot);
      expect((await h.api("PATCH", `/api/bots/${bot.id}`, { computer: "cloud" })).status).toBe(200);
      expect((await h.api("POST", `/api/bots/${bot.id}/messages`, { text: `Work on independent screen ${i + 1}` })).status).toBe(202);
      const turn = await h.launched(bot.threadId);
      const computer = turn.mcpConfig.mcpServers.computer;
      expect(computer).toBeTruthy();
      mounted.push(computer); screens.push(JSON.parse(computer.args.at(-1)));
    }
    expect(new Set(mounted.map(computer => computer.args.at(-2))).size).toBe(1);
    expect(new Set(mounted.map(computer => computer.env.MADANI_CONTROL_TOKEN)).size).toBe(4);
    for (const key of ["display", "socket", "chromiumProfile", "generation"]) expect(new Set(screens.map(screen => screen[key])).size, key).toBe(4);
    expect(screens.map(screen => screen.display).sort()).toEqual([2, 3, 4, 5]);
    for (let i = 0; i < bots.length; i++) {
      expect(screens[i].botId).toBe(bots[i].id);
      expect(screens[i].chromiumProfile).toContain(screens[i].botHash);
      expect(screens[i].socket).toBe(`/run/user/1000/omb-screens/${screens[i].display}/cua.sock`);
      expect((await control(mounted[i])).body).toMatchObject({ held: false });
    }
    const sameTask = (await h.api("POST", `/api/bots/${bots[0].id}/tasks`, { title: "Same bot next turn", select: false })).body.task.threadId;
    expect((await h.api("POST", `/api/bots/${bots[0].id}/messages`, { text: "Wait for this bot's own screen", threadId: sameTask })).status).toBe(202);
    const same = (await h.launched(sameTask)).mcpConfig.mcpServers.computer;
    expect(JSON.parse(same.args.at(-1))).toEqual(screens[0]);
    const waiting = control(same); void waiting.catch(() => {});
    await expect.poll(async () => {
      const messages = (await h.api("GET", `/api/threads/${sameTask}/messages?limit=100`)).body.messages as any[];
      return messages.some(message => message.tool?.name?.startsWith("Waiting for its turn on this computer"));
    }, { timeout: 10_000, interval: 30 }).toBe(true);

    const watched = bots[2];
    const joined = await h.api("POST", `/api/bots/${watched.id}/computer/join?viewer=proxy`, {});
    expect(joined.status, JSON.stringify(joined.body)).toBe(200);
    viewer = new WebSocket(h.fixture.info.url.replace(/^http/, "ws") + `/api/desktop-viewer/vps/${watched.id}/websockify`, { origin: h.fixture.info.url });
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("Independent viewer handshake timed out")), 5_000);
      viewer!.once("error", error => { clearTimeout(deadline); reject(error); });
      viewer!.once("message", raw => { clearTimeout(deadline); expect(raw.toString()).toBe("RFB 003.008\n"); resolve(); });
    });
    let viewerClosed = false;
    viewer.once("close", () => { viewerClosed = true; });

    const fifth = (await h.api("POST", "/api/bots", { name: "Cancelled fifth screen" })).body.bot;
    await h.api("PATCH", `/api/bots/${fifth.id}`, { computer: "cloud" });
    const probes = calls().filter(args => args.some(arg => arg.includes("health_report"))).length;
    expect((await h.api("POST", `/api/bots/${fifth.id}/messages`, { text: "Queue behind the four occupied screens" })).status).toBe(202);
    await expect.poll(() => calls().filter(args => args.some(arg => arg.includes("health_report"))).length, { timeout: 10_000, interval: 30 }).toBeGreaterThan(probes);
    expect(h.dump(fifth.threadId)).toBe(null);
    expect((await h.tasks(fifth.id)).find(task => task.threadId === fifth.threadId)?.busy).toBe(true);
    await h.stop(fifth.id, fifth.threadId);

    await h.stop(bots[0].id, bots[0].threadId);
    expect((await waiting).body).toMatchObject({ held: false });
    expect((await control(mounted[0])).status).toBe(401);
    const sixth = (await h.api("POST", "/api/bots", { name: "Reclaimed screen" })).body.bot;
    await h.api("PATCH", `/api/bots/${sixth.id}`, { computer: "cloud" });
    expect((await h.api("POST", `/api/bots/${sixth.id}/messages`, { text: "Take the next free independent screen" })).status).toBe(202);
    await h.stop(watched.id, watched.threadId);
    const replacement = (await h.launched(sixth.threadId)).mcpConfig.mcpServers.computer;
    const reclaimed = JSON.parse(replacement.args.at(-1));
    expect(reclaimed.display).toBe(screens[2].display);
    expect(reclaimed.generation).not.toBe(screens[2].generation);
    expect(reclaimed.chromiumProfile).not.toBe(screens[2].chromiumProfile);
    await expect.poll(() => viewerClosed, { timeout: 1_500, interval: 20 }).toBe(true);
    expect((await h.api("GET", `/api/desktop-viewer/vps/${watched.id}`)).status).toBe(404);
    expect(h.dump(fifth.threadId)).toBe(null);
    expect((await control(replacement)).body).toMatchObject({ held: false });
    const ensured = calls().filter(args => args.includes("ensure"));
    expect(ensured).toHaveLength(5);
    expect(new Set(ensured.map(args => args[args.indexOf("ensure") + 2])).size).toBe(5);
    expect(calls().some(args => args.includes("python3") && args.includes("-I"))).toBe(false);
    await h.stop(bots[0].id, sameTask);
    for (const bot of [bots[1], bots[3], sixth]) await h.stop(bot.id, bot.threadId);
    expect((await h.api("PATCH", "/api/config", { vps: { independentScreens: false } })).status).toBe(200);
  } finally { viewer?.terminate(); await h.close(); }
}, 90_000);

it.skipIf(process.platform === "win32")("defaults to twenty independent screens in one computer and bounds a cancelled twenty-first request", async () => {
  const h = await harness({ screens: true });
  let stream: Awaited<ReturnType<typeof openSse>> | undefined;
  try {
    const saved = await h.api("PATCH", "/api/config", { vps: { sshAlias: "fixture-vps", idleTimeoutMinutes: 0 } });
    expect(saved.body.vps).toMatchObject({ independentScreens: true, maxScreens: 20 });
    const untouched = (await h.api("POST", "/api/bots", { name: "Unopened screen" })).body.bot;
    stream = await openSse(h.fixture.info.url + "/api/events");
    const bots: any[] = [];
    const wakes: any[] = [];
    for (let i = 0; i < 20; i++) {
      const bot = (await h.api("POST", "/api/bots", { name: `Twenty screens ${i + 1}` })).body.bot;
      bots.push(bot);
      expect((await h.api("PATCH", `/api/bots/${bot.id}`, { computer: "cloud" })).status).toBe(200);
      const awake = await h.api("POST", `/api/bots/${bot.id}/computer/provision`, {});
      expect(awake.status, JSON.stringify(awake.body)).toBe(200);
      wakes.push(awake.body);
      expect((await h.api("POST", `/api/bots/${bot.id}/computer/control`, { action: "take" })).body.held).toBe(true);
    }
    expect(new Set(wakes.map(wake => wake.resourceKey)).size).toBe(1);
    expect(new Set(wakes.map(wake => wake.viewerKey)).size).toBe(20);
    expect((await h.api("GET", `/api/bots/${untouched.id}/computer`)).body).toMatchObject({ ready: false, state: "stopped" });
    expect(stream.frames.some(frame => frame.kind === "computer-state" && frame.botId === untouched.id && ["starting", "ready"].includes(frame.state))).toBe(false);
    expect((await h.api("PATCH", "/api/config", { vps: { maxScreens: 15 } })).status).toBe(409);
    const overflow = (await h.api("POST", "/api/bots", { name: "Twenty-first screen" })).body.bot;
    await h.api("PATCH", `/api/bots/${overflow.id}`, { computer: "cloud" });
    const probes = readFileSync(h.vps.calls, "utf8").split("\n").filter(line => line.includes("health_report")).length;
    const cancel = new AbortController();
    const pending = fetch(`${h.fixture.info.url}/api/bots/${overflow.id}/computer/provision`, {
      method: "POST", headers: { "content-type": "application/json", origin: h.fixture.info.url }, body: "{}", signal: cancel.signal,
    });
    void pending.catch(() => {});
    await expect.poll(() => readFileSync(h.vps.calls, "utf8").split("\n").filter(line => line.includes("health_report")).length, { timeout: 5_000, interval: 30 }).toBeGreaterThan(probes);
    await expect.poll(async () => (await h.api("GET", `/api/bots/${overflow.id}/computer`)).body.state, { timeout: 5_000, interval: 30 }).toBe("stopped");
    cancel.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    for (const bot of bots) expect((await h.api("POST", `/api/bots/${bot.id}/computer/control`, { action: "release" })).body.held).toBe(false);
    await expect.poll(async () => (await h.api("PATCH", "/api/config", { vps: { maxScreens: 15 } })).status, { timeout: 5_000, interval: 40 }).toBe(200);
    expect((await h.api("GET", "/api/config")).body.vps).toMatchObject({ independentScreens: true, maxScreens: 15 });
    const calls = readFileSync(h.vps.calls, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]);
    const ensured = calls.filter(args => args.includes("ensure"));
    expect(ensured).toHaveLength(20);
    expect(ensured.map(args => Number(args[args.indexOf("ensure") + 1])).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 2));
  } finally { stream?.close(); await h.close(); }
}, 90_000);
