// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import { restoreComposerDraft } from "@/lib/drafts";
import { t } from "@/lib/i18n";
import { DEFAULT_VOICE_PREFS, setVoicePrefs } from "@/lib/voice-input/prefs";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  return { dispatch: vi.fn() };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, bots: [bot], instances: [{
      instanceId: "fake", driverKind: "claude", displayName: "Fake", capabilities: {},
    }] },
    dispatch: fixture.dispatch,
  }) };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/use-slash-skills", () => ({ useSlashSkills: () => [] }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => false }));
vi.mock("./CallView", () => ({ CallButton: () => null }));
vi.mock("./DesktopCapabilities", async () => {
  const { initialDesktopCapabilities } = await import("@/lib/desktop");
  const capabilities = { ...initialDesktopCapabilities(), dictation: { available: true, engine: "apple-speech", onDevice: true } };
  return { useDesktopCapabilities: () => ({ capabilities, ready: true }) };
});

import { Composer } from "./Composer";

const bot: Bot = {
  id: "busy-dictation-bot", threadId: "busy-dictation-thread", name: "Fixture", title: "", description: "",
  color: "blue", notifications: false, unread: false, busy: true, messages: [],
  modelSelection: { instanceId: "fake", model: "fake" },
};
const draftId = `bot:${bot.id}:${bot.threadId}`;

describe("dictation while the bot works", () => {
  let root: Root;
  let container: HTMLDivElement;
  let transcript: (line: { partial?: boolean; text?: string }) => void;
  let speechStop: ReturnType<typeof vi.fn>;

  const input = () => container.querySelector("textarea")!;
  const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  const click = (label: string) => flushSync(() => button(label)!.click());
  const hear = (text: string) => flushSync(() => transcript({ text, partial: true }));
  const mount = (draft: string) => {
    restoreComposerDraft(draftId, { text: draft, attachments: [] });
    flushSync(() => root.render(createElement(Composer, { bot })));
  };

  beforeEach(() => {
    globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    speechStop = vi.fn().mockResolvedValue(undefined);
    setVoicePrefs({ firstRunSeen: true });
    window.madaniDesktop = {
      platform: "darwin",
      speechStart: vi.fn().mockResolvedValue(undefined), speechStop,
      onSpeechTranscript: (cb: typeof transcript) => { transcript = cb; return vi.fn(); },
      onSpeechEnd: () => vi.fn(),
    } as unknown as typeof window.madaniDesktop;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    restoreComposerDraft(draftId, { text: "", attachments: [] });
    delete window.madaniDesktop;
    setVoicePrefs(DEFAULT_VOICE_PREFS);
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("shows no Stop while the bot works, and a dictated line goes out as the follow-up", () => {
    mount("");
    expect(button(t("chat.stopTurn"))).toBeNull();
    click(t("composer.dictation.start"));
    hear("also check the footer");
    flushSync(() => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(speechStop).toHaveBeenCalled();
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "send", text: "also check the footer", followUp: "steer" }));
  });

  it("offers discard only while recording, and it brings back the draft from before", () => {
    mount("typed first");
    expect(button(t("composer.dictation.discard"))).toBeNull();
    click(t("composer.dictation.start"));
    hear("then said this");
    // the words wait on the voice line until they are done; the draft stays as typed
    expect(input().value).toBe("typed first");
    expect(container.querySelector("[data-voice-preview]")?.textContent).toBe("then said this");
    click(t("composer.dictation.discard"));
    expect(speechStop).toHaveBeenCalled();
    expect(input().value).toBe("typed first");
    expect(button(t("composer.dictation.discard"))).toBeNull();
    hear("a late result");
    expect(input().value).toBe("typed first");
  });

  it("Esc cancels: nothing that was said lands", () => {
    mount("");
    click(t("composer.dictation.start"));
    hear("drop this");
    flushSync(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(input().value).toBe("");
    expect(speechStop).toHaveBeenCalled();
    expect(button(t("composer.dictation.start"))).not.toBeNull();
  });
});
