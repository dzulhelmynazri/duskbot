import { readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-madani.ts";
import { fixtureApi } from "../scripts/testing/preview-fixture.ts";
import { createTeamVpsFixture } from "../scripts/testing/team-vps-fixture.ts";

// opening a viewer never wakes a screen, so after a restart join?viewer=proxy asks for the wake and provision does it
it.skipIf(process.platform === "win32").each([false, true])("reinitializes bot screens through provision after a same-container restart without revoking a healthy boot (viewer first: %s)", async viewerFirst => {
  const vps = await createTeamVpsFixture({ screens: true });
  let fixture: VerificationServer | undefined;
  try {
    fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "hang" }, undefined, vps.localVm);
    const api = fixtureApi(fixture.info.url);
    await api("PUT", "/api/config", { vps: { sshAlias: "fixture-vps", mode: "shared", independentScreens: true, idleTimeoutMinutes: 0 } });
    const bot = (await api("POST", "/api/bots", { name: "Restarted screen", settings: { computer: "cloud" } })).bot;
    const physical = await api("GET", `/api/bots/${bot.id}/computer`);
    const recordPath = join(vps.records, `${physical.container_id}.json`);
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    record.State.StartedAt = "2026-11-07T00:00:00.000000001Z";
    writeFileSync(recordPath, JSON.stringify(record));
    const initial = await api("POST", `/api/bots/${bot.id}/computer/provision`, {});
    expect(initial.viewerKey).toBeTypeOf("string");
    expect(initial.viewerKey).not.toBe("unallocated");
    await api("POST", `/api/bots/${bot.id}/messages`, { text: "Keep this fixture turn open." });
    let control: { MADANI_CONTROL_URL: string; MADANI_CONTROL_TOKEN: string } | undefined;
    await expect.poll(() => {
      try { control = JSON.parse(readFileSync(fixture!.fixtureDumpPath, "utf8")).mcpConfig?.mcpServers?.computer?.env; }
      catch { return false; }
      return Boolean(control?.MADANI_CONTROL_URL);
    }, { timeout: 10_000 }).toBe(true);
    const gate = () => fetch(control!.MADANI_CONTROL_URL, { headers: { authorization: `Bearer ${control!.MADANI_CONTROL_TOKEN}` } });
    expect((await gate()).status).toBe(200);
    const calls = () => readFileSync(vps.calls, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]);
    const resets = () => calls().filter(args => args.includes("/usr/local/bin/omb-screen") && args.includes("reset")).length;
    const firstResetCount = resets();
    expect((await api("GET", `/api/bots/${bot.id}/computer`)).viewerKey).toBe(initial.viewerKey);
    expect((await api("POST", `/api/bots/${bot.id}/computer/provision`, {})).viewerKey).toBe(initial.viewerKey);
    expect((await api("POST", `/api/bots/${bot.id}/computer/join?viewer=proxy`, {})).viewerKey).toBe(initial.viewerKey);
    expect(resets()).toBe(firstResetCount);
    expect((await gate()).status).toBe(200);

    const restarted = JSON.parse(readFileSync(recordPath, "utf8"));
    restarted.State = { ...restarted.State, Running: true, Status: "running", StartedAt: "2026-11-07T00:00:01.000000001Z" };
    writeFileSync(recordPath, JSON.stringify(restarted));
    for (const file of readdirSync(vps.screenRecords)) unlinkSync(join(vps.screenRecords, file));
    if (viewerFirst) {
      await expect(api("POST", `/api/bots/${bot.id}/computer/join?viewer=proxy`, {})).rejects.toThrow("Wake this bot screen before opening it");
      expect(resets()).toBe(firstResetCount);
    }
    const result = await api("POST", `/api/bots/${bot.id}/computer/provision`, {});
    const ready = await api("GET", `/api/bots/${bot.id}/computer`);
    expect(result.viewerKey).toBe(ready.viewerKey);
    expect(ready.container_id).toBe(initial.container_id);
    expect(ready.viewerKey).toBeTypeOf("string");
    expect(ready.viewerKey).not.toBe(initial.viewerKey);
    expect(ready.viewerKey).not.toBe("unallocated");
    expect(resets()).toBe(firstResetCount + 1);
    expect(calls()).toContainEqual(expect.arrayContaining(["ensure", ready.viewerKey]));
    expect((await gate()).status).toBe(401);
    const screen = JSON.parse(readFileSync(join(vps.screenRecords, "2.json"), "utf8"));
    expect(screen.generation).toBe(ready.viewerKey);
  } finally {
    await fixture?.close();
    await vps.close();
  }
}, 45_000);
