import type { ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";

import { PURCHASE_REFUSAL, purchaseGate } from "../purchase-gate.ts";
import type { Message } from "../store.ts";
import { CONFIRM_PURCHASE_PATH, createPurchaseRoutes, personSaid } from "./purchases.ts";

const summary = { merchant: "Acme", items: [{ name: "Kettle", quantity: 1 }], total: "$45.00" };
const said = (text: string): Message => ({ id: `u${text.length}`, at: 1, role: "user", kind: "text", text }) as Message;
const checkout = { content: [{ type: "text", text: 'Page t1: "Checkout" at https://shop.example/checkout\n- button "Place order" [ref=e9]' }] };

function call(body: unknown, messages: Message[], answer: { ok: true; approved: true } | { ok: false; text: string } = { ok: true, approved: true }) {
  const confirmPurchase = vi.fn(async () => answer);
  const route = createPurchaseRoutes({ hold: { confirmPurchase }, bot: () => ({ id: "b1", name: "Scout", color: "green" }) as never, messagesFor: () => messages });
  const sent: Array<{ status: number; body: Record<string, unknown> }> = [];
  const json = ((_res: ServerResponse, status: number, payload: Record<string, unknown>) => { sent.push({ status, body: payload }); }) as never;
  const done = route({ method: "POST", path: CONFIRM_PURCHASE_PATH, res: {} as ServerResponse, json, botId: "b1", threadId: "t1", readBody: async () => body, browserSession: "route-s1" });
  return { done, sent, confirmPurchase };
}

describe("confirm_purchase", () => {
  it("lets the browser take the purchase's last step once the person confirmed", async () => {
    purchaseGate.observe("route-s1", checkout);
    expect(purchaseGate.check("route-s1", "agent_browser_click", { ref: "e9" })).toBe(PURCHASE_REFUSAL);
    const { done, sent, confirmPurchase } = call({ summary }, [said("buy the kettle")]);
    await done;
    expect(confirmPurchase).toHaveBeenCalledWith(expect.objectContaining({ recorded: false, summary: expect.objectContaining({ merchant: "Acme" }) }));
    expect(sent).toEqual([{ status: 200, body: { text: expect.stringMatching(/confirmed/) } }]);
    expect(purchaseGate.check("route-s1", "agent_browser_click", { ref: "e9" })).toBeNull();
    purchaseGate.forget("route-s1");
  });

  it("a Cancel leaves the browser refusing", async () => {
    purchaseGate.observe("route-s1", checkout);
    const { done, sent } = call({ summary }, [], { ok: false, text: "madani bot did not buy this: the user declined." });
    await done;
    expect(sent[0]).toMatchObject({ status: 409 });
    expect(purchaseGate.check("route-s1", "agent_browser_click", { ref: "e9" })).toBe(PURCHASE_REFUSAL);
    purchaseGate.forget("route-s1");
  });

  it("buys without asking only on the person's own words from their latest message", async () => {
    const latest = [said("Just order it, no need to ask me first.")];
    expect(personSaid(latest, "no need to ask me first")).toBe(true);
    expect(personSaid(latest, "buy anything you like")).toBe(false);
    expect(personSaid(latest, "ask")).toBe(false);
    expect(personSaid([said("Order it without asking."), said("Actually, wait.")], "Order it without asking")).toBe(false);

    const refused = call({ summary, without_asking: true, quote: "go ahead and buy" }, latest);
    await refused.done;
    expect(refused.sent[0]).toMatchObject({ status: 400 });
    expect(refused.confirmPurchase).not.toHaveBeenCalled();

    const recorded = call({ summary, without_asking: true, quote: "no need to ask me first" }, latest);
    await recorded.done;
    expect(recorded.confirmPurchase).toHaveBeenCalledWith(expect.objectContaining({ recorded: true }));
    purchaseGate.forget("route-s1");
  });

  it("refuses a summary without a total", async () => {
    const { done, sent, confirmPurchase } = call({ summary: { merchant: "Acme", items: [{ name: "Kettle", quantity: 1 }] } }, []);
    await done;
    expect(sent[0]).toMatchObject({ status: 400, body: { error: expect.stringMatching(/total/) } });
    expect(confirmPurchase).not.toHaveBeenCalled();
  });
});
