import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { accountGateRequired, gateBlocks, installAccountGate } from "./account-gate.mjs";

test("no desktop requires an account before the app unless the install asks for one (MADANI_REQUIRE_ACCOUNT=1), and never a remote page", () => {
  for (const packaged of [true, false]) for (const custom of [true, false]) for (const remote of [true, false]) for (const want of [undefined, "0", "1"]) {
    assert.equal(accountGateRequired({ env: { MADANI_REQUIRE_ACCOUNT: want }, packaged, custom, remote }), !remote && want === "1");
  }
});

test("a kept account can work offline, while every incomplete or ended sign-in blocks", () => {
  for (const status of ["connected", "unavailable", "connecting", "reauth-required", "restoring", "signed-out"]) {
    assert.equal(gateBlocks({ status, account: { id: "a" } }), !["connected", "unavailable"].includes(status)); assert.equal(gateBlocks({ status }), true);
  }
  assert.equal(gateBlocks(null), true); assert.equal(gateBlocks(undefined), true);
});

function fixture() {
  const handlers = new Map(), calls = [], guarded = [], sent = [];
  const f = { state: { status: "connecting", message: "waiting", enrollment: { userCode: "ABCDE-FGHJK", expiresAt: 100, token: "private" }, token: "private" }, required: true, alive: true };
  const client = { state: () => f.state,
    emailStart: async (...args) => { calls.push(["emailStart", ...args]); return { outcome: "sent" }; },
    emailVerify: async (...args) => { calls.push(["emailVerify", ...args]); return f.verify ?? { outcome: "signed-in", state: { token: "private" } }; },
    emailCancel: () => calls.push(["emailCancel"]),
    begin: async (...args) => { calls.push(["begin", ...args]); }, cancel: async () => { calls.push(["cancel"]); f.state = { status: "signed-out" }; },
    reopen: async () => { calls.push(["reopen"]); }, signInOptions: async () => ({ providers: ["google", "apple"], recovery: true }) };
  f.gate = installAccountGate({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    guard: (channel, handler) => (...args) => { guarded.push(channel); return handler(...args); }, client: () => client, required: () => f.required,
    window: () => f.noWindow ? null : { isDestroyed: () => !f.alive, webContents: { send: (...args) => sent.push(args) } } });
  return Object.assign(f, { calls, guarded, sent, handlers, call: (method, ...args) => handlers.get(`account-gate:${method}`)({}, ...args) });
}

