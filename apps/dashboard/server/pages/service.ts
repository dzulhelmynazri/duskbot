import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { join } from "node:path";
import { pagesHomeSignature } from "../../../../server/pages/access.ts";
import { PAGE_FILE_EXTENSIONS, PAGE_ID, PAGE_MAX_BYTES, PAGE_MAX_FILES } from "../../../../shared/published-page.ts";
import { createJsonStore } from "../billing/json-store.ts";
import type { StoredCloud } from "../clouds/types.ts";
import type { ObjectStore } from "./object-store.ts";

interface PageFile { path: string; size: number; sha256: string; contentType: string }
interface Page {
  id: string; accountId: string; cloudId: string; title: string; version: number; files: PageFile[]; bytes: number;
  state: "live" | "unpublished"; createdAt: number; updatedAt: number;
}
interface Grant { action: "create" | "update" | "delete"; pageId: string; accountId: string; cloudId: string; expiresAt: number }
interface Limits { pagesPerAccount: number; bytes: number; files: number; perHour: number }
type HeadersInput = IncomingHttpHeaders | Headers;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const header = (headers: HeadersInput, key: string): string => headers instanceof Headers ? headers.get(key) ?? "" : typeof headers[key] === "string" ? headers[key] : "";
const failure = (status: number, error: string, message: string, extra = {}) => Response.json({ error, message, ...extra }, { status });
const invalid = () => failure(401, "invalid_token", "This pages credential is not valid.");
const missing = () => failure(404, "not_found", "There is no such page on this account.");
const gone = () => failure(410, "unpublished", "This page was unpublished.");
const rateLimited = () => failure(429, "rate_limited", "Too many pages requests. Try again later.");
const extension = (path: string) => path.split(".").at(-1)!.toLowerCase();
const validPath = (path: unknown): path is string => typeof path === "string" && path.length <= 4096 && path.split("/").every(part => part !== "." && part !== ".." && /^[A-Za-z0-9_][A-Za-z0-9._ ()+@-]{0,99}$/.test(part));
const types: Record<string, string> = {
  html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript", json: "application/json", txt: "text/plain", csv: "text/csv", md: "text/markdown",
  parquet: "application/vnd.apache.parquet", arrow: "application/vnd.apache.arrow.file", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
};
function contentType(path: string) { const ext = extension(path), type = types[ext] ?? "application/octet-stream"; return type.startsWith("text/") || ["json", "svg"].includes(ext) ? `${type}; charset=utf-8` : type; }
const security = {
  "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
  "content-security-policy": "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; default-src 'self' https: data: blob: 'unsafe-inline'; frame-ancestors 'none'",
  "cache-control": "public, max-age=60",
};
export function pageNotFound(method: string): Response {
  return new Response(method === "HEAD" ? null : "Not found.\n", { status: 404, headers: { ...security, "content-type": "text/plain; charset=utf-8" } });
}
function validState(value: unknown): value is { pages: Page[] } {
  const pages = (value as { pages?: unknown } | null)?.pages;
  return Array.isArray(pages) && new Set(pages.map(page => page?.id)).size === pages.length && pages.every(page => page && PAGE_ID.test(page.id) && typeof page.accountId === "string" && typeof page.cloudId === "string"
    && typeof page.title === "string" && Number.isSafeInteger(page.version) && page.version > 0 && ["live", "unpublished"].includes(page.state)
    && Number.isSafeInteger(page.bytes) && page.bytes >= 0 && Number.isSafeInteger(page.createdAt) && Number.isSafeInteger(page.updatedAt)
    && Array.isArray(page.files) && page.files.every((file: PageFile) => file && validPath(file.path) && PAGE_FILE_EXTENSIONS.has(extension(file.path)) && Number.isSafeInteger(file.size) && file.size >= 0 && /^[a-f0-9]{64}$/.test(file.sha256) && typeof file.contentType === "string"));
}

