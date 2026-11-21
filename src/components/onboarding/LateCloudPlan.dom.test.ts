// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  config: null as null | { onboarding: { completedAt: string; version: number; reelSeen: boolean; hintsSeen: string[] } },
  puts: [] as string[][],
}));
vi.mock("@/state/store", () => ({
  useStore: () => ({ state: { config: f.config }, dispatch: vi.fn() }),
  api: vi.fn(async (_path: string, init: RequestInit) => {
    const patch = JSON.parse(String(init.body)) as { onboarding: { hintsSeen: string[] } };
    f.puts.push(patch.onboarding.hintsSeen);
    return f.config;
  }),
}));
vi.mock("./MakingStep", () => ({ MakingStep: () => createElement("p", null, "Setting up your cloud") }));
vi.mock("../DesktopCapabilities", () => ({ WindowDragStrip: () => null }));
vi.mock("./WelcomeGate", () => ({ localDesktopPage: () => true }));

const { LateCloudPlan } = await import("./LateCloudPlan");
const { CLOUD_OPENED_HERE } = await import("./late-cloud");
const { forgetPlaceSwitch } = await import("@/lib/place-switch");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cloud = (status: string) => ({ status: "connected", clouds: [{ primary: true, runsOn: "cloud", role: "owner", status }] });
let root: Root | null = null;
let host: HTMLDivElement;

function desktop(account: unknown, { arrived }: { arrived: boolean }) {
  (window as unknown as { madaniDesktop: unknown }).madaniDesktop = {
    remoteClient: { active: false },
    workspaces: { arrived: () => arrived },
    cloudAccount: { state: async () => account, onState: () => () => {} },
  };
}
async function mount() {
  host = document.createElement("div");
  root = createRoot(host);
  await act(async () => { root!.render(createElement(LateCloudPlan, { viewer: { canSave: true, cloudHome: false } as never })); });
  await act(async () => { await Promise.resolve(); });
}
const making = () => host.querySelector("[data-late-cloud]") !== null;

beforeEach(() => {
  forgetPlaceSwitch();
  f.puts = [];
  f.config = { onboarding: { completedAt: "2026-10-01T10:00:00.000Z", version: 1, reelSeen: true, hintsSeen: ["met-chief-v1"] } };
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; });

describe("switching to this Mac with a madani cloud already running", () => {
  it("a ready cloud on an install without the hint: no making screen after a switch, the hint recorded quietly", async () => {
    desktop(cloud("ready"), { arrived: true });
    await mount();
    expect(making()).toBe(false);
    expect(f.puts).toEqual([["met-chief-v1", CLOUD_OPENED_HERE]]);
  });

  it("nor on a plain launch, nor for a cloud asleep or stopped", async () => {
    for (const status of ["ready", "stopped", "offline"]) {
      forgetPlaceSwitch(); f.puts = [];
      desktop(cloud(status), { arrived: false });
      await mount();
      expect(making(), status).toBe(false);
      expect(f.puts, status).toEqual([["met-chief-v1", CLOUD_OPENED_HERE]]);
      await act(async () => root?.unmount());
    }
  });
});

describe("a plan whose cloud is still being made", () => {
  it("shows the making screen once, then never again", async () => {
    desktop(cloud("setting_up"), { arrived: false });
    await mount();
    expect(making()).toBe(true);
    expect(f.puts).toHaveLength(1);
    await act(async () => root?.unmount());
    f.config!.onboarding.hintsSeen = f.puts[0]!;
    await mount();
    expect(making()).toBe(false);
  });

  it("waits for a later launch when a switch of place opened the page", async () => {
    desktop(cloud("setting_up"), { arrived: true });
    await mount();
    expect(making()).toBe(false);
    expect(f.puts, "still due on a later launch").toEqual([]);
  });
});
