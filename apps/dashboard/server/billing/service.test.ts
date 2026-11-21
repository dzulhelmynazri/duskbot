import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Cart } from "../../../../shared/billing-api.ts";
import type { CloudsService, DesktopPlan, OrderInput, StoredCloud } from "../clouds/types.ts";
import { BILLING_CONFIG } from "./plans.ts";
import { quote } from "./pricing.ts";
import { createFakeBillingProvider } from "./fake-provider.ts";
import { createBillingStore } from "./store.ts";
import { CHECKOUT_BURST, CHECKOUT_REUSE_MS, createBillingService } from "./service.ts";
import { BillingProviderError } from "./types.ts";

const owner = { id: "owner", email: "owner@example.com" }, stranger = { id: "stranger", email: "stranger@example.com" };
const day = 86_400_000;
function fakeClouds() {
  const rows: StoredCloud[] = [];
  function get(id: string) { return rows.find(cloud => cloud.id === id) ?? null; }
  const clouds: CloudsService = {
    order: vi.fn(({ team, ...input }: OrderInput) => {
      const cloud: StoredCloud = { ...input, ...(team ? { team: { id: input.id ?? `cloud_${rows.length}`, name: team } } : {}), id: input.id ?? `cloud_${rows.length}`, desiredSpec: { ...input.spec }, subscriptionId: null, status: "checkout", setupStep: null, wantPower: "on", serverId: null, ipv4: null, origin: null, bootstrapSecret: "fixture", workspaceId: null, primary: false, hidden: false, paymentProblem: false, suspended: null, destroyAt: null, error: null, attempts: 0, nextAttemptAt: 0, createdAt: 0, updatedAt: 0, powerSince: 0 };
      rows.push(cloud); return cloud;
    }),
    pairMember: vi.fn(async () => ({ origin: "https://team.example.test", code: "AAAA-BBBB-CCCC", expiresAt: time + 300_000 })),
    memberLeft: vi.fn(async () => "done" as const),
    activate: vi.fn((id: string, subscriptionId: string, plan: DesktopPlan) => { Object.assign(get(id)!, plan, { subscriptionId, status: "provisioning" }); }),
    changePlan: vi.fn((id: string, plan: DesktopPlan) => { Object.assign(get(id)!, plan); }),
    setPaymentProblem: vi.fn((id: string, problem: boolean) => { get(id)!.paymentProblem = problem; }),
    setReview: vi.fn((id: string, review: boolean) => { const cloud = get(id)!; if (review) cloud.review = true; else delete cloud.review; }),
    scheduleDestroy: vi.fn((id: string, at: number) => { get(id)!.destroyAt = at; }),
    cancelDestroy: vi.fn((id: string) => { get(id)!.destroyAt = null; }),
    end: vi.fn((id: string, destroyAt: number) => { Object.assign(get(id)!, { status: "stopped", destroyAt, ended: true, endedAt: time }); }),
    abandon: vi.fn((id: string) => { const cloud = get(id)!; if (cloud.status === "checkout") cloud.status = "destroyed"; }),
    revivable: vi.fn((id: string) => { const cloud = get(id); return !!cloud?.ended && cloud.status !== "destroyed" && (cloud.destroyAt === null || cloud.destroyAt > time); }),
    revive: vi.fn((id: string, subscriptionId: string, plan: DesktopPlan) => {
      const cloud = get(id); if (!cloud?.ended || cloud.status === "destroyed") return false;
      Object.assign(cloud, plan, { subscriptionId, ended: undefined, endedAt: undefined, destroyAt: null, status: "running", revivedAt: time }); return true;
    }),
    destroyForDeletedAccount: vi.fn((id: string) => { const cloud = get(id)!; if (cloud.status === "destroyed") return false; Object.assign(cloud, { ended: true, endedAt: time, destroyAt: time }); return true; }),
    scrubAccount: (accountId, anonId) => { for (const cloud of rows) if (cloud.accountId === accountId) { cloud.accountId = anonId; cloud.name = "Deleted"; } },
    get, owned: (accountId, id) => rows.find(cloud => cloud.id === id && cloud.accountId === accountId) ?? null, byWorkspace: workspaceId => rows.find(cloud => cloud.workspaceId === workspaceId) ?? null,
    list: (accountId, includeHidden = false) => rows.filter(cloud => cloud.accountId === accountId && (includeHidden || !cloud.hidden)),
    view: cloud => ({ id: cloud.id, name: cloud.name, color: cloud.color, kind: cloud.kind, placement: cloud.placement, status: cloud.status, setupStep: cloud.setupStep, region: cloud.region, machine: cloud.spec, botComputers: cloud.botComputers, origin: cloud.origin, workspaceId: cloud.workspaceId, lastReportAt: null, destroyAt: cloud.destroyAt, error: cloud.error, subscriptionId: cloud.subscriptionId, createdAt: cloud.createdAt }),
    rename: (_accountId, id, patch) => Object.assign(get(id)!, patch), suspend: async () => {}, resume: async () => {}, hide: (_accountId, id) => get(id)!, power: async (_accountId, id) => get(id)!,
    pair: async () => ({ origin: "https://fixture.test", code: "fixture", expiresAt: 0 }), reconcile: async () => {}, close() {},
  };
  return clouds;
}

