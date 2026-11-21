// The mocked removal stands in for docker-over-SSH: these tests pin which aliases may reach it.
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ComputerControl } from "../computer-control.ts";
import { TeamComputers, teamComputerOwner } from "../team-computers.ts";
import { z } from "zod";
import { requiredScope } from "../request-auth.ts";
import type { AppConfig } from "../config.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { BotRecord } from "../store.ts";
import * as vps from "../vps-computer.ts";
import { createComputerRoutes, type ComputerRouteDeps } from "./computers.ts";
import { PASS, type RouteContext } from "./table.ts";

vi.mock("../vps-computer.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../vps-computer.ts")>();
  return { ...actual, removeManagedVpsComputer: vi.fn(), vpsComputerAction: vi.fn(), vpsComputerStatus: vi.fn(), vpsComputerJoin: vi.fn() };
});

const remove = vi.mocked(vps.removeManagedVpsComputer);
const CONTAINER = "madanibot-vps-test-abc123";

beforeEach(() => {
  remove.mockReset();
  remove.mockResolvedValue({ removed: true, name: CONTAINER });
});

function fixture(bots: BotRecord[], cfg: AppConfig) {
  // Only what the VPS remove endpoint touches; any other dependency is absent, and a route that reached for one would throw.
  const deps = {
    store: { bot: () => null, bots, sections: [] },
    cfg,
    computerProviderConfigTransitions: new Set(),
    managedVpsOwners: () => [],
    claimManagedVpsMutation: () => () => {},
    teamComputers: { list: () => [] },
    routines: () => null,
  } as unknown as ComputerRouteDeps;
  const handler = createComputerRoutes(deps);
  const postRemove = async (body: Record<string, unknown>) => {
    const sent: Array<{ status: number; body: any }> = [];
    const out = await handler({
      req: { headers: { "content-type": "application/json" } } as unknown as IncomingMessage,
      res: {} as ServerResponse,
      url: new URL(`http://localhost/api/computers/vps/${CONTAINER}/remove`),
      path: `/api/computers/vps/${CONTAINER}/remove`,
      method: "POST",
      auth: { kind: "loopback", scopes: ["admin"] } as RequestAuth,
      json: ((_res: ServerResponse, status: number, response: unknown) => {
        sent.push({ status, body: response });
      }) as RouteContext["json"],
      readBody: (async () => body) as RouteContext["readBody"],
    });
    expect(out).not.toBe(PASS);
    expect(sent).toHaveLength(1);
    return sent[0]!;
  };
  return { postRemove };
}

const cfgWith = (sshAlias: string): AppConfig => ({ vps: { sshAlias } }) as AppConfig;
const botWith = (vpsAlias?: string): BotRecord => ({ id: "bot-1", vpsAlias }) as BotRecord;

describe("POST /api/computers/vps/:name/restart", () => {
  it("is admin-only and restarts even while bots are on the computer", async () => {
    expect(requiredScope("POST", `/api/computers/vps/${CONTAINER}/restart`)).toBe("admin");
    const restart = vi.fn().mockResolvedValue({ ready: true });
    const handler = createComputerRoutes({
      store: { bot: () => null, bots: [], sections: [] }, cfg: cfgWith("production-vps"), computerProviderConfigTransitions: new Set(),
      managedVpsOwners: () => [{ botId: "bot-1", name: "Bot", inUse: true }], teamComputers: { list: () => [] }, routines: () => null,
      restartManagedVpsComputer: restart,
    } as unknown as ComputerRouteDeps);
    const sent: Array<{ status: number; body: unknown }> = [];
    await handler({
      req: { headers: { "content-type": "application/json" } } as unknown as IncomingMessage, res: {} as ServerResponse,
      url: new URL(`http://localhost/api/computers/vps/${CONTAINER}/restart`), path: `/api/computers/vps/${CONTAINER}/restart`, method: "POST",
      auth: { kind: "loopback", scopes: ["admin"] } as RequestAuth,
      json: ((_res: ServerResponse, status: number, body: unknown) => { sent.push({ status, body }); }) as RouteContext["json"],
      readBody: (async () => ({})) as RouteContext["readBody"],
    });
    expect(sent).toEqual([{ status: 200, body: { ready: true } }]);
    expect(restart).toHaveBeenCalledWith(CONTAINER);
  });
});

