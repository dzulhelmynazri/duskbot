import { createHash, randomBytes } from "node:crypto";
import { CANCEL_ANSWERS, CLOUD_SWATCHES, RETENTION_OUTCOMES, RETENTION_STEPS, checkoutSource } from "../../../../shared/billing-api.ts";
import type { CancelAnswer, RetentionInput, RetentionView, FunnelRow, FunnelView, DeletionBlocker, BillingErrorCode, BillingOverview, CancelSurvey, Cart, ChangePreview, ChangeTiming, CheckoutAnswer, CheckoutItem, InvoicePage, LicenseCheck, LicenseView, SubscriptionView } from "../../../../shared/billing-api.ts";
import type { CloudsService, DesktopPlan } from "../clouds/types.ts";
import { paidCloud } from "../clouds/service.ts";
import { BILLING_CONFIG, catalogView } from "./plans.ts";
import type { BillingConfig } from "./plans.ts";
import { changeTiming, dodoCart, dodoCartKeys, parseCart, quote, sameCart } from "./pricing.ts";
import type { BillingMode, BillingStore, CloudAction, PendingChange, ScheduledChange, StoredCheckout, StoredSubscription } from "./store.ts";
import { BillingProviderError, SYNC_PAGE } from "./types.ts";
import type { AccountRef, BillingEvent, BillingProvider, ChangeMode } from "./types.ts";
import type { WebhookHeaders } from "./webhook-signature.ts";
import { appendLedger, draft, moneyOf } from "./ledger.ts";
import type { LedgerDraft, LedgerEntry } from "./ledger.ts";
import type { Attribution } from "./store.ts";

export class BillingError extends Error {
  status: number; code: BillingErrorCode; url?: string | null; blockers?: DeletionBlocker[];
  constructor(status: number, code: BillingErrorCode, url?: string | null) { super(code); this.status = status; this.code = code; if (url !== undefined) this.url = url; }
}
export interface BillingServiceOptions {
  store: BillingStore; provider: BillingProvider; clouds: CloudsService; config?: BillingConfig; publicUrl: string; now?: () => number; random?: (bytes: number) => string;
  /** told after a change is stored: an email goes out for each; never throws into billing */
  notify?: (notice: BillingNotice) => void;
  /** each new ledger row, after it is stored; never throws into billing */
  onLedger?: (entry: LedgerEntry) => void;
  /** each cancel flow step, after it is stored; never throws into billing */
  onRetention?: (entry: { accountId: string } & RetentionInput) => void;
  /** the provider's mode, stamped on each new subscription and payment: dodo test or live; the fake provider is test */
  mode?: BillingMode;
}
/** the stay-on discount: once per account, on a monthly plan's next three renewals */
export const RETENTION_DISCOUNT = { percent: 30, cycles: 3 } as const;
export type BillingNotice =
  | { kind: "receipt"; accountId: string; invoiceId: string; amountCents: number; currency: string; description: string; paidAt: number;
      periodStart: number | null; periodEnd: number | null; renews: boolean; first: boolean; cloudId: string | null; revived: boolean }
  | { kind: "payment_failed"; accountId: string; amountCents: number; currency: string; description: string; cloudId: string | null; fixBy: number | null }
  | { kind: "cancelled"; accountId: string; description: string; cloudId: string | null; endsAt: number | null; graceDays: number };
const day = 86_400_000;
/** a scheduled change's renewal may arrive this much before the date we stored */
const SCHEDULED_EARLY_MS = 3_600_000;
/** a change sent to the provider and not seen back by then was not made there (an unpaid card check, say) */
export const PENDING_CHANGE_TTL_MS = 60 * 60_000;
/** an open-ended comp's period end: far enough out that every entitlement check reads it as current */
export const OPEN_ENDED_AT = Date.UTC(2100, 0, 1);
/** a second start of the same plan this soon after the first is the same click again: it gets the page already made */
export const CHECKOUT_REUSE_MS = 60_000;
/** how far back a paid checkout that never became a plan is looked for at the provider */
export const RECOVER_WINDOW_MS = 30 * 86_400_000;
/** new checkout pages one account may open in a short while, under the hourly limit: a person comparing plans opens a
 * few, a script opens one a second */
export const CHECKOUT_BURST = { count: 5, windowMs: 10 * 60_000 } as const;
/** a plan the operator gave rather than sold: its own checkout source, and what its one payment records */
export interface OperatorGrant { source: "ops_grant" | "admin_comp"; amountCents?: number }
const emailOf = (email: string) => email.trim().toLowerCase();
function fail(status: number, code: BillingErrorCode): never { throw new BillingError(status, code); }
function serviceError(error: unknown): never { if (error instanceof BillingError) throw error; throw new BillingError(503, "unavailable"); }
function guarded<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args) => { try { const result = fn(...args); return result instanceof Promise ? result.catch(serviceError) as R : result; } catch (error) { return serviceError(error); } };
}
function surveyOf(input: unknown): CancelSurvey {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail(400, "invalid_request");
  const value = input as Record<string, unknown>;
  if (!CANCEL_ANSWERS.includes(value.answer as CancelSurvey["answer"]) || Object.keys(value).some(key => !["answer", "expected", "improve"].includes(key))) fail(400, "invalid_request");
  const survey: CancelSurvey = { answer: value.answer as CancelSurvey["answer"] };
  for (const key of ["expected", "improve"] as const) if (value[key] !== undefined) {
    if (typeof value[key] !== "string" || value[key].trim().length > 2000) fail(400, "invalid_request");
    survey[key] = value[key].trim();
  }
  return survey;
}

