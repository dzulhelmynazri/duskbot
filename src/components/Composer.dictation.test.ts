// @vitest-environment happy-dom
import { act, createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import { restoreComposerDraft } from "@/lib/drafts";
import { t } from "@/lib/i18n";
import { DEFAULT_VOICE_PREFS, setVoicePrefs, voicePrefs } from "@/lib/voice-input/prefs";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), settings: { appSettingsOpen: false, appSettingsSection: "general" } }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, bots: [bot], instances: [{
      instanceId: "fake", driverKind: "claude", displayName: "Fake", capabilities: {},
    }], ...fixture.settings },
    dispatch: fixture.dispatch,
  }) };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/use-slash-skills", () => ({ useSlashSkills: () => [] }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => false }));
vi.mock("./CallView", () => ({ CallButton: () => null }));
// A whole capabilities object: Advanced mode (on whenever a saved draft exists) renders the place chip, which reads
// host.platform.
vi.mock("./DesktopCapabilities", async () => {
  const { initialDesktopCapabilities } = await import("@/lib/desktop");
  const capabilities = { ...initialDesktopCapabilities(), dictation: { available: true, engine: "apple-speech", onDevice: true } };
  return { useDesktopCapabilities: () => ({ capabilities, ready: true }) };
});

import { Composer } from "./Composer";

const bot: Bot = {
  id: "dictation-bot", threadId: "dictation-thread", name: "Fixture", title: "", description: "",
  color: "blue", notifications: false, unread: false, busy: false, messages: [],
  modelSelection: { instanceId: "fake", model: "fake" },
};
const draftId = `bot:${bot.id}:${bot.threadId}`;
type Transcript = { partial?: boolean; text?: string; error?: string };

