// @vitest-environment happy-dom
// A cloud's own sign-in page shows the same Connect an AI grid as this computer (AiCards and its connect panel), never
// a cloud-only set of tiles and sign-in cards.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { BotEditorStore, initialState, type InstanceInfo, type useStore } from "@/state/store";

vi.mock("@/components/Avatar", () => ({ MausAvatar: () => null }));
import { CloudEngineSignIn, cloudOwnEngines } from "./CloudEngineSignIn";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const engine = (instanceId: string, driverKind: string, method: "paste-code" | "device-code", extra: Partial<InstanceInfo> = {}): InstanceInfo => ({
  instanceId, driverKind, displayName: driverKind === "codex" ? "Codex" : driverKind === "grokAgent" ? "Grok" : "Claude", access: "subscription",
  snapshot: { state: "available", authenticated: false }, models: { default: "", options: [] }, authentication: { method },
  ...extra,
} as InstanceInfo);
const claude = engine("claude", "claudeAgent", "paste-code");
const codex = engine("codex", "codex", "device-code");
const grok = engine("grok", "grokAgent", "device-code");

let host: HTMLDivElement;
let root: Root;
const dispatch = vi.fn();
function mount(instances: InstanceInfo[]) {
  const store = { state: { ...initialState, config: {}, instances }, dispatch, refreshInstances: vi.fn(async () => {}), refreshModels: vi.fn(async () => {}) } as unknown as ReturnType<typeof useStore>;
  act(() => root.render(createElement(BotEditorStore, { value: store, children: createElement(CloudEngineSignIn) })));
}

beforeEach(() => {
  setLocale("en");
  dispatch.mockReset();
  vi.stubGlobal("madaniDesktop", undefined);
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    if (String(path).includes("/auth/start")) return new Response(JSON.stringify({ auth: { phase: "waiting", flowId: "f", userCode: "RJ4K-WQ8M", authorizationUrl: "https://accounts.x.ai/device" } }));
    if (String(path).startsWith("/api/instances")) return new Response(JSON.stringify({ instances: [claude, codex, grok] }));
    return new Response("{}");
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("is the Connect an AI grid every machine shows, with no cloud-only tiles or sign-in cards", () => {
  mount([claude, codex, grok]);
  expect(host.querySelector("[data-cloud-sign-in] [data-ai-cards]")).not.toBeNull();
  for (const tile of ["chatgpt", "claude", "grok"]) expect(host.querySelector(`[data-funnel-ai="${tile}"]`)).not.toBeNull();
  expect(host.querySelector("[data-cloud-choice]")).toBeNull();
  expect(host.querySelector("[data-engine-setup], [data-device-sign-in], [data-claude-sign-in]")).toBeNull();
  expect(host.querySelector("[data-ai-more]")?.textContent).toBe("More providers or use an API key");
});

it("signs in with the same code step as this computer", async () => {
  mount([claude, codex, grok]);
  await act(async () => { host.querySelector<HTMLElement>('[data-funnel-ai="grok"]')!.click(); });
  await vi.waitFor(() => expect(host.querySelector('[data-connect-stage="waiting"]')).not.toBeNull());
  expect(host.querySelector('[data-sign-in="code"]')?.textContent).toBe("RJ4K-WQ8M");
  expect(host.querySelector("[data-connect-copy]")?.textContent).toBe("Copy code and open Grok");
  expect(host.textContent).toContain("Enter this code at accounts.x.ai/device");
});

it("checks only the cloud's own engines, never a local-model or read-only one", () => {
  const local = engine("claude-local", "claudeAgent", "paste-code", { access: "custom" });
  const company = engine("company.acme.anthropic", "claudeAgent", "paste-code", { readOnly: true });
  expect(cloudOwnEngines([local, company, claude])).toEqual([claude]);
});
