import { describe, expect, it, vi } from "vitest";

import { modelProvider } from "../shared/model-providers.ts";
import { ModelCatalogStore } from "./model-catalog/catalog.ts";
import {
  CatalogIndex, addressProblem, buildConnection, catalogGroups, listProviderModels, moreProviders, probeLocalProviders, resolveProvider,
} from "./model-providers.ts";

const def = (id: string) => modelProvider(id)!;
const snapshot = () => new ModelCatalogStore({ dataDir: "/nonexistent", fetchDisabled: true, openCodeCachePath: null, log: () => {} }).get();

describe("the bundled catalog", () => {
  const catalog = snapshot();

  it("loads from the snapshot with models for the main providers", () => {
    expect(catalog.origin).toBe("snapshot");
    for (const id of ["anthropic", "openai", "google", "xai", "mistral", "deepseek", "alibaba", "moonshotai", "zai", "groq", "togetherai",
      "fireworks-ai", "cerebras", "openrouter", "cohere", "azure", "amazon-bedrock", "google-vertex"]) {
      expect(Object.keys(catalog.providers[id]?.models ?? {}).length, id).toBeGreaterThan(0);
    }
  });

  it("groups our providers first, then every other provider with an address", () => {
    const groups = catalogGroups(catalog, new Set(["anthropic"]));
    expect(groups[0]).toMatchObject({ providerId: "anthropic", connected: true });
    expect(groups.some((group) => group.providerId.startsWith("catalog:"))).toBe(true);
    expect(groups.find((group) => group.providerId === "openrouter")!.models.length).toBeGreaterThan(100);
    const more = moreProviders(catalog);
    expect(more.length).toBeGreaterThan(50);
    expect(more.every((entry) => entry.baseUrl.startsWith("https://"))).toBe(true);
    expect(more.some((entry) => entry.catalogId === "openrouter")).toBe(false);
  });

  it("carries context, price and capabilities for badges", () => {
    const index = new CatalogIndex(catalog);
    const facts = index.find(Object.keys(catalog.providers.anthropic!.models)[0]!, "anthropic")!;
    expect(facts.context).toBeGreaterThan(0);
    expect(facts.input).toBeGreaterThanOrEqual(0);
    expect(facts.tools).toBe(true);
    const routed = Object.keys(catalog.providers.openrouter!.models).find((id) => id.startsWith("anthropic/"))!;
    expect(index.find(routed)?.name).toBeTruthy();
  });

  it("resolves a catalog provider by id but never one on a local address", () => {
    const some = moreProviders(catalog)[0]!;
    expect(resolveProvider(some.id, catalog)?.baseUrl).toBe(some.baseUrl);
    expect(resolveProvider("catalog:lmstudio", catalog)).toBeUndefined();
    expect(resolveProvider("catalog:nope", catalog)).toBeUndefined();
  });
});

describe("addressProblem", () => {
  it("allows https anywhere and http only on this machine or its network", () => {
    expect(addressProblem("https://api.example.com/v1", "cloud")).toBeNull();
    expect(addressProblem("http://127.0.0.1:8317/v1", "computer")).toBeNull();
    expect(addressProblem("http://192.168.1.20:11434/v1", "server")).toBeNull();
    expect(addressProblem("http://api.example.com/v1", "computer")).toMatch(/https/);
  });

  it("keeps madani cloud off its own network and everyone off link-local metadata", () => {
    expect(addressProblem("http://127.0.0.1:8317/v1", "cloud")).toMatch(/madani cloud/);
    expect(addressProblem("https://10.0.0.5/v1", "cloud")).toMatch(/madani cloud/);
    expect(addressProblem("http://169.254.169.254/latest", "computer")).toBeTruthy();
    expect(addressProblem("https://user:pass@example.com/v1", "computer")).toBeTruthy();
  });
});

