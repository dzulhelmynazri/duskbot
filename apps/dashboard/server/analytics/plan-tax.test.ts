// plan names and tax in the owner's revenue: a bundle's cart is its bundle in any region, and money counts before tax
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Cart } from "../../../../shared/billing-api.ts";
import { BILLING_CONFIG, managedRegionConfig } from "../billing/plans.ts";
import { bundleOf, quote } from "../billing/pricing.ts";
import { draft, ledgerId, type LedgerEntry } from "../billing/ledger.ts";
import type { StoredInvoice, StoredSubscription } from "../billing/store.ts";
import { createBilling } from "../billing/index.ts";
import { useStateBackend, type StateBackend } from "../persistence/backend.ts";
import { paymentsOf } from "./revenue.ts";
import { billingSteps } from "./profile.ts";
import { subscriptionReport, type SubscriptionsInput } from "./subscriptions.ts";

const NOW = Date.UTC(2026, 10, 13, 12);
const plus = (interval: "month" | "year", region = "us-west-2"): Cart => ({ interval, license: { kind: "none" }, desktop: { kind: "shared_s", region } });
const label = (sub: StoredSubscription) => { const id = quote(sub.cart, BILLING_CONFIG).bundle; return BILLING_CONFIG.bundles.find(b => b.id === id)?.label.toLowerCase() ?? "custom"; };

describe("plan names", () => {
  it("names every bundle's cart by its bundle, monthly or yearly, in any region", () => {
    for (const config of [BILLING_CONFIG, managedRegionConfig(BILLING_CONFIG)]) for (const bundle of config.bundles) for (const interval of ["month", "year"] as const) {
      const cart = { ...bundle.cart, interval } as Cart;
      expect(bundleOf(cart, BILLING_CONFIG)).toBe(bundle.id);
      expect(quote(cart, BILLING_CONFIG).bundle).toBe(bundle.id);
    }
    expect(bundleOf(plus("month", "us-west-2"))).toBe("starter");
    expect(bundleOf(plus("year", "sin"))).toBe("starter");
  });
  it("calls only a cart no bundle has custom", () => {
    expect(bundleOf({ interval: "month", license: { kind: "solo" }, desktop: { kind: "shared_s", region: "us-west-2" } })).toBeNull();
    expect(bundleOf({ interval: "month", license: { kind: "team", members: 3 }, desktop: { kind: "dedicated", region: "fsn1", spec: { vcpu: 8, ramGb: 16, diskGb: 160 } } })).toBeNull();
    expect(bundleOf({ interval: "month", license: { kind: "none" }, desktop: { kind: "shared_m", region: "us-west-2" } })).toBeNull();
  });
});

// one Indian buyer on plus monthly: $20 plus 18% GST, charged $23.60
function taxed(opts: { invoiceTax: boolean }): SubscriptionsInput {
  const sub: StoredSubscription = { id: "sub_1", accountId: "acct_1", providerSubscriptionId: "sub_dodo", checkoutId: "chk_1", cart: plus("month"), totalCents: 2000, lines: [], status: "active",
    licenseId: null, cloudId: null, currentPeriodStart: NOW - 3_600_000, currentPeriodEnd: NOW + 30 * 86_400_000, cancelAtPeriodEnd: false, createdAt: NOW - 3_600_000, updatedAt: NOW, version: 1, source: "dash_billing" };
  const invoice: StoredInvoice = { id: "inv_1", accountId: "acct_1", providerPaymentId: "pay_1", subscriptionId: "sub_1", checkoutId: "chk_1", amountCents: 2360,
    ...(opts.invoiceTax ? { taxCents: 360 } : {}), currency: "USD", status: "paid", description: "madani cloud plus", createdAt: NOW - 3_600_000 };
  const ledger: LedgerEntry[] = [
    { ...draft({ key: "pay:1", type: "payment.succeeded", at: NOW - 3_600_000, via: "webhook", accountId: "acct_1", subscriptionId: "sub_1", providerPaymentId: "pay_1", amountCents: 2360, taxCents: 360, netCents: 2000, plan: "custom", country: "IN" }), id: ledgerId("pay:1"), recordedAt: NOW },
    { ...draft({ key: "act:1", type: "subscription.cancel_scheduled", at: NOW - 60_000, via: "webhook", accountId: "acct_1", subscriptionId: "sub_1", plan: "custom" }), id: ledgerId("act:1"), recordedAt: NOW },
  ];
  return { subscriptions: [sub], invoices: [invoice], refunds: [], ledger, checkouts: [], customers: [], accounts: new Map([["acct_1", { email: "buyer@example.test", createdAt: NOW - 86_400_000 }]]),
    activity: new Map(), planOf: label, planLabel: id => BILLING_CONFIG.bundles.find(b => b.id === id)?.label.toLowerCase() ?? id, now: NOW };
}

describe("revenue before tax", () => {
  for (const invoiceTax of [true, false]) it(`counts $20, not $23.60, with the tax ${invoiceTax ? "on the invoice" : "only on the ledger row"}`, () => {
    const input = taxed({ invoiceTax });
    const report = subscriptionReport(input);
    expect(report.headline.mrr).toBe(2000);
    expect(report.cash).toMatchObject({ gross: 2000, tax: 360 });
    expect(report.customers[0]).toMatchObject({ plan: "plus", mrr: 2000, ltv: 2000 });
    const paid = report.feed.find(item => item.kind === "new")!;
    expect(paid).toMatchObject({ amountCents: 2000, plan: "plus" });
    // a ledger row written as custom reads by its subscription's plan today
    expect(report.feed.find(item => item.kind === "cancel_scheduled")!.plan).toBe("plus");

    const payments = paymentsOf(input);
    expect(payments).toEqual([expect.objectContaining({ amountCents: 2000, taxCents: 360, kind: "new" })]);
    const step = billingSteps(payments, []).find(item => item.kind === "paid")!;
    expect(step).toMatchObject({ amountCents: 2000, taxCents: 360 });
  });
  it("takes a refund of a taxed charge back before tax too", () => {
    const input = taxed({ invoiceTax: true });
    input.refunds = [{ id: "ref_1", paymentId: "pay_1", amountCents: 2360, currency: "USD" }];
    expect(subscriptionReport(input).cash).toMatchObject({ gross: 2000, refunds: 2000 });
    const refund = paymentsOf(input).find(payment => payment.kind === "refund")!;
    expect(refund).toMatchObject({ amountCents: -2000, taxCents: -360 });
  });
  it("leaves an untaxed charge whole", () => {
    const input = taxed({ invoiceTax: false });
    input.ledger = [];
    input.invoices = [{ ...input.invoices[0]!, amountCents: 2000 }];
    expect(subscriptionReport(input).cash).toMatchObject({ gross: 2000, tax: 0 });
    expect(paymentsOf(input)[0]).toMatchObject({ amountCents: 2000, taxCents: 0 });
  });
});

describe("the fake billing provider", () => {
  let dir = "";
  afterEach(() => { useStateBackend(null); if (dir) rmSync(dir, { recursive: true, force: true }); });
  it("refuses a database store: its made-up payments would read as revenue", () => {
    dir = mkdtempSync(join(tmpdir(), "madani-fake-billing-"));
    useStateBackend({} as StateBackend);
    expect(() => createBilling({ dataDir: dir, publicUrl: "https://preview.example.test", env: { MADANI_BILLING_PROVIDER: "fake" } } as never)).toThrow(/refuses a MongoDB store/);
  });
});
