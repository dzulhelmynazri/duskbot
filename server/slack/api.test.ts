import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SLACK_DEFAULT_REDIRECT_URL } from "../../shared/slack.ts";
import { allowedFileUrl, allowedSocketUrl, createSlackApi, SlackApiError, slackApiBase, slackRedirectUrl, slackTestOrigin } from "./api.ts";

const token = "xoxb-test-canary-credential";
const close: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  while (close.length) await close.pop()!();
});

async function fixture(handler: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void) {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    handler(req, res, Buffer.concat(chunks));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  close.push(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, env: { MADANI_SLACK_API_URL: origin } };
}

const json = (value: unknown, status = 200, headers?: Record<string, string>) => new Response(JSON.stringify(value), { status, headers });
const fetcher = (fn: (url: string | URL | Request, init?: RequestInit) => Promise<Response>) => vi.fn<typeof fetch>(fn);

describe("Slack API requests", () => {
  it("form encodes values, sends the token only when supplied, and uses the fixture base", async () => {
    const received: { path?: string; auth?: string; type?: string; body: string }[] = [];
    const { env, origin } = await fixture((req, res, body) => {
      received.push({ path: req.url, auth: req.headers.authorization, type: req.headers["content-type"], body: body.toString() });
      res.end(JSON.stringify({ ok: true, value: 7 }));
    });
    const api = createSlackApi({ env });
    expect(api.base).toBe(`${origin}/api/`);
    expect(api.testOrigin).toBe(origin);
    expect(await api.call("chat.postMessage", token, { text: "a & b", count: 7, yes: true, no: false, blocks: [{ text: "hi" }], omitted: undefined })).toEqual({ ok: true, value: 7 });
    await api.call("tooling.tokens.rotate", null, { refresh_token: "refresh-canary" });
    expect(received[0]).toMatchObject({ path: "/api/chat.postMessage", auth: `Bearer ${token}`, type: "application/x-www-form-urlencoded; charset=utf-8" });
    expect(Object.fromEntries(new URLSearchParams(received[0].body))).toEqual({ text: "a & b", count: "7", yes: "true", no: "false", blocks: '[{"text":"hi"}]' });
    expect(received[1].auth).toBeUndefined();
  });

  it("maps ok:false to a fixed error without request credentials", async () => {
    const request = fetcher(async () => json({ ok: false, error: "invalid_auth" }));
    const error = await createSlackApi({ fetch: request }).call("auth.test", token, { secret: "param-canary" }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(SlackApiError);
    expect(error).toMatchObject({ code: "invalid_auth", message: "Slack refused auth.test: invalid_auth" });
    expect(String(error)).not.toContain(token);
    expect(String(error)).not.toContain("param-canary");
  });

  it.each([429, 200])("honours Retry-After for rate limiting with HTTP %s", async (status) => {
    let calls = 0;
    const request = fetcher(async () => ++calls === 1 ? json({ ok: false, error: "ratelimited" }, status, { "Retry-After": "2.5" }) : json({ ok: true }));
    const sleep = vi.fn(async (_ms: number) => {});
    await expect(createSlackApi({ fetch: request, sleep }).call("auth.test", token)).resolves.toEqual({ ok: true });
    expect(sleep.mock.calls).toEqual([[2500]]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    [undefined, 1000], ["90", 30000], ["bad", 1000], ["-1", 1000], ["0", 0],
  ])("bounds Retry-After case %# and stops at maxRetries", async (header, ms) => {
    const request = fetcher(async () => json({ ok: false, error: "ratelimited" }, 429, header === undefined ? {} : { "Retry-After": header }));
    const sleep = vi.fn(async (_ms: number) => {});
    await expect(createSlackApi({ fetch: request, sleep, maxRetries: 2 }).call("auth.test", token)).rejects.toMatchObject({ code: "ratelimited", retryAfterMs: ms });
    expect(request).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[ms], [ms]]);
  });

  it("retries rate-limited JSON only up to the default budget", async () => {
    const request = fetcher(async () => json({ ok: false, error: "ratelimited" }));
    const sleep = vi.fn(async (_ms: number) => {});
    await expect(createSlackApi({ fetch: request, sleep }).call("auth.test", token)).rejects.toMatchObject({ code: "ratelimited", retryAfterMs: 1000 });
    expect(request).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls).toEqual([[1000], [1000], [1000]]);
  });

  it("retries 5xx once after one second then reports status", async () => {
    const request = fetcher(async () => new Response("unavailable", { status: 503 }));
    const sleep = vi.fn(async (_ms: number) => {});
    await expect(createSlackApi({ fetch: request, sleep }).call("auth.test", token)).rejects.toMatchObject({ code: "server_error", status: 503 });
    expect(request).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls).toEqual([[1000]]);
  });

  it("returns a successful response after a 5xx retry", async () => {
    let calls = 0;
    const request = fetcher(async () => ++calls === 1 ? new Response(null, { status: 500 }) : json({ ok: true }));
    await expect(createSlackApi({ fetch: request, sleep: async () => {} }).call("auth.test", null)).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("replaces network errors with a fixed sentence and applies a 30 second timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const request = fetcher(async () => { throw new Error(`transport failed with ${token}`); });
    const error = await createSlackApi({ fetch: request }).call("auth.test", token).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "network", message: "Slack could not be reached for auth.test" });
    expect(String(error)).not.toContain(token);
    expect(timeout).toHaveBeenCalledWith(30000);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("maps a timeout abort to network", async () => {
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
    const request = fetcher(async (_url, init) => {
      init?.signal?.throwIfAborted();
      return json({ ok: true });
    });
    await expect(createSlackApi({ fetch: request }).call("auth.test", token)).rejects.toMatchObject({ code: "network" });
  });

  it.each(["not json", "null", "[]", '{"ok":"true"}', '{"ok":false,"error":"xoxb-test-canary-credential"}'])
    ("refuses a malformed API response %# without leaking its body", async (body) => {
      const request = fetcher(async () => new Response(body));
      const error = await createSlackApi({ fetch: request }).call("auth.test", token).catch((error: unknown) => error);
      expect(error).toMatchObject({ code: "bad_response" });
      expect(String(error)).not.toContain(token);
    });

  it("refuses method paths and never follows API redirects", async () => {
    const request = fetcher(async () => new Response(null, { status: 302, headers: { location: "https://evil.example" } }));
    const api = createSlackApi({ fetch: request });
    await expect(api.call("https://evil.example", token)).rejects.toMatchObject({ code: "bad_method" });
    expect(request).not.toHaveBeenCalled();
    await expect(api.call("auth.test", token)).rejects.toMatchObject({ code: "bad_response" });
    expect(request.mock.calls[0][1]?.redirect).toBe("manual");
  });

  it("uploads multipart fields and a file, retaining retry and error handling", async () => {
    let calls = 0;
    const forms: FormData[] = [];
    const request = fetcher(async (_url, init) => {
      forms.push(init?.body as FormData);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      expect(new Headers(init?.headers).has("content-type")).toBe(false);
      return ++calls === 1 ? json({ ok: false, error: "ratelimited" }) : json({ ok: true });
    });
    const sleep = vi.fn(async (_ms: number) => {});
    const api = createSlackApi({ fetch: request, sleep });
    await api.upload("apps.icon.set", token, { app_id: "A1" }, { field: "image", name: "icon.png", mime: "image/png", bytes: new Uint8Array([1, 2, 3]) });
    expect(sleep.mock.calls).toEqual([[1000]]);
    for (const form of forms) {
      expect(form.get("app_id")).toBe("A1");
      const file = form.get("image") as File;
      expect(file.name).toBe("icon.png");
      expect(file.type).toBe("image/png");
      expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1, 2, 3]);
    }
    request.mockImplementation(async () => json({ ok: false, error: "invalid_auth" }));
    await expect(api.upload("apps.icon.set", token, {}, { field: "image", name: "icon.png", mime: "image/png", bytes: new Uint8Array() })).rejects.toMatchObject({ code: "invalid_auth" });
  });
});

