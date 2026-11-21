// @vitest-environment happy-dom
import { createElement, useRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyGlassGlyphs, buttonKind, composerButtons, covered, cssColor, cssHex, darkGround, frameOf, REASSERT_MS, restingFrame, transcriptRoom, typeInto, useNativeGlass, type GlassBridge, type GlassEvent, type GlassState } from "./native-glass";
import type { SlidePath } from "./NavStack";
import type { MobilePlatform } from "./platform";

const rects = new WeakMap<Element, DOMRect>();
function place(el: Element, x: number, y: number, w: number, h: number) {
  rects.set(el, { x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON() {} } as DOMRect);
}

let frames: FrameRequestCallback[] = [];
const runFrame = () => { const due = frames; frames = []; for (const cb of due) cb(performance.now()); };

beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return rects.get(this) ?? ({ x: 0, y: 0, left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, toJSON() {} } as DOMRect);
  });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
  vi.stubGlobal("cancelAnimationFrame", () => { frames = []; });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 390 });
  Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 844 });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  frames = [];
  document.body.innerHTML = "";
});

describe("rects", () => {
  it("measures in css px, rounded to half a point", () => {
    const el = document.createElement("div");
    place(el, 12.26, 59.74, 44, 44);
    expect(frameOf(el)).toEqual({ x: 12.5, y: 59.5, w: 44, h: 44 });
  });

  it("measures a control where it rests: off its page's offset, and at full size while a press scales it", () => {
    const el = document.createElement("button");
    Object.defineProperty(el, "offsetWidth", { value: 44 });
    Object.defineProperty(el, "offsetHeight", { value: 44 });
    // pressed to .96 around its centre, on a page 200px into its slide
    place(el, 212 + 0.88, 59 + 0.88, 42.24, 42.24);
    expect(restingFrame(el, 200)).toEqual({ x: 12, y: 59, w: 44, h: 44 });
  });

  it("is covered when something outside the chat is on top of it, not when the chat's own content is", () => {
    const chat = document.createElement("div");
    const pill = document.createElement("button");
    const sheet = document.createElement("div");
    chat.appendChild(pill);
    document.body.append(chat, sheet);
    place(pill, 100, 60, 120, 44);
    document.elementFromPoint = () => pill;
    expect(covered(pill, chat)).toBe(false);
    document.elementFromPoint = () => sheet;
    expect(covered(pill, chat)).toBe(true);
  });

  it("is not covered while it slides in from off screen", () => {
    const chat = document.createElement("div");
    const pill = document.createElement("button");
    chat.appendChild(pill);
    place(pill, 500, 60, 120, 44);
    document.elementFromPoint = () => document.body;
    expect(covered(pill, chat)).toBe(false);
  });
});

describe("composer buttons", () => {
  const button = (attrs: Record<string, string>, wrap?: string) => {
    const el = document.createElement("button");
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (!wrap) return el;
    const parent = document.createElement("div");
    parent.setAttribute(wrap, "");
    parent.appendChild(el);
    return el;
  };

  it("names each control's native twin", () => {
    expect(buttonKind(button({ "data-voice-mic": "start" }))).toBe("mic");
    expect(buttonKind(button({ "data-voice-mic": "send" }))).toBe("micSend");
    expect(buttonKind(button({ "data-composer-send": "" }))).toBe("send");
    expect(buttonKind(button({ "data-composer-send": "waits" }))).toBe("waits");
    expect(buttonKind(button({ "data-composer-stop": "beside" }))).toBe("stop");
    expect(buttonKind(button({ "data-composer-discard": "" }))).toBe("discard");
    expect(buttonKind(button({ "aria-haspopup": "menu" }, "data-composer-follow-up"))).toBe("followUp");
    expect(buttonKind(button({ "data-call-button": "composer" })), "the call keeps the composer native while the field is empty").toBe("call");
    expect(buttonKind(button({ "data-call-button": "composer", "data-call-active": "" }))).toBe("hangUp");
    expect(buttonKind(button({ "aria-label": "Help" }))).toBeNull();
  });

  it("leaves the composer to the page when one control has no twin", () => {
    const actions = document.createElement("div");
    actions.append(button({ "data-voice-mic": "start" }), button({ "aria-label": "Help" }));
    expect(composerButtons(actions)).toBeNull();
    actions.lastElementChild!.remove();
    actions.append(button({ "data-composer-send": "", disabled: "" }));
    expect(composerButtons(actions)?.buttons).toEqual([
      { kind: "mic", disabled: false, label: "" },
      { kind: "send", disabled: true, label: "" },
    ]);
  });
});

