import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { cosine, embeddingsWanted, embedPassages, embedQuery, embedderSettled, warmEmbedder, wasmPrefix } from "./memory-embed.ts";

describe("local embeddings", () => {
  it("stay off under a test runner unless asked for, and off when switched off", () => {
    expect(embeddingsWanted({ VITEST: "true" })).toBe(false);
    expect(embeddingsWanted({ VITEST: "true", MADANI_MEMORY_EMBED: "1" })).toBe(true);
    expect(embeddingsWanted({ MADANI_MEMORY_EMBED: "0" })).toBe(false);
    expect(embeddingsWanted({})).toBe(true);
  });

  it("answer null, never throw, before the model is there", async () => {
    expect(await embedPassages(["anything"])).toBeNull();
    expect(await embedQuery("anything")).toBeNull();
  });

  // Windows loads embeddings through this prefix, and a bare C:\... path made the wasm init fail on every start.
  it("hands ort a file URL for the wasm files, with a trailing slash", () => {
    const dir = mkdtempSync(join(tmpdir(), "madani wasm prefix #"));
    try {
      const prefix = wasmPrefix(dir);
      expect(new URL(prefix).protocol).toBe("file:");
      expect(prefix.endsWith("/")).toBe(true);
      expect(fileURLToPath(`${prefix}model_quantized.onnx`)).toBe(join(dir, "model_quantized.onnx"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Runs only where the model files were placed (MADANI_MODEL_DIR), so CI never downloads 50 MB.
  const dir = process.env.MADANI_MODEL_DIR;
  it.skipIf(!dir || !existsSync(join(dir, "model_quantized.onnx")) || process.env.MADANI_MEMORY_EMBED !== "1")("rank a paraphrase above unrelated facts", async () => {
    warmEmbedder();
    expect(await embedderSettled()).toBe(true);
    const facts = ["Ana is the person's sister; her email is ana.r@example.com", "The person goes to the gym on Fridays", "Atlas deploys to Railway"];
    const vectors = (await embedPassages(facts))!;
    const query = (await embedQuery("what's my sibling's email?"))!;
    const scores = vectors.map((vector) => cosine(query, vector));
    expect(scores.indexOf(Math.max(...scores))).toBe(0);
    expect(scores[0]).toBeGreaterThan(0.6);
  });
});
