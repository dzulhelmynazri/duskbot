import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-madani.ts";
import { createTeamVpsFixture } from "../scripts/testing/team-vps-fixture.ts";
import { createControlClient } from "./control-client.ts";
import { vpsContainerName } from "./vps-computer.ts";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function harness(slow = false) {
  const vps = await createTeamVpsFixture();
  let fixture: VerificationServer;
  try {
    fixture = await launchVerificationServer({ MADANI_TEST_VPS_IDLE_CLOCK: "1", ...(slow ? {
      FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: join(dirname(vps.calls), "engine.finish"),
    } : {}) }, undefined, vps.localVm);
  } catch (error) { await vps.close(); throw error; }
  const evidence: unknown[] = [];
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
    });
    const result = { status: response.status, body: await response.json() as any };
    if (method !== "GET") evidence.push({ method, path, status: response.status });
    return result;
  };
  const configured = await api("PUT", "/api/config", { vps: { sshAlias: "fixture-vps", mode: "per-bot", idleTimeoutMinutes: 0 } });
  expect(configured.status).toBe(200);
  const bot = (await api("POST", "/api/bots", { name: "Idle fixture" })).body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "cloud", browser: false, approvalMode: "full" })).status).toBe(200);
  const name = vpsContainerName(bot.id);
  const row = (): { Id: string; Name: string; State: { Running: boolean } } | null => {
    const entries = readdirSync(vps.records).filter((file) => file.endsWith(".json"))
      .map((file) => JSON.parse(readFileSync(join(vps.records, file), "utf8")));
    return entries.find((entry) => entry.Name === `/${name}`) ?? null;
  };
  const commands = () => readFileSync(vps.calls, "utf8").trim().split("\n").filter(Boolean).map((line) => {
    const args = JSON.parse(line) as string[];
    return args[0] === "-H" ? args.slice(2) : args;
  });
  const mutations = () => commands().filter((args) => ["start", "stop", "rm"].includes(args[0]!) && args.at(-1) === row()?.Id).map((args) => args[0]);
  const enable = async () => {
    const result = await api("PUT", "/api/config", { vps: { idleTimeoutMinutes: 10 } });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
  };
  const wake = async () => {
    const result = await api("POST", `/api/bots/${bot.id}/computer/provision`, {});
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.ready).toBe(true);
    expect(row()?.State.Running).toBe(true);
  };
  return { fixture, vps, api, bot, row, commands, mutations, enable, wake,
    async close() {
      const path = `${fixture.info.logPath}.idle.json`;
      try {
        writeFileSync(path, JSON.stringify({ actions: evidence, finalRunning: row()?.State.Running, mutations: mutations() }, null, 2));
        await fixture.close();
        expect(existsSync(fixture.info.dataDir)).toBe(false);
      } finally { await vps.close(); console.info(JSON.stringify({ evidencePath: path, serverLog: fixture.info.logPath })); }
    },
  };
}

it.skipIf(process.platform === "win32")("sleeps despite read-only watch traffic, wakes in place, and protects a person's control until handback", async () => {
  const h = await harness();
  try {
    await h.enable();
    await h.wake();
    const identity = h.row()!.Id;
    await expect.poll(async () => {
      if (!h.row()?.State.Running) return false;
      expect((await h.api("GET", `/api/bots/${h.bot.id}/computer`)).status).toBe(200);
      const preview = await h.api("POST", `/api/bots/${h.bot.id}/computer/screenshot`, {});
      expect([200, 409]).toContain(preview.status);
      return h.row()?.State.Running;
    }, { timeout: 8_000, interval: 100 }).toBe(false);
    expect(h.mutations().filter((action) => action === "stop")).toHaveLength(1);
    await h.wake();
    expect(h.row()!.Id).toBe(identity);
    expect(h.mutations().filter((action) => action === "start")).toHaveLength(1);
    const lease = randomUUID();
    expect((await h.api("POST", `/api/bots/${h.bot.id}/computer/control`, { action: "take", controlLeaseId: lease })).body.owned).toBe(true);
    await delay(1_700);
    expect(h.row()?.State.Running).toBe(true);
    expect(h.mutations().filter((action) => action === "stop")).toHaveLength(1);
    expect((await h.api("POST", `/api/bots/${h.bot.id}/computer/control`, { action: "release", controlLeaseId: lease })).body.released).toBe(true);
    await expect.poll(() => h.row()?.State.Running, { timeout: 8_000, interval: 50 }).toBe(false);
    expect(h.mutations().filter((action) => action === "stop")).toHaveLength(2);
    // only explicit zeros keep it awake; a legacy idleTimeoutMinutes 0 no longer does
    expect((await h.api("PUT", "/api/config", { vps: { lifecycle: { browserIdleMinutes: 0, screenIdleMinutes: 0, computerIdleMinutes: 0 } } })).status).toBe(200);
    await h.wake();
    await delay(1_700);
    expect(h.row()?.State.Running).toBe(true);
    expect(h.mutations()).not.toContain("rm");
    expect(h.commands().some((args) => ["run", "pull", "build"].includes(args[0]!))).toBe(false);
  } finally { await h.close(); }
}, 35_000);

it.skipIf(process.platform === "win32")("keeps an active GUI turn awake, sleeps after Stop, and lets a later computer turn wake the same container", async () => {
  const h = await harness(true);
  const dumpFile = join(h.fixture.info.dataDir, "fake-claude-dump.json");
  const computer = async () => {
    let connection: { url: string; token: string } | undefined;
    await expect.poll(() => {
      try {
        const dump = JSON.parse(readFileSync(dumpFile, "utf8"));
        const env = dump.mcpConfig?.mcpServers?.computer?.env;
        if (env?.MADANI_CONTROL_URL && env?.MADANI_CONTROL_TOKEN) connection = { url: env.MADANI_CONTROL_URL, token: env.MADANI_CONTROL_TOKEN };
      } catch {}
      return Boolean(connection);
    }, { timeout: 10_000, interval: 50 }).toBe(true);
    return createControlClient(connection);
  };
  try {
    await h.enable();
    await h.wake();
    const identity = h.row()!.Id;
    expect((await h.api("POST", `/api/bots/${h.bot.id}/messages`, { text: "Inspect this computer and keep working." })).status).toBe(202);
    expect((await (await computer()).state(true)).held).toBe(false);
    await delay(1_700);
    expect(h.row()?.State.Running).toBe(true);
    expect(h.mutations().filter((action) => action === "stop")).toHaveLength(0);
    expect((await h.api("POST", `/api/bots/${h.bot.id}/interrupt`, {})).status).toBe(200);
    await expect.poll(() => h.row()?.State.Running, { timeout: 8_000, interval: 50 }).toBe(false);
    rmSync(dumpFile, { force: true });
    expect((await h.api("POST", `/api/bots/${h.bot.id}/messages`, { text: "Use this computer again." })).status).toBe(202);
    // asleep, the turn starts at once and wakes the computer beside it, since the message is about the computer
    await expect.poll(() => existsSync(dumpFile), { timeout: 10_000, interval: 50 }).toBe(true);
    await expect.poll(() => h.row()?.State.Running, { timeout: 8_000, interval: 50 }).toBe(true);
    expect(h.row()?.Id).toBe(identity);
    expect(h.mutations().filter((action) => action === "start")).toHaveLength(1);
    expect(h.mutations()).not.toContain("rm");
    expect((await h.api("POST", `/api/bots/${h.bot.id}/interrupt`, {})).status).toBe(200);
  } finally { await h.close(); }
}, 35_000);
