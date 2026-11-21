// @vitest-environment happy-dom
// the works-on choices' cloud desktop row in a real dom: each step runs its own existing flow through the desktop's bridges,
// and never touches where the bot works.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudAccountState } from "../../../electron/cloud-account.mjs";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), cloudHome: false }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({ state: { ...original.initialState, config: fixture.cloudHome ? { cloudHome: true } : null }, dispatch: fixture.dispatch }),
  };
});

const { CloudDesktopListRow, useCloudDesktop } = await import("./CloudDesktop");

function Harness() {
  const cloudDesktop = useCloudDesktop();
  return cloudDesktop ? createElement("div", null, createElement(CloudDesktopListRow, { cloudDesktop }), cloudDesktop.dialog) : createElement("p", { "data-none": true });
}

const HOME = { id: "c-home", name: "Harbor", color: null, role: "owner", tier: "pro", runsOn: "cloud", status: "ready", origin: "https://home.example.test", teamId: null, primary: true, managed: true, provider: "managed" } as const;
let root: Root, host: HTMLElement;
const settle = async () => { for (let at = 0; at < 4; at++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const row = () => host.querySelector<HTMLElement>("[data-panel-row='cloud-desktop']");
const button = (label: string) => [...document.body.querySelectorAll("button")].find((candidate) => candidate.textContent === label);

function desktop({ account = { status: "connected", clouds: [HOME] } as CloudAccountState, keep = { shown: true, on: false, moved: false, coming: false }, plan = { status: "paid" as const, provider: "managed" } } = {}) {
  const bridges = {
    cloudAccount: { state: vi.fn(async () => account), onState: vi.fn(() => () => {}), openDashboard: vi.fn(async () => account), connectHome: vi.fn(async () => account) },
    cloudSendPage: { notice: vi.fn(async () => ({ ready: true })), onNotice: vi.fn(() => () => {}), keepHere: vi.fn(async () => keep), setKeepHere: vi.fn(async (on: boolean) => ({ ...keep, on })) },
    cloudPlan: { state: vi.fn(async () => plan) },
  };
  (window as unknown as { madaniDesktop: unknown }).madaniDesktop = bridges;
  return bridges;
}

async function render() {
  flushSync(() => root.render(createElement(Harness)));
  await settle();
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  fixture.dispatch.mockReset();
  fixture.cloudHome = false;
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  delete (window as unknown as { madaniDesktop?: unknown }).madaniDesktop;
});

describe("the cloud desktop row", () => {
  it("is not there outside the desktop app", async () => {
    await render();
    expect(host.querySelector("[data-none]")).not.toBeNull();
  });

  it("offers Add a Cloud to an account without one", async () => {
    const bridges = desktop({ account: { status: "connected", clouds: [] } });
    await render();
    expect(row()?.textContent).toContain("Get one");
    row()!.click();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "openCloudAdd", source: "app_menu" });
    expect(bridges.cloudSendPage.setKeepHere).not.toHaveBeenCalled();
  });

  it("says a Cloud being set up is on its way, and does nothing yet", async () => {
    desktop({ account: { status: "connected", clouds: [{ ...HOME, status: "setting_up", origin: null }] } });
    await render();
    expect(row()?.tagName).not.toBe("BUTTON");
    expect(row()?.textContent).toContain("Setting up…");
  });

  it("moves this computer's bots there only once the person confirms", async () => {
    const bridges = desktop();
    await render();
    expect(row()?.textContent).toContain("Move my bots there");
    flushSync(() => row()!.click());
    expect(document.body.textContent).toContain("Move this computer's bots to Harbor?");
    flushSync(() => button("Cancel")!.click());
    expect(bridges.cloudSendPage.setKeepHere).not.toHaveBeenCalled();
    flushSync(() => row()!.click());
    button("Move bots")!.click();
    await settle();
    expect(bridges.cloudSendPage.setKeepHere).toHaveBeenCalledWith(false);
    expect([...document.body.querySelectorAll("[role='alertdialog']")].filter((el) => !el.closest("[data-leaving]")), "the confirm has closed").toEqual([]);
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("opens the Cloud once the bots are there, and says why when it can't", async () => {
    const bridges = desktop({ keep: { shown: true, on: false, moved: true, coming: false } });
    bridges.cloudAccount.connectHome.mockRejectedValueOnce(new Error("The Cloud didn't answer."));
    await render();
    expect(row()?.textContent).toContain("Open");
    row()!.click();
    await settle();
    expect(bridges.cloudAccount.connectHome).toHaveBeenCalledTimes(1);
    expect(row()?.textContent).toContain("The Cloud didn't answer.");
  });

  it("moves the bots back from the cloud desktop's own page once the person confirms", async () => {
    fixture.cloudHome = true;
    const bridges = desktop({ keep: { shown: true, on: false, moved: true, coming: false } });
    await render();
    expect(bridges.cloudAccount.state).not.toHaveBeenCalled();
    expect(row()?.textContent).toContain("Move back to this computer");
    flushSync(() => row()!.click());
    button("Move back")!.click();
    await settle();
    expect(bridges.cloudSendPage.setKeepHere).toHaveBeenCalledWith(true);
  });

  it("is not there on a Cloud's own page that a managed provider doesn't run", async () => {
    fixture.cloudHome = true;
    desktop({ keep: { shown: true, on: false, moved: true, coming: false }, plan: { status: "paid" } as never });
    await render();
    expect(host.querySelector("[data-none]")).not.toBeNull();
  });
});
