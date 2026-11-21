import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-madani.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

it("keeps a real routine waiting until both concurrent broker approvals settle and cancels it once", async () => {
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "hang" });
  let socket: Socket | undefined;
  const { url, dataDir } = fixture.info;
  const api = async (method: string, path: string, body?: unknown, expected = 200) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url }, signal: AbortSignal.timeout(hostTimeout(15_000)),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(expected);
    return value;
  };
  try {
    const bot = (await api("POST", "/api/bots", { name: "Parallel fixture" }, 201)).bot;
    const dump = join(dataDir, "fixture-turn.json");
    const wrapper = join(dataDir, "fixture-engine.mjs");
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      `process.env.FAKE_CLAUDE_DUMP = ${JSON.stringify(dump)};`,
      `await import(${JSON.stringify(new URL("./testing/fake-claude-cli.ts", import.meta.url).href)});`,
    ].join("\n"), { mode: 0o700 });
    await api("PATCH", "/api/instances/claude", { cli: wrapper });
    await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask" });
    const input = { name: "Parallel approvals", prompt: "Run fixture actions", botId: bot.id, timeoutMinutes: 5, schedule: { type: "daily", time: "23:59", weekdays: [0, 1, 2, 3, 4, 5, 6] } };
    for (const at of [8_640_000_000_000_001, -1, 0.5]) await api("POST", "/api/routines", { ...input, schedule: { type: "once", at } }, 400);
    const { routine } = await api("POST", "/api/routines", input, 201);
    await api("POST", `/api/routines/${routine.id}/run`, undefined, 201);
    const run = async () => (await api("GET", "/api/routines")).runs.find((candidate: any) => candidate.routineId === routine.id);
    await expect.poll(() => existsSync(dump), { timeout: hostTimeout(15_000) }).toBe(true);
    const launch = JSON.parse(readFileSync(dump, "utf8"));
    socket = connect(launch.mcpConfig.mcpServers.madani.args.at(-1));
    await new Promise<void>((resolve, reject) => { socket!.once("connect", resolve); socket!.once("error", reject); });
    const answers: Array<{ id: string; behavior: string }> = [];
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (line) answers.push(JSON.parse(line));
      }
    });
    const first = randomUUID(), second = randomUUID();
    socket.write(`${JSON.stringify({ t: "ask", id: first, tool: "mcp__fixture__first_action", input: { message: "first fixture request" } })}\n`);
    socket.write(`${JSON.stringify({ t: "ask", id: second, tool: "mcp__fixture__second_action", input: { message: "second fixture request" } })}\n`);
    await expect.poll(run, { timeout: hostTimeout(15_000) }).toMatchObject({ status: "waiting", asked: { requestId: first, pending: [{ requestId: second }] } });
    const waiting = await run();
    await api("POST", `/api/threads/${waiting.threadId}/respond`, { requestId: first, behavior: "allow" });
    await expect.poll(run, { timeout: hostTimeout(15_000) }).toMatchObject({ status: "waiting", asked: { requestId: second }, attention: "Waiting for your approval to use second_action" });
    await api("POST", `/api/threads/${waiting.threadId}/respond`, { requestId: second, behavior: "deny" });
    await expect.poll(run, { timeout: hostTimeout(15_000) }).toMatchObject({ status: "running" });
    expect((await run()).asked).toBeUndefined();
    await expect.poll(() => answers, { timeout: hostTimeout(15_000) }).toEqual(expect.arrayContaining([expect.objectContaining({ id: first, behavior: "allow" }), expect.objectContaining({ id: second, behavior: "deny" })]));
    await api("POST", `/api/routine-runs/${waiting.id}/cancel`);
    await expect.poll(run, { timeout: hostTimeout(15_000) }).toMatchObject({ status: "cancelled" });
    expect((await api("GET", "/api/routines")).runs).toHaveLength(1);
  } finally {
    socket?.destroy();
    await fixture.close();
  }
}, hostTimeout(60_000));
