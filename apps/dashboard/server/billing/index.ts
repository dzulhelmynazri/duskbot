import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DashboardState } from "../store.ts";
import { createCloudsService } from "../clouds/service.ts";
import { linkGrantSignerFromEnv, signLinkGrant } from "../link-grant.ts";
import type { CloudEventKind } from "../clouds/service.ts";
import { createFakeCloudProvider } from "../clouds/fake-provider.ts";
import { createFakePoolDriver } from "../clouds/fake-pool-driver.ts";
import { createPoolProvider } from "../clouds/pool.ts";
import { createHetznerProvider } from "../clouds/hetzner.ts";
import { createHomeClient } from "../clouds/home-client.ts";
import { createSealer, parseSealKey } from "../clouds/seal.ts";
import { createAiStash, memoryAiStashStore, type AiStashStore } from "../clouds/ai-stash.ts";
import type { CloudProvider, HomeClient } from "../clouds/types.ts";
import type { StoredCloud } from "../clouds/types.ts";
import { managedCloudFromEnv } from "../../../cloud-service/src/index.ts";
import type { CloudLetter } from "../../../cloud-service/src/index.ts";
import { entitlementSignerFromEnv } from "../entitlements.ts";
import type { Catalog } from "../../../../shared/billing-api.ts";
import { createBillingStore } from "./store.ts";
import { BillingError, createBillingService } from "./service.ts";
import type { BillingNotice, BillingServiceOptions, OperatorGrant } from "./service.ts";
import { BILLING_CONFIG, dodoProducts, managedRegionConfig, missingDodoProducts, trialConfig } from "./plans.ts";
import { createFakeBillingProvider } from "./fake-provider.ts";
import { stateBackend } from "../persistence/backend.ts";
import { createDodoProvider } from "./dodo-provider.ts";
import { BillingProviderError } from "./types.ts";
import type { AccountRef, AccountResolver, BillingProvider } from "./types.ts";
import { createBillingRoutes } from "./routes.ts";
import { createAdminRoutes } from "./admin-routes.ts";
import { createTeams } from "./team.ts";
import type { TeamMail } from "./team.ts";
import type { LedgerEntry } from "./ledger.ts";

