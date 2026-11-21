// Secrets the person saved to the Vault from a bot's card, so that bot can use them again without asking. Security:
// sealed with AES-256-GCM under a key that never lives in the data folder. In the desktop app the key comes from the
// main process, which keeps it sealed by the OS keychain (Electron safeStorage); on a headless server it is a random
// 0600 file in the service user's own config folder. No route returns a value, nothing logs one, and neither file is
// backed up, exported or synced (workspace-backup-policy.ts); only a move to the person's own Cloud carries each secret,
// sealed for that Cloud's server (vault-move.ts). Root on the machine can still read the key file.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, isAbsolute } from "node:path";
import { z } from "zod";

import type { SavedSecretSummary } from "../shared/saved-secrets.ts";
import { LEGACY } from "../electron/legacy-names.mjs";
import { writeFileAtomic } from "./atomic.ts";
import { decryptBrowserState, encryptBrowserState } from "./browser-sites.ts";

export const SAVED_SECRETS_FILE = "saved-secrets.json.enc";
export const SAVED_SECRETS_KEY_MESSAGE = "madanibot:saved-secrets-key";
const HEX_KEY = /^[0-9a-f]{64}$/u;
const SAVED_LIMIT = 200;

const recordSchema = z.object({
  id: z.string().uuid(),
  label: z.string().min(1).max(80),
  bots: z.array(z.string().min(1).max(128)).min(1).max(200),
  value: z.string().min(1).max(4_096),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastUsedAt: z.number().optional(),
  /** When a use failed in a way that may mean it is wrong: shown in Settings until it is replaced or removed. */
  needsCheck: z.number().optional(),
});
const fileSchema = z.object({ version: z.literal(1), secrets: z.array(recordSchema).max(SAVED_LIMIT) });
type SavedRecord = z.infer<typeof recordSchema>;
type SavedFile = z.infer<typeof fileSchema>;

export class SavedSecretsUnavailable extends Error {
  constructor() {
    super("Saved secrets are not ready on this computer yet. Try again in a moment.");
    this.name = "SavedSecretsUnavailable";
  }
}

/** Where the key comes from: `get` is null until it is known; `peek` never makes one. */
export interface SavedSecretsKey {
  get(): string | null;
  peek(): string | null;
}

/** A headless server's key: `<config>/madanibot/saved-secrets-<data folder hash>.key`, outside the data folder,
 * 0600 in a 0700 folder, owned by this user. A link, a foreign owner or a loose mode is refused or tightened. */
export function fileSavedSecretsKey(dataDir: string, file = defaultKeyFile(dataDir)): SavedSecretsKey & { file: string } {
  const legacy = file === defaultKeyFile(dataDir) ? legacyKeyFiles(dataDir) : [];
  const inside = relative(resolve(dataDir), resolve(file));
  // A data folder that holds the config folder (a home used as the data folder) gets no key: saving to the Vault is
  // refused, and Use once still works. Set MADANI_SAVED_SECRETS_KEY_FILE to a path outside it.
  const misplaced = !inside || (!inside.startsWith("..") && !isAbsolute(inside));
  const outside = () => { if (misplaced) throw new Error("the saved secrets key must live outside the data folder; set MADANI_SAVED_SECRETS_KEY_FILE"); };
  let cached: string | null = null;
  return {
    file,
    get() {
      if (cached) return cached;
      outside();
      cached = readKeyFile(file) ?? carryLegacyKey(file, legacy) ?? createKeyFile(file);
      return cached;
    },
    peek() {
      if (cached) return cached;
      if (misplaced) return null;
      cached = readKeyFile(file) ?? legacy.map(readKeyFile).find(Boolean) ?? null;
      return cached;
    },
  };
}

const keyBase = () => process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
const keyTag = (dataDir: string) => createHash("sha256").update(resolve(dataDir)).digest("hex").slice(0, 16);

function defaultKeyFile(dataDir: string): string {
  const configured = process.env.MADANI_SAVED_SECRETS_KEY_FILE?.trim();
  if (configured) return configured;
  return join(keyBase(), "madanibot", `saved-secrets-${keyTag(dataDir)}.key`);
}

/** where a build from before the rename kept this data folder's key: its own config folder, named for the data folder
 * by its path then (the old folder name when the data folder has since moved to the new one) */
function legacyKeyFiles(dataDir: string): string[] {
  const dirs = [dataDir, ...(basename(resolve(dataDir)) === ".madanibot" ? [join(dirname(resolve(dataDir)), LEGACY.dataDirName)] : [])];
  return dirs.map((dir) => join(keyBase(), LEGACY.devName, `saved-secrets-${keyTag(dir)}.key`));
}

