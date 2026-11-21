import test from "node:test";
import assert from "node:assert/strict";
import { createUsageNotes } from "./usage-notes.mjs";

const NOTE = { id: "frust00001", at: 1 };
function setup({ install = "install_abcdefghijkl", status = 204, notes = { frustrations: [NOTE] } } = {}) {
  const local = [], remote = [];
  const localRequest = async (route, init = {}) => { local.push({ route, method: init.method ?? "GET", body: init.body }); return { ok: true, json: async () => ({ notes }) }; };
  const fetch = async (url, init) => { remote.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) }); return { status, body: null }; };
  const sender = createUsageNotes({ origin: "https://madani.bot", install: () => install, token: () => "tok", localRequest, platform: "darwin", version: "0.2.11", fetch, setTimer: () => 1, clearTimer: () => {} });
  return { sender, local, remote };
}

test("sends waiting notes with the install id and marks them sent once they landed", async () => {
  const { sender, local, remote } = setup();
  assert.equal(await sender.run(), true);
  assert.equal(remote[0].url, "https://madani.bot/v1/app/notes");
  assert.equal(remote[0].auth, "Bearer tok");
  assert.deepEqual(remote[0].body, { install: "install_abcdefghijkl", platform: "darwin", version: "0.2.11", frustrations: [NOTE] });
  assert.deepEqual(JSON.parse(local.at(-1).body), { sent: ["frust00001"] });
});

test("keeps the notes when the account service refuses them", async () => {
  const { sender, local } = setup({ status: 503 });
  assert.equal(await sender.run(), false);
  assert.equal(local.filter(call => call.method === "POST").length, 0);
});

test("sends nothing without an install id (usage analytics off) or without notes", async () => {
  for (const options of [{ install: null }, { notes: null }]) {
    const { sender, remote } = setup(options);
    assert.equal(await sender.run(), false);
    assert.equal(remote.length, 0);
  }
});
