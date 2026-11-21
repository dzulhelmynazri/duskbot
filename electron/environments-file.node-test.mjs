import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createEnvironmentsFile } from "./environments-file.mjs";

function setup(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "madani-envs-"));
  const target = path.join(dir, "environments.json");
  if (text !== undefined) fs.writeFileSync(target, text);
  const store = createEnvironmentsFile({ file: () => target, fs, path, now: () => 42 });
  return { dir, target, store, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("a damaged or newer saved-servers list is kept aside before the app reads it as empty", () => {
  for (const text of ['{"version":2,"environments":[{"id":"vps"', '{"version":3,"environments":[{"id":"vps"}]}']) {
    const { dir, target, store, done } = setup(text);
    try {
      assert.deepEqual(store.read().environments, []);
      store.read();
      assert.deepEqual(fs.readdirSync(dir).sort(), ["environments.json", "environments.json.unreadable-42"]);
      assert.equal(fs.readFileSync(`${target}.unreadable-42`, "utf8"), text);
    } finally { done(); }
  }
});

test("a readable list or no list keeps nothing aside", () => {
  for (const text of [undefined, '{"version":2,"environments":[],"activeId":"local"}']) {
    const { dir, store, done } = setup(text);
    try {
      store.read();
      assert.equal(fs.readdirSync(dir).some((name) => name.includes("unreadable")), false);
    } finally { done(); }
  }
});
