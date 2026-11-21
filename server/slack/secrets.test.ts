import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptBrowserState } from "../browser-sites.ts";
import type { SavedSecretsKey } from "../saved-secrets.ts";
import { excludedWorkspaceAuthPath } from "../workspace-backup-policy.ts";
import { SLACK_SECRETS_FILE, SlackSecretStore, SlackSecretsUnavailable } from "./secrets.ts";
import type { SlackBotRecord, SlackWorkspaceRecord } from "./secrets.ts";

const directories: string[] = [];
const canary = `test-canary-${randomBytes(12).toString("hex")}`;
afterEach(() => {
  vi.restoreAllMocks();
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "madani-slack-secrets-"));
  directories.push(dataDir);
  const value = randomBytes(32).toString("hex");
  const key: SavedSecretsKey = { get: () => value, peek: () => value };
  return { dataDir, key, value, path: join(dataDir, SLACK_SECRETS_FILE) };
}

function workspace(): SlackWorkspaceRecord {
  return { teamId: "T1", teamName: "Test team", userId: "U1", configToken: `${canary}-config`, refreshToken: `${canary}-refresh`,
    expiresAt: 5000, state: "connected", connectedAt: 1000, rotatedAt: 2000 };
}

function bot(botId = "bot1"): SlackBotRecord {
  return { botId, appId: "A1", teamId: "T1", clientId: "C1", clientSecret: `${canary}-client`, signingSecret: `${canary}-signing`,
    redirectUri: "https://link.madani.bot/slack/callback", manifestHash: "a".repeat(64),
    oauthState: { hash: "b".repeat(64), expiresAt: 3000 }, botToken: `${canary}-bot`, botUserId: "UB1", teamName: "Test team", handle: "helper",
    installedAt: 1000, appToken: `${canary}-app`, appTokenAt: 2000, createdAt: 500 };
}

