// @vitest-environment happy-dom
// Simple mode's composer: one pill with a round + (attach, Work until done or Finish together, Teach a task), a chip for a
// mode only while this conversation turns it on, and one round button in the bot's tone that calls, sends or stops.
// Advanced keeps its row of buttons.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group } from "@/state/store";
import { restoreComposerDraft } from "@/lib/drafts";
import { setCallMode } from "@/lib/call-mode";
import { BOT_BUTTON, botButtonTone } from "@/lib/bot-button";

const fixture = vi.hoisted(() => ({
  agentsMcp: true,
  dispatch: vi.fn(),
  call: null as Record<string, unknown> | null,
  liveCall: null as unknown,
  config: undefined as unknown,
}));
const ENGINE = "claude-3f0c2b1e-9d1a-4c55-8a51-0a3a6f1e2b7c";
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, config: fixture.config ?? original.initialState.config, bots: [bot, peer], liveCall: fixture.liveCall, instances: [{
      instanceId: ENGINE, driverKind: "claudeAgent", displayName: "Claude", capabilities: { agentsMcp: fixture.agentsMcp },
    }] },
    dispatch: fixture.dispatch,
  }) };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/cloud-guest")>(), useReactor: () => "user" }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("./CallView", () => ({ CallButton: (props: Record<string, unknown>) => {
  fixture.call = props;
  return null;
} }));

import { Composer, SEND_HOLD_MAX_MS } from "./Composer";

// these cover live calls, which ship behind a switch that is off
vi.stubEnv("VITE_MADANI_LIVE_CALL", "1");

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
const menu = () => document.body.querySelector<HTMLElement>("[data-composer-menu]");
const popover = () => document.body.querySelector<HTMLElement>('[data-sidebar-popover-menu="anchored"]');
const click = (element: Element | null) => {
  if (!element) throw new Error("nothing to click");
  flushSync(() => (element as HTMLElement).click());
};
/** The bot's own button: its bubble's fill and ink, with the darker hover and press steps. */
function expectBotButton(button: HTMLElement | null, color: Bot["color"]) {
  const tone = botButtonTone(color);
  expect(button?.className.split(" ")).toContain(BOT_BUTTON);
  expect(button?.style.getPropertyValue("--bot-button")).toBe(tone.fill);
  expect(button?.style.getPropertyValue("--bot-button-ink")).toBe(tone.ink);
  expect(button?.style.getPropertyValue("--bot-button-hover")).toBe(tone.hover);
  expect(button?.style.getPropertyValue("--bot-button-pressed")).toBe(tone.pressed);
}
const sendButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]');