describe("buildConnection", () => {
  it("makes a key provider an OpenAI-compatible connection on its own address", () => {
    const built = buildConnection(def("groq"), { key: "gsk_test" }, "cloud");
    expect(built).toMatchObject({ entry: { driver: "openai-compat", access: "api", displayName: "Groq", config: { key: "gsk_test", url: "https://api.groq.com/openai/v1" } } });
    expect("instanceId" in built && built.instanceId).toMatch(/^openai-compat-/);
  });

  it("fills Azure's address from the resource and needs it", () => {
    expect(buildConnection(def("azure"), { key: "k" }, "computer")).toEqual({ error: "Enter the resource name." });
    expect(buildConnection(def("azure"), { key: "k", fields: { resource: "acme" }, models: ["gpt-4o-prod"] }, "computer"))
      .toMatchObject({ entry: { config: { url: "https://acme.openai.azure.com/openai/v1", managedModels: ["gpt-4o-prod"] } } });
  });

  it("needs no key for a local server, and refuses one on madani cloud", () => {
    expect(buildConnection(def("ollama"), {}, "computer")).toMatchObject({ entry: { access: "custom", config: { url: "http://127.0.0.1:11434/v1", key: "local" } } });
    expect(buildConnection(def("ollama"), {}, "cloud")).toHaveProperty("error");
    expect(buildConnection(def("groq"), {}, "computer")).toEqual({ error: "Paste your Groq key." });
  });

  it("presets CLIProxyAPI and lets its address be changed", () => {
    expect(buildConnection(def("cliproxyapi"), { key: "k" }, "computer")).toMatchObject({ entry: { config: { url: "http://127.0.0.1:8317/v1" } } });
    expect(buildConnection(def("cliproxyapi"), { key: "k", fields: { baseUrl: "http://127.0.0.1:9317/v1" } }, "server"))
      .toMatchObject({ entry: { config: { url: "http://127.0.0.1:9317/v1" } } });
  });

  it("makes a custom OpenAI-compatible endpoint with its model", () => {
    expect(buildConnection(def("custom-openai"), { key: "k", fields: { baseUrl: "https://llm.example.com/v1", model: "my-model" } }, "cloud"))
      .toMatchObject({ entry: { driver: "openai-compat", access: "custom", config: { url: "https://llm.example.com/v1", managedModels: ["my-model"] } } });
    expect(buildConnection(def("custom-openai"), { key: "k" }, "cloud")).toEqual({ error: "Enter the base URL." });
  });

  it("runs an Anthropic-compatible endpoint through Claude Code with its own address and key", () => {
    const built = buildConnection(def("custom-anthropic"), { key: "sk-test", fields: { baseUrl: "https://gw.example.com", model: "claude-x" } }, "computer");
    expect(built).toMatchObject({ entry: { driver: "claudeAgent", access: "api", config: { requireApiKey: true, managedModels: ["claude-x"] },
      environment: { ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_AUTH_TOKEN: "sk-test", ANTHROPIC_BASE_URL: "https://gw.example.com", ANTHROPIC_MODEL: "claude-x" } } });
    expect("instanceId" in built && built.instanceId).toMatch(/^claude-api-/);
    const official = buildConnection(def("anthropic"), { key: "sk-ant-x" }, "cloud");
    expect(official).toMatchObject({ entry: { driver: "claudeAgent", environment: { ANTHROPIC_API_KEY: "sk-ant-x" } } });
    expect("entry" in official && official.entry.environment).not.toHaveProperty("ANTHROPIC_BASE_URL");
  });

  it("refuses a key that is an address or holds spaces", () => {
    expect(buildConnection(def("groq"), { key: "https://api.groq.com" }, "computer")).toHaveProperty("error");
    expect(buildConnection(def("groq"), { key: "gsk_a b" }, "computer")).toHaveProperty("error");
  });
});

describe("listProviderModels", () => {
  const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

  it("reads an OpenAI-style list with the key as a bearer token", async () => {
    const fetch = answer(200, { data: [{ id: "a" }, { id: "b" }, { id: "a" }] });
    expect(await listProviderModels({ def: def("groq"), baseUrl: "https://api.groq.com/openai/v1", key: "k", fetch })).toEqual({ ok: true, models: ["a", "b"] });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.groq.com/openai/v1/models");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k");
    expect(init.redirect).toBe("error");
  });

  it("reads Anthropic's list with its own headers, and Gemini's model names", async () => {
    const fetch = answer(200, { data: [{ id: "claude-x" }] });
    await listProviderModels({ def: def("custom-anthropic"), baseUrl: "https://gw.example.com", key: "k", fetch });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://gw.example.com/v1/models?limit=1000");
    expect(init.headers).toMatchObject({ "x-api-key": "k", "anthropic-version": "2023-06-01" });
    expect(await listProviderModels({ def: def("google"), baseUrl: "https://g", key: "k", fetch: answer(200, { data: [{ id: "models/gemini-2.5-pro" }] }) }))
      .toEqual({ ok: true, models: ["gemini-2.5-pro"] });
  });

  it("tells a refused key from an unreachable server", async () => {
    expect(await listProviderModels({ def: def("groq"), baseUrl: "https://x", key: "bad", fetch: answer(401, {}) })).toEqual({ ok: false, reason: "rejected", status: 401 });
    const down = vi.fn(async () => { throw new TypeError("fetch failed"); });
    expect(await listProviderModels({ def: def("groq"), baseUrl: "https://x", key: "k", fetch: down })).toEqual({ ok: false, reason: "unreachable" });
  });
});

describe("probeLocalProviders", () => {
  it("finds the local servers that answer, a key refusal included, and probes nothing on madani cloud", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const text = String(url);
      if (text.includes(":11434")) return new Response("{}", { status: 200 });
      if (text.includes(":8317")) return new Response("{}", { status: 401 });
      throw new TypeError("connection refused");
    });
    expect([...await probeLocalProviders("computer", fetch as unknown as typeof globalThis.fetch)].sort()).toEqual(["cliproxyapi", "ollama"]);
    fetch.mockClear();
    expect(await probeLocalProviders("cloud", fetch as unknown as typeof globalThis.fetch)).toEqual(new Set());
    expect(fetch).not.toHaveBeenCalled();
  });
});
