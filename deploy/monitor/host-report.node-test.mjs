import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { collect, newestBackups } from "./host-report.mjs";

test("finds the newest backup per set across runs, daily and weekly", () => {
  const root = mkdtempSync(join(tmpdir(), "madani-host-report-"));
  try {
    for (const [set, kind, name, at] of [["madani", "runs", "a.age", 1_000], ["madani", "daily", "b.age", 5_000], ["make", "daily", "c.age", 3_000]]) {
      mkdirSync(join(root, set, kind), { recursive: true });
      writeFileSync(join(root, set, kind, name), "x");
      utimesSync(join(root, set, kind, name), at, at);
    }
    mkdirSync(join(root, "empty"));
    const found = newestBackups(root).sort((a, b) => a.set.localeCompare(b.set));
    assert.deepEqual(found, [{ set: "madani", at: 5_000_000 }, { set: "empty", at: null }, { set: "make", at: 3_000_000 }]);
    assert.deepEqual(newestBackups(join(root, "missing")), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reports this box's numbers in the shape the ops page accepts", async () => {
  const report = await collect({ MADANI_HOST_NAME: "oracle", MADANI_BACKUP_ROOT: "/nonexistent" });
  assert.equal(report.host, "oracle");
  for (const key of ["mem", "disk"]) assert.ok(report[key] >= 0 && report[key] <= 100);
  assert.equal(report.load.length, 3);
  assert.deepEqual(report.backups, []);
});
