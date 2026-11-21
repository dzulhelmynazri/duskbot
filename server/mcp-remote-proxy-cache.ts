import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import type { RemoteMcpSpec } from "./contracts.ts";
import { McpRpcError } from "./mcp-http.ts";

type Json = Record<string, unknown>;
type Metadata = { initialize: Json; pages: Record<string, Json> };
const record = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const cursorKey = (params: unknown) => JSON.stringify(record(params) ? params.cursor ?? null : null);
const nextCursor = (page: Json) => page.nextCursor === undefined || page.nextCursor === null || page.nextCursor === "" ? undefined : page.nextCursor;
export const REMOTE_MCP_CACHE_ENV = "MADANI_REMOTE_MCP_CACHE_DIR";
export const REMOTE_MCP_CACHE_ID_ENV = "MADANI_REMOTE_MCP_CACHE_ID";
export const remoteMcpCacheIdentity = Symbol.for("madanibot.remoteMcpCacheIdentity");

export function remoteMcpCacheDirectory(directory: string | undefined, home: string): string | undefined {
  if (!directory || basename(directory) !== "remote-mcp-cache") return directory;
  const child = relative(dirname(directory), home);
  return child === "engine-home" || dirname(child) === "engine-homes" ? join(home, "remote-mcp-cache") : directory;
}

export function remoteMcpCacheKey(spec: RemoteMcpSpec, handshake: object): string {
  const headers = Object.entries(spec.headers).map(([key, value]) => [key.toLowerCase(), value]).sort(([a], [b]) => a!.localeCompare(b!));
  return createHash("sha256").update(JSON.stringify([1, spec.type, spec.url, headers, handshake])).digest("hex");
}

function complete(value: unknown): value is Metadata {
  if (!record(value) || !record(value.initialize) || typeof value.initialize.protocolVersion !== "string" || !record(value.pages)) return false;
  const seen = new Set<string>();
  let key = "null";
  while (!seen.has(key) && seen.size < 100) {
    seen.add(key);
    const page = value.pages[key];
    if (!record(page) || !Array.isArray(page.tools)) return false;
    const next = nextCursor(page);
    if (next === undefined) return true;
    if (typeof next !== "string") return false;
    key = JSON.stringify(next);
  }
  return false;
}

function unknownTool(value: unknown): boolean {
  const text = value instanceof McpRpcError ? value.detail
    : record(value) && value.isError === true ? JSON.stringify(value.content) : "";
  return typeof text === "string" && /unknown[ _-]*tool|tool[^\n]{0,120}(?:not found|does not exist|not exist|unknown)|no such tool/i.test(text);
}

export class RemoteMcpMetadataCache {
  private saved?: Metadata;
  private liveInitialize?: Promise<unknown>;
  private initializeResult?: Json;
  private pages: Record<string, Json> = {};
  private refreshing?: Promise<void>;
  private generation = 0;
  private readonly file?: string;
  private readonly directory?: string;
  private readonly initializeUpstream: (signal: AbortSignal) => Promise<unknown>;
  private readonly requestUpstream: (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>;
  private readonly closed: AbortSignal;
  private readonly changed: () => void;

  constructor(options: {
    directory?: string; identity?: string; spec: RemoteMcpSpec; handshake: object; closed: AbortSignal;
    initialize: (signal: AbortSignal) => Promise<unknown>;
    request: (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>;
    changed: () => void;
  }) {
    this.directory = options.directory;
    this.file = options.directory ? join(options.directory, `${options.identity ? createHash("sha256").update(JSON.stringify([options.identity, options.handshake])).digest("hex") : remoteMcpCacheKey(options.spec, options.handshake)}.json`) : undefined;
    this.initializeUpstream = options.initialize;
    this.requestUpstream = options.request;
    this.closed = options.closed;
    this.changed = options.changed;
    if (this.file) try {
      const value: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (complete(value)) this.saved = value;
    } catch {}
  }

  invalidate(): void {
    this.generation += 1;
    this.saved = undefined;
    this.pages = {};
    if (this.file) try { unlinkSync(this.file); } catch {}
    this.changed();
  }

  private live(): Promise<unknown> {
    if (!this.liveInitialize) {
      const pending = this.initializeUpstream(AbortSignal.any([this.closed, AbortSignal.timeout(30_000)]));
      this.liveInitialize = pending;
      void pending.then((value) => { if (record(value)) this.initializeResult = value; }, () => {
        if (this.liveInitialize === pending) this.liveInitialize = undefined;
      });
    }
    return this.liveInitialize;
  }

  private save(value: Metadata): void {
    this.saved = value;
    if (this.file && this.directory) try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      writeFileAtomic(this.file, JSON.stringify(value), { mode: 0o600, durable: false });
    } catch {}
  }

  private refresh(): void {
    if (this.refreshing) return;
    const generation = this.generation;
    const work = (async () => {
      const initialize = await this.live();
      if (!record(initialize)) return;
      const pages: Record<string, Json> = {};
      const signal = AbortSignal.any([this.closed, AbortSignal.timeout(120_000)]);
      let cursor: string | undefined;
      for (let count = 0; count < 100; count += 1) {
        const params = cursor === undefined ? {} : { cursor };
        const key = cursorKey(params);
        if (Object.hasOwn(pages, key)) return;
        const page = await this.requestUpstream("tools/list", params, signal);
        if (!record(page) || !Array.isArray(page.tools)) return;
        pages[key] = page;
        const next = nextCursor(page);
        if (next === undefined) {
          if (generation === this.generation && !this.closed.aborted) { this.save({ initialize, pages }); this.changed(); }
          return;
        }
        if (typeof next !== "string") return;
        cursor = next;
      }
    })();
    this.refreshing = work;
    void work.catch(() => {}).finally(() => { if (this.refreshing === work) this.refreshing = undefined; });
  }

  async request(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    if (method === "initialize" && this.saved) { this.refresh(); return this.saved.initialize; }
    if (method === "tools/list" && this.saved && Object.hasOwn(this.saved.pages, cursorKey(params))) {
      return this.saved.pages[cursorKey(params)];
    }
    const live = this.live();
    const initialize = await new Promise<unknown>((resolve, reject) => {
      const abort = () => reject(new Error("aborted"));
      signal.addEventListener("abort", abort, { once: true });
      void live.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
      if (signal.aborted) abort();
    });
    if (signal.aborted) throw new Error("aborted");
    if (method === "initialize") return initialize;
    const generation = this.generation;
    try {
      const result = await this.requestUpstream(method, params, signal);
      if (method === "tools/list" && record(result) && Array.isArray(result.tools) && generation === this.generation) {
        this.pages[cursorKey(params)] = result;
        const value = { initialize: this.initializeResult, pages: this.pages };
        if (complete(value)) this.save(value);
      }
      if (method === "tools/call" && unknownTool(result)) this.invalidate();
      return result;
    } catch (error) {
      if (method === "tools/call" && unknownTool(error)) this.invalidate();
      throw error;
    }
  }
}
