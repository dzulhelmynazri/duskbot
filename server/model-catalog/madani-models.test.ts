import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { ModelCatalog, ProviderDriver, ProviderInstance } from "../contracts.ts";
import { ProviderRegistry } from "../harness/registry.ts";
import { refreshStaleModelLists, STARTUP_MODEL_CACHE_FRESH_MS, writeStartupModelCache } from "../startup-model-catalog.ts";
import {
  curateModelCatalog,
  DUSK_MODELS_REFRESH_MS,
  DUSK_MODELS_URL,
  DUSK_MODELS_URL_ENV,
  DuskModelCatalog,
  parseDuskModels,
  prettyModelLabel,
  type CuratedEngine,
} from "./dusk-models.ts";

const CURATED: CuratedEngine = {
  models: [
    { id: "gpt-6.2-sol", label: "GPT-6.2 Sol", add: true },
    { id: "gpt-6.2-astra", label: "GPT-6.2 Astra", add: true },
    { id: "gpt-6.1-terra", label: "GPT-6.1 Terra" },
    { id: "gpt-6-astra", label: "GPT-6 Astra", contextWindow: 400_000 },
    { id: "gpt-6-sol", label: "GPT-6 Sol" },
  ],
};

const doc = (updatedAt: string, engines: Record<string, CuratedEngine> = { codex: CURATED }) => ({ schema: 1, updatedAt, engines });

describe("prettyModelLabel", () => {
  it.each([
    ["GPT-6.2-Astra", "gpt-6.2-astra", "GPT-6.2 Astra"],
    ["gpt-6.2-astra", "gpt-6.2-astra", "GPT-6.2 Astra"],
    ["", "gpt-5.3-codex-spark", "GPT-5.3 Codex Spark"],
    ["claude-opus-5-5", "claude-opus-5-5", "Claude Opus 5.5"],
    ["grok-4-fast", "grok-4-fast", "Grok 4 Fast"],
    ["GPT-6.1 Terra", "gpt-6.1-terra", "GPT-6.1 Terra"],
    ["gpt-oss-120b", "gpt-oss-120b", "GPT OSS 120b"],
    ["claude-haiku-4-5-20251001", "claude-haiku-4-5-20251001", "Claude Haiku 4.5 20251001"],
  ])("%s (%s) reads %s", (label, id, expected) => {
    expect(prettyModelLabel(label, id)).toBe(expected);
  });
});

describe("curateModelCatalog", () => {
  const live: ModelCatalog = {
    default: "gpt-6-sol",
    options: [
      { id: "gpt-6.1-terra", label: "GPT-6.1 Terra" },
      { id: "gpt-6-astra", label: "GPT-6-Astra" },
      { id: "gpt-6-sol", label: "GPT-6-Sol" },
      { id: "gpt-7-nova", label: "GPT-7-Nova" },
      { id: "omlx::qwen", label: "qwen (omlx)", custom: true },
    ],
  };

  it("names the engine's rows ours, keeps its order and default, and places missing additions before the next curated row", () => {
    expect(curateModelCatalog(live, CURATED)).toEqual({
      default: "gpt-6-sol",
      options: [
        { id: "gpt-6.2-sol", label: "GPT-6.2 Sol" },
        { id: "gpt-6.2-astra", label: "GPT-6.2 Astra" },
        { id: "gpt-6.1-terra", label: "GPT-6.1 Terra" },
        { id: "gpt-6-astra", label: "GPT-6 Astra", contextWindow: 400_000 },
        { id: "gpt-6-sol", label: "GPT-6 Sol" },
        { id: "gpt-7-nova", label: "GPT-7 Nova" },
        { id: "omlx::qwen", label: "qwen (omlx)", custom: true },
      ],
    });
  });

  it("adds nothing the engine already lists, and only rows marked add", () => {
    const listed: ModelCatalog = { default: "gpt-6.2-astra", options: [{ id: "gpt-6.2-astra", label: "GPT-6.2-Astra", contextWindow: 1 }] };
    expect(curateModelCatalog(listed, CURATED)).toEqual({
      default: "gpt-6.2-astra",
      options: [{ id: "gpt-6.2-sol", label: "GPT-6.2 Sol" }, { id: "gpt-6.2-astra", label: "GPT-6.2 Astra", contextWindow: 1 }],
    });
  });

  it("puts additions with no later curated row before the custom rows", () => {
    const out = curateModelCatalog({ default: "x", options: [{ id: "x", label: "x" }, { id: "p::y", label: "y", custom: true }] }, { models: [{ id: "new", label: "New", add: true }] });
    expect(out.options.map((option) => option.id)).toEqual(["x", "new", "p::y"]);
  });

  it("falls back to the curated default when the engine's is not listed, and leaves a list without a curated engine alone", () => {
    expect(curateModelCatalog({ default: "", options: [] }, { default: "a", models: [{ id: "a", label: "A", add: true }] })).toEqual({ default: "a", options: [{ id: "a", label: "A" }] });
    expect(curateModelCatalog(live, undefined)).toBe(live);
  });
});

