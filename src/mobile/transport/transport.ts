import { RelayGoneError, type RelayChannel } from "./relay";
import { noteRefusedRequest } from "@/lib/session-ended";
import { asleepAnswer, BACKGROUND_HEADERS, forgetCloudGone, goneAnswer, markCloudAsleep, markCloudGone } from "@/lib/cloud-power";
import { setUploadRoute } from "@/lib/upload-request";
import { forgetLocalVoiceCall } from "@/lib/voice-call/availability";
import { limitSendAttempts } from "@/state/optimistic-send";
import { forgetWorkspaceAnswers, noteWorkspaceAnswer, placeAnswered } from "../connection/reachability";

export type PhoneTransport =
  | { kind: "same-origin" | "bearer"; origin: string; token?: string }
  | { kind: "relay"; channel: RelayChannel; token: string };

const originOf = (transport: PhoneTransport) => transport.kind === "relay" ? "https://mobile-relay.invalid" : transport.origin;
/** routes that never leave the page: a relay tunnel */
const inPage = (transport: PhoneTransport) => transport.kind === "relay";

export function relayFetch(channel: RelayChannel, token: string, onBodyProgress?: (sent: number, total: number) => void): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${token}`);
    const body = request.body ? new Uint8Array(await request.arrayBuffer()) : null;
    request.signal.throwIfAborted();
    return channel.request(request.method, `${url.pathname}${url.search}`, headers, body, request.signal, onBodyProgress);
  };
}

type SseEvent = { data: string; lastEventId: string; type: string };

export function createSseParser(onEvent: (event: SseEvent) => void) {
  const decoder = new TextDecoder();
  let line = "", data: string[] = [], event = "", lastEventId = "";
  let afterCr = false;
  const consumeLine = () => {
    if (!line) {
      const message = data.length ? { data: data.join("\n"), lastEventId, type: event || "message" } : null;
      data = [];
      event = "";
      if (message) onEvent(message);
      return;
    }
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id" && !value.includes("\0")) lastEventId = value;
  };
  const consume = (text: string) => {
    for (const char of text) {
      if (afterCr && char === "\n") { afterCr = false; continue; }
      afterCr = char === "\r";
      if (char === "\r" || char === "\n") { consumeLine(); line = ""; }
      else line += char;
    }
  };
  return {
    push(chunk: Uint8Array | string) { consume(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })); },
    finish() { consume(decoder.decode()); line = ""; data = []; event = ""; },
  };
}

function apiPath(path: string): boolean {
  return path.startsWith("/api/") || path.startsWith("/.well-known/madanibot/");
}

function workspaceUrl(origin: string): URL {
  const url = new URL(origin);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new TypeError("invalid workspace origin");
  return url;
}

export function rewriteApiUrl(input: string, pageOrigin: string, workspaceOrigin: string): string | null {
  try {
    if (input.includes("\\") || [...input].some((char) => char.charCodeAt(0) <= 32)) return null;
    const page = new URL(pageOrigin);
    const relative = apiPath(input);
    if (!relative && !/^[a-z][a-z\d+.-]*:\/\//i.test(input)) return null;
    const url = new URL(input, page);
    if (url.protocol !== page.protocol || url.host !== page.host || url.username || url.password || !apiPath(url.pathname)) return null;
    return `${workspaceUrl(workspaceOrigin).origin}${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

type StreamContext = { fetch: typeof fetch; token: string; url: string; failed?: () => void };
let installed: { transport: PhoneTransport; streamFetch: typeof fetch } | null = null;

export class BearerEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readyState: number = 0;
  readonly url: string;
  readonly withCredentials = false;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private readonly controller = new AbortController();

  constructor(url: string | URL, _init?: EventSourceInit, context?: StreamContext) {
    super();
    const rewritten = installed && rewriteApiUrl(String(url), window.location.origin, originOf(installed.transport));
    const stream = context ?? (installed && rewritten ? { fetch: installed.streamFetch, token: installed.transport.token ?? "", url: rewritten } : null);
    this.url = stream?.url ?? String(url);
    if (stream) void this.open(stream);
    else queueMicrotask(() => this.fail());
  }

  close(): void {
    this.readyState = this.CLOSED;
    this.controller.abort();
  }

  private fail(): void {
    if (this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSED;
    this.controller.abort();
    const event = new Event("error");
    this.dispatchEvent(event);
    this.onerror?.(event);
  }

  private async open(context: StreamContext): Promise<void> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await context.fetch(context.url, {
        // only safelisted headers next to Authorization: a workspace's CORS preflight refuses any other one
        headers: { Authorization: `Bearer ${context.token}`, Accept: "text/event-stream" }, cache: "no-store",
        credentials: "omit", mode: "cors", redirect: "error", signal: this.controller.signal,
      });
      if (this.controller.signal.aborted) return;
      // a stream refused for its credential is the one request a quiet phone makes: it asks whether the session still stands
      if (response.status === 401) noteRefusedRequest();
      if (asleepAnswer(response)) markCloudAsleep();
      else if (goneAnswer(response)) markCloudGone();
      else if (!response.ok) context.failed?.();
      if (!response.ok || !response.body) { this.fail(); return; }
      reader = response.body.getReader();
      this.readyState = this.OPEN;
      const opened = new Event("open");
      this.dispatchEvent(opened);
      this.onopen?.(opened);
      const parser = createSseParser((message) => {
        if (this.readyState !== this.OPEN) return;
        const event = new MessageEvent(message.type, { data: message.data, lastEventId: message.lastEventId, origin: new URL(this.url).origin });
        this.dispatchEvent(event);
        if (message.type === "message") this.onmessage?.(event);
      });
      while (!this.controller.signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) { parser.finish(); this.fail(); break; }
        parser.push(chunk.value);
      }
    } catch {
      if (!this.controller.signal.aborted && this.readyState === this.CONNECTING) context.failed?.();
      this.fail();
    } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
    }
  }
}

