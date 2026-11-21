import { randomBytes } from "node:crypto";
import { createServer, IncomingMessage, request, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pagesAuthHeaders } from "../../../../server/pages/access.ts";
import { createPagesClient } from "../../../../server/pages/client.ts";
import { PAGE_MAX_BYTES } from "../../../../shared/published-page.ts";
import { createSealer } from "../clouds/seal.ts";
import type { StoredCloud } from "../clouds/types.ts";
import { createMemoryObjectStore, type ObjectStore } from "./object-store.ts";
import { createPagesRoutes, pagesRoutesFromEnv } from "./routes.ts";
import { createPagesService } from "./service.ts";

type Grant = { pageId: string; token: string; [key: string]: unknown };

const machineId = "c012345678901234567890123", secret = "fixture-bootstrap-secret", domain = "page.madani.bot";
const files = (html = "<h1>hello</h1>") => [{ path: "index.html", data: Buffer.from(html) }, { path: "style.css", data: Buffer.from("body{color:red}") }];
const security = {
  "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
  "content-security-policy": "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; default-src 'self' https: data: blob: 'unsafe-inline'; frame-ancestors 'none'",
  "cache-control": "public, max-age=60",
};
function fixtureCloud(time: number, sealer: { seal(value: string): string }): StoredCloud {
  const spec = { vcpu: 2, ramGb: 4, diskGb: 40 };
  return { id: machineId, accountId: "account-fixture", name: "fixture", color: null, kind: "dedicated", placement: "dedicated", subscriptionId: null, spec, desiredSpec: spec, region: "test", botComputers: null, status: "running", setupStep: null, wantPower: "on", serverId: null, ipv4: null, origin: null, bootstrapSecret: sealer.seal(secret), workspaceId: null, primary: true, hidden: false, paymentProblem: false, suspended: null, destroyAt: null, error: null, attempts: 0, nextAttemptAt: 0, createdAt: time, updatedAt: time, powerSince: time };
}

