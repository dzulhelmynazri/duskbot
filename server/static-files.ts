// The desktop bundle served from MADANI_STATIC_DIR: content types, cache rules and the SPA fallback.
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { brotliCompress, constants as zlib, gzip } from "node:zlib";

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

/** Never framed (a hidden frame could act on a pair or sign-in page unseen), and no Referer. */
const PAGE_HEADERS = { "content-security-policy": "frame-ancestors 'none'", "x-frame-options": "DENY", "referrer-policy": "no-referrer" } as const;

/** Pages with an entry of their own: the app, and the desktop window's rail of places. */
const PAGES: Record<string, string> = { "/": "/index.html", "/rail": "/rail.html" };

const COMPRESSIBLE = new Set(["text/javascript", "text/css", "image/svg+xml", "application/json", "application/manifest+json", "text/plain; charset=utf-8"]);
const COMPRESS_MIN_BYTES = 1024;
type Encoding = "br" | "gzip";
const encoded = new Map<string, Promise<Buffer>>();

/** The coding to answer a forwarded request with, or null. Loopback pages read the bundle off this machine, where
 * encoding would only spend CPU; a forwarded one (the VPS link agent, a phone tunnel) crosses a slow network. */
export function staticEncoding(req: Pick<IncomingMessage, "headers"> | undefined): Encoding | null {
  if (!req || req.headers["x-forwarded-for"] === undefined) return null;
  const accepted = new Map<string, number>();
  for (const entry of [req.headers["accept-encoding"] ?? ""].flat().join(",").split(",")) {
    const [coding, ...params] = entry.split(";").map((part) => part.trim().toLowerCase());
    const q = params.find((param) => param.startsWith("q="));
    if (coding) accepted.set(coding, q === undefined ? 1 : Number(q.slice(2)));
  }
  if ((accepted.get("br") ?? 0) > 0) return "br";
  if ((accepted.get("gzip") ?? 0) > 0) return "gzip";
  return null;
}

function encode(file: string, data: Buffer, encoding: Encoding): Promise<Buffer> {
  const key = `${encoding}:${file}`;
  let pending = encoded.get(key);
  if (!pending) {
    // brotli quality 5 is gzip's speed at a smaller size; 11 takes seconds on a 2 MB chunk
    pending = new Promise<Buffer>((resolve, reject) => {
      const done = (error: Error | null, out: Buffer) => (error ? reject(error) : resolve(out));
      if (encoding === "br") brotliCompress(data, { params: { [zlib.BROTLI_PARAM_QUALITY]: 5, [zlib.BROTLI_PARAM_SIZE_HINT]: data.length } }, done);
      else gzip(data, { level: 6 }, done);
    });
    encoded.set(key, pending);
    pending.catch(() => encoded.delete(key));
  }
  return pending;
}

/** Public by design: the same bundle anyone can download, with no secrets, and /pair must load before a session exists. */
export function serveStatic(res: ServerResponse, path: string, staticDir: string | null, req?: Pick<IncomingMessage, "headers">): boolean {
  if (!staticDir) return false;
  const safe = PAGES[path] ?? path.replace(/\.\./g, "");
  const file = join(staticDir, safe);
  try {
    const data = readFileSync(file);
    const type = MIME[extname(file)] ?? "application/octet-stream";
    // Vite content-hashes every file under /assets/, so those URLs are immutable while public/ has no assets/ dir.
    const cache = type === "text/html" ? "no-cache" : safe.startsWith("/assets/") ? "public, max-age=31536000, immutable" : null;
    const headers = { "content-type": type, ...(type === "text/html" ? PAGE_HEADERS : {}), ...(cache ? { "cache-control": cache } : {}) };
    const encoding = cache?.endsWith("immutable") && COMPRESSIBLE.has(type) && data.length >= COMPRESS_MIN_BYTES ? staticEncoding(req) : null;
    if (!encoding) {
      res.writeHead(200, headers);
      res.end(data);
      return true;
    }
    // hashed files never change under one name, so each is encoded once per process
    encode(file, data, encoding).then(
      (body) => res.writeHead(200, { ...headers, "content-encoding": encoding, "content-length": body.length, vary: "Accept-Encoding" }).end(body),
      () => res.writeHead(200, { ...headers, vary: "Accept-Encoding" }).end(data),
    );
    return true;
  } catch {
      // SPA fallback, never immutable: a missing chunk answered with the page must not stay cached under the chunk's URL.
    try {
      const data = readFileSync(join(staticDir, "index.html"));
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-cache", ...PAGE_HEADERS });
      res.end(data);
      return true;
    } catch {
      return false;
    }
  }
}
