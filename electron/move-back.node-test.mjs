import assert from "node:assert/strict";
import test from "node:test";

import { createMoveBack } from "./move-back.mjs";

const HAND = { id: "env-box", kind: "remote", origin: "https://box.example", name: "box" };
const ENV_ID = "11111111-2222-4333-8444-555555555555";

function fixture(over = {}) {
  const calls = [];
  const server = { frozen: false, deleted: false };
  const deps = {
    link: () => null,
    viaLink: async () => ({ freeze: async () => { calls.push("link-freeze"); }, thaw: async () => { calls.push("link-thaw"); } }),
    away: () => false,
    home: () => null,
    moving: () => false,
    places: () => [HAND, { id: "cloud", kind: "remote", origin: "https://c.example", name: "My Cloud", cloud: true }],
    who: async () => ({ signedIn: true, own: true, environmentId: ENV_ID }),
    async serverCall(from, method, route, body) {
      calls.push(`${method} ${from.origin}${route}`);
      if (route === "/api/move/freeze" && method === "POST") { assert.equal(typeof body.place, "string"); server.frozen = true; }
      if (route === "/api/move/freeze" && method === "DELETE") server.frozen = false;
      return {};
    },
    local: async (method, route) => {
      if (route === "/api/move/freeze") return { frozen: false };
      if (route.startsWith("/api/bots")) return { bots: [{ id: "madani", defaultBot: true }] };
      return {};
    },
    backupHere: async () => { calls.push("backup-here"); },
    backupFrom: async (from, onBytes) => { calls.push(`backup-from ${from.origin}`); onBytes(5, 10); return { id: "b1" }; },
    restoreFile: async (entry) => { calls.push(`restore ${entry.id}`); },
    label: () => "my mac",
    finish: () => { calls.push("finish"); },
    onChange: () => {},
    ...over,
  };
  return { back: createMoveBack(deps), calls, server, deps };
}

test("bots come from a hand-saved server of the person's own to an empty computer, and the server keeps its copy paused", async () => {
  const seen = [];
  const { back, calls, server } = fixture({ onChange: () => seen.push(back.view()?.step) });
  assert.deepEqual(await back.run("env-box"), { ok: true });
  assert.deepEqual(calls, ["backup-here", "POST https://box.example/api/move/freeze", "backup-from https://box.example", "restore b1", "finish"]);
  assert.equal(server.frozen, true);
  assert.ok(!calls.some((call) => call.startsWith("DELETE")), "nothing on the server is deleted or lifted");
  for (const step of ["check", "backup-here", "pause", "copy", "restore"]) assert.ok(seen.includes(step), step);
  assert.equal(back.view().status, "done");
});

test("a computer with bots of its own is never replaced", async () => {
  const { back, calls } = fixture({ local: async (method, route) => (route.startsWith("/api/bots") ? { bots: [{ id: "a" }] } : { frozen: false }) });
  await assert.rejects(back.run("env-box"), /bots of its own/);
  assert.deepEqual(calls, []);
  assert.deepEqual(await back.sources(), { places: [{ id: "env-box", name: "box" }], blocked: "own-bots" });
});

test("a computer whose bots moved elsewhere can't take another server's bots", async () => {
  const { back } = fixture({ local: async (method, route) => (route === "/api/move/freeze" ? { frozen: true } : { bots: [] }) });
  await assert.rejects(back.run("env-box"), /moved somewhere else/);
});

test("a server with other people on it or a signed-out one gives nothing", async () => {
  const shared = fixture({ who: async () => ({ signedIn: true, own: false, environmentId: ENV_ID }) });
  await assert.rejects(shared.back.run("env-box"), /other people/);
  assert.deepEqual(shared.calls, []);
  const out = fixture({ who: async () => ({ signedIn: false, own: false, environmentId: null }) });
  await assert.rejects(out.back.run("env-box"), /isn't signed in/);
});

test("only saved servers, never a Cloud, are a source", async () => {
  const { back } = fixture();
  await assert.rejects(back.run("cloud"), /isn't in this app/);
});

test("a copy that fails lifts the server's pause and changes nothing here", async () => {
  const { back, calls, server } = fixture({ backupFrom: async () => { throw new Error("The backup could not be saved."); } });
  await assert.rejects(back.run("env-box"), /could not be saved/);
  assert.equal(server.frozen, false);
  assert.ok(!calls.some((call) => call.startsWith("restore")));
  assert.equal(back.view().status, "failed");
});

test("a busy bot on the server says so plainly", async () => {
  const { back } = fixture({ serverCall: async () => { throw Object.assign(new Error("A bot is still working."), { status: 409 }); } });
  await assert.rejects(back.run("env-box"), /still working/);
});

test("after a move to a hand-saved server, the bots come back from it without a link-service link", async () => {
  const home = { id: "env-box", origin: "https://box.example", name: "box", environmentId: ENV_ID };
  const { back, calls } = fixture({ away: () => true, home: () => home, local: async () => { throw new Error("frozen here"); } });
  assert.deepEqual(await back.sources(), { places: [{ id: "env-box", name: "box" }], blocked: null });
  await back.run();
  assert.deepEqual(calls, ["backup-here", "POST https://box.example/api/move/freeze", "backup-from https://box.example", "restore b1", "finish"]);
});

test("a server that is another one now behind the same address gives nothing", async () => {
  const home = { id: "env-box", origin: "https://box.example", name: "box", environmentId: ENV_ID };
  const { back } = fixture({ away: () => true, home: () => home, who: async () => ({ signedIn: true, own: true, environmentId: "99999999-2222-4333-8444-555555555555" }) });
  await assert.rejects(back.run(), /another one now/);
});

test("a linked server is paused through its agent", async () => {
  const home = { id: "env-box", origin: "https://box.example", name: "box" };
  const { back, calls } = fixture({ away: () => true, home: () => home, link: () => ({ id: "l1", envId: "env-box", origin: "https://box.example", name: "box" }) });
  await back.run();
  assert.deepEqual(calls, ["backup-here", "link-freeze", "backup-from https://box.example", "restore b1", "finish"]);
});

test("a backup of this computer that fails stops before the server is touched, and a retry can go through", async () => {
  let failing = true;
  const { back, calls, server } = fixture({ backupHere: async () => { calls.push("backup-here"); if (failing) throw new Error("disk full"); } });
  await assert.rejects(back.run("env-box"), /backup of this computer could not be saved first, so nothing was moved/);
  assert.deepEqual(calls, ["backup-here"]);
  assert.equal(server.frozen, false);
  assert.equal(back.view().status, "failed");
  failing = false;
  assert.deepEqual(await back.run("env-box"), { ok: true });
});

test("a copy that runs out of time says so plainly, and the server's pause is lifted", async () => {
  const { back, server } = fixture({ backupFrom: async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); } });
  await assert.rejects(back.run("env-box"), /box took too long to answer\. Your bots are still there\. Try again\./);
  assert.equal(back.view().status, "failed");
  assert.equal(server.frozen, false);
});
