import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAuthStore } from "./store.ts";

describe("auth persistence", () => {
  let dataDir: string;
  let store: ReturnType<typeof createAuthStore> | undefined;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "madani-auth-store-")); vi.stubEnv("MADANI_AUTH_SECRET", undefined); });
  afterEach(() => { store?.close(); store = undefined; rmSync(dataDir, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.useRealTimers(); });
  it("requires at least 32 characters in an explicit secret", () => {
    for (const secret of ["", "a".repeat(31)]) {
      vi.stubEnv("MADANI_AUTH_SECRET", secret);
      expect(() => createAuthStore(dataDir)).toThrow("at least 32 characters");
    }
  });
  it("uses the supplied secret without persisting it", () => {
    vi.stubEnv("MADANI_AUTH_SECRET", "fixture-secret-".repeat(4));
    store = createAuthStore(dataDir);
    expect(store.secret).toBe(process.env.MADANI_AUTH_SECRET);
    store.close();
    expect(existsSync(`${dataDir}/auth-secret`)).toBe(false);
    expect(readFileSync(`${dataDir}/auth.json`, "utf8")).not.toContain(store.secret);
  });
  it("coalesces writes, atomically replaces the state and flushes on close", async () => {
    vi.useFakeTimers();
    store = createAuthStore(dataDir);
    store.state.accounts.push({ id: "acct_fixture", email: "fixture@example.test", name: null, createdAt: 1 });
    store.changed(); store.changed();
    expect(existsSync(`${dataDir}/auth.json`)).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(JSON.parse(readFileSync(`${dataDir}/auth.json`, "utf8")).accounts).toHaveLength(1);
    expect(existsSync(`${dataDir}/auth.json.tmp`)).toBe(false);
    if (process.platform !== "win32") expect(statSync(`${dataDir}/auth.json`).mode & 0o777).toBe(0o600);
    store.state.accounts[0].name = "Updated"; store.changed(); store.close();
    expect(JSON.parse(readFileSync(`${dataDir}/auth.json`, "utf8")).accounts[0].name).toBe("Updated");
  });
});
