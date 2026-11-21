// Connectors follow the person between this computer and My Cloud, on two real servers with main's own wiring
// (scripts/testing/cloud-send-fixture.ts) and a fake connector service: an MCP server whose sign-in rotates its refresh
// token on every use and ends the whole sign-in when a spent one comes back, as Composio's does. A server connected on
// one side is connected and usable on the other, through the move to My Cloud and the way home, and a sign-out or a
// removal on one side reaches the other.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

import { bringSignInsHome, localPlace, remotePlace, syncConnectors, writes, type Place } from "../electron/connector-sync.mjs";
import { launchCloudSendFixture, type CloudSendFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { openMcpOAuthFile } from "./mcp-oauth-store.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

/** The fake connector service: tokens per person, refresh tokens spent once, the person's connected apps as tools. */
function connectorService() {
  const access = new Set<string>();
  const refresh = new Map<string, "live" | "spent">();
  const apps = new Set<string>();
  const seen = { refreshes: 0, reused: false, refused: 0 };
  const mint = () => {
    const pair = { access_token: `fake-conn-access-${hex(12)}`, refresh_token: `fake-conn-refresh-${hex(12)}` };
    access.add(pair.access_token);
    refresh.set(pair.refresh_token, "live");
    return pair;
  };
  const endAll = () => { access.clear(); for (const key of refresh.keys()) refresh.set(key, "spent"); };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (req.url === "/token") {
        const form = new URLSearchParams(body);
        const token = form.get("refresh_token") ?? "";
        const state = refresh.get(token);
        if (form.get("grant_type") !== "refresh_token" || state !== "live") {
          if (state === "spent") { seen.reused = true; endAll(); }
          res.writeHead(400, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: "invalid_grant" }));
        }
        refresh.set(token, "spent");
        seen.refreshes++;
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ...mint(), expires_in: 600, token_type: "Bearer" }));
      }
      const bearer = /^Bearer (.+)$/u.exec(String(req.headers.authorization ?? ""))?.[1];
      if (!bearer || !access.has(bearer)) {
        seen.refused++;
        res.writeHead(401, { "www-authenticate": "Bearer" });
        return res.end();
      }
      let message: { id?: number; method?: string } = {};
      try { message = JSON.parse(body); } catch {}
      if (message.id === undefined) { res.writeHead(202); return res.end(); }
      const result = message.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-connector", version: "1" } }
        : message.method === "tools/list"
          ? { tools: [...apps].map((app) => ({ name: `${app}_send`, description: `Send with ${app}`, inputSchema: { type: "object", properties: {} } })) }
          : {};
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  return { server, mint, apps, seen };
}

let fx: CloudSendFixture;
let service: ReturnType<typeof connectorService>;
let host = "";

beforeAll(async () => {
  service = connectorService();
  await new Promise<void>((resolve) => service.server.listen(0, "127.0.0.1", resolve));
  host = `127.0.0.1:${(service.server.address() as { port: number }).port}`;
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-sync-${hex(8)}`, env: { MADANI_TEST_CONNECTOR_HOSTS: host } });
}, hostTimeout(90_000));
afterAll(async () => {
  await fx?.close();
  await new Promise((resolve) => service?.server.close(resolve));
});

const asCall = (side: CloudSendFixture["local"]) => async (method: string, route: string, body?: unknown) => {
  const answer = await side(method, route, body);
  return { ok: answer.status >= 200 && answer.status < 300, ...answer };
};
/** This computer as main reaches it: loopback writes, secrets over the private port. */
const here = () => localPlace(async (route: string, init: RequestInit = {}) => {
  const answer = await fx.local(init.method ?? "GET", route, init.body ? JSON.parse(String(init.body)) : undefined);
  return new Response(answer.body === null || answer.body === undefined ? "" : JSON.stringify(answer.body), { status: answer.status });
}, (what: object) => fx.handoff(what as never));
const cloud = () => remotePlace(asCall(fx.onCloud));
const places = (): Place[] => [
  { key: "local", kind: "local", label: "This computer", client: here() },
  { key: "cloud", kind: "cloud", label: "My Cloud", client: cloud() },
];

const listed = async (side: CloudSendFixture["local"]) => (await side("GET", "/api/connector-sync")).body;
const signIn = async (side: CloudSendFixture["local"], name = "notes") => (await listed(side)).servers.find((server: { name: string }) => server.name === name)?.signIn;
/** A real connection test from that side: the tools its sign-in reaches, or why not. */
const tools = async (side: CloudSendFixture["local"], name = "notes") => {
  const probe = await side("POST", `/api/mcp/servers/${name}/test`);
  return probe.body?.ok ? (probe.body.tools ?? []).map((tool: { name: string }) => tool.name).sort() : `not usable: ${probe.status} ${probe.body?.auth ?? probe.body?.error ?? ""}`;
};
const seedSignIn = (pair: { access_token: string; refresh_token: string }) => {
  const file = join(fx.root, "desktop", ".madanibot", "mcp-oauth.json");
  writeFileSync(file, JSON.stringify({ servers: { notes: { url: `http://${host}/mcp`, state: "signed-in", clientId: "fake-public-client",
    tokenEndpoint: `http://${host}/token`, tokens: { access: pair.access_token, refresh: pair.refresh_token, expiresAt: Date.now() + 9 * 60_000 } } } }));
};

