import { SLACK_DEFAULT_REDIRECT_URL } from "../../shared/slack.ts";

export class SlackApiError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(code: string, options: { method?: string; status?: number; retryAfterMs?: number } = {}) {
    const method = options.method ?? "request";
    super(code === "network" ? `Slack could not be reached for ${method}` : `Slack refused ${method}: ${code}`);
    this.name = "SlackApiError";
    this.code = code;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export interface SlackApiOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  minGapMs?: number;
}
export type SlackParams = Record<string, string | number | boolean | object | undefined>;
export interface SlackApi {
  call<T = Record<string, unknown>>(method: string, token: string | null, params?: SlackParams): Promise<T>;
  upload<T = Record<string, unknown>>(method: string, token: string, fields: Record<string, string>, file: { field: string; name: string; mime: string; bytes: Uint8Array }): Promise<T>;
  download(url: string, token: string, maxBytes: number): Promise<{ bytes: Buffer; mime: string }>;
  putUpload(url: string, bytes: Uint8Array, mime: string): Promise<void>;
  queued<T>(key: string, fn: () => Promise<T>): Promise<T>;
  readonly base: string;
  readonly testOrigin: string | null;
}

export function slackTestOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.MADANI_SLACK_API_URL;
  return value && value === value.trim() && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(value) ? value : null;
}

export function slackApiBase(env: NodeJS.ProcessEnv = process.env): string {
  const origin = slackTestOrigin(env);
  return origin ? `${origin}/api/` : "https://slack.com/api/";
}

export function allowedFileUrl(value: string, testOrigin: string | null): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    return (url.protocol === "https:" && url.origin === "https://files.slack.com") || (testOrigin !== null && url.origin === testOrigin);
  } catch {
    return false;
  }
}

export function allowedSocketUrl(value: string, testOrigin: string | null): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    return (url.protocol === "wss:" && url.hostname.endsWith(".slack.com")) ||
      (testOrigin !== null && url.protocol === "ws:" && url.hostname === "127.0.0.1" && url.port === new URL(testOrigin).port);
  } catch {
    return false;
  }
}