describe("voice input in the real composer", () => {
  let root: Root;
  let container: HTMLDivElement;
  let transcript: (line: Transcript) => void;
  let end: (info: { code: number; reason?: string }) => void;
  let level: ((value: number) => void) | undefined;
  let speechStop: ReturnType<typeof vi.fn>;
  let speechStart: ReturnType<typeof vi.fn>;
  let speechFinish: ReturnType<typeof vi.fn>;

  const input = () => container.querySelector("textarea")!;
  const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  const click = (label: string) => flushSync(() => button(label)!.click());
  const hear = (text: string) => flushSync(() => transcript({ text, partial: true }));
  const preview = () => container.querySelector("[data-voice-preview]")?.textContent ?? null;
  const key = (init: KeyboardEventInit) => flushSync(() => window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init })));
  const mount = () => flushSync(() => root.render(createElement(Composer, { bot })));

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    speechStop = vi.fn().mockResolvedValue(undefined);
    speechStart = vi.fn().mockResolvedValue(undefined);
    speechFinish = vi.fn().mockResolvedValue(undefined);
    level = undefined;
    setVoicePrefs({ ...DEFAULT_VOICE_PREFS, firstRunSeen: true });
    window.madaniDesktop = {
      platform: "darwin",
      speechStart, speechStop, speechFinish,
      onSpeechTranscript: (cb: typeof transcript) => { transcript = cb; return vi.fn(); },
      onSpeechEnd: (cb: typeof end) => { end = cb; return vi.fn(); },
      onSpeechLevel: (cb: (value: number) => void) => { level = cb; return vi.fn(); },
    } as unknown as typeof window.madaniDesktop;
    restoreComposerDraft(draftId, { text: "", attachments: [] });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    mount();
  });

  const start = () => {
    click(t("composer.dictation.start"));
    expect(speechStart).toHaveBeenCalledOnce();
  };

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    restoreComposerDraft(draftId, { text: "", attachments: [] });
    restoreComposerDraft(`bot:${bot.id}:other-thread`, { text: "", attachments: [] });
    setVoicePrefs(DEFAULT_VOICE_PREFS);
    delete window.madaniDesktop;
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows a waveform and one line of the latest words while talking, and leaves the draft alone", () => {
    start();
    expect(container.querySelector("[data-voice-waveform]")).not.toBeNull();
    expect(preview()).toBe(t("composer.placeholder.listening"));
    expect(level).toBeTypeOf("function");
    hear("first words");
    expect(preview()).toBe("first words");
    const long = "so this is a much longer thought that keeps going well past what one line of the chat bar can hold at once";
    hear(long);
    expect(preview()!.startsWith("…")).toBe(true);
    expect(long.endsWith(preview()!.slice(1))).toBe(true);
    expect(input().value).toBe("");
  });

  it("lands the heard words at once on Done, then takes the recognizer's final words", () => {
    start();
    hear("hello there");
    click(t("composer.dictation.stop"));
    expect(input().value).toBe("hello there");
    expect(speechFinish).toHaveBeenCalledOnce();
    expect(container.querySelector("[data-composer-voice]")).toBeNull();
    flushSync(() => transcript({ text: "Hello there.", partial: false }));
    flushSync(() => end({ code: 0, reason: "completed" }));
    expect(input().value).toBe("Hello there.");
  });

  it("does not let a late final overwrite an edit made after the words landed", () => {
    start();
    hear("draft words");
    click(t("composer.dictation.stop"));
    flushSync(() => restoreComposerDraft(draftId, { text: "edited by hand", attachments: [] }));
    flushSync(() => transcript({ text: "Draft words.", partial: false }));
    expect(input().value).toBe("edited by hand");
  });

  it("ignores empty partial and final callbacks", () => {
    start();
    hear("ここまで入力した文章。");
    hear("");
    flushSync(() => transcript({ text: "", partial: false }));
    expect(preview()).toBe("ここまで入力した文章。");
    click(t("composer.dictation.stop"));
    expect(input().value).toBe("ここまで入力した文章。");
  });

  it("sends what was heard on the send key and rejects late speech and end events", () => {
    start();
    hear("送信する文章。");
    key({ key: "Enter" });
    expect(speechStop).toHaveBeenCalled();
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "send", text: "送信する文章。" }));
    expect(input().value).toBe("");
    hear("送った後の独り言。");
    flushSync(() => end({ code: 1, reason: "recognition-error" }));
    expect(input().value).toBe("");
    expect(button(t("composer.dictation.start"))).not.toBeNull();
    expect(container.textContent).not.toContain(t("composer.dictation.failed"));
  });

  it("in the phone app listening shows only discard and keep, and keep leaves the words in the field", () => {
    document.documentElement.dataset.mobileApp = "ios";
    try {
      start();
      hear("call the dentist");
      expect(container.querySelector("[data-composer-send]")).toBeNull();
      expect(container.querySelector('button[data-voice-mic="send"]')).toBeNull();
      expect(container.querySelector("[data-composer-discard]")).not.toBeNull();
      click(t("composer.dictation.stop"));
      expect(input().value).toBe("call the dentist");
      expect(fixture.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "send" }));
    } finally {
      delete document.documentElement.dataset.mobileApp;
    }
  });

  it("cancels on Esc: listening stops and nothing lands", () => {
    start();
    hear("never mind");
    key({ key: "Escape" });
    expect(speechStop).toHaveBeenCalled();
    expect(input().value).toBe("");
    expect(container.querySelector("[data-composer-voice]")).toBeNull();
    hear("late words");
    expect(input().value).toBe("");
  });

  it("starts and finishes with the keyboard shortcut", () => {
    key({ key: "d", code: "KeyD", metaKey: true, shiftKey: true });
    expect(speechStart).toHaveBeenCalledOnce();
    hear("by shortcut");
    key({ key: "d", code: "KeyD", metaKey: true, shiftKey: true });
    expect(input().value).toBe("by shortcut");
  });

  it("can start again after Done, and an old session's callbacks are ignored", () => {
    start();
    hear("最初の文章。");
    click(t("composer.dictation.stop"));
    const late = transcript;
    click(t("composer.dictation.start"));
    flushSync(() => late({ text: "古いセッション", partial: true }));
    hear("追加の文章。");
    click(t("composer.dictation.stop"));
    expect(input().value).toBe("最初の文章。 追加の文章。");
  });

  it("puts a live session's words in the chat they were said in when the chat changes", async () => {
    start();
    hear("元スレッドの文章。");
    const previous = transcript;
    flushSync(() => root.render(createElement(Composer, { bot: { ...bot, threadId: "other-thread" } })));
    await expect.poll(() => input().value).toBe("");
    expect(speechStop).toHaveBeenCalled();
    flushSync(() => previous({ text: "元スレッドの遅い結果。", partial: true }));
    expect(input().value).toBe("");
    flushSync(() => root.render(createElement(Composer, { bot })));
    await expect.poll(() => input().value).toBe("元スレッドの文章。");
  });

  it("says which permission to turn on when the microphone could not be used", () => {
    start();
    flushSync(() => end({ code: 1, reason: "mic-failed" }));
    expect(container.textContent).toContain("Privacy & Security → Microphone");
    expect(container.textContent).not.toContain(t("composer.dictation.failed"));
  });

  it("says a refused microphone in one line with a button to System Settings", () => {
    const permOpenSettings = vi.fn().mockResolvedValue(undefined);
    Object.assign(window.madaniDesktop!, { permOpenSettings });
    start();
    flushSync(() => end({ code: 1, reason: "mic-denied" }));
    expect(container.textContent).toContain(t("composer.voice.micDenied"));
    const open = container.querySelector<HTMLButtonElement>('[data-open-system-settings="mic"]')!;
    expect(open.textContent).toBe(t("permissions.openSystemSettings"));
    flushSync(() => open.click());
    expect(permOpenSettings).toHaveBeenCalledWith("mic");
  });

  it("keeps the heard words when recognition ends in an error", () => {
    start();
    hear("失敗しても残す文章。");
    flushSync(() => end({ code: 1, reason: "recognition-error" }));
    expect(input().value).toBe("失敗しても残す文章。");
    expect(container.textContent).toContain(t("composer.dictation.failed"));
  });
});

