// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo, Message } from "@/state/store";

vi.mock("@/components/ChatMarkdown", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/components/ChatMarkdown")>(),
  ChatMarkdown: ({ text }: { text: string }) => createElement("p", null, text),
}));
vi.mock("@/components/DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/components/DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true, useReactor: () => "user" }));
vi.mock("@/components/ModelPicker", () => ({ ModelPicker: () => null }));

const { ChatView } = await import("@/components/ChatView");
const { BotEditorStore, initialState } = await import("@/state/store");

// happy-dom lays nothing out, so the phone's own rules are applied by hand: each rule in mobile.css that matches an element
// and sets a property, the most specific (then the last) winning. mobile.css is unlayered, so it beats every utility class.
type Rule = { selector: string; decls: Map<string, string>; weight: number };
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "mobile.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
function splitTop(list: string): string[] {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < list.length; i++) {
    if ("([".includes(list[i]!)) depth++;
    else if (")]".includes(list[i]!)) depth--;
    else if (list[i] === "," && depth === 0) { parts.push(list.slice(start, i)); start = i + 1; }
  }
  return [...parts, list.slice(start)].map((part) => part.trim()).filter(Boolean);
}
const rules: Rule[] = [...css.matchAll(/([^{};]+)\{([^{}]*)\}/g)].flatMap(([, selectors, body]) => {
  const decls = new Map(body!.split(";").map((decl) => decl.split(":").map((side) => side.trim())).filter(([prop, value]) => prop && value).map(([prop, value]) => [prop!, value!]));
  return splitTop(selectors!).filter((selector) => !selector.startsWith("@") && !/^(from|to|\d+%)$/.test(selector)).map((selector) => ({
    selector, decls, weight: (selector.match(/\[|(?<![:\w-])\.[\w\\]|:(?!:)(?!is\(|where\()/g) ?? []).length,
  }));
});
function phone(el: Element, prop: string): string | undefined {
  let best: Rule | undefined;
  for (const rule of rules) {
    if (!rule.decls.has(prop)) continue;
    let hit = false;
    try { hit = el.matches(rule.selector); } catch {}
    if (hit && (!best || rule.weight >= best.weight)) best = rule;
  }
  return best?.decls.get(prop);
}

const LONG = "a long reply that runs well past one line on a phone, so it should use the whole column and never wrap at two thirds of the width";
const messages: Message[] = [
  { id: "m1", role: "user", kind: "text", text: `${LONG}, from me`, at: 1 },
  { id: "m2", parentId: "m1", role: "bot", kind: "text", text: LONG, at: 2 },
  { id: "m3", parentId: "m2", role: "user", kind: "text", text: "ok", at: 3 },
  { id: "m4", parentId: "m3", role: "bot", kind: "text", text: `${LONG}\n\nand a second paragraph`, at: 4 },
  { id: "m5", parentId: "m4", role: "user", kind: "text", text: "🎉", at: 5 },
  { id: "m6", parentId: "m5", role: "bot", kind: "text", text: "here they are:\n\n| Plan | Price |\n|---|---|\n| Team | $29 |\n\nTeam fits.", at: 6 },
];
const TEXT_ROWS = 4;
const bot: Bot = {
  id: "nova", threadId: "nova-thread", name: "Nova", title: "", description: "", color: "purple",
  notifications: true, unread: false, busy: false, messages, activeLeafId: "m6", modelSelection: { instanceId: "test", model: "m" },
  tasks: [{ threadId: "nova-thread", title: "Thread", createdAt: 1, busy: false, activity: "idle", modelSelection: { instanceId: "test", model: "m" }, approvalMode: "ask" }],
};

let root: Root;
beforeAll(async () => {
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  const shell = document.createElement("div");
  shell.className = "madani-mobile";
  shell.innerHTML = "<div data-mobile-chat></div>";
  document.body.append(shell);
  root = createRoot(shell.firstElementChild!);
  const state: AppState = {
    ...initialState, connected: true, selectedId: "nova", bots: [bot],
    instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test", snapshot: { state: "available" } } as InstanceInfo],
    config: { features: {} } as AppState["config"],
  };
  const value = { state, dispatch: vi.fn(), flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  flushSync(() => root.render(createElement(BotEditorStore, { value, children: createElement(ChatView, { bot }) })));
  await new Promise((resolve) => setTimeout(resolve, 0));
});
afterAll(() => {
  root.unmount();
  vi.unstubAllGlobals();
});

const rows = () => [...document.querySelectorAll<HTMLElement>("[data-mobile-chat] [data-message-row]")];
const bubbleOf = (row: Element) => row.querySelector<HTMLElement>("[data-chat-bubble]")!;

describe("message width on the phone, on the rendered chat", () => {
  it("draws every message as a row with its bubble", () => {
    expect(rows()).toHaveLength(messages.length);
    for (const row of rows()) expect(bubbleOf(row)).toBeTruthy();
  });

  it("stops a bot reply 44px short of the column, like a chat bubble", () => {
    for (const row of rows().slice(0, TEXT_ROWS).filter((el) => el.classList.contains("items-start"))) expect(phone(bubbleOf(row), "max-width")).toBe("calc(100% - 44px)");
  });

  it("stops your own bubble 44px short of the column", () => {
    for (const row of rows().slice(0, TEXT_ROWS).filter((el) => el.classList.contains("items-end"))) expect(phone(bubbleOf(row), "max-width")).toBe("calc(100% - 44px)");
  });

  it("keeps everything beside a bubble out of the row's flow, so nothing narrows it", () => {
    for (const row of rows().slice(0, TEXT_ROWS)) {
      const bubble = bubbleOf(row);
      for (const sibling of [...bubble.parentElement!.children].filter((el) => el !== bubble)) expect(phone(sibling, "position")).toBe("absolute");
      expect(row.querySelectorAll('[data-testid="message-actions"]').length).toBeGreaterThan(0);
      for (const actions of row.querySelectorAll('[data-testid="message-actions"]')) expect(phone(actions, "position")).toBe("absolute");
    }
  });

  it("puts no other width cap between the bubble and the row", () => {
    for (const row of rows().slice(0, TEXT_ROWS)) {
      for (let el = bubbleOf(row).parentElement; el && el !== row; el = el.parentElement) expect(el.className).not.toMatch(/max-w-/);
    }
  });
});

describe("the composer on the phone", () => {
  it("stretches its rows across the pill, so a wide screen (an iPhone on its side) never pushes them to the right", () => {
    const pill = document.querySelector("[data-mobile-chat] [data-tour=composer]")!;
    expect(pill.className).toMatch(/\bflex-col\b/);
    expect(phone(pill, "align-items") ?? "stretch").toBe("stretch");
  });

  it("stops a card waiting on the person under the top bar, its words scrolling between its title and its buttons", () => {
    const dock = document.querySelector("[data-mobile-chat] [data-grok-inset]")!;
    const holder = document.createElement("div");
    holder.setAttribute("data-approval-dock", "");
    holder.innerHTML = '<div data-ask-card="approval"><div data-approval-body class="min-h-0 flex-1 overflow-y-auto"></div></div>';
    dock.append(holder);
    const card = holder.querySelector("[data-ask-card]")!;
    expect(phone(card, "max-height")).toMatch(/^calc\(100dvh/);
    expect(phone(card, "flex-direction")).toBe("column");
    holder.remove();
  });

  it("keeps an attached file's small remove button its own size, not a 44px disc over the thumbnail", () => {
    const dock = document.querySelector("[data-mobile-chat] [data-grok-inset]")!;
    const tile = document.createElement("div");
    tile.setAttribute("data-composer-attachment", "");
    tile.innerHTML = "<button type=button>x</button>";
    dock.append(tile);
    expect(phone(tile.querySelector("button")!, "min-width")).toBe("0");
    expect(phone(dock.querySelector("[data-tour=composer] button")!, "min-width")).toBe("44px");
    tile.remove();
  });
});

describe("bubbles that are not plain text, on the phone", () => {
  it("keeps an emoji-only message at its large size, with no bubble around it", () => {
    const emoji = document.querySelector("[data-mobile-chat] [data-emoji-only]")!;
    expect(emoji.textContent).toBe("🎉");
    expect(phone(emoji, "font-size")).toBeUndefined();
    expect(phone(emoji, "padding")).toBeUndefined();
  });

  it("gives a reply split around a table no padding of its own, so its bubbles line up with every other reply's", () => {
    const outer = [...document.querySelectorAll("[data-mobile-chat] [data-chat-bubble]")].find((el) => el.querySelector("[data-reply-blocks]"))!;
    expect(outer).toBeTruthy();
    expect(phone(outer, "padding")).toBeUndefined();
    const inner = outer.querySelector("[data-reply-blocks] [data-chat-bubble]")!;
    expect(phone(inner, "padding")).toBe("8px 14px");
  });
});
