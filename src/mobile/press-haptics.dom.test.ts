// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "@/state/store";
import { HAPTICS, haptic, installHaptics, type HapticAction } from "./haptics";
import type { MobilePlatform } from "./platform";
import { installRipple } from "./press";
import { Sheet } from "./Sheet";
import { tapHaptic, useChatHaptics } from "./use-chat-haptics";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
/** Each top-level or nested rule as its selector and its declarations. */
function rules(css: string): { selector: string; body: string }[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selector: match[1]!.trim(), body: match[2]! }));
}
const PAINTS_FILL = /(^|;|\s)background(-color|-image)?\s*:/;
const PHONE_GATE = ":where(:not(html[data-mobile-app] *))";

let clock = 0;
let platform: MobilePlatform & { haptic: ReturnType<typeof vi.fn> };
let root: Root | null = null;
beforeEach(async () => {
  vi.spyOn(performance, "now").mockImplementation(() => (clock += 100));
  platform = { haptic: vi.fn(), prefs: { get: async () => null, set: async () => {} } } as unknown as typeof platform;
  await installHaptics(platform);
});
afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});
const mount = (node: ReturnType<typeof createElement>) => {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  flushSync(() => root!.render(node));
};
const played = () => platform.haptic.mock.calls.map(([kind]) => kind);

describe("a press in the phone app paints no fill", () => {
  it("rows, menu items and the glass buttons have no pressed or opening tint", () => {
    const pressed = rules(source("./mobile.css")).filter((rule) => /:active|\[data-opening\]/.test(rule.selector) && PAINTS_FILL.test(rule.body));
    expect(pressed.map((rule) => rule.selector).filter((selector) => !selector.includes("data-tour=\"composer\""))).toEqual([]);
  });

  it("the shared buttons and menu rows keep their hover and pressed fills off the phone app only", () => {
    const shared = [...rules(source("../styles.css")), ...rules(source("../styles/overlays.css"))]
      .filter((rule) => /\.(ui-button|ui-icon-button|ui-menu-row|ui-pill|bot-button|table-action|turn-now-toggle|ui-toast-close)\b[^,]*:(hover|active)/.test(rule.selector) && PAINTS_FILL.test(rule.body));
    expect(shared.length).toBeGreaterThan(8);
    for (const rule of shared) {
      for (const part of rule.selector.split(/,(?![^(]*\))/).filter((one) => /:(hover|active)/.test(one))) expect(part).toContain(PHONE_GATE);
    }
  });

  it("tailwind's active: utilities do not apply inside the phone app", () => {
    expect(source("../styles.css")).toMatch(/@custom-variant active \(&:active:where\(:not\(html\[data-mobile-app\] \*\)\)\);/);
  });

  it("on Android a ripple answers a button but never a row or a menu item", () => {
    HTMLElement.prototype.animate = vi.fn(() => ({ cancel() {}, finished: Promise.resolve() })) as never;
    document.body.innerHTML = `<div id="root"><button id="row" class="mobile-row">Nova</button><button id="item" role="menuitem">Copy</button><button id="button">Retry</button></div>`;
    const host = document.getElementById("root")!;
    const stop = installRipple(host);
    for (const id of ["row", "item", "button"]) {
      document.getElementById(id)!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 4, clientY: 4 }));
    }
    expect(document.getElementById("row")!.hasAttribute("data-ripple")).toBe(false);
    expect(document.getElementById("item")!.hasAttribute("data-ripple")).toBe(false);
    expect(document.getElementById("button")!.hasAttribute("data-ripple")).toBe(true);
    stop();
  });
});

describe("haptics", () => {
  it("plays every action through the one map", () => {
    for (const action of Object.keys(HAPTICS) as HapticAction[]) {
      platform.haptic.mockClear();
      haptic(action);
      expect(platform.haptic).toHaveBeenCalledWith(HAPTICS[action]);
    }
    expect(HAPTICS).toMatchObject({ openChat: "light", back: "light", toggle: "selection", segment: "selection", pick: "selection", sheet: "soft", refresh: "selection", swipeReply: "medium", hold: "medium", send: "light", reply: "soft", error: "error", success: "success" });
  });

  it("plays nothing once the person turns haptics off", async () => {
    await installHaptics({ ...platform, prefs: { get: async () => "off", set: async () => {}, remove: async () => {} } });
    haptic("openChat");
    expect(platform.haptic).not.toHaveBeenCalled();
  });

  it("ticks a switch, a new segment or choice and a menu option, and nothing for a choice already made", () => {
    document.body.innerHTML = `
      <button id="switch" role="switch" aria-checked="false"></button>
      <button id="tab" role="tab" aria-selected="false"></button><button id="on" role="tab" aria-selected="true"></button>
      <button id="radio" role="radio" aria-checked="false"></button><button id="pressed" aria-pressed="true"></button>
      <button id="item" role="menuitem"></button><div id="option" role="option"></div>
      <button id="stop" data-composer-stop=""></button><button id="off" role="menuitem" disabled></button><button id="plain"></button>`;
    const of = (id: string) => tapHaptic(document.getElementById(id));
    expect([of("switch"), of("tab"), of("on"), of("radio"), of("pressed"), of("item"), of("option"), of("stop"), of("off"), of("plain")])
      .toEqual(["toggle", "segment", null, "segment", null, "pick", "pick", "stop", null, null]);
  });

  it("a sheet ticks as it opens and as it closes", () => {
    const sheet = (open: boolean) => createElement("div", { className: "madani-mobile" }, createElement(Sheet, { open, onClose() {}, title: "Settings", children: "body" }));
    mount(sheet(true));
    expect(played()).toEqual(["soft"]);
    flushSync(() => root!.render(sheet(false)));
    expect(played()).toEqual(["soft", "soft"]);
  });

  it("an open chat taps as a message leaves, softly as the reply lands, warns on an error, and ticks taps on choices", () => {
    const user = { id: "optimistic-1", role: "user", kind: "text", text: "hi" };
    const reply = { id: "r1", role: "assistant", kind: "text", text: "hello" };
    const stateWith = (messages: object[], error: string | null = null) => ({ bots: [{ id: "nova", messages }], groups: [], error }) as unknown as AppState;
    const Probe = ({ state }: { state: AppState }) => { useChatHaptics(state, "nova"); return null; };
    mount(createElement(Probe, { state: stateWith([]) }));
    flushSync(() => root!.render(createElement(Probe, { state: stateWith([user]) })));
    flushSync(() => root!.render(createElement(Probe, { state: stateWith([user, reply]) })));
    flushSync(() => root!.render(createElement(Probe, { state: stateWith([user, reply], "the place is asleep") })));
    expect(played()).toEqual(["light", "soft", "error"]);

    const item = document.body.appendChild(document.createElement("button"));
    item.setAttribute("role", "menuitem");
    item.click();
    expect(played().at(-1)).toBe("selection");
  });
});
