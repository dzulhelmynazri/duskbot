import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { parseAiSignInList } from "../../shared/ai-signins.ts";
import { applyCloudAiSignIns, CLOUD_AI_SIGNINS_PATH, signedInDrivers, type CloudAiSignIn } from "../cloud-ai-signins.ts";
import { createCloudHealth } from "../cloud-health.ts";
import { cloudRequestSignature } from "../cloud-home.ts";
import { DATA_DIR } from "../config.ts";
import { SessionRegistry } from "../sessions.ts";
import { createCloudSignedRoutes } from "./cloud-signed.ts";

const secret = "S".repeat(43);
const auth = JSON.stringify({ tokens: { access_token: "held-token" } });
const cleanup: string[] = [];
afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function routes() {
  let counter = 0;
  const now = () => 1_800_000_000_000;
  const got: CloudAiSignIn[][] = [];
  const sessions = new SessionRegistry({ file: join(DATA_DIR, "sessions.json"), now });
  const health = createCloudHealth({
    store: { onChange: () => () => {}, botByThread: () => null, bots: [] }, bus: { subscribe: () => () => {} },
    engines: () => [], dataDir: DATA_DIR, eventsDir: DATA_DIR, version: "0.1.0", image: undefined, connectors: () => null,
    browser: () => ({ available: true, installing: false, interrupted: 0 }), now,
  });
  const handle = createCloudSignedRoutes({ secret, sessions, health, now, aiSignIns: async (items) => { got.push(items); } });
  const sign = (body: string, key = secret) => {
    const timestamp = String(Math.floor(now() / 1000)), nonce = `nonce-${String(++counter).padStart(12, "0")}`;
    return { "content-type": "application/json", "x-madani-cloud-timestamp": timestamp, "x-madani-cloud-nonce": nonce,
      "x-madani-cloud-signature": `v1=${cloudRequestSignature(key, timestamp, nonce, "POST", CLOUD_AI_SIGNINS_PATH, body)}` };
  };
  const send = async (headers: Record<string, string>, body: string) => {
    const req = Object.assign(new PassThrough(), { method: "POST", url: CLOUD_AI_SIGNINS_PATH, headers, socket: { remoteAddress: "127.0.0.1" } }) as unknown as IncomingMessage;
    let status = 0, text = "";
    const res = { setHeader() {}, writeHead(code: number) { status = code; }, end(data: string) { text = data; } } as unknown as ServerResponse;
    const url = new URL(CLOUD_AI_SIGNINS_PATH, "http://localhost");
    const answered = handle({ req, res, url, path: url.pathname, method: "POST" });
    (req as unknown as PassThrough).end(body);
    return { answered: await answered, status, body: text ? JSON.parse(text) : null };
  };
  return { sign, send, got };
}

describe("POST /api/cloud/ai-signins", () => {
  it("takes the Admin's signed held sign-ins once, and nothing unsigned, replayed or malformed", async () => {
    const { sign, send, got } = routes();
    const body = JSON.stringify({ v: 1, items: [{ kind: "codex-auth", auth }] });
    const once = sign(body);
    expect(await send(once, body)).toEqual({ answered: true, status: 200, body: { ok: true } });
    expect((await send(once, body)).body).toEqual({ error: "replayed_request" });
    expect((await send(sign(body, "F".repeat(43)), body)).status).toBe(401);
    for (const bad of [{ v: 1, items: [] }, { v: 1, items: [{ kind: "claude-token", auth: "x" }] }, { v: 1, items: [{ kind: "codex-auth", auth: "nope" }] }]) {
      const text = JSON.stringify(bad);
      expect((await send(sign(text), text)).status).toBe(400);
    }
    expect(got).toEqual([[{ kind: "codex-auth", auth }]]);
  });
});

describe("applying held sign-ins", () => {
  it("writes the ChatGPT login only where none is, readable by this account alone", () => {
    const home = mkdtempSync(join(tmpdir(), "madani-codex-home-"));
    cleanup.push(home);
    const env = { CODEX_HOME: join(home, "codex") };
    expect(applyCloudAiSignIns([{ kind: "codex-auth", auth }], env)).toEqual({ applied: ["codex-auth"], kept: [] });
    const file = join(home, "codex", "auth.json");
    expect(readFileSync(file, "utf8")).toBe(auth);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    writeFileSync(file, "{\"mine\":true}");
    expect(applyCloudAiSignIns([{ kind: "codex-auth", auth }], env)).toEqual({ applied: [], kept: ["codex-auth"] });
    expect(readFileSync(file, "utf8")).toBe("{\"mine\":true}");
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
  });

  it("writes Grok, Gemini and Kimi logins where their CLIs read them, and keeps any login already there", () => {
    const home = mkdtempSync(join(tmpdir(), "madani-cli-home-"));
    cleanup.push(home);
    const env = { HOME: home };
    const grok = JSON.stringify({ "https://auth.x.ai::id": { refresh_token: "grok-secret" } });
    const gemini = JSON.stringify({ access_token: "gemini-secret", refresh_token: "r" });
    const kimi = JSON.stringify({ access_token: "kimi-secret", refresh_token: "r" });
    const items = [{ kind: "grok-auth" as const, auth: grok }, { kind: "gemini-oauth" as const, auth: gemini }, { kind: "kimi-auth" as const, auth: kimi, file: "kimi-code-env-ab12.json" }];
    expect(applyCloudAiSignIns(items, env)).toEqual({ applied: ["grok-auth", "gemini-oauth", "kimi-auth"], kept: [] });
    expect(readFileSync(join(home, ".grok", "auth.json"), "utf8")).toBe(grok);
    expect(readFileSync(join(home, ".gemini", "oauth_creds.json"), "utf8")).toBe(gemini);
    expect(readFileSync(join(home, ".kimi-code", "credentials", "kimi-code-env-ab12.json"), "utf8")).toBe(kimi);
    expect(applyCloudAiSignIns([{ ...items[2]!, file: "kimi-code.json" }], env), "a Kimi login for another region is still a login").toEqual({ applied: [], kept: ["kimi-auth"] });
    expect(signedInDrivers(["codex-auth", "grok-auth", "gemini-oauth", "kimi-auth"])).toEqual(new Set(["codex", "grokAgent", "geminiAgent", "kimiAgent"]));
  });
});

describe("the held sign-ins' shape", () => {
  it("takes one of each CLI login, a Kimi one with its token file's name, and nothing else", () => {
    const one = (kind: string, extra: object = {}) => ({ kind, auth, ...extra });
    expect(parseAiSignInList([one("codex-auth"), one("grok-auth"), one("gemini-oauth"), one("kimi-auth", { file: "kimi-code.json" })])).toHaveLength(4);
    expect(parseAiSignInList([one("kimi-auth")]), "a Kimi login names its file").toBeNull();
    expect(parseAiSignInList([one("kimi-auth", { file: "../../.ssh/authorized_keys" })]), "never a path").toBeNull();
    expect(parseAiSignInList([one("grok-auth", { file: "kimi-code.json" })])).toBeNull();
    expect(parseAiSignInList([one("grok-auth"), one("grok-auth")])).toBeNull();
    expect(parseAiSignInList([one("claude-token")]), "a Claude sign-in is never carried").toBeNull();
    expect(parseAiSignInList([one("cursor-auth")])).toBeNull();
    const big = JSON.stringify({ x: "y".repeat(30_000) });
    expect(parseAiSignInList([{ kind: "codex-auth", auth: big }, { kind: "grok-auth", auth: big }, { kind: "gemini-oauth", auth: big }]), "the whole set stays small").toBeNull();
  });
});

