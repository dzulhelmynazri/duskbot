import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-madani.ts";
import { createTeamVpsFixture } from "../scripts/testing/team-vps-fixture.ts";
import { fakeDesktopFrame } from "../scripts/testing/fake-desktop-frame.ts";
import { vpsContainerName } from "./vps-computer.ts";
import { teamComputerOwner } from "./team-computers.ts";

const FRAME = fakeDesktopFrame(0, 1).toString("base64");

describe.skipIf(process.platform === "win32")("taking control never waits for the screen preview", () => {
  let fixture: VerificationServer;
  let vps: Awaited<ReturnType<typeof createTeamVpsFixture>>;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  };
  const apiOk = async (method: string, path: string, body?: unknown) => {
    const result = await api(method, path, body);
    expect(result.status, `${method} ${path}: ${JSON.stringify(result.body)}`).toBeLessThan(400);
    return result.body;
  };
  const captures = (): string[][] => existsSync(`${vps.screenshotHold}.started`)
    ? readFileSync(`${vps.screenshotHold}.started`, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const hold = () => {
    rmSync(`${vps.screenshotHold}.started`, { force: true });
    writeFileSync(vps.screenshotHold, "hold");
  };
  const release = () => rmSync(vps.screenshotHold, { force: true });
  const newBot = async (name: string, patch: Record<string, unknown>) => {
    const { bot } = await apiOk("POST", "/api/bots", { name });
    await apiOk("PATCH", `/api/bots/${bot.id}`, { browser: false, modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, ...patch });
    return bot as { id: string; name: string; threadId: string };
  };
  const viewer = (joinUrl: string, path = "/vnc.html") => {
    const url = new URL(joinUrl, fixture.info.url);
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.pathname).toBe(path);
  };

  beforeAll(async () => {
    vps = await createTeamVpsFixture({ holdScreenshots: true, screens: true });
    fixture = await launchVerificationServer({}, undefined, vps.localVm);
    await apiOk("PUT", "/api/config", { vps: { sshAlias: "control-fixture", mode: "per-bot" } });
  }, 60_000);
  afterAll(async () => {
    if (vps) release();
    await fixture?.close();
    await vps?.close();
  });

  it("a bot's cloud computer: take control and its desktop link go through; changing the computer still waits", async () => {
    const bot = await newBot("Pip", { computer: "cloud" });
    const status = await apiOk("POST", `/api/bots/${bot.id}/computer/provision`, {});
    expect(status.container_name).toBe(vpsContainerName(bot.id));
    hold();
    const preview = `/api/bots/${bot.id}/computer/screenshot?threadId=${bot.threadId}`;
    const first = api("POST", preview, {});
    let second: ReturnType<typeof api> | undefined;
    try {
      await expect.poll(() => captures().length, { timeout: 10_000 }).toBe(1);
      second = api("POST", preview, {});
      const took = await api("POST", `/api/bots/${bot.id}/computer/control`, { action: "take" });
      expect(took.status, `take control waited on the preview: ${JSON.stringify(took.body)}`).toBe(200);
      expect(took.body.held).toBe(true);
      const joined = await api("POST", `/api/bots/${bot.id}/computer/join?threadId=${bot.threadId}`, {});
      expect(joined.status, `the desktop link waited on the preview: ${JSON.stringify(joined.body)}`).toBe(200);
      viewer(joined.body.joinUrl);
      expect((await api("POST", `/api/bots/${bot.id}/computer/sleep`, {})).status, "sleep must still wait for capture").toBe(409);
      expect((await api("PUT", "/api/config", { vps: { sshAlias: "changed-fixture" } })).status, "resource changes must still wait for capture").toBe(409);
    } finally { release(); }
    expect((await first).body.png).toBe(FRAME);
    expect((await second!).body.png).toBe(FRAME);
    expect(captures(), "two panels watching share one capture").toHaveLength(1);
    expect((await apiOk("POST", `/api/bots/${bot.id}/computer/control`, { action: "release" })).held).toBe(false);
  }, 60_000);

  it("a team's shared computer: the same, from the bot and from the Team map", async () => {
    const requestId = randomUUID();
    const shared = await apiOk("POST", "/api/team-computers", { requestId, name: "Ops desktop", acknowledgeCost: true });
    const ada = await newBot("Ada", { section: "Ops" });
    await apiOk("PATCH", `/api/team-computers/${shared.id}`, { section: "Ops", acknowledgeSharedAccess: true });
    const status = await apiOk("GET", `/api/bots/${ada.id}/computer?threadId=${ada.threadId}`);
    expect(status.container_name).toBe(vpsContainerName(teamComputerOwner(shared.id)));
    // each bot has its own screen on a shared computer: Ada's is woken before anyone watches it
    await apiOk("POST", `/api/bots/${ada.id}/computer/provision`, {});
    hold();
    const first = api("POST", `/api/bots/${ada.id}/computer/screenshot?threadId=${ada.threadId}`, {});
    try {
      await expect.poll(() => captures().length, { timeout: 10_000 }).toBe(1);
      expect(captures()[0]).toContain(status.container_id);
      const took = await api("POST", `/api/bots/${ada.id}/computer/control`, { action: "take" });
      expect(took.status, `take control waited on the preview: ${JSON.stringify(took.body)}`).toBe(200);
      const joined = await api("POST", `/api/bots/${ada.id}/computer/join?threadId=${ada.threadId}`, {});
      expect(joined.status, `the desktop link waited on the preview: ${JSON.stringify(joined.body)}`).toBe(200);
      // Ada's own screen on the shared computer opens in the app's screen viewer
      viewer(joined.body.joinUrl, "/desktop-viewer");
      expect((await apiOk("POST", `/api/bots/${ada.id}/computer/control`, { action: "release" })).held).toBe(false);
      const lease = randomUUID();
      const map = await api("POST", `/api/team-computers/${shared.id}/control`, { action: "take", controlLeaseId: lease });
      expect(map.status, `the Team map's take waited on the preview: ${JSON.stringify(map.body)}`).toBe(200);
      expect(map.body.owned).toBe(true);
      const mapJoined = await api("POST", `/api/team-computers/${shared.id}/join`, {});
      expect(mapJoined.status, `the Team map's desktop link waited on the preview: ${JSON.stringify(mapJoined.body)}`).toBe(200);
      viewer(mapJoined.body.joinUrl);
      expect((await api("POST", `/api/team-computers/${shared.id}/sleep`, {})).status).toBe(409);
      await apiOk("POST", `/api/team-computers/${shared.id}/control`, { action: "release", controlLeaseId: lease });
    } finally { release(); }
    expect((await first).body.png).toBe(FRAME);
  }, 60_000);
});
