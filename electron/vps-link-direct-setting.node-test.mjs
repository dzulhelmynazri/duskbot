import assert from "node:assert/strict";
import test from "node:test";

import { installLinkDirectIpc } from "./vps-link-main.mjs";
import { createVpsLink } from "./vps-link.mjs";

const ORIGIN = "http://vps-cccccccccc.localhost:5555";
const HOST_KEY = `ssh-ed25519 ${"A".repeat(68)}`;
const until = async (check, ms = 2000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

function setup({ direct = true, controlFails = new Set(), extra = {}, deps = {}, caps = ["direct-ssh"], cfUrl = () => null } = {}) {
  let value = { v: 1, current: "cccccccccc", links: [{ id: "cccccccccc", base: "http://relay.invalid", name: "box", mode: "relay", origin: ORIGIN, port: 5555, envId: "env-1", keyP: "p:k", tokenP: "p:t", ...extra }] };
  const store = { read: () => value, write: (next) => { value = JSON.parse(JSON.stringify(next)); } };
  const controls = [], uses = [], hellos = [], specs = [];
  const proxy = {
    start: async () => ORIGIN,
    close: async () => {},
    control: async (op) => {
      if (op === "hello") { hellos.push(op); if (controlFails.has(op)) throw new Error("Your server did not answer. Is it on?"); return { protocol: 2, caps }; }
      controls.push(op);
      if (controlFails.has(op)) throw new Error("Your server did not answer. Is it on?");
      if (op === "direct-cf") return { url: cfUrl() };
      if (op === "direct-key") return { v: 1, host: "203.0.113.9", port: 22, user: "maus", hostKeys: [HOST_KEY] };
      return { ok: true };
    },
    useDirect: (spec) => { uses.push(spec ? "on" : "off"); specs.push(spec); },
    transport: () => "relay",
  };
  const link = createVpsLink({
    base: "http://relay.invalid",
    fetch: async () => { throw new Error("offline"); },
    serverFetch: async () => { throw new Error("offline"); },
    store, protect: async (text) => `p:${text}`, unprotect: async (text) => text.slice(2), label: () => "Mac",
    saveServer: () => "env-1", forgetServer: () => {}, switchTo: () => {}, ownHome: { away: () => false, view: () => null, home: () => null, chosen: () => null, start: async () => {} },
    ownHomeReset: () => {}, localRequest: async () => new Response("{}"), backups: { save: async () => ({}), open: async () => ({}) },
    localCredentials: { codexAuth: async () => null, claudeCli: async () => null, claudeToken: async () => "" }, relaunch: () => {},
    proxyFactory: () => proxy,
    ...deps,
    ...(direct ? { direct: { newKey: () => ({ privateKey: "private", publicKey: `ssh-ed25519 ${"B".repeat(68)}` }), connector: () => async () => ({}) } } : {}),
  });
  return { link, proxy, controls, uses, hellos, specs, stored: () => value.links[0] };
}

test("the direct path comes up by itself once the tunnel is open", async () => {
  const { link, controls, uses } = setup();
  await link.resume();
  await until(() => uses.includes("on"));
  assert.deepEqual(controls, ["direct-key"]);
  assert.deepEqual(link.directSetting(ORIGIN), { on: true, path: "relay" });
  assert.equal(link.directSetting("http://elsewhere.localhost:1"), null);
  await link.close();
});

test("turning it off closes the path and takes the key off the server; on sets up a new key", async () => {
  const { link, controls, uses, stored } = setup();
  await link.resume();
  await until(() => uses.includes("on"));
  assert.deepEqual(await link.setDirect(ORIGIN, false), { on: false, path: "relay" });
  assert.equal(uses.at(-1), "off");
  assert.deepEqual(controls, ["direct-key", "direct-off"]);
  assert.equal(stored().directOff, true);
  assert.equal(stored().directRevoke, undefined);
  assert.equal(stored().direct, undefined);
  assert.deepEqual(await link.setDirect(ORIGIN, true), { on: true, path: "relay" });
  await until(() => controls.length === 3);
  assert.equal(controls[2], "direct-key");
  await until(() => uses.at(-1) === "on");
  assert.equal(stored().directOff, undefined);
  await link.close();
});

test("an off switch stays off across launches, and a server that missed the revoke is asked again", async () => {
  const first = setup({ controlFails: new Set(["direct-off"]) });
  await first.link.resume();
  await until(() => first.uses.includes("on"));
  await first.link.setDirect(ORIGIN, false);
  assert.equal(first.stored().directRevoke, true);
  await first.link.close();
  const { directOff, directRevoke } = first.stored();
  const relaunch = setup({ extra: { directOff, directRevoke } });
  await relaunch.link.resume();
  await until(() => relaunch.controls.length === 1);
  assert.deepEqual(relaunch.controls, ["direct-off"]);
  assert.deepEqual(relaunch.uses, []);
  await until(() => relaunch.stored().directRevoke === undefined);
  assert.equal(relaunch.stored().directOff, true);
  assert.deepEqual(relaunch.link.directSetting(ORIGIN), { on: false, path: "relay" });
  await relaunch.link.close();
});

test("unlinking takes the key off the server before the tunnel is forgotten", async () => {
  const { link, controls, uses } = setup();
  await link.resume();
  await until(() => uses.includes("on"));
  await link.forget();
  assert.deepEqual(controls, ["direct-key", "direct-off"]);
  await link.close();
});

test("MADANI_LINK_DIRECT=off in the app: no row, nothing asked of the server", async () => {
  const { link, controls } = setup({ direct: false });
  await link.resume();
  assert.equal(link.directSetting(ORIGIN), null);
  assert.equal(await link.setDirect(ORIGIN, false), null);
  assert.deepEqual(controls, []);
  await link.close();
});

test("main names the link from the page asking, never from the page's words", async () => {
  const handlers = new Map();
  const asked = [];
  installLinkDirectIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    pageOrigin: (event) => event.origin ?? null,
    link: { directSetting: (origin) => { asked.push(["state", origin]); return { on: true, path: "direct" }; }, setDirect: async (origin, on) => { asked.push(["set", origin, on]); return { on, path: "relay" }; } },
  });
  assert.deepEqual(await handlers.get("link-direct:state")({ origin: ORIGIN }), { on: true, path: "direct" });
  assert.equal(await handlers.get("link-direct:state")({}), null);
  await assert.rejects(async () => handlers.get("link-direct:set")({}, false));
  assert.deepEqual(await handlers.get("link-direct:set")({ origin: ORIGIN }, "yes"), { on: false, path: "relay" });
  assert.deepEqual(asked, [["state", ORIGIN], ["set", ORIGIN, false]]);
});

