// A managed Cloud's volume backup holds every key its sealed records need: restored into a fresh home, each Vault item
// opens. The volume is laid out as a managed home runs it (HOME=/data, the data folder /data/.madanibot, no XDG config
// folder), snapshotted with the snapshot's own exclusions (PLATFORM_ENTRIES) and restored as omb-home restore does it.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { PLATFORM_ENTRIES } from "../apps/cloud-service/src/home.ts";
import { CLOUD_HOME } from "../electron/legacy-names.mjs";
import { serverEnvironmentAllowed } from "./cloud-home-start.ts";
import { LoginStore } from "./login-store.ts";
import { fileSavedSecretsKey, SavedSecretStore } from "./saved-secrets.ts";

const KEPT_ENV = ["HOME", "XDG_CONFIG_HOME", "MADANI_SAVED_SECRETS_KEY_FILE"] as const;
let saved: Partial<Record<(typeof KEPT_ENV)[number], string | undefined>> = {};
let root = "";

beforeEach(() => {
  saved = Object.fromEntries(KEPT_ENV.map((name) => [name, process.env[name]]));
  root = mkdtempSync(join(tmpdir(), "madani-backup-keys-"));
});
afterEach(() => {
  for (const name of KEPT_ENV) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
  rmSync(root, { recursive: true, force: true });
});

/** Every file under `dir` but the platform's own entries, with its mode. */
function files(dir: string): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (folder: string) => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      const info = lstatSync(path);
      if (info.isDirectory()) walk(path);
      else out[relative(dir, path)] = info.mode & 0o777;
    }
  };
  walk(dir);
  return out;
}

it("restores a managed Cloud's backup into a fresh home that opens every Vault item, its keys owner-only", () => {
  // the server's environment on a managed home never takes another config folder or key file
  expect(serverEnvironmentAllowed("XDG_CONFIG_HOME")).toBe(false);
  expect(serverEnvironmentAllowed("MADANI_SAVED_SECRETS_KEY_FILE")).toBe(false);

  const volume = join(root, "data");
  const dataDir = join(volume, CLOUD_HOME.dataName);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  process.env.HOME = volume;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.MADANI_SAVED_SECRETS_KEY_FILE;
  // the platform's own folders, which a backup leaves out
  mkdirSync(join(volume, "config"));
  writeFileSync(join(volume, "config", "platform.json"), "{}");
  writeFileSync(join(volume, ".omb-cloud-home.json"), JSON.stringify({ version: 1, machine: "c0123456789abcdef01234567" }), { mode: 0o600 });

  const password = `fake-backup-Passw0rd-${Date.now()}`, token = "ops_fake-backup-token", secret = "sk_test_fake_backup_value";
  const totp = { secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1" as const, digits: 6, period: 30 };
  const logins = new LoginStore({ dataDir });
  const login = logins.create({ site: "example.test", hosts: ["accounts.example.test"], exactHost: false, username: "alice", password, totp, source: "settings", bots: ["bot-1"] });
  logins.setOnePasswordToken(token);
  const key = fileSavedSecretsKey(dataDir);
  new SavedSecretStore({ dataDir, key }).save({ label: "Stripe secret key", botId: "bot-1", value: secret });
  // the Vault's key lives on the volume, beside the data folder, not in it
  expect(relative(volume, key.file).startsWith("..")).toBe(false);
  expect(relative(dataDir, key.file).startsWith("..")).toBe(true);
  const before = files(volume);

  // the snapshot: the volume as omb-home snapshot tars it
  const archive = join(root, "backup.tar");
  execFileSync("tar", ["-C", root, "--numeric-owner", "-cf", archive, ...PLATFORM_ENTRIES.map((entry) => `--exclude=data/${entry}`), "data"]);

  // a fresh home: the old volume gone, an empty one at the same mount, the backup restored as omb-home restore does
  rmSync(volume, { recursive: true, force: true });
  mkdirSync(volume);
  const stage = join(root, "stage");
  mkdirSync(stage);
  execFileSync("tar", ["-xf", archive, "-C", stage, "--numeric-owner", "--no-same-permissions"]);
  const restoredRoot = join(stage, "data");
  expect(existsSync(join(restoredRoot, ".omb-cloud-home.json"))).toBe(true);
  for (const entry of readdirSync(restoredRoot)) renameSync(join(restoredRoot, entry), join(volume, entry));

  const after = files(volume);
  const kept = Object.fromEntries(Object.entries(before).filter(([path]) => !path.startsWith("config/")));
  expect(after, "every file but the platform's comes back, each with its own mode").toEqual(kept);
  expect(after[relative(volume, key.file)]).toBe(0o600);
  expect(after[join(CLOUD_HOME.dataName, "logins-key")]).toBe(0o600);

  // opened by the restored home's own stores, as its server opens them
  const restoredLogins = new LoginStore({ dataDir });
  expect(restoredLogins.get(login.id)).toMatchObject({ username: "alice", password, totp });
  expect(restoredLogins.onePasswordToken()).toBe(token);
  const vault = new SavedSecretStore({ dataDir, key: fileSavedSecretsKey(dataDir) });
  expect(vault.find("Stripe secret key", "bot-1")?.value).toBe(secret);
  expect(readdirSync(dataDir).some((name) => name.includes("unreadable")), "nothing was set aside as unreadable").toBe(false);
});