function srcsetPaths(value: string): Array<{ start: number; end: number; path: string }> {
  const paths: Array<{ start: number; end: number; path: string }> = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /[\s,]/.test(value[index])) index++;
    const start = index;
    while (index < value.length && !/\s/.test(value[index])) index++;
    let end = index;
    while (end > start && value[end - 1] === ",") end--;
    const path = value.slice(start, end);
    if (path.startsWith("/api/")) paths.push({ start, end, path });
    if (end < index) continue;
    let parentheses = 0;
    while (index < value.length) {
      const char = value[index++];
      if (char === "(") parentheses++;
      else if (char === ")") parentheses = Math.max(0, parentheses - 1);
      else if (char === "," && parentheses === 0) break;
    }
  }
  return paths;
}

const FAILED = "data-madani-media-failed";

function awaitingBlob(element: Element): boolean {
  return (element.getAttribute("src") ?? "").startsWith("/api/") || srcsetPaths(element.getAttribute("srcset") ?? "").length > 0;
}

function installMedia(): () => void {
  const selector = "img,audio,video,source,image,link[rel~='icon']";
  const attributes = ["src", "srcset", "poster", "href"];
  const cache = new Map<string, string>();
  const pending = new Map<string, Promise<string | null>>();
  const processed = new WeakMap<Element, Map<string, string>>();
  const controller = new AbortController();
  let stopped = false;
  const blobUrl = (path: string): Promise<string | null> => {
    const cached = cache.get(path);
    if (cached) { cache.delete(path); cache.set(path, cached); return Promise.resolve(cached); }
    const existing = pending.get(path);
    if (existing) return existing;
    const request = window.fetch(path, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) return null;
      const blob = await response.blob();
      if (stopped) return null;
      const url = URL.createObjectURL(blob);
      cache.set(path, url);
      if (cache.size > 300) {
        const oldest = cache.keys().next().value!;
        URL.revokeObjectURL(cache.get(oldest)!);
        cache.delete(oldest);
      }
      return url;
    }).catch(() => null).finally(() => pending.delete(path));
    pending.set(path, request);
    return request;
  };
  const replace = async (element: Element, attribute: string) => {
    const value = element.getAttribute(attribute);
    if (!value || processed.get(element)?.get(attribute) === value) return;
    if (attribute === "src" && value.startsWith("/api/")) element.removeAttribute(FAILED);
    let next = value;
    if (attribute === "srcset") {
      const replacements = await Promise.all(srcsetPaths(value).map(async (candidate) => ({ ...candidate, url: await blobUrl(candidate.path) })));
      for (const { start, end, url } of replacements.reverse()) {
        if (!url) continue;
        next = next.slice(0, start) + url + next.slice(end);
      }
    } else if (value.startsWith("/api/")) {
      const url = await blobUrl(value);
      if (!url) {
        if (!stopped && attribute === "src" && element.getAttribute(attribute) === value) {
          element.setAttribute(FAILED, "");
          element.dispatchEvent(new Event("error"));
        }
        return;
      }
      next = url;
    }
    if (stopped || next === value || element.getAttribute(attribute) !== value) return;
    let marks = processed.get(element);
    if (!marks) { marks = new Map(); processed.set(element, marks); }
    marks.set(attribute, next);
    element.setAttribute("data-madani-media", "1");
    element.setAttribute(attribute, next);
    if (element instanceof HTMLMediaElement) element.load();
    else if (element.tagName.toLowerCase() === "source" && element.parentElement instanceof HTMLMediaElement) element.parentElement.load();
  };
  const scan = (node: Node) => {
    if (node instanceof Element && node.matches(selector)) for (const attr of attributes) void replace(node, attr);
    if (node instanceof Element || node instanceof Document) {
      for (const element of node.querySelectorAll(selector)) for (const attr of attributes) void replace(element, attr);
    }
  };
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes" && mutation.target instanceof Element && mutation.target.matches(selector)) void replace(mutation.target, mutation.attributeName!);
      for (const node of mutation.addedNodes) scan(node);
    }
  });
  // the app's own origin serves no /api, so a workspace path's first load fails before its blob is swapped in; that
  // error is held back (it would show a broken image), and the real one is sent if the blob cannot be had
  const early = (event: Event) => {
    const element = event.target;
    if (element instanceof Element && element.matches(selector) && !element.hasAttribute(FAILED) && awaitingBlob(element)) event.stopImmediatePropagation();
  };
  document.addEventListener("error", early, true);
  observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: attributes });
  scan(document);
  return () => {
    stopped = true;
    document.removeEventListener("error", early, true);
    observer.disconnect();
    controller.abort();
    for (const url of cache.values()) URL.revokeObjectURL(url);
    cache.clear();
  };
}

