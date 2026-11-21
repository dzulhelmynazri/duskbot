import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDashboardApp } from "../../app.ts";
import { memoryMailer } from "../../auth/mail.ts";
import { memorySink, type StoredEvent } from "../../analytics/sink.ts";
import { cloudFleetOf, desktopFleetOf, serverFleet, type FleetAnswer } from "./fleet.ts";

const NOW = Date.parse("2026-11-20T12:00:00Z"), DAY = 86_400_000;
const open = (install: string, version: string, at: number, name = "app_open"): StoredEvent =>
  ({ id: `${install}-${at}-${name}`, name, at, accountId: null, props: {}, ctx: { install, app: { platform: "darwin", version } } as StoredEvent["ctx"] });

describe("the fleet", () => {
  it("counts each desktop install once, at the version it opened last, and errors by version", () => {
    const rows = desktopFleetOf([open("a", "0.2.24", NOW - 3 * DAY), open("a", "0.2.25", NOW - DAY), open("b", "0.2.24", NOW - DAY), open("c", "0.2.25", NOW - 40 * DAY),
      open("b", "0.2.24", NOW - DAY, "app_error"), open("a", "0.2.25", NOW - DAY, "app_error"), open("a", "0.2.25", NOW - DAY, "app_error")], NOW - 14 * DAY, NOW);
    expect(rows).toEqual([{ version: "0.2.25", installs: 1, errors: 2 }, { version: "0.2.24", installs: 1, errors: 1 }]);
  });

  it("counts managed clouds by version and reports the canary clouds' trial", () => {
    const update = (version: string, extra: object = {}) => ({ update: { guard: { current: { version, sha256: "a".repeat(64) }, previous: null, policy: { serial: 0, floor: null, blocked: [] }, failed: [], trial: null, last: null, ...extra }, refused: null, stuck: false, retryAt: null } });
    const clouds = [
      { id: "c1", status: "running", managed: update("0.2.26", { trial: { to: { version: "0.2.26" }, selfTest: "passed" } }) },
      { id: "c2", status: "sleeping", managed: update("0.2.25", { last: { kind: "rolled_back", version: "0.2.26", at: 1 } }) },
      { id: "c3", status: "destroyed", managed: update("0.2.25") },
      { id: "c4", status: "running" },
    ];
    const answer = cloudFleetOf(clouds as never, ["c1", "c2", "nope"]);
    expect(answer.versions).toEqual([{ version: "0.2.26", clouds: 1, onTrial: 1 }, { version: "0.2.25", clouds: 1, onTrial: 0 }]);
    expect(answer.canary).toEqual([
      { id: "c1", version: "0.2.26", trial: "passed", rolledBack: null, refused: null, stuck: false },
      { id: "c2", version: "0.2.25", trial: null, rolledBack: "0.2.26", refused: null, stuck: false },
      { id: "nope", version: null, trial: null, rolledBack: null, refused: null, stuck: false },
    ]);
  });

  it("reads the link service's counts with its stats token, and nothing without one", async () => {
    expect(await serverFleet({})).toBeNull();
    const seen: string[] = [];
    const fetcher = (async (url: string, init: RequestInit) => { seen.push(`${url} ${(init.headers as Record<string, string>).authorization}`); return new Response(JSON.stringify({ windowMs: 1, servers: [{ version: "0.2.25", count: 3 }], agents: [] })); }) as unknown as typeof fetch;
    expect(await serverFleet({ MADANI_LINK_STATS_TOKEN: "t", MADANI_LINK_URL: "https://link.example/" }, fetcher)).toEqual({ windowMs: 1, servers: [{ version: "0.2.25", count: 3 }], agents: [] });
    expect(seen).toEqual(["https://link.example/ops/fleet Bearer t"]);
  });
});

describe("GET /v1/ops/fleet", () => {
  const TOKEN = "o".repeat(32);
  let server: Server, dataDir: string, app: ReturnType<typeof createDashboardApp>;
  afterEach(async () => {
    app.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("answers counts to the ops token only, and hides itself from everyone else", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "madani-fleet-test-"));
    const sink = memorySink(() => NOW);
    await sink.insert(open("a", "0.2.25", NOW - DAY));
    app = createDashboardApp({ dataDir, publicUrl: "http://127.0.0.1:7999", mailer: memoryMailer(), staticDir: null, now: () => NOW, analytics: { sink }, admin: { emails: [], env: { MADANI_OPS_TOKEN: TOKEN } } });
    server = createServer(app.handle);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    expect((await fetch(`${base}/v1/ops/fleet`)).status).toBe(404);
    expect((await fetch(`${base}/v1/ops/fleet`, { headers: { authorization: `Bearer ${"x".repeat(32)}` } })).status).toBe(404);
    expect((await fetch(`${base}/v1/ops/fleet?canary=../x`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(400);
    const answer = await (await fetch(`${base}/v1/ops/fleet?days=7&canary=c1`, { headers: { authorization: `Bearer ${TOKEN}` } })).json() as FleetAnswer;
    expect(answer).toMatchObject({ desktops: { days: 7, versions: [{ version: "0.2.25", installs: 1, errors: 0 }] }, clouds: { versions: [], canary: [{ id: "c1", version: null }] }, servers: null });
  });
});
