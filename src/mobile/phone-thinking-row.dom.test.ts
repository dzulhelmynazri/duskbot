// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";

const dispatch = vi.fn();
const haptic = vi.fn();
let instances: InstanceInfo[] = [];
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: { instances }, dispatch }),
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("./haptics", async (importOriginal) => ({ ...await importOriginal<typeof import("./haptics")>(), haptic: (action: string) => haptic(action) }));

const { PhoneThinkingRow } = await import("./PhoneModelRow");

const claude = {
  instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude",
  capabilities: { effortLevels: ["low", "medium", "high", "xhigh", "max"] },
  models: { default: "claude-fable-5-2", options: [{ id: "claude-fable-5-2", label: "Claude Fable 5.2" }] },
} as unknown as InstanceInfo;
const plain = { ...claude, instanceId: "plain", capabilities: {} } as unknown as InstanceInfo;
const botOn = (instanceId: string, effort?: string) =>
  ({ id: "nova", name: "Nova", threadId: "t1", busy: false, modelSelection: { instanceId, model: "claude-fable-5-2", ...(effort ? { effort } : {}) } }) as unknown as Bot;

let root: Root | null = null;
const mount = (bot: Bot) => {
  const host = document.body.appendChild(document.createElement("div"));
  host.className = "madani-mobile";
  root = createRoot(host);
  flushSync(() => root!.render(createElement(PhoneThinkingRow, { bot })));
};
afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
  dispatch.mockReset();
  haptic.mockReset();
});

describe("the phone's Thinking row", () => {
  it("is left out for a model that takes no thinking level", () => {
    instances = [plain];
    mount(botOn("plain"));
    expect(document.querySelector("[data-phone-thinking-row]")).toBeNull();
  });

  it("shows the level, lists Default and every level in a sheet, and saves a pick like the desktop picker", () => {
    instances = [claude];
    mount(botOn("claude", "high"));
    const row = document.querySelector<HTMLButtonElement>("[data-phone-thinking-row]")!;
    expect(row.textContent).toContain("Thinking");
    expect(row.textContent).toContain("High");
    flushSync(() => row.click());
    const options = [...document.querySelectorAll<HTMLButtonElement>("[data-phone-thinking-option]")];
    expect(options.map((option) => option.textContent)).toEqual(["Default", "Low", "Medium", "High", "X-high", "Max"]);
    expect(options[3]!.getAttribute("aria-pressed")).toBe("true");
    flushSync(() => options[5]!.click());
    expect(haptic).toHaveBeenLastCalledWith("pick");
    expect(document.querySelector("[data-phone-thinking-option]")).not.toBeNull();
    expect(dispatch).toHaveBeenCalledWith({ type: "setModel", botId: "nova", threadId: "t1", updateBotDefault: true,
      selection: { instanceId: "claude", model: "claude-fable-5-2", effort: "max" } });
  });

  it("clears the level on Default, so the provider decides", () => {
    instances = [claude];
    mount(botOn("claude", "low"));
    flushSync(() => document.querySelector<HTMLButtonElement>("[data-phone-thinking-row]")!.click());
    flushSync(() => document.querySelector<HTMLButtonElement>("[data-phone-thinking-option=default]")!.click());
    expect(dispatch).toHaveBeenCalledWith({ type: "setModel", botId: "nova", threadId: "t1", updateBotDefault: true,
      selection: { instanceId: "claude", model: "claude-fable-5-2" } });
  });
});
