import type { IncomingMessage } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRequestAuth } from "../request-auth.ts";
import { createScreenDirect } from "../screen-direct.ts";
import { SessionRegistry } from "../sessions.ts";
import { createScreenTransportAgentRoutes, SCREEN_TRANSPORT_AGENT_PATH, screenTransportCounters } from "./screen-transport-agent.ts";
import { PASS, type RouteContext } from "./table.ts";

function call(handler: ReturnType<typeof createScreenTransportAgentRoutes>, auth: RouteContext["auth"], method: string, path = SCREEN_TRANSPORT_AGENT_PATH) {
  let answer: { status: number; body: unknown } | null = null;
  const headers: Record<string, string> = {};
  const ctx = {
    req: {} as RouteContext["req"], res: { setHeader: (name: string, value: string) => { headers[name] = value; } } as unknown as RouteContext["res"],
    url: new URL(`http://x${path}`), path, method, auth,
    json: ((_res: unknown, status: number, value: unknown) => { answer = { status, body: value }; }) as unknown as RouteContext["json"],
    readBody: (async () => null) as unknown as RouteContext["readBody"],
  };
  return handler(ctx).then((out) => (out === PASS ? "pass" : { ...answer!, headers }));
}

const owner = { kind: "loopback", scopes: ["admin", "client"] } as const;
const service = { kind: "loopback", scopes: ["client"], trust: "service" } as const;
const companion = { kind: "loopback", scopes: ["admin", "client"], companionDevice: "phone-1" } as const;
const session = { kind: "session", via: "bearer", scopes: ["admin", "client"], session: { id: "s" } } as unknown as RouteContext["auth"];

describe("the link agent's screen counters", () => {
  it("answers the agent on owner-trust loopback with the whole shape, all zero on a fresh server", async () => {
    const direct = createScreenDirect({ load: () => null, now: () => new Date("2026-11-13T10:00:00.000Z") });
    const routes = createScreenTransportAgentRoutes({ stats: () => direct.stats() });
    const answer = await call(routes, owner, "GET");
    expect(answer).toMatchObject({ status: 200, headers: { "cache-control": "no-store" } });
    const body = (answer as { body: Record<string, unknown> }).body;
    expect(body).toMatchObject({
      v: 1, since: "2026-11-13T10:00:00.000Z", available: false,
      paths: { direct: 0, "cloudflare-turn": 0, "our-relay": 0 }, pairs: {},
      direct: { sessions: 0, open: 0, failed: 0, bytesSent: 0, bytesReceived: 0, candidates: { host: 0, srflx: 0, prflx: 0, relay: 0 } },
      relay: { sessions: 0, open: 0, bytesSent: 0, bytesReceived: 0 },
    });
    expect((body.relay as { reasons: Record<string, number> }).reasons.none).toBe(0);
  });

  it("refuses everyone else: a session (even admin), a phone's companion, a shared server's bot shell; GET only", async () => {
    const routes = createScreenTransportAgentRoutes({ stats: () => null });
    for (const auth of [session, companion, service]) expect((await call(routes, auth, "GET") as { status: number }).status).toBe(403);
    expect((await call(routes, owner, "POST") as { status: number }).status).toBe(405);
    expect(await call(routes, owner, "GET", "/api/computer/egress")).toBe("pass");
    expect(await call(routes, owner, "GET", "/api/desktop-viewer/transport")).toBe("pass");
  });

  it("copies only aggregate numbers: unknown fields, odd keys and non-numbers never pass", () => {
    const counters = screenTransportCounters({
      since: "not a date", available: true,
      paths: { direct: 3, "our-relay": 2.7, "cloudflare-turn": -1 },
      pairs: { "srflx/relay": 2, "203.0.113.7:30001/host": 1, "Bot Name": 4 } as Record<string, number>,
      direct: { sessions: 5, open: 1, failed: Number.NaN, bytesSent: 10, bytesReceived: "9" as unknown as number, candidates: { host: 1, srflx: 2, prflx: 0, relay: 1 }, peers: ["10.0.0.2"] } as never,
      relay: { sessions: 2, open: 0, bytesSent: 1, bytesReceived: 2, reasons: { "ice-failed": 1, none: 1 } } as never,
      viewers: [{ bot: "b1", address: "198.51.100.1" }],
    } as never);
    expect(counters).toEqual({
      v: 1, since: null, available: true,
      paths: { direct: 3, "our-relay": 2, "cloudflare-turn": 0 },
      pairs: { "srflx/relay": 2 },
      direct: { sessions: 5, open: 1, failed: 0, bytesSent: 10, bytesReceived: 0, candidates: { host: 1, srflx: 2, prflx: 0, relay: 1 } },
      relay: { sessions: 2, open: 0, bytesSent: 1, bytesReceived: 2, reasons: { "ice-failed": 1, none: 1 } },
    });
    expect(screenTransportCounters(null)).toMatchObject({ v: 1, since: null, available: false, paths: {}, direct: { sessions: 0 } });
  });
});

describe("the agent's request reaches the route", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  // exactly what agent.mjs's local() sends to 127.0.0.1:8799
  const agentRequest = { headers: { host: "127.0.0.1:8799", accept: "application/json", "x-madani-cli": "1" }, method: "GET" } as unknown as IncomingMessage;

  function resolve(options: { loopbackTrust?: "owner" | "service"; loopbackMutationToken?: string }) {
    const dir = mkdtempSync(join(tmpdir(), "madani-screen-agent-"));
    dirs.push(dir);
    return resolveRequestAuth(agentRequest, { sessions: new SessionRegistry({ file: join(dir, "sessions.json") }), cookieName: "c", streamPath: "/api/events", url: new URL(SCREEN_TRANSPORT_AGENT_PATH, "http://127.0.0.1:8799"), ...options });
  }

  it("as owner-trust loopback on a self-hosted server, not caught by the desktop viewer's mutation rule", () => {
    expect(resolve({}).auth).toEqual({ kind: "loopback", scopes: ["admin", "client"] });
    expect(resolve({ loopbackTrust: "owner", loopbackMutationToken: "t".repeat(43) }).auth).toEqual({ kind: "loopback", scopes: ["admin", "client"] });
    // a shared server (and a cloud home): a bot's shell is loopback too, so the gate refuses before the route
    expect(resolve({ loopbackTrust: "service" })).toMatchObject({ auth: null, status: 403 });
  });
});
