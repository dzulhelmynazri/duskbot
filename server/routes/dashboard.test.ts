import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DASHBOARD_URL, parseWorkspaceReport } from "../../shared/dashboard-protocol.ts";
import { createDashboardCollector } from "../dashboard-report.ts";
import type { DashboardCollectorDeps } from "../dashboard-report.ts";
import { createDashboardCommands } from "../dashboard-commands.ts";
import { dashboardApps } from "../dashboard-apps.ts";
import { macMemoryUsed } from "../dashboard-machine.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { createDashboardRoutes, dashboardUrl } from "./dashboard.ts";
import type { DashboardRouteDeps } from "./dashboard.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [], dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => { server.closeAllConnections(); return new Promise((done) => server.close(done)); }));
  await Promise.all(dirs.splice(0).map(removeTempDir));
});
const ADMIN: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const session = { id: "s1", label: "Laptop", scopes: ["admin", "client"] as ("admin" | "client")[], createdAt: 10, lastSeenAt: 20, expiresAt: Date.now() + 86400_000 };
function dependencies(): DashboardCollectorDeps {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-collector-")); dirs.push(dir);
  return {
    dataDir: dir, cfg: {}, bots: () => [{ id: "nova", name: "Nova", color: "blue", mascotBody: null, computer: "vm", modelSelection: { instanceId: "engine", model: "test" } }],
    managedVpsOwners: () => [], teamComputers: () => [], localInventory: async () => ({ instances: [] }), localRuntime: async () => ({ runtime: null, available: [], daemonUp: false }),
    vps: { listManagedVpsComputers: vi.fn(), vpsDockerArgs: (_alias, args) => args, defaultRunner: vi.fn(async () => ({ stdout: "", stderr: "" })), vpsContainerName: (id) => id },
    lastUsedAt: () => 42, busy: () => true, engine: () => ({ displayName: "My engine", driverKind: "fixture" }),
    routines: () => [{ id: "routine", botId: "nova", name: "Morning brief", schedule: { type: "cron", expression: "0 9 * * *", timeZone: "UTC" }, enabled: false, nextRunAt: 99, lastRunAt: 88 }],
    phones: () => [{ key: "registry-key", registration: { installId: "abcdefgh", name: "Sid's iPhone", platform: "ios", appVersion: "1", timeZone: "UTC", capabilities: {} }, registeredAt: 1, seen: 2, lastUsedAt: null, online: true, busy: false }],
    sessions: () => [session], mobile: () => ({ devices: [{ id: "device", sessionId: "s1", name: "Phone", platform: "ios", createdAt: 3 }], agent: null }), publicUrl: () => null, deviceLabel: () => "Fixture",
    checkUpdate: async () => ({ current: "1", available: false, install: "unknown" }), prices: () => null,
    planUsage: vi.fn(async () => ({ fetchedAt: "now", providers: [{ id: "engine", name: "Engine", driver: "fixture", plan: "Pro", ok: true, error: null,
      fiveHour: { available: true, remainingPercent: 75, usedPercent: 25, resetsAt: "2026-11-08T12:00:00Z" }, weekly: { available: false, remainingPercent: null, usedPercent: null, resetsAt: null }, extra: [], models: [] }] })),
    usage: { flush: vi.fn(async () => {}), read: vi.fn(() => ["visible", "hidden"].map((threadId) => ({ at: new Date().toISOString(), botId: "nova", botName: "Nova", threadId, model: "test", instanceId: "engine", driverKind: "fixture", input: 10, output: 20, costUsd: 0.25, trigger: { kind: "owner" as const },
      ...(threadId === "visible" ? { cachedInput: 4, cacheWrite: 2 } : {}) }))) },
    machine: async () => ({ at: 1, host: { hostname: "Fixture", platform: "linux", arch: "x64", cpus: 1, cpuModel: "Fixture CPU" }, cpu: { percent: 5, load: [0, 0, 0] }, memory: { usedBytes: 1, totalBytes: 2 }, disk: { usedBytes: 1, totalBytes: 2, path: "/private/secret" }, network: null, uptimeSec: 1, processUptimeSec: 1, app: { version: "1", node: "22" } }),
  };
}
async function listen(server: Server) {
  servers.push(server); await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function routes(overrides: Partial<DashboardRouteDeps> = {}, auth = ADMIN) {
  const reporter = { status: vi.fn(() => ({ connected: false, url: null, workspaceId: null, lastReportAt: null, lastError: null, watching: false })),
    link: vi.fn(async (url: string) => ({ v: 1 as const, workspaceId: "workspace", claimUrl: `${url}/claim`, dashboardUrl: url, claimExpiresAt: 0 })), forget: vi.fn(async () => {}), start() {}, stop() {} };
  const deps = { reporter, linkAgentBase: () => "https://link.test", env: {}, ...overrides };
  const handlers = [createDashboardRoutes(deps)];
  const base = await listen(createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!await dispatchRoutes(handlers, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
  }));
  return { reporter, call: (method = "GET", body?: object, contentType = "application/json") => fetch(`${base}/api/dashboard/link`, { method, headers: { "content-type": contentType }, ...(body ? { body: JSON.stringify(body) } : {}) }) };
}

