import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installNpmEngine, npmModulesDir } from "./engine-install.ts";
import { InstallProgressBoard, downloadMeter, parseDryRun, treeBytes, unpackedTotal, watchFolder, type InstallProgress } from "./install-progress.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const registry = (sizes: Record<string, number | undefined>) => vi.fn(async (url: string | URL | Request) => {
  const key = decodeURIComponent(String(url).replace("https://registry.example/", ""));
  if (!(key in sizes)) return new Response("{}", { status: 404 });
  return Response.json({ dist: sizes[key] === undefined ? {} : { unpackedSize: sizes[key] } });
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("measuring an install", () => {
  it("reads npm's dry run as the packages it would add", () => {
    expect(parseDryRun("add @openai/codex 0.169.0\nadd @openai/codex-darwin-arm64 0.169.0-darwin-arm64\n\nadded 2 packages in 4s\nchange x 1 => 2\n"))
      .toEqual([{ name: "@openai/codex", version: "0.169.0" }, { name: "@openai/codex-darwin-arm64", version: "0.169.0-darwin-arm64" }]);
  });

  it("sums the registry's unpacked sizes, finding an aliased platform package under its real name", async () => {
    const fetchImpl = registry({ "@openai/codex/0.169.0": 13_570, "@openai/codex/0.169.0-darwin-arm64": 300_000_000 });
    const total = await unpackedTotal(parseDryRun("add @openai/codex 0.169.0\nadd @openai/codex-darwin-arm64 0.169.0-darwin-arm64"), { registry: "https://registry.example", fetchImpl: fetchImpl as typeof fetch });
    expect(total).toBe(300_013_570);
  });

  it("calls the total unknown when any size is missing, never short", async () => {
    const fetchImpl = registry({ "a/1.0.0": 10, "b/1.0.0": undefined });
    expect(await unpackedTotal([{ name: "a", version: "1.0.0" }, { name: "b", version: "1.0.0" }], { registry: "https://registry.example", fetchImpl: fetchImpl as typeof fetch })).toBeNull();
    expect(await unpackedTotal([], { registry: "https://registry.example", fetchImpl: fetchImpl as typeof fetch })).toBeNull();
  });

  it("counts a download chunk by chunk, then setup", () => {
    const seen: InstallProgress[] = [];
    const meter = downloadMeter(100, (progress) => seen.push(progress));
    meter.add(40);
    meter.add(70);
    meter.setup();
    expect(seen).toEqual([
      { phase: "download", received: 0, total: 100 },
      { phase: "download", received: 40, total: 100 },
      { phase: "download", received: 100, total: 100 },
      { phase: "setup", received: 100, total: 100 },
    ]);
  });

  it("reports a growing folder against the total once it is known, then setup when the bytes are in", async () => {
    vi.useFakeTimers();
    const sizes = [1_000, 1_000, 1_250, 1_600, 2_000];
    let tick = 0;
    let known!: (value: number) => void;
    const seen: InstallProgress[] = [];
    const watch = watchFolder("/x", 1_000, new Promise<number>((resolve) => { known = resolve; }), (progress) => seen.push(progress), 100, async () => sizes[Math.min(tick++, sizes.length - 1)]!);
    await vi.advanceTimersByTimeAsync(100);
    expect(seen).toEqual([]);
    known(1_000);
    await vi.advanceTimersByTimeAsync(400);
    watch.stop();
    expect(seen).toEqual([
      { phase: "download", received: 0, total: 1_000 },
      { phase: "download", received: 250, total: 1_000 },
      { phase: "download", received: 600, total: 1_000 },
      { phase: "setup", received: 1_000, total: 1_000 },
    ]);
  });

  it("keeps the latest reading per AI until the install ends", () => {
    const board = new InstallProgressBoard();
    board.sink("gemini")({ phase: "download", received: 5, total: 10 });
    expect(board.get("gemini")).toEqual({ phase: "download", received: 5, total: 10 });
    board.clear("gemini");
    expect(board.get("gemini")).toBeNull();
  });
});

describe.skipIf(process.platform === "win32")("an npm install with progress", () => {
  it("measures the folder npm writes against the dry run's total", async () => {
    vi.stubGlobal("fetch", registry({ "fake-engine/1.0.0": 4_000, "fake-dep/2.0.0": 4_000 }));
    const base = mkdtempSync(join(tmpdir(), "madani-progress-"));
    try {
      const seen: InstallProgress[] = [];
      const npm = async (args: string[]) => {
        if (args.includes("--dry-run")) return { code: 0, output: "add fake-engine 1.0.0\nadd fake-dep 2.0.0\n\nadded 2 packages in 1s\n" };
        const folder = join(npmModulesDir(args[args.indexOf("--prefix") + 1]!), "fake-engine");
        mkdirSync(folder, { recursive: true });
        for (let part = 0; part < 4; part += 1) {
          writeFileSync(join(folder, `part-${part}`), Buffer.alloc(2_000));
          await new Promise((resolve) => setTimeout(resolve, 450));
        }
        return { code: 0, output: "" };
      };
      await installNpmEngine("fake-engine", { baseDir: base, env: { PATH: process.env.PATH, npm_config_registry: "https://registry.example/" }, onProgress: (progress) => seen.push(progress), npm });
      const downloads = seen.filter((progress) => progress.phase === "download");
      expect(downloads.length).toBeGreaterThan(0);
      for (const progress of downloads) expect(progress.total).toBe(8_000);
      expect(downloads.map((progress) => progress.received)).toEqual(downloads.map((progress) => progress.received).sort((a, b) => a - b));
      expect(seen.at(-1)).toEqual({ phase: "setup", received: 8_000, total: 8_000 });
      expect(await treeBytes(npmModulesDir(join(base, "tools", "npm")))).toBe(8_000);
    } finally {
      removeTempDir(base);
    }
  });
});
