// @vitest-environment happy-dom
// Settings → general → bring in from other apps: what this computer holds (BringIn), then the first run's prompt for AIs online.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { bringRunNow, resetBringRunForTests } from "@/lib/first-run-import";
import { GROK_EXPORT_FORMAT } from "../../shared/grok-import";
import type { SetupDetection } from "../../shared/setup-import";

const f = vi.hoisted(() => ({ state: {} as Record<string, unknown>, dispatch: vi.fn(), api: vi.fn() }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: f.state, dispatch: f.dispatch }), api: f.api }));
vi.mock("@/state/api", () => ({ api: f.api }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/components/Avatar", () => ({ BotAvatar: () => null, MausAvatar: () => null }));
vi.mock("@/lib/default-bot", async (original) => ({ ...(await original<typeof import("@/lib/default-bot")>()), useViewerEmail: () => null }));
const { ImportSettings } = await import("./ImportSettings");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const maus = { id: "maus", name: "Madani", defaultBot: {}, messages: [] };
const molty = { source: "openclaw", app: "OpenClaw", where: "~/.openclaw", channels: [], unreadable: [], bots: [{
  name: "Molty", title: "", description: "", instructions: "Be helpful.", memories: ["Sam's sister is Ana."], userFacts: [], skills: [], routines: [], apps: [],
}] };
const grokFile = { name: "grok-bot-export-drew.json", modifiedAt: 1, text: JSON.stringify({ format: GROK_EXPORT_FORMAT, bots: [{ name: "Drew", instructions: "Hi." }] }) };
const SETUP: SetupDetection = { skills: [{ name: "pdf", source: "claudeCode" }], tools: [] };

let host: HTMLDivElement, root: Root;
const button = (label: string) => [...host.querySelectorAll("button")].find((node) => node.textContent === label);
const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
const client = (detection: SetupDetection) => ({
  detect: vi.fn(async () => detection),
  apply: vi.fn(async () => ({ skills: { added: ["pdf"], present: [], skipped: [], filesLeftOut: 0, review: [] }, tools: { added: [], present: [], skipped: [] } })),
});
async function show(options: { local?: boolean; detection?: SetupDetection } = {}) {
  if (options.local !== false) vi.stubGlobal("madaniDesktop", { remoteClient: { active: false } });
  const setup = client(options.detection ?? SETUP);
  await act(async () => root.render(createElement(ImportSettings, { client: setup })));
  await settle();
  return setup;
}

beforeEach(() => {
  setLocale("en");
  resetBringRunForTests();
  f.state = { bots: [maus], config: { profile: {} } };
  f.dispatch = vi.fn();
  f.api.mockReset();
  f.api.mockImplementation(async (path: string, init?: { body?: string; method?: string }) => {
    if (path === "/api/setup-import/bots") return { apps: [molty] };
    if (path.startsWith("/api/setup-import/grok")) return { files: [grokFile], bots: ["Drew", "Eggbot"] };
    if (path === "/api/mcp/servers") return { servers: [] };
    if (path.startsWith("/api/teams/import")) return { bots: [{ id: `id-${JSON.parse(init!.body!).package.name}`, name: JSON.parse(init!.body!).package.name }], routines: [] };
    return {};
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("Settings → bring in from other apps", () => {
  it("lists everything this computer holds, Grok bot's saved files included, with the prompt for AIs online folded below", async () => {
    await show();
    expect(f.api.mock.calls.map(([path]) => path), "Settings may read Downloads, unlike the first run").toContain("/api/setup-import/grok");
    expect(host.querySelector("[data-bring-hero]"), "nothing here is really used: no memory source").toBeNull();
    expect([...host.querySelectorAll("[data-bring-find]")].map((row) => row.getAttribute("data-bring-find")).sort(), "everything is reachable here")
      .toEqual(["bots:grok-bot", "bots:openclaw", "setup:claudeCode"]);
    expect(host.querySelector('[data-bring-import="bots:openclaw"]')?.getAttribute("aria-label")).toBe("Import from OpenClaw");
    expect(host.querySelector("[data-bring-more], [data-bring-memory]"), "no Show more, no notes checkbox").toBeNull();
    const online = host.querySelector<HTMLButtonElement>("[data-bring-online]")!;
    expect(online.textContent, "below what is here, the prompt is one quiet line").toBe("From Grok bot, ChatGPT, Claude or Gemini");
    expect(online.getAttribute("aria-expanded")).toBe("false");
    await act(async () => { online.click(); });
    expect(online.getAttribute("aria-expanded")).toBe("true");
    expect(button("Copy the prompt")).toBeTruthy();
    expect(host.querySelector("[data-bring-ai], [data-bring-paste], textarea"), "no AI to pick, no answer box").toBeNull();
    expect(host.querySelector("[data-bring-grok]")?.textContent, "a Grok bot bot with nothing saved yet goes through the prompt").toContain("Eggbot in Grok bot");
    for (const old of ["Move from Grok bot", "Start import", "Copy prompt", "Look for bots"]) expect(button(old), old).toBeUndefined();
    expect(host.querySelector("[data-import-section=grok], [data-import-section=notes], [data-import-section=apps], [data-import-section=bots]")).toBeNull();
    expect(host.querySelector("[data-bring-skip], [data-bring-next]"), "no funnel buttons").toBeNull();
  });

  it("brings one app in on its own Bring in, says how it went on the page, and marks it imported", async () => {
    const setup = await show();
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-bring-import="bots:openclaw"]')!.click(); });
    await settle();
    expect(setup.apply, "only that app's things").not.toHaveBeenCalled();
    const imported = f.api.mock.calls.filter(([path]) => String(path).startsWith("/api/teams/import")).map(([, init]) => JSON.parse(init.body).package.name);
    expect(imported).toEqual(["Molty"]);
    expect(host.querySelector("[data-bring-run]")?.textContent).toBe("Your bots now know 1 thing about you. Also brought in 1 bot.");
    expect(host.querySelector('[data-bring-find="bots:openclaw"]')?.getAttribute("data-bring-state")).toBe("done");
    expect(host.querySelector('[data-bring-import="bots:openclaw"]'), "no second import of the same").toBeNull();
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-bring-import="setup:claudeCode"]')!.click(); });
    await settle();
    expect(setup.apply).toHaveBeenCalledWith({ skills: true, tools: true, sources: ["claudeCode"] });
    expect(host.querySelector('[data-bring-find="setup:claudeCode"]')?.getAttribute("data-bring-state")).toBe("done");
  });

  it("leads with the app really used, its memory always coming, and its own confirmation", async () => {
    const detection: SetupDetection = { ...SETUP, memory: [{ source: "claudeCode", files: 4, notes: 30, topics: { preferences: true, aboutYou: true, workStyle: false, projects: 0 } }],
      usage: { claudeCode: 14 } };
    const setup = await show({ detection });
    const hero = host.querySelector("[data-bring-hero]")!;
    expect(hero.getAttribute("data-bring-find")).toBe("setup:claudeCode");
    expect(hero.textContent).toContain("It's learned your preferences and who you are.");
    setup.apply.mockResolvedValueOnce({ skills: { added: ["pdf"], present: [], skipped: [], filesLeftOut: 0, review: [] }, tools: { added: [], present: [], skipped: [] }, memory: { added: 30, sources: ["claudeCode"], failed: false } } as never);
    await act(async () => { hero.querySelector<HTMLButtonElement>("[data-bring-import]")!.click(); });
    await settle();
    expect(setup.apply).toHaveBeenCalledWith({ skills: true, tools: true, sources: ["claudeCode"], memory: true, memoryBot: maus.id });
    expect(host.querySelector("[data-bring-said]")?.textContent).toBe("Done. Your bots now know 30 things about you.");
  });

  it("forgets a bringing in that finished before the page opened", async () => {
    await show();
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-bring-import="setup:claudeCode"]')!.click(); });
    await settle();
    expect(bringRunNow().kind).toBe("done");
    await act(async () => root.unmount());
    root = createRoot(host);
    await show();
    expect(bringRunNow().kind).toBe("idle");
    expect(host.querySelector('[data-bring-import="setup:claudeCode"]')).toBeTruthy();
  });

  it("away from this computer's own desktop app, reads nothing here and offers the prompt straight away", async () => {
    await show({ local: false });
    expect(f.api.mock.calls.filter(([path]) => String(path).startsWith("/api/setup-import"))).toEqual([]);
    expect(host.querySelector("[data-bring-looking]")).toBeNull();
    expect(host.querySelector("[data-bring-find]")).toBeNull();
    expect(host.querySelector("[data-bring-prompt] pre")?.textContent).toContain("madani-bot-notes");
    expect(button("Copy the prompt")).toBeTruthy();
    expect(button("Import all")).toBeUndefined();
  });

  it("takes the notes another AI wrote when they are pasted on the page, and says so there", async () => {
    await show({ local: false });
    const paste = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(paste, "clipboardData", { value: { getData: () => JSON.stringify({ format: "madani-bot-notes", version: 2, from: "ChatGPT", about_me: { basics: ["I live in Pune."] } }) } });
    await act(async () => { host.dispatchEvent(paste); });
    expect(paste.defaultPrevented, "nothing behind gets it").toBe(true);
    await settle();
    expect(host.querySelector("[data-bring-notes]")).not.toBeNull();
    expect(host.querySelector("[data-bring-notes]")?.textContent).toMatch(/ChatGPT|notes/);
  });
});
