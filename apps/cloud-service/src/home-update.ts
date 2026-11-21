// Updates a running managed home can't be broken by (shared/update-guard.ts). The newest release this service offers
// (MADANI_MANAGED_HOME_RELEASE_FILE, read again when it changes, else the package it was started with; a release file that
// lists cloud ids is offered to those clouds only, the rest keep the package the service started with) is installed only
// when its signature verifies, it is newer than what the home runs, at or above the signed floor and not blocked, and
// only while the home is idle: no turn, routine run, upload or backup. The home self-tests on the new version
// (server/update-state.ts); a failed self-test, or the next two runs failing in a row, rolls it back to the version
// before (`omb-home rollback`, never below the floor). The home itself tells its owner, in one line.
import { readFileSync, statSync } from "node:fs";
import { acceptPolicy, freshUpdateRecord, idleForUpdate, refusal, review, rolledBack, sawRun, selfTested, settle, startTrial, type Release, type UpdatePolicy, type UpdateRecord, type Verdict } from "../../../shared/update-guard.ts";
import { RetryableCloudError } from "../../dashboard/server/clouds/http.ts";
import type { HomeClient, StoredCloud } from "../../dashboard/server/clouds/types.ts";
import type { Audit } from "./audit.ts";
import type { MachineImage, MachineProvider } from "./provider.ts";
import { verifyRelease, type ReleaseKey } from "./release-signing.ts";

/** a home package on offer: its signature names its version; an unsigned one (loopback and the e2e harness only) may say it */
export interface HomeRelease { sha256: string; url?: string; file?: string; signature?: string; version?: string; clouds?: readonly string[] }
export interface HomeUpdateState { guard: UpdateRecord; refused: string | null; stuck: boolean; retryAt: number | null }

/** how long a new version gets to answer and pass its self-test */
export const SELF_TEST_WAIT_MS = 5 * 60_000;
const INSTALL_RETRY_MS = 60 * 60_000;
const SHA256 = /^[a-f0-9]{64}$/;

/** MADANI_MANAGED_HOME_RELEASE_FILE: `{ sha256, signature, url | file, clouds? }`, read again whenever it changes; `clouds`
 * (cloud ids) limits the offer to those clouds, for a canary, and an empty or missing list offers it to every cloud */
export function createReleaseFile(file: string | null | undefined): () => HomeRelease | null {
  let held: { mtime: number; value: HomeRelease | null } | null = null;
  return () => {
    if (!file) return null;
    let mtime: number;
    try { mtime = statSync(file).mtimeMs; } catch { return held?.value ?? null; }
    if (held?.mtime !== mtime) {
      let value: HomeRelease | null = null;
      try {
        const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
        if (typeof raw.sha256 === "string" && SHA256.test(raw.sha256) && (typeof raw.url === "string" || typeof raw.file === "string")) {
          value = { sha256: raw.sha256, ...(typeof raw.url === "string" ? { url: raw.url } : { file: raw.file as string }),
            ...(typeof raw.signature === "string" ? { signature: raw.signature } : {}), ...(typeof raw.version === "string" ? { version: raw.version } : {}),
            ...(Array.isArray(raw.clouds) && raw.clouds.length ? { clouds: raw.clouds.filter((id): id is string => typeof id === "string") } : {}) };
        }
      } catch { value = held?.value ?? null; }
      held = { mtime, value };
    }
    return held.value;
  };
}

export const offeredTo = (release: HomeRelease, cloudId: string) => !release.clouds?.length || release.clouds.includes(cloudId);

export interface HomeUpdateDeps {
  provider: MachineProvider;
  image: MachineImage;
  home: HomeClient;
  audit: Audit;
  releaseKeys: readonly ReleaseKey[];
  requireSigned: boolean;
  /** what this service offers now, newest first: the release file, then the package it started with */
  releases(): Array<HomeRelease | null>;
  policy(): UpdatePolicy | null;
  now(): number;
  save(cloud: StoredCloud): void;
}

/** what the reconciler knows of the home this pass */
export interface HomeUpdateContext { origin: string; upstream: string; secret: string; busy: readonly string[] | null }

