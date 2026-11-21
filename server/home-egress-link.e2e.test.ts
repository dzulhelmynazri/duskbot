// A madani cloud home's built-in browser meets a site that blocks the datacenter and lets a home connection through. The
// pieces are the real ones: the browser's gate (gate.ts) with its through route, this server's link and its websocket
// route, the app's link client (electron/home-egress-link.mjs) over the app's own websocket client, and the app's egress
// endpoint (electron/vps-link-egress.mjs). Only the dialer on "the person's computer" is a stand-in: it reaches the
// fixture's "home" listener, as a real home connection would reach the site from a home address.
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createHomeEgressLink as createAppLink } from "../electron/home-egress-link.mjs";
import { createEgressEndpoint } from "../electron/vps-link-egress.mjs";
import type { CdpPage } from "./browser/cdp/page.ts";
import { CHROME, startChrome, type RunningChrome } from "./browser/cdp/testing/real-chrome.ts";
import { openGate, type EgressGate } from "./browser/egress/gate.ts";
import { createComputerEgress } from "./computer-egress.ts";
import { HUMAN_CHECK_PAGE, parseHumanCheckPage, RELOAD_PAGE } from "./host/human-check-watch.ts";
import { createSignInRequests } from "./host/sign-in-requests.ts";
import { runSiteBlockLadder, wallState } from "./host/site-block-ladder.ts";
import { createHomeEgressLink } from "./home-egress-link.ts";
import { createHomeEgressLinkRoutes } from "./routes/home-egress-link.ts";
import { PASS, type RouteContext } from "./routes/table.ts";
import { createUpgrades } from "./routes/upgrades.ts";
import type { BotRecord, Message } from "./store.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const suite = CHROME ? describe : describe.skip;
// the app's own websocket client (no declaration file: it is the app's)
const { wssConnector } = await import("../electron/vps-link-direct.mjs" as string) as {
  wssConnector(options: { url: string; spki: null; headers: Record<string, string> }): () => Promise<{ readable: import("node:stream").Duplex; close(): void }>;
};
const CONTENT = `<!doctype html><meta charset="utf-8"><title>New paste</title><h1>New paste</h1><textarea></textarea><button>Create new paste</button>${"<p>Lorem ipsum.</p>".repeat(80)}`;
const DENIED = `<!doctype html><meta charset="utf-8"><title>Access denied</title><h1>Access denied</h1><p>Your request was blocked.</p>`;

