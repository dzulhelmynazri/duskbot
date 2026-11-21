// @vitest-environment happy-dom
// Move to Cloud desktop in a real dom: checkout first when there is no Cloud (recorded as app_computer_move), the move with
// one tap once there is, its progress with a way to stop, and the way back once the bots are there.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudAccountState } from "../../../electron/cloud-account.mjs";
import { MOVE_INTENT_KEY } from "@/lib/cloud-move";

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

const { CloudMoveSheet, CloudMoveWatcher } = await import("./CloudMoveSheet");

const HOME = { id: "c-home", name: "Harbor", color: null, role: "owner", tier: "pro", runsOn: "cloud", status: "ready", origin: "https://home.example.test", teamId: null, primary: true, managed: true, provider: "managed" } as const;
const OFFER = { plans: [{ tier: "pro", amount: 4900, label: "Pro" }, { tier: "starter", amount: 1900, label: "Starter" }], recommended: "pro" };
type Keep = { shown: boolean; on: boolean; moved: boolean; coming: boolean };
let root: Root, host: HTMLElement;
const onClose = vi.fn();
const settle = async () => { for (let at = 0; at < 5; at++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const button = (label: string) => [...document.body.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
const stage = () => document.body.querySelector("[data-cloud-move-stage]")?.getAttribute("data-cloud-move-stage");

function desktop({ account = { status: "connected", clouds: [HOME] } as CloudAccountState, keep = { shown: true, on: true, moved: false, coming: false } as Keep, move = null as unknown, offer = null as unknown } = {}) {
  let kept = keep;
  const bridges = {
    cloudAccount: { state: vi.fn(async () => account), onState: vi.fn(() => () => {}), offer: vi.fn(async () => OFFER), openDashboard: vi.fn(async () => account), connectHome: vi.fn(async () => account) },
    cloudSendPage: {
      notice: vi.fn(async () => (move || offer ? { ...(move ? { move } : {}), ...(offer ? { offer } : {}) } : null)), onNotice: vi.fn(() => () => {}), keepHere: vi.fn(async () => kept),
      setKeepHere: vi.fn(async (on: boolean) => (kept = { ...kept, on })),
      moveOfferAccept: vi.fn(async () => ({})),
    },
  };
  (window as unknown as { madaniDesktop: unknown }).madaniDesktop = bridges;
  return bridges;
}

async function render(target: "cloud" | "home" = "cloud") {
  flushSync(() => root.render(createElement(CloudMoveSheet, { target, onClose })));
  await settle();
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  fixture.dispatch.mockReset();
  fixture.bots = 3;
  onClose.mockReset();
  const kept = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => void kept.set(key, value), removeItem: (key: string) => void kept.delete(key) });
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  delete (window as unknown as { madaniDesktop?: unknown }).madaniDesktop;
  vi.unstubAllGlobals();
});

