import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createDashboardApp } from "./app.ts";
import { memoryMailer } from "./auth/mail.ts";
import { CSRF_HEADER } from "../../../shared/account-api.ts";

// the page at /dashboard, the admin panel at /admin (owner only), the site at every other path, all on one origin
describe("one origin: dashboard, admin and site", () => {
  const origin = "https://madani.test", OWNER = "owner@madani.test";
  let mailer: ReturnType<typeof memoryMailer>;
  let app: ReturnType<typeof createDashboardApp>;
  let server: Server, site: Server;
  let dataDir: string, staticDir: string, url: string;
  const siteHits: string[] = [];

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "madani-one-origin-"));
    staticDir = mkdtempSync(join(tmpdir(), "madani-one-origin-static-"));
    writeFileSync(`${staticDir}/index.html`, "<!doctype html><title>page shell</title>");
    mkdirSync(`${staticDir}/assets/admin`, { recursive: true });
    writeFileSync(`${staticDir}/assets/main.js`, "main");
    writeFileSync(`${staticDir}/assets/admin/AdminApp-x.js`, "admin chunk");
    siteHits.length = 0;
    site = createServer((req, res) => { siteHits.push(req.url ?? ""); res.writeHead(404, { "content-type": "text/plain" }); res.end("site 404"); });
    await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
    const siteAddress = site.address() as { port: number };
    mailer = memoryMailer();
    app = createDashboardApp({ dataDir, publicUrl: origin, mailer, staticDir, pageBase: "/dashboard", siteUpstream: `http://127.0.0.1:${siteAddress.port}`, admin: { emails: [OWNER] } });
    server = createServer(app.handle);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    app.close();
    for (const s of [server, site]) await new Promise<void>(resolve => { s.close(() => resolve()); s.closeAllConnections(); });
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(staticDir, { recursive: true, force: true });
  });

  const get = (path: string, headers: Record<string, string> = {}) => fetch(`${url}${path}`, { redirect: "manual", headers });
  /** a request with an exact Host header (fetch will not send one of its own choosing) */
  const hosted = (host: string, path: string, method = "GET") => new Promise<{ status: number; location?: string }>((resolve, reject) => {
    const out = request(`${url}${path}`, { method, headers: { host } }, answer => { answer.resume(); resolve({ status: answer.statusCode ?? 0, location: answer.headers.location }); });
    out.on("error", reject); out.end();
  });
  async function login(email: string) {
    const post = (path: string, body: unknown) => fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });
    const { attempt } = await (await post("/v1/auth/start", { email })).json() as { attempt: string };
    const sent = mailer.outbox.findLast(item => item.to === email)!.text.match(/\b\d{8}\b/)![0];
    const verify = await post("/v1/auth/verify", { attempt, code: sent });
    expect(verify.status).toBe(200);
    const csrf = (await verify.json() as { csrfToken: string }).csrfToken;
    return { cookie: verify.headers.get("set-cookie")!.split(";")[0]!, csrf };
  }

  it("serves the page under /dashboard and sends the old /app addresses on", async () => {
    expect(await (await get("/dashboard")).text()).toContain("page shell");
    expect(await (await get("/dashboard/billing")).text()).toContain("page shell");
    for (const [from, to] of [["/app", "/dashboard"], ["/app/", "/dashboard/"], ["/app/billing?plan=plus", "/dashboard/billing?plan=plus"], ["/app/admin", "/admin"], ["/app/admin/people?x=1", "/admin/people?x=1"]]) {
      const answer = await get(from!);
      expect(answer.status, from).toBe(301);
      expect(answer.headers.get("location"), from).toBe(to);
    }
    const inside = await get("/dashboard/admin/clouds");
    expect([inside.status, inside.headers.get("location")]).toEqual([302, "/admin/clouds"]);
    // a page route without the base still lands in the page
    expect((await get("/billing")).headers.get("location")).toBe("/dashboard/billing");
    expect((await get("/pricing")).status).toBe(404);
    expect(siteHits).toEqual(["/pricing"]);
  });

  it("sends someone signed in from / to the dashboard; signed out, or /?home, still gets the home page", async () => {
    const before = siteHits.length;
    expect((await get("/")).status).toBe(404);
    expect(siteHits.slice(before)).toEqual(["/"]);
    const person = await login("home@madani.test");
    const answer = await get("/", { cookie: person.cookie });
    expect([answer.status, answer.headers.get("location")]).toEqual([302, "/dashboard/"]);
    expect((await get("/?home", { cookie: person.cookie })).status).toBe(404);
  });

  it("answers the apps' @devs reports itself, never the site's 404", async () => {
    const report = { installId: "test-install-0001", source: "bot", description: "it broke", appVersion: "0.1.150", platform: "darwin arm64, desktop app", diagnostics: "" };
    const sent = await fetch(`${url}/api/bug-reports`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(report) });
    expect(sent.status).toBe(201);
    const { id } = await sent.json() as { id: string };
    const asked = await fetch(`${url}/api/bug-reports/status`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ installId: report.installId, ids: [id] }) });
    expect(await asked.json()).toEqual({ reports: [{ id, status: "received", fixedIn: null }], notify: true });
    expect(siteHits).toEqual([]);
  });

  it("shows /admin only to the owner: signed out goes to sign-in, anyone else gets the site's not-found", async () => {
    const out = await get("/admin/people");
    expect(out.status).toBe(302);
    expect(out.headers.get("location")).toBe(`/dashboard/sign-in?${new URLSearchParams({ next: "/admin/people" })}`);

    const stranger = await login("someone@madani.test");
    const denied = await get("/admin", { cookie: stranger.cookie });
    expect([denied.status, await denied.text()]).toEqual([404, "site 404"]);
    expect((await get("/dashboard/assets/admin/AdminApp-x.js", { cookie: stranger.cookie })).status).toBe(404);
    expect((await get("/dashboard/assets/admin/AdminApp-x.js")).status).toBe(404);
    expect(await (await get("/dashboard/assets/main.js", { cookie: stranger.cookie })).text()).toBe("main");
    for (const path of ["/v1/admin/me", "/v1/admin/overview", "/v1/admin/users", "/v1/admin/waitlist"]) expect((await get(path, { cookie: stranger.cookie })).status, path).toBe(403);
    expect((await get("/v1/admin/me")).status).toBe(401);
    const change = await fetch(`${url}/v1/admin/notes`, { method: "POST", headers: { "content-type": "application/json", origin, cookie: stranger.cookie, [CSRF_HEADER]: stranger.csrf }, body: "{}" });
    expect(change.status).toBe(403);

    const owner = await login(OWNER);
    const shell = await get("/admin/people", { cookie: owner.cookie });
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain("page shell");
    expect(await (await get("/dashboard/assets/admin/AdminApp-x.js", { cookie: owner.cookie })).text()).toBe("admin chunk");
    expect((await get("/v1/admin/me", { cookie: owner.cookie })).status).toBe(200);
  });

  it("keeps one public host: www to the apex, app to the page (its API still answers), dev home", async () => {
    expect(await hosted("www.madani.test", "/pricing?a=1")).toEqual({ status: 301, location: "https://madani.test/pricing?a=1" });
    expect(await hosted("app.madani.test", "/")).toEqual({ status: 301, location: "https://madani.test/dashboard" });
    expect(await hosted("app.madani.test", "/billing")).toEqual({ status: 301, location: "https://madani.test/dashboard/billing" });
    expect(await hosted("app.madani.test", "/admin")).toEqual({ status: 301, location: "https://madani.test/admin" });
    expect((await hosted("app.madani.test", "/v1/health")).status).toBe(200);
    expect(await hosted("dev.madani.test", "/anything")).toEqual({ status: 301, location: "https://madani.test/" });
    expect((await hosted("madani.test", "/dashboard")).status).toBe(200);
  });

  it("before launch (waitlistOnly) sends the page home but keeps the apps' and emailed links' flows, the API, webhooks and the site", async () => {
    // without the flag nothing changes
    for (const path of ["/dashboard", "/dashboard/", "/dashboard/billing", "/dashboard/account"]) expect((await get(path)).status).toBe(200);
    app.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    let skew = 0;
    app = createDashboardApp({ dataDir, publicUrl: origin, mailer, staticDir, pageBase: "/dashboard", waitlistOnly: true, now: () => Date.now() + skew,
      siteUpstream: `http://127.0.0.1:${(site.address() as { port: number }).port}`, admin: { emails: [OWNER] } });
    server = createServer(app.handle);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    for (const path of ["/dashboard", "/dashboard/", "/dashboard/billing?plan=plus", "/dashboard/bots/b1", "/dashboard/usage",
      "/dashboard/signup", "/dashboard/welcome", "/dashboard/devices", "/dashboard/nope", "/dashboard/index.html", "/billing", "/signup", "/connectors", "/cloud"]) {
      const answer = await get(path);
      expect([path, answer.status, answer.headers.get("location")]).toEqual([path, 302, "/"]);
    }
    // the account page (where the app stores send people to delete an account) goes to the site's page about it
    for (const path of ["/account", "/account/", "/dashboard/account"]) {
      const answer = await get(path);
      expect([path, answer.status, answer.headers.get("location")]).toEqual([path, 302, "/delete-account"]);
    }
    expect((await get("/account/devices")).headers.get("location")).toBe("/");
    expect((await fetch(`${url}/dashboard/billing`, { method: "HEAD", redirect: "manual" })).status).toBe(302);
    // a plain visit to a flow's page goes home too: nothing on it came from the app or an emailed link
    for (const path of ["/dashboard/sign-in", "/dashboard/signin", "/dashboard/sign-in?next=%2Fbilling", "/dashboard/sign-in?next=%2F%2Fevil.test",
      "/dashboard/sign-in?attempt=" + "a".repeat(43), "/dashboard/cloud/desktop", "/dashboard/cloud/desktop?code=ABCDE-FGHJK", "/dashboard/sign-in?next=%2Fcloud%2Fdesktop%3Fcode%3DABCDE-FGHJK",
      "/dashboard/sign-in?next=%2Fsign-in%3Fnext%3D%252Fadmin", "/sign-in", "/cloud/desktop?code=ABCDE-FGHJK"]) {
      const answer = await get(path);
      expect([path, answer.status, answer.headers.get("location")]).toEqual([path, 302, "/"]);
    }
    // the desktop app's sign-in: its live code opens the page, and the oauth round trip (errors, a provider without an email) carries it in next
    const post = (path: string, body: unknown) => fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });
    const { userCode } = await (await post("/api/cloud/desktop/authorize", { deviceName: "Studio", platform: "darwin" })).json() as { userCode: string };
    const desktop = `/cloud/desktop?code=${userCode}`;
    // the emailed "trouble signing in?" link: its attempt rides in the query, the code stays in the fragment
    const lost = "lost@madani.test";
    await login(lost);
    skew = 120_000; // past the resend wait between two codes to one address
    expect((await post("/v1/auth/start", { email: lost, recover: true })).status).toBe(200);
    const link = new URL(mailer.outbox.findLast(item => item.to === lost)!.text.match(/https:\/\/madani\.test\/dashboard\/sign-in\?\S+/)![0]);
    expect(link.hash).toMatch(/^#code=\d{8}$/);
    const opened = await (await get(`/dashboard/sign-in${link.search}`)).text();
    expect(opened).toContain('<meta name="madani-prelaunch" content="1">');
    // the handoff, claim and delete links keep their token in the fragment, out of our sight: the page checks those itself
    for (const path of [`/dashboard${desktop}`, `/dashboard/sign-in?${new URLSearchParams({ error: "oauth_denied", next: desktop })}`, `/dashboard/sign-in?${new URLSearchParams({ pending: "p", next: desktop })}`,
      "/dashboard/sign-in?next=%2Fclaim", "/dashboard/handoff", "/dashboard/claim", "/dashboard/clouds/c1/delete", "/dashboard/assets/main.js"]) expect([path, (await get(path)).status]).toEqual([path, 200]);
    expect(await get(desktop).then(answer => answer.headers.get("location"))).toBe(`/dashboard${desktop}`);
    // a code that was denied, or a made-up one, does not
    expect((await get("/dashboard/cloud/desktop?code=ZZZZZ-ZZZZZ")).headers.get("location")).toBe("/");
    // the admin panel and its sign-in go home too (used from preview before launch), even for the owner; its API stays
    const owner = await login(OWNER);
    for (const [path, cookie] of [["/admin", ""], ["/admin/people", owner.cookie], ["/dashboard/admin/people", owner.cookie], ["/dashboard/sign-in?next=%2Fadmin", ""]] as const) {
      const answer = await get(path, cookie ? { cookie } : {});
      expect([path, answer.status, answer.headers.get("location")]).toEqual([path, 302, path.startsWith("/dashboard/admin") ? "/admin/people" : "/"]);
    }
    expect((await get("/v1/admin/me", { cookie: owner.cookie })).status).toBe(200);
    // the API, webhooks and well-known addresses answer as before; the site keeps every other path
    expect((await get("/v1/health")).status).toBe(200);
    const webhook = await fetch(`${url}/v1/billing/webhooks/dodo`, { method: "POST", redirect: "manual", headers: { "content-type": "application/json" }, body: "{}" });
    expect(webhook.status).not.toBe(302);
    expect((await get("/api/cloud/desktop/authorize")).status).not.toBe(302);
    expect((await get("/.well-known/madanibot/dashboard")).status).toBe(200);
    expect((await get("/privacy")).status).toBe(404);
    expect(siteHits).toContain("/privacy");
    expect((await get("/")).status).toBe(404);
    expect(siteHits).toContain("/");
  });

  it("refuses waitlist-only without a page base", () => {
    expect(() => createDashboardApp({ dataDir, publicUrl: origin, mailer, staticDir, waitlistOnly: true })).toThrow(/page base/);
  });
});

