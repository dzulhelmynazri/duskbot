import { describe, expect, it } from "vitest";

import {
  MODEL_PROVIDERS, connectedProviders, modelProvider, placeFromEnv, providerBaseUrl, providerOfInstance, providerOffer,
} from "./model-providers.ts";

const def = (id: string) => modelProvider(id)!;
const ready = { state: "available", authenticated: true };

describe("the provider table", () => {
  it("covers every provider the owner asked for, each with a unique id", () => {
    const ids = MODEL_PROVIDERS.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ["anthropic", "openai", "google", "xai", "mistral", "deepseek", "qwen", "moonshot", "zhipu", "groq", "together", "fireworks",
      "cerebras", "openrouter", "perplexity", "cohere", "azure", "bedrock", "vertex", "ollama", "lmstudio", "llamacpp", "vllm", "cliproxyapi",
      "custom-openai", "custom-anthropic"]) expect(ids).toContain(id);
  });

  it("keeps the subscription sign-ins on their engines", () => {
    expect(def("anthropic").signIn?.driverKinds).toContain("claudeAgent");
    expect(def("openai").signIn?.driverKinds).toContain("codex");
    expect(def("google").signIn?.driverKinds).toContain("geminiAgent");
    expect(def("xai").signIn?.driverKinds).toContain("grokAgent");
  });

  it("gives every non-custom provider a base URL, https unless it runs locally", () => {
    for (const provider of MODEL_PROVIDERS.filter((entry) => entry.section !== "custom")) {
      expect(provider.baseUrl, provider.id).toMatch(provider.local ? /^http:\/\/127\.0\.0\.1:\d+\/v1$/ : /^https:\/\//);
    }
  });
});

describe("providerBaseUrl", () => {
  it("fills Azure, Bedrock and Vertex addresses from their fields", () => {
    expect(providerBaseUrl(def("azure"), { resource: "acme-ai" })).toBe("https://acme-ai.openai.azure.com/openai/v1");
    expect(providerBaseUrl(def("bedrock"), { region: "eu-west-1" })).toBe("https://bedrock-runtime.eu-west-1.amazonaws.com/openai/v1");
    expect(providerBaseUrl(def("vertex"), { project: "my-proj", location: "global" }))
      .toBe("https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global/endpoints/openapi");
  });

  it("refuses a missing field or one that would change the host or path", () => {
    expect(providerBaseUrl(def("azure"), {})).toBeNull();
    expect(providerBaseUrl(def("azure"), { resource: "evil.com/x" })).toBeNull();
    expect(providerBaseUrl(def("bedrock"), { region: "us-east-1@evil" })).toBeNull();
  });

  it("uses a typed base URL over the preset and needs one for a custom endpoint", () => {
    expect(providerBaseUrl(def("cliproxyapi"))).toBe("http://127.0.0.1:8317/v1");
    expect(providerBaseUrl(def("cliproxyapi"), { baseUrl: "http://127.0.0.1:9000/v1/" })).toBe("http://127.0.0.1:9000/v1");
    expect(providerBaseUrl(def("custom-openai"))).toBeNull();
  });
});

describe("where a connection lives", () => {
  it("reads the place from the server's environment", () => {
    expect(placeFromEnv({ MADANI_DESKTOP_PARENT: "1" })).toBe("computer");
    expect(placeFromEnv({ MADANI_DEV_OWN_SERVER: "1" })).toBe("computer");
    expect(placeFromEnv({ MADANI_CLOUD_ROLE: "home", MADANI_DESKTOP_PARENT: "1" })).toBe("cloud");
    expect(placeFromEnv({ MADANI_CLOUD_ROLE: "team" })).toBe("cloud");
    expect(placeFromEnv({})).toBe("server");
  });

  it("never offers a local model on madani cloud", () => {
    expect(providerOffer(def("ollama"), "cloud", new Set(["ollama"]))).toEqual({ offered: false, reason: "cloud" });
    expect(providerOffer(def("cliproxyapi"), "cloud", new Set())).toEqual({ offered: false, reason: "cloud" });
  });

  it("offers a local model on a computer, marked when it isn't running", () => {
    expect(providerOffer(def("ollama"), "computer", new Set(["ollama"]))).toEqual({ offered: true });
    expect(providerOffer(def("lmstudio"), "computer", new Set())).toEqual({ offered: true, reason: "not-running" });
  });

  it("offers a local model on your own server only when that server runs it", () => {
    expect(providerOffer(def("ollama"), "server", new Set(["ollama"]))).toEqual({ offered: true });
    expect(providerOffer(def("vllm"), "server", new Set(["ollama"]))).toEqual({ offered: false, reason: "not-running" });
  });

  it("offers every hosted provider everywhere", () => {
    for (const place of ["computer", "cloud", "server"] as const) expect(providerOffer(def("openrouter"), place, new Set()).offered).toBe(true);
  });
});

describe("connected providers", () => {
  it("matches sign-ins, the app's own key instances and added connections by host", () => {
    expect(providerOfInstance({ instanceId: "claude", driverKind: "claudeAgent" })?.id).toBe("anthropic");
    expect(providerOfInstance({ instanceId: "chatgpt", driverKind: "codex" })?.id).toBe("openai");
    expect(providerOfInstance({ instanceId: "openrouter", driverKind: "openai-compat" })?.id).toBe("openrouter");
    expect(providerOfInstance({ instanceId: "openai-compat-1", driverKind: "openai-compat", url: "https://api.groq.com/openai/v1" })?.id).toBe("groq");
    expect(providerOfInstance({ instanceId: "openai-compat-2", driverKind: "openai-compat", url: "https://acme.openai.azure.com/openai/v1" })?.id).toBe("azure");
    expect(providerOfInstance({ instanceId: "openai-compat-3", driverKind: "openai-compat", url: "http://127.0.0.1:8317/v1" })?.id).toBe("cliproxyapi");
    expect(providerOfInstance({ instanceId: "openai-compat-4", driverKind: "openai-compat", url: "https://api.groq.com.evil.test/v1" })).toBeUndefined();
  });

  it("counts only ready instances and never OpenCode's free backup", () => {
    const connected = connectedProviders([
      { instanceId: "claude", driverKind: "claudeAgent", snapshot: ready },
      { instanceId: "chatgpt", driverKind: "codex", snapshot: { state: "available", authenticated: false } },
      { instanceId: "groq", driverKind: "groq", snapshot: ready, enabled: false },
      { instanceId: "kimi", driverKind: "kimiAgent", snapshot: { state: "unavailable" } },
      { instanceId: "openai-compat-x", driverKind: "openai-compat", url: "http://127.0.0.1:11434/v1", access: "custom", snapshot: { state: "available", authenticated: false } },
      { instanceId: "opencodeGo", driverKind: "opencodeGo", snapshot: { ...ready, freeFallback: true } },
    ]);
    expect([...connected.keys()].sort()).toEqual(["anthropic", "ollama"]);
  });
});
