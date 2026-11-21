import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-madani.ts";
import { createTeamVpsFixture } from "../scripts/testing/team-vps-fixture.ts";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function harness(independent: boolean, initiallyEnabled = true) {
  const vps = await createTeamVpsFixture({ screens: independent });
  let fixture;
  try { fixture = await launchVerificationServer({ MADANI_TEST_VPS_IDLE_CLOCK: "1" }, undefined, vps.localVm); }
  catch (error) { await vps.close(); throw error; }
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  expect((await api("PUT", "/api/config", { vps: { sshAlias: "fixture-vps", mode: independent ? "shared" : "per-bot", independentScreens: independent, lifecycle: initiallyEnabled ? { browserIdleMinutes: 180, screenIdleMinutes: 1440, computerIdleMinutes: 2880 } : { browserIdleMinutes: 0, screenIdleMinutes: 0, computerIdleMinutes: 0 } } })).status).toBe(200);
  const state = () => JSON.parse(readFileSync(join(fixture.info.dataDir, "vps-lifecycle.json"), "utf8"));
  const commands = () => readFileSync(vps.calls, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]).map(args => args[0] === "-H" ? args.slice(2) : args);
  const containers = () => readdirSync(vps.records).filter(file => file.endsWith(".json")).map(file => JSON.parse(readFileSync(join(vps.records, file), "utf8")));
  const screens = () => readdirSync(vps.screenRecords).filter(file => file.endsWith(".json")).map(file => JSON.parse(readFileSync(join(vps.screenRecords, file), "utf8")));
  const bot = async (name: string) => {
    const created = await api("POST", "/api/bots", { name });
    expect(created.status).toBe(201);
    expect((await api("PATCH", `/api/bots/${created.body.bot.id}`, { computer: "cloud", browser: false })).status).toBe(200);
    return created.body.bot as { id: string };
  };
  const wake = async (id: string) => { const result = await api("POST", `/api/bots/${id}/computer/provision`, {}); expect(result.status, JSON.stringify(result.body)).toBe(200); return result.body; };
  return { fixture, vps, api, state, commands, containers, screens, bot, wake,
    async close() {
      const path = `${fixture.info.logPath}.lifecycle.json`;
      try {
        writeFileSync(path, JSON.stringify({ commands: commands(), containers: containers(), screens: screens(), lifecycle: existsSync(join(fixture.info.dataDir, "vps-lifecycle.json")) ? state() : null }, null, 2));
        await fixture.close();
      } finally { await vps.close(); console.info(JSON.stringify({ evidence: path })); }
    },
  };
}

it.skipIf(process.platform === "win32")("closes the primary browser at 3h, stops only its owned container at 24h, and records the 48h stage idempotently", async () => {
  const h = await harness(false);
  try {
    const bot = await h.bot("Primary lifecycle");
    await h.wake(bot.id);
    const id = h.containers()[0].Id;
    await expect.poll(() => h.commands().some(args => args[0] === "exec" && args.some(arg => arg.includes('"method":"Browser.close"'))), { timeout: 8_000, interval: 25 }).toBe(true);
    expect(h.containers()[0].State.Running).toBe(true);
    await expect.poll(() => h.containers()[0].State.Running, { timeout: 8_000, interval: 25 }).toBe(false);
    await expect.poll(() => h.state().entries.find((entry: any) => !entry.target.botId)?.completed.includes("computer"), { timeout: 8_000, interval: 25 }).toBe(true);
    expect(h.commands().filter(args => args[0] === "stop")).toEqual([["stop", "--time", "10", id]]);
    expect(h.commands().some(args => ["rm", "pull", "build"].includes(args[0]!))).toBe(false);
    expect(statSync(join(h.fixture.info.dataDir, "vps-lifecycle.json")).mode & 0o777).toBe(0o600);
  } finally { await h.close(); }
}, 25_000);

it.skipIf(process.platform === "win32")("retires only an idle bot screen at 24h, ignores passive watch activity, and protects a held sibling through the 48h deadline", async () => {
  const h = await harness(true, false);
  try {
    const first = await h.bot("Idle screen");
    const sibling = await h.bot("Held screen");
    const a = await h.wake(first.id);
    await h.wake(sibling.id);
    expect(h.screens()).toHaveLength(2);
    const hold = randomUUID(), firstHold = randomUUID();
    expect((await h.api("POST", `/api/bots/${first.id}/computer/control`, { action: "take", controlLeaseId: firstHold })).body.owned).toBe(true);
    expect((await h.api("POST", `/api/bots/${sibling.id}/computer/control`, { action: "take", controlLeaseId: hold })).body.owned).toBe(true);
    expect((await h.api("PUT", "/api/config", { vps: { lifecycle: { browserIdleMinutes: 180, screenIdleMinutes: 1440, computerIdleMinutes: 2880 } } })).status).toBe(200);
    expect((await h.api("POST", `/api/bots/${first.id}/computer/control`, { action: "release", controlLeaseId: firstHold })).body.released).toBe(true);
    const firstGeneration = a.viewerKey;
    const browserCloses = () => h.commands().filter(args => args.includes("browser-close"));
    await expect.poll(async () => {
      await h.api("GET", `/api/bots/${first.id}/computer`);
      await h.api("POST", `/api/bots/${first.id}/computer/screenshot`, {});
      return browserCloses().some(args => args.includes(firstGeneration));
    }, { timeout: 8_000, interval: 50 }).toBe(true);
    expect(browserCloses()).toHaveLength(1);
    await expect.poll(() => h.screens().some(screen => screen.generation === firstGeneration), { timeout: 8_000, interval: 50 }).toBe(false);
    expect(h.screens()).toHaveLength(1);
    const beforeJoin = h.commands().length;
    for (let attempt = 0; attempt < 3; attempt++) {
      const join = await h.api("POST", `/api/bots/${first.id}/computer/join?viewer=proxy`, {});
      expect(join).toMatchObject({ status: 409, body: { error: expect.stringContaining("Wake this bot screen") } });
    }
    expect(h.screens()).toHaveLength(1);
    expect(h.commands().slice(beforeJoin).some(args => args.includes("ensure") || args[0] === "start" || args[0] === "run")).toBe(false);
    await delay(1_800);
    expect(h.containers()[0].State.Running).toBe(true);
    expect(h.commands().filter(args => args[0] === "stop")).toEqual([]);
    expect((await h.api("POST", `/api/bots/${sibling.id}/computer/control`, { action: "release", controlLeaseId: hold })).body.released).toBe(true);
    await expect.poll(() => h.containers()[0].State.Running, { timeout: 8_000, interval: 50 }).toBe(false);
    expect(h.screens()).toHaveLength(0);
    expect(h.commands().filter(args => args[0] === "stop")).toHaveLength(1);
    expect(h.commands().some(args => ["rm", "pull", "build"].includes(args[0]!))).toBe(false);
  } finally { await h.close(); }
}, 30_000);

