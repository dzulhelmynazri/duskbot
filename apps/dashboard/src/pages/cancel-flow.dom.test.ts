// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BillingOverview, Selection } from "../data/contracts";
import { fixtureCatalog } from "../data/fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const plus: Selection = { license: "personal", members: 1, desktop: "shared-s", size: null, region: "eu-central", interval: "month" };
const pro: Selection = { license: "starter", members: 1, desktop: "shared-m", size: null, region: "eu-central", interval: "month" };
const billingFor = (selection: Selection, offer = true): BillingOverview => ({
  subscription: { id: "sub", bundle: null, selection, status: "active", amountUsd: 20, currentPeriodEnd: Date.UTC(2026, 11, 13), cancelAt: null },
  paymentMethod: null, invoices: [], retention: { offer: offer ? { percent: 30, cycles: 3 } : null, applied: null },
});
const state = vi.hoisted(() => ({
  cloud: {} as Record<string, unknown>,
  session: { toast: (_message: string) => {} },
  usage: { month: { totals: { turns: 42 } }, bots: [{ bot: { routines: [{}, {}, {}] } }, { bot: { routines: [] } }], loading: false },
}));
vi.mock("../data/cloud", () => ({ useCloud: () => state.cloud }));
vi.mock("../data/session", () => ({ useSession: () => state.session }));
vi.mock("../data/usage", () => ({ useAccountUsage: () => state.usage }));

const makeSpies = () => ({ cancel: vi.fn(async (_reason: string) => {}), changePlan: vi.fn(async (_selection: Selection, _approved?: number) => {}), retentionStep: vi.fn((_input: object) => {}),
  takeDiscount: vi.fn(async (_reason: string) => {}), updateCard: vi.fn(async () => {}), onClose: vi.fn(() => {}) });
let spies = makeSpies();
beforeEach(() => { spies = makeSpies(); });
const roots: Root[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.innerHTML = ""; vi.restoreAllMocks(); });

async function open(selection: Selection, offer = true) {
  state.cloud = { billing: billingFor(selection, offer), ...spies };
  const { CancelFlow } = await import("./cancel-flow");
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  roots.push(root);
  await act(async () => root.render(createElement(CancelFlow, { open: true, onClose: () => spies.onClose(), catalog: fixtureCatalog })));
}
const title = () => document.querySelector("[role=dialog] h2")?.textContent;
const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === label) ?? null;
const click = async (label: string) => { const b = button(label); expect(b, label).not.toBeNull(); await act(async () => b!.click()); };
const pick = async (label: string) => {
  const input = [...document.querySelectorAll<HTMLLabelElement>("label")].find((l) => l.textContent === label)?.querySelector("input");
  expect(input, label).toBeTruthy();
  await act(async () => input!.click());
};

test("the plan page shows free until someone is on a cloud plan, then plus, pro and team", async () => {
  const { tiersFor } = await import("./Billing");
  expect(tiersFor(false)).toEqual(["free", "starter", "pro"]);
  expect(tiersFor(true)).toEqual(["starter", "pro", "team"]);
});

test("skipping the reason still offers a way to keep it, then a clearly labeled cancel, and records nothing", async () => {
  await open(plus);
  expect(title()).toBe("what's going on?");
  await click("continue");
  expect(title()).toBe("before you go");
  expect(document.body.textContent).toContain("30% off your next 3 months");
  await click("continue to cancel");
  expect(title()).toBe("cancel your plan?");
  expect(document.body.textContent).toContain("your 2 bots stop working when your mac sleeps");
  expect(document.body.textContent).toContain("your 3 routines only run while your mac is awake");
  expect(document.body.textContent).toContain("your madani cloud files are kept for 30 days, then deleted");
  await click("cancel my plan");
  expect(spies.cancel).toHaveBeenCalledWith("");
  expect(spies.retentionStep).not.toHaveBeenCalled();
  expect(spies.onClose).toHaveBeenCalled();
});