describe("Slack files", () => {
  it("refuses a download or upload host before making any request", async () => {
    const request = fetcher(async () => new Response());
    const api = createSlackApi({ fetch: request });
    await expect(api.download("https://evil.example/file", token, 10)).rejects.toMatchObject({ code: "file_host" });
    await expect(api.putUpload("https://evil.example/file", new Uint8Array(), "text/plain")).rejects.toMatchObject({ code: "file_host" });
    expect(request).not.toHaveBeenCalled();
  });

  it("downloads bytes with bearer auth and strips mime parameters", async () => {
    let auth: string | undefined;
    const { origin, env } = await fixture((req, res) => {
      auth = req.headers.authorization;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("hello");
    });
    expect(await createSlackApi({ env }).download(`${origin}/file`, token, 5)).toEqual({ bytes: Buffer.from("hello"), mime: "text/plain" });
    expect(auth).toBe(`Bearer ${token}`);
  });

  it("defaults an absent mime", async () => {
    const request = fetcher(async () => new Response(new Uint8Array([1])));
    expect((await createSlackApi({ fetch: request }).download("https://files.slack.com/file", token, 10)).mime).toBe("application/octet-stream");
  });

  it("refuses redirects without following them", async () => {
    const paths: string[] = [];
    const { origin, env } = await fixture((req, res) => {
      paths.push(req.url!);
      res.writeHead(302, { Location: "/elsewhere" });
      res.end();
    });
    await expect(createSlackApi({ env }).download(`${origin}/redirect`, token, 10)).rejects.toMatchObject({ code: "file_redirect" });
    expect(paths).toEqual(["/redirect"]);
  });

  it("rejects Content-Length over the limit before reading the body", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    const request = fetcher(async () => new Response(stream, { headers: { "Content-Length": "100" } }));
    await expect(createSlackApi({ fetch: request }).download("https://files.slack.com/file", token, 5)).rejects.toMatchObject({ code: "too_large" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("counts streamed bytes and cancels as soon as the limit is exceeded", async () => {
    const cancel = vi.fn();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(3)); }, cancel,
    }, { highWaterMark: 0 });
    const request = fetcher(async () => new Response(stream));
    await expect(createSlackApi({ fetch: request }).download("https://files.slack.com/file", token, 5)).rejects.toMatchObject({ code: "too_large" });
    expect(pulls).toBe(2);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("reports non-2xx file statuses", async () => {
    const request = fetcher(async () => new Response(null, { status: 403 }));
    await expect(createSlackApi({ fetch: request }).download("https://files.slack.com/file", token, 5)).rejects.toMatchObject({ code: "file_status" });
  });

  it("posts raw upload bytes with mime and no Authorization", async () => {
    let received: { auth?: string; type?: string; body: Buffer; method?: string } | undefined;
    const { origin, env } = await fixture((req, res, body) => {
      received = { auth: req.headers.authorization, type: req.headers["content-type"], body, method: req.method };
      res.end("ok");
    });
    await createSlackApi({ env }).putUpload(`${origin}/upload`, new Uint8Array([1, 2, 3]), "image/png");
    expect(received).toEqual({ auth: undefined, type: "image/png", body: Buffer.from([1, 2, 3]), method: "POST" });
  });

  it("refuses upload redirects and reports failed uploads", async () => {
    const request = fetcher(async () => new Response(null, { status: 302 }));
    const api = createSlackApi({ fetch: request });
    await expect(api.putUpload("https://files.slack.com/upload", new Uint8Array(), "text/plain")).rejects.toMatchObject({ code: "upload_status", status: 302 });
    expect(request.mock.calls[0][1]?.redirect).toBe("manual");
    expect(new Headers(request.mock.calls[0][1]?.headers).has("authorization")).toBe(false);
  });
});

describe("Slack post queues", () => {
  it("spaces starts by key, preserves order through errors, and releases idle queues", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const api = createSlackApi();
    const starts: [string, number][] = [];
    const first = api.queued("one", async () => { starts.push(["first", Date.now()]); throw new Error("failed"); });
    const failure = expect(first).rejects.toThrow("failed");
    const second = api.queued("one", async () => { starts.push(["second", Date.now()]); return 2; });
    const other = api.queued("two", async () => { starts.push(["other", Date.now()]); return 3; });
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual([["first", 0], ["other", 0]]);
    await vi.advanceTimersByTimeAsync(1099);
    expect(starts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts[2]).toEqual(["second", 1100]);
    await failure;
    expect(await second).toBe(2);
    expect(await other).toBe(3);
    await vi.runAllTimersAsync();
    expect(vi.getTimerCount()).toBe(0);
    await api.queued("one", async () => { starts.push(["idle", Date.now()]); });
    expect(starts.at(-1)).toEqual(["idle", 2200]);
    await vi.runAllTimersAsync();
  });

  it("serialises long functions and honours a custom minimum gap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const api = createSlackApi({ minGapMs: 100 });
    const starts: number[] = [];
    let finish: () => void = () => {};
    const first = api.queued("one", () => { starts.push(Date.now()); return new Promise<void>((resolve) => { finish = resolve; }); });
    const second = api.queued("one", async () => { starts.push(Date.now()); });
    await vi.advanceTimersByTimeAsync(250);
    expect(starts).toEqual([0]);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual([0, 250]);
    await Promise.all([first, second]);
    await vi.runAllTimersAsync();
  });
});

