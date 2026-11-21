import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { bundleSource, createLocalUi, devSource, servedOrigins, uiPatterns, uiRoute } from "./local-ui.mjs";

const VPS = "http://vps-abc.localhost:51234";
const CLOUD = "https://me.madani.cloud";
const html = [{ name: "Content-Type", value: "text/html; charset=utf-8" }];

test("only a saved place's origin is served, never this computer's own page", () => {
  assert.deepEqual(
    servedOrigins([CLOUD, `${VPS}/pair#code=x`, "http://127.0.0.1:8799", null, "file:///tmp/x", "not a url", CLOUD], ["http://127.0.0.1:8799", "http://127.0.0.1:5199"]),
    [VPS, CLOUD].sort(),
  );
});

test("a place's pages are paused once its server answered, its files before they leave, its API never", () => {
  const patterns = uiPatterns([CLOUD]);
  assert.deepEqual(patterns.find((pattern) => pattern.resourceType === "Document"), { urlPattern: `${CLOUD}/*`, resourceType: "Document", requestStage: "Response" });
  const types = new Set(patterns.map((pattern) => pattern.resourceType));
  for (const api of ["Fetch", "XHR", "EventSource", "WebSocket"]) assert.equal(types.has(api), false, api);
  // CDP's Fetch filter refuses a resource type it does not know, and then nothing at all is served
  for (const type of types) assert.ok(["Document", "Script", "Stylesheet", "Image", "Font", "Media", "Other"].includes(type), type);
  assert.equal(patterns.find((pattern) => pattern.resourceType === "Media").urlPattern, `${CLOUD}/assets/*`);
  assert.deepEqual(uiPatterns([]), []);
});

test("routing: pages, files, and what stays with the server", () => {
  const origins = [CLOUD, VPS];
  const page = (url, status = 200, headers = html) => uiRoute({ url, resourceType: "Document", responseStatusCode: status, responseHeaders: headers }, origins);
  assert.equal(page(`${CLOUD}/`), "page");
  assert.equal(page(`${CLOUD}/pair`), "page");
  assert.equal(page(`${VPS}/chat/abc?x=1`), "page");
  // the server's redirects (a frozen copy sends every page to /home) and errors stay its own
  assert.equal(page(`${CLOUD}/`, 302), "network");
  assert.equal(page(`${CLOUD}/`, 502), "network");
  assert.equal(uiRoute({ url: `${CLOUD}/`, resourceType: "Document", responseErrorReason: "ConnectionRefused" }, origins), "network");
  assert.equal(page(`${CLOUD}/download`, 200, [{ name: "content-type", value: "application/pdf" }]), "network");
  assert.equal(page(`${CLOUD}/api/files/x`), "network");
  assert.equal(page(`${CLOUD}/.well-known/madanibot/environment`), "network");
  assert.equal(page("https://elsewhere.example/"), "network");

  assert.equal(uiRoute({ url: `${CLOUD}/assets/index-abc.js`, resourceType: "Script" }, origins), "file");
  assert.equal(uiRoute({ url: `${VPS}/app-icon.svg`, resourceType: "Image" }, origins), "file");
  assert.equal(uiRoute({ url: `${CLOUD}/api/bots/1/avatar`, resourceType: "Image" }, origins), "network");
  assert.equal(uiRoute({ url: `${CLOUD}/apix/x.js`, resourceType: "Script" }, origins), "file");
  assert.equal(uiRoute({ url: "http://127.0.0.1:8799/assets/x.js", resourceType: "Script" }, origins), "network");
});