suite("a cloud home's built-in browser through the person's connection", () => {
  const servers: Server[] = [];
  const sockets = new Set<Socket>();
  let datacenter = 0, home = 0, cloud = 0;
  let homeHits = 0;
  let run: RunningChrome, page: CdpPage, gate: EgressGate;
  const link = createHomeEgressLink();
  const egress = createComputerEgress({ enabled: () => false, docker: () => null });
  let app: ReturnType<typeof createAppLink>;

  async function listen(server: Server): Promise<number> {
    servers.push(server);
    server.on("connection", (socket: Socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
  }

  beforeAll(async () => {
    const respond = (status: number, body: string) => (_req: IncomingMessage, res: ServerResponse) => { res.writeHead(status, { "content-type": "text/html", "cache-control": "no-store" }); res.end(body); };
    datacenter = await listen(createHttpServer(respond(403, DENIED)));
    home = await listen(createHttpServer((req, res) => { homeHits += 1; respond(200, CONTENT)(req, res); }));
    // the cloud home's own server: only the link route, as the owner's app
    const upgrades = createUpgrades();
    const route = createHomeEgressLinkRoutes({ link, upgrades });
    const handle = async (req: IncomingMessage, res: ServerResponse) => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      const ctx = { req, res, path, method: req.method ?? "GET", url: new URL(req.url ?? "/", "http://x"), auth: { kind: "loopback", scopes: ["admin", "client"] },
        json: (r: ServerResponse, status: number, body: unknown) => { r.writeHead(status, { "content-type": "application/json" }); r.end(JSON.stringify(body)); }, readBody: async () => ({}) } as unknown as RouteContext;
      if ((await route(ctx)) === PASS) { res.writeHead(404); res.end(); }
    };
    const cloudServer = createHttpServer((req, res) => void handle(req, res));
    upgrades.attach(cloudServer, handle);
    cloud = await listen(cloudServer);
    // the app on the person's computer
    app = createAppLink({
      origin: () => `http://127.0.0.1:${cloud}`, awake: () => true, cookie: async () => "madani_session=fixture", checkMs: 200,
      connect: (url, headers) => wssConnector({ url, spki: null, headers })(),
      endpoint: (tunnel) => createEgressEndpoint({ ...tunnel, dialer: { open: () => new Promise((resolve) => {
        const socket = connect(home, "127.0.0.1", () => resolve({ socket }));
        socket.once("error", () => resolve({ failed: "unreachable" }));
      }) } }),
    });
    app.check();
    gate = await openGate({
      decide: async () => null,
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
      through: (target) => (link.online() && egress.routesHome(target.host) ? link.open(target.host, target.port) : null),
    });
    run = await startChrome("home-egress", { launch: { egressPort: gate.port } });
    page = await run.browser.waitForPage();
  }, hostTimeout(180_000));

  afterAll(async () => {
    app?.close();
    link.close();
    await run?.close();
    await gate?.close();
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  });

  it("links the app over the home's own https and says when it takes streams", async () => {
    await expect.poll(() => link.online(), { timeout: 10_000 }).toBe(true);
    expect(app.linked()).toBe(true);
  }, hostTimeout(20_000));

  it("a bot that meets the datacenter block finishes through the person's connection, with no ask; other sites stay put", async () => {
    const site = `http://blocked.test:${datacenter}/`;
    await page.navigate(site).catch(() => undefined);
    const read = async () => parseHumanCheckPage(await page.evaluate(HUMAN_CHECK_PAGE).catch(() => null));
    expect(wallState((await read())!)).toBe("blocked");

    const messages: Message[] = [];
    const nova = { id: "b1", name: "Nova", color: "green" } as BotRecord;
    const flow = createSignInRequests({
      store: { appendMessage: ((_t: string, row: Partial<Message>) => { const m = { id: `m${messages.length + 1}`, at: Date.now(), ...row } as Message; messages.push(m); return m; }) as never,
        activePath: () => messages, patchMessage: (() => null) as never },
      connectorThread: () => ({ bot: nova, group: undefined }), signInPlace: () => "browser", threadLanguage: () => undefined, followCard: () => undefined,
      computerControl: { requestHelp: () => ({ held: false, helpReason: null, heldSinceMs: null }), settleHelp: () => [] }, signInControlKey: () => "b1",
      // as server/index.ts wires the built-in browser on a cloud home
      recoverCheck: (ref, { quick }) => runSiteBlockLadder({
        read, reload: () => page.evaluate(RELOAD_PAGE).catch(() => null),
        homeRoute: async () => {
          if (!link.online() || !egress.markBlocked(ref.site)) return false;
          gate.drop((host) => host === ref.site || host.endsWith(`.${ref.site}`));
          return true;
        },
      }, { quick }),
    });
    expect(await flow.requestSignIn(nova, "t1", "blocked.test", "", true)).toMatchObject({ outcome: "cleared", via: "home" });
    expect(messages.filter((message) => message.kind === "signin")).toEqual([]);
    expect(await page.evaluate("document.title")).toBe("New paste");
    expect(homeHits).toBeGreaterThan(0);
    expect(egress.status().blockedSites).toEqual(["blocked.test"]);
    // another site is not routed: it still meets the datacenter
    const before = homeHits;
    await page.navigate(`http://other.test:${datacenter}/`).catch(() => undefined);
    expect(wallState((await read())!)).toBe("blocked");
    expect(homeHits).toBe(before);
  }, hostTimeout(120_000));

  it("falls back to the datacenter cleanly when the person's computer goes offline", async () => {
    app.close();
    await expect.poll(() => link.online(), { timeout: 5_000 }).toBe(false);
    gate.drop(() => true);
    await page.navigate(`http://blocked.test:${datacenter}/`).catch(() => undefined);
    const probe = parseHumanCheckPage(await page.evaluate(HUMAN_CHECK_PAGE).catch(() => null));
    expect(probe && wallState(probe)).toBe("blocked");
  }, hostTimeout(30_000));
});
