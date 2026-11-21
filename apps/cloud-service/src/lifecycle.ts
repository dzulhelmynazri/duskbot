// a managed My Cloud from paid to deleted: provision, sleep when idle, wake for a person, a routine or Slack, back up,
// come back from a lost machine, keep a plan's data 30 days after it ended, and delete only through the verdict in
// retention.ts. One step per reconcile, each safe to repeat after a crash.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SleepPolicy } from "./power/policy.ts";
import type { ProviderCostProfile } from "./power/cost.ts";
import { costChargeRefusal, costStopRefusal, DEFAULT_RAILS, freshMemory, noteFailure, noteHealthy, noteStart, noteStop, noteUse, prune, startRefusal, stopRefusal, type PowerMemory, type RailSettings } from "./power/rails.ts";
import { validStats } from "./power/predictor.ts";
import { nextRun, plannedRuns, runnableFrom } from "./power/schedule.ts";
import { StartCapError, type StartKind, type StartLedger } from "./starts.ts";
import type { SpendInit, SpendLedger } from "./spend.ts";
import { linkKeys } from "../../dashboard/server/clouds/bootstrap.ts";
import { ProviderBusyError, ProviderError, ProviderLimitError, type MachineProvider, type MachineImage } from "./provider.ts";
import type { ReleaseKey } from "./release-signing.ts";
import { homeBackupKey, homeVolumeScan, type BackupStore } from "./backups.ts";
import { volumeLayer } from "./bundle.ts";
import { DAY_MS, DEFAULT_DELETE_DELAY_DAYS, DEFAULT_RETENTION_DAYS, deletionVerdict, dueNotice, prunableBackups, type Entitlement, type NoticeKind, type Verdict } from "./retention.ts";
import type { Audit, AuditActor, AuditEntry } from "./audit.ts";
import { RetryableCloudError } from "../../dashboard/server/clouds/http.ts";
import { ManagedCloudError } from "../../dashboard/server/clouds/managed.ts";
import type { HomeClient, HomePower, StoredCloud } from "../../dashboard/server/clouds/types.ts";
import type { HomeLifecycleState } from "./state.ts";
import type { HomeUpdates } from "./home-update.ts";
import { createEgressGuard } from "./egress.ts";

/** how long open apps have between the owner's pause notice and the machine stopping (the reconciler's next pass or so) */
export const OWNER_SLEEP_GRACE_MS = 10_000;
/** a dashboard view (its live pulse, polled only while the page shows an awake cloud) counts as an open app this long */
export const VIEW_FRESH_MS = 2 * 60_000;
const MINUTE = 60_000, HOUR = 3_600_000, BACKUP_RETRY_MS = 10 * MINUTE, SETUP_TRIES = 3, RESTORE_TRIES = 3, SETUP_PATIENCE_MS = 6 * HOUR, SETUP_ERROR_RETRY_MS = 6 * HOUR;

export interface ManagedSettings {
  /** the shortest idle before any stop, in minutes (MADANI_MANAGED_IDLE_MINUTES); the power policy decides past it */
  idleMinutes: number;
  /** the provider's own auto-stop, extended while the home is up: a dead-man switch if this service stops (MADANI_MANAGED_LEASE_HOURS) */
  leaseSeconds: number;
  /** a backup at most this often (MADANI_MANAGED_BACKUP_HOURS) */
  backupEveryMs: number;
  /** days whose newest generation is kept per cloud, besides the long-held oldest (MADANI_MANAGED_BACKUP_KEEP), at least 2 */
  backupKeep: number;
  retentionDays: number;
  deleteDelayDays: number;
  /** after a retention deletion the backups stay this long more (MADANI_MANAGED_BACKUP_TAIL_DAYS) */
  backupTailMs: number;
  /** a routine's run wakes its home this long before */
  wakeLeadMs: number;
  /** wakes the public edge may ask for per home per hour (webhooks, the app through our domain) */
  edgeWakesPerHour: number;
  powerReadMs: number;
  /** the home's app package: a URL the machine downloads, or a file this service uploads; its release signature travels with it */
  package: { sha256: string; url?: string; file?: string; signature?: string } | null;
  /** machines refuse an unsigned package (every service that is not loopback) */
  requireSigned: boolean;
  /** user-facing origins are https://<label>.<publicDomain>, proxied to the machine (edge/worker.js); null: the provider's own */
  publicDomain: string | null;
  /** the machine redeems a one-time claim for its secrets, so the provider's API never carries them; off where no machine can reach this service */
  claims: boolean;
  maxBackupBytes: number;
  /** a machine the provider stops finding is lost only after this long of direct 404s and absence from the account's list */
  lostAfterMs: number;
}
export const DEFAULT_MANAGED_SETTINGS: ManagedSettings = {
  idleMinutes: 15, leaseSeconds: 2 * 3600, backupEveryMs: 24 * HOUR, backupKeep: 2, retentionDays: DEFAULT_RETENTION_DAYS,
  deleteDelayDays: DEFAULT_DELETE_DELAY_DAYS, backupTailMs: 30 * DAY_MS, wakeLeadMs: 2 * MINUTE, edgeWakesPerHour: 20, powerReadMs: MINUTE, package: null, requireSigned: false, publicDomain: null, claims: false, maxBackupBytes: 4 * 1024 ** 3, lostAfterMs: 30 * MINUTE,
};

