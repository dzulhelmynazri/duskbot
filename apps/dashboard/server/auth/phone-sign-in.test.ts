import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDashboardApp, type DashboardAppOptions } from "../app.ts";
import { AUTH_LIMITS, PHONE_CODE_REMEMBERED_MS, PHONE_CODES_OUTSTANDING } from "./index.ts";
import { memoryMailer } from "./mail.ts";
import { ACCOUNT_ROUTES, cleanPhoneSignInCode, PHONE_SIGN_IN_TTL_MS, type AppGrant, type EmailStartAnswer, type PhoneSignInGrant } from "../../../../shared/account-api.ts";
import { PAIRING_CODE_ALPHABET } from "../../../../server/sessions.ts";
import { createCloudAccountClient } from "../../../../electron/cloud-account.mjs";

const desktop = { deviceName: "Fixture Mac", platform: "darwin", appVersion: "1.2.3" };
const phone = { deviceName: "Fixture iPhone", platform: "ios", appVersion: "1.0.0" };
const email = "owner@example.test";
async function body<T>(response: Response | Promise<Response>): Promise<T> { return (await response).json() as Promise<T>; }

describe("phone sign-in codes", () => {
  let dataDir: string, url: string, time: number, server: Server, ipCounter = 0;
  let app: ReturnType<typeof createDashboardApp>;
  let mailer: ReturnType<typeof memoryMailer>;
  let options: DashboardAppOptions;
  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "madani-phone-code-test-"));
    time = Date.now(); mailer = memoryMailer();
    options = { dataDir, publicUrl: "http://127.0.0.1:7480", mailer, staticDir: null, now: () => time, trustProxy: true };
    app = createDashboardApp(options);
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
  function restart() {
    app.close(); app = createDashboardApp(options);
    server.removeAllListeners("request"); server.on("request", app.handle);
  }
  function call(path: string, data: unknown, headers: Record<string, string> = {}) {
    return fetch(url + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(data) });
  }
  const mailed = (address: string) => mailer.outbox.findLast(item => item.to === address && /\b\d{8}\b/.test(item.text))!.text.match(/\b\d{8}\b/)![0];
  async function signIn(address = email, device: Record<string, string> = desktop): Promise<AppGrant> {
    const started = await body<EmailStartAnswer>(call(ACCOUNT_ROUTES.appEmailStart, { email: address, ...device }));
    const response = await call(ACCOUNT_ROUTES.appEmailVerify, { attempt: started.attempt, code: mailed(address) });
    expect(response.status).toBe(200);
    return body<AppGrant>(response);
  }
  const bearer = (grant: AppGrant) => ({ authorization: `Bearer ${grant.accessToken}` });
  const mint = (grant: AppGrant) => call(ACCOUNT_ROUTES.phoneSignIn, {}, bearer(grant));
  // each redeem from its own address unless a test is about one address's limit
  const redeem = (code: unknown, ip = `10.0.0.${++ipCounter % 250}`) => call(ACCOUNT_ROUTES.appPhoneSignIn, { code, ...phone }, { "x-forwarded-for": ip });

  it("a signed-in desktop mints a short letters-only code that logs a phone in once, as the same account", async () => {
    const mac = await signIn();
    const response = await mint(mac);
    expect(response.status).toBe(200);
    const grant = await body<PhoneSignInGrant>(response);
    expect(grant).toEqual({ v: 1, code: expect.stringMatching(/^[A-Z]{4}-[A-Z]{4}$/), expiresAt: time + PHONE_SIGN_IN_TTL_MS, email });
    expect([...grant.code.replace("-", "")].every(char => PAIRING_CODE_ALPHABET.includes(char))).toBe(true);

    // typed loosely: lowercase, spaces, no dash
    const signedIn = await redeem(grant.code.toLowerCase().replace("-", " "));
    expect(signedIn.status).toBe(200);
    const phoneGrant = await body<AppGrant>(signedIn);
    expect(phoneGrant.account.email).toBe(email);
    expect(phoneGrant.account.id).toBe(mac.account.id);
    expect(phoneGrant.accessToken).toMatch(/^omc_/);
    // a real session: the phone reads its account with it, and it is listed as a phone
    const session = await fetch(url + ACCOUNT_ROUTES.appSession, { headers: bearer(phoneGrant) });
    expect(session.status).toBe(200);
    expect((await body<{ account: { email: string } }>(session)).account.email).toBe(email);

    const again = await redeem(grant.code);
    expect(again.status).toBe(409);
    expect(await body(again)).toEqual({ error: "used" });
  });

  it("says expired once the ten minutes are up, and wrong for a code nobody made", async () => {
    const grant = await body<PhoneSignInGrant>(mint(await signIn()));
    time += PHONE_SIGN_IN_TTL_MS;
    const late = await redeem(grant.code);
    expect(late.status).toBe(410);
    expect(await body(late)).toEqual({ error: "expired" });

    const wrong = await redeem(grant.code === "ABCD-EFGH" ? "ABCD-EFGJ" : "ABCD-EFGH");
    expect(wrong.status).toBe(400);
    expect(await body(wrong)).toEqual({ error: "invalid_code" });
    // digits, I and O are never in a code
    expect((await redeem("ABCD-EF12")).status).toBe(400);
    expect((await redeem("ABCD-EFGO")).status).toBe(400);

    // remembered for a while, then forgotten like any unknown code
    time += PHONE_CODE_REMEMBERED_MS;
    expect(await body(redeem(grant.code))).toEqual({ error: "invalid_code" });
  });

  it("survives a restart of the service between showing the code and typing it", async () => {
    const grant = await body<PhoneSignInGrant>(mint(await signIn()));
    restart();
    expect((await redeem(grant.code)).status).toBe(200);
  });

  it("ends with the desktop sign-in that made it", async () => {
    const mac = await signIn();
    const grant = await body<PhoneSignInGrant>(mint(mac));
    expect((await fetch(url + ACCOUNT_ROUTES.appSession, { method: "DELETE", headers: { ...bearer(mac), "content-type": "application/json" }, body: "{}" })).status).toBe(200);
    expect(await body(redeem(grant.code))).toEqual({ error: "expired" });
  });

  it("only a desktop app session mints one: never signed out, never a phone handing its sign-in on", async () => {
    expect((await call(ACCOUNT_ROUTES.phoneSignIn, {})).status).toBe(401);
    const iphone = await signIn(email, phone);
    const refused = await mint(iphone);
    expect(refused.status).toBe(403);
  });

  it("keeps only the newest few codes of an account live", async () => {
    const mac = await signIn();
    const grants: PhoneSignInGrant[] = [];
    for (let i = 0; i <= PHONE_CODES_OUTSTANDING; i++) { grants.push(await body<PhoneSignInGrant>(mint(mac))); time += 1_000; }
    expect(await body(redeem(grants[0]!.code))).toEqual({ error: "expired" });
    expect((await redeem(grants.at(-1)!.code)).status).toBe(200);
  });

  it("limits minting per desktop session", async () => {
    const mac = await signIn();
    for (let i = 0; i < AUTH_LIMITS.phoneCodesPerSession; i++) expect((await mint(mac)).status).toBe(200);
    const limited = await mint(mac);
    expect(limited.status).toBe(429);
  });

  it("limits guesses from one address, even before the code is checked", async () => {
    const grant = await body<PhoneSignInGrant>(mint(await signIn()));
    for (let i = 0; i < AUTH_LIMITS.phoneRedeemsPerIp; i++) expect((await redeem("BCDE-FGHJ", "10.9.9.9")).status).toBe(400);
    const limited = await redeem(grant.code, "10.9.9.9");
    expect(limited.status).toBe(429);
    expect(await body(limited)).toEqual({ error: "rate_limited" });
    // another address still gets in with the real code
    expect((await redeem(grant.code, "10.9.9.10")).status).toBe(200);
  });

  it("the desktop app's account client mints one, and says signed out when it is", async () => {
    let saved: unknown = null;
    const client = createCloudAccountClient({ origin: url, fixture: true, ...desktop, now: () => time,
      store: { async read() { return saved; }, async write(value: unknown) { saved = value; } },
      async openBrowser() {}, setTimer: () => 1, clearTimer() {} });
    try {
      await client.start();
      expect(await client.phoneSignIn()).toEqual({ outcome: "signed-out" });
      await client.emailStart(email);
      expect((await client.emailVerify(mailed(email))).outcome).toBe("signed-in");
      const minted = await client.phoneSignIn();
      expect(minted).toMatchObject({ outcome: "code", email, expiresAt: time + PHONE_SIGN_IN_TTL_MS });
      expect((await redeem((minted as { code: string }).code)).status).toBe(200);
    } finally { client.close?.(); }
  });

  it("asks for a valid device and code shape", async () => {
    expect((await call(ACCOUNT_ROUTES.appPhoneSignIn, { code: "ABCD-EFGH" })).status).toBe(400);
    expect(await body(redeem(42))).toEqual({ error: "invalid_code" });
  });

  it("is reachable from the phone's web build (cors)", async () => {
    const preflight = await fetch(url + ACCOUNT_ROUTES.appPhoneSignIn, { method: "OPTIONS", headers: { origin: "http://localhost:5173", "access-control-request-method": "POST" } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("cleanPhoneSignInCode", () => {
  it("takes the code however it was typed, and nothing else", () => {
    expect(cleanPhoneSignInCode("abcd-efgh")).toBe("ABCDEFGH");
    expect(cleanPhoneSignInCode(" ABCD EFGH ")).toBe("ABCDEFGH");
    expect(cleanPhoneSignInCode("ABCD-EFGH-JKLM")).toBeNull();
    expect(cleanPhoneSignInCode("ABCD-EFG1")).toBeNull();
    expect(cleanPhoneSignInCode(null)).toBeNull();
  });
});