describe("account pages HTTP fixture", () => {
  let dir: string, base: string, server: Server, time: number, store: ObjectStore, service: ReturnType<typeof createPagesService>, routes: ReturnType<typeof createPagesRoutes>, cloud: StoredCloud;
  const sealer = createSealer(randomBytes(32));
  const access = () => ({ kind: "home" as const, url: `${base}/api/cloud/pages/token`, machineId, secret });
  const client = () => createPagesClient({ access, now: () => time });
  const mount = (limits = {}, objects = store) => {
    service = createPagesService({ dataDir: dir, store: objects, clouds: { get: id => id === machineId ? cloud : null }, unseal: sealer.unseal, publicUrl: base, limits: { pagesPerAccount: 2, ...limits }, now: () => time });
    routes = createPagesRoutes(service);
  };
  const mint = (action = "create", pageId?: string) => {
    const body = JSON.stringify({ action, ...(pageId ? { pageId } : {}) });
    return fetch(`${base}/api/cloud/pages/token`, { method: "POST", body, headers: { "content-type": "application/json", ...pagesAuthHeaders(access(), body, time) } });
  };
  const form = (entries = files(), title = "fixture") => {
    const value = new FormData();
    value.set("manifest", JSON.stringify({ title, files: entries.map(file => ({ path: file.path, size: file.data.length })) }));
    entries.forEach((file, index) => value.set(`f${index}`, new Blob([new Uint8Array(file.data)])));
    return value;
  };
  const upload = (grant: { pageId: string; token: string }, body = form()) => fetch(`${base}/v1/pages/${grant.pageId}`, { method: "PUT", headers: { authorization: `Bearer ${grant.token}` }, body });
  const hostRequest = (id: string, path = "/", method = "GET", headers = {}) => new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request(base, { path, method, headers: { host: `${id}.${domain}`, ...headers } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject); req.end();
  });
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "madani-account-pages-")); time = Date.now(); store = createMemoryObjectStore();
    cloud = fixtureCloud(time, sealer);
    server = createServer((req, res) => {
      void routes.handle(req, res, new URL(req.url!, base)).then(handled => { if (!handled) { res.writeHead(404); res.end("fixture fallback"); } });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    mount();
  });
  afterEach(async () => {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  it("publishes through the real client, serves isolated hosts, updates, persists and unpublishes", async () => {
    const published = await client().publish({ title: "fixture", files: files() });
    expect(published).toMatchObject({ ok: true, badge: false, usage: { pages: 1, limit: 2 } });
    if (!published.ok) throw new Error("Publish failed.");
    expect(published.pageId).toMatch(/^[a-z0-9]{24}$/);
    expect(published.url).toBe(`https://${published.pageId}.${domain}/`);
    const response = await hostRequest(published.pageId);
    expect(response.status).toBe(200); expect(response.body).toBe("<h1>hello</h1>");
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
    for (const [key, value] of Object.entries(security)) expect(response.headers[key]).toBe(value);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.headers.etag).toMatch(/^"[a-f0-9]{64}"$/);
    const css = await hostRequest(published.pageId, "/style.css");
    expect(css.headers["content-type"]).toBe("text/css; charset=utf-8"); expect(css.body).toBe("body{color:red}");
    expect((await hostRequest(published.pageId, "/", "HEAD")).body).toBe("");
    expect((await hostRequest(published.pageId, "/", "HEAD")).headers.etag).toBe(response.headers.etag);
    const cached = await hostRequest(published.pageId, "/", "GET", { "if-none-match": response.headers.etag });
    expect(cached.status).toBe(304); expect(cached.body).toBe("");
    for (const [key, value] of Object.entries(security)) expect(cached.headers[key]).toBe(value);
    const updated = await client().publish({ title: "updated", files: files("<h1>new</h1>"), pageId: published.pageId });
    expect(updated).toMatchObject({ ok: true, pageId: published.pageId });
    expect(await store.list(`pages/${published.pageId}/`)).toEqual([`pages/${published.pageId}/v2/index.html`, `pages/${published.pageId}/v2/style.css`]);
    mount();
    expect((await hostRequest(published.pageId)).body).toBe("<h1>new</h1>");
    const registry = JSON.parse(await readFile(join(dir, "pages.json"), "utf8"));
    expect(registry.pages[0]).toMatchObject({ version: 2, state: "live", accountId: cloud.accountId, cloudId: machineId });
    expect(await client().unpublish(published.pageId)).toEqual({ ok: true, pageId: published.pageId, usage: { pages: 0, limit: 2 } });
    const missing = await hostRequest(published.pageId);
    expect(missing.status).toBe(404); expect(missing.body).toBe("Not found.\n");
    for (const [key, value] of Object.entries(security)) expect(missing.headers[key]).toBe(value);
    expect(await store.list(`pages/${published.pageId}/`)).toEqual([]);
    expect((await mint("update", published.pageId)).status).toBe(410);
  });

  it("rejects wrong signatures, replayed nonces, stale signatures and desktop bearer tokens", async () => {
    const body = JSON.stringify({ action: "create" }), headers = { "content-type": "application/json", ...pagesAuthHeaders(access(), body, time) };
    const send = (extra = {}) => fetch(`${base}/api/cloud/pages/token`, { method: "POST", body, headers: { ...headers, ...extra } });
    expect((await send({ "x-madani-cloud-signature": "v1=wrong" })).status).toBe(401);
    expect((await send()).status).toBe(200);
    const replay = await send(); expect(replay.status).toBe(401); expect(await replay.json()).toMatchObject({ error: "invalid_token" });
    expect((await send(pagesAuthHeaders(access(), body, time - 301_000))).status).toBe(401);
    expect((await send({ authorization: `Bearer madani_pd_${"a".repeat(43)}` })).status).toBe(401);
    expect((await send({ ...pagesAuthHeaders(access(), body, time), "x-madani-cloud-machine": "missing" })).status).toBe(401);
  });

  it.each(["destroyed", "suspended", "ended"])("rejects a %s cloud", async state => {
    if (state === "ended") cloud.ended = true;
    else cloud.status = state as StoredCloud["status"];
    expect((await mint()).status).toBe(401);
  });

  it("consumes upload tokens once, binds actions and expires tokens", async () => {
    const response = await mint(), grant = await response.json() as Grant;
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await upload(grant)).status).toBe(200);
    expect((await upload(grant)).status).toBe(401);
    const deletion = (await (await mint("delete", grant.pageId)).json() as Grant);
    expect((await upload(deletion)).status).toBe(401);
    expect((await fetch(`${base}/v1/pages/${deletion.pageId}`, { method: "DELETE", headers: { authorization: `Bearer ${deletion.token}` } })).status).toBe(200);
    expect((await fetch(`${base}/v1/pages/${deletion.pageId}`, { method: "DELETE", headers: { authorization: `Bearer ${deletion.token}` } })).status).toBe(401);
    const expired = (await (await mint()).json() as Grant); time += 600_001;
    expect((await upload(expired)).status).toBe(401);
  });

  it.each([["../x.html", 400], ["dir/../index.html", 400], ["/x.html", 400], ["dir\\x.html", 400], ["x.exe", 415]])("refuses file %s", async (path, status) => {
    const grant = (await (await mint()).json() as Grant);
    const response = await upload(grant, form([{ path: String(path), data: Buffer.from("x") }]));
    expect(response.status).toBe(status); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await store.list("")).toEqual([]);
  });

  it("refuses invalid manifests, size mismatches, duplicate paths and file or byte excess", async () => {
    const cases: Array<[FormData, number]> = [[form(files(), "bad\nname"), 400], [form([{ path: "a.css", data: Buffer.from("a") }]), 400], [form([files()[0]!, files()[0]!]), 400]];
    const mismatch = form(); mismatch.set("f0", new Blob(["wrong size"])); cases.push([mismatch, 400]);
    mount({ files: 1 });
    cases.unshift([form(), 413]);
    for (const [body, status] of cases) {
      if (status === 400) mount();
      expect((await upload((await (await mint()).json() as Grant), body)).status).toBe(status);
    }
    mount({ bytes: 2 }); expect((await upload((await (await mint()).json() as Grant))).status).toBe(413);
  });

  it("gives the real client a limit failure and enforces quota again at upload", async () => {
    mount({ pagesPerAccount: 1 });
    const pending = (await (await mint()).json() as Grant);
    expect((await client().publish({ title: "first", files: files() })).ok).toBe(true);
    expect((await upload(pending)).status).toBe(402);
    expect(await client().publish({ title: "second", files: files() })).toMatchObject({ ok: false, reason: "limit", usage: { pages: 1, limit: 1 }, plan: "cloud", upgrade: false });
  });

  it("rate limits accounts and hides pages belonging to another account", async () => {
    mount({ perHour: 2 });
    const grant = (await (await mint()).json() as Grant); expect((await upload(grant)).status).toBe(200);
    expect((await mint("update", grant.pageId)).status).toBe(200);
    expect((await mint()).status).toBe(429);
    cloud.accountId = "another-account";
    expect((await mint("update", grant.pageId)).status).toBe(404);
    expect((await mint("delete", grant.pageId)).status).toBe(404);
    cloud.accountId = "account-fixture"; time += 3_600_001;
    expect((await mint()).status).toBe(200);
  });

  it("validates host and raw paths, maps directories, and isolates all page-host routes", async () => {
    const grant = (await (await mint()).json() as Grant);
    expect((await upload(grant, form([{ path: "dir/index.html", data: Buffer.from("directory") }]))).status).toBe(200);
    expect((await hostRequest(grant.pageId, "/dir/")).body).toBe("directory");
    expect((await hostRequest(grant.pageId, "/dir/", "GET", { host: `${grant.pageId.toUpperCase()}.${domain.toUpperCase()}` })).status).toBe(200);
    for (const path of ["/dir/../index.html", "/dir/%2e%2e/index.html", "/dir/%5cx.html", "/%invalid", "/missing.html"]) expect((await hostRequest(grant.pageId, path)).status).toBe(404);
    expect((await hostRequest("a".repeat(24))).status).toBe(404);
    expect((await hostRequest("invalid")).body).toBe("Not found.\n");
    expect((await hostRequest(grant.pageId, "/api/cloud/pages/token", "POST")).status).toBe(405);
    expect((await hostRequest(grant.pageId, "/missing", "HEAD")).body).toBe("");
    expect((await hostRequest(grant.pageId, "/dir/", "GET", { host: `${grant.pageId}.${domain}.evil.test` })).body).toBe("fixture fallback");
  });

  it("caps content-length and chunked bodies before parsing", async () => {
    expect((await fetch(`${base}/api/cloud/pages/token`, { method: "POST", body: "x".repeat(4097) })).status).toBe(413);
    expect((await fetch(`${base}/v1/pages/${"a".repeat(24)}`, { method: "PUT", body: Buffer.alloc(PAGE_MAX_BYTES + 1024 * 1024 + 1) })).status).toBe(413);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/api/cloud/pages/token`, { method: "POST", headers: { "transfer-encoding": "chunked" } }, res => { res.resume(); resolve(res.statusCode!); });
      req.on("error", reject); req.write("x".repeat(4097)); req.end();
    });
    expect(status).toBe(413);
  });

  it("keeps the previous version when storing a replacement fails", async () => {
    const published = await client().publish({ title: "first", files: files() });
    if (!published.ok) throw new Error("Publish failed.");
    const broken = { ...store, put: async () => { throw new Error("fixture write failed"); } };
    mount({}, broken);
    expect((await client().publish({ title: "replacement", files: files("new"), pageId: published.pageId })).ok).toBe(false);
    expect((await hostRequest(published.pageId)).body).toBe("<h1>hello</h1>");
    expect(await store.list(`pages/${published.pageId}/v2/`)).toEqual([]);
  });

  it("defaults loopback wiring to disk, hosted wiring to off, and validates S3 configuration", () => {
    const config = { dataDir: dir, publicUrl: base, clouds: { get: () => cloud }, env: {} };
    expect(pagesRoutesFromEnv(config)).toHaveProperty("handle");
    expect(pagesRoutesFromEnv({ ...config, publicUrl: "https://account.test" })).toHaveProperty("handle");
    expect(() => pagesRoutesFromEnv({ ...config, env: { MADANI_PAGES_STORE: "unknown" } })).toThrow("MADANI_PAGES_STORE");
    expect(() => pagesRoutesFromEnv({ ...config, env: { MADANI_PAGES_STORE: "s3", MADANI_PAGES_S3_ENDPOINT: "http://s3.test" } })).toThrow("MADANI_PAGES_S3_ENDPOINT");
    expect(() => pagesRoutesFromEnv({ ...config, env: { MADANI_PAGES_STORE: "s3", MADANI_PAGES_S3_ENDPOINT: "https://s3.test" } })).toThrow("MADANI_PAGES_S3_REGION");
  });
});

it("exercises the real client and durable service contract without a network transport", async () => {
  const dir = await mkdtemp(join(tmpdir(), "madani-pages-contract-")), sealer = createSealer(randomBytes(32)), time = Date.now(), cloud = fixtureCloud(time, sealer), store = createMemoryObjectStore();
  const access = { kind: "home" as const, url: "https://account.test/api/cloud/pages/token", machineId, secret };
  const options = { dataDir: dir, store, clouds: { get: (id: string) => id === machineId ? cloud : null }, unseal: sealer.unseal, publicUrl: "https://account.test", now: () => time, limits: { pagesPerAccount: 1 } };
  let service = createPagesService(options);
  const http: typeof fetch = async (input, init) => {
    const request = new Request(input, init), body = Buffer.from(await request.arrayBuffer()), url = new URL(request.url);
    if (url.pathname === "/api/cloud/pages/token") return service.mint(request.headers, body);
    const id = url.pathname.split("/").at(-1)!;
    return request.method === "DELETE" ? service.remove(id, request.headers.get("authorization") ?? "") : service.upload(id, request.headers.get("authorization") ?? "", body, request.headers.get("content-type") ?? "");
  };
  const client = createPagesClient({ access: () => access, fetch: http, now: () => time });
  try {
    const published = await client.publish({ title: "first", files: files() });
    expect(published).toMatchObject({ ok: true, usage: { pages: 1, limit: 1 }, badge: false });
    if (!published.ok) throw new Error("Publish failed.");
    const host = `${published.pageId}.${domain}`;
    const response = await service.serve(host, "/", "GET");
    expect(await response.text()).toBe("<h1>hello</h1>");
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    for (const [key, value] of Object.entries(security)) expect(response.headers.get(key)).toBe(value);
    expect(response.headers.has("set-cookie")).toBe(false);
    expect((await service.serve(host, "/", "HEAD")).headers.get("etag")).toBe(response.headers.get("etag"));
    expect((await service.serve(host, "/", "GET", response.headers.get("etag")!)).status).toBe(304);
    expect((await service.serve(host, "/", "POST")).status).toBe(405);
    expect((await service.serve(host, "/%2e%2e/x.html", "GET")).status).toBe(404);
    expect(await client.publish({ title: "over quota", files: files() })).toMatchObject({ ok: false, reason: "limit", plan: "cloud", upgrade: false });
    expect(await client.publish({ title: "replacement", files: files("new"), pageId: published.pageId })).toMatchObject({ ok: true, pageId: published.pageId });
    expect(await store.list(`pages/${published.pageId}/v1/`)).toEqual([]);
    service = createPagesService(options);
    expect(await (await service.serve(host.toUpperCase(), "/", "GET")).text()).toBe("new");
    expect(await client.unpublish(published.pageId)).toMatchObject({ ok: true, usage: { pages: 0, limit: 1 } });
    expect((await service.serve(host, "/", "GET")).status).toBe(404);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("rejects invalid credentials, replays, token reuse and unsafe files without a network transport", async () => {
  const dir = await mkdtemp(join(tmpdir(), "madani-pages-validation-")), sealer = createSealer(null), time = Date.now(), cloud = fixtureCloud(time, sealer), store = createMemoryObjectStore();
  const service = createPagesService({ dataDir: dir, store, clouds: { get: id => id === machineId ? cloud : null }, unseal: sealer.unseal, publicUrl: "http://localhost", now: () => time });
  const access = { kind: "home" as const, url: "http://localhost/api/cloud/pages/token", machineId, secret }, body = JSON.stringify({ action: "create" });
  const headers = pagesAuthHeaders(access, body, time);
  const mint = () => service.mint(pagesAuthHeaders(access, body, time), Buffer.from(body));
  const upload = async (grant: { pageId: string; token: string }, path: string) => {
    const form = new FormData(); form.set("manifest", JSON.stringify({ title: "fixture", files: [{ path, size: 1 }] })); form.set("f0", new Blob(["x"]));
    const request = new Request("http://localhost/", { method: "PUT", body: form });
    return service.upload(grant.pageId, `Bearer ${grant.token}`, Buffer.from(await request.arrayBuffer()), request.headers.get("content-type")!);
  };
  try {
    expect(service.mint({ ...headers, "x-madani-cloud-signature": "v1=bad" }, Buffer.from(body)).status).toBe(401);
    expect(service.mint(headers, Buffer.from(body)).status).toBe(200);
    expect(service.mint(headers, Buffer.from(body)).status).toBe(401);
    expect(service.mint(pagesAuthHeaders(access, body, time - 301_000), Buffer.from(body)).status).toBe(401);
    expect(service.mint({ authorization: "Bearer madani_pd_unsupported" }, Buffer.from(body)).status).toBe(401);
    const grant = (await mint().json() as Grant);
    expect((await upload(grant, "index.html")).status).toBe(200);
    expect((await upload(grant, "index.html")).status).toBe(401);
    expect((await upload((await mint().json() as Grant), "../x.html")).status).toBe(400);
    expect((await upload((await mint().json() as Grant), "x.exe")).status).toBe(415);
    cloud.ended = true; expect(mint().status).toBe(401);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("dispatches page hosts before API routes and caps raw streams without a network transport", async () => {
  const dir = await mkdtemp(join(tmpdir(), "madani-pages-routes-")), time = Date.now(), sealer = createSealer(null), cloud = fixtureCloud(time, sealer);
  const options = { dataDir: dir, publicUrl: "http://localhost", clouds: { get: () => cloud }, env: {} };
  const service = createPagesService({ ...options, store: createMemoryObjectStore(), unseal: sealer.unseal });
  const routes = createPagesRoutes(service);
  async function call(handler: { handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> }, host: string, path: string, method: string, body = Buffer.alloc(0), headers = {}) {
    const req = new IncomingMessage(new Socket());
    req.method = method; req.url = path; req.headers = { host, ...headers };
    req.push(body); req.push(null);
    let status = 0, answerHeaders: Record<string, string> = {}, answer: Buffer = Buffer.alloc(0);
    const res = { writeHead(code: number, value: Record<string, string>) { status = code; answerHeaders = value; }, end(value?: Buffer) { answer = value ?? Buffer.alloc(0); } } as unknown as ServerResponse;
    const handled = await handler.handle(req, res, new URL(path, options.publicUrl));
    req.destroy();
    return { handled, status, headers: answerHeaders, body: answer.toString() };
  }
  try {
    const host = `${"a".repeat(24)}.${domain}`;
    expect(await call(routes, host, "/api/cloud/pages/token", "POST")).toMatchObject({ handled: true, status: 405 });
    expect(await call(routes, "localhost", "/api/cloud/pages/token", "POST", Buffer.alloc(4097))).toMatchObject({ handled: true, status: 413, headers: { "cache-control": "no-store" } });
    expect(await call(routes, "localhost", `/v1/pages/${"a".repeat(24)}`, "PUT", Buffer.alloc(PAGE_MAX_BYTES + 1024 * 1024 + 1))).toMatchObject({ handled: true, status: 413 });
    const off = pagesRoutesFromEnv({ ...options, publicUrl: "https://account.test" });
    expect(await call(off, host, "/v1/auth/start", "POST")).toMatchObject({ handled: true, status: 404, body: "Not found.\n", headers: security });
    expect(await call(off, "account.test", "/api/cloud/pages/token", "POST")).toMatchObject({ handled: false });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
