import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createVpsLifecycleStore } from "./vps-lifecycle-store.ts";
import { independentScreenTarget } from "./shared-desktop-screens.ts";
import type { VpsLifecycleState } from "./vps-lifecycle.ts";

const directories: string[] = [];
const workspace = "11111111-1111-4111-8111-111111111111";
const target = { ownerId: "computer_shared", sshAlias: "fixture-vps", containerId: "a".repeat(64) };
const record = { target, lastActivityAt: 1_000_000, epoch: 1, completed: [], failures: 0 };
const state: VpsLifecycleState = { version: 1, entries: [record, { ...record, target: { ...target, botId: "bot", screen: independentScreenTarget("bot", 2) }, failedStage: "browser", failures: 2, retryAt: 2_000_000 }] };
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "madani-lifecycle-state-")); directories.push(directory);
  const file = join(directory, "lifecycle.json");
  return { directory, file, store: createVpsLifecycleStore(file, workspace) };
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("workspace-bound lifecycle persistence", () => {
  it("atomically stores timestamps, canonical generations and retry receipts with private permissions", () => {
    const { store, file } = fixture();
    expect(store.load()).toBeNull(); store.save(state);
    expect(store.load()).toEqual(state);
    expect(JSON.parse(readFileSync(file, "utf8")).environmentId).toBe(workspace);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });
  it("rejects state copied from another workspace without resetting it", () => {
    const { store, file } = fixture(); store.save(state);
    expect(() => createVpsLifecycleStore(file, "22222222-2222-4222-8222-222222222222").load()).toThrow(/another workspace/);
    expect(store.load()).toEqual(state);
  });
  it("refuses corrupt, oversized and symbolic state files", () => {
    const { store, file, directory } = fixture();
    writeFileSync(file, "invalid"); expect(() => store.load()).toThrow();
    writeFileSync(file, " ".repeat(5_000_001)); expect(() => store.load()).toThrow(/Unsafe/);
    rmSync(file); const actual = join(directory, "actual.json"); writeFileSync(actual, JSON.stringify({ ...state, environmentId: workspace }));
    symlinkSync(actual, file); expect(() => store.load()).toThrow();
  });
  it("refuses to write a valid-shaped state that would exceed the readable size limit", () => {
    const { store } = fixture(); store.save(state);
    const entries = [record, ...Array.from({ length: 9999 }, (_, index) => {
      const botId = `bot-${index}-${"x".repeat(145)}`;
      return { ...record, target: { ...target, botId, screen: independentScreenTarget(botId, 2) } };
    })];
    expect(() => store.save({ version: 1, entries })).toThrow(/storage limit/);
    expect(store.load()).toEqual(state);
  });
  it.each([
    { ...state, version: 2 },
    { ...state, entries: [record, record] },
    { ...state, entries: [{ ...record, lastActivityAt: -1 }] },
    { ...state, entries: [{ ...record, target: { ...target, containerId: "short" } }] },
    { ...state, entries: [state.entries[1]!] },
    { ...state, entries: [{ ...record, completed: ["power-off"] }] },
  ])("rejects malformed state before writing: %o", malformed => {
    const { store } = fixture();
    expect(() => store.save(malformed as VpsLifecycleState)).toThrow();
    expect(store.load()).toBeNull();
  });
});
