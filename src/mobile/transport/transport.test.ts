import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RelayGoneError } from "./relay";
import { ASLEEP_PROBE_GAP_MS, asleepProbe, BearerEventSource, createSseParser, installTransport, mediaUrl, rewriteApiUrl } from "./transport";
import { cloudAsleep, cloudGone, noteCloudPageActivity, resetCloudPowerForTests } from "@/lib/cloud-power";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("SSE parser", () => {
  it("keeps split lines, CRLF, multiline data, event names and persistent ids", () => {
    const events: Array<{ data: string; lastEventId: string; type: string }> = [];
    const parser = createSseParser((event) => events.push(event));
    for (const chunk of [": keepalive\r", "\nid: cursor-1\r\neve", "nt: update\r\ndata: first\r\nda", "ta:  second\r", "\n\r", "\ndata: next\n\n"]) parser.push(chunk);
    expect(events).toEqual([
      { type: "update", lastEventId: "cursor-1", data: "first\n second" },
      { type: "message", lastEventId: "cursor-1", data: "next" },
    ]);
  });

  it("decodes UTF-8 even when every multibyte character is split", () => {
    const events: string[] = [];
    const parser = createSseParser((event) => events.push(event.data));
    for (const byte of new TextEncoder().encode("\ufeffdata: café 🐭 日本語\n\n")) parser.push(Uint8Array.of(byte));
    parser.finish();
    expect(events).toEqual(["café 🐭 日本語"]);
  });

  it("ignores comments and empty blocks, resets event names and rejects null ids", () => {
    const events: Array<{ data: string; lastEventId: string; type: string }> = [];
    const parser = createSseParser((event) => events.push(event));
    parser.push(": ping\n\nevent: stale\nid: first\n\nid: bad\0id\ndata\n\nid:\rdata: last\r\rdata: unfinished");
    parser.finish();
    expect(events).toEqual([
      { type: "message", lastEventId: "first", data: "" },
      { type: "message", lastEventId: "", data: "last" },
    ]);
  });
});

describe("API URL routing", () => {
  it.each([
    ["/api/events?since=a%2Fb#ignored", "https://workspace.test/api/events?since=a%2Fb"],
    ["/.well-known/madanibot/environment", "https://workspace.test/.well-known/madanibot/environment"],
    ["https://localhost/api/bots", "https://workspace.test/api/bots"],
    ["https://localhost/.well-known/madanibot/environment", "https://workspace.test/.well-known/madanibot/environment"],
    ["https://other.test/api/bots", null],
    ["https://localhost:8080/api/bots", null],
    ["http://localhost/api/bots", null],
    ["//other.test/api/bots", null],
    ["//localhost/api/bots", null],
    ["/api/../../elsewhere", null],
    ["/api\\other.test/file", null],
    ["https://person@localhost/api/bots", null],
    ["/apiary/bots", null],
    ["/assets/logo.svg", null],
    ["data:text/plain,/api/bots", null],
    ["api/bots", null],
  ])("routes %s without leaking credentials", (input, expected) => {
    expect(rewriteApiUrl(input, "https://localhost", "https://workspace.test")).toBe(expected);
  });

  it("handles capacitor origins without trusting other opaque origins", () => {
    expect(rewriteApiUrl("/api/events", "capacitor://localhost", "https://workspace.test")).toBe("https://workspace.test/api/events");
    expect(rewriteApiUrl("capacitor://localhost/api/events", "capacitor://localhost", "https://workspace.test")).toBe("https://workspace.test/api/events");
    expect(rewriteApiUrl("other://localhost/api/events", "capacitor://localhost", "https://workspace.test")).toBeNull();
  });
});