describe("colours", () => {
  it("reads the page's computed colours as hex, and nothing for a clear one", () => {
    expect(cssHex("rgb(18, 111, 212)")).toBe("#126fd4");
    expect(cssHex("rgba(0, 0, 0, 0)")).toBeNull();
    expect(cssHex("rgb(28 28 28 / 0.9)")).toBe("#1c1c1c");
    expect(cssHex("#FDFDFD")).toBe("#fdfdfd");
    expect(cssHex("")).toBeNull();
  });

  it("follows the app's own ground for light and dark, whatever the system says", () => {
    expect(darkGround("#fdfdfd")).toBe(false);
    expect(darkGround("#121212")).toBe(true);
    expect(darkGround(null)).toBeNull();
  });

  it("hands each button's fill and ink to its native twin", () => {
    const actions = document.createElement("div");
    const send = document.createElement("button");
    send.setAttribute("data-composer-send", "");
    send.style.backgroundColor = "rgb(0, 133, 74)";
    send.style.color = "rgb(255, 255, 255)";
    actions.append(send);
    document.body.append(actions);
    expect(composerButtons(actions)?.buttons[0]).toMatchObject({ kind: "send", fill: "#00854a", ink: "#ffffff" });
  });

  it("keeps a see-through fill and ink see-through, as the resting mic's quiet disc", () => {
    expect(cssColor("rgba(24, 24, 32, 0.055)")).toBe("#1818200e");
    expect(cssColor("rgba(28, 28, 28, 0.68)")).toBe("#1c1c1cad");
    expect(cssColor("rgb(28, 28, 28)")).toBe("#1c1c1c");
    expect(cssColor("rgba(0, 0, 0, 0)")).toBeNull();
  });

  it("reads where a colour transition or handoff is heading, not the frame it is on", () => {
    const actions = document.createElement("div");
    const send = document.createElement("button");
    send.setAttribute("data-composer-send", "");
    send.style.backgroundColor = "rgb(5, 140, 80)";
    actions.append(send);
    document.body.append(actions);
    const effect = Object.create(KeyframeEffect.prototype) as KeyframeEffect;
    effect.getKeyframes = () => [{ backgroundColor: "rgb(0, 133, 74)" }, { backgroundColor: "rgb(10, 150, 90)" }] as unknown as ComputedKeyframe[];
    send.getAnimations = () => [{ effect } as unknown as Animation];
    expect(composerButtons(actions)?.buttons[0]?.fill).toBe("#0a965a");
  });
});

describe("typing", () => {
  it("sets the field and fires input, once per change", () => {
    const field = document.createElement("textarea");
    const input = vi.fn();
    field.addEventListener("input", input);
    typeInto(field, "hi");
    typeInto(field, "hi");
    expect(field.value).toBe("hi");
    expect(input).toHaveBeenCalledTimes(1);
  });
});

function fakeGlass() {
  let listener: ((event: GlassEvent) => void) | null = null;
  const glass = {
    update: vi.fn<(state: GlassState) => void>(),
    setText: vi.fn<(text: string, seq: number) => void>(),
    clearText: vi.fn<(id: number) => void>(),
    setAvatar: vi.fn(),
    focus: vi.fn(),
    blur: vi.fn(),
    clear: vi.fn(),
    slide: vi.fn<(path: SlidePath | null, at?: number) => void>(),
    onEvent: (fn: (event: GlassEvent) => void) => { listener = fn; return () => { listener = null; }; },
  } satisfies GlassBridge;
  return { glass, send: (event: GlassEvent) => listener?.(event) };
}

let slideGlass: (path: SlidePath | null) => void = () => {};