beforeEach(() => {
  fixture.agentsMcp = true;
  fixture.liveCall = null;
  fixture.config = undefined;
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

describe("the Simple composer in a bot chat", () => {
  it("with Live calls off, still offers a call with the built-in voice, and no Live choice", () => {
    vi.stubEnv("VITE_MADANI_LIVE_CALL", "");
    try {
      render({ bot });
      expect(fixture.call).toMatchObject({ placement: "composer", live: false });
    } finally {
      vi.stubEnv("VITE_MADANI_LIVE_CALL", "1");
    }
  });

  it("with calls off, makes the mic its one round button in the bot's tone, and offers no call", () => {
    vi.stubEnv("VITE_MADANI_LIVE_CALL", "");
    vi.stubEnv("VITE_MADANI_VOICE_CALL", "0");
    try {
      render({ bot });
      expect(fixture.call).toBeNull();
      const mic = container.querySelector<HTMLButtonElement>('[data-composer-actions] button[data-voice-mic="start"]')!;
      expect(mic.getAttribute("aria-label")).toBe("Start dictation");
      expect(mic.style.backgroundColor).not.toBe("");
      expect(mic.className.split(" ")).toEqual(expect.arrayContaining(["size-7", "rounded-full", "composer-press"]));
      expect(container.querySelector("[data-composer-actions]")!.lastElementChild).toBe(mic);
    } finally {
      vi.stubEnv("VITE_MADANI_LIVE_CALL", "1");
      vi.stubEnv("VITE_MADANI_VOICE_CALL", "");
    }
  });

  it("is one pill: a round + that attaches files, the field, and one round button in the bot's tone", () => {
    render({ bot });
    expect(plus()?.getAttribute("aria-label")).toBe("Attach files");
    expect(plus()?.getAttribute("aria-haspopup")).toBeNull();
    const pill = container.querySelector('[data-tour="composer"]')!.className.split(" ");
    expect(pill).toEqual(expect.arrayContaining(["composer-pill", "rounded-[22px]", "bg-composer", "px-[9px]", "pt-[7px]", "pb-[9px]", "inset-ring-[0.5px]", "inset-ring-ink/[0.12]",
      "hover:inset-ring-ink/[0.24]", "focus-within:inset-ring-ink/[0.24]", "data-[drag-over]:inset-ring-accent"]));
    expect(pill.filter((name) => name.startsWith("shadow"))).toEqual(["shadow-[0_2px_8px_-1px_rgb(0_0_0/0.05),0_1px_2px_rgb(0_0_0/0.03),0_0_0_1px_rgb(228_228_228/0.04)]"]);
    expect(container.querySelector("[data-composer-row]")!.className).not.toContain("flex-wrap");
    expect(container.querySelector("[data-composer-actions]")!.className.split(" ")).toContain("gap-2");
    expect(container.querySelector("[data-composer-plus]")!.className.split(" ")).toEqual(expect.arrayContaining(["composer-press", "size-7", "bg-ink/[0.06]", "inset-ring-[0.5px]", "inset-ring-ink/[0.08]", "text-ink/[0.56]"]));
    expect(container.querySelector('button[aria-label="Attach a file"]')).toBeNull();
    expect(container.querySelector("[data-goal-chip]")).toBeNull();
    expect(container.querySelector("[data-approval-chip]")).toBeNull();
    const tone = botButtonTone("purple");
    expect(fixture.call).toMatchObject({ bot: { id: "atlas" }, placement: "composer", fill: `var(--grok-cta, ${tone.fill})`, ink: tone.ink });
  });

  it("keeps the + to uploads: Teach a task and Work until done stay out of it, /learn and /goal stay typed commands", () => {
    render({ bot });
    expect(menu()).toBeNull();
    const field = container.querySelector("textarea")!;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "/");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(document.body.textContent).toContain("/learn");
    expect(document.body.textContent).toContain("/goal");
  });

  it("opens the file picker straight from the + when attaching is its only row", () => {
    fixture.config = { features: { skillAuthoring: false } };
    const picker = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    render({ group: { ...room, dm: true }, members: [bot, peer] });
    const attach = container.querySelector<HTMLButtonElement>('button[aria-label="Attach files"]')!;
    expect(attach.getAttribute("aria-haspopup")).toBeNull();
    click(attach);
    expect(picker).toHaveBeenCalledOnce();
    expect(menu()).toBeNull();
  });

  it("keeps the plain placeholder while the bot works and says what Send does in the bot's terms", () => {
    restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "and this", attachments: [] });
    render({ bot: { ...bot, busy: true } });
    expect(container.querySelector("textarea")!.getAttribute("placeholder")).toBe("Message Atlas");
    const send = container.querySelector<HTMLButtonElement>('button[aria-label="Sends when Atlas is done"]')!;
    expect(send.getAttribute("title")).toBe("Sends when Atlas is done");
  });

  it("rounds its corners in from 22 to 18 once the message takes a second line", () => {
    restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "one\ntwo", attachments: [] });
    render({ bot });
    const pill = container.querySelector('[data-tour="composer"]')!;
    expect(pill.hasAttribute("data-multiline")).toBe(true);
    expect(pill.className.split(" ")).toContain("rounded-[18px]");
  });

  it("sets the composer on plain canvas from its top edge down, with no fade above it", () => {
    render({ bot });
    const backdrop = container.querySelector("[data-composer-backdrop]")!.className.split(" ");
    expect(backdrop).toEqual(expect.arrayContaining(["bg-app", "top-0", "-bottom-4", "-left-5", "-right-5"]));
    expect(backdrop.some((name) => /gradient|blur|^from-|^to-|^opacity/.test(name))).toBe(false);
  });

  it("attaches through the same file picker as the paperclip", () => {
    const picker = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    render({ bot });
    click(plus());
    expect(picker).toHaveBeenCalledOnce();
    expect(menu()).toBeNull();
  });

  it("turns its round button into Send while there is text, in the bot's colour", () => {
    restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "hello", attachments: [] });
    render({ bot });
    const send = sendButton()!;
    expect(send.className.split(" ")).toContain("size-7");
    expectBotButton(send, "purple");
    expect(send.className).not.toMatch(/\bbg-accent\b|brightness/);
    expect(fixture.call).toBeNull();
    render({ bot: { ...bot, color: "yellow" } });
    expectBotButton(sendButton(), "yellow");
  });

  it("hands focus back to the field after a click on Send, holds Send grayed until the server has it, then fades the arrow out over the call glyph", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "hello", attachments: [] });
    render({ bot });
    const send = sendButton()!;
    send.focus();
    click(send);
    flushSync(() => frames.splice(0).forEach((frame) => frame(0)));
    expect(container.querySelector("textarea")!.value).toBe("");
    expect(document.activeElement).toBe(container.querySelector("textarea"));
    // the same button stays, disabled (the bot button's gray), with no glyph change and no follow-up menu
    expect(sendButton()).toBe(send);
    expect(send.disabled).toBe(true);
    expect(container.querySelector("[data-composer-glyph-ghost]")).toBeNull();
    expect(container.querySelector("[data-composer-row]")!.hasAttribute("data-glyph-swap")).toBe(false);
    const sent = fixture.dispatch.mock.calls.map(([action]) => action).find((action) => action.type === "send")!;
    expect(sent).toMatchObject({ text: "hello", onSettled: expect.any(Function) });
    flushSync(() => sent.onSettled());
    expect(sendButton()).toBeNull();
    const ghost = container.querySelector("[data-composer-glyph-ghost]")!;
    expect(ghost.getAttribute("aria-hidden")).toBe("true");
    expect(ghost.querySelector(".composer-glyph-out")).not.toBeNull();
  });

  it("lets go of a held Send when the send fails, and on its own after a send the server never answers", () => {
    vi.useFakeTimers();
    try {
      restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "hello", attachments: [] });
      render({ bot });
      click(sendButton());
      expect(sendButton()!.disabled).toBe(true);
      flushSync(() => { vi.advanceTimersByTime(SEND_HOLD_MAX_MS); });
      expect(sendButton()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds no Send for a message sent with no network: it waits in its own bubble and the field is free at once", () => {
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    try {
      restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "hello", attachments: [] });
      render({ bot });
      click(sendButton());
      expect(sendButton()).toBeNull();
    } finally {
      online.mockRestore();
    }
  });

  it("never shows Stop while the bot works: only voice and send, typed or not", () => {
    const busy = { ...bot, busy: true };
    render({ bot: busy });
    expect(container.querySelector("[data-composer-stop]")).toBeNull();
    expect(container.querySelector('[data-voice-mic="start"]')).not.toBeNull();

    restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "and also this", attachments: [] });
    render({ bot: busy });
    expect(container.querySelector("[data-composer-stop]")).toBeNull();
    expect(container.querySelector('[data-voice-mic="start"]')).not.toBeNull();
  });

  it("shows the approval level as a chip only while this conversation overrides the bot, in the panel's words", () => {
    render({ bot: { ...bot, approvalMode: "full" } });
    expect(container.querySelector("[data-approval-chip]")).toBeNull();
    const task = { threadId: bot.threadId, title: "new thread", createdAt: 1 };
    render({ bot: { ...bot, tasks: [{ ...task, approvalMode: "full" }] } });
    const chip = container.querySelector("[data-approval-chip]")!;
    expect(chip.getAttribute("data-approval-chip")).toBe("full");
    expect(chip.textContent).toBe("Just do it");
    click(chip.closest("button"));
    const level = popover()!;
    expect(level.textContent).toContain("Ask me first");
    expect(level.textContent).toContain("Command allowlist");
    expect(level.querySelector('[data-menu-key="approval:full"] .gi-check')).not.toBeNull();
    click(level.querySelector('[data-menu-key="approval:ask"]'));
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "updateTask", botId: "atlas", threadId: "atlas-thread", patch: { approvalMode: "ask" } });
  });

  it("shows Work until done as a quiet neutral chip with a × only while it is on, and turns it off from there", () => {
    restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "", attachments: [], channelMode: "goal" });
    render({ bot });
    const chip = container.querySelector<HTMLButtonElement>("[data-goal-chip]")!;
    expect(chip.textContent).toBe("Work until done");
    expect(chip.querySelector(".gi-x")).not.toBeNull();
    expect(chip.getAttribute("aria-label")).toBe("Turn off work until done");
    expect(chip.hasAttribute("aria-pressed")).toBe(false);
    expect(chip.className.split(" ")).toEqual(expect.arrayContaining(["h-7", "rounded-full", "bg-ink/[0.06]", "text-ink-secondary", "text-[13px]"]));
    expect(chip.className).not.toMatch(/accent/);
    click(chip);
    expect(container.querySelector("[data-goal-chip]")).toBeNull();
  });

  it("turns a typed /goal into the chip, leaving only the goal itself in the field", () => {
    render({ bot });
    const field = container.querySelector("textarea")!;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "/goal ship the release");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector("[data-goal-chip]")?.textContent).toBe("Work until done");
    expect(container.querySelector("textarea")!.value).toBe("ship the release");
  });
});

