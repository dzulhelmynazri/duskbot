import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { parseSettingsListing, REFUSED_MS, syncSettings } from "./settings-sync.mjs";

const digest = (key, value) => createHash("sha256").update(`omb-setting:${key}:${JSON.stringify(value ?? null)}`).digest("hex");

/** One place as server/settings-sync.ts answers it, in memory: values and when each changed, every call recorded. */
function place(kind, label, settings = {}, { secrets = [], refuse = [] } = {}) {
  const calls = [];
  const state = structuredClone(settings);
  const client = {
    list: async () => parseSettingsListing({ place: { id: label, label }, settings: Object.fromEntries(Object.entries(state).map(([key, { value, at }]) =>
      [key, { digest: digest(key, value), at, kind: secrets.includes(key) ? "secret" : "plain", set: value !== undefined && value !== null && value !== "" }])) }),
    values: async (keys) => { calls.push(["values", ...keys]); return Object.fromEntries(keys.map((key) => [key, state[key]?.value ?? null])); },
    put: async (key, value, at) => {
      calls.push(["put", key]);
      if (refuse.includes(key)) throw Object.assign(new Error("refused"), { status: 400 });
      state[key] = { value, at };
      return { ok: true };
    },
  };
  return { key: `${kind}:${label}`, kind, label, client, calls, state };
}
const run = (places, options = {}) => syncSettings(places, { now: () => 1_000, ...options });
const value = (where, key) => where.state[key]?.value;

test("the last change wins, wherever it was made, and reaches every place that differs", async () => {
  const mac = place("local", "This computer", { language: { value: "fr", at: 100 }, "ui.madani-skin": { value: "midnight", at: 50 } });
  const cloud = place("cloud", "My Cloud", { language: { value: "de", at: 300 }, "ui.madani-skin": { value: "midnight", at: 0 } });
  const vps = place("server", "vps", { language: { value: undefined, at: 0 }, "ui.madani-skin": { value: undefined, at: 0 } });
  const done = await run([mac, cloud, vps]);
  assert.deepEqual(done.failed, []);
  assert.equal(value(mac, "language"), "de");
  assert.equal(value(vps, "language"), "de");
  assert.equal(mac.state.language.at, 300, "taken with the time it changed there");
  assert.equal(value(vps, "ui.madani-skin"), "midnight");
  assert.deepEqual(cloud.calls.filter(([op]) => op === "put"), [], "My Cloud had the newest: nothing written there");
  const again = await run([mac, cloud, vps]);
  assert.deepEqual(again.changed, []);
});

test("a setting nobody changed since its place first saw it: set beats unset, then this computer, then My Cloud", async () => {
  const mac = place("local", "This computer", { talkingStyle: { value: "direct", at: 0 }, language: { value: undefined, at: 0 } });
  const cloud = place("cloud", "My Cloud", { talkingStyle: { value: "warm", at: 0 }, language: { value: "ja", at: 0 } });
  await run([mac, cloud]);
  assert.equal(value(cloud, "talkingStyle"), "direct", "a new Cloud takes this computer's");
  assert.equal(value(mac, "language"), "ja", "a clean computer takes the Cloud's, never the reverse");
});

test("secrets are read only from the place that has the newest, and a setting one place does not list is left alone", async () => {
  const mac = place("local", "This computer", { "anthropic.key": { value: "k-old", at: 10 } }, { secrets: ["anthropic.key"] });
  const cloud = place("cloud", "My Cloud", { "anthropic.key": { value: "k-new", at: 20 }, "anthropic.url": { value: "https://gw.example", at: 20 } }, { secrets: ["anthropic.key"] });
  await run([mac, cloud]);
  assert.equal(value(mac, "anthropic.key"), "k-new");
  assert.equal(value(mac, "anthropic.url"), undefined, "this computer reaches its own address: not listed, not written");
  assert.deepEqual(mac.calls.filter(([op]) => op === "values"), []);
  assert.deepEqual(cloud.calls.filter(([op]) => op === "values"), [["values", "anthropic.key"]]);
});

test("a value a place refuses is not offered to it again soon, and one that does not answer is left out", async () => {
  const mac = place("local", "This computer", { defaultModelSelection: { value: { instanceId: "codex-here", model: "m" }, at: 50 } });
  const cloud = place("cloud", "My Cloud", { defaultModelSelection: { value: { instanceId: "claude", model: "s" }, at: 10 } }, { refuse: ["defaultModelSelection"] });
  const down = { key: "server:down", kind: "server", label: "down", client: { list: async () => { throw new Error("offline"); } } };
  const refused = new Map();
  const first = await run([mac, cloud, down], { refused });
  assert.deepEqual(first.failed, ["defaultModelSelection at My Cloud"]);
  const second = await run([mac, cloud, down], { refused });
  assert.deepEqual(second.failed, []);
  assert.equal(cloud.calls.filter(([op]) => op === "put").length, 1);
  const later = await run([mac, cloud], { refused, now: () => 1_000 + REFUSED_MS + 1 });
  assert.deepEqual(later.failed, ["defaultModelSelection at My Cloud"], "asked again once the wait is over");
});

test("one place alone has nothing to bring level", async () => {
  const mac = place("local", "This computer", { language: { value: "fr", at: 5 } });
  assert.deepEqual(await run([mac]), { changed: [], failed: [] });
});
