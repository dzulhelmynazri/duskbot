// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ownsDrag } from "../gesture";
import { heldBubble } from "../MessageHold";
import { PlatformContext, type MobilePlatform } from "../platform";
import { CodeViewer } from "./CodeViewer";
import { TableViewer } from "./TableViewer";
import { TextFileContent } from "../../components/HtmlFilePreview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const selectRules = () => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../mobile.css"), "utf8").split("\n")
  .filter((line) => line.startsWith("html[data-mobile-app]") && /user-select/.test(line)).join("\n");

let host: HTMLDivElement | null = null;
afterEach(() => {
  host?.remove();
  host = null;
  document.querySelector("style[data-test-select]")?.remove();
  delete document.documentElement.dataset.mobileApp;
  window.getSelection()?.removeAllRanges();
  vi.unstubAllGlobals();
});

async function mount(element: ReturnType<typeof createElement>) {
  document.documentElement.dataset.mobileApp = "ios";
  const style = document.createElement("style");
  style.dataset.testSelect = "";
  style.textContent = selectRules();
  document.head.append(style);
  host = document.createElement("div");
  host.className = "madani-mobile";
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(element));
  return host;
}

const selectOf = (el: Element) => getComputedStyle(el).userSelect;

describe("viewer text selects on the phone while its chrome stays tappable", () => {
  it("turns selection on for viewer content and keeps it off for the app and the buttons inside a viewer", async () => {
    const root = await mount(createElement("div", { "data-selectable": "" }, createElement("p", null, "words"), createElement("button", { type: "button" }, "copy")));
    expect(selectOf(document.documentElement)).toBe("none");
    expect(selectOf(root.querySelector("[data-selectable]")!)).toBe("text");
    expect(selectRules()).toMatch(/\[data-selectable\] \{[^}]*-webkit-touch-callout: default/);
    expect(selectOf(root.querySelector("[data-selectable] button")!)).toBe("none");
  });

  it("marks the markdown and plain text file previews selectable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("plain words")));
    const root = await mount(createElement(TextFileContent, { path: "/w/notes.txt", name: "notes.txt", message: { threadId: "t", messageId: "m" }, markdown: false }));
    await vi.waitFor(() => expect(root.querySelector("[data-file-preview='text']")).not.toBeNull());
    expect(root.querySelector("[data-file-preview='text']")!.hasAttribute("data-selectable")).toBe(true);
    expect(root.querySelector("button")!.closest("[data-selectable]")).toBeNull();
  });

  it("marks the code and table viewers' content selectable, not their headers", async () => {
    const phone = { kind: "ios", native: true } as unknown as MobilePlatform;
    const root = await mount(createElement(PlatformContext, { value: phone },
      createElement(CodeViewer, { code: "let a = 1", lang: "js", open: true, onClose: () => {} }),
      createElement(TableViewer, { columns: [{ text: "a" }], rows: [[{ text: "1" }]], name: "t", open: true, onClose: () => {} })));
    expect(root.querySelector("[data-code-viewer]")!.hasAttribute("data-selectable")).toBe(true);
    expect(root.querySelector("[data-table-viewer] table")!.hasAttribute("data-selectable")).toBe(true);
    for (const button of root.querySelectorAll("button")) expect(button.closest("[data-selectable]")).toBeNull();
  });

  it("a drag over selected viewer text belongs to the selection, not a pull to close", async () => {
    const root = await mount(createElement("div", { "data-selectable": "" }, createElement("p", null, "some words here")));
    const words = root.querySelector("p")!;
    expect(ownsDrag(words)).toBe(false);
    const range = document.createRange();
    range.setStart(words.firstChild!, 0);
    range.setEnd(words.firstChild!, 4);
    window.getSelection()!.addRange(range);
    expect(ownsDrag(words)).toBe(true);
  });

  it("a long press on selectable text in a message starts selection, not the message menu", async () => {
    const root = await mount(createElement("div", { "data-mobile-chat": "" },
      createElement("div", { "data-message-row": "" },
        createElement("div", { "data-chat-bubble": "" }, createElement("span", { "data-plain": "" }, "hi"), createElement("pre", { "data-selectable": "" }, "code")),
        createElement("div", { "data-testid": "message-actions" }))));
    expect(heldBubble(root.querySelector("[data-plain]"))).not.toBeNull();
    expect(heldBubble(root.querySelector("pre"))).toBeNull();
  });
});
