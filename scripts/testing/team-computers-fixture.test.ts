import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../control-madani.ts";
import { fixtureApi } from "./preview-fixture.ts";
import { createTeamVpsFixture } from "./team-vps-fixture.ts";
import { teamComputerOwner } from "../../server/team-computers.ts";
import { vpsContainerName } from "../../server/vps-computer.ts";

it("launches the isolated fake engine without a remote computer account", async () => {
  const fixture = await launchVerificationServer({});
  try {
    const config = JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8"));
    expect(config).not.toHaveProperty("box");
    expect(config.instances).not.toHaveProperty("computer");
    const response = await fetch(`${fixture.info.url}/api/team-computers`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ configured: false, computers: [] });
  } finally { await fixture.close(); }
  expect(existsSync(fixture.info.dataDir)).toBe(false);
}, 30_000);

it.skipIf(process.platform === "win32")("uses the owned Docker fixture for one shared VPS desktop with no external provider", async () => {
  const vps = await createTeamVpsFixture({ frames: true });
  let fixture: VerificationServer | undefined;
  try {
    fixture = await launchVerificationServer({}, undefined, vps.localVm);
    const api = fixtureApi(fixture.info.url);
    // per-bot screens (on by default) report ready only once a turn has a screen; this checks the shared desktop itself,
    // as group-local-vm's shared-computer test does (4bcb21d7f)
    await api("PUT", "/api/config", { vps: { sshAlias: "fixture-vps", mode: "per-bot", independentScreens: false } });
    const first = (await api("POST", "/api/bots", { name: "First researcher" })).bot;
    const second = (await api("POST", "/api/bots", { name: "Second researcher" })).bot;
    const outsider = (await api("POST", "/api/bots", { name: "Other work" })).bot;
    await api("POST", "/api/sidebar-sections", { name: "Research", botIds: [first.id, second.id] });
    for (const bot of [first, second]) await api("PATCH", `/api/bots/${bot.id}`, { computer: null, cloudBackend: "vps" });
    const id = randomUUID();
    await api("POST", "/api/team-computers", { name: "Research desktop", requestId: id, acknowledgeCost: true });
    await api("PATCH", `/api/team-computers/${id}`, { section: "Research", acknowledgeSharedAccess: true });
    for (const bot of [first, second]) {
      expect(await api("GET", `/api/bots/${bot.id}/computer`)).toMatchObject({ backend: "vps", sshAlias: "fixture-vps", teamComputer: { id }, container_name: vpsContainerName(teamComputerOwner(id)), ready: true });
    }
    expect((await api("GET", `/api/bots/${outsider.id}/computer`)).teamComputer).toBeUndefined();
    const spare = randomUUID();
    await api("POST", "/api/team-computers", { name: "Spare desktop", requestId: spare, acknowledgeCost: true });
    const inventory = await api("GET", "/api/computers/vps");
    expect(inventory.available).toBe(true);
    expect(inventory.instances.map((entry: { ownerBotId: string }) => entry.ownerBotId)).toEqual(expect.arrayContaining([teamComputerOwner(id), teamComputerOwner(spare)]));
    const screenshot = await api("POST", `/api/bots/${first.id}/computer/screenshot`, {});
    expect(screenshot.format).toBe("png");
    expect(screenshot.png).toMatch(/^iVBOR/);
    const config = JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8"));
    expect(config).not.toHaveProperty("box");
    const calls = readFileSync(vps.calls, "utf8");
    expect(calls).toContain("ssh://fixture-vps");
    expect(calls).toContain(vpsContainerName(teamComputerOwner(id)));
  } finally {
    await fixture?.close();
    await vps.close();
  }
  expect(existsSync(fixture!.info.dataDir)).toBe(false);
}, 30_000);