export function createHomeUpdates(deps: HomeUpdateDeps) {
  const log = (c: StoredCloud, action: string, reason: string, detail?: Record<string, string | number | boolean | null>, actor: "reconciler" | "operator" = "reconciler") =>
    deps.audit.record({ cloudId: c.id, action, actor, reason, serverId: c.serverId, ...(detail ? { detail } : {}) });

  function versionOf(pkg: HomeRelease): string | null {
    if (pkg.signature) {
      try { return verifyRelease(pkg.signature, { kind: "home-package", sha256: pkg.sha256 }, deps.releaseKeys).version; } catch { return null; }
    }
    return deps.requireSigned ? null : pkg.version ?? null;
  }
  function known(sha256: string | null): Release | null {
    if (!sha256) return null;
    const pkg = deps.releases().find(p => p?.sha256 === sha256);
    const version = pkg ? versionOf(pkg) : null;
    return version ? { version, sha256 } : null;
  }
  function stateOf(c: StoredCloud): HomeUpdateState {
    const b = c.managed!;
    const u = (b.update ??= { guard: freshUpdateRecord(known(b.installed)), refused: null, stuck: false, retryAt: null });
    // a fresh machine (a recovery, a rebuild) runs whatever its setup installed: that is the version now, with nothing before it
    if (!u.guard.trial && b.installed && u.guard.current?.sha256 !== b.installed) { u.guard.current = known(b.installed); u.guard.previous = null; }
    return u;
  }

  async function rollback(c: StoredCloud, x: HomeUpdateContext, u: HomeUpdateState, verdict: Extract<Verdict, { action: "rollback" }>) {
    const from = u.guard.current?.version ?? null;
    const done = await deps.provider.run(c.serverId!, deps.image.rollbackCommand, 300);
    if (!done.ok || !done.stdout.includes("rolled back")) {
      log(c, "update_rollback_failed", verdict.reason, { from, to: verdict.to.version });
      console.warn(`managed: ALERT cloud ${c.id}: the rollback from ${from} to ${verdict.to.version} failed; it is tried again`);
      throw new RetryableCloudError("Cloud update rollback failed.");
    }
    const { failedRuns } = rolledBack(u.guard, verdict.to, verdict.reason, deps.now());
    c.managed!.installed = verdict.to.sha256; u.stuck = false;
    log(c, "update_rolled_back", verdict.reason, { from, to: verdict.to.version, rerunFree: failedRuns.length });
    console.warn(`managed: ALERT cloud ${c.id}: the update to ${from} was rolled back to ${verdict.to.version} (${verdict.reason})`);
    deps.save(c);
    const started = await deps.provider.run(c.serverId!, deps.image.startCommand(x.origin, x.upstream), 120);
    if (!started.ok) throw new RetryableCloudError("Cloud home did not start after a rollback.");
  }

  /** the trial's verdict this pass: the home's own report of its self-test and runs; null while its self-test runs */
  async function judge(x: HomeUpdateContext, u: HomeUpdateState): Promise<Verdict | null> {
    const trial = u.guard.trial!, now = deps.now();
    const report = await deps.home.update?.(x.upstream, x.secret).catch(() => null) ?? null;
    let verdict: Verdict = { action: "wait" };
    if (trial.selfTest === "pending") {
      const elsewhere = report !== null && report.version !== null && report.version !== trial.to.version;
      if (report?.selfTest === "failed" || elsewhere || (report?.selfTest !== "passed" && now - trial.at > SELF_TEST_WAIT_MS)) verdict = selfTested(u.guard, false, now);
      else if (report?.selfTest === "passed") verdict = selfTested(u.guard, true, now);
      else return null;
    }
    for (const run of report?.runs ?? []) if (verdict.action === "wait" && run.at >= trial.at) verdict = sawRun(u.guard, run, now);
    return verdict.action === "wait" ? review(u.guard, now) : verdict;
  }

  /**
   * One update step for a running home, after its power read. True when the step used this pass (an install, a rollback,
   * a self-test still running): the reconciler stops there, and never sleeps a home in the middle of one.
   */
  async function step(c: StoredCloud, x: HomeUpdateContext): Promise<boolean> {
    if (!c.serverId || !c.managed) return false;
    const u = stateOf(c), now = deps.now();
    const policy = deps.policy();
    if (policy && acceptPolicy(u.guard, policy)) { log(c, "update_policy", "signed", { serial: policy.serial, floor: policy.floor, blocked: policy.blocked.length }); deps.save(c); }
    const verdict = u.guard.trial ? await judge(x, u) : review(u.guard, now);
    if (verdict === null) { deps.save(c); return true; }
    if (verdict.action === "settle") { const to = u.guard.trial!.to.version; settle(u.guard, now); log(c, "update_settled", "trial_passed", { version: to }); deps.save(c); return false; }
    if (verdict.action === "stuck") {
      if (!u.stuck) { u.stuck = true; log(c, "update_stuck", verdict.reason, { version: u.guard.current?.version ?? null }); console.warn(`managed: ALERT cloud ${c.id}: ${u.guard.current?.version} should be rolled back (${verdict.reason}) but nothing allowed is left to go back to`); deps.save(c); }
      return false;
    }
    if (verdict.action === "rollback") {
      // a failed self-test follows an install at an idle moment; anything later waits for one, so no run is cut short
      if (verdict.reason !== "self_test" && !(x.busy && idleForUpdate(x.busy))) return false;
      await rollback(c, x, u, verdict);
      return true;
    }
    if (u.guard.trial || !x.busy) return false;
    const pkg = deps.releases().find((p): p is HomeRelease => p !== null && offeredTo(p, c.id));
    if (!pkg || pkg.sha256 === c.managed.installed) return false;
    const version = versionOf(pkg), offer = version ? { version, sha256: pkg.sha256 } : null;
    const why = offer ? refusal(u.guard, offer) : "invalid";
    if (why) {
      if (u.refused !== `${pkg.sha256}:${why}`) { u.refused = `${pkg.sha256}:${why}`; log(c, "update_refused", why, { version }); deps.save(c); }
      return false;
    }
    // staged: it waits for an idle moment
    if (!idleForUpdate(x.busy) || (u.retryAt !== null && u.retryAt > now)) return false;
    if (pkg.file) await deps.provider.upload(c.serverId, deps.image.packagePath, readFileSync(pkg.file));
    const floor = pkg.signature ? u.guard.policy.floor : null;
    const done = await deps.provider.run(c.serverId, deps.image.installCommand(pkg.sha256, pkg.url, pkg.signature, floor), 600);
    if (!done.ok || !done.stdout.includes("installed")) {
      u.retryAt = now + INSTALL_RETRY_MS;
      log(c, "update_install_failed", done.stdout.includes("older package") ? "older" : done.stdout.includes("below floor") ? "below_floor" : "install", { version: offer!.version });
      deps.save(c);
      return true;
    }
    const from = u.guard.current?.version ?? null;
    startTrial(u.guard, offer!, now); u.retryAt = null; u.refused = null; c.managed.installed = pkg.sha256;
    log(c, "update_applied", "idle", { from, to: offer!.version });
    deps.save(c);
    const started = await deps.provider.run(c.serverId, deps.image.startCommand(x.origin, x.upstream), 120);
    if (!started.ok) {
      const failed = selfTested(u.guard, false, deps.now());
      if (failed.action === "rollback") await rollback(c, x, u, failed);
    }
    return true;
  }

  /** the operator ends a version's trial early (a test cloud whose routines don't run): only once its self-test passed,
   *  so a newer release may install at the next idle moment; audited with the operator's reason */
  function endTrial(c: StoredCloud, reason: string): { ended: string } | { refused: "no_trial" | "self_test_pending" } {
    const u = c.managed?.update;
    if (!u?.guard.trial) return { refused: "no_trial" };
    if (u.guard.trial.selfTest !== "passed") return { refused: "self_test_pending" };
    const version = u.guard.trial.to.version;
    settle(u.guard, deps.now());
    log(c, "update_settled", "operator", { version, why: reason }, "operator");
    deps.save(c);
    return { ended: version };
  }
  return { step, endTrial, state: (c: StoredCloud) => c.managed?.update ?? null };
}
export type HomeUpdates = ReturnType<typeof createHomeUpdates>;
