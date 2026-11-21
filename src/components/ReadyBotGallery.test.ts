// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const opened = vi.hoisted(() => ({ props: null as null | { open: boolean; onCancel: () => void; onConfirm: () => void }, dispatch: vi.fn(), state: { config: null, bots: [] } as { config: { botLimit?: number } | null; bots: object[] } }));
vi.mock("./LocalComputerAutoWarning", () => ({
  LocalComputerAutoWarning: (props: NonNullable<typeof opened.props>) => { opened.props = props.open ? props : null; return null; },
}));
const made = vi.hoisted(() => ({ defaults: { profile: {}, memory: {}, skills: [], routines: [] } as { profile: Record<string, unknown>; memory: object; skills: unknown[]; routines: unknown[] }, create: vi.fn() }));
vi.mock("@/state/store", () => ({
  useStore: () => ({ dispatch: opened.dispatch, state: opened.state }),
  api: vi.fn(async () => ({ defaults: made.defaults, suggestedName: "Nova", modelSelection: { instanceId: "", model: "" } })),
}));
vi.mock("@/lib/create-configured-bot", () => ({ createConfiguredBot: made.create }));
vi.mock("@/lib/new-bot", async (actual) => ({ ...await actual<typeof import("@/lib/new-bot")>(), announceNewBot: vi.fn() }));

const { ReadyBotGallery } = await import("./ReadyBotGallery");
const { READY_BOTS } = await import("@/lib/ready-bots");

let root: Root;
let host: HTMLElement;
const onDialog = vi.fn();
const onAdded = vi.fn();

function render(search = "") {
  flushSync(() => root.render(createElement(ReadyBotGallery, { search, onDialog, onAdded })));
}
const cards = () => [...host.querySelectorAll("[data-ready-bot]")].map((card) => card.getAttribute("data-ready-bot"));
const button = (name: string) => [...host.querySelectorAll("button")].find((candidate) =>
  candidate.textContent === name || candidate.getAttribute("aria-label") === name)!;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  opened.props = null;
  opened.state = { config: null, bots: [] };
  opened.dispatch.mockReset();
  made.defaults = { profile: {}, memory: {}, skills: [], routines: [] };
  made.create.mockReset();
  made.create.mockImplementation(async (draft: { bot: { name: string } }) => ({ bot: { id: "new-bot", name: draft.bot.name }, warnings: [] }));
  onDialog.mockClear();
  onAdded.mockClear();
});
afterEach(() => { flushSync(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("ready-made bots gallery", () => {
  it("shows every ready-made bot with its own Add button", () => {
    render();
    expect(cards()).toEqual(READY_BOTS.map((bot) => bot.id));
    const labels = [...host.querySelectorAll("button[aria-label^='Add ']")].map((add) => add.getAttribute("aria-label"));
    expect(new Set(labels).size).toBe(READY_BOTS.length);
    expect(host.querySelector(`[data-ready-bot="${READY_BOTS[0]!.id}"]`)?.getAttribute("title")).toBe(READY_BOTS[0]!.description);
  });

  it("narrows to a category and back to all", () => {
    render();
    flushSync(() => button("Design").click());
    expect(cards()).toEqual(["design-critic"]);
    expect(button("Design").getAttribute("aria-pressed")).toBe("true");
    flushSync(() => button("All").click());
    expect(cards()).toHaveLength(READY_BOTS.length);
  });

  it("follows the Templates search and hides itself when nothing matches", () => {
    render("receipts");
    expect(cards()).toEqual(["bookkeeper"]);
    render("no bot is called this");
    expect(host.querySelector("section")).toBeNull();
  });

  it("makes the chosen bot in one click, filled in from it", async () => {
    render();
    flushSync(() => button("Add Penny, Bookkeeper").click());
    await vi.waitFor(() => expect(onAdded).toHaveBeenCalledWith({ id: "new-bot", name: "Penny" }));
    expect(opened.props).toBeNull();
    expect(onDialog).not.toHaveBeenCalled();
    expect(opened.dispatch).toHaveBeenCalledWith({ type: "botCreationPending", on: true });
    expect(opened.dispatch).toHaveBeenLastCalledWith({ type: "botCreationPending", on: false });
  });

  it("asks in place before a bot that would approve its own work on this computer, then makes it with that yes", async () => {
    made.defaults = { profile: { approvalMode: "auto", computer: "local" }, memory: {}, skills: [], routines: [] };
    render();
    flushSync(() => button("Add Penny, Bookkeeper").click());
    await vi.waitFor(() => expect(opened.props?.open).toBe(true));
    expect(made.create).not.toHaveBeenCalled();
    expect(onDialog).toHaveBeenLastCalledWith(true);
    flushSync(() => opened.props!.onConfirm());
    expect(onDialog).toHaveBeenLastCalledWith(false);
    await vi.waitFor(() => expect(onAdded).toHaveBeenCalledWith({ id: "new-bot", name: "Penny" }));
    expect(made.create.mock.calls[0][0].consent).toEqual({ acknowledgeLocalAuto: true });
  });

  it("on a paired device, which cannot read the host's defaults, makes the bot at once", () => {
    vi.stubGlobal("madaniDesktop", { remoteClient: { active: true } });
    render();
    flushSync(() => button("Add Penny, Bookkeeper").click());
    expect(opened.props).toBeNull();
    expect(opened.dispatch).toHaveBeenCalledWith({ type: "newBot", onCreated: onAdded });
  });

  it("gives Templates its keys back when the question is declined, and makes nothing", async () => {
    made.defaults = { profile: { approvalMode: "auto", computer: "local" }, memory: {}, skills: [], routines: [] };
    render();
    flushSync(() => button("Add Edie, Writer and editor").click());
    await vi.waitFor(() => expect(opened.props).not.toBeNull());
    flushSync(() => opened.props!.onCancel());
    expect(onDialog).toHaveBeenLastCalledWith(false);
    expect(opened.props).toBeNull();
    expect(made.create).not.toHaveBeenCalled();
    expect(onAdded).not.toHaveBeenCalled();
  });

  it("at Starter's limit opens the upgrade popup instead of a form to fill in", async () => {
    const { botLimitShown, closeBotLimit } = await import("@/lib/bot-limit");
    opened.state = { config: { botLimit: 5 }, bots: Array.from({ length: 5 }, () => ({})) };
    render();
    flushSync(() => button("Add Penny, Bookkeeper").click());
    expect(opened.props).toBeNull();
    expect(made.create).not.toHaveBeenCalled();
    expect(botLimitShown()).toBe(true);
    closeBotLimit();
  });
});
