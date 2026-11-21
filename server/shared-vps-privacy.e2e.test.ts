import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-madani.ts";
import { fixtureApi } from "../scripts/testing/preview-fixture.ts";
import { createTeamVpsFixture } from "../scripts/testing/team-vps-fixture.ts";
import { createControlClient } from "./control-client.ts";
import { teamComputerOwner } from "./team-computers.ts";
import { vpsContainerName } from "./vps-computer.ts";

it.skipIf(process.platform === "win32")("never implicitly shares the personal desktop with multiple or domain administrators", async () => {
  const vps = await createTeamVpsFixture();
  let fixture: VerificationServer | undefined;
  try {
    fixture = await launchVerificationServer({}, undefined, vps.localVm);
    const api = fixtureApi(fixture.info.url);
    await api("PUT", "/api/config", { vps: { sshAlias: "fixture-vps", mode: "shared", independentScreens: false }, signIn: { admins: ["owner@example.test"], members: [] } });
    const auto = (await api("POST", "/api/bots", { name: "Unowned Auto bot" })).bot;
    const explicit = (await api("POST", "/api/bots", { name: "Unowned VPS bot", settings: { computer: "cloud" } })).bot;
    const status = (id: string) => api("GET", `/api/bots/${id}/computer`);
    const personal = await status(auto.id);
    const sharedId = personal.teamComputer?.id;
    expect(sharedId).toBeTypeOf("string");
    expect(personal.container_name).toBe(vpsContainerName(teamComputerOwner(sharedId)));
    expect((await status(explicit.id)).teamComputer?.id).toBe(sharedId);

    for (const admins of [["owner@example.test", "other@example.test"], ["@example.test"]]) {
      await api("PUT", "/api/config", { signIn: { admins, members: [] } });
      for (const bot of [auto, explicit]) {
        const current = await status(bot.id);
        expect(current.teamComputer, JSON.stringify(admins)).toBeUndefined();
        expect(current.container_name).toBe(vpsContainerName(bot.id));
        expect(current.container_name).not.toBe(personal.container_name);
      }
    }

    const registry = JSON.parse(readFileSync(join(fixture.info.dataDir, "team-computers.json"), "utf8"));
    expect(registry.computers).toContainEqual(expect.objectContaining({ id: sharedId, scope: "workspace" }));
    await api("PUT", "/api/config", { signIn: { admins: ["owner@example.test"], members: [] } });
    expect((await status(auto.id)).teamComputer?.id).toBe(sharedId);
  } finally {
    await fixture?.close();
    await vps.close();
  }
}, 45_000);

it.skipIf(process.platform === "win32")("keeps a running shared turn and human control pinned when a sign-in change would stop sharing", async () => {
  const vps = await createTeamVpsFixture();
  let fixture: VerificationServer | undefined;
  try {
    fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "hang" }, undefined, vps.localVm);
    const api = fixtureApi(fixture.info.url);
    const signIn = { admins: ["owner@example.test"], members: [] as string[] };
    await api("PUT", "/api/config", { vps: { sshAlias: "fixture-vps", mode: "shared", independentScreens: false }, signIn });
    const bot = (await api("POST", "/api/bots", { name: "Held shared turn", settings: { computer: "cloud" } })).bot;
    const target = await api("GET", `/api/bots/${bot.id}/computer`);
    expect(target.teamComputer?.id).toBeTypeOf("string");
    await api("POST", `/api/bots/${bot.id}/messages`, { text: "Hold this fixture turn on its shared desktop." });
    let mounted: { args: string[]; env: { MADANI_CONTROL_URL: string; MADANI_CONTROL_TOKEN: string } } | undefined;
    await expect.poll(() => {
      try { mounted = JSON.parse(readFileSync(fixture!.fixtureDumpPath, "utf8")).mcpConfig?.mcpServers?.computer; }
      catch { return false; }
      return Boolean(mounted?.env.MADANI_CONTROL_URL);
    }, { timeout: 10_000 }).toBe(true);
    const gate = createControlClient({ url: mounted!.env.MADANI_CONTROL_URL, token: mounted!.env.MADANI_CONTROL_TOKEN });
    expect(await gate.state(true)).toMatchObject({ held: false });
    const lease = "fixture-held-shared-privacy";
    try {
      expect(await api("POST", `/api/bots/${bot.id}/computer/control`, { action: "take", controlLeaseId: lease })).toMatchObject({ held: true, owned: true });
      expect(await api("GET", `/api/team-computers/${target.teamComputer.id}/control`)).toMatchObject({ held: true });
      const start = readFileSync(vps.calls, "utf8").length;
      for (const next of [
        { admins: ["owner@example.test", "other@example.test"], members: [] },
        { admins: ["@example.test"], members: [] },
        { admins: ["owner@example.test"], members: ["member@example.test"] },
      ]) {
        const response = await fetch(`${fixture.info.url}/api/config`, {
          method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ signIn: next }),
        });
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: expect.stringMatching(/stop|active|control/i) });
        expect(await api("GET", `/api/bots/${bot.id}/computer`)).toMatchObject({ teamComputer: target.teamComputer, container_name: target.container_name });
        expect(await api("POST", `/api/bots/${bot.id}/computer/control`, { action: "check", controlLeaseId: lease })).toMatchObject({ held: true, owned: true });
        expect(await api("GET", `/api/team-computers/${target.teamComputer.id}/control`)).toMatchObject({ held: true });
        expect(JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8")).signIn).toEqual(signIn);
      }
      const calls = readFileSync(vps.calls, "utf8").slice(start).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]);
      expect(calls.some(args => args.includes("stop") || args.includes("rm") || args.includes("kill"))).toBe(false);
    } finally {
      await api("POST", `/api/bots/${bot.id}/computer/control`, { action: "release", controlLeaseId: lease });
      await api("POST", `/api/bots/${bot.id}/interrupt`, {});
    }
  } finally {
    await fixture?.close();
    await vps.close();
  }
}, 45_000);
