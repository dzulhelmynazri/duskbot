// The managed cloud backend the account service plugs in (apps/dashboard/server/clouds/managed.ts): one machine per cloud at
// the provider, its lifecycle, backups, retention, the stray-machine sweep, the machine claim and the edge's route lookup.
// The provider's API key, backup storage and backup secret exist only in this process.
import "../../../electron/legacy-names.mjs";
import { createHash, hkdfSync, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { DESKTOP_KINDS, type CloudDesktopView } from "../../../shared/billing-api.ts";
import type { StoredSubscription } from "../../dashboard/server/billing/store.ts";
import { type ManagedCloud, type ManagedCloudContext, type ManagedCloudFactory, type ManagedCloudRoutesContext } from "../../dashboard/server/clouds/managed.ts";
import { parseSealKey } from "../../dashboard/server/clouds/seal.ts";
import type { DesktopPlan, StoredCloud } from "../../dashboard/server/clouds/types.ts";
import { createAudit, type Audit, type AuditEntry } from "./audit.ts";
import { createBackupStore, homeBackupKey, type BackupStore } from "./backups.ts";
import { HOME_IMAGE } from "./home.ts";
import type { MachineProvider } from "./provider.ts";
import { createInstaboxProvider, instaboxCostProfile, INSTABOX_RAILS, INSTABOX_STARTS_PER_MINUTE, type InstaboxPlan } from "./instabox.ts";
import { guardBackupSecret } from "./key-guard.ts";
import { createLifecycle, freshManagedState, managedSettingsFromEnv, type Lifecycle, type ManagedSettings } from "./lifecycle.ts";
import { entitlementOf, noticeText, type Entitlement, type NoticeKind } from "./retention.ts";
import { parseReleaseKeys, PINNED_RELEASE_KEYS, verifyRelease, type ReleaseKey } from "./release-signing.ts";
import { createSweep } from "./sweep.ts";
import { createStartLedger } from "./starts.ts";
import { createSpendLedger, fileSpendStore } from "./spend.ts";
import { createPowerPolicy, DEFAULT_POLICY, type PolicyParams } from "./power/policy.ts";
import type { RailSettings } from "./power/rails.ts";
import type { ProviderCostProfile } from "./power/cost.ts";
import "./state.ts";
import { createHomeUpdates, createReleaseFile, type HomeRelease } from "./home-update.ts";
import { createPolicySource, UPDATE_POLICY_PATH, type PolicySource } from "./update-policy.ts";

/** a retention notice: the plain letter, and what it is about for a richer rendering */
export interface CloudLetter { subject: string; text: string; notice?: { kind: NoticeKind; at: number | null; link?: string } }
export interface ManagedCloudDeps {
  provider: MachineProvider;
  backups: BackupStore;
  audit: Audit;
  settings: ManagedSettings;
  kinds: ReadonlyArray<DesktopPlan["kind"]>;
  /** this service's backup secret; never on a machine */
  backupSecret: Buffer;
  /** the secret the backups were sealed with, to seal them again after a deliberate change */
  previousBackupSecret?: Buffer | null;
  /** the billing system of record, read fresh at every decision */
  entitlement(cloud: StoredCloud): Entitlement;
  notify(cloud: StoredCloud, kind: NoticeKind, at: number | null, link?: string): void;
  /** public keys a release must be signed with (the pinned ones unless a test says otherwise) */
  releaseKeys?: readonly ReleaseKey[];
  /** the bearer the edge proxy presents to look up a label's upstream (MADANI_MANAGED_EDGE_TOKEN) */
  edgeToken?: string | null;
  /** keys the opaque public labels; defaults to one derived from the backup secret */
  labelKey?: Buffer;
  /** the operator's alert, also used when the day's provider starts approach the included count */
  alert?(entry: AuditEntry): void;
  /** the provider's prices and start limits, for the ledger, the policy and the rails (the Pro plan's by default) */
  costProfile?: ProviderCostProfile;
  /** rails over the policy's (the provider's scale by default) */
  rails?: Partial<RailSettings>;
  /** the power policy's settings (the tuned defaults otherwise) */
  policy?: PolicyParams;
  /** a monotonic clock for the cost ledger, so a wall-clock jump is not taken as time passing (only with the real clock) */
  mono?: () => number;
  /** the signed update policy (MADANI_UPDATE_POLICY_FILE): the floor and the block list, served at /v1/updates/policy */
  updatePolicy?: PolicySource | null;
  /** the newest home release on offer (MADANI_MANAGED_HOME_RELEASE_FILE), ahead of settings.package */
  release?: () => HomeRelease | null;
}

export function createManagedCloud(deps: ManagedCloudDeps): ManagedCloudFactory {
  return {
    kinds: deps.kinds,
    create(ctx: ManagedCloudContext): ManagedCloud {
      const { backups, backupSecret } = deps, previous = deps.previousBackupSecret ?? null;
      const generations = () => ctx.clouds().flatMap(c => (c.managed?.backups ?? []).map(g => ({ c, g })));
      guardBackupSecret(ctx.dataDir, backupSecret, previous, old => {
        for (const { c, g } of generations()) {
          const tar = backups.read(c.id, homeBackupKey(old, c.id), g.file);
          const record = backups.write(c.id, homeBackupKey(backupSecret, c.id), tar);
          if (!backups.read(c.id, homeBackupKey(backupSecret, c.id), record.file).equals(tar)) throw new Error("A backup did not verify after sealing it with the new secret.");
          const file = g.file;
          Object.assign(g, { file: record.file, bytes: record.bytes, sha256: record.sha256 });
          ctx.commit();
          backups.remove(c.id, file);
        }
      }, secret => {
        const newest = generations().sort((a, b) => b.g.at - a.g.at)[0];
        if (!newest) return null;
        try { backups.read(newest.c.id, homeBackupKey(secret, newest.c.id), newest.g.file); return true; } catch { return false; }
      });
      const base = deps.policy ?? DEFAULT_POLICY;
      const releaseKeys = deps.releaseKeys ?? PINNED_RELEASE_KEYS;
      const labelKey = deps.labelKey ?? Buffer.from(hkdfSync("sha256", backupSecret, Buffer.alloc(0), Buffer.from("omb-managed-label"), 32));
      const settings = deps.settings, provider = deps.provider, profile = deps.costProfile ?? instaboxCostProfile();
      const params: PolicyParams = { ...base, schedule: { ...base.schedule, leadMs: settings.wakeLeadMs }, rails: { ...base.rails, ...(deps.rails ?? INSTABOX_RAILS), minIdleMs: settings.idleMinutes * 60_000 } };
      const starts = createStartLedger({ dataDir: ctx.dataDir, file: "provider-starts.json", profile, now: ctx.now,
        alert: text => { console.warn(`managed: ${text}`); deps.alert?.({ at: ctx.now(), cloudId: "fleet", action: "starts_alert", actor: "reconciler", reason: text.slice(0, 120) }); } });
      const sleepPolicy = createPowerPolicy({ profile, params, pool: () => starts.view() });
      // each home's monthly cost book: nothing is charged to a home past its ceiling (power/ceiling.ts, docs/power.md)
      const spend = createSpendLedger({ store: fileSpendStore(ctx.dataDir, "spend"), profile, reserveStarts: params.rails.costReserveStarts, now: ctx.now, mono: deps.mono,
        alert: (cloudId, text, key) => {
          console.warn(`managed: ALERT ${text}`);
          deps.audit.record({ cloudId, action: "cost_ceiling_alert", actor: "reconciler", reason: key });
          deps.alert?.({ at: ctx.now(), cloudId, action: "cost_ceiling", actor: "reconciler", reason: text.slice(0, 120) });
        } });
      const updates = createHomeUpdates({ provider, image: HOME_IMAGE, home: ctx.home, audit: deps.audit, releaseKeys, requireSigned: settings.requireSigned, now: ctx.now, save: ctx.save,
        releases: () => [deps.release?.() ?? null, settings.package], policy: () => deps.updatePolicy?.policy() ?? null });
      const lifecycle: Lifecycle = createLifecycle({ ...deps, provider, settings, updates, image: HOME_IMAGE, starts, spend, sleepPolicy, costProfile: profile, rails: params.rails, home: ctx.home, now: ctx.now, save: ctx.save, stored: ctx.stored, unseal: ctx.unseal, seal: ctx.seal,
        dashboardUrl: ctx.dashboardUrl, adminOrigin: ctx.adminOrigin, removeWorkspace: ctx.removeWorkspace, clouds: ctx.clouds, entitle: ctx.entitlement, ...(ctx.linkGrant ? { linkGrant: ctx.linkGrant } : {}), releaseKeys, labelKey });
      const sweep = createSweep({ dataDir: ctx.dataDir, file: "machine-sweep.json", provider, audit: deps.audit, retentionDays: settings.retentionDays, now: ctx.now });
      const claimLimits = new Map<string, { count: number; until: number }>();
      /** failed redemptions per address: 60 per 15 minutes; a machine's own successful boot never counts */
      function limited(key: string): boolean {
        const now = ctx.now();
        for (const [k, item] of claimLimits) if (item.until <= now) claimLimits.delete(k);
        return (claimLimits.get(key)?.count ?? 0) >= 60;
      }
      function failed(key: string) {
        const now = ctx.now(), item = claimLimits.get(key);
        if (!item || item.until <= now) claimLimits.set(key, { count: 1, until: now + 15 * 60_000 }); else item.count++;
        // a flood from many addresses must not grow this without bound: the oldest windows go first
        for (const k of claimLimits.keys()) { if (claimLimits.size <= CLAIM_LIMIT_ENTRIES) break; claimLimits.delete(k); }
      }
      const digest = (value: string) => createHash("sha256").update(value).digest();
      async function handle(req: IncomingMessage, res: ServerResponse, url: URL, routes: ManagedCloudRoutesContext): Promise<boolean> {
        if (url.pathname === "/v1/managed/claims/redeem") {
          if (req.method !== "POST") { routes.json(res, 405, { error: "method_not_allowed" }); return true; }
          // the claim is the credential (43 random characters); a guesser gets 60 wrong tries per address per 15 minutes
          const address = `claim:${routes.clientIp(req)}`;
          if (limited(address)) { res.setHeader("retry-after", "60"); routes.json(res, 429, { error: "rate_limited" }); return true; }
          const body = await routes.readJson(req).catch(() => ({} as Record<string, unknown>));
          const answer = lifecycle.redeemClaim(body.cloud, body.claim);
          if (!answer) { failed(address); routes.json(res, 403, { error: "invalid_claim" }); return true; }
          res.setHeader("cache-control", "no-store");
          routes.json(res, 200, answer);
          return true;
        }
        if (url.pathname === UPDATE_POLICY_PATH) {
          // public and signed: every install checks the signature against its own pinned keys
          const signed = deps.updatePolicy?.signed() ?? null;
          if (req.method !== "GET" || !signed) { routes.json(res, req.method === "GET" ? 404 : 405, { error: req.method === "GET" ? "not_found" : "method_not_allowed" }); return true; }
          res.setHeader("cache-control", "public, max-age=300");
          routes.json(res, 200, signed);
          return true;
        }
        if (url.pathname === "/v1/managed/edge/route") {
          const want = deps.edgeToken ? `Bearer ${deps.edgeToken}` : null;
          // only the edge proxy may ask; to anyone else the route does not exist
          if (req.method !== "GET" || !want || !digest(String(req.headers.authorization ?? "")).equals(digest(want))) { routes.json(res, 404, { error: "not_found" }); return true; }
          const label = url.searchParams.get("label") ?? "";
          const route = lifecycle.edgeRoute(label);
          if (!route) { routes.json(res, lifecycle.edgeGone(label) ? 410 : 404, { error: lifecycle.edgeGone(label) ? "gone" : "not_found" }); return true; }
          res.setHeader("cache-control", "no-store");
          routes.json(res, 200, route);
          return true;
        }
        if (url.pathname === "/v1/managed/edge/wake") {
          const want = deps.edgeToken ? `Bearer ${deps.edgeToken}` : null;
          if (req.method !== "POST" || !want || !digest(String(req.headers.authorization ?? "")).equals(digest(want))) { routes.json(res, 404, { error: "not_found" }); return true; }
          const reason = url.searchParams.get("reason") === "webhook" ? "webhook" : "client";
          const answer = lifecycle.edgeWake(url.searchParams.get("label") ?? "", reason);
          if (answer.status === 202) ctx.kick?.(lifecycle.cloudOfLabel(url.searchParams.get("label") ?? ""));
          res.setHeader("cache-control", "no-store");
          if (answer.status === 429) res.setHeader("retry-after", "300");
          routes.json(res, answer.status, { ok: answer.ok, retryAfterMs: answer.ok ? 1_000 : null });
          return true;
        }
        return false;
      }
      return {
        kinds: deps.kinds,
        fresh: () => freshManagedState(),
        reconcile: c => lifecycle.reconcile(c),
        retryAt: (c, error) => lifecycle.retryAt(c, error),
        view(c): Partial<CloudDesktopView> {
          const m = c.managed, retained = lifecycle.verdict(c), egress = lifecycle.egress(c);
          return { provider: "managed", lastBackupAt: m?.backups.at(-1)?.at ?? null,
            deleteScheduledAt: m?.deleteRequest?.confirmedAt && m.deleteRequest.cancelledAt === null ? m.deleteRequest.executeAfter : null,
            deleteAskedAt: m?.deleteRequest && !m.deleteRequest.confirmedAt && m.deleteRequest.cancelledAt === null && (m.deleteRequest.tokenExpiresAt ?? 0) > ctx.now() ? m.deleteRequest.requestedAt : null,
            waking: c.status === "sleeping" && (c.wantPower === "on" || m?.wakeStartedAt != null) && egress?.state !== "paused",
            stoppedBy: c.status === "sleeping" || c.status === "stopped" ? (m?.sleepReason === "owner" ? "user" : m?.sleepReason ?? null) : null,
            egress: egress && { bytes: egress.bytes, state: egress.state === "alerted" ? "ok" : egress.state, until: egress.until },
            ...(c.status !== "destroyed" ? { destroyAt: retained.earliestAt } : {}) };
        },
        afterPass: async clouds => { lifecycle.dailyCheck(clouds); await sweep.sweep(clouds); },
        revivable: c => lifecycle.revivable(c),
        requestDelete: (c, link) => lifecycle.requestDelete(c, link),
        confirmDelete: (c, token) => lifecycle.confirmDelete(c, token),
        cancelDelete: c => lifecycle.cancelDelete(c),
        operatorDelete: (c, reason) => lifecycle.operatorDelete(c, reason),
        accountDeleted: (c) => { lifecycle.accountDeleted(c); sweep.soon(); },
        resizeNow: c => lifecycle.resizeNow(c),
        backupNow: c => lifecycle.backupNow(c),
        noteView: c => lifecycle.noteView(c),
        resizing: c => lifecycle.resizing(c),
        setHold: (c, hold) => lifecycle.setHold(c, hold),
        endTrial: (c, reason) => updates.endTrial(c, reason),
        usage: async (c, from) => c.serverId ? provider.usage(c.serverId, from).catch(() => null) : null,
        handle,
        close: () => { sweep.close(); starts.close(); },
      };
    },
  };
}

/** addresses whose failed claim redemptions are remembered at once */
export const CLAIM_LIMIT_ENTRIES = 10_000;

/** a loopback service's own backup secret, kept beside its data */
function localSecret(path: string): Buffer {
  if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString("base64url"), { mode: 0o600, flag: "wx" });
  return parseSealKey(readFileSync(path, "utf8").trim());
}

