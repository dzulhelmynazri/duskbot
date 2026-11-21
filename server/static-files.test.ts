import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";

import { serveStatic, staticEncoding } from "./static-files.ts";

const dir = mkdtempSync(join(tmpdir(), "madani-static-"));
writeFileSync(join(dir, "index.html"), "app");
writeFileSync(join(dir, "rail.html"), "rail");
mkdirSync(join(dir, "assets"));
writeFileSync(join(dir, "assets", "rail-1a2b.js"), "js");
const big = "export const x = 1;\n".repeat(400);
writeFileSync(join(dir, "assets", "app-9f8e.js"), big);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function get(path: string, staticDir: string = dir, reqHeaders?: Record<string, string>) {
  const answer: { status?: number; headers: Record<string, string>; body?: string; raw?: Buffer } = { headers: {} };
  let ended = () => {};
  const done = new Promise<void>((resolve) => { ended = resolve; });
  const res = {
    writeHead(status: number, headers: Record<string, string>) { answer.status = status; answer.headers = headers; return res; },
    end(data: Buffer) { answer.raw = Buffer.from(data); answer.body = String(data); ended(); },
  } as unknown as ServerResponse;
  const served = serveStatic(res, path, staticDir, reqHeaders ? { headers: reqHeaders } : undefined);
  return Object.assign(answer, { served, done });
}

describe("serveStatic", () => {
  it("answers the window's rail with its own small page, never cached", () => {
    const rail = get("/rail");
    expect(rail.body).toBe("rail");
    expect(rail.headers).toMatchObject({ "content-type": "text/html", "cache-control": "no-cache", "x-frame-options": "DENY" });
  });

  it("answers the app's paths with the app, and keeps hashed assets for good", () => {
    expect(get("/").body).toBe("app");
    expect(get("/settings").body).toBe("app");
    expect(get("/rail/more").body).toBe("app");
    expect(get("/assets/rail-1a2b.js").headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("encodes hashed assets for forwarded requests only, once per file", async () => {
    const local = get("/assets/app-9f8e.js", dir, { "accept-encoding": "gzip, br" });
    await local.done;
    expect(local.headers["content-encoding"]).toBeUndefined();
    expect(local.body).toBe(big);

    const linked = get("/assets/app-9f8e.js", dir, { "accept-encoding": "gzip, deflate, br", "x-forwarded-for": "192.0.2.10" });
    await linked.done;
    expect(linked.headers).toMatchObject({ "content-encoding": "br", vary: "Accept-Encoding", "cache-control": "public, max-age=31536000, immutable" });
    expect(brotliDecompressSync(linked.raw!).toString()).toBe(big);
    expect(linked.raw!.length).toBeLessThan(big.length / 4);

    const gz = get("/assets/app-9f8e.js", dir, { "accept-encoding": "gzip", "x-forwarded-for": "192.0.2.10" });
    await gz.done;
    expect(gz.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(gz.raw!).toString()).toBe(big);
  });

  it("leaves pages, tiny files and refused codings alone", async () => {
    const forwarded = { "accept-encoding": "gzip, br", "x-forwarded-for": "192.0.2.10" };
    expect(get("/", dir, forwarded).headers["content-encoding"]).toBeUndefined();
    expect(get("/assets/rail-1a2b.js", dir, forwarded).headers["content-encoding"]).toBeUndefined();
    expect(staticEncoding({ headers: { "accept-encoding": "br;q=0, gzip;q=0", "x-forwarded-for": "1" } })).toBeNull();
    expect(staticEncoding({ headers: { "accept-encoding": "br;q=0, gzip", "x-forwarded-for": "1" } })).toBe("gzip");
    expect(staticEncoding(undefined)).toBeNull();
  });
});
