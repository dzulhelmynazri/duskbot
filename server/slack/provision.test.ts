import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptBrowserState } from "../browser-sites.ts";
import { startFakeSlack } from "../testing/fake-slack.ts";
import { createSlackApi } from "./api.ts";
import { createConfigTokens } from "./config-token.ts";
import { buildSlackManifest, manifestHash, SLACK_BOT_SCOPES } from "./manifest.ts";
import { createSlackProvisioner, type ProvisionDeps } from "./provision.ts";
import { SLACK_SECRETS_FILE, SlackSecretStore } from "./secrets.ts";

const bot = { id: "research", name: "Research Bot", color: "green", description: "Finds answers." };
const redirectUrl = "https://example.test/slack/callback";
const key = { get: () => "a".repeat(64), peek: () => "a".repeat(64) };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
  vi.restoreAllMocks();
});
const stateOf = (result: { authorizeUrl: string }) => new URL(result.authorizeUrl).searchParams.get("state")!;

async function fixture(icon?: ProvisionDeps["icon"]) {
  const fake = await startFakeSlack();
  const dataDir = mkdtempSync(join(tmpdir(), "slack-provision-test-"));
  const store = new SlackSecretStore({ dataDir, key });
  let clock = Date.now();
  let transform: ((method: string, body: Record<string, unknown>) => Record<string, unknown>) | undefined;
  const api = createSlackApi({
    env: { MADANI_SLACK_API_URL: fake.url }, minGapMs: 0,
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (!transform) return response;
      return Response.json(transform(String(url).split("/").at(-1)!, await response.json() as Record<string, unknown>));
    },
  });
  const tokens = createConfigTokens({ store, api, now: () => clock, setTimer: () => ({ cancel() {} }) });
  const log = vi.fn<(line: string) => void>();
  const provisioner = createSlackProvisioner({ store, api, tokens, redirectUrl, icon, now: () => clock, log });
  cleanup.push(async () => { tokens.stop(); await fake.close(); rmSync(dataDir, { recursive: true, force: true }); });
  await tokens.connect(fake.config.access, fake.config.refresh);
  async function install() {
    const result = await provisioner.provision(bot);
    return provisioner.exchange(fake.mintCode(result.record.appId), stateOf(result));
  }
  return {
    fake, dataDir, store, api, tokens, log, provisioner, install,
    now: () => clock, advance: (ms: number) => { clock += ms; },
    transform: (fn: NonNullable<typeof transform>) => { transform = fn; },
  };
}