/** the key from before the rename, copied to its new place; the old file stays */
function carryLegacyKey(file: string, legacy: string[]): string | null {
  for (const old of legacy) {
    const key = readKeyFile(old);
    if (!key) continue;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    ownedPlain(dirname(file), "folder");
    writeKey(file, key);
    return key;
  }
  return null;
}

function ownedPlain(path: string, kind: "file" | "folder"): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || (kind === "file" ? !info.isFile() : !info.isDirectory())) throw new Error(`the saved secrets key ${kind} is not a plain ${kind}`);
  if (process.platform === "win32") return;
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error(`the saved secrets key ${kind} belongs to someone else`);
  if ((info.mode & 0o077) !== 0) chmodSync(path, kind === "file" ? 0o600 : 0o700);
}

function readKeyFile(file: string): string | null {
  if (!existsSync(file)) return null;
  ownedPlain(dirname(file), "folder");
  ownedPlain(file, "file");
  const key = readFileSync(file, "utf8").trim();
  if (!HEX_KEY.test(key)) throw new Error("the saved secrets key file is damaged");
  return key;
}

function createKeyFile(file: string): string {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  ownedPlain(dirname(file), "folder");
  const key = randomBytes(32).toString("hex");
  writeKey(file, key);
  return key;
}

function writeKey(file: string, key: string): void {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
  try {
    writeSync(fd, `${key}\n`);
  } finally {
    closeSync(fd);
  }
}

/** The desktop app's key: the main process sends it, or says the keychain is unavailable, in which case the headless
 * file key is used instead. Until either arrives, `get` is null. */
export function desktopSavedSecretsKey(fallback: () => SavedSecretsKey): SavedSecretsKey & { receive(message: unknown): boolean } {
  let key: string | null = null;
  let use: SavedSecretsKey | null = null;
  return {
    get: () => key ?? use?.get() ?? null,
    peek: () => key ?? use?.peek() ?? null,
    receive(raw) {
      const message = (raw as { data?: unknown } | null)?.data ?? raw;
      if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== SAVED_SECRETS_KEY_MESSAGE) return false;
      const sent = (message as { key?: unknown }).key;
      if (typeof sent === "string" && HEX_KEY.test(sent)) key = sent;
      else use = fallback();
      return true;
    },
  };
}

export function summarizeSavedSecret(record: SavedRecord): SavedSecretSummary {
  return { id: record.id, label: record.label, bots: [...record.bots], createdAt: record.createdAt, updatedAt: record.updatedAt,
    ...(record.lastUsedAt === undefined ? {} : { lastUsedAt: record.lastUsedAt }),
    ...(record.needsCheck === undefined ? {} : { needsCheck: record.needsCheck }) };
}