export interface ManagedCloudEnvOptions {
  dataDir: string;
  publicUrl: string;
  loopback: boolean;
  sealKey: Buffer | null;
  now(): number;
  fetch?: typeof fetch;
  /** the billing store's subscriptions, read at the moment of each decision */
  subscriptions(): readonly StoredSubscription[];
  /** an owner's letter (retention, recovery, deletion); delivery failures are logged, never thrown */
  mail?(cloud: StoredCloud, letter: CloudLetter): void;
  /** the operator's alert for every deletion action */
  alert?(entry: AuditEntry): void;
}

/** MADANI_MANAGED=1 attaches the backend; anything else leaves the account service without one */
export function managedCloudFromEnv(env: NodeJS.ProcessEnv, options: ManagedCloudEnvOptions): ManagedCloudFactory | null {
  if (env.MADANI_MANAGED !== undefined && env.MADANI_MANAGED !== "0" && env.MADANI_MANAGED !== "1") throw new Error("Invalid MADANI_MANAGED.");
  if (env.MADANI_MANAGED !== "1") return null;
  const required = (key: string) => { const value = env[key]; if (!value) throw new Error(`${key} is required.`); return value; };
  const apiKey = required("INSTABOX_API_KEY");
  // the e2e harness's service is on a name no machine resolves and nobody uses (.invalid or .test): it may relax these
  const harness = env.MADANI_MANAGED_TEST_HARNESS === "1" && /\.(?:invalid|test)$/.test(new URL(options.publicUrl).hostname);
  const lenient = options.loopback || harness;
  // a service people use: user-facing names on our own domain behind the edge, and signed releases only
  if (!lenient) { required("MADANI_CLOUD_SEAL_KEY"); required("MADANI_MANAGED_PUBLIC_DOMAIN"); required("MADANI_MANAGED_EDGE_TOKEN"); }
  const edgeToken = env.MADANI_MANAGED_EDGE_TOKEN || null;
  if (edgeToken !== null && edgeToken.length < 32) throw new Error("MADANI_MANAGED_EDGE_TOKEN must be at least 32 characters.");
  const kinds = (env.MADANI_MANAGED_KINDS ?? "shared_s,shared_m,dedicated").split(",").map(k => k.trim());
  if (!kinds.length || kinds.some(k => k === "none" || !(DESKTOP_KINDS as readonly string[]).includes(k))) throw new Error("Invalid MADANI_MANAGED_KINDS.");
  const scope = env.MADANI_MANAGED_SCOPE ?? createHash("sha256").update(new URL(options.publicUrl).origin).digest("hex").slice(0, 16);
  // the backup secret never leaves this service: its own key, or one derived from the seal key, or (loopback only) a local file
  const backupSecret = env.MADANI_MANAGED_BACKUP_KEY ? parseSealKey(env.MADANI_MANAGED_BACKUP_KEY)
    : options.sealKey ? Buffer.from(hkdfSync("sha256", options.sealKey, Buffer.alloc(0), Buffer.from("omb-home-backup-secret"), 32))
    : localSecret(join(options.dataDir, "backup-secret"));
  const settings = managedSettingsFromEnv(env, { loopback: lenient });
  const plan = env.MADANI_MANAGED_PROVIDER_PLAN ?? "pro";
  if (!Object.hasOwn(INSTABOX_STARTS_PER_MINUTE, plan)) throw new Error("Invalid MADANI_MANAGED_PROVIDER_PLAN.");
  const idlePause = Number(env.MADANI_MANAGED_IDLE_PAUSE_MINUTES ?? 30);
  const releaseKeys = [...PINNED_RELEASE_KEYS, ...parseReleaseKeys(env.MADANI_RELEASE_PUBLIC_KEYS)];
  if (settings.package?.signature) verifyRelease(settings.package.signature, { kind: "home-package", sha256: settings.package.sha256 }, releaseKeys);
  else if (settings.requireSigned && settings.package) throw new Error("MADANI_MANAGED_HOME_PACKAGE_SIGNATURE is required: a home package must be signed by a release key.");
  const provider = createInstaboxProvider({ apiKey, baseUrl: env.INSTABOX_BASE_URL, scope, fetch: options.fetch, template: env.MADANI_MANAGED_PROVIDER_TEMPLATE, idlePauseMinutes: idlePause });
  return createManagedCloud({ kinds: kinds as Array<DesktopPlan["kind"]>, settings, costProfile: instaboxCostProfile({ plan: plan as InstaboxPlan }), backupSecret, releaseKeys, edgeToken,
    updatePolicy: createPolicySource(env.MADANI_UPDATE_POLICY_FILE, releaseKeys), release: createReleaseFile(env.MADANI_MANAGED_HOME_RELEASE_FILE),
    previousBackupSecret: env.MADANI_MANAGED_BACKUP_KEY_PREVIOUS ? parseSealKey(env.MADANI_MANAGED_BACKUP_KEY_PREVIOUS) : null,
    provider,
    backups: createBackupStore({ dir: env.MADANI_MANAGED_BACKUP_DIR || join(options.dataDir, "managed-backups"), now: options.now }),
    audit: createAudit({ dataDir: options.dataDir, now: options.now, alert: options.alert }),
    alert: options.alert,
    mono: options.now === Date.now ? () => performance.now() : undefined,
    entitlement: cloud => entitlementOf(options.subscriptions(), cloud, options.now()),
    notify: (cloud, kind, at, link) => options.mail?.(cloud, { ...noticeText(kind, { name: cloud.name, at, dashboardUrl: options.publicUrl, link }), notice: { kind, at, link } }) });
}
