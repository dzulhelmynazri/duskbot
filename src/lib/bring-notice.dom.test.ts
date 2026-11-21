// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ config: { onboarding: { completedAt: "2026-11-01", version: 1, hintsSeen: [] as string[] } } }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: f.config }, dispatch: vi.fn() }), api: vi.fn() }));
vi.mock("./setup-import", () => ({
  setupImportApi: {},
  localSetupImport: () => true,
  detectSetupWithin: () => ({ found: Promise.resolve({}), cancel: () => {} }),
}));
vi.mock("./first-run-import", () => ({
  localFinds: () => [],
  memorySource: () => ({ id: "setup:claude", app: "Claude Code" }),
}));

const { useBringNotice } = await import("./bring-notice");
const { forgetPlaceSwitch } = await import("./place-switch");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let seen: { fact: boolean | null; find: unknown } | null = null;
function Probe() {
  seen = useBringNotice();
  return null;
}

let root: Root | null = null;
let switching: ((on: boolean) => void) | null = null;
const desktop = (arrived: boolean) => {
  (window as unknown as { madaniDesktop: unknown }).madaniDesktop = {
    remoteClient: { active: false },
    workspaces: { arrived: () => arrived, onSwitching: (callback: (on: boolean) => void) => { switching = callback; return () => { switching = null; }; } },
  };
};
async function mount() {
  root = createRoot(document.createElement("div"));
  await act(async () => { root!.render(createElement(Probe)); });
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => { forgetPlaceSwitch(); seen = null; sessionStorage.clear(); });
afterEach(async () => { await act(async () => root?.unmount()); root = null; });

describe("the bring card waits for a calm moment", () => {
  it("is due on a page the person opened here", async () => {
    desktop(false);
    await mount();
    expect(seen?.fact).toBe(true);
  });

  it("never on the page a switch of place just opened", async () => {
    desktop(true);
    await mount();
    expect(seen?.fact).toBe(false);
  });

  it("goes while a switch of place is under way", async () => {
    desktop(false);
    await mount();
    expect(seen?.fact).toBe(true);
    await act(async () => switching?.(true));
    expect(seen?.fact).toBe(false);
  });
});