describe("bearer event source", () => {
  it("opens one streamed request and dispatches named messages before EOF closes it", async () => {
    const bytes = new TextEncoder().encode("id: 9\nevent: ping\ndata: alive\n\ndata: hello\n\n");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } })));
    const source = new BearerEventSource("/api/events", undefined, { url: "https://workspace.test/api/events", token: "test-secret", fetch: fetcher });
    const open = vi.fn(), error = vi.fn(), message = vi.fn(), named = vi.fn();
    source.onopen = open;
    source.onerror = error;
    source.onmessage = message;
    source.addEventListener("ping", named);
    await vi.waitFor(() => expect(source.readyState).toBe(source.CLOSED));
    expect(open).toHaveBeenCalledOnce();
    expect(named.mock.calls[0][0]).toMatchObject({ type: "ping", data: "alive", lastEventId: "9" });
    expect(message.mock.calls[0][0]).toMatchObject({ type: "message", data: "hello", lastEventId: "9" });
    expect(error).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]).toEqual(["https://workspace.test/api/events", expect.objectContaining({ credentials: "omit", redirect: "error", headers: { Authorization: "Bearer test-secret", Accept: "text/event-stream" }, cache: "no-store" })]);
  });

  it.each([401, 503])("closes on HTTP %s without retrying", async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));
    const source = new BearerEventSource("/api/events", undefined, { url: "https://workspace.test/api/events", token: "test", fetch: fetcher });
    const error = vi.fn();
    source.onerror = error;
    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
    expect(source.readyState).toBe(BearerEventSource.CLOSED);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("closes on network failure and supports closing before the response", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline"));
    const source = new BearerEventSource("/api/events", undefined, { url: "https://workspace.test/api/events", token: "test", fetch: fetcher });
    const error = vi.fn();
    source.addEventListener("error", error);
    source.close();
    await Promise.resolve();
    expect(source.readyState).toBe(source.CLOSED);
    expect(error).not.toHaveBeenCalled();
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    const failed = new BearerEventSource("/api/events", undefined, { url: "https://workspace.test/api/events", token: "test", fetch: fetcher });
    failed.onerror = error;
    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
    expect(failed.readyState).toBe(failed.CLOSED);
  });
});

function transportFixture() {
  class EmptyElement extends EventTarget {
    readonly attributes = new Map<string, string>();
    readonly tagName = "IMG";
    getAttribute(name: string) { return this.attributes.get(name) ?? null; }
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    hasAttribute(name: string) { return this.attributes.has(name); }
    removeAttribute(name: string) { this.attributes.delete(name); }
    matches() { return true; }
    querySelectorAll() { return []; }
  }
  class EmptyDocument extends EventTarget {
    elements: EmptyElement[] = [];
    querySelectorAll() { return this.elements; }
  }
  class FakeSocket extends EventTarget {
    static CONNECTING = 0;
    constructor(readonly url: string) { super(); }
    close() {}
  }
  class FakeSource extends EventTarget { constructor(readonly url: string) { super(); } }
  vi.stubGlobal("Document", EmptyDocument);
  vi.stubGlobal("Element", EmptyElement);
  vi.stubGlobal("HTMLMediaElement", class extends EmptyElement {});
  const document = new EmptyDocument();
  vi.stubGlobal("document", document);
  let mutated: (mutations: unknown[]) => void = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal("MutationObserver", class {
    constructor(callback: (mutations: unknown[]) => void) { mutated = callback; }
    observe() {}
    disconnect = disconnect;
  });
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response());
  const browser = { fetch: fetcher as typeof fetch, EventSource: FakeSource as unknown as typeof EventSource, WebSocket: FakeSocket as unknown as typeof WebSocket, location: new URL("https://localhost/") };
  vi.stubGlobal("window", browser);
  return { browser, fetcher, FakeSource, EmptyElement, document, disconnect, mutate: (element: EmptyElement, attributeName = "src") => mutated([{ type: "attributes", target: element, attributeName, addedNodes: [] }]) };
}