function Chat({ platform }: { platform: MobilePlatform }) {
  const ref = useRef<HTMLDivElement>(null);
  slideGlass = useNativeGlass(platform, ref, true);
  return createElement("div", { ref, className: "madani-mobile" },
    createElement("div", { className: "mobile-page", id: "page" }, createElement("div", { "data-mobile-chat": "", id: "chat" },
      createElement("nav", { "data-glass-nav": "" },
        createElement("button", { "data-glass": "back", id: "back" }),
        createElement("button", { "data-glass": "title", id: "title" },
          createElement("span", { "data-glass-avatar": "" }),
          createElement("span", { "data-glass-name": "" }, "Manager")),
        createElement("button", { "data-glass": "right", id: "right" })),
      createElement("div", { "data-grok-inset": "", id: "dock" }, createElement("div", { "data-tour": "composer", id: "shell" },
        createElement("button", { id: "plus" }, createElement("span", { "data-composer-plus": "" })),
        createElement("div", null,
          createElement("div", { "data-composer-row": "" },
            createElement("textarea", { id: "field", placeholder: "Message Manager", enterKeyHint: "send", defaultValue: "" }),
            createElement("div", { "data-composer-actions": "" },
              createElement("button", { "data-voice-mic": "start", "aria-label": "Dictate", id: "mic" })))))))));
}