describe("the composer after Set me up", () => {
  it("asks for the job and shows a chip to stop it while the conversation waits, and neither once it does not", () => {
    render({ bot: { ...bot, tasks: [{ threadId: bot.threadId, title: "new thread", createdAt: 1, setupRequest: { at: 2 } }] } });
    expect(container.querySelector("textarea")!.getAttribute("placeholder")).toBe("Tell Atlas what you'd like help with");
    expect(container.querySelector("[data-setup-request]")?.textContent).toContain("Atlas is ready to be set up");
    expect(container.querySelector(`[aria-label="Stop setting up Atlas"]`)).not.toBeNull();
    render({ bot: { ...bot, tasks: [{ threadId: bot.threadId, title: "new thread", createdAt: 1 }] } });
    expect(container.querySelector("textarea")!.getAttribute("placeholder")).toBe("Message Atlas");
    expect(container.querySelector("[data-setup-request]")).toBeNull();
  });
});

describe("the Simple composer in a group chat", () => {
  it("turns a typed /goal into Finish together and keeps its chip in view while it is on", () => {
    render({ group: room, members: [bot, peer] });
    expect(container.querySelector("[data-goal-chip]")).toBeNull();
    expect(container.querySelector("textarea")!.getAttribute("placeholder")).toBe("Message Launch planning");
    restoreComposerDraft(`group:${room.id}:${room.threadId}`, { text: "hello room", attachments: [] });
    render({ group: room, members: [bot, peer] });
    const send = sendButton()!;
    expect(send.className.split(" ")).not.toContain(BOT_BUTTON);
    expect(send.style.backgroundColor).toBe("var(--color-accent)");
    expect(send.style.color).toBe("var(--color-accent-ink)");
    restoreComposerDraft(`group:${room.id}:${room.threadId}`, { text: "", attachments: [] });
    render({ group: room, members: [bot, peer] });
    expect(plus()?.getAttribute("aria-label")).toBe("Attach files");
    const field = container.querySelector("textarea")!;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "/goal ");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const chip = container.querySelector("[data-goal-chip]");
    expect(chip?.getAttribute("aria-label")).toBe("Turn off finish together");
    expect(container.querySelector("textarea")!.getAttribute("placeholder")).toContain("finish together");
    click(chip);
    expect(container.querySelector("[data-goal-chip]")).toBeNull();
  });

  it("keeps the room's @ hint only when the room answers to mentions", () => {
    render({ group: { ...room, defaultResponder: { kind: "mentions" } }, members: [bot, peer] });
    expect(container.querySelector("textarea")!.getAttribute("placeholder")).toBe("Message Launch planning (@ to bring a bot in)");
  });
});