describe("POST /api/computers/vps/:name/remove", () => {
  it("refuses an alias no bot or default uses without touching SSH", async () => {
    const { postRemove } = fixture([botWith("alpha-vps")], cfgWith("production-vps"));

    const refused = await postRemove({ confirmName: CONTAINER, alias: "foreign-vps" });

    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/default server or a bot's own SSH alias/);
    expect(remove).not.toHaveBeenCalled();
  });

  it("lets a bot's own alias and the default through to removal", async () => {
    const { postRemove } = fixture([botWith("alpha-vps")], cfgWith("production-vps"));

    const perBot = await postRemove({ confirmName: CONTAINER, alias: "alpha-vps" });

    expect(perBot.status).toBe(200);
    expect(remove).toHaveBeenCalledWith({ vps: { sshAlias: "alpha-vps" } }, [], CONTAINER, CONTAINER);

    remove.mockClear();
    const fallback = await postRemove({ confirmName: CONTAINER, alias: "production-vps" });

    expect(fallback.status).toBe(200);
    expect(remove).toHaveBeenCalledWith({ vps: { sshAlias: "production-vps" } }, [], CONTAINER, CONTAINER);
  });

  it("keeps using the default server when no alias is given", async () => {
    const cfg = cfgWith("production-vps");
    const { postRemove } = fixture([botWith("alpha-vps")], cfg);

    const removed = await postRemove({ confirmName: CONTAINER });

    expect(removed.status).toBe(200);
    expect(remove).toHaveBeenCalledWith(cfg, [], CONTAINER, CONTAINER);
  });
});

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function teamFixture() {
  const directory = mkdtempSync(join(tmpdir(), "madani-team-vps-route-"));
  directories.push(directory);
  const registry = new TeamComputers(join(directory, "team-computers.json"), randomUUID());
  const computer = registry.create("Shared research desktop");
  const control = new ComputerControl();
  const cfg = { vps: { sshAlias: "workspace-vps" } };
  let active = false;
  const deps = {
    cfg, store: { bot: () => null, bots: [{ id: "member", section: "Research", vpsAlias: "member-only-vps" }], sections: ["Research"] },
    sessions: { isLive: () => true }, teamComputers: registry, computerControl: control, controlLeaseIdSchema: z.string().min(16),
    remoteComputerLifecycleBusyOwners: new Set(), computerProviderConfigTransitions: new Set(), routines: () => null,
    teamComputersPayload: async () => registry.list(), teamComputerInUse: () => false, recheckDesktopViewers: () => {}, managedVpsOwners: () => [],
    providerTransitionMessage: () => "VPS settings are changing", botHasActiveTurn: () => active,
    botComputerControlSnapshot: () => ({ held: false }), claimTeamComputerLifecycle: () => () => {}, claimBotComputerLifecycle: () => () => {},
  } as unknown as ComputerRouteDeps;
  const handler = createComputerRoutes(deps);
  const call = async (method: string, suffix: string, body: unknown = {}, remote = false) => {
    let sent: { status: number; body: any } | undefined;
    const path = `/api/team-computers${suffix}`;
    await handler({
      req: { headers: { "content-type": "application/json" } } as IncomingMessage,
      res: { setHeader: () => {} } as unknown as ServerResponse, path, url: new URL(`http://localhost${path}`), method,
      auth: remote ? { kind: "session", session: { id: "fixture-session" }, scopes: ["admin"] } : { kind: "loopback", scopes: ["admin"] },
      json: ((_res: ServerResponse, status: number, response: unknown) => { sent = { status, body: response }; }) as RouteContext["json"],
      readBody: async () => body,
    } as RouteContext);
    return sent!;
  };
  return { registry, computer, control, cfg, call, deps, busy: () => { active = true; } };
}

