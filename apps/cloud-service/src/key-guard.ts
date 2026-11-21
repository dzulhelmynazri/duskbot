// The backup secret may not change under existing backups: they would no longer open, and retention would then delete
// a sandbox whose only copy is a backup nobody can read. Its fingerprint lives beside the data; a different secret refuses
// to start unless the previous one is given, and then every backup is sealed again with the new one first.
import { createHmac } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FILE = "backup-key.fingerprint";
export const backupFingerprint = (secret: Buffer) => createHmac("sha256", secret).update("omb-home-backup-fingerprint").digest("hex");

export class BackupSecretChangedError extends Error {
  constructor() {
    super("The backup secret changed (MADANI_MANAGED_BACKUP_KEY or MADANI_CLOUD_SEAL_KEY), so existing backups would no longer open. Set the old one as MADANI_MANAGED_BACKUP_KEY_PREVIOUS to seal them again with the new one, or put the old one back.");
    this.name = "BackupSecretChangedError";
  }
}

/**
 * Checks the secret against the stored fingerprint. With none stored yet (a first start, or backups from before this check),
 * `opens(secret)` says whether the newest backup opens with it (null: there are no backups). `rekey(previous)` seals every
 * backup again with the new secret before the new fingerprint is recorded.
 */
export function guardBackupSecret(dataDir: string, secret: Buffer, previous: Buffer | null, rekey: (previous: Buffer) => void, opens: (secret: Buffer) => boolean | null): void {
  const path = join(dataDir, FILE), current = backupFingerprint(secret);
  const stored = existsSync(path) ? readFileSync(path, "utf8").trim() : null;
  if (stored === current) return;
  if (stored === null && opens(secret) !== false) { writeFileSync(path, `${current}\n`, { mode: 0o600 }); return; }
  if (previous && (stored === null ? opens(previous) === true : stored === backupFingerprint(previous))) {
    rekey(previous);
    writeFileSync(path, `${current}\n`, { mode: 0o600 });
    return;
  }
  throw new BackupSecretChangedError();
}
