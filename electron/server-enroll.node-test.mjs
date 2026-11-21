import assert from "node:assert/strict";
import test from "node:test";
import { cloudMoveLinkWorkspace, createServerEnroll } from "./server-enroll.mjs";

const grant = { enrollToken: "e".repeat(43), dashboardUrl: "https://accounts.test" };
const signedIn = (id = "acct_a") => ({ status: "connected", account: { id } });

function fixture(overrides = {}) {
  const f = { memory: null, calls: [], unlinked: [], grants: 0, logs: [], timers: [], servers: [{ id: "env1", key: "envid-1", name: "box" }], answer: { claimed: true, workspaceId: "ws_box1" }, unlinkAnswer: true };
  f.enroll = createServerEnroll({
    client: () => ({ enrollGrant: async () => { f.grants++; return grant; }, unlinkWorkspace: async (id) => { f.unlinked.push(id); return f.unlinkAnswer; } }),
    servers: () => f.servers,
    call: async (id, method, route, body) => { f.calls.push({ id, method, route, body }); if (f.fail) throw new Error("down"); return method === "POST" ? f.answer : { ok: true }; },
    store: { read: () => f.memory, write: (value) => { f.memory = structuredClone(value); } },
    log: (line) => f.logs.push(line),
    setTimer: (fn, ms) => { f.timers.push({ fn, ms }); return f.timers.length; },
    clearTimer: () => {},
    ...overrides,
  });
  return f;
}

test("a server linked with the install line joins the signed-in account's dashboard, once, with no secret kept", async () => {
  const f = fixture();
  await f.enroll.kick();
  assert.equal(f.calls.length, 0, "signed out: nothing is asked");
  f.enroll.onState(signedIn());
  await f.enroll.kick();
  assert.deepEqual(f.calls, [{ id: "env1", method: "POST", route: "/api/dashboard/link", body: { url: grant.dashboardUrl, enrollToken: grant.enrollToken } }]);
  assert.equal(f.memory.linked["envid-1"].workspaceId, "ws_box1");
  assert.equal(f.memory.linked["envid-1"].accountId, "acct_a");
  assert.ok(!JSON.stringify(f.memory).includes(grant.enrollToken));
  assert.ok(f.logs.every((line) => !line.includes(grant.enrollToken)));
  await f.enroll.kick();
  assert.equal(f.calls.length, 1, "already on the dashboard: not asked again");
  assert.equal(f.enroll.placeFor("ws_box1"), "env1");
  assert.equal(f.enroll.placeFor("ws_other"), null);
});

test("a server that fails is tried again later, a few times, then left alone", async () => {
  let clock = 0;
  const g = fixture({ now: () => clock });
  g.fail = true;
  g.enroll.onState(signedIn());
  await g.enroll.kick();
  assert.equal(g.calls.length, 1);
  assert.equal(g.timers[0].ms, 30_000);
  await g.enroll.kick();
  assert.equal(g.calls.length, 1, "not before its wait");
  for (const wait of [30_000, 120_000, 600_000]) { clock += wait; await g.enroll.kick(); }
  assert.equal(g.calls.length, 4);
  clock += 10 * 60 * 60_000; await g.enroll.kick();
  assert.equal(g.calls.length, 4, "given up until the next sign-in");
  g.enroll.onState(signedIn("acct_b"));
  await g.enroll.kick();
  assert.equal(g.calls.length, 5);
  g.fail = false;
  clock += 30_000; await g.enroll.kick();
  assert.equal(g.memory.linked["envid-1"].accountId, "acct_b");
});

test("forgetting the server takes it off the dashboard, and asks again at the next sign-in when that fails", async () => {
  const f = fixture();
  f.enroll.onState(signedIn());
  await f.enroll.kick();
  await f.enroll.forget("env1");
  assert.deepEqual(f.unlinked, ["ws_box1"]);
  assert.deepEqual(f.calls.at(-1), { id: "env1", method: "DELETE", route: "/api/dashboard/link", body: {} });
  assert.deepEqual(f.memory.linked, {});
  assert.deepEqual(f.memory.unlink, []);

  const g = fixture();
  g.enroll.onState(signedIn());
  await g.enroll.kick();
  g.servers = [];
  g.enroll.onState({ status: "signed-out", account: null });
  g.fail = true;
  await g.enroll.forget("env1");
  assert.deepEqual(g.unlinked, [], "signed out: nothing to ask yet");
  assert.deepEqual(g.memory.unlink, [{ accountId: "acct_a", workspaceId: "ws_box1" }]);
  g.enroll.onState(signedIn());
  await g.enroll.kick();
  assert.deepEqual(g.unlinked, ["ws_box1"]);
  assert.deepEqual(g.memory.unlink, []);
  await g.enroll.forget("env-unknown");
  assert.deepEqual(g.unlinked, ["ws_box1"]);
});

test("the same server saved again keeps its dashboard place", async () => {
  const f = fixture();
  f.enroll.onState(signedIn());
  await f.enroll.kick();
  f.servers = [{ id: "env2", key: "envid-1", name: "box" }];
  await f.enroll.kick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.memory.linked["envid-1"].envId, "env2");
  assert.equal(f.enroll.placeFor("ws_box1"), "env2");
});

test("the dashboard's move link carries a workspace id only", () => {
  assert.equal(cloudMoveLinkWorkspace("madanibot://cloud-move/ws_abc123"), "ws_abc123");
  assert.equal(cloudMoveLinkWorkspace("madanibot://cloud-move/ws_abc123/"), "ws_abc123");
  for (const bad of ["madanibot://cloud-move/https://evil.test", "madanibot://cloud-move/", "madanibot://cloud", "madanibot://cloud-move/ws_a?x=1", null]) assert.equal(cloudMoveLinkWorkspace(bad), null);
});