describe("Slack encrypted secrets", () => {
  it("round trips workspace and bots without plaintext on disk", () => {
    const options = fixture();
    const store = new SlackSecretStore(options);
    expect(store.ready()).toBe(true);
    expect(store.workspace()).toBeNull();
    expect(store.bots()).toEqual([]);
    store.setWorkspace(workspace());
    store.putBot(bot());
    const reopened = new SlackSecretStore(options);
    expect(reopened.workspace()).toEqual(workspace());
    expect(reopened.bot("bot1")).toEqual(bot());
    expect(reopened.bots()).toEqual([bot()]);
    expect(readFileSync(options.path).includes(canary)).toBe(false);
    expect(readFileSync(options.path).includes("Test team")).toBe(false);
    for (const name of readdirSync(options.dataDir)) expect(readFileSync(join(options.dataDir, name)).includes(canary)).toBe(false);
    store.setWorkspace(null);
    expect(new SlackSecretStore(options).workspace()).toBeNull();
    expect(new SlackSecretStore(options).bots()).toEqual([bot()]);
  });

  it.skipIf(process.platform === "win32")("writes only owner-readable files", () => {
    const options = fixture();
    new SlackSecretStore(options).putBot(bot());
    expect(statSync(options.path).mode & 0o777).toBe(0o600);
  });

  it("returns empty reads and refuses all mutations while the key is unknown", () => {
    const options = fixture();
    const store = new SlackSecretStore({ dataDir: options.dataDir, key: { get: () => null, peek: () => null } });
    expect(store.ready()).toBe(false);
    expect(store.workspace()).toBeNull();
    expect(store.bots()).toEqual([]);
    expect(store.bot("bot1")).toBeNull();
    expect(store.botByStateHash("b".repeat(64))).toBeNull();
    expect(store.secretValues()).toEqual([]);
    expect(() => store.setWorkspace(workspace())).toThrow(SlackSecretsUnavailable);
    expect(() => store.setWorkspace(null)).toThrow(SlackSecretsUnavailable);
    expect(() => store.putBot(bot())).toThrow(SlackSecretsUnavailable);
    expect(() => store.patchBot("bot1", {})).toThrow(SlackSecretsUnavailable);
    expect(() => store.removeBot("bot1")).toThrow(SlackSecretsUnavailable);
    expect(existsSync(options.path)).toBe(false);
  });

  it("does not cache empty reads or rename a file while waiting for a key", () => {
    const options = fixture();
    const writer = new SlackSecretStore(options);
    writer.setWorkspace(workspace());
    writer.putBot(bot());
    let value: string | null = null;
    const store = new SlackSecretStore({ dataDir: options.dataDir, key: { get: () => value, peek: () => value } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(store.workspace()).toBeNull();
    expect(store.bots()).toEqual([]);
    expect(store.secretValues()).toEqual([]);
    expect(readdirSync(options.dataDir)).toEqual([SLACK_SECRETS_FILE]);
    expect(warn).not.toHaveBeenCalled();
    value = options.value;
    expect(store.ready()).toBe(true);
    expect(store.workspace()).toEqual(workspace());
    expect(store.bot("bot1")).toEqual(bot());
    store.patchBot("bot1", { handle: "new handle" });
    expect(new SlackSecretStore(options).bot("bot1")?.handle).toBe("new handle");
  });

  it("can write after an initially absent key arrives", () => {
    const options = fixture();
    let value: string | null = null;
    const store = new SlackSecretStore({ dataDir: options.dataDir, key: { get: () => value, peek: () => value } });
    expect(store.bots()).toEqual([]);
    value = options.value;
    store.putBot(bot());
    expect(new SlackSecretStore(options).bot("bot1")).toEqual(bot());
  });

  it("is not ready while the key is unknown or refused, and never throws", () => {
    const options = fixture();
    expect(new SlackSecretStore({ dataDir: options.dataDir, key: { get: () => null, peek: () => null } }).ready()).toBe(false);
    const refused = new SlackSecretStore({ dataDir: options.dataDir, key: { get: () => { throw new Error("misplaced"); }, peek: () => null } });
    expect(refused.ready()).toBe(false);
    expect(refused.workspace()).toBeNull();
    expect(() => refused.setWorkspace(null)).toThrow(SlackSecretsUnavailable);
  });

  it("sets a damaged file aside and warns once without its contents", () => {
    const options = fixture();
    const raw = Buffer.from(`damaged ${canary}`);
    writeFileSync(options.path, raw);
    vi.spyOn(Date, "now").mockReturnValue(12345);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new SlackSecretStore(options);
    expect(store.workspace()).toBeNull();
    expect(store.bots()).toEqual([]);
    expect(store.secretValues()).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]).toEqual(["Slack: the saved secrets file could not be opened; it was set aside and a new one started."]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(canary);
    const aside = `${options.path}.unreadable-12345`;
    expect(readFileSync(aside)).toEqual(raw);
    expect(existsSync(options.path)).toBe(false);
    store.putBot(bot());
    expect(readFileSync(aside)).toEqual(raw);
    expect(new SlackSecretStore(options).bots()).toEqual([bot()]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it.each([
    "not json", JSON.stringify({ version: 2, workspace: null, bots: [] }),
    JSON.stringify({ version: 1, workspace: { ...workspace(), expiresAt: "5000" }, bots: [] }),
    JSON.stringify({ version: 1, workspace: { ...workspace(), configToken: "x".repeat(4097) }, bots: [] }),
    JSON.stringify({ version: 1, workspace: null, bots: [{ ...bot(), appId: "x".repeat(65) }] }),
    JSON.stringify({ version: 1, workspace: null, bots: [{ ...bot(), teamName: "x".repeat(201) }] }),
    JSON.stringify({ version: 1, workspace: null, bots: [{ ...bot(), clientSecret: "x".repeat(4097) }] }),
    JSON.stringify({ version: 1, workspace: null, bots: [{ ...bot(), botToken: 123 }] }),
    JSON.stringify({ version: 1, workspace: null, bots: Array.from({ length: 201 }, (_, n) => bot(`bot${n}`)) }),
  ])("rejects decrypted malformed records case %# without logging secrets", (text) => {
    const options = fixture();
    writeFileSync(options.path, encryptBrowserState(text, options.value));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(new SlackSecretStore(options).bots()).toEqual([]);
    expect(readdirSync(options.dataDir).some((name) => /^slack-secrets\.json\.enc\.unreadable-\d+$/.test(name))).toBe(true);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(canary);
  });

  it("validates writes without changing the saved file or exposing inputs", () => {
    const options = fixture();
    const store = new SlackSecretStore(options);
    store.putBot(bot());
    const before = readFileSync(options.path);
    expect(() => store.putBot({ ...bot(), clientSecret: canary.repeat(300) })).toThrow("Invalid Slack secrets record.");
    expect(() => store.setWorkspace({ ...workspace(), teamId: "x".repeat(65) })).toThrow("Invalid Slack secrets record.");
    expect(readFileSync(options.path)).toEqual(before);
    expect(store.bot("bot1")).toEqual(bot());
  });

  it("replaces bots, patches undefined fields away, finds hashes, and removes bots", () => {
    const options = fixture();
    const store = new SlackSecretStore(options);
    store.putBot(bot());
    store.putBot({ ...bot(), handle: "replacement" });
    expect(store.bots()).toHaveLength(1);
    expect(store.bot("bot1")?.handle).toBe("replacement");
    expect(store.botByStateHash("b".repeat(64))?.botId).toBe("bot1");
    expect(store.botByStateHash("c".repeat(64))).toBeNull();
    const patched = store.patchBot("bot1", { handle: "changed", oauthState: undefined, appToken: undefined });
    expect(patched?.handle).toBe("changed");
    expect(patched).not.toHaveProperty("oauthState");
    expect(patched).not.toHaveProperty("appToken");
    expect(new SlackSecretStore(options).bot("bot1")).toEqual(patched);
    expect(store.botByStateHash("b".repeat(64))).toBeNull();
    expect(store.patchBot("missing", {})).toBeNull();
    expect(store.removeBot("missing")).toBe(false);
    expect(store.removeBot("bot1")).toBe(true);
    expect(store.bot("bot1")).toBeNull();
    expect(new SlackSecretStore(options).bots()).toEqual([]);
  });

  it("returns only present tokens and secrets for redaction", () => {
    const store = new SlackSecretStore(fixture());
    store.setWorkspace(workspace());
    store.putBot(bot());
    expect(store.secretValues()).toEqual([workspace().configToken, workspace().refreshToken, bot().clientSecret, bot().signingSecret, bot().botToken, bot().appToken]);
    for (const id of ["T1", "U1", "A1", "C1", "bot1", "UB1"]) expect(store.secretValues()).not.toContain(id);
    store.patchBot("bot1", { botToken: undefined, appToken: undefined });
    store.setWorkspace(null);
    expect(store.secretValues()).toEqual([bot().clientSecret, bot().signingSecret]);
  });

  it("caches the loaded file and protects the cache from caller mutation", () => {
    const options = fixture();
    const store = new SlackSecretStore(options);
    store.setWorkspace(workspace());
    store.putBot(bot());
    const loaded = new SlackSecretStore(options);
    expect(loaded.ready()).toBe(true);
    loaded.bots();
    store.removeBot("bot1");
    expect(loaded.bot("bot1")).toEqual(bot());
    loaded.bot("bot1")!.clientSecret = "changed";
    loaded.bots()[0].oauthState!.hash = "c".repeat(64);
    loaded.workspace()!.configToken = "changed";
    expect(loaded.bot("bot1")).toEqual(bot());
    expect(loaded.workspace()).toEqual(workspace());
  });

  it("excludes Slack credentials, unreadable files, thread maps and atomic temp files from backups", () => {
    for (const path of [SLACK_SECRETS_FILE, `${SLACK_SECRETS_FILE}.unreadable-123`, `${SLACK_SECRETS_FILE}.123.0f0e-11.tmp`, "slack-threads.json", "slack-threads.json.unreadable-123", "slack-threads.json.123.0f0e-11.tmp"]) {
      expect(excludedWorkspaceAuthPath(path)).toBe(true);
    }
    for (const path of ["slack-threads.json.bak", `${SLACK_SECRETS_FILE}.bak`, `workspaces/bot/${SLACK_SECRETS_FILE}`, "notes/slack-threads.json"]) {
      expect(excludedWorkspaceAuthPath(path)).toBe(false);
    }
  });
});
