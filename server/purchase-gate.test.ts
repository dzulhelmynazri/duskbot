import { describe, expect, it } from "vitest";

import { pointName, pointNameScript, PURCHASE_REFUSAL, PurchaseGate, withPointNames } from "./purchase-gate.ts";

const checkout = {
  content: [{ type: "text", text: 'Page t1: "Checkout" at https://shop.example/checkout\n- textbox "Card number" [ref=e3]\n- button "Apply" [ref=e4]\n- button "Place your order" [ref=e7]' }],
};
const agentBrowserSnapshot = { content: [{ type: "text", text: "https://shop.example/product/1\n- button \"Buy now\" [ref=e2]\n- button \"Add to cart\" [ref=e3]" }] };

function at(page: unknown, now = { t: 0 }) {
  const gate = new PurchaseGate(() => now.t);
  gate.observe("s1", page);
  return { gate, now };
}

describe("the browser's purchase gate", () => {
  it("refuses Place order by ref until the person confirmed, then lets exactly one through", () => {
    const { gate } = at(checkout);
    expect(gate.check("s1", "agent_browser_click", { ref: "e4" })).toBeNull();
    expect(gate.check("s1", "agent_browser_click", { ref: "e7" })).toBe(PURCHASE_REFUSAL);
    gate.grant("s1");
    expect(gate.check("s1", "agent_browser_click", { ref: "e7" })).toBeNull();
    gate.observe("s1", { content: [{ type: "text", text: "Clicked e7." }] });
    expect(gate.check("s1", "agent_browser_click", { ref: "e7" })).toBe(PURCHASE_REFUSAL);
  });

  it("gives the confirmation back when the click failed", () => {
    const { gate } = at(checkout);
    gate.grant("s1");
    expect(gate.check("s1", "agent_browser_click", { ref: "e7" })).toBeNull();
    gate.observe("s1", { isError: true, content: [{ type: "text", text: "The element is covered." }] });
    expect(gate.check("s1", "agent_browser_click", { ref: "e7" })).toBeNull();
  });

  it("reads agent-browser's @refs, selectors and text, Enter on a checkout page and a batch step", () => {
    const { gate } = at(agentBrowserSnapshot);
    expect(gate.check("s1", "agent_browser_click", { selector: "@e2" })).toBe(PURCHASE_REFUSAL);
    expect(gate.check("s1", "agent_browser_click", { selector: "@e3" })).toBeNull();
    expect(gate.check("s1", "agent_browser_click", { selector: 'button:has-text("Buy now")' })).toBe(PURCHASE_REFUSAL);
    expect(gate.check("s1", "agent_browser_click", { selector: "#place-order" })).toBe(PURCHASE_REFUSAL);
    expect(gate.check("s1", "agent_browser_click", { text: "Place order" })).toBe(PURCHASE_REFUSAL);
    expect(gate.check("s1", "agent_browser_press", { key: "Enter" })).toBeNull();

    const onCheckout = at(checkout).gate;
    expect(onCheckout.check("s1", "agent_browser_press", { key: "Enter" })).toBe(PURCHASE_REFUSAL);
    expect(onCheckout.check("s1", "agent_browser_fill", { ref: "e3", text: "4242", submit: true })).toBe(PURCHASE_REFUSAL);
    expect(onCheckout.check("s1", "agent_browser_fill", { ref: "e3", text: "4242" })).toBeNull();
    expect(onCheckout.check("s1", "agent_browser_batch", { steps: [{ do: "fill", ref: "e3", text: "4242" }, { do: "click", ref: "e7" }] })).toBe(PURCHASE_REFUSAL);
  });

  it("names a click by point from the page and gates it like a ref; one it cannot name counts on a checkout page", async () => {
    const answer = (name: string | null) => async () => name;
    const { gate } = at(agentBrowserSnapshot);
    const named = (name: string | null, args: Record<string, unknown> = { x: 300, y: 420 }) => withPointNames("agent_browser_click", args, answer(name));
    expect(gate.check("s1", "agent_browser_click", await named("Buy now"))).toBe(PURCHASE_REFUSAL);
    expect(gate.check("s1", "agent_browser_click", await named("Add to cart"))).toBeNull();
    expect(gate.check("s1", "agent_browser_click", await named(null))).toBeNull();
    const onCheckout = at(checkout).gate;
    expect(onCheckout.check("s1", "agent_browser_click", await named(null))).toBe(PURCHASE_REFUSAL);
    expect(onCheckout.check("s1", "agent_browser_click", await named("Apply"))).toBeNull();
    const batch = await withPointNames("agent_browser_batch", { steps: [{ do: "click", x: 10, y: 20 }] }, answer("Place your order"));
    expect(onCheckout.check("s1", "agent_browser_batch", batch)).toBe(PURCHASE_REFUSAL);
    expect(await withPointNames("agent_browser_click", { ref: "e2" }, answer("Buy now"))).toEqual({ ref: "e2" });
  });

  it("reads the name the page script returned through either engine's eval result", () => {
    expect(pointName({ content: [{ type: "text", text: "MADANI_HIT:Place%20order:END" }] })).toBe("Place order");
    expect(pointName({ content: [{ type: "text", text: JSON.stringify({ result: "MADANI_HIT:Pay%20%2445:END" }) }] })).toBe("Pay $45");
    expect(pointName({ content: [{ type: "text", text: "MADANI_HIT::END" }] })).toBeNull();
    expect(pointName({ isError: true, content: [{ type: "text", text: "agent_browser_eval is refused here" }] })).toBeNull();
    expect(pointNameScript(12.5, 40)).toContain("elementFromPoint(12.5, 40)");
  });

  it("a confirmation lasts ten minutes and stays with its own browser", () => {
    const { gate, now } = at(checkout);
    gate.observe("s2", checkout);
    gate.grant("s1");
    expect(gate.check("s2", "agent_browser_click", { ref: "e7" })).toBe(PURCHASE_REFUSAL);
    now.t = 11 * 60_000;
    expect(gate.check("s1", "agent_browser_click", { ref: "e7" })).toBe(PURCHASE_REFUSAL);
  });
});