test("too expensive: records the reason, offers the one-time discount and takes it", async () => {
  await open(plus);
  await pick("it's too expensive");
  await click("continue");
  expect(spies.retentionStep).toHaveBeenCalledWith({ reason: "price", step: "reason", outcome: "shown" });
  expect(title()).toBe("a lighter way to keep it");
  expect(document.body.textContent).toContain("30% off your next 3 months");
  await click("take 30% off");
  expect(spies.takeDiscount).toHaveBeenCalledWith("price");
  expect(spies.cancel).not.toHaveBeenCalled();
});

test("too expensive on pro without the discount: offers plus, and cancel is still one click away", async () => {
  await open(pro, false);
  await pick("it's too expensive");
  await click("continue");
  expect(button("take 30% off")).toBeNull();
  await click("switch to plus");
  expect(spies.changePlan).toHaveBeenCalledWith(expect.objectContaining({ desktop: "shared-s", license: "starter" }), 0);
  expect(spies.retentionStep).toHaveBeenLastCalledWith({ reason: "price", step: "help", outcome: "downgrade" });
});

test("something broke: fix links first, then continue to cancel, and keeping the plan is recorded", async () => {
  await open(plus);
  await pick("something broke");
  await click("continue");
  expect(title()).toBe("let's fix it first");
  expect([...document.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(expect.arrayContaining(["/cloud", expect.stringMatching(/^mailto:hello@madani\.bot/)]));
  await click("continue to cancel");
  expect(title()).toBe("cancel your plan?");
  await click("keep my plan");
  expect(spies.retentionStep).toHaveBeenLastCalledWith({ reason: "broken", step: "confirm", outcome: "kept" });
  expect(spies.cancel).not.toHaveBeenCalled();
});

test("not using it shows what the bots did; a plan with a work license ends only the madani cloud", async () => {
  await open(pro);
  await pick("i'm not using it");
  await click("continue");
  expect(document.body.textContent).toContain("this month your 2 bots took 42 turns.");
  await click("continue to cancel");
  expect(title()).toBe("cancel your madani cloud?");
  await click("cancel madani cloud");
  expect(spies.changePlan).toHaveBeenCalledWith({ ...pro, desktop: "none", size: null });
  expect(spies.retentionStep).toHaveBeenLastCalledWith({ reason: "unused", step: "confirm", outcome: "cancelled" });
});

test("pro on a free trial cancels the whole plan at the trial's end, never a plan change that bills at once", async () => {
  const until = Date.now() + 3 * 86_400_000;
  const billing = billingFor(pro, false);
  billing.subscription = { ...billing.subscription!, currentPeriodEnd: until, trialEndsAt: until };
  state.cloud = { billing, ...spies };
  const { CancelFlow } = await import("./cancel-flow");
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  roots.push(root);
  await act(async () => root.render(createElement(CancelFlow, { open: true, onClose: () => spies.onClose(), catalog: fixtureCatalog })));
  await pick("i'm switching to something else");
  await click("continue");
  expect(button("switch to plus")).toBeNull();
  expect(title()).toBe("cancel your plan?");
  expect(document.body.textContent).toContain("you won't be charged.");
  expect(document.body.textContent).not.toContain("work license stays");
  await click("cancel my plan");
  expect(spies.cancel).toHaveBeenCalledWith("switching");
  expect(spies.changePlan).not.toHaveBeenCalled();
});

test("switching on pro is offered plus first; keeping the plan is the main button", async () => {
  await open(pro, false);
  await pick("i'm switching to something else");
  await click("continue");
  expect(title()).toBe("before you go");
  expect(button("switch to plus")).not.toBeNull();
  await click("continue to cancel");
  expect(title()).toBe("cancel your madani cloud?");
  await click("cancel madani cloud");
  expect(spies.changePlan).toHaveBeenCalledWith({ ...pro, desktop: "none", size: null });
});

test("with nothing cheaper to offer, switching goes straight to the cancel: at most three screens", async () => {
  await open(plus, false);
  await pick("i'm switching to something else");
  await click("continue");
  expect(title()).toBe("cancel your plan?");
  await click("cancel my plan");
  expect(spies.cancel).toHaveBeenCalledWith("switching");
});
