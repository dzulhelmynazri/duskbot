import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

import { runControlMadani } from "../scripts/control-madani.ts";
import { launchRestartableServer } from "./testing/restartable-server.ts";
import { openSse, type SseRecorder } from "./testing/sse.ts";

it("serves the engine list while new engines are probing, publishes progress and lets a ready bot answer", async () => {
  const fixture = await launchRestartableServer();
  const { url, dataDir, logPath } = fixture;
  let events: SseRecorder | undefined;
  const api = async (path: string, timeoutMs = 10_000): Promise<any> => {
    const response = await fetch(url + path, { headers: { origin: url }, signal: AbortSignal.timeout(timeoutMs) });
    expect(response.ok).toBe(true);
    return response.json();
  };
  const control = (...args: string[]) => runControlMadani([...args, "--url", url]) as Promise<any>;
  try {
    const bot = (await api("/api/bots")).bots[0];
    await fixture.stop();
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const gates = ["slow", "tail"].map((id) => {
      const release = join(dataDir, `${id}-release`);
      const probes = join(dataDir, `${id}-probes`);
      const cli = join(dataDir, `${id}-cli.mjs`);
      writeFileSync(cli, `#!/usr/bin/env node\nawait import(${JSON.stringify(new URL("./testing/fake-claude-cli.ts", import.meta.url).href)});\n`, { mode: 0o700 });
      config.instances[id] = {
        driver: "claudeAgent", displayName: id, config: { cli },
        environment: { FAKE_CLAUDE_PROBE_LOG: probes, FAKE_CLAUDE_HOLD_VERSION: release },
      };
      return { id, probes, release };
    });
    writeFileSync(configPath, JSON.stringify(config));
    const restarted = performance.now();
    await fixture.start();
    const startupMs = performance.now() - restarted;
    await expect.poll(() => existsSync(gates[0].probes), { timeout: 10_000 }).toBe(true);
    events = await openSse(url + "/api/events", { origin: url });
    const requested = performance.now();
    const initial = (await api("/api/instances", 3_000)).instances;
    const engineListMs = performance.now() - requested;
    for (const { id } of gates) expect(initial.find((engine: any) => engine.instanceId === id).snapshot)
      .toEqual({ state: "unavailable", reason: "Checking engine status" });

    await control("send", "--bot", bot.id, "--task", bot.threadId, "--text", "READY_BOT_DURING_STARTUP_K6");
    expect((await control("wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "20")).status).toBe("settled");
    expect((await api(`/api/threads/${bot.threadId}/messages?limit=20`)).messages.some((message: any) =>
      message.role === "bot" && message.kind === "text" && message.turnSucceeded === true)).toBe(true);

    const observedAt = events.frames.length;
    writeFileSync(gates[0].release, "ready");
    await events.until((frame) => events!.frames.indexOf(frame) >= observedAt && frame.kind === "config");
    const progressing = (await api("/api/instances", 3_000)).instances;
    expect(progressing.find((engine: any) => engine.instanceId === "slow").snapshot.state).toBe("available");
    expect(progressing.find((engine: any) => engine.instanceId === "tail").snapshot)
      .toEqual({ state: "unavailable", reason: "Checking engine status" });

    writeFileSync(gates[1].release, "ready");
    await expect.poll(async () => (await api("/api/instances", 3_000)).instances.find((engine: any) =>
      engine.instanceId === "tail").snapshot.state, { timeout: 10_000 }).toBe("available");
    console.info(JSON.stringify({ startupMs: Math.round(startupMs), engineListMs: Math.round(engineListMs), logPath }));
  } finally {
    events?.close();
    for (const id of ["slow", "tail"]) writeFileSync(join(dataDir, `${id}-release`), "cleanup");
    await fixture.close();
  }
}, 60_000);
