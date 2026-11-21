// @vitest-environment happy-dom
// The phone composer: a round + beside one pill, in Simple and Advanced mode. The buttons Advanced shows in a row
// (attach, approval level, where the bot works, Finish together) are entries of that +, and the call button is inverse.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group } from "@/state/store";
import { failedComposerSends, rememberFailedComposerSend, restoreComposerDraft } from "@/lib/drafts";
import { setCallMode } from "@/lib/call-mode";
import { setSendKey } from "@/lib/send-key";

const fixture = vi.hoisted(() => ({
  dispatch: vi.fn(),
  call: null as Record<string, unknown> | null,
  liveCall: null as unknown,
}));
const ENGINE = "claude-3f0c2b1e-9d1a-4c55-8a51-0a3a6f1e2b7c";
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, bots: [bot, peer], liveCall: fixture.liveCall, instances: [{
      instanceId: ENGINE, driverKind: "claudeAgent", displayName: "Claude", capabilities: { agentsMcp: true },
    }] },
    dispatch: fixture.dispatch,
  }) };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("./CallView", () => ({ CallButton: (props: Record<string, unknown>) => {
  fixture.call = props;
  return null;
} }));

import { Composer } from "./Composer";
import { composerButtons } from "@/mobile/native-glass";

const bot: Bot = {
  id: "atlas", threadId: "atlas-thread", name: "Atlas", title: "", description: "",
  color: "purple", notifications: false, unread: false, busy: false, messages: [], approvalMode: "ask",
  modelSelection: { instanceId: ENGINE, model: "fake" },
};
const peer: Bot = { ...bot, id: "juniper", threadId: "juniper-thread", name: "Juniper", color: "teal" };
const room: Group = {
  id: "room", threadId: "room-thread", name: "Launch planning", memberIds: [bot.id, peer.id],
  defaultResponder: { kind: "member", botId: bot.id }, bulletin: "", unread: false,
  createdAt: 1, setupCompletedAt: 1, messages: [],
};

