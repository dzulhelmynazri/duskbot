// The app's egress link is a websocket the home holds open while it is awake: it must never count as someone using the
// home, nor as work in flight, or a madani cloud home that sleeps when idle stays up (and billing) while the app is open.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { CLOUD_IDLE_ACTIVITY_MS, CLOUD_IDLE_AWAKE_MS, createCloudPower } from "./cloud-power.ts";
import { createHomeEgressLink } from "./home-egress-link.ts";
import { createHomeEgressLinkRoutes, HOME_EGRESS_LINK_PATH } from "./routes/home-egress-link.ts";
import type { RouteContext } from "./routes/table.ts";
import { createUpgrades } from "./routes/upgrades.ts";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const done of cleanup.splice(0)) done(); });

async function homeWithLink() {
  let clock = Date.UTC(2026, 10, 14, 12);
  const dataDir = mkdtempSync(join(tmpdir(), "madani-egress-power-"));
  const power = createCloudPower({ dataDir, now: () => clock, broadcast: () => {}, probes: {
    turn: () => false, run: () => false, liveCall: () => false, computer: () => false, maintenance: () => false, nextDueAt: () => null,
  } });
  const upgrades = createUpgrades();
  const route = createHomeEgressLinkRoutes({ link: createHomeEgressLink(), upgrades });
  const server = createServer();
  const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  // as server/index.ts: every authenticated request goes through the power's request() before its route
  upgrades.attach(server, async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    power.request(url.pathname, req.headers, res);
    await route({ req, res, url, path: url.pathname, method: req.method ?? "GET", json, readBody: async () => "",
      auth: { kind: "session", via: "bearer", scopes: ["admin"] } } as unknown as RouteContext);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  cleanup.push(() => { power.close(); server.closeAllConnections(); server.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const pass = (ms: number) => { for (let left = ms; left > 0; left -= 5_000) { clock += Math.min(5_000, left); power.tick(); } };
  return { power, pass, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}${HOME_EGRESS_LINK_PATH}` };
}

describe("the app's egress link on a cloud home that sleeps", () => {
  it("lets the home go idle while the link is open, and after it closes", async () => {
    const h = await homeWithLink();
    h.pass(CLOUD_IDLE_ACTIVITY_MS + CLOUD_IDLE_AWAKE_MS);
    const ws = new WebSocket(h.url);
    await new Promise((open, fail) => { ws.once("open", open); ws.once("error", fail); });
    h.pass(CLOUD_IDLE_AWAKE_MS);
    expect(h.power.report()).toMatchObject({ idle: true, busy: [] });
    expect(h.power.prepareSleep()).toMatchObject({ ok: true });
    const closed = new Promise((done) => ws.once("close", done));
    ws.close();
    await closed;
    h.pass(CLOUD_IDLE_AWAKE_MS);
    expect(h.power.report()).toMatchObject({ idle: true, busy: [] });
  });
});
