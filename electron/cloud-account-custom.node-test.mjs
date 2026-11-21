import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { checkoutDestination, cloudOrigin, cloudTarget, createCloudAccountClient, CLOUD_ORIGIN, STAGING_CLOUD_ORIGIN } from "./cloud-account.mjs";

const accessToken = `omc_${"T".repeat(43)}`;
async function fixture(t, options = {}) {
  const f = { now: 1_800_000_000_000, requests: [], browsers: [], states: [], saved: null, timer: null, approved: false, revoked: false, badUrl: false };
  const identity = () => ({ cloudContractVersion: 1, expiresAt: f.now + 86400_000, device: { id: "fixture-device" }, account: { id: "fixture-account", email: "person@example.test" } });
  const server = createServer(async (req, res) => {
    res.setHeader("date", new Date(f.now).toUTCString());
    let body = ""; for await (const chunk of req) body += chunk;
    f.requests.push({ route: req.url, method: req.method, token: req.headers.authorization, version: req.headers["x-madani-version"], body });
    const send = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.url === "/api/cloud/desktop/authorize") return send(201, { cloudContractVersion: 1, deviceCode: "A".repeat(43), userCode: "ABCDE-FGHJK", verificationUriComplete: f.badUrl ? "https://untrusted.test" : `${f.origin}/cloud/desktop?code=ABCDE-FGHJK`, expiresIn: 600, interval: 5 });
    if (req.url === "/api/cloud/desktop/token") return f.approved ? send(200, { ...identity(), accessToken }) : send(400, { error: "authorization_pending" });
    if (req.headers.authorization !== `Bearer ${accessToken}`) return send(401, { error: "invalid_token" });
    if (req.url === "/v1/app/enroll-grant") return send(f.enrollStatus ?? 200, f.enrollAnswer ?? { v: 1, enrollToken: "e".repeat(43), expiresAt: f.now + 60_000, dashboardUrl: f.origin });
    if (req.url === "/api/cloud/desktop/session") return f.revoked ? send(401, { error: "invalid_token" }) : send(200, { ...identity(), entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 0 } });
    send(404, { error: "not_found" });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); f.origin = `http://127.0.0.1:${server.address().port}`;
  f.client = createCloudAccountClient({ origin: f.origin, fixture: true, deviceName: "Fixture computer", platform: "darwin", appVersion: "0.1.fixture", now: () => f.now,
    store: { read: async () => f.saved, write: async value => { f.saved = structuredClone(value); } }, openBrowser: async url => { f.browsers.push(url); }, onState: state => f.states.push(state),
    setTimer: callback => { f.timer = callback; return 1; }, clearTimer: () => { f.timer = null; }, ...options });
  f.connect = async () => {
    await f.client.begin(); f.approved = true; const callback = f.timer; f.timer = null; callback();
    for (let i = 0; i < 200; i++) { if (f.client.state().status === "connected") return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail("Fixture did not connect");
  };
  t.after(async () => { f.client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return f;
}

test("custom account targets accept only bare https or loopback http origins and isolate every file", () => {
  const fields = { file: "cloud-account-custom.bin", saved: "cloud-accounts-custom.bin", places: "account-places-custom.json", environments: "environments-custom.json", sync: "cloud-sync-custom", look: "cloud-home-look-custom.json" };
  for (const origin of ["https://accounts.example.test", "https://example.test:8443", "http://localhost:1234", "http://127.0.0.1:1234", "http://[::1]:1234"]) {
    assert.deepEqual(cloudTarget({ MADANI_CLOUD_ORIGIN: origin, MADANI_CLOUD_STAGING: "1" }), { origin, staging: false, custom: true, ...fields });
    assert.equal(cloudOrigin(origin, false, true), origin);
  }
  for (const origin of ["", "bad", "http://remote.test", "https://u:p@host.test", "https://host.test/", "https://host.test/path", "https://host.test?x=1", "https://host.test#", " https://host.test", "HTTPS://host.test", "http://localhost.evil.test", "http://127.0.0.2:1234", "https://host.test:443"]) {
    assert.deepEqual(cloudTarget({ MADANI_CLOUD_ORIGIN: origin }), cloudTarget({}));
    assert.deepEqual(cloudTarget({ MADANI_CLOUD_ORIGIN: origin, MADANI_CLOUD_STAGING: "1" }), cloudTarget({ MADANI_CLOUD_STAGING: "1" }));
    assert.throws(() => cloudOrigin(origin, false, true));
  }
  assert.equal(cloudTarget({}).origin, CLOUD_ORIGIN); assert.equal(cloudTarget({}).custom, false);
  assert.equal(cloudTarget({ MADANI_CLOUD_STAGING: "1" }).origin, STAGING_CLOUD_ORIGIN); assert.equal(cloudTarget({ MADANI_CLOUD_STAGING: "1" }).custom, false);
  for (const host of ["checkout.dodopayments.com", "test.checkout.dodopayments.com"]) assert.equal(checkoutDestination(`https://${host}/session/x`, { custom: true }), `https://${host}/session/x`);
  assert.equal(checkoutDestination("https://evil.test/session/x", { custom: true }), null);
});

test("enrollment grants require a connected sign-in, validate every field and keep the token in main", async t => {
  const f = await fixture(t, { custom: true, fixture: false });
  assert.equal(await f.client.enrollGrant(), null); assert.deepEqual(f.requests, []);
  await f.connect();
  const good = { v: 1, enrollToken: "e".repeat(43), expiresAt: f.now + 60_000, dashboardUrl: `${f.origin}/dashboard` };
  f.enrollAnswer = good;
  assert.deepEqual(await f.client.enrollGrant(), { enrollToken: good.enrollToken, dashboardUrl: good.dashboardUrl });
  assert.deepEqual(f.requests.at(-1), { route: "/v1/app/enroll-grant", method: "POST", body: "{}", token: `Bearer ${accessToken}`, version: "0.1.fixture" });
  for (const patch of [{ v: 2 }, { enrollToken: "short" }, { enrollToken: `${"e".repeat(43)}\n` }, { enrollToken: 123 }, { enrollToken: `${"e".repeat(42)}!` }, { expiresAt: f.now }, { expiresAt: Number.MAX_SAFE_INTEGER + 1 }, { dashboardUrl: "https://other.test" }, { dashboardUrl: "bad" }, { dashboardUrl: null }]) {
    f.enrollAnswer = { ...good, ...patch }; assert.equal(await f.client.enrollGrant(), null);
  }
  f.enrollStatus = 503; assert.equal(await f.client.enrollGrant(), null);
  f.enrollStatus = 401; f.enrollAnswer = { code: "invalid_token", error: "Sign in again." }; f.revoked = true;
  assert.equal(await f.client.enrollGrant(), null); assert.equal(f.client.state().status, "reauth-required");
  assert.equal(await f.client.enrollGrant(), null);
  assert.ok(!JSON.stringify(f.states).includes(good.enrollToken));
});

test("browser sign-in accepts the supported providers only after validating the verification page", async t => {
  const f = await fixture(t);
  for (const provider of ["google", "apple", "x", "unknown", { provider: "google" }]) {
    await f.client.begin(null, { provider });
    assert.equal(f.browsers.at(-1), typeof provider === "string" && ["google", "apple"].includes(provider)
      ? `${f.origin}/v1/auth/oauth/${provider}/start?next=${encodeURIComponent("/cloud/desktop?code=ABCDE-FGHJK")}` : `${f.origin}/cloud/desktop?code=ABCDE-FGHJK`);
    await f.client.cancel();
  }
  const opened = f.browsers.length; f.badUrl = true;
  assert.equal((await f.client.begin(null, { provider: "google" })).status, "signed-out"); assert.equal(f.browsers.length, opened);
});