describe("parseDuskModels", () => {
  it("rejects documents that are not a catalog and drops bad rows", () => {
    expect(parseDuskModels(null)).toBeNull();
    expect(parseDuskModels({ schema: 2, updatedAt: "2026-11-18T00:00:00Z", engines: {} })).toBeNull();
    expect(parseDuskModels({ schema: 1, updatedAt: "not a date", engines: {} })).toBeNull();
    const parsed = parseDuskModels({
      schema: 1,
      updatedAt: "2026-11-18T00:00:00Z",
      engines: {
        codex: { default: "missing", models: [
          { id: "ok", label: " OK ", add: true, contextWindow: 10 },
          { id: "ok", label: "dupe" },
          { id: "bad id with spaces", label: "x" },
          { id: "ctl", label: "a\u0007b" },
          { id: "cw", label: "CW", contextWindow: -1, add: "yes" },
        ] },
        "Bad Key": { models: [] },
      },
    });
    expect(parsed).toEqual({ schema: 1, updatedAt: "2026-11-18T00:00:00.000Z", engines: { codex: { models: [{ id: "ok", label: "OK", add: true, contextWindow: 10 }, { id: "cw", label: "CW" }] } } });
  });

  it("the bundled copy parses, lists GPT-6.2 Astra for Codex, and matches the file dusk.bot serves", () => {
    const bundled = readFileSync(join(import.meta.dirname, "dusk-models.json"), "utf8");
    const site = readFileSync(join(import.meta.dirname, "..", "..", "apps", "site", "public", "landing", "releases", "models.json"), "utf8");
    expect(site).toBe(bundled);
    const parsed = parseDuskModels(JSON.parse(bundled))!;
    expect(parsed.engines.codex!.models).toContainEqual({ id: "gpt-6.2-astra", label: "GPT-6.2 Astra", add: true });
    for (const key of ["codex", "claude", "grok"]) expect(parsed.engines[key]!.models.length).toBeGreaterThan(0);
  });
  it("the bundled copy offers Claude Fable 5.2 on a Claude Code list that predates it, ahead of Fable 5.1", () => {
    const parsed = parseDuskModels(JSON.parse(readFileSync(join(import.meta.dirname, "dusk-models.json"), "utf8")))!;
    const older = { default: "claude-sonnet-5", options: [{ id: "claude-fable-5-1", label: "Claude Fable 5.1" }, { id: "claude-sonnet-5", label: "Claude Sonnet 5" }] };
    expect(curateModelCatalog(older, parsed.engines.claude).options.slice(0, 2)).toEqual([
      { id: "claude-fable-5-2", label: "Claude Fable 5.2", contextWindow: 1_000_000 },
      { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
    ]);
  });
});

describe("DuskModelCatalog", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const respond = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, ...init });

  function store(options: { fetch?: typeof fetch; bundled?: unknown; env?: NodeJS.ProcessEnv; now?: () => number } = {}) {
    return new DuskModelCatalog({ dataDir: dir, bundled: doc("2026-11-01T00:00:00Z"), env: {}, log: () => {}, ...options });
  }
  const fresh = () => { dir = mkdtempSync(join(tmpdir(), "dusk-models-")); };

  it("uses the bundled copy offline, and a newer fetched one after it is cached", async () => {
    fresh();
    const calls: string[] = [];
    const remote = doc("2026-11-18T00:00:00Z", { codex: { models: [{ id: "gpt-9", label: "GPT-9", add: true }] } });
    const a = store({ fetch: (async (url: string) => { calls.push(url); return respond(remote); }) as typeof fetch });
    expect(a.get().updatedAt).toBe("2026-11-01T00:00:00.000Z");
    expect(await a.refresh()).toBe("updated");
    expect(calls).toEqual([DUSK_MODELS_URL]);
    expect(a.get().engines.codex!.models[0]!.id).toBe("gpt-9");
    // a restart reads the cache, not the network
    const b = store({ fetch: (async () => { throw new Error("offline"); }) as typeof fetch });
    expect(b.get().engines.codex!.models[0]!.id).toBe("gpt-9");
  });

  it("keeps a newer bundled copy over an older fetched one", async () => {
    fresh();
    const a = store({ bundled: doc("2026-12-01T00:00:00Z"), fetch: (async () => respond(doc("2026-11-18T00:00:00Z", {}))) as typeof fetch });
    expect(await a.refresh()).toBe("unchanged");
    expect(a.get().updatedAt).toBe("2026-12-01T00:00:00.000Z");
  });

  it("skips a fetch within a few hours of the last, and fetches again after", async () => {
    fresh();
    let now = Date.parse("2026-11-18T00:00:00Z");
    let calls = 0;
    const a = store({ now: () => now, fetch: (async () => { calls += 1; return respond(doc("2026-11-18T00:00:00Z")); }) as typeof fetch });
    await a.refresh();
    now += DUSK_MODELS_REFRESH_MS - 1;
    expect(await a.refresh()).toBe("fresh");
    now += 2;
    expect(await a.refresh()).not.toBe("fresh");
    expect(calls).toBe(2);
  });

  it("keeps the current list when the fetch fails, is malformed, too large, or turned off", async () => {
    fresh();
    for (const fetchImpl of [
      async () => { throw new Error("offline"); },
      async () => respond("not json"),
      async () => respond({ schema: 1 }),
      async () => respond("x", { status: 500 }),
      async () => respond("{}", { headers: { "content-length": String(10 * 1024 * 1024) } }),
      async () => respond(" ".repeat(300 * 1024)),
    ]) {
      const a = store({ fetch: fetchImpl as typeof fetch });
      expect(await a.refresh({ force: true })).toBe("failed");
      expect(a.get().updatedAt).toBe("2026-11-01T00:00:00.000Z");
    }
    let called = false;
    const off = store({ env: { DUSK_DISABLE_MODEL_CATALOG_FETCH: "1" }, fetch: (async () => { called = true; return respond(doc("2026-11-18T00:00:00Z")); }) as typeof fetch });
    expect(await off.refresh()).toBe("disabled");
    expect(called).toBe(false);
  });

  it("asks only https addresses, or http on this machine, and never follows a redirect", async () => {
    fresh();
    expect(store({ env: { [DUSK_MODELS_URL_ENV]: "http://evil.example/models.json" } }).url).toBeNull();
    expect(store({ env: { [DUSK_MODELS_URL_ENV]: "http://127.0.0.1:4000/models.json" } }).url).toBe("http://127.0.0.1:4000/models.json");
    let init: RequestInit | undefined;
    await store({ fetch: (async (_url: string, given: RequestInit) => { init = given; return respond(doc("2026-11-18T00:00:00Z")); }) as typeof fetch }).refresh();
    expect(init?.redirect).toBe("error");
  });

  it("curates through the newest document and hands back the same object for the same list", () => {
    fresh();
    const a = store();
    const live: ModelCatalog = { default: "gpt-6-sol", options: [{ id: "gpt-6-sol", label: "GPT-6-Sol" }] };
    const first = a.curate("codex", live);
    expect(first.options.map((option) => option.id)).toEqual(["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6-sol"]);
    expect(a.curate("codex", live)).toBe(first);
    expect(a.curate("grok", live)).toBe(live);
  });
});