// the own-server short line: madani.bot/s/<code> is the link service's, through Cloudflare, with the visitor's address
describe("one origin: the short install line", () => {
  it("sends /s/<code> and /s/<code>/<way> to the link service, and nothing else there", async () => {
    const hits: Array<{ url: string; ip: string }> = [];
    const link = createServer((req, res) => { hits.push({ url: req.url ?? "", ip: String(req.headers["x-real-ip"] ?? "") }); res.writeHead(200, { "content-type": "text/plain" }); res.end("#!/bin/sh\n"); });
    await new Promise<void>(resolve => link.listen(0, "127.0.0.1", resolve));
    const dataDir = mkdtempSync(join(tmpdir(), "madani-short-line-"));
    const app = createDashboardApp({ dataDir, staticDir: dataDir, publicUrl: "https://madani.test", mailer: memoryMailer(), linkUpstream: `http://127.0.0.1:${(link.address() as { port: number }).port}` });
    const server = createServer(app.handle);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const answer = await fetch(`${base}/s/k3x9m2p/cloudflare`, { headers: { "cf-connecting-ip": "203.0.113.9" } });
      expect(answer.status).toBe(200);
      expect(await answer.text()).toBe("#!/bin/sh\n");
      expect(await (await fetch(`${base}/s/k3x9m2p`)).text()).toBe("#!/bin/sh\n");
      expect((await fetch(`${base}/s/k3x9m2p/a/b`)).status).not.toBe(200);
      expect(hits.map(hit => hit.url)).toEqual(["/s/k3x9m2p/cloudflare", "/s/k3x9m2p"]);
      expect(hits[0]!.ip).toBe("203.0.113.9");
    } finally {
      app.close();
      for (const s of [server, link]) await new Promise<void>(resolve => { s.close(() => resolve()); s.closeAllConnections(); });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