it("a connector connected on this computer is connected and usable on My Cloud, through the move, a sign-out and the way home", async () => {
  // Connected here: the server, signed in, with Gmail connected through it.
  expect((await fx.local("POST", "/api/mcp/servers", { name: "notes", type: "http", url: `http://${host}/mcp` })).status).toBe(201);
  expect((await fx.local("PATCH", "/api/mcp/servers/notes", { enabled: true })).status).toBe(200);
  seedSignIn(service.mint());
  service.apps.add("gmail");
  expect(await tools(fx.local)).toEqual(["gmail_send"]);
  expect((await signIn(fx.local)).role).toBe("holder");

  // Level: My Cloud gets the server, holds the sign-in (it is always on), this computer keeps using it, lent.
  const first = await syncConnectors(places());
  expect(first.failed).toEqual([]);
  expect(first.added).toEqual([{ name: "notes", place: "My Cloud" }]);
  expect(first.moved).toEqual([{ name: "notes", from: "This computer", to: "My Cloud" }]);
  expect((await signIn(fx.onCloud)).role).toBe("holder");
  expect((await signIn(fx.local)).role).toBe("lent");
  expect(openMcpOAuthFile(join(fx.root, "desktop", ".madanibot", "mcp-oauth.json")).servers.notes.tokens.refresh, "this computer no longer has the refresh token").toBeUndefined();
  expect(await tools(fx.onCloud)).toEqual(["gmail_send"]);
  expect(await tools(fx.local)).toEqual(["gmail_send"]);

  // An app connected through it shows on both at once: it is the person's, not a place's.
  service.apps.add("notion");
  expect(await tools(fx.onCloud)).toEqual(["gmail_send", "notion_send"]);
  expect(await tools(fx.local)).toEqual(["gmail_send", "notion_send"]);

  // Tokens run short: only My Cloud refreshes, this computer gets the new one, and no spent refresh token comes back.
  const before = service.seen.refreshes;
  const topUp = await syncConnectors(places());
  expect(topUp.failed).toEqual([]);
  expect(topUp.lent).toEqual([{ name: "notes", place: "This computer" }]);
  expect(service.seen.refreshes).toBe(before + 1);
  for (let pass = 0; pass < 3; pass++) expect((await syncConnectors(places())).failed).toEqual([]);
  expect(service.seen.reused).toBe(false);
  expect((await signIn(fx.local)).digest).toBe((await signIn(fx.onCloud)).digest);
  expect(await tools(fx.local)).toEqual(["gmail_send", "notion_send"]);

  // Signed out on My Cloud: signed out here too.
  expect((await fx.onCloud("POST", "/api/mcp/servers/notes/sign-out")).status).toBe(200);
  const out = await syncConnectors(places());
  expect(out.signedOut).toEqual([{ name: "notes", place: "This computer" }]);
  expect((await signIn(fx.local)).role).toBe("none");
  expect(await tools(fx.local)).toMatch(/^not usable/u);

  // Signed in again here, then the move to My Cloud: nothing to connect again on either side.
  seedSignIn(service.mint());
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect((await signIn(fx.local)).role).toBe("holder");
  const moved = await fx.move({ final: true });
  expect(moved.result.failed.filter((item: { label?: string }) => item.label === "notes")).toEqual([]);
  expect((await signIn(fx.onCloud)).role).toBe("holder");
  expect((await signIn(fx.local)).role, "the move keeps this computer's access token, lent").toBe("lent");
  expect(await tools(fx.onCloud)).toEqual(["gmail_send", "notion_send"]);
  expect(await tools(fx.local)).toEqual(["gmail_send", "notion_send"]);
  expect((await syncConnectors(places())).failed).toEqual([]);

  // The way home (My Cloud ended): the sign-in comes back to this computer, which holds and refreshes it.
  expect(await bringSignInsHome(cloud(), writes(asCall(fx.local)))).toEqual(["notes"]);
  expect((await signIn(fx.local)).role).toBe("holder");
  expect((await signIn(fx.onCloud)).role).toBe("lent");
  const refreshed = service.seen.refreshes;
  expect(await fx.handoff({ kind: "connector", op: "lend", name: "notes" } as never)).toMatchObject({ ok: true });
  expect(await tools(fx.local)).toEqual(["gmail_send", "notion_send"]);
  expect(service.seen.refreshes, "this computer refreshes it now").toBeGreaterThanOrEqual(refreshed);
  expect(service.seen.reused).toBe(false);

  // Removed here: removed on My Cloud.
  expect((await fx.local("DELETE", "/api/mcp/servers/notes")).status).toBe(200);
  const removed = await syncConnectors(places());
  expect(removed.removed).toEqual([{ name: "notes", place: "My Cloud" }]);
  expect((await listed(fx.onCloud)).servers).toEqual([]);

  // No token was ever written where a person or a log reads it.
  for (const answer of fx.answers.filter((text) => !text.includes("\"access\""))) expect(answer).not.toMatch(/fake-conn-refresh-/u);
  expect(fx.logs()).not.toMatch(/fake-conn-(access|refresh)-/u);
}, hostTimeout(180_000));

it("the private secrets routes answer only the person's own session on their own place", async () => {
  expect((await fx.local("POST", "/api/mcp/servers", { name: "docs", type: "http", url: `http://${host}/mcp`, headers: { Authorization: `Bearer fake-docs-${hex(6)}` } })).status).toBe(201);
  expect((await fx.local("GET", "/api/connector-sync/servers/docs/definition")).status, "this computer answers secrets only over its private port").toBe(404);
  expect((await fx.local("POST", "/api/connector-sync/servers/docs/take", {})).status).toBe(404);
  const listing = await listed(fx.local);
  expect(JSON.stringify(listing)).not.toMatch(/fake-docs-/u);
  expect((await fx.handoff({ kind: "connector", op: "definition", name: "docs" } as never)).connector.server.headers.Authorization).toMatch(/^Bearer fake-docs-/u);
}, hostTimeout(60_000));
