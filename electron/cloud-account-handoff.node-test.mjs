import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { createCloudAccountClient, handoffDestination } from "./cloud-account.mjs";

const accessToken = `omc_${"T".repeat(43)}`;
const handoffToken = "H".repeat(43);

async function fixture(t, handoff, page = null) {
  const f = { requests: [], opened: [], handoff };
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    f.requests.push({ route: req.url, method: req.method, token: req.headers.authorization, body });
    const send = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.headers.authorization !== `Bearer ${accessToken}`) return send(401, { error: "invalid_token" });
    if (req.url === "/api/cloud/desktop/session") return send(200, { cloudContractVersion: 1, expiresAt: Date.now() + 86_400_000, device: { id: "device" }, account: { id: "account", email: "person@example.test" }, entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 0 }, ...(page ? { handoffUrl: page(f.origin) } : {}) });
    if (req.url === "/v1/app/web-handoff" && req.method === "POST") { const answer = f.handoff(f.origin); return send(answer.status, answer.body); }
    send(404, { error: "not_found" });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  f.origin = `http://127.0.0.1:${server.address().port}`;
  let saved = { origin: f.origin, token: accessToken, expiresAt: Date.now() + 86_400_000, device: { id: "device" }, account: { id: "account", email: "person@example.test" } };
  f.client = createCloudAccountClient({ origin: f.origin, fixture: true, platform: "darwin", deviceName: "Fixture Mac", appVersion: "1.0.0",
    store: { async read() { return saved; }, async write(value) { saved = value; } }, async openBrowser(url) { f.opened.push(url); },
    setTimer: () => 1, clearTimer: () => {} });
  t.after(() => f.client.close?.());
  return f;
}

test("handoffDestination accepts only this origin's handoff page with a fragment token", () => {
  const origin = "https://madani.bot";
  for (const good of [`${origin}/handoff#t=${handoffToken}`, `${origin}/dashboard/handoff#t=${handoffToken}`]) assert.equal(handoffDestination(good, origin), good);
  for (const bad of [`https://evil.test/handoff#t=${handoffToken}`, `http://madani.bot/handoff#t=${handoffToken}`, `${origin}/handoff?t=${handoffToken}`,
    `${origin}/handoff?x=1#t=${handoffToken}`, `${origin}/billing#t=${handoffToken}`, `${origin}/handoff#t=short`, `${origin}/handoff`,
    `https://user:pass@madani.bot/handoff#t=${handoffToken}`, `https://madani.bot.evil.test/handoff#t=${handoffToken}`, `${origin}/x/../handoff#t=${handoffToken}`, null, 42]) {
    assert.equal(handoffDestination(bad, origin), null, String(bad));
  }
});

test("webHandoff asks with the bearer and opens only the Admin's own handoff link", async t => {
  const f = await fixture(t, origin => ({ status: 200, body: { v: 1, url: `${origin}/handoff#t=${handoffToken}`, expiresAt: Date.now() + 120_000 } }));
  assert.equal((await f.client.start()).status, "connected");
  assert.deepEqual(await f.client.webHandoff({ plan: "pro", source: "app_computer_move" }), { opened: true });
  const asked = f.requests.find(item => item.route === "/v1/app/web-handoff");
  assert.equal(asked.token, `Bearer ${accessToken}`);
  assert.deepEqual(JSON.parse(asked.body), { next: "plans", plan: "pro", source: "app_computer_move" });
  assert.deepEqual(f.opened, [`${f.origin}/handoff#t=${handoffToken}`]);
  await assert.rejects(f.client.webHandoff({ plan: "team" }));
  await assert.rejects(f.client.webHandoff({ source: "somewhere" }));
});

test("webHandoff never opens a foreign address: it opens the plain plans page instead", async t => {
  const f = await fixture(t, () => ({ status: 200, body: { v: 1, url: `https://evil.test/handoff#t=${handoffToken}`, expiresAt: Date.now() + 120_000 } }));
  await f.client.start();
  assert.deepEqual(await f.client.webHandoff({ plan: "plus", source: "app_card" }), { opened: true, fallback: true });
  assert.deepEqual(f.opened, [`${f.origin}/billing?plan=plus&src=app_card`]);
});