let root: Root;
let container: HTMLDivElement;
const render = (props: Parameters<typeof Composer>[0]) => flushSync(() => root.render(createElement(Composer, props)));
const plus = () => container.querySelector<HTMLElement>("[data-composer-plus]")?.closest("button") ?? null;
const menu = () => document.body.querySelector<HTMLElement>('[data-sidebar-popover-menu="anchored"]');
const item = (key: string) => document.body.querySelector<HTMLButtonElement>(`[data-menu-key="${key}"]`);
const click = (element: Element | null) => {
  if (!element) throw new Error("nothing to click");
  flushSync(() => (element as HTMLElement).click());
};
function openPlus() {
  click(plus());
  expect(menu()).not.toBeNull();
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("max-width: 767.98px"), addEventListener() {}, removeEventListener() {} }));
  fixture.liveCall = null;
  setCallMode("turns");
  fixture.call = null;
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  for (const id of [`bot:${bot.id}:${bot.threadId}`, `group:${room.id}:${room.threadId}`]) restoreComposerDraft(id, { text: "", attachments: [] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// these cover live calls, which ship behind a switch that is off
vi.stubEnv("VITE_MADANI_LIVE_CALL", "1");

describe("the phone composer", () => {
  it("while the bot works there is no Stop: the mic keeps its place and every control has its native glass twin", () => {
    vi.stubEnv("VITE_MADANI_LIVE_CALL", "");
    try {
      render({ bot: { ...bot, busy: true } });
      expect(container.querySelector("[data-composer-stop]")).toBeNull();
      expect(container.querySelector('[data-voice-mic="start"]')).not.toBeNull();
      expect(composerButtons(container.querySelector("[data-composer-actions]"))?.buttons.map((b) => b.kind)).not.toContain("stop");
    } finally {
      vi.stubEnv("VITE_MADANI_LIVE_CALL", "1");
    }
  });

  it("in the phone app, return adds a new line and only Send sends, whatever send key the desktop chose", () => {
    setSendKey("enter");
    document.documentElement.dataset.mobileApp = "ios";
    try {
      render({ bot });
      const field = container.querySelector("textarea")!;
      expect(field.getAttribute("enterkeyhint")).toBe("enter");
      restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "", attachments: [] });
      flushSync(() => {
        const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
        setValue.call(field, "ship it");
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      flushSync(() => { field.dispatchEvent(enter); });
      expect(enter.defaultPrevented).toBe(false);
      expect(fixture.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "send" }));
      click(container.querySelector("[data-composer-send]"));
      expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "send", text: "ship it" }));
    } finally {
      delete document.documentElement.dataset.mobileApp;
    }
  });

  it("in the phone app, while the bot works a typed message gets the same labelled Send, with no clock and no follow-up menu", () => {
    document.documentElement.dataset.mobileApp = "ios";
    try {
      restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "and also this", attachments: [] });
      render({ bot: { ...bot, busy: true } });
      const send = container.querySelector<HTMLElement>("[data-composer-send]")!;
      expect(send.dataset.composerSend).toBe("");
      expect(send.getAttribute("aria-label")).toBeTruthy();
      expect(container.querySelector("[data-composer-follow-up]")).toBeNull();
      expect(container.querySelector("[data-composer-stop]")).toBeNull();
      expect(composerButtons(container.querySelector("[data-composer-actions]"))?.buttons.map((b) => b.kind)).toEqual(["mic", "send"]);
    } finally {
      delete document.documentElement.dataset.mobileApp;
    }
  });

  it("outside the phone app a send key that needs a modifier keeps return for a new line", () => {
    setSendKey("mod-enter");
    try {
      render({ bot });
      expect(container.querySelector("textarea")!.getAttribute("enterkeyhint")).toBe("enter");
    } finally {
      setSendKey("enter");
    }
  });

  it("with calls off, ends the pill on an inverse mic and offers no call", () => {
    vi.stubEnv("VITE_MADANI_LIVE_CALL", "");
    vi.stubEnv("VITE_MADANI_VOICE_CALL", "0");
    try {
      render({ bot });
      expect(fixture.call).toBeNull();
      const mic = container.querySelector<HTMLButtonElement>('button[data-voice-mic="start"]')!;
      expect(mic.getAttribute("aria-label")).toBe("Start dictation");
      expect(mic.className.split(" ")).toEqual(expect.arrayContaining(["bg-ink", "text-app", "size-8"]));
    } finally {
      vi.stubEnv("VITE_MADANI_LIVE_CALL", "1");
      vi.stubEnv("VITE_MADANI_VOICE_CALL", "");
    }
  });

  it("is one pill to the reference's measure: the + at its left edge and every control 32 px inside it", () => {
    render({ bot });
    const pill = container.querySelector("[data-composer-row]")!;
    expect(pill.contains(plus())).toBe(true);
    expect(container.querySelector("[data-composer-plus]")!.className.split(" ")).toEqual(expect.arrayContaining(["size-8", "rounded-full"]));
    expect(pill.parentElement!.className.split(" ")).toEqual(expect.arrayContaining(["min-h-[48px]", "rounded-[24px]", "p-2"]));
    expect(container.querySelector<HTMLButtonElement>('button[data-voice-mic="start"]')!.className.split(" ")).toContain("size-8");
    expect(fixture.call).toMatchObject({ placement: "composer", inverse: true });
    expect(fixture.call?.fill).toBeUndefined();
  });

  it("offers only the photo library, the camera and files from the +, each its own picker", () => {
    render({ bot: { ...bot, tasks: [{ threadId: bot.threadId, title: "new thread", createdAt: 1, approvalMode: "full" }] } });
    openPlus();
    const keys = [...menu()!.querySelectorAll("[data-menu-key]")].map((row) => row.getAttribute("data-menu-key"));
    expect(keys).toEqual(["attach:photos", "attach:camera", "attach"]);
    expect(menu()!.textContent).not.toMatch(/Work until done|Teach a task|acts|Call mode|Live/);
    expect(item("attach:photos")?.textContent).toContain("Photo library");
    expect(item("attach:camera")?.textContent).toContain("Take photo");
    expect(item("attach")?.textContent).toContain("Files");
    const opened: HTMLInputElement[] = [];
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) { opened.push(this); });
    click(item("attach:camera"));
    expect(opened[0]?.accept).toBe("image/*");
    expect(opened[0]?.getAttribute("capture")).toBe("environment");
    openPlus();
    click(item("attach:photos"));
    expect(opened[1]?.accept).toBe("image/*,video/*");
    expect(opened[1]?.multiple).toBe(true);
    openPlus();
    click(item("attach"));
    expect(opened[2]?.accept).toBe("");
    expect(opened[2]?.hasAttribute("capture")).toBe(false);
  });

  it("edit on a failed send puts its words back in the field, focused with the cursor at the end", async () => {
    const draftId = `bot:${bot.id}:${bot.threadId}`;
    rememberFailedComposerSend(draftId, { sendId: "lost", text: "ship it friday", requestText: "ship it friday", threadId: bot.threadId });
    render({ bot });
    expect(container.textContent).toContain("Not sent");
    click(container.querySelector("[data-failed-edit]"));
    await new Promise((done) => requestAnimationFrame(() => done(null)));
    const field = container.querySelector("textarea")!;
    expect(field.value).toBe("ship it friday");
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe("ship it friday".length);
    expect(failedComposerSends(draftId)).toEqual([]);
    expect(container.querySelector("[data-failed-send]")).toBeNull();
  });

  it("keeps one file picker on a wider screen", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: !query.includes("max-width"), addEventListener() {}, removeEventListener() {} }));
    render({ bot });
    expect(fixture.call?.inverse).toBe(false);
    expect(container.querySelectorAll('input[type="file"]')).toHaveLength(1);
    expect(container.querySelector("input[capture]")).toBeNull();
  });
});