test("the bundle answers like the local server and never outside its folder", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "local-ui-"));
  mkdirSync(path.join(dir, "assets"));
  writeFileSync(path.join(dir, "index.html"), "<p>app</p>");
  writeFileSync(path.join(dir, "rail.html"), "<p>rail</p>");
  writeFileSync(path.join(dir, "assets", "index-1.js"), "1");
  writeFileSync(path.join(dir, "app-icon.svg"), "<svg/>");
  writeFileSync(path.join(path.dirname(dir), "outside.txt"), "secret");
  const source = bundleSource(dir);

  const index = await source.page(`${CLOUD}/chat/1`);
  assert.equal(String(index.body), "<p>app</p>");
  assert.equal(index.headers["content-type"], "text/html");
  assert.equal(index.headers["x-frame-options"], "DENY");
  assert.equal(index.headers["cache-control"], "no-cache");
  assert.equal(String((await source.page(`${CLOUD}/rail`)).body), "<p>rail</p>");

  const script = await source.file(`${CLOUD}/assets/index-1.js?v=2`);
  assert.equal(script.headers["content-type"], "text/javascript");
  assert.match(script.headers["cache-control"], /immutable/);
  assert.equal((await source.file(`${CLOUD}/app-icon.svg`)).headers["content-type"], "image/svg+xml");
  // a file only an older server's own page names is that server's to answer
  assert.equal(await source.file(`${CLOUD}/assets/index-OLD.js`), null);
  assert.equal(await source.file(`${CLOUD}/assets`), null);
  assert.equal(await source.file(`${CLOUD}/%2e%2e/outside.txt`), null);
  assert.equal(await source.file(`${CLOUD}/..%2Foutside.txt`), null);
});

test("the dev source passes Vite's answer through and leaves a missing file to the server", async () => {
  const asked = [];
  const fetch = async (url, init) => {
    asked.push([url, init.headers.accept]);
    if (url.endsWith("/missing.js")) return new Response("nope", { status: 404 });
    if (url.includes("/@vite/client")) return new Response("export {}", { headers: { "content-type": "text/javascript", "content-encoding": "gzip" } });
    return new Response("<html></html>", { headers: { "content-type": "text/html" } });
  };
  const source = devSource("http://127.0.0.1:5199/", { fetch });
  const client = await source.file(`${VPS}/@vite/client?t=1`);
  assert.equal(String(client.body), "export {}");
  assert.equal(client.headers["content-encoding"], undefined);
  assert.equal(await source.file(`${VPS}/missing.js`), null);
  const page = await source.page(`${VPS}/chat/1`);
  assert.equal(page.headers["x-frame-options"], "DENY");
  assert.deepEqual(asked.map(([url]) => url), ["http://127.0.0.1:5199/@vite/client?t=1", "http://127.0.0.1:5199/missing.js", "http://127.0.0.1:5199/chat/1"]);
});

test("routing: every dev module, optimized dependency and lazy chunk of a place's page is this app's", () => {
  const origins = [VPS, CLOUD];
  for (const url of [
    `${VPS}/src/App.tsx`, `${VPS}/src/main.tsx`, `${VPS}/src/locales/en.json?import`, `${VPS}/src/styles.css`, `${VPS}/@vite/client`,
    `${VPS}/@react-refresh`, `${VPS}/@fs/Users/me/app/node_modules/vite/dist/client/env.mjs`, `${VPS}/node_modules/.vite/deps/react.js?v=25ce7337`,
    `${VPS}/node_modules/.vite/deps/chunk-UTDYDSFM.js?v=163a8dbf`, `${VPS}/src/App.tsx?t=1731000000000`, `${VPS}/shared/wire.ts`,
    `${CLOUD}/assets/App-Bx1.js`, `${CLOUD}/assets/DesktopViewer-C9.js`, `${CLOUD}/assets/index-D2.css`,
  ]) assert.equal(uiRoute({ url, resourceType: "Script" }, origins), "file", url);
  assert.equal(uiRoute({ url: `${VPS}/src/assets/sounds/tick.wav`, resourceType: "Media" }, origins), "file");
  const media = uiPatterns([VPS]).filter((pattern) => pattern.resourceType === "Media").map((pattern) => pattern.urlPattern);
  for (const at of ["/assets/*", "/src/*", "/@fs/*", "/node_modules/*"]) assert.ok(media.includes(`${VPS}${at}`), at);
  assert.equal(media.some((pattern) => pattern.includes("/api")), false);
});

