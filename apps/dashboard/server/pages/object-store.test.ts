import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PAGE_MAX_BYTES } from "../../../../shared/published-page.ts";
import { createFsObjectStore, createMemoryObjectStore, createS3ObjectStore, signS3Request } from "./object-store.ts";

const dirs: string[] = [], servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

it("matches the AWS S3 GET object signing example", () => {
  const headers = signS3Request({ method: "GET", url: "https://examplebucket.s3.amazonaws.com/test.txt", region: "us-east-1", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", date: "20130524T000000Z", headers: { Range: "bytes=0-9" } });
  expect(headers.authorization).toBe("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
});

describe.each(["memory", "fs"])("%s object store", kind => {
  it("persists content types, isolates buffers, lists prefixes and deletes exact keys", async () => {
    const dir = await mkdtemp(join(tmpdir(), "madani-pages-objects-")); dirs.push(dir);
    const store = kind === "fs" ? createFsObjectStore(dir) : createMemoryObjectStore();
    const body = Buffer.from("hello");
    await store.put("pages/a/index.html", body, { contentType: "text/html; charset=utf-8" });
    body.fill(0);
    await store.put("pages/a/index.html/nested.css", Buffer.from("body{}"), { contentType: "text/css" });
    const restored = kind === "fs" ? createFsObjectStore(dir) : store;
    const object = await restored.get("pages/a/index.html");
    expect(object?.body.toString()).toBe("hello");
    expect(object?.contentType).toBe("text/html; charset=utf-8");
    expect(object?.etag).toMatch(/^"[a-f0-9]{64}"$/);
    object!.body.fill(0);
    expect((await restored.get("pages/a/index.html"))?.body.toString()).toBe("hello");
    expect(await restored.list("pages/a/")).toEqual(["pages/a/index.html", "pages/a/index.html/nested.css"]);
    await restored.delete(["pages/a/index.html", "pages/missing.txt"]);
    expect(await restored.get("pages/a/index.html")).toBeNull();
    expect(await restored.list("pages/a/")).toEqual(["pages/a/index.html/nested.css"]);
  });

  it.each(["../x", "a/../x", "/absolute", "a\\b", "a..b", "a//b", "a/./b"])("refuses unsafe key %s", async key => {
    const dir = await mkdtemp(join(tmpdir(), "madani-pages-keys-")); dirs.push(dir);
    const store = kind === "fs" ? createFsObjectStore(dir) : createMemoryObjectStore();
    await expect(store.put(key, Buffer.from("x"), { contentType: "text/plain" })).rejects.toThrow("Invalid object key");
    await expect(store.get(key)).rejects.toThrow("Invalid object key");
    await expect(store.delete([key])).rejects.toThrow("Invalid object key");
    expect(await store.list("")).toEqual([]);
  });
});

it("round trips through a signed path-style S3 server and follows escaped continuation tokens", async () => {
  const objects = new Map<string, { body: Buffer; contentType: string }>(), seen: string[] = [], authorizations: string[] = [];
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://s3.test");
    authorizations.push(req.headers.authorization ?? "");
    seen.push(`${req.method} ${url.pathname}`);
    if (!/^AWS4-HMAC-SHA256 Credential=test-key\/\d{8}\/us-east-1\/s3\/aws4_request,/.test(req.headers.authorization ?? "")) { res.writeHead(403); res.end(); return; }
    if (url.searchParams.get("list-type") === "2") {
      const keys = [...objects.keys()].filter(key => key.startsWith(url.searchParams.get("prefix") ?? "")).sort(), next = url.searchParams.get("continuation-token");
      if (next && next !== "next+&=/") { res.writeHead(400); res.end(); return; }
      res.end(`<ListBucketResult><IsTruncated>${next ? "false" : "true"}</IsTruncated><Contents><Key>${escape(keys[next ? 1 : 0]!)}</Key></Contents>${next ? "" : "<NextContinuationToken>next+&amp;=/</NextContinuationToken>"}</ListBucketResult>`);
      return;
    }
    const key = decodeURIComponent(url.pathname.slice("/bucket/".length));
    if (req.method === "PUT") {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      objects.set(key, { body: Buffer.concat(chunks), contentType: req.headers["content-type"]! }); res.end();
    } else if (req.method === "DELETE") { objects.delete(key); res.writeHead(204); res.end(); }
    else {
      const object = objects.get(key);
      if (!object) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": object.contentType, etag: '"fake-etag"' }); res.end(object.body);
    }
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const store = createS3ObjectStore({ endpoint, bucket: "bucket", region: "us-east-1", accessKeyId: "test-key", secretAccessKey: "test-secret" });
  await store.put("pages/a/a +@.html", Buffer.from("<p>hello</p>"), { contentType: "text/html; charset=utf-8" });
  await store.put("pages/a/b&x.txt", Buffer.from("text"), { contentType: "text/plain" });
  expect(await store.get("pages/a/a +@.html")).toEqual({ body: Buffer.from("<p>hello</p>"), contentType: "text/html; charset=utf-8", etag: '"fake-etag"' });
  expect(await store.get("missing")).toBeNull();
  expect(await store.list("pages/a/")).toEqual(["pages/a/a +@.html", "pages/a/b&x.txt"]);
  await store.delete(["pages/a/a +@.html", "pages/a/b&x.txt"]);
  expect(objects.size).toBe(0);
  expect(seen).toContain("PUT /bucket/pages/a/a%20%2B%40.html");
  expect(seen.filter(value => value.startsWith("DELETE"))).toHaveLength(2);
  expect(authorizations).toHaveLength(seen.length);
  expect(authorizations.every(value => value.startsWith("AWS4-HMAC-SHA256 Credential=test-key/"))).toBe(true);
});

it("bounds S3 bodies, rejects malformed listings, and scrubs upstream errors", async () => {
  const base = { endpoint: "https://s3.test", bucket: "bucket", region: "region", accessKeyId: "key", secretAccessKey: "private-test-secret" };
  const fake = (reply: () => Response): typeof fetch => async () => reply();
  await expect(createS3ObjectStore({ ...base, fetch: fake(() => new Response("x", { headers: { "content-length": String(PAGE_MAX_BYTES + 1) } })) }).get("key")).rejects.toThrow("too large");
  const overflowing = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(PAGE_MAX_BYTES)); controller.enqueue(new Uint8Array(1)); controller.close(); } });
  await expect(createS3ObjectStore({ ...base, fetch: fake(() => new Response(overflowing)) }).get("key")).rejects.toThrow("too large");
  for (const xml of ["<Key>&unknown;</Key><IsTruncated>false</IsTruncated>", "<Key><nested/></Key><IsTruncated>false</IsTruncated>", "<IsTruncated>true</IsTruncated>", "<!DOCTYPE x><IsTruncated>false</IsTruncated>"]) {
    await expect(createS3ObjectStore({ ...base, fetch: fake(() => new Response(xml)) }).list("")).rejects.toThrow("Invalid S3");
  }
  const broken: typeof fetch = async () => { throw new Error(base.secretAccessKey); };
  await expect(createS3ObjectStore({ ...base, fetch: broken }).get("key")).rejects.toThrow(/^S3 request failed\.$/);
  await expect(createS3ObjectStore({ ...base, fetch: fake(() => new Response(base.secretAccessKey, { status: 500 })) }).get("key")).rejects.toThrow(/^S3 request failed\.$/);
});