describe("move to cloud desktop", () => {
  it("without a Cloud: says what the person gets and its price, then checkout from this source, with the move to follow", async () => {
    const bridges = desktop({ account: { status: "connected", clouds: [] } as CloudAccountState });
    await render();
    expect(stage()).toBe("buy");
    const text = document.body.textContent ?? "";
    expect(text).toContain("All 3 bots move together, with their chats, memory, files and routines.");
    expect(text).toContain("Keeps working while your computer sleeps or is closed");
    expect(text).toContain("From $19/month + tax where applicable.");
    expect(text).toContain("After you pay, your bots move by themselves.");
    button("Get cloud desktop")!.click();
    await settle();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "openCloudAdd", source: "app_computer_move" });
    expect(onClose).toHaveBeenCalled();
    expect(Number(localStorage.getItem(MOVE_INTENT_KEY))).toBeGreaterThan(0);
    expect(bridges.cloudSendPage.setKeepHere).not.toHaveBeenCalled();
  });

  it("signed out: the same checkout begins with the sign-in", async () => {
    desktop({ account: { status: "signed-out" } as CloudAccountState });
    await render();
    button("Get cloud desktop")!.click();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "openCloudAdd", source: "app_computer_move", signIn: true });
  });

  it("with a Cloud the bots were kept away from: one tap moves all of them", async () => {
    const bridges = desktop();
    await render();
    expect(stage()).toBe("ready");
    button("Move 3 bots")!.click();
    await settle();
    expect(bridges.cloudSendPage.setKeepHere).toHaveBeenCalledWith(false);
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("with a Cloud never moved to: Move is the person's yes the first move waits for, not the keep-here switch it already is", async () => {
    // Seen Nov 14: keep-here was already off, so Move only turned it off again, the move went on waiting for a yes, and nothing happened.
    const bridges = desktop({ keep: { shown: true, on: false, moved: false, coming: false }, offer: { stage: "prompt", bots: 3 } });
    await render();
    expect(stage()).toBe("ready");
    button("Move 3 bots")!.click();
    await settle();
    expect(bridges.cloudSendPage.moveOfferAccept).toHaveBeenCalledWith("settings");
    expect(bridges.cloudSendPage.setKeepHere).not.toHaveBeenCalled();
  });

  it("after the checkout it asked for, finishes the move with no second tap, then forgets it", async () => {
    localStorage.setItem(MOVE_INTENT_KEY, String(Date.now()));
    const bridges = desktop();
    flushSync(() => root.render(createElement(CloudMoveWatcher)));
    await settle();
    expect(bridges.cloudSendPage.setKeepHere).toHaveBeenCalledWith(false);
    expect(localStorage.getItem(MOVE_INTENT_KEY)).toBeNull();
  });

  it("does nothing by itself without that checkout", async () => {
    const bridges = desktop();
    flushSync(() => root.render(createElement(CloudMoveWatcher)));
    await settle();
    expect(bridges.cloudSendPage.setKeepHere).not.toHaveBeenCalled();
  });

  it("while they move: how far it got, and Stop keeps them here", async () => {
    const bridges = desktop({ keep: { shown: true, on: false, moved: false, coming: false }, move: { phase: "copy", chats: { done: 2, total: 10 } } });
    await render();
    expect(stage()).toBe("moving");
    expect(document.body.querySelector("[role='status']")).not.toBeNull();
    expect(button("Get cloud desktop")).toBeUndefined();
    button("Stop and keep them here")!.click();
    await settle();
    expect(bridges.cloudSendPage.setKeepHere).toHaveBeenCalledWith(true);
  });

  it("once there: opens the Cloud desktop, and Move back asks first, then brings them home", async () => {
    const bridges = desktop({ keep: { shown: true, on: false, moved: true, coming: false } });
    await render();
    expect(stage()).toBe("moved");
    flushSync(() => button("Move back to this computer")!.click());
    expect(document.body.textContent).toContain("Move this computer's bots back?");
    flushSync(() => button("Cancel")!.click());
    expect(bridges.cloudSendPage.setKeepHere).not.toHaveBeenCalled();
    flushSync(() => button("Move back to this computer")!.click());
    button("Move back")!.click();
    await settle();
    expect(bridges.cloudSendPage.setKeepHere).toHaveBeenCalledWith(true);
    button("Open cloud desktop")!.click();
    await settle();
    expect(bridges.cloudAccount.connectHome).toHaveBeenCalledTimes(1);
  });

  it("says why when a step fails, and keeps the sheet open", async () => {
    const bridges = desktop();
    bridges.cloudSendPage.setKeepHere.mockRejectedValueOnce(new Error("My Cloud didn't answer."));
    await render();
    button("Move 3 bots")!.click();
    await settle();
    expect(document.body.querySelector("[role='alert']")?.textContent).toBe("My Cloud didn't answer.");
    expect(onClose).not.toHaveBeenCalled();
  });
});