test("the dev source: a busy Vite gets a few connections, a reset is asked again, and Vite's errors stay Vite's", async () => {
  let open = 0, most = 0, resets = 0;
  const fetch = async (url) => {
    open += 1; most = Math.max(most, open);
    try {
      await new Promise((resolve) => setTimeout(resolve, 2));
      // the first asks for App.tsx find Vite's backlog full
      if (url.endsWith("/src/App.tsx") && resets < 2) { resets += 1; throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }); }
      if (url.includes("/deps/old.js")) return new Response("Outdated Optimize Dep", { status: 504 });
      if (url.endsWith("/src/broken.tsx")) return new Response("Transform failed", { status: 500 });
      if (url.endsWith("/assets/index-OLD.js")) return new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
      return new Response("export {}", { headers: { "content-type": "text/javascript" } });
    } finally { open -= 1; }
  };
  const source = devSource("http://127.0.0.1:5199", { fetch, connections: 3, pause: async () => {} });
  const urls = Array.from({ length: 40 }, (_, i) => `${VPS}/src/m${i}.ts`);
  const answers = await Promise.all([source.file(`${VPS}/src/App.tsx`), ...urls.map((url) => source.file(url))]);
  assert.ok(answers.every((answer) => answer?.status === 200 && String(answer.body) === "export {}"));
  assert.equal(resets, 2);
  assert.ok(most <= 3, `at most 3 at once, saw ${most}`);
  // never the place's server: it has no dev modules, so Vite's own error is the honest answer (its client handles a 504)
  assert.equal((await source.file(`${VPS}/node_modules/.vite/deps/old.js?v=1`)).status, 504);
  assert.equal((await source.file(`${VPS}/src/broken.tsx`)).status, 500);
  // Vite's index for a name it lacks: a file only the server's own page names
  assert.equal(await source.file(`${VPS}/assets/index-OLD.js`), null);
  // Vite gone for good: the window logs it instead of hiding it
  const gone = devSource("http://127.0.0.1:5199", { fetch: async () => { throw new TypeError("fetch failed"); }, pause: async () => {} });
  await assert.rejects(gone.file(`${VPS}/src/App.tsx`));
  assert.equal(await gone.page(`${VPS}/`), null);
});

function fakeWindow() {
  const sent = [];
  const debuggerApi = Object.assign(new EventEmitter(), {
    attached: false,
    isAttached() { return this.attached; },
    attach() { this.attached = true; },
    async sendCommand(method, params) { sent.push([method, params]); return {}; },
  });
  const contents = Object.assign(new EventEmitter(), { debugger: debuggerApi, isDestroyed: () => false });
  return { contents, sent };
}

test("the window: patterns follow the places, a paused request gets one answer", async () => {
  const { contents, sent } = fakeWindow();
  let places = [];
  const source = { page: async () => ({ status: 200, headers: { "content-type": "text/html" }, body: Buffer.from("new") }), file: async (url) => (url.endsWith("/new.js") ? { status: 200, headers: {}, body: Buffer.from("js") } : null) };
  const ui = createLocalUi({ source, origins: () => places });
  await ui.attach(contents);
  // only This Mac: nothing is intercepted
  assert.deepEqual(sent.map(([method]) => method), ["Fetch.disable"]);
  places = [CLOUD];
  await ui.refresh();
  await ui.refresh();
  assert.deepEqual(sent.map(([method]) => method), ["Fetch.disable", "Fetch.enable"]);

  const answer = async (params) => {
    sent.length = 0;
    contents.debugger.emit("message", {}, "Fetch.requestPaused", params);
    await new Promise((resolve) => setImmediate(resolve));
    return sent;
  };
  const [[method, fulfilled]] = await answer({ requestId: "1", resourceType: "Document", responseStatusCode: 200, responseHeaders: html, request: { url: `${CLOUD}/` } });
  assert.equal(method, "Fetch.fulfillRequest");
  assert.equal(Buffer.from(fulfilled.body, "base64").toString(), "new");
  assert.deepEqual((await answer({ requestId: "2", resourceType: "Script", request: { url: `${CLOUD}/assets/old.js` } })).map(([m]) => m), ["Fetch.continueRequest"]);
  assert.deepEqual((await answer({ requestId: "3", resourceType: "Script", request: { url: `${CLOUD}/new.js` } })).map(([m]) => m), ["Fetch.fulfillRequest"]);
  assert.deepEqual((await answer({ requestId: "4", resourceType: "Image", request: { url: `${CLOUD}/api/x` } })).map(([m]) => m), ["Fetch.continueRequest"]);
});

