import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptBrowserState } from "../browser-sites.ts";
import { startFakeSlack } from "../testing/fake-slack.ts";
import { createSlackApi } from "./api.ts";
import { createConfigTokens } from "./config-token.ts";
import { SLACK_SECRETS_FILE, SlackSecretStore, SlackSecretsUnavailable } from "./secrets.ts";

const minute = 60_000;
const key = { get: () => "a".repeat(64), peek: () => "a".repeat(64) };
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
  vi.restoreAllMocks();
});

async function fixture() {
  const fake = await startFakeSlack();
  const dataDir = mkdtempSync(join(tmpdir(), "slack-config-test-"));
  const store = new SlackSecretStore({ dataDir, key });
  let clock = Date.now();
  const timers: { fn: () => void; ms: number; canceled: boolean }[] = [];
  const log = vi.fn<(line: string) => void>();
  let offline = false;
  let transform: ((method: string, body: Record<string, unknown>) => Record<string, unknown>) | undefined;
  const api = createSlackApi({
    env: { MADANI_SLACK_API_URL: fake.url }, minGapMs: 0, sleep: async () => {},
    fetch: async (url, init) => {
      if (offline) throw new Error("transport failed with secret-canary");
      const response = await fetch(url, init);
      if (!transform) return response;
      return Response.json(transform(String(url).split("/").at(-1)!, await response.json() as Record<string, unknown>));
    },
  });
  const tokens = createConfigTokens({
    store, api, now: () => clock, log,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, canceled: false };
      timers.push(timer);
      return { cancel: () => { timer.canceled = true; } };
    },
  });
  cleanup.push(async () => { tokens.stop(); await fake.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return {
    fake, store, tokens, api, log, dataDir, timers,
    now: () => clock, setNow: (value: number) => { clock = value; },
    offline: () => { offline = true; },
    transform: (fn: NonNullable<typeof transform>) => { transform = fn; },
    connect: () => tokens.connect(fake.config.access, fake.config.refresh),
    fire: () => {
      const timer = timers.findLast((entry) => !entry.canceled)!;
      timer.canceled = true;
      clock += timer.ms;
      timer.fn();
    },
  };
}

describe("Slack configuration tokens", () => {
  it("rotates the pasted pair and atomically saves the new pair and workspace", async () => {
    const f = await fixture();
    const pasted = [f.fake.config.access, f.fake.config.refresh];
    const write = vi.spyOn(f.store, "setWorkspace");
    const status = await f.connect();
    expect(f.fake.config.rotations).toBe(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(f.store.workspace()).toMatchObject({
      teamId: "T0FAKE", teamName: "Fake Team", userId: "U0OWNER", state: "connected",
      configToken: f.fake.config.access, refreshToken: f.fake.config.refresh,
      connectedAt: f.now(), rotatedAt: f.now(),
    });
    expect(status).toEqual({ version: 1, state: "connected", teamId: "T0FAKE", teamName: "Fake Team",
      expiresAt: f.store.workspace()!.expiresAt, apps: 0, ready: true });
    const expiration = f.store.workspace()!.expiresAt;
    expect(expiration % 1000).toBe(0);
    expect(expiration - Date.now()).toBeGreaterThan(12 * 60 * minute - 2000);
    const decrypted = decryptBrowserState(readFileSync(join(f.dataDir, SLACK_SECRETS_FILE)), key.get());
    for (const value of pasted) expect(decrypted.includes(value)).toBe(false);
    expect(new SlackSecretStore({ dataDir: f.dataDir, key }).workspace()).toEqual(f.store.workspace());
    expect(f.fake.callsTo("tooling.tokens.rotate")[0].token).toBeNull();
    expect(f.fake.callsTo("auth.test")[0].token === f.fake.config.access).toBe(true);
  });

  it("refuses a bad refresh token without saving anything", async () => {
    const f = await fixture();
    await expect(f.tokens.connect(f.fake.config.access, "bad-refresh-canary")).rejects.toMatchObject({ code: "invalid_refresh_token" });
    expect(f.store.workspace()).toBeNull();
    expect(f.fake.config.rotations).toBe(0);
    expect(f.timers).toHaveLength(0);
  });

  it.each(["token", "refresh_token", "exp"])("refuses a rotate response missing %s", async (field) => {
    const f = await fixture();
    f.transform((method, body) => { if (method === "tooling.tokens.rotate") delete body[field]; return body; });
    await expect(f.connect()).rejects.toMatchObject({ code: "bad_response" });
    expect(f.store.workspace()).toBeNull();
  });

  it("falls back to the team id when auth.test fails", async () => {
    const f = await fixture();
    f.fake.fail("auth.test", "invalid_auth");
    expect(await f.connect()).toMatchObject({ teamName: "T0FAKE" });
  });

  it("requires a ready secret store before making any request", async () => {
    const f = await fixture();
    const store = new SlackSecretStore({ dataDir: f.dataDir, key: { get: () => null, peek: () => null } });
    const tokens = createConfigTokens({ store, api: f.api });
    await expect(tokens.connect(f.fake.config.access, f.fake.config.refresh)).rejects.toBeInstanceOf(SlackSecretsUnavailable);
    expect(tokens.status(3)).toEqual({ version: 1, state: "not_connected", apps: 3, ready: false });
    expect(f.fake.calls).toHaveLength(0);
  });

  it("fires scheduled rotation thirty minutes before expiry and stop cancels it", async () => {
    const f = await fixture();
    await f.connect();
    expect(f.timers.at(-1)?.ms).toBe(f.store.workspace()!.expiresAt - f.now() - 30 * minute);
    f.fire();
    await f.tokens.token();
    expect(f.fake.config.rotations).toBe(2);
    expect(f.store.workspace()!.configToken === f.fake.config.access).toBe(true);
    f.tokens.stop();
    expect(f.timers.every((timer) => timer.canceled)).toBe(true);
  });

  it("start rotates immediately when due and otherwise schedules", async () => {
    const f = await fixture();
    await f.connect();
    f.tokens.stop();
    f.tokens.start();
    expect(f.timers.at(-1)?.canceled).toBe(false);
    f.tokens.stop();
    f.setNow(f.store.workspace()!.expiresAt - 29 * minute);
    f.tokens.start();
    await f.tokens.token();
    expect(f.fake.config.rotations).toBe(2);
  });

  it.each(["invalid_refresh_token", "invalid_auth", "token_revoked", "token_expired"])("marks refusal %s as needing reconnection", async (code) => {
    const f = await fixture();
    await f.connect();
    f.fake.fail("tooling.tokens.rotate", code);
    f.setNow(f.store.workspace()!.expiresAt - 10 * minute);
    await expect(f.tokens.token()).rejects.toMatchObject({ code: "needs_reconnect" });
    expect(f.tokens.status(2)).toMatchObject({ state: "needs_reconnect", apps: 2,
      error: "Slack stopped accepting the workspace token. Connect the workspace again." });
    expect(f.timers.every((timer) => timer.canceled)).toBe(true);
  });

  it("retries network failures after one, five and fifteen minutes, then stops at expiry", async () => {
    const f = await fixture();
    await f.connect();
    const original = f.store.workspace()!;
    f.setNow(original.expiresAt - 30 * minute);
    f.offline();
    f.tokens.start();
    expect(await f.tokens.token() === original.configToken).toBe(true);
    for (const delay of [minute, 5 * minute, 15 * minute, 9 * minute]) {
      expect(f.timers.at(-1)?.ms).toBe(delay);
      f.fire();
      if (f.now() < original.expiresAt) await f.tokens.token();
    }
    await expect(f.tokens.token()).rejects.toMatchObject({ code: "needs_reconnect" });
    expect(f.store.workspace()?.state).toBe("needs_reconnect");
    expect(JSON.stringify(f.log.mock.calls).includes("secret-canary")).toBe(false);
  });

  it("retries server failures while the access token is valid", async () => {
    const f = await fixture();
    await f.connect();
    f.fake.fail("tooling.tokens.rotate", "server_error");
    f.setNow(f.store.workspace()!.expiresAt - 10 * minute);
    await f.tokens.token();
    expect(f.store.workspace()?.state).toBe("connected");
    expect(f.timers.at(-1)?.ms).toBe(minute);
  });

  it("shares one rotation across concurrent callers and rotates within ten minutes", async () => {
    const f = await fixture();
    await f.connect();
    f.setNow(f.store.workspace()!.expiresAt - 10 * minute - 1);
    await f.tokens.token();
    expect(f.fake.config.rotations).toBe(1);
    f.setNow(f.store.workspace()!.expiresAt - 10 * minute);
    f.fake.delay("tooling.tokens.rotate", 20);
    const values = await Promise.all(Array.from({ length: 8 }, () => f.tokens.token()));
    expect(f.fake.config.rotations).toBe(2);
    expect(values.every((value) => value === f.fake.config.access)).toBe(true);
    expect(f.store.workspace()!.refreshToken === f.fake.config.refresh).toBe(true);
  });

  it("disconnect clears status and prevents an in-flight rotation from restoring the record", async () => {
    const f = await fixture();
    await f.connect();
    f.setNow(f.store.workspace()!.expiresAt - minute);
    f.fake.delay("tooling.tokens.rotate", 20);
    const rotation = f.tokens.token();
    f.tokens.disconnect();
    await expect(rotation).rejects.toMatchObject({ code: "needs_reconnect" });
    expect(f.store.workspace()).toBeNull();
    expect(f.tokens.status(4)).toEqual({ version: 1, state: "not_connected", apps: 4, ready: true });
    await expect(f.tokens.token()).rejects.toMatchObject({ code: "needs_reconnect" });
  });

  it("never exposes credentials in logs or errors, even when Slack echoes a form secret", async () => {
    const f = await fixture();
    const pasted = [f.fake.config.access, f.fake.config.refresh];
    f.fake.fail("auth.test", "invalid_auth");
    await f.connect();
    const values = [...pasted, ...f.store.secretValues(), "canary_refresh_secret"];
    f.fake.fail("tooling.tokens.rotate", "canary_refresh_secret");
    const error = await f.tokens.connect("canary_access_secret", "canary_refresh_secret").catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "bad_response" });
    for (const value of values) {
      expect(JSON.stringify(f.log.mock.calls).includes(value)).toBe(false);
      expect(String(error).includes(value)).toBe(false);
    }
  });
});