describe("installed adapters", () => {
  it("preserves Request bodies, headers, method and abort signals; restores globals", async () => {
    const { browser, fetcher } = transportFixture();
    const restore = installTransport({ kind: "bearer", origin: "https://workspace.test", token: "test-secret" });
    try {
      const controller = new AbortController();
      await browser.fetch(new Request("https://localhost/api/upload", { method: "POST", body: "bytes", headers: { "Content-Type": "text/plain" }, signal: controller.signal }));
      const request = fetcher.mock.calls[0][0] as Request;
      expect(request.url).toBe("https://workspace.test/api/upload");
      expect(request.method).toBe("POST");
      expect(await request.text()).toBe("bytes");
      expect(request.headers.get("Authorization")).toBe("Bearer test-secret");
      expect(request.headers.get("Content-Type")).toBe("text/plain");
      expect(request.credentials).toBe("omit");
      expect(request.mode).toBe("cors");
      controller.abort();
      expect(request.signal.aborted).toBe(true);
      await browser.fetch("/api/events", { headers: { Authorization: "Bearer explicit" } });
      expect(new Headers(fetcher.mock.calls[1][1]?.headers).get("Authorization")).toBe("Bearer explicit");
      const external = new Request("https://other.test/api/data");
      await browser.fetch(external);
      expect(fetcher.mock.calls[2]).toEqual([external, undefined]);
      expect(mediaUrl("/api/attachments/image")).toBe("https://workspace.test/api/attachments/image");
    } finally { restore(); }
    expect(browser.fetch).toBe(fetcher);
    expect(mediaUrl("/api/attachments/image")).toBe("/api/attachments/image");
  });

  it("hands native http image bytes as a File, so none above 0x7F turn into U+FFFD", async () => {
    const { browser, fetcher } = transportFixture();
    const restore = installTransport({ kind: "bearer", origin: "https://workspace.test", token: "test-secret" });
    const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0x80);
    try {
      await browser.fetch("/api/attachments?uploadId=a", { method: "POST", headers: { "content-type": "image/png" }, body: png });
      const sent = fetcher.mock.calls[0][1]?.body;
      expect(sent).toBeInstanceOf(File);
      expect((sent as File).type).toBe("image/png");
      expect(new Uint8Array(await (sent as File).arrayBuffer())).toEqual(png);
      await browser.fetch(new Request("https://localhost/api/attachments", { method: "POST", headers: { "content-type": "image/png" }, body: png }));
      const fromRequest = fetcher.mock.calls[1][1]?.body;
      expect(fromRequest).toBeInstanceOf(File);
      expect(new Uint8Array(await (fromRequest as File).arrayBuffer())).toEqual(png);
      await browser.fetch("/api/chat", { method: "POST", body: "{\"text\":\"hi\"}" });
      expect(fetcher.mock.calls[2][1]?.body).toBe("{\"text\":\"hi\"}");
    } finally { restore(); }
  });

  it("keeps unrelated EventSource URLs native and only adds socket tokens over TLS", () => {
    const { browser, FakeSource } = transportFixture();
    let restore = installTransport({ kind: "bearer", origin: "https://workspace.test", token: "test-secret" });
    try {
      expect(new browser.EventSource("/other/events")).toBeInstanceOf(FakeSource);
      expect(new browser.EventSource("https://other.test/api/events")).toBeInstanceOf(FakeSource);
      expect(new browser.WebSocket("wss://localhost/api/viewer?size=1").url).toBe("wss://workspace.test/api/viewer?size=1&access_token=test-secret");
      expect(new browser.WebSocket("wss://other.test/api/viewer").url).toBe("wss://other.test/api/viewer");
    } finally { restore(); }
    restore = installTransport({ kind: "bearer", origin: "http://companion.test:8810", token: "test-secret" });
    try { expect(new browser.WebSocket("/api/viewer").url).toBe("ws://companion.test:8810/api/viewer"); } finally { restore(); }
  });

  it("converts media and srcset candidates, deduplicates loads and preserves external URLs", async () => {
    const { document, EmptyElement, fetcher, mutate, disconnect } = transportFixture();
    const first = new EmptyElement(), second = new EmptyElement(), sourceSet = new EmptyElement();
    first.setAttribute("src", "/api/attachments/a");
    second.setAttribute("src", "/api/attachments/a");
    sourceSet.setAttribute("srcset", "  /api/attachments/a 1x, /api/attachments/b 2x, data:image/svg+xml,/api/keep 3x, https://other.test/image 4x");
    document.elements = [first, second, sourceSet];
    fetcher.mockImplementation(async () => new Response("image bytes"));
    let sequence = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:test-${++sequence}`);
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const restore = installTransport({ kind: "bearer", origin: "https://workspace.test", token: "test" });
    try {
      await vi.waitFor(() => expect(first.getAttribute("src")).toBe("blob:test-1"));
      expect(second.getAttribute("src")).toBe("blob:test-1");
      expect(sourceSet.getAttribute("srcset")).toBe("  blob:test-1 1x, blob:test-2 2x, data:image/svg+xml,/api/keep 3x, https://other.test/image 4x");
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(first.getAttribute("data-madani-media")).toBe("1");
      mutate(first);
      await Promise.resolve();
      expect(fetcher).toHaveBeenCalledTimes(2);
      first.setAttribute("src", "/api/attachments/b");
      mutate(first);
      await vi.waitFor(() => expect(first.getAttribute("src")).toBe("blob:test-2"));
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { restore(); }
    expect(disconnect).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledTimes(2);
  });

  it("leaves failed or changed media alone and discards late results after uninstall", async () => {
    const { document, EmptyElement, fetcher, mutate } = transportFixture();
    const first = new EmptyElement();
    first.setAttribute("src", "/api/attachments/a");
    document.elements = [first];
    fetcher.mockResolvedValueOnce(new Response(null, { status: 403 }));
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
    const restore = installTransport({ kind: "bearer", origin: "https://workspace.test", token: "test" });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    expect(first.getAttribute("src")).toBe("/api/attachments/a");
    let finish: (response: Response) => void = () => {};
    fetcher.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    first.setAttribute("src", "/api/attachments/b");
    mutate(first);
    first.setAttribute("src", "https://other.test/image");
    restore();
    finish(new Response("late image"));
    await vi.waitFor(() => expect(fetcher.mock.calls[1][1]?.signal?.aborted).toBe(true));
    expect(first.getAttribute("src")).toBe("https://other.test/image");
    expect(create).not.toHaveBeenCalled();
  });

  it("revokes the oldest media URL when the cache exceeds 300 entries", async () => {
    const { document, EmptyElement, fetcher } = transportFixture();
    document.elements = Array.from({ length: 301 }, (_, index) => {
      const element = new EmptyElement();
      element.setAttribute("src", `/api/attachments/${index}`);
      return element;
    });
    fetcher.mockImplementation(async () => new Response("image"));
    let sequence = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:test-${++sequence}`);
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const restore = installTransport({ kind: "bearer", origin: "https://workspace.test", token: "test" });
    try {
      await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:test-1"));
      expect(revoke).toHaveBeenCalledOnce();
    } finally { restore(); }
    expect(revoke).toHaveBeenCalledTimes(301);
  });
});

