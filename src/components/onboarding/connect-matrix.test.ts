// @vitest-environment happy-dom
// Every card of the Connect an AI grid, in every install state, through the real grid, connect panel and setup card.
// Settings > Models, the API keys page, the Connect an AI dialog (first run, composer banner, a failed reply, the bot's
// details) all render this one grid, so this is the matrix for each of them. Requests are synthetic and stay in-process.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { BotEditorStore, initialState, type InstanceInfo, type useStore } from "@/state/store";
import { AiCards } from "./AiCards";
import { ConnectPanel, type ConnectFlowHandle } from "./SignInPill";
import { ConnectProviderDialog } from "../models/ConnectProviderDialog";
import type { ProviderInfo } from "@/lib/model-providers";
import type { ConnectState } from "./connect-flow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Words that send the person to a terminal, to Settings, or to do the install themselves. */
const SENDS_ELSEWHERE = [/curl /, /npm install/, /\birm\b/, /\| ?(ba)?sh\b/, /Copy command/, /Terminal/, /settings →/i, /Open API keys/,
  /CLI path/, /Install it and sign in/, /View setup guide/, /Prefer a terminal/];

type Tile = { tile: string; instanceId: string; driverKind: string; displayName: string; auth?: InstanceInfo["authentication"]; command?: string };
const TILES: Tile[] = [
  { tile: "chatgpt", instanceId: "codex", driverKind: "codex", displayName: "Codex", auth: { method: "device-code" }, command: "npm install -g @openai/codex" },
  { tile: "claude", instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", auth: { method: "paste-code" }, command: "npm install -g @anthropic-ai/claude-code" },
  { tile: "grok", instanceId: "grok", driverKind: "grokAgent", displayName: "Grok", auth: { method: "device-code" }, command: "curl -fsSL https://x.ai/cli/install.sh | bash" },
  { tile: "gemini", instanceId: "antigravity", driverKind: "antigravityAgent", displayName: "Antigravity", auth: { method: "browser" } },
  { tile: "cursor", instanceId: "cursor", driverKind: "cursorAgent", displayName: "Cursor", auth: { method: "device-code" }, command: "curl https://cursor.com/install -fsS | bash" },
  { tile: "copilot", instanceId: "githubCopilot", driverKind: "copilotAgent", displayName: "GitHub Copilot", auth: { method: "device-code" }, command: "npm install -g @github/copilot" },
];

function engine(tile: Tile, state: "missing" | "installable" | "signedOut"): InstanceInfo {
  const command = tile.command ? { darwin: tile.command, linux: tile.command, win32: tile.command } : undefined;
  return {
    instanceId: tile.instanceId, driverKind: tile.driverKind, displayName: tile.displayName, access: "subscription",
    models: { default: "m", options: [] },
    snapshot: state === "signedOut" ? { state: "available", authenticated: false, version: "1.0.0" } : { state: "unavailable", reason: `\`${tile.instanceId}\` CLI not found` },
    ...(tile.auth ? { authentication: tile.auth } : {}),
    install: tile.command
      ? { platform: "linux", command, docsUrl: "https://example.test/docs", signInCommand: `${tile.instanceId} login`,
        ...(state === "installable" ? { server: tile.command.startsWith("npm") ? { package: "fixture" } : { script: true } } : {}) }
      : { platform: "linux", docsUrl: "https://example.test/docs", managed: { label: "Install Antigravity", downloadBytes: 50_000_000 } },
  } as InstanceInfo;
}

const apiKeyEngines: InstanceInfo[] = [
  { instanceId: "openrouter", driverKind: "openai-compat", displayName: "OpenRouter", access: "api", models: { default: "m", options: [] },
    snapshot: { state: "unavailable", reason: "No API key" }, install: { settings: "connections" } } as InstanceInfo,
  { instanceId: "openaiCompat", driverKind: "openai-compat", displayName: "Other (OpenAI-compatible)", access: "api", models: { default: "m", options: [] },
    snapshot: { state: "unavailable", reason: "No API key" }, install: { settings: "connections" } } as InstanceInfo,
];

let host: HTMLDivElement;
let root: Root;
let instances: InstanceInfo[] = [];
const installs: string[] = [];
const dispatch = vi.fn();

function mount() {
  const store = {
    state: { ...initialState, config: {}, instances }, dispatch,
    refreshInstances: vi.fn(async () => {}), refreshModels: vi.fn(async () => {}),
  } as unknown as ReturnType<typeof useStore>;
  act(() => root.render(createElement(BotEditorStore, { value: store, children: createElement(AiCards, { tested: null, onMore: () => {} }) })));
}
const press = async (tile: string) => {
  await act(async () => { host.querySelector<HTMLElement>(`[data-funnel-ai="${tile}"]`)!.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};
const connectArea = (tile: string) => host.querySelector<HTMLElement>(`[data-funnel-ai-connect="${tile}"]`)!;
const expectNoWayOut = (text: string) => { for (const pattern of SENDS_ELSEWHERE) expect(text).not.toMatch(pattern); };

beforeEach(() => {
  setLocale("en");
  installs.length = 0;
  dispatch.mockReset();
  vi.stubGlobal("madaniDesktop", undefined);
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (String(path).endsWith("/install")) {
      installs.push(String(path));
      return new Promise<Response>(() => {});
    }
    if (String(path).startsWith("/api/instances")) return new Response(JSON.stringify({ instances }));
    void init;
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

describe("every card of the grid", () => {
  it.each(TILES.map((tile) => [tile.tile, tile] as const))("%s, not installed: installs on the bots' computer by itself, no command", async (_name, tile) => {
    instances = [engine(tile, "installable"), ...apiKeyEngines];
    mount();
    await press(tile.tile);
    expect(connectArea(tile.tile).dataset).toBeDefined();
    expect(host.querySelector('[data-connect-stage="installing"]')).not.toBeNull();
    expect(installs).toEqual([`/api/instances/${tile.instanceId}/install`]);
    expectNoWayOut(connectArea(tile.tile).textContent ?? "");
  });

  it.each(TILES.map((tile) => [tile.tile, tile] as const))("%s, installed and signed out: no command and no Settings detour", async (_name, tile) => {
    instances = [engine(tile, "signedOut"), ...apiKeyEngines];
    mount();
    await press(tile.tile);
    expect(installs).toEqual([]);
    expectNoWayOut(connectArea(tile.tile).textContent ?? "");
  });

  it.each(TILES.map((tile) => [tile.tile, tile] as const))("%s, not installable here: one plain line, never the vendor's command", async (_name, tile) => {
    instances = [engine(tile, "missing"), ...apiKeyEngines];
    mount();
    await press(tile.tile);
    const text = connectArea(tile.tile).textContent ?? "";
    expectNoWayOut(text);
    if (tile.command) expect(text).not.toContain(tile.command);
  });

  it("takes an OpenRouter key and an OpenAI-compatible base URL and key right in the card", async () => {
    instances = [...apiKeyEngines];
    mount();
    await press("openrouter");
    expect(connectArea("openrouter").querySelector('[data-key-row="openrouter"]')).not.toBeNull();
    expectNoWayOut(connectArea("openrouter").textContent ?? "");
    await press("local");
    const local = connectArea("local");
    expect(local.textContent).toContain("Other (OpenAI-compatible)");
    expect(local.textContent).not.toMatch(/^other /);
    expect(local.querySelector('input[aria-label="OpenAI-compatible base URL"]')).not.toBeNull();
    expect(local.querySelector('[data-key-row="openaiCompat"]')).not.toBeNull();
    expectNoWayOut(local.textContent ?? "");
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "toggleAppSettings" }));
  });
});

describe("the connect panel after an install", () => {
  const panel = (state: ConnectState) => {
    const retry = vi.fn();
    const onTrouble = vi.fn();
    const flow = { state, target: null, start: vi.fn(), cancel: vi.fn(), retry, openAgain: vi.fn(), submit: vi.fn() } as unknown as ConnectFlowHandle;
    act(() => root.render(createElement(ConnectPanel, { flow, name: "Cursor", driverKind: "cursorAgent", onTrouble })));
    return { retry, onTrouble };
  };

  it("a code sign-in shows the code, where to enter it and one button; a link sign-in only waits, with Open again", () => {
    panel({ stage: "waiting", since: Date.now(), kind: "device", flowId: "f", link: "https://github.com/login/device", code: "A1B2-C3D4", opened: true });
    const coded = host.querySelector<HTMLElement>('[data-connect-stage="waiting"]')!;
    expect(coded.textContent).toContain("Enter this code at github.com/login/device");
    expect(coded.querySelector('[data-sign-in="code"]')?.textContent).toBe("A1B2-C3D4");
    expect([...coded.querySelectorAll("[data-connect-copy]")].map((button) => button.textContent)).toEqual(["Copy code and open Cursor"]);
    expect(coded.querySelector('[role="status"]')?.textContent).toContain("Waiting for you to sign in");

    panel({ stage: "waiting", since: Date.now(), kind: "browser", flowId: "f", link: "https://cursor.com/loginDeepControl?challenge=a&uuid=b", code: null, opened: true });
    const linked = host.querySelector<HTMLElement>('[data-connect-stage="waiting"]')!;
    expect(linked.querySelector('[role="status"]')?.textContent).toContain("Finish signing in to Cursor in your browser");
    expect(linked.querySelector('[data-sign-in="code"]')).toBeNull();
    expect(linked.querySelector("[data-connect-copy]")).toBeNull();
    expect(linked.textContent).toContain("Open again");
  });

  it("a browser sign-in says what to do there, then adds the elapsed line at 20 s and Try another way at 45 s", () => {
    const wait = (seconds: number) => panel({ stage: "waiting", since: Date.now() - seconds * 1000, kind: "browser", flowId: "f", link: "https://cursor.com/login", code: null, opened: true });
    const area = () => host.querySelector<HTMLElement>('[data-connect-stage="waiting"]')!;
    wait(2);
    expect(area().querySelector("[data-connect-guide]")?.textContent).toContain("Sign in on the Cursor page that opened in your browser");
    expect(area().querySelector("[data-connect-still]")).toBeNull();
    expect(area().querySelector("[data-connect-other]")).toBeNull();
    wait(25);
    expect(area().querySelector("[data-connect-still]")?.textContent).toMatch(/Still waiting for your browser, 2\d s/);
    expect(area().querySelector("[data-connect-other]")).toBeNull();
    const { onTrouble } = wait(50);
    const other = area().querySelector<HTMLButtonElement>("[data-connect-other]")!;
    expect(other.textContent).toBe("Try another way");
    expect(area().textContent).toContain("Open again");
    act(() => other.click());
    expect(onTrouble).toHaveBeenCalledOnce();
    expect(host.textContent).not.toMatch(/\u2014/);
  });

  it("a failed browser sign-in offers Try again, Open again and Try another way", () => {
    panel({ stage: "failed", at: "waiting", reason: "timeout", message: null, link: "https://cursor.com/login" });
    expect([...host.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Try again", "Open again", "Try another way"]);
  });

  it("shows honest progress while installing", () => {
    panel({ stage: "installing", since: Date.now(), downloadBytes: null });
    expect(host.textContent).toContain("Getting Cursor ready");
    expect(host.textContent).toContain("Installing Cursor on the computer your bots run on");
    expectNoWayOut(host.textContent ?? "");
  });

  it("shows a measured install as a percent, one bar and the megabytes, then setting up", () => {
    const MB = 1024 * 1024;
    panel({ stage: "installing", since: Date.now() - 20_000, downloadBytes: 321 * MB, progress: { phase: "download", received: 142.6 * MB, total: 321 * MB } });
    const stage = host.querySelector<HTMLElement>('[data-connect-stage="installing"]')!;
    expect(stage.querySelector("p")?.textContent).toBe("Getting Cursor ready…44%");
    expect(stage.textContent).toContain("142 of 321\u00a0MB");
    expect(stage.textContent).not.toContain("20 s");
    const bar = stage.querySelector<HTMLElement>('[role="progressbar"]')!;
    expect(bar.getAttribute("aria-valuenow")).toBe("44");
    expect(stage.querySelectorAll('[role="progressbar"]')).toHaveLength(1);

    panel({ stage: "installing", since: Date.now() - 20_000, downloadBytes: 321 * MB, progress: { phase: "setup", received: 321 * MB, total: 321 * MB } });
    expect(stage.textContent).toContain("Setting up…");
    expect(stage.textContent).not.toContain("%");
    expect(stage.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("100");
    expectNoWayOut(stage.textContent ?? "");
  });

  it("falls back to elapsed time with no bar when the total is unknown", () => {
    panel({ stage: "installing", since: Date.now() - 20_000, downloadBytes: 321 * 1024 * 1024, progress: { phase: "download", received: 5, total: null } });
    const stage = host.querySelector<HTMLElement>('[data-connect-stage="installing"]')!;
    expect(stage.textContent).toContain("20 s");
    expect(stage.textContent).toContain("about 321\u00a0MB");
    expect(stage.querySelector('[role="progressbar"]')).toBeNull();
  });

  it("says a failed install in one plain line with Try again, never the installer's output", async () => {
    const { retry } = panel({ stage: "failed", at: "installing", reason: "error", message: "The installer stopped before it finished.\ncurl: (6) Could not resolve host", link: null });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Cursor couldn't be installed on the computer your bots run on. Try again in a moment.");
    expect(host.textContent).not.toContain("curl");
    expect(host.querySelector("[data-connect-trouble]")).toBeNull();
    const buttons = [...host.querySelectorAll("button")].map((button) => button.textContent);
    expect(buttons).toEqual(["Try again"]);
    await act(async () => { host.querySelector("button")!.click(); });
    expect(retry).toHaveBeenCalledOnce();
  });

  it("says an install that ran past its deadline plainly, with Try again", () => {
    panel({ stage: "failed", at: "installing", reason: "timeout", message: null, link: null });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Downloading Cursor is taking too long. Check the internet connection, then try again.");
    expect([...host.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Try again"]);
  });

  it("an AI the install left unusable is the same plain line", () => {
    panel({ stage: "failed", at: "installing", reason: "unavailable", message: "`cursor-agent` CLI not found", link: null });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Cursor couldn't be installed on the computer your bots run on. Try again in a moment.");
  });
});

describe("More providers or use an API key", () => {
  it("signs in with Claude right in the provider sheet instead of bouncing to Settings", async () => {
    const claude = TILES.find((tile) => tile.tile === "claude")!;
    instances = [engine(claude, "installable")];
    const store = { state: { ...initialState, config: {}, instances }, dispatch, refreshInstances: vi.fn(async () => {}), refreshModels: vi.fn(async () => {}) } as unknown as ReturnType<typeof useStore>;
    const anthropic = { id: "anthropic", label: "Anthropic", section: "major", wire: "anthropic", baseUrl: "https://api.anthropic.com", listModels: "anthropic",
      offered: true, modelCount: 3, connected: [], signIn: { label: "Sign in with Claude", driverKinds: ["claudeAgent"] } } as unknown as ProviderInfo;
    const onClose = vi.fn();
    act(() => root.render(createElement(BotEditorStore, { value: store, children: createElement(ConnectProviderDialog, { provider: anthropic, place: "computer", onClose }) })));
    await act(async () => { document.querySelector<HTMLElement>("[data-connect-sign-in]")!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(onClose).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "toggleAppSettings" }));
    expect(document.querySelector('[data-connect-sign-in-flow] [data-connect-stage="installing"]')).not.toBeNull();
    expect(installs).toEqual(["/api/instances/claude/install"]);
  });
});
