import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createVoiceProcess, type VoiceProcess } from "./voice-process.ts";

let dir: string;
const started: VoiceProcess[] = [];
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "madani-voice-process-")); });
afterEach(() => {
  for (const voice of started.splice(0)) voice.stop();
  rmSync(dir, { recursive: true, force: true });
});

function worker(body: string): string {
  const file = path.join(dir, "worker.mjs");
  writeFileSync(file, `process.on("message", async (request) => { ${body} });\nprocess.on("disconnect", () => process.exit(0));\n`);
  return file;
}

function voice(options: Parameters<typeof createVoiceProcess>[0]) {
  const created = createVoiceProcess(options);
  started.push(created);
  return created;
}

describe("the built-in voice's own process", () => {
  it("runs the real worker entry and carries samples both ways", async () => {
    const real = voice({ modelDir: dir });
    await expect(real.transcribe(new Float32Array(100))).resolves.toBe("");
  }, 30_000);

  it("hands back the worker's answers and errors", async () => {
    const entry = worker(`
      if (request.op === "speak") process.send({ id: request.id, ok: true, value: new Float32Array([0.5, request.speed]) });
      else process.send({ id: request.id, ok: false, error: "no models yet" });`);
    const fake = voice({ modelDir: dir, entry });
    const samples = await fake.speak("Hi.", "af_heart", 1.25);
    expect(samples).toBeInstanceOf(Float32Array);
    expect([...samples]).toEqual([0.5, 1.25]);
    await expect(fake.warm({ hear: true, speak: true })).rejects.toThrow("no models yet");
    expect(fake.usable()).toBe(true);
  }, 30_000);

  it("survives a native crash in the worker, and this app version stops trying", async () => {
    const entry = worker(`process.abort();`);
    const lines: string[] = [];
    const crashing = voice({ modelDir: dir, entry, version: "0.2.24", log: (line) => lines.push(line) });
    await expect(crashing.warm({ hear: true, speak: true })).rejects.toThrow("cannot run on this computer");
    expect(crashing.usable()).toBe(false);
    await expect(crashing.speak("Hi.", "af_heart", 1)).rejects.toThrow("cannot run on this computer");
    expect(lines.join("\n")).toMatch(/crashed/);
    expect(JSON.parse(readFileSync(path.join(dir, "runtime-crashed.json"), "utf8")).version).toBe("0.2.24");
    expect(voice({ modelDir: dir, entry, version: "0.2.24" }).usable()).toBe(false);
    expect(voice({ modelDir: dir, entry, version: "0.2.25" }).usable()).toBe(true);
  }, 30_000);

  it("a stopped worker is not a crash", async () => {
    const entry = worker(`setTimeout(() => process.send({ id: request.id, ok: true }), 5_000);`);
    const slow = voice({ modelDir: dir, entry });
    const waiting = slow.warm({ hear: true, speak: true });
    slow.stop();
    await expect(waiting).rejects.toThrow("stopped");
    expect(slow.usable()).toBe(true);
  }, 30_000);

  it("ships as its own bundle entry", () => {
    const script = readFileSync(path.join(import.meta.dirname, "../../scripts/bundle-server.mjs"), "utf8");
    expect(script.match(/const ENTRY_POINTS = \[([\s\S]*?)\];/)?.[1]).toMatch(/["']local-voice\/voice-worker\.ts["']/);
  });
});
