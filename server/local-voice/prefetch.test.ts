import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelStore, Paused, type DownloadState, type ModelFile } from "./models.ts";
import { startPrefetch } from "./prefetch.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function fakeModels() {
  const calls: string[] = [];
  let phase: DownloadState = { phase: "missing", hear: false, speak: false };
  let finish: (() => void) | null = null;
  let fail: ((error: unknown) => void) | null = null;
  return {
    calls,
    finish: () => { phase = { phase: "ready", hear: true, speak: true }; finish?.(); },
    fail: (error: unknown) => fail?.(error),
    models: {
      status: () => phase,
      ensure: (opts?: { background?: boolean }) => {
        calls.push(opts?.background ? "ensure:background" : "ensure");
        return new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
      },
      pauseBackground: () => { calls.push("pause"); },
    },
  };
}

describe("startPrefetch", () => {
  it("waits for a quiet harness, fetches in the background, then warms the voice", async () => {
    let clock = 0;
    const fake = fakeModels();
    const warm = vi.fn(async () => {});
    const stop = startPrefetch({ models: fake.models as never, busy: () => false, onBattery: async () => false, warm, now: () => clock, idleMs: 60_000, checkMs: 1_000 });
    clock = 30_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.calls).toEqual([]);
    clock = 61_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.calls).toEqual(["ensure:background"]);
    fake.finish();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(warm).toHaveBeenCalled();
    stop();
  });

  it("makes way while a bot works or the computer runs on battery, and starts the quiet wait again", async () => {
    let clock = 0;
    let busy = true;
    let battery = false;
    const fake = fakeModels();
    const stop = startPrefetch({ models: fake.models as never, busy: () => busy, onBattery: async () => battery, warm: async () => {}, now: () => clock, idleMs: 60_000, checkMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.calls).toEqual(["pause"]);
    busy = false;
    battery = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.calls).toEqual(["pause", "pause"]);
    battery = false;
    clock += 30_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.calls).toEqual(["pause", "pause"]);
    clock += 31_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.calls.at(-1)).toBe("ensure:background");
    stop();
  });

  it("tries again later after a failed download, but resumes at once after a pause", async () => {
    let clock = 0;
    const fake = fakeModels();
    const stop = startPrefetch({ models: fake.models as never, busy: () => false, onBattery: async () => false, warm: async () => {}, now: () => clock, idleMs: 60_000, checkMs: 1_000, retryMs: 600_000 });
    clock = 61_000;
    await vi.advanceTimersByTimeAsync(1_000);
    fake.fail(new Error("offline"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.calls).toEqual(["ensure:background"]);
    clock += 600_001;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.calls).toEqual(["ensure:background", "ensure:background"]);
    fake.fail(new Paused());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fake.calls).toEqual(["ensure:background", "ensure:background", "ensure:background"]);
    stop();
  });
});

describe("a background download", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("pauses on request, keeps what it had, and a call's request finishes it", async () => {
    vi.useRealTimers();
    const dir = mkdtempSync(path.join(tmpdir(), "madani-voice-pause-"));
    dirs.push(dir);
    const body = Buffer.alloc(64 * 1024, 7);
    const file: ModelFile = { path: "moonshine/a.bin", url: "https://models.example/a.bin", bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") };
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      const range = (init?.headers as Record<string, string> | undefined)?.range;
      const from = range ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0;
      const signal = init?.signal;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(body.subarray(from, from + 1024));
          await Promise.race([gate, new Promise((resolve) => signal?.addEventListener("abort", resolve))]);
          if (signal?.aborted) { controller.error(signal.reason); return; }
          controller.enqueue(body.subarray(from + 1024));
          controller.close();
        },
      });
      return new Response(stream, { status: range ? 206 : 200 });
    };
    const store = new ModelStore({ dir, fetchImpl, files: [file], mirror: null });
    const background = store.ensure({ background: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    store.pauseBackground();
    await expect(background).rejects.toBeInstanceOf(Paused);
    expect(store.status()).toEqual({ phase: "missing", hear: false, speak: true });
    release();
    await store.ensure();
    expect(store.ready("hear")).toBe(true);
  });
});