describe("relay transport", () => {
  it("tunnels API fetches, request bodies and EventSource with the workspace bearer", async () => {
    const { browser, fetcher, FakeSource } = transportFixture();
    const channel = {
      request: vi.fn().mockImplementation(async (_method: string, path: string) => path.startsWith("/api/events")
        ? new Response("event: ping\ndata: relay hello\n\n", { headers: { "Content-Type": "text/event-stream" } })
        : new Response("uploaded")),
      close: vi.fn(),
    };
    const restore = installTransport({ kind: "relay", channel, token: "workspace-secret" });
    try {
      const abort = new AbortController();
      const form = new FormData();
      form.append("file", new Blob(["binary bytes"]), "file.txt");
      await browser.fetch(new Request("https://localhost/api/files", { method: "POST", body: form, signal: abort.signal }));
      const [method, path, headers, bytes, signal] = channel.request.mock.calls[0];
      expect(method).toBe("POST");
      expect(path).toBe("/api/files");
      expect(headers.get("Authorization")).toBe("Bearer workspace-secret");
      expect(headers.get("Content-Type")).toMatch(/^multipart\/form-data; boundary=/);
      expect(new TextDecoder().decode(bytes)).toContain("binary bytes");
      abort.abort();
      expect(signal.aborted).toBe(true);
      const events = new browser.EventSource("/api/events?cursor=7");
      const ping = vi.fn();
      events.addEventListener("ping", ping);
      await vi.waitFor(() => expect(ping).toHaveBeenCalledOnce());
      expect((ping.mock.calls[0][0] as MessageEvent).data).toBe("relay hello");
      expect(channel.request.mock.calls[1][1]).toBe("/api/events?cursor=7");
      expect(channel.request.mock.calls[1][2].get("Authorization")).toBe("Bearer workspace-secret");
      expect(new browser.EventSource("https://external.test/api/events")).toBeInstanceOf(FakeSource);
      await browser.fetch("https://external.test/api/files");
      expect(fetcher).toHaveBeenCalledWith("https://external.test/api/files", undefined);
      expect(mediaUrl("/api/attachments/a")).toBe("/api/attachments/a");
    } finally { restore(); }
    expect(channel.close).toHaveBeenCalledOnce();
    expect(browser.fetch).toBe(fetcher);
  });

  it("says so once the relay no longer has the channel, and stays quiet for a lost connection", async () => {
    const { browser } = transportFixture();
    const channel = { request: vi.fn().mockRejectedValue(new Error("relay closed")), close: vi.fn() };
    const gone = vi.fn();
    const restore = installTransport({ kind: "relay", channel, token: "workspace-secret" }, gone);
    try {
      await expect(browser.fetch("/api/bots")).rejects.toThrow("relay closed");
      expect(gone).not.toHaveBeenCalled();
      channel.request.mockRejectedValue(new RelayGoneError());
      await expect(browser.fetch("/api/bots")).rejects.toBeInstanceOf(RelayGoneError);
      expect(gone).toHaveBeenCalledOnce();
    } finally { restore(); }
  });

  it("loads media through the relay and revokes its blob on uninstall", async () => {
    const { document, EmptyElement, fetcher } = transportFixture();
    const element = new EmptyElement();
    element.setAttribute("src", "/api/attachments/a");
    document.elements = [element];
    const channel = { request: vi.fn().mockResolvedValue(new Response("image bytes")), close: vi.fn() };
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:relay-image");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const restore = installTransport({ kind: "relay", channel, token: "workspace-secret" });
    try {
      await vi.waitFor(() => expect(element.getAttribute("src")).toBe("blob:relay-image"));
      expect(channel.request.mock.calls[0].slice(0, 2)).toEqual(["GET", "/api/attachments/a"]);
      expect(fetcher).not.toHaveBeenCalled();
    } finally { restore(); }
    expect(revoke).toHaveBeenCalledWith("blob:relay-image");
  });
});

