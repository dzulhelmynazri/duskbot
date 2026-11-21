// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ImageViewer } from "./ImageViewer";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const SIDES = ["top", "bottom", "left", "right"] as const;

let host: HTMLDivElement | null = null;
afterEach(() => { host?.remove(); host = null; });

describe("full screen viewers keep their controls out of the status bar and the home indicator", () => {
  it("reads every inset from Capacitor's injected values first, then the system's", () => {
    const css = source("../mobile.css");
    for (const side of SIDES) expect(css).toContain(`--m-safe-${side}: var(--safe-area-inset-${side}, env(safe-area-inset-${side}, 0px));`);
  });

  it("puts the picture viewer's controls inside every inset", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const bridge = { haptic: () => {}, openLink: () => {}, view: () => {} };
    await act(async () => { root.render(createElement(ImageViewer, { images: [{ src: "/a.png", name: "a.png" }], initialIndex: 0, bridge, onClose: () => {} })); });
    const [top, bottom] = [...host.querySelectorAll<HTMLElement>(".viewer-chrome")];
    expect(top!.dataset.viewerControls).toBe("");
    for (const token of ["pt-[calc(var(--m-safe-top)+8px)]", "ps-[calc(var(--m-safe-left)+16px)]", "pe-[calc(var(--m-safe-right)+16px)]"]) expect(top!.className).toContain(token);
    expect(bottom!.className).toContain("pb-[calc(var(--m-safe-bottom)+16px)]");
    for (const button of top!.querySelectorAll("button")) expect(button.classList.contains("viewer-key")).toBe(true);
    await act(async () => root.unmount());
  });

  it("keeps the diagram viewer's and the desktop picture dialog's controls below the top inset", () => {
    for (const file of ["../../components/MermaidViewer.tsx", "../../components/AttachmentPreview.tsx"]) {
      const controls = source(file).split("\n").find((line) => line.includes("data-viewer-controls"));
      expect(controls).toContain("top-[calc(var(--safe-area-inset-top,env(safe-area-inset-top,0px))+12px)]");
      expect(controls).toContain("end-[calc(var(--safe-area-inset-right,env(safe-area-inset-right,0px))+12px)]");
    }
  });

  it("keeps every sheet clear of the side insets in landscape", () => {
    expect(source("./viewers.css")).toContain(".madani-mobile .mobile-sheet { padding-inline: var(--m-safe-left) var(--m-safe-right); }");
  });
});
