// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./PanelShell", () => ({ PanelDetailsTab: { preload: () => Promise.resolve() }, PanelAdvancedTab: { preload: () => Promise.resolve() } }));

const saved = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => void saved.set(key, value) });

const { PanelPlaceholder } = await import("./PanelPlaceholder");

afterEach(() => {
  document.body.innerHTML = "";
});

function mount(onClose = () => {}) {
  const host = document.createElement("div");
  document.body.append(host);
  flushSync(() => createRoot(host).render(createElement(PanelPlaceholder, { onClose })));
  return host;
}

describe("PanelPlaceholder", () => {
  it("draws the panel's shell while the window loads, never a remembered bot's face or name, and closes", () => {
    localStorage.setItem("madanibot.botPanelLast.v1", JSON.stringify({ id: "b1", name: "Tally", color: "green" }));
    const onClose = vi.fn();
    const host = mount(onClose);
    const panel = host.querySelector("[data-panel-placeholder]")!;
    expect(panel.getAttribute("aria-busy")).toBe("true");
    expect(panel.textContent).not.toContain("Tally");
    expect(panel.querySelectorAll(".animate-pulse, [class*='animate-pulse']").length).toBeGreaterThan(5);
    host.querySelector<HTMLButtonElement>("button[aria-label]")!.click();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