export function createPagesService(options: {
  dataDir: string; store: ObjectStore; clouds: { get(id: string): StoredCloud | null }; unseal(v: string): string;
  publicUrl: string; pagesDomain?: string; limits?: Partial<Limits>; now?: () => number; random?: (size: number) => Buffer;
}) {
  const now = options.now ?? Date.now, random = options.random ?? randomBytes, pagesDomain = (options.pagesDomain ?? "page.madani.bot").toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(pagesDomain)) throw new Error("Invalid pages domain.");
  const limits = { pagesPerAccount: 50, bytes: PAGE_MAX_BYTES, files: PAGE_MAX_FILES, perHour: 120, ...options.limits };
  if (!Object.values(limits).every(value => Number.isSafeInteger(value) && value > 0) || limits.bytes > PAGE_MAX_BYTES || limits.files > PAGE_MAX_FILES) throw new Error("Invalid pages limits.");
  const registry = createJsonStore<{ pages: Page[] }>(join(options.dataDir, "pages.json"), () => ({ pages: [] }), validState);
  const nonces = new Map<string, number>(), tokens = new Map<string, Grant>(), rates = new Map<string, number[]>();
  let pending: Promise<unknown> = Promise.resolve();
  function serial<T>(run: () => Promise<T>): Promise<T> { const result = pending.then(run); pending = result.catch(() => {}); return result; }
  const usage = (accountId: string) => ({ pages: registry.state.pages.filter(page => page.accountId === accountId && page.state === "live").length, limit: limits.pagesPerAccount });
  const limitFailure = (accountId: string) => failure(402, "page_limit", "This account's pages are used up.", { usage: usage(accountId), plan: "cloud", upgrade: false });
  const pageUrl = (id: string) => `https://${id}.${pagesDomain}/`;
  const objectKeys = (page: Page) => page.files.map(file => `pages/${page.id}/v${page.version}/${file.path}`);
  function cleanup() {
    const time = now();
    for (const [key, expiry] of nonces) if (expiry <= time) nonces.delete(key);
    for (const [key, grant] of tokens) if (grant.expiresAt <= time) tokens.delete(key);
    for (const [key, times] of rates) { const recent = times.filter(at => at > time - 3_600_000); if (recent.length) rates.set(key, recent); else rates.delete(key); }
  }
  function take(pageId: string, bearer: string, actions: Grant["action"][]): Grant | null {
    cleanup();
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(bearer)?.[1];
    if (!token) return null;
    const key = digest(token), grant = tokens.get(key);
    if (!grant || grant.pageId !== pageId || !actions.includes(grant.action)) return null;
    tokens.delete(key);
    return grant;
  }
  function owned(grant: Grant) { return registry.state.pages.find(page => page.id === grant.pageId && page.accountId === grant.accountId); }

  return {
    pagesDomain,
    mint(headers: HeadersInput, rawBody: Buffer): Response {
      cleanup();
      const machine = header(headers, "x-madani-cloud-machine"), timestamp = header(headers, "x-madani-cloud-timestamp"), nonce = header(headers, "x-madani-cloud-nonce"), signature = header(headers, "x-madani-cloud-signature");
      const cloud = options.clouds.get(machine), nonceKey = `${machine}:${nonce}`;
      if (header(headers, "authorization") || !cloud || ["destroyed", "destroying", "suspended", "checkout"].includes(cloud.status) || cloud.ended || cloud.suspended !== null
        || cloud.endsAt !== undefined && cloud.endsAt <= now() || cloud.destroyAt !== null && cloud.destroyAt <= now()
        || !/^\d{1,12}$/.test(timestamp) || Math.abs(Number(timestamp) * 1000 - now()) > 300_000 || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || nonces.has(nonceKey)) return invalid();
      try {
        const expected = Buffer.from(`v1=${pagesHomeSignature(options.unseal(cloud.bootstrapSecret), machine, timestamp, nonce, rawBody.toString("utf8"))}`), actual = Buffer.from(signature);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return invalid();
      } catch { return invalid(); }
      if (nonces.size >= 10_000) return invalid();
      nonces.set(nonceKey, now() + 600_000);
      let input;
      try { input = JSON.parse(rawBody.toString("utf8")); } catch { return failure(400, "invalid_request", "Invalid pages request."); }
      if (!input || !["create", "update", "delete"].includes(input.action) || input.action !== "create" && (typeof input.pageId !== "string" || !PAGE_ID.test(input.pageId))) return failure(400, "invalid_request", "Invalid pages request.");
      const action = input.action as Grant["action"];
      if (action === "create" && usage(cloud.accountId).pages >= limits.pagesPerAccount) return limitFailure(cloud.accountId);
      if (action !== "create") {
        const page = registry.state.pages.find(page => page.id === input.pageId && page.accountId === cloud.accountId);
        if (!page) return missing();
        if (action === "update" && page.state === "unpublished") return gone();
      }
      const times = rates.get(cloud.accountId) ?? [];
      if (times.length >= limits.perHour || tokens.size >= 10_000 || !rates.has(cloud.accountId) && rates.size >= 10_000) return rateLimited();
      let pageId = input.pageId as string;
      if (action === "create") {
        for (let attempt = 0; attempt < 10; attempt++) {
          pageId = [...random(24)].map(byte => (byte % 36).toString(36)).join("");
          if (pageId.length === 24 && !registry.state.pages.some(page => page.id === pageId) && ![...tokens.values()].some(grant => grant.pageId === pageId)) break;
          if (attempt === 9) throw new Error("Unable to allocate page id.");
        }
      }
      const token = random(32).toString("base64url"), tokenHash = digest(token);
      if (token.length !== 43 || tokens.has(tokenHash)) throw new Error("Unable to allocate pages token.");
      tokens.set(tokenHash, { action, pageId, accountId: cloud.accountId, cloudId: cloud.id, expiresAt: now() + 600_000 });
      rates.set(cloud.accountId, [...times, now()]);
      return Response.json({ token, pageId, action, uploadUrl: options.publicUrl, pageUrl: pageUrl(pageId), plan: "cloud", limits: { pages: limits.pagesPerAccount, bytes: limits.bytes, files: limits.files, perHour: limits.perHour }, badge: false });
    },
    async upload(pageId: string, bearer: string, rawBody: Buffer, type: string): Promise<Response> {
      const grant = take(pageId, bearer, ["create", "update"]);
      if (!grant) return invalid();
      let form: FormData, manifest;
      try {
        form = await new Request("http://pages.invalid/", { method: "PUT", headers: { "content-type": type }, body: new Uint8Array(rawBody) }).formData();
        if (form.getAll("manifest").length !== 1 || typeof form.get("manifest") !== "string") throw new Error();
        manifest = JSON.parse(form.get("manifest") as string);
      } catch { return failure(400, "invalid_page", "Invalid page manifest."); }
      // oxlint-disable-next-line no-control-regex -- control characters are what this strips or refuses
      if (!manifest || typeof manifest.title !== "string" || manifest.title.length < 1 || manifest.title.length > 200 || /[\x00-\x1f\x7f-\x9f]/.test(manifest.title) || !Array.isArray(manifest.files) || !manifest.files.length) return failure(400, "invalid_page", "Invalid page manifest.");
      if (manifest.files.length > limits.files) return failure(413, "too_large", "This page has too many files.");
      const files: PageFile[] = [], bodies: Buffer[] = [], paths = new Set<string>();
      let bytes = 0;
      for (const [index, file] of manifest.files.entries()) {
        if (!file || !validPath(file.path) || paths.has(file.path) || !Number.isSafeInteger(file.size) || file.size < 0) return failure(400, "invalid_page", "Invalid page file.");
        if (!PAGE_FILE_EXTENSIONS.has(extension(file.path))) return failure(415, "file_type", "This file type is not supported.");
        bytes += file.size;
        if (bytes > limits.bytes) return failure(413, "too_large", "This page is too large.");
        const blob = form.get(`f${index}`);
        if (!(blob instanceof Blob) || form.getAll(`f${index}`).length !== 1 || blob.size !== file.size) return failure(400, "invalid_page", "Page file size does not match its manifest.");
        const body = Buffer.from(await blob.arrayBuffer());
        paths.add(file.path); bodies.push(body); files.push({ path: file.path, size: file.size, sha256: digest(body), contentType: contentType(file.path) });
      }
      if ([...form.keys()].length !== files.length + 1 || !files.some(file => ["html", "htm"].includes(extension(file.path)))) return failure(400, "invalid_page", "A page needs an HTML file.");
      return serial(async () => {
        const previous = owned(grant);
        if (grant.action === "update" && !previous) return missing();
        if (previous?.state === "unpublished") return gone();
        if (grant.action === "create" && usage(grant.accountId).pages >= limits.pagesPerAccount) return limitFailure(grant.accountId);
        const page: Page = { id: pageId, accountId: grant.accountId, cloudId: grant.cloudId, title: manifest.title, version: (previous?.version ?? 0) + 1, files, bytes, state: "live", createdAt: previous?.createdAt ?? now(), updatedAt: now() };
        const keys = objectKeys(page);
        try {
          for (const [index, key] of keys.entries()) await options.store.put(key, bodies[index]!, { contentType: files[index]!.contentType });
          registry.state.pages = [...registry.state.pages.filter(entry => entry.id !== pageId), page];
          try { registry.commit(); } catch (error) { registry.state.pages = registry.state.pages.filter(entry => entry.id !== pageId); if (previous) registry.state.pages.push(previous); throw error; }
        } catch {
          await options.store.delete(keys).catch(() => {});
          return failure(503, "unavailable", "The page could not be stored. Try again later.");
        }
        if (previous) await options.store.delete(objectKeys(previous)).catch(() => {});
        return Response.json({ pageId, url: pageUrl(pageId), version: page.version, badge: false, usage: usage(grant.accountId) });
      });
    },
    async remove(pageId: string, bearer: string): Promise<Response> {
      const grant = take(pageId, bearer, ["delete"]);
      if (!grant) return invalid();
      return serial(async () => {
        const page = owned(grant);
        if (!page) return missing();
        await options.store.delete(objectKeys(page));
        const previous = { state: page.state, updatedAt: page.updatedAt };
        page.state = "unpublished"; page.updatedAt = now();
        try { registry.commit(); } catch (error) { Object.assign(page, previous); throw error; }
        return Response.json({ pageId, state: "unpublished", usage: usage(grant.accountId) });
      });
    },
    async serve(host: string, path: string, method: string, ifNoneMatch = ""): Promise<Response> {
      const text = (status: number, body: string) => new Response(method === "HEAD" ? null : body, { status, headers: { ...security, "content-type": "text/plain; charset=utf-8", ...(status === 405 ? { allow: "GET, HEAD" } : {}) } });
      const suffix = `.${pagesDomain}`, hostname = host.toLowerCase().replace(/:\d+$/, ""), id = hostname.endsWith(suffix) ? hostname.slice(0, -suffix.length) : "";
      if (!PAGE_ID.test(id)) return text(404, "Not found.\n");
      if (!["GET", "HEAD"].includes(method)) return text(405, "Method not allowed.\n");
      let decoded;
      try { decoded = decodeURIComponent(path); } catch { return text(404, "Not found.\n"); }
      if (!decoded.startsWith("/")) return text(404, "Not found.\n");
      const target = `${decoded.slice(1)}${decoded.endsWith("/") ? "index.html" : ""}`;
      if (!validPath(target)) return text(404, "Not found.\n");
      const page = registry.state.pages.find(page => page.id === id && page.state === "live"), file = page?.files.find(file => file.path === target);
      if (!page || !file) return text(404, "Not found.\n");
      const object = await options.store.get(`pages/${id}/v${page.version}/${target}`);
      if (!object) return text(404, "Not found.\n");
      const etag = `"${file.sha256}"`, headers = { ...security, "content-type": contentType(target), etag };
      if (ifNoneMatch.split(",").some(value => value.trim() === etag || value.trim() === `W/${etag}` || value.trim() === "*")) return new Response(null, { status: 304, headers });
      return new Response(method === "HEAD" ? null : new Uint8Array(object.body), { headers: { ...headers, "content-length": String(object.body.length) } });
    },
  };
}
export type PagesService = ReturnType<typeof createPagesService>;
