// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VpsCloudMoveView } from "@/lib/vps-cloud-move";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), bots: 3 }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({
      state: { ...original.initialState, config: null, bots: Array.from({ length: fixture.bots }, (_, at) => ({ id: `b${at}`, name: `Bot ${at}` })) },
      dispatch: fixture.dispatch,
    }),
  };
});

const { CloudMoveSheet } = await import("./CloudMoveSheet");

const PLACE = "hetzner-box";
const OFFER = { plans: [{ tier: "pro", amount: 5000, label: "Pro" }, { tier: "starter", amount: 2000, label: "Plus" }], recommended: "pro" };
let root: Root, host: HTMLElement;
const onClose = vi.fn();
const settle = async () => { for (let at = 0; at < 5; at++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const button = (label: string) => [...document.body.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
const stage = () => document.body.querySelector("[data-cloud-move-stage]")?.getAttribute("data-cloud-move-stage");
const text = () => document.body.textContent ?? "";

function desktop(view: VpsCloudMoveView | null) {
  let listener: ((next: VpsCloudMoveView) => void) | null = null;
  const vpsCloudMove = view ? {
    view: vi.fn(async () => view),
    start: vi.fn(async (): Promise<VpsCloudMoveView> => ({ stage: "moving", place: PLACE, route: "direct", phase: "copy" })),
    buy: vi.fn(async (): Promise<VpsCloudMoveView> => ({ stage: "buying", place: PLACE, route: "direct" })),
    retry: vi.fn(async (): Promise<VpsCloudMoveView> => ({ stage: "moving", place: PLACE, route: "direct", phase: "copy" })),
    cancel: vi.fn(async (): Promise<VpsCloudMoveView> => ({ stage: "none", cloud: "none" })),
    onChange: vi.fn((callback: (next: VpsCloudMoveView) => void) => { listener = callback; return () => { listener = null; }; }),
  } : undefined;
  const bridges = {
    platform: "darwin",
    app: { ownPage: false },
    workspaces: { state: vi.fn(async () => ({ local: false, name: PLACE })), menu: vi.fn(async () => {}) },
    cloudAdd: { state: vi.fn(async () => ({ signedIn: true, hasCloud: false, supported: true, canAdd: true, offer: OFFER, count: 0 })) },
    ...(vpsCloudMove ? { vpsCloudMove } : {}),
  };
  (window as unknown as { madaniDesktop: unknown }).madaniDesktop = bridges;
  return { bridges, vps: vpsCloudMove!, tell: (next: VpsCloudMoveView) => flushSync(() => listener?.(next)) };
}

async function render() {
  flushSync(() => root.render(createElement(CloudMoveSheet, { target: "cloud", onClose })));
  await settle();
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  fixture.dispatch.mockReset();
  fixture.bots = 3;
  onClose.mockReset();
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  delete (window as unknown as { madaniDesktop?: unknown }).madaniDesktop;
  vi.unstubAllGlobals();
});

describe("move a VPS's bots to madani cloud", () => {
  it("an older app without the bridge: still says to switch to this computer", async () => {
    desktop(null);
    await render();
    expect(stage()).toBe("elsewhere");
    expect(text()).toContain("Moves start from your Mac");
    expect(button("Switch to this Mac")).toBeDefined();
  });

  it("no cloud: perks, price, and checkout from the click", async () => {
    const { vps } = desktop({ stage: "none", cloud: "none" });
    await render();
    expect(stage()).toBe("vps-buy");
    expect(text()).toContain(`All 3 bots move straight from ${PLACE}`);
    expect(text(), "the cheapest plan, named with its price, before the browser opens").toContain("Plus: $20/month + tax where applicable.");
    expect(text()).toContain(`After you pay, your bots move from ${PLACE} by themselves.`);
    button("Get madani cloud")!.click();
    await settle();
    expect(vps.buy, "Get madani cloud buys Plus, not Pro").toHaveBeenCalledWith("plus");
    expect(stage()).toBe("vps-buying");
  });

  it("signed out: the plan and its price come from the move's own offer, before any sign-in", async () => {
    const { bridges, vps } = desktop({ stage: "none", cloud: "signed-out" });
    Object.assign(bridges, { cloudAdd: { state: vi.fn(async () => ({ signedIn: false, hasCloud: false, supported: true, canAdd: true, offer: null, count: 0 })) } });
    Object.assign(vps, { offer: vi.fn(async () => OFFER) });
    await render();
    expect(text()).toContain("Plus: $20/month + tax where applicable.");
  });

  it("signed out: buy's refusal opens the sign-in, from this source", async () => {
    const { bridges, vps } = desktop({ stage: "none", cloud: "signed-out" });
    Object.assign(bridges, { cloudAccount: { state: vi.fn(async () => ({ status: "signed-out" })), onState: vi.fn(() => () => {}) } });
    vps.buy.mockRejectedValueOnce(new Error("Error invoking remote method 'vps-cloud-move:buy': Error: Sign in to madani cloud first."));
    await render();
    button("Get madani cloud")!.click();
    await settle();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "openCloudAdd", source: "app_computer_move", signIn: true });
    expect(onClose).toHaveBeenCalled();
    expect(document.body.querySelector("[role='alert']")).toBeNull();
  });

  it("signed out on a server's page: the account sheet opens right here, never a pointer to another page", async () => {
    const { vps, bridges } = desktop({ stage: "none", cloud: "signed-out" });
    const open = vi.fn(async () => {});
    (bridges as Record<string, unknown>).accountSheet = { open, offered: vi.fn(async () => true) };
    vps.buy.mockRejectedValueOnce(new Error("Sign in to madani cloud first."));
    await render();
    button("Get madani cloud")!.click();
    await settle();
    expect(open).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector("[role='alert']")).toBeNull();
    expect(text()).not.toContain("own page");
  });

  it("a purchase going on in the browser says Continue in your browser, with Open again and Cancel", async () => {
    const { vps, tell } = desktop({ stage: "buying", place: PLACE, route: "direct", signingIn: true });
    const signIn = vi.fn(async (): Promise<VpsCloudMoveView> => ({ stage: "buying", place: PLACE, route: "direct", signingIn: true }));
    (vps as Record<string, unknown>).signIn = signIn;
    await render();
    expect(text()).toContain("Continue in your browser");
    expect(text()).toContain("pick up your plan there");
    expect(button("Cancel")).toBeTruthy();
    expect(button("Open checkout again")).toBeUndefined();
    button("Open again")!.click();
    await settle();
    expect(signIn).toHaveBeenCalledTimes(1);
    // signed in: main opens the checkout, and the sheet is the usual one again
    tell({ stage: "buying", place: PLACE, route: "direct" });
    await settle();
    expect(text()).toContain("Finish checkout in your browser");
  });

  it("with a cloud ready: one tap starts the move", async () => {
    const { vps } = desktop({ stage: "none", cloud: "ready" });
    await render();
    expect(stage()).toBe("vps-ready");
    expect(text()).toContain("Nothing changes on this Mac.");
    button("Move 3 bots")!.click();
    await settle();
    expect(vps.start).toHaveBeenCalledTimes(1);
    expect(stage()).toBe("vps-moving");
  });

  it("buying: checkout again, and the move can be cancelled", async () => {
    const { vps } = desktop({ stage: "buying", place: PLACE, route: "direct" });
    await render();
    expect(text()).toContain("Finish checkout in your browser");
    button("Open checkout again")!.click();
    await settle();
    expect(vps.buy).toHaveBeenCalledTimes(1);
    button("Cancel move")!.click();
    await settle();
    expect(vps.cancel).toHaveBeenCalledTimes(1);
  });

  it("moving: chats as they go, then a quiet moment, and retrying by itself", async () => {
    const { tell } = desktop({ stage: "moving", place: PLACE, route: "direct", phase: "copy", chats: { done: 40, total: 142 } });
    await render();
    expect(document.body.querySelector("[role='status']")?.textContent).toBe("Moving chats, 40 of 142");
    tell({ stage: "moving", place: PLACE, route: "direct", phase: "wait", retrying: true, error: "the server didn't answer." });
    expect(document.body.querySelector("[role='status']")?.textContent).toBe("Waiting for a quiet moment");
    expect(text()).toContain("trying again by itself");
    expect(button("Get madani cloud")).toBeUndefined();
  });

  it("fallback: goes via this computer, which restarts once", async () => {
    desktop({ stage: "fallback", place: PLACE, route: "via-mac", why: "vps_failing" });
    await render();
    expect(stage()).toBe("vps-fallback");
    expect(text()).toContain("Going via this Mac");
    expect(text()).toContain("come back to this Mac first, then move on to madani cloud by themselves");
    expect(text()).toContain("The app restarts once on the way.");
  });

  it("failed: says why, and try again retries", async () => {
    const { vps } = desktop({ stage: "failed", place: PLACE, route: "direct", error: "madani cloud didn't answer." });
    await render();
    expect(document.body.querySelector("[role='alert']")?.textContent).toBe("madani cloud didn't answer.");
    button("Try again")!.click();
    await settle();
    expect(vps.retry).toHaveBeenCalledTimes(1);
  });

  it("done: what moved, and what stays on the server", async () => {
    const stays = `Saved logins, 1Password and app keys stay on ${PLACE}. Connect them again on madani cloud.`;
    desktop({ stage: "done", place: PLACE, route: "direct", counts: { bots: 3, chats: 142, routines: 4 }, stays });
    await render();
    expect(text()).toContain("Your bots are on madani cloud");
    expect(text()).toContain(`Moved from ${PLACE}: 3 bots, 142 chats, and 4 routines.`);
    expect(document.body.querySelector("[data-vps-move-stays]")?.textContent).toBe(stays);
  });
});