test("the window: a dev module whose first asks are reset is still this app's answer, never the server's", async () => {
  const { contents, sent } = fakeWindow();
  let tries = 0;
  const fetch = async () => {
    tries += 1;
    if (tries < 3) throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    return new Response("export default 1", { headers: { "content-type": "text/javascript" } });
  };
  const ui = createLocalUi({ source: devSource("http://127.0.0.1:5199", { fetch, pause: async () => {} }), origins: () => [VPS] });
  await ui.attach(contents);
  sent.length = 0;
  contents.debugger.emit("message", {}, "Fetch.requestPaused", { requestId: "7", resourceType: "Script", request: { url: `${VPS}/src/App.tsx` } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(sent.map(([method]) => method), ["Fetch.fulfillRequest"]);
  assert.equal(Buffer.from(sent[0][1].body, "base64").toString(), "export default 1");
  assert.equal(sent[0][1].responseCode, 200);
});

test("the window: a source that fails leaves the server's own answer", async () => {
  const { contents, sent } = fakeWindow();
  const ui = createLocalUi({ source: { page: async () => { throw new Error("disk"); }, file: async () => null }, origins: () => [CLOUD] });
  await ui.attach(contents);
  sent.length = 0;
  contents.debugger.emit("message", {}, "Fetch.requestPaused", { requestId: "1", resourceType: "Document", responseStatusCode: 200, responseHeaders: html, request: { url: `${CLOUD}/` } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, [["Fetch.continueRequest", { requestId: "1" }]]);
});

test("the window: a debugger it cannot have leaves every page to its server", async () => {
  const { contents, sent } = fakeWindow();
  contents.debugger.attach = () => { throw new Error("Another debugger is already attached"); };
  const lines = [];
  const ui = createLocalUi({ source: bundleSource(tmpdir()), origins: () => [CLOUD], log: (line) => lines.push(line) });
  await ui.attach(contents);
  assert.deepEqual(sent, []);
  assert.match(lines[0], /could not attach/);
});

test("the window: a request the page let go of before its answer is dropped quietly; any other refusal is logged and passed on", async () => {
  const { contents, sent } = fakeWindow();
  const lines = [];
  const ui = createLocalUi({ source: { page: async () => null, file: async () => ({ status: 200, headers: {}, body: Buffer.from("js") }) }, origins: () => [CLOUD], log: (line) => lines.push(line) });
  await ui.attach(contents);
  let refusal = "Invalid InterceptionId.";
  contents.debugger.sendCommand = async (method, params) => { sent.push([method, params]); if (method === "Fetch.fulfillRequest") throw new Error(refusal); return {}; };
  const answer = async (requestId) => {
    sent.length = 0;
    contents.debugger.emit("message", {}, "Fetch.requestPaused", { requestId, resourceType: "Script", request: { url: `${CLOUD}/assets/a.js` } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    return sent.map(([method]) => method);
  };
  assert.deepEqual(await answer("1"), ["Fetch.fulfillRequest"]);
  assert.deepEqual(lines, []);
  refusal = "Body too large";
  assert.deepEqual(await answer("2"), ["Fetch.fulfillRequest", "Fetch.continueRequest"]);
  assert.match(lines[0], /could not answer file \(Body too large\)/);
});