describe("the first tap on the mic", () => {
  let root: Root;
  let container: HTMLDivElement;
  let speechStart: ReturnType<typeof vi.fn>;
  const dialog = () => document.querySelector<HTMLElement>('[data-panel-modal="voice-first-run"]');

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    setVoicePrefs(DEFAULT_VOICE_PREFS);
    speechStart = vi.fn().mockResolvedValue(undefined);
    window.madaniDesktop = {
      platform: "darwin", speechStart, speechStop: vi.fn().mockResolvedValue(undefined), speechFinish: vi.fn().mockResolvedValue(undefined),
      onSpeechTranscript: () => vi.fn(), onSpeechEnd: () => vi.fn(),
    } as unknown as typeof window.madaniDesktop;
    restoreComposerDraft(draftId, { text: "", attachments: [] });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    flushSync(() => root.render(createElement(Composer, { bot })));
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    setVoicePrefs(DEFAULT_VOICE_PREFS);
    delete window.madaniDesktop;
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const tapMic = () => flushSync(() => container.querySelector<HTMLButtonElement>(`button[aria-label="${t("composer.dictation.start")}"]`)!.click());

  // the sheet eases out: it takes no more presses the moment it is answered, and is gone once it has faded
  const leaves = async () => {
    expect(dialog()?.closest("[data-leaving]")?.hasAttribute("inert")).toBe(true);
    await vi.waitFor(() => expect(dialog()).toBeNull());
  };

  it("says the Mac's own transcription listens, then starts on Continue and never shows again", async () => {
    tapMic();
    expect(dialog()?.textContent).toContain(t("composer.voice.firstRun.mac"));
    expect(speechStart).not.toHaveBeenCalled();
    const go = [...dialog()!.querySelectorAll("button")].find((b) => b.textContent === t("composer.voice.firstRun.continue"))!;
    flushSync(() => go.click());
    // listening starts at once, under the leaving sheet; a second press on it does nothing
    expect(speechStart).toHaveBeenCalledOnce();
    flushSync(() => go.click());
    expect(speechStart).toHaveBeenCalledOnce();
    await leaves();
    expect(voicePrefs().firstRunSeen).toBe(true);
    flushSync(() => container.querySelector<HTMLButtonElement>(`button[aria-label="${t("composer.dictation.stop")}"]`)!.click());
    tapMic();
    expect(dialog()).toBeNull();
    expect(speechStart).toHaveBeenCalledTimes(2);
  });

  it("opens Settings > Voice from its quiet link without listening", async () => {
    tapMic();
    flushSync(() => dialog()!.querySelector<HTMLButtonElement>("[data-voice-setup]")!.click());
    await leaves();
    expect(speechStart).not.toHaveBeenCalled();
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "toggleAppSettings", open: true, section: "voice" }));
    expect(voicePrefs().firstRunSeen).toBe(true);
  });
});

