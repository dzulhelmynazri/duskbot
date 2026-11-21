import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renameSync } from "node:fs";
import { LEGACY } from "../electron/legacy-names.mjs";
import { afterEach, describe, expect, it } from "vitest";

import { sealCardSecret } from "../src/lib/card-seal.ts";
import { createCardSealer, CardSealError } from "./card-seal.ts";
import { HeldSecrets } from "./login-store.ts";
import { addHeldSecretScrubber, redactSecretsInText } from "./redact.ts";
import { desktopSavedSecretsKey, fileSavedSecretsKey, SAVED_SECRETS_FILE, SavedSecretStore, SavedSecretsUnavailable } from "./saved-secrets.ts";
import { excludedWorkspaceAuthPath } from "./workspace-backup-policy.ts";

// never a real secret: a fresh random canary per run
const CANARY = `or_CANARY${randomBytes(12).toString("hex")}`;
const removals: Array<() => void> = [];
afterEach(() => { while (removals.length) removals.pop()!(); });

function homes() {
  const root = mkdtempSync(join(tmpdir(), "madani-saved-secrets-"));
  return { dataDir: join(root, "data"), keyFile: join(root, "config", "madanibot", "saved-secrets.key") };
}

describe("saved secrets at rest", () => {
  it("a headless server from before the rename keeps its Vault: the old key file is found and copied, never replaced", () => {
    const root = mkdtempSync(join(tmpdir(), "madani-saved-secrets-legacy-"));
    const previous = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = join(root, "config");
    removals.push(() => { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; });
    // the old build: data in the old folder, its key under the old config folder name
    const oldData = join(root, LEGACY.dataDirName);
    const tag = createHash("sha256").update(oldData).digest("hex").slice(0, 16);
    const oldKey = fileSavedSecretsKey(oldData, join(root, "config", LEGACY.devName, `saved-secrets-${tag}.key`));
    new SavedSecretStore({ dataDir: oldData, key: oldKey }).save({ label: "Card", botId: "b", value: CANARY });
    const moved = join(root, ".madanibot");
    renameSync(oldData, moved);
    const key = fileSavedSecretsKey(moved);
    expect(key.peek()).toBe(oldKey.get());
    const carried = fileSavedSecretsKey(moved);
    expect(carried.get()).toBe(oldKey.get());
    expect(new SavedSecretStore({ dataDir: moved, key }).list().map((item) => item.label)).toEqual(["Card"]);
    expect(readFileSync(carried.file, "utf8").trim()).toBe(oldKey.get());
    expect(existsSync(oldKey.file)).toBe(true);
  });

  it("seals every value under a key outside the data folder, 0600, and lists only labels", () => {
    const { dataDir, keyFile } = homes();
    const store = new SavedSecretStore({ dataDir, key: fileSavedSecretsKey(dataDir, keyFile), now: () => 1_000 });
    const saved = store.save({ label: "OpenRouter API key", botId: "pepper", value: CANARY });
    expect(saved).toEqual({ id: saved.id, label: "OpenRouter API key", bots: ["pepper"], createdAt: 1_000, updatedAt: 1_000 });
    expect(JSON.stringify(store.list())).not.toContain(CANARY);

    const disk = readFileSync(join(dataDir, SAVED_SECRETS_FILE));
    expect(disk.includes(CANARY)).toBe(false);
    expect(disk.includes("OpenRouter")).toBe(false);
    for (const name of readdirSync(dataDir)) expect(readFileSync(join(dataDir, name)).includes(CANARY)).toBe(false);
    expect(statSync(join(dataDir, SAVED_SECRETS_FILE)).mode & 0o777).toBe(0o600);
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(statSync(join(keyFile, "..")).mode & 0o777).toBe(0o700);

    // the same key opens it again; the value is found only for a bot it was saved for
    const again = new SavedSecretStore({ dataDir, key: fileSavedSecretsKey(dataDir, keyFile) });
    expect(again.find("openrouter api key", "pepper")?.value).toBe(CANARY);
    expect(again.find("OpenRouter API key", "someone-else")).toBeNull();
  });

  it("refuses a key inside the data folder, tightens a loose key file and never opens with another key", () => {
    const { dataDir, keyFile } = homes();
    expect(() => fileSavedSecretsKey(dataDir, join(dataDir, "key")).get()).toThrow(/outside the data folder/u);
    expect(fileSavedSecretsKey(dataDir, join(dataDir, "key")).peek()).toBeNull();
    new SavedSecretStore({ dataDir, key: fileSavedSecretsKey(dataDir, keyFile) }).save({ label: "Key", botId: "b", value: CANARY });
    chmodSync(keyFile, 0o644);
    fileSavedSecretsKey(dataDir, keyFile).get();
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);

    writeFileSync(keyFile, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
    const other = new SavedSecretStore({ dataDir, key: fileSavedSecretsKey(dataDir, keyFile) });
    expect(other.list()).toEqual([]);
    // set aside, not overwritten
    expect(readdirSync(dataDir).some((name) => name.startsWith(`${SAVED_SECRETS_FILE}.unreadable-`))).toBe(true);
  });

  it("waits for the desktop keychain key, and removes a secret for good", () => {
    const { dataDir, keyFile } = homes();
    const key = desktopSavedSecretsKey(() => fileSavedSecretsKey(dataDir, keyFile));
    const store = new SavedSecretStore({ dataDir, key });
    expect(store.ready()).toBe(false);
    expect(() => store.save({ label: "Key", botId: "b", value: CANARY })).toThrow(SavedSecretsUnavailable);
    expect(store.secretValues()).toEqual([]);
    expect(key.receive({ type: "madanibot:saved-secrets-key", key: randomBytes(32).toString("hex") })).toBe(true);
    const saved = store.save({ label: "Key", botId: "b", value: CANARY });
    expect(existsSync(keyFile)).toBe(false);
    expect(store.remove(saved.id)).toBe(true);
    expect(store.find("Key", "b")).toBeNull();
    expect(store.secretValues()).toEqual([]);
  });

  it("never travels in a backup or a move", () => {
    expect(excludedWorkspaceAuthPath(SAVED_SECRETS_FILE)).toBe(true);
    expect(excludedWorkspaceAuthPath(`${SAVED_SECRETS_FILE}.1.0f0e-11.tmp`)).toBe(true);
    expect(excludedWorkspaceAuthPath(`${SAVED_SECRETS_FILE}.unreadable-123`)).toBe(true);
  });
});

