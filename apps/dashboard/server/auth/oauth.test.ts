import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDashboardApp, type DashboardAppOptions } from "../app.ts";
import { startFakeProviders } from "./fake-providers.ts";
import { AUTH_LIMITS } from "./index.ts";
import { memoryMailer } from "./mail.ts";
import { pictureUrl, providersFromEnv } from "./providers.ts";
import { createCloudAccountClient } from "../../../../electron/cloud-account.mjs";
import { APP_AUTH_REDIRECT, APP_LANDING_PATH, CSRF_HEADER, type AccountAnswer, type AppGrant, type OAuthProvider, type WebSignInAnswer } from "../../../../shared/account-api.ts";

class CookieJar {
  values = new Map<string, string>();
  read(response: Response) {
    for (const cookie of response.headers.getSetCookie()) {
      const [name, value] = cookie.split(";")[0]!.split("=");
      if (cookie.includes("Max-Age=0")) this.values.delete(name!); else this.values.set(name!, value!);
    }
  }
  header() { return [...this.values].map(([name, value]) => `${name}=${value}`).join("; "); }
}
const decodeHtml = (value: string) => value.replace(/&(amp|lt|gt|quot|#39);/g, (_, entity: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[entity]!);
const random = () => randomBytes(32).toString("base64url");
const mobile = { deviceName: "Fixture phone", platform: "ios", appVersion: "1.0.0" };
describe("OAuth over isolated HTTP", () => {
  let fake: Awaited<ReturnType<typeof startFakeProviders>>, server: Server, app: ReturnType<typeof createDashboardApp>, options: DashboardAppOptions;
  let dataDir: string, url: string, time: number, jar: CookieJar, mailer: ReturnType<typeof memoryMailer>;
  beforeEach(async () => {
    fake = await startFakeProviders(); dataDir = mkdtempSync(join(tmpdir(), "madani-oauth-")); time = Date.now(); jar = new CookieJar(); mailer = memoryMailer();
    server = createServer();
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error();
    url = `http://127.0.0.1:${address.port}`;
    options = { dataDir, publicUrl: url, mailer, oauth: fake.config, staticDir: null, now: () => time };
    app = createDashboardApp(options); server.on("request", app.handle);
  });
  afterEach(async () => {
    app.close(); await fake.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    rmSync(dataDir, { recursive: true, force: true });
  });
  function restart(changes: Partial<DashboardAppOptions>) {
    app.close(); options = { ...options, ...changes }; app = createDashboardApp(options); server.removeAllListeners("request"); server.on("request", app.handle);
  }
  async function call(path: string, data?: unknown, headers: Record<string, string> = {}, method = data === undefined ? "GET" : "POST", browser = jar) {
    const res = await fetch(new URL(path, url), { redirect: "manual", method, headers: { cookie: browser.header(), ...(data === undefined ? {} : { "content-type": "application/json" }), ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    browser.read(res); return res;
  }
  const location = (response: Response) => { expect(response.status).toBe(302); return response.headers.get("location")!; };
  // a google account at an address google is not authoritative for (no gmail, no hd): it goes through an email code
  const untrusted = () => fake.setUser("google", { subject: "google-pending", email: "sid@company.test", emailVerified: true, label: "Pending Fixture", name: "Pending Fixture" });
  async function authorization(provider: OAuthProvider, query = "") {
    const start = await call(`/v1/auth/oauth/${provider}/start${query}`);
    const authorizeUrl = location(start);
    const response = await fetch(authorizeUrl, { redirect: "manual" });
    if (provider !== "apple") return { callback: location(response), method: "GET", body: undefined };
    expect(response.status).toBe(200);
    const html = await response.text(), body = new URLSearchParams();
    for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) body.set(match[1]!, decodeHtml(match[2]!));
    return { callback: decodeHtml(/action="([^"]+)"/.exec(html)![1]!), method: "POST", body: body.toString() };
  }
  async function callback(auth: Awaited<ReturnType<typeof authorization>>, browser = jar) {
    const res = await fetch(auth.callback, { redirect: "manual", method: auth.method, headers: { cookie: browser.header(), ...(auth.body ? { "content-type": "application/x-www-form-urlencoded", origin: "https://appleid.apple.com" } : {}) }, body: auth.body });
    browser.read(res); return res;
  }
  const oauth = async (provider: OAuthProvider, query = "") => callback(await authorization(provider, query));
  const account = async () => (await (await call("/v1/account")).json()) as AccountAnswer;
  const error = (res: Response) => new URL(location(res), url).searchParams.get("error");
  async function emailLogin(email = "sid@madanibot.test", pending?: string) {
    const start = await call("/v1/auth/start", { email, ...(pending ? { pending } : {}) }); expect(start.status).toBe(200);
    const { attempt } = await start.json() as { attempt: string };
    const code = mailer.outbox.findLast(message => message.to === email && /\b\d{8}\b/.test(message.text))!.text.match(/\b\d{8}\b/)![0];
    return call("/v1/auth/verify", { attempt, code });
  }
  async function appAuthorization(provider = "google", changes: Record<string, string> = {}, verifier = random()) {
    const appState = random();
    const params = new URLSearchParams({ provider, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state: appState, redirect_uri: APP_AUTH_REDIRECT, ...changes });
    const started = await call(`/v1/auth/app/start?${params}`);
    const providerResponse = await fetch(location(started), { redirect: "manual" });
    const res = await call(location(providerResponse));
    return { verifier, state: appState, response: res, target: new URL(location(res), url) };
  }
  const redeem = (code: string, verifier: string) => call("/v1/auth/app/token", { code, codeVerifier: verifier, ...mobile }, { origin: "capacitor://localhost" });

  it("signs up with Google, returns both cookies, persists the identity and reuses the same account", async () => {
    const response = await oauth("google", "?next=/account"); expect(location(response)).toBe("/account");
    expect(response.headers.getSetCookie()).toHaveLength(3); expect(jar.values.has("madani_oauth")).toBe(false);
    const first = await account();
    expect(first.account).toMatchObject({ email: "sid@madanibot.test", name: "Sid Fixture", providers: ["email", "google"] });
    expect(first.identities).toEqual([{ provider: "google", email: "sid@madanibot.test", label: "Sid Fixture", addedAt: time }]);
    jar = new CookieJar(); expect(location(await oauth("google"))).toBe("/");
    expect((await account()).account.id).toBe(first.account.id);
    restart({}); jar = new CookieJar(); await oauth("google"); expect((await account()).account.id).toBe(first.account.id);
  });
  it("links verified Google email to an existing email account without replacing its name", async () => {
    const signed = await (await emailLogin()).json() as WebSignInAnswer;
    await call("/v1/account", { name: "Chosen name" }, { [CSRF_HEADER]: signed.csrfToken }, "PATCH");
    jar = new CookieJar(); await oauth("google");
    expect((await account()).account).toMatchObject({ id: signed.account.id, name: "Chosen name", providers: ["email", "google"] });
  });
  it("does not link an unverified Google email", async () => {
    const signed = await (await emailLogin()).json() as WebSignInAnswer;
    fake.setUser("google", { subject: "unverified", email: signed.account.email, emailVerified: false, label: null, name: "Someone" });
    jar = new CookieJar();
    const target = new URL(location(await oauth("google", "?next=/account")), url);
    expect(target.pathname).toBe("/sign-in"); expect(target.searchParams.get("pending")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(target.searchParams.get("next")).toBe("/account"); expect((await call("/v1/me")).status).toBe(401);
    app.close(); expect(JSON.parse(readFileSync(`${dataDir}/auth.json`, "utf8")).identities).toEqual([]);
  });
  it("handles Apple form_post from Apple's origin, verifies its secret and saves the first name", async () => {
    const response = await oauth("apple"); expect(location(response)).toBe("/");
    const first = await account(); expect(first.account.name).toBe("Apple Fixture"); expect(first.identities[0]?.email).toBe("sid@privaterelay.appleid.test");
    jar = new CookieJar(); const auth = await authorization("apple"); expect(new URLSearchParams(auth.body).has("user")).toBe(false);
    await callback(auth); expect((await account()).account).toEqual(first.account);
    expect((await call("/v1/auth/start", { email: "someone@example.test" }, { origin: "https://appleid.apple.com" })).status).toBe(403);
    const badPost = await fetch(url + "/v1/auth/oauth/google/callback", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://appleid.apple.com" }, body: "state=bad" });
    expect(badPost.status).toBe(403);
  });
  const native = (body: Record<string, unknown>) => fetch(new URL("/api/cloud/app/sign-in/apple", url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const nativeBody = (input: Parameters<typeof fake.nativeApple>[0], extra: Record<string, unknown> = {}) => ({ ...fake.nativeApple(input), nonce: input.nonce, ...mobile, ...extra });
  it("signs the iphone app in with a native Apple token: private relay email, first-time name, same account after", async () => {
    const nonce = random(), response = await native(nativeBody({ nonce, privateEmail: true }, { givenName: "Native", familyName: "Fixture" }));
    expect(response.status).toBe(200); expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const grant = await response.json() as AppGrant;
    expect(grant).toMatchObject({ cloudContractVersion: 1, account: { email: "sid@privaterelay.appleid.test" } }); expect(grant.accessToken).toMatch(/^omc_/);
    const session = await fetch(new URL("/api/cloud/desktop/session", url), { headers: { authorization: `Bearer ${grant.accessToken}` } });
    expect(session.status).toBe(200);
    const again = await (await native(nativeBody({ nonce: random() }))).json() as AppGrant;
    expect(again.account.id).toBe(grant.account.id);
    app.close(); const stored = JSON.parse(readFileSync(`${dataDir}/auth.json`, "utf8")) as { accounts: Array<{ name: string }>; identities: Array<{ provider: string; revoke?: string }> };
    expect(stored.accounts).toHaveLength(1); expect(stored.accounts[0]!.name).toBe("Native Fixture");
    expect(stored.identities).toHaveLength(1); expect(stored.identities[0]!.revoke).toBeTruthy();
    for (const token of fake.appleTokens()) expect(JSON.stringify(stored)).not.toContain(token);
  });
  it("links a native Apple sign-in to the email account with the same verified address", async () => {
    const signed = await (await emailLogin("sid@madanibot.test")).json() as WebSignInAnswer;
    const grant = await (await native(nativeBody({ nonce: random(), email: "sid@madanibot.test" }))).json() as AppGrant;
    expect(grant.account.id).toBe(signed.account.id); expect((await account()).account.providers).toEqual(["email", "apple"]);
  });
  it("refuses native Apple tokens with a wrong nonce, another audience, a spent code, unknown fields, or no native client", async () => {
    const nonce = random();
    const status = async (body: Record<string, unknown>) => { const res = await native(body); return [res.status, (await res.json() as { error: string }).error]; };
    expect(await status({ ...nativeBody({ nonce }), nonce: random() })).toEqual([400, "invalid_grant"]);
    expect(await status(nativeBody({ nonce, clientId: "other.app" }))).toEqual([400, "invalid_grant"]);
    expect(await status(nativeBody({ nonce, issuedAt: Math.floor(Date.now() / 1000) - 3600 }))).toEqual([400, "invalid_grant"]);
    const body = nativeBody({ nonce });
    expect((await native(body)).status).toBe(200); expect(await status(body)).toEqual([400, "invalid_grant"]);
    expect(await status({ ...nativeBody({ nonce }), admin: true })).toEqual([400, "invalid_request"]);
    expect(await status({ ...nativeBody({ nonce }), platform: "android" })).toEqual([400, "invalid_request"]);
    restart({ signupOpen: false }); expect(await status(nativeBody({ nonce, subject: "apple-new", email: "new@privaterelay.appleid.test" }))).toEqual([403, "signup_closed"]);
    restart({ oauth: { ...fake.config, apple: { ...fake.config.apple!, nativeClientIds: undefined } } });
    expect(await status(nativeBody({ nonce }))).toEqual([503, "provider_unavailable"]);
  });
  it("revokes both Apple grants, the website's and the iphone app's, each with its own client, when the account is deleted", async () => {
    await oauth("apple"); const [web] = fake.appleTokens();
    await native(nativeBody({ nonce: random() })); const [, app] = fake.appleTokens();
    await oauth("apple"); expect(fake.appleTokens()).toHaveLength(3);
    expect(app).toBeTruthy(); expect(JSON.stringify(await account())).not.toContain("revoke");
    const { account: owner } = await account();
    expect((await call("/v1/account/delete", { email: owner.email }, { [CSRF_HEADER]: jar.values.get("madani_csrf")! })).status).toBe(200);
    // the newest web token and the app's token are revoked; the replaced web token is not kept, so it is not sent
    const revoked = fake.revoked();
    expect(revoked).toHaveLength(2); expect(revoked).toContain(app); expect(revoked).not.toContain(web);
    expect(fake.appleTokens()).toEqual([web]);
  });
  it("rejects an Apple client secret signed with a different key", async () => {
    const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    restart({ oauth: { ...fake.config, apple: { ...fake.config.apple!, apple: { ...fake.config.apple!.apple!, privateKey: key } } } });
    expect(error(await oauth("apple"))).toBe("oauth_failed");
  });
  it("completes a Google sign-in without a trusted email through an email code, attaches once, and signs in directly next time", async () => {
    untrusted();
    const target = new URL(location(await oauth("google", "?next=/account")), url), pending = target.searchParams.get("pending")!;
    const verified = await emailLogin("pending-owner@example.test", pending); expect(verified.status).toBe(200);
    const signed = await verified.json() as WebSignInAnswer;
    expect(signed.redirect).toBe("/account"); expect(signed.account.providers).toEqual(["email", "google"]);
    expect((await account()).identities).toMatchObject([{ provider: "google", email: null, label: "Pending Fixture" }]);
    expect((await call("/v1/auth/start", { email: "other@example.test", pending })).status).toBe(400);
    jar = new CookieJar(); expect(location(await oauth("google"))).toBe("/"); expect((await account()).account.id).toBe(signed.account.id);
  });
  it("finishes a pending identity only in the browser that signed in to the provider", async () => {
    untrusted(); const pending = new URL(location(await oauth("google")), url).searchParams.get("pending")!;
    // the pending link sent to someone else: their browser has no binding cookie, so it cannot attach the attacker's identity
    expect((await call("/v1/auth/start", { email: "victim@example.test", pending }, {}, "POST", new CookieJar())).status).toBe(400);
    const started = await call("/v1/auth/start", { email: "owner-x@example.test", pending }); expect(started.status).toBe(200);
    const { attempt } = await started.json() as { attempt: string };
    const code = /\b\d{8}\b/.exec(mailer.outbox.at(-1)!.text)![0];
    expect((await call("/v1/auth/verify", { attempt, code }, {}, "POST", new CookieJar())).status).toBe(410);
  });
  it("links a Google address only where Google is authoritative (gmail or a workspace hd)", async () => {
    const victim = await (await emailLogin("person@company.test")).json() as WebSignInAnswer;
    jar = new CookieJar();
    // a former owner of person@company.test still holds a google account claiming it, verified, without hd
    fake.setUser("google", { subject: "stale-google", email: "person@company.test", emailVerified: true, label: null, name: "Former" });
    const target = new URL(location(await oauth("google")), url);
    expect(target.pathname).toBe("/sign-in"); expect(target.searchParams.get("pending")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await call("/v1/me")).status).toBe(401);
    jar = new CookieJar();
    fake.setUser("google", { subject: "workspace-google", email: "person@company.test", emailVerified: true, hd: "company.test", label: null, name: "Person" });
    expect(location(await oauth("google"))).toBe("/");
    expect((await account()).account.id).toBe(victim.account.id);
    jar = new CookieJar();
    fake.setUser("google", { subject: "gmail-google", email: "someone@gmail.com", emailVerified: true, label: null, name: "Someone" });
    expect(location(await oauth("google"))).toBe("/");
    expect((await account()).account.email).toBe("someone@gmail.com");
  });
  it.each(["google", "apple"] as const)("maps %s denial and clears the binding", async provider => {
    fake.deny(provider); const response = await oauth(provider, "?next=/account");
    expect(error(response)).toBe("oauth_denied"); expect(new URL(location(response), url).searchParams.get("next")).toBe("/account");
    expect(jar.values.has("madani_oauth")).toBe(false);
  });
  it.each(["missing", "wrong"])("refuses a %s binding and consumes the state", async kind => {
    const auth = await authorization("google"), other = new CookieJar();
    if (kind === "wrong") other.values.set("madani_oauth", random());
    expect(error(await callback(auth, other))).toBe("oauth_failed"); expect(error(await callback(auth))).toBe("oauth_failed");
    expect((await call("/v1/me")).status).toBe(401);
  });
  it("refuses replay, mismatched providers, duplicate parameters, and expired state", async () => {
    const auth = await authorization("google"); await callback(auth); expect(error(await callback(auth))).toBe("oauth_failed");
    const mismatched = await authorization("google"); mismatched.callback = mismatched.callback.replace("/google/callback", "/apple/callback"); expect(error(await callback(mismatched))).toBe("oauth_failed");
    const duplicate = await authorization("google"); duplicate.callback += "&code=other"; expect(error(await callback(duplicate))).toBe("oauth_failed");
    const expired = await authorization("google"); time += 600_000; expect(error(await callback(expired))).toBe("oauth_expired");
  });
  it.each(["//evil.example", "/a/..//evil.example", "https://evil.example", "/\\evil.example", "/a\nb", "/" + "a".repeat(512)])("falls back to / for next=%s", async next => {
    expect(location(await oauth("google", `?next=${encodeURIComponent(next)}`))).toBe("/");
  });
  it("encodes valid Unicode next paths for HTTP redirects", async () => {
    const next = "/account/नाम?q=hello world#profile";
    expect(location(await oauth("google", `?next=${encodeURIComponent(next)}`))).toBe(new URL(next, url).href.slice(url.length));
  });
  it("reuses a well-formed binding across starts and sets HTTPS cross-site cookie flags", async () => {
    const first = await call("/v1/auth/oauth/google/start"), binding = jar.values.get("madani_oauth");
    expect(first.headers.getSetCookie()[0]).toContain("HttpOnly; Path=/v1/auth; Max-Age=600; SameSite=Lax");
    await call("/v1/auth/oauth/apple/start"); expect(jar.values.get("madani_oauth")).toBe(binding);
    restart({ publicUrl: "https://accounts.example.test" });
    const secure = await call("/v1/auth/oauth/apple/start"); expect(secure.headers.getSetCookie()[0]).toContain("SameSite=None; Secure");
  });
  it("attaches a second provider in link mode and keeps identity deletion working", async () => {
    await oauth("google"); const first = await account();
    await oauth("apple", "?link=1&next=/account"); const linked = await account();
    expect(linked.account.id).toBe(first.account.id); expect(linked.account.name).toBe("Sid Fixture"); expect(linked.identities.map(item => item.provider)).toEqual(["google", "apple"]);
    const deleted = await call("/v1/account/identities/apple", {}, { [CSRF_HEADER]: jar.values.get("madani_csrf")! }, "DELETE");
    expect(deleted.status).toBe(200); expect((await account()).identities).toHaveLength(1);
  });
  it("revokes the Apple sign-in at Apple when the account is deleted or Apple is unlinked, and keeps its token sealed", async () => {
    await oauth("apple");
    const [issued] = fake.appleTokens();
    expect(issued).toBeTruthy();
    const saved = app.auth.directory().identities;
    expect(saved[0]?.revoke).toBeTruthy();
    expect(JSON.stringify(saved)).not.toContain(issued!);
    expect((await account()).identities[0]).not.toHaveProperty("revoke");
    const email = (await account()).account.email;
    const deleted = await call("/v1/account/delete", { email }, { [CSRF_HEADER]: jar.values.get("madani_csrf")! });
    expect(deleted.status).toBe(200);
    expect(fake.revoked()).toEqual([issued]);

    jar = new CookieJar();
    await oauth("google"); await oauth("apple", "?link=1&next=/account");
    const [linked] = fake.appleTokens();
    expect((await call("/v1/account/identities/apple", {}, { [CSRF_HEADER]: jar.values.get("madani_csrf")! }, "DELETE")).status).toBe(200);
    expect(fake.revoked()).toEqual([issued, linked]);
  });
  it("refuses linking without a session, after signout, or when another account owns the identity", async () => {
    expect(error(await call("/v1/auth/oauth/google/start?link=1"))).toBe("oauth_failed");
    await oauth("google"); const google = await account(); const ownerJar = jar;
    jar = new CookieJar(); await oauth("apple"); const apple = await account(); expect(apple.account.id).not.toBe(google.account.id);
    expect(error(await oauth("google", "?link=1"))).toBe("identity_taken"); expect((await account()).account.id).toBe(apple.account.id);
    jar = ownerJar; const auth = await authorization("apple", "?link=1"); await call("/v1/auth/signout", {});
    expect(error(await callback(auth))).toBe("oauth_failed");
  });
  it("refuses a pending identity that another email account claimed in the meantime", async () => {
    untrusted();
    const first = new URL(location(await oauth("google")), url).searchParams.get("pending")!;
    const second = new URL(location(await oauth("google")), url).searchParams.get("pending")!;
    await emailLogin("first@example.test", first);
    const response = await emailLogin("second@example.test", second); expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "identity_taken" });
    app.close(); expect(JSON.parse(readFileSync(`${dataDir}/auth.json`, "utf8")).accounts).toHaveLength(1);
  });
  it("expires pending identities and preserves closed-signup behavior", async () => {
    untrusted(); const pending = new URL(location(await oauth("google")), url).searchParams.get("pending")!;
    time += 900_000; expect((await call("/v1/auth/start", { email: "pending@example.test", pending })).status).toBe(400);
    time = Date.now();
    const signed = await (await emailLogin()).json() as WebSignInAnswer;
    fake.setUser("google", { subject: "google-sid", email: "sid@madanibot.test", emailVerified: true, hd: "madanibot.test", label: "Sid Fixture", name: "Sid Fixture" });
    restart({ signupOpen: false }); jar = new CookieJar(); await oauth("google"); expect((await account()).account.id).toBe(signed.account.id);
    expect(error(await oauth("apple"))).toBe("signup_closed");
    untrusted(); const next = new URL(location(await oauth("google")), url).searchParams.get("pending")!;
    const start = await call("/v1/auth/start", { email: "new@example.test", pending: next }); expect(start.status).toBe(200);
    expect(mailer.outbox.some(message => message.to === "new@example.test")).toBe(false);
  });
  it("gives the app the account's name and its google photo", async () => {
    fake.setUser("google", { subject: "google-photo", email: "photo@gmail.com", emailVerified: true, label: "Photo Person", name: "Photo Person", picture: "https://lh3.googleusercontent.test/a/photo=s96-c" });
    const flow = await appAuthorization();
    const grant = await (await redeem(flow.target.searchParams.get("code")!, flow.verifier)).json() as AppGrant;
    expect(grant.account).toEqual({ id: grant.account.id, email: "photo@gmail.com", name: "Photo Person", avatarUrl: "https://lh3.googleusercontent.test/a/photo=s96-c" });
    const session = await call("/api/cloud/desktop/session", undefined, { authorization: `Bearer ${grant.accessToken}` });
    expect(await session.json()).toMatchObject({ account: grant.account });
  });
  it("keeps only https photos without credentials or ports", () => {
    expect(pictureUrl("https://lh3.googleusercontent.com/a/x=s96-c")).toBe("https://lh3.googleusercontent.com/a/x=s96-c");
    for (const bad of ["http://lh3.googleusercontent.com/a", "javascript:alert(1)", "https://user:pass@example.test/a.png", "https://example.test:8443/a.png", `https://example.test/${"a".repeat(1100)}`, 42, null]) expect(pictureUrl(bad), String(bad)).toBeNull();
  });
  it("advertises configured providers and hides unavailable ones in production", async () => {
    expect(await (await call("/v1/auth/providers")).json()).toMatchObject({ providers: ["google", "apple"].map(id => ({ id, enabled: true, comingSoon: false })) });
    restart({ oauth: {} }); expect(error(await call("/v1/auth/oauth/google/start?next=/account"))).toBe("provider_unavailable");
    expect(await (await call("/v1/auth/providers")).json()).toMatchObject({ providers: ["google", "apple"].map(id => ({ id, enabled: false, comingSoon: true })) });
    restart({ dev: false }); expect(await (await call("/v1/auth/providers")).json()).toMatchObject({ providers: ["google", "apple"].map(id => ({ id, enabled: false, comingSoon: false })) });
  });
  it("limits OAuth starts per IP across app and web routes", async () => {
    for (let i = 0; i < AUTH_LIMITS.oauthPerIp; i++) expect((await call("/v1/auth/oauth/google/start")).status).toBe(302);
    expect((await call("/v1/auth/oauth/apple/start")).status).toBe(429);
    expect((await call("/v1/auth/app/start")).status).toBe(429);
  });
  it("exchanges an app deep-link code for an accepted mobile omc_ grant, without cookies", async () => {
    const flow = await appAuthorization();
    expect(flow.target.protocol).toBe("madanibot:"); expect(flow.target.hostname).toBe("auth"); expect(flow.target.searchParams.get("state")).toBe(flow.state);
    const code = flow.target.searchParams.get("code")!; expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(jar.values.has("madani_dash")).toBe(false);
    const response = await redeem(code, flow.verifier); expect(response.status).toBe(200); expect(response.headers.get("set-cookie")).toBeNull(); expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const grant = await response.json() as AppGrant; expect(grant.accessToken).toMatch(/^omc_[A-Za-z0-9_-]{43}$/);
    const session = await call("/api/cloud/desktop/session", undefined, { authorization: `Bearer ${grant.accessToken}` }); expect(session.status).toBe(200); expect(await session.json()).toMatchObject({ account: grant.account, device: grant.device });
    expect(await (await redeem(code, flow.verifier)).json()).toEqual({ error: "invalid_grant" });
    app.close(); const saved = readFileSync(`${dataDir}/auth.json`, "utf8"); expect(saved).not.toContain(code); expect(saved).not.toContain(flow.verifier); expect(JSON.parse(saved).sessions[0].kind).toBe("mobile");
  });
  it("burns app codes on wrong or malformed verifiers and rejects expired codes", async () => {
    for (const wrong of [random(), "bad"]) {
      const flow = await appAuthorization(), code = flow.target.searchParams.get("code")!;
      expect(await (await redeem(code, wrong)).json()).toEqual({ error: "invalid_grant" });
      expect(await (await redeem(code, flow.verifier)).json()).toEqual({ error: "invalid_grant" });
    }
    const flow = await appAuthorization(); time += 300_000; expect(await (await redeem(flow.target.searchParams.get("code")!, flow.verifier)).json()).toEqual({ error: "invalid_grant" });
    const malformed = await fetch(url + "/v1/auth/app/token", { method: "POST", body: "{" }); expect(malformed.status).toBe(400); expect(await malformed.json()).toEqual({ error: "invalid_grant" });
  });
  it("completes the app's pending email and returns a fresh PKCE deep link", async () => {
    untrusted(); const flow = await appAuthorization(); expect(flow.target.pathname).toBe("/sign-in");
    const signed = await (await emailLogin("phone@example.test", flow.target.searchParams.get("pending")!)).json() as WebSignInAnswer;
    const deep = new URL(signed.redirect!); expect(deep.protocol).toBe("madanibot:"); expect(deep.searchParams.get("state")).toBe(flow.state);
    expect((await redeem(deep.searchParams.get("code")!, flow.verifier)).status).toBe(200);
  });
  it("ends a desktop sign-up that needed an email on the landing page, with the app's code in the fragment only", async () => {
    untrusted(); const flow = await appAuthorization("google", { landing: "page" }); expect(flow.target.pathname).toBe("/sign-in");
    const signed = await (await emailLogin("new-desk@example.test", flow.target.searchParams.get("pending")!)).json() as WebSignInAnswer;
    const landing = new URL(signed.redirect!, url); expect(landing.pathname).toBe(APP_LANDING_PATH); expect(landing.search).toBe("");
    const fragment = new URLSearchParams(landing.hash.slice(1)); expect(fragment.get("state")).toBe(flow.state);
    expect((await redeem(fragment.get("code")!, flow.verifier)).status).toBe(200);
  });
  it("returns app errors to the exact deep link with its state", async () => {
    fake.deny("google"); const flow = await appAuthorization();
    expect(flow.target.protocol).toBe("madanibot:"); expect(flow.target.searchParams.get("error")).toBe("oauth_denied"); expect(flow.target.searchParams.get("state")).toBe(flow.state);
  });
  it.each([
    { provider: "missing" }, { provider: "email" }, { provider: "x" }, { code_challenge: "bad" }, { code_challenge_method: "plain" }, { state: "short" }, { state: "x".repeat(257) }, { redirect_uri: "https://evil.example" }, { redirect_uri: "madanibot://auth/" }, { link: "1" }, { landing: "app" },
  ])("rejects invalid app authorization parameters %j", async change => {
    const params = new URLSearchParams({ provider: "google", code_challenge: random(), code_challenge_method: "S256", state: random(), redirect_uri: APP_AUTH_REDIRECT });
    for (const [key, value] of Object.entries(change)) if (value !== undefined) params.set(key, value);
    const response = await call(`/v1/auth/app/start?${params}`); expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: "invalid_request" });
  });
  it("signs the desktop app in with one tap: provider, back through the app's link, plan intent straight on, no approval page", async () => {
    let saved: unknown = null;
    const opened: string[] = [];
    const desktop = (appLinks: boolean) => createCloudAccountClient({ origin: url, fixture: true, deviceName: "Fixture Mac", platform: "darwin", appVersion: "1.2.3", now: () => time, appLinks,
      store: { async read() { return saved; }, async write(value: unknown) { saved = value; } }, async openBrowser(target: string) { opened.push(target); },
      setTimer: () => 1, clearTimer: () => {} });
    const client = desktop(true);
    try {
      await client.start();
      expect(await client.signInOptions()).toEqual({ providers: ["google", "apple"], recovery: true });
      expect(await client.begin({ plan: "pro", source: "app_settings" }, { provider: "google" })).toMatchObject({ status: "connecting", browser: "google" });
      expect(client.state().enrollment).toBeUndefined();
      const start = new URL(opened[0]!);
      expect(`${start.origin}${start.pathname}`).toBe(`${url}/v1/auth/app/start`);
      expect(start.searchParams.get("redirect_uri")).toBe(APP_AUTH_REDIRECT);
      const providerResponse = await fetch(location(await call(`${start.pathname}${start.search}`)), { redirect: "manual" });
      // the browser ends on the website's "you're signed in, head back" page, which hands the app its link
      const landing = new URL(location(await call(location(providerResponse))), url);
      expect(landing.pathname).toBe(APP_LANDING_PATH); expect(landing.search).toBe("");
      const link = `${APP_AUTH_REDIRECT}?${landing.hash.slice(1)}`;
      expect(link.startsWith(`${APP_AUTH_REDIRECT}?code=`)).toBe(true);
      // a link this app did not start, or a forged state, does nothing
      expect((await client.finishLink(`${APP_AUTH_REDIRECT}?code=${"c".repeat(43)}&state=${"s".repeat(43)}`)).outcome).toBe("ignored");
      expect(client.state().status).toBe("connecting");
      const done = await client.finishLink(link);
      expect(done.outcome).toBe("signed-in");
      expect(client.state()).toMatchObject({ status: "connected", account: { email: "sid@madanibot.test" } });
      // the plan chosen before signing in comes through the sign-in with it: no second step to find it again
      expect(client.state().checkout).toMatchObject({ plan: "pro", signIn: true });
      expect(opened).toHaveLength(1);
      expect((await client.finishLink(link)).outcome).toBe("ignored");
    } finally { client.close(); }
  });
  it("signs the desktop app up by magic link: the website signs in, approves without a click, and the app follows; tracked to the install", async () => {
    let saved: unknown = null;
    const opened: string[] = [];
    let wait: (() => void) | null = null;
    const client = createCloudAccountClient({ origin: url, fixture: true, deviceName: "Fixture Mac", platform: "darwin", appVersion: "1.2.3", now: () => time,
      store: { async read() { return saved; }, async write(value: unknown) { saved = value; } }, async openBrowser(target: string) { opened.push(target); },
      setTimer: (run: () => void) => { wait = run; return 1; }, clearTimer: () => {} });
    try {
      await client.start();
      const asked = await client.begin(null, { email: "magic-new@example.test" });
      expect(asked).toMatchObject({ status: "connecting", magic: "magic-new@example.test" });
      expect(opened).toHaveLength(0);
      const userCode = asked.enrollment!.userCode;
      // the mail: one button to the website's sign-in, carrying this app's code on to its page
      const mail = mailer.outbox.findLast(message => message.to === "magic-new@example.test")!;
      const link = new URL(/https?:\/\/\S+\/sign-in\?\S+/.exec(mail.text)![0]);
      expect(link.searchParams.get("next")).toBe(`/cloud/desktop?code=${userCode}`);
      const code = new URLSearchParams(link.hash.slice(1)).get("code")!;
      // the website: the link signs up, then the app's page finds this browser signed in after the app asked
      time += 1000;
      expect((await call("/v1/auth/verify", { attempt: link.searchParams.get("attempt"), code })).status).toBe(200);
      const looked = await (await call(`/v1/auth/device?code=${userCode}`)).json() as { fresh: boolean; created?: true };
      expect(looked).toMatchObject({ fresh: true, created: true });
      expect((await call("/v1/auth/device/approve", { userCode }, { [CSRF_HEADER]: jar.values.get("madani_csrf")! })).status).toBe(200);
      time += 6000; wait!();
      for (let i = 0; i < 50 && client.state().status !== "connected"; i++) await new Promise(resolve => setTimeout(resolve, 20));
      expect(client.state()).toMatchObject({ status: "connected", account: { email: "magic-new@example.test" } });
      // the website is still taking the new account through its first steps: the app's sign-in doesn't end them
      expect((await account()).onboarded).toBe(false);
      app.close(); const state = JSON.parse(readFileSync(join(dataDir, "auth.json"), "utf8")) as { accounts: { email: string; signedUpFrom?: unknown }[] };
      expect(state.accounts.find(item => item.email === "magic-new@example.test")?.signedUpFrom).toMatchObject({ name: "Fixture Mac", platform: "darwin", appVersion: "1.2.3" });
    } finally { client.close(); }
  });
  it("asks again on the app's page when this browser was signed in before the app asked", async () => {
    await emailLogin("before@example.test");
    time += 1000;
    const answer = await (await call("/api/cloud/desktop/authorize", { deviceName: "Fixture Mac", platform: "darwin" })).json() as { userCode: string };
    const looked = await (await call(`/v1/auth/device?code=${answer.userCode}`)).json() as { fresh: boolean; created?: true };
    expect(looked.fresh).toBe(false); expect(looked.created).toBeUndefined();
  });
  it("ends the desktop's provider sign-in on a denied link and keeps the code flow where the app has no link", async () => {
    let saved: unknown = null;
    const opened: string[] = [];
    const make = (appLinks: boolean) => createCloudAccountClient({ origin: url, fixture: true, deviceName: "Fixture Mac", platform: "darwin", now: () => time, appLinks,
      store: { async read() { return saved; }, async write(value: unknown) { saved = value; } }, async openBrowser(target: string) { opened.push(target); },
      setTimer: () => 1, clearTimer: () => {} });
    const client = make(true);
    try {
      await client.start();
      await client.begin(null, { provider: "apple" });
      const state = new URL(opened[0]!).searchParams.get("state")!;
      const ended = await client.finishLink(`${APP_AUTH_REDIRECT}?error=oauth_denied&state=${state}`);
      expect(ended).toMatchObject({ outcome: "failed", state: { status: "signed-out", message: "signin-cancelled" } });
    } finally { client.close(); }
    const plain = make(false);
    try {
      await plain.start();
      expect((await plain.begin(null, { provider: "google" })).enrollment?.userCode).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
      expect(opened.at(-1)).toContain("/v1/auth/oauth/google/start?next=");
    } finally { plain.close(); }
  });
  it("rejects forged or invalid id tokens before creating an account", async () => {
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    let mutation: Record<string, unknown> = {}, header: Record<string, unknown> = {}, badSignature = false;
    const request: typeof fetch = async (input, init) => {
      const response = await fetch(input, init), path = new URL(String(input)).pathname;
      if (path === "/google/jwks") return Response.json({ keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid: "fixture-rsa", alg: "RS256" }] });
      if (path !== "/google/token") return response;
      const tokens = await response.json() as { id_token: string }, parts = tokens.id_token.split(".");
      const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
      const data = [ { alg: "RS256", kid: "fixture-rsa", ...header }, { ...claims, ...mutation } ].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
      return Response.json({ id_token: `${data}.${(badSignature ? Buffer.alloc(256) : sign("sha256", Buffer.from(data), keys.privateKey)).toString("base64url")}` });
    };
    restart({ fetch: request });
    for (const changes of [{ aud: "other" }, { iss: "other" }, { nonce: "other" }, { exp: Math.floor(time / 1000) - 61 }]) { mutation = changes; expect(error(await oauth("google"))).toBe("oauth_failed"); }
    mutation = {}; header = { alg: "none" }; expect(error(await oauth("google"))).toBe("oauth_failed");
    header = { kid: "unknown" }; expect(error(await oauth("google"))).toBe("oauth_failed");
    header = {}; badSignature = true; expect(error(await oauth("google"))).toBe("oauth_failed");
    expect((await call("/v1/me")).status).toBe(401); app.close(); expect(JSON.parse(readFileSync(`${dataDir}/auth.json`, "utf8")).accounts).toEqual([]);
  });
});

describe("provider environment configuration", () => {
  it("loads production defaults and escaped Apple PEM without env URL overrides, and ignores X settings", () => {
    const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const env = { MADANI_AUTH_GOOGLE_CLIENT_ID: "google", MADANI_AUTH_GOOGLE_CLIENT_SECRET: "secret", MADANI_AUTH_GOOGLE_TOKEN_URL: "https://evil.example", MADANI_AUTH_X_CLIENT_ID: "x", MADANI_AUTH_X_SCOPES: "users.read offline.access", MADANI_AUTH_APPLE_CLIENT_ID: "apple", MADANI_AUTH_APPLE_TEAM_ID: "team", MADANI_AUTH_APPLE_KEY_ID: "key", MADANI_AUTH_APPLE_PRIVATE_KEY: key.replace(/\n/g, "\\n") };
    const config = providersFromEnv(env);
    expect(config.google).toMatchObject({ tokenUrl: "https://oauth2.googleapis.com/token", scopes: "openid email profile" });
    expect(Object.keys(config).sort()).toEqual(["apple", "google"]);
    expect(config.apple?.apple?.privateKey).toBe(key); expect(config.apple?.authorizeUrl).toBe("https://appleid.apple.com/auth/authorize");
    const dir = mkdtempSync(join(tmpdir(), "madani-apple-key-"));
    try {
      const file = join(dir, "key.p8"); writeFileSync(file, key, { mode: 0o600 });
      expect(providersFromEnv({ ...env, MADANI_AUTH_APPLE_PRIVATE_KEY: undefined, MADANI_AUTH_APPLE_PRIVATE_KEY_FILE: file }).apple?.apple?.privateKey).toBe(key);
    } finally { rmSync(dir, { recursive: true, force: true }); }
    expect(providersFromEnv({})).toEqual({});
  });
  it("reads the Apple key base64-encoded on one line and the native bundle ids", () => {
    const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const env = { MADANI_AUTH_APPLE_CLIENT_ID: "bot.madani.signin", MADANI_AUTH_APPLE_TEAM_ID: "team", MADANI_AUTH_APPLE_KEY_ID: "key", MADANI_AUTH_APPLE_PRIVATE_KEY: Buffer.from(key).toString("base64"), MADANI_AUTH_APPLE_NATIVE_CLIENT_IDS: "bot.madani.mobile, bot.madani.mac" };
    expect(providersFromEnv(env).apple).toMatchObject({ clientId: "bot.madani.signin", nativeClientIds: ["bot.madani.mobile", "bot.madani.mac"], revokeUrl: "https://appleid.apple.com/auth/revoke", apple: { privateKey: key } });
    expect(providersFromEnv({ ...env, MADANI_AUTH_APPLE_NATIVE_CLIENT_IDS: undefined }).apple?.nativeClientIds).toBeUndefined();
    expect(() => providersFromEnv({ ...env, MADANI_AUTH_APPLE_NATIVE_CLIENT_IDS: "bad id" })).toThrow("MADANI_AUTH_APPLE_NATIVE_CLIENT_IDS");
    expect(() => providersFromEnv({ ...env, MADANI_AUTH_APPLE_PRIVATE_KEY: "bm90IGEga2V5" })).toThrow("expected a P-256 private key");
  });
  it.each([
    [{ MADANI_AUTH_GOOGLE_CLIENT_ID: "client" }, "MADANI_AUTH_GOOGLE_CLIENT_SECRET"],
    [{ MADANI_AUTH_GOOGLE_CLIENT_SECRET: "secret" }, "MADANI_AUTH_GOOGLE_CLIENT_ID"],
    [{ MADANI_AUTH_APPLE_CLIENT_ID: "client" }, "MADANI_AUTH_APPLE_TEAM_ID"],
    [{ MADANI_AUTH_APPLE_CLIENT_ID: "client", MADANI_AUTH_APPLE_TEAM_ID: "team" }, "MADANI_AUTH_APPLE_KEY_ID"],
    [{ MADANI_AUTH_APPLE_CLIENT_ID: "client", MADANI_AUTH_APPLE_TEAM_ID: "team", MADANI_AUTH_APPLE_KEY_ID: "key" }, "MADANI_AUTH_APPLE_PRIVATE_KEY"],
  ])("names missing configuration without values", (env, name) => { expect(() => providersFromEnv(env)).toThrow(name); });
});