export function createBillingService(options: BillingServiceOptions) {
  const { store, provider, clouds } = options, state = store.state, config = options.config ?? BILLING_CONFIG;
  const now = options.now ?? Date.now, random = options.random ?? (bytes => randomBytes(bytes).toString("base64url"));
  const publicUrl = guarded(() => new URL(options.publicUrl).origin)();
  state.cloudActions ??= []; state.teamInvites ??= []; state.teamLeaves ??= []; state.refunds ??= []; state.closures ??= []; state.providerCancels ??= []; state.duplicates ??= []; state.ledger ??= []; state.retention ??= []; state.retentionDiscounts ??= [];
  const confirmations = new Map<string, { accountId: string; subscriptionId: string; cart: Cart; total: number; expiresAt: number; version: number; timing: ChangeTiming; chargeCents: number }>();
  const mode: BillingMode = options.mode ?? "test";
  const queues = new Map<string, Promise<unknown>>();
  const id = (prefix: string) => `${prefix}_${random(16)}`;
  const copy = <T>(value: T): T => structuredClone(value);
  let notices: BillingNotice[] = [];
  let recorded: LedgerEntry[] = [];
  function sendNotices() {
    const due = notices; notices = [];
    for (const notice of due) try { options.notify?.(notice); } catch { console.warn("billing: a notice failed"); }
    const rows = recorded; recorded = [];
    for (const row of rows) try { options.onLedger?.(row); } catch { console.warn("billing: a ledger listener failed"); }
  }
  function record(input: LedgerDraft) { const row = appendLedger(state.ledger!, input, now()); if (row) recorded.push(row); return row; }
  const monthlyOf = (sub: Pick<StoredSubscription, "totalCents" | "cart" | "source" | "review">) => sub.review || sub.source === "admin_comp" || sub.source === "ops_grant" ? 0 : sub.cart.interval === "year" ? Math.round(sub.totalCents / 12) : sub.totalCents;
  const subFields = (sub: StoredSubscription) => ({ accountId: sub.accountId, subscriptionId: sub.id, providerSubscriptionId: sub.providerSubscriptionId,
    plan: quote(sub.cart, config).bundle ?? "custom", interval: sub.cart.interval, mrrCents: monthlyOf(sub) });
  const planLabel = (sub: StoredSubscription) => config.bundles.find(bundle => bundle.id === quote(sub.cart, config).bundle)?.label.toLowerCase() ?? "custom";
  const cancelledNotice = (sub: StoredSubscription): BillingNotice =>
    ({ kind: "cancelled", accountId: sub.accountId, description: planLabel(sub), cloudId: sub.cloudId, endsAt: sub.currentPeriodEnd, graceDays: config.graceDays });
  // retain webhook ownership binding without retaining the deleted account id.
  const closureId = (accountId: string) => `closure_${createHash("sha256").update(accountId).digest("hex")}`;
  function closureFor(accountId: string) {
    return state.closures!.find(entry => entry.accountId === accountId || entry.anonId === accountId || entry.id === closureId(accountId));
  }
  /** dodo keeps one customer per email: a deleted account's customer id is free for the next account of that email */
  const deleted = (accountId: string) => closureFor(accountId)?.steps.includes("scrubbed") === true;
  function releaseDeletedCustomers(providerCustomerId?: string) {
    let released = 0;
    for (const row of state.customers) if (row.providerCustomerId && (providerCustomerId === undefined || row.providerCustomerId === providerCustomerId) && deleted(row.accountId)) { row.providerCustomerId = null; released++; }
    return released;
  }
  function ensureClosure(accountId: string, destroyDesktopsNow = false) {
    let closure = closureFor(accountId);
    if (!closure) {
      closure = { id: closureId(accountId), accountId, anonId: id("anon"), startedAt: now(), completedAt: null, destroyDesktopsNow, steps: [] };
      state.closures!.push(closure); store.commit();
    }
    return closure;
  }
  function deletionBlockers(accountId: string): DeletionBlocker[] {
    return [
      ...state.subscriptions.filter(sub => sub.accountId === accountId && ["active", "payment_problem"].includes(sub.status)).map(sub => ({
        kind: "subscription" as const, id: sub.id, label: config.bundles.find(bundle => bundle.id === quote(sub.cart, config).bundle)?.label ?? "Custom plan", status: sub.status,
      })),
      ...clouds.list(accountId, true).filter(cloud => !["checkout", "destroyed"].includes(cloud.status)).map(cloud => ({ kind: "cloud_desktop" as const, id: cloud.id, label: cloud.name, status: clouds.view(cloud).status })),
    ];
  }
  /** one the provider would still renew: a plan already set to end, or one made in the other provider mode (which that
   * provider can't find, so it refuses every call), needs no cancel */
  function renews(sub: StoredSubscription) {
    return sub.status !== "ended" && sub.status !== "cancelled" && !sub.cancelAtPeriodEnd && !!sub.providerSubscriptionId && (sub.mode === undefined || sub.mode === mode);
  }
  function closeAccount(account: AccountRef, input: { destroyDesktopsNow: boolean }) {
    return serialized(account.id, async () => {
      const closure = ensureClosure(account.id, input.destroyDesktopsNow);
      if (closure.completedAt !== null) return;
      async function step(name: string, fn: () => void | Promise<void>) {
        if (closure.steps.includes(name)) return;
        await fn(); closure.steps.push(name); store.commit();
      }
      await step("checkouts", () => {
        for (const checkout of state.checkouts) if (checkout.accountId === account.id && checkout.status === "open") {
          if (checkout.cloudId) clouds.abandon(checkout.cloudId);
          checkout.status = "expired";
        }
      });
      for (const sub of state.subscriptions.filter(sub => sub.accountId === account.id && renews(sub))) {
        await step(`cancel:${sub.id}`, async () => {
          await provider.cancelAtPeriodEnd(sub.providerSubscriptionId!, true);
          sub.cancelAtPeriodEnd = true; sub.updatedAt = now(); sub.version++;
        });
      }
      await step("desktops", () => {
        for (const cloud of clouds.list(account.id, true)) if (cloud.status !== "destroyed") {
          if (cloud.status === "checkout") { clouds.abandon(cloud.id); continue; }
          clouds.setReview(cloud.id, false);
          const sub = state.subscriptions.find(sub => sub.id === cloud.subscriptionId);
          if (closure.destroyDesktopsNow) clouds.end(cloud.id, closure.startedAt + config.graceDays * day);
          else clouds.scheduleDestroy(cloud.id, (sub?.currentPeriodEnd ?? closure.startedAt) + config.graceDays * day);
        }
      });
      await step("licenses", () => {
        for (const license of state.licenses) {
          if (license.ownerAccountId === account.id) { license.status = "expired"; license.validUntil = closure.startedAt; }
          else license.members = license.members.filter(member => member.accountId !== account.id && emailOf(member.email) !== emailOf(account.email));
        }
      });
      closure.completedAt = now(); store.commit();
    });
  }
  function accountDeleted(accountId: string) {
    const closure = ensureClosure(accountId);
    if (closure.steps.includes("scrubbed")) return;
    const original = closure.accountId, anonId = closure.anonId;
    const emails = new Set([...state.customers, ...state.checkouts].filter(row => row.accountId === original).map(row => emailOf(row.email)).filter(Boolean));
    clouds.scrubAccount(original, anonId);
    for (const rows of [state.customers, state.checkouts, state.subscriptions, state.invoices, state.feedback]) {
      for (const row of rows) if (row.accountId === original) row.accountId = anonId;
    }
    for (const row of state.ledger ?? []) if (row.accountId === original) row.accountId = anonId;
    for (const row of state.customers) if (row.accountId === anonId) { row.email = ""; row.providerCustomerId = null; delete row.attribution; }
    for (const row of state.checkouts) if (row.accountId === anonId) { row.email = ""; row.source = null; row.url = null; }
    for (const row of state.feedback) if (row.accountId === anonId) { delete row.expected; delete row.improve; }
    for (const license of state.licenses) {
      if (license.ownerAccountId === original) { license.ownerAccountId = anonId; license.status = "expired"; license.validUntil = closure.startedAt; }
      for (const member of license.members) if (member.accountId === original || emails.has(emailOf(member.email))) { member.accountId = anonId; member.email = ""; }
    }
    for (const row of state.duplicates ?? []) if (row.accountId === original) row.accountId = anonId;
    for (const action of state.cloudActions ?? []) if (action.kind === "order" && action.input.accountId === original) { action.input.accountId = anonId; action.input.name = "Deleted"; }
    closure.accountId = anonId; closure.completedAt ??= now(); closure.steps.push("scrubbed"); store.commit();
    destroyDeleted();
  }
  /** every cloud of a deleted account is destroyed: right after the deletion, and again on a timer for any a failed
   *  step or a restart left behind (its machine and archive go through the managed delete, which retries itself) */
  function destroyDeleted() {
    let found = 0;
    for (const closure of state.closures!) {
      if (!closure.steps.includes("scrubbed")) continue;
      for (const cloud of clouds.list(closure.anonId, true)) {
        try { if (clouds.destroyForDeletedAccount(cloud.id)) found++; }
        catch (error) { console.warn(`billing: a deleted account's cloud ${cloud.id} could not be ended (${(error as Error).message})`); }
      }
    }
    return found;
  }
  function scrubDeleted(exists: (accountId: string) => boolean) {
    for (const closure of state.closures!) if (!closure.steps.includes("scrubbed") && !exists(closure.accountId)) accountDeleted(closure.accountId);
  }
  function queueProviderCancel(subscriptionId: string) {
    if (!state.providerCancels!.some(entry => entry.id === subscriptionId)) state.providerCancels!.push({ id: subscriptionId, completedAt: null });
  }
  /** a refusal (already cancelled or refunded, say) never blocks the queue: the operator is told instead */
  async function settledAtProvider(call: () => Promise<void>, what: string) {
    try { await call(); }
    catch (error) {
      if (!(error instanceof BillingProviderError) || error.code !== "refused") throw error;
      console.warn(`billing: ALERT the provider refused a duplicate subscription's ${what}; check it by hand`);
    }
  }
  let draining: Promise<void> | null = null;
  function drainProviderCancels(): Promise<void> {
    if (draining) return draining;
    draining = Promise.resolve().then(async () => {
      for (const entry of state.providerCancels!) if (entry.completedAt === null) {
        await provider.cancelAtPeriodEnd(entry.id, true);
        entry.completedAt = now(); store.commit();
      }
      for (const entry of state.duplicates!) {
        if (entry.cancelledAt === null) { await settledAtProvider(() => provider.cancelNow(entry.id), "cancel"); entry.cancelledAt = now(); store.commit(); }
        for (const payment of entry.payments) if (payment.refundedAt === null) {
          await settledAtProvider(() => provider.refundPayment(payment.id, "duplicate_subscription"), "refund");
          payment.refundedAt = now(); store.commit();
        }
      }
    }).finally(() => { draining = null; });
    return draining;
  }
  function kickProviderCancels() { void drainProviderCancels().catch(() => {}); }
  function endClosedSubscription(checkout: StoredCheckout, providerId: string) {
    let sub = state.subscriptions.find(sub => sub.providerSubscriptionId === providerId);
    if (!sub && checkout.cart) {
      sub = { id: id("sub"), accountId: checkout.accountId, providerSubscriptionId: providerId, checkoutId: checkout.id, cart: copy(checkout.cart), totalCents: checkout.amountCents, lines: copy(checkout.lines),
        status: "ended", source: checkout.source, licenseId: null, cloudId: checkout.cloudId, currentPeriodStart: null, currentPeriodEnd: null, cancelAtPeriodEnd: true, createdAt: now(), updatedAt: now(), version: 0, mode };
      state.subscriptions.push(sub); checkout.subscriptionId = sub.id;
      for (const invoice of state.invoices) if (invoice.checkoutId === checkout.id && !invoice.subscriptionId) invoice.subscriptionId = sub.id;
    }
    if (sub) { sub.status = "ended"; sub.cancelAtPeriodEnd = true; delete sub.pendingChange; delete sub.scheduledChange; }
    checkout.providerSubscriptionId = providerId;
    queueProviderCancel(providerId);
    return sub;
  }
  function parsed(input: unknown) { const cart = parseCart(input, config); if (!cart) fail(400, "invalid_request"); return cart; }
  /** a team plan's cloud boots as a Team Cloud, named for its owner ("sid's team"); its team id is the cloud's id */
  function teamOf(cart: Cart, accountId: string, email?: string): { team?: string } {
    if (cart.license.kind !== "team") return {};
    const address = email ?? state.customers.find(row => row.accountId === accountId)?.email ?? "";
    const local = address.split("@")[0]!.replace(/[^\p{L}\p{N}._-]/gu, "").slice(0, 40);
    return { team: local ? `${local}'s team` : "team" };
  }
  function purchasable(cart: Cart) { if (cart.license.kind === "none" && cart.desktop.kind === "none") fail(400, "invalid_request"); }
  function returnUrl(path = "/billing") {
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) fail(400, "invalid_request");
    const url = new URL(path, publicUrl); if (url.origin !== publicUrl) fail(400, "invalid_request"); return url.href;
  }
  function products() {
    if (provider.name !== "fake") return config.products;
    return new Proxy(config.products, { get: (target, key) => typeof key === "string" ? target[key] ?? key : undefined });
  }
  /** the cart as provider ids; a key missing from MADANI_DODO_PRODUCTS is named in the log and answers 503 */
  function providerCart(cart: Cart) {
    const ids = products(), lines = dodoCart(cart, ids, config);
    if (lines) return lines;
    console.error(`billing: MADANI_DODO_PRODUCTS has no id for ${dodoCartKeys(cart, config).map(({ key }) => key).filter(key => !ids[key]).join(", ") || "this cart"}`);
    fail(503, "unavailable");
  }
  function desktopPlan(cart: Cart): DesktopPlan {
    if (cart.desktop.kind === "none") fail(400, "invalid_request");
    const option = config.desktops[cart.desktop.kind];
    return { kind: option.kind, placement: option.placement, spec: copy(cart.desktop.spec ?? option.machine), botComputers: option.botComputers };
  }
  function owned(accountId: string, subscriptionId: string) {
    const sub = state.subscriptions.find(sub => sub.id === subscriptionId && sub.accountId === accountId);
    if (!sub) fail(404, "not_found"); return sub;
  }
  function editable(accountId: string, subscriptionId: string) {
    if (closureFor(accountId)) fail(409, "billing_active");
    const sub = owned(accountId, subscriptionId);
    if (sub.status === "ended" || sub.status === "pending" || !sub.providerSubscriptionId) fail(409, "not_subscribed"); return sub;
  }
  function ownedLicense(account: AccountRef, licenseId: string) {
    if (closureFor(account.id)) fail(409, "billing_active");
    const license = state.licenses.find(license => license.id === licenseId && license.ownerAccountId === account.id);
    if (!license) fail(404, "not_found"); return license;
  }
  function customer(accountId: string, email: string, providerCustomerId: string | null = null) {
    let entry = state.customers.find(customer => customer.accountId === accountId);
    if (!entry) { entry = { accountId, email: emailOf(email), providerCustomerId }; state.customers.push(entry); }
    if (providerCustomerId) { entry.providerCustomerId = providerCustomerId; releaseDeletedCustomers(providerCustomerId); }
    return entry;
  }
  function view(sub: StoredSubscription): SubscriptionView {
    return copy({ id: sub.id, cart: sub.cart, bundle: quote(sub.cart, config).bundle, lines: sub.lines, totalCents: sub.totalCents, status: sub.status,
      licenseId: sub.licenseId, cloudId: sub.cloudId, currentPeriodEnd: sub.currentPeriodEnd, cancelAtPeriodEnd: sub.cancelAtPeriodEnd, createdAt: sub.createdAt,
      ...(sub.trialEndsAt !== undefined && now() < sub.trialEndsAt ? { trialEndsAt: sub.trialEndsAt } : {}),
      ...(sub.scheduledChange ? { scheduledChange: { cart: sub.scheduledChange.cart, bundle: quote(sub.scheduledChange.cart, config).bundle, totalCents: sub.scheduledChange.totalCents, at: sub.scheduledChange.at } } : {}) });
  }
  /** the free days a first cloud plan of this account starts with: one trial per account, and per email across accounts
   *  (a closed account's address signing up again); null signed out means the plain offer */
  function trialDays(account: AccountRef | null, cart?: Cart): number | null {
    if (!config.trial || cart && cart.desktop.kind === "none") return null;
    if (!account) return config.trial.days;
    const email = emailOf(account.email);
    const owners = new Set([account.id, ...state.customers.filter(entry => entry.email === email).map(entry => entry.accountId)]);
    return state.subscriptions.some(sub => owners.has(sub.accountId)) ? null : config.trial.days;
  }
  function cap(accountId: string) { if (clouds.list(accountId, true).filter(cloud => cloud.status !== "destroyed").length >= config.maxCloudsPerAccount) fail(409, "cap"); }
  /** a live subscription this cart would duplicate: the same plan, or a second work license */
  function duplicateOf(accountId: string, cart: Cart, exceptProviderId: string | null = null) {
    return state.subscriptions.find(sub => sub.accountId === accountId && ["pending", "active", "payment_problem"].includes(sub.status)
      && (exceptProviderId === null || sub.providerSubscriptionId !== exceptProviderId)
      && (sameCart(sub.cart, cart) || cart.license.kind !== "none" && sub.cart.license.kind !== "none")) ?? null;
  }
  /** the newest of this account's ended clouds whose data is still kept, which a new plan of this cart brings back */
  function revivableCloud(accountId: string, cart: Cart) {
    if (cart.desktop.kind === "none") return null;
    const plan = desktopPlan(cart);
    return clouds.list(accountId, true).filter(cloud => cloud.ended && clouds.revivable(cloud.id, plan)
      && !state.subscriptions.some(sub => sub.cloudId === cloud.id && sub.status !== "ended"))
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0] ?? null;
  }
  /** a signed event for a cart checkout of ours whose account already has this plan under another provider subscription */
  function duplicateEvent(event: Extract<BillingEvent, { kind: "subscription" | "payment" }>, checkout: StoredCheckout): event is typeof event & { subscriptionId: string } {
    if (checkout.kind !== "cart" || !checkout.cart || !event.subscriptionId || event.checkoutId !== checkout.id || event.accountId !== checkout.accountId) return false;
    if (state.subscriptions.some(sub => sub.providerSubscriptionId === event.subscriptionId)) return false;
    return state.duplicates!.some(row => row.id === event.subscriptionId) || duplicateOf(checkout.accountId, checkout.cart, event.subscriptionId) !== null;
  }
  function settleDuplicate(checkout: StoredCheckout, providerId: string, input: { paymentId?: string; ended?: boolean } = {}) {
    let entry = state.duplicates!.find(row => row.id === providerId);
    if (!entry) {
      entry = { id: providerId, accountId: checkout.accountId, checkoutId: checkout.id, cancelledAt: input.ended ? now() : null, payments: [] };
      state.duplicates!.push(entry);
      console.warn("billing: ALERT a duplicate subscription is cancelled and refunded");
    }
    for (const invoice of state.invoices) if (invoice.checkoutId === checkout.id && invoice.status === "paid" && !entry.payments.some(row => row.id === invoice.providerPaymentId)) {
      entry.payments.push({ id: invoice.providerPaymentId, refundedAt: null });
    }
    if (input.paymentId && !entry.payments.some(row => row.id === input.paymentId)) entry.payments.push({ id: input.paymentId, refundedAt: null });
    if (checkout.status === "open") checkout.status = "completed";
    if (checkout.cloudId && !checkout.revive && !checkout.subscriptionId) clouds.abandon(checkout.cloudId);
  }
  function licenseAvailable(accountId: string, cart: Cart, except?: string) {
    if (cart.license.kind !== "none" && state.subscriptions.some(sub => sub.accountId === accountId && sub.id !== except && sub.status !== "ended" && sub.cart.license.kind !== "none")) fail(409, "already_subscribed");
  }
  function refreshLicense(sub: StoredSubscription, email: string) {
    let license = state.licenses.find(license => license.id === sub.licenseId);
    if (sub.cart.license.kind === "none") { if (license) license.status = "expired"; sub.licenseId = null; return; }
    const option = config.licenses[sub.cart.license.kind];
    if (!license) {
      license = { id: id("lic"), ownerAccountId: sub.accountId, kind: sub.cart.license.kind, seats: 1, members: [{ email: emailOf(email), accountId: sub.accountId, role: "owner", addedAt: now() }], priority: option.priority, subscriptionId: sub.id, status: "active", validUntil: sub.currentPeriodEnd };
      state.licenses.push(license); sub.licenseId = license.id;
    }
    Object.assign(license, { kind: sub.cart.license.kind, seats: sub.cart.license.kind === "solo" ? 1 : sub.cart.license.members!, priority: option.priority,
      validUntil: sub.currentPeriodEnd, status: sub.status === "ended" ? "expired" : sub.status === "payment_problem" ? "grace" : "active" });
  }
  function period(sub: StoredSubscription, next: number | null) {
    if (next === null || (sub.currentPeriodEnd !== null && next <= sub.currentPeriodEnd)) return;
    if (sub.currentPeriodEnd !== null) sub.currentPeriodStart = sub.currentPeriodEnd;
    else {
      const start = new Date(next), date = start.getUTCDate(); start.setUTCDate(1); start.setUTCMonth(start.getUTCMonth() - (sub.cart.interval === "year" ? 12 : 1));
      const last = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate(); start.setUTCDate(Math.min(date, last)); sub.currentPeriodStart = start.getTime();
    }
    sub.currentPeriodEnd = next;
  }
  /** a subscription whose first payment never landed: no period was ever paid */
  function neverPaid(sub: StoredSubscription) { return (sub.status === "pending" || sub.status === "payment_problem") && sub.currentPeriodEnd === null; }
  function dropNeverPaid(sub: StoredSubscription, checkout: StoredCheckout) {
    sub.status = "ended"; refreshLicense(sub, checkout.email); delete sub.pendingChange; delete sub.scheduledChange;
    if (checkout.status === "open") checkout.status = "expired";
    if (sub.cloudId && !checkout.revive) clouds.abandon(sub.cloudId);
  }
  function endSubscription(sub: StoredSubscription, email: string) {
    sub.status = "ended"; delete sub.scheduledChange; refreshLicense(sub, email);
    if (sub.cloudId) cloudAction({ kind: "end", cloudId: sub.cloudId, at: now() + config.graceDays * day });
  }
  function cloudAction(action: CloudAction) { (state.cloudActions ??= []).push(action); }
  function flushCloudActions() {
    while (state.cloudActions?.length) {
      const action = state.cloudActions[0];
      const accountId = action.kind === "order" ? action.input.accountId : clouds.get(action.cloudId)?.accountId;
      if (accountId && closureFor(accountId) && !["end", "schedule"].includes(action.kind)) { state.cloudActions.shift(); store.commit(); continue; }
      if (action.kind === "order") clouds.order({ ...action.input, id: action.cloudId });
      else if (action.kind === "change") {
        const cloud = clouds.get(action.cloudId);
        if (!cloud?.ended && cloud?.status !== "destroyed" && cloud?.status !== "destroying") {
          if (clouds.movable && !clouds.movable(action.cloudId, action.plan)) console.warn(`billing: ALERT cloud ${action.cloudId} is not on the managed backend and can't take a ${action.plan.kind} plan in place; its plan changed, its machine did not`);
          else clouds.changePlan(action.cloudId, action.plan, action.now ? { now: true } : undefined);
        }
      }
      else if (action.kind === "activate") clouds.activate(action.cloudId, action.subscriptionId, action.plan);
      else if (action.kind === "revive") revive(action);
      else if (action.kind === "payment") clouds.setPaymentProblem(action.cloudId, action.problem);
      else if (action.kind === "schedule") clouds.scheduleDestroy(action.cloudId, action.at);
      else if (action.kind === "end") { if (action.from === undefined) clouds.end(action.cloudId, action.at); else clouds.end(action.cloudId, action.at, action.from); }
      else clouds.cancelDestroy(action.cloudId);
      state.cloudActions.shift();
      try { store.commit(); } catch (error) { state.cloudActions.unshift(action); throw error; }
    }
  }
  function revive(action: Extract<CloudAction, { kind: "revive" }>) {
    if (clouds.revive(action.cloudId, action.subscriptionId, action.plan)) return;
    const sub = state.subscriptions.find(row => row.id === action.subscriptionId), previous = clouds.get(action.cloudId);
    if (!sub || sub.cloudId !== action.cloudId || sub.status === "ended" || sub.cart.desktop.kind === "none") return;
    const fresh = clouds.order({ ...action.plan, ...teamOf(sub.cart, sub.accountId), accountId: sub.accountId, name: previous?.name ?? "My Cloud", color: previous?.color ?? null, region: sub.cart.desktop.region! });
    sub.cloudId = fresh.id;
    clouds.activate(fresh.id, sub.id, action.plan);
  }
  /** `nextBillingAt`: the provider's next billing date after a change that started a new cycle */
  function applyChange(sub: StoredSubscription, change: PendingChange, email: string, nextBillingAt: number | null = null) {
    const previous = sub.cart, cart = change.cart, before = monthlyOf(sub);
    if (change.newCycle && nextBillingAt !== null && nextBillingAt > now()) { sub.currentPeriodStart = now(); sub.currentPeriodEnd = nextBillingAt; }
    sub.cart = copy(cart); sub.totalCents = change.totalCents; sub.lines = copy(change.lines); sub.updatedAt = now(); sub.version++;
    const after = monthlyOf(sub);
    const type = after > before ? "subscription.upgraded" : after < before ? "subscription.downgraded" : "subscription.plan_changed";
    record(draft({ key: `${type}:${sub.id}:${sub.version}`, at: now(), type, via: provider.name === "fake" ? "app" : "webhook", ...subFields(sub), previousMrrCents: before, status: sub.status }));
    refreshLicense(sub, email);
    if (cart.desktop.kind !== "none") {
      const plan = desktopPlan(cart);
      if (previous.desktop.kind === "none") {
        sub.cloudId = change.cloudId;
        cloudAction({ kind: "order", cloudId: sub.cloudId!, input: { ...plan, ...teamOf(cart, sub.accountId, email), accountId: sub.accountId, name: "My Cloud", color: null, region: cart.desktop.region! } });
        cloudAction({ kind: "activate", cloudId: sub.cloudId!, subscriptionId: sub.id, plan });
      } else if (!sameCart({ ...cart, license: previous.license, interval: previous.interval }, previous) && sub.cloudId) cloudAction({ kind: "change", cloudId: sub.cloudId, plan, ...(change.resizeNow ? { now: true } : {}) });
    } else if (previous.desktop.kind !== "none" && sub.cloudId) {
      // the desktop is paid to the period's end (a downgrade refunds nothing): it runs until then, and the grace starts there
      const paidTo = sub.currentPeriodEnd !== null && sub.currentPeriodEnd > now() ? sub.currentPeriodEnd : now();
      cloudAction({ kind: "end", cloudId: sub.cloudId, at: paidTo + config.graceDays * day, ...(paidTo > now() ? { from: paidTo } : {}) }); sub.cloudId = null;
    }
    if (sub.cloudId && sub.cancelAtPeriodEnd && sub.currentPeriodEnd !== null) cloudAction({ kind: "schedule", cloudId: sub.cloudId, at: sub.currentPeriodEnd + config.graceDays * day });
    if (sub.pendingChange === change) delete sub.pendingChange;
    if (sub.scheduledChange === change) delete sub.scheduledChange;
  }
  function matchesProduct(event: Extract<BillingEvent, { kind: "subscription" }>, product: PendingChange["products"]) {
    const addons = (items: typeof event.addons) => JSON.stringify([...items].sort((a, b) => a.addonId.localeCompare(b.addonId)));
    return event.productId === product.productId && addons(event.addons) === addons(product.addons);
  }
  /** why a signed event may not touch this checkout, or null when it may. a deleted account's checkout may still take its
   *  own subscription's events from a customer the next account of that email now holds: they only end that subscription */
  function unbound(event: Extract<BillingEvent, { kind: "subscription" | "payment" }>, checkout: StoredCheckout) {
    if (event.checkoutId !== null && event.checkoutId !== checkout.id) return "names another checkout";
    const closure = closureFor(checkout.accountId);
    if (event.accountId !== checkout.accountId && (!closure || !event.accountId || closure.id !== closureId(event.accountId))) return "names another account";
    if (event.customerId === null) return "has no customer";
    const owner = state.customers.find(customer => customer.accountId === checkout.accountId);
    if (owner?.providerCustomerId && owner.providerCustomerId !== event.customerId) return "is from a customer other than the account's";
    if (!deleted(checkout.accountId) && state.customers.some(customer => customer.accountId !== checkout.accountId && customer.providerCustomerId === event.customerId && !deleted(customer.accountId))) {
      return "is from a customer another account holds";
    }
    return null;
  }
  function refused(event: Extract<BillingEvent, { kind: "subscription" | "payment" }>, why: string) {
    const ref = event.kind === "subscription" ? event.subscriptionId : event.paymentId;
    console.warn(`billing: WARN ${event.kind}.${event.type} ${ref} (checkout ${event.checkoutId ?? "none"}) not applied: it ${why}`);
  }
  function applySubscription(event: Extract<BillingEvent, { kind: "subscription" }>, at: number) {
    let sub = state.subscriptions.find(sub => sub.providerSubscriptionId === event.subscriptionId);
    const checkout = sub ? state.checkouts.find(checkout => checkout.id === sub!.checkoutId) : state.checkouts.find(checkout => checkout.id === event.checkoutId);
    if (!checkout || checkout.kind !== "cart") return refused(event, "names no cart checkout of ours");
    if (!sub && !closureFor(checkout.accountId) && duplicateEvent(event, checkout)) {
      settleDuplicate(checkout, event.subscriptionId, { ended: event.type === "cancelled" || event.type === "expired" }); return;
    }
    const why = unbound(event, checkout);
    if (why) return refused(event, why);
    if (checkout.providerSubscriptionId && checkout.providerSubscriptionId !== event.subscriptionId) return refused(event, "is for a checkout bound to another subscription");
    if (!sub) {
      const expected = checkout.cart && dodoCart(checkout.cart, products(), config)?.[0];
      if (!expected || !matchesProduct(event, expected)) return refused(event, "does not match the checkout's products");
    }
    if (closureFor(checkout.accountId)) {
      if (["active", "renewed", "plan_changed"].includes(event.type) || event.status === "active") endClosedSubscription(checkout, event.subscriptionId);
      return;
    }
    if ((event.type === "active" || event.type === "renewed") && (event.nextBillingAt === null || event.nextBillingAt <= now())) return;
    if (!sub && checkout?.cart && checkout.kind === "cart" && !checkout.subscriptionId) {
      const previousCloud = checkout.cloudId ? clouds.get(checkout.cloudId) : null;
      const lost = checkout.revive ? !clouds.revivable(checkout.cloudId!, desktopPlan(checkout.cart)) : previousCloud?.status === "destroyed";
      if (event.type === "active" && lost && previousCloud && checkout.cart.desktop.kind !== "none") {
        delete checkout.revive;
        checkout.cloudId = `c${randomBytes(12).toString("hex")}`;
        cloudAction({ kind: "order", cloudId: checkout.cloudId, input: { ...desktopPlan(checkout.cart), ...teamOf(checkout.cart, checkout.accountId, checkout.email), accountId: checkout.accountId, name: previousCloud.name, color: previousCloud.color, region: checkout.cart.desktop.region! } });
      }
      sub = { id: id("sub"), accountId: checkout.accountId, providerSubscriptionId: event.subscriptionId, checkoutId: checkout.id, cart: copy(checkout.cart), totalCents: checkout.amountCents, lines: copy(checkout.lines),
        status: "pending", source: checkout.source, licenseId: null, cloudId: checkout.cloudId, currentPeriodStart: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, createdAt: now(), updatedAt: now(), version: 0, mode };
      state.subscriptions.push(sub); checkout.subscriptionId = sub.id;
      for (const invoice of state.invoices) if (invoice.checkoutId === checkout.id && !invoice.subscriptionId) invoice.subscriptionId = sub.id;
    }
    if (!sub || !checkout) return;
    if (sub.status === "ended" || at < (sub.lastEventAt ?? 0)) return;
    checkout.providerSubscriptionId = event.subscriptionId;
    customer(sub.accountId, checkout.email, event.customerId);
    sub.lastEventAt = at;
    const changing = ["plan_changed", "active", "renewed"].includes(event.type) && event.status === "active";
    if (sub.pendingChange && changing && matchesProduct(event, sub.pendingChange.products)) applyChange(sub, sub.pendingChange, checkout.email, event.nextBillingAt);
    // a scheduled change lands with the renewal that bills it; a renewal of the old plan past its date means the provider dropped it
    // a renewal billing the scheduled plan is the switch, whenever it comes (a renewal moved earlier brings it forward)
    if (sub.scheduledChange && changing && (event.type === "renewed" || now() >= sub.scheduledChange.at - SCHEDULED_EARLY_MS) && matchesProduct(event, sub.scheduledChange.products)) applyChange(sub, sub.scheduledChange, checkout.email);
    else if (sub.scheduledChange && event.type === "renewed" && event.nextBillingAt !== null && event.nextBillingAt > sub.scheduledChange.at && !matchesProduct(event, sub.scheduledChange.products)) {
      console.warn(`billing: subscription ${sub.id} renewed on its old plan; its scheduled change was dropped by the provider`);
      delete sub.scheduledChange;
    }
    const first = sub.status === "pending" || sub.cloudId !== null && clouds.get(sub.cloudId)?.status === "checkout";
    if (event.type === "active" || event.type === "renewed") {
      const trialStarts = first && checkout.trialDays !== undefined && sub.trialEndsAt === undefined && sub.currentPeriodEnd === null;
      // a renewal that starts a period past the trial's end ends the trial, even one charged early; dodo also sends
      // renewed for a plan change inside the trial (do_not_bill, 2026-11), with the trial's end as its next date
      if (event.type === "renewed" && sub.trialEndsAt !== undefined && sub.trialEndsAt > now() && event.nextBillingAt !== null && event.nextBillingAt > sub.trialEndsAt) {
        sub.trialEndsAt = now(); if (sub.currentPeriodEnd !== null && sub.currentPeriodEnd > now()) sub.currentPeriodEnd = now();
      }
      sub.status = "active"; period(sub, event.nextBillingAt); if (event.type === "active") sub.cancelAtPeriodEnd = event.cancelAtPeriodEnd; checkout.status = "completed";
      // dodo sends subscription.active at checkout with next_billing_date at the trial's end: that first period is the trial
      if (trialStarts && sub.currentPeriodEnd !== null) { sub.currentPeriodStart = now(); sub.trialEndsAt = sub.currentPeriodEnd; }
      refreshLicense(sub, checkout.email);
      if (sub.cloudId && sub.cart.desktop.kind !== "none") {
        if (first) cloudAction({ kind: checkout.revive && sub.cloudId === checkout.cloudId ? "revive" : "activate", cloudId: sub.cloudId, subscriptionId: sub.id, plan: desktopPlan(sub.cart) });
        cloudAction({ kind: "payment", cloudId: sub.cloudId, problem: false });
        if (!sub.cancelAtPeriodEnd) cloudAction({ kind: "keep", cloudId: sub.cloudId });
        else if (sub.currentPeriodEnd !== null) cloudAction({ kind: "schedule", cloudId: sub.cloudId, at: sub.currentPeriodEnd + config.graceDays * day });
      }
    } else if ((event.type === "on_hold" || event.type === "failed") && neverPaid(sub)) {
      // the first payment never went through: a checkout that failed, not a plan. on_hold is cancelled at the provider
      // so it can't charge later for a cloud we already let go
      dropNeverPaid(sub, checkout);
      if (event.type === "on_hold") queueProviderCancel(event.subscriptionId);
    } else if (event.type === "on_hold" || event.type === "failed") {
      if (sub.status !== "payment_problem") notices.push({ kind: "payment_failed", accountId: sub.accountId, amountCents: sub.totalCents, currency: config.currency, description: planLabel(sub),
        cloudId: sub.cloudId, fixBy: (sub.currentPeriodEnd ?? now()) + config.graceDays * day });
      sub.status = "payment_problem"; refreshLicense(sub, checkout.email);
      if (sub.cloudId) {
        cloudAction({ kind: "payment", cloudId: sub.cloudId, problem: true });
        cloudAction({ kind: "schedule", cloudId: sub.cloudId, at: (sub.currentPeriodEnd ?? now()) + config.graceDays * day });
      }
    } else if (event.type === "cancelled" || event.type === "expired") endSubscription(sub, checkout.email);
    else {
      // a change that started a new billing cycle (monthly to yearly) moves the period with it
      if (event.type === "plan_changed" && event.status === "active" && event.nextBillingAt !== null && event.nextBillingAt > now() && sub.currentPeriodEnd !== null
        && event.nextBillingAt > sub.currentPeriodEnd && (sub.trialEndsAt === undefined || now() >= sub.trialEndsAt)) { sub.currentPeriodStart = now(); sub.currentPeriodEnd = event.nextBillingAt; }
      if (event.cancelAtPeriodEnd && !sub.cancelAtPeriodEnd && sub.status === "active") notices.push(cancelledNotice({ ...sub, cancelAtPeriodEnd: true }));
      sub.cancelAtPeriodEnd = event.cancelAtPeriodEnd;
      const license = state.licenses.find(license => license.id === sub!.licenseId); if (license) license.validUntil = sub.currentPeriodEnd;
      if (sub.cloudId) {
        if (sub.cancelAtPeriodEnd && sub.currentPeriodEnd !== null) cloudAction({ kind: "schedule", cloudId: sub.cloudId, at: sub.currentPeriodEnd + config.graceDays * day });
        else if (!sub.cancelAtPeriodEnd && sub.status === "active" && sub.currentPeriodEnd !== null && sub.currentPeriodEnd > now()) cloudAction({ kind: "keep", cloudId: sub.cloudId });
      }
    }
    sub.updatedAt = now(); sub.version++;
  }
  function applyPayment(event: Extract<BillingEvent, { kind: "payment" }>) {
    let sub = state.subscriptions.find(sub => sub.providerSubscriptionId === event.subscriptionId);
    const checkout = state.checkouts.find(checkout => checkout.id === (sub?.checkoutId ?? event.checkoutId));
    if (checkout && !sub && !closureFor(checkout.accountId) && duplicateEvent(event, checkout)) {
      if (event.type === "succeeded") settleDuplicate(checkout, event.subscriptionId, { paymentId: event.paymentId });
      return;
    }
    if (!checkout || checkout.kind !== "cart" || !checkout.cart) return refused(event, "names no cart checkout of ours");
    const why = unbound(event, checkout);
    if (why) return refused(event, why);
    if (event.currency !== config.currency) return refused(event, `is in ${event.currency}`);
    if (event.subscriptionId === null) return refused(event, "has no subscription");
    if (checkout.providerSubscriptionId && checkout.providerSubscriptionId !== event.subscriptionId) return refused(event, "is for a checkout bound to another subscription");
    let invoice = state.invoices.find(invoice => invoice.providerPaymentId === event.paymentId);
    if (invoice && (invoice.accountId !== checkout.accountId || invoice.checkoutId !== checkout.id)) return refused(event, "names an invoice of another checkout");
    if (closureFor(checkout.accountId) && event.type === "succeeded" && event.subscriptionId) sub = endClosedSubscription(checkout, event.subscriptionId);
    if (event.subscriptionId) checkout.providerSubscriptionId = event.subscriptionId;
    customer(checkout.accountId, checkout.email, event.customerId);
    if (!invoice) {
      invoice = { id: id("inv"), accountId: checkout.accountId, providerPaymentId: event.paymentId, subscriptionId: sub?.id ?? checkout.subscriptionId, checkoutId: checkout.id,
        amountCents: event.amountCents, ...taxOf(event), currency: event.currency, status: event.type === "succeeded" ? "paid" : "failed",
        description: (sub?.lines ?? checkout.lines).filter(line => line.kind !== "discount").map(line => line.label).join(", "), createdAt: now(), mode };
      state.invoices.push(invoice);
      if (invoice.status === "paid") receipt(invoice, sub ?? null);
    } else if (event.type === "succeeded" && invoice.status === "failed") { Object.assign(invoice, { status: "paid", amountCents: event.amountCents, ...taxOf(event), currency: event.currency }); receipt(invoice, sub ?? null); }
    settleRefunds(event.paymentId);
  }
  // the tax inside a charge in its own currency (prices are tax exclusive), kept so revenue can count before tax
  function taxOf(event: { amountCents: number; taxCents?: number | null }) {
    return typeof event.taxCents === "number" && event.taxCents > 0 ? { taxCents: Math.min(event.taxCents, event.amountCents) } : {};
  }
  function receipt(invoice: (typeof state.invoices)[number], sub: StoredSubscription | null) {
    if (invoice.amountCents === 0) return;
    const paidBefore = state.invoices.some(other => other !== invoice && other.status !== "failed" && other.amountCents > 0 && other.checkoutId === invoice.checkoutId);
    notices.push({ kind: "receipt", accountId: invoice.accountId, invoiceId: invoice.id, amountCents: invoice.amountCents, currency: invoice.currency, description: invoice.description, paidAt: now(),
      periodStart: sub?.currentPeriodStart ?? null, periodEnd: sub?.currentPeriodEnd ?? null, renews: sub ? !sub.cancelAtPeriodEnd : false, first: !paidBefore, cloudId: sub?.cloudId ?? null,
      revived: !paidBefore && state.checkouts.some(checkout => checkout.id === invoice.checkoutId && checkout.revive === true) });
  }
  function applyRefund(event: Extract<BillingEvent, { kind: "refund" }>) {
    const refunds = state.refunds ??= [];
    if (state.invoices.some(invoice => invoice.providerPaymentId === event.paymentId && invoice.status === "refunded") && !refunds.some(refund => refund.paymentId === event.paymentId)) return;
    if (!refunds.some(refund => refund.id === event.refundId)) refunds.push({ id: event.refundId, paymentId: event.paymentId, amountCents: event.amountCents, currency: event.currency });
    settleRefunds(event.paymentId);
  }
  function settleRefunds(paymentId: string) {
    const invoice = state.invoices.find(invoice => invoice.providerPaymentId === paymentId);
    if (!invoice || invoice.status === "failed" || invoice.amountCents <= 0) return;
    let refunded = 0;
    for (const refund of state.refunds ?? []) if (refund.paymentId === paymentId && refund.currency === invoice.currency) refunded += Math.min(refund.amountCents, invoice.amountCents - refunded);
    if (refunded === invoice.amountCents) invoice.status = "refunded";
  }
  function handleWebhook(headers: WebhookHeaders, rawBody: Buffer): { duplicate: boolean } {
    let verified;
    try { verified = provider.verifyWebhook(headers, rawBody); }
    catch (error) { if (error instanceof BillingProviderError && error.code === "refused") fail(400, "invalid_request"); fail(401, "bad_signature"); }
    flushCloudActions();
    if (state.webhookEvents.some(event => event.id === verified.id)) { kickProviderCancels(); return { duplicate: true }; }
    const before = copy(state);
    try {
      const event = verified.event;
      const prior = event.kind === "subscription" ? copy(state.subscriptions.find(sub => sub.providerSubscriptionId === event.subscriptionId) ?? null) : null;
      if (event.kind === "subscription") applySubscription(event, verified.at);
      else if (event.kind === "payment") applyPayment(event);
      else if (event.kind === "refund") applyRefund(event);
      ledgerOf(verified.id, verified.at, event, prior);
      state.webhookEvents.push({ id: verified.id, at: now(), type: event.kind === "refund" ? "refund.succeeded" : event.kind === "ignored" || event.kind === "dispute" ? (event.kind === "dispute" ? `dispute.${event.type}` : event.type) : `${event.kind}.${event.type}` });
      state.webhookEvents = state.webhookEvents.filter(event => event.at >= now() - 30 * day).sort((a, b) => a.at - b.at);
      store.commit();
    } catch (error) { Object.assign(state, before); notices = []; recorded = []; throw error; }
    sendNotices();
    flushCloudActions();
    kickProviderCancels();
    return { duplicate: false };
  }
  /** the ledger rows one verified delivery adds: only for records of ours, so a stray or duplicate subscription stays out */
  function ledgerOf(webhookId: string, sentAt: number, event: BillingEvent, prior: StoredSubscription | null) {
    const base = { via: "webhook" as const, webhookId };
    if (event.kind === "payment") {
      const invoice = state.invoices.find(row => row.providerPaymentId === event.paymentId);
      if (!invoice) return;
      const sub = state.subscriptions.find(row => row.id === invoice.subscriptionId);
      record(draft({ ...base, key: `payment.${event.type}:${event.paymentId}`, at: event.createdAt ?? sentAt, type: `payment.${event.type}`, ...(sub ? subFields(sub) : { accountId: invoice.accountId }),
        providerPaymentId: event.paymentId, providerCustomerId: event.customerId, amountCents: event.amountCents, currency: event.currency, ...moneyOf(event),
        country: event.country ?? null, reason: event.errorCode ?? null, status: event.type }));
      return;
    }
    if (event.kind === "refund" || event.kind === "dispute") {
      const invoice = state.invoices.find(row => row.providerPaymentId === event.paymentId);
      const sub = invoice ? state.subscriptions.find(row => row.id === invoice.subscriptionId) : undefined;
      const type = event.kind === "refund" ? "refund.succeeded" : `dispute.${event.type}`, ref = event.kind === "refund" ? event.refundId : event.disputeId;
      record(draft({ ...base, key: `${type}:${ref}`, at: event.createdAt ?? sentAt, type, ...(sub ? subFields(sub) : { accountId: invoice?.accountId ?? null }), providerPaymentId: event.paymentId,
        providerRef: ref, amountCents: event.amountCents, currency: event.currency, reason: event.reason ?? null, status: event.kind === "dispute" ? event.stage : null }));
      return;
    }
    if (event.kind === "ignored") {
      if (!event.data) return;
      const data = event.data, text = (value: unknown) => typeof value === "string" && value ? value.slice(0, 80) : null;
      const metadata = data.metadata && typeof data.metadata === "object" ? data.metadata as Record<string, unknown> : {};
      const checkout = state.checkouts.find(row => row.id === text(metadata.checkoutId));
      const ref = text(data.checkout_session_id) ?? text(data.payment_id) ?? text(data.subscription_id) ?? webhookId;
      record(draft({ ...base, key: `${event.type}:${ref}`, at: sentAt, type: event.type, accountId: checkout?.accountId ?? null, providerRef: ref,
        providerPaymentId: text(data.payment_id), providerSubscriptionId: text(data.subscription_id), amountCents: Number.isSafeInteger(data.total_amount) ? data.total_amount as number : null,
        currency: text(data.currency) }));
      return;
    }
    const sub = state.subscriptions.find(row => row.providerSubscriptionId === event.subscriptionId);
    if (!sub || sub.status === "pending") return;
    const fields = { ...base, ...subFields(sub), at: sentAt, providerCustomerId: event.customerId, country: event.country ?? null, previousMrrCents: prior && prior.status !== "pending" ? monthlyOf(prior) : null };
    const was = prior?.status ?? "pending";
    if (event.type === "active" && sub.status === "active" && was === "pending") record(draft({ ...fields, key: `subscription.active:${sub.providerSubscriptionId}`, type: "subscription.active", at: event.createdAt ?? sentAt, status: "active" }));
    if ((event.type === "active" || event.type === "renewed") && sub.status === "active" && was === "payment_problem") {
      record(draft({ ...fields, key: `subscription.recovered:${sub.providerSubscriptionId}:${sub.currentPeriodEnd ?? webhookId}`, type: "subscription.recovered", status: "active" }));
    }
    if (event.type === "renewed" && sub.status === "active") record(draft({ ...fields, key: `subscription.renewed:${sub.providerSubscriptionId}:${event.nextBillingAt ?? webhookId}`, type: "subscription.renewed", status: "active" }));
    if ((event.type === "on_hold" || event.type === "failed") && was !== "payment_problem" && sub.status === "payment_problem") {
      record(draft({ ...fields, key: `subscription.${event.type}:${sub.providerSubscriptionId}:${sub.currentPeriodEnd ?? webhookId}`, type: `subscription.${event.type}`, status: event.status, reason: event.reason ?? null }));
    }
    if ((event.type === "cancelled" || event.type === "expired") && was !== "ended" && sub.status === "ended") {
      record(draft({ ...fields, key: `subscription.${event.type}:${sub.providerSubscriptionId}`, type: `subscription.${event.type}`, at: event.cancelledAt ?? sentAt, status: "ended", reason: event.reason ?? null }));
    }
    if (prior && prior.status !== "pending" && sub.status !== "ended" && prior.cancelAtPeriodEnd !== sub.cancelAtPeriodEnd) {
      const type = sub.cancelAtPeriodEnd ? "subscription.cancel_scheduled" : "subscription.cancel_undone";
      record(draft({ ...fields, key: `${type}:${sub.providerSubscriptionId}:${webhookId}`, type, status: sub.status, reason: event.reason ?? null }));
    }
  }
  kickProviderCancels();
  try { flushCloudActions(); } catch {}
  const retryCloudActions = setInterval(() => { try { flushCloudActions(); } catch {} }, 15_000);
  retryCloudActions.unref();
  const sweepDeleted = setInterval(() => { try { destroyDeleted(); } catch {} }, 10 * 60_000);
  sweepDeleted.unref();
  /** checkouts nobody paid before they lapsed: expired with the cloud each reserved, so nothing of them lingers. a late
   *  payment still lands and orders a fresh cloud (the subscription event's lost-cloud path) */
  function expireLapsed() {
    const lapsed = state.checkouts.filter(checkout => checkout.status === "open" && checkout.openUntil <= now());
    if (!lapsed.length) return 0;
    for (const checkout of lapsed) {
      const cloud = checkout.cloudId ? clouds.get(checkout.cloudId) : null;
      checkout.status = "expired"; if (checkout.cloudId) clouds.abandon(checkout.cloudId);
      console.log(`billing: expired unpaid checkout ${checkout.id} (account ${checkout.accountId}, started ${new Date(checkout.createdAt).toISOString()})${cloud?.status === "destroyed" && !checkout.revive ? `, retired its pending cloud ${cloud.id} "${cloud.name}" in ${cloud.region}` : ""}`);
    }
    store.commit();
    return lapsed.length;
  }
  /** heals subscriptions an earlier build left in payment_problem after a failed first payment */
  function healNeverPaid() {
    const stuck = state.subscriptions.filter(sub => sub.status === "payment_problem" && neverPaid(sub));
    for (const sub of stuck) {
      const checkout = state.checkouts.find(row => row.id === sub.checkoutId);
      if (!checkout) continue;
      dropNeverPaid(sub, checkout);
      console.log(`billing: ended never-paid subscription ${sub.id} (account ${sub.accountId}, checkout ${checkout.id})`);
    }
    if (stuck.length) store.commit();
  }
  try { healNeverPaid(); } catch (error) { console.warn(`billing: healing never-paid subscriptions failed (${(error as Error).message})`); }
  try { if (releaseDeletedCustomers()) store.commit(); } catch (error) { console.warn(`billing: releasing deleted accounts' customers failed (${(error as Error).message})`); }
  /** a live provider subscription of a recent checkout of ours that never became a plan here (its webhook was refused or
   *  lost): read back from the provider and applied as its subscription.active would have been */
  async function recoverUnapplied(): Promise<{ recovered: number }> {
    if (!provider.list) return { recovered: 0 };
    const since = now() - RECOVER_WINDOW_MS;
    const waiting = new Set(state.checkouts.filter(row => row.kind === "cart" && row.cart && !row.subscriptionId && !row.providerSubscriptionId && row.createdAt >= since && !closureFor(row.accountId)).map(row => row.id));
    if (!waiting.size) return { recovered: 0 };
    const found: Array<Record<string, unknown>> = [];
    for (let page = 0; page < 20; page++) {
      const items = await provider.list("subscriptions", page);
      for (const item of items) {
        const metadata = item.metadata && typeof item.metadata === "object" ? item.metadata as Record<string, unknown> : {};
        if (item.status === "active" && typeof item.subscription_id === "string" && typeof metadata.checkoutId === "string" && waiting.has(metadata.checkoutId)
          && !state.subscriptions.some(sub => sub.providerSubscriptionId === item.subscription_id) && !state.duplicates!.some(row => row.id === item.subscription_id)) found.push(item);
      }
      const oldest = Date.parse(String(items.at(-1)?.created_at ?? ""));
      if (items.length < SYNC_PAGE || Number.isFinite(oldest) && oldest < since) break;
    }
    let recovered = 0;
    for (const item of found) {
      const providerId = item.subscription_id as string, metadata = item.metadata as Record<string, unknown>;
      const seen = await provider.subscription(providerId);
      if (seen.status !== "active") continue;
      const customer = item.customer && typeof item.customer === "object" ? (item.customer as Record<string, unknown>).customer_id : null;
      const event: Extract<BillingEvent, { kind: "subscription" }> = { kind: "subscription", type: "active", subscriptionId: providerId, customerId: typeof customer === "string" ? customer : null,
        checkoutId: metadata.checkoutId as string, accountId: typeof metadata.accountId === "string" ? metadata.accountId : null, productId: seen.productId, addons: seen.addons,
        nextBillingAt: seen.nextBillingAt, cancelAtPeriodEnd: item.cancel_at_next_billing_date === true, status: seen.status };
      const before = copy(state);
      try { applySubscription(event, now()); ledgerOf(`recover:${providerId}`, now(), event, null); store.commit(); }
      catch (error) { Object.assign(state, before); notices = []; recorded = []; throw error; }
      sendNotices(); flushCloudActions(); kickProviderCancels();
      if (state.subscriptions.some(sub => sub.providerSubscriptionId === providerId && sub.status !== "ended")) {
        recovered++; console.warn(`billing: WARN recovered provider subscription ${providerId} for checkout ${event.checkoutId}: its webhook never applied`);
      }
    }
    return { recovered };
  }
  void recoverUnapplied().catch(error => console.warn(`billing: recovering unapplied subscriptions failed (${(error as Error).message})`));
  try { expireLapsed(); } catch {}
  const sweepLapsed = setInterval(() => { try { expireLapsed(); } catch {} }, 10 * 60_000);
  sweepLapsed.unref();
  /** `all`: an operator's grant replaces an open checkout the person never paid */
  function expireCheckouts(accountId: string, all = false) {
    for (const checkout of state.checkouts) if (checkout.accountId === accountId && checkout.status === "open" && (all || checkout.openUntil <= now())) {
      checkout.status = "expired"; if (checkout.cloudId) clouds.abandon(checkout.cloudId);
    }
  }
  async function checkout(account: AccountRef, item: CheckoutItem, input: { source?: unknown; returnPath?: string; operator?: OperatorGrant } = {}): Promise<CheckoutAnswer> {
    if (closureFor(account.id)) fail(409, "billing_active");
    if (!item || typeof item !== "object" || item.kind !== "cart") fail(400, "invalid_request");
    const url = returnUrl(input.returnPath);
    const source = input.operator?.source ?? checkoutSource(input.source);
    expireCheckouts(account.id, input.operator !== undefined);
    const cart = parsed(item.cart);
    const amount = (priced: number) => input.operator?.amountCents ?? priced;
    const open = state.checkouts.find(checkout => checkout.accountId === account.id && checkout.kind === "cart" && checkout.status === "open" && checkout.openUntil > now());
    // the same plan again within a minute, from any surface (a double click, a click that seemed to do nothing, a
    // retry loop) gets the page just made, never another provider session
    const name = typeof item.name === "string" ? item.name.trim() : item.name, cloudOf = open?.cloudId ? clouds.get(open.cloudId) : null;
    const reused = input.operator ? null : open && open.url && open.createdAt > now() - CHECKOUT_REUSE_MS && open.cart && sameCart(open.cart, cart)
      && (!open.cloudId || ((name === undefined || cloudOf?.name === name) && (item.color === undefined || cloudOf?.color === item.color))) ? open : null;
    const started = (within: number) => state.checkouts.filter(checkout => checkout.accountId === account.id && checkout.createdAt > now() - within).length;
    if (!reused && (started(3_600_000) >= config.checkoutsPerHour || started(CHECKOUT_BURST.windowMs) >= CHECKOUT_BURST.count)) fail(429, "rate_limited");
    if (queues.has(account.id) || state.subscriptions.some(sub => sub.accountId === account.id && sub.pendingChange)) fail(409, "change_in_progress");
    purchasable(cart); licenseAvailable(account.id, cart);
    // a request still waiting on the provider holds its place; one that already has a page is replaced below
    if (state.checkouts.some(checkout => checkout.accountId === account.id && checkout.status === "open" && checkout.openUntil > now() && !checkout.url)) throw new BillingError(409, "checkout_open", null);
    if (duplicateOf(account.id, cart)) fail(409, "already_subscribed");
    if (((item.name !== undefined && (typeof item.name !== "string" || !item.name.trim() || item.name.trim().length > 100)) || (item.color !== undefined && !CLOUD_SWATCHES.includes(item.color)))) fail(400, "invalid_request");
    if (reused) return { v: 1, checkoutId: reused.id, checkoutUrl: reused.url!, cloudId: reused.cloudId, revives: reused.revive === true };
    const lines = providerCart(cart);
    // past its first minute an unpaid checkout is never handed out again: a dodo page someone already tried to pay on sends them straight back
    // (status=pending) until it lapses. each try gets a fresh page; a late payment on the old one still lands, and a
    // second plan of the same cart is cancelled and refunded (settleDuplicate)
    if (open) expireCheckouts(account.id, true);
    const revive = revivableCloud(account.id, cart);
    if (cart.desktop.kind !== "none" && !revive) cap(account.id);
    const cloud = revive ?? (cart.desktop.kind !== "none" ? clouds.order({ ...desktopPlan(cart), ...teamOf(cart, account.id, account.email), accountId: account.id, name: item.name?.trim() ?? "My Cloud", color: item.color ?? null, region: cart.desktop.region! }) : null);
    const trial = input.operator ? null : trialDays(account, cart);
    const entry: StoredCheckout = { id: id("chk"), accountId: account.id, email: emailOf(account.email), kind: "cart", cart,
      cloudId: cloud?.id ?? null, ...(revive ? { revive: true } : {}), providerSessionId: null, url: null, status: "open", source, ...(trial ? { trialDays: trial } : {}), createdAt: now(), openUntil: now() + config.checkoutOpenMinutes * 60_000,
      subscriptionId: null, amountCents: amount(quote(cart, config).totalCents), lines: quote(cart, config).lines };
    state.checkouts.push(entry); const owner = customer(account.id, account.email);
    if (!input.operator) record(draft({ key: `checkout.started:${entry.id}`, at: entry.createdAt, type: "checkout.started", via: "app", accountId: account.id, providerRef: entry.id,
      amountCents: entry.amountCents, currency: config.currency, plan: quote(cart, config).bundle ?? "custom", interval: cart.interval, reason: source }));
    store.commit(); sendNotices();
    try {
      const session = await provider.createCheckout({ checkoutId: entry.id, accountId: account.id, email: entry.email, customerId: owner.providerCustomerId, cart: lines, returnUrl: url, ...(trial ? { trialDays: trial } : {}),
        billing: { interval: cart.interval, amountCents: entry.amountCents, currency: config.currency } });
      entry.providerSessionId = session.sessionId;
      if (closureFor(account.id)) { entry.status = "expired"; entry.url = null; store.commit(); fail(409, "billing_active"); }
      entry.url = session.url; store.commit();
      return { v: 1, checkoutId: entry.id, checkoutUrl: session.url, cloudId: entry.cloudId, revives: entry.revive === true };
    } catch (error) {
      if (error instanceof BillingProviderError) console.warn(`billing: WARN checkout ${entry.id} didn't open: the provider said ${error.code}`);
      entry.status = "expired"; store.commit(); if (entry.cloudId && !entry.revive) clouds.abandon(entry.cloudId); fail(503, "unavailable");
    }
  }
  function licenseCheck(account: AccountRef): LicenseCheck {
    const email = emailOf(account.email); let changed = false;
    for (const license of state.licenses) for (const member of license.members) if (member.email === email && member.accountId === null) { member.accountId = account.id; changed = true; }
    if (changed) store.commit();
    const license = state.licenses.find(license => license.members.some(member => member.accountId === account.id) &&
      (["active", "grace"].includes(license.status) && license.validUntil !== null && now() < license.validUntil));
    const until = config.freeWorkUntil !== null && now() < config.freeWorkUntil ? config.freeWorkUntil : null;
    return { v: 1, work: license ? "licensed" : until !== null ? "free_until" : "unlicensed",
      license: license ? { id: license.id, kind: license.kind, status: license.status, validUntil: license.validUntil, role: license.ownerAccountId === account.id ? "owner" : "member" } : null,
      freeWorkUntil: until, checkedAt: now() };
  }
  function licenses(accountId: string) {
    const email = state.customers.find(customer => customer.accountId === accountId)?.email;
    return copy(state.licenses.filter(license => license.ownerAccountId === accountId || license.members.some(member => member.accountId === accountId || member.accountId === null && email !== undefined && member.email === email)));
  }
  function addMember(account: AccountRef, licenseId: string, input: string): LicenseView {
    const license = ownedLicense(account, licenseId);
    if (typeof input !== "string" || input.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.trim())) fail(400, "invalid_request");
    const email = emailOf(input); if (license.members.some(member => member.email === email)) return copy(license);
    if (license.members.length >= license.seats) fail(409, "seats_full");
    license.members.push({ email, accountId: null, role: "member", addedAt: now() }); store.commit(); return copy(license);
  }
  function removeMember(account: AccountRef, licenseId: string, input: string): LicenseView {
    const license = ownedLicense(account, licenseId); if (typeof input !== "string") fail(400, "invalid_request");
    const email = emailOf(input); if (license.members.some(member => member.email === email && member.role === "owner")) fail(403, "forbidden");
    license.members = license.members.filter(member => member.email !== email); store.commit(); return copy(license);
  }
  function saveFeedback(account: AccountRef, cloudId: string | null, subscriptionId: string | null, survey: CancelSurvey) {
    const entry = { id: id("fb"), accountId: account.id, cloudId, subscriptionId, ...survey, at: now() }; state.feedback.push(entry); store.commit();
  }
  async function serialized<T>(subscriptionId: string, fn: () => Promise<T>): Promise<T> {
    const previous = queues.get(subscriptionId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(fn); queues.set(subscriptionId, current);
    try { return await current; } finally { if (queues.get(subscriptionId) === current) queues.delete(subscriptionId); }
  }
  async function setCancel(account: AccountRef, subscriptionId: string, cancel: boolean, survey?: CancelSurvey) {
    return serialized(account.id, async () => {
      let sub = editable(account.id, subscriptionId);
      if (!cancel && (sub.status !== "active" || sub.currentPeriodEnd === null || sub.currentPeriodEnd <= now())) fail(409, "not_subscribed");
      const answer = survey === undefined ? undefined : surveyOf(survey);
      if (answer) saveFeedback(account, sub.cloudId, sub.id, answer);
      await provider.cancelAtPeriodEnd(sub.providerSubscriptionId!, cancel);
      sub = owned(account.id, subscriptionId);
      if (sub.status === "ended" || !cancel && (sub.status !== "active" || sub.currentPeriodEnd === null || sub.currentPeriodEnd <= now())) fail(409, "not_subscribed");
      const before = copy(state);
      const wasCancelled = sub.cancelAtPeriodEnd;
      try {
        sub.cancelAtPeriodEnd = cancel; sub.updatedAt = now(); sub.version++;
        if (sub.cloudId) {
          if (cancel && sub.currentPeriodEnd !== null) cloudAction({ kind: "schedule", cloudId: sub.cloudId, at: sub.currentPeriodEnd + config.graceDays * day });
          else if (!cancel) cloudAction({ kind: "keep", cloudId: sub.cloudId });
        }
        store.commit();
      } catch (error) { Object.assign(state, before); throw error; }
      if (cancel && !wasCancelled && answer) saveRetention(account, sub.id, { reason: answer.answer, step: "confirm", outcome: "cancelled" });
      if (cancel && !wasCancelled && sub.status === "active") { notices.push(cancelledNotice(sub)); sendNotices(); }
      flushCloudActions(); return view(sub);
    });
  }
  function saveRetention(account: AccountRef, subscriptionId: string, input: RetentionInput) {
    const entry = { id: id("rt"), accountId: account.id, subscriptionId, reason: input.reason, step: input.step, outcome: input.outcome, at: now() };
    state.retention!.push(entry); store.commit();
    try { options.onRetention?.({ accountId: account.id, reason: input.reason, step: input.step, outcome: input.outcome }); } catch { console.warn("billing: a retention listener failed"); }
  }
  function retentionStep(account: AccountRef, subscriptionId: string, input: unknown) {
    const sub = owned(account.id, subscriptionId), value = input as Record<string, unknown> | null;
    if (!value || typeof value !== "object" || !CANCEL_ANSWERS.includes(value.reason as CancelAnswer) || !RETENTION_STEPS.includes(value.step as RetentionInput["step"])
      || !RETENTION_OUTCOMES.includes(value.outcome as RetentionInput["outcome"])) fail(400, "invalid_request");
    saveRetention(account, sub.id, { reason: value.reason as CancelAnswer, step: value.step as RetentionInput["step"], outcome: value.outcome as RetentionInput["outcome"] });
    return { ok: true as const };
  }
  const discountable = (sub: StoredSubscription) => sub.status === "active" && !sub.cancelAtPeriodEnd && !sub.pendingChange && !sub.scheduledChange && sub.cart.interval === "month" && sub.totalCents > 0
    && !!sub.providerSubscriptionId && !sub.review && sub.source !== "admin_comp" && sub.source !== "ops_grant" && sub.currentPeriodEnd !== null && sub.currentPeriodEnd > now();
  function retentionView(accountId: string): RetentionView {
    const taken = state.retentionDiscounts!.find(entry => entry.accountId === accountId);
    if (taken) return { offer: null, applied: { percent: taken.percent, cycles: taken.cycles, at: taken.at } };
    const live = state.subscriptions.some(sub => sub.accountId === accountId && discountable(sub));
    return { offer: live ? { ...RETENTION_DISCOUNT } : null, applied: null };
  }
  async function retentionDiscount(account: AccountRef, subscriptionId: string, reason: unknown) {
    if (!CANCEL_ANSWERS.includes(reason as CancelAnswer)) fail(400, "invalid_request");
    return serialized(account.id, async () => {
      if (state.retentionDiscounts!.some(entry => entry.accountId === account.id)) fail(409, "discount_used");
      let sub = editable(account.id, subscriptionId);
      if (!discountable(sub)) fail(409, "discount_unavailable");
      const line = providerCart(sub.cart)[0];
      const { code } = await provider.applyDiscount({ subscriptionId: sub.providerSubscriptionId!, productId: line.productId, addons: line.addons, ...RETENTION_DISCOUNT, accountId: account.id });
      sub = owned(account.id, subscriptionId);
      state.retentionDiscounts!.push({ id: id("disc"), accountId: account.id, subscriptionId: sub.id, code, ...RETENTION_DISCOUNT, at: now() });
      store.commit();
      saveRetention(account, sub.id, { reason: reason as CancelAnswer, step: "help", outcome: "discount" });
      return { subscription: view(sub), retention: retentionView(account.id) };
    });
  }
  function feedback(account: AccountRef, input: { cloudId?: string | null; survey: CancelSurvey }) {
    if (!input || typeof input !== "object") fail(400, "invalid_request");
    const cloudId = input.cloudId ?? null;
    if (cloudId !== null && typeof cloudId !== "string") fail(400, "invalid_request");
    if (cloudId && !clouds.owned(account.id, cloudId)) fail(404, "not_found");
    const sub = cloudId ? state.subscriptions.find(sub => sub.accountId === account.id && sub.cloudId === cloudId) : null;
    saveFeedback(account, cloudId, sub?.id ?? null, surveyOf(input.survey));
  }
  /** a plan switch keeps the cloud where it is: a region is never part of it */
  function sameRegion(sub: StoredSubscription, cart: Cart): Cart {
    return cart.desktop.kind !== "none" && sub.cart.desktop.kind !== "none" && cart.desktop.region !== sub.cart.desktop.region ? { ...cart, desktop: { ...cart.desktop, region: sub.cart.desktop.region } } : cart;
  }
  const trialing = (sub: StoredSubscription) => sub.trialEndsAt !== undefined && now() < sub.trialEndsAt;
  function changeAllowed(account: AccountRef, sub: StoredSubscription, cart: Cart) {
    if (sub.status !== "active" || sub.currentPeriodEnd === null || sub.currentPeriodEnd <= now()) fail(409, "not_subscribed");
    if (state.subscriptions.some(other => other.accountId === account.id && other.pendingChange)) fail(409, "change_in_progress");
    purchasable(cart); licenseAvailable(account.id, cart, sub.id);
    if (cart.license.kind !== "none" && sub.cart.license.kind === "none") {
      const open = state.checkouts.find(checkout => checkout.accountId === account.id && checkout.status === "open" && checkout.openUntil > now() && checkout.cart && checkout.cart.license.kind !== "none");
      if (open) throw new BillingError(409, "checkout_open", open.url);
    }
    if (sameCart(sub.cart, cart) || sub.scheduledChange && sameCart(sub.scheduledChange.cart, cart)) fail(409, "already_on_plan");
    if (cart.desktop.kind !== "none" && sub.cart.desktop.kind === "none") cap(account.id);
    const license = state.licenses.find(license => license.id === sub.licenseId);
    if (license && cart.license.kind !== "none" && license.members.length > quote(cart, config).members) fail(409, "seats_full");
  }
  /** a change sent to the provider whose webhook has not come: read back from the provider, applied once it shows there,
   *  dropped once it is clearly not coming */
  async function settlePending(accountId: string) {
    for (const sub of state.subscriptions.filter(row => row.accountId === accountId && row.pendingChange && row.providerSubscriptionId)) {
      const pending = sub.pendingChange!;
      const seen = await provider.subscription(sub.providerSubscriptionId!);
      const current = owned(accountId, sub.id);
      if (current.pendingChange !== pending) continue;
      const shows = seen.productId === pending.products.productId && JSON.stringify(sortAddons(seen.addons)) === JSON.stringify(sortAddons(pending.products.addons));
      if (shows) settleChange(current, pending, seen.nextBillingAt);
      else if ((pending.at ?? 0) <= now() - PENDING_CHANGE_TTL_MS) { delete current.pendingChange; current.updatedAt = now(); current.version++; store.commit(); }
    }
  }
  const sortAddons = (items: Array<{ addonId: string; quantity: number }>) => [...items].sort((a, b) => a.addonId.localeCompare(b.addonId));
  function settleChange(sub: StoredSubscription, change: PendingChange, nextBillingAt: number | null) {
    const before = copy(state), email = state.checkouts.find(checkout => checkout.id === sub.checkoutId)?.email ?? state.customers.find(row => row.accountId === sub.accountId)?.email ?? "";
    try { applyChange(sub, change, email, nextBillingAt); store.commit(); }
    catch (error) { Object.assign(state, before); recorded = []; throw error; }
    sendNotices(); flushCloudActions();
  }
  /** one interval after `at`, on the same day of the month where it has one */
  function oneInterval(at: number, interval: Cart["interval"]) {
    const date = new Date(at), dayOfMonth = date.getUTCDate(); date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + (interval === "year" ? 12 : 1));
    date.setUTCDate(Math.min(dayOfMonth, new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate())); return date.getTime();
  }
  /** what a change does, priced by the provider: the charge now is the provider's own, tax included */
  async function planChange(sub: StoredSubscription, cart: Cart) {
    if (sub.scheduledChange && sameCart(sub.cart, cart)) return { timing: "undo" as const, mode: null, priced: quote(cart, config), lines: null, chargeCents: 0, taxCents: 0 };
    const { timing, mode } = changeTiming(sub.cart, cart, trialing(sub), config);
    const priced = quote(cart, config), lines = providerCart(cart);
    const charge = timing === "now" ? await provider.previewChange({ subscriptionId: sub.providerSubscriptionId!, productId: lines[0].productId, addons: lines[0].addons, mode, billing: { interval: cart.interval, amountCents: priced.totalCents, currency: config.currency } })
      : { chargeCents: 0, taxCents: 0 };
    return { timing, mode, priced, lines, chargeCents: charge.chargeCents, taxCents: charge.taxCents };
  }
  async function previewChange(account: AccountRef, subscriptionId: string, input: unknown): Promise<ChangePreview> {
    let sub = editable(account.id, subscriptionId);
    const cart = sameRegion(sub, parsed(input));
    await settlePending(account.id);
    sub = editable(account.id, subscriptionId);
    if (!(sub.scheduledChange && sameCart(sub.cart, cart))) changeAllowed(account, sub, cart);
    else if (sub.status !== "active") fail(409, "not_subscribed");
    const plan = await planChange(sub, cart);
    sub = editable(account.id, subscriptionId);
    const expiresAt = now() + 600_000, confirmation = random(32), periodEnd = sub.currentPeriodEnd!;
    for (const [token, preview] of confirmations) if (preview.expiresAt <= now() || preview.accountId === account.id && preview.subscriptionId === sub.id) confirmations.delete(token);
    confirmations.set(confirmation, { accountId: account.id, subscriptionId, cart, total: plan.priced.totalCents, expiresAt, version: sub.version, timing: plan.timing, chargeCents: plan.chargeCents });
    const nextChargeAt = plan.mode === "new_cycle" ? oneInterval(now(), cart.interval) : periodEnd;
    return { v: 1, quote: plan.priced, timing: plan.timing, chargeNowCents: plan.chargeCents, taxCents: plan.taxCents, effectiveAt: plan.timing === "scheduled" ? periodEnd : now(),
      nextChargeCents: plan.priced.totalCents, nextChargeAt, confirmation, expiresAt };
  }
  async function change(account: AccountRef, subscriptionId: string, confirmation: string): Promise<{ subscription: SubscriptionView; paymentUrl?: string }> {
    return serialized(account.id, async () => {
      let sub = editable(account.id, subscriptionId);
      const preview = confirmations.get(confirmation);
      if (!preview || preview.accountId !== account.id || preview.subscriptionId !== subscriptionId) fail(409, "confirmation_required");
      confirmations.delete(confirmation);
      if (preview.expiresAt <= now() || preview.version !== sub.version) fail(409, "confirmation_required");
      const cart = preview.cart;
      if (quote(cart, config).totalCents !== preview.total) fail(409, "price_changed");
      if (preview.timing === "undo") {
        if (!sub.scheduledChange || !sameCart(sub.cart, cart)) fail(409, "confirmation_required");
        await provider.cancelScheduledChange(sub.providerSubscriptionId!);
        sub = owned(account.id, subscriptionId);
        delete sub.scheduledChange; sub.updatedAt = now(); sub.version++; store.commit();
        return { subscription: view(sub) };
      }
      changeAllowed(account, sub, cart);
      // the plan as it is now: a trial that ended or a price that moved since the preview asks again
      const plan = await planChange(sub, cart);
      sub = editable(account.id, subscriptionId);
      if (plan.timing !== preview.timing) fail(409, "confirmation_required");
      if (plan.chargeCents > preview.chargeCents) fail(409, "price_changed");
      const lines = plan.lines!, mode = plan.mode as ChangeMode;
      const pending: PendingChange = { cart: copy(cart), totalCents: plan.priced.totalCents, lines: plan.priced.lines, products: copy(lines[0]), at: now(),
        cloudId: cart.desktop.kind !== "none" && sub.cart.desktop.kind === "none" ? `c${randomBytes(12).toString("hex")}` : sub.cloudId,
        ...(mode === "new_cycle" ? { newCycle: true } : {}), resizeNow: true };
      const scheduled = plan.timing === "scheduled";
      if (!scheduled) { sub.pendingChange = pending; try { store.commit(); } catch (error) { delete sub.pendingChange; throw error; } }
      let answer: { paymentUrl: string | null };
      try {
        answer = await provider.changePlan({ subscriptionId: sub.providerSubscriptionId!, productId: lines[0].productId, addons: lines[0].addons, mode, billing: { interval: cart.interval, amountCents: plan.priced.totalCents, currency: config.currency } });
      } catch (error) {
        if (error instanceof BillingProviderError && error.code === "refused") {
          const row = owned(account.id, subscriptionId); if (row.pendingChange === pending) delete row.pendingChange; store.commit();
          fail(402, "payment_failed");
        }
        throw error;
      }
      sub = owned(account.id, subscriptionId);
      if (sub.status !== "active") fail(409, "not_subscribed");
      if (scheduled) {
        const at: ScheduledChange = { ...pending, at: sub.currentPeriodEnd! };
        sub.scheduledChange = at; sub.updatedAt = now(); sub.version++; store.commit();
        return { subscription: view(sub) };
      }
      // the provider replaced any scheduled change with this one
      if (sub.scheduledChange) { delete sub.scheduledChange; store.commit(); }
      if (answer.paymentUrl) return { subscription: view(sub), paymentUrl: answer.paymentUrl };
      if (sub.pendingChange === pending) {
        const seen = await provider.subscription(sub.providerSubscriptionId!).catch(() => null);
        sub = owned(account.id, subscriptionId);
        const shows = seen && seen.productId === pending.products.productId && JSON.stringify(sortAddons(seen.addons)) === JSON.stringify(sortAddons(pending.products.addons));
        if (shows && sub.pendingChange === pending) settleChange(sub, pending, seen.nextBillingAt);
      }
      flushCloudActions(); return { subscription: view(owned(account.id, subscriptionId)) };
    });
  }
  /** the operator's change of a live plan: the owner's own preview and change, without the round trip through their page */
  async function operatorChange(account: AccountRef, subscriptionId: string, input: unknown) {
    const changed = await change(account, subscriptionId, (await previewChange(account, subscriptionId, input)).confirmation);
    const sub = owned(account.id, subscriptionId);
    if (sub.source === "admin_comp" && sub.totalCents !== 0) { sub.totalCents = 0; sub.updatedAt = now(); sub.version++; store.commit(); return view(sub); }
    return changed.subscription;
  }
  /** moves a live plan's period end either way; `OPEN_ENDED_AT` makes it open-ended */
  function setPeriodEnd(account: AccountRef, subscriptionId: string, until: number) {
    const sub = editable(account.id, subscriptionId);
    if (!Number.isSafeInteger(until) || until <= now()) fail(400, "invalid_request");
    const before = copy(state);
    try {
      sub.currentPeriodEnd = until;
      if (sub.scheduledChange) sub.scheduledChange.at = until;
      if (sub.currentPeriodStart === null || sub.currentPeriodStart >= until) sub.currentPeriodStart = Math.min(sub.currentPeriodStart ?? now(), now());
      sub.updatedAt = now(); sub.version++;
      refreshLicense(sub, state.checkouts.find(checkout => checkout.id === sub.checkoutId)?.email ?? account.email);
      if (sub.cloudId && sub.cancelAtPeriodEnd) cloudAction({ kind: "schedule", cloudId: sub.cloudId, at: until + config.graceDays * day });
      store.commit();
    } catch (error) { Object.assign(state, before); throw error; }
    flushCloudActions(); return view(sub);
  }
  /** the operator's move of a paid plan's next renewal, either way: the provider reschedules it (nothing is charged or
   *  credited), then the period here follows */
  async function moveRenewal(account: AccountRef, subscriptionId: string, until: number) {
    return serialized(account.id, async () => {
      const sub = editable(account.id, subscriptionId);
      if (sub.status !== "active" || !Number.isSafeInteger(until) || until <= now() || until >= OPEN_ENDED_AT) fail(400, "invalid_request");
      if (!provider.setNextBillingDate) fail(503, "unavailable");
      await provider.setNextBillingDate(sub.providerSubscriptionId!, until);
      return setPeriodEnd(account, subscriptionId, until);
    });
  }
  /** ends a live plan today: the provider stops billing, and its cloud gets the usual grace from now */
  async function endNow(account: AccountRef, subscriptionId: string) {
    return serialized(account.id, async () => {
      let sub = editable(account.id, subscriptionId);
      await provider.cancelNow(sub.providerSubscriptionId!);
      sub = owned(account.id, subscriptionId);
      if (sub.status === "ended") return view(sub);
      const before = copy(state);
      try {
        delete sub.pendingChange; delete sub.scheduledChange;
        endSubscription(sub, state.checkouts.find(checkout => checkout.id === sub.checkoutId)?.email ?? account.email);
        sub.updatedAt = now(); sub.version++; store.commit();
      } catch (error) { Object.assign(state, before); throw error; }
      flushCloudActions(); return view(sub);
    });
  }
  function invoices(accountId: string, cursor?: string | null, limit = 20): InvoicePage {
    if (!Number.isInteger(limit) || limit < 1) fail(400, "invalid_request"); limit = Math.min(limit, 50);
    let after: { at: number; id: string } | null = null;
    if (cursor) {
      if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) fail(400, "invalid_request");
      try {
        const decoded: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (!decoded || typeof decoded !== "object" || !Number.isSafeInteger((decoded as { at: number }).at) || typeof (decoded as { id: string }).id !== "string") fail(400, "invalid_request");
        after = decoded as { at: number; id: string };
      } catch { fail(400, "invalid_request"); }
    }
    const rows = state.invoices.filter(invoice => invoice.accountId === accountId && (!after || invoice.createdAt < after.at || invoice.createdAt === after.at && invoice.id < after.id))
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const selected = rows.slice(0, limit), last = selected.at(-1);
    return { invoices: selected.map(invoice => ({ id: invoice.id, at: invoice.createdAt, amountCents: invoice.amountCents, currency: invoice.currency, status: invoice.status, description: invoice.description, downloadUrl: `/v1/billing/invoices/${invoice.id}/download` })),
      nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ at: last.createdAt, id: last.id })).toString("base64url") : null };
  }
  async function invoiceDownload(accountId: string, invoiceId: string) {
    const invoice = state.invoices.find(invoice => invoice.id === invoiceId && invoice.accountId === accountId); if (!invoice) fail(404, "not_found");
    const url = await provider.invoiceUrl(invoice.providerPaymentId); if (url) return { redirect: url };
    const pdf = await provider.invoicePdf(invoice.providerPaymentId); if (!pdf) fail(404, "not_found"); return { pdf };
  }
  function overview(account: AccountRef): BillingOverview {
    const license = licenseCheck(account);
    return { v: 1, subscriptions: state.subscriptions.filter(sub => sub.accountId === account.id).map(view), licenses: licenses(account.id), license,
      clouds: clouds.list(account.id).filter(paidCloud).map(cloud => clouds.view(cloud)), invoices: invoices(account.id), retention: retentionView(account.id) };
  }
  function appState(account: AccountRef) {
    const primary = state.subscriptions.find(sub => sub.accountId === account.id && sub.cart.desktop.kind !== "none" && ["active", "payment_problem", "cancelled"].includes(sub.status)) ?? null;
    const active = primary !== null && primary.currentPeriodEnd !== null && primary.currentPeriodEnd > now();
    return { primary: primary ? view(primary) : null, entitlement: { plan: active ? "pro" as const : "free" as const, tier: primary ? quote(primary.cart, config).bundle ?? "custom" : "free",
      status: active ? "active" as const : "inactive" as const, expiresAt: active ? primary!.currentPeriodEnd : null, version: primary?.version ?? 0 } };
  }
  /** checkouts opened in [from, to) by where they started: paid once a subscription or a top-up landed */
  function funnel(from: number, to: number): FunnelView {
    const rows = new Map<FunnelRow["source"], FunnelRow>();
    for (const row of state.checkouts) {
      if (row.createdAt < from || row.createdAt >= to) continue;
      const source = (row.source as FunnelRow["source"] | null) ?? "unknown";
      const entry = rows.get(source) ?? { source, started: 0, paid: 0, active: 0 };
      entry.started++;
      const sub = row.subscriptionId ? state.subscriptions.find(item => item.id === row.subscriptionId) : undefined;
      if (row.status === "completed" || sub && sub.status !== "pending") entry.paid++;
      if (sub && (sub.status === "active" || sub.status === "payment_problem")) entry.active++;
      rows.set(source, entry);
    }
    const list = [...rows.values()].sort((a, b) => b.started - a.started || a.source.localeCompare(b.source));
    const totals = list.reduce((sum, row) => ({ started: sum.started + row.started, paid: sum.paid + row.paid, active: sum.active + row.active }), { started: 0, paid: 0, active: 0 });
    return { v: 1, from, to, rows: list, totals };
  }
  let syncing: Promise<{ scanned: number; added: number }> | null = null;
  /** reads the provider's past payments, refunds, disputes and subscriptions onto the ledger; what is already there stays as it is */
  function syncFromProvider(): Promise<{ scanned: number; added: number }> {
    if (!provider.list) return Promise.reject(new BillingError(409, "unavailable"));
    syncing ??= (async () => {
      let scanned = 0, added = 0;
      const text = (value: unknown) => typeof value === "string" && value ? value.slice(0, 120) : null;
      const time = (value: unknown) => { const at = typeof value === "string" ? Date.parse(value) : NaN; return Number.isFinite(at) ? at : null; };
      const cents = (value: unknown) => Number.isSafeInteger(value) ? value as number : typeof value === "string" && /^\d{1,12}$/.test(value) ? Number(value) : null;
      const accountOf = (item: Record<string, unknown>) => {
        const customerId = text((item.customer as Record<string, unknown> | undefined)?.customer_id);
        const metadata = item.metadata && typeof item.metadata === "object" ? item.metadata as Record<string, unknown> : {};
        const known = (id: string | null) => id && state.customers.some(row => row.accountId === id) ? id : null;
        return state.customers.find(row => customerId && row.providerCustomerId === customerId)?.accountId ?? known(text(metadata.accountId));
      };
      const add = (input: LedgerDraft) => { if (record(input)) added++; };
      async function each(resource: "payments" | "subscriptions" | "refunds" | "disputes", fn: (item: Record<string, unknown>) => void) {
        for (let page = 0; page < 50; page++) {
          const items = await provider.list!(resource, page);
          for (const item of items) { scanned++; fn(item); }
          if (items.length < SYNC_PAGE) return;
        }
      }
      await each("payments", item => {
        const paymentId = text(item.payment_id), status = item.status === "succeeded" || item.status === "failed" ? item.status : null, at = time(item.created_at);
        if (!paymentId || !status || at === null) return;
        const invoice = state.invoices.find(row => row.providerPaymentId === paymentId);
        const sub = state.subscriptions.find(row => (invoice && row.id === invoice.subscriptionId) || (text(item.subscription_id) && row.providerSubscriptionId === text(item.subscription_id)));
        const settlement = cents(item.settlement_amount), tax = cents(item.settlement_tax) ?? cents(item.tax);
        add(draft({ key: `payment.${status}:${paymentId}`, at, type: `payment.${status}`, via: "sync", ...(sub ? subFields(sub) : { accountId: invoice?.accountId ?? accountOf(item) }),
          providerPaymentId: paymentId, providerSubscriptionId: text(item.subscription_id), providerCustomerId: text((item.customer as Record<string, unknown> | undefined)?.customer_id),
          amountCents: cents(item.total_amount), currency: text(item.currency), netCents: settlement === null ? null : Math.max(0, settlement - (cents(item.settlement_tax) ?? 0)), taxCents: tax,
          country: text((item.billing as Record<string, unknown> | undefined)?.country)?.toUpperCase().slice(0, 2) ?? null, reason: text(item.error_code), status }));
      });
      await each("refunds", item => {
        const refundId = text(item.refund_id), paymentId = text(item.payment_id), at = time(item.created_at);
        if (!refundId || !paymentId || at === null || item.status !== "succeeded") return;
        const invoice = state.invoices.find(row => row.providerPaymentId === paymentId), sub = state.subscriptions.find(row => invoice && row.id === invoice.subscriptionId);
        const paid = state.ledger!.find(row => row.providerPaymentId === paymentId && row.type === "payment.succeeded");
        add(draft({ key: `refund.succeeded:${refundId}`, at, type: "refund.succeeded", via: "sync", ...(sub ? subFields(sub) : { accountId: invoice?.accountId ?? paid?.accountId ?? null }),
          providerPaymentId: paymentId, providerRef: refundId, amountCents: cents(item.amount), currency: text(item.currency), reason: text(item.reason) }));
      });
      await each("disputes", item => {
        const disputeId = text(item.dispute_id), paymentId = text(item.payment_id), at = time(item.created_at);
        if (!disputeId || !paymentId || at === null) return;
        const invoice = state.invoices.find(row => row.providerPaymentId === paymentId);
        const paid = state.ledger!.find(row => row.providerPaymentId === paymentId && row.type === "payment.succeeded");
        const fields = { via: "sync" as const, at, accountId: invoice?.accountId ?? paid?.accountId ?? null, providerPaymentId: paymentId, providerRef: disputeId, amountCents: cents(item.amount), currency: text(item.currency), status: text(item.dispute_stage) };
        add(draft({ ...fields, key: `dispute.opened:${disputeId}`, type: "dispute.opened" }));
        const now = text(item.dispute_status)?.replace(/^dispute_/, "");
        if (now && now !== "opened" && ["challenged", "accepted", "cancelled", "expired", "won", "lost"].includes(now)) add(draft({ ...fields, key: `dispute.${now}:${disputeId}`, type: `dispute.${now}` }));
      });
      await each("subscriptions", item => {
        const providerId = text(item.subscription_id), at = time(item.created_at);
        if (!providerId || at === null || item.status === "pending") return;
        const sub = state.subscriptions.find(row => row.providerSubscriptionId === providerId);
        const fields = { via: "sync" as const, ...(sub ? subFields(sub) : { accountId: accountOf(item), providerSubscriptionId: providerId, mrrCents: cents(item.recurring_pre_tax_amount) }),
          providerCustomerId: text((item.customer as Record<string, unknown> | undefined)?.customer_id), country: text((item.billing as Record<string, unknown> | undefined)?.country)?.toUpperCase().slice(0, 2) ?? null };
        add(draft({ ...fields, key: `subscription.active:${providerId}`, type: "subscription.active", at, status: "active" }));
        const ended = time(item.cancelled_at);
        if ((item.status === "cancelled" || item.status === "expired") && ended !== null) add(draft({ ...fields, key: `subscription.${item.status}:${providerId}`, type: `subscription.${item.status}`, at: ended, status: "ended" }));
      });
      state.lastSync = { at: now(), added, scanned };
      store.commit(); sendNotices();
      return { scanned, added };
    })().finally(() => { syncing = null; });
    return syncing;
  }
  /** App Review's demo plan, made here and never through the payment provider (no provider subscription, nothing to bill or
   *  cancel there), whatever billing runs on: an open-ended plan of `bundle` with its cloud, both marked review. Idempotent. */
  function grantReview(account: AccountRef, input: { bundle: string; name: string }) {
    const live = state.subscriptions.find(sub => sub.accountId === account.id && sub.review && sub.status === "active");
    if (live) return { subscriptionId: live.id, cloudId: live.cloudId, created: false };
    const bundle = config.bundles.find(item => item.id === input.bundle && item.id !== "free");
    if (!bundle || bundle.cart.desktop.kind === "none") fail(400, "invalid_request");
    const cart = quote({ ...copy(bundle.cart), interval: "month" }, config).cart;
    cart.desktop.region ??= config.defaultRegion;
    cap(account.id);
    const priced = quote(cart, config), plan = desktopPlan(cart);
    const cloud = clouds.order({ ...plan, ...teamOf(cart, account.id, account.email), accountId: account.id, name: input.name, color: null, region: cart.desktop.region! });
    clouds.setReview(cloud.id, true);
    const checkout: StoredCheckout = { id: id("chk"), accountId: account.id, email: emailOf(account.email), kind: "cart", cart: copy(cart), cloudId: cloud.id, providerSessionId: null, url: null,
      status: "completed", source: "ops_grant", createdAt: now(), openUntil: now(), subscriptionId: null, amountCents: 0, lines: priced.lines };
    const sub: StoredSubscription = { id: id("sub"), accountId: account.id, providerSubscriptionId: null, checkoutId: checkout.id, cart: copy(cart), totalCents: 0, lines: priced.lines,
      status: "active", source: "ops_grant", review: true, licenseId: null, cloudId: cloud.id, currentPeriodStart: now(), currentPeriodEnd: OPEN_ENDED_AT, cancelAtPeriodEnd: false,
      createdAt: now(), updatedAt: now(), version: 0, mode };
    checkout.subscriptionId = sub.id;
    state.checkouts.push(checkout); state.subscriptions.push(sub);
    refreshLicense(sub, account.email);
    cloudAction({ kind: "activate", cloudId: cloud.id, subscriptionId: sub.id, plan });
    store.commit(); flushCloudActions();
    return { subscriptionId: sub.id, cloudId: cloud.id, created: true };
  }
  /** App Review's demo account: its plans and clouds are marked (or cleared) so no billing, retention or revenue path counts them */
  function markReview(accountId: string, review: boolean) {
    for (const sub of state.subscriptions) if (sub.accountId === accountId && !!sub.review !== review) {
      if (review) sub.review = true; else delete sub.review;
      sub.updatedAt = now(); sub.version++;
    }
    store.commit();
    for (const cloud of clouds.list(accountId, true)) if (cloud.status !== "destroyed" && cloud.status !== "checkout") clouds.setReview(cloud.id, review);
    return {
      subscriptions: state.subscriptions.filter(sub => sub.accountId === accountId).map(sub => ({ id: sub.id, status: sub.status, cloudId: sub.cloudId, review: sub.review === true })),
      clouds: clouds.list(accountId, true).filter(cloud => cloud.status !== "destroyed").map(cloud => ({ id: cloud.id, name: cloud.name, status: cloud.status, origin: cloud.origin, review: cloud.review === true })),
    };
  }
  /** keeps a customer's first touch once; later calls never move it */
  function setAttribution(accountId: string, attribution: Attribution) {
    const row = state.customers.find(item => item.accountId === accountId);
    if (!row || row.attribution) return false;
    row.attribution = attribution; store.changed(); return true;
  }
  return {
    syncFromProvider: guarded(syncFromProvider), recoverUnapplied: guarded(recoverUnapplied), setAttribution: guarded(setAttribution),
    funnel: guarded(funnel), markReview: guarded(markReview), grantReview: guarded(grantReview),
    deletionBlockers: guarded(deletionBlockers), closeAccount: guarded(closeAccount), accountDeleted: guarded(accountDeleted), scrubDeleted: guarded(scrubDeleted), destroyDeleted: guarded(destroyDeleted), drainProviderCancels: guarded(drainProviderCancels),
    expireLapsed: guarded(expireLapsed),
    catalog: guarded((account?: AccountRef | null) => { const trial = trialDays(account ?? null); return { ...catalogView(now(), config), ...(trial ? { trialDays: trial } : {}) }; }),
    trialDays: guarded((account: AccountRef | null) => trialDays(account)), quote: guarded((input: unknown) => quote(parsed(input), config)), checkout: guarded(checkout), handleWebhook: guarded(handleWebhook),
    subscriptions: guarded((accountId: string) => state.subscriptions.filter(sub => sub.accountId === accountId).map(view)), licenses: guarded(licenses), licenseCheck: guarded(licenseCheck), addMember: guarded(addMember), removeMember: guarded(removeMember),
    cancel: guarded((account: AccountRef, subscriptionId: string, survey?: CancelSurvey) => setCancel(account, subscriptionId, true, survey)), keep: guarded((account: AccountRef, subscriptionId: string) => setCancel(account, subscriptionId, false)),
    feedback: guarded(feedback), retentionStep: guarded(retentionStep), retentionDiscount: guarded(retentionDiscount), previewChange: guarded(previewChange), change: guarded(change),
    operatorChange: guarded(operatorChange), setPeriodEnd: guarded(setPeriodEnd), moveRenewal: guarded(moveRenewal), endNow: guarded(endNow), mode,
    updateCard: guarded(async (account: AccountRef, subscriptionId: string, path?: string) => { const url = returnUrl(path), sub = editable(account.id, subscriptionId); return provider.updatePaymentMethod(sub.providerSubscriptionId!, url); }),
    invoices: guarded(invoices), invoiceDownload: guarded(invoiceDownload), overview: guarded(overview), appState: guarded(appState), close: guarded(() => { clearInterval(retryCloudActions); clearInterval(sweepDeleted); clearInterval(sweepLapsed); confirmations.clear(); store.close(); }),
  };
}