describe("a computer where nothing can listen", () => {
  let root: Root;
  let container: HTMLDivElement;
  let speechStart: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    setVoicePrefs({ ...DEFAULT_VOICE_PREFS, firstRunSeen: true });
    speechStart = vi.fn().mockResolvedValue(undefined);
    // Linux has no recognizer of its own, and this server has no listening key
    window.madaniDesktop = {
      platform: "linux", speechStart, speechStop: vi.fn().mockResolvedValue(undefined), speechFinish: vi.fn().mockResolvedValue(undefined),
      onSpeechTranscript: () => vi.fn(), onSpeechEnd: () => vi.fn(),
    } as unknown as typeof window.madaniDesktop;
    restoreComposerDraft(draftId, { text: "", attachments: [] });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    flushSync(() => root.render(createElement(Composer, { bot })));
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    setVoicePrefs(DEFAULT_VOICE_PREFS);
    delete window.madaniDesktop;
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const pressMic = () => flushSync(() => container.querySelector<HTMLButtonElement>(`button[aria-label="${t("composer.dictation.start")}"]`)!.click());
  const note = () => container.querySelector<HTMLElement>("[data-speech-note]");

  it("says so plainly on a card with a button that opens Settings at Voice, and the button closes it", () => {
    expect(note()).toBeNull();
    pressMic();
    expect(speechStart).not.toHaveBeenCalled();
    const card = note()!.querySelector<HTMLElement>("[data-chat-error]")!;
    expect(card.textContent).toContain(t("composer.voice.unavailableTitle"));
    expect(card.textContent).toContain(t("composer.voice.noRecognizer"));
    expect(container.textContent?.toLowerCase()).not.toContain("settings > voice");
    const choose = card.querySelector<HTMLButtonElement>("[data-open-voice-settings]")!;
    expect(choose.textContent).toBe(t("composer.voice.chooseService"));
    flushSync(() => choose.click());
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "toggleAppSettings", open: true, section: "voice" }));
    expect(note()).toBeNull();
  });

  it("the cross closes it, and only another failed press brings it back", () => {
    pressMic();
    flushSync(() => note()!.querySelector<HTMLButtonElement>(`button[aria-label="${t("chat.error.dismiss")}"]`)!.click());
    expect(note()).toBeNull();
    flushSync(() => root.render(createElement(Composer, { bot })));
    expect(note()).toBeNull();
    pressMic();
    expect(note()).not.toBeNull();
  });

  it("goes away once Settings opens at Voice some other way", async () => {
    pressMic();
    expect(note()).not.toBeNull();
    fixture.settings = { appSettingsOpen: true, appSettingsSection: "voice" };
    try {
      await act(async () => root.render(createElement(Composer, { bot })));
      expect(note()).toBeNull();
    } finally {
      fixture.settings = { appSettingsOpen: false, appSettingsSection: "general" };
    }
  });
});