describe("useNativeGlass", () => {
  let root: Root;
  let host: HTMLDivElement;

  function mount(acks = false) {
    const { glass, send } = fakeGlass();
    if (acks) Object.assign(glass, { acks: true });
    const platform = { kind: "ios", native: true, glass } as unknown as MobilePlatform;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    flushSync(() => root.render(createElement(Chat, { platform })));
    const $ = (id: string) => document.getElementById(id)!;
    place($("back"), 12, 59, 44, 44);
    place($("title"), 120, 59, 150, 44);
    place($("right"), 334, 59, 44, 44);
    place($("shell"), 10, 760, 370, 48);
    document.elementFromPoint = (_x, y) => (y > 700 ? $("field") : $("title"));
    return { glass, send, $ };
  }

  afterEach(() => { flushSync(() => root.unmount()); });

  it("sends the header and composer frames, and again only when they move", () => {
    const { glass, $ } = mount();
    runFrame();
    expect(glass.update).toHaveBeenCalledTimes(1);
    const state = glass.update.mock.calls[0]![0];
    expect(state.header).toMatchObject({ back: { x: 12, y: 59, w: 44, h: 44 }, title: { x: 120, w: 150 }, right: { x: 334 }, name: "Manager" });
    expect(state.composer).toMatchObject({ frame: { x: 10, y: 760, w: 370, h: 48 }, plus: true, placeholder: "Message Manager", returnSends: true, voice: null, buttons: [{ kind: "mic", disabled: false, label: "Dictate" }] });
    expect(document.documentElement.dataset.nativeGlassHeader).toBe("");
    expect(document.documentElement.dataset.nativeGlassComposer).toBe("");
    runFrame();
    expect(glass.update).toHaveBeenCalledTimes(1);
    place($("back"), 100, 59, 44, 44);
    runFrame();
    expect(glass.update).toHaveBeenCalledTimes(2);
    expect(glass.update.mock.calls[1]![0].header?.back.x).toBe(100);
  });

  it("measures a resting chat a few times a second, and every frame once something outside its transcript changes", async () => {
    const { glass, $ } = mount();
    const log = document.createElement("div");
    log.setAttribute("role", "log");
    $("chat").prepend(log);
    await new Promise((done) => setTimeout(done, 0));
    for (let i = 0; i < 31; i += 1) runFrame();
    const sent = glass.update.mock.calls.length;
    place($("back"), 100, 59, 44, 44);
    runFrame();
    expect(glass.update).toHaveBeenCalledTimes(sent);
    log.append("a reply streaming in");
    await new Promise((done) => setTimeout(done, 0));
    runFrame();
    expect(glass.update).toHaveBeenCalledTimes(sent);
    $("shell").dataset.multiline = "";
    await new Promise((done) => setTimeout(done, 0));
    runFrame();
    expect(glass.update).toHaveBeenCalledTimes(sent + 1);
    expect(glass.update.mock.lastCall![0].header?.back.x).toBe(100);
  });

  it("sends frames where they rest on the page and the page's offset, and nothing while the native side plays a slide", () => {
    const { glass, $ } = mount();
    const slideBy = (dx: number) => {
      place($("page"), dx, 0, 390, 844);
      place($("back"), 12 + dx, 59, 44, 44);
      place($("title"), 120 + dx, 59, 150, 44);
      place($("right"), 334 + dx, 59, 44, 44);
      place($("shell"), 10 + dx, 760, 370, 48);
    };
    slideBy(390);
    runFrame();
    expect(glass.update.mock.lastCall![0]).toMatchObject({ offset: 390, header: { back: { x: 12 } }, composer: { frame: { x: 10 } } });
    const sent = glass.update.mock.calls.length;
    $("page").dataset.moving = "";
    slideGlass({ duration: 400, points: [390, 200, 0] });
    expect(glass.slide).toHaveBeenCalledWith({ duration: 400, points: [390, 200, 0] }, expect.any(Number));
    for (const dx of [300, 120, 30]) { slideBy(dx); runFrame(); }
    expect(glass.update).toHaveBeenCalledTimes(sent + 1);
    expect(glass.update.mock.lastCall![0]).toMatchObject({ offset: 0, header: { back: { x: 12 } } });
    // a finger takes the page: the slide stops and the page is followed every frame
    slideGlass(null);
    expect(glass.slide).toHaveBeenLastCalledWith(null);
    slideBy(40);
    runFrame();
    slideBy(60);
    runFrame();
    expect(glass.update.mock.calls.slice(-2).map(([state]) => state.offset)).toEqual([40, 60]);
  });

  it("sends the avatar before the header that shows it", () => {
    const { glass } = mount();
    runFrame();
    const avatarAt = glass.setAvatar.mock.invocationCallOrder[0];
    const headerAt = glass.update.mock.invocationCallOrder[0];
    expect(avatarAt).toBeLessThan(headerAt!);
  });

  it("with acks the page keeps its composer until the native one is on screen, and takes it back when it is not", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      const { glass, send } = mount(true);
      const html = document.documentElement;
      runFrame();
      expect(glass.update.mock.lastCall![0].composer).not.toBeNull();
      expect(html.dataset.nativeGlassComposer).toBeUndefined();
      send({ type: "composer", shown: true });
      runFrame();
      expect(html.dataset.nativeGlassComposer).toBe("");
      send({ type: "composer", shown: false, reason: "no host" });
      runFrame();
      expect(html.dataset.nativeGlassComposer).toBeUndefined();
      expect(glass.update.mock.lastCall![0].composer).toBeNull();

      // back in front it asks again; silence past the wait keeps the page's
      document.dispatchEvent(new Event("visibilitychange"));
      runFrame();
      expect(glass.update.mock.lastCall![0].composer).not.toBeNull();
      vi.advanceTimersByTime(500);
      runFrame();
      expect(html.dataset.nativeGlassComposer).toBeUndefined();
      expect(glass.update.mock.lastCall![0].composer).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it("gives the composer's place to a call's bar: the native composer goes, stays gone through every resend, and comes back as the bar leaves", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      const { glass, send, $ } = mount(true);
      const html = document.documentElement;
      runFrame();
      send({ type: "composer", shown: true });
      runFrame();
      expect(html.dataset.nativeGlassComposer).toBe("");

      const bar = document.createElement("div");
      bar.setAttribute("data-call-surface", "");
      $("chat").append(bar);
      for (let i = 0; i < 15; i += 1) runFrame();
      expect(glass.update.mock.lastCall![0]).toMatchObject({ composer: null, call: true, header: { name: "Manager" } });
      expect(html.dataset.nativeGlassComposer).toBeUndefined();

      // the once-a-second resend and the ack wait never bring the composer back while the call holds its place
      const sent = glass.update.mock.calls.length;
      vi.advanceTimersByTime(REASSERT_MS + 500);
      for (let i = 0; i < 15; i += 1) runFrame();
      expect(glass.update.mock.calls.length).toBeGreaterThan(sent);
      expect(glass.update.mock.calls.slice(sent).every(([state]) => state.composer === null && state.call === true)).toBe(true);
      document.dispatchEvent(new Event("visibilitychange"));
      runFrame();
      expect(glass.update.mock.lastCall![0]).toMatchObject({ composer: null, call: true });

      // the bar starts to leave: the composer is asked back under it, no longer as a call
      bar.setAttribute("data-call-leaving", "");
      for (let i = 0; i < 15; i += 1) runFrame();
      expect(glass.update.mock.lastCall![0].composer).not.toBeNull();
      expect(glass.update.mock.lastCall![0].call).toBeUndefined();
      send({ type: "composer", shown: true });
      runFrame();
      expect(html.dataset.nativeGlassComposer).toBe("");
      bar.remove();
    } finally { vi.useRealTimers(); }
  });

  it("drops the native chrome while a sheet covers the chat", () => {
    const { glass } = mount();
    runFrame();
    document.elementFromPoint = () => document.body;
    runFrame();
    expect(glass.update.mock.lastCall![0]).toMatchObject({ header: null, composer: null });
    expect(document.documentElement.dataset.nativeGlassHeader).toBeUndefined();
  });

  it("hands native taps, typing and return to the page's own controls", () => {
    const { send, $ } = mount();
    runFrame();
    const clicks = { back: vi.fn(), title: vi.fn(), plus: vi.fn(), mic: vi.fn() };
    for (const [id, fn] of Object.entries(clicks)) $(id).addEventListener("click", fn);
    send({ type: "tap", target: "back" });
    send({ type: "tap", target: "title" });
    send({ type: "tap", target: "plus" });
    send({ type: "button", index: 0 });
    for (const fn of Object.values(clicks)) expect(fn).toHaveBeenCalledTimes(1);

    const field = $("field") as HTMLTextAreaElement;
    const keys = vi.fn((event: KeyboardEvent) => event.key);
    field.addEventListener("keydown", keys);
    send({ type: "text", text: "hello" });
    expect(field.value).toBe("hello");
    send({ type: "submit" });
    expect(keys.mock.results[0]?.value).toBe("Enter");
  });

  it("presses the control a native tap stood in for, even after the page's set moved on", () => {
    const { send, $ } = mount();
    const stop = document.createElement("button");
    stop.setAttribute("data-composer-stop", "slot");
    $("mic").after(stop);
    runFrame();
    const pressed = { mic: vi.fn(), stop: vi.fn() };
    $("mic").addEventListener("click", pressed.mic);
    stop.addEventListener("click", pressed.stop);
    send({ type: "button", index: 0, kind: "stop" });
    expect(pressed.stop).toHaveBeenCalledTimes(1);
    expect(pressed.mic).not.toHaveBeenCalled();
  });

  const LONG = Array.from({ length: 80 }, (_, i) => `line ${i}: check the build again 🚀 “quoted”`).join("\n");

  /** the page's Send: what a tap on the native one presses, and what the page then does with its field */
  function pageSends($: (id: string) => HTMLElement, takes = true) {
    $("mic").addEventListener("click", () => { if (takes) typeInto($("field") as HTMLTextAreaElement, ""); });
  }

  it("clears the native field outright once the page takes a long send, and never types its old text back", () => {
    const { glass, send, $ } = mount();
    pageSends($);
    runFrame();
    send({ type: "text", text: LONG });
    runFrame();
    send({ type: "button", index: 0, kind: "send" });
    // the field's own text from before the clear, late (a dictation or autocorrection settling)
    send({ type: "text", text: LONG.replace(/again 🚀 “quoted”$/, "again! 🚀 “quoted”") });
    expect(($("field") as HTMLTextAreaElement).value).toBe("");
    runFrame();
    const id = glass.clearText.mock.calls[0]![0];
    expect(glass.setText).toHaveBeenLastCalledWith("", id);
    send({ type: "text", text: LONG });
    expect(($("field") as HTMLTextAreaElement).value).toBe("");
    expect(glass.clearText.mock.calls.length).toBeGreaterThan(1);
    send({ type: "text", text: "next one" });
    expect(($("field") as HTMLTextAreaElement).value).toBe("next one");
  });

  it("leaves the native field alone when the page does not take the send", () => {
    const { glass, send, $ } = mount();
    pageSends($, false);
    runFrame();
    send({ type: "text", text: LONG });
    send({ type: "button", index: 0, kind: "send" });
    for (let i = 0; i < 3; i += 1) runFrame();
    expect(glass.clearText).not.toHaveBeenCalled();
    expect(($("field") as HTMLTextAreaElement).value).toBe(LONG);
  });

  it("puts a failed send's text back in the native field after clearing it", () => {
    const { glass, send, $ } = mount();
    pageSends($);
    runFrame();
    send({ type: "text", text: LONG });
    send({ type: "button", index: 0, kind: "send" });
    runFrame();
    expect(glass.clearText).toHaveBeenCalledTimes(1);
    typeInto($("field") as HTMLTextAreaElement, LONG);
    runFrame();
    expect(glass.setText).toHaveBeenLastCalledWith(LONG, expect.any(Number));
  });

  it("types native text into the composer's current field after the page made it anew", () => {
    const { send, $ } = mount();
    runFrame();
    const old = $("field") as HTMLTextAreaElement;
    const fresh = document.createElement("textarea");
    old.replaceWith(fresh);
    send({ type: "text", text: "hello" });
    expect(fresh.value).toBe("hello");
  });

  it("sends the page's own edits to the native field, never echoing what was typed there", () => {
    const { glass, send, $ } = mount();
    runFrame();
    expect(glass.setText, "a chat opening hands the field its own text, empty here").toHaveBeenCalledTimes(1);
    expect(glass.setText.mock.calls[0]![0]).toBe("");
    send({ type: "text", text: "hel" });
    runFrame();
    expect(glass.setText).toHaveBeenCalledTimes(1);
    typeInto($("field") as HTMLTextAreaElement, "");
    runFrame();
    expect(glass.setText).toHaveBeenCalledTimes(2);
    expect(glass.setText.mock.calls[1]![0]).toBe("");
    send({ type: "text", text: "again" });
    runFrame();
    typeInto($("field") as HTMLTextAreaElement, "");
    runFrame();
    expect(glass.setText).toHaveBeenCalledTimes(3);
    const seqs = glass.setText.mock.calls.map((call) => call[1]);
    expect(seqs[1]! > seqs[0]! && seqs[2]! > seqs[1]!).toBe(true);
  });

  // App Store 1.2: each chat counted from 1 again while the native field kept the highest count it had taken, so after
  // the first chat a send never cleared the native field
  it("keeps counting up across chats, so a send clears the native field in every chat, not only the first", () => {
    const first = mount();
    runFrame();
    first.send({ type: "text", text: "one" });
    typeInto(first.$("field") as HTMLTextAreaElement, "");
    runFrame();
    const highest = Math.max(...first.glass.setText.mock.calls.map((call) => call[1]));
    flushSync(() => root.unmount());
    const second = mount();
    runFrame();
    second.send({ type: "text", text: "two" });
    typeInto(second.$("field") as HTMLTextAreaElement, "");
    runFrame();
    const cleared = second.glass.setText.mock.calls.at(-1)!;
    expect(cleared[0]).toBe("");
    expect(cleared[1]).toBeGreaterThan(highest);
  });

  it("keeps the composer's height to the native one and blurs it on the way out", () => {
    const { glass, send, $ } = mount();
    runFrame();
    send({ type: "height", height: 72 });
    expect($("shell").style.getPropertyValue("--glass-composer-h")).toBe("72px");
    send({ type: "focus", focused: true });
    flushSync(() => root.unmount());
    root = createRoot(host);
    expect(glass.blur).toHaveBeenCalled();
    expect(glass.clear).toHaveBeenCalled();
    expect(document.documentElement.dataset.nativeGlassComposer).toBeUndefined();
  });

  it("keeps the composer's gap while the page rides the keyboard down, so the native one follows the keyboard alone", () => {
    const { glass, $ } = mount();
    const root = host.querySelector<HTMLElement>(".madani-mobile")!;
    // the keyboard is up and settled: the layout ends at its top
    root.style.setProperty("--m-kb", "300px");
    place($("shell"), 10, 460, 370, 48);
    for (let i = 0; i < 31; i += 1) runFrame();
    expect(glass.update.mock.lastCall![0].composer?.gap).toBe(36);
    // it starts to hide: the layout takes the space back at once and the dock is drawn where it was, riding down from there
    root.style.setProperty("--m-kb", "0px");
    $("dock").style.transform = "matrix(1, 0, 0, 1, 0, -300)";
    for (let i = 0; i < 31; i += 1) runFrame();
    expect(glass.update.mock.calls.map((call) => call[0].composer?.gap)).not.toContain(336);
    $("dock").style.transform = "matrix(1, 0, 0, 1, 0, -120)";
    place($("shell"), 10, 640, 370, 48);
    for (let i = 0; i < 31; i += 1) runFrame();
    expect(glass.update.mock.lastCall![0].composer?.gap).toBe(36);
  });

  it("raises the native field when the page focuses its own", () => {
    const { glass, $ } = mount();
    runFrame();
    ($("field") as HTMLTextAreaElement).focus();
    expect(glass.focus).toHaveBeenCalled();
  });

  it("hands the keyboard back to the native field when the page's composer gives way to it again", () => {
    const { glass, $ } = mount();
    runFrame();
    const strip = document.createElement("div");
    place(strip, 10, 700, 370, 40);
    $("field").closest("[data-composer-row]")!.parentElement!.prepend(strip);
    for (let i = 0; i < 15; i += 1) runFrame();
    expect(glass.update.mock.lastCall![0].composer).toBeNull();
    ($("field") as HTMLTextAreaElement).focus();
    expect(glass.focus).not.toHaveBeenCalled();
    strip.remove();
    for (let i = 0; i < 15; i += 1) runFrame();
    expect(glass.update.mock.lastCall![0].composer).not.toBeNull();
    expect(glass.focus).toHaveBeenCalledTimes(1);
  });

  it("tells the native side its chrome again every second, so a composer it lost comes back", () => {
    let clock = 5000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const { glass } = mount();
    for (let i = 0; i < 31; i += 1) runFrame();
    const sent = glass.update.mock.calls.length;
    for (let i = 0; i < 15; i += 1) runFrame();
    expect(glass.update).toHaveBeenCalledTimes(sent);
    clock += REASSERT_MS + 1;
    for (let i = 0; i < 15; i += 1) runFrame();
    expect(glass.update).toHaveBeenCalledTimes(sent + 1);
    expect(glass.update.mock.lastCall![0].composer).not.toBeNull();
  });

  it("tells the native side everything again when the app comes back to the front", () => {
    const { glass } = mount();
    for (let i = 0; i < 31; i += 1) runFrame();
    const sent = glass.update.mock.calls.length;
    document.dispatchEvent(new Event("visibilitychange"));
    runFrame();
    expect(glass.update).toHaveBeenCalledTimes(sent + 1);
  });
});