export const ASLEEP_PROBE_GAP_MS = 10_000;
/** how long one send to a place over the network waits for its answer before asking again on a new request */
export const PHONE_SEND_ATTEMPT_MS = 20_000;

/** The live stream goes through the WebView's own fetch, and a sleeping Cloud's edge answer carries no CORS headers, so
 * a failed stream cannot tell asleep from unreachable; one background read through native http can. */
export function asleepProbe(send: typeof fetch, origin: string, token: string, now = Date.now): () => void {
  let last = -Infinity;
  return () => {
    if (now() - last < ASLEEP_PROBE_GAP_MS) return;
    last = now();
    void send(`${origin}/api/health`, { headers: { Authorization: `Bearer ${token}`, ...BACKGROUND_HEADERS }, credentials: "omit", redirect: "error", signal: AbortSignal.timeout(10_000) })
      .then((response) => { if (asleepAnswer(response)) markCloudAsleep(); else if (goneAnswer(response)) markCloudGone(); void response.body?.cancel().catch(() => {}); })
      .catch(() => {});
  };
}

/** CapacitorHttp 8 (`convertBody` in native-bridge.js) sends a Uint8Array or stream body through `TextDecoder`, which turns
 * every byte above 0x7F into U+FFFD, and a plain Blob as JSON; only a `File` crosses to native http byte for byte, as base64. */
export async function nativeBody(body: BodyInit | null | undefined, contentType: string | null): Promise<BodyInit | null | undefined> {
  if (body == null || typeof body === "string" || body instanceof URLSearchParams || body instanceof FormData || body instanceof File) return body;
  const type = contentType || (body instanceof Blob ? body.type : "") || "application/octet-stream";
  return new File([await new Response(body).arrayBuffer()], "body", { type });
}

