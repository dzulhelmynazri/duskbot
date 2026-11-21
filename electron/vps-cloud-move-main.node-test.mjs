import assert from "node:assert/strict";
import test from "node:test";
import { parseCloudSummary } from "./cloud-home.mjs";
import { oneHomeCloud } from "./one-home-main.mjs";
import { installVpsCloudMoveMain } from "./vps-cloud-move-main.mjs";

const VPS = { id: "place-1", kind: "remote", name: "Hetzner box", origin: "https://box.example.test" };
const ENV_ID = "0d9e8f7a-6b5c-4d3e-9f8a-7b6c5d4e3f2a";

function setup({ handoff = async () => ({ opened: true }), state = null, cloud = () => state, account = null, continueInBrowser = null } = {}) {
  const handlers = new Map(), files = new Map(), told = [], tracked = [], asked = [];
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/auth/session") return json({ kind: "session", own: true });
    if (path === "/.well-known/madanibot/environment") return json({ environmentId: ENV_ID, capabilities: { move: 1, moveOut: 1 } });
    return new Response("{}", { status: 404 });
  };
  const move = installVpsCloudMoveMain({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    pageOrigin: (event) => event.origin ?? null,
    localPage: (event) => event.local === true,
    environments: () => [VPS, { id: "cloud", kind: "remote", name: "My Cloud", origin: "https://cloud.example.test", cloud: { id: "c" } }],
    fetch,
    cloud,
    home: () => null,
    cloudRead: async () => new Response("{}", { status: 503 }),
    file: (name) => ({ read: () => files.get(name) ?? null, write: (value) => files.set(name, value) }),
    account: () => ({ webHandoff: async (options) => { asked.push(options); return handoff(options); }, ...(account ? { state: account } : {}), ...(continueInBrowser ? { continueInBrowser } : {}) }),
    viaMac: { available: () => false, start: async () => {}, view: () => null },
    openHome: () => {},
    track: (name, props) => tracked.push({ name, props }),
    tell: (view) => told.push(view),
    log: () => {},
  });
  const call = (channel, event, ...args) => handlers.get(channel)(event, ...args);
  return { move, call, files, told, tracked, asked };
}

test("only the saved server whose page asks is moved; any other page is refused before anything is asked", async () => {
  const { call, files } = setup();
  await assert.rejects(call("vps-cloud-move:start", { origin: "https://evil.example.test" }), /Open the server whose bots should move/);
  await assert.rejects(call("vps-cloud-move:start", { origin: "https://cloud.example.test" }), /Open the server whose bots should move/, "a Cloud place is never a source");
  await assert.rejects(call("vps-cloud-move:start", { local: true }), /Open the server/, "this computer's page only reads");
  assert.throws(() => call("vps-cloud-move:view", {}), /only available in this app's window/);
  assert.deepEqual(call("vps-cloud-move:view", { local: true }), { stage: "none", cloud: "signed-out" });
  assert.equal(files.get("vps-cloud-choice.json"), undefined);
});

test("buy first: the checkout opens signed in on the cheapest plan (plus) when none is named, and the move waits for its Cloud", async () => {
  const { call, files, asked, tracked } = setup({ state: { status: "connected", account: { id: "acct" } } });
  const view = await call("vps-cloud-move:buy", { origin: VPS.origin }, "not-a-plan");
  assert.deepEqual(asked, [{ plan: "plus", source: "app_computer_move" }]);
  assert.equal(view.stage, "buying");
  assert.equal(files.get("vps-cloud-choice.json").route, "direct");
  assert.deepEqual(tracked.map((entry) => [entry.name, entry.props.step]), [["vps_cloud_move", "buy"]]);
  assert.equal(call("vps-cloud-move:cancel", { origin: VPS.origin }).stage, "none", "nothing ran, so it can be let go of");
});

test("bought: the move leaves waiting once the account service's session says the ready Cloud takes moves", async () => {
  // the session as apps/dashboard/server/billing/admin-routes.ts sessionFields sends it for a managed cloud
  const origin = "https://c1.madani.test";
  let summary = null;
  const session = () => ({ status: "connected", account: { id: "acct" }, entitlement: { plan: "pro", status: "active", expiresAt: null, version: 2 }, machine: summary ? parseCloudSummary(summary) : undefined });
  const { call } = setup({ cloud: () => oneHomeCloud(session()) });
  assert.equal((await call("vps-cloud-move:buy", { origin: VPS.origin }, "plus")).stage, "buying");
  summary = { state: "setting_up", setup: { step: "starting" }, disk: { gb: 20, maxGb: 20 } };
  assert.equal(call("vps-cloud-move:view", { origin: VPS.origin }).stage, "buying", "no origin while it sets up");
  const ready = { state: "ready", origin, power: { state: "awake", since: 1, sleeps: true }, disk: { gb: 20, maxGb: 20 } };
  summary = ready;
  assert.equal(call("vps-cloud-move:view", { origin: VPS.origin }).stage, "waiting", "ready without the service's word on moves never starts");
  summary = { ...ready, moves: true };
  assert.deepEqual(call("vps-cloud-move:view", { origin: VPS.origin }), { place: VPS.name, route: "direct", stage: "moving", phase: "copy" });
});

test("signed out, the buy says so and the page goes to sign-in", async () => {
  const { call } = setup({ handoff: async () => ({ signedOut: true }) });
  await assert.rejects(call("vps-cloud-move:buy", { origin: VPS.origin }, "pro"), /Sign in to madani cloud first/);
});

test("asked from the rail or the dashboard, only that server's own page opens the sheet, once", () => {
  const { move, call } = setup();
  assert.equal(call("vps-cloud-move:asked", { origin: VPS.origin }), false, "nothing asked yet");
  assert.throws(() => move.ask("cloud"), /isn't in this app/, "never a Cloud");
  move.ask(VPS.id);
  assert.equal(call("vps-cloud-move:asked", { origin: "https://cloud.example.test" }), false, "another page never");
  assert.equal(call("vps-cloud-move:asked", { local: true }), false);
  assert.equal(call("vps-cloud-move:asked", { origin: VPS.origin }), true);
  assert.equal(call("vps-cloud-move:asked", { origin: VPS.origin }), false, "once");
});

test("signed out, the buy continues in the browser for the plan (sign in, then its checkout there), and the page says so", async () => {
  let status = "signed-out";
  const continued = [];
  const { call, move } = setup({ account: () => ({ status }), continueInBrowser: async (intent) => { continued.push(intent); status = "connecting"; return { outcome: "browser" }; } });
  const view = await call("vps-cloud-move:buy", { origin: VPS.origin }, "plus");
  assert.deepEqual(continued, [{ kind: "upgrade", plan: "plus", source: "app_computer_move" }]);
  assert.equal(view.stage, "buying");
  assert.equal(view.signingIn, true, "the page shows Continue in your browser");
  status = "connected";
  await move.signedInNow();
  assert.equal(call("vps-cloud-move:view", { origin: VPS.origin }).signingIn, undefined, "signed in there: the usual checkout wait");
});

test("signed out, a browser sign-in that didn't start is said plainly, never a checkout wait over nothing", async () => {
  const { call } = setup({ account: () => ({ status: "signed-out" }), continueInBrowser: async () => ({ outcome: "failed" }) });
  await assert.rejects(call("vps-cloud-move:buy", { origin: VPS.origin }, "plus"), /sign-in page didn't open/);
});
