import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, verificationServerEnvironment } from "../scripts/control-madani.ts";
import { waitForExit } from "./testing/cleanup.ts";

const PROBE_MS = 1_500;
// The owner's "hi" took 6.9 s to be answered: a bot with no AI chosen waited for the start-up read of every engine, then
// had every engine probed all over again. One read is enough; the second only doubled the wait.
it("a first send during the start-up read waits on that read once, never on a second probe of every engine", async () => {
  const fixture = await launchVerificationServer();
  const { dataDir, url, logPath } = fixture.info;
  let server: ChildProcess | undefined;
  try {
    const probes = join(dataDir, "probe-log");
    const botsPath = join(dataDir, "bots.json"), configPath = join(dataDir, "config.json"), slowCli = join(dataDir, "slow-claude.mjs");
    writeFileSync(slowCli, ["#!/usr/bin/env node",
      `process.env.FAKE_CLAUDE_PROBE_LOG = ${JSON.stringify(probes)};`,
      `const probe = process.argv.some((a) => a === "--version" || a === "--help" || a === "auth");`,
      `if (probe) await new Promise((r) => setTimeout(r, ${PROBE_MS}));`,
      `await import(${JSON.stringify(new URL("./testing/fake-claude-cli.ts", import.meta.url).href)});`].join("\n"), { mode: 0o700 });
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const bots = JSON.parse(readFileSync(botsPath, "utf8"));
    bots[0].modelSelection = { instanceId: "", model: "" };
    writeFileSync(botsPath, JSON.stringify(bots));
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances.claude = { ...config.instances.claude, config: { ...config.instances.claude.config, cli: slowCli } };
    writeFileSync(configPath, JSON.stringify(config));
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log] });
    closeSync(log);
    await expect.poll(async () => { try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; } }, { timeout: 20_000, interval: 50 }).toBe(true);
    const bot = bots[0];
    const threadId = bot.threadId;
    const t0 = Date.now();
    const res = await fetch(`${url}/api/bots/${bot.id}/messages`, { method: "POST", headers: { "content-type": "application/json", origin: url },
      body: JSON.stringify({ text: "hi", threadId, sendId: randomUUID() }), signal: AbortSignal.timeout(60_000) });
    const postMs = Date.now() - t0;
    let replyMs = -1;
    await expect.poll(async () => {
      const page = await (await fetch(`${url}/api/threads/${threadId}/messages?limit=20`, { headers: { origin: url } })).json() as { messages?: Array<{ role: string; kind: string; at: number }> };
      const reply = page.messages?.findLast((m) => m.role === "bot" && m.kind === "text" && m.at >= t0);
      if (reply && replyMs < 0) replyMs = Date.now() - t0;
      return Boolean(reply);
    }, { timeout: 60_000, interval: 25 }).toBe(true);
    if (process.env.MEASURE_OUT) appendFileSync(process.env.MEASURE_OUT, JSON.stringify({ probeMs: PROBE_MS, status: res.status, postMs, firstReplyMs: replyMs }) + "\n");
    expect(res.status).toBe(202);
    const kinds = readFileSync(probes, "utf8").trim().split("\n").map((line) => line.split(" ")[0]);
    for (const kind of new Set(kinds)) expect(kinds.filter((one) => one === kind), `${kind} probes`).toHaveLength(1);
    // one start-up read of three 1.5 s probes; probing again took it past 7.8 s
    expect(postMs).toBeLessThan(PROBE_MS * 3 + 2_500);
  } finally {
    await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 120_000);