/** `onGone`: the relay no longer has this phone's channel, so only pairing again brings the workspace back. */
export function installTransport(transport: PhoneTransport, onGone?: () => void): () => void {
  if (transport.kind === "same-origin") return () => {};
  const origin = originOf(transport);
  const workspace = workspaceUrl(origin);
  const originalFetch = window.fetch;
  const OriginalEventSource = window.EventSource;
  const OriginalWebSocket = window.WebSocket;
  const previous = installed;
  const streamFetch = (window as Window & { CapacitorWebFetch?: typeof fetch }).CapacitorWebFetch ?? originalFetch;
  const overRelay = (send: typeof fetch): typeof fetch => (input, init) => send(input, init).catch((error: unknown) => {
    if (error instanceof RelayGoneError) onGone?.();
    throw error;
  });
  const sendWorkspace = transport.kind === "relay" ? overRelay(relayFetch(transport.channel, transport.token)) : originalFetch.bind(window);
  // every answer from the place proves it is reachable, whatever the live stream is doing
  const fetchWorkspace: typeof fetch = (input, init) => sendWorkspace(input, init).then((response) => {
    if (placeAnswered(response)) noteWorkspaceAnswer();
    else if (goneAnswer(response)) markCloudGone();
    return response;
  });
  forgetWorkspaceAnswers();
  forgetCloudGone();
  const context = { transport, streamFetch: inPage(transport) ? fetchWorkspace : streamFetch.bind(window) };
  const probeAsleep = transport.kind === "bearer" ? asleepProbe(fetchWorkspace, origin, transport.token ?? "") : undefined;
  installed = context;
  const patchedFetch: typeof fetch = async (input, init) => {
    const url = rewriteApiUrl(input instanceof Request ? input.url : String(input), window.location.origin, origin);
    if (!url) return originalFetch.call(window, input, init);
    const request = input instanceof Request ? new Request(input, init) : null;
    const headers = new Headers(request?.headers ?? init?.headers);
    if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${transport.token ?? ""}`);
    const body = transport.kind !== "bearer" ? undefined
      : await nativeBody(request ? request.body && await request.clone().arrayBuffer() : init?.body, headers.get("Content-Type"));
    // redirects must not carry the workspace credential to a different origin, including through native http.
    const options: RequestInit = { ...(request ? {} : init), headers, credentials: "omit", mode: "cors", redirect: "error", ...(body != null && !request ? { body } : {}) };
    if (request) return fetchWorkspace(new Request(new Request(url, request), options), body != null ? { body } : undefined);
    return fetchWorkspace(url, options);
  };
  const sources = new Set<BearerEventSource>();
  const PatchedEventSource = new Proxy(OriginalEventSource, {
    construct(Target, args: [string | URL, EventSourceInit?]) {
      const url = rewriteApiUrl(String(args[0]), window.location.origin, origin);
      if (!url || !new URL(url).pathname.startsWith("/api/")) return new Target(...args);
      for (const source of sources) if (source.readyState === source.CLOSED) sources.delete(source);
      const source = new BearerEventSource(args[0], args[1], { url, token: transport.token ?? "", fetch: context.streamFetch, failed: probeAsleep });
      sources.add(source);
      source.addEventListener("error", () => sources.delete(source), { once: true });
      return source;
    },
  });
  const sockets = new Set<WebSocket>();
  const PatchedWebSocket = new Proxy(OriginalWebSocket, {
    construct(Target, args: [string | URL, (string | string[])?]) {
      const input = String(args[0]);
      let target: URL | null = null;
      try {
        const url = new URL(input, window.location.href);
        if (!inPage(transport) && url.host === window.location.host && ["ws:", "wss:", window.location.protocol].includes(url.protocol) && url.pathname.startsWith("/api/") && !url.username && !url.password) {
          target = new URL(`${url.pathname}${url.search}`, workspace);
          target.protocol = workspace.protocol === "https:" ? "wss:" : "ws:";
          // the sync branch's server must accept access_token on authenticated viewer upgrades.
          if (workspace.protocol === "https:" && transport.token) target.searchParams.set("access_token", transport.token);
        }
      } catch {}
      const socket = new Target(target?.href ?? args[0], args[1]);
      if (target) { sockets.add(socket); socket.addEventListener("close", () => sockets.delete(socket), { once: true }); }
      return socket;
    },
  });
  window.fetch = patchedFetch;
  window.EventSource = PatchedEventSource;
  window.WebSocket = PatchedWebSocket;
  forgetLocalVoiceCall();
  // the relay sends a body from the page in chunks, so it can count them; bearer requests go out through native http
  const stopUploads = transport.kind === "relay" ? setUploadRoute((input, init, onProgress) => {
    const url = rewriteApiUrl(input, window.location.origin, origin);
    if (!url) return null;
    return overRelay(relayFetch(transport.channel, transport.token, onProgress))(url, { method: init.method, headers: init.headers, body: init.body as BodyInit, signal: init.signal, credentials: "omit", redirect: "error" });
  }) : () => {};
  const stopMedia = installMedia();
  const stopSendLimit = limitSendAttempts(PHONE_SEND_ATTEMPT_MS);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    stopUploads();
    stopMedia();
    stopSendLimit();
    if (transport.kind === "relay") transport.channel.close();
    for (const source of sources) source.close();
    for (const socket of sockets) socket.close();
    if (window.fetch === patchedFetch) window.fetch = originalFetch;
    if (window.EventSource === PatchedEventSource) window.EventSource = OriginalEventSource;
    if (window.WebSocket === PatchedWebSocket) window.WebSocket = OriginalWebSocket;
    if (installed === context) installed = previous;
  };
}

export function mediaUrl(path: string): string {
  return installed && !inPage(installed.transport) ? rewriteApiUrl(path, window.location.origin, originOf(installed.transport)) ?? path : path;
}