export interface BillingOptions {
  dataDir: string; publicUrl: string; dashboard: { state: DashboardState; changed(): void; close?(): void }; accounts: AccountResolver;
  accountExists?: (accountId: string) => boolean;
  /** the account an operator's grant names, by email */
  findAccount?: (email: string) => AccountRef | null;
  env?: NodeJS.ProcessEnv; now?: () => number; fetch?: typeof fetch;
  /** measured wake times the catalog may show (the slack edge times wakes) */
  wakeStats?: () => NonNullable<Catalog["wake"]>;
  /** a managed cloud's letter to its owner (retention, recovery, deletion requests); delivery failures are logged, never thrown */
  mail?: (cloud: StoredCloud, letter: CloudLetter) => void;
  /** billing events worth an email: receipts, failed payments, cancellations */
  notify?: (notice: BillingNotice) => void;
  /** each new billing ledger row, once stored */
  onLedger?: (entry: LedgerEntry) => void;
  onRetention?: BillingServiceOptions["onRetention"];
  /** a cloud's first time up, and a cloud the generic lifecycle took down */
  cloudEvent?: (kind: CloudEventKind, cloud: StoredCloud) => void;
  /** every cloud status change */
  cloudStatus?: (cloud: StoredCloud, from: StoredCloud["status"] | null) => void;
  /** where AI sign-ins for a Cloud still being made are held (clouds/ai-stash.ts); in memory when absent */
  aiStash?: AiStashStore;
  teamMail?: (message: TeamMail) => void;
  accountName?: (accountId: string) => string | null;
  accountEmail?: (accountId: string) => string | null;
  /** every deletion action of a managed cloud and fleet alerts, for the record; never an email */
  alert?: (entry: { at: number; cloudId: string; action: string; actor: string; reason: string }) => void;
}
export const ACCOUNT_CLOSE_UNAVAILABLE = "Your plan couldn't be cancelled with the payment provider just now, so nothing was deleted and your madani cloud is still there; try again in a few minutes.";
/** the hosted app's Bearer resolver remains null until shared/account-api.ts supplies the accounts service */
export function createBilling(options: BillingOptions) {
  const env = options.env ?? process.env, now = options.now ?? Date.now, url = new URL(options.publicUrl);
  const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  function required(key: string) { const value = env[key]; if (!value) throw new Error(`${key} is required.`); return value; }
  function choice(key: string, allowed: string[]) {
    const value = env[key]; if (value !== undefined && !allowed.includes(value)) throw new Error(`Invalid ${key}.`);
    return value ?? (loopback ? "fake" : "off");
  }
  // preview: no payment provider yet. Checkout answers "checkout_soon"; the operator grants plans (POST /v1/billing/ops/grant),
  // which run through the same checkout, webhook and provisioning code with an in-process fake provider that charges nothing
  const billingProvider = choice("MADANI_BILLING_PROVIDER", ["fake", "dodo", "preview"]);
  const cloudProvider = choice("MADANI_CLOUD_PROVIDER", ["fake", "hetzner"]), poolDriver = choice("MADANI_POOL_DRIVER", ["fake"]);
  // the fake provider mints paid checkouts that charge nothing: on a real database they would read as revenue, so it only
  // runs on the local JSON stores (the operator-grant preview mode is free comps and may)
  if (billingProvider === "fake" && stateBackend()) throw new Error("MADANI_BILLING_PROVIDER=fake makes up payments and refuses a MongoDB store; use dodo (test mode) or preview.");
  const fake = billingProvider === "fake" || billingProvider === "preview" ? createFakeBillingProvider({ now }) : null;
  const unavailable = () => { throw new BillingProviderError("unavailable"); };
  let provider: BillingProvider;
  const dodoMode = env.MADANI_DODO_MODE ?? "test";
  if (billingProvider === "dodo") {
    const apiKey = required("MADANI_DODO_API_KEY"), webhookSecret = required("MADANI_DODO_WEBHOOK_SECRET");
    const mode = dodoMode;
    if (mode !== "test" && mode !== "live") throw new Error("Invalid MADANI_DODO_MODE.");
    required("MADANI_DODO_PRODUCTS");
    provider = createDodoProvider({ apiKey, webhookSecret, mode, now, fetch: options.fetch });
  } else provider = fake ?? { name: "dodo", createCheckout: unavailable, updatePaymentMethod: unavailable, verifyWebhook: unavailable, cancelAtPeriodEnd: unavailable, cancelNow: unavailable, refundPayment: unavailable, previewChange: unavailable, changePlan: unavailable, cancelScheduledChange: unavailable, subscription: unavailable, applyDiscount: unavailable, invoiceUrl: unavailable, invoicePdf: unavailable };
  let products: Record<string, string>;
  try { products = dodoProducts(env); } catch { throw new Error("Invalid MADANI_DODO_PRODUCTS."); }
  if (billingProvider === "dodo" && missingDodoProducts(products).length) console.error(`billing: MADANI_DODO_PRODUCTS is missing ${missingDodoProducts(products).join(", ")}; carts that need them answer 503`);
  let config = { ...BILLING_CONFIG, products, trial: trialConfig(env.MADANI_TRIAL_DAYS) };
  const sealKey = env.MADANI_CLOUD_SEAL_KEY ? parseSealKey(env.MADANI_CLOUD_SEAL_KEY) : null;
  const image = cloudProvider === "hetzner" ? required("MADANI_CLOUD_HOME_IMAGE") : env.MADANI_CLOUD_HOME_IMAGE ?? "ghcr.io/madanibot/madanibot-cloud-home:latest";
  const disabled: CloudProvider = { name: "fake", find: unavailable, create: unavailable, status: unavailable, power: unavailable, resize: unavailable, destroy: unavailable };
  let dedicated: CloudProvider = disabled;
  if (cloudProvider === "fake") dedicated = createFakeCloudProvider();
  if (cloudProvider === "hetzner") {
    const token = required("MADANI_HETZNER_TOKEN"); required("MADANI_CLOUD_SEAL_KEY");
    dedicated = createHetznerProvider({ token, fetch: options.fetch });
  }
  /** a real pool host driver does not exist yet; only the isolated fake driver is available */
  const fakePool = poolDriver === "fake" ? createFakePoolDriver({ hosts: [1, 2].map(n => ({ id: `fake-${n}`, region: "fsn1", domain: "pool.madanibot.test", draining: false, capacity: { vcpu: 64, ramGb: 128, diskGb: 4000, slots: 100 } })) }) : null;
  const pool = fakePool ? createPoolProvider({ driver: fakePool, now }) : { ...disabled, suspend: unavailable, resume: unavailable };
  // a managed backend (MADANI_MANAGED=1, apps/cloud-service): its provider key stays in this process; homes never receive it
  let billingStore: ReturnType<typeof createBillingStore> | null = null;
  const managed = managedCloudFromEnv(env, { dataDir: options.dataDir, publicUrl: url.origin, loopback, sealKey, now, fetch: options.fetch,
    subscriptions: () => billingStore?.state.subscriptions ?? [], mail: options.mail, alert: options.alert });
  // the region list is only what can really run: the managed backend's one region unless a regional provider is attached
  const allManaged = !!managed && (["shared_s", "shared_m", "dedicated"] as const).every(kind => managed.kinds.includes(kind));
  if (allManaged || (cloudProvider === "off" && poolDriver === "off")) config = managedRegionConfig(config);
  const realHome = createHomeClient({ fetch: options.fetch, now });
  const fakeHome: HomeClient = { healthy: async () => true, pair: async () => {
    const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ", bytes = randomBytes(12);
    const code = [...bytes].map(b => alphabet[b % alphabet.length]).join("").match(/.{4}/g)!.join("-");
    return { code, expiresAt: now() + 300_000 };
  } };
  // a loopback service fakes the homes of its fake providers; a managed backend's homes are always real (managedHome)
  const fakeOrigin = (origin: string) => loopback && (origin.endsWith(".pool.madanibot.test") ? poolDriver === "fake" : cloudProvider === "fake");
  const home: HomeClient = {
    power: (origin, secret, minutes) => realHome.power!(origin, secret, minutes),
    sleep: (origin, secret, minutes) => realHome.sleep!(origin, secret, minutes),
    plan: (origin, secret, input) => realHome.plan!(origin, secret, input),
    entitle: (origin, secret, token, linkGrant) => fakeOrigin(origin) ? Promise.resolve({ expiresAt: now() + 3_600_000 }) : realHome.entitle!(origin, secret, token, linkGrant),
    healthy: (origin, secret) => (fakeOrigin(origin) ? fakeHome : realHome).healthy(origin, secret),
    pair: (origin, secret, input) => (fakeOrigin(origin) ? fakeHome : realHome).pair(origin, secret, input),
    signIns: (origin, secret, items) => (fakeOrigin(origin) ? Promise.resolve() : realHome.signIns!(origin, secret, items)),
    memberLeft: (origin, secret, email) => (fakeOrigin(origin) ? Promise.resolve() : realHome.memberLeft!(origin, secret, email)),
  };
  // every hosted home refuses clients without a signed entitlement, so a service that runs homes must be able to sign one
  const entitlements = entitlementSignerFromEnv(env, { dataDir: options.dataDir, loopback, now, required: !loopback && (cloudProvider !== "off" || poolDriver !== "off" || managed !== null) });
  const sealer = createSealer(sealKey);
  const aiStash = createAiStash({ store: options.aiStash ?? memoryAiStashStore(now), sealer, now });
  const linkGrants = linkGrantSignerFromEnv(env, { dataDir: options.dataDir, loopback });
  const clouds = createCloudsService({ aiStash, entitlements, linkGrant: linkGrants ? cloud => signLinkGrant(cloud.accountId, linkGrants, now()).grant : null, onEvent: options.cloudEvent, onStatus: options.cloudStatus, dataDir: options.dataDir, now, providers: { pool, dedicated }, home, sealer, managed, managedHome: realHome,
    workspaces: {
      register({ accountId, name, publicKey }) {
        const id = `ws_${randomBytes(16).toString("base64url")}`;
        options.dashboard.state.workspaces.push({ id, publicKey, ownerAccountId: accountId, claimHash: null, claimExpiresAt: 0, name, kind: "vps", version: "", connectedAt: now(), lastReportAt: null, lastSeq: 0, lastSeqAt: 0, report: null, sectionAt: {} });
        options.dashboard.changed(); options.dashboard.close?.(); return id;
      },
      lastReportAt: id => options.dashboard.state.workspaces.find(ws => ws.id === id)?.lastReportAt ?? null,
      remove(id) { options.dashboard.state.workspaces = options.dashboard.state.workspaces.filter(ws => ws.id !== id); options.dashboard.changed(); options.dashboard.close?.(); },
    },
    config: { adminOrigin: url.origin, dashboardUrl: url.origin, image, originTemplate: env.MADANI_CLOUD_ORIGIN_TEMPLATE,
      configured: { pool: poolDriver !== "off", dedicated: cloudProvider !== "off" },
      poolQuota(kind, spec, botComputers) { return { ...spec, ...(config.poolQuotas[kind as "shared_s" | "shared_m"] ?? config.poolQuotas.shared_m), botComputers }; } },
  });
  const store = createBillingStore(options.dataDir);
  billingStore = store;
  const mode = billingProvider === "dodo" && dodoMode === "live" ? "live" as const : "test" as const;
  const service = createBillingService({ store, provider, clouds, config, publicUrl: url.origin, now, notify: options.notify, onLedger: options.onLedger, onRetention: options.onRetention, mode });
  if (options.accountExists) service.scrubDeleted(options.accountExists);
  // a deleted account's clouds left over from before (or by a failed step) are destroyed at start, then every 10 minutes
  service.destroyDeleted();
  const teams = createTeams({ store, clouds, config, now, mail: options.teamMail, accountName: options.accountName, accountEmail: options.accountEmail });
  const opsToken = env.MADANI_OPS_TOKEN || null;
  if (opsToken !== null && opsToken.length < 32) throw new Error("MADANI_OPS_TOKEN must be at least 32 characters.");
  if (billingProvider === "preview" && !opsToken) throw new Error("MADANI_BILLING_PROVIDER=preview needs MADANI_OPS_TOKEN for plan grants.");
  // a grant is completed by the in-process fake provider, so only where that provider is the one billing runs on
  const completer = billingProvider === "preview" || loopback ? fake : null;
  function setEnd(owner: AccountRef, subscriptionId: string, until: number) {
    const view = service.setPeriodEnd(owner, subscriptionId, until);
    const providerId = store.state.subscriptions.find(sub => sub.id === subscriptionId)?.providerSubscriptionId;
    const held = providerId ? completer?.subscriptions.get(providerId) : undefined;
    if (held) held.nextBillingAt = until;
    return view;
  }
  async function grant(owner: AccountRef, input: { bundle: string; interval: "month" | "year"; name?: string; source: OperatorGrant["source"]; amountCents?: number; until?: number }) {
    if (!completer) throw new BillingError(503, "unavailable");
    const bundle = config.bundles.find(item => item.id === input.bundle && item.id !== "free");
    if (!bundle) throw new BillingError(400, "invalid_request");
    const checkout = await service.checkout(owner, { kind: "cart", cart: service.quote({ ...bundle.cart, interval: input.interval }).cart, ...(input.name === undefined ? {} : { name: input.name }) },
      { operator: { source: input.source, ...(input.amountCents === undefined ? {} : { amountCents: input.amountCents }) } });
    const stored = store.state.checkouts.find(item => item.id === checkout.checkoutId);
    if (!stored?.providerSessionId) throw new BillingError(500, "failed");
    for (const delivery of completer.complete(stored.providerSessionId)) service.handleWebhook(delivery.headers, delivery.body);
    const sub = store.state.subscriptions.find(item => item.checkoutId === stored.id) ?? null;
    if (sub && input.until !== undefined) setEnd(owner, sub.id, input.until);
    void clouds.reconcile().catch(() => {});
    return { checkoutId: stored.id, subscriptionId: sub?.id ?? null };
  }
  const reviewEmail = env.MADANI_REVIEW_EMAIL?.trim().toLowerCase() || null;
  // nothing is sold while billing is off or the site is the pre-launch waitlist; an operator's grant still works
  const checkoutOpen = billingProvider !== "preview" && billingProvider !== "off" && env.MADANI_PRELAUNCH_WAITLIST_ONLY !== "1";
  const context = { service, teams, clouds, store, config, accounts: options.accounts, now, enabled: billingProvider !== "off", fake: loopback ? fake : null, wakeStats: options.wakeStats ?? (() => ({})), opsToken,
    appRoutes: billingProvider !== "off" || reviewEmail !== null,
    checkoutOpen, endTrials: billingProvider === "preview" || env.MADANI_OPS_END_TRIAL === "1", grants: billingProvider === "preview" ? fake : null, grant,
    testPurchases: billingProvider === "dodo" && dodoMode === "test", findAccount: options.findAccount ?? (() => null), reviewEmail };
  const routes = createBillingRoutes(context), admin = createAdminRoutes(context);
  return {
    async handle(req: IncomingMessage, res: ServerResponse, target: URL) { return await routes(req, res, target) || await admin.handle(req, res, target); },
    /** the operator may end a home package's trial early (preview, or MADANI_OPS_END_TRIAL=1) */
    endTrials: context.endTrials,
    async beforeAccountDelete(owner: AccountRef, body: Record<string, unknown>) {
      const blockers = service.deletionBlockers(owner.id);
      if (body.cancelBilling !== true && blockers.length) { const error = new BillingError(409, "billing_active"); error.blockers = blockers; throw error; }
      try { await service.closeAccount(owner, { destroyDesktopsNow: body.destroyDesktopsNow === true }); }
      catch (error) {
        if (error instanceof BillingError && error.code === "unavailable") error.message = ACCOUNT_CLOSE_UNAVAILABLE;
        throw error;
      }
    },
    accountDeleted: service.accountDeleted,
    /** the account's plans, payments and cloud desktops for its owner's export: no provider ids, keys or sealed secrets */
    exportAccount(accountId: string) {
      const billingState = store.state;
      return {
        subscriptions: billingState.subscriptions.filter(sub => sub.accountId === accountId).map(({ id, lines, totalCents, status, currentPeriodStart, currentPeriodEnd, cancelAtPeriodEnd, createdAt, updatedAt }) =>
          ({ id, lines, totalCents, status, currentPeriodStart, currentPeriodEnd, cancelAtPeriodEnd, createdAt, updatedAt })),
        payments: billingState.invoices.filter(invoice => invoice.accountId === accountId).map(({ id, amountCents, currency, status, description, createdAt }) => ({ id, amountCents, currency, status, description, createdAt })),
        cloudDesktops: clouds.list(accountId, true).map(({ id, name, kind, region, spec, status, createdAt, updatedAt, destroyAt }) => ({ id, name, kind, region, spec, status, createdAt, updatedAt, destroyAt })),
      };
    },
    /** the owner's plan edits: grants only where the fake provider completes them */
    operator: { provider: billingProvider as "preview" | "fake" | "dodo" | "off", grants: completer !== null, grant, setEnd, mode },
    enabled: context.enabled, appRoutes: context.appRoutes, sessionFields: admin.sessionFields, licenseCheck: service.licenseCheck, service, clouds, store, fake, fakePool,
    teams,
    close() { teams.close(); clouds.close(); service.close(); },
  };
}
export type BillingContext = {
  service: ReturnType<typeof createBillingService>; teams: ReturnType<typeof createTeams>; clouds: ReturnType<typeof createCloudsService>; store: ReturnType<typeof createBillingStore>;
  config: typeof BILLING_CONFIG; accounts: AccountResolver; now(): number; enabled: boolean; fake: ReturnType<typeof createFakeBillingProvider> | null;
  wakeStats(): NonNullable<Catalog["wake"]>;
  /** MADANI_OPS_TOKEN: unset hides the operator's funnel read */
  opsToken: string | null;
  /** false in preview, with billing off and before launch (MADANI_PRELAUNCH_WAITLIST_ONLY=1): nothing can be bought */
  checkoutOpen: boolean;
  /** the apps' cloud routes (/api/cloud/desktop/*): with billing, or with billing off for App Review's granted cloud */
  appRoutes?: boolean;
  /** the operator may end a home package's trial early: preview, or MADANI_OPS_END_TRIAL=1 */
  endTrials?: boolean;
  /** preview only: the provider that completes an operator's grant */
  grants: ReturnType<typeof createFakeBillingProvider> | null;
  /** dodo in test mode: an operator's grant opens a real test-mode checkout for a harness to pay with a test card */
  testPurchases?: boolean;
  /** a plan given through the same checkout, webhook and provisioning code, completed by the fake provider */
  grant(owner: AccountRef, input: { bundle: string; interval: "month" | "year"; name?: string; source: OperatorGrant["source"]; amountCents?: number; until?: number }): Promise<{ checkoutId: string; subscriptionId: string | null }>;
  findAccount(email: string): AccountRef | null;
  /** MADANI_REVIEW_EMAIL: the one account POST /v1/billing/ops/review may mark */
  reviewEmail?: string | null;
};