const sameLabel = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export class SavedSecretStore {
  private readonly file: string;
  private readonly key: SavedSecretsKey;
  private readonly now: () => number;
  private cache: SavedFile | null = null;
  version = 0;

  constructor(options: { dataDir: string; key: SavedSecretsKey; now?: () => number }) {
    this.file = join(options.dataDir, SAVED_SECRETS_FILE);
    this.key = options.key;
    this.now = options.now ?? Date.now;
  }

  /** A key is known: nothing was ever saved without one, so a server that never saved one makes none to say no. */
  ready(): boolean {
    try {
      return this.key.peek() !== null;
    } catch {
      return false;
    }
  }

  private read(): SavedFile {
    if (this.cache) return this.cache;
    const key = this.key.get();
    if (!key) throw new SavedSecretsUnavailable();
    let data: SavedFile = { version: 1, secrets: [] };
    if (existsSync(this.file)) {
      try {
        data = fileSchema.parse(JSON.parse(decryptBrowserState(readFileSync(this.file), key)));
      } catch {
        // A file this key cannot open is kept aside, never overwritten, and its contents are never logged.
        const aside = `${this.file}.unreadable-${this.now()}`;
        renameSync(this.file, aside);
        console.warn("saved secrets: the saved secrets file could not be opened with this computer's key; it was set aside and a new one started");
      }
    }
    this.cache = data;
    this.version++;
    return data;
  }

  private write(data: SavedFile): void {
    const key = this.key.get();
    if (!key) throw new SavedSecretsUnavailable();
    const parsed = fileSchema.parse(data);
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, encryptBrowserState(JSON.stringify(parsed), key), { mode: 0o600 });
    this.cache = parsed;
    this.version++;
  }

  list(): SavedSecretSummary[] {
    if (!this.ready() && !existsSync(this.file)) return [];
    return this.read().secrets.map(summarizeSavedSecret).sort((a, b) => a.label.localeCompare(b.label));
  }

  /** The labels a bot may use, for its prompt: never a value. */
  labelsFor(botId: string): string[] {
    if (!this.ready()) return [];
    return this.read().secrets.filter((record) => record.bots.includes(botId)).map((record) => record.label).sort();
  }

  /** The saved secret with this label that this bot may use. Server-only: no route returns it. */
  find(label: string, botId: string): { id: string; label: string; value: string; needsCheck?: number } | null {
    const found = this.read().secrets.find((record) => sameLabel(record.label, label) && record.bots.includes(botId));
    return found ? { id: found.id, label: found.label, value: found.value, ...(found.needsCheck === undefined ? {} : { needsCheck: found.needsCheck }) } : null;
  }

  /** The same label saved again replaces its value and adds the bot; nothing else is ever merged. */
  save(input: { label: string; botId: string; value: string }): SavedSecretSummary {
    const data = this.read();
    const at = this.now();
    const same = data.secrets.find((record) => sameLabel(record.label, input.label));
    if (same) {
      const { needsCheck: _checked, ...rest } = same;
      const next: SavedRecord = { ...rest, value: input.value, bots: [...new Set([...same.bots, input.botId])], updatedAt: at };
      this.write({ ...data, secrets: data.secrets.map((record) => record.id === same.id ? next : record) });
      return summarizeSavedSecret(next);
    }
    if (data.secrets.length >= SAVED_LIMIT) throw new Error(`The Vault holds at most ${SAVED_LIMIT} secrets. Remove one in Settings first.`);
    const record: SavedRecord = { id: randomUUID(), label: input.label.trim(), bots: [input.botId], value: input.value, createdAt: at, updatedAt: at };
    this.write({ ...data, secrets: [...data.secrets, record] });
    return summarizeSavedSecret(record);
  }

  /** A secret moved in from the person's own computer: the same label replaces its value and adds the bots. */
  adopt(input: { label: string; bots: readonly string[]; value: string }): SavedSecretSummary {
    const data = this.read();
    const at = this.now();
    const bots = [...new Set(input.bots)].slice(0, 200);
    const same = data.secrets.find((record) => sameLabel(record.label, input.label));
    if (same) {
      const { needsCheck: _checked, ...rest } = same;
      const next: SavedRecord = { ...rest, value: input.value, bots: [...new Set([...same.bots, ...bots])].slice(0, 200), updatedAt: at };
      this.write({ ...data, secrets: data.secrets.map((record) => record.id === same.id ? next : record) });
      return summarizeSavedSecret(next);
    }
    if (data.secrets.length >= SAVED_LIMIT) throw new Error(`The Vault holds at most ${SAVED_LIMIT} secrets.`);
    const record: SavedRecord = { id: randomUUID(), label: input.label.trim(), bots, value: input.value, createdAt: at, updatedAt: at };
    this.write({ ...data, secrets: [...data.secrets, record] });
    return summarizeSavedSecret(record);
  }

  /** Every secret with its value, for the move to the person's own Cloud only (vault-move.ts); nothing while no key was ever made. */
  movable(): Array<{ label: string; bots: string[]; value: string }> {
    if (!this.ready()) return [];
    return this.read().secrets.map((record) => ({ label: record.label, bots: [...record.bots], value: record.value }));
  }

  markUsed(id: string): void {
    const data = this.read();
    const at = this.now();
    if (!data.secrets.some((record) => record.id === id)) return;
    this.write({ ...data, secrets: data.secrets.map((record) => record.id === id ? { ...record, lastUsedAt: at } : record) });
  }

  /** Marks a secret whose use failed unclearly; false when it is gone or was already marked. */
  flag(id: string): boolean {
    const data = this.read();
    const found = data.secrets.find((record) => record.id === id);
    if (!found || found.needsCheck !== undefined) return false;
    const at = this.now();
    this.write({ ...data, secrets: data.secrets.map((record) => record.id === id ? { ...record, needsCheck: at } : record) });
    return true;
  }

  remove(id: string): boolean {
    const data = this.read();
    if (!data.secrets.some((record) => record.id === id)) return false;
    this.write({ ...data, secrets: data.secrets.filter((record) => record.id !== id) });
    return true;
  }

  /** A deleted bot loses its access; a secret no bot may use any more goes with it. */
  forgetBot(botId: string): void {
    if (!this.ready()) return;
    const data = this.read();
    if (!data.secrets.some((record) => record.bots.includes(botId))) return;
    const secrets = data.secrets.map((record) => ({ ...record, bots: record.bots.filter((bot) => bot !== botId) })).filter((record) => record.bots.length > 0);
    this.write({ ...data, secrets });
  }

  /** Every value, for held-secret redaction; nothing while the key is unknown. */
  secretValues(): string[] {
    if (!this.ready()) return [];
    try {
      return this.read().secrets.map((record) => record.value);
    } catch {
      return [];
    }
  }
}