describe("dashboard collector", () => {
  it("emits protocol sections, owner activity, prefixed phones and routines without private fields", async () => {
    const deps = dependencies(), collect = createDashboardCollector(deps);
    const report = { v: 1 as const, seq: 1, at: Date.now(), workspace: collect.workspace(), machine: await collect.machine(), computers: await collect.computers(), devices: await collect.devices(), activity: await collect.activity(), bots: collect.bots(), plans: await collect.plans() };
    expect(parseWorkspaceReport(report)).toEqual(report);
    expect(report.devices.phones.map((phone) => phone.id)).toEqual(["phone:registry-key", "mobile:device"]);
    expect(report.bots[0]).toMatchObject({ color: "blue", body: null, model: "test", engine: "My engine", computer: "local-vm", busy: true, lastActiveAt: 42,
      routines: [{ id: "routine", name: "Morning brief", paused: true, schedule: expect.stringContaining("Every day"), nextRunAt: 99, lastRunAt: 88 }] });
    expect(report.activity.totals).toEqual({ turns: 2, tokens: 60, costUsd: 0.5, input: 14, output: 40, cacheRead: 4, cacheWrite: 2 });
    expect(report.activity.byBot).toHaveLength(1); expect(report.activity.byModel).toHaveLength(1);
    expect(JSON.stringify(report)).not.toMatch(/private|secret|threadId|prompt|tokenHash|capabilities|revoke/);
    expect(report.machine.disk?.path).toBe("");
    expect(report.plans?.providers[0].windows).toEqual([{ label: "5-hour", usedPercent: 25, resetsAt: Date.parse("2026-11-08T12:00:00Z") }]);
    await collect.plans(); await collect.activity();
    expect(deps.planUsage).toHaveBeenCalledTimes(1); expect(deps.usage?.read).toHaveBeenCalledTimes(1);
  });
  it("maps inherited team computers and honors a routine's human schedule label", () => {
    const deps = dependencies(), routines = deps.routines();
    const collect = createDashboardCollector({ ...deps, computerKind: () => "team", routines: () => routines.map((routine) => ({ ...routine, scheduleLabel: "Every morning" })) });
    expect(collect.bots()[0]).toMatchObject({ computer: "team", routines: [{ schedule: "Every morning" }] });
  });
});

