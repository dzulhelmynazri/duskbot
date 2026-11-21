import { createServer, type RequestListener, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMobileSessions } from "../src/mobile.ts";
import { createProxyHandler } from "../src/proxy.ts";

const TOKEN = `madani_sess_${"a".repeat(43)}`;
const servers: Server[] = [];

async function listen(server: Server): Promise<number> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as { port: number }).port;
}

afterEach(async () => {
  for (const server of servers.splice(0).reverse()) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function fixture(listener: RequestListener) {
  const reached = vi.fn(listener);
  const harnessPort = await listen(createServer(reached));
  const mobile = createMobileSessions({ file: null });
  mobile.remember(TOKEN, "phone");
  const port = await listen(createServer(createProxyHandler({
    harnessPort,
    mobile,
    authenticate: () => null,
    mutationToken: () => "sidecar-only-secret",
    redeem: () => ({ error: "not pairing" }),
    serverName: () => "fixture",
  })));
  return { reached, url: `http://127.0.0.1:${port}` };
}

const preflight = (url: string, origin: string, method = "GET", headers = "authorization") => fetch(url, {
  method: "OPTIONS",
  headers: { origin, "access-control-request-method": method, "access-control-request-headers": headers },
});

describe("the phone app's WebView origin", () => {
  it.each(["https://localhost", "capacitor://localhost"])("streams events to %s with a bearer", async (origin) => {
    const event = "data: {\"kind\":\"reply\"}\n\n";
    const app = await fixture((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(event);
    });
    const allowed = await preflight(`${app.url}/api/events`, origin, "GET", "authorization");
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(origin);
    expect(allowed.headers.get("access-control-allow-methods")).toBe("GET");
    expect(allowed.headers.get("access-control-allow-headers")).toBe("Authorization");
    expect(app.reached).not.toHaveBeenCalled();

    const response = await fetch(`${app.url}/api/events`, {
      headers: { origin, authorization: `Bearer ${TOKEN}`, accept: "text/event-stream" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(event);
    await reader.cancel();
    expect(app.reached.mock.calls[0][0].headers.origin).toBeUndefined();
  });

  it("lets the app read a refused credential", async () => {
    const app = await fixture((_req, res) => res.end());
    const response = await fetch(`${app.url}/api/events`, {
      headers: { origin: "https://localhost", authorization: "Bearer madani_unknown_device" },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://localhost");
    expect(app.reached).not.toHaveBeenCalled();
  });

  it("refuses it without a bearer, on writes and on pairing", async () => {
    const app = await fixture((_req, res) => res.end());
    const origin = "https://localhost";
    expect((await fetch(`${app.url}/api/events`, { headers: { origin } })).status).toBe(403);
    expect((await fetch(`${app.url}/api/health`, { headers: { origin } })).status).toBe(403);
    expect((await fetch(`${app.url}/api/mobile/redeem`, { method: "POST", headers: { origin } })).status).toBe(403);
    expect((await fetch(`${app.url}/api/pair`, { method: "POST", headers: { origin } })).status).toBe(403);
    expect((await fetch(`${app.url}/api/bots`, { method: "POST", headers: { origin, authorization: `Bearer ${TOKEN}` } })).status).toBe(403);
    expect((await preflight(`${app.url}/api/bots`, origin, "POST", "authorization, content-type")).status).toBe(403);
    expect((await preflight(`${app.url}/api/events`, origin, "GET", "authorization, x-forged")).status).toBe(403);
    expect(app.reached).not.toHaveBeenCalled();
  });

  it.each(["https://example.test", "http://localhost", "https://localhost:8443", "capacitor://example.test", "null"])(
    "still refuses %s before the token",
    async (origin) => {
      const app = await fixture((_req, res) => res.end());
      const response = await fetch(`${app.url}/api/events`, { headers: { origin, authorization: `Bearer ${TOKEN}` } });
      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      const asked = await preflight(`${app.url}/api/events`, origin);
      expect(asked.status).toBe(403);
      expect(asked.headers.get("access-control-allow-origin")).toBeNull();
      expect(app.reached).not.toHaveBeenCalled();
    },
  );
});