describe("the header's symbols for the page", () => {
  const png = (tag: string) => `data:image/png;base64,${tag}`;
  afterEach(() => {
    const html = document.documentElement;
    delete html.dataset.nativeGlyphs;
    for (const name of ["back", "right"]) for (const end of ["", "-w", "-h"]) html.style.removeProperty(`--native-glyph-${name}${end}`);
  });

  it("dresses the page's back and computer buttons in the glass's own glyphs, at their size", () => {
    const html = document.documentElement;
    expect(applyGlassGlyphs(html, { back: { data: png("QkFDSw=="), w: 11.5, h: 19 }, right: { data: png("RElTUA=="), w: 24, h: 17.5 } })).toBe(true);
    expect(html.dataset.nativeGlyphs).toBe("back right");
    expect(html.style.getPropertyValue("--native-glyph-right")).toBe(`url("${png("RElTUA==")}")`);
    expect(html.style.getPropertyValue("--native-glyph-back-w")).toBe("11.5px");
  });

  it("leaves the page's own glyphs when the native side sends nothing usable", () => {
    const html = document.documentElement;
    expect(applyGlassGlyphs(html, {})).toBe(false);
    expect(applyGlassGlyphs(html, { right: { data: "javascript:alert(1)", w: 24, h: 17 } })).toBe(false);
    expect(html.dataset.nativeGlyphs).toBeUndefined();
  });
});

describe("the transcript's room under its last row", () => {
  it("is the empty space below a short chat and none under a long one", () => {
    const chat = document.createElement("div");
    const list = document.createElement("div");
    const content = document.createElement("div");
    const jump = document.createElement("div");
    jump.style.position = "absolute";
    list.className = "glass-scroller";
    list.append(content, jump);
    chat.append(list);
    document.body.append(chat);
    place(list, 0, 54, 390, 700);
    place(jump, 0, 700, 390, 40);
    const size = (filled: number) => {
      place(content, 0, 54, 390, filled);
      Object.defineProperty(list, "clientHeight", { configurable: true, get: () => 700 });
      // a browser never reports less than the box itself, however short the content
      Object.defineProperty(list, "scrollHeight", { configurable: true, get: () => Math.max(700, filled) });
    };
    size(420.4);
    expect(transcriptRoom(chat)).toBe(280);
    size(2400);
    expect(transcriptRoom(chat)).toBe(0);
    expect(transcriptRoom(null)).toBe(0);
    chat.remove();
  });
});
