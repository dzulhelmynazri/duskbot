import { existsSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { parseFactFile } from "./memory-facts.ts";
import { flushMemoryJournal, JOURNAL_DIR, journalFile, readMemoryJournal, rotatedJournalFile, rotateMemoryJournal } from "./memory-journal.ts";
import { MERGE_MARKER, mergeLoser, mergePairs, mergePrompt, parseMerge } from "./memory-merge.ts";
import { createMemoryUpkeep } from "./memory-upkeep.ts";
import { TIDY_MARKER } from "./memory-tidy.ts";
import { closeMessageDb } from "./message-db.ts";
import {
  appendMemoryArchive, compactMemoryTopic, ensureWorkspace, foldOldLogs, listMemoryLogs, listMemoryTopics, memoryTopicIndex, readMemoryLog, readMemoryTopic,
  workspaceDir, writeMemoryFile, writeMemoryLog, writeMemoryTopic, WORKSPACES_DIR,
} from "./workspace.ts";

const BOT = "consolidate-bot";

beforeEach(() => {
  closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  rmSync(WORKSPACES_DIR, { recursive: true, force: true });
});

describe("near-duplicate pairs", () => {
  it("pair word-for-word repeats without embeddings, ask the model about the rest, and pick the older line to go", async () => {
    const items = [
      { where: "MEMORY.md", line: 0, text: "Atlas deploys to Railway", date: "2026-03-01" },
      { where: "memory/atlas.md", line: 3, text: "Atlas deploys to Railway.", date: "2026-05-01" },
      { where: "memory/atlas.md", line: 4, text: "Atlas has 3 servers", date: "2026-05-01" },
    ];
    const pairs = await mergePairs(items);
    expect(pairs).toHaveLength(1);
    expect(mergeLoser(pairs[0]!)).toBe(items[0]);
    expect(mergePrompt(pairs)).toContain(MERGE_MARKER);
    expect(parseMerge('{"same": [0, 7, 0]}', 1)).toEqual([0]);
    expect(parseMerge("no idea", 1)).toEqual([]);
  });

  it("strike the older copy as merged in the nightly tidy-up, journal it, and read it back as merged history", async () => {
    ensureWorkspace(BOT);
    writeMemoryFile(BOT, "- 2026-03-01 · Atlas deploys to Railway\n- 2026-03-02 · The person likes tea\n- 2026-03-03 · Ships on Fridays\n- 2026-03-04 · Reviews on Mondays\n- 2026-03-05 · Uses pnpm\n");
    writeMemoryTopic(BOT, "atlas.md", "- 2026-05-01 · Atlas deploys to Railway\n- 2026-05-02 · Atlas has 3 servers\n");
    const bot = { id: BOT, name: "Forge" };
    const upkeep = createMemoryUpkeep({
      bots: () => [bot], bot: () => bot, busy: () => false, addToAboutMe: () => 0, sourceLabel: () => "chat", quietMs: () => 60_000, tidyHour: () => 3,
      engine: () => ({ generateText: async (prompt) => (prompt.includes(TIDY_MARKER) ? '{"pairs":[]}' : prompt.includes(MERGE_MARKER) ? '{"same":[]}' : '{"moves":[]}') }),
    });
    const report = await upkeep.tidy(BOT);
    upkeep.stop();
    expect(report.merged).toBe(1);
    const memory = readFileSync(join(workspaceDir(BOT), "MEMORY.md"), "utf8");
    expect(memory).toMatch(/~~Atlas deploys to Railway~~ · merged \d{4}-\d{2}-\d{2}/);
    expect(readMemoryTopic(BOT, "atlas.md")).toContain("- 2026-05-01 · Atlas deploys to Railway\n");
    expect(parseFactFile("MEMORY.md", memory, "2026-11-15").find((fact) => fact.text === "Atlas deploys to Railway")?.status).toBe("merged");
    await flushMemoryJournal(BOT);
    expect(readMemoryJournal(BOT).some((row) => row.via === "merge")).toBe(true);
  });
});

describe("bounded growth, nothing lost", () => {
  it("rolls the archive's oldest half into a yearly archive that is history like the archive", () => {
    ensureWorkspace(BOT);
    const lines = Array.from({ length: 40 }, (_, i) => `- 2025-0${1 + (i % 9)}-10 · old note ${i} ${"x".repeat(60)}`);
    appendMemoryArchive(BOT, lines, 2_000);
    const archive = readMemoryTopic(BOT, "archive.md")!;
    const rolled = readMemoryTopic(BOT, "archive-2025.md")!;
    expect(Buffer.byteLength(archive)).toBeLessThanOrEqual(1_100);
    expect(`${rolled}${archive}`.match(/old note \d+/g)).toHaveLength(40);
    expect(rolled).toContain("old note 0 ");
    expect(parseFactFile("memory/archive-2025.md", rolled, "2026-11-15")[0]?.keys).toBe("");
    expect(memoryTopicIndex(BOT).split("\n").at(-1)).toContain("archive");
  });

  it("moves a full topic's replaced, then oldest, entries into the archive", () => {
    ensureWorkspace(BOT);
    const live = Array.from({ length: 30 }, (_, i) => `- 2026-0${1 + (i % 9)}-1${i % 10} · fact ${i} ${"y".repeat(50)}`);
    writeMemoryTopic(BOT, "big.md", ["- 2026-01-01 · ~~Old value~~ · superseded 2026-02-01", ...live].join("\n"));
    expect(compactMemoryTopic(BOT, "big.md", 1_500, "2026-11-15")).toBeGreaterThan(1);
    const topic = readMemoryTopic(BOT, "big.md")!;
    expect(Buffer.byteLength(topic)).toBeLessThanOrEqual(1_125);
    expect(topic).not.toContain("Old value");
    expect(readMemoryTopic(BOT, "archive.md")).toContain("~~Old value~~");
    expect(`${topic}${readMemoryTopic(BOT, "archive.md")}`.match(/fact \d+ /g)).toHaveLength(30);
  });

  it("folds daily logs older than 90 days into a month file and keeps recent days as they are", () => {
    ensureWorkspace(BOT);
    writeMemoryLog(BOT, "2026-06-01.md", "- 09:00 · shipped A\n");
    writeMemoryLog(BOT, "2026-06-02.md", "- 10:00 · shipped B\n");
    writeMemoryLog(BOT, "2026-11-01.md", "- 11:00 · shipped C\n");
    expect(foldOldLogs(BOT, "2026-11-15")).toBe(2);
    expect(listMemoryLogs(BOT)).toEqual(["2026-06.md", "2026-11-01.md"]);
    expect(readMemoryLog(BOT, "2026-06.md")).toBe("## 2026-06-01\n- 09:00 · shipped A\n\n## 2026-06-02\n- 10:00 · shipped B\n");
    expect(listMemoryTopics(BOT).map((topic) => topic.name)).not.toContain("2026-06.md");
  });

  it("rotates a large journal: the newest rows stay, older ones go to a gzip file without their earlier copies", async () => {
    mkdirSync(JOURNAL_DIR, { recursive: true });
    const row = (i: number) => JSON.stringify({ id: `r${i}`, at: i, botId: BOT, path: "MEMORY.md", kind: "edited", before: "z".repeat(400), canRevert: true });
    writeFileSync(journalFile(BOT), `${Array.from({ length: 100 }, (_, i) => row(i)).join("\n")}\n`);
    const moved = await rotateMemoryJournal(BOT, 10_000);
    expect(moved).toBeGreaterThan(70);
    expect(statSync(journalFile(BOT)).size).toBeLessThanOrEqual(5_000);
    expect(readMemoryJournal(BOT, 500)[0]?.id).toBe("r99");
    const old = gunzipSync(readFileSync(rotatedJournalFile(BOT))).toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(old).toHaveLength(moved);
    expect(old[0]).toMatchObject({ id: "r0", before: null, canRevert: false });
    expect(existsSync(rotatedJournalFile(BOT))).toBe(true);
  });
});

describe("near-duplicate pairs by meaning", () => {
  const dir = process.env.MADANI_MODEL_DIR;
  // Runs only where the model files were placed (MADANI_MODEL_DIR), so CI never downloads them.
  it.skipIf(!dir || !existsSync(join(dir, "model_quantized.onnx")) || process.env.MADANI_MEMORY_EMBED !== "1")("pair a rewording, never two different numbers", async () => {
    const { warmEmbedder, embedderSettled } = await import("./memory-embed.ts");
    warmEmbedder();
    expect(await embedderSettled()).toBe(true);
    const pairs = await mergePairs([
      { where: "MEMORY.md", line: 0, text: "The person is allergic to peanuts", date: "2026-01-01" },
      { where: "MEMORY.md", line: 1, text: "The person has a peanut allergy", date: "2026-02-01" },
      { where: "MEMORY.md", line: 2, text: "Atlas has 3 servers", date: "2026-01-01" },
      { where: "MEMORY.md", line: 3, text: "Atlas has 4 servers", date: "2026-02-01" },
    ]);
    expect(pairs.map((pair) => [pair.a.line, pair.b.line])).toEqual([[0, 1]]);
  });
});