describe("shared team VPS lifecycle", () => {
  it("keeps named desktops admin-only and provisions using the shared owner and workspace alias", async () => {
    expect(requiredScope("POST", "/api/team-computers")).toBe("admin");
    expect(requiredScope("GET", "/api/team-computers")).toBe("admin");
    vi.mocked(vps.vpsComputerAction).mockResolvedValue({ ready: true } as vps.VpsComputerStatus);
    const { registry, cfg, call } = teamFixture();
    const requestId = randomUUID();
    expect((await call("POST", "", { name: "New desktop", requestId, acknowledgeCost: true })).status).toBe(201);
    expect(registry.get(requestId)).toBeDefined();
    expect(vps.vpsComputerAction).toHaveBeenLastCalledWith("provision", cfg, teamComputerOwner(requestId));
  });
  it("does not assign a missing or unsafe computer and rechecks active target members", async () => {
    const { computer, registry, call, busy } = teamFixture();
    const assignment = { section: "Research", acknowledgeSharedAccess: true };
    vi.mocked(vps.vpsComputerStatus).mockResolvedValue({ managed: false, container: "missing" } as vps.VpsComputerStatus);
    expect((await call("PATCH", `/${computer.id}`, assignment)).status).toBe(409);
    expect(registry.get(computer.id)?.section).toBeNull();
    vi.mocked(vps.vpsComputerStatus).mockImplementationOnce(async () => {
      busy();
      return { managed: true, container: "running", security: "hardened", network: "private", mounts: "none" } as vps.VpsComputerStatus;
    });
    await expect(call("PATCH", `/${computer.id}`, assignment)).rejects.toMatchObject({ status: 409 });
    expect(registry.get(computer.id)?.section).toBeNull();
  });
  it("validates the destination and completes scoped cleanup before changing a team assignment", async () => {
    const { computer, registry, call, deps } = teamFixture();
    const cleanup = vi.fn(async (): Promise<void> => { throw Object.assign(new Error("fixture cleanup unavailable"), { status: 503 }); });
    deps.prepareTeamComputerAssignment = cleanup;
    const assignment = { section: "Research", acknowledgeSharedAccess: true };
    await expect(call("PATCH", `/${computer.id}`, { ...assignment, section: "Foreign" })).rejects.toMatchObject({ status: 404 });
    expect(cleanup).not.toHaveBeenCalled();
    vi.mocked(vps.vpsComputerStatus).mockResolvedValue({ managed: true, container: "running", security: "hardened", network: "private", mounts: "none" } as vps.VpsComputerStatus);
    await expect(call("PATCH", `/${computer.id}`, assignment)).rejects.toMatchObject({ status: 503 });
    expect(registry.get(computer.id)?.section).toBeNull();
    cleanup.mockImplementation(async () => { expect(registry.get(computer.id)?.section).toBeNull(); });
    expect((await call("PATCH", `/${computer.id}`, assignment)).status).toBe(200);
    expect(registry.get(computer.id)?.section).toBe("Research");
  });
  it("requires shared control before ready-only join and keeps remote viewers on the authenticated proxy", async () => {
    const { computer, control, cfg, call } = teamFixture();
    const key = teamComputerOwner(computer.id);
    vi.mocked(vps.vpsComputerJoin).mockResolvedValue({ joinUrl: "http://127.0.0.1:9998/vnc.html#password=private", state: "running" });
    expect((await call("POST", `/${computer.id}/join`)).status).toBe(409);
    control.acquireLease(key, "private-first-lease");
    const reply = await call("POST", `/${computer.id}/join`, {}, true);
    expect(reply).toEqual({ status: 200, body: { joinUrl: `/desktop-viewer#target=vps%2F${key}`, state: "running" } });
    expect(JSON.stringify(reply)).not.toMatch(/password|private-first-lease|127.0.0.1/);
    expect(vps.vpsComputerJoin).toHaveBeenLastCalledWith(cfg, key, undefined, true);
  });
  it("refuses a ready-only join if the person releases control while the tunnel opens", async () => {
    const { computer, control, call } = teamFixture();
    const key = teamComputerOwner(computer.id);
    control.take(key);
    vi.mocked(vps.vpsComputerJoin).mockImplementationOnce(async () => {
      control.release(key);
      return { joinUrl: "http://127.0.0.1:9998/vnc.html#password=private", state: "running" };
    });
    expect((await call("POST", `/${computer.id}/join`)).status).toBe(409);
  });
});