export function slackRedirectUrl(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.MADANI_SLACK_REDIRECT_URL;
  if (value) {
    try {
      const url = new URL(value);
      if (!url.username && !url.password && (url.protocol === "https:" ||
        (url.protocol === "http:" && url.hostname === "127.0.0.1" && /^http:\/\/127\.0\.0\.1:\d{1,5}(?:[/?#]|$)/.test(value)))) return value;
    } catch {}
  }
  return SLACK_DEFAULT_REDIRECT_URL;
}

function retryAfter(response: Response): number {
  const seconds = Number(response.headers.get("retry-after") ?? 1);
  return Math.min(30, Number.isFinite(seconds) && seconds >= 0 ? seconds : 1) * 1000;
}

export function createSlackApi(options: SlackApiOptions = {}): SlackApi {
  const base = slackApiBase(options.env);
  const testOrigin = slackTestOrigin(options.env);
  const request = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxRetries = options.maxRetries ?? 3;
  const minGapMs = options.minGapMs ?? 1100;
  const queues = new Map<string, Promise<void>>();

  async function fetchResponse(method: string, url: string, init: RequestInit): Promise<Response> {
    try {
      return await request(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new SlackApiError("network", { method });
    }
  }

  async function post<T>(method: string, token: string | null, body: () => URLSearchParams | FormData, contentType?: string): Promise<T> {
    if (method !== method.trim() || !/^[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)*$/.test(method)) throw new SlackApiError("bad_method");
    let rateRetries = 0;
    let serverRetries = 0;
    for (;;) {
      const headers: Record<string, string> = {};
      if (token !== null) headers.Authorization = `Bearer ${token}`;
      if (contentType) headers["Content-Type"] = contentType;
      const response = await fetchResponse(method, `${base}${method}`, { method: "POST", headers, body: body() });
      if (response.status === 429) {
        const retryAfterMs = retryAfter(response);
        await response.body?.cancel().catch(() => {});
        if (rateRetries++ >= maxRetries) throw new SlackApiError("ratelimited", { method, retryAfterMs });
        await sleep(retryAfterMs);
        continue;
      }
      if (response.status >= 500 && response.status <= 599) {
        await response.body?.cancel().catch(() => {});
        if (serverRetries++ >= 1) throw new SlackApiError("server_error", { method, status: response.status });
        await sleep(1000);
        continue;
      }
      let result: unknown;
      try {
        result = await response.json();
      } catch (error) {
        if (error instanceof SyntaxError) throw new SlackApiError("bad_response", { method });
        throw new SlackApiError("network", { method });
      }
      if (!result || typeof result !== "object" || !("ok" in result) || typeof result.ok !== "boolean") throw new SlackApiError("bad_response", { method });
      if (!result.ok) {
        const code = "error" in result && typeof result.error === "string" && result.error === result.error.trim() && /^[a-z][a-z0-9_]{0,63}$/.test(result.error) &&
          (token === null || !result.error.includes(token)) ? result.error : "bad_response";
        if (code === "ratelimited") {
          const retryAfterMs = retryAfter(response);
          if (rateRetries++ >= maxRetries) throw new SlackApiError(code, { method, retryAfterMs });
          await sleep(retryAfterMs);
          continue;
        }
        throw new SlackApiError(code, { method });
      }
      return result as T;
    }
  }

  return {
    base,
    testOrigin,
    call<T>(method: string, token: string | null, params: SlackParams = {}): Promise<T> {
      return post<T>(method, token, () => {
        const body = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
          if (value !== undefined) body.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
        }
        return body;
      }, "application/x-www-form-urlencoded; charset=utf-8");
    },
    upload<T>(method: string, token: string, fields: Record<string, string>, file: { field: string; name: string; mime: string; bytes: Uint8Array }): Promise<T> {
      return post<T>(method, token, () => {
        const body = new FormData();
        for (const [key, value] of Object.entries(fields)) body.set(key, value);
        body.set(file.field, new Blob([new Uint8Array(file.bytes)], { type: file.mime }), file.name);
        return body;
      });
    },
    async download(url, token, maxBytes) {
      const method = "download";
      if (!allowedFileUrl(url, testOrigin)) throw new SlackApiError("file_host", { method });
      const response = await fetchResponse(method, url, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
      const refuse = async (code: string): Promise<never> => {
        await response.body?.cancel().catch(() => {});
        throw new SlackApiError(code, { method });
      };
      if (response.status >= 300 && response.status < 400) return refuse("file_redirect");
      if (!response.ok) return refuse("file_status");
      if (Number(response.headers.get("content-length")) > maxBytes) return refuse("too_large");
      const chunks: Buffer[] = [];
      let size = 0;
      const reader = response.body?.getReader();
      if (reader) {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) {
              await reader.cancel().catch(() => {});
              throw new SlackApiError("too_large", { method });
            }
            chunks.push(Buffer.from(value));
          }
        } catch (error) {
          if (error instanceof SlackApiError) throw error;
          throw new SlackApiError("network", { method });
        } finally {
          reader.releaseLock();
        }
      }
      return { bytes: Buffer.concat(chunks, size), mime: response.headers.get("content-type")?.split(";")[0].trim() || "application/octet-stream" };
    },
    async putUpload(url, bytes, mime) {
      const method = "putUpload";
      if (!allowedFileUrl(url, testOrigin)) throw new SlackApiError("file_host", { method });
      const response = await fetchResponse(method, url, { method: "POST", headers: { "Content-Type": mime }, body: new Uint8Array(bytes) });
      await response.body?.cancel().catch(() => {});
      if (!response.ok) throw new SlackApiError("upload_status", { method, status: response.status });
    },
    queued<T>(key: string, fn: () => Promise<T>): Promise<T> {
      let startedAt = 0;
      const result = (queues.get(key) ?? Promise.resolve()).then(() => {
        startedAt = Date.now();
        return fn();
      });
      const tail = result.then(() => {}, () => {}).then(async () => {
        const remaining = minGapMs - (Date.now() - startedAt);
        if (remaining > 0) await sleep(remaining);
      });
      queues.set(key, tail);
      void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
      return result;
    },
  };
}