test("a server not reachable when the app opens (a captive portal) gets its direct path once it answers, not never", async () => {
  const controlFails = new Set(["hello", "direct-key"]);
  const { link, controls, uses, hellos } = setup({ controlFails, deps: { setupAgainMs: [20] } });
  await link.resume();
  await until(() => hellos.length >= 2);
  assert.deepEqual(uses, []);
  controlFails.clear();
  await until(() => uses.includes("on"));
  assert.ok(controls.includes("direct-key"));
  await link.close();
});

test("a cloudflare address that is not there yet joins the running direct path later, without dropping it", async () => {
  let url = null;
  const dialled = [];
  const direct = { newKey: () => ({ privateKey: "private", publicKey: `ssh-ed25519 ${"B".repeat(68)}` }), connector: () => async () => { dialled.push("ssh"); throw new Error("no"); }, wssConnector: ({ via }) => async () => { dialled.push(via); throw new Error("no"); } };
  const { link, uses, specs } = setup({ direct: false, caps: ["direct-ssh", "direct-cf"], cfUrl: () => url, deps: { setupAgainMs: [20], direct } });
  await link.resume();
  await until(() => uses.includes("on"));
  url = "wss://abc-def.trycloudflare.com/link";
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(uses, ["on"], "the direct path is set up once");
  await specs[0].connect().catch(() => {});
  assert.deepEqual(dialled.sort(), ["cf", "ssh"]);
  await link.close();
});

test("the row says which way the app reaches the server: directly, through its cloudflare tunnel, or through the relay", async () => {
  const { link, proxy } = setup();
  await link.resume();
  let via = "ssh";
  proxy.transport = () => "direct";
  proxy.directVia = () => via;
  assert.deepEqual(link.directSetting(ORIGIN), { on: true, path: "direct", via: "ssh" });
  via = "cf";
  assert.deepEqual(link.directSetting(ORIGIN), { on: true, path: "cloudflare" });
  via = "cloud";
  assert.deepEqual(link.directSetting(ORIGIN), { on: true, path: "relay" });
  proxy.transport = () => "relay";
  assert.deepEqual(link.directSetting(ORIGIN), { on: true, path: "relay" });
  await link.close();
});