test("every gate channel is guarded, accepts plain strings only, and strips identity and tokens from answers and changes", async () => {
  const f = fixture();
  assert.deepEqual([...f.handlers.keys()], ["state", "signInStart", "options", "signInVerify", "signInCancel", "browser", "magicLink", "cancel", "reopen"].map(name => `account-gate:${name}`));
  const expected = { required: true, blocked: true, status: "connecting", message: "waiting", enrollment: { userCode: "ABCDE-FGHJK", expiresAt: 100 } };
  assert.deepEqual(await f.call("state"), expected);
  await f.call("signInStart", { email: "x" }); await f.call("signInStart", "a@example.test"); await f.call("signInStart", "a@example.test", { recover: true }); await f.call("signInStart", "a@example.test", { recover: "yes" });
  assert.deepEqual(await f.call("options"), { providers: ["google", "apple"], recovery: true });
  assert.deepEqual(await f.call("signInVerify", 12345678), { outcome: "signed-in" });
  f.verify = { outcome: "wrong-code", triesLeft: 3, state: { token: "private" } };
  assert.deepEqual(await f.call("signInVerify", "12345678"), { outcome: "wrong-code", triesLeft: 3 });
  await f.call("signInCancel", "ignored");
  assert.deepEqual(await f.call("browser", "google"), expected); await f.call("browser", { provider: "x" });
  await f.call("magicLink", "a@example.test"); await f.call("magicLink", { email: "x" });
  f.gate.changed(f.state); assert.deepEqual(f.sent, [["account-gate:changed", expected]]);
  f.alive = false; f.gate.changed(f.state); f.noWindow = true; f.gate.changed(f.state); assert.equal(f.sent.length, 1);
  assert.deepEqual(await f.call("cancel", "ignored"), { required: true, blocked: true, status: "signed-out" });
  f.required = false; assert.equal((await f.call("state")).blocked, false);
  await f.call("reopen");
  f.state = { status: "connecting", browser: "google", token: "private" };
  assert.deepEqual(await f.call("state"), { required: false, blocked: false, status: "connecting", browser: "google" });
  assert.deepEqual(f.calls, [["emailStart", "", { recover: false }], ["emailStart", "a@example.test", { recover: false }], ["emailStart", "a@example.test", { recover: true }], ["emailStart", "a@example.test", { recover: false }], ["emailVerify", ""], ["emailVerify", "12345678"], ["emailCancel"], ["begin", null, { provider: "google" }], ["begin", null, { provider: "" }], ["begin", null, { email: "a@example.test" }], ["begin", null, { email: "" }], ["cancel"], ["reopen"]]);
  f.state = { status: "connecting", enrollment: { userCode: "ABCDE-FGHJK", expiresAt: 1 }, magic: "a@example.test", token: "private" };
  assert.deepEqual(await f.call("state"), { required: false, blocked: false, status: "connecting", enrollment: { userCode: "ABCDE-FGHJK", expiresAt: 1 }, magic: "a@example.test" });
  assert.equal(f.guarded.length, 18); assert.ok(!JSON.stringify(f.sent).includes("private"));
});

function preload({ enabled = true, remote = false } = {}) {
  let bridge; const calls = [], listeners = new Map();
  vm.runInNewContext(readFileSync(new URL("./preload.cjs", import.meta.url), "utf8"), {
    process: { platform: "fixture", argv: ["--madani-local-origin=http://127.0.0.1:1234", ...(enabled ? ["--madani-account-gate=1"] : [])] },
    location: { origin: remote ? "https://remote.test" : "http://127.0.0.1:1234" }, TextEncoder, localStorage: { getItem: () => null },
    require: () => ({ webUtils: {}, contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } }, ipcRenderer: {
      invoke: (...args) => { calls.push(args); return Promise.resolve(null); }, on: (channel, handler) => listeners.set(channel, handler),
      removeListener: (channel, handler) => { assert.equal(listeners.get(channel), handler); listeners.delete(channel); }, send() {},
    } }),
  });
  return { bridge, calls, listeners };
}

test("the gate bridge is flag-gated and local, coerces words and unsubscribes from its own changed channel", async () => {
  const f = preload(), gate = f.bridge.accountGate;
  assert.equal(preload({ enabled: false }).bridge.accountGate, undefined); assert.equal(preload({ remote: true }).bridge.accountGate, undefined);
  await gate.state(); await gate.signInStart({ toString: () => "a@example.test" }); await gate.signInVerify(12345678); await gate.signInCancel("ignored"); await gate.browser("apple"); await gate.cancel("ignored");
  await gate.signInStart("a@example.test", { recover: true }); await gate.options("ignored"); await gate.reopen("ignored");
  // the options object is made in the preload's own realm
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls)), [["account-gate:state"], ["account-gate:signInStart", "a@example.test", { recover: false }], ["account-gate:signInVerify", "12345678"], ["account-gate:signInCancel"], ["account-gate:browser", "apple"], ["account-gate:cancel"],
    ["account-gate:signInStart", "a@example.test", { recover: true }], ["account-gate:options"], ["account-gate:reopen"]]);
  const changes = [], unsubscribe = gate.onChange(state => changes.push(state)); f.listeners.get("account-gate:changed")({}, { status: "connected" });
  assert.deepEqual(changes, [{ status: "connected" }]); unsubscribe(); assert.equal(f.listeners.has("account-gate:changed"), false);
});
