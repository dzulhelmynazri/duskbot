import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";

import { fixtureServer, guardRealEngines, realEngine, temporaryRoots } from "./engine-guard.ts";

// stand-ins for installed engines: outside every temporary folder, never run
const installed = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", ".cache", `madani-engine-guard-unit-${process.pid}`);
const bin = join(installed, "bin"), sdk = join(installed, "@anthropic-ai", "claude-agent-sdk", "cli.js");
mkdirSync(bin, { recursive: true });
mkdirSync(dirname(sdk), { recursive: true });
for (const file of [join(bin, "claude"), join(bin, "codex"), sdk]) writeFileSync(file, "", { mode: 0o755 });
const fixtureHome = mkdtempSync(join(tmpdir(), "madani-engine-guard-"));
mkdirSync(join(fixtureHome, "bin"));
writeFileSync(join(fixtureHome, "bin", "claude"), "", { mode: 0o755 });
afterAll(() => { rmSync(installed, { recursive: true, force: true }); rmSync(fixtureHome, { recursive: true, force: true }); });
const fixtures = temporaryRoots();

it("refuses an installed engine CLI however it is named, and lets a fixture engine in a temporary folder run", () => {
  expect(realEngine("claude", ["-p", "hi"], fixtures, bin)).toBe("claude");
  expect(realEngine(join(bin, "codex"), ["app-server"], fixtures)).toBe("codex");
  expect(realEngine("claude -p hello", [], fixtures, bin)).toBe("claude");
  expect(realEngine(process.execPath, [sdk], fixtures)).toBe("@anthropic-ai/claude-agent-sdk");
  expect(realEngine("claude", [], fixtures, join(fixtureHome, "bin"))).toBeNull();
  expect(realEngine("git", ["status"], fixtures)).toBeNull();
});

it("lets the read-only probes through, and an engine that is not installed fail on its own", () => {
  expect(realEngine("claude", ["--version"], fixtures, bin)).toBeNull();
  expect(realEngine("claude", ["auth", "status", "--json"], fixtures, bin)).toBeNull();
  expect(realEngine("claude", ["-p", "--version"], fixtures, bin)).toBe("claude");
  expect(realEngine("claude", ["-p", "hi"], fixtures, "/nonexistent")).toBeNull();
});

it("guards a server whose data folder is temporary, never an installed one, unless a live check allows real engines", () => {
  expect(fixtureServer({ MADANI_DATA_DIR: fixtureHome })).toBe(true);
  expect(fixtureServer({ MADANI_DATA_DIR: fixtureHome, MADANI_ALLOW_REAL_ENGINES: "1" })).toBe(false);
  expect(fixtureServer({ MADANI_DATA_DIR: join(homedir(), ".madanibot") })).toBe(false);
  expect(fixtureServer({})).toBe(false);
});

it("stops a spawn of a real engine through the live child_process exports", async () => {
  guardRealEngines(fixtures, (engine) => { throw new Error(`refused ${engine}`); });
  const { spawn, execFileSync } = await import("node:child_process");
  expect(() => spawn(process.execPath, [sdk])).toThrow("refused @anthropic-ai/claude-agent-sdk");
  expect(() => execFileSync(join(bin, "codex"), ["exec", "hello"])).toThrow("refused codex");
});
