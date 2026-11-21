import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUpdateState, UPDATE_STATE_FILE, type FinishedRun } from "./update-state.ts";
import { browserPageCheck, runSelfTest, type SelfTestChecks } from "./update-selftest.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), "madani-update-")); dirs.push(dir); return dir; };

function boot(dataDir: string, version: string, at: number, checks: SelfTestChecks, runs: FinishedRun[] = []) {
  let clock = at;
  const state = createUpdateState({ dataDir, version, checks, runs: since => runs.filter(r => r.at >= since), now: () => clock });
  return { state, tick: (ms: number) => { clock += ms; } };
}
const good: SelfTestChecks = { health: () => true, browser: async () => true, connectors: async () => ({ gmail: true }) };

describe("update state", () => {
  it("says 'updated' once a newer version's self-test passes, once", async () => {
    const dir = tmp();
    await boot(dir, "1.4.1", 1, good).state.boot();
    const { state } = boot(dir, "1.4.2", 10, good);
    const result = await state.boot();
    expect(result?.ok).toBe(true);
    expect(state.digest()).toMatchObject({ kind: "updated", version: "1.4.2" });
    expect(state.report()).toMatchObject({ version: "1.4.2", selfTest: "passed" });
    state.seen();
    expect(state.digest()).toBeNull();
    // a plain restart says nothing and does not test again
    expect(boot(dir, "1.4.2", 20, good).state.boot()).toBeNull();
  });

  it("fails the self-test only on what worked before, and then says nothing", async () => {
    const dir = tmp();
    await boot(dir, "1.0.0", 1, { ...good, connectors: async () => ({ gmail: false }) }).state.boot();
    // gmail was already failing: not the update's fault
    const next = boot(dir, "1.1.0", 10, { ...good, connectors: async () => ({ gmail: false }) });
    expect((await next.state.boot())?.ok).toBe(true);
    // the browser worked on 1.1.0 and fails on 1.2.0: a regression
    const bad = boot(dir, "1.2.0", 20, { ...good, browser: async () => false, connectors: async () => ({ gmail: false }) });
    const result = await bad.state.boot();
    expect(result).toMatchObject({ ok: false, checks: { browser: "failed", "connector:gmail": "failed" } });
    expect(bad.state.report().selfTest).toBe("failed");
    expect(bad.state.digest()).toMatchObject({ kind: "updated", version: "1.1.0" });
  });

  it("a boot on an older version is a rollback: 'rolled back', and the bad version's failed runs run again free once", async () => {
    const dir = tmp();
    await boot(dir, "2.0.0", 1, good).state.boot();
    await boot(dir, "2.1.0", 100, good).state.boot();
    const runs = [{ id: "before", ok: false, at: 50 }, { id: "r1", ok: false, at: 150 }, { id: "r2", ok: true, at: 160 }, { id: "r3", ok: false, at: 170 }];
    const { state } = boot(dir, "2.0.0", 200, good, runs);
    await state.boot();
    expect(state.digest()).toMatchObject({ kind: "rolled_back", version: "2.1.0" });
    expect(state.takeFreeReruns()).toEqual(["r1", "r3"]);
    expect(state.takeFreeReruns()).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, UPDATE_STATE_FILE), "utf8")).boots.map((b: { version: string }) => b.version)).toEqual(["2.0.0", "2.1.0", "2.0.0"]);
  });

  it("health always counts, even on a first boot", async () => {
    expect((await runSelfTest({ health: () => false }, null)).ok).toBe(false);
    expect((await runSelfTest({ health: () => true, browser: async () => false }, null)).ok).toBe(true);
  });

  it("opens a page in a headless browser binary, in a throwaway profile", async () => {
    const dir = tmp(), bin = join(dir, "chrome");
    writeFileSync(bin, `#!/bin/sh\nfor a in "$@"; do case "$a" in --user-data-dir=*) [ -d "\${a#--user-data-dir=}" ] || exit 3 ;; esac; done\nfor a in "$@"; do last="$a"; done\nprintf '<html><body>%s</body></html>' "$last" | sed 's/.*<p>//'\n`);
    chmodSync(bin, 0o755);
    expect(await browserPageCheck(async () => bin)()).toBe(true);
    expect(await browserPageCheck(async () => null)()).toBeNull();
    expect(await browserPageCheck(async () => join(dir, "missing"))()).toBe(false);
  });

  it("keeps the self-test's browser off the macOS keychain, so no keychain dialog appears", async () => {
    const dir = tmp(), bin = join(dir, "chrome"), args = join(dir, "args");
    writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${args}"\nprintf '%s' madani-selftest-page\n`);
    chmodSync(bin, 0o755);
    expect(await browserPageCheck(async () => bin)()).toBe(true);
    expect(readFileSync(args, "utf8").split("\n")).toEqual(expect.arrayContaining(["--use-mock-keychain", "--password-store=basic"]));
  });
});