describe("a sleeping Cloud behind the phone's stream", () => {
  // an untouched phone: one in use wakes the home straight back (src/lib/cloud-power.test.ts)
  beforeEach(() => noteCloudPageActivity(0));
  afterEach(() => resetCloudPowerForTests());
  it("an asleep answer on the stream itself puts the page to sleep without a probe", async () => {
    const failed = vi.fn();
    const fetcher = vi.fn(async () => new Response("asleep", { status: 503, headers: { "x-madani-cloud-power": "asleep" } }));
    const source = new BearerEventSource("/api/events", undefined, { url: "https://workspace.test/api/events", token: "t", fetch: fetcher, failed });
    await vi.waitFor(() => expect(source.readyState).toBe(source.CLOSED));
    expect(cloudAsleep()).toBe(true); expect(failed).not.toHaveBeenCalled();
  });
  it("a stream the WebView could not read asks once through native http", async () => {
    const failed = vi.fn();
    const source = new BearerEventSource("/api/events", undefined, { url: "https://workspace.test/api/events", token: "t", fetch: vi.fn(async () => { throw new TypeError("cors"); }), failed });
    await vi.waitFor(() => expect(source.readyState).toBe(source.CLOSED));
    expect(failed).toHaveBeenCalledOnce();
  });
  it("the probe and the stream both hear a deleted madani cloud, and say it is gone", async () => {
    const gone = () => new Response("This madani bot was deleted.", { status: 410, headers: { "x-madani-cloud-power": "gone" } });
    asleepProbe(vi.fn(async () => gone()), "https://workspace.test", "secret", () => 0)();
    await vi.waitFor(() => expect(cloudGone()).toBe(true));
    expect(cloudAsleep()).toBe(false);
    resetCloudPowerForTests();
    const failed = vi.fn();
    const source = new BearerEventSource("/api/events", undefined, { url: "https://workspace.test/api/events", token: "t", fetch: vi.fn(async () => gone()), failed });
    await vi.waitFor(() => expect(source.readyState).toBe(source.CLOSED));
    expect(cloudGone()).toBe(true);
    expect(failed).not.toHaveBeenCalled();
  });
  it("the probe is a background read that marks the page asleep, at most once in its gap", async () => {
    let clock = 0;
    const send = vi.fn(async () => new Response("", { status: 503, headers: { "x-madani-cloud-power": "asleep" } }));
    const probe = asleepProbe(send, "https://workspace.test", "secret", () => clock);
    probe(); probe();
    await vi.waitFor(() => expect(cloudAsleep()).toBe(true));
    expect(send).toHaveBeenCalledOnce();
    const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://workspace.test/api/health");
    expect(init.headers).toMatchObject({ Authorization: "Bearer secret", "x-madani-background": "1" });
    clock = ASLEEP_PROBE_GAP_MS; probe();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