test("an Admin without the route (404) falls back to the plans page with the plan", async t => {
  const f = await fixture(t, () => ({ status: 404, body: { error: "Not found.", code: "not_found" } }));
  await f.client.start();
  assert.deepEqual(await f.client.webHandoff({ plan: "pro", source: "app_computer_move" }), { opened: true, fallback: true });
  assert.deepEqual(f.opened, [`${f.origin}/billing?plan=pro&src=app_computer_move`]);
});

test("signed out: nothing is asked or opened", async t => {
  const f = await fixture(t, () => assert.fail("asked while signed out"));
  await f.client.start();
  await f.client.signOut();
  assert.deepEqual(await f.client.webHandoff({ plan: "pro" }), { signedOut: true });
  assert.deepEqual(f.opened, []);
});

test("the account's other pages open signed in too: Open your plan page, a workspace, and the plain page when the Admin is older", async t => {
  let answer = origin => ({ status: 200, body: { v: 1, url: `${origin}/dashboard/handoff#t=${handoffToken}`, expiresAt: Date.now() + 120_000 } });
  const f = await fixture(t, origin => answer(origin));
  await f.client.start();
  await f.client.openDashboard();
  assert.deepEqual(await f.client.webHandoff({ page: "workspace", workspaceId: "ws_abc-1" }), { opened: true });
  const asked = f.requests.filter(item => item.route === "/v1/app/web-handoff").map(item => JSON.parse(item.body));
  assert.deepEqual(asked, [{ next: "cloud" }, { next: "workspace", workspaceId: "ws_abc-1" }]);
  assert.deepEqual(f.opened, [`${f.origin}/dashboard/handoff#t=${handoffToken}`, `${f.origin}/dashboard/handoff#t=${handoffToken}`]);
  answer = () => ({ status: 400, body: { error: "Invalid request.", code: "invalid_request" } });
  assert.deepEqual(await f.client.webHandoff({ page: "workspace", workspaceId: "ws_abc-1" }), { opened: true, fallback: true });
  assert.equal(f.opened.at(-1), `${f.origin}/?workspace=ws_abc-1`);
  for (const bad of [{ page: "admin" }, { page: "workspace" }, { page: "workspace", workspaceId: "../x" }, { page: "cloud", plan: "pro" }, { page: "account", workspaceId: "ws_abc" }, { page: "toString" }]) {
    await assert.rejects(f.client.webHandoff(bad), String(JSON.stringify(bad)));
  }
});

test("with the session's handoff page the browser opens at once on a token made here, and the Admin learns that token", async t => {
  const f = await fixture(t, () => ({ status: 200, body: { v: 1, url: "ignored", expiresAt: Date.now() + 120_000 } }), origin => `${origin}/dashboard/handoff`);
  await f.client.start();
  await f.client.openDashboard();
  assert.equal(f.opened.length, 1);
  const match = new RegExp(`^${f.origin}/dashboard/handoff#t=([A-Za-z0-9_-]{43})$`).exec(f.opened[0]);
  assert.ok(match, f.opened[0]);
  for (let n = 0; n < 50 && !f.requests.some(item => item.route === "/v1/app/web-handoff"); n++) await new Promise(resolve => setTimeout(resolve, 10));
  const asked = f.requests.find(item => item.route === "/v1/app/web-handoff");
  assert.deepEqual(JSON.parse(asked.body), { next: "cloud", token: match[1] });
});

test("a session handoff page that is not this Admin's own is never used", async t => {
  const f = await fixture(t, origin => ({ status: 200, body: { v: 1, url: `${origin}/handoff#t=${handoffToken}`, expiresAt: Date.now() + 120_000 } }), () => "https://evil.test/handoff");
  await f.client.start();
  await f.client.openDashboard();
  assert.deepEqual(f.opened, [`${f.origin}/handoff#t=${handoffToken}`]);
});

test("an account service without phone codes (404) says unsupported, so the phone page logs in by email instead", async t => {
  const f = await fixture(t, () => ({ status: 200, body: {} }));
  await f.client.start();
  assert.deepEqual(await f.client.phoneSignIn(), { outcome: "unsupported" });
  assert.ok(f.requests.some(item => item.route === "/v1/app/phone-sign-in"));
});