describe("Slack URL boundaries", () => {
  it("defaults to the Slack Web API", () => {
    expect(slackApiBase({})).toBe("https://slack.com/api/");
    expect(slackTestOrigin({})).toBeNull();
  });

  it.each(["http://127.0.0.1:1", "http://127.0.0.1:99", "http://127.0.0.1:12345"])("accepts the exact loopback override %s", (origin) => {
    expect(slackApiBase({ MADANI_SLACK_API_URL: origin })).toBe(`${origin}/api/`);
    expect(slackTestOrigin({ MADANI_SLACK_API_URL: origin })).toBe(origin);
  });

  it.each(["https://evil", "http://localhost:1", "http://127.0.0.1:99/x", "http://127.0.0.1:99/", "http://127.0.0.1:99?x", "https://127.0.0.1:99", "http://127.0.0.1:123456", "http://127.0.0.1", "http://user@127.0.0.1:99", "HTTP://127.0.0.1:99", " http://127.0.0.1:99", "http://127.0.0.1:99\n"])("ignores an unsafe API override %s", (origin) => {
    expect(slackApiBase({ MADANI_SLACK_API_URL: origin })).toBe("https://slack.com/api/");
    expect(slackTestOrigin({ MADANI_SLACK_API_URL: origin })).toBeNull();
  });

  it.each([
    ["https://files.slack.com/private", null, true], ["https://files.slack.com:443/private", null, true],
    ["https://files.slack.com:444/private", null, false], ["http://files.slack.com/file", null, false],
    ["https://files.slack.com.evil/file", null, false], ["https://user@files.slack.com/file", null, false],
    ["https://user:pass@files.slack.com/file", null, false], ["not a URL", null, false],
    ["http://127.0.0.1:99/file", "http://127.0.0.1:99", true],
    ["http://127.0.0.1:98/file", "http://127.0.0.1:99", false], ["http://127.0.0.1:99/file", null, false],
    ["http://localhost:99/file", "http://127.0.0.1:99", false],
  ])("checks file host case %#", (url, origin, allowed) => {
    expect(allowedFileUrl(url!, origin)).toBe(allowed);
  });

  it.each([
    ["wss://wss-primary.slack.com/link/?ticket=test", null, true], ["wss://a.b.slack.com/link", null, true],
    ["wss://slack.com/link", null, false], ["wss://notslack.com/link", null, false],
    ["wss://slack.com.evil/link", null, false], ["ws://wss-primary.slack.com/link", null, false],
    ["wss://user:pass@wss-primary.slack.com/link", null, false], ["invalid", null, false],
    ["ws://127.0.0.1:99/link", "http://127.0.0.1:99", true],
    ["ws://127.0.0.1:99/link", null, false], ["ws://127.0.0.1:98/link", "http://127.0.0.1:99", false],
    ["ws://localhost:99/link", "http://127.0.0.1:99", false],
    ["ws://user@127.0.0.1:99/link", "http://127.0.0.1:99", false],
    ["wss://127.0.0.1:99/link", "http://127.0.0.1:99", false],
  ])("checks socket host case %#", (url, origin, allowed) => {
    expect(allowedSocketUrl(url!, origin)).toBe(allowed);
  });

  it.each(["https://example.com/callback", "http://127.0.0.1:99/callback", "http://127.0.0.1:80/callback"])("accepts redirect override %s", (url) => {
    expect(slackRedirectUrl({ MADANI_SLACK_REDIRECT_URL: url })).toBe(url);
  });

  it.each(["", "bad", "http://evil/callback", "http://localhost:99/callback", "http://127.0.0.1/callback", "http://127.0.0.1:99.evil/callback", "https://user:pass@example.com/callback", "ftp://example.com/callback"])("defaults unsafe redirect case %#", (url) => {
    expect(slackRedirectUrl({ MADANI_SLACK_REDIRECT_URL: url })).toBe(SLACK_DEFAULT_REDIRECT_URL);
    expect(slackRedirectUrl({})).toBe(SLACK_DEFAULT_REDIRECT_URL);
  });
});
