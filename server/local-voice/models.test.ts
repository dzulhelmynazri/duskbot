import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultModelDir, mirrorFromEnv, MODEL_FILES, ModelStore, sourcesFor, TOTAL_BYTES, type ModelFile } from "./models.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "madani-voice-models-"));
  dirs.push(dir);
  return dir;
}

const body = Buffer.from("the weights of a very small model, repeated ".repeat(40));
const file: ModelFile = { path: "kokoro/test.bin", url: "https://models.example/test.bin", bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") };

function server(opts: { honourRange?: boolean; corrupt?: boolean } = {}) {
  const calls: Array<string | undefined> = [];
  const fetchImpl = async (_url: string, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string> | undefined)?.range;
    calls.push(range);
    const payload = opts.corrupt ? Buffer.from(body).fill(0x41) : body;
    if (range && opts.honourRange !== false) {
      const from = Number(/bytes=(\d+)-/.exec(range)![1]);
      return new Response(payload.subarray(from), { status: 206 });
    }
    return new Response(payload, { status: 200 });
  };
  return { calls, fetchImpl };
}

describe("ModelStore", () => {
  it("pins every file to a revision and a hash", () => {
    for (const entry of MODEL_FILES) {
      expect(entry.url).toMatch(/\/(?:resolve|[0-9a-f]{40})\/|\/[0-9a-f]{40}\//);
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.bytes).toBeGreaterThan(0);
    }
    expect(TOTAL_BYTES).toBeLessThan(180 * 1024 * 1024);
  });

  it("downloads, verifies and reports ready", async () => {
    const dir = scratch();
    const { fetchImpl, calls } = server();
    const store = new ModelStore({ dir, fetchImpl, files: [file] });
    expect(store.status()).toEqual({ phase: "missing", hear: true, speak: false });
    await store.ensure();
    expect(store.status()).toEqual({ phase: "ready", hear: true, speak: true });
    expect(readFileSync(path.join(dir, file.path))).toEqual(body);
    expect(calls).toEqual([undefined]);
    await new ModelStore({ dir, fetchImpl, files: [file] }).ensure();
    expect(calls).toHaveLength(1);
  });

  it("resumes a part file where it stopped", async () => {
    const dir = scratch();
    mkdirSync(path.join(dir, "kokoro"), { recursive: true });
    writeFileSync(path.join(dir, `${file.path}.part`), body.subarray(0, 300));
    const { fetchImpl, calls } = server();
    const store = new ModelStore({ dir, fetchImpl, files: [file] });
    await store.ensure();
    expect(calls).toEqual(["bytes=300-"]);
    expect(readFileSync(path.join(dir, file.path))).toEqual(body);
  });

  it("starts over when the server ignores the range", async () => {
    const dir = scratch();
    mkdirSync(path.join(dir, "kokoro"), { recursive: true });
    writeFileSync(path.join(dir, `${file.path}.part`), body.subarray(0, 300));
    const { fetchImpl } = server({ honourRange: false });
    await new ModelStore({ dir, fetchImpl, files: [file] }).ensure();
    expect(readFileSync(path.join(dir, file.path))).toEqual(body);
  });

  it("never keeps a file whose contents do not match", async () => {
    const dir = scratch();
    const { fetchImpl } = server({ corrupt: true });
    const store = new ModelStore({ dir, fetchImpl, files: [file] });
    await expect(store.ensure()).rejects.toThrow(/did not match/);
    expect(store.status()).toMatchObject({ phase: "failed" });
    expect(store.has(file.path)).toBe(false);
  }, 20_000);

  it("asks madani.bot's copy first and falls back to the pinned upstream", async () => {
    const dir = scratch();
    const asked: string[] = [];
    const fetchImpl = async (url: string) => {
      asked.push(url);
      return url.startsWith("https://madani.bot/") ? new Response("gone", { status: 404 }) : new Response(body, { status: 200 });
    };
    await new ModelStore({ dir, fetchImpl, files: [file], mirror: "https://madani.bot/voice" }).ensure();
    expect(asked).toEqual([`https://madani.bot/voice/${file.sha256}/test.bin`, file.url]);
    expect(readFileSync(path.join(dir, file.path))).toEqual(body);
    expect(sourcesFor(file, null)).toEqual([file.url]);
    expect(mirrorFromEnv({ MADANI_VOICE_MIRROR_URL: "off" })).toBeNull();
    expect(mirrorFromEnv({})).toBe("https://madani.bot/voice");
  });

  it("keeps models in the computer's cache, outside any workspace", () => {
    expect(defaultModelDir({}, "darwin")).toMatch(/Library\/Caches\/bot\.madani\.app\/voice$/);
    expect(defaultModelDir({ XDG_CACHE_HOME: "/c" }, "linux")).toBe("/c/madanibot/voice");
    expect(defaultModelDir({ MADANI_VOICE_MODELS_DIR: "/m" }, "linux")).toBe("/m");
  });
});