describe("the composer", () => {
  describe("with a message longer than one line", () => {
    const type = (value: string) => {
      const field = container.querySelector("textarea")!;
      flushSync(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    const classes = (selector: string) => container.querySelector(selector)!.className.split(" ");
    const stacked = () => classes(".mention-editor").includes("basis-full");
    /** A field 20 characters wide: longer text wraps onto a second 24px line. */
    const wrapPast20 = () => vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get")
      .mockImplementation(function (this: HTMLTextAreaElement) { return this.value.length > 20 ? 48 : 24; });

    it("measures each new message afresh, so a wrap from a narrower composer does not stick", () => {
      const wrap = wrapPast20();
      render({ bot });
      type("a".repeat(25));
      expect(stacked()).toBe(true);
      type("");
      // Wider now: 30 characters fit on the one row.
      wrap.mockImplementation(function (this: HTMLTextAreaElement) { return this.value.length > 40 ? 48 : 24; });
      type("a".repeat(30));
      expect(stacked()).toBe(false);
    });

    it("never stacks an empty field, even when its placeholder wraps", () => {
      vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockReturnValue(48);
      render({ bot });
      expect(stacked()).toBe(false);
    });

    it("gives the text the pill's full width above the + and the round button", () => {
      wrapPast20();
      render({ bot });
      type("a".repeat(25) + "\nb");
      expect(stacked()).toBe(true);
      expect(classes("[data-composer-row]")).toContain("flex-wrap");
      expect(classes("textarea")).toEqual(expect.arrayContaining(["px-1", "pt-1", "pb-0"]));
      // grok's composer stays open while any text is left, and closes to one row only once the field is empty
      type("short");
      expect(stacked()).toBe(true);
      expect(container.querySelector('[data-tour="composer"]')!.className.split(" ")).toContain("rounded-[18px]");
      type("");
      expect(stacked()).toBe(false);
      expect(container.querySelector('[data-tour="composer"]')!.className.split(" ")).toContain("rounded-[22px]");
    });
  });
});
