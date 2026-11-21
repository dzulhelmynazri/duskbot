// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedDesktopBridge } from "../../../electron/managed-desktop.mjs";
import { setLocale } from "@/lib/i18n";
import type { InstanceInfo } from "@/state/store";

const f = vi.hoisted(() => ({
  instances: [] as InstanceInfo[], dispatch: vi.fn(), row: null as null | { bridge: unknown; onOpenSettings: () => void },
  check: (): Promise<object> => Promise.resolve({ ok: true }), checks: [] as string[], fail: false,
}));
vi.mock("@/state/store", () => ({
  api: async (path: string) => {
    if (f.fail) { f.fail = false; throw new Error("503"); }
    if (!path.endsWith("/check")) return { instances: f.instances };
    f.checks.push(path);
    return f.check();
  },
  useStore: () => ({ state: { instances: f.instances }, dispatch: f.dispatch }),
}));
vi.mock("@/components/EngineSetup", async () => {
  const { createElement: h } = await import("react");
  return { EngineSetup: ({ instance, intent, description }: { instance: InstanceInfo; intent: string; description?: string }) =>
    h("div", { "data-engine-setup": instance.instanceId, "data-intent": intent, "data-description": description }) };
});
vi.mock("@/components/models/ModelDirectory", async () => {
  const { createElement: h } = await import("react");
  return { ModelDirectory: () => h("div", { "data-model-directory-stub": "" }) };
});
// The row has its own tests; here only whether the first screen offers it.
vi.mock("./beats/OrganisationRow", () => ({ OrganisationRow: (props: NonNullable<typeof f.row>) => { f.row = props; return null; } }));
const { ConnectAi, ConnectAiDialog, DIALOG_LEAVE_MS } = await import("./ConnectAi");
const { useWelcomeAi } = await import("./welcome-ai");
const { useStore } = await import("@/state/store");

