import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDashboardApp } from "./app.ts";
import { COMPUTER_PAIR_LIMITS, presenceOf } from "./app-computers.ts";
import { ACCOUNT_ROUTES, type AppComputersAnswer, type AppGrant, type EmailStartAnswer, type EnrollGrantAnswer } from "../../../shared/account-api.ts";
import { APP_COMMAND_ONLINE_MS, SIGNATURE_HEADERS, signedPayload, type EnrollAnswer, type ReportAnswer, type WorkspaceReport } from "../../../shared/dashboard-protocol.ts";
import { mobileLinkUrl, MOBILE_GRANT_TTL_MS } from "../../../shared/mobile-link.ts";
import { memoryMailer } from "./auth/mail.ts";

async function body<T>(response: Response | Promise<Response>): Promise<T> { return (await response).json() as Promise<T>; }

describe("the phone's computers", () => {
  let dataDir: string, url: string, time: number, server: Server, nonce: number;
  let app: ReturnType<typeof createDashboardApp>;
  let mailer: ReturnType<typeof memoryMailer>;
  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "madani-computers-test-"));
    time = Date.now(); nonce = 0; mailer = memoryMailer();
    app = createDashboardApp({ dataDir, publicUrl: "http://127.0.0.1:7480", mailer, staticDir: null, now: () => time });
    server = createServer(app.handle);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture did not start.");
    url = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    app.close();
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
    rmSync(dataDir, { recursive: true, force: true });
  });
  function call(path: string, data?: unknown, headers: Record<string, string> = {}, method = data === undefined ? "GET" : "POST") {
    return fetch(url + path, { method, headers: { ...(data === undefined ? {} : { "content-type": "application/json" }), ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  }
  const bearer = (grant: AppGrant) => ({ authorization: `Bearer ${grant.accessToken}` });
  async function appLogin(email: string): Promise<AppGrant> {
    const started = await body<EmailStartAnswer>(call("/api/cloud/app/sign-in/start", { email, deviceName: "Fixture Phone", platform: "ios", appVersion: "1.0.0" }));
    const code = mailer.outbox.findLast(item => item.to === email)!.text.match(/\b\d{8}\b/)![0];
    return body<AppGrant>(call("/api/cloud/app/sign-in/verify", { attempt: started.attempt, code }));
  }
  type Computer = { id: string; keys: { publicKey: KeyObject; privateKey: KeyObject } };
  async function computer(owner: AppGrant, name = "Studio Mac"): Promise<Computer> {
    const grant = await body<EnrollGrantAnswer>(call("/v1/app/enroll-grant", {}, bearer(owner)));
    const keys = generateKeyPairSync("ed25519");
    const input = { v: 1, publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"), name, kind: "mac", version: "1.0.0", enrollToken: grant.enrollToken };
    const raw = JSON.stringify(input), at = time + ++nonce;
    const signature = sign(null, Buffer.from(signedPayload("POST", "/v1/enroll", at, createHash("sha256").update(raw).digest("hex"))), keys.privateKey).toString("base64");
    const enrolled = await body<EnrollAnswer>(call("/v1/enroll", input, { [SIGNATURE_HEADERS.time]: String(at), [SIGNATURE_HEADERS.signature]: signature }));
    const ws = { id: enrolled.workspaceId, keys };
    expect((await signed(ws, "/v1/report", report())).status).toBe(200);
    return ws;
  }
  function signed(ws: Computer, path: string, report?: WorkspaceReport) {
    const raw = report ? JSON.stringify(report) : "", method = report ? "POST" : "GET", at = time + ++nonce;
    const signature = sign(null, Buffer.from(signedPayload(method, path, at, createHash("sha256").update(raw).digest("hex"))), ws.keys.privateKey).toString("base64");
    return fetch(url + path, { method, headers: { "content-type": "application/json", [SIGNATURE_HEADERS.workspace]: ws.id, [SIGNATURE_HEADERS.time]: String(at), [SIGNATURE_HEADERS.signature]: signature }, ...(report ? { body: raw } : {}) });
  }
  let seq = 0;
  const report = (extra: Partial<WorkspaceReport> = {}): WorkspaceReport => ({ v: 1, seq: ++seq, at: time, workspace: { name: "Studio Mac", kind: "mac", version: "1.0.0", platform: "darwin", environmentId: "env-studio" }, ...extra });
  const link = () => mobileLinkUrl({ v: 2, workspace: { name: "Studio Mac", environmentId: "env-studio", kind: "mac" }, grant: { id: "grant-1", secret: "madani_pair_secret", expiresAt: time + MOBILE_GRANT_TTL_MS },
    via: [{ kind: "companion", url: "http://192.168.1.4:5331", net: "lan", priority: 1 }] });
  /** the computer side: picks up the queued phone.pair and answers it */
  async function answerPairing(ws: Computer, result: { ok: boolean; link?: string; reason?: "unreachable" | "refused" }) {
    const waited = await body<ReportAnswer>(signed(ws, "/v1/wait?wait=1"));
    const command = waited.commands.find(item => item.kind === "phone.pair")!;
    expect(command.target).toBe("Fixture Phone");
    expect((await signed(ws, "/v1/report", report({ results: [{ id: command.id, message: null, at: time, ...result }] }))).status).toBe(200);
  }

  it("lists only the account's own computers, with presence and the computer's own id", async () => {
    const owner = await appLogin("owner@example.test"), other = await appLogin("other@example.test");
    expect((await call(ACCOUNT_ROUTES.appComputers)).status).toBe(401);
    const mac = await computer(owner);
    await computer(other, "Someone else's Mac");
    expect(await body<AppComputersAnswer>(call(ACCOUNT_ROUTES.appComputers, undefined, bearer(owner)))).toEqual({ v: 1, computers: [
      { id: mac.id, name: "Studio Mac", kind: "mac", presence: "online", lastSeenAt: time, environmentId: "env-studio" }] });
    time += APP_COMMAND_ONLINE_MS + 1;
    const later = await body<AppComputersAnswer>(call(ACCOUNT_ROUTES.appComputers, undefined, bearer(owner)));
    expect(later.computers[0]).toMatchObject({ presence: "asleep", environmentId: "env-studio" });
    expect((await body<AppComputersAnswer>(call(ACCOUNT_ROUTES.appComputers, undefined, bearer(other)))).computers.map(item => item.name)).toEqual(["Someone else's Mac"]);
  });

  it("brokers a pairing link from an online computer to its own account's phone, and never stores it", async () => {
    const owner = await appLogin("owner@example.test");
    const mac = await computer(owner);
    const asked = call(ACCOUNT_ROUTES.appComputerPair(mac.id), {}, bearer(owner));
    const pairing = link();
    await answerPairing(mac, { ok: true, link: pairing });
    const response = await asked;
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await body(response)).toEqual({ v: 1, link: pairing, expiresAt: time + MOBILE_GRANT_TTL_MS });
    app.close();
    expect(readFileSync(join(dataDir, "state.json"), "utf8")).not.toContain(pairing.slice(20, 80));
  });

  it("denies another account's computer as missing, and says offline or unreachable", async () => {
    const owner = await appLogin("owner@example.test"), other = await appLogin("other@example.test");
    const mac = await computer(owner);
    expect((await call(ACCOUNT_ROUTES.appComputerPair(mac.id), {})).status).toBe(401);
    const denied = await call(ACCOUNT_ROUTES.appComputerPair(mac.id), {}, bearer(other));
    expect(denied.status).toBe(404);
    expect(await body(denied)).toMatchObject({ code: "not_found" });
    expect((await call(ACCOUNT_ROUTES.appComputerPair("../ws_x"), {}, bearer(owner))).status).toBe(404);
    expect(await body<ReportAnswer>(signed(mac, "/v1/wait?wait=1"))).toMatchObject({ commands: [] });

    const unreachable = call(ACCOUNT_ROUTES.appComputerPair(mac.id), {}, bearer(owner));
    await answerPairing(mac, { ok: false, reason: "unreachable" });
    expect(await body(unreachable)).toMatchObject({ code: "computer_unreachable" });
    const refused = call(ACCOUNT_ROUTES.appComputerPair(mac.id), {}, bearer(owner));
    await answerPairing(mac, { ok: true, link: "madanibot://pair?m=bm90LWEtcGF5bG9hZA" });
    expect(await body(refused)).toMatchObject({ code: "pair_refused" });

    time += APP_COMMAND_ONLINE_MS + 1;
    const asleep = await call(ACCOUNT_ROUTES.appComputerPair(mac.id), {}, bearer(owner));
    expect(asleep.status).toBe(409);
    expect(await body(asleep)).toMatchObject({ code: "computer_offline" });
  });

  it("limits how often one account asks", async () => {
    const owner = await appLogin("owner@example.test");
    const mac = await computer(owner);
    for (let i = 0; i < COMPUTER_PAIR_LIMITS.perAccount; i++) {
      const asked = call(ACCOUNT_ROUTES.appComputerPair(mac.id), {}, bearer(owner));
      await answerPairing(mac, { ok: false, reason: "refused" });
      expect((await asked).status).toBe(409);
    }
    expect((await call(ACCOUNT_ROUTES.appComputerPair(mac.id), {}, bearer(owner))).status).toBe(429);
  });

  it("calls a computer asleep after it stops holding its line, and offline after a day", () => {
    expect(presenceOf(null, 10)).toBe("offline");
    expect(presenceOf(0, APP_COMMAND_ONLINE_MS)).toBe("online");
    expect(presenceOf(0, APP_COMMAND_ONLINE_MS + 1)).toBe("asleep");
    expect(presenceOf(0, 24 * 60 * 60_000 + 1)).toBe("offline");
  });
});
