import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { PAGE_ID, PAGE_MAX_BYTES } from "../../../../shared/published-page.ts";
import { createSealer, parseSealKey } from "../clouds/seal.ts";
import type { StoredCloud } from "../clouds/types.ts";
import { createFsObjectStore, createMemoryObjectStore, createS3ObjectStore } from "./object-store.ts";
import { createPagesService, pageNotFound, type PagesService } from "./service.ts";

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  if (Number(req.headers["content-length"]) > limit) { req.resume(); return null; }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const body = Buffer.from(chunk);
    bytes += body.length;
    if (bytes > limit) { req.resume(); return null; }
    chunks.push(body);
  }
  return Buffer.concat(chunks);
}

export function createPagesRoutes(service: PagesService) {
  return {
    async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
      const host = (req.headers.host ?? "").toLowerCase().replace(/:\d+$/, ""), method = req.method ?? "GET";
      const pageHost = host.endsWith(`.${service.pagesDomain}`);
      const match = /^\/v1\/pages\/([^/]+)$/.exec(url.pathname), id = match?.[1];
      const tokenRoute = method === "POST" && url.pathname === "/api/cloud/pages/token";
      if (!pageHost && !tokenRoute && !(id && PAGE_ID.test(id) && ["PUT", "DELETE"].includes(method))) return false;
      let response: Response;
      try {
        if (pageHost) response = await service.serve(host, (req.url ?? "/").split("?")[0]!, method, typeof req.headers["if-none-match"] === "string" ? req.headers["if-none-match"] : "");
        else if (method === "DELETE") response = await service.remove(id!, req.headers.authorization ?? "");
        else {
          const body = await readBody(req, tokenRoute ? 4096 : PAGE_MAX_BYTES + 1024 * 1024);
          if (body === null) response = Response.json({ error: "too_large", message: "Request body is too large." }, { status: 413 });
          else response = tokenRoute ? service.mint(req.headers, body) : await service.upload(id!, req.headers.authorization ?? "", body, req.headers["content-type"] ?? "");
        }
      } catch {
        response = pageHost ? pageNotFound(method)
          : Response.json({ error: "unavailable", message: "The pages service is unavailable. Try again later." }, { status: 503 });
      }
      const headers = Object.fromEntries(response.headers);
      if (!pageHost) headers["cache-control"] = "no-store";
      res.writeHead(response.status, headers);
      res.end(method === "HEAD" ? undefined : Buffer.from(await response.arrayBuffer()));
      return true;
    },
  };
}

export function pagesRoutesFromEnv(options: { dataDir: string; publicUrl: string; clouds: { get(id: string): StoredCloud | null }; now?: () => number; fetch?: typeof fetch; env?: NodeJS.ProcessEnv }) {
  const env = options.env ?? process.env, url = new URL(options.publicUrl);
  const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  const kind = env.MADANI_PAGES_STORE ?? (loopback ? "fs" : "off");
  if (!["memory", "fs", "s3", "off"].includes(kind)) throw new Error("Invalid MADANI_PAGES_STORE.");
  if (kind === "off") return {
    async handle(req: IncomingMessage, res: ServerResponse) {
      if (!(req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "").endsWith(`.${(env.MADANI_PAGES_DOMAIN ?? "page.madani.bot").toLowerCase()}`)) return false;
      const response = pageNotFound(req.method ?? "GET");
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      return true;
    },
  };
  function required(key: string) { const value = env[key]; if (!value) throw new Error(`${key} is required.`); return value; }
  function s3() {
    const endpoint = required("MADANI_PAGES_S3_ENDPOINT");
    try { if (new URL(endpoint).protocol !== "https:") throw new Error(); } catch { throw new Error("Invalid MADANI_PAGES_S3_ENDPOINT."); }
    return createS3ObjectStore({ endpoint, region: required("MADANI_PAGES_S3_REGION"), bucket: required("MADANI_PAGES_S3_BUCKET"), accessKeyId: required("MADANI_PAGES_S3_ACCESS_KEY_ID"), secretAccessKey: required("MADANI_PAGES_S3_SECRET_ACCESS_KEY"), fetch: options.fetch });
  }
  const store = kind === "memory" ? createMemoryObjectStore() : kind === "fs" ? createFsObjectStore(join(options.dataDir, "pages-objects")) : s3();
  const sealer = createSealer(env.MADANI_CLOUD_SEAL_KEY ? parseSealKey(env.MADANI_CLOUD_SEAL_KEY) : null);
  return createPagesRoutes(createPagesService({ ...options, store, unseal: sealer.unseal, pagesDomain: env.MADANI_PAGES_DOMAIN }));
}