it.skipIf(process.platform === "win32")("retires exactly the changed or deleted bot screen without renewing a sibling clock or stopping the shared computer", async () => {
  const h = await harness(true, false);
  try {
    const first = await h.bot("Departing screen"), sibling = await h.bot("Retained screen");
    const a = await h.wake(first.id), b = await h.wake(sibling.id);
    await expect.poll(() => { try { return h.state().entries.length; } catch { return 0; } }, { timeout: 5_000 }).toBe(3);
    const before = h.state();
    const siblingClock = before.entries.find((entry: any) => entry.target.botId === sibling.id).lastActivityAt;
    const resourceClock = before.entries.find((entry: any) => !entry.target.botId).lastActivityAt;
    const changed = await h.api("PATCH", `/api/bots/${first.id}`, { computer: "off" });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(h.screens().map(screen => screen.generation)).toEqual([b.viewerKey]);
    expect(h.state().entries.some((entry: any) => entry.target.botId === first.id)).toBe(false);
    expect(h.state().entries.find((entry: any) => entry.target.botId === sibling.id).lastActivityAt).toBe(siblingClock);
    expect(h.state().entries.find((entry: any) => !entry.target.botId).lastActivityAt).toBe(resourceClock);
    expect((await h.api("DELETE", `/api/bots/${sibling.id}`)).status).toBe(200);
    expect(h.screens()).toEqual([]);
    expect(h.state().entries.some((entry: any) => entry.target.botId === sibling.id)).toBe(false);
    expect(h.state().entries.find((entry: any) => !entry.target.botId).lastActivityAt).toBe(resourceClock);
    expect(h.containers()[0].State.Running).toBe(true);
    expect(h.commands().filter(args => args.includes("stop") && args.includes("/usr/local/bin/omb-screen")).map(args => args.at(-1))).toEqual([a.viewerKey, b.viewerKey]);
    expect(h.commands().some(args => args[0] === "stop" || args[0] === "rm")).toBe(false);
  } finally { await h.close(); }
}, 25_000);

it.skipIf(process.platform === "win32")("validates requests before screen cleanup and preserves access when a scoped stop fails or the bot is held", async () => {
  const h = await harness(true, false);
  const failure = join(dirname(h.vps.screenRecords), "screen-stop-fail");
  try {
    const first = await h.bot("Cleanup refusal"), sibling = await h.bot("Unaffected sibling");
    await h.wake(first.id); const b = await h.wake(sibling.id);
    const stops = () => h.commands().filter(args => args.includes("/usr/local/bin/omb-screen") && args.includes("stop"));
    expect((await h.api("PATCH", `/api/bots/${first.id}`, { computer: ["off"] })).status).toBe(400);
    expect(stops()).toEqual([]);
    const forged = await fetch(h.fixture.info.url + `/api/bots/${first.id}`, { method: "PATCH", headers: { "content-type": "application/json", origin: "https://untrusted.invalid" }, body: JSON.stringify({ computer: "off" }) });
    expect(forged.status).toBe(403); expect(stops()).toEqual([]);
    writeFileSync(failure, "fail");
    const refused = await h.api("PATCH", `/api/bots/${first.id}`, { computer: "off" });
    expect(refused).toMatchObject({ status: 503, body: { error: expect.stringContaining("access settings were kept") } });
    expect((await h.api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === first.id).computer).toBe("cloud");
    expect(h.screens()).toHaveLength(2);
    rmSync(failure);
    expect((await h.api("PATCH", `/api/bots/${first.id}`, { computer: "off" })).status).toBe(200);
    expect(h.screens().map(screen => screen.generation)).toEqual([b.viewerKey]);
    const hold = randomUUID();
    expect((await h.api("POST", `/api/bots/${sibling.id}/computer/control`, { action: "take", controlLeaseId: hold })).body.owned).toBe(true);
    const beforeBusy = stops().length;
    expect((await h.api("PATCH", `/api/bots/${sibling.id}`, { computer: "off" })).status).toBe(409);
    expect(stops()).toHaveLength(beforeBusy);
    expect((await h.api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === sibling.id).computer).toBe("cloud");
    expect((await h.api("POST", `/api/bots/${sibling.id}/computer/control`, { action: "release", controlLeaseId: hold })).body.released).toBe(true);
  } finally { rmSync(failure, { force: true }); await h.close(); }
}, 25_000);
