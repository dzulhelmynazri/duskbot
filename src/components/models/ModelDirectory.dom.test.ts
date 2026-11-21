// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  useStore: () => ({ state: { instances: [] }, dispatch: vi.fn(), refreshInstances: vi.fn() }),
}));

const { ModelDirectory } = await import("./ModelDirectory");

const provider = (id: string, label: string, section: string, extra: Record<string, unknown> = {}) =>
  ({ id, label, section, wire: "openai", baseUrl: "", listModels: "openai", offered: true, modelCount: 3, connected: [], ...extra });
const answer = (place: "computer" | "cloud") => ({
  place, catalog: { origin: "snapshot", updatedAt: "2026-11-01T00:00:00Z", providers: 220, models: 4000 },
  providers: [
    provider("anthropic", "Anthropic", "major", { connected: ["claude"] }),
    provider("groq", "Groq", "fast"),
    place === "cloud" ? provider("ollama", "Ollama", "local", { offered: false, reason: "cloud" }) : provider("ollama", "Ollama", "local", { reason: "not-running" }),
    provider("cliproxyapi", "CLIProxyAPI", "local"),
  ].filter((entry) => place === "computer" || entry.id !== "cliproxyapi"),
  more: [{ id: "catalog:venice", label: "Venice", modelCount: 9 }],
});

let host: HTMLDivElement;
let root: Root;
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const serve = (place: "computer" | "cloud") => vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(String(url).includes("/search")
  ? { hits: [{ group: { providerId: "groq", label: "Groq", connected: false }, models: [{ id: "llama-3.3-70b", name: "Llama 3.3 70B", tools: true, vision: false }], total: 3 }] }
  : answer(place))));

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("Settings > Models", () => {
  it("lists providers by section with their state and says where connections are saved", async () => {
    serve("computer");
    flushSync(() => root.render(createElement(ModelDirectory)));
    await settle();
    expect(host.querySelector("[data-model-directory-place]")?.textContent).toContain("Saved on this computer");
    expect(host.querySelector('[data-provider-row="anthropic"]')?.textContent).toContain("Connected");
    expect(host.querySelector('[data-provider-row="ollama"]')?.textContent).toContain("Not running");
    expect(host.querySelector('[data-provider-section="local"]')?.textContent).toContain("CLIProxyAPI");
    expect(host.textContent).toContain("Show 1 more providers");
  });

  it("on madani cloud leaves local models out and says why", async () => {
    serve("cloud");
    flushSync(() => root.render(createElement(ModelDirectory)));
    await settle();
    expect(host.querySelector('[data-provider-row="ollama"]')).toBeNull();
    expect(host.textContent).toContain("aren't offered on madani cloud");
    expect(host.querySelector("[data-model-directory-place]")?.textContent).toContain("madani cloud");
  });

  it("searches every model, grouped by provider with badges and a connect button", async () => {
    serve("computer");
    flushSync(() => root.render(createElement(ModelDirectory)));
    await settle();
    const input = host.querySelector<HTMLInputElement>("[data-model-directory-search]")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "llama");
    flushSync(() => input.dispatchEvent(new Event("input", { bubbles: true })));
    await new Promise((resolve) => setTimeout(resolve, 250));
    await settle();
    const results = host.querySelector("[data-model-directory-results]")!;
    expect(results.textContent).toContain("Llama 3.3 70B");
    expect(results.querySelector('[data-badge="tools"]')).not.toBeNull();
    expect(results.textContent).toContain("2 more matches");
    flushSync(() => results.querySelector<HTMLButtonElement>('[data-connect-provider="groq"]')!.click());
    await settle();
    expect(document.querySelector('[data-panel-modal="connect-provider"]')?.textContent).toContain("Connect Groq");
  });
});