describe("dashboard link routes", () => {
  it("accepts a valid enrollment token and rejects malformed tokens before linking", async () => {
    const { call, reporter } = await routes(), enrollToken = "e".repeat(43);
    for (const token of [null, 123, {}, "", "short", "e".repeat(44), `${"e".repeat(43)}\n`, `${"e".repeat(42)}!`]) expect((await call("POST", { url: "https://accounts.test", enrollToken: token })).status).toBe(400);
    expect(reporter.link).not.toHaveBeenCalled();
    expect(await (await call("POST", { url: "https://accounts.test", enrollToken })).json()).toEqual({ claimed: true, workspaceId: "workspace", claimUrl: "https://accounts.test/claim", dashboardUrl: "https://accounts.test" });
    expect(reporter.link).toHaveBeenCalledWith("https://accounts.test", { enrollToken });
  });
  it("rejects non-admin sessions and service loopback on every link method", async () => {
    for (const auth of [{ kind: "session", via: "bearer", session: { ...session, tokenHash: "hash" }, scopes: ["client"] } as RequestAuth, { ...ADMIN, trust: "service" } as RequestAuth]) {
      const { call, reporter } = await routes({}, auth);
      for (const method of ["GET", "POST", "DELETE"]) expect((await call(method, method === "POST" ? {} : undefined)).status).toBe(403);
      expect(reporter.link).not.toHaveBeenCalled();
    }
  });
  it("requires JSON mutations and exposes status and forget", async () => {
    const { call, reporter } = await routes();
    expect((await call()).status).toBe(200);
    for (const method of ["POST", "DELETE"]) expect((await call(method, undefined, "text/plain")).status).toBe(415);
    expect(await (await call("DELETE")).json()).toEqual({ ok: true }); expect(reporter.forget).toHaveBeenCalledOnce();
  });
  it("validates URLs and resolves body, environment, discovery, default in order", async () => {
    for (const url of ["http://remote.test", "ftp://test", "https://u:p@host", "https://host?secret=x"]) expect(dashboardUrl(url)).toBeNull();
    expect(dashboardUrl("https://host/dashboard/")).toBe("https://host/dashboard");
    expect(dashboardUrl("http://localhost:1234")).toBe("http://localhost:1234"); expect(dashboardUrl("http://127.0.0.1:1234")).toBe("http://127.0.0.1:1234");
    const discovery = vi.fn<typeof fetch>(async () => Response.json({ v: 1, url: "https://discovered.test" }));
    const explicit = await routes({ env: { MADANI_DASHBOARD_URL: "https://env.test" }, fetch: discovery });
    expect(await (await explicit.call("POST", { url: "https://body.test" })).json()).toMatchObject({ claimed: true, dashboardUrl: "https://body.test" });
    await explicit.call("POST", {}); expect(explicit.reporter.link).toHaveBeenLastCalledWith("https://env.test"); expect(discovery).not.toHaveBeenCalled();
    expect((await explicit.call("POST", { url: "http://bad.test" })).status).toBe(400);
    const discovered = await routes({ fetch: discovery }); await discovered.call("POST", {}); expect(discovered.reporter.link).toHaveBeenCalledWith("https://discovered.test");
    expect(discovery).toHaveBeenCalledWith("https://link.test/.well-known/madanibot/dashboard", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    const fallback = await routes({ fetch: async () => { throw new Error("offline"); } }); await fallback.call("POST", {}); expect(fallback.reporter.link).toHaveBeenCalledWith(DEFAULT_DASHBOARD_URL);
    const invalid = await routes({ fetch: async () => Response.json({ v: 1, url: "http://bad.test" }) }); await invalid.call("POST", {}); expect(invalid.reporter.link).toHaveBeenCalledWith(DEFAULT_DASHBOARD_URL);
  });
});

describe("dashboard command routes", () => {
  it("calls existing routes with one-use owner grants, preserves route errors and refuses unknown targets", async () => {
    const collect = createDashboardCollector(dependencies());
    const seen: Array<{ path: string; method: string; body: unknown }> = [];
    let nonce = "";
    const server = createServer(async (req, res) => {
      nonce = String(req.headers["x-madani-dashboard-command"]);
      const auth = commands.authenticate(req); expect(auth && commands.owns(auth)).toBe(true);
      expect(commands.authenticate(req)).toBeNull();
      seen.push({ path: req.url!, method: req.method!, body: req.method === "DELETE" ? null : await readBody(req) });
      json(res, req.url?.includes("sessions") ? 409 : 200, req.url?.includes("sessions") ? { error: "This session is already gone." } : { ok: true });
    });
    const base = await listen(server), commands = createDashboardCommands({ port: Number(new URL(base).port), collect });
    for (const [kind, target] of [["computer.wake", "nova"], ["computer.sleep", "nova"], ["phone.revoke", "phone:registry-key"], ["phone.revoke", "mobile:device"], ["routine.pause", "routine"], ["routine.resume", "routine"]] as const) {
      expect((await commands.execute({ id: kind, kind, target, issuedAt: 0, expiresAt: Date.now() + 1000 })).ok).toBe(true);
    }
    expect(seen.map((entry) => entry.path)).toEqual(["/api/bots/nova/local-computer/start", "/api/bots/nova/local-computer/stop", "/api/phones/registry-key", "/api/mobile/devices/device", "/api/routines/routine", "/api/routines/routine"]);
    expect(seen.slice(-2).map((entry) => entry.body)).toEqual([{ enabled: false }, { enabled: true }]);
    expect((await commands.execute({ id: "session", kind: "session.revoke", target: "s1", issuedAt: 0, expiresAt: Date.now() + 1000 })).message).toBe("This session is already gone.");
    expect((await commands.execute({ id: "missing", kind: "computer.wake", target: "missing", issuedAt: 0, expiresAt: Date.now() + 1000 })).ok).toBe(false);
    expect(nonce).not.toBe("");
  });
});

describe("dashboard app commands", () => {
  async function workspace(answer: (req: { url: string; method: string }) => [number, object]) {
    const seen: Array<{ path: string; method: string }> = [];
    const server = createServer(async (req, res) => {
      const auth = commands.authenticate(req); expect(auth && commands.owns(auth)).toBe(true);
      seen.push({ path: req.url!, method: req.method! });
      const [status, body] = answer({ url: req.url!, method: req.method! });
      json(res, status, body);
    });
    const base = await listen(server), commands = createDashboardCommands({ port: Number(new URL(base).port), collect: createDashboardCollector(dependencies()) });
    let sent = 0;
    const run = (kind: "app.connect" | "app.disconnect", target: string) => commands.execute({ id: `${kind}-${++sent}`, kind, target, issuedAt: 0, expiresAt: Date.now() + 1000 });
    return { seen, run };
  }
  it("starts a sign-in through the workspace's own connector route and hands back only an https link", async () => {
    let url = "https://connect.composio.dev/link/abc";
    const w = await workspace(({ method }) => method === "POST" ? [200, { url }] : [200, { removed: 1 }]);
    expect(await w.run("app.connect", "Gmail")).toMatchObject({ ok: true, url });
    expect(await w.run("app.disconnect", "gmail")).toMatchObject({ ok: true, message: "Disconnected." });
    url = "javascript:alert(1)";
    expect(await w.run("app.connect", "gmail")).toMatchObject({ ok: false, message: "This app did not return a sign-in page." });
    expect(w.seen).toEqual([{ path: "/api/connectors/gmail/authorize", method: "POST" }, { path: "/api/connectors/gmail", method: "DELETE" }, { path: "/api/connectors/gmail/authorize", method: "POST" }]);
    expect(await w.run("app.connect", "../admin")).toMatchObject({ ok: false, message: "This app could not be found." });
    expect(w.seen).toHaveLength(3);
  });
  it("passes a workspace's refusal through but hides its internal failures", async () => {
    let status = 403;
    // a short plain reason is shown even from a 5xx (f3fdbf0be); one carrying a path, link or stack stays inside
    const w = await workspace(() => [status, { error: status === 403 ? "Your team admin has not allowed this app." : "Composio authorization failed reading /data/.madanibot/composio.json" }]);
    expect((await w.run("app.connect", "gmail")).message).toBe("Your team admin has not allowed this app.");
    status = 502;
    expect((await w.run("app.connect", "gmail")).message).toBe("The workspace could not complete this action.");
  });
  it("reports connected and half-connected apps only, and nothing when apps are not set up", async () => {
    const source = { connectorAvailability: vi.fn<() => "configured" | "unconfigured">(() => "configured"), connectedServicesInventory: vi.fn(async () => ({ complete: false, services: {
      gmail: { connected: true, pending: false, status: "ACTIVE", accounts: [] }, linear: { connected: false, pending: true, status: "INITIATED", accounts: [] },
      slack: { connected: false, pending: false, status: "EXPIRED", accounts: [] }, "bad slug!": { connected: true, pending: false, status: "ACTIVE", accounts: [] } } })) };
    expect(await dashboardApps({}, source)).toEqual({ available: true, complete: false, services: [{ slug: "gmail", connected: true, pending: false }, { slug: "linear", connected: false, pending: true }] });
    source.connectorAvailability.mockReturnValue("unconfigured");
    expect(await dashboardApps({}, source)).toEqual({ available: false, complete: true, services: [] });
  });
});

it("counts a Mac's active, wired and compressed pages as used memory, not its file cache", () => {
  const vmStat = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:  100.\nPages active:  1000.\nPages inactive:  5000.\nPages wired down:  500.\nPages occupied by compressor:  250.\n";
  expect(macMemoryUsed(vmStat)).toBe(1750 * 16384);
  expect(macMemoryUsed("nothing useful")).toBeNull();
});
