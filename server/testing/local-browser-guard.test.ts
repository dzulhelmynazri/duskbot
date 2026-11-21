import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("refuses container subprocesses before launching them inside an isolated native-browser fixture", () => {
  const directory = mkdtempSync(join(tmpdir(), "madani-native-guard-"));
  try {
    const result = spawnSync(process.execPath, ["--import", new URL("./local-browser-guard.mjs", import.meta.url).href,
      "--input-type=module", "-e", `
        import assert from 'node:assert/strict';
        import {spawnSync, execFileSync} from 'node:child_process';
        assert.throws(() => spawnSync('docker', ['version']), /refuses container commands/);
        assert.throws(() => execFileSync('/fixture/podman', ['version']), /refuses container commands/);
      `], { env: { HOME: directory, MADANI_DATA_DIR: directory, MADANI_TEST_LOCAL_BROWSER_GUARD: "1" }, encoding: "utf8", timeout: 5_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(directory, "container-attempts.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)))
      .toEqual([{ command: "docker" }, { command: "podman" }]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