/** settings from MADANI_MANAGED_* */
export function managedSettingsFromEnv(env: NodeJS.ProcessEnv, options: { loopback?: boolean } = {}): ManagedSettings {
  const number = (name: string, min: number, max: number, fallback: number) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${name}.`);
    return value;
  };
  const sha256 = env.MADANI_MANAGED_HOME_PACKAGE_SHA256;
  const pkg = env.MADANI_MANAGED_HOME_PACKAGE_URL || env.MADANI_MANAGED_HOME_PACKAGE_FILE
    ? { sha256: sha256 && /^[a-f0-9]{64}$/.test(sha256) ? sha256 : (() => { throw new Error("Invalid MADANI_MANAGED_HOME_PACKAGE_SHA256."); })(),
      ...(env.MADANI_MANAGED_HOME_PACKAGE_URL ? { url: env.MADANI_MANAGED_HOME_PACKAGE_URL } : { file: env.MADANI_MANAGED_HOME_PACKAGE_FILE }) }
    : null;
  const signature = env.MADANI_MANAGED_HOME_PACKAGE_SIGNATURE || (env.MADANI_MANAGED_HOME_PACKAGE_SIGNATURE_FILE ? readFileSync(env.MADANI_MANAGED_HOME_PACKAGE_SIGNATURE_FILE, "utf8").trim() : "");
  if (signature && pkg) Object.assign(pkg, { signature });
  const publicDomain = env.MADANI_MANAGED_PUBLIC_DOMAIN || null;
  if (publicDomain !== null && !/^(?=.{4,200}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(publicDomain)) throw new Error("Invalid MADANI_MANAGED_PUBLIC_DOMAIN.");
  if (!pkg) throw new Error("A managed cloud needs MADANI_MANAGED_HOME_PACKAGE_URL (or _FILE) with MADANI_MANAGED_HOME_PACKAGE_SHA256.");
  return { ...DEFAULT_MANAGED_SETTINGS, package: pkg, publicDomain,
    requireSigned: !options.loopback, claims: !options.loopback,
    idleMinutes: number("MADANI_MANAGED_IDLE_MINUTES", 1, 24 * 60, 15),
    leaseSeconds: number("MADANI_MANAGED_LEASE_HOURS", 1, 720, 2) * 3600,
    backupEveryMs: number("MADANI_MANAGED_BACKUP_HOURS", 1, 24 * 7, 24) * HOUR,
    backupKeep: number("MADANI_MANAGED_BACKUP_KEEP", 2, 30, 2),
    wakeLeadMs: number("MADANI_MANAGED_WAKE_LEAD_MINUTES", 1, 30, 2) * MINUTE,
    edgeWakesPerHour: number("MADANI_MANAGED_EDGE_WAKES_PER_HOUR", 1, 60, 20),
    retentionDays: number("MADANI_MANAGED_RETENTION_DAYS", DEFAULT_RETENTION_DAYS, 3650, DEFAULT_RETENTION_DAYS),
    deleteDelayDays: number("MADANI_MANAGED_DELETE_DELAY_DAYS", DEFAULT_DELETE_DELAY_DAYS, 90, DEFAULT_DELETE_DELAY_DAYS),
    backupTailMs: number("MADANI_MANAGED_BACKUP_TAIL_DAYS", 7, 365, 30) * DAY_MS,
    maxBackupBytes: number("MADANI_MANAGED_BACKUP_MAX_MB", 64, 64 * 1024, 4096) * 1024 * 1024,
    lostAfterMs: number("MADANI_MANAGED_LOST_AFTER_MINUTES", 2, 24 * 60, 30) * MINUTE };
}

export function freshManagedState(): HomeLifecycleState {
  return { attempt: 0, installed: null, restoreFrom: null, restoredFrom: null, sleptAt: null, sleepReason: null, nextDueAt: null, lastPowerAt: null, busy: [], leaseAt: null,
    lastStopAt: null, wakeStartedAt: null, backups: [], lastBackupTryAt: null, backupProblem: null, endedAt: null, notices: [], deleteRequest: null, deletion: null,
    deletedAt: null, backupsDeleteAfter: null, retired: [], recoveries: 0, hold: false };
}

export interface LifecycleDeps {
  /** the operator's alert (an email, or an incident): one per incident */
  alert?(entry: AuditEntry): void;
  provider: MachineProvider;
  image: MachineImage;
  backups: BackupStore;
  home: HomeClient;
  audit: Audit;
  settings: ManagedSettings;
  /** the billing system of record, read fresh at every decision */
  entitlement(cloud: StoredCloud): Entitlement;
  notify(cloud: StoredCloud, kind: NoticeKind, at: number | null, link?: string): void;
  unseal(value: string): string;
  seal(value: string): string;
  dashboardUrl: string;
  adminOrigin: string;
  removeWorkspace(workspaceId: string): void;
  now(): number;
  save(cloud: StoredCloud): void;
  /** this service's backup secret (MADANI_MANAGED_BACKUP_KEY, or derived from MADANI_CLOUD_SEAL_KEY); never on a home */
  backupSecret: Buffer;
  /** the cloud's record as stored on disk now, re-read right before anything irreversible */
  stored(cloudId: string): StoredCloud | null;
  /** every cloud, for the claim and the edge's route lookup */
  clouds(): StoredCloud[];
  /** a fresh signed entitlement for the cloud's home, or null when none is signed */
  entitle(cloud: StoredCloud): string | null;
  /** a link grant for the cloud's account, sent beside its entitlement for the home's phone relay */
  linkGrant?(cloud: StoredCloud): string | null;
  /** the release keys a package must be signed with */
  releaseKeys: readonly ReleaseKey[];
  /** keys the opaque public labels (never on a machine) */
  labelKey: Buffer;
  /** the provider's start pool (starts.ts): rolling windows, alerted, refused past the provider's hard cap or its not-before time */
  starts?: StartLedger;
  /** the power policy (power/policy.ts): whether an idle home stops now, and when a sleeping one wakes for a run */
  sleepPolicy: SleepPolicy;
  /** the provider's prices and start rules, for the rails */
  costProfile: ProviderCostProfile;
  /** the hard limits every stop and start passes, whatever the policy says (power/rails.ts) */
  rails?: RailSettings;
  /** every home's monthly cost book (spend.ts): the rails keep each under its ceiling */
  spend?: SpendLedger;
  /** staged updates of a running home, with their self-test and rollback (home-update.ts) */
  updates?: HomeUpdates;
}

/** a start the rails held back (a failing home's backoff, the provider's hard cap or not-before time, a busy minute):
 *  not a failure, tried again at `retryAt` */
export class StartHeldError extends RetryableCloudError {
  readonly retryAt: number;
  readonly reason: string;
  constructor(reason: string, retryAt: number) { super("The start waits for the start limits."); this.name = "StartHeldError"; this.reason = reason; this.retryAt = retryAt; }
}

/** how long a start the provider accepted may still read as stopped before it is asked again */
export const WAKE_SETTLE_MS = 60_000;

export function createLifecycle(deps: LifecycleDeps) {
  const { provider, image, settings, audit, now } = deps;
  const log = (c: StoredCloud, action: string, actor: AuditActor, reason: string, detail?: Record<string, string | number | boolean | null>) =>
    audit.record({ cloudId: c.id, action, actor, reason, serverId: c.serverId, ...(detail ? { detail } : {}) });
  const state = (c: StoredCloud): HomeLifecycleState => (c.managed ??= freshManagedState());
  /** the operator hears of it once: an audit line, the console's ALERT line (an incident) and the alert hook (recorded, never an email) */
  const opsAlert = (c: StoredCloud | null, action: string, reason: string, text: string) => {
    console.warn(`managed: ALERT ${text}`);
    if (c) log(c, action, "reconciler", reason);
    deps.alert?.({ at: now(), cloudId: c?.id ?? "fleet", action, actor: "reconciler", reason: text.slice(0, 900) });
  };
  const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);
  /** awake time with a reason: work of any kind, a run or check due soon, a wake for the person's own routines (that
   *  whole stretch), staying up for a run ahead, or the person using it in the last half hour or with the app open */
  const EXPLAINED_BUSY = new Set(["turn", "run", "live-call", "computer", "maintenance", "due-soon", "recent-work", "focus"]);
  const EXPLAINED_STAY = new Set(["run_soon_cheaper_awake", "cheaper_awake_until_run", "routine_due", "work_buffer"]);
  const explained = (b: HomeLifecycleState, power: HomePower) =>
    power.busy.some(code => EXPLAINED_BUSY.has(code)) || b.wokeFor === "routine" || EXPLAINED_STAY.has(b.stayReason ?? "")
    || (power.lastActivityAt !== null && now() - power.lastActivityAt < 30 * MINUTE);
  /** adds the time since the last power read to the day's awake tally (a gap over 5 minutes counts as 5: a read that did
   *  not happen is not proof it was up), and the part with a reason (`explained`); a finished day awake over half of it
   *  with no reason is flagged for the daily check */
  const tallyDay = (c: StoredCloud, power: HomePower) => {
    const b = state(c), at = now(), day = dayOf(at);
    const t = b.awakeDay && b.awakeDay.day === day ? b.awakeDay : null;
    if (b.awakeDay && b.awakeDay.day !== day && b.awakeDay.awakeMs - b.awakeDay.workMs > 12 * HOUR) b.flaggedDay = { day: b.awakeDay.day, awakeMs: b.awakeDay.awakeMs, workMs: b.awakeDay.workMs };
    const dt = t ? Math.max(0, Math.min(at - t.at, 5 * MINUTE)) : 0, work = explained(b, power);
    b.awakeDay = { day, at, awakeMs: (t?.awakeMs ?? 0) + dt, workMs: (t?.workMs ?? 0) + (work ? dt : 0) };
  };
  const rails = deps.rails ?? DEFAULT_RAILS;
  const pool = () => deps.starts?.view() ?? { used: { minute: 0, hour: 0, day: 0 }, blockedUntil: null };
  const egress = createEgressGuard({ provider, now, save: c => deps.save(c), log: (c, action, reason, detail) => log(c, action, "reconciler", reason, detail),
    alert: (_c, text) => console.warn(`managed: ALERT ${text}`) });
  /** the home's power memory (its starts, stops, failed starts and activity), checked on every read */
  function memory(c: StoredCloud): PowerMemory {
    const b = state(c), m = b.power ?? freshMemory(now());
    m.stats = validStats(m.stats, now());
    for (const key of ["starts", "stops", "failures"] as const) if (!Array.isArray(m[key]) || !m[key].every(Number.isFinite)) m[key] = [];
    if (m.breaker && !(Number.isFinite(m.breaker.openUntil) && Number.isFinite(m.breaker.trips))) m.breaker = null;
    b.power = prune(m, now());
    return m;
  }
  // ---- the monthly cost ceiling: every billable thing is charged to the home's book before it is asked for
  const rateOf = (spec: StoredCloud["spec"]) => deps.costProfile.computeCentsPerHour(spec);
  function spendInit(c: StoredCloud): SpendInit {
    const b = state(c), fresh = c.status === "provisioning" && b.attempt === 0 && !c.serverId;
    // a home already running before its book opened: what it spent so far this month is priced as always-on
    return { rate: rateOf(c.spec), up: !fresh, bytes: b.backups.reduce((n, g) => n + g.bytes, 0), prepaid: fresh, before: !fresh, disk: c.serverId ? diskOf(c.spec) : 0 };
  }
  const diskOf = (spec: StoredCloud["spec"]) => deps.costProfile.diskCentsPerHour?.(spec) ?? 0;
  const spendView = (c: StoredCloud) => deps.spend ? deps.spend.view(c.id, () => spendInit(c)) : null;
  const spendNote = (c: StoredCloud, ev: Parameters<SpendLedger["record"]>[2]) => deps.spend?.record(c.id, () => spendInit(c), ev);
  /** what the provider says about the home's own machine: billed unless it is stopped or gone */
  const spendMark = (c: StoredCloud, up: boolean) => deps.spend?.mark(c.id, () => spendInit(c), up);
  /** a retired machine's keep-alive runs until the next pass stops it, and at most until its lease does */
  const extraMachineCents = (c: StoredCloud) => Math.max(rateOf(c.spec), rateOf(c.desiredSpec)) * settings.leaseSeconds / 3600;
  const costHeldSeen = new Map<string, string>();
  function costHeld(c: StoredCloud, reason: string, what: string) {
    state(c).stayReason = reason;
    if (costHeldSeen.get(c.id) === `${reason}:${what}`) return;
    costHeldSeen.set(c.id, `${reason}:${what}`); log(c, "cost_ceiling", "reconciler", what);
    console.warn(`managed: ALERT cloud ${c.id}: held at its monthly cost ceiling (${what})`);
  }
  function syncBytes(c: StoredCloud) { if (deps.spend) spendNote(c, { e: "bytes", bytes: state(c).backups.reduce((n, g) => n + g.bytes, 0) }); }

  function breakerOpened(c: StoredCloud, m: PowerMemory) {
    log(c, "starts_failing", "reconciler", "breaker_open", { trips: m.breaker?.trips ?? 0, until: m.breaker?.openUntil ?? null });
    console.warn(`managed: ALERT cloud ${c.id}: its machine failed to come up ${rails.breakerFailures} times; automatic starts wait until ${new Date(m.breaker?.openUntil ?? now()).toISOString()}`);
  }
  /** a provider start: through the rails first, charged to the home's book at the worst price before it is asked for (and
   *  settled to the price the pool ledger proves once it ran), counted once it was asked for; one the rails hold back is
   *  tried again later. `extra`: a second machine of the home (a retired disk's keep-alive), charged with its compute. */
  async function start<T>(c: StoredCloud, kind: StartKind, run: () => Promise<T>, latest: number | null = null, extra = false): Promise<T> {
    const m = memory(c), extraCents = extra ? extraMachineCents(c) : 0;
    const refused = startRefusal({ now: now(), kind, latest, memory: m, pool: pool(), profile: deps.costProfile, spend: spendView(c), extraCents }, rails);
    if (refused) {
      if (refused.reason.startsWith("cost_")) { costHeld(c, refused.reason, kind); deps.save(c); }
      throw new StartHeldError(refused.reason, refused.recheckAt);
    }
    deps.starts?.admit();
    const worst = deps.spend?.worst ?? 0;
    if (deps.spend) {
      if (extra) spendNote(c, { e: "extra", cents: worst + extraCents, why: `retired_${kind}` });
      else {
        const spec = kind === "resize" ? c.desiredSpec : c.spec;
        if (deps.spend.book(c.id).current?.rate !== rateOf(spec)) spendNote(c, { e: "rate", rate: rateOf(spec) });
        if (deps.spend.book(c.id).current?.disk !== diskOf(spec)) spendNote(c, { e: "disk", rate: diskOf(spec) });
        spendNote(c, { e: "start", kind, cents: worst });
      }
    }
    let result: T;
    try { result = await run(); }
    catch (error) {
      // refused outright (a limit, busy, a 4xx): nothing started, so nothing is owed; anything else may have been billed
      const refusedByProvider = error instanceof ProviderLimitError || error instanceof ProviderBusyError || error instanceof ProviderError && error.status < 500;
      if (deps.spend && refusedByProvider) spendNote(c, extra ? { e: "extra", cents: -(worst + extraCents), why: "refused" } : { e: "settle", cents: worst, void: true });
      if (error instanceof ProviderLimitError) { if (error.info.nextStartAt !== null) deps.starts?.block(error.info.nextStartAt); }
      else if (!(error instanceof ProviderBusyError) && noteFailure(m, now(), rails)) breakerOpened(c, m);
      deps.save(c);
      throw error;
    }
    if (deps.spend && deps.starts) {
      // the pool ledger proves the price this start had (an included one is free); a held resume is not proven free
      const price = deps.costProfile.startCents(deps.starts.view().used);
      if (Number.isFinite(price) && price < worst) spendNote(c, extra ? { e: "extra", cents: -(worst - price), why: "settled" } : { e: "settle", cents: worst - price });
    }
    deps.starts?.record(c.id, kind);
    noteStart(m, now()); deps.save(c);
    return result;
  }
  const secret = (c: StoredCloud) => deps.unseal(c.bootstrapSecret);
  const keyOf = (c: StoredCloud) => homeBackupKey(deps.backupSecret, c.id);
  /** where this service reaches the home: the machine's own hosted URL, never through the public proxy */
  const homeOrigin = (c: StoredCloud) => state(c).upstream ?? c.origin!;
  const label = (c: StoredCloud) => (state(c).label ??= `d${createHmac("sha256", deps.labelKey).update(`omb-managed-label:${c.id}`).digest("hex").slice(0, 20)}`);
  /** the user-facing origin for a machine's hosted URL: ours when a public domain is set */
  function publish(c: StoredCloud, upstream: string) {
    const b = state(c);
    b.upstream = upstream;
    c.origin = settings.publicDomain ? `https://${label(c)}.${settings.publicDomain}` : upstream;
  }
  /** a hosted home serves no client without a fresh entitlement: pushed when it comes up, refreshed hourly */
  async function entitle(c: StoredCloud, force: boolean) {
    if (!deps.home.entitle || (!force && c.entitledAt !== undefined && now() - c.entitledAt < HOUR)) return;
    const token = deps.entitle(c);
    if (!token) return;
    try { await deps.home.entitle(homeOrigin(c), secret(c), token, deps.linkGrant?.(c) ?? null); }
    catch { throw new RetryableCloudError("Cloud home refused its entitlement."); }
    c.entitledAt = now(); deps.save(c);
  }
  const latestVerified = (b: HomeLifecycleState) => [...b.backups].reverse().find(g => g.verifiedAt !== null) ?? null;
  function notice(c: StoredCloud, kind: NoticeKind, at: number | null, link?: string) {
    const b = state(c);
    if (["ended", "left_30", "left_7", "left_1", "deleted"].includes(kind) && b.notices.some(n => n.kind === kind)) return;
    b.notices.push({ kind, at: now() });
    deps.save(c);
    try { deps.notify(c, kind, at, link); } catch { console.warn(`managed: notice ${kind} for ${c.id} was not delivered`); }
  }

  /** cut off before its first setup finished (cancelled while provisioning, say): no one ever used it, so it holds no data */
  const neverSetUp = (c: StoredCloud) => c.setupStep !== null && state(c).recoveries === 0 && state(c).backups.length === 0;

  function verdictFor(c: StoredCloud, given = deps.entitlement(c)): Verdict {
    const b = state(c), final = latestVerified(b);
    // a plan that ended with no period end on record: the clock runs from when this service first saw it end
    const entitlement = !given.active && given.until === null && given.known && b.endedAt !== null ? { ...given, until: b.endedAt } : given;
    return deletionVerdict({ now: now(), retentionDays: settings.retentionDays, entitlement, finalBackup: final ? { at: final.snapshotAt, verifiedAt: final.verifiedAt } : null,
      lastStopAt: b.lastStopAt, ownerRequest: b.deleteRequest, neverSetUp: neverSetUp(c), hold: b.hold || c.suspended !== null && c.suspended !== "Account deleted" });
  }

  /** a backup of the volume, read from the running home */
  async function backup(c: StoredCloud, reason: string): Promise<boolean> {
    const b = state(c), serverId = c.serverId;
    if (!serverId) return false;
    b.lastBackupTryAt = now(); deps.save(c);
    // the volume is read from the running home as of now: what it held before this moment is in it
    const takenAt = now(), snapshot = await provider.latestSnapshot(serverId);
    if (!snapshot) { b.backupProblem = "no_snapshot"; deps.save(c); return false; }
    let stream: ReadableStream<Uint8Array>;
    try { stream = await provider.snapshotTar(snapshot.id, image.homeVolume); }
    catch (error) { b.backupProblem = "snapshot_read"; deps.save(c); log(c, "backup_failed", "reconciler", "snapshot_read"); throw error; }
    // streamed to disk as it is read, sealed and hashed on the way, and checked as a tar on the way too: memory stays at
    // a chunk or two whatever the volume's size
    const layers: Record<string, number> = {};
    const scan = homeVolumeScan(c.id, (name, bytes) => { const key = volumeLayer(name); layers[key] = (layers[key] ?? 0) + bytes; }), key = keyOf(c);
    let size = 0, tooLarge = false;
    const reader = stream.getReader();
    async function* pieces() {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    }
    let written: Awaited<ReturnType<BackupStore["writeStream"]>>;
    try {
      written = await deps.backups.writeStream(c.id, key, pieces(), chunk => {
        size += chunk.length;
        if (size > settings.maxBackupBytes) { tooLarge = true; throw new Error("too_large"); }
        scan.push(chunk);
      });
    } catch (error) {
      if (tooLarge) { await reader.cancel().catch(() => {}); b.backupProblem = "too_large"; deps.save(c); log(c, "backup_skipped", "reconciler", "too_large"); return false; }
      await reader.cancel().catch(() => {}); throw error;
    } finally { reader.releaseLock(); }
    const { plainBytes, ...record } = written, problem = scan.end();
    if (problem) { deps.backups.remove(c.id, record.file); b.backupProblem = problem; deps.save(c); log(c, "backup_refused", "reconciler", problem); return false; }
    // its storage until the month ends is charged before it is kept (the pruning after only gives some back)
    const storage = deps.spend ? deps.spend.storageCents(c.id, () => spendInit(c), plainBytes) : 0;
    if (costChargeRefusal(spendView(c), storage, now())) {
      deps.backups.remove(c.id, record.file);
      b.backupProblem = "cost_ceiling"; deps.save(c); log(c, "backup_skipped", "reconciler", "cost_ceiling", { bytes: plainBytes });
      deps.spend?.alert(c.id, "backup", `cloud ${c.id}: a backup was skipped, its storage would pass the monthly cost ceiling`);
      return false;
    }
    if (deps.spend) spendNote(c, { e: "bytes", bytes: b.backups.reduce((n, g) => n + g.bytes, 0) + record.bytes });
    // restorable means: it opens with this cloud's key and is still this cloud's volume, read back from disk a piece at a time
    const opened = await deps.backups.check(c.id, key, record.file);
    const verified = opened.problem === null && opened.sha256 === record.sha256;
    b.backups.push({ ...record, verifiedAt: verified ? now() : null, snapshotAt: takenAt });
    b.backupProblem = verified ? null : "unverified";
    log(c, "backup", "reconciler", reason, { file: record.file, bytes: record.bytes, verified, ...Object.fromEntries(Object.entries(layers).map(([k, v]) => [`bytes_${k}`, v])) });
    pruneBackups(c);
    syncBytes(c);
    deps.save(c);
    return verified;
  }

  /** the generations prunableBackups no longer needs; none while an operator hold is set */
  function pruneBackups(c: StoredCloud) {
    const b = state(c);
    if (b.hold) return;
    const keep = b.archive && c.serverId === null ? 1 : settings.backupKeep;
    const drop = prunableBackups(b.backups, { keep, protect: b.restoreFrom ? [b.restoreFrom] : [] });
    for (const old of drop) {
      deps.backups.remove(c.id, old.file); b.backups.splice(b.backups.indexOf(old), 1);
      log(c, "backup_pruned", "reconciler", keep === 1 ? "archived" : "generations", { file: old.file });
    }
    if (drop.length) { syncBytes(c); deps.save(c); }
  }

  /** a setup step still under way is waiting, not failing: polled again soon, and only a setup past 45 minutes fails */
  function wait(c: StoredCloud, ms: number) {
    if (now() - (state(c).setupSince ?? c.provisionedAt ?? c.createdAt) > 45 * MINUTE) throw new Error("Cloud setup timed out.");
    c.nextAttemptAt = now() + ms; deps.save(c);
  }

  async function provisionStep(c: StoredCloud, entitled: boolean) {
    const b = state(c);
    // the setup step stays: a plan that starts again carries on from it (resumeSetup)
    if (!entitled) { log(c, "provision_held", "reconciler", "not_entitled"); c.status = "stopped"; deps.save(c); return; }
    if (c.setupStep === "reserving") {
      if (!c.workspaceId || !c.linkPublicKey || !c.sealedLinkPrivateKey) throw new Error("Missing cloud bootstrap.");
      const link = { v: 1 as const, url: deps.dashboardUrl, workspaceId: c.workspaceId, publicKey: c.linkPublicKey, privateKey: deps.unseal(c.sealedLinkPrivateKey), enrolledAt: c.provisionedAt ?? now(), claimed: true };
      // the machine gets a one-time claim, never its secrets: the provider's API and its logs never carry them
      let boot = image.bootFile({ cloudId: c.id, adminOrigin: deps.adminOrigin, secret: secret(c), dashboardUrl: deps.dashboardUrl, link, ...(c.team ? { team: c.team } : {}) });
      if (settings.claims) {
        // the same claim for the same attempt: a retried create gets the first machine back, with the first boot file
        const claim = createHmac("sha256", deps.backupSecret).update(`omb-managed-claim:${c.id}:${b.attempt}`).digest("base64url");
        b.claim = { hash: createHash("sha256").update(claim).digest("hex"), expiresAt: now() + HOUR, redeemedAt: null };
        boot = image.claimBootFile({ cloudId: c.id, claim, redeem: `${deps.dashboardUrl}/v1/managed/claims/redeem` });
      }
      const server = await start(c, b.attempt > 0 ? "recover" : "create", () => provider.create({ cloudId: c.id, spec: c.spec, region: c.region, userData: image.setupScript({ releaseKeys: deps.releaseKeys, requireSigned: settings.requireSigned }),
        ttlSeconds: settings.leaseSeconds, attempt: b.attempt, files: [boot], snapshotId: b.restoreSnapshot ?? null }));
      c.serverId = server.id; b.upstream = server.origin ?? null; c.origin = null; b.installed = null; b.leaseAt = now(); b.setupSince = now();
      log(c, "create", "reconciler", b.attempt ? "recovery" : "paid", { attempt: b.attempt });
      c.setupStep = "storage"; deps.save(c); return;
    }
    if (!c.serverId) throw new Error("Missing cloud server.");
    if (c.setupStep === "storage") {
      const s = await provider.machine(c.serverId);
      if (!s || s.state !== "running" || (s.setup !== "done" && s.setup !== null && s.setup !== "failed")) return wait(c, 5_000);
      if (s.setup === "failed") return setupFailed(c);
      const pkg = settings.package;
      if (pkg && b.installed !== pkg.sha256) {
        if (pkg.file) await provider.upload(c.serverId, image.packagePath, readFileSync(pkg.file));
        const done = await provider.run(c.serverId, image.installCommand(pkg.sha256, pkg.url, pkg.signature), 600);
        if (!done.ok || !done.stdout.includes("installed")) throw new RetryableCloudError("Cloud package install failed.");
        b.installed = pkg.sha256; deps.save(c);
      }
      if (b.restoreFrom) {
        if (!(await restored(c, b.restoreFrom))) return restoreFailed(c);
        const from = b.backups.find(g => g.file === b.restoreFrom);
        b.restoredFrom = { file: b.restoreFrom, at: from?.snapshotAt ?? now() }; b.restoreFrom = null; b.restoreTries = 0;
        log(c, "restore", "reconciler", "recovery", { file: b.restoredFrom.file });
      }
      c.setupStep = "starting"; deps.save(c); return;
    }
    if (c.setupStep === "starting") {
      publish(c, state(c).upstream ?? await provider.origin(c.serverId));
      const started = await provider.run(c.serverId, image.startCommand(c.origin!, homeOrigin(c)), 120);
      if (!started.ok) throw new RetryableCloudError("Cloud home did not start.");
      c.setupStep = "checking"; deps.save(c); return;
    }
    if (!c.origin || !(await deps.home.healthy(homeOrigin(c), secret(c)))) return wait(c, 5_000);
    // a new home is ready once its bot computers can start at once: their image builds on the machine in a minute or two
    if (now() - (b.setupSince ?? now()) < 15 * MINUTE && (await provider.run(c.serverId, image.desktopStatusCommand, 30)).stdout.trim() === "building") return wait(c, 5_000);
    await entitle(c, true);
    if (b.claim) b.claim = null;
    c.status = "running"; c.setupStep = null; c.lastCheckedAt = now(); c.powerSince = now(); c.wantPower = "on";
    b.wakeStartedAt = null; b.lastPowerAt = now(); b.sleptAt = null; b.sleepReason = null;
    c.attempts = 0; c.nextAttemptAt = 0; c.error = null;
    log(c, "running", "reconciler", b.restoredFrom ? "recovered" : "provisioned");
    if (b.restoredFrom && b.attempt > 0) notice(c, "recovered", b.restoredFrom.file ? b.restoredFrom.at : null);
    if (b.restoreSnapshot) {
      // back from its archive: the snapshot has done its job
      const snapshotId = b.restoreSnapshot;
      b.restoreSnapshot = null; if (b.archive?.snapshotId === snapshotId) b.archive = null;
      await provider.deleteSnapshot(snapshotId).then(() => log(c, "snapshot_deleted", "reconciler", "restored", { snapshot: snapshotId }),
        () => console.warn(`managed: snapshot ${snapshotId} of ${c.id} was restored but could not be deleted`));
    }
    deps.save(c);
  }

  async function restored(c: StoredCloud, file: string): Promise<boolean> {
    let tar: Buffer;
    try { tar = deps.backups.read(c.id, keyOf(c), file); } catch { return false; }
    await provider.upload(c.serverId!, image.restorePath, tar);
    const done = await provider.run(c.serverId!, image.restoreCommand, 600);
    return done.ok && done.stdout.includes("restored");
  }

  /** a restore that keeps failing falls back to the next older verified generation, RESTORE_TRIES tries each; with none
   *  left the recovery stops in the error state for the operator (setupErrored retries it, slowly) */
  function restoreFailed(c: StoredCloud): never {
    const b = state(c), file = b.restoreFrom!;
    b.restoreTries = (b.restoreTries ?? 0) + 1;
    log(c, "restore_failed", "reconciler", "recovery", { file, tries: b.restoreTries });
    if (b.restoreTries < RESTORE_TRIES) { deps.save(c); throw new RetryableCloudError("Cloud restore failed."); }
    b.badRestores = [...new Set([...(b.badRestores ?? []), file])];
    b.restoreTries = 0;
    const failedAt = b.backups.find(g => g.file === file)?.snapshotAt ?? Infinity;
    const older = [...b.backups].reverse().find(g => g.verifiedAt !== null && g.snapshotAt < failedAt && !b.badRestores!.includes(g.file));
    if (older) {
      b.restoreFrom = older.file;
      log(c, "restore_fallback", "reconciler", "recovery", { from: file, to: older.file });
      deps.save(c); throw new RetryableCloudError("Cloud restore failed; an older backup is tried next.");
    }
    console.warn(`managed: ALERT cloud ${c.id}: no backup of it restores; its recovery waits for the operator`);
    c.status = "error"; c.error = "Restoring your data failed. We are on it.";
    deps.save(c); throw new Error("Cloud restore failed.");
  }

  /** a first setup that failed on its machine (a mirror down, say): a fresh machine, at most SETUP_TRIES in all; the failed
   *  one held no data and is retired, so it is deleted with its cloud */
  async function setupFailed(c: StoredCloud) {
    const b = state(c);
    b.setupFailures = (b.setupFailures ?? 0) + 1;
    log(c, "setup_failed", "reconciler", "setup_script", { tries: b.setupFailures });
    if (b.setupFailures >= SETUP_TRIES) { console.warn(`managed: ALERT cloud ${c.id}: its setup failed ${SETUP_TRIES} times`); deps.save(c); throw new Error("Cloud setup failed."); }
    if (c.serverId && !b.retired.some(r => r.serverId === c.serverId)) b.retired.push({ serverId: c.serverId, at: now(), deletion: null });
    if (c.serverId) await provider.power(c.serverId, "off").catch(() => {});
    b.attempt++; b.installed = null; b.claim = null; b.upstream = null; b.setupSince = now();
    c.serverId = null; c.origin = null; c.setupStep = "reserving"; c.nextAttemptAt = 0;
    deps.save(c);
  }

  /** a first setup a plan's end cut off, carried on once a plan pays for it again */
  async function resumeSetup(c: StoredCloud) {
    const b = state(c);
    renewed(c);
    if (c.serverId) {
      const s = await provider.machine(c.serverId);
      if (!s) { c.serverId = null; c.origin = null; b.upstream = null; b.installed = null; b.attempt++; c.setupStep = "reserving"; }
      else if (s.state === "stopped") await start(c, "wake", () => provider.power(c.serverId!, "on"));
    }
    // a cold boot lost the started home: started again
    if (c.setupStep === "checking") c.setupStep = "starting";
    b.setupSince = now(); b.setupErrorAt = null; b.setupRetries = 0; c.status = "provisioning"; c.wantPower = "on"; c.nextAttemptAt = 0; c.attempts = 0; c.error = null;
    log(c, "setup_resumed", "billing", "plan_renewed", { step: c.setupStep });
    deps.save(c);
  }

  /** a first setup that ended in an error: its machines paused (nothing on them is anyone's yet), and the setup tried again
   *  every SETUP_ERROR_RETRY_MS while the plan pays, unless its setup script itself failed every time (the operator's call) */
  async function setupErrored(c: StoredCloud) {
    const b = state(c);
    if (b.setupErrorAt == null) { b.setupErrorAt = now(); log(c, "setup_error", "reconciler", "paused"); console.warn(`managed: ALERT cloud ${c.id}: its first setup failed; its machine is paused and setup is tried again later`); }
    if (c.serverId) { const s = await provider.machine(c.serverId); if (s && (s.state === "running" || s.state === "starting")) await provider.power(c.serverId, "off"); }
    await retiredStep(c);
    const againAt = b.setupErrorAt + SETUP_ERROR_RETRY_MS;
    if ((b.setupFailures ?? 0) < SETUP_TRIES && now() >= againAt) return resumeSetup(c);
    c.nextAttemptAt = Math.min(againAt, now() + 30 * MINUTE); deps.save(c);
  }

  /** a lost machine: a fresh machine, from the newest verified backup when there is one; the old one is retired, never deleted here */
  function recover(c: StoredCloud, why: string) {
    const b = state(c), from = latestVerified(b);
    if (c.serverId && !b.retired.some(r => r.serverId === c.serverId)) b.retired.push({ serverId: c.serverId, at: now(), deletion: null });
    b.attempt++; b.recoveries++; b.restoreFrom = from?.file ?? null; b.installed = null; b.restoredFrom = from ? null : { file: "", at: 0 };
    c.serverId = null; c.origin = null; b.upstream = null; b.claim = null; c.status = "provisioning"; c.setupStep = "reserving"; c.attempts = 0; c.nextAttemptAt = 0;
    if (!c.sealedLinkPrivateKey) { const keys = linkKeys(); c.linkPublicKey = keys.publicKey; c.sealedLinkPrivateKey = deps.seal(keys.privateKey); }
    log(c, "recover", "reconciler", why, { backup: from?.file ?? null, attempt: b.attempt });
    deps.save(c);
  }

  /** The owner's pause: the home tells its open apps it is going to sleep, busy or not, and the machine stops
   * OWNER_SLEEP_GRACE_MS later on a following pass. True while that grace runs. */
  async function ownerSleepNotice(c: StoredCloud): Promise<boolean> {
    const b = state(c);
    if (!b.sleepNoticeAt) {
      b.sleepNoticeAt = now();
      await deps.home.sleep!(homeOrigin(c), secret(c), Math.max(1, Math.round(rails.minIdleMs / MINUTE)), { force: true }).catch(() => null);
      log(c, "sleep_notice", "owner", "owner");
      deps.save(c);
      return true;
    }
    return now() - b.sleepNoticeAt < OWNER_SLEEP_GRACE_MS;
  }

  /** `quietSince`: when the home's data last changed, for the final backup retention relies on (now by default) */
  async function sleepNow(c: StoredCloud, reason: HomeLifecycleState["sleepReason"], actor: AuditActor, quietSince = now()) {
    const b = state(c);
    if (!c.serverId) return;
    await provider.power(c.serverId, "off");
    b.lastStopAt = quietSince;
    // a stop the rails' cost rule allowed: the start that ends this sleep is already paid for
    if (reason === "idle" || reason === "owner") spendNote(c, { e: "stop" });
    if (reason === "owner") delete c.pauseRequestedAt;
    b.sleptAt = now(); b.sleepReason = reason; b.sleepNoticeAt = null; c.status = reason === "plan" ? "stopped" : "sleeping"; c.powerSince = now(); c.wantPower = "off";
    log(c, "sleep", actor, reason ?? "idle", { nextDueAt: b.nextDueAt });
    deps.save(c);
  }

  /** the stored record wins where it is more careful: a hold, a suspension or an owner's cancel this process has not seen */
  function rereadStored(c: StoredCloud): boolean {
    const b = state(c), fresh = deps.stored(c.id);
    if (!fresh?.managed) { log(c, "delete_refused", "reconciler", "record_unreadable"); return false; }
    if (fresh.managed.hold && !b.hold) b.hold = true;
    if (fresh.suspended !== null && c.suspended === null) c.suspended = fresh.suspended;
    const cancelled = fresh.managed.deleteRequest?.cancelledAt ?? null;
    if (cancelled !== null && b.deleteRequest && b.deleteRequest.cancelledAt === null) b.deleteRequest.cancelledAt = cancelled;
    return true;
  }

  /** the final backup, opened now with this service's key and checked to be this cloud's volume: the copy deletion relies on */
  async function finalBackupOpens(c: StoredCloud): Promise<boolean> {
    const final = latestVerified(state(c));
    let problem: string | null = "no_final_backup";
    if (final) {
      try { problem = (await deps.backups.check(c.id, keyOf(c), final.file)).problem; } catch { problem = "unreadable"; }
    }
    if (problem === null) return true;
    log(c, "delete_refused", "reconciler", `backup_${problem}`);
    console.warn(`managed: ALERT cloud ${c.id} is due for deletion but its final backup does not open (${problem}); nothing was deleted`);
    return false;
  }

  async function deleteStep(c: StoredCloud, verdict: Extract<Verdict, { delete: true }>) {
    const b = state(c);
    if (b.deletion && b.deletion.sent === false && (await provider.machine(b.deletion.serverId)) !== null) {
      // a DELETE whose answer never came, and the machine is still there: asked again only if the verdict still says so
      if (!rereadStored(c)) return;
      const again = verdictFor(c);
      if (!again.delete) { log(c, "delete_aborted", "reconciler", again.reason); b.deletion = null; c.status = "stopped"; deps.save(c); return; }
      const answer = await provider.requestDelete(b.deletion.serverId);
      b.deletion.operationId = answer.operationId; b.deletion.sent = true; deps.save(c);
      if (!answer.gone) return;
    }
    if (!b.deletion && c.serverId) {
      // last check against the record, right before the provider is asked
      if (!rereadStored(c)) return;
      const again = verdictFor(c);
      if (!again.delete) { log(c, "delete_refused", "reconciler", again.reason); return; }
      if (again.reason === "retention_over" && !neverSetUp(c) && !(await finalBackupOpens(c))) return;
      // recorded before the call, so a lost answer is never read as a lost machine (and rebuilt)
      c.status = "destroying"; b.deletion = { serverId: c.serverId, operationId: null, at: now(), reason: verdict.reason, sent: false }; deps.save(c);
      log(c, "delete_requested", "reconciler", verdict.reason);
      const answer = await provider.requestDelete(c.serverId);
      b.deletion.operationId = answer.operationId; b.deletion.sent = true;
      log(c, "delete_accepted", "reconciler", verdict.reason, { operation: answer.operationId });
      deps.save(c);
      if (!answer.gone) return;
    }
    if (b.deletion?.operationId) {
      const op = await provider.deletion(b.deletion.operationId);
      if (op && op.status !== "completed") return;
    }
    if (b.deletion && (await provider.machine(b.deletion.serverId)) !== null) return;
    if (b.archive) {
      // the archived home is the data now: the same record check as before a machine's delete
      if (!rereadStored(c)) return;
      const again = verdictFor(c);
      if (!again.delete) { log(c, "delete_refused", "reconciler", again.reason); return; }
      if (again.reason === "retention_over" && !neverSetUp(c) && !(await finalBackupOpens(c))) return;
      await provider.deleteSnapshot(b.archive.snapshotId);
      log(c, "snapshot_deleted", "reconciler", verdict.reason, { snapshot: b.archive.snapshotId });
      b.archive = null; deps.save(c);
    }
    for (const old of b.retired) if (old.snapshotId) {
      await provider.deleteSnapshot(old.snapshotId);
      log(c, "snapshot_deleted", "reconciler", "retired_with_cloud", { snapshot: old.snapshotId }); old.snapshotId = null;
    }
    for (const old of b.retired) if (!old.deletion) {
      const answer = await provider.requestDelete(old.serverId);
      old.deletion = { operationId: answer.operationId, at: now() };
      log(c, "delete_requested", "reconciler", "retired_with_cloud", { operation: answer.operationId });
    }
    if (c.workspaceId) deps.removeWorkspace(c.workspaceId);
    c.destroyedOrigin = c.origin ?? c.destroyedOrigin;
    c.status = "destroyed"; c.setupStep = null; c.origin = null; c.serverId = null; c.ipv4 = null;
    b.deletedAt = now();
    b.backupsDeleteAfter = verdict.reason === "owner_request" ? now() : now() + settings.backupTailMs;
    log(c, "deleted", "reconciler", verdict.reason);
    notice(c, "deleted", now());
    deps.save(c);
  }

  /** backups outlive the machine for a while, then go through the same record check */
  function dropBackupsWhenDue(c: StoredCloud) {
    const b = state(c);
    if (b.deletedAt === null || b.backupsDeleteAfter === null || b.backupsDeleteAfter > now() || !b.backups.length || b.hold) return;
    if (!rereadStored(c) || b.hold) return;
    if (deps.entitlement(c).active) { log(c, "delete_refused", "reconciler", "subscribed"); return; }
    for (const g of b.backups.slice()) { deps.backups.remove(c.id, g.file); b.backups.splice(b.backups.indexOf(g), 1); }
    syncBytes(c);
    log(c, "backups_deleted", "reconciler", b.deletion?.reason ?? "retention_over");
    deps.save(c);
  }

  /** a machine a recovery replaced, or a second one the sweep found: its data cannot be read here and may be newer than
   *  the backup the recovery used, so it is saved whole as a provider snapshot (free) for the operator, kept until the
   *  cloud is deleted, and the machine and the disk we pay for are deleted. */
  async function retiredStep(c: StoredCloud) {
    const b = state(c);
    for (const old of b.retired) {
      if (old.deletion || old.archiveTryAt != null && now() - old.archiveTryAt < HOUR) continue;
      old.archiveTryAt = now(); deps.save(c);
      try {
        // a paused one is resumed to be saved: a start of a second machine, charged to the home like its keep-alive
        const snap = await start(c, "recover", () => provider.archive(old.serverId, snapshotName(old.serverId)), null, true);
        if (snap) { old.snapshotId = snap.id; old.archivedAt = now(); deps.save(c); }
        const answer = snap ? await provider.requestDelete(old.serverId) : { operationId: null };
        old.deletion = { operationId: answer.operationId, at: now() };
        log(c, "retired_deleted", "reconciler", snap ? "archived" : "gone", { old: old.serverId, snapshot: snap?.id ?? null });
        deps.save(c);
      } catch (error) {
        if (error instanceof StartHeldError) continue;
        log(c, "retired_archive_failed", "reconciler", error instanceof ProviderError ? error.code : "retry", { old: old.serverId });
      }
    }
  }
  const snapshotName = (serverId: string) => `madani-${serverId.slice(2)}`;

  /** a plan that ended, with its final backup taken: the home saved whole as a provider snapshot (free) and its machine
   *  deleted, so the retention months cost no disk; a new plan in time boots a machine from it */
  async function archiveEnded(c: StoredCloud) {
    const b = state(c), serverId = c.serverId!;
    if (b.archive?.serverId !== serverId) {
      const snap = await start(c, "wake", () => provider.archive(serverId, snapshotName(serverId)));
      if (!snap) return;
      b.archive = { snapshotId: snap.id, at: now(), serverId, from: serverId }; spendMark(c, false);
      log(c, "archived", "reconciler", "plan_ended", { snapshot: snap.id }); deps.save(c);
    }
    const answer = await provider.requestDelete(serverId);
    log(c, "archive_machine_deleted", "reconciler", "plan_ended", { operation: answer.operationId });
    b.archive!.serverId = null; if (deps.spend) spendNote(c, { e: "disk", rate: 0 });
    c.serverId = null; c.origin = null; b.upstream = null; c.status = "stopped"; deps.save(c);
  }

  /** a new plan for an archived home: a machine booted from its snapshot, with no setup and no restore */
  function restoreArchive(c: StoredCloud) {
    const b = state(c);
    renewed(c);
    b.attempt++; b.restoreSnapshot = b.archive!.snapshotId; b.restoreFrom = null; b.restoredFrom = null; b.claim = null; b.upstream = null; b.setupSince = now();
    c.serverId = null; c.origin = null; c.status = "provisioning"; c.setupStep = "reserving"; c.wantPower = "on"; c.attempts = 0; c.nextAttemptAt = 0; c.error = null;
    log(c, "restore_archive", "billing", "plan_renewed", { snapshot: b.restoreSnapshot });
    deps.save(c);
  }

  /** a machine is lost only after repeated direct 404s spread over `lostAfterMs` and its absence from the account's list */
  async function confirmLost(c: StoredCloud): Promise<boolean> {
    const b = state(c);
    if (!b.missingSince) { b.missingSince = now(); b.missingChecks = 0; log(c, "missing_seen", "reconciler", "first_404"); }
    b.missingChecks = (b.missingChecks ?? 0) + 1;
    if (b.missingChecks < 3 || now() - b.missingSince < settings.lostAfterMs) {
      c.nextAttemptAt = now() + Math.max(60_000, Math.floor(settings.lostAfterMs / 3)); deps.save(c); return false;
    }
    if (c.serverId && await provider.listed(c.serverId)) { log(c, "missing_but_listed", "reconciler", "kept"); b.missingSince = now(); b.missingChecks = 0; deps.save(c); return false; }
    return true;
  }

  /** a plan that ended is paid again: the retention clock, its notices and a pending delete request end */
  function renewed(c: StoredCloud) {
    const b = state(c);
    b.finalWakes = 0;
    if (b.endedAt === null) return;
    b.endedAt = null; b.notices = b.notices.filter(n => !["ended", "left_30", "left_7", "left_1"].includes(n.kind));
    log(c, "plan_renewed", "billing", "record"); notice(c, "resumed", null);
    if (b.deleteRequest && b.deleteRequest.cancelledAt === null) { b.deleteRequest.cancelledAt = now(); b.deleteRequest.tokenHash = null; log(c, "delete_cancelled", "billing", "plan_renewed"); }
  }

  /** retention bookkeeping for a plan that ended: the clock, the notices */
  async function planEnded(c: StoredCloud, entitlement: Entitlement, verdict: Verdict, up: boolean) {
    const b = state(c);
    if (b.endedAt === null) {
      b.endedAt = now();
      log(c, "plan_ended", "billing", "record", { until: entitlement.until });
      if (c.origin && up) await deps.home.plan?.(homeOrigin(c), secret(c), { cancelled: true }).catch(() => {});
      deps.save(c);
    }
    if (verdict.earliestAt !== null) { const kind = dueNotice({ now: now(), earliestAt: verdict.earliestAt, sent: b.notices.map(n => n.kind as NoticeKind) }); if (kind) notice(c, kind, verdict.earliestAt); }
  }

  /** one step; a step that ran through ends a streak of provider limits */
  async function reconcile(c: StoredCloud): Promise<void> {
    await reconcileStep(c);
    const b = state(c);
    if (b.limitStreak || b.setupRetries) { b.limitStreak = 0; b.setupRetries = 0; deps.save(c); }
    if (c.status === "running" || c.status === "sleeping") {
      await egress.step(c, c.status === "running" && b.wakeStartedAt === null).catch(error => console.warn(`managed: the egress check of ${c.id} failed: ${(error as Error).message}`));
    }
  }

  async function reconcileStep(c: StoredCloud): Promise<void> {
    const b = state(c);
    if (c.status === "checkout") return;
    if (c.status === "destroyed") { dropBackupsWhenDue(c); return; }
    pruneBackups(c);
    const entitlement = deps.entitlement(c);
    const verdict = verdictFor(c, entitlement);
    if (verdict.delete || b.deletion) return deleteStep(c, verdict.delete ? verdict : { delete: true, reason: (b.deletion?.reason ?? "retention_over") as "retention_over", earliestAt: now() });
    if (c.status === "provisioning") return provisionStep(c, entitlement.active);
    if (c.setupStep !== null && entitlement.active && c.suspended === null) return c.status === "error" ? setupErrored(c) : resumeSetup(c);
    if (!c.serverId) {
      if (entitlement.active && b.archive && b.archive.serverId === null && c.suspended === null) return restoreArchive(c);
      // an ended plan with no machine (a rebuild held for want of a plan) still gets its notices and keeps its old disks
      if (!entitlement.active) { if (c.status !== "stopped") { c.status = "stopped"; deps.save(c); } await planEnded(c, entitlement, verdict, false); await retiredStep(c); }
      return;
    }
    if (c.suspended !== null) {
      const s = await provider.machine(c.serverId);
      if (s) spendMark(c, s.state !== "stopped");
      if (s && (s.state === "running" || s.state === "starting")) await sleepNow(c, "operator", "operator");
      c.status = "suspended"; c.suspensionApplied = true; deps.save(c); return;
    }
    const s = await provider.machine(c.serverId);
    if (!s) { if (await confirmLost(c)) { spendMark(c, false); return recover(c, "missing"); } return; }
    spendMark(c, s.state !== "stopped");
    if (b.missingSince) { log(c, "missing_cleared", "reconciler", "answered"); b.missingSince = null; b.missingChecks = 0; deps.save(c); }
    // a machine that paused itself (our lease lapsed): its data may have changed up to then
    if (s.state === "stopped" && b.sleptAt === null && s.stoppedAt !== null && s.stoppedAt > (b.lastStopAt ?? 0)) { b.lastStopAt = s.stoppedAt; deps.save(c); }

    if (!entitlement.active) {
      await planEnded(c, entitlement, verdict, s.state === "running");
      const final = latestVerified(b), covered = neverSetUp(c) || final !== null && (b.lastStopAt === null || final.snapshotAt >= b.lastStopAt);
      if (s.state === "running") {
        // InstaBox (seen 2026-11-20) reads a machine as running for minutes after its pause was accepted, or refuses the
        // pause while busy: asked again, with no new stop time that would make the final backup look older than the data
        if (b.sleepReason === "plan" && b.sleptAt !== null && (b.wakeStartedAt ?? 0) <= b.sleptAt) { await provider.power(c.serverId, "off"); return; }
        // the copy retention relies on is read from the running home, right before it sleeps for good
        const quiet = now();
        if (!covered && (b.lastBackupTryAt ?? 0) + BACKUP_RETRY_MS <= now()) await backup(c, "plan_ended").catch(() => false);
        return sleepNow(c, "plan", "billing", quiet);
      }
      if (s.state === "stopped") {
        c.status = "stopped";
        await retiredStep(c);
        if (covered && !b.hold && c.suspended === null && verdict.earliestAt !== null) return archiveEnded(c);
        // asleep with no final backup as new as its data: woken once to take it (a start costs nothing, only seconds)
        // each such wake that brought no backup doubles the wait to the next, up to a day: a home whose backup cannot succeed
        // (too large, refused) is not woken every few minutes until the operator looks. the wait also runs from the wake
        // itself: InstaBox (seen 2026-11-20) reads a resuming machine as paused for minutes
        const finalWakes = b.finalWakes ?? 0, lastTry = Math.max(b.lastBackupTryAt ?? 0, b.wakeStartedAt ?? 0);
        if (!covered && verdict.earliestAt !== null && lastTry + Math.min(BACKUP_RETRY_MS * 2 ** finalWakes, DAY_MS) <= now()) {
          if (finalWakes === 3) console.warn(`managed: ALERT cloud ${c.id}: its plan ended and its final backup keeps failing (${b.backupProblem ?? "unknown"})`);
          await start(c, "wake", () => provider.power(c.serverId!, "on")); b.finalWakes = finalWakes + 1; b.wakeStartedAt = now(); log(c, "wake", "reconciler", "final_backup"); deps.save(c);
        }
      }
      return;
    }
    if (b.endedAt !== null) {
      renewed(c);
      if (c.status === "stopped") { c.status = "sleeping"; c.wantPower = "on"; }
      if (c.origin) await deps.home.plan?.(homeOrigin(c), secret(c), { cancelled: false }).catch(() => {});
    }

    const up = s.state === "running";
    if (s.state === "error") { await start(c, "recover", () => provider.power(c.serverId!, "on")).catch(() => {}); b.wakeStartedAt = now(); log(c, "resume", "reconciler", "provider_error"); deps.save(c); return; }
    if (s.state === "stopped" && egress.paused(c)) {
      // paused for its upload: no wake of any kind until the month ends
      if (c.status !== "sleeping" || b.stayReason !== "egress_paused") { c.status = "sleeping"; b.stayReason = "egress_paused"; deps.save(c); }
      await retiredStep(c);
      return;
    }
    const resizeKey = `${c.desiredSpec.vcpu}-${c.desiredSpec.ramGb}-${c.desiredSpec.diskGb}`;
    const resizeWanted = (c.desiredSpec.vcpu !== c.spec.vcpu || c.desiredSpec.ramGb !== c.spec.ramGb || c.desiredSpec.diskGb !== c.spec.diskGb) && b.resizeBlocked !== resizeKey;
    if (s.state === "stopped" && resizeWanted) {
      // a plan change: the disk stays, the machine boots on the new size, then it is started like any wake
      try { await start(c, "resize", () => provider.resize(c.serverId!, c.desiredSpec)); }
      catch (error) {
        if (error instanceof ProviderError && error.status < 500) { b.resizeBlocked = resizeKey; log(c, "resize_refused", "reconciler", error.code); deps.save(c); return; }
        throw error;
      }
      log(c, "resize", b.resizeAskedAt ? "owner" : "reconciler", "plan_changed", { to: resizeKey });
      c.spec = { ...c.desiredSpec }; b.wakeStartedAt = now(); c.wantPower = "on"; b.resizeAskedAt = null; deps.save(c); return;
    }
    if (s.state === "stopped") {
      // the provider accepts a start before its machine stops reading as stopped: asking again would be a second start,
      // charged and counted against the month's reserve. one that never happened is asked again after the settle time
      if (b.wakeStartedAt !== null && now() - b.wakeStartedAt < WAKE_SETTLE_MS) return;
      const m = memory(c), wanted = c.wantPower === "on";
      // a routine's pre-wake comes from the policy (its spread, the rails); a person's wake is never held for one
      const plan = wanted ? null : deps.sleepPolicy.wake({ now: now(), cloudId: c.id, nextDueAt: b.nextDueAt, upcoming: b.upcoming ?? null, memory: m, spend: spendView(c) });
      const due = plan?.start === true;
      if (plan && !plan.start && b.stayReason !== plan.reason && !["not_yet", "nothing_due"].includes(plan.reason)) { b.stayReason = plan.reason; deps.save(c); }
      if (wanted || due) {
        const intent = wanted && c.wakeRequestedAt !== undefined && now() - c.wakeRequestedAt < 5 * MINUTE;
        if (intent) deps.sleepPolicy.observe(m, c.wakeRequestedAt!, b.wakeBy === "webhook" ? "connector" : "user");
        if (intent) b.wakeBy = null;
        await start(c, intent ? "wake" : due ? "routine" : "wake", () => provider.power(c.serverId!, "on"), due ? plan!.latest : null); b.wakeStartedAt = now(); b.wakeFailureNoted = false; c.wantPower = "on";
        log(c, "wake", intent ? "owner" : "reconciler", due ? "routine_due" : "asked");
        b.wokeFor = !intent && due ? "routine" : "person";
        deps.save(c); return;
      }
      if (c.status !== "sleeping" && c.status !== "stopped") { c.status = "sleeping"; deps.save(c); }
      // the owner paused it while it was already asleep on its own: from now on it is their pause, not ours
      if (c.pauseRequestedAt !== undefined && c.wantPower === "off" && b.sleepReason !== "owner" && b.sleepReason !== "plan") {
        log(c, "sleep", "owner", "owner", { from: b.sleepReason });
        b.sleepReason = "owner"; delete c.pauseRequestedAt; deps.save(c);
      }
      await retiredStep(c);
      return;
    }
    if (!up) return;
    if (egress.paused(c)) return sleepNow(c, "egress", "reconciler");
    if (!c.origin || !b.upstream) publish(c, b.upstream ?? c.origin ?? await provider.origin(c.serverId));
    if (b.wakeStartedAt !== null || c.status !== "running") {
      // a resume that kept memory finds the home running (the start command says so); a cold boot starts it
      const started = await provider.run(c.serverId, image.startCommand(c.origin!, homeOrigin(c)), 120);
      if (!started.ok || !(await deps.home.healthy(homeOrigin(c), secret(c)))) {
        // a start that has not brought the home up in 5 minutes is a failed one, once: enough of them open the breaker
        if (b.wakeStartedAt !== null && now() - b.wakeStartedAt > 5 * MINUTE && !b.wakeFailureNoted) {
          const m = memory(c);
          b.wakeFailureNoted = true;
          if (noteFailure(m, now(), rails)) breakerOpened(c, m);
          deps.save(c);
        }
        throw new RetryableCloudError("Cloud home not answering after a wake.");
      }
      noteHealthy(memory(c)); b.wakeFailureNoted = false;
      await entitle(c, true);
      log(c, "awake", "reconciler", "healthy", { ms: b.wakeStartedAt === null ? null : now() - b.wakeStartedAt });
      c.status = "running"; c.powerSince = now(); b.wakeStartedAt = null; b.sleptAt = null; b.sleepReason = null; b.lastPowerAt = now(); b.leaseAt = now();
      await provider.lease(c.serverId, settings.leaseSeconds);
      deps.save(c); return;
    }
    // the owner asked for a stop, or to apply a plan change now (resized while stopped): only once the start back is paid
    // for under the monthly ceiling, else the home stays up
    if (c.wantPower !== "off" && b.sleepNoticeAt) b.sleepNoticeAt = null;
    if (c.wantPower === "off" || resizeWanted && b.resizeAskedAt) {
      const held = costStopRefusal(spendView(c), now(), true);
      if (!held) {
        if (c.wantPower === "off" && deps.home.sleep && await ownerSleepNotice(c)) return;
        // the due backup is read from the home before it sleeps, as before an idle sleep
        const last = b.backups.at(-1), quiet = now();
        if ((!last || now() - last.at >= settings.backupEveryMs) && (b.lastBackupTryAt ?? 0) + BACKUP_RETRY_MS <= now()) await backup(c, "before_sleep").catch(() => false);
        return sleepNow(c, "owner", "owner", quiet);
      }
      costHeld(c, held.reason, "owner_stop");
    }
    if (b.leaseAt === null || now() - b.leaseAt >= Math.min(30 * MINUTE, settings.leaseSeconds * 500)) { await provider.lease(c.serverId, settings.leaseSeconds); b.leaseAt = now(); deps.save(c); }
    if (b.lastPowerAt !== null && now() - b.lastPowerAt < settings.powerReadMs) return;
    b.lastPowerAt = now();
    await entitle(c, false).catch(() => console.warn(`managed: the entitlement refresh for ${c.id} failed; it is tried again`));
    const power = deps.home.power ? await deps.home.power(homeOrigin(c), secret(c), Math.max(1, Math.round(rails.minIdleMs / MINUTE))).catch(() => null) : null;
    if (await deps.updates?.step(c, { origin: c.origin!, upstream: homeOrigin(c), secret: secret(c), busy: power?.busy ?? null })) { deps.save(c); return; }
    if (!power) { deps.save(c); return; }
    const m = memory(c);
    tallyDay(c, power);
    // holds the home stopped counting as stuck (a hung transfer, a computer or call past its cap): one alert per incident
    const stuckKey = [...(power.stuck ?? [])].sort().join(",");
    if (stuckKey !== (b.stuckAlert ?? "")) {
      b.stuckAlert = stuckKey;
      if (stuckKey) opsAlert(c, "hold_stuck", stuckKey, `cloud ${c.id}: a ${stuckKey} hold ran 6 hours with nothing moving; it no longer keeps the cloud awake`);
    }
    // the dashboard on screen is a hint like the app's focus: the rails cap both from the later of it starting and the last input
    const viewing = b.viewedAt != null && now() - b.viewedAt < VIEW_FRESH_MS;
    const busy = viewing && !power.busy.includes("focus") ? [...power.busy, "focus"] : power.busy;
    b.busy = busy; b.nextDueAt = power.nextDueAt; b.upcoming = power.upcoming ?? null;
    b.focusSince = busy.includes("focus") ? b.focusSince ?? now() : null;
    if (power.lastActivityAt !== null) { deps.sleepPolicy.observe(m, power.lastActivityAt, "user"); noteUse(m, power.lastActivityAt, now()); }
    const snapshot = { now: now(), cloudId: c.id, spec: c.spec, homeIdle: power.idle, awakeSince: c.powerSince, lastActivityAt: power.lastActivityAt, busy, focusSince: b.focusSince ?? null,
      nextDueAt: power.nextDueAt, upcoming: b.upcoming, wakeRequestedAt: c.wakeRequestedAt ?? null, lastWorkAt: power.lastWorkAt ?? null, memory: m, spend: spendView(c) };
    const decision = deps.sleepPolicy.decide(snapshot);
    // the rails again, whatever the policy said: no policy stops a home they hold up
    const next = nextRun(plannedRuns(power.nextDueAt, b.upcoming, now()), now());
    const held = decision.action === "stop" ? stopRefusal({ now: now(), awakeSince: c.powerSince, busy, focusSince: b.focusSince ?? null, lastActivityAt: power.lastActivityAt,
      wakeRequestedAt: c.wakeRequestedAt ?? null, lastWorkAt: power.lastWorkAt ?? null, nextRunAt: next ? runnableFrom(next) : null, memory: m, pool: pool(), profile: deps.costProfile, spend: spendView(c) }, rails) : null;
    const reason = decision.action === "stay" ? decision.reason : held?.reason ?? null;
    if (b.stayReason !== reason) b.stayReason = reason;
    if (power.idle && decision.action === "stop" && !held && deps.home.sleep) {
      // backups are read from the running home: the due one is taken now, while it is idle
      const last = b.backups.at(-1), quiet = now();
      if ((!last || now() - last.at >= settings.backupEveryMs) && (b.lastBackupTryAt ?? 0) + BACKUP_RETRY_MS <= now()) await backup(c, "before_sleep").catch(() => false);
      const agreed = await deps.home.sleep(homeOrigin(c), secret(c), decision.idleMinutes);
      if (agreed.ok) {
        b.nextDueAt = agreed.nextDueAt ?? power.nextDueAt;
        await sleepNow(c, "idle", "reconciler", quiet);
        noteStop(memory(c), now()); deps.save(c); return;
      }
    }
    // a home that never sleeps still gets a backup
    const last = b.backups.at(-1);
    if (now() - (last?.at ?? c.provisionedAt ?? c.createdAt) >= 2 * settings.backupEveryMs && (b.lastBackupTryAt ?? 0) + 6 * HOUR <= now()) await backup(c, "awake_overdue").catch(() => false);
    deps.save(c);
  }

  // owner's delete request: never acts at once; the reconciler deletes after the undo window, through the same verdict
  const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
  /** the machine's one-time claim, answered once (again within 10 minutes, for a lost answer) with what its boot file used to carry */
  function redeemClaim(cloudId: unknown, claim: unknown): Record<string, unknown> | null {
    if (typeof cloudId !== "string" || typeof claim !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(claim)) return null;
    const c = deps.clouds().find(x => x.id === cloudId && x.backend && x.status === "provisioning");
    const held = c?.managed?.claim;
    if (!c || !held || held.expiresAt < now() || (held.redeemedAt !== null && now() - held.redeemedAt > 5 * MINUTE)) return null;
    const given = Buffer.from(createHash("sha256").update(claim).digest("hex")), want = Buffer.from(held.hash);
    if (given.length !== want.length || !timingSafeEqual(given, want) || !c.workspaceId || !c.linkPublicKey || !c.sealedLinkPrivateKey) return null;
    if (held.redeemedAt === null) { held.redeemedAt = now(); log(c, "claim_redeemed", "system", "first_boot"); deps.save(c); }
    else {
      // a lost answer, or someone else holding the claim: either way the operator hears of it
      log(c, "claim_redeemed_again", "system", "operator_checks");
      console.warn(`managed: ALERT cloud ${c.id}: its machine claim was redeemed a second time`);
    }
    const link = { v: 1 as const, url: deps.dashboardUrl, workspaceId: c.workspaceId, publicKey: c.linkPublicKey, privateKey: deps.unseal(c.sealedLinkPrivateKey), enrolledAt: c.provisionedAt ?? now(), claimed: true };
    return image.bootContent({ cloudId: c.id, adminOrigin: deps.adminOrigin, secret: secret(c), dashboardUrl: deps.dashboardUrl, link, ...(c.team ? { team: c.team } : {}) });
  }
  function edgeCloud(value: string): StoredCloud | null {
    if (!/^d[0-9a-f]{20}$/.test(value)) return null;
    return deps.clouds().find(x => x.backend && x.managed?.label === value && x.status !== "destroyed" && x.status !== "destroying") ?? null;
  }
  /** only a paid, unsuspended home that is up or idle-asleep: never one stopped for its plan, an operator or a delete */
  function edgeWakeable(c: StoredCloud): boolean {
    return (c.status === "running" || c.status === "sleeping") && !c.ended && c.suspended === null && (c.destroyAt === null || c.destroyAt > now())
      && deps.entitlement(c).active && !egress.paused(c) && !(state(c).deleteRequest?.confirmedAt && state(c).deleteRequest?.cancelledAt === null) && state(c).deletion === null;
  }
  return {
    redeemClaim,
    /** the edge's lookup: the machine's own hosted URL behind a public label */
    upstreamFor(value: string): string | null { return edgeCloud(value)?.managed?.upstream ?? null; },
    cloudOfLabel(value: string): string | undefined { return edgeCloud(value)?.id; },
    /** the label was a home that has been deleted, and no live home has it: the edge says gone, never "not found yet" */
    edgeGone(value: string): boolean {
      if (!/^d[0-9a-f]{20}$/.test(value) || edgeCloud(value)) return false;
      return deps.clouds().some(x => x.managed?.label === value && (x.status === "destroyed" || x.status === "destroying"));
    },
    /** the same, and whether the home answers now: the edge forwards to an awake home and wakes a sleeping one */
    edgeRoute(value: string): { upstream: string; awake: boolean; wakeable: boolean } | null {
      const c = edgeCloud(value), upstream = c?.managed?.upstream;
      if (!c || !upstream) return null;
      return { upstream, awake: c.status === "running" && state(c).wakeStartedAt === null, wakeable: edgeWakeable(c) };
    },
    /** a request at the edge for a sleeping home (a webhook, the app): woken like the owner's own wake, under its own hourly cap */
    edgeWake(value: string, reason: "webhook" | "client"): { ok: boolean; status: number } {
      const c = edgeCloud(value);
      if (!c || !edgeWakeable(c)) return { ok: false, status: 409 };
      if (c.status === "running" && state(c).wakeStartedAt === null) return { ok: true, status: 200 };
      const b = state(c), recent = (b.edgeWakes ?? []).filter(t => t > now() - HOUR);
      // anyone can reach a public name: each wake is a provider start, so strangers get a small budget, never an open tap
      if (c.wantPower !== "on" && recent.length >= settings.edgeWakesPerHour) { b.edgeWakes = recent; deps.save(c); return { ok: false, status: 429 }; }
      if (c.wantPower !== "on") { recent.push(now()); log(c, "wake_asked", "edge", reason); }
      b.edgeWakes = recent; b.wakeBy = reason; c.wantPower = "on"; c.wakeRequestedAt = now(); c.nextAttemptAt = 0; deps.save(c);
      return { ok: true, status: 202 };
    },
    reconcile,
    /** after each pass: any cloud flagged for a day awake over half of it without bot work gets one ops alert for all of them */
    dailyCheck(clouds: readonly StoredCloud[]) {
      const at = now(), flagged = clouds.filter(c => c.managed && (state(c).flaggedDay ?? null) !== null);
      // a cloud that slept through midnight finishes its day at its next power read; one with no read today finishes here
      for (const c of clouds) {
        const b = c.managed ? state(c) : null;
        if (b?.awakeDay && b.awakeDay.day !== dayOf(at) && at - b.awakeDay.at > 10 * MINUTE) {
          if (b.awakeDay.awakeMs - b.awakeDay.workMs > 12 * HOUR) { b.flaggedDay = { day: b.awakeDay.day, awakeMs: b.awakeDay.awakeMs, workMs: b.awakeDay.workMs }; if (!flagged.includes(c)) flagged.push(c); }
          b.awakeDay = null; deps.save(c);
        }
      }
      if (!flagged.length) return;
      const lines = flagged.map(c => { const f = state(c).flaggedDay!; return `${c.id} ${f.day}: awake ${(f.awakeMs / HOUR).toFixed(1)} h, bot work ${(f.workMs / HOUR).toFixed(1)} h`; });
      opsAlert(null, "awake_without_work", `${flagged.length}_clouds`, `clouds awake over half a day with no work, routine or use to explain it: ${lines.join("; ")}`.slice(0, 900));
      for (const c of flagged) { log(c, "awake_without_work", "reconciler", state(c).flaggedDay!.day); state(c).flaggedDay = null; deps.save(c); }
    },
    /** its owner has the dashboard open on it (VIEW_FRESH_MS): a hint for the power policy, never use, never a wake */
    noteView(c: StoredCloud) {
      if (!c.managed || c.status !== "running") return;
      const b = state(c), at = now();
      const stale = b.viewedAt == null || at - b.viewedAt >= MINUTE;
      b.viewedAt = at;
      if (stale) deps.save(c);
    },
    egress: (c: StoredCloud) => egress.view(c),
    verdict: (c: StoredCloud) => verdictFor(c),
    /** its data is still kept: within retention, with no deletion under way */
    revivable(c: StoredCloud) {
      if (c.status === "destroyed" || c.status === "destroying" || state(c).deletion) return false;
      const verdict = verdictFor(c);
      return !verdict.delete && (verdict.earliestAt === null || now() < verdict.earliestAt);
    },
    backup: (c: StoredCloud) => backup(c, "manual"),
    /** a backup now, asked by its owner's app once a move into it was checked: only while it runs, and at most once per
     *  BACKUP_RETRY_MS whoever asks, so asking again never costs more than the schedule's own tries */
    async backupNow(c: StoredCloud): Promise<boolean> {
      const b = state(c);
      if (!c.managed || c.status !== "running" || (b.lastBackupTryAt ?? 0) + BACKUP_RETRY_MS > now()) return false;
      return backup(c, "after_move");
    },
    requestDelete(c: StoredCloud, link: (token: string) => string) {
      const b = state(c);
      if (c.status === "destroyed" || c.status === "destroying") throw new ManagedCloudError(409, "unavailable");
      if (deps.entitlement(c).active) throw new ManagedCloudError(409, "billing_active");
      const token = randomBytes(32).toString("base64url");
      b.deleteRequest = { requestedAt: now(), tokenHash: hashToken(token), tokenExpiresAt: now() + HOUR, confirmedAt: null, executeAfter: null, cancelledAt: null };
      log(c, "delete_asked", "owner", "email_sent");
      deps.save(c);
      notice(c, "delete_requested", null, link(token));
    },
    confirmDelete(c: StoredCloud, token: string) {
      const b = state(c), request = b.deleteRequest;
      if (!request || request.cancelledAt !== null || request.confirmedAt !== null || !request.tokenHash || request.tokenExpiresAt === null || request.tokenExpiresAt < now()) throw new ManagedCloudError(409, "confirmation_required");
      const given = Buffer.from(hashToken(token)), want = Buffer.from(request.tokenHash);
      if (given.length !== want.length || !timingSafeEqual(given, want)) throw new ManagedCloudError(409, "confirmation_required");
      if (deps.entitlement(c).active) throw new ManagedCloudError(409, "billing_active");
      request.confirmedAt = now(); request.executeAfter = now() + settings.deleteDelayDays * DAY_MS; request.tokenHash = null; request.tokenExpiresAt = null;
      log(c, "delete_confirmed", "owner", "email_link", { executeAfter: request.executeAfter });
      deps.save(c);
      notice(c, "delete_scheduled", request.executeAfter);
      return request.executeAfter;
    },
    operatorDelete(c: StoredCloud, reason: string) {
      const b = state(c);
      if (c.status === "destroyed" || c.status === "destroying") throw new ManagedCloudError(409, "unavailable");
      if (deps.entitlement(c).active) throw new ManagedCloudError(409, "billing_active");
      b.deleteRequest = { requestedAt: now(), tokenHash: null, tokenExpiresAt: null, confirmedAt: now(), executeAfter: now(), cancelledAt: null };
      log(c, "delete_confirmed", "operator", reason);
      c.nextAttemptAt = 0; deps.save(c);
    },
    /** its account was deleted (the website, the app or the phone): confirmed at once, whatever the plan said; a hold
     *  still stops it. the reconciler deletes the machine and its archive and asks again until the provider confirms */
    accountDeleted(c: StoredCloud) {
      const b = state(c);
      if (c.status === "destroyed" || c.status === "destroying" || b.deletion) return;
      if (b.deleteRequest?.confirmedAt && b.deleteRequest.cancelledAt === null && b.deleteRequest.executeAfter !== null && b.deleteRequest.executeAfter <= now()) return;
      b.deleteRequest = { requestedAt: now(), tokenHash: null, tokenExpiresAt: null, confirmedAt: now(), executeAfter: now(), cancelledAt: null };
      log(c, "delete_confirmed", "owner", "account_deleted");
      c.nextAttemptAt = 0; deps.save(c);
    },
    cancelDelete(c: StoredCloud) {
      const b = state(c);
      if (!b.deleteRequest || b.deleteRequest.cancelledAt !== null || b.deletion || c.status === "destroying" || c.status === "destroyed") throw new ManagedCloudError(409, "unavailable");
      b.deleteRequest.cancelledAt = now(); b.deleteRequest.tokenHash = null;
      log(c, "delete_cancelled", "owner", "undo");
      deps.save(c);
      notice(c, "delete_cancelled", null);
    },
    /** apply a pending plan change now instead of at the next idle sleep */
    resizeNow(c: StoredCloud) { state(c).resizeAskedAt = now(); c.nextAttemptAt = 0; deps.save(c); },
    resizing(c: StoredCloud) { return c.desiredSpec.vcpu !== c.spec.vcpu || c.desiredSpec.ramGb !== c.spec.ramGb || c.desiredSpec.diskGb !== c.spec.diskGb || state(c).wakeStartedAt !== null; },
    /** when a failed step runs again; null: the clouds service's own backoff */
    /** a provider limit (429) is no failure: backed off 30 s doubling to 5 minutes (or as long as it asks), never counted */
    retryAt(c: StoredCloud, error: unknown): number | null {
      const b = state(c);
      // the rails held a start back, or the pool is full: waiting, not failing
      if (error instanceof StartHeldError || error instanceof StartCapError) return Math.max(now() + 5_000, error.retryAt);
      if (!(error instanceof ProviderLimitError)) {
        if (b.limitStreak) { b.limitStreak = 0; deps.save(c); }
        // a provider outage during a first setup waits it out (30 s doubling to 15 minutes) for up to SETUP_PATIENCE_MS
        if (c.status === "provisioning" && error instanceof RetryableCloudError && now() - (b.setupSince ?? c.provisionedAt ?? c.createdAt) < SETUP_PATIENCE_MS) {
          b.setupRetries = (b.setupRetries ?? 0) + 1; deps.save(c);
          return now() + Math.min(15 * MINUTE, 30_000 * 2 ** Math.min(b.setupRetries - 1, 5));
        }
        return null;
      }
      // setup keeps its 45-minute ceiling: past it a limit fails setup like any other cause
      if (c.status === "provisioning" && now() - (b.setupSince ?? c.provisionedAt ?? c.createdAt) > 45 * MINUTE) return null;
      b.limitStreak = (b.limitStreak ?? 0) + 1;
      if (b.limitStreak === 1) log(c, "provider_limit", "reconciler", "rate_limited");
      if (b.limitStreak === 12) { log(c, "provider_limit_long", "reconciler", "operator_decides"); console.warn(`managed: ALERT cloud ${c.id}: the provider has refused it 12 times in a row (rate or quota limit)`); }
      const backoff = Math.min(5 * MINUTE, 30_000 * 2 ** Math.min(b.limitStreak - 1, 4));
      deps.save(c);
      const notBefore = error.info.nextStartAt !== null ? Math.min(error.info.nextStartAt - now(), 15 * MINUTE) : 0;
      return now() + Math.max(backoff, Math.min(error.retryAfterMs ?? 0, 15 * MINUTE), notBefore);
    },
    setHold(c: StoredCloud, hold: boolean) { state(c).hold = hold; log(c, hold ? "hold" : "hold_released", "operator", "manual"); deps.save(c); },
  };
}
export type Lifecycle = ReturnType<typeof createLifecycle>;