describe("the registry and stale engine lists", () => {
  afterEach(() => rmSync(join(DATA_DIR, "providers", "engine-models"), { recursive: true, force: true }));

  function fakeDriver(kind: string, key: string | undefined, models: () => ModelCatalog, refreshModels?: () => Promise<void>): ProviderDriver<Record<string, unknown>> {
    return {
      driverKind: kind,
      metadata: { displayName: kind },
      models: models(),
      decodeConfig: (raw) => (raw ?? {}) as Record<string, unknown>,
      defaultConfig: () => ({}),
      async create(input): Promise<ProviderInstance> {
        return {
          instanceId: input.instanceId,
          driverKind: kind,
          displayName: input.displayName,
          enabled: input.enabled,
          get models() { return models(); },
          ...(key ? { modelCatalogKey: key } : {}),
          ...(refreshModels ? { refreshModels } : {}),
          snapshot: async () => ({ state: "available", version: "0" }),
          adapter: {
            provider: kind,
            capabilities: { sessionModelSwitch: "unsupported" },
            sendTurn: async () => ({ turnId: "t" }),
            interruptTurn: async () => {},
            respondToRequest: async () => "unavailable" as const,
            readThread: async () => ({ threadId: "x", turns: [] }),
            rollbackThread: async () => ({ threadId: "x", turns: [] }),
            stopSession: async () => {},
            listSessions: async () => [],
            hasSession: async () => false,
            stopAll: async () => {},
            streamEvents: () => () => {},
          },
          dispose: async () => {},
        } as unknown as ProviderInstance;
      },
    };
  }

  it("reads an engine's models through the catalog only when the engine names its catalog key, and follows later lists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dusk-models-reg-"));
    try {
      const catalog = new DuskModelCatalog({ dataDir: dir, bundled: doc("2026-11-18T00:00:00Z"), env: {}, log: () => {} });
      let list: ModelCatalog = { default: "gpt-6-sol", options: [{ id: "gpt-6-sol", label: "GPT-6-Sol" }] };
      const registry = new ProviderRegistry([
        fakeDriver("curated", "codex", () => list),
        fakeDriver("plain", undefined, () => list),
      ], { modelCatalog: catalog, npmAvailable: () => false });
      await registry.load({ a: { driver: "curated" }, b: { driver: "plain" } });
      expect(registry.get("a")!.models.options.map((option) => option.label)).toEqual(["GPT-6.2 Sol", "GPT-6.2 Astra", "GPT-6 Sol"]);
      expect(registry.get("b")!.models).toBe(list);
      list = { default: "gpt-6.2-astra", options: [{ id: "gpt-6.2-astra", label: "GPT-6.2-Astra" }] };
      expect(registry.get("a")!.models.default).toBe("gpt-6.2-astra");
      expect(registry.get("a")!.models.options.map((option) => option.id)).toEqual(["gpt-6.2-sol", "gpt-6.2-astra"]);
      await registry.disposeAll();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads again only the lists last read over the freshness window ago", async () => {
    const now = Date.now();
    const list: ModelCatalog = { default: "a", options: [{ id: "a", label: "A" }] };
    writeStartupModelCache("stale-list", list, { checkedAt: now - STARTUP_MODEL_CACHE_FRESH_MS - 1 });
    writeStartupModelCache("fresh-list", list, { checkedAt: now - 1000 });
    const refreshed: string[] = [];
    const instance = (instanceId: string) => ({ instanceId, refreshModels: async () => { refreshed.push(instanceId); if (instanceId === "never-read") throw new Error("cli failed"); } });
    await refreshStaleModelLists([instance("stale-list"), instance("fresh-list"), instance("never-read"), { instanceId: "no-refresh" }, instance("after-a-failure")], now);
    expect(refreshed).toEqual(["stale-list", "never-read", "after-a-failure"]);
  });
});