describe("a saved secret in tool output", () => {
  it("is masked wherever text crosses to a bot, a transcript or a log", () => {
    const { dataDir, keyFile } = homes();
    const store = new SavedSecretStore({ dataDir, key: fileSavedSecretsKey(dataDir, keyFile) });
    const held = new HeldSecrets(store);
    removals.push(addHeldSecretScrubber((text) => held.scrub(text)));
    const output = `$ curl -H "Authorization: ${CANARY}" https://openrouter.test\n{"echo":"${CANARY}","url":"${encodeURIComponent(CANARY)}"}`;
    expect(redactSecretsInText(output)).toContain(CANARY);
    store.save({ label: "OpenRouter API key", botId: "pepper", value: CANARY });
    const scrubbed = redactSecretsInText(output);
    expect(scrubbed).not.toContain(CANARY);
    expect(scrubbed).toContain("https://openrouter.test");
  });
});

describe("a card secret sealed for its server", () => {
  const context = { botId: "pepper", threadId: "t1", messageId: "m1", requestKey: "r1", remember: true };

  it("opens only on this server, for this card and choice", async () => {
    const sealer = createCardSealer();
    const sealed = await sealCardSecret(CANARY, sealer.publicKey(), context);
    expect(JSON.stringify(sealed)).not.toContain(CANARY);
    expect(await sealer.open(sealed, context)).toBe(CANARY);
    await expect(sealer.open(sealed, { ...context, remember: false })).rejects.toThrow(/could not be verified/u);
    await expect(sealer.open(sealed, { ...context, messageId: "m2" })).rejects.toThrow(/could not be verified/u);
    const restarted = createCardSealer();
    const stale = await restarted.open(sealed, context).catch((error: unknown) => error);
    expect(stale).toBeInstanceOf(CardSealError);
    expect((stale as CardSealError).sealKey?.keyId).toBe(restarted.publicKey().keyId);
  });
});
