import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-madani.ts";
import { fixtureApi } from "../scripts/testing/preview-fixture.ts";
import { createTeamVpsFixture } from "../scripts/testing/team-vps-fixture.ts";

it.skipIf(process.platform === "win32")("protects an admitted shared-screen turn while Docker inspection spans the browser idle deadline", async () => {
  const vps = await createTeamVpsFixture({ screens: true });
  let fixture: VerificationServer | undefined;
  try {
    fixture = await launchVerificationServer({ MADANI_TEST_VPS_IDLE_CLOCK: "1", FAKE_CLAUDE_MODE: "hang" }, undefined, vps.localVm);
    const api = fixtureApi(fixture.info.url);
    await api("PUT", "/api/config", { vps: { sshAlias: "fixture-vps", mode: "shared", independentScreens: true,
      lifecycle: { browserIdleMinutes: 0, screenIdleMinutes: 0, computerIdleMinutes: 0 } } });
    const bot = (await api("POST", "/api/bots", { name: "Admitted screen setup", settings: { computer: "cloud", browser: false } })).bot;
    const ready = await api("POST", `/api/bots/${bot.id}/computer/provision`, {});
    expect(ready.viewerKey).toBeTypeOf("string");
    expect(ready.viewerKey).not.toBe("unallocated");
    const offset = readFileSync(vps.calls, "utf8").length;
    writeFileSync(vps.hold, "hold setup inspection");
    await api("POST", `/api/bots/${bot.id}/messages`, { text: "Use this bot's existing desktop." });
    await expect.poll(() => existsSync(`${vps.hold}.started`), { timeout: 5_000, interval: 25 }).toBe(true);
    await api("PATCH", "/api/config", { vps: { lifecycle: { browserIdleMinutes: 180, screenIdleMinutes: 1440, computerIdleMinutes: 2880 } } });
    await new Promise(resolve => setTimeout(resolve, 1_250));
    expect(existsSync(fixture.fixtureDumpPath)).toBe(false);
    rmSync(vps.hold);
    let computer: { args: string[] } | undefined;
    await expect.poll(() => {
      try { computer = JSON.parse(readFileSync(fixture!.fixtureDumpPath, "utf8")).mcpConfig?.mcpServers?.computer; }
      catch { return false; }
      return Boolean(computer);
    }, { timeout: 10_000, interval: 25 }).toBe(true);
    expect(JSON.parse(computer!.args.at(-1)!)).toMatchObject({ botId: bot.id, generation: ready.viewerKey });
    expect((await api("GET", `/api/bots/${bot.id}/computer`)).viewerKey).toBe(ready.viewerKey);
    const commands = readFileSync(vps.calls, "utf8").slice(offset).split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]);
    expect(commands.some(args => args.includes("browser-close") || args.includes("stop") || args.includes("reset"))).toBe(false);
    const current = (await api("GET", "/api/bots?messages=0")).bots.find((entry: { id: string }) => entry.id === bot.id);
    expect(current.busy).toBe(true);
  } finally {
    rmSync(vps.hold, { force: true });
    await fixture?.close();
    await vps.close();
  }
}, 25_000);