/** As the first screen has it: the AI it stands on, tested once, handed to the block. */
function FirstScreenAi() {
  const { state } = useStore();
  return createElement(ConnectAi, { tested: useWelcomeAi(state.instances), onMore: () => {} });
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const engine = (instanceId: string, driverKind: string, displayName: string, ready: boolean): InstanceInfo => ({
  instanceId, driverKind, displayName, install: { docsUrl: "https://example.test" },
  snapshot: { state: ready ? "available" : "unavailable", authenticated: ready }, models: { default: "m", options: [] },
});
const bridge = { onState: vi.fn(), state: vi.fn() } as unknown as ManagedDesktopBridge;
let host: HTMLDivElement, root: Root;
const text = () => document.body.textContent ?? "";
const show = async () => {
  await act(async () => { root.render(createElement(FirstScreenAi)); });
};
const otherWays = async () => {
  await act(async () => {});
};
/** The AIs shown as cards, in their order. */
const cards = () => [...document.body.querySelectorAll<HTMLElement>("[data-funnel-ai]")].map((card) => card.dataset.funnelAi);
const press = async (selector: string) => {
  const target = document.body.querySelector<HTMLElement>(selector)!;
  await act(async () => { target.click(); });
};

beforeEach(() => {
  setLocale("en");
  f.check = () => Promise.resolve({ ok: true });
  f.checks = [];
  f.instances = [engine("grok", "grokAgent", "Grok", false), engine("claude", "claudeAgent", "Claude", false), engine("codex", "codex", "Codex", false)];
  f.dispatch.mockReset();
  f.row = null;
  f.fail = false;
  vi.stubGlobal("madaniDesktop", undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("connecting an AI on the first screen", () => {
  it("says when it could not check the AIs, keeps the cards it already shows, and checks again", async () => {
    // Was a step of scripts/verify-onboarding-ui.ts, whose fixture no longer reaches this step (its AI already works).
    f.fail = true;
    await show();
    expect(text()).toContain("Couldn't check your AI connections");
    expect(cards()).toEqual(["chatgpt", "claude", "grok"]);
    const button = [...document.body.querySelectorAll("button")].find((node) => node.textContent === "Check again")!;
    await act(async () => { button.click(); });
    expect(text()).not.toContain("Couldn't check your AI connections");
    expect(cards()).toEqual(["chatgpt", "claude", "grok"]);
  });

  it("shows the popular AIs as a grid of cards by the names people use, with a small link to every other provider", async () => {
    await show();
    expect(cards()).toEqual(["chatgpt", "claude", "grok"]);
    expect(document.body.querySelector("[data-funnel-ai=chatgpt]")?.tagName, "a card to press").toBe("BUTTON");
    expect(document.body.querySelector("[data-engine-setup]"), "nothing unfolds until a card is pressed").toBeNull();
    expect(document.body.querySelector("[data-ai-more]")?.textContent).toBe("More providers or use an API key");
    for (const word of [/\bengines?\b/i, /Needs setup/i, /to set up/i]) expect(text()).not.toMatch(word);
  });

  it("opens a pressed card's own setup under the grid, a local model's as its own", async () => {
    f.instances = [engine("codex", "codex", "Codex", false), { ...engine("openaiCompat", "openai-compat", "local models", false), access: "custom" }];
    const setup = (id: string) => document.body.querySelector(`[data-engine-setup="${id}"]`);
    await show();
    expect(cards()).toEqual(["chatgpt", "local"]);
    await press("[data-funnel-ai=chatgpt]");
    expect(document.body.querySelector("[data-funnel-ai=chatgpt]")?.getAttribute("aria-pressed")).toBe("true");
    expect(setup("codex")?.getAttribute("data-intent")).toBe("cloud");
    await press("[data-funnel-ai=local]");
    expect(setup("codex")).toBeNull();
    expect(setup("openaiCompat")?.getAttribute("data-intent")).toBe("inject");
  });

  it("shows a connected AI's card on the plain tile tone, with a green check and Connected, not to be pressed again", async () => {
    f.instances = [engine("claude", "claudeAgent", "Claude", true), engine("codex", "codex", "Codex", false)];
    await show();
    const claude = document.body.querySelector<HTMLElement>("[data-funnel-ai=claude]")!;
    expect(claude.tagName).toBe("DIV");
    expect(claude.hasAttribute("data-connected")).toBe(true);
    expect(claude.className, "green is the status word, not the surface").not.toContain("bg-success");
    expect(claude.querySelector(".text-success")?.textContent).toContain("Connected");
    expect(claude.textContent).toContain("Connected");
    expect(claude.querySelector("svg"), "a check, not colour alone").not.toBeNull();
    expect(document.body.querySelector("button[data-funnel-ai=chatgpt]")).not.toBeNull();
  });

  it("says which AI is connected once one is", async () => {
    f.instances = [engine("claude", "claudeAgent", "Claude", true), engine("codex", "codex", "Codex", false)];
    await show();
    expect(document.body.querySelector("[data-ai-connected]")?.textContent).toContain("Claude");
  });

  it("says Connected only after the AI answered a test message, and plainly while it checks", async () => {
    let answer!: (value: object) => void;
    f.check = () => new Promise((resolve) => { answer = resolve; });
    f.instances = [engine("grok", "grokAgent", "Grok", true), engine("claude", "claudeAgent", "Claude", true)];
    await show();
    expect(f.checks).toEqual(["/api/instances/claude/check"]);
    expect(document.body.querySelector("[data-ai-connected]")).toBeNull();
    expect(document.body.querySelector("[data-ai-checking]")?.textContent).toBe("Checking that Claude answers…");
    await act(async () => { answer({ ok: true }); });
    expect(document.body.querySelector("[data-ai-connected]")?.textContent).toBe("Connected · Claude");
    expect(document.body.querySelector("[data-ai-checking]")).toBeNull();
  });

  it("says a signed-in AI didn't answer, tries the next one, and keeps every other way open", async () => {
    f.check = () => Promise.resolve({ ok: false, error: "Claude didn't answer within 90 seconds." });
    f.instances = [engine("claude", "claudeAgent", "Claude", true), engine("codex", "codex", "Codex", false), engine("kimi", "kimiAgent", "Kimi", false)];
    await show();
    expect(document.body.querySelector("[data-ai-silent] [data-ai-reason]")?.textContent).toBe("Claude didn't answer within 90 seconds.");
    expect(document.body.querySelector("[data-ai-silent]")?.textContent).toContain("Or connect another AI below.");
    expect(document.body.querySelector("[data-ai-connected]")).toBeNull();
    expect(document.body.querySelector("button[data-funnel-ai=chatgpt]"), "another AI is still a card to press").not.toBeNull();
    await otherWays();
    expect(document.body.querySelector("[data-ai-more]")).not.toBeNull();
    // The next ready AI gets its own test.
    f.instances = [...f.instances, engine("grok", "grokAgent", "Grok", true)];
    f.check = () => Promise.resolve({ ok: true });
    await show();
    expect(f.checks).toEqual(["/api/instances/claude/check", "/api/instances/grok/check"]);
    expect(document.body.querySelector("[data-ai-connected]")?.textContent).toBe("Connected · Grok");
  });

  it("says the plain reason a check gave, and Check again sends a new test message", async () => {
    f.check = () => Promise.resolve({ ok: false, error: "Claude isn't signed in on this computer anymore. Sign in again, then check again." });
    f.instances = [engine("claude", "claudeAgent", "Claude", true), engine("codex", "codex", "Codex", false)];
    await show();
    expect(document.body.querySelector("[data-ai-reason]")?.textContent).toBe("Claude isn't signed in on this computer anymore. Sign in again, then check again.");
    expect(text()).not.toContain("is signed in but didn't answer");
    let answer!: (value: object) => void;
    f.check = () => new Promise((resolve) => { answer = resolve; });
    const again = [...document.body.querySelectorAll<HTMLButtonElement>("[data-ai-silent] button")].find((button) => button.textContent === "Check again")!;
    await act(async () => { again.click(); });
    expect(f.checks).toEqual(["/api/instances/claude/check", "/api/instances/claude/check"]);
    expect(document.body.querySelector("[data-ai-checking]")?.textContent).toBe("Checking that Claude answers…");
    await act(async () => { answer({ ok: true }); });
    expect(document.body.querySelector("[data-ai-connected]")?.textContent).toBe("Connected · Claude");
  });

  it("shows what the server's own test found, without sending another", async () => {
    f.instances = [{ ...engine("claude", "claudeAgent", "Claude", true), aiTest: "failed", aiTestError: "Your Claude usage limit has been reached." },
      engine("codex", "codex", "Codex", false)];
    await show();
    expect(f.checks).toEqual([]);
    expect(document.body.querySelector("[data-ai-reason]")?.textContent).toBe("Your Claude usage limit has been reached.");
    // With no reason given, the plain line.
    f.instances = [{ ...engine("claude", "claudeAgent", "Claude", true), aiTest: "failed" }];
    await show();
    expect(document.body.querySelector("[data-ai-reason]")?.textContent).toBe("Claude is signed in but didn't answer. Try another way.");
  });

  it("asks for the person's own AI when only OpenCode's free model works, and says the free model is a backup", async () => {
    const backup: InstanceInfo = { ...engine("opencodeGo", "opencodeGo", "OpenCode", true), snapshot: { state: "available", authenticated: true, freeFallback: true } };
    f.instances = [backup, engine("claude", "claudeAgent", "Claude", false)];
    await show();
    expect(f.checks).toEqual([]);
    expect(document.body.querySelector("[data-ai-connected]")).toBeNull();
    expect(document.body.querySelector("[data-ai-backup]")?.textContent).toBe("OpenCode's free model is ready as a backup. For the best answers, connect an AI you already use.");
    expect(document.body.querySelector("button[data-funnel-ai=claude]")).not.toBeNull();
  });

  it("offers the organization sign-in under the cards on this computer's own window only", async () => {
    await show();
    await otherWays();
    expect(f.row).toBeNull();
    vi.stubGlobal("madaniDesktop", { organization: bridge });
    window.madaniDesktop = { organization: bridge } as unknown as typeof window.madaniDesktop;
    await show();
    expect(f.row?.bridge).toBe(bridge);
    f.row!.onOpenSettings();
    expect(f.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "organization" });
    delete window.madaniDesktop;
  });

  it.each([undefined, "grok", "claude"])("opens with nothing running, whatever AI it was opened for (%s), until the person presses a card (their press is tested above)", async (start) => {
    const onConnected = vi.fn();
    await act(async () => { root.render(createElement(ConnectAiDialog, { tested: null, onClose: () => {}, start: start as never, onConnected })); });
    await act(async () => {});
    const pressed = [...document.body.querySelectorAll("button[data-funnel-ai]")].map((card) => card.getAttribute("aria-pressed"));
    expect(pressed.length).toBeGreaterThan(0);
    expect(pressed.every((value) => value === "false")).toBe(true);
    expect(document.body.querySelector("[data-funnel-ai-connect]")).toBeNull();
    expect(onConnected).not.toHaveBeenCalled();
    // the AI it was opened for only takes the focus
    if (start) expect(document.activeElement).toBe(document.body.querySelector(`button[data-funnel-ai="${start}"]`));
    else expect(document.activeElement).toBe(document.body.querySelector("[data-connect-ai]"));
  });

  it("opens as the Connect an AI dialog, which Escape closes and a click outside never does", async () => {
    const onClose = vi.fn();
    await act(async () => { root.render(createElement(ConnectAiDialog, { tested: null, onClose })); });
    const dialog = document.body.querySelector<HTMLElement>("[data-connect-ai]")!;
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.querySelector("h2")?.textContent).toBe("Connect an AI");
    expect(dialog.querySelector("[data-ai-cards]")).not.toBeNull();
    const more = dialog.querySelector<HTMLButtonElement>("[data-ai-more]")!;
    await act(async () => { more.click(); });
    expect(dialog.querySelector("h2")?.textContent).toBe("More providers or use an API key");
    expect(dialog.querySelector("[data-model-directory-stub]")).not.toBeNull();
    await act(async () => { dialog.querySelector<HTMLButtonElement>("[data-connect-ai-back]")!.click(); });
    expect(dialog.querySelector("h2")?.textContent).toBe("Connect an AI");
    await act(async () => { dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    // it fades out first, then closes
    expect(dialog.classList.contains("animate-pop-out")).toBe(true);
    expect(dialog.parentElement!.hasAttribute("data-leaving")).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { await new Promise((done) => setTimeout(done, DIALOG_LEAVE_MS + 10)); });
    expect(onClose).toHaveBeenCalledOnce();
    await act(async () => { dialog.parentElement!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(onClose, "a click outside stays").toHaveBeenCalledOnce();
  });
});