describe("Slack provisioning", () => {
  it("creates the expected app, uploads its icon and saves only the hash of a random state", async () => {
    const icon = vi.fn<NonNullable<ProvisionDeps["icon"]>>(async () => ({ bytes: new Uint8Array([1, 2, 3]), mime: "image/png", name: "bot.png" }));
    const f = await fixture(icon);
    const result = await f.provisioner.provision(bot);
    const app = f.fake.apps.get(result.record.appId)!;
    expect(app.manifest).toEqual(buildSlackManifest(bot, redirectUrl));
    expect(result.record).toMatchObject({
      botId: bot.id, teamId: "T0FAKE", clientId: app.credentials.client_id, clientSecret: app.credentials.client_secret,
      signingSecret: app.credentials.signing_secret, redirectUri: redirectUrl,
      manifestHash: manifestHash(app.manifest), createdAt: f.now(),
    });
    expect(icon).toHaveBeenCalledWith(bot.id);
    expect(f.fake.icons).toEqual([{ appId: result.record.appId, bytes: Buffer.from([1, 2, 3]), mime: "image/png" }]);
    const url = new URL(result.authorizeUrl), state = stateOf(result);
    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: result.record.clientId,
      scope: SLACK_BOT_SCOPES.join(","), redirect_uri: redirectUrl, state });
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    expect(result.record.oauthState).toEqual({ hash: createHash("sha256").update(state).digest("hex"), expiresAt: f.now() + 15 * 60_000 });
    const plaintext = decryptBrowserState(readFileSync(join(f.dataDir, SLACK_SECRETS_FILE)), key.get());
    expect(plaintext.includes(state)).toBe(false);
    expect(JSON.stringify(f.store.bot(bot.id)).includes(state)).toBe(false);
    expect(new SlackSecretStore({ dataDir: f.dataDir, key }).bot(bot.id)).toEqual(result.record);
  });

  it("skips missing icons and ignores icon failures with fixed logs", async () => {
    const icon = vi.fn<NonNullable<ProvisionDeps["icon"]>>(async () => null);
    const f = await fixture(icon);
    await f.provisioner.provision(bot);
    expect(f.fake.icons).toHaveLength(0);
    expect(f.log).toHaveBeenLastCalledWith("Slack bot icon is unavailable and was skipped.");
    icon.mockRejectedValueOnce(new Error("icon-secret-canary"));
    await f.provisioner.provision(bot);
    expect(f.log).toHaveBeenLastCalledWith("Slack bot icon could not be updated.");
    icon.mockResolvedValue({ bytes: new Uint8Array([1]), name: "bot.png", mime: "image/png" });
    f.fake.fail("apps.icon.set", "invalid_arguments");
    await f.provisioner.provision(bot);
    expect(f.fake.icons).toHaveLength(0);
    expect(JSON.stringify(f.log.mock.calls).includes("icon-secret-canary")).toBe(false);
  });

  it("reuses a provisioned app, updates a changed manifest and replaces the previous state", async () => {
    const f = await fixture();
    const first = await f.provisioner.provision(bot);
    const second = await f.provisioner.provision(bot);
    expect(second.record.appId).toBe(first.record.appId);
    expect(f.fake.apps.size).toBe(1);
    expect(f.fake.callsTo("apps.manifest.create")).toHaveLength(1);
    expect(f.fake.callsTo("apps.manifest.update")).toHaveLength(0);
    expect(stateOf(second) === stateOf(first)).toBe(false);
    await expect(f.provisioner.exchange(f.fake.mintCode(first.record.appId), stateOf(first))).rejects.toMatchObject({ code: "bad_state" });
    const changed = await f.provisioner.provision({ ...bot, name: "Renamed" });
    expect(f.fake.callsTo("apps.manifest.update")).toHaveLength(1);
    expect(f.fake.apps.get(changed.record.appId)?.manifest).toEqual(buildSlackManifest({ ...bot, name: "Renamed" }, redirectUrl));
    expect(f.store.bots()).toHaveLength(1);
  });

  it.each(["app_id", "credentials"])("refuses a create response missing %s without saving a bot", async (field) => {
    const f = await fixture();
    f.transform((method, body) => { if (method === "apps.manifest.create") delete body[field]; return body; });
    await expect(f.provisioner.provision(bot)).rejects.toMatchObject({ code: "bad_response" });
    expect(f.store.bot(bot.id)).toBeNull();
  });

  it("exchanges once without Bearer auth, saves installation and refuses provisioning again", async () => {
    const f = await fixture();
    const pending = await f.provisioner.provision(bot);
    f.store.patchBot(bot.id, { error: "Previous failure." });
    const code = f.fake.mintCode(pending.record.appId);
    const installed = await f.provisioner.exchange(code, stateOf(pending));
    expect(installed).toMatchObject({ botUserId: "U0BOT1", teamName: "Fake Team", handle: bot.name, installedAt: f.now() });
    expect(installed.botToken?.startsWith("xoxb-")).toBe(true);
    expect(installed).not.toHaveProperty("oauthState");
    expect(installed).not.toHaveProperty("error");
    expect(f.store.bot(bot.id)).toEqual(installed);
    expect(f.fake.callsTo("oauth.v2.access")[0]).toMatchObject({ token: null, params: {
      client_id: pending.record.clientId, client_secret: pending.record.clientSecret, code, redirect_uri: redirectUrl,
    } });
    expect(f.fake.callsTo("users.info")[0].token === installed.botToken).toBe(true);
    await expect(f.provisioner.exchange(code, stateOf(pending))).rejects.toMatchObject({ code: "bad_state" });
    await expect(f.provisioner.provision(bot)).rejects.toMatchObject({ code: "already_installed" });
  });

  it("uses the username without a display name and keeps the bot name when lookup fails", async () => {
    const f = await fixture();
    f.transform((method, body) => method === "users.info" ? { ok: true, user: { name: "research-handle", profile: { display_name: "" } } } : body);
    expect((await f.install()).handle).toBe("research-handle");
    const other = await f.provisioner.provision({ ...bot, id: "other", name: "Other Bot" });
    f.transform((_method, body) => body);
    f.fake.fail("users.info", "user_not_found");
    expect((await f.provisioner.exchange(f.fake.mintCode(other.record.appId), stateOf(other))).handle).toBe("Other Bot");
  });

  it("rejects invalid state and code formats before making an OAuth request", async () => {
    const f = await fixture();
    const pending = await f.provisioner.provision(bot);
    for (const state of ["invalid", "A".repeat(64), "f".repeat(63), "0".repeat(64)]) {
      await expect(f.provisioner.exchange("valid-code", state)).rejects.toMatchObject({ code: "bad_state" });
    }
    for (const code of ["short", "x".repeat(257), "has spaces", "bad&code"]) {
      await expect(f.provisioner.exchange(code, stateOf(pending))).rejects.toMatchObject({ code: "bad_code" });
    }
    expect(f.fake.callsTo("oauth.v2.access")).toHaveLength(0);
  });

  it("consumes expired state without exchanging it", async () => {
    const f = await fixture();
    const pending = await f.provisioner.provision(bot);
    const code = f.fake.mintCode(pending.record.appId);
    f.advance(15 * 60_000 + 1);
    await expect(f.provisioner.exchange(code, stateOf(pending))).rejects.toMatchObject({ code: "expired_state" });
    await expect(f.provisioner.exchange(code, stateOf(pending))).rejects.toMatchObject({ code: "bad_state" });
    expect(f.fake.callsTo("oauth.v2.access")).toHaveLength(0);
    expect(f.store.bot(bot.id)).not.toHaveProperty("oauthState");
  });

  it("consumes state before Slack responds, including a failed exchange", async () => {
    const f = await fixture();
    const pending = await f.provisioner.provision(bot);
    const code = f.fake.mintCode(pending.record.appId);
    f.fake.fail("oauth.v2.access", "invalid_code");
    f.fake.delay("oauth.v2.access", 20);
    const first = f.provisioner.exchange(code, stateOf(pending));
    expect(f.store.bot(bot.id)).not.toHaveProperty("oauthState");
    await expect(f.provisioner.exchange(code, stateOf(pending))).rejects.toMatchObject({ code: "bad_state" });
    await expect(first).rejects.toMatchObject({ code: "invalid_code" });
    await expect(f.provisioner.exchange(code, stateOf(pending))).rejects.toMatchObject({ code: "bad_state" });
    expect(f.fake.callsTo("oauth.v2.access")).toHaveLength(1);
  });

  it("binds state to its bot and refuses a code minted for another app", async () => {
    const f = await fixture();
    const first = await f.provisioner.provision(bot);
    const other = await f.provisioner.provision({ ...bot, id: "other" });
    await expect(f.provisioner.exchange(f.fake.mintCode(other.record.appId), stateOf(first))).rejects.toMatchObject({ code: "invalid_code" });
    expect(f.store.bot(bot.id)?.botToken).toBeUndefined();
    expect(f.store.bot("other")?.oauthState).toBeDefined();
  });

  it.each(["wrong_app", "wrong_team"])("refuses a successful OAuth response with %s", async (reason) => {
    const f = await fixture();
    const pending = await f.provisioner.provision(bot);
    f.transform((method, body) => {
      if (method !== "oauth.v2.access") return body;
      return reason === "wrong_app" ? { ...body, app_id: "AOTHER" } : { ...body, team: { id: "TOTHER", name: "Other Team" } };
    });
    await expect(f.provisioner.exchange(f.fake.mintCode(pending.record.appId), stateOf(pending))).rejects.toMatchObject({ code: reason });
    expect(f.store.bot(bot.id)?.botToken).toBeUndefined();
    expect(f.store.bot(bot.id)).not.toHaveProperty("oauthState");
    expect(f.fake.callsTo("users.info")).toHaveLength(0);
  });

  it.each(["access_token", "bot_user_id"])("refuses OAuth responses missing %s", async (field) => {
    const f = await fixture();
    const pending = await f.provisioner.provision(bot);
    f.transform((method, body) => { if (method === "oauth.v2.access") delete body[field]; return body; });
    await expect(f.provisioner.exchange(f.fake.mintCode(pending.record.appId), stateOf(pending))).rejects.toMatchObject({ code: "bad_response" });
    expect(f.store.bot(bot.id)?.botToken).toBeUndefined();
  });

  it("refuses non-bot OAuth tokens", async () => {
    const f = await fixture();
    const pending = await f.provisioner.provision(bot);
    f.transform((method, body) => method === "oauth.v2.access" ? { ...body, access_token: "xoxp-test-secret" } : body);
    await expect(f.provisioner.exchange(f.fake.mintCode(pending.record.appId), stateOf(pending))).rejects.toMatchObject({ code: "bad_response" });
  });

  it("uses the saved redirect and consumes state after a bad redirect refusal", async () => {
    const f = await fixture();
    const pending = await f.provisioner.provision(bot);
    f.store.patchBot(bot.id, { redirectUri: "https://other.example.test/callback" });
    const code = f.fake.mintCode(pending.record.appId);
    await expect(f.provisioner.exchange(code, stateOf(pending))).rejects.toMatchObject({ code: "bad_redirect_uri" });
    await expect(f.provisioner.exchange(code, stateOf(pending))).rejects.toMatchObject({ code: "bad_state" });
  });

  it("validates and saves app-level tokens without auth.test or retaining the socket URL", async () => {
    const f = await fixture();
    const installed = await f.install();
    const token = f.fake.mintAppToken(installed.appId);
    const authCalls = f.fake.callsTo("auth.test").length;
    expect(await f.provisioner.setAppToken(bot.id, token)).toMatchObject({ appToken: token, appTokenAt: f.now() });
    expect(f.fake.callsTo("apps.connections.open")).toHaveLength(1);
    expect(f.fake.callsTo("auth.test")).toHaveLength(authCalls);
    expect(JSON.stringify(f.store.bot(bot.id))).not.toContain("ticket=");
    expect(JSON.stringify(f.log.mock.calls)).not.toContain("ticket=");
    f.fake.revokeAppToken(token);
    await expect(f.provisioner.setAppToken(bot.id, token)).rejects.toMatchObject({ code: "invalid_auth" });
  });

  it("rejects invalid app token formats and requires an installed bot", async () => {
    const f = await fixture();
    for (const token of ["bad", "xapp-short", `xapp-${"x".repeat(301)}`, `xapp-${"x".repeat(20)}!`]) {
      await expect(f.provisioner.setAppToken(bot.id, token)).rejects.toMatchObject({ code: "bad_app_token" });
    }
    const pending = await f.provisioner.provision(bot);
    const token = f.fake.mintAppToken(pending.record.appId);
    await expect(f.provisioner.setAppToken(bot.id, token)).rejects.toMatchObject({ code: "not_installed" });
    await expect(f.provisioner.setAppToken("missing", token)).rejects.toMatchObject({ code: "not_installed" });
    expect(f.fake.callsTo("apps.connections.open")).toHaveLength(0);
  });

  it("updates only changed manifests and retains the old hash after a failure for retry", async () => {
    const f = await fixture();
    await f.provisioner.provision(bot);
    await f.provisioner.update(bot);
    await f.provisioner.update({ ...bot, id: "missing" });
    expect(f.fake.callsTo("apps.manifest.update")).toHaveLength(0);
    const renamed = { ...bot, name: "New name" };
    await f.provisioner.update(renamed);
    await f.provisioner.update(renamed);
    expect(f.fake.callsTo("apps.manifest.update")).toHaveLength(1);
    const oldHash = f.store.bot(bot.id)!.manifestHash;
    const recolored = { ...renamed, color: "blue" };
    f.fake.fail("apps.manifest.update", "invalid_auth");
    await f.provisioner.update(recolored);
    expect(f.store.bot(bot.id)!.manifestHash).toBe(oldHash);
    expect(f.log).toHaveBeenLastCalledWith("Slack bot manifest could not be updated.");
    await f.provisioner.update(recolored);
    expect(f.store.bot(bot.id)!.manifestHash).toBe(manifestHash(buildSlackManifest(recolored, redirectUrl)));
    expect(f.fake.callsTo("apps.manifest.update")).toHaveLength(3);
    f.tokens.disconnect();
    await f.provisioner.update(bot);
    expect(f.fake.callsTo("apps.manifest.update")).toHaveLength(3);
  });

  it("revokes and deletes the bot, and is safe to remove twice", async () => {
    const f = await fixture();
    const installed = await f.install();
    await f.provisioner.remove(bot.id);
    await f.provisioner.remove(bot.id);
    expect(f.store.bot(bot.id)).toBeNull();
    expect(f.fake.apps.has(installed.appId)).toBe(false);
    expect(f.fake.callsTo("auth.revoke")).toHaveLength(1);
    expect(f.fake.callsTo("apps.manifest.delete")).toHaveLength(1);
    await expect(f.api.call("auth.test", installed.botToken!)).rejects.toMatchObject({ code: "invalid_auth" });
  });

  it.each(["app_not_found", "invalid_auth"])("removes the local record despite Slack refusal %s", async (code) => {
    const f = await fixture();
    await f.install();
    f.log.mockClear();
    f.fake.fail("auth.revoke", "invalid_auth");
    f.fake.fail("apps.manifest.delete", code);
    await expect(f.provisioner.remove(bot.id)).resolves.toBeUndefined();
    expect(f.store.bot(bot.id)).toBeNull();
    expect(f.log.mock.calls.flat()).toEqual(code === "app_not_found"
      ? ["Slack bot token could not be revoked."]
      : ["Slack bot token could not be revoked.", "Slack bot app could not be deleted."]);
  });

  it("requires a connected workspace to provision but can remove when it is gone", async () => {
    const f = await fixture();
    await f.install();
    f.store.setWorkspace({ ...f.store.workspace()!, state: "needs_reconnect" });
    await expect(f.provisioner.provision({ ...bot, id: "other" })).rejects.toMatchObject({ code: "needs_reconnect" });
    f.tokens.disconnect();
    await expect(f.provisioner.provision({ ...bot, id: "other" })).rejects.toMatchObject({ code: "needs_reconnect" });
    await f.provisioner.remove(bot.id);
    expect(f.store.bot(bot.id)).toBeNull();
    expect(f.fake.callsTo("apps.manifest.delete")).toHaveLength(0);
    expect(f.fake.callsTo("auth.revoke")).toHaveLength(1);
  });

  it("keeps tokens, secrets, codes and raw state out of logs and error messages", async () => {
    const f = await fixture();
    const pending = await f.provisioner.provision(bot);
    const code = f.fake.mintCode(pending.record.appId), state = stateOf(pending);
    const secrets = [...f.store.secretValues(), code, state];
    f.fake.fail("oauth.v2.access", "invalid_code");
    const error = await f.provisioner.exchange(code, state).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "invalid_code" });
    const installed = await f.install();
    const appToken = f.fake.mintAppToken(installed.appId);
    await f.provisioner.setAppToken(bot.id, appToken);
    f.fake.fail("apps.manifest.update", "invalid_auth");
    await f.provisioner.update({ ...bot, name: "Changed" });
    for (const secret of [...secrets, ...f.store.secretValues()]) {
      expect(String(error).includes(secret)).toBe(false);
      expect(JSON.stringify(f.log.mock.calls).includes(secret)).toBe(false);
    }
    const retry = await f.provisioner.provision({ ...bot, id: "retry" });
    f.fake.fail("oauth.v2.access", "canary_oauth_code");
    const reflected = await f.provisioner.exchange("canary_oauth_code", stateOf(retry)).catch((error: unknown) => error);
    expect(reflected).toMatchObject({ code: "bad_response" });
    expect(String(reflected).includes("canary_oauth_code")).toBe(false);
  });
});
