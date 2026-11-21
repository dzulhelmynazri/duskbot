import { DATA_DIR } from "./config.ts";
import type { StandaloneRelease } from "./contracts.ts";
import { OPENCODE_STANDALONE } from "./drivers/acp/opencode-release.ts";
import { installStandaloneEngine, standaloneAssetFor, type StandaloneInstallOptions, type StandaloneInstalled } from "./engine-standalone.ts";
import { findCliCandidates } from "./env-path.ts";
import { trail, trailError } from "./trail.ts";

/** Set by whatever starts the server where OpenCode's free backup should be ready before the first message: the desktop
 * app and a madani cloud home. */
export const PREINSTALL_FREE_BACKUP_ENV = "MADANI_PREINSTALL_FREE_BACKUP";

export interface FreeBackupPreinstall {
  outcome: "present" | "installed" | "unsupported" | "failed";
  error?: string;
}

export interface FreeBackupPreinstallDeps {
  baseDir?: string;
  release?: StandaloneRelease;
  present?: () => boolean;
  install?: (release: StandaloneRelease, options: StandaloneInstallOptions) => Promise<StandaloneInstalled>;
  now?: () => number;
  /** waits before each further try after a failed one */
  retryMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

export const FREE_BACKUP_RETRY_MS: readonly number[] = [15_000, 60_000];

const pause = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.(); });

let pending: Promise<FreeBackupPreinstall> | null = null;

/** OpenCode's own build through the same install Settings uses, unless a copy (the app's or the person's) is already
 * found. A failed try is retried a few times. Never rejects: the outcome goes to the trail. Overlapping calls share one run. */
export function preinstallFreeBackup(deps: FreeBackupPreinstallDeps = {}): Promise<FreeBackupPreinstall> {
  pending ??= preinstallOnce(deps)
    .catch((error: unknown): FreeBackupPreinstall => {
      trailError("free_backup.preinstall", error, { outcome: "failed" });
      return { outcome: "failed", error: error instanceof Error ? error.message : String(error) };
    })
    .finally(() => { pending = null; });
  return pending;
}

async function preinstallOnce(deps: FreeBackupPreinstallDeps): Promise<FreeBackupPreinstall> {
  const release = deps.release ?? OPENCODE_STANDALONE;
  const present = deps.present ?? (() => findCliCandidates(release.engine).length > 0);
  if (present()) return { outcome: "present" };
  if (!standaloneAssetFor(release)) {
    trail("free_backup.preinstall", { outcome: "unsupported" });
    return { outcome: "unsupported" };
  }
  const now = deps.now ?? Date.now;
  const retries = deps.retryMs ?? FREE_BACKUP_RETRY_MS;
  const startedAt = now();
  trail("free_backup.preinstall", { outcome: "started", version: release.version });
  for (let attempt = 0; ; attempt += 1) {
    try {
      await (deps.install ?? installStandaloneEngine)(release, { baseDir: deps.baseDir ?? DATA_DIR });
      trail("free_backup.preinstall", { outcome: "installed", version: release.version, ms: now() - startedAt, tries: attempt + 1 });
      return { outcome: "installed" };
    } catch (error) {
      const wait = retries[attempt];
      if (wait === undefined) {
        trailError("free_backup.preinstall", error, { outcome: "failed", ms: now() - startedAt, tries: attempt + 1 });
        return { outcome: "failed", error: error instanceof Error ? error.message : String(error) };
      }
      trailError("free_backup.preinstall", error, { outcome: "retrying", tries: attempt + 1, waitMs: wait });
      await (deps.sleep ?? pause)(wait);
      if (present()) return { outcome: "present" };
    }
  }
}

/** At boot: starts the preinstall without waiting on it when `env` asks for one; `installed` runs once a copy was added. */
export function startFreeBackupPreinstall(
  env: NodeJS.ProcessEnv,
  installed: () => void,
  deps: FreeBackupPreinstallDeps = {},
): Promise<FreeBackupPreinstall> | null {
  if (env[PREINSTALL_FREE_BACKUP_ENV] !== "1") return null;
  const run = preinstallFreeBackup(deps);
  void run.then(({ outcome }) => { if (outcome === "installed") installed(); })
    .catch((error: unknown) => trailError("free_backup.installed", error));
  return run;
}
