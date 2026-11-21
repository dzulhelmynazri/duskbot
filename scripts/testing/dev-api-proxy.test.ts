import { createServer as createHttpServer, get, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";

import { devApiProxy } from "./dev-api-proxy.ts";

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });

async function harnessAndProxy() {
  const streams = new Set<ServerResponse>();
  const harness: Server = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: hello\n\n");
    streams.add(res);
  });
  await new Promise<void>((done) => harness.listen(0, "127.0.0.1", done));
  closers.push(() => new Promise((done) => { harness.closeAllConnections(); harness.close(done); }));
  const vite: ViteDevServer = await createServer({ configFile: false, logLevel: "silent", root: import.meta.dirname,
    cacheDir: join(import.meta.dirname, "..", "..", ".madani-scratch", "vite-dev-api-proxy"),
    server: { host: "127.0.0.1", port: 0, hmr: false, proxy: { "/api": devApiProxy((harness.address() as AddressInfo).port) } } });
  await vite.listen();
  closers.unshift(() => vite.close());
  const port = (vite.httpServer!.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/api/events`, dieHarness: () => { for (const res of streams) res.socket?.destroy(); } };
}

describe("the dev renderer's /api proxy", () => {
  it("drops the connection instead of answering 500 when the harness is not listening", async () => {
    const closed: Server = createHttpServer();
    await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
    const harnessPort = (closed.address() as AddressInfo).port;
    await new Promise((done) => closed.close(done));
    const vite: ViteDevServer = await createServer({ configFile: false, logLevel: "silent", root: import.meta.dirname,
      cacheDir: join(import.meta.dirname, "..", "..", ".madani-scratch", "vite-dev-api-proxy"),
      server: { host: "127.0.0.1", port: 0, hmr: false, proxy: { "/api": devApiProxy(harnessPort) } } });
    await vite.listen();
    closers.unshift(() => vite.close());
    const port = (vite.httpServer!.address() as AddressInfo).port;
    const outcome = await fetch(`http://127.0.0.1:${port}/api/config`, { method: "PUT", body: JSON.stringify({ profile: { name: "Ada" } }) })
      .then((res) => `status ${res.status}`, () => "unreachable");
    expect(outcome).toBe("unreachable");
  });


  it("ends the window's event stream when the harness behind it dies", async () => {
    const { url, dieHarness } = await harnessAndProxy();
    const closed = await new Promise<boolean>((resolve, reject) => {
      get(url, (res) => {
        res.once("data", () => dieHarness());
        res.once("close", () => resolve(true));
        res.on("error", () => {});
      }).on("error", reject);
      setTimeout(() => resolve(false), 5_000);
    });
    expect(closed).toBe(true);
  });
});