let dataDir: string, time: number;
let store: ReturnType<typeof createBillingStore>, provider: ReturnType<typeof createFakeBillingProvider>, service: ReturnType<typeof createBillingService>, clouds: CloudsService;
let config: typeof BILLING_CONFIG;
const preset = (index: number, interval: Cart["interval"] = "month"): Cart => ({ ...structuredClone(config.bundles[index].cart), interval });
const licensedDesktop = (): Cart => ({ ...preset(1), license: { kind: "solo" } });
const desktopOnly = (): Cart => ({ ...preset(1), license: { kind: "none" } });
function deliver(deliveries: Array<{ headers: Record<string, string>; body: Buffer }>) { return deliveries.map(delivery => service.handleWebhook(delivery.headers, delivery.body)); }
async function buy(cart = licensedDesktop(), account = owner) {
  const answer = await service.checkout(account, { kind: "cart", cart });
  const checkout = store.state.checkouts.find(checkout => checkout.id === answer.checkoutId)!;
  const deliveries = provider.complete(checkout.providerSessionId!); deliver(deliveries);
  return { answer, checkout, deliveries, sub: store.state.subscriptions.find(sub => sub.checkoutId === checkout.id)! };
}
function signed(type: string, data: object, id = `event_${store.state.webhookEvents.length}`) {
  return provider.sign(id, { business_id: "fixture", timestamp: new Date(time).toISOString(), type, data });
}
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "madani-billing-fixture-")); time = Date.UTC(2026, 10, 8); config = structuredClone(BILLING_CONFIG);
  store = createBillingStore(dataDir); provider = createFakeBillingProvider({ now: () => time }); clouds = fakeClouds();
  service = createBillingService({ store, provider, clouds, config, publicUrl: "https://dashboard.test", now: () => time });
});
afterEach(() => { service.close(); rmSync(dataDir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("billing service isolated fixture", () => {
  it("completes a checkout, persists its license and invoice, and replays without side effects", async () => {
    const { answer, sub, deliveries } = await buy();
    expect(sub).toMatchObject({ status: "active", totalCents: quote(licensedDesktop(), config).totalCents, cloudId: answer.cloudId, version: 1 });
    expect(service.licenses(owner.id)[0]).toMatchObject({ kind: "solo", status: "active", seats: 1, members: [{ email: owner.email, role: "owner", accountId: owner.id }] });
    expect(service.invoices(owner.id).invoices[0]).toMatchObject({ amountCents: quote(licensedDesktop(), config).totalCents, currency: "USD", status: "paid" });
    expect(store.state.invoices[0].subscriptionId).toBe(sub.id);
    expect(clouds.activate).toHaveBeenCalledExactlyOnceWith(answer.cloudId, sub.id, { kind: "shared_s", placement: "pool", spec: { vcpu: 2, ramGb: 4, diskGb: 20 }, botComputers: 2 });
    const before = structuredClone(store.state); expect(deliver(deliveries)).toEqual([{ duplicate: true }, { duplicate: true }]);
    expect(store.state).toEqual(before); expect(clouds.activate).toHaveBeenCalledTimes(1);
    const newId = provider.sign("another_activation", deliveries[1].body); deliver([newId]);
    expect(store.state.subscriptions).toHaveLength(1); expect(clouds.activate).toHaveBeenCalledTimes(1);
    service.close(); store = createBillingStore(dataDir);
    expect(store.state.subscriptions[0].id).toBe(sub.id);
    if (process.platform !== "win32") expect(statSync(join(dataDir, "billing.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dataDir, "billing.json"), "utf8")).not.toContain(provider.secret);
    expect(service.appState(owner)).toMatchObject({ entitlement: { plan: "pro", tier: "custom", status: "active" } });
  });
  it("shows no cloud for an unpaid checkout, leaves nothing once it lapses, and shows the cloud once paid", async () => {
    const answer = await service.checkout(owner, { kind: "cart", cart: desktopOnly() });
    expect(clouds.get(answer.cloudId!)?.status).toBe("checkout");
    expect(service.overview(owner).clouds).toEqual([]);
    time += (config.checkoutOpenMinutes + 1) * 60_000;
    const retry = await service.checkout(owner, { kind: "cart", cart: desktopOnly() });
    expect(clouds.get(answer.cloudId!)?.status).toBe("destroyed");
    expect(service.overview(owner).clouds).toEqual([]);
    const row = store.state.checkouts.find(checkout => checkout.id === retry.checkoutId)!;
    deliver(provider.complete(row.providerSessionId!));
    expect(service.overview(owner).clouds.map(cloud => [cloud.id, cloud.status])).toEqual([[retry.cloudId, "provisioning"]]);
  });
  it("records where each checkout started on the checkout and its subscription, and counts the funnel by source", async () => {
    const started = time;
    const paid = await service.checkout(owner, { kind: "cart", cart: desktopOnly() }, { source: "app_routines" });
    const row = store.state.checkouts.find(checkout => checkout.id === paid.checkoutId)!;
    deliver(provider.complete(row.providerSessionId!));
    const sub = store.state.subscriptions.find(item => item.checkoutId === row.id)!;
    expect([row.source, sub.source, sub.status]).toEqual(["app_routines", "app_routines", "active"]);
    const other = { id: "acct_other", email: "other@example.test" };
    await service.checkout(other, { kind: "cart", cart: desktopOnly() }, { source: "dash_billing" });
    await service.checkout({ id: "acct_third", email: "third@example.test" }, { kind: "cart", cart: desktopOnly() }, { source: "something_new" });
    await service.checkout({ id: "acct_fourth", email: "fourth@example.test" }, { kind: "cart", cart: { interval: "month", license: { kind: "solo" }, desktop: { kind: "none" } } });
    expect(store.state.checkouts.map(checkout => checkout.source)).toEqual(["app_routines", "dash_billing", "other", null]);
    expect(service.funnel(started, time + 1)).toEqual({ v: 1, from: started, to: time + 1, totals: { started: 4, paid: 1, active: 1 }, rows: [
      { source: "app_routines", started: 1, paid: 1, active: 1 }, { source: "dash_billing", started: 1, paid: 0, active: 0 },
      { source: "other", started: 1, paid: 0, active: 0 }, { source: "unknown", started: 1, paid: 0, active: 0 }] });
    expect(service.funnel(time + 1, time + 2).totals).toEqual({ started: 0, paid: 0, active: 0 });
  });

  it("refuses bad signatures without modifying state and records unknown signed events", () => {
    const delivery = signed("payment.succeeded", { payment_id: "p", total_amount: 1, currency: "USD", metadata: { checkoutId: "unknown" } });
    const before = structuredClone(store.state);
    expect(() => service.handleWebhook({ ...delivery.headers, "webhook-signature": "v1,bad" }, delivery.body)).toThrow(expect.objectContaining({ status: 401, code: "bad_signature" }));
    expect(store.state).toEqual(before); deliver([delivery]); expect(store.state.invoices).toHaveLength(0); expect(store.state.webhookEvents).toHaveLength(1);
    expect(deliver([delivery])).toEqual([{ duplicate: true }]);
  });
  it("records a payment and its refund once, including differently signed duplicates", async () => {
    const { deliveries } = await buy(); deliver(deliveries);
    deliver([provider.sign("payment_again", deliveries[0].body)]); expect(store.state.invoices).toHaveLength(1);
    const refund = provider.refund(store.state.invoices[0].providerPaymentId); deliver(refund); deliver(refund); deliver([provider.sign("refund_again", refund[0].body)]);
    expect(store.state.refunds).toHaveLength(1); expect(service.invoices(owner.id).invoices[0].status).toBe("refunded");
    const partial = signed("refund.succeeded", { refund_id: "extra_refund", payment_id: store.state.invoices[0].providerPaymentId, amount: 100, currency: "USD" }); deliver([partial]);
    expect(service.invoices(owner.id).invoices[0].status).toBe("refunded");
  });
  it("cancels with a trimmed survey, schedules deletion, and keeps the subscription", async () => {
    const { sub } = await buy();
    expect(await service.cancel(owner, sub.id, { answer: "price", expected: "  cheaper  ", improve: "  flexibility " })).toMatchObject({ cancelAtPeriodEnd: true });
    expect(store.state.feedback[0]).toMatchObject({ accountId: owner.id, subscriptionId: sub.id, cloudId: sub.cloudId, answer: "price", expected: "cheaper", improve: "flexibility" });
    expect(clouds.scheduleDestroy).toHaveBeenLastCalledWith(sub.cloudId, sub.currentPeriodEnd! + 30 * day);
    expect(provider.cancelCalls[0]).toEqual({ subscriptionId: sub.providerSubscriptionId, cancel: true });
    await service.keep(owner, sub.id); expect(sub.cancelAtPeriodEnd).toBe(false); expect(clouds.cancelDestroy).toHaveBeenLastCalledWith(sub.cloudId);
    expect(provider.cancelCalls.at(-1)?.cancel).toBe(false);
    service.feedback(owner, { cloudId: sub.cloudId, survey: { answer: "later" } }); expect(store.state.feedback).toHaveLength(2);
    await expect(service.cancel(owner, sub.id, { answer: "other", improve: "x".repeat(2001) })).rejects.toMatchObject({ code: "invalid_request" });
    expect(() => service.feedback(stranger, { cloudId: sub.cloudId, survey: { answer: "later" } })).toThrow(expect.objectContaining({ code: "not_found" }));
  });
  it("expires and binds confirmations, detects price changes and preserves the plan on provider failure", async () => {
    const { sub } = await buy();
    let preview = await service.previewChange(owner, sub.id, preset(2)); time += 600_000;
    await expect(service.change(owner, sub.id, preview.confirmation)).rejects.toMatchObject({ code: "confirmation_required" });
    preview = await service.previewChange(owner, sub.id, preset(2)); config.desktops.shared_m.monthlyCents! += 100;
    await expect(service.change(owner, sub.id, preview.confirmation)).rejects.toMatchObject({ code: "price_changed" });
    preview = await service.previewChange(owner, sub.id, preset(2)); provider.failChangePlan = true;
    await expect(service.change(owner, sub.id, preview.confirmation)).rejects.toMatchObject({ status: 503, code: "unavailable" });
    expect(sub.totalCents).toBe(quote(licensedDesktop(), BILLING_CONFIG).totalCents); expect(clouds.changePlan).not.toHaveBeenCalled();
    await expect(service.change(stranger, sub.id, preview.confirmation)).rejects.toMatchObject({ code: "not_found" });
  });
  it("licenses owners and invited members, binds normalized emails and enforces seats", async () => {
    expect(service.licenseCheck(owner).work).toBe("free_until"); time = config.freeWorkUntil!; expect(service.licenseCheck(owner).work).toBe("unlicensed");
    const { sub } = await buy(preset(3)); expect(service.licenseCheck(owner).work).toBe("licensed");
    service.addMember(owner, sub.licenseId!, "  Friend@Example.com  ");
    expect(() => service.addMember(owner, sub.licenseId!, "full@example.com")).toThrow(expect.objectContaining({ code: "seats_full" }));
    const friend = { id: "friend", email: "friend@example.com" }; expect(service.licenseCheck(friend)).toMatchObject({ work: "licensed", license: { role: "member" } });
    expect(service.licenses(friend.id)[0].members[1].accountId).toBe("friend");
    expect(() => service.removeMember(owner, sub.licenseId!, owner.email)).toThrow(expect.objectContaining({ code: "forbidden" }));
    expect(() => service.addMember(friend, sub.licenseId!, "bad@example.com")).toThrow(expect.objectContaining({ code: "not_found" }));
    service.removeMember(owner, sub.licenseId!, friend.email); expect(service.licenseCheck(friend).work).toBe("unlicensed");
  });
  it("keeps paid license grace, renews periods, respects cancellation and expires", async () => {
    const { sub } = await buy(); const until = sub.currentPeriodEnd!;
    deliver(provider.fail(sub.providerSubscriptionId!)); expect(sub.status).toBe("payment_problem"); expect(clouds.setPaymentProblem).toHaveBeenLastCalledWith(sub.cloudId, true);
    expect(service.licenseCheck(owner)).toMatchObject({ work: "licensed", license: { status: "grace", validUntil: until } });
    time = until; expect(service.appState(owner).entitlement).toMatchObject({ status: "inactive", expiresAt: null });
    expect(service.licenseCheck(owner).license).toBeNull();
    await service.cancel(owner, sub.id); const cancelCalls = vi.mocked(clouds.cancelDestroy).mock.calls.length;
    deliver(provider.renew(sub.providerSubscriptionId!)); expect(sub.currentPeriodStart).toBe(until); expect(sub.currentPeriodEnd).toBeGreaterThan(until);
    expect(clouds.cancelDestroy).toHaveBeenCalledTimes(cancelCalls); expect(clouds.setPaymentProblem).toHaveBeenLastCalledWith(sub.cloudId, false);
    deliver(provider.expire(sub.providerSubscriptionId!)); expect(sub.status).toBe("ended"); expect(service.licenses(owner.id)[0].status).toBe("expired");
    expect(clouds.end).toHaveBeenLastCalledWith(sub.cloudId, time + 30 * day); expect(service.appState(owner).primary).toBeNull();
  });
  it("enforces open checkout, license exclusivity, desktop cap, and account rate limits", async () => {
    await service.checkout(owner, { kind: "cart", cart: preset(2) });
    await service.checkout(owner, { kind: "cart", cart: licensedDesktop() });
    expect(store.state.checkouts.map(checkout => checkout.status)).toEqual(["expired", "open"]);
    deliver(provider.complete(store.state.checkouts[1].providerSessionId!));
    await expect(service.checkout(owner, { kind: "cart", cart: preset(2) })).rejects.toMatchObject({ code: "already_subscribed" });
    await buy(desktopOnly()); config.maxCloudsPerAccount = 2;
    await expect(service.checkout(owner, { kind: "cart", cart: desktopOnly() })).rejects.toMatchObject({ code: "already_subscribed" });
    await expect(service.checkout(owner, { kind: "cart", cart: { ...desktopOnly(), interval: "year" } })).rejects.toMatchObject({ code: "cap" });
    config.checkoutsPerHour = 2; await expect(service.checkout(owner, { kind: "cart", cart: { interval: "month", license: { kind: "solo" }, desktop: { kind: "none" } } })).rejects.toMatchObject({ code: "rate_limited" });
    await expect(service.checkout(stranger, { kind: "cart", cart: preset(0) })).rejects.toMatchObject({ code: "invalid_request" });
  });
  it("reserves concurrent checkouts before awaiting the provider and abandons failures", async () => {
    let release: (() => void) | undefined;
    const original = provider.createCheckout;
    vi.spyOn(provider, "createCheckout").mockImplementation(async input => { await new Promise<void>(resolve => { release = resolve; }); return original(input); });
    const pending = service.checkout(owner, { kind: "cart", cart: preset(1) });
    await expect(service.checkout(owner, { kind: "cart", cart: preset(1) })).rejects.toMatchObject({ code: "checkout_open" }); release!(); await pending;
    time += 31 * 60_000; vi.mocked(provider.createCheckout).mockRejectedValue(new Error("provider fixture failure"));
    await expect(service.checkout(owner, { kind: "cart", cart: preset(1) })).rejects.toMatchObject({ code: "unavailable" });
    expect(store.state.checkouts.map(checkout => checkout.status)).toEqual(["expired", "expired"]); expect(clouds.abandon).toHaveBeenCalledTimes(2);
  });
  it("paginates invoices at equal timestamps without skipping or duplicating and protects downloads", async () => {
    const { sub } = await buy(); deliver(provider.renew(sub.providerSubscriptionId!)); deliver(provider.renew(sub.providerSubscriptionId!));
    const first = service.invoices(owner.id, null, 2), second = service.invoices(owner.id, first.nextCursor, 2);
    expect(first.invoices).toHaveLength(2); expect(second.invoices).toHaveLength(1); expect(second.nextCursor).toBeNull();
    expect(new Set([...first.invoices, ...second.invoices].map(invoice => invoice.id)).size).toBe(3);
    expect(first.invoices[0].downloadUrl).toBe(`/v1/billing/invoices/${first.invoices[0].id}/download`);
    expect(await service.invoiceDownload(owner.id, first.invoices[0].id)).toMatchObject({ redirect: expect.stringContaining("https://") });
    await expect(service.invoiceDownload(stranger.id, first.invoices[0].id)).rejects.toMatchObject({ code: "not_found" });
    expect(service.invoices(stranger.id).invoices).toEqual([]); expect(() => service.invoices(owner.id, "bad")).toThrow(expect.objectContaining({ code: "invalid_request" }));
    expect(await service.updateCard(owner, sub.id, "/billing")).toEqual({ url: `https://test.checkout.dodopayments.com/fake_card_${encodeURIComponent(sub.providerSubscriptionId!)}` });
    await expect(service.updateCard(stranger, sub.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(service.updateCard(owner, sub.id, "//evil.test")).rejects.toMatchObject({ code: "invalid_request" });
    expect(service).not.toHaveProperty("portal"); expect(provider).not.toHaveProperty("portal");
  });
  it("adds and removes a desktop and updates seats without an unnecessary resize", async () => {
    const licenseOnly: Cart = { ...licensedDesktop(), desktop: { kind: "none" } }; const { sub } = await buy(licenseOnly);
    await service.change(owner, sub.id, (await service.previewChange(owner, sub.id, licensedDesktop())).confirmation);
    expect(clouds.activate).toHaveBeenCalledTimes(1); const cloudId = sub.cloudId;
    const team: Cart = { ...preset(1), license: { kind: "team", members: 5 } };
    await service.change(owner, sub.id, (await service.previewChange(owner, sub.id, team)).confirmation);
    expect(clouds.changePlan).not.toHaveBeenCalled(); expect(service.licenses(owner.id)[0]).toMatchObject({ kind: "team", seats: 5 });
    // dropping the desktop is smaller: it waits for the next billing date, and the cloud runs until then
    await service.change(owner, sub.id, (await service.previewChange(owner, sub.id, { ...team, desktop: { kind: "none" } })).confirmation);
    expect(sub.scheduledChange?.cart.desktop.kind).toBe("none"); expect(sub.cloudId).toBe(cloudId); expect(clouds.end).not.toHaveBeenCalled();
    time = sub.currentPeriodEnd!; deliver(provider.renew(sub.providerSubscriptionId!));
    expect(sub.cart.desktop.kind).toBe("none"); expect(sub.scheduledChange).toBeUndefined();
    expect(clouds.end).toHaveBeenLastCalledWith(cloudId, time + 30 * day); expect(sub.cloudId).toBeNull();
  });
  it("a failed first payment is not a plan and never blocks the next checkout", async () => {
    const first = await service.checkout(owner, { kind: "cart", cart: desktopOnly() });
    const checkout = store.state.checkouts.find(row => row.id === first.checkoutId)!, input = provider.sessions.get(checkout.providerSessionId!)!;
    const data = { subscription_id: "dsub_failed", customer: { customer_id: "cus_failed" }, metadata: { checkoutId: checkout.id, accountId: owner.id },
      product_id: input.cart[0].productId, addons: input.cart[0].addons.map(addon => ({ addon_id: addon.addonId, quantity: addon.quantity })),
      next_billing_date: new Date(time).toISOString(), cancel_at_next_billing_date: false, status: "failed" };
    deliver([signed("payment.failed", { payment_id: "pay_failed", subscription_id: "dsub_failed", customer: { customer_id: "cus_failed" }, metadata: data.metadata, total_amount: 2360, currency: "USD" }, "pay_evt"), signed("subscription.failed", data, "sub_evt")]);
    expect(service.subscriptions(owner.id).filter(sub => sub.status !== "ended")).toEqual([]);
    expect(checkout.status).toBe("expired"); expect(clouds.get(first.cloudId!)?.status).toBe("destroyed");
    expect(clouds.setPaymentProblem).not.toHaveBeenCalled();
    const retry = await service.checkout(owner, { kind: "cart", cart: desktopOnly() });
    expect(retry.checkoutUrl).toMatch(/^https:/); expect(retry.cloudId).not.toBe(first.cloudId);
    const done = provider.complete(store.state.checkouts.find(row => row.id === retry.checkoutId)!.providerSessionId!); deliver(done);
    expect(service.subscriptions(owner.id).filter(sub => sub.status === "active")).toHaveLength(1);
  });
  it("a first payment put on hold ends the never-paid subscription and cancels it at the provider", async () => {
    const first = await service.checkout(owner, { kind: "cart", cart: desktopOnly() });
    const checkout = store.state.checkouts.find(row => row.id === first.checkoutId)!, input = provider.sessions.get(checkout.providerSessionId!)!;
    deliver([signed("subscription.on_hold", { subscription_id: "dsub_hold", customer: { customer_id: "cus_hold" }, metadata: { checkoutId: checkout.id, accountId: owner.id },
      product_id: input.cart[0].productId, addons: input.cart[0].addons.map(addon => ({ addon_id: addon.addonId, quantity: addon.quantity })),
      next_billing_date: new Date(time).toISOString(), cancel_at_next_billing_date: false, status: "on_hold" })]);
    expect(store.state.subscriptions[0]?.status).toBe("ended"); expect(store.state.providerCancels).toEqual([expect.objectContaining({ id: "dsub_hold" })]);
    await expect(service.checkout(owner, { kind: "cart", cart: desktopOnly() })).resolves.toMatchObject({ checkoutUrl: expect.any(String) });
  });
  it("heals a never-paid subscription an earlier build left in payment_problem", async () => {
    const first = await service.checkout(owner, { kind: "cart", cart: desktopOnly() });
    const checkout = store.state.checkouts.find(row => row.id === first.checkoutId)!;
    store.state.subscriptions.push({ id: "sub_stuck", accountId: owner.id, providerSubscriptionId: "dsub_stuck", checkoutId: checkout.id, cart: desktopOnly(), totalCents: 2000, lines: checkout.lines,
      status: "payment_problem", source: checkout.source, licenseId: null, cloudId: checkout.cloudId, currentPeriodStart: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, createdAt: time, updatedAt: time, version: 2, mode: "test" });
    checkout.subscriptionId = "sub_stuck"; store.commit(); service.close();
    service = createBillingService({ store, provider, clouds, config, publicUrl: "https://dashboard.test", now: () => time });
    expect(store.state.subscriptions[0].status).toBe("ended"); expect(checkout.status).toBe("expired"); expect(clouds.get(first.cloudId!)?.status).toBe("destroyed");
    await expect(service.checkout(owner, { kind: "cart", cart: desktopOnly() })).resolves.toMatchObject({ checkoutUrl: expect.any(String) });
  });
  it("records failed invoices once and upgrades the same payment on success", async () => {
    await service.checkout(owner, { kind: "cart", cart: { interval: "month", license: { kind: "solo" }, desktop: { kind: "none" } } });
    const data = { payment_id: "pay_one", subscription_id: "dsub_one", customer: { customer_id: "cus_one" }, metadata: { checkoutId: store.state.checkouts[0].id, accountId: owner.id }, total_amount: 1200, currency: "USD" };
    deliver([signed("payment.failed", data)]); expect(store.state.invoices[0].status).toBe("failed");
    deliver([signed("payment.succeeded", data)]); expect(store.state.invoices).toHaveLength(1); expect(store.state.invoices[0].status).toBe("paid");
  });
  it("keeps purchased prices and lines stable when the catalog changes before activation", async () => {
    const answer = await service.checkout(owner, { kind: "cart", cart: preset(1) });
    config.desktops.shared_s.monthlyCents = 2500;
    deliver(provider.complete(store.state.checkouts[0].providerSessionId!));
    const sub = service.subscriptions(owner.id)[0];
    expect(sub.totalCents).toBe(quote(preset(1), BILLING_CONFIG).totalCents); expect(sub.lines.reduce((sum, line) => sum + line.amountCents, 0)).toBe(quote(preset(1), BILLING_CONFIG).totalCents);
    expect(sub.cloudId).toBe(answer.cloudId);
    service.close(); store = createBillingStore(dataDir);
    service = createBillingService({ store, provider, clouds, config, publicUrl: "https://dashboard.test", now: () => time });
    expect(deliver(provider.complete(store.state.checkouts[0].providerSessionId!))).toEqual([{ duplicate: true }, { duplicate: true }]);
    expect(clouds.activate).toHaveBeenCalledTimes(1);
  });
  it("renews at the changed fake-provider price and streams an owner-only PDF", async () => {
    const { sub } = await buy(); await service.change(owner, sub.id, (await service.previewChange(owner, sub.id, preset(2))).confirmation);
    deliver(provider.renew(sub.providerSubscriptionId!)); expect(store.state.invoices.at(-1)!.amountCents).toBe(quote(preset(2), config).totalCents);
    service = createBillingService({ store, provider: { ...provider, invoiceUrl: async () => null }, clouds, config, publicUrl: "https://dashboard.test", now: () => time });
    expect(await service.invoiceDownload(owner.id, store.state.invoices[0].id)).toMatchObject({ pdf: { contentType: "application/pdf", body: expect.any(Buffer) } });
  });
  it("serializes license additions across subscriptions of the same account", async () => {
    const first = await buy(desktopOnly()), second = await buy({ ...desktopOnly(), interval: "year" });
    const a = await service.previewChange(owner, first.sub.id, licensedDesktop()), b = await service.previewChange(owner, second.sub.id, { ...licensedDesktop(), interval: "year" });
    const results = await Promise.allSettled([service.change(owner, first.sub.id, a.confirmation), service.change(owner, second.sub.id, b.confirmation)]);
    expect(results[0].status).toBe("fulfilled"); expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "already_subscribed" } });
    expect(provider.changeCalls).toHaveLength(1);
  });
  it("refuses missing product ids in real-provider mode and binds confirmations to subscriptions", async () => {
    const a = await buy(desktopOnly()), b = await buy({ ...desktopOnly(), interval: "year" });
    const preview = await service.previewChange(owner, a.sub.id, { ...desktopOnly(), desktop: { kind: "shared_m", region: "fsn1" } });
    await expect(service.change(owner, b.sub.id, preview.confirmation)).rejects.toMatchObject({ code: "confirmation_required" });
    service = createBillingService({ store, provider: { ...provider, name: "dodo" }, clouds, config, publicUrl: "https://dashboard.test", now: () => time });
    await expect(service.previewChange(owner, a.sub.id, preset(2))).rejects.toMatchObject({ code: "unavailable" });
    await expect(service.checkout(stranger, { kind: "cart", cart: preset(1) })).rejects.toMatchObject({ code: "unavailable" });
    expect(provider.changeCalls).toHaveLength(0);
  });
  it("prunes webhook retention and refuses invalid persisted state", () => {
    store.state.webhookEvents = Array.from({ length: 20_000 }, (_, i) => ({ id: `old_${i}`, at: time, type: "ignored" }));
    store.state.webhookEvents.push({ id: "expired", at: time - 31 * day, type: "ignored" });
    deliver([signed("unknown", {})]); expect(store.state.webhookEvents).toHaveLength(20_001); expect(store.state.webhookEvents.some(event => event.id === "expired")).toBe(false);
    writeFileSync(join(dataDir, "billing.json"), JSON.stringify({ ...store.state, invoices: [{ amountCents: 0.5 }] }));
    expect(() => createBillingStore(dataDir)).toThrow("Invalid state");
  });
});

describe("billing security regressions", () => {
  it("binds signed events to account, customer, checkout kind, amount, currency and product", async () => {
    const cart = await service.checkout(owner, { kind: "cart", cart: preset(1) });
    await service.checkout(stranger, { kind: "cart", cart: { interval: "month", license: { kind: "solo" }, desktop: { kind: "none" } } });
    const other = store.state.checkouts[1];
    const payment = { payment_id: "p", subscription_id: "dsub_stranger", customer: { customer_id: "cus_stranger" }, metadata: { checkoutId: other.id, accountId: stranger.id }, total_amount: 1200, currency: "USD" };
    for (const patch of [{ metadata: { ...payment.metadata, accountId: owner.id } }, { subscription_id: null }, { currency: "EUR" }]) {
      deliver([signed("payment.succeeded", { ...payment, ...patch })]);
    }
    expect(store.state.invoices).toEqual([]); expect(store.state.customers.every(customer => customer.providerCustomerId === null)).toBe(true);
    deliver([signed("payment.succeeded", payment)]);
    expect(store.state.invoices).toMatchObject([{ accountId: stranger.id, providerPaymentId: "p", status: "paid" }]);
    const activation = JSON.parse(provider.complete(store.state.checkouts[0].providerSessionId!)[1].body.toString());
    deliver([signed("subscription.active", { ...activation.data, metadata: { checkoutId: cart.checkoutId, accountId: stranger.id } })]);
    deliver([signed("subscription.active", { ...activation.data, product_id: "wrong_product" })]);
    deliver([signed("subscription.active", { ...activation.data, customer: payment.customer })]);
    expect(store.state.subscriptions).toEqual([]); expect(clouds.activate).not.toHaveBeenCalled();
    deliver([signed("subscription.active", activation.data)]); expect(store.state.subscriptions).toHaveLength(1);
  });

  it("does not associate a different subscription with a checkout already bound by its payment", async () => {
    await service.checkout(owner, { kind: "cart", cart: preset(1) });
    const deliveries = provider.complete(store.state.checkouts[0].providerSessionId!); deliver([deliveries[0]]);
    const activation = JSON.parse(deliveries[1].body.toString());
    deliver([signed("subscription.active", { ...activation.data, subscription_id: "other_subscription" })]);
    expect(store.state.subscriptions).toEqual([]);
    deliver([deliveries[1]]); expect(store.state.subscriptions).toHaveLength(1);
  });

  it("settles partial, out-of-order and other-currency refunds against the paid amount", async () => {
    await service.checkout(owner, { kind: "cart", cart: { interval: "month", license: { kind: "solo" }, desktop: { kind: "none" } } });
    const checkout = store.state.checkouts[0];
    deliver([signed("refund.succeeded", { refund_id: "r1", payment_id: "p", amount: 600, currency: "USD" })]);
    service.close(); store = createBillingStore(dataDir);
    service = createBillingService({ store, provider, clouds, config, publicUrl: "https://dashboard.test", now: () => time });
    const payment = { payment_id: "p", subscription_id: "dsub_p", customer: { customer_id: "cus" }, metadata: { checkoutId: checkout.id, accountId: owner.id }, total_amount: 1200, currency: "USD" };
    deliver([signed("payment.succeeded", payment)]);
    expect(store.state.invoices[0].status).toBe("paid");
    deliver([signed("refund.succeeded", { refund_id: "wrong_currency", payment_id: "p", amount: 600, currency: "EUR" })]);
    expect(store.state.invoices[0].status).toBe("paid");
    deliver([signed("refund.succeeded", { refund_id: "r2", payment_id: "p", amount: 900, currency: "USD" })]);
    expect(store.state.invoices[0].status).toBe("refunded");
    deliver([signed("payment.succeeded", payment)]); expect(store.state.invoices).toHaveLength(1); expect(store.state.invoices[0].status).toBe("refunded");
  });

  it("commits the event and cloud intent together and retries partial application after restart", async () => {
    await service.checkout(owner, { kind: "cart", cart: preset(1) });
    const deliveries = provider.complete(store.state.checkouts[0].providerSessionId!); deliver([deliveries[0]]);
    vi.mocked(clouds.setPaymentProblem).mockImplementationOnce(() => { throw new Error("synthetic disk failure"); });
    expect(() => deliver([deliveries[1]])).toThrow(expect.objectContaining({ code: "unavailable" }));
    expect(store.state.subscriptions).toHaveLength(1);
    const subId = store.state.subscriptions[0].id;
    expect(store.state.cloudActions).toHaveLength(2);
    service.close(); store = createBillingStore(dataDir);
    service = createBillingService({ store, provider, clouds, config, publicUrl: "https://dashboard.test", now: () => time });
    expect(store.state.cloudActions).toEqual([]); expect(store.state.subscriptions[0].id).toBe(subId);
    expect(deliver([deliveries[1]])).toEqual([{ duplicate: true }]); expect(clouds.activate).toHaveBeenCalledTimes(1);
  });

  it("does not activate a cloud when the billing transaction fails to persist", async () => {
    await service.checkout(owner, { kind: "cart", cart: preset(1) });
    const deliveries = provider.complete(store.state.checkouts[0].providerSessionId!); deliver([deliveries[0]]);
    vi.spyOn(store, "commit").mockImplementationOnce(() => { throw new Error("synthetic full disk"); });
    expect(() => deliver([deliveries[1]])).toThrow(expect.objectContaining({ code: "unavailable" }));
    expect(store.state.subscriptions).toEqual([]); expect(store.state.cloudActions).toEqual([]); expect(clouds.activate).not.toHaveBeenCalled();
    deliver([deliveries[1]]); expect(store.state.subscriptions).toHaveLength(1); expect(clouds.activate).toHaveBeenCalledTimes(1);
  });

  it("keeps unpaid destruction scheduled and refuses stale activation or unpaid plan changes", async () => {
    const { sub, deliveries } = await buy(); time += 1000;
    deliver(provider.fail(sub.providerSubscriptionId!));
    const deadline = sub.currentPeriodEnd! + config.graceDays * day;
    expect(clouds.get(sub.cloudId!)?.destroyAt).toBe(deadline);
    await expect(service.keep(owner, sub.id)).rejects.toMatchObject({ code: "not_subscribed" });
    await expect(service.previewChange(owner, sub.id, preset(2))).rejects.toMatchObject({ code: "not_subscribed" });
    deliver([provider.sign("stale_activation", deliveries[1].body)]);
    expect(sub.status).toBe("payment_problem"); expect(clouds.get(sub.cloudId!)?.destroyAt).toBe(deadline);
    const updated = JSON.parse(deliveries[1].body.toString()).data;
    deliver([signed("subscription.updated", { ...updated, next_billing_date: new Date(time + 365 * day).toISOString() })]);
    expect(sub.currentPeriodEnd! + config.graceDays * day).toBe(deadline); expect(clouds.get(sub.cloudId!)?.destroyAt).toBe(deadline);
  });

  it("expires active licenses at the paid boundary even when an expiry webhook is missing", async () => {
    const { sub } = await buy(); time = sub.currentPeriodEnd!;
    expect(service.licenseCheck(owner).license).toBeNull();
    await expect(service.keep(owner, sub.id)).rejects.toMatchObject({ code: "not_subscribed" });
    expect(() => service.invoices(owner.id, "a".repeat(513))).toThrow(expect.objectContaining({ code: "invalid_request" }));
  });
});

describe("durable provider reconciliation", () => {
  it("recovers a plan change when the provider applied it but the response was lost", async () => {
    const { sub } = await buy();
    const change = provider.changePlan;
    vi.spyOn(provider, "changePlan").mockImplementationOnce(async input => { await change(input); throw new Error("synthetic lost response"); });
    const preview = await service.previewChange(owner, sub.id, preset(2));
    await expect(service.change(owner, sub.id, preview.confirmation)).rejects.toMatchObject({ code: "unavailable" });
    expect(sub.totalCents).toBe(quote(licensedDesktop(), BILLING_CONFIG).totalCents); expect(sub.pendingChange).toBeDefined();
    service.close(); store = createBillingStore(dataDir);
    service = createBillingService({ store, provider, clouds, config, publicUrl: "https://dashboard.test", now: () => time });
    // the next look at plans reads the provider back: the change it made is applied, never asked for twice
    await expect(service.previewChange(owner, store.state.subscriptions[0].id, preset(2))).rejects.toMatchObject({ code: "already_on_plan" });
    expect(store.state.subscriptions[0]).toMatchObject({ totalCents: quote(preset(2), config).totalCents, cart: preset(2) });
    expect(store.state.subscriptions[0].pendingChange).toBeUndefined(); expect(provider.changeCalls).toHaveLength(1);
    expect(clouds.changePlan).toHaveBeenCalledTimes(1);
  });

  it("does not revive a subscription when expiry arrives before activation", async () => {
    await service.checkout(owner, { kind: "cart", cart: preset(1) });
    const deliveries = provider.complete(store.state.checkouts[0].providerSessionId!);
    const activation = JSON.parse(deliveries[1].body.toString());
    deliver([signed("subscription.expired", { ...activation.data, status: "expired" })]);
    deliver(deliveries);
    expect(store.state.subscriptions[0].status).toBe("ended"); expect(clouds.activate).not.toHaveBeenCalled();
  });

  it("refreshes fake delivery signatures without changing their idempotency keys", async () => {
    const { checkout } = await buy(); time += 600_000;
    expect(deliver(provider.complete(checkout.providerSessionId!))).toEqual([{ duplicate: true }, { duplicate: true }]);
    expect(store.state.subscriptions).toHaveLength(1);
  });
});

it("waits for a matching signed outcome before granting a Dodo upgrade", async () => {
  const { sub, deliveries } = await buy(); service.close();
  config.products = Object.fromEntries(["license_solo:month", "addon_shared_s:month", "plan_pro:month"].map(key => [key, key]));
  // the provider's own record does not show the change yet (a payment still settling): it waits for the webhook
  const shown = await provider.subscription(sub.providerSubscriptionId!);
  service = createBillingService({ store, provider: { ...provider, name: "dodo", subscription: async () => shown }, clouds, config, publicUrl: "https://dashboard.test", now: () => time });
  const end = sub.currentPeriodEnd;
  const result = (await service.change(owner, sub.id, (await service.previewChange(owner, sub.id, preset(2))).confirmation)).subscription;
  expect(result.totalCents).toBe(quote(licensedDesktop(), BILLING_CONFIG).totalCents); expect(clouds.changePlan).not.toHaveBeenCalled();
  await expect(service.previewChange(owner, sub.id, desktopOnly())).rejects.toMatchObject({ code: "change_in_progress" });
  const data = JSON.parse(deliveries[1].body.toString()).data;
  deliver([signed("subscription.plan_changed", data)]);
  expect(sub.pendingChange).toBeDefined(); expect(sub.totalCents).toBe(quote(licensedDesktop(), BILLING_CONFIG).totalCents);
  deliver([signed("subscription.plan_changed", { ...data, product_id: "plan_pro:month", addons: [] })]);
  expect(sub.pendingChange).toBeUndefined(); expect(sub.totalCents).toBe(quote(preset(2), config).totalCents);
  expect(sub.currentPeriodEnd).toBe(end); expect(clouds.changePlan).toHaveBeenCalledTimes(1);
});

it("fulfills a late paid checkout with one replacement instead of reviving the abandoned cloud", async () => {
  const answer = await service.checkout(owner, { kind: "cart", cart: preset(1) });
  const checkout = store.state.checkouts[0]; time += 31 * 60_000;
  await service.checkout(owner, { kind: "cart", cart: { interval: "month", license: { kind: "solo" }, desktop: { kind: "none" } } });
  expect(clouds.get(answer.cloudId!)?.status).toBe("destroyed");
  const deliveries = provider.complete(checkout.providerSessionId!); deliver(deliveries); deliver(deliveries);
  const sub = store.state.subscriptions[0];
  expect(sub.cloudId).not.toBe(answer.cloudId); expect(clouds.get(sub.cloudId!)?.status).toBe("provisioning");
  expect(clouds.get(answer.cloudId!)?.status).toBe("destroyed"); expect(clouds.activate).toHaveBeenCalledTimes(1);
});

it("counts hidden desktops against the account limit", async () => {
  const { sub } = await buy(); clouds.get(sub.cloudId!)!.hidden = true; config.maxCloudsPerAccount = 1;
  expect(clouds.list(owner.id)).toEqual([]);
  await expect(service.checkout(owner, { kind: "cart", cart: desktopOnly() })).rejects.toMatchObject({ code: "cap" });
});

it("does not debit a legacy fully refunded invoice again", async () => {
  await buy();
  const invoice = store.state.invoices[0];
  deliver(provider.refund(invoice.providerPaymentId)); delete store.state.refunds; store.commit();
  service.close(); store = createBillingStore(dataDir);
  service = createBillingService({ store, provider, clouds, config, publicUrl: "https://dashboard.test", now: () => time });
  deliver([signed("refund.succeeded", { refund_id: "another", payment_id: invoice.providerPaymentId, amount: invoice.amountCents, currency: "USD" })]);
  expect(store.state.refunds).toEqual([]); expect(store.state.invoices[0].status).toBe("refunded");
});

it("discards a stale resize intent after the desktop has been destroyed", async () => {
  const { sub } = await buy();
  clouds.get(sub.cloudId!)!.status = "destroyed";
  store.state.cloudActions = [{ kind: "change", cloudId: sub.cloudId!, plan: { kind: "shared_m", placement: "pool", spec: { vcpu: 4, ramGb: 8, diskGb: 60 }, botComputers: 5 } }];
  store.commit(); service.close();
  service = createBillingService({ store, provider, clouds, config, publicUrl: "https://dashboard.test", now: () => time });
  expect(clouds.changePlan).not.toHaveBeenCalled(); expect(store.state.cloudActions).toEqual([]);
});

describe("paying again after a plan ended", () => {
  function withNotices() {
    const notices: unknown[] = []; service.close();
    service = createBillingService({ store, provider, clouds, config, publicUrl: "https://dashboard.test", now: () => time, notify: notice => notices.push(notice) });
    return notices;
  }
  async function ended() {
    const first = await buy(desktopOnly());
    deliver(provider.expire(first.sub.providerSubscriptionId!));
    expect(clouds.get(first.sub.cloudId!)).toMatchObject({ ended: true }); time += 3 * day;
    return first;
  }
  it("brings the paused cloud back with its data within retention instead of ordering a new one", async () => {
    const first = await ended(), notices = withNotices();
    const answer = await service.checkout(owner, { kind: "cart", cart: desktopOnly() });
    expect(answer).toMatchObject({ cloudId: first.sub.cloudId, revives: true }); expect(clouds.order).toHaveBeenCalledTimes(1);
    const checkout = store.state.checkouts.find(row => row.id === answer.checkoutId)!;
    deliver(provider.complete(checkout.providerSessionId!));
    const sub = store.state.subscriptions.find(row => row.checkoutId === checkout.id)!;
    expect(sub).toMatchObject({ status: "active", cloudId: first.sub.cloudId });
    expect(clouds.revive).toHaveBeenCalledExactlyOnceWith(first.sub.cloudId, sub.id, expect.objectContaining({ kind: "shared_s" }));
    expect(clouds.activate).toHaveBeenCalledTimes(1);
    expect(clouds.get(first.sub.cloudId!)).toMatchObject({ subscriptionId: sub.id, ended: undefined, destroyAt: null });
    expect(notices).toContainEqual(expect.objectContaining({ kind: "receipt", revived: true, first: true }));
  });
  it("orders a new cloud once the ended one's data is gone", async () => {
    const first = await ended(); time += 31 * day; clouds.get(first.sub.cloudId!)!.status = "destroyed";
    const answer = await service.checkout(owner, { kind: "cart", cart: desktopOnly() });
    expect(answer.revives).toBe(false); expect(answer.cloudId).not.toBe(first.sub.cloudId);
    deliver(provider.complete(store.state.checkouts.at(-1)!.providerSessionId!));
    expect(clouds.revive).not.toHaveBeenCalled(); expect(clouds.activate).toHaveBeenCalledTimes(2);
  });
  it("orders a new cloud when the paused one was deleted between checkout and payment", async () => {
    const first = await ended();
    const answer = await service.checkout(owner, { kind: "cart", cart: desktopOnly() }); expect(answer.revives).toBe(true);
    clouds.get(first.sub.cloudId!)!.status = "destroyed";
    deliver(provider.complete(store.state.checkouts.at(-1)!.providerSessionId!));
    const sub = store.state.subscriptions.at(-1)!;
    expect(sub.cloudId).not.toBe(first.sub.cloudId); expect(clouds.get(sub.cloudId!)).toMatchObject({ status: "provisioning", subscriptionId: sub.id });
    expect(clouds.revive).not.toHaveBeenCalled();
  });
});

describe("repeated starts", () => {
  it("hands the same page back for the same plan started again within a minute, without another provider session", async () => {
    const create = vi.spyOn(provider, "createCheckout");
    const license: Cart = { interval: "month", license: { kind: "solo" }, desktop: { kind: "none" } };
    const first = await service.checkout(owner, { kind: "cart", cart: license }, { source: "dash_license" });
    for (let i = 0; i < 17; i++) { time += 2_000; expect(await service.checkout(owner, { kind: "cart", cart: license }, { source: "dash_license" })).toEqual(first); }
    expect(create).toHaveBeenCalledTimes(1);
    expect(store.state.checkouts.map(checkout => checkout.status)).toEqual(["open"]);
    expect(store.state.ledger?.filter(row => row.type === "checkout.started")).toHaveLength(1);
    // a desktop plan keeps the cloud it reserved
    const other = { id: "acct_desk", email: "desk@example.test" };
    const desk = await service.checkout(other, { kind: "cart", cart: desktopOnly(), name: "Home" });
    expect(await service.checkout(other, { kind: "cart", cart: desktopOnly(), name: "Home" })).toEqual(desk);
    expect(clouds.order).toHaveBeenCalledTimes(1); expect(clouds.abandon).not.toHaveBeenCalled();
  });
  it("hands the page back whichever surface asks again, and makes a fresh one for another plan, name, or once the minute is over", async () => {
    const first = await service.checkout(owner, { kind: "cart", cart: desktopOnly() }, { source: "app_card" });
    expect(await service.checkout(owner, { kind: "cart", cart: desktopOnly() }, { source: undefined })).toEqual(first);
    const otherPlan = await service.checkout(owner, { kind: "cart", cart: { ...desktopOnly(), interval: "year" } }, { source: "dash_billing" });
    expect(otherPlan.checkoutId).not.toBe(first.checkoutId);
    const otherName = await service.checkout(owner, { kind: "cart", cart: { ...desktopOnly(), interval: "year" }, name: "Work" }, { source: "dash_billing" });
    expect(otherName.checkoutId).not.toBe(otherPlan.checkoutId);
    time += CHECKOUT_REUSE_MS + 1;
    const later = await service.checkout(owner, { kind: "cart", cart: { ...desktopOnly(), interval: "year" }, name: "Work" }, { source: "dash_billing" });
    expect(later.checkoutId).not.toBe(otherName.checkoutId);
    expect(store.state.checkouts.filter(checkout => checkout.status === "open").map(checkout => checkout.id)).toEqual([later.checkoutId]);
  });
  it("stops a burst of new pages from one account well under the hourly limit, and lets it buy again after a while", async () => {
    const create = vi.spyOn(provider, "createCheckout");
    const carts = [preset(1), { ...preset(1), interval: "year" as const }, preset(2), { ...preset(2), interval: "year" as const }, licensedDesktop()];
    for (const cart of carts) { await service.checkout(owner, { kind: "cart", cart }, { source: "made_up" }); time += 1_000; }
    expect(create).toHaveBeenCalledTimes(CHECKOUT_BURST.count);
    // the open one again is still handed back; anything new waits
    expect((await service.checkout(owner, { kind: "cart", cart: licensedDesktop() })).checkoutId).toBe(store.state.checkouts.at(-1)!.id);
    await expect(service.checkout(owner, { kind: "cart", cart: preset(1) })).rejects.toMatchObject({ code: "rate_limited" });
    expect(create).toHaveBeenCalledTimes(CHECKOUT_BURST.count);
    time += CHECKOUT_BURST.windowMs;
    await service.checkout(owner, { kind: "cart", cart: preset(1) });
    expect(create).toHaveBeenCalledTimes(CHECKOUT_BURST.count + 1);
  });
});

describe("one subscription per plan", () => {
  it("opens a fresh page instead of the unpaid one, frees what it held, and still takes a late payment on the old one", async () => {
    const first = await service.checkout(owner, { kind: "cart", cart: desktopOnly() });
    time += CHECKOUT_REUSE_MS + 1;
    const again = await service.checkout(owner, { kind: "cart", cart: desktopOnly() });
    expect(again.checkoutId).not.toBe(first.checkoutId); expect(again.checkoutUrl).not.toBe(first.checkoutUrl);
    expect(store.state.checkouts.map(checkout => checkout.status)).toEqual(["expired", "open"]);
    expect(clouds.abandon).toHaveBeenCalledExactlyOnceWith(first.cloudId); expect(clouds.order).toHaveBeenCalledTimes(2);
    // the old page was paid after all (a slow bank): the plan lands on it with a cloud of its own
    deliver(provider.complete(store.state.checkouts[0].providerSessionId!));
    expect(store.state.subscriptions).toHaveLength(1); expect(store.state.subscriptions[0]).toMatchObject({ checkoutId: first.checkoutId, status: "active" });
    expect(store.state.subscriptions[0].cloudId).not.toBe(first.cloudId);
    await expect(service.checkout(owner, { kind: "cart", cart: desktopOnly() })).rejects.toMatchObject({ code: "already_subscribed" });
  });
  it("closes the unpaid page when the plan is paid on the new one", async () => {
    await service.checkout(owner, { kind: "cart", cart: desktopOnly() });
    time += CHECKOUT_REUSE_MS + 1;
    await service.checkout(owner, { kind: "cart", cart: desktopOnly() });
    deliver(provider.complete(store.state.checkouts[1].providerSessionId!));
    await expect(service.checkout(owner, { kind: "cart", cart: desktopOnly() })).rejects.toMatchObject({ code: "already_subscribed" });
  });
  it("cancels at once and refunds a second subscription paid on a stale checkout page", async () => {
    await service.checkout(owner, { kind: "cart", cart: desktopOnly() });
    const stale = store.state.checkouts[0]; time += 31 * 60_000;
    await service.checkout(owner, { kind: "cart", cart: desktopOnly() });
    deliver(provider.complete(store.state.checkouts[1].providerSessionId!));
    const kept = store.state.subscriptions[0];
    const late = provider.complete(stale.providerSessionId!);
    deliver([late[1]]); deliver([late[0]]);
    const duplicateId = JSON.parse(late[1].body.toString()).data.subscription_id as string;
    const paymentId = JSON.parse(late[0].body.toString()).data.payment_id as string;
    expect(store.state.subscriptions).toEqual([kept]); expect(clouds.activate).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(provider.refundCalls).toEqual([{ paymentId, reason: "duplicate_subscription" }]));
    expect(provider.cancelNowCalls).toEqual([duplicateId]);
    expect(store.state.duplicates).toEqual([{ id: duplicateId, accountId: owner.id, checkoutId: stale.id, cancelledAt: time, payments: [{ id: paymentId, refundedAt: time }] }]);
    deliver([signed("subscription.renewed", { ...JSON.parse(late[1].body.toString()).data, next_billing_date: new Date(time + 40 * day).toISOString() })]);
    expect(store.state.subscriptions).toEqual([kept]);
    expect(store.state.invoices.map(row => row.providerPaymentId)).not.toContain(paymentId);
  });
  it("refunds a duplicate whose activation arrives before its payment, and keeps retrying a provider failure", async () => {
    await service.checkout(owner, { kind: "cart", cart: desktopOnly() });
    const stale = store.state.checkouts[0]; time += 31 * 60_000;
    await service.checkout(owner, { kind: "cart", cart: desktopOnly() });
    deliver(provider.complete(store.state.checkouts[1].providerSessionId!));
    const failing = vi.spyOn(provider, "refundPayment").mockRejectedValueOnce(new Error("provider down"));
    const late = provider.complete(stale.providerSessionId!);
    deliver([late[1]]); deliver([late[0]]);
    await vi.waitFor(() => expect(failing).toHaveBeenCalledTimes(1));
    expect(store.state.duplicates![0].payments[0].refundedAt).toBeNull();
    deliver([signed("ping", {})]);
    await vi.waitFor(() => expect(store.state.duplicates![0].payments[0].refundedAt).toBe(time));
  });
});

describe("billing ledger", () => {
  const types = () => store.state.ledger!.map(row => row.type);
  it("records each moment once, however often or under whatever delivery id it arrives", async () => {
    const { sub, deliveries } = await buy(desktopOnly());
    expect(types()).toEqual(["checkout.started", "payment.succeeded", "subscription.active"]);
    expect(store.state.ledger![2]).toMatchObject({ accountId: owner.id, subscriptionId: sub.id, plan: expect.any(String), interval: "month", mrrCents: sub.totalCents, via: "webhook" });
    deliver(deliveries);
    deliver(deliveries.map((delivery, i) => provider.sign(`redelivered_${i}`, delivery.body)));
    expect(types()).toEqual(["checkout.started", "payment.succeeded", "subscription.active"]);
    time += 31 * day; deliver(provider.renew(sub.providerSubscriptionId!));
    deliver(provider.fail(sub.providerSubscriptionId!)); deliver([signed("subscription.on_hold", { ...JSON.parse(provider.fail(sub.providerSubscriptionId!)[0].body.toString()).data }, "hold_again")]);
    time += day; deliver(provider.renew(sub.providerSubscriptionId!));
    expect(types().slice(3)).toEqual(["payment.succeeded", "subscription.renewed", "subscription.on_hold", "payment.succeeded", "subscription.recovered", "subscription.renewed"]);
    const paid = store.state.invoices.at(-1)!;
    const refund = provider.refund(paid.providerPaymentId); deliver(refund); deliver(refund.map(d => provider.sign("refund_same_id", d.body)));
    expect(types().filter(type => type === "refund.succeeded")).toHaveLength(1);
    deliver([signed("dispute.opened", { dispute_id: "dsp_1", payment_id: paid.providerPaymentId, amount: "2000", currency: "USD", dispute_stage: "dispute", dispute_status: "dispute_opened" })]);
    deliver([signed("dispute.opened", { dispute_id: "dsp_1", payment_id: paid.providerPaymentId, amount: "2000", currency: "USD" }, "dispute_again")]);
    expect(store.state.ledger!.filter(row => row.type === "dispute.opened")).toMatchObject([{ accountId: owner.id, amountCents: 2000, providerRef: "dsp_1" }]);
    deliver(provider.expire(sub.providerSubscriptionId!));
    expect(types().at(-1)).toBe("subscription.expired");
    const ids = store.state.ledger!.map(row => row.id); expect(new Set(ids).size).toBe(ids.length);
  });
  it("tells listeners about new rows only, after they are stored", async () => {
    const seen: string[] = [];
    service.close(); service = createBillingService({ store, provider, clouds, config, publicUrl: "https://dashboard.test", now: () => time, onLedger: row => seen.push(row.type) });
    const { deliveries } = await buy(desktopOnly());
    deliver(deliveries.map((delivery, i) => provider.sign(`again_${i}`, delivery.body)));
    expect(seen).toEqual(["checkout.started", "payment.succeeded", "subscription.active"]);
  });
  it("classifies plan changes as upgrades and downgrades with the MRR before and after", async () => {
    const { sub } = await buy(desktopOnly());
    const bigger: Cart = { ...desktopOnly(), desktop: { ...desktopOnly().desktop, kind: "shared_m" } };
    const preview = await service.previewChange(owner, sub.id, bigger);
    await service.change(owner, sub.id, preview.confirmation);
    const row = store.state.ledger!.find(item => item.type === "subscription.upgraded");
    expect(row).toMatchObject({ previousMrrCents: quote(desktopOnly(), config).totalCents, mrrCents: quote(bigger, config).totalCents });
  });
  it("backfills from the provider once, matching what webhooks already recorded", async () => {
    const { sub } = await buy(desktopOnly());
    const paid = store.state.invoices[0]!;
    const pages: Record<string, Array<Record<string, unknown>>> = {
      payments: [{ payment_id: paid.providerPaymentId, status: "succeeded", created_at: new Date(time).toISOString(), total_amount: 2000, currency: "USD", settlement_amount: 2000, settlement_tax: 300 },
        { payment_id: "pay_old", status: "succeeded", created_at: new Date(time - 40 * day).toISOString(), total_amount: 1500, currency: "USD", customer: { customer_id: "cus_unknown" }, billing: { country: "de" } }],
      refunds: [{ refund_id: "ref_old", payment_id: "pay_old", status: "succeeded", created_at: new Date(time - 39 * day).toISOString(), amount: 1500, currency: "USD" }],
      disputes: [{ dispute_id: "dsp_old", payment_id: "pay_old", amount: "1500", currency: "USD", dispute_status: "dispute_lost", created_at: new Date(time - 38 * day).toISOString() }],
      subscriptions: [{ subscription_id: sub.providerSubscriptionId, status: "active", created_at: new Date(time).toISOString() }],
    };
    const calls: string[] = [];
    (provider as unknown as { list: (resource: string, page: number) => Promise<unknown[]> }).list = async (resource, page) => { calls.push(`${resource}:${page}`); return page === 0 ? pages[resource] ?? [] : []; };
    const first = await service.syncFromProvider();
    expect(first).toEqual({ scanned: 5, added: 4 });
    expect(store.state.ledger!.find(row => row.providerPaymentId === "pay_old" && row.type === "payment.succeeded")).toMatchObject({ via: "sync", country: "DE", amountCents: 1500, accountId: null });
    expect(store.state.ledger!.filter(row => row.type.startsWith("dispute.")).map(row => row.type)).toEqual(["dispute.opened", "dispute.lost"]);
    expect(await service.syncFromProvider()).toEqual({ scanned: 5, added: 0 });
    expect(store.state.lastSync).toMatchObject({ added: 0, scanned: 5 });
    expect(calls).toEqual(["payments:0", "refunds:0", "disputes:0", "subscriptions:0", "payments:0", "refunds:0", "disputes:0", "subscriptions:0"]);
  });
  it("refuses a backfill where the provider keeps no history", async () => {
    await expect(service.syncFromProvider()).rejects.toMatchObject({ status: 409 });
  });
});

describe("cancel flow and the stay-on discount", () => {
  it("offers the discount on a live monthly plan, applies it once at the provider and records the save", async () => {
    const { sub } = await buy();
    expect(service.overview(owner).retention).toEqual({ offer: { percent: 30, cycles: 3 }, applied: null });
    const answer = await service.retentionDiscount(owner, sub.id, "price");
    expect(provider.discountCalls).toEqual([expect.objectContaining({ subscriptionId: sub.providerSubscriptionId, percent: 30, cycles: 3, accountId: owner.id })]);
    expect(answer.retention).toEqual({ offer: null, applied: { percent: 30, cycles: 3, at: time } });
    expect(store.state.retention).toEqual([expect.objectContaining({ accountId: owner.id, subscriptionId: sub.id, reason: "price", step: "help", outcome: "discount" })]);
    await expect(service.retentionDiscount(owner, sub.id, "price")).rejects.toMatchObject({ status: 409, code: "discount_used" });
    expect(provider.discountCalls).toHaveLength(1);
    expect(store.state.subscriptions.find(row => row.id === sub.id)).toMatchObject({ status: "active", cancelAtPeriodEnd: false });
  });

  it("keeps the discount to one per account across plans and survives a restart", async () => {
    const { sub } = await buy();
    await service.retentionDiscount(owner, sub.id, "price");
    service.close(); store = createBillingStore(dataDir);
    service = createBillingService({ store, provider, clouds, config, publicUrl: "https://dashboard.test", now: () => time });
    expect(service.overview(owner).retention).toEqual({ offer: null, applied: { percent: 30, cycles: 3, at: time } });
    await expect(service.retentionDiscount(owner, sub.id, "unused")).rejects.toMatchObject({ code: "discount_used" });
  });

  it("refuses the discount on a yearly plan, a plan set to cancel, a failed provider call and someone else's plan", async () => {
    const yearly = await buy(preset(1, "year"));
    expect(service.overview(owner).retention?.offer).toBeNull();
    await expect(service.retentionDiscount(owner, yearly.sub.id, "price")).rejects.toMatchObject({ code: "discount_unavailable" });
    await expect(service.retentionDiscount(stranger, yearly.sub.id, "price")).rejects.toMatchObject({ status: 404 });
    await expect(service.retentionDiscount(owner, yearly.sub.id, "nope" as never)).rejects.toMatchObject({ status: 400 });
    const monthly = await buy(desktopOnly(), stranger);
    provider.failDiscount = true;
    await expect(service.retentionDiscount(stranger, monthly.sub.id, "price")).rejects.toMatchObject({ code: "unavailable" });
    expect(store.state.retentionDiscounts).toEqual([]);
    provider.failDiscount = false;
    await service.cancel(stranger, monthly.sub.id);
    await expect(service.retentionDiscount(stranger, monthly.sub.id, "price")).rejects.toMatchObject({ code: "discount_unavailable" });
    expect(provider.discountCalls).toHaveLength(0);
  });

  it("account closure with the cloud deleted now asks the provider only about plans it would still renew", async () => {
    const cancelled = await buy(), otherMode = await buy(desktopOnly()), renewing = await buy(desktopOnly(), stranger);
    await service.cancel(owner, cancelled.sub.id, { answer: "switching" });
    store.state.subscriptions.find(sub => sub.id === otherMode.sub.id)!.mode = "live";
    const refuse = vi.spyOn(provider, "cancelAtPeriodEnd").mockRejectedValue(new BillingProviderError("refused"));
    await service.closeAccount(owner, { destroyDesktopsNow: true });
    expect(refuse).not.toHaveBeenCalled();
    expect(clouds.end).toHaveBeenCalledWith(cancelled.answer.cloudId, expect.any(Number));
    expect(store.state.closures!.find(c => c.accountId === owner.id)!.completedAt).not.toBeNull();
    await expect(service.closeAccount(stranger, { destroyDesktopsNow: true })).rejects.toMatchObject({ status: 503, code: "unavailable" });
    expect(refuse.mock.calls).toEqual([[renewing.sub.providerSubscriptionId, true]]);
  });
  it("records each step and a cancel with its reason, and validates the step", async () => {
    const { sub } = await buy();
    const seen: unknown[] = [];
    service.close(); store = createBillingStore(dataDir);
    service = createBillingService({ store, provider, clouds, config, publicUrl: "https://dashboard.test", now: () => time, onRetention: entry => seen.push(entry) });
    expect(service.retentionStep(owner, sub.id, { reason: "broken", step: "reason", outcome: "shown" })).toEqual({ ok: true });
    expect(service.retentionStep(owner, sub.id, { reason: "broken", step: "help", outcome: "helped" })).toEqual({ ok: true });
    expect(() => service.retentionStep(owner, sub.id, { reason: "broken", step: "help", outcome: "gone" })).toThrow();
    expect(() => service.retentionStep(stranger, sub.id, { reason: "broken", step: "reason", outcome: "shown" })).toThrow();
    await service.cancel(owner, sub.id, { answer: "switching" });
    expect(seen).toEqual([
      { accountId: owner.id, reason: "broken", step: "reason", outcome: "shown" },
      { accountId: owner.id, reason: "broken", step: "help", outcome: "helped" },
      { accountId: owner.id, reason: "switching", step: "confirm", outcome: "cancelled" },
    ]);
    expect(store.state.feedback.at(-1)).toMatchObject({ answer: "switching", subscriptionId: sub.id });
    await service.cancel(owner, sub.id, { answer: "switching" });
    expect(store.state.retention).toHaveLength(3);
  });
});

describe("App Review's demo plan", () => {
  it("marks the account's plans and clouds, and clears them again", async () => {
    const { sub, answer } = await buy();
    expect(service.markReview(owner.id, true)).toEqual({
      subscriptions: [{ id: sub.id, status: "active", cloudId: answer.cloudId, review: true }],
      clouds: [expect.objectContaining({ id: answer.cloudId, review: true })] });
    expect(clouds.setReview).toHaveBeenCalledWith(answer.cloudId, true);
    expect(service.markReview(owner.id, true).subscriptions[0]!.review).toBe(true);
    expect(service.markReview(owner.id, false).clouds[0]).toMatchObject({ review: false });
    expect(store.state.subscriptions[0]!.review).toBeUndefined();
  });
  it("is never revenue: its ledger rows carry no mrr and it is never offered the stay-on discount", async () => {
    const { sub } = await buy();
    service.markReview(owner.id, true);
    expect(service.overview(owner).retention?.offer).toBeNull();
    const before = store.state.ledger!.length;
    time += 31 * day; deliver(provider.renew(sub.providerSubscriptionId!));
    const rows = store.state.ledger!.slice(before).filter(row => row.subscriptionId === sub.id && typeof row.mrrCents === "number");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map(row => row.mrrCents)).toEqual(rows.map(() => 0));
  });
  it("a deleted account's clouds are destroyed at once, whatever was asked, and the sweep finds any left behind", async () => {
    const { answer } = await buy();
    await service.closeAccount(owner, { destroyDesktopsNow: false });
    expect(clouds.get(answer.cloudId!)!.destroyAt).toBeGreaterThan(time);
    service.accountDeleted(owner.id);
    const cloud = clouds.get(answer.cloudId!)!;
    expect(cloud.accountId).not.toBe(owner.id);
    expect(clouds.destroyForDeletedAccount).toHaveBeenCalledWith(answer.cloudId);
    expect(cloud.destroyAt).toBe(time);
    // one a restart or a failed step left: the sweep ends it again
    Object.assign(cloud, { destroyAt: null, ended: false });
    vi.mocked(clouds.destroyForDeletedAccount).mockClear();
    expect(service.destroyDeleted()).toBe(1);
    expect(clouds.destroyForDeletedAccount).toHaveBeenCalledWith(answer.cloudId);
    cloud.status = "destroyed";
    expect(service.destroyDeleted()).toBe(0);
  });
  it("its owner's account deletion still ends the cloud: the flag is cleared before the desktops step", async () => {
    const { answer } = await buy();
    service.markReview(owner.id, true);
    await service.closeAccount(owner, { destroyDesktopsNow: true });
    expect(clouds.setReview).toHaveBeenLastCalledWith(answer.cloudId, false);
    expect(clouds.end).toHaveBeenCalledWith(answer.cloudId, expect.any(Number));
    expect(clouds.get(answer.cloudId!)!.review).toBeUndefined();
  });
});

describe("free trial", () => {
  beforeEach(() => {
    service.close(); config = { ...structuredClone(BILLING_CONFIG), trial: { days: 3 } };
    service = createBillingService({ store, provider, clouds, config, publicUrl: "https://dashboard.test", now: () => time });
  });
  it("is off without a trial config: no trial days in the catalog or the checkout", async () => {
    service.close(); config = structuredClone(BILLING_CONFIG);
    service = createBillingService({ store, provider, clouds, config, publicUrl: "https://dashboard.test", now: () => time });
    expect(service.catalog(owner).trialDays).toBeUndefined(); expect(service.trialDays(null)).toBeNull();
    const { checkout, sub } = await buy(desktopOnly());
    expect(checkout.trialDays).toBeUndefined(); expect(provider.sessions.get(checkout.providerSessionId!)?.trialDays).toBeUndefined();
    expect(sub.trialEndsAt).toBeUndefined(); expect(store.state.invoices[0].amountCents).toBeGreaterThan(0);
  });
  it("sends the trial on an account's first cloud checkout only, never on a license-only cart", async () => {
    expect(service.catalog(owner).trialDays).toBe(3);
    const license = await service.checkout(stranger, { kind: "cart", cart: { interval: "month", license: { kind: "solo" }, desktop: { kind: "none" } } });
    expect(store.state.checkouts.find(row => row.id === license.checkoutId)!.trialDays).toBeUndefined();
    const { checkout, sub } = await buy(desktopOnly());
    expect(provider.sessions.get(checkout.providerSessionId!)?.trialDays).toBe(3);
    expect(sub).toMatchObject({ status: "active", trialEndsAt: time + 3 * day, currentPeriodStart: time, currentPeriodEnd: time + 3 * day });
    expect(service.subscriptions(owner.id)[0]).toMatchObject({ trialEndsAt: time + 3 * day });
    expect(clouds.activate).toHaveBeenCalledWith(sub.cloudId, sub.id, expect.anything());
    expect(service.catalog(owner).trialDays).toBeUndefined();
    const second = await service.checkout(owner, { kind: "cart", cart: { ...preset(2), license: { kind: "none" } } });
    const again = store.state.checkouts.find(row => row.id === second.checkoutId)!;
    expect(again.trialDays).toBeUndefined(); expect(provider.sessions.get(again.providerSessionId!)?.trialDays).toBeUndefined();
    const other = { id: "other", email: "OWNER@example.com" };
    expect(service.trialDays(other)).toBeNull();
  });
  it("keeps a trialing subscription active through the never-paid rules and their heal on restart", async () => {
    const { sub } = await buy(desktopOnly());
    service.close(); service = createBillingService({ store, provider, clouds, config, publicUrl: "https://dashboard.test", now: () => time });
    expect(store.state.subscriptions[0]).toMatchObject({ id: sub.id, status: "active", trialEndsAt: time + 3 * day });
    expect(clouds.get(sub.cloudId!)?.status).not.toBe("destroyed");
  });
  it("a trial ending without payment takes the failed-payment path, with the grace from the trial's end", async () => {
    const { sub } = await buy(desktopOnly());
    time += 3 * day; deliver(provider.fail(sub.providerSubscriptionId!));
    const row = store.state.subscriptions[0];
    expect(row.status).toBe("payment_problem");
    expect(clouds.setPaymentProblem).toHaveBeenLastCalledWith(sub.cloudId, true);
    expect(clouds.scheduleDestroy).toHaveBeenLastCalledWith(sub.cloudId, row.trialEndsAt! + 30 * day);
  });
  it("cancelling in the trial ends the plan at the trial's end and charges nothing", async () => {
    const { sub } = await buy(desktopOnly());
    await service.cancel(owner, sub.id, { answer: "price" });
    expect(provider.cancelCalls.at(-1)).toEqual({ subscriptionId: sub.providerSubscriptionId, cancel: true });
    expect(store.state.subscriptions[0]).toMatchObject({ status: "active", cancelAtPeriodEnd: true, currentPeriodEnd: time + 3 * day });
    expect(clouds.scheduleDestroy).toHaveBeenLastCalledWith(sub.cloudId, time + 3 * day + 30 * day);
    expect(store.state.invoices.every(invoice => invoice.amountCents === 0)).toBe(true);
    time += 3 * day; deliver(provider.expire(sub.providerSubscriptionId!));
    expect(store.state.subscriptions[0].status).toBe("ended");
  });
});

describe("plan switching", () => {
  const plus = (interval: Cart["interval"] = "month") => ({ ...preset(1), interval });
  const pro = (interval: Cart["interval"] = "month") => preset(2, interval);
  const team = (interval: Cart["interval"] = "month") => preset(3, interval);
  async function switchTo(sub: { id: string }, cart: Cart) {
    const preview = await service.previewChange(owner, sub.id, cart);
    return { preview, result: await service.change(owner, sub.id, preview.confirmation) };
  }
  const trialFirst = () => { config.trial = { days: 3 }; };
  /** the provider's subscription as a webhook carries it */
  const subscriptionEvent = (id: string) => {
    const row = provider.subscriptions.get(id)!;
    return { subscription_id: id, customer: { customer_id: row.customerId }, metadata: { checkoutId: row.input.checkoutId, accountId: row.input.accountId }, product_id: row.input.cart[0].productId,
      addons: row.input.cart[0].addons.map(addon => ({ addon_id: addon.addonId, quantity: addon.quantity })), next_billing_date: new Date(row.nextBillingAt).toISOString(), cancel_at_next_billing_date: false, status: "active" };
  };

  it("trial plus to pro: nothing today, the trial keeps its end, the first charge is pro's, and the machine grows now", async () => {
    trialFirst();
    const { sub } = await buy(plus());
    const trialEnd = sub.trialEndsAt!; expect(trialEnd).toBe(time + 3 * day);
    time += day;
    const { preview } = await switchTo(sub, pro());
    expect(preview).toMatchObject({ timing: "trial", chargeNowCents: 0, taxCents: 0, effectiveAt: time, nextChargeCents: 5000, nextChargeAt: trialEnd });
    expect(provider.changeCalls.at(-1)?.mode).toBe("trial"); expect(provider.charges).toEqual([]);
    expect(sub).toMatchObject({ cart: pro(), totalCents: 5000, trialEndsAt: trialEnd, currentPeriodEnd: trialEnd });
    expect(service.licenses(owner.id)[0]).toMatchObject({ kind: "solo", status: "active", seats: 1 });
    expect(clouds.changePlan).toHaveBeenLastCalledWith(sub.cloudId, expect.objectContaining({ kind: "shared_m", spec: { vcpu: 4, ramGb: 8, diskGb: 60 } }), { now: true });
    // dodo answers a trial switch with subscription.renewed whose next date is still the trial's end: the trial goes on
    deliver([signed("subscription.renewed", { ...subscriptionEvent(sub.providerSubscriptionId!), next_billing_date: new Date(trialEnd).toISOString() })]);
    expect(sub.trialEndsAt).toBe(trialEnd); expect(service.subscriptions(owner.id)[0]!.trialEndsAt).toBe(trialEnd);
    time = trialEnd; deliver(provider.renew(sub.providerSubscriptionId!));
    expect(store.state.invoices.at(-1)!.amountCents).toBe(5000); expect(sub.currentPeriodEnd).toBeGreaterThan(trialEnd);
  });
  it("trial pro to plus: nothing today, plus from the trial's end, the work license goes and the machine shrinks", async () => {
    trialFirst();
    const { sub } = await buy(pro()); const trialEnd = sub.trialEndsAt!;
    const { preview } = await switchTo(sub, plus());
    expect(preview).toMatchObject({ timing: "trial", chargeNowCents: 0, nextChargeCents: 2000, nextChargeAt: trialEnd });
    expect(sub).toMatchObject({ cart: plus(), trialEndsAt: trialEnd }); expect(sub.licenseId).toBeNull();
    expect(clouds.changePlan).toHaveBeenLastCalledWith(sub.cloudId, expect.objectContaining({ kind: "shared_s" }), { now: true });
    time = trialEnd; deliver(provider.renew(sub.providerSubscriptionId!));
    expect(store.state.invoices.at(-1)!.amountCents).toBe(2000);
  });
  it("a renewal charged before the trial's end ends the trial: the next switch is prorated, not free", async () => {
    trialFirst();
    const { sub } = await buy(plus()); time += day;
    provider.subscriptions.get(sub.providerSubscriptionId!)!.nextBillingAt = time;
    deliver(provider.renew(sub.providerSubscriptionId!));
    expect(sub.trialEndsAt).toBe(time); expect(sub.currentPeriodStart).toBe(time); expect(sub.currentPeriodEnd).toBeGreaterThan(time + 27 * day);
    time += 15 * day;
    const { preview } = await switchTo(sub, pro());
    expect(preview.timing).toBe("now"); expect(preview.chargeNowCents).toBeGreaterThan(0); expect(provider.changeCalls.at(-1)?.mode).toBe("keep_cycle");
  });
  it("plus to pro after the trial: charged now for the days left only, the billing date stays, and the provider's amount is the one shown", async () => {
    const { sub } = await buy(plus()); const end = sub.currentPeriodEnd!;
    time = sub.currentPeriodStart! + (end - sub.currentPeriodStart!) * 0.25;
    const { preview } = await switchTo(sub, pro());
    expect(preview).toMatchObject({ timing: "now", chargeNowCents: Math.round((5000 - 2000) * 0.75), effectiveAt: time, nextChargeCents: 5000, nextChargeAt: end });
    expect(provider.changeCalls.at(-1)?.mode).toBe("keep_cycle"); expect(provider.charges).toEqual([{ subscriptionId: sub.providerSubscriptionId, cents: preview.chargeNowCents }]);
    expect(sub).toMatchObject({ cart: pro(), totalCents: 5000, currentPeriodEnd: end }); expect(sub.pendingChange).toBeUndefined();
    expect(service.licenses(owner.id)[0]).toMatchObject({ kind: "solo", status: "active" });
    expect(clouds.changePlan).toHaveBeenLastCalledWith(sub.cloudId, expect.objectContaining({ kind: "shared_m" }), { now: true });
  });
  it("never charges more than was shown: a later confirm only gets cheaper, a higher price asks again", async () => {
    const { sub } = await buy(plus());
    const preview = await service.previewChange(owner, sub.id, pro());
    time += 9 * 60_000;
    await service.change(owner, sub.id, preview.confirmation);
    expect(provider.charges[0]!.cents).toBeLessThanOrEqual(preview.chargeNowCents);
    const back = await buy(desktopOnly(), stranger);
    const shown = await service.previewChange(stranger, back.sub.id, { ...desktopOnly(), desktop: { kind: "shared_m", region: "fsn1" } });
    vi.spyOn(provider, "previewChange").mockResolvedValueOnce({ chargeCents: shown.chargeNowCents + 1, taxCents: 0 });
    await expect(service.change(stranger, back.sub.id, shown.confirmation)).rejects.toMatchObject({ code: "price_changed" });
  });
  it("plus to team: charged now for the time left, a two-seat team license, and the machine resizes to the team size in place", async () => {
    const { sub } = await buy(plus()); time += 10 * day;
    const { preview } = await switchTo(sub, team());
    expect(preview.timing).toBe("now"); expect(preview.chargeNowCents).toBeGreaterThan(0);
    expect(sub.cart).toEqual(team());
    expect(service.licenses(owner.id)[0]).toMatchObject({ kind: "team", seats: 2, status: "active" });
    expect(clouds.changePlan).toHaveBeenLastCalledWith(sub.cloudId, { kind: "dedicated", placement: "dedicated", spec: { vcpu: 8, ramGb: 16, diskGb: 160 }, botComputers: null }, { now: true });
  });
  it("a cloud off the managed backend never blocks the switch: the plan changes and the operator is told", async () => {
    const { sub } = await buy(plus()); clouds.movable = vi.fn(() => false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await switchTo(sub, team());
    expect(sub.cart).toEqual(team()); expect(clouds.changePlan).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ALERT"));
  });
  it("pro to plus mid-period: nothing now, pro and its license until the billing date, then plus and a smaller machine", async () => {
    const { sub } = await buy(pro()); const end = sub.currentPeriodEnd!; time += 5 * day;
    const { preview, result } = await switchTo(sub, plus());
    expect(preview).toMatchObject({ timing: "scheduled", chargeNowCents: 0, effectiveAt: end, nextChargeCents: 2000, nextChargeAt: end });
    expect(provider.changeCalls.at(-1)?.mode).toBe("scheduled"); expect(provider.charges).toEqual([]);
    expect(result.subscription.scheduledChange).toMatchObject({ bundle: "starter", totalCents: 2000, at: end });
    expect(sub.cart).toEqual(pro()); expect(clouds.changePlan).not.toHaveBeenCalled();
    expect(service.licenses(owner.id)[0]).toMatchObject({ kind: "solo", status: "active" });
    await expect(service.previewChange(owner, sub.id, plus())).rejects.toMatchObject({ code: "already_on_plan" });
    time = end; deliver(provider.renew(sub.providerSubscriptionId!));
    expect(sub).toMatchObject({ cart: plus(), totalCents: 2000 }); expect(sub.scheduledChange).toBeUndefined(); expect(sub.licenseId).toBeNull();
    expect(store.state.invoices.at(-1)!.amountCents).toBe(2000);
    expect(clouds.changePlan).toHaveBeenLastCalledWith(sub.cloudId, expect.objectContaining({ kind: "shared_s" }), { now: true });
  });
  it("undoes a scheduled downgrade by choosing the current plan again, and an upgrade replaces it", async () => {
    const { sub } = await buy(pro()); time += day;
    await switchTo(sub, plus());
    const { preview } = await switchTo(sub, pro());
    expect(preview).toMatchObject({ timing: "undo", chargeNowCents: 0 });
    expect(provider.cancelScheduledCalls).toEqual([sub.providerSubscriptionId]); expect(sub.scheduledChange).toBeUndefined();
    await switchTo(sub, plus()); expect(sub.scheduledChange).toBeDefined();
    await switchTo(sub, team());
    expect(sub.scheduledChange).toBeUndefined(); expect(sub.cart).toEqual(team());
  });
  it("a renewal moved earlier brings a scheduled change with it", async () => {
    const { sub } = await buy(pro()); await switchTo(sub, plus());
    const early = time + 2 * day;
    await service.moveRenewal(owner, sub.id, early);
    expect(sub.scheduledChange?.at).toBe(early);
    provider.subscriptions.get(sub.providerSubscriptionId!)!.nextBillingAt = time + day;
    time += day; deliver(provider.renew(sub.providerSubscriptionId!));
    expect(sub).toMatchObject({ cart: plus(), totalCents: 2000 }); expect(sub.scheduledChange).toBeUndefined();
  });
  it("a renewal of the old plan past the date drops a scheduled change the provider let go", async () => {
    const { sub } = await buy(pro()); await switchTo(sub, plus());
    provider.subscriptions.get(sub.providerSubscriptionId!)!.scheduled = null;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    time = sub.currentPeriodEnd!; deliver(provider.renew(sub.providerSubscriptionId!));
    expect(sub.scheduledChange).toBeUndefined(); expect(sub.cart).toEqual(pro());
  });
  it("monthly to yearly: the year less this month's unused part now, and a new yearly period from today", async () => {
    const { sub } = await buy(pro()); const start = sub.currentPeriodStart!, end = sub.currentPeriodEnd!;
    time = start + (end - start) / 2;
    const yearly = quote(pro("year"), config).totalCents;
    const { preview } = await switchTo(sub, pro("year"));
    expect(preview).toMatchObject({ timing: "now", chargeNowCents: Math.round(yearly - 5000 * 0.5), nextChargeCents: yearly });
    expect(provider.changeCalls.at(-1)?.mode).toBe("new_cycle");
    expect(sub).toMatchObject({ cart: pro("year"), currentPeriodStart: time, currentPeriodEnd: preview.nextChargeAt });
    expect(new Date(preview.nextChargeAt!).getUTCFullYear()).toBe(new Date(time).getUTCFullYear() + 1);
    expect(clouds.changePlan).not.toHaveBeenCalled();
  });
  it("yearly to monthly on the same plan keeps the paid year and switches at its end", async () => {
    const { sub } = await buy(pro("year")); const end = sub.currentPeriodEnd!;
    const { preview } = await switchTo(sub, pro());
    expect(preview).toMatchObject({ timing: "scheduled", chargeNowCents: 0, effectiveAt: end, nextChargeCents: 5000 });
    expect(sub.cart).toEqual(pro("year"));
  });
  it("team to pro needs its extra members gone first", async () => {
    const { sub } = await buy(team());
    service.addMember(owner, sub.licenseId!, "teammate@example.com");
    await expect(service.previewChange(owner, sub.id, pro())).rejects.toMatchObject({ code: "seats_full" });
  });
  it("a refused payment changes nothing and says so; a card check hands back the provider's payment page", async () => {
    const { sub } = await buy(plus());
    let preview = await service.previewChange(owner, sub.id, pro()); provider.failChangePlan = "refused";
    await expect(service.change(owner, sub.id, preview.confirmation)).rejects.toMatchObject({ status: 402, code: "payment_failed" });
    expect(sub.cart).toEqual(plus()); expect(sub.pendingChange).toBeUndefined();
    provider.failChangePlan = false; provider.paymentUrl = "https://test.checkout.dodopayments.com/pay_3ds";
    // the provider still shows plus: the card check was never paid
    const plusSeen = await provider.subscription(sub.providerSubscriptionId!);
    vi.spyOn(provider, "subscription").mockResolvedValue(plusSeen);
    preview = await service.previewChange(owner, sub.id, pro());
    const { paymentUrl } = await service.change(owner, sub.id, preview.confirmation);
    expect(paymentUrl).toBe("https://test.checkout.dodopayments.com/pay_3ds"); expect(sub.pendingChange).toBeDefined();
    await expect(service.previewChange(owner, sub.id, team())).rejects.toMatchObject({ code: "change_in_progress" });
    // never paid: after an hour the change is let go and plans can be switched again
    time += 61 * 60_000;
    await expect(service.previewChange(owner, sub.id, team())).resolves.toMatchObject({ timing: "now" });
    expect(sub.pendingChange).toBeUndefined();
  });
  it("keeps the cloud's region: a plan picked for another region still switches", async () => {
    config.poolRegions.push("nbg1");
    const { sub } = await buy(plus());
    const { preview } = await switchTo(sub, { ...pro(), desktop: { kind: "shared_m", region: "nbg1" } });
    expect(preview.timing).toBe("now"); expect(sub.cart.desktop.region).toBe("fsn1");
  });
});

describe("a deleted account's email signing up again", () => {
  async function deleteAfterBuying() {
    const { sub } = await buy(desktopOnly());
    const customerId = store.state.customers.find(row => row.accountId === owner.id)!.providerCustomerId!;
    await service.closeAccount(owner, { destroyDesktopsNow: true }); service.accountDeleted(owner.id);
    return { sub, customerId };
  }
  const again = { id: "owner_again", email: owner.email };
  async function payAgain(customerId: string) {
    const answer = await service.checkout(again, { kind: "cart", cart: desktopOnly() });
    const checkout = store.state.checkouts.find(row => row.id === answer.checkoutId)!;
    // dodo keeps one customer per email, so the new account's checkout lands on the deleted account's customer
    provider.sessions.get(checkout.providerSessionId!)!.customerId = customerId;
    deliver(provider.complete(checkout.providerSessionId!));
  }
  it("pays with the customer dodo kept for that email and gets the plan; the deleted rows no longer hold it", async () => {
    const { customerId } = await deleteAfterBuying();
    expect(store.state.customers.filter(row => row.providerCustomerId === customerId)).toEqual([]);
    await payAgain(customerId);
    expect(service.subscriptions(again.id)).toEqual([expect.objectContaining({ status: "active" })]);
    expect(store.state.customers.filter(row => row.providerCustomerId === customerId).map(row => row.accountId)).toEqual([again.id]);
  });
  it("rebinds a customer an older build left on the deleted account, and warns on any refused event", async () => {
    const { customerId } = await deleteAfterBuying();
    store.state.customers.find(row => row.accountId.startsWith("anon_"))!.providerCustomerId = customerId;
    await payAgain(customerId);
    expect(service.subscriptions(again.id)).toEqual([expect.objectContaining({ status: "active" })]);
    expect(store.state.customers.filter(row => row.providerCustomerId === customerId).map(row => row.accountId)).toEqual([again.id]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    deliver([signed("payment.succeeded", { payment_id: "pay_x", subscription_id: "sub_x", customer: { customer_id: "cus_x" }, total_amount: 1, currency: "USD", metadata: { checkoutId: "chk_unknown" } })]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^billing: WARN payment\.succeeded pay_x .*not applied/));
    expect(warn.mock.calls.flat().join(" ")).not.toContain(owner.email);
  });
  it("recovers a paid subscription whose webhook never applied from the provider", async () => {
    const answer = await service.checkout(owner, { kind: "cart", cart: desktopOnly() });
    const checkout = store.state.checkouts.find(row => row.id === answer.checkoutId)!;
    const [, active] = provider.complete(checkout.providerSessionId!);
    const data = JSON.parse(active.body.toString("utf8")).data;
    Object.assign(provider, { list: async (resource: string) => resource === "subscriptions" ? [{ ...data, addons: undefined, created_at: new Date(time).toISOString() }] : [] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await service.recoverUnapplied()).toEqual({ recovered: 1 });
    expect(service.subscriptions(owner.id)).toEqual([expect.objectContaining({ status: "active" })]);
    expect(await service.recoverUnapplied()).toEqual({ recovered: 0 });
  });
});
